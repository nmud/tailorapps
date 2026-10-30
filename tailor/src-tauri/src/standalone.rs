//! Makes each generated app a real Windows app: its own process and taskbar identity
//! (AppUserModelID), its own icon, a Start menu entry, and correct behaviour when pinned.

use std::path::{Path, PathBuf};

pub fn app_id(slug: &str) -> String {
    format!("Tailor.App.{slug}")
}

/// Start menu folder for apps made with Tailor.
pub fn start_menu_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("Microsoft/Windows/Start Menu/Programs/Tailor apps")
}

/// A Start menu file name for an app name, keeping only characters Windows allows.
pub fn shortcut_path(name: &str) -> PathBuf {
    let clean: String = name
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect();
    let clean = clean.trim();
    start_menu_dir().join(format!("{}.lnk", if clean.is_empty() { "App" } else { clean }))
}

/// Wrap a PNG in a single-image .ico (Windows Vista+ reads PNG-compressed icons).
pub fn png_to_ico(png: &[u8]) -> Vec<u8> {
    let mut ico = Vec::with_capacity(png.len() + 22);
    ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]); // reserved, type icon, one image
    ico.extend_from_slice(&[0, 0, 0, 0]); // 256x256 (0 means 256), no palette, reserved
    ico.extend_from_slice(&1u16.to_le_bytes()); // colour planes
    ico.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes()); // image data offset
    ico.extend_from_slice(png);
    ico
}

#[cfg(windows)]
mod win {
    use std::path::Path;

    use windows::Win32::Foundation::HWND;
    use windows::Win32::Storage::EnhancedStorage::{
        PKEY_AppUserModel_ID, PKEY_AppUserModel_RelaunchCommand,
        PKEY_AppUserModel_RelaunchDisplayNameResource, PKEY_AppUserModel_RelaunchIconResource,
    };
    use windows::Win32::System::Com::StructuredStorage::{PVCHF_DEFAULT, PropVariantChangeType};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, IPersistFile,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PROPERTYKEY, SHGetPropertyStoreForWindow};
    use windows::Win32::UI::Shell::{IShellLinkW, SetCurrentProcessExplicitAppUserModelID, ShellLink};
    use windows::core::{HSTRING, Interface, PROPVARIANT, Result};

    fn set(store: &IPropertyStore, key: &PROPERTYKEY, value: &str) -> Result<()> {
        let src = PROPVARIANT::from(value);
        let mut dst = PROPVARIANT::default();
        unsafe {
            PropVariantChangeType(&mut dst, &src, PVCHF_DEFAULT, VT_LPWSTR)?;
            store.SetValue(key, &dst)
        }
    }

    pub fn set_process_app_id(id: &str) {
        unsafe {
            let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(id));
        }
    }

    /// Give a window its own taskbar identity and tell Windows how to relaunch it when pinned.
    pub fn set_window_identity(hwnd: isize, id: &str, command: &str, name: &str, icon: &Path) -> Result<()> {
        unsafe {
            let store: IPropertyStore = SHGetPropertyStoreForWindow(HWND(hwnd as _))?;
            set(&store, &PKEY_AppUserModel_ID, id)?;
            set(&store, &PKEY_AppUserModel_RelaunchCommand, command)?;
            set(&store, &PKEY_AppUserModel_RelaunchDisplayNameResource, name)?;
            set(&store, &PKEY_AppUserModel_RelaunchIconResource, &format!("{},0", icon.display()))?;
            store.Commit()
        }
    }

    pub fn create_shortcut(link_path: &Path, exe: &Path, args: &str, icon: &Path, id: &str, description: &str) -> Result<()> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(exe.as_os_str()))?;
            link.SetArguments(&HSTRING::from(args))?;
            link.SetIconLocation(&HSTRING::from(icon.as_os_str()), 0)?;
            link.SetDescription(&HSTRING::from(description))?;
            let store: IPropertyStore = link.cast()?;
            set(&store, &PKEY_AppUserModel_ID, id)?;
            store.Commit()?;
            let file: IPersistFile = link.cast()?;
            file.Save(&HSTRING::from(link_path.as_os_str()), true)
        }
    }
}

pub fn set_process_app_id(id: &str) {
    #[cfg(windows)]
    win::set_process_app_id(id);
    #[cfg(not(windows))]
    let _ = id;
}

pub fn set_window_identity(hwnd: isize, slug: &str, name: &str, icon: &Path) {
    #[cfg(windows)]
    if let Ok(exe) = std::env::current_exe() {
        let command = format!("\"{}\" --app {slug}", exe.display());
        let _ = win::set_window_identity(hwnd, &app_id(slug), &command, name, icon);
    }
    #[cfg(not(windows))]
    let _ = (hwnd, slug, name, icon);
}

pub fn create_shortcut(slug: &str, name: &str, description: &str, icon: &Path) -> Result<PathBuf, String> {
    let path = shortcut_path(name);
    std::fs::create_dir_all(start_menu_dir()).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        win::create_shortcut(&path, &exe, &format!("--app {slug}"), icon, &app_id(slug), description)
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = (slug, description, icon);
    Ok(path)
}

/// Remove one of Tailor's Start menu shortcuts: only a plain `.lnk` file directly inside the
/// "Tailor apps" folder, so a path like `...\Tailor apps\..\..\x` can't delete anything else.
pub fn remove_shortcut(path: &Path) {
    if shortcut_removable(path, &start_menu_dir()) {
        let _ = std::fs::remove_file(path);
    }
}

fn shortcut_removable(path: &Path, dir: &Path) -> bool {
    let plain_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.to_ascii_lowercase().ends_with(".lnk"));
    let inside = path.components().all(|c| matches!(c, std::path::Component::Prefix(_) | std::path::Component::RootDir | std::path::Component::Normal(_)));
    plain_name && inside && path.parent() == Some(dir)
}

#[cfg(test)]
mod tests {
    use super::shortcut_removable;
    use std::path::Path;

    #[test]
    fn only_shortcuts_directly_in_the_tailor_folder_can_be_removed() {
        let dir = Path::new(r"C:\Users\u\Start Menu\Programs\Tailor apps");
        assert!(shortcut_removable(&dir.join("Paper Ledger.lnk"), dir));
        assert!(!shortcut_removable(&dir.join(r"..\..\..\Documents\thesis.docx"), dir));
        assert!(!shortcut_removable(&dir.join(r"..\..\Tailor apps\x.lnk"), dir));
        assert!(!shortcut_removable(&dir.join(r"..\Other.lnk"), dir));
        assert!(!shortcut_removable(&dir.join("notes.txt"), dir));
        assert!(!shortcut_removable(&dir.join(r"sub\x.lnk"), dir));
        assert!(!shortcut_removable(Path::new(r"C:\Windows\x.lnk"), dir));
    }
}

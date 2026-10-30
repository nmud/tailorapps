# TailorApps

*TailorApps is the project. On your computer, the app is simply called **Tailor**.*

**[Download for Windows](https://github.com/nmud/tailorapps/releases/latest/download/TailorApps-Setup.exe)** (Mac coming soon) · [Website](https://nmud.github.io/tailorapps/) (source in `website/`)

**You can't prompt what you don't know.** Tailor is a Windows app that notices the things you do over and over (with your permission), suggests small apps that make them easier, builds them with Meta's Muse models, tests them the way you'd use them, and installs them as real apps on your computer.

You don't need to know what software you need, or anything about software at all. Tailor explains every suggestion with something it actually counted:

> *You had up to 13 claude.ai tabs open at once, in all 7 of your recent work sessions.*
> → **Agent Hub**: all your AI chats and tools in one place.

## What it does

1. **Learns how you work.** You choose what it may see: websites (a Chrome or Edge add-on) and apps on this computer. It never reads what you type or copy.
2. **Notices friction.** It notices repetition (copying between the same places, switching back and forth) and clutter (lots of tabs or windows open, lots of AI tools set up).
3. **Suggests apps**, says why, and shows exactly what each app would be allowed to see. You make it, change it, or say "not for me", and Tailor remembers that.
4. **Builds the app**, fixes its own build and runtime errors, then **tries it out the way you would** before you see it. Problems the Tester finds go back to the Builder.
5. **Installs it as a real app**: its own window, taskbar button, icon and Start menu entry. Pin it like any other app.

Tailor itself stays in the system tray when you close it, like Discord, and can start with Windows.

## Agents and models

Everything runs on Meta models. People never choose a model; the backend assigns them (`backend/supabase/functions/tailor/index.ts`).

| Agent | Job | What it sees | Model |
| --- | --- | --- | --- |
| Observer | Turns counted activity signals into patterns | A digest of counts and titles | `muse-spark-1.3` |
| Designer | Ideas: streams three quick idea cards (first in ~7 s), then writes the full plan for the one you make | Patterns, a short profile, your feedback | `muse-spark-1.3` for ideas, `muse-wonder-1.0` for the plan |
| Goals | Reads each goal you set and picks which apps and sites to count; Tailor counts progress and ideas aim at your goals | Your goal and the names of apps and sites seen | `muse-spark-1.3` |
| Builder | Writes, builds and fixes the app | Only the approved spec | `muse-wonder-1.0` |
| Tester | Role-plays the person and uses the app before it ships | The spec, a one-line sketch of the person, the app's screen | `muse-spark-1.3` |

- **Evidence is counted, not generated.** Sessions, copy→paste flows, back-and-forth switching, and tab/window/tool clutter are computed in code (`src/agents/digest.ts`). Models only name and interpret signals by id.
- **The Tester really uses the app.** It reads the screen, clicks, types and chooses, one step at a time, inside a hidden copy (`src/agents/tester.ts` with the harness in `tailor-runtime.js`). Downloads, file pickers, dialogs and links are blocked during the test, and the app's saved data is restored afterwards.

## Safety model

| Concern | What Tailor does |
| --- | --- |
| Generated code | Each app runs in a sealed frame at its own address (`<app>.localhost:48100`) with no Tauri access (verified: calls from inside are dropped) and a CSP that blocks the network unless you approved a host. |
| Live data for apps | Off by default. An idea may ask for **open tabs**, **open windows**, or **AI tool names** (MCP servers, connectors, plugins, skills). You see this before making it, and the app host refuses anything not granted. Tool scanning reads names only, never commands or keys. |
| AI calls | Go to Tailor's backend with your sign-in token. The Muse key is a server secret. Per-person and global daily caps protect the credits (spend-limit alerts don't stop billing). |
| Accounts | Supabase Auth, email and password. The refresh token is kept in Windows Credential Manager; the access token stays in memory and never reaches the page. |
| Observation | Content is never collected. Password managers, banking and sign-in pages are skipped; mail and chat keep only the app or site name; emails, long numbers and tokens are scrubbed. Search words and full addresses are off by default; private windows are ignored. Everything stays local except short summaries sent for ideas. |
| Your data | The Learning page shows everything recorded, what Tailor noticed, and what you told it. Each item can be deleted. History is kept for 30 days by default. |

## Set up

### 1. Backend (Supabase project `tailor`)

Already created and deployed: the `usage` table with its two counting functions, and the `tailor` edge function (`signup`, `chat`). To finish:

- **Add the Muse key:** Supabase dashboard → Edge Functions → Secrets → `MUSE_API_KEY`. Optional: `TAILOR_DAILY_LIMIT` (default 300 per person), `TAILOR_GLOBAL_DAILY_LIMIT` (default 3000), and `MUSE_MODEL_OBSERVER` / `_DESIGNER` / `_BUILDER` / `_TESTER`.
- **Password reset:** under Auth → Email Templates → Reset Password, include `{{ .Token }}` so people get a code (the app asks for it). Supabase's built-in email only reaches project members; add custom SMTP before launch.
- Turn on leaked-password protection (Auth → Passwords).

### 2. Desktop app

Windows 10/11, Node 20+ (for development only; installed Tailor downloads its own build tools), Rust, and the VS C++ Build Tools.

```powershell
cd tailor
npm install
npm run tauri dev        # development
npx tauri build          # installer: src-tauri/target/release/bundle/nsis/Tailor_0.1.0_x64-setup.exe
```

### 3. Browser add-on

`chrome://extensions` (or `edge://extensions`) → Developer mode → Load unpacked → the `extension/` folder. Tailor's onboarding walks through this and shows when it's connected.

### 4. Releasing an update

Installing a newer version updates Tailor in place: same folder, one entry in Installed apps, and everyone's data, sign-in and apps kept. To release one:

1. Bump `version` in `tailor/package.json` (the installer reads it from there), e.g. `0.1.0` → `0.1.1`.
2. Run `npx tauri build` in `tailor/` and share the new `Tailor_<version>_x64-setup.exe`.

Never change `identifier` (`com.tailor.desktop`) or `productName` (`Tailor`) in `tauri.conf.json`: the installer uses them to find the existing install, and the app ID is where everyone's data lives. Changing either installs a second copy instead of updating.

## 3-minute demo

1. **Sign in** (a new account takes seconds) and choose what Tailor may learn from. Turning everything off asks you to confirm.
2. **Learning → Load the sample** (a labelled made-up week), or use real activity.
3. **Ideas:** "Too many AI chats and tools to keep track of: up to 13 claude.ai tabs open at once…" → **Agent Hub**. Point out "Can see the tabs open in your browser" and "Can see the names of the tools set up in your AI apps".
4. **Make this app:** Planning → Building → Trying it out → Ready. Open "Show details" to show the Tester typing and clicking, the problem it found, and the fix.
5. **Want something different?** Ask for one change.
6. **Add to My apps** → Open. It's its own app with its own taskbar button and icon, listing your real AI chats and Claude Code tools. Show it in the Start menu.
7. Close Tailor with X: it stays in the tray. Switch to Midnight in Settings → Appearance and watch the apps follow.

## Project layout

```
backend/supabase/functions/tailor/   sign-up and the Muse proxy (models, caps)
tailor/                              Tauri 2 desktop app
  src/
    App.tsx, AppFrame.tsx            the launcher, and the frame around each generated app
    agents/digest.ts                 counted sessions and signals
    agents/observer.ts               Observer
    agents/designer.ts               Designer
    agents/builder.ts                Builder: write, build, fix, check, test, revise, version
    agents/tester.ts                 Tester
    lib/theme.ts, lib/appIcon.ts     themes (with Mica), and each app's Windows icon
    views/                           Sign in · Onboarding · Ideas · Building · My apps · Learning · Settings
  src-tauri/src/
    auth.rs, llm.rs                  accounts and backend calls
    privacy.rs, collector.rs         privacy floor; app/window/clipboard-change sampler
    aitools.rs                       names of MCP servers, connectors, plugins, skills
    ingest.rs                        browser add-on endpoint
    appserver.rs                     per-app addresses, CSP, approved data feeds, theme
    app_mode.rs, standalone.rs       apps as their own processes, taskbar identity, Start menu
    tray.rs                          tray icon and menu
    workspace.rs                     build tools (private Node if needed), sandboxed writes, builds
  src-tauri/resources/workspace/     app template, app kit (light and dark), runtime and test harness
extension/                           Chrome/Edge add-on
docs/HACKATHON.md                    rules, dates, judging, model choices
```

## Limitations

- **Not yet run against the live Meta Model API.** The pipeline was tested end to end against a local OpenAI-compatible mock, and the release build was tested through the real backend up to the missing-key response. If Muse rejects an optional setting (structured output, reasoning level, streaming), Tailor retries without it.
- Windows only (the desktop collector, Mica, taskbar identity and Start menu entries).
- One local database per computer; signing in as someone else on the same computer shows the same local history and apps.
- Generated apps can use only React, React DOM and lucide-react, plus the data feeds above.

// Reports THAT you copied or pasted on this page, and how many characters. Never the text itself.
(() => {
  const send = (msg) => {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // The extension was reloaded; this page's script is orphaned until refresh.
    }
  };

  document.addEventListener(
    'copy',
    () => {
      const chars = String(document.getSelection() ?? '').length;
      if (chars > 0) send({ type: 'copy', chars });
    },
    true
  );

  document.addEventListener(
    'paste',
    (e) => {
      const chars = (e.clipboardData?.getData('text') ?? '').length;
      const el = e.target;
      const target = el && el.isContentEditable ? 'editor' : String(el?.tagName ?? '').toLowerCase().slice(0, 12);
      if (chars > 0) send({ type: 'paste', chars, target });
    },
    true
  );
})();

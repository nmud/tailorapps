// Managed by Tailor. Two jobs, both only when the app is embedded in Tailor itself:
// 1. Report runtime errors to the Tailor preview so the Builder can fix them.
// 2. Let Tailor's Tester agent read the screen and use the app like a person would.
// It sends only error text and what is visible on screen. Saved data is restored after a test.
(function () {
  // Match Tailor's light or dark theme, and follow it when it changes.
  function syncTheme() {
    fetch('/__tailor/theme', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (t) { document.documentElement.dataset.theme = t.theme === 'dark' ? 'dark' : 'light'; })
      .catch(function () {});
  }
  syncTheme();
  window.addEventListener('focus', syncTheme);
  setInterval(syncTheme, 15000);

  var embedded = window.parent && window.parent !== window;
  var LAUNCHERS = ['http://localhost:1420', 'http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'];
  var errors = [];

  function send(kind, message, stack) {
    if (kind === 'error') errors.push(String(message || '').slice(0, 300));
    if (!embedded) return;
    try {
      window.parent.postMessage(
        { source: 'tailor-app', kind: kind, message: String(message || '').slice(0, 2000), stack: String(stack || '').slice(0, 4000) },
        '*'
      );
    } catch (e) {}
  }
  window.__tailorReport = send;
  window.addEventListener('error', function (e) {
    send('error', e.message, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason || {};
    send('error', r.message || String(r), r.stack);
  });
  window.addEventListener('load', function () {
    setTimeout(function () {
      var root = document.getElementById('root');
      send('ready', root && root.childElementCount > 0 ? 'rendered' : 'empty');
    }, 600);
  });

  if (!embedded) return;

  // ── test harness ──────────────────────────────────────────
  var nextRef = 1;
  var backup = null;
  var notes = [];

  function startTesting() {
    if (window.__tailorTesting) return;
    window.__tailorTesting = true;
    backup = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      backup[k] = localStorage.getItem(k);
    }
    // Nothing a test does may reach the real computer: no dialogs, downloads, file pickers or new windows.
    window.alert = function (m) { notes.push('Message shown: ' + String(m).slice(0, 200)); };
    window.confirm = function (m) { notes.push('Asked to confirm: ' + String(m).slice(0, 200)); return true; };
    window.prompt = function (m) { notes.push('Asked for input: ' + String(m).slice(0, 200)); return ''; };
    window.open = function () { notes.push('Tried to open a new window'); return null; };
    document.addEventListener(
      'click',
      function (e) {
        var el = e.target && e.target.closest ? e.target.closest('a[download], a[href^="blob:"], input[type=file]') : null;
        if (!el) return;
        e.preventDefault();
        notes.push(el.tagName === 'INPUT' ? 'Opened a file picker (skipped during the test)' : 'Started a download (skipped during the test)');
      },
      true
    );
  }

  function endTesting() {
    if (!backup) return;
    localStorage.clear();
    Object.keys(backup).forEach(function (k) { localStorage.setItem(k, backup[k]); });
    backup = null;
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }

  function nameOf(el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return aria;
    if (el.id) {
      var lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab && lab.innerText.trim()) return lab.innerText.trim();
    }
    var wrap = el.closest('label');
    if (wrap && wrap !== el && wrap.innerText.trim()) return wrap.innerText.trim();
    var tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      var txt = (el.innerText || '').trim();
      if (txt) return txt;
    }
    return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
  }

  function snapshot() {
    var sel = 'button, a[href], input, textarea, select, summary, [role=button], [role=tab], [role=checkbox], [role=switch], [role=menuitem], [role=option], [contenteditable=true], [tabindex]:not([tabindex="-1"])';
    var items = [];
    var smallTargets = 0;
    document.querySelectorAll(sel).forEach(function (el) {
      if (!visible(el) || items.length >= 120) return;
      if (!el.dataset.tailorRef) el.dataset.tailorRef = 'e' + nextRef++;
      var r = el.getBoundingClientRect();
      if (r.height < 28 || r.width < 28) smallTargets++;
      var tag = el.tagName.toLowerCase();
      var role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? el.type || 'text' : tag);
      var item = { ref: el.dataset.tailorRef, role: role, name: nameOf(el).replace(/\s+/g, ' ').slice(0, 80) };
      if ((tag === 'input' || tag === 'textarea' || tag === 'select') && el.type !== 'checkbox') item.value = String(el.value || '').slice(0, 80);
      if (el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true') item.on = true;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
      items.push(item);
    });
    var tinyText = 0;
    document.querySelectorAll('p, span, li, td, th, label, button, a, h1, h2, h3, div').forEach(function (el) {
      if (el.children.length === 0 && (el.textContent || '').trim() && visible(el) && parseFloat(getComputedStyle(el).fontSize) < 13) tinyText++;
    });
    return {
      title: document.title,
      text: (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 3500),
      elements: items,
      errors: errors.slice(-5),
      notes: notes.splice(0),
      smallTargets: smallTargets,
      tinyText: tinyText,
    };
  }

  function setValue(el, v) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function act(cmd) {
    var el = document.querySelector('[data-tailor-ref="' + cmd.ref + '"]');
    if (!el) return 'That control is no longer on screen.';
    el.scrollIntoView({ block: 'center' });
    if (cmd.op === 'click') {
      if (el.focus) el.focus();
      el.click();
    } else if (cmd.op === 'type') {
      el.focus();
      setValue(el, cmd.text || '');
    } else if (cmd.op === 'select') {
      var opt = Array.prototype.find.call(el.options || [], function (o) { return o.text === cmd.text || o.value === cmd.text; });
      setValue(el, opt ? opt.value : cmd.text || '');
    } else if (cmd.op === 'press') {
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      var form = el.form || el.closest('form');
      if (form && form.requestSubmit) form.requestSubmit();
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    }
    return null;
  }

  window.addEventListener('message', function (e) {
    var cmd = e.data;
    if (LAUNCHERS.indexOf(e.origin) < 0 || !cmd || cmd.source !== 'tailor-test') return;
    function reply(result) {
      e.source.postMessage({ source: 'tailor-app', kind: 'test-result', id: cmd.id, result: result }, e.origin);
    }
    if (cmd.op === 'begin') {
      startTesting();
      return reply(snapshot());
    }
    if (cmd.op === 'end') {
      endTesting();
      return reply({ ok: true });
    }
    if (cmd.op === 'snapshot') return reply(snapshot());
    var problem = act(cmd);
    setTimeout(function () {
      var shot = snapshot();
      if (problem) shot.problem = problem;
      reply(shot);
    }, 400);
  });
})();

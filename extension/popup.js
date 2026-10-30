async function render() {
  const c = await chrome.storage.local.get(['paused', 'server']);
  const s = c.server;
  const status = document.getElementById('status');
  const detail = document.getElementById('detail');
  document.getElementById('paused').checked = !!c.paused;

  if (c.paused) {
    status.textContent = 'Paused';
    status.className = 'status off';
    detail.textContent = 'Nothing is being noted.';
  } else if (!s || !s.connected) {
    status.textContent = 'Not connected';
    status.className = 'status off';
    detail.textContent = 'Open the Tailor app on this computer.';
  } else if (!s.learning) {
    status.textContent = 'Learning is off';
    status.className = 'status off';
    detail.textContent = 'You can turn it on in the Tailor app.';
  } else {
    status.textContent = 'On';
    status.className = 'status on';
    detail.textContent = 'Connected to Tailor.';
  }
}

document.getElementById('paused').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ paused: e.target.checked });
  render();
});
chrome.storage.onChanged.addListener(render);
render();

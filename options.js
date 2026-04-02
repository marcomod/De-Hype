const keyInput = document.getElementById('api-key');
const status = document.getElementById('status');
const saveBtn = document.getElementById('save');

const renderStatus = (value) => {
  status.textContent = value ? `Saved key: ${value.slice(0, 8)}...` : 'No key saved yet.';
};

chrome.storage.local.get(['openaiApiKey']).then((state) => {
  renderStatus(state.openaiApiKey);
  if (state.openaiApiKey) keyInput.value = state.openaiApiKey;
});

saveBtn.addEventListener('click', async () => {
  const key = (keyInput.value || '').trim();
  await chrome.storage.local.set({ openaiApiKey: key });
  renderStatus(key);
  saveBtn.textContent = 'Saved';
  setTimeout(() => {
    saveBtn.textContent = 'Save key';
  }, 900);
});

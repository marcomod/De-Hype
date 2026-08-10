const keyInput = document.getElementById('api-key');
const status = document.getElementById('status');
const saveBtn = document.getElementById('save');

const renderStatus = (hasSavedKey) => {
  status.textContent = hasSavedKey ? 'API key saved locally.' : 'No key saved yet.';
};

chrome.storage.local.get(['openaiApiKey']).then((state) => {
  renderStatus(Boolean(state.openaiApiKey));
});

saveBtn.addEventListener('click', async () => {
  const key = (keyInput.value || '').trim();
  await chrome.storage.local.set({ openaiApiKey: key });
  keyInput.value = '';
  renderStatus(Boolean(key));
  saveBtn.textContent = 'Saved';
  setTimeout(() => {
    saveBtn.textContent = 'Save key';
  }, 900);
});

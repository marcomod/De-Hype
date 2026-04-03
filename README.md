# De-Hype

De-Hype is a Chrome Extension that neutralizes clickbait headlines in real time.

It preserves page layout, watches dynamic DOM updates, and inserts a cleaner de-hyped summary under target headlines.

## Why this exists

Clickbait is optimized for attention, not clarity. De-Hype rewrites headlines into neutral language so you can scan content faster and with less noise.

## Key Features

- Non-destructive headline enhancement (does not replace the original DOM title node)
- Real-time processing with MutationObserver + viewport gating
- AI rewrite pipeline using `gpt-4o-mini`
- Local cache and daily budget controls to reduce API cost
- Fallback rewrite path when API is unavailable/quota-limited
- Popup control center:
  - enable/disable
  - rewrite mode (`Subtle`, `Balanced`, `Aggressive`)
  - per-site toggles
  - demo mode
  - pause current tab
  - session recap metrics

## Demo Mode

When **Demo Mode** is ON:

- De-Hype skips live API calls
- Uses deterministic local rewriting
- Still produces stable output for recordings/demos
- Avoids failures from quota/network/API issues

## Supported Sites

- YouTube (`youtube.com`)
- CNN (`cnn.com`)
- The Verge (`theverge.com`)

## Architecture (MV3)

- `contentScript.js`
  - Finds headline nodes by site profile
  - Observes DOM changes and lazy-loaded content
  - Injects de-hyped summary blocks under headline containers
- `background.js` (service worker)
  - Handles OpenAI calls
  - Cache + budget + stats + recap
  - Fallback behavior and error/backoff handling
- `popup/App.jsx`
  - Main controls and runtime status
- `options.html` + `options.js`
  - API key storage (`chrome.storage.local`)

## Local Setup

1. Install dependencies

```bash
npm install
```

2. Build the extension

```bash
npm run build
```

3. Load in Chrome

- Open `chrome://extensions`
- Enable **Developer mode**
- Click **Load unpacked**
- Select the `dist` folder from this project

4. Set your OpenAI key

- Open extension **Options** page
- Save `openaiApiKey`

## Usage

1. Open a supported site page
2. Open De-Hype popup
3. Turn De-Hype ON
4. Choose mode (`Subtle`, `Balanced`, `Aggressive`)
5. Optional: turn ON Demo Mode for stable recordings
6. Optional: pause only current tab when needed

## Keyboard Shortcuts

Configured in `manifest.json`:

- `Ctrl/Cmd + Shift + Y` → Toggle De-Hype
- `Ctrl/Cmd + Shift + D` → Toggle Demo Mode
- `Ctrl/Cmd + Shift + P` → Pause/Resume current tab

## Troubleshooting

### Rewrites not appearing

- Confirm extension is enabled in popup
- Confirm site toggle is enabled (YouTube/CNN/The Verge)
- Refresh page after reloading extension

### `429 insufficient_quota`

- Add billing/credits to your OpenAI account
- Use Demo Mode if you need immediate stable behavior

### Works on one site but not another

- Site DOM may have changed; selectors may need update in `contentScript.js`

## Project Structure

```text
manifest.json
background.js
contentScript.js
popup/
  App.jsx
  main.jsx
  styles.css
popup.html
options.html
options.js
vite.config.js
tailwind.config.js
postcss.config.js
```

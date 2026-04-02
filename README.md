<<<<<<< HEAD

# De-Hype

Chrome extension that rewrites sensationalist titles to short factual summaries.

## Run / test locally

1. Install dependencies
   - `cd '/Users/marcomodestino/Downloads/My Stuff/dehype'`
   - `npm install`
2. Build the extension assets
   - `npm run build`
3. In Chrome, open `chrome://extensions`
4. Enable Developer mode
5. Click **Load unpacked** and select `dist` inside this folder
6. Open the extension options page and save your OpenAI key
   - Open extension settings → **Options** or manually open `options.html` from the extension
   - Paste a valid OpenAI API key (for `gpt-4o-mini`)
7. Open YouTube or supported news pages and flip **Enable De-Hype** in the popup

## Files included

- `manifest.json`: MV3 extension manifest
- `background.js`: service worker with OpenAI + caching logic
- `contentScript.js`: DOM observer + `deHypeElement`
- `popup.html`: popup host
- `popup/main.jsx`: React entry
- `popup/App.js`: popup app component
- `popup/styles.css`: Tailwind stylesheet source
- `options.html` + `options.js`: store API key in `chrome.storage.local`
- `vite.config.js`, `tailwind.config.js`, `postcss.config.js`: build setup

## Notes

- Cached rewrites are stored in `chrome.storage.local` and reused across sessions.
- Counter is reset each local day.

import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react-swc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = resolve(__dirname, 'dist');

function copyExtensionAssets() {
  return {
    name: 'copy-extension-assets',
    writeBundle() {
      mkdirSync(distDir, { recursive: true });
      copyFileSync(resolve(__dirname, 'manifest.json'), resolve(distDir, 'manifest.json'));
      copyFileSync(resolve(__dirname, 'background.js'), resolve(distDir, 'background.js'));
      copyFileSync(resolve(__dirname, 'contentScript.js'), resolve(distDir, 'contentScript.js'));
      copyFileSync(resolve(__dirname, 'options.html'), resolve(distDir, 'options.html'));
      copyFileSync(resolve(__dirname, 'options.js'), resolve(distDir, 'options.js'));
    }
  };
}

export default {
  plugins: [react(), copyExtensionAssets()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html')
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  }
};

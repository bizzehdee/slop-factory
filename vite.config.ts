import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The release workflow stamps the version from its vX.Y.Z tag into package.json; the app shows it.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Tauri expects a fixed dev port and doesn't want Vite clearing its output.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
  define: { __APP_VERSION__: JSON.stringify(version) },
});

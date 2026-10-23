import { defineConfig } from 'vite';

// Tauri expects a fixed dev port and doesn't want Vite clearing its output.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});

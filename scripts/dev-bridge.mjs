// Dev-only: runs one sidecar and exposes it to the browser over ws://127.0.0.1:1421, so you
// can work on the UI with `npm run dev:browser` without rebuilding the Tauri shell.
// Like the desktop app, the sidecar outlives page reloads: reopened projects replay their state.
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'sidecar', 'dist', 'index.js');
const wss = new WebSocketServer({ host: '127.0.0.1', port: 1421 });

let child;
let alive = false;
function sidecar() {
  if (child && alive) return child;
  child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] });
  alive = true;
  createInterface({ input: child.stdout }).on('line', (line) => {
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(line);
  });
  child.on('exit', (code, signal) => {
    alive = false;
    console.log(`Sidecar exited (${signal ?? `code ${code}`}). It restarts on the next connection.`);
  });
  return child;
}

wss.on('connection', (ws) => {
  sidecar();
  ws.on('message', (data) => sidecar().stdin.write(String(data).replace(/\n/g, ' ') + '\n'));
});

process.on('SIGINT', () => {
  child?.stdin.end();
  process.exit(0);
});

console.log('Dev bridge listening on ws://127.0.0.1:1421');

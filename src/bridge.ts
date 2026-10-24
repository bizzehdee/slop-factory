// Talks to the sidecar. Inside Tauri it goes through the Rust shell (invoke + events);
// in a plain browser (npm run dev:browser) it goes through scripts/dev-bridge.mjs over a WebSocket.
import type { SidecarEvent, UiCommand } from '../sidecar/src/protocol';

type Listener = (e: SidecarEvent) => void;

export interface Bridge {
  send(cmd: UiCommand): void;
  onEvent(fn: Listener): void;
  pickFolder(): Promise<string | null>;
  notify(title: string, body: string): Promise<void>;
  /** Closing the window or quitting was asked for; quit() goes ahead, doing nothing keeps the app open. */
  onQuitRequested(fn: () => void): void;
  quit(): Promise<void>;
  readonly mode: 'tauri' | 'browser';
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function tauriBridge(): Promise<Bridge> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const notification = await import('@tauri-apps/plugin-notification');
  const listeners: Listener[] = [];
  await listen<string>('sidecar://event', ({ payload }) => {
    try {
      const e = JSON.parse(payload) as SidecarEvent;
      listeners.forEach((fn) => fn(e));
    } catch {
      /* ignore non-JSON lines */
    }
  });
  const quitListeners: (() => void)[] = [];
  await listen('app://quit-requested', () => {
    void invoke('quit_ack');
    if (!quitListeners.length) return void invoke('quit_confirmed');
    quitListeners.forEach((fn) => fn());
  });
  await invoke('sidecar_start');
  return {
    mode: 'tauri',
    onQuitRequested: (fn) => quitListeners.push(fn),
    quit: () => invoke('quit_confirmed'),
    send: (cmd) => void invoke('sidecar_send', { line: JSON.stringify(cmd) }),
    onEvent: (fn) => listeners.push(fn),
    pickFolder: async () => {
      const picked = await open({ directory: true, multiple: false, title: 'Open project' });
      return typeof picked === 'string' ? picked : null;
    },
    notify: async (title, body) => {
      let granted = await notification.isPermissionGranted();
      if (!granted) granted = (await notification.requestPermission()) === 'granted';
      if (granted) notification.sendNotification({ title, body });
    },
  };
}

function browserBridge(): Bridge {
  const listeners: Listener[] = [];
  const queue: string[] = [];
  let ws: WebSocket | undefined;

  const connect = () => {
    ws = new WebSocket(`ws://${location.hostname}:1421`);
    ws.onopen = () => queue.splice(0).forEach((l) => ws!.send(l));
    ws.onmessage = (m) => {
      const e = JSON.parse(String(m.data)) as SidecarEvent;
      listeners.forEach((fn) => fn(e));
    };
    ws.onclose = () => {
      console.error('Lost the dev bridge. Is `node scripts/dev-bridge.mjs` running?');
      setTimeout(connect, 2000);
    };
  };
  connect();

  // A browser tab can't hold its own closing, so a quit is only ever asked for by the tests,
  // through a slop:quit-requested event; going ahead is recorded rather than closing anything.
  const quitListeners: (() => void)[] = [];
  window.addEventListener('slop:quit-requested', () => quitListeners.forEach((fn) => fn()));
  return {
    mode: 'browser',
    onQuitRequested: (fn) => quitListeners.push(fn),
    quit: async () => {
      (window as { __quit?: boolean }).__quit = true;
    },
    send: (cmd) => {
      const line = JSON.stringify(cmd);
      if (ws?.readyState === WebSocket.OPEN) ws.send(line);
      else queue.push(line);
    },
    onEvent: (fn) => listeners.push(fn),
    pickFolder: async () => window.prompt('Project folder (absolute path)')?.trim() || null,
    notify: async (title, body) => {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission === 'granted') new Notification(title, { body });
    },
  };
}

export const createBridge = (): Promise<Bridge> => (isTauri ? tauriBridge() : Promise.resolve(browserBridge()));

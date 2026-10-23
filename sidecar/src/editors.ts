import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EditorInfo } from './protocol.js';

// Editors "Open with" offers when they are installed. Each is found by its command on PATH,
// its macOS app bundle, or its usual Windows install path, in that order.
interface EditorSpec {
  id: string;
  name: string;
  commands: string[];
  macApps: string[];
  winPaths: string[]; // relative to %LOCALAPPDATA% when not absolute
}

const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const PROGRAMS = process.env.ProgramFiles ?? 'C:\\Program Files';
const TOOLBOX = process.platform === 'win32' ? path.join(LOCAL, 'JetBrains', 'Toolbox', 'scripts') : path.join(os.homedir(), '.local', 'share', 'JetBrains', 'Toolbox', 'scripts');

const EDITORS: EditorSpec[] = [
  { id: 'vscode', name: 'Visual Studio Code', commands: ['code'], macApps: ['Visual Studio Code'], winPaths: ['Programs\\Microsoft VS Code\\Code.exe', `${PROGRAMS}\\Microsoft VS Code\\Code.exe`] },
  { id: 'cursor', name: 'Cursor', commands: ['cursor'], macApps: ['Cursor'], winPaths: ['Programs\\cursor\\Cursor.exe'] },
  { id: 'zed', name: 'Zed', commands: ['zed', 'zeditor'], macApps: ['Zed'], winPaths: ['Programs\\Zed\\Zed.exe'] },
  { id: 'sublime', name: 'Sublime Text', commands: ['subl'], macApps: ['Sublime Text'], winPaths: [`${PROGRAMS}\\Sublime Text\\sublime_text.exe`, `${PROGRAMS}\\Sublime Text 3\\sublime_text.exe`] },
  { id: 'idea', name: 'IntelliJ IDEA', commands: ['idea'], macApps: ['IntelliJ IDEA', 'IntelliJ IDEA CE', 'IntelliJ IDEA Ultimate'], winPaths: [path.join(TOOLBOX, 'idea.cmd')] },
  { id: 'webstorm', name: 'WebStorm', commands: ['webstorm'], macApps: ['WebStorm'], winPaths: [path.join(TOOLBOX, 'webstorm.cmd')] },
  { id: 'pycharm', name: 'PyCharm', commands: ['pycharm', 'charm'], macApps: ['PyCharm', 'PyCharm CE', 'PyCharm Professional Edition'], winPaths: [path.join(TOOLBOX, 'pycharm.cmd')] },
];

type Launch = { cmd: string; args: (dir: string) => string[]; shell?: boolean };

const isFile = (p: string) => fs.stat(p).then((s) => s.isFile(), () => false);
const isDir = (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false);

async function onPath(command: string): Promise<string | undefined> {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), TOOLBOX].filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) for (const ext of exts) if (await isFile(path.join(dir, command + ext))) return path.join(dir, command + ext);
  return undefined;
}

async function find(spec: EditorSpec): Promise<Launch | undefined> {
  if (process.platform === 'darwin') {
    // Finder-launched apps get a bare PATH, so prefer the app bundle there.
    for (const app of spec.macApps) {
      for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
        if (await isDir(path.join(root, `${app}.app`))) return { cmd: 'open', args: (dir) => ['-a', app, dir] };
      }
    }
  }
  for (const command of spec.commands) {
    const found = await onPath(command);
    // Windows editors install .cmd shims, which only run through a shell.
    if (found) return { cmd: found, args: (dir) => [dir], shell: /\.(cmd|bat)$/i.test(found) };
  }
  if (process.platform === 'win32') {
    for (const p of spec.winPaths) {
      const full = path.isAbsolute(p) ? p : path.join(LOCAL, p);
      if (await isFile(full)) return { cmd: full, args: (dir) => [dir], shell: /\.(cmd|bat)$/i.test(full) };
    }
  }
  return undefined;
}

let found: Promise<Map<string, Launch>> | undefined;

function detect(): Promise<Map<string, Launch>> {
  found ??= (async () => {
    const map = new Map<string, Launch>();
    for (const spec of EDITORS) {
      const launch = await find(spec);
      if (launch) map.set(spec.id, launch);
    }
    return map;
  })();
  return found;
}

export async function installedEditors(): Promise<EditorInfo[]> {
  const map = await detect();
  return EDITORS.filter((e) => map.has(e.id)).map((e) => ({ id: e.id, name: e.name }));
}

export async function openInEditor(id: string, dir: string): Promise<void> {
  const launch = (await detect()).get(id);
  if (!launch) throw new Error(`${EDITORS.find((e) => e.id === id)?.name ?? id} isn't installed.`);
  const args = launch.args(dir);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.shell ? `"${launch.cmd}"` : launch.cmd, launch.shell ? args.map((a) => `"${a}"`) : args, {
      detached: true,
      stdio: 'ignore',
      shell: launch.shell,
      windowsHide: true,
    });
    child.once('error', (err) => reject(new Error(`Couldn't start ${id}: ${err.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

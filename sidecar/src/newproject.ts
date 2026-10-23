import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { NewProjectRequest } from './protocol.js';
import { configDir } from './providers.js';

const run = promisify(execFile);
export const FRAMEWORK_REPO = 'https://github.com/bizzehdee/agent-framework';

/** A folder name for a project name: "Slop Factory" -> "slop-factory". */
export function folderFor(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '');
}

function validFolder(folder: string): boolean {
  return !!folder && folder !== '.' && folder !== '..' && !/[\\/:*?"<>|]/.test(folder);
}

async function sh(cmd: string, args: string[], cwd: string, log: (line: string) => void): Promise<string> {
  log(`$ ${[cmd, ...args].join(' ')}`);
  try {
    const { stdout } = await run(cmd, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`${cmd} ${args[0] ?? ''} failed: ${(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')}`);
  }
}

/** A copy of agent-framework kept beside the app's settings, fetched or brought up to date. */
export async function frameworkCopy(log: (line: string) => void): Promise<string> {
  const dir = path.join(configDir(), 'agent-framework');
  const have = await fs.stat(path.join(dir, '.git')).then(() => true, () => false);
  if (!have) {
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await sh('git', ['clone', '--depth', '1', FRAMEWORK_REPO, dir], path.dirname(dir), log);
    return dir;
  }
  try {
    await sh('git', ['pull', '--ff-only'], dir, log);
  } catch (err) {
    // Offline or diverged: the copy we have still installs.
    log(`Couldn't update agent-framework (${err instanceof Error ? err.message : String(err)}); using the copy already here.`);
  }
  return dir;
}

/**
 * AGENTS.md for "basic task tracking": the framework's task-tracking standard on its own. References
 * to standards that aren't installed become plain mentions.
 */
export function basicAgentsMd(standard: string): string {
  const body = standard
    .replace(/^---\n[\s\S]*?\n---\n+/, '')
    .replace(/^# Task tracking\n+/, '')
    .replace(/\s*\(\[\[([a-z-]+)\]\]\)/g, '')
    .replace(/\[\[([a-z-]+)\]\]/g, (_all, name: string) => `the ${name.replace(/-/g, ' ')} standard`);
  // Its sections sit one level down, under "Task tracking". Examples inside code fences keep their headings.
  let fence = false;
  const shifted = body
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      return !fence && /^#{1,5} /.test(line) ? `#${line}` : line;
    })
    .join('\n');
  return (
    '# Agent instructions\n\n' +
    `This project uses the task and bug tracking rules from [agent-framework](${FRAMEWORK_REPO}) and nothing else from it.\n\n` +
    '## Task tracking\n\n' +
    shifted.trim() +
    '\n'
  );
}

/** Make the folder, set up git and the framework as asked, and return the new project's path. */
export async function createProject(req: NewProjectRequest, log: (line: string) => void): Promise<string> {
  const name = req.name.trim();
  const folder = (req.folder ?? '').trim() || folderFor(name);
  if (!name) throw new Error('Give the project a name.');
  if (!validFolder(folder)) throw new Error(`"${folder}" can't be a folder name.`);
  const parent = path.resolve(req.parent);
  if (!(await fs.stat(parent).then((s) => s.isDirectory(), () => false))) throw new Error(`Not a folder: ${parent}`);
  const dir = path.join(parent, folder);
  const existing = await fs.readdir(dir).catch(() => null);
  if (existing && existing.length) throw new Error(`${dir} already exists and isn't empty.`);
  await fs.mkdir(dir, { recursive: true });
  log(`Created ${dir}`);

  if (req.git) {
    try {
      await sh('git', ['init', '-b', 'main'], dir, log);
    } catch {
      await sh('git', ['init'], dir, log); // git before 2.28 has no -b
    }
    const remote = req.remote?.trim();
    if (remote) await sh('git', ['remote', 'add', 'origin', remote], dir, log);
  }

  if (req.framework !== 'none') {
    const fw = await frameworkCopy(log);
    if (req.framework === 'full') {
      // Claude Code reads .claude/skills/, so the claude adapter's pointers let it find each standard.
      if (process.platform === 'win32') await sh('pwsh', ['-NoProfile', '-File', path.join(fw, 'install.ps1'), '-Target', dir, '-Adapters', 'claude', '-Yes'], fw, log);
      else await sh('sh', [path.join(fw, 'install.sh'), dir, '--yes', '--adapters', 'claude'], fw, log);
    } else {
      const standard = await fs.readFile(path.join(fw, 'standards', 'task-tracking.md'), 'utf8');
      await fs.writeFile(path.join(dir, 'AGENTS.md'), basicAgentsMd(standard), 'utf8');
      log('Wrote AGENTS.md with the task and bug tracking rules');
    }
  }
  return dir;
}

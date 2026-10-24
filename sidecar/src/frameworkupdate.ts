import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FrameworkStatus } from './protocol.js';
import { TASK_TRACKING_STAMP, basicAgentsMd, frameworkCopy, standardVersion } from './newproject.js';
import { writeFileAtomic } from './names.js';

// ---------- is the project's agent-framework the current one, and bringing it up to date ----------

const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;
const BASIC_MARK = 'task and bug tracking rules from [agent-framework]';

const read = (file: string) => fs.readFile(file, 'utf8').catch(() => '');
const exists = (file: string) => fs.access(file).then(() => true, () => false);

/** How agent-framework went into the project, if it did: by its installer, or the app's task-tracking-only AGENTS.md. */
export async function frameworkKind(dir: string): Promise<FrameworkStatus['kind']> {
  const agents = await read(path.join(dir, 'AGENTS.md'));
  if (/Standards version: [0-9a-f]+/.test(agents) || /Standards version: [0-9a-f]+/.test(await read(path.join(dir, '.claude', 'CLAUDE.md')))) return 'full';
  if (agents.includes(BASIC_MARK)) return 'basic';
  // Installs from before the stamp: the installer's skill for task tracking is there.
  if (await exists(path.join(dir, '.agents', 'skills', 'task-tracking', 'SKILL.md'))) return 'full';
  return 'none';
}

/** The "## Task tracking" section of an AGENTS.md: from its heading to the next level-two heading outside a code fence. */
export function taskSection(text: string): { start: number; end: number } | null {
  const lines = text.split('\n');
  let at = -1;
  let fence = false;
  let offset = 0;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) {
      if (at >= 0) return { start: at, end: offset };
      if (/^## Task tracking\s*$/.test(line)) at = offset;
    }
    offset += line.length + 1;
  }
  return at >= 0 ? { start: at, end: text.length } : null;
}

const sectionText = (text: string): string | null => {
  const s = taskSection(text);
  return s ? text.slice(s.start, s.end).replace(TASK_TRACKING_STAMP, '').trim() : null;
};

/** Compare a task-tracking-only AGENTS.md with what the current standard gives. */
export function checkBasic(agentsMd: string, standard: string): Omit<FrameworkStatus, 'kind'> {
  const installed = (taskSection(agentsMd) && agentsMd.match(TASK_TRACKING_STAMP)?.[1]) || 'unstamped';
  const outdated = sectionText(agentsMd) !== sectionText(basicAgentsMd(standard));
  return { installed, current: standardVersion(standard), outdated, differ: outdated ? 1 : 0, missing: 0 };
}

/** The task-tracking section brought up to date, and anything else in the file left as it was. */
export function upgradeBasic(agentsMd: string, standard: string): string {
  const fresh = basicAgentsMd(standard);
  const want = fresh.slice(taskSection(fresh)!.start).trimEnd();
  const have = taskSection(agentsMd);
  if (!have) return `${agentsMd.trimEnd()}\n\n${want}\n`;
  const after = agentsMd.slice(have.end);
  return `${agentsMd.slice(0, have.start)}${want}\n${after ? `\n${after}` : ''}`;
}

/** What the installer's check said. */
export function parseCheck(out: string): Omit<FrameworkStatus, 'kind'> {
  const installed = out.match(/Installed version:\s*(\S+)/)?.[1];
  const current = out.match(/Current version:\s*(\S+)/)?.[1];
  const counts = out.match(/(\d+) up to date, (\d+) differ, (\d+) missing/);
  const differ = counts ? Number(counts[2]) : 0;
  const missing = counts ? Number(counts[3]) : 0;
  // Leftovers from an earlier layout make an install out of date too, though every current file matches.
  const leftovers = /Left over from an earlier layout/.test(out);
  return { installed, current: current === 'unknown' ? undefined : current, outdated: /Out of date/.test(out) || differ + missing > 0 || leftovers, differ, missing };
}

async function installer(fw: string, dir: string, mode: 'check' | 'upgrade'): Promise<{ code: number; out: string }> {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['pwsh', ['-NoProfile', '-File', path.join(fw, 'install.ps1'), '-Target', dir, mode === 'check' ? '-Check' : '-Upgrade']]
      : ['sh', [path.join(fw, 'install.sh'), dir, `--${mode}`]];
  try {
    const { stdout, stderr } = await run(cmd, args, { cwd: fw, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message: string };
    // The check exits 1 for "out of date", which is an answer, not a failure.
    if (typeof e.code === 'number') return { code: e.code, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    throw new Error(`${cmd} couldn't run: ${e.message}`);
  }
}

const lastLines = (out: string, n: number) => out.trim().split('\n').filter((l) => l.trim()).slice(-n).join(' ');

export interface FrameworkHooks {
  emit: (status: FrameworkStatus) => void;
  notice: (level: 'info' | 'warn' | 'error', text: string) => void;
  dismissed: () => string | undefined;
  undismiss: () => Promise<void>;
  agentBusy: () => boolean;
  changed: () => void; // files in the project changed: git should look again
}

/** Checks one project's agent-framework when it opens and once a day after, and upgrades it when asked. */
export class FrameworkMonitor {
  status: FrameworkStatus = { kind: 'none', outdated: false };
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private dir: string,
    private hooks: FrameworkHooks,
  ) {}

  start(): void {
    void this.check(false);
    this.timer = setInterval(() => void this.check(false), DAY);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private set(next: Partial<FrameworkStatus>): void {
    this.status = { ...this.status, ...next };
    const dismissed = !!this.status.current && this.hooks.dismissed() === this.status.current;
    if (!this.stopped) this.hooks.emit({ ...this.status, dismissed });
  }

  /** manual: asked for from the menu, so update the copy now and say what was found. */
  async check(manual: boolean): Promise<void> {
    if (this.status.checking || this.status.upgrading) return;
    const kind = await frameworkKind(this.dir);
    if (kind === 'none') {
      this.set({ kind, outdated: false, installed: undefined, current: undefined, error: undefined });
      if (manual) this.hooks.notice('info', 'This project doesn’t use agent-framework.');
      return;
    }
    this.set({ kind, checking: true });
    try {
      const fw = await frameworkCopy(() => undefined, manual ? 0 : DAY);
      let found: Omit<FrameworkStatus, 'kind'>;
      if (kind === 'basic') {
        const standard = await fs.readFile(path.join(fw, 'standards', 'task-tracking.md'), 'utf8');
        found = checkBasic(await read(path.join(this.dir, 'AGENTS.md')), standard);
      } else {
        const { code, out } = await installer(fw, this.dir, 'check');
        if (code !== 0 && code !== 1) throw new Error(lastLines(out, 2) || `the installer's check exited with ${code}`);
        found = parseCheck(out);
      }
      this.set({ ...found, kind, checking: false, error: undefined });
      if (manual) {
        // Asking again shows it again, though "not now" was said to this version before.
        if (this.hooks.dismissed()) {
          await this.hooks.undismiss();
          this.set({});
        }
        this.hooks.notice('info', found.outdated ? describe(this.status) : `agent-framework is up to date (${found.current ?? 'current version'}).`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.set({ kind, checking: false, error });
      if (manual) this.hooks.notice('warn', `Couldn’t check agent-framework: ${error}`);
    }
  }

  async upgrade(): Promise<void> {
    if (this.status.upgrading || this.status.checking || this.status.kind === 'none') return;
    if (this.hooks.agentBusy()) return this.hooks.notice('warn', 'The agent is working in this project. Upgrade agent-framework once it has finished, so the files don’t change under it.');
    const from = this.status.installed;
    this.set({ upgrading: true });
    try {
      const fw = await frameworkCopy(() => undefined, DAY);
      let summary: string;
      if (this.status.kind === 'basic') {
        const standard = await fs.readFile(path.join(fw, 'standards', 'task-tracking.md'), 'utf8');
        const file = path.join(this.dir, 'AGENTS.md');
        await writeFileAtomic(file, upgradeBasic(await read(file), standard));
        summary = 'Rewrote the task tracking section of AGENTS.md.';
      } else {
        const { code, out } = await installer(fw, this.dir, 'upgrade');
        if (code !== 0) throw new Error(lastLines(out, 2) || `the installer exited with ${code}`);
        summary = logSummary(out, this.dir);
      }
      this.set({ upgrading: false });
      this.hooks.changed();
      await this.check(false);
      const to = this.status.current;
      this.hooks.notice('info', `Upgraded agent-framework${from && to && from !== to ? ` from ${from} to ${to}` : to ? ` to ${to}` : ''}. Look over the changes under “uncommitted” before committing them.\n\n${summary}`);
    } catch (err) {
      this.set({ upgrading: false });
      this.hooks.notice('error', `Couldn’t upgrade agent-framework: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The installer's log, short enough for the transcript: the files it wrote, then what it said at the end. */
export function logSummary(out: string, dir?: string): string {
  // Paths inside the project read better without the project's own path in front.
  const lines = out.split('\n').map((l) => (dir ? l.split(`${dir}${path.sep}`).join('') : l).trimEnd());
  const files = lines.filter((l) => /^\s+[+-] /.test(l)).map((l) => l.trim());
  const shown = files.slice(0, 12);
  const rest = lines.filter((l) => l.trim() && !/^\s+[+-] /.test(l) && !/^(Upgrading|Adapters kept|Stacks kept):/.test(l));
  return [...shown, files.length > shown.length ? `…and ${files.length - shown.length} more` : '', ...rest].filter(Boolean).join('\n');
}

export function describe(s: FrameworkStatus): string {
  if (s.installed && s.current && s.installed !== s.current) return `agent-framework is out of date here (${s.installed} → ${s.current}).`;
  const n = (s.differ ?? 0) + (s.missing ?? 0);
  return n ? `${n} agent-framework file${n === 1 ? '' : 's'} here ${n === 1 ? 'isn’t' : 'aren’t'} what version ${s.current ?? 'current'} has.` : 'agent-framework has files left over from an earlier version.';
}

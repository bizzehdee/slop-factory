import { execFile } from 'node:child_process';
import type { ChangedFile, GitInfo } from './protocol.js';

// The project's git repository, through the git command-line tool: where its branch stands
// against its upstream, fetching on a timer, and pulling (fast-forward only) and pushing on
// request. Pulling by itself is opt-in per project, and only happens when it can't disturb
// anything: the agent idle, nothing uncommitted, and the branch simply behind.

const QUICK = 30_000; // status and the like
const NETWORK = 120_000; // fetch, pull, push
const STATUS_EVERY = 30_000;
const DEBOUNCE = 400;

export class GitError extends Error {}

interface RunOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

/** Run git; its output, or a GitError with what git said went wrong. */
export function git(cwd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: opts.timeout ?? QUICK, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: opts.env ?? process.env },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') return reject(new GitError('git isn’t installed, or isn’t on the PATH.'));
        if (e.killed) return reject(new GitError(`git ${args[0]} took too long and was stopped. If it needs a password or passphrase, set up a credential helper or SSH agent so it can run without asking.`));
        reject(new GitError(gitMessage(String(stderr || stdout || e.message))));
      },
    );
  });
}

/** The useful part of what git printed: its fatal and error lines, else its last lines, without hints. */
export function gitMessage(out: string): string {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^hint:/i.test(l));
  const important = lines.filter((l) => /^(fatal|error|remote: error)\b/i.test(l) || /rejected/.test(l));
  return (important.length ? important : lines.slice(-3)).map((l) => l.replace(/^(fatal|error):\s*/i, '')).join(' ').slice(0, 500) || 'git failed.';
}

const MAX_DIFF = 400_000;
const MAX_FILES = 500;
const MAX_NEW_FILE_DIFFS = 50;

/** One line of git status --porcelain=v1: what kind of change it is. */
function changeKind(xy: string): ChangedFile['status'] {
  if (xy === '??') return 'untracked';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflict';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy[0] === 'A') return 'added';
  return 'modified';
}

/** git status --porcelain=v1 -z, as files. A rename's entry is followed by the name it had. */
export function parseChanges(z: string): ChangedFile[] {
  const parts = z.split('\0');
  const out: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const file: ChangedFile = { path: e.slice(3), status: changeKind(xy) };
    if (xy.includes('R') || xy.includes('C')) file.from = parts[++i];
    out.push(file);
  }
  return out;
}

/** What isn't committed: each file and how it changed, and one diff of it all. Reads only. */
export async function uncommittedChanges(root: string): Promise<{ files: ChangedFile[]; diff: string; more: number }> {
  const z = await git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z']);
  const all = parseChanges(z);
  const files = all.slice(0, MAX_FILES);
  const hasHead = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false);
  // Against the last commit, so staged and unstaged changes show together; before any commit, both halves.
  let diff = hasHead
    ? await git(root, ['--no-optional-locks', 'diff', 'HEAD', '--no-color', '-M'])
    : (await git(root, ['--no-optional-locks', 'diff', '--cached', '--no-color'])) + (await git(root, ['--no-optional-locks', 'diff', '--no-color']));
  // New files have no diff in git's eyes: show their contents as added lines.
  for (const f of files.filter((x) => x.status === 'untracked' && !x.path.endsWith('/')).slice(0, MAX_NEW_FILE_DIFFS)) {
    if (diff.length > MAX_DIFF) break;
    diff += await noIndexDiff(root, f.path);
  }
  if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + '\n# … the rest is cut short';
  return { files, diff, more: all.length - files.length };
}

/** git diff --no-index against nothing: a new file as all-added lines. git exits 1 when they differ. */
function noIndexDiff(root: string, file: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', file], { cwd: root, timeout: QUICK, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (_err, stdout) => resolve(String(stdout ?? '')));
  });
}

let installed: Promise<boolean> | undefined;
export const gitInstalled = () => (installed ??= git(process.cwd(), ['--version']).then(() => true, () => false));

/** git status --porcelain=v2 --branch, as the numbers the header shows. */
export function parseStatus(text: string): Pick<GitInfo, 'branch' | 'detached' | 'upstream' | 'ahead' | 'behind' | 'changed' | 'untracked' | 'conflicts'> {
  const s = { ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0 } as ReturnType<typeof parseStatus>;
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14).trim();
      if (head === '(detached)') s.detached = true;
      else s.branch = head;
    } else if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [s.ahead, s.behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) s.changed++;
    else if (line.startsWith('u ')) s.conflicts++;
    else if (line.startsWith('? ')) s.untracked++;
  }
  return s;
}

/** Whether pulling now, unasked, is safe: fast-forward only, nothing local to disturb. */
export function canAutoPull(info: GitInfo, agentBusy: boolean): boolean {
  return info.repo && info.autoPull && !!info.upstream && !info.detached && info.behind > 0 && info.ahead === 0 && info.changed === 0 && info.conflicts === 0 && !agentBusy;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export interface GitMonitorOptions {
  fetchMinutes: () => number; // 0: never fetch on a timer
  autoPull: () => boolean;
  agentBusy: () => boolean;
  emit: (info: GitInfo) => void;
  notice: (level: 'info' | 'warn', text: string) => void;
}

/** One project's repository: kept up to date, fetched on a timer, and pulled or pushed on request. */
export class GitMonitor {
  private info: GitInfo = { available: true, repo: false, ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0, remotes: [], autoPull: false };
  private chain: Promise<unknown> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private debounce?: NodeJS.Timeout;
  private lastFetchTry = 0;
  private env?: NodeJS.ProcessEnv;
  private stopped = false;

  constructor(private root: string, private opts: GitMonitorOptions) {}

  start(): void {
    void this.refresh().then(() => this.maybeFetch(true));
    this.timers.push(setInterval(() => void this.refresh(), STATUS_EVERY));
    this.timers.push(setInterval(() => void this.maybeFetch(false), 60_000));
  }

  stop(): void {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    clearTimeout(this.debounce);
  }

  /** Something may have changed (a turn ended, files moved): look again shortly, once. */
  poke(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), DEBOUNCE);
  }

  get current(): GitInfo {
    return this.info;
  }

  /** git operations on one repository run one at a time, so they never trip over each other's locks. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private publish(change: Partial<GitInfo>): void {
    this.info = { ...this.info, ...change, autoPull: this.opts.autoPull() };
    if (!this.stopped) this.opts.emit(this.info);
  }

  /** Network operations must never sit waiting for a password nobody can type. */
  private async networkEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.env) return this.env;
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    // Without a terminal, ssh would hang on a passphrase prompt; keep any ssh command the user set up.
    const custom = process.env.GIT_SSH_COMMAND || (await git(this.root, ['config', '--get', 'core.sshCommand']).catch(() => '')).trim();
    if (!custom) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    return (this.env = env);
  }

  /** Read where the repository stands now. Every action reads it first, so none acts on old news. */
  private async readStatus(): Promise<void> {
    if (!(await gitInstalled())) return this.publish({ available: false, repo: false });
    const inside = await git(this.root, ['rev-parse', '--is-inside-work-tree']).then((o) => o.trim() === 'true', () => false);
    if (!inside) return this.publish({ available: true, repo: false, branch: undefined, upstream: undefined, ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0, remotes: [] });
    try {
      // --no-optional-locks: looking must never get in the way of the agent's own git commands.
      const [status, remotes] = await Promise.all([
        git(this.root, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch']),
        git(this.root, ['remote']),
      ]);
      const parsed = parseStatus(status);
      this.publish({ available: true, repo: true, branch: undefined, detached: undefined, upstream: undefined, ...parsed, remotes: remotes.split('\n').map((r) => r.trim()).filter(Boolean) });
    } catch {
      /* a transient failure (a lock, a repository mid-rewrite): keep what was shown */
    }
  }

  refresh(): Promise<void> {
    return this.serial(async () => {
      await this.readStatus();
      await this.autoPull();
    });
  }

  private async maybeFetch(first: boolean): Promise<void> {
    const minutes = this.opts.fetchMinutes();
    if (!minutes || !this.info.repo || !this.info.remotes.length) return;
    if (!first && Date.now() - this.lastFetchTry < minutes * 60_000 - 5_000) return;
    await this.fetch(false).catch(() => undefined);
  }

  /** Download what the remotes have. Never changes your files. */
  fetch(manual: boolean): Promise<void> {
    this.lastFetchTry = Date.now();
    return this.serial(async () => {
      await this.readStatus();
      if (!this.info.repo) throw new GitError('This folder isn’t a git repository.');
      if (!this.info.remotes.length) throw new GitError('This repository has no remote to fetch from.');
      this.publish({ running: 'fetch' });
      try {
        await git(this.root, ['fetch', '--all', '--prune', '--quiet'], { timeout: NETWORK, env: await this.networkEnv() });
        this.publish({ running: undefined, lastFetch: Date.now(), fetchError: undefined });
      } catch (err) {
        // A failed timed fetch shows on the status, not in the conversation.
        this.publish({ running: undefined, fetchError: (err as Error).message });
        if (manual) throw err;
      }
    }).then(() => this.refresh());
  }

  /** Bring in the upstream's commits, fast-forward only: anything that needs a merge is left to you. */
  pull(manual = true): Promise<void> {
    return this.serial(async () => {
      await this.readStatus();
      await this.doPull(manual);
    }).then(() => this.refresh());
  }

  private async doPull(manual: boolean): Promise<void> {
    const i = this.info;
    if (!i.repo) throw new GitError('This folder isn’t a git repository.');
    if (i.detached) throw new GitError('You aren’t on a branch, so there’s nothing to pull into.');
    if (!i.upstream) throw new GitError(`${i.branch} doesn’t track a remote branch yet. Push it first, or set its upstream.`);
    if (i.ahead && i.behind) throw new GitError(`${i.branch} and ${i.upstream} have diverged (${i.ahead} ahead, ${i.behind} behind), so pulling needs a merge or a rebase. Ask the agent to do it.`);
    this.publish({ running: 'pull' });
    try {
      const before = i.behind;
      await git(this.root, ['pull', '--ff-only', '--quiet'], { timeout: NETWORK, env: await this.networkEnv() });
      this.opts.notice('info', before ? `Pulled ${plural(before, 'commit')} from ${i.upstream}${manual ? '' : ' automatically'}.` : `${i.branch} is up to date with ${i.upstream}.`);
    } finally {
      this.publish({ running: undefined });
    }
  }

  /** Inside refresh(): pull by itself when that's turned on and safe. */
  private async autoPull(): Promise<void> {
    if (!canAutoPull({ ...this.info, autoPull: this.opts.autoPull() }, this.opts.agentBusy())) return;
    try {
      await this.doPull(false);
      await this.readStatus();
    } catch (err) {
      this.opts.notice('warn', `Couldn’t pull automatically: ${(err as Error).message}`);
    }
  }

  /** Send your commits to the upstream, setting one up on a branch's first push. Never forces. */
  push(): Promise<void> {
    return this.serial(async () => {
      await this.readStatus();
      const i = this.info;
      if (!i.repo) throw new GitError('This folder isn’t a git repository.');
      if (i.detached || !i.branch) throw new GitError('You aren’t on a branch, so there’s nothing to push.');
      const remote = i.remotes.includes('origin') ? 'origin' : i.remotes[0];
      if (!remote) throw new GitError('This repository has no remote to push to. Add one with: git remote add origin <url>');
      this.publish({ running: 'push' });
      try {
        const args = i.upstream ? ['push', '--quiet'] : ['push', '--quiet', '--set-upstream', remote, i.branch];
        await git(this.root, args, { timeout: NETWORK, env: await this.networkEnv() });
        this.opts.notice('info', i.upstream ? `Pushed ${plural(i.ahead, 'commit')} to ${i.upstream}.` : `Pushed ${i.branch} to ${remote}, and it now tracks ${remote}/${i.branch}.`);
      } finally {
        this.publish({ running: undefined });
      }
    }).then(() => this.refresh());
  }

  /** Make the project a git repository. */
  init(): Promise<void> {
    return this.serial(async () => {
      await this.readStatus();
      if (this.info.repo) return;
      await git(this.root, ['init']);
      this.opts.notice('info', 'Made this project a git repository.');
    }).then(() => this.refresh());
  }
}

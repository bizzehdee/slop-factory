import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorktreeInfo } from './protocol.js';

// Work a subagent did in its own worktree ("Start in subagent" asks for isolation: "worktree"),
// for review: what each branch changed against the project's current branch, and merging or
// discarding it. Claude Code keeps the worktrees it makes under .claude/worktrees/.

const run = promisify(execFile);
const MAX_DIFF = 400_000;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error((e.stderr || e.stdout || e.message).trim().split('\n').slice(-3).join(' '));
  }
}

/** The project's checked-out branch, the base each worktree is compared with and merged into. */
async function baseOf(root: string): Promise<string> {
  return (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function listWorktrees(root: string): Promise<WorktreeInfo[]> {
  let porcelain: string;
  try {
    porcelain = await git(root, ['worktree', 'list', '--porcelain']);
  } catch {
    return []; // not a git repository
  }
  const main = path.resolve(root);
  const base = await baseOf(root).catch(() => 'HEAD');
  const out: WorktreeInfo[] = [];
  for (const block of porcelain.split(/\n\n+/)) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (!wt || path.resolve(wt) === main || /^prunable/m.test(block)) continue;
    const ref = branch ?? (/^HEAD ([0-9a-f]+)$/m.exec(block)?.[1] ?? '');
    const [ahead, files, dirty] = await Promise.all([
      git(root, ['rev-list', '--count', `${base}..${ref}`]).then((s) => Number(s.trim()) || 0, () => 0),
      git(root, ['diff', '--name-only', `${base}...${ref}`]).then((s) => s.split('\n').filter(Boolean), () => [] as string[]),
      git(wt, ['status', '--porcelain']).then((s) => s.split('\n').filter(Boolean).length, () => 0),
    ]);
    out.push({
      path: wt,
      branch: branch ?? ref.slice(0, 8),
      base,
      ahead,
      files,
      uncommitted: dirty,
      agent: path.resolve(wt).startsWith(path.join(main, '.claude', 'worktrees') + path.sep),
    });
  }
  return out;
}

async function find(root: string, wtPath: string): Promise<WorktreeInfo> {
  const wt = (await listWorktrees(root)).find((w) => path.resolve(w.path) === path.resolve(wtPath));
  if (!wt) throw new Error(`${wtPath} isn't one of this project's worktrees.`);
  return wt;
}

/** The branch's changes since it left the base, then anything not yet committed in the worktree. */
export async function worktreeDiff(root: string, wtPath: string): Promise<string> {
  const wt = await find(root, wtPath);
  let diff = await git(root, ['diff', `${wt.base}...${wt.branch}`]);
  if (wt.uncommitted) {
    const local = await git(wt.path, ['diff', 'HEAD']);
    const untracked = (await git(wt.path, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
    diff += `\n# Not committed in the worktree yet\n${local}${untracked.map((f) => `# new file, not committed: ${f}\n`).join('')}`;
  }
  return diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n# … diff cut short' : diff;
}

/**
 * Merge the worktree's branch into the project's current branch. A merge that conflicts is undone,
 * leaving everything as it was, and the error says so.
 */
export async function mergeWorktree(root: string, wtPath: string): Promise<string> {
  const wt = await find(root, wtPath);
  if (!wt.ahead) throw new Error(`${wt.branch} has nothing committed to merge.`);
  if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()) {
    throw new Error(`The project has uncommitted changes on ${wt.base}. Commit or stash them before merging.`);
  }
  try {
    await git(root, ['merge', '--no-ff', '--no-edit', wt.branch]);
  } catch (err) {
    await git(root, ['merge', '--abort']).catch(() => undefined);
    throw new Error(`${wt.branch} doesn't merge cleanly into ${wt.base}, so nothing was changed. (${err instanceof Error ? err.message : String(err)})`);
  }
  return `Merged ${wt.branch} into ${wt.base} (${wt.ahead} commit${wt.ahead === 1 ? '' : 's'}).`;
}

/** Remove the worktree and its branch. */
export async function discardWorktree(root: string, wtPath: string): Promise<string> {
  const wt = await find(root, wtPath);
  await git(root, ['worktree', 'remove', '--force', wt.path]);
  if (wt.branch && wt.branch !== wt.base) await git(root, ['branch', '-D', wt.branch]).catch(() => undefined);
  return `Discarded ${wt.branch}.`;
}

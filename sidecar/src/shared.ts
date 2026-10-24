import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// What every login shares: your own CLAUDE.md, settings, skills, commands, agents and the like.
// An account's folder links to the default login's copy, so editing one edits both. The sign-in,
// conversations and Claude Code's per-login state (.claude.json, credentials) are never linked.

const SHARED = ['CLAUDE.md', 'settings.json', 'keybindings.json', 'skills', 'commands', 'agents', 'output-styles', 'hooks', 'plugins'];

/** The default login's Claude Code folder. */
export const homeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

/** Link the shared items into an account's folder; what is already there is left alone. Returns the names linked. */
export async function shareConfig(accountDir: string, source = homeConfigDir()): Promise<string[]> {
  if (path.resolve(accountDir) === path.resolve(source)) return [];
  const linked: string[] = [];
  for (const name of SHARED) {
    const from = path.join(source, name);
    const to = path.join(accountDir, name);
    const stat = await fs.stat(from).catch(() => null);
    if (!stat || (await exists(to))) continue;
    try {
      // A junction needs no special rights on Windows, where a folder symlink would.
      await fs.symlink(from, to, stat.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    } catch {
      // No symlinks here (Windows without developer mode): a copy at least starts it off alike.
      try {
        await fs.cp(from, to, { recursive: true });
      } catch {
        continue;
      }
    }
    linked.push(name);
  }
  return linked;
}

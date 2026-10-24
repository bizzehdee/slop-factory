import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// Apps opened from the Finder or a desktop launcher start with a bare PATH (/usr/bin:/bin), so
// tools installed with Homebrew or in ~/.local/bin, git among them, look missing to the sidecar
// and to the agent's own commands. Take the PATH your login shell sets up, as a terminal would.

const COMMON = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** PATH with the login shell's entries first and the usual install folders after, no repeats. */
export function mergePath(current: string, fromShell: string, home = os.homedir()): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...fromShell.split(path.delimiter), ...current.split(path.delimiter), ...COMMON, path.join(home, '.local', 'bin')]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(path.delimiter);
}

export function fixPath(): void {
  if (process.platform === 'win32') return; // Windows apps get the full PATH
  let fromShell = '';
  try {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
    // Markers around the value keep anything a shell's start-up files print out of it.
    const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    fromShell = /__PATH__(.*)__PATH__/s.exec(out)?.[1] ?? '';
  } catch {
    /* a slow or broken shell: fall back to the usual folders */
  }
  process.env.PATH = mergePath(process.env.PATH ?? '', fromShell);
}

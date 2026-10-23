// The agent SDK ships its native engine as one optional package per platform, and npm installs
// only the one for this machine. A universal macOS build needs both Mac ones:
//   node scripts/fetch-sdk-binaries.mjs darwin-x64 darwin-arm64
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modules = fileURLToPath(new URL('../sidecar/node_modules/@anthropic-ai/', import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(modules, 'claude-agent-sdk', 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const target of process.argv.slice(2)) {
  const name = `claude-agent-sdk-${target}`;
  const dest = path.join(modules, name);
  if (existsSync(path.join(dest, 'package.json'))) {
    console.log(`${name} is already there`);
    continue;
  }
  // npm pack doesn't check the platform, unlike npm install.
  const work = mkdtempSync(path.join(tmpdir(), 'sdk-'));
  const tarball = execFileSync(npm, ['pack', `@anthropic-ai/${name}@${version}`, '--silent'], { cwd: work, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').pop();
  mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(work, tarball), '-C', dest, '--strip-components=1']);
  rmSync(work, { recursive: true, force: true });
  console.log(`Added ${name}@${version}`);
}

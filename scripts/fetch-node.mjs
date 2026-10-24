// Fetch the Node.js runtime the installers carry, so people don't have to install Node themselves.
//   node scripts/fetch-node.mjs x86_64-unknown-linux-gnu
//   node scripts/fetch-node.mjs universal-apple-darwin      (Apple silicon and Intel in one file, plus each on its own,
//                                                             which Tauri's per-architecture builds look for)
//   node scripts/fetch-node.mjs                             (this machine)
// Takes the newest release of the major version in .node-version, checks it against Node's
// published SHA-256 sums, and writes src-tauri/binaries/slop-factory-node-<target>[.exe], where Tauri's
// externalBin (src-tauri/tauri.release.conf.json) picks it up.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'src-tauri', 'binaries');
const major = readFileSync(path.join(root, '.node-version'), 'utf8').trim().replace(/^v/, '').split('.')[0];

// Tauri target triple -> Node's name for the build.
const DIST = {
  'x86_64-unknown-linux-gnu': { name: 'linux-x64', ext: 'tar.xz' },
  'aarch64-unknown-linux-gnu': { name: 'linux-arm64', ext: 'tar.xz' },
  'x86_64-apple-darwin': { name: 'darwin-x64', ext: 'tar.gz' },
  'aarch64-apple-darwin': { name: 'darwin-arm64', ext: 'tar.gz' },
  'x86_64-pc-windows-msvc': { name: 'win-x64', ext: 'zip' },
  'aarch64-pc-windows-msvc': { name: 'win-arm64', ext: 'zip' },
};

function hostTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function latest() {
  const index = JSON.parse((await get('https://nodejs.org/dist/index.json')).toString());
  const release = index.find((r) => r.version.startsWith(`v${major}.`));
  if (!release) throw new Error(`No Node ${major} release found`);
  return release.version;
}

/** Download one build, check its checksum, and return the path of its node binary. */
async function fetchOne(version, sums, triple, work) {
  const { name, ext } = DIST[triple] ?? (() => { throw new Error(`No Node build for ${triple}`); })();
  const file = `node-${version}-${name}.${ext}`;
  const expected = sums.match(new RegExp(`^([0-9a-f]{64})  ${file.replace(/\./g, '\\.')}$`, 'm'))?.[1];
  if (!expected) throw new Error(`${file} isn't in SHASUMS256.txt`);
  const data = await get(`https://nodejs.org/dist/${version}/${file}`);
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`${file}: checksum ${actual} doesn't match ${expected}`);
  const archive = path.join(work, file);
  writeFileSync(archive, data);
  const dir = path.join(work, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', dir]);
  const base = path.join(dir, `node-${version}-${name}`);
  return name.startsWith('win') ? path.join(base, 'node.exe') : path.join(base, 'bin', 'node');
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : [hostTriple()];
const version = await latest();
const sums = (await get(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).toString();
mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'node-dist-'));
try {
  for (const triple of targets) {
    // Installed beside the app; a plain "node" would clash with the system's /usr/bin/node on Linux.
    const dest = path.join(out, `slop-factory-node-${triple}${triple.includes('windows') ? '.exe' : ''}`);
    if (triple === 'universal-apple-darwin') {
      // One binary for both Macs, as the universal app needs.
      const arm = await fetchOne(version, sums, 'aarch64-apple-darwin', work);
      const intel = await fetchOne(version, sums, 'x86_64-apple-darwin', work);
      execFileSync('lipo', ['-create', arm, intel, '-output', dest]);
      // Tauri builds each architecture on its own before joining them, and each build looks for its own file.
      for (const [file, triple] of [[arm, 'aarch64-apple-darwin'], [intel, 'x86_64-apple-darwin']]) {
        const part = path.join(out, `slop-factory-node-${triple}`);
        copyFileSync(file, part);
        chmodSync(part, 0o755);
      }
    } else {
      copyFileSync(await fetchOne(version, sums, triple, work), dest);
    }
    if (!dest.endsWith('.exe')) chmodSync(dest, 0o755);
    console.log(`Node ${version} -> ${path.relative(root, dest)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (!existsSync(out)) process.exit(1);

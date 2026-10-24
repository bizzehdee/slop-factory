// Stamp one version into every manifest: node scripts/set-version.mjs 1.2.3
// The release workflow runs it with the X.Y.Z from a vX.Y.Z tag; the app shows that version.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs X.Y.Z');
  process.exit(2);
}
const root = new URL('..', import.meta.url);
const file = (rel) => fileURLToPath(new URL(rel, root));

function json(rel, update) {
  const data = JSON.parse(readFileSync(file(rel), 'utf8'));
  update(data);
  writeFileSync(file(rel), JSON.stringify(data, null, 2) + '\n');
}
function text(rel, pattern, replacement) {
  const before = readFileSync(file(rel), 'utf8');
  // Unchanged text is fine (the version may already be right); a missing version line is not.
  if (!pattern.test(before)) throw new Error(`No version found in ${rel}`);
  writeFileSync(file(rel), before.replace(pattern, replacement));
}

for (const pkg of ['package.json', 'sidecar/package.json']) json(pkg, (d) => (d.version = version));
for (const lock of ['package-lock.json', 'sidecar/package-lock.json']) {
  json(lock, (d) => {
    d.version = version;
    if (d.packages?.['']) d.packages[''].version = version;
  });
}
json('src-tauri/tauri.conf.json', (d) => (d.version = version));
text('src-tauri/Cargo.toml', /^version = "[^"]*"/m, `version = "${version}"`);
// Windows checkouts may have CRLF line endings.
text('src-tauri/Cargo.lock', /(name = "slop-factory"\r?\nversion = )"[^"]*"/, `$1"${version}"`);
console.log(`Version set to ${version}`);

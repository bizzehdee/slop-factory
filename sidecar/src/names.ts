import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The app's name, version and where it keeps things. Earlier builds were called Claude Desk and
// used .claude-desk names; those are still read, and the settings folder is moved across once.

export const APP_NAME = 'Slop Factory';
const PROJECT_FILES = ['.slop-factory.json', '.claude-desk.json'];
export const PROJECT_DIR = '.slop-factory';
export const LEGACY_PROJECT_DIR = '.claude-desk';

/** The version the release workflow stamps into sidecar/package.json from its vX.Y.Z tag. */
export function appVersion(): string {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function configDir(): string {
  return process.env.SLOP_FACTORY_CONFIG_DIR || path.join(os.homedir(), '.slop-factory');
}

/** Move ~/.claude-desk to ~/.slop-factory the first time this version runs. */
export async function migrateConfigDir(): Promise<void> {
  if (process.env.SLOP_FACTORY_CONFIG_DIR) return;
  const legacy = path.join(os.homedir(), '.claude-desk');
  const dir = configDir();
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);
  if ((await exists(dir)) || !(await exists(legacy))) return;
  await fs.rename(legacy, dir).catch(() => fs.cp(legacy, dir, { recursive: true }));
}

/** A project's .slop-factory.json (or its older .claude-desk.json), or {}. */
export async function readProjectSettings(root: string): Promise<Record<string, unknown>> {
  for (const name of PROJECT_FILES) {
    try {
      return JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
    } catch {
      /* not there, or not JSON: try the next */
    }
  }
  return {};
}

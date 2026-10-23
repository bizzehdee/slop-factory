import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FrameworkInfo } from './protocol.js';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listDir(p: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walkMd(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await listDir(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMd(full, base)));
    else if (e.name.endsWith('.md')) out.push(path.relative(base, full).replace(/\.md$/, '').split(path.sep).join(':'));
  }
  return out;
}

/**
 * A quick look at what Claude Code will pick up from this project, so the UI can show
 * which parts of your framework (rules, agents, skills, hooks) are in play.
 * The SDK does the real loading via settingSources; this is just for display.
 */
export async function scanFramework(root: string): Promise<FrameworkInfo> {
  const dotClaude = path.join(root, '.claude');

  // Claude Code loads AGENTS.md as project instructions when the project has no CLAUDE.md.
  // If a CLAUDE.md exists it should import or link AGENTS.md, or your rules won't load.
  const agentsMd = await exists(path.join(root, 'AGENTS.md'));
  const claudeMd: string[] = [];
  let claudeMdImportsAgents = false;
  for (const rel of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) {
    const full = path.join(root, rel);
    if (!(await exists(full))) continue;
    claudeMd.push(rel);
    try {
      if (/AGENTS\.md/.test(await fs.readFile(full, 'utf8'))) claudeMdImportsAgents = true;
    } catch {
      /* ignore */
    }
  }

  const agentsSkills: string[] = [];
  for (const e of await listDir(path.join(root, '.agents', 'skills'))) {
    if (e.isDirectory() && (await exists(path.join(root, '.agents', 'skills', e.name, 'SKILL.md')))) agentsSkills.push(e.name);
  }
  agentsSkills.sort();

  const settingsFiles: string[] = [];
  const hooks = new Set<string>();
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const full = path.join(root, rel);
    if (!(await exists(full))) continue;
    settingsFiles.push(rel);
    try {
      const json = JSON.parse(await fs.readFile(full, 'utf8'));
      for (const k of Object.keys(json?.hooks ?? {})) hooks.add(k);
    } catch {
      /* unreadable settings: Claude Code will report it */
    }
  }

  const agents = (await walkMd(path.join(dotClaude, 'agents'))).sort();
  const commands = (await walkMd(path.join(dotClaude, 'commands'))).sort();

  const skills: string[] = [];
  for (const e of await listDir(path.join(dotClaude, 'skills'))) {
    if (e.isDirectory() && (await exists(path.join(dotClaude, 'skills', e.name, 'SKILL.md')))) skills.push(e.name);
  }

  return { agentsMd, agentsSkills, claudeMd, claudeMdImportsAgents, settingsFiles, agents, skills: skills.sort(), commands, hooks: [...hooks].sort() };
}

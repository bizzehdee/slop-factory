import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { claudeBinary } from './auth.js';
import type { McpEntry, McpScope } from './protocol.js';

const run = promisify(execFile);

// MCP servers live where Claude Code keeps them: user and local scope in ~/.claude.json (local under
// the project's entry), project scope in the project's .mcp.json. Changes go through "claude mcp",
// so Claude Code stays the one writing its own files; reading them is enough to list.

const claudeJson = () => (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'));

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

const servers = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, Record<string, unknown>>) : {});

export async function listMcp(project?: string): Promise<McpEntry[]> {
  const global = await readJson(claudeJson());
  const out: McpEntry[] = [];
  const add = (scope: McpScope, map: Record<string, Record<string, unknown>>) => {
    for (const [name, config] of Object.entries(map)) out.push({ name, scope, config });
  };
  add('user', servers(global.mcpServers));
  if (project) {
    const projectsMap = servers(global.projects);
    const entry = projectsMap[project] ?? projectsMap[project.split(path.sep).join('/')];
    add('local', servers(entry?.mcpServers));
    add('project', servers((await readJson(path.join(project, '.mcp.json'))).mcpServers));
  }
  return out;
}

async function claudeMcp(args: string[], cwd: string): Promise<void> {
  try {
    await run(claudeBinary(), ['mcp', ...args], { cwd, timeout: 60_000, windowsHide: true });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error((e.stderr || e.stdout || e.message).trim().split('\n').pop() ?? e.message);
  }
}

/** Add or replace a server. Renaming or moving scope removes the old entry first. */
export async function saveMcp(project: string | undefined, server: McpEntry, previous?: { name: string; scope: McpScope }): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(server.name)) throw new Error('Server names can use letters, digits, - and _ only.');
  if (server.scope !== 'user' && !project) throw new Error('Open a project to add a project or local server.');
  const cwd = project ?? os.homedir();
  const list = await listMcp(project);
  const clash = list.some((s) => s.name === server.name && s.scope === server.scope);
  if (clash && !(previous && previous.name === server.name && previous.scope === server.scope)) {
    throw new Error(`There's already a ${server.scope} server called ${server.name}.`);
  }
  const old = previous && list.find((s) => s.name === previous.name && s.scope === previous.scope);
  if (old) await claudeMcp(['remove', '-s', old.scope, old.name], cwd);
  try {
    await claudeMcp(['add-json', '-s', server.scope, server.name, JSON.stringify(server.config)], cwd);
  } catch (err) {
    // Put the old entry back rather than lose it.
    if (old) await claudeMcp(['add-json', '-s', old.scope, old.name, JSON.stringify(old.config)], cwd).catch(() => undefined);
    throw err;
  }
}

export async function removeMcp(project: string | undefined, name: string, scope: McpScope): Promise<void> {
  await claudeMcp(['remove', '-s', scope, name], project ?? os.homedir());
}

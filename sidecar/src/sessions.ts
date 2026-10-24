import { deleteSession, forkSession, getSessionMessages, getSubagentMessages, listSessions, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEntry } from './protocol.js';

// A project's conversations, as Claude Code keeps them on disk. They live in the login's config
// folder, which the SDK's readers take from the environment, so each call runs with the folder set
// and one at a time, since projects on different logins can ask together.

const HOME_DIR = process.env.CLAUDE_CONFIG_DIR; // the default login's folder, when it isn't ~/.claude
let chain: Promise<unknown> = Promise.resolve();

/** Run something that reads Claude Code's files with this login's folder (undefined: the default login's). */
export function inConfigDir<T>(configDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    if (configDir ?? HOME_DIR) process.env.CLAUDE_CONFIG_DIR = configDir ?? HOME_DIR;
    else delete process.env.CLAUDE_CONFIG_DIR;
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

export const readMessages = (id: string, dir: string, configDir?: string) => inConfigDir(configDir, () => getSessionMessages(id, { dir }));
export const readSubagent = (id: string, agentId: string, dir: string, configDir?: string) => inConfigDir(configDir, () => getSubagentMessages(id, agentId, { dir }));

export async function sessionList(dir: string, configDir: string | undefined, current?: string): Promise<SessionEntry[]> {
  const found = await inConfigDir(configDir, () => listSessions({ dir, includeWorktrees: false }));
  return found
    .map((s) => ({
      id: s.sessionId,
      title: (s.customTitle || s.summary || s.firstPrompt || 'Untitled').slice(0, 200),
      firstPrompt: s.firstPrompt?.slice(0, 300),
      modified: s.lastModified,
      created: s.createdAt,
      branch: s.gitBranch,
      tag: s.tag,
      current: s.sessionId === current,
    }))
    .sort((a, b) => b.modified - a.modified);
}

export const renameConversation = (id: string, title: string, dir: string, configDir?: string) => inConfigDir(configDir, () => renameSession(id, title, { dir }));
export const deleteConversation = (id: string, dir: string, configDir?: string) => inConfigDir(configDir, () => deleteSession(id, { dir }));
export const forkConversation = (id: string, dir: string, configDir?: string, title?: string) => inConfigDir(configDir, async () => (await forkSession(id, { dir, ...(title ? { title } : {}) })).sessionId);

import { deleteSession, forkSession, getSessionMessages, getSubagentMessages, listSessions, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEntry } from './protocol.js';
import { loginDir } from './shared.js';

// A project's conversations, as Claude Code keeps them on disk. They live in the login's config
// folder, which the SDK's readers take from the environment, so each call runs with the folder set
// and one at a time, since projects on different logins can ask together.

let chain: Promise<unknown> = Promise.resolve();

const setConfigDir = (dir: string | undefined) => {
  if (dir) process.env.CLAUDE_CONFIG_DIR = dir;
  else delete process.env.CLAUDE_CONFIG_DIR;
};

/**
 * Run something that reads Claude Code's files with this login's folder (undefined: the default
 * login's), then put the default back, so nothing started afterwards inherits another login.
 */
export function inConfigDir<T>(configDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    setConfigDir(loginDir(configDir));
    try {
      return await fn();
    } finally {
      setConfigDir(loginDir());
    }
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

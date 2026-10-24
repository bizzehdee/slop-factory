import { readMessages } from './sessions.js';
import type { ProjectEvent } from './protocol.js';
import { ATTACHED_FILE, attachedNames } from './attachments.js';

// A conversation picked up after a restart: Claude Code resumes it from its own transcript, and
// the window rebuilds what it showed from the same messages.

interface StoredMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  message: unknown;
  parent_tool_use_id: string | null;
}

type Block = { type: string; text?: string; title?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

// Text Claude Code adds to user turns on its own, not typed by anyone.
const INTERNAL = /^<(command-|local-command|system-reminder|bash-|user-memory|task-notification)/;

function preview(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 4000);
  if (Array.isArray(content)) return content.map((b: Block) => (b?.type === 'text' ? b.text ?? '' : `[${b?.type ?? 'block'}]`)).join('\n').slice(0, 4000);
  return '';
}

/** The window events that show a stored conversation, in order. */
export function messagesToEvents(messages: StoredMessage[]): ProjectEvent[] {
  const out: ProjectEvent[] = [];
  for (const m of messages) {
    const msg = m.message as { content?: unknown; id?: string } | undefined;
    const content = msg?.content;
    const parent = m.parent_tool_use_id;
    if (m.type === 'user') {
      if (typeof content === 'string') {
        if (!parent && content.trim() && !INTERNAL.test(content.trim())) out.push({ type: 'user', text: content });
        continue;
      }
      const blocks = (Array.isArray(content) ? content : []) as Block[];
      for (const b of blocks) {
        if (b.type === 'tool_result' && b.tool_use_id) out.push({ type: 'toolResult', toolUseId: b.tool_use_id, isError: !!b.is_error, preview: preview(b.content) });
      }
      if (parent) continue;
      // A message's own text, with the files sent along with it.
      const text = blocks.filter((b) => b.type === 'text' && b.text?.trim() && !INTERNAL.test(b.text.trim()) && !ATTACHED_FILE.test(b.text)).map((b) => b.text).join('\n\n');
      const attachments = attachedNames(blocks);
      if (text || attachments.length) out.push({ type: 'user', text, ...(attachments.length ? { attachments } : {}) });
    } else if (m.type === 'assistant') {
      for (const b of (Array.isArray(content) ? content : []) as Block[]) {
        if (b.type === 'text' && b.text) out.push({ type: 'assistantText', msgId: msg?.id ?? m.uuid, text: b.text, parent });
        else if (b.type === 'tool_use' && b.id) out.push({ type: 'toolUse', id: b.id, name: b.name ?? 'Tool', input: b.input, parent });
      }
    }
  }
  return out;
}

export async function loadHistory(sessionId: string, dir: string, configDir?: string): Promise<ProjectEvent[]> {
  return messagesToEvents((await readMessages(sessionId, dir, configDir)) as StoredMessage[]);
}

import type { Attachment } from './protocol.js';

// Files added to a message. Images and PDFs go to the model as image and document blocks; a text
// file's contents go in a text block wrapped in a tag that names it, so the conversation can show
// the file as an attachment when it's picked up again rather than as a message of its own.

export const ATTACHED_FILE = /^<attached-file name="([^"]*)">\n/;

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string };

const escapeName = (name: string) => name.replace(/["\n]/g, '_');

/** A user message's content: plain text, or blocks when files are attached. */
export function messageContent(text: string, attachments: Attachment[] = []): string | Block[] {
  if (!attachments.length) return text;
  const blocks: Block[] = text.trim() ? [{ type: 'text', text }] : [];
  for (const a of attachments) {
    if (a.kind === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
    else if (a.kind === 'pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.name });
    else blocks.push({ type: 'text', text: `<attached-file name="${escapeName(a.name)}">\n${a.data}\n</attached-file>` });
  }
  return blocks;
}

/** What a stored message's blocks attached, by name, for showing it again. */
export function attachedNames(blocks: { type: string; text?: string; title?: string }[]): string[] {
  const names: string[] = [];
  for (const b of blocks) {
    if (b.type === 'image') names.push('image');
    else if (b.type === 'document') names.push(b.title || 'document');
    else if (b.type === 'text') {
      const m = ATTACHED_FILE.exec(b.text ?? '');
      if (m) names.push(m[1]);
    }
  }
  return names;
}

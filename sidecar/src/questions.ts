import type { OpenQuestion } from './protocol.js';

// The project-planning and task-tracking standards end plan.md, every docs/ section document
// and every phase document with an "Open questions" section: each undecided item, and who must
// decide it. An item the user chose to leave undecided ends "(left open by the user, YYYY-MM-DD)".

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const LEFT_OPEN = /\(left open by the user(?:,\s*([0-9]{4}-[0-9]{2}-[0-9]{2}))?\)\s*\.?\s*$/i;
const NONE = /^(none|n\/a|nothing( yet)?|no open questions)\.?$/i;

/** Plan documents that hold Open questions, besides the task files. */
export const isQuestionDoc = (rel: string) => /^plan\.md$/i.test(rel) || /^docs\/[^/]+\.md$/i.test(rel);

export function parseOpenQuestions(src: string, rel: string): OpenQuestion[] {
  const lines = src.split(/\r?\n/);
  const out: OpenQuestion[] = [];
  let title = '';
  let inFence = false;
  let level = 0; // heading level of the Open questions section we are in, 0 = not in one
  let current: OpenQuestion | undefined;
  let itemIndent = 0;

  const finish = () => {
    if (!current) return;
    const left = LEFT_OPEN.exec(current.text);
    if (left) {
      current.leftOpen = left[1] ?? true;
      current.text = current.text.slice(0, left.index).trim();
    }
    if (current.text && !NONE.test(current.text)) out.push(current);
    current = undefined;
  };

  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      if (!inFence) finish();
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const h = HEADING.exec(line);
    if (h) {
      if (!title && h[1].length === 1) title = h[2];
      if (level && h[1].length <= level) {
        finish();
        level = 0;
      }
      if (/^open questions$/i.test(h[2].trim())) level = h[1].length;
      return;
    }
    if (!level) return;
    const m = ITEM.exec(line);
    const indent = m ? m[1].replace(/\t/g, '    ').length : 0;
    if (m && (!current || indent <= itemIndent)) {
      finish();
      current = { id: `${rel}#L${i + 1}`, rel, line: i, text: m[2].trim(), doc: title || rel };
      itemIndent = indent;
    } else if (current && line.trim()) {
      // Continuation lines and nested bullets belong to the item above.
      current.text += '\n' + line.trim();
    }
  });
  finish();
  return out;
}

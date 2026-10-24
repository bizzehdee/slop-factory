import { promises as fs } from 'node:fs';
import path from 'node:path';

// Quick capture from the board: add a task, a bug or an open question straight into the project's
// files, in the task-tracking and project-planning standards' formats, without asking the agent.

const today = () => new Date().toISOString().slice(0, 10);
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Where a "## <name>" section's content ends: the next heading of the same or higher level, or EOF. */
function sectionEnd(lines: string[], start: number, level: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]);
    if (h && h[1].length <= level) return i;
  }
  return lines.length;
}

function findSection(lines: string[], name: RegExp): { at: number; level: number } | undefined {
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]);
    if (h && name.test(h[2].trim())) return { at: i, level: h[1].length };
  }
  return undefined;
}

/** Insert lines at the end of a section's content, before its trailing blank lines. */
function appendToSection(lines: string[], at: number, level: number, add: string[]): void {
  let end = sectionEnd(lines, at, level);
  while (end > at + 1 && !lines[end - 1].trim()) end--;
  // An empty section gets a blank line under its heading first.
  lines.splice(end, 0, ...(end === at + 1 ? ['', ...add] : add));
}

/** A row for the document's Revision history table, if it has one. */
function addRevision(lines: string[], change: string): void {
  const sec = findSection(lines, /^revision history$/i);
  if (!sec) return;
  const end = sectionEnd(lines, sec.at, sec.level);
  const rows = lines.slice(sec.at, end).map((l, i) => (l.trim().startsWith('|') ? sec.at + i : -1)).filter((i) => i >= 0);
  if (rows.length < 2) return; // header and separator at least
  lines.splice(rows[rows.length - 1] + 1, 0, `| ${today()} | ${change} |`);
}

/** The next unused number for an id prefix, across the given texts: T for tasks, B for bugs. */
export function nextId(texts: string[], prefix: 'T' | 'B' | 'TASK-'): number {
  const re = prefix === 'TASK-' ? /\bTASK-(\d+)/g : new RegExp(`\\b${prefix}(\\d+)\\b`, 'g');
  let max = 0;
  for (const t of texts) for (const m of t.matchAll(re)) max = Math.max(max, Number(m[1]));
  return max + 1;
}

/** A phase document with a new task at the end of its Tasks list. */
export function insertTask(src: string, id: string, title: string): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const line = `- [ ] ${id}: ${title}`;
  const sec = findSection(lines, /^tasks$/i);
  if (sec) appendToSection(lines, sec.at, sec.level, [line]);
  else {
    // No Tasks heading yet: add one after the title.
    const at = lines.findIndex((l) => /^#\s/.test(l));
    lines.splice(at + 1, 0, '', '## Tasks', '', line);
  }
  addRevision(lines, `Added ${id}: ${title}`);
  return lines.join(eol);
}

/** An older TASK.md with a new task at the end of one of its sections. */
export function insertLegacyTask(src: string, section: string, id: string, title: string): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const sec = findSection(lines, new RegExp(`^${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  const line = `- [ ] ${id}: ${title}`;
  if (sec) appendToSection(lines, sec.at, sec.level, [line]);
  else lines.push('', `## ${section}`, '', line);
  return lines.join(eol);
}

export function insertBug(src: string, id: string, title: string, details: string): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const body = src.trim() ? src.replace(/\s*$/, '') : '# Bugs';
  const entry = [`### ${id}: ${title}`, '- Status: open', `- Reported: ${today()}`, ...details.split('\n').filter((l) => l.trim()).map((l) => (l.startsWith('-') ? l : `- ${l}`))];
  return [body, '', ...entry, ''].join(eol);
}

/** A document with a new item under Open questions, made before Revision history if missing. */
export function insertQuestion(src: string, text: string): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const item = `- ${text.replace(/\s*\n\s*/g, ' ').trim()}`;
  const sec = findSection(lines, /^open questions$/i);
  if (sec) {
    // "None." gives way to the first real question.
    const end = sectionEnd(lines, sec.at, sec.level);
    for (let i = end - 1; i > sec.at; i--) {
      if (!/^(-\s*)?none\.?$/i.test(lines[i].trim())) continue;
      // Take the blank line before it too, so no gap is left behind.
      lines.splice(!lines[i - 1].trim() && i - 1 > sec.at ? i - 1 : i, !lines[i - 1].trim() && i - 1 > sec.at ? 2 : 1);
    }
    appendToSection(lines, sec.at, sec.level, [item]);
  } else {
    const rev = findSection(lines, /^revision history$/i);
    const block = ['## Open questions', '', item, ''];
    if (rev) lines.splice(rev.at, 0, ...block);
    else lines.push('', ...block);
  }
  return lines.join(eol);
}

async function read(file: string): Promise<string> {
  return fs.readFile(file, 'utf8').catch(() => '');
}

function inside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep) || !abs.toLowerCase().endsWith('.md')) throw new Error(`Not a markdown file in the project: ${rel}`);
  return abs;
}

/** Add a task to a phase document (or an older TASK.md section), returning its id. */
export async function addTask(root: string, rel: string, title: string, taskFiles: string[], section?: string): Promise<string> {
  const abs = inside(root, rel);
  const texts = await Promise.all(taskFiles.map((f) => read(path.join(root, f))));
  const src = await read(abs);
  if (section) {
    const id = `TASK-${String(nextId(texts, 'TASK-')).padStart(3, '0')}`;
    await fs.writeFile(abs, insertLegacyTask(src, section, id, title));
    return id;
  }
  const id = `T${nextId(texts, 'T')}`;
  await fs.writeFile(abs, insertTask(src, id, title));
  return id;
}

export async function addBug(root: string, title: string, details: string): Promise<string> {
  const abs = path.join(root, 'tasks', 'bugs.md');
  const src = await read(abs);
  const id = `B${nextId([src], 'B')}`;
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, insertBug(src, id, title, details));
  return id;
}

export async function addQuestion(root: string, rel: string, text: string): Promise<void> {
  const abs = inside(root, rel);
  await fs.writeFile(abs, insertQuestion(await read(abs), text));
}

import { watch, type FSWatcher } from 'chokidar';
import picomatch from 'picomatch';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BugEntry, DocLink, OpenQuestion, PhaseRow, TaskFile, TaskFileKind, TaskItem, TaskState } from './protocol.js';
import { isQuestionDoc, parseOpenQuestions } from './questions.js';
import { readProjectSettings } from './names.js';

// "- [ ] text", "* [x] text", "1. [/] text" ...
const CHECKBOX = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX/~-])\]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

function markToState(mark: string): TaskState {
  switch (mark) {
    case 'x':
    case 'X':
      return 'done';
    case '/':
    case '~':
      return 'doing';
    case '-':
      return 'cancelled';
    default:
      return 'todo';
  }
}

function indentWidth(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === '\t' ? 4 : 1;
  return n;
}

const PHASE_DOC = /(^|\/)task_phase_(\d+)\.md$/i;
const PHASE_TITLE = /^Phase\s+(\d+)\s*[:\-–]\s*(.*)$/i;
const BUG_HEADING = /^###\s+(B\d+)\s*[:\-–]\s*(.*)$/;
const BUG_FIELD = /^\s*[-*]\s+(Status|Reported)\s*:\s*(.*)$/i;
const LINK_TARGET = /\]\(([^)\s]+)\)/;
const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
// "T5: ..." (current standard) or "TASK-050.1: ..." (older TASK.md format).
const TASK_ID = /^((?:TASK-|T)\d+(?:\.\d+)*)\s*:\s*/;
const ID_IN_TEXT = /\b(?:TASK-\d+(?:\.\d+)*|[TB]\d+)\b/g;
const DEP_FIELD = /^\s*[-*]\s+\*\*(Depends on|Blocked by)\s*:?\*\*\s*:?\s*(.*)$/i;

/** Last line (exclusive) of the indented block under line i. */
function blockEnd(lines: string[], i: number, indent: number): number {
  let j = i + 1;
  let lastContent = i;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim()) continue;
    if (/^#{1,6}\s/.test(l) || indentWidth(/^\s*/.exec(l)![0]) <= indent) break;
    lastContent = j;
  }
  return lastContent + 1;
}

/** Markdown links on a line that point at local .md files, resolved against the file's folder. */
export function docLinks(line: string, rel: string): DocLink[] {
  const dir = path.posix.dirname(rel);
  const out: DocLink[] = [];
  for (const m of line.matchAll(MD_LINK)) {
    const href = m[2].split('#')[0];
    if (!href.toLowerCase().endsWith('.md') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    out.push({ label: m[1].trim(), rel: path.posix.normalize(path.posix.join(dir, href)) });
  }
  return out;
}

function itemTitle(text: string): { id?: string; title: string } {
  const idMatch = TASK_ID.exec(text);
  const rest = idMatch ? text.slice(idMatch[0].length) : text;
  const title = rest.replace(MD_LINK, (all, label: string, href: string) => (href.split('#')[0].toLowerCase().endsWith('.md') ? '' : label)).replace(/\s+/g, ' ').trim();
  return { id: idMatch?.[1], title };
}

export function fileKind(rel: string): TaskFileKind {
  const lower = rel.toLowerCase();
  if (!lower.includes('/') && lower === 'task.md') return 'index';
  if (PHASE_DOC.test(lower)) return 'phase';
  if (/(^|\/)bugs\.md$/.test(lower)) return 'bugs';
  return 'other';
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** The first markdown table whose header has Phase and Status columns. */
export function parsePhaseTable(src: string, rel: string): PhaseRow[] {
  const lines = src.split(/\r?\n/);
  const dir = path.posix.dirname(rel);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|') || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
    const head = splitRow(lines[i]).map((h) => h.toLowerCase());
    const col = (name: string) => head.findIndex((h) => h === name);
    const [cPhase, cGoal, cStatus, cDoc] = [col('phase'), col('goal'), col('status'), col('document')];
    if (cPhase < 0 || cStatus < 0) continue;

    const rows: PhaseRow[] = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const cells = splitRow(lines[j]);
      const link = cDoc >= 0 ? LINK_TARGET.exec(cells[cDoc] ?? '')?.[1] : undefined;
      rows.push({
        number: cells[cPhase] ?? '',
        goal: cGoal >= 0 ? cells[cGoal] ?? '' : '',
        status: (cells[cStatus] ?? '').toLowerCase(),
        doc: link && !/^[a-z]+:/i.test(link) ? path.posix.normalize(path.posix.join(dir, link.split('#')[0])) : undefined,
      });
    }
    return rows;
  }
  return [];
}

export function parseBugs(src: string, rel = 'tasks/bugs.md'): BugEntry[] {
  const bugs: BugEntry[] = [];
  let current: BugEntry | undefined;
  src.split(/\r?\n/).forEach((line, i) => {
    const h = BUG_HEADING.exec(line);
    if (h) {
      current = { id: h[1], title: h[2].trim(), status: 'open', line: i, links: [] };
      bugs.push(current);
      return;
    }
    if (/^#{1,3}\s/.test(line)) {
      current = undefined;
      return;
    }
    if (current) {
      const field = /^\s*[-*]\s+([A-Za-z ]+):/.exec(line)?.[1];
      for (const l of docLinks(line, rel)) current.links.push(field && !/^(spec|summary)$/i.test(l.label) ? { ...l, label: field } : l);
    }
    const f = current && BUG_FIELD.exec(line);
    if (f && current) {
      if (f[1].toLowerCase() === 'status') current.status = f[2].trim().toLowerCase();
      else current.reported = f[2].trim();
    }
  });
  return bugs;
}

export function parseTaskFile(src: string, rel: string): Omit<TaskFile, 'mtime'> {
  const kind = fileKind(rel);
  const { title, items } = parseTaskMarkdown(src, rel);
  const file: Omit<TaskFile, 'mtime'> = { rel, kind, title, items };
  if (kind === 'index') {
    file.phases = parsePhaseTable(src, rel);
    // An older-format TASK.md has no phase table: its checkbox tasks are the plan itself.
    if (!file.phases.length && items.length) {
      file.kind = 'legacy';
      delete file.phases;
    }
  }
  if (kind === 'bugs') file.bugs = parseBugs(src, rel);
  if (kind === 'phase') {
    const t = PHASE_TITLE.exec(title);
    file.phaseNumber = t?.[1] ?? PHASE_DOC.exec(rel)?.[2];
  }
  return file;
}

export function parseTaskMarkdown(src: string, rel: string): { title: string; items: TaskItem[] } {
  const lines = src.split(/\r?\n/);
  const items: TaskItem[] = [];
  let title = '';
  let section: string | undefined;
  let inFence = false;
  const indentStack: number[] = []; // indents of currently open parent items

  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const h = HEADING.exec(line);
    if (h) {
      const text = h[2].trim();
      if (h[1].length === 1 && !title) title = text;
      else section = text;
      indentStack.length = 0;
      return;
    }

    const m = CHECKBOX.exec(line);
    if (!m) return;
    const indent = indentWidth(m[1]);
    while (indentStack.length && indentStack[indentStack.length - 1] >= indent) indentStack.pop();
    const depth = indentStack.length;
    indentStack.push(indent);
    const text = m[3].trim();
    const item: TaskItem = { line: i, depth, state: markToState(m[2]), text, ...itemTitle(text), links: docLinks(text, rel), section };
    // Detail fields under the item (older format). Only lines at the item's own field level
    // count, so a nested subtask's fields never become its parent's.
    const end = blockEnd(lines, i, indent);
    if (end > i + 1) item.hasDetails = true;
    let fieldIndent = -1;
    for (let j = i + 1; j < end; j++) {
      if (!lines[j].trim()) continue;
      const w = indentWidth(/^\s*/.exec(lines[j])![0]);
      if (fieldIndent < 0) fieldIndent = w;
      if (w !== fieldIndent || CHECKBOX.test(lines[j])) continue;
      const dep = DEP_FIELD.exec(lines[j]);
      if (!dep) continue;
      if (/^depends/i.test(dep[1])) {
        const ids = [...dep[2].matchAll(ID_IN_TEXT)].map((x) => x[0]);
        if (ids.length) item.dependsOn = ids;
      } else {
        // Blocked by names open questions or outside needs as free text: keep the wording.
        const reasons = dep[2].split(/;\s*/).map((r) => r.trim().replace(/\.$/, '')).filter((r) => r && !/^none$/i.test(r));
        if (reasons.length) item.blockedBy = reasons;
      }
    }
    items.push(item);
  });

  return { title: title || rel, items };
}

export interface TaskConfig {
  taskGlobs: string[];
  docGlobs: string[];
  ignore: string[];
}

// Defaults follow the agent-framework task-tracking standard (globs: task.md, tasks/*.md).
// Override per project with "taskGlobs" in .slop-factory.json.
export const DEFAULT_TASK_CONFIG: TaskConfig = {
  taskGlobs: ['task.md', 'tasks/*.md'],
  // Specs and summaries from the task-tracking standard. Watched so the board knows which exist.
  docGlobs: ['specs/*.md', 'summaries/*.md'],
  ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/target/**'],
};

export async function loadTaskConfig(root: string): Promise<TaskConfig> {
  try {
    const raw = await readProjectSettings(root);
    return {
      taskGlobs: Array.isArray(raw.taskGlobs) && raw.taskGlobs.length ? raw.taskGlobs : DEFAULT_TASK_CONFIG.taskGlobs,
      docGlobs: Array.isArray(raw.docGlobs) ? raw.docGlobs : DEFAULT_TASK_CONFIG.docGlobs,
      ignore: Array.isArray(raw.ignore) ? raw.ignore : DEFAULT_TASK_CONFIG.ignore,
    };
  } catch {
    return DEFAULT_TASK_CONFIG;
  }
}

/** The project summary at the root (plan.md, any case). Always watched, whatever docGlobs says. */
export const isPlanDoc = (rel: string) => rel.toLowerCase() === 'plan.md';

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

export class TaskWatcher {
  private files = new Map<string, TaskFile>();
  private docs = new Set<string>();
  private questions = new Map<string, OpenQuestion[]>();
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private isTask: (rel: string) => boolean;
  private isDoc: (rel: string) => boolean;
  private isIgnored: (rel: string) => boolean;

  constructor(
    private root: string,
    private config: TaskConfig,
    private onChange: (files: TaskFile[], docs: string[], questions: OpenQuestion[]) => void,
  ) {
    this.isTask = picomatch(config.taskGlobs, { dot: false, nocase: true });
    const isDocGlob = picomatch(config.docGlobs ?? [], { dot: false, nocase: true });
    this.isDoc = (rel) => isPlanDoc(rel) || isDocGlob(rel);
    this.isIgnored = picomatch(config.ignore, { dot: true });
  }

  start(): void {
    this.watcher = watch(this.root, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 40 },
      ignored: (abs, stats) => {
        const rel = toRel(this.root, abs);
        if (!rel || rel.startsWith('..')) return false;
        if (this.isIgnored(rel) || this.isIgnored(rel + '/')) return true;
        // Skip non-task files, but keep walking directories.
        return !!stats?.isFile() && !this.isTask(rel) && !this.isDoc(rel) && !isQuestionDoc(rel);
      },
    });
    this.watcher
      .on('add', (p) => void this.load(p))
      .on('change', (p) => void this.load(p))
      .on('unlink', (p) => {
        const rel = toRel(this.root, p);
        this.files.delete(rel);
        this.docs.delete(rel);
        this.questions.delete(rel);
        this.schedule();
      })
      .on('ready', () => this.schedule())
      .on('error', (err) => process.stderr.write(`[tasks] watch error: ${String(err)}\n`));
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    await this.watcher?.close();
  }

  snapshot(): TaskFile[] {
    const order: Record<TaskFileKind, number> = { index: 0, legacy: 0, phase: 1, bugs: 2, other: 3 };
    return [...this.files.values()].sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        Number(a.phaseNumber ?? 0) - Number(b.phaseNumber ?? 0) ||
        a.rel.localeCompare(b.rel),
    );
  }

  /** Flip a checkbox between done and not-done, but only if the line still says what the UI showed. */
  async toggle(rel: string, line: number, expectedText: string): Promise<void> {
    if (!this.files.has(rel)) throw new Error(`Not a tracked task file: ${rel}`);
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Path escapes project');

    const src = await fs.readFile(abs, 'utf8');
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const lines = src.split(/\r?\n/);
    const m = CHECKBOX.exec(lines[line] ?? '');
    if (!m || m[3].trim() !== expectedText) throw new Error('That task changed on disk; refresh and try again.');

    const next = markToState(m[2]) === 'done' ? ' ' : 'x';
    lines[line] = lines[line].replace(/\[([ xX/~-])\]/, `[${next}]`);
    await fs.writeFile(abs, lines.join(eol), 'utf8');
  }

  /** Read markdown documents for the progress view. Only .md files inside the project. */
  async readDocs(paths: string[]): Promise<{ rel: string; markdown: string }[]> {
    const root = path.resolve(this.root);
    const out: { rel: string; markdown: string }[] = [];
    for (const rel of [...new Set(paths)].slice(0, 20)) {
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root + path.sep) || !abs.toLowerCase().endsWith('.md')) continue;
      try {
        out.push({ rel: toRel(root, abs), markdown: await fs.readFile(abs, 'utf8') });
      } catch {
        /* not written yet */
      }
    }
    return out;
  }

  /** The markdown of a task entry and everything indented under it, for the progress view. */
  async readBlock(rel: string, line: number): Promise<{ rel: string; markdown: string } | undefined> {
    if (!this.files.has(rel)) return undefined;
    const src = await fs.readFile(path.resolve(this.root, rel), 'utf8');
    const lines = src.split(/\r?\n/);
    const m = CHECKBOX.exec(lines[line] ?? '');
    if (!m) return undefined;
    const indent = indentWidth(m[1]);
    const block = lines.slice(line, blockEnd(lines, line, indent));
    const dedented = block.map((l) => {
      let cut = 0;
      while (cut < indent && (l[cut] === ' ' || l[cut] === '\t')) cut++;
      return l.slice(cut);
    });
    // Drop the checkbox from the first line; the panel shows the id and title itself.
    dedented[0] = dedented[0].replace(/^(?:[-*+]|\d+[.)])\s+\[[^\]]\]\s+/, '');
    return { rel: `${rel}#L${line + 1}`, markdown: dedented.join('\n') };
  }

  docList(): string[] {
    return [...this.docs].sort();
  }

  /** Every Open questions item across the plan and the task files, plan first. */
  questionList(): OpenQuestion[] {
    const rank = (rel: string) => (/^plan\.md$/i.test(rel) ? 0 : rel.startsWith('docs/') ? 1 : 2);
    return [...this.questions.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }))
      .flatMap(([, q]) => q);
  }

  private async load(abs: string): Promise<void> {
    const rel = toRel(this.root, abs);
    const task = this.isTask(rel);
    const question = task || isQuestionDoc(rel);
    if (this.isDoc(rel) && !task) this.docs.add(rel);
    if (!question) return this.schedule();
    try {
      const [src, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
      if (task) this.files.set(rel, { ...parseTaskFile(src, rel), mtime: st.mtimeMs });
      this.questions.set(rel, parseOpenQuestions(src, rel));
    } catch {
      this.files.delete(rel);
      this.questions.delete(rel);
    }
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onChange(this.snapshot(), this.docList(), this.questionList()), 60);
  }
}

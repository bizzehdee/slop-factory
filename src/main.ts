import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/source-serif-4';
import './styles.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { createBridge, type Bridge } from './bridge';
import type {
  ActionItem,
  AskedQuestion,
  AuthState,
  McpEntry,
  McpScope,
  BugEntry,
  DocContent,
  EditorInfo,
  FrameworkInfo,
  ItemAction,
  OpenQuestion,
  PhaseRow,
  PermissionModeName,
  ProcessInfo,
  ProjectEvent,
  ProviderConfig,
  SessionInfo,
  SidecarEvent,
  TaskFile,
  TaskItem,
  TaskState,
  UiCommand,
} from '../sidecar/src/protocol';

// ---------- DOM helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

function svgIcon(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = path;
  return svg;
}
const ICON_MORE = '<circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/>';
const ICON_FLAG = '<path d="M4 14V2.5h7.5L10 5.5l1.5 3H4" />';
const ICON_CLOSE = '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';

const md = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }) as string);

function elapsed(from: number, to = Date.now()): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// ---------- state ----------

type TurnEnd = Extract<ProjectEvent, { type: 'turnEnd' }>;

interface Proj {
  dir: string;
  name: string;
  framework?: FrameworkInfo;
  session?: SessionInfo;
  mode: PermissionModeName;
  providerId: string;
  busy: boolean;
  status?: string | null;
  processes: ProcessInfo[];
  tasks: TaskFile[];
  docs: Set<string>;
  priorities: string[];
  expanded: Set<string>;
  userToggled: boolean;
  lastTurn?: TurnEnd;
  transcript: HTMLElement;
  liveText: Map<string, HTMLElement>;
  toolCards: Map<string, HTMLElement>;
  permissionCards: Map<string, HTMLElement>;
  pending: Set<string>;
  asked: Map<string, AskedQuestion[]>; // open AskUserQuestion calls
  docQuestions: OpenQuestion[];
  chatQuestions: ChatQuestion[];
  freshTurn: boolean; // the next reply replaces the conversation's questions
  answerDrafts: Map<string, string>;
  selectedQuestions: Set<string>;
  answeredQuestions: Set<string>;
  draft: string;
  unseen: boolean;
  replaying: boolean;
  holdQueue: boolean; // set by Stop: the queue waits until you start something again
}

const projects = new Map<string, Proj>();
let editorList: EditorInfo[] = [];
let providerList: ProviderConfig[] = [{ id: 'subscription', name: 'Claude subscription', kind: 'subscription' }];
const providerOf = (p: Proj) => providerList.find((x) => x.id === p.providerId) ?? providerList[0];
let active: Proj | undefined;
let bridge: Bridge | undefined;

const send = (cmd: UiCommand) => bridge?.send(cmd);

function store(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
function load(key: string): string | null {
  try {
    // Earlier builds, called Claude Desk, kept these under claude-desk:.
    return localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^slop-factory:/, 'claude-desk:'));
  } catch {
    return null;
  }
}
const saveOpenProjects = () => store('slop-factory:projects', JSON.stringify([...projects.keys()]));

function newProject(dir: string, name: string): Proj {
  const transcript = h('div', { class: 'transcript', role: 'log', 'aria-live': 'polite', hidden: true });
  $('transcripts').append(transcript);
  return {
    dir,
    name,
    mode: 'default',
    providerId: 'subscription',
    busy: false,
    processes: [],
    tasks: [],
    docs: new Set(),
    priorities: [],
    expanded: new Set(),
    userToggled: false,
    transcript,
    liveText: new Map(),
    toolCards: new Map(),
    permissionCards: new Map(),
    pending: new Set(),
    asked: new Map(),
    docQuestions: [],
    chatQuestions: [],
    freshTurn: false,
    answerDrafts: new Map(),
    selectedQuestions: new Set(),
    answeredQuestions: new Set(),
    draft: '',
    unseen: false,
    replaying: false,
    holdQueue: false,
  };
}

// ---------- board model ----------

interface BoardItem extends ActionItem {
  state: TaskState | 'bug';
  status?: string; // bugs
  line: number;
  text?: string; // tasks: the raw line text, for toggling
  docLinks: { label: string; rel: string }[];
  hasDetails?: boolean;
  dependsOn?: string[];
  blockedBy?: string[];
  section?: string; // tasks: the heading they sit under (an older TASK.md's sections are its phases)
}

const isSpec = (l: { label: string; rel: string }) => /spec/i.test(l.label) || /(^|\/)spec[-_]/i.test(l.rel);
const isSummary = (l: { label: string; rel: string }) => /summar/i.test(l.label) || /(^|\/)summary[-_]/i.test(l.rel);

function conventionDoc(p: Proj, kind: 'spec' | 'summary', item: { kind: 'task' | 'bug'; id?: string }): string | undefined {
  // Only "T<n>" / "B<n>" ids have standard spec and summary names.
  const num = /^[TB](\d+)$/.exec(item.id ?? '')?.[1];
  if (!num) return undefined;
  const rel = `${kind === 'spec' ? 'specs/spec' : 'summaries/summary'}-${item.kind === 'bug' ? 'BUG' : 'TASK'}-${num}.md`;
  return p.docs.has(rel) ? rel : undefined;
}

/** A doc counts when its file exists: linked from the item first, then the standard's file name. */
function resolveDocs(p: Proj, base: { kind: 'task' | 'bug'; id?: string }, links: { label: string; rel: string }[]) {
  const linkedSpec = links.find(isSpec)?.rel;
  const linkedSummary = links.find(isSummary)?.rel;
  return {
    spec: (linkedSpec && p.docs.has(linkedSpec) ? linkedSpec : undefined) ?? conventionDoc(p, 'spec', base) ?? linkedSpec,
    summary: (linkedSummary && p.docs.has(linkedSummary) ? linkedSummary : undefined) ?? conventionDoc(p, 'summary', base) ?? linkedSummary,
  };
}

function taskItem(p: Proj, file: TaskFile, t: TaskItem): BoardItem {
  return {
    key: t.id ?? `${file.rel}#${t.title}`,
    kind: 'task',
    id: t.id,
    title: t.title || t.text,
    rel: file.rel,
    phase: file.phaseNumber,
    done: t.state === 'done',
    state: t.state,
    line: t.line,
    text: t.text,
    docLinks: t.links,
    legacy: file.kind === 'legacy',
    hasDetails: t.hasDetails,
    dependsOn: t.dependsOn,
    blockedBy: t.blockedBy,
    section: t.section,
    ...resolveDocs(p, { kind: 'task', id: t.id }, t.links),
  };
}

function bugItem(p: Proj, file: TaskFile, b: BugEntry): BoardItem {
  return {
    key: b.id,
    kind: 'bug',
    id: b.id,
    title: b.title,
    rel: file.rel,
    done: b.status === 'fixed' || b.status === "won't fix",
    state: 'bug',
    status: b.status,
    line: b.line,
    docLinks: b.links,
    ...resolveDocs(p, { kind: 'bug', id: b.id }, b.links),
  };
}

// Phases (and older TASK.md sections) can be queued and started like tasks.

const PHASE_PREFIX = /^Phase\s+\d+\s*[:\-–]\s*/i;

function phaseDocFor(row: PhaseRow, phases: TaskFile[]): TaskFile | undefined {
  return (row.doc && phases.find((ph) => ph.rel === row.doc)) || phases.find((ph) => ph.phaseNumber === row.number);
}

function phaseItem(row: PhaseRow, doc: TaskFile | undefined, indexRel: string): BoardItem {
  const cls = phaseStatusClass(row.status);
  return {
    key: `P${row.number}`,
    kind: 'phase',
    title: doc?.title.replace(PHASE_PREFIX, '') || row.goal || `Phase ${row.number}`,
    rel: doc?.rel ?? indexRel,
    phase: row.number,
    done: cls === 'done' || cls === 'dropped',
    state: cls === 'done' ? 'done' : cls === 'doing' ? 'doing' : cls === 'dropped' ? 'cancelled' : 'todo',
    line: 0,
    docLinks: doc ? [{ label: 'Phase', rel: doc.rel }] : [],
  };
}

interface LegacySection {
  name: string;
  items: TaskItem[];
}

function legacySections(file: TaskFile): LegacySection[] {
  const sections: LegacySection[] = [];
  for (const it of file.items) {
    const name = it.section ?? 'Tasks';
    let sec = sections[sections.length - 1];
    if (!sec || sec.name !== name) sections.push((sec = { name, items: [] }));
    sec.items.push(it);
  }
  return sections;
}

function legacyStatus(items: TaskItem[]): string {
  const top = items.filter((i) => i.depth === 0 && i.state !== 'cancelled');
  if (top.length && top.every((i) => i.state === 'done')) return 'done';
  if (items.some((i) => i.state === 'done' || i.state === 'doing')) return 'in progress';
  return 'planned';
}

function sectionItem(file: TaskFile, sec: LegacySection): BoardItem {
  const status = legacyStatus(sec.items);
  return {
    key: `section:${sec.name}`,
    kind: 'phase',
    title: sec.name,
    rel: file.rel,
    legacy: true,
    done: status === 'done',
    state: status === 'done' ? 'done' : status === 'in progress' ? 'doing' : 'todo',
    line: 0,
    docLinks: [],
  };
}

/** The short label shown before an item's title: T5, B2, P2. */
const itemRef = (it: BoardItem) => it.id ?? (it.kind === 'phase' ? (it.phase ? `P${it.phase}` : '§') : '');

function allItems(p: Proj): Map<string, BoardItem> {
  const map = new Map<string, BoardItem>();
  const index = p.tasks.find((f) => f.kind === 'index');
  const phases = p.tasks.filter((f) => f.kind === 'phase');
  for (const row of index?.phases ?? []) {
    const it = phaseItem(row, phaseDocFor(row, phases), index!.rel);
    map.set(it.key, it);
  }
  for (const f of p.tasks) {
    if (f.kind === 'legacy') for (const sec of legacySections(f)) {
      const it = sectionItem(f, sec);
      map.set(it.key, it);
    }
    if (f.kind === 'phase' || f.kind === 'other' || f.kind === 'legacy') for (const t of f.items) {
      const it = taskItem(p, f, t);
      map.set(it.key, it);
    }
    if (f.kind === 'bugs') for (const b of f.bugs ?? []) {
      const it = bugItem(p, f, b);
      map.set(it.key, it);
    }
  }
  return map;
}

const toActionItem = (b: BoardItem): ActionItem => ({
  key: b.key,
  kind: b.kind,
  id: b.id,
  title: b.title,
  rel: b.rel,
  phase: b.phase,
  done: b.done,
  legacy: b.legacy,
  spec: b.spec,
  summary: b.summary,
});

// ---------- transcript ----------

function stickToBottom(p: Proj, fn: () => void): void {
  const t = p.transcript;
  const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  fn();
  if (atBottom && !p.replaying) t.scrollTop = t.scrollHeight;
}

const appendEntry = (p: Proj, el: HTMLElement) => stickToBottom(p, () => p.transcript.append(el));

function emptyTranscript(p: Proj): void {
  p.transcript.replaceChildren(
    h('div', { class: 'empty' }, h('p', {}, `The agent has ${p.name}'s rules loaded. Ask for something, or use the ⋯ menu on a task to start it.`)),
  );
}

function assistantDelta(p: Proj, msgId: string, index: number, text: string): void {
  const key = `${msgId}:${index}`;
  let el = p.liveText.get(key);
  if (!el) {
    el = h('div', { class: 'msg assistant streaming' });
    el.dataset.raw = '';
    p.liveText.set(key, el);
    appendEntry(p, el);
  }
  el.dataset.raw += text;
  stickToBottom(p, () => (el!.textContent = el!.dataset.raw ?? ''));
}

function assistantFinal(p: Proj, msgId: string, text: string, parent: string | null): void {
  if (parent) return nestUnder(p, parent, h('div', { class: 'sub-text' }, text.slice(0, 300)));
  const entry = [...p.liveText.entries()].find(([k]) => k.startsWith(msgId + ':'));
  let el: HTMLElement;
  if (entry) {
    p.liveText.delete(entry[0]);
    el = entry[1];
  } else {
    el = h('div', { class: 'msg assistant' });
    appendEntry(p, el);
  }
  el.classList.remove('streaming');
  stickToBottom(p, () => (el.innerHTML = md(text)));
}

function relPath(p: Proj, file: string): string {
  const root = p.dir.replace(/[\\/]+$/, '');
  for (const sep of ['/', '\\']) if (file.startsWith(root + sep)) return file.slice(root.length + 1);
  return file;
}

// Tool calls are drawn the way Claude Code's terminal shows them: Name(argument).
function toolSummary(p: Proj, name: string, input: unknown): { label: string; detail?: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? (v.startsWith('/') || /^[A-Za-z]:\\/.test(v) ? relPath(p, v) : v) : undefined);
  switch (name) {
    case 'Bash':
      return { label: 'Bash', detail: str(i.command) };
    case 'Monitor':
      return { label: 'Monitor', detail: str(i.description) ?? str(i.command) };
    case 'Read':
      return { label: 'Read', detail: str(i.file_path) };
    case 'Write':
      return { label: 'Write', detail: str(i.file_path) };
    case 'Edit':
    case 'MultiEdit':
      return { label: 'Update', detail: str(i.file_path) };
    case 'Grep':
      return { label: 'Search', detail: str(i.pattern) ? `pattern: "${i.pattern}"` : undefined };
    case 'Glob':
      return { label: 'Search', detail: str(i.pattern) };
    case 'Skill':
      return { label: 'Skill', detail: str(i.skill) ?? str(i.name) };
    case 'Task':
    case 'Agent':
      return { label: str(i.subagent_type) ? `Task: ${i.subagent_type}` : 'Task', detail: str(i.description) };
    case 'TodoWrite':
      return { label: 'Update Todos' };
    case 'WebSearch':
      return { label: 'Web Search', detail: str(i.query) };
    case 'WebFetch':
      return { label: 'Fetch', detail: str(i.url) };
    default:
      return { label: name, detail: JSON.stringify(input)?.slice(0, 160) };
  }
}

function firstLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return 'Done';
  const head = lines[0].length > 140 ? lines[0].slice(0, 139) + '…' : lines[0];
  return lines.length > 1 ? `${head}  (+${lines.length - 1} lines)` : head;
}

// Claude Code summarises some results instead of echoing them.
function resultLine(tool: string, preview: string): string {
  const lines = preview.split('\n').filter((l) => l.trim()).length;
  if (tool === 'Read') return `Read ${lines} line${lines === 1 ? '' : 's'}`;
  if ((tool === 'Grep' || tool === 'Glob') && lines) return `Found ${lines} result${lines === 1 ? '' : 's'}`;
  return firstLine(preview);
}

function ledgerCall(s: { label: string; detail?: string }): HTMLElement {
  return h('span', { class: 'tool-call' }, h('span', { class: 'tool-name' }, s.label), s.detail ? h('span', { class: 'tool-arg' }, `(${s.detail})`) : null);
}

function nestUnder(p: Proj, parentToolId: string, el: HTMLElement): void {
  const card = p.toolCards.get(parentToolId);
  if (!card) return;
  let list = card.querySelector<HTMLElement>('.sub-steps');
  if (!list) {
    list = h('div', { class: 'sub-steps' });
    card.append(list);
  }
  stickToBottom(p, () => list!.append(el));
}

function toolUse(p: Proj, id: string, name: string, input: unknown, parent: string | null): void {
  const s = toolSummary(p, name, input);
  if (parent) {
    const line = h('div', { class: 'sub-step' }, ledgerCall(s));
    p.toolCards.set(id, line);
    return nestUnder(p, parent, line);
  }
  const card = h(
    'details',
    { class: `tool tool-${name.toLowerCase()} pending`, dataset: { tool: name } },
    h(
      'summary',
      {},
      h('span', { class: 'tool-line' }, h('span', { class: 'bullet', 'aria-hidden': 'true' }), ledgerCall(s)),
      h('span', { class: 'tool-result' }, h('span', { class: 'elbow', 'aria-hidden': 'true' }, '⎿'), h('span', { class: 'tool-result-text' }, 'Running…')),
    ),
    h('pre', { class: 'tool-input' }, JSON.stringify(input, null, 2)),
  );
  p.toolCards.set(id, card);
  appendEntry(p, card);
}

function toolResult(p: Proj, toolUseId: string, isError: boolean, preview: string): void {
  const card = p.toolCards.get(toolUseId);
  if (!card) return;
  card.classList.remove('pending');
  card.classList.toggle('failed', isError);
  if (card.tagName !== 'DETAILS') return;
  const text = card.querySelector('.tool-result-text');
  if (text) text.textContent = isError ? `Error: ${firstLine(preview)}` : resultLine(card.dataset.tool ?? '', preview);
  if (preview.trim()) {
    card.append(h('pre', { class: 'tool-output' }, preview));
    if (isError) (card as HTMLDetailsElement).open = true;
  }
}

function permissionRequest(p: Proj, id: string, toolName: string, input: unknown, reason?: string): void {
  p.pending.add(id);
  const s = toolSummary(p, toolName, input);
  const decide = (decision: 'allow' | 'always' | 'deny') => {
    send({ type: 'permissionReply', project: p.dir, id, decision });
    markAnswered(p, id, decision === 'deny' ? 'Denied' : decision === 'always' ? 'Allowed for this session' : 'Allowed once');
  };
  const card = h(
    'div',
    { class: 'permission', role: 'group', 'aria-label': `The agent wants to use ${toolName}` },
    h('p', { class: 'permission-title' }, `The agent wants to use ${toolName}`),
    s.detail ? h('code', { class: 'permission-detail' }, s.detail) : null,
    reason ? h('p', { class: 'permission-reason' }, reason) : null,
    h(
      'div',
      { class: 'permission-actions' },
      h('button', { class: 'button primary', type: 'button', onclick: () => decide('allow') }, 'Allow once'),
      h('button', { class: 'button', type: 'button', onclick: () => decide('always') }, 'Allow for session'),
      h('button', { class: 'button quiet', type: 'button', onclick: () => decide('deny') }, 'Deny'),
    ),
  );
  p.permissionCards.set(id, card);
  appendEntry(p, card);
  if (p === active && !p.replaying) card.querySelector<HTMLButtonElement>('button')?.focus();
}

function markAnswered(p: Proj, id: string, outcome: string): void {
  p.pending.delete(id);
  const card = p.permissionCards.get(id);
  if (card && !card.classList.contains('answered')) {
    card.classList.add('answered');
    card.querySelector('.permission-actions')?.replaceChildren(h('span', { class: 'permission-outcome' }, outcome));
  }
  p.permissionCards.delete(id);
  renderProjects();
}

function notice(p: Proj, level: 'info' | 'warn' | 'error', text: string): void {
  appendEntry(p, h('div', { class: `notice ${level}`, role: level === 'error' && !p.replaying ? 'alert' : undefined }, text));
}

// ---------- questions ----------

interface ChatQuestion {
  id: string;
  text: string;
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * The questions in one of Claude's replies: list items and prose lines with a question mark,
 * and every item of a list under a "Questions" line. A list item keeps the options under it.
 */
function extractQuestions(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  let fence = false;
  let underQuestions = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !line.trim()) continue;
    const item = LIST_ITEM.exec(line);
    if (!item) {
      underQuestions = /\bquestions?\b[^.?!]*:?\**\s*$/i.test(line) && !line.includes('?');
      if (line.includes('?')) out.push(line.replace(/^\s*(#{1,6}\s+|>\s*)/, '').trim());
      continue;
    }
    if (!item[2].includes('?') && !underQuestions) continue;
    const indent = item[1].length;
    const parts = [item[2].trim()];
    for (; i + 1 < lines.length; i++) {
      const sub = /^(\s*)\S/.exec(lines[i + 1]);
      if (!sub || sub[1].length <= indent) break;
      parts.push(lines[i + 1].trim());
    }
    out.push(parts.join('\n'));
  }
  return out;
}

function noteReply(p: Proj, msgId: string, text: string): void {
  if (p.freshTurn) {
    p.chatQuestions = [];
    p.freshTurn = false;
  }
  extractQuestions(text).forEach((q, n) => p.chatQuestions.push({ id: `chat:${msgId}:${n}`, text: q }));
}

function askQuestions(p: Proj, id: string, questions: AskedQuestion[]): void {
  p.pending.add(id);
  p.asked.set(id, questions);
  const card = h(
    'div',
    { class: 'permission ask-note', role: 'group', 'aria-label': 'The agent has questions for you' },
    h('p', { class: 'permission-title' }, questions.length === 1 ? 'The agent has a question for you' : `The agent has ${questions.length} questions for you`),
    h('p', { class: 'permission-reason' }, questions.map((q) => q.question).join(' · ')),
    h('div', { class: 'permission-actions' }, h('button', { class: 'button primary', type: 'button', onclick: () => openQuestion(p, `ask:${id}`) }, 'Answer')),
  );
  p.permissionCards.set(id, card);
  appendEntry(p, card);
}

const RECOMMENDED = /\s*\((recommended)\)\s*$/i;

/** Claude's AskUserQuestion call as a form: every question in the call is answered together. */
function askForm(p: Proj, id: string, questions: AskedQuestion[]): { body: HTMLElement; actions: HTMLElement[] } {
  const picks = questions.map(() => new Set<string>());
  const others = questions.map(() => '');
  const submit = h('button', { class: 'button primary', type: 'button', disabled: true }, questions.length > 1 ? 'Submit answers' : 'Submit answer') as HTMLButtonElement;
  const complete = () => questions.every((_, i) => picks[i].size > 0 && (!picks[i].has('__other') || others[i].trim()));
  const refresh = () => (submit.disabled = !complete());
  const settle = (outcome: string) => {
    p.asked.delete(id);
    markAnswered(p, id, outcome);
    afterAnswer(p);
  };
  submit.addEventListener('click', () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      answers[q.question] = [...picks[i]].map((l) => (l === '__other' ? others[i].trim() : l)).join(', ');
    });
    send({ type: 'answerQuestions', project: p.dir, id, answers });
    settle('Answered');
  });

  const blocks = questions.map((q, i) => {
    const name = `${id}:${i}`;
    const type = q.multiSelect ? 'checkbox' : 'radio';
    const choose = (value: string, on: boolean) => {
      if (!q.multiSelect) picks[i].clear();
      if (on) picks[i].add(value);
      else picks[i].delete(value);
      refresh();
    };
    const other = h('input', { class: 'ask-other-text', type: 'text', placeholder: 'Your own answer', 'aria-label': `Your own answer to: ${q.question}` }) as HTMLInputElement;
    const otherPick = h('input', { type, name, value: '__other', 'aria-label': 'Use your own answer' }) as HTMLInputElement;
    other.addEventListener('input', () => {
      others[i] = other.value;
      if (others[i].trim() && !otherPick.checked) {
        otherPick.checked = true;
        choose('__other', true);
      } else refresh();
    });
    otherPick.addEventListener('change', () => choose('__other', otherPick.checked));
    return h(
      'fieldset',
      { class: 'ask-q' },
      h('legend', {}, q.header ? h('span', { class: 'ask-header' }, q.header) : null, h('span', { class: 'ask-question' }, q.question)),
      q.multiSelect ? h('p', { class: 'ask-hint' }, 'Choose any that apply') : null,
      ...q.options.map((o) => {
        const recommended = RECOMMENDED.test(o.label);
        const input = h('input', { type, name, value: o.label }) as HTMLInputElement;
        input.addEventListener('change', () => choose(o.label, input.checked));
        return h(
          'label',
          { class: `ask-option${recommended ? ' recommended' : ''}` },
          input,
          h(
            'span',
            { class: 'ask-option-body' },
            h('span', { class: 'ask-option-label' }, o.label.replace(RECOMMENDED, ''), recommended ? h('span', { class: 'badge' }, 'Recommended') : null),
            o.description ? h('span', { class: 'ask-option-desc' }, o.description) : null,
          ),
        );
      }),
      h('label', { class: 'ask-option other' }, otherPick, other),
    );
  });

  const dismiss = h(
    'button',
    {
      class: 'button quiet',
      type: 'button',
      title: 'The agent carries on and you answer in your next message',
      onclick: () => {
        send({ type: 'answerQuestions', project: p.dir, id });
        settle('Dismissed: answer in the conversation');
      },
    },
    'Answer in chat instead',
  );
  return { body: h('div', { class: 'ask-form' }, ...blocks), actions: [submit, dismiss] };
}

interface QuestionRow {
  id: string;
  text: string;
  source?: OpenQuestion;
}

const where = (q: QuestionRow) => (q.source ? `${q.source.rel}, Open questions` : 'asked in the conversation');
const questionTitle = (text: string) => text.split('\n')[0].replace(/\*\*|__|`/g, '');

function openRows(p: Proj): QuestionRow[] {
  return [
    ...p.chatQuestions.filter((q) => !p.answeredQuestions.has(q.id)).map((q) => ({ id: q.id, text: q.text })),
    ...p.docQuestions.filter((q) => !p.answeredQuestions.has(q.id)).map((q) => ({ id: q.id, text: q.text, source: q })),
  ];
}

/** Send the answers typed so far: the given questions, or every one with a draft. */
function sendAnswers(p: Proj, only?: string[]): void {
  const rows = openRows(p).filter((q) => (!only || only.includes(q.id)) && p.answerDrafts.get(q.id)?.trim());
  if (!rows.length) return;
  const lines = rows.map((q, n) => `${n + 1}. ${questionTitle(q.text)} (${where(q)})\n   Answer: ${p.answerDrafts.get(q.id)!.trim().replace(/\n/g, '\n   ')}`);
  send({
    type: 'send',
    project: p.dir,
    text:
      `My answers to open questions:\n\n${lines.join('\n\n')}` +
      (rows.some((q) => q.source) ? '\n\nRecord each decision in the document that owns it and take it off that Open questions list, as the project-planning standard says.' : ''),
  });
  for (const q of rows) {
    p.answeredQuestions.add(q.id);
    p.answerDrafts.delete(q.id);
    p.selectedQuestions.delete(q.id);
  }
  afterAnswer(p);
}

/** Have Claude ask the given questions (or the selected ones) as multiple choice, with recommendations. */
function askAsChoices(p: Proj, only?: string[]): void {
  const rows = openRows(p).filter((q) => (only ? only.includes(q.id) : p.selectedQuestions.has(q.id)));
  if (!rows.length) return;
  send({
    type: 'send',
    project: p.dir,
    text:
      'Ask me these open questions with the AskUserQuestion tool, at most four per call. Check the code and the plan first so the ' +
      'options are grounded. Give each question 2 to 4 distinct options with a short description, and end the label of every ' +
      'option you recommend with " (Recommended)": at least one per question, more where several are good. When I answer, record ' +
      'each decision where its question lives and take it off that Open questions list.\n\n' +
      rows.map((q, n) => `${n + 1}. ${q.text.replace(/\n/g, ' ')} (${where(q)})`).join('\n'),
  });
  for (const q of rows) p.selectedQuestions.delete(q.id);
  if (docsView?.question) closeDocs();
  renderQuestions(true);
}

/** After answering from the popup, move on to the next open question, or close it. */
function afterAnswer(p: Proj): void {
  renderQuestions(true);
  if (!docsView?.question || docsView.project !== p.dir) return;
  const next = [...p.asked.keys()].map((id) => `ask:${id}`)[0] ?? openRows(p).find((r) => !r.source?.leftOpen)?.id;
  if (next) openQuestion(p, next);
  else closeDocs();
}

function openQuestion(p: Proj, id: string): void {
  docsView = { project: p.dir, key: `question:${id}`, requestId: '', tab: '', docs: [], question: id };
  questionViewKey = '';
  renderDocs();
  renderHeader();
  renderQuestions(true);
  $('docs-panel').hidden = false;
  ($('docs-body').querySelector<HTMLElement>('textarea, input') ?? $('docs-close')).focus();
}

let questionViewKey = '';

/** The question popup, in the docs panel. Rebuilt only when it shows something else, so drafts and picks survive. */
function renderQuestionView(p: Proj | undefined, id: string): void {
  const key = `${p?.dir}|${id}`;
  if (key === questionViewKey) return;
  questionViewKey = key;
  $('docs-tabs').hidden = true;
  const body = $('docs-body');
  const actions = $('docs-actions');
  actions.hidden = false;
  const askId = id.startsWith('ask:') ? id.slice(4) : undefined;
  const asked = p && askId ? p.asked.get(askId) : undefined;
  const row = p && !askId ? openRows(p).find((r) => r.id === id) : undefined;

  if (p && askId && asked) {
    $('docs-ref').textContent = 'The agent is asking';
    $('docs-title').textContent = asked.length > 1 ? `${asked.length} questions` : asked[0].header || 'A question';
    const form = askForm(p, askId, asked);
    body.replaceChildren(form.body);
    actions.replaceChildren(...form.actions);
    return;
  }
  if (!p || !row) {
    $('docs-ref').textContent = '';
    $('docs-title').textContent = 'Question';
    body.replaceChildren(h('div', { class: 'docs-empty' }, h('p', {}, 'This question has been answered.')));
    actions.replaceChildren();
    actions.hidden = true;
    return;
  }

  $('docs-ref').textContent = row.source ? row.source.doc : 'From the conversation';
  $('docs-title').textContent = questionTitle(row.text);
  const text = h('div', { class: 'q-full' });
  text.innerHTML = md(row.text);
  const answer = h('textarea', { class: 'q-answer', rows: 4, placeholder: 'Your answer', 'aria-label': 'Your answer' }) as HTMLTextAreaElement;
  answer.value = p.answerDrafts.get(id) ?? '';
  const sendBtn = h('button', { class: 'button primary', type: 'button', disabled: !answer.value.trim(), onclick: () => sendAnswers(p, [id]) }, 'Send answer') as HTMLButtonElement;
  answer.addEventListener('input', () => {
    p.answerDrafts.set(id, answer.value);
    sendBtn.disabled = !answer.value.trim();
    renderQuestions();
  });
  answer.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      sendAnswers(p, [id]);
    }
  });
  const left = row.source?.leftOpen;
  const parts: HTMLElement[] = [];
  if (row.source) {
    const src = row.source;
    parts.push(h('p', { class: 'docs-path' }, h('button', { class: 'link-button', type: 'button', onclick: () => showDoc(p, src.rel, src.doc) }, `${src.rel}, line ${src.line + 1}`)));
  }
  if (left) parts.push(h('p', { class: 'q-tag' }, typeof left === 'string' ? `You left this open on ${left}` : 'You left this open'));
  parts.push(
    text,
    h('label', { class: 'q-answer-label' }, h('span', {}, 'Your answer'), answer),
    h('p', { class: 'field-hint' }, 'Ctrl+Enter to send. Or have the agent ask it as multiple choice, with the options it recommends.'),
  );
  body.replaceChildren(...parts);
  actions.replaceChildren(sendBtn, h('button', { class: 'button', type: 'button', onclick: () => askAsChoices(p, [id]) }, 'Ask me as choices'));
}

let questionsKey = '';

/** The list in the right bar: one line per question; clicking one opens it. */
function renderQuestions(force = false): void {
  const p = active;
  const section = $('questions-section');
  if (!p) {
    section.hidden = true;
    questionsKey = '';
    return;
  }
  const rows = openRows(p);
  const asked = [...p.asked.entries()];
  const openId = docsView?.project === p.dir ? docsView.question : undefined;
  const key = JSON.stringify([p.dir, asked.map(([id]) => id), rows.map((r) => [r.id, !!p.answerDrafts.get(r.id)?.trim()]), openId]);
  const count = asked.reduce((n, [, qs]) => n + qs.length, 0) + rows.filter((r) => !r.source?.leftOpen).length;
  $('questions-count').textContent = count ? `${count} open` : '';
  section.hidden = !asked.length && !rows.length;
  if (!force && key === questionsKey) return updateQuestionActions(p);
  questionsKey = key;

  const item = (id: string, label: string, extra: { pick?: boolean; tag?: string; cls?: string }) => {
    const li = h('li', { class: `q-row${extra.cls ? ` ${extra.cls}` : ''}${openId === id ? ' open' : ''}` });
    if (extra.pick) {
      const pick = h('input', { type: 'checkbox', class: 'q-pick', title: 'Select to have the agent ask it as multiple choice', 'aria-label': `Select: ${label}` }) as HTMLInputElement;
      pick.checked = p.selectedQuestions.has(id);
      pick.addEventListener('change', () => {
        if (pick.checked) p.selectedQuestions.add(id);
        else p.selectedQuestions.delete(id);
        updateQuestionActions(p);
      });
      li.append(pick);
    } else li.append(h('span', { class: 'q-dot', 'aria-hidden': 'true' }));
    li.append(
      h(
        'button',
        { class: 'q-open', type: 'button', title: label, onclick: () => openQuestion(p, id) },
        h('span', { class: 'q-label' }, label),
        extra.tag ? h('span', { class: 'q-tag' }, extra.tag) : null,
        p.answerDrafts.get(id)?.trim() ? h('span', { class: 'q-tag draft' }, 'draft') : null,
      ),
    );
    return li;
  };

  const groups: HTMLElement[] = [];
  if (asked.length) {
    groups.push(
      h('div', { class: 'q-group asking' }, h('h3', {}, 'The agent is asking'), h('ul', { class: 'q-list' }, ...asked.flatMap(([id, qs]) => qs.map((q) => item(`ask:${id}`, q.question, { cls: 'asking' }))))),
    );
  }
  const chat = rows.filter((r) => !r.source);
  if (chat.length) groups.push(h('div', { class: 'q-group' }, h('h3', {}, 'From the conversation'), h('ul', { class: 'q-list' }, ...chat.map((r) => item(r.id, questionTitle(r.text), { pick: true })))));
  const byDoc = new Map<string, QuestionRow[]>();
  for (const r of rows) if (r.source) byDoc.set(r.source.rel, [...(byDoc.get(r.source.rel) ?? []), r]);
  for (const [rel, list] of byDoc) {
    groups.push(
      h(
        'div',
        { class: 'q-group' },
        h('h3', {}, h('button', { class: 'link-button q-doc', type: 'button', title: `Open ${rel}`, onclick: () => showDoc(p, rel, list[0].source!.doc) }, list[0].source!.doc)),
        h('ul', { class: 'q-list' }, ...list.map((r) => item(r.id, questionTitle(r.text), { pick: true, tag: r.source?.leftOpen ? 'left open' : undefined, cls: r.source?.leftOpen ? 'left-open' : undefined }))),
      ),
    );
  }
  if (rows.length) {
    groups.push(
      h(
        'div',
        { class: 'q-actions' },
        h('button', { class: 'button', type: 'button', id: 'q-ask', title: 'The agent asks the selected questions as multiple choice, with its recommendations', onclick: () => askAsChoices(p) }, 'Ask as choices'),
        h('button', { class: 'button', type: 'button', id: 'q-send', onclick: () => sendAnswers(p) }, 'Send drafts'),
      ),
    );
  }
  $('questions').replaceChildren(...groups);
  updateQuestionActions(p);
}

function updateQuestionActions(p: Proj): void {
  const rows = openRows(p);
  const drafts = rows.filter((q) => p.answerDrafts.get(q.id)?.trim()).length;
  const picked = rows.filter((q) => p.selectedQuestions.has(q.id)).length;
  const sendBtn = document.getElementById('q-send') as HTMLButtonElement | null;
  const askBtn = document.getElementById('q-ask') as HTMLButtonElement | null;
  if (sendBtn) {
    sendBtn.hidden = !drafts;
    sendBtn.textContent = drafts > 1 ? `Send ${drafts} drafts` : 'Send draft';
  }
  if (askBtn) {
    askBtn.disabled = !picked;
    askBtn.textContent = picked ? `Ask ${picked} as choices` : 'Select to ask as choices';
  }
}

const ACTION_LABEL: Record<ItemAction, string> = { start: 'Start now', startSubagent: 'Start in subagent', reinvestigate: 'Reinvestigate', summarise: 'Summarise' };

function userMessage(p: Proj, text: string, action?: { kind: ItemAction; key: string }): void {
  p.transcript.querySelector('.empty')?.remove();
  if (action) {
    // Board buttons send a prompt on your behalf; show what was sent, folded.
    const el = h(
      'details',
      { class: 'msg user action' },
      h('summary', {}, h('span', { class: 'action-kind' }, ACTION_LABEL[action.kind]), ` ${action.key}`),
      h('div', { class: 'action-prompt' }, text),
    );
    return appendEntry(p, el);
  }
  appendEntry(p, h('div', { class: 'msg user' }, text));
}

/** Your own message always brings the conversation to the bottom, wherever you had scrolled. */
function scrollToEnd(p: Proj): void {
  if (!p.replaying) p.transcript.scrollTop = p.transcript.scrollHeight;
}

// ---------- menus ----------

const menuEl = $('menu');
let menuAnchor: HTMLElement | null = null;
let submenu: { el: HTMLElement; parent: HTMLButtonElement } | null = null;

interface MenuItem {
  label: string;
  run?: () => void;
  submenu?: MenuItem[];
  disabled?: boolean;
}

function menuButton(it: MenuItem, inSubmenu: boolean): HTMLButtonElement {
  if (it.submenu) {
    const b = h(
      'button',
      { class: 'menu-item has-submenu', type: 'button', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      h('span', {}, it.label),
      h('span', { class: 'menu-caret', 'aria-hidden': 'true' }, '›'),
    ) as HTMLButtonElement;
    b.addEventListener('click', () => openSubmenu(b, it.submenu!, true));
    b.addEventListener('mouseenter', () => openSubmenu(b, it.submenu!, false));
    return b;
  }
  const b = h(
    'button',
    {
      class: 'menu-item',
      type: 'button',
      role: 'menuitem',
      disabled: it.disabled,
      onclick: () => {
        closeMenu();
        it.run?.();
      },
    },
    it.label,
  ) as HTMLButtonElement;
  if (!inSubmenu) b.addEventListener('mouseenter', closeSubmenu);
  return b;
}

function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenu(false);
  menuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  menuEl.replaceChildren(...items.map((it) => menuButton(it, false)));
  menuEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth;
  const mh = menuEl.offsetHeight;
  menuEl.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left))}px`;
  menuEl.style.top = `${r.bottom + mh + 8 > window.innerHeight ? r.top - mh - 4 : r.bottom + 4}px`;
  menuEl.querySelector<HTMLButtonElement>('button')?.focus();
}

/** A flyout beside its parent item: to the right, or to the left when there's no room. */
function openSubmenu(parent: HTMLButtonElement, items: MenuItem[], focus: boolean): void {
  if (submenu?.parent !== parent) {
    closeSubmenu();
    const el = h('div', { class: 'menu submenu', role: 'menu' }, ...items.map((it) => menuButton(it, true)));
    document.body.append(el);
    el.addEventListener('keydown', (ev) => menuKeys(ev, el));
    submenu = { el, parent };
    parent.setAttribute('aria-expanded', 'true');
    const r = parent.getBoundingClientRect();
    const right = r.right + 4 + el.offsetWidth < window.innerWidth;
    el.style.left = `${right ? r.right + 4 : Math.max(8, r.left - el.offsetWidth - 4)}px`;
    el.style.top = `${Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, r.top - 4))}px`;
  }
  if (focus) submenu!.el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}

function closeSubmenu(): void {
  if (!submenu) return;
  submenu.parent.setAttribute('aria-expanded', 'false');
  submenu.el.remove();
  submenu = null;
}

function closeMenu(refocus = true): void {
  closeSubmenu();
  if (menuEl.hidden) return;
  menuEl.hidden = true;
  menuAnchor?.setAttribute('aria-expanded', 'false');
  if (refocus && menuAnchor?.isConnected) menuAnchor.focus();
  menuAnchor = null;
}

function menuKeys(ev: KeyboardEvent, el: HTMLElement): void {
  const items = [...el.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)')];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  const current = items[i];
  const inSubmenu = el !== menuEl;
  if (ev.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
  else if (ev.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
  else if (ev.key === 'ArrowRight' && current?.classList.contains('has-submenu')) current.click();
  else if (inSubmenu && (ev.key === 'ArrowLeft' || ev.key === 'Escape')) {
    const parent = submenu?.parent;
    closeSubmenu();
    parent?.focus();
  } else if (ev.key === 'Escape' || ev.key === 'Tab') closeMenu();
  else return;
  ev.preventDefault();
  ev.stopPropagation();
}

menuEl.addEventListener('keydown', (ev) => menuKeys(ev, menuEl));
document.addEventListener('pointerdown', (ev) => {
  const t = ev.target as Node;
  if (!menuEl.hidden && !menuEl.contains(t) && !submenu?.el.contains(t) && !menuAnchor?.contains(t)) closeMenu(false);
});

function progressLabel(item: BoardItem): string | undefined {
  if (item.kind === 'phase') return item.docLinks.length ? 'Show phase document' : undefined;
  return item.legacy && !item.spec && !item.summary ? 'Show details' : 'Show progress';
}

const PRIORITISE_LABEL = 'Prioritise (start after current work)';

function itemMenu(p: Proj, item: BoardItem): MenuItem[] {
  const queued = p.priorities.includes(item.key);
  const items: MenuItem[] = [];
  const progress = progressLabel(item);
  if (!item.done) {
    items.push({ label: queued ? 'Remove from queue' : PRIORITISE_LABEL, run: () => prioritise(p, item) });
    items.push({ label: 'Start now', run: () => runAction(p, 'start', item) });
    items.push({ label: 'Start in subagent (own worktree)', run: () => runAction(p, 'startSubagent', item) });
    if (progress) items.push({ label: progress, run: () => showProgress(p, item) });
  } else {
    if (queued) items.push({ label: 'Remove from queue', run: () => prioritise(p, item) });
    if (progress) items.push({ label: progress, run: () => showProgress(p, item) });
    items.push({ label: 'Summarise work done', run: () => runAction(p, 'summarise', item) });
    if (item.kind !== 'phase') items.push({ label: 'Reinvestigate with a subagent', run: () => runAction(p, 'reinvestigate', item) });
  }
  return items;
}

function runAction(p: Proj, action: ItemAction, item: BoardItem): void {
  if (action === 'start' || action === 'startSubagent') p.holdQueue = false;
  send({ type: 'runAction', project: p.dir, action, item: toActionItem(item) });
}

// ---------- priority queue: prioritised items start, in order, whenever Claude is free ----------

const isFree = (p: Proj) => !p.busy && !p.pending.size;

function nextQueued(p: Proj, skip?: string): BoardItem | undefined {
  const items = allItems(p);
  for (const key of p.priorities) {
    const it = items.get(key);
    if (it && !it.done && key !== skip) return it;
  }
  return undefined;
}

/** Queue an item to start after the current work, or take it off the queue. */
function prioritise(p: Proj, item: BoardItem): void {
  if (p.priorities.includes(item.key)) return send({ type: 'togglePriority', project: p.dir, key: item.key });
  const ahead = isFree(p) ? nextQueued(p, item.key) : undefined;
  // Nothing running and nothing queued ahead of it: there's no current work to wait for.
  if (isFree(p) && !ahead) return runAction(p, 'start', item);
  send({ type: 'togglePriority', project: p.dir, key: item.key });
  if (ahead) runAction(p, 'start', ahead);
}

/** Claude just finished a turn: start the next queued item, unless you stopped it or it failed. */
function startQueued(p: Proj): void {
  const held = p.holdQueue || !!p.lastTurn?.isError;
  p.holdQueue = false;
  if (held || !isFree(p)) return;
  const next = nextQueued(p);
  if (next) runAction(p, 'start', next);
}

function moreButton(p: Proj, item: BoardItem): HTMLButtonElement {
  const b = h('button', {
    class: 'more',
    type: 'button',
    'aria-label': `Actions for ${item.id ?? item.title}`,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    title: 'Actions',
  });
  b.append(svgIcon(ICON_MORE));
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (menuAnchor === b) return closeMenu();
    openMenu(b, itemMenu(p, item));
  });
  return b;
}

// ---------- progress panel (spec and summary) ----------

// A single document (plan.md, or where an open question lives) shows under doc: and its key.
interface PlainDoc {
  rel: string;
  ref: string;
  title: string;
}
let docsView: { project: string; key: string; requestId: string; tab: string; docs: DocContent[]; doc?: PlainDoc; question?: string } | undefined;

const planRel = (p: Proj) => [...p.docs].find((rel) => rel.toLowerCase() === 'plan.md');
const planOpen = (p: Proj) => docsView?.project === p.dir && !!docsView.doc && docsView.doc.rel === planRel(p);

function togglePlan(p: Proj): void {
  if (planOpen(p)) return closeDocs();
  const rel = planRel(p);
  if (rel) showDoc(p, rel, p.name, 'Plan');
}

function showDoc(p: Proj, rel: string, title: string, ref = ''): void {
  const requestId = Math.random().toString(36).slice(2);
  const key = `doc:${rel}`;
  docsView = { project: p.dir, key, requestId, tab: rel, docs: [], doc: { rel, ref, title } };
  send({ type: 'readDocs', project: p.dir, requestId, key, paths: [rel] });
  renderDocs();
  renderHeader();
  $('docs-panel').hidden = false;
  $('docs-close').focus();
}

function docPaths(item: BoardItem): string[] {
  return [item.spec, item.summary, ...item.docLinks.map((l) => l.rel)].filter((x): x is string => !!x);
}

/** A task with detail lines under it (Depends on, Blocked by, an older TASK.md's whole entry) shows that entry too. */
const docBlocks = (item: BoardItem) => (item.kind === 'task' && item.hasDetails ? [{ rel: item.rel, line: item.line }] : undefined);
const blockRel = (item: BoardItem) => `${item.rel}#L${item.line + 1}`;

function showProgress(p: Proj, item: BoardItem, openOn?: string): void {
  const requestId = Math.random().toString(36).slice(2);
  // Finished work opens on its summary; anything else on its spec.
  const tab = openOn ?? (item.done ? item.summary : item.spec) ?? item.spec ?? item.summary ?? (docBlocks(item) ? blockRel(item) : '');
  docsView = { project: p.dir, key: item.key, requestId, tab, docs: [] };
  send({ type: 'readDocs', project: p.dir, requestId, key: item.key, paths: docPaths(item), blocks: docBlocks(item) });
  renderDocs();
  renderHeader();
  $('docs-panel').hidden = false;
  $('docs-close').focus();
}

function refreshDocs(p: Proj): void {
  if (!docsView || docsView.project !== p.dir || docsView.question) return;
  if (docsView.doc) {
    docsView.requestId = Math.random().toString(36).slice(2);
    send({ type: 'readDocs', project: p.dir, requestId: docsView.requestId, key: docsView.key, paths: [docsView.doc.rel] });
    return;
  }
  const item = allItems(p).get(docsView.key);
  if (!item) return;
  docsView.requestId = Math.random().toString(36).slice(2);
  send({ type: 'readDocs', project: p.dir, requestId: docsView.requestId, key: item.key, paths: docPaths(item), blocks: docBlocks(item) });
}

function docLabel(item: BoardItem | undefined, rel: string): string {
  if (item && rel === blockRel(item)) return 'Task';
  if (item?.spec === rel) return 'Spec';
  if (item?.summary === rel) return 'Summary';
  return item?.docLinks.find((l) => l.rel === rel)?.label || rel.split('/').pop()!.replace(/\.md$/, '');
}

function renderDocs(): void {
  const panel = $('docs-panel');
  if (!docsView) return void (panel.hidden = true);
  const p = projects.get(docsView.project);
  if (docsView.question) return renderQuestionView(p, docsView.question);
  questionViewKey = '';
  const plain = docsView.doc;
  const item = p && !plain ? allItems(p).get(docsView.key) : undefined;
  $('docs-ref').textContent = plain ? plain.ref : item ? itemRef(item) : '';
  $('docs-title').textContent = plain ? plain.title : item?.title ?? docsView.key;

  const docs = docsView.docs;
  if (docs.length && !docs.some((d) => d.rel === docsView!.tab)) docsView.tab = docs[0].rel;
  const tabs = $('docs-tabs');
  tabs.replaceChildren(
    ...docs.map((d) =>
      h(
        'button',
        {
          class: 'docs-tab',
          type: 'button',
          role: 'tab',
          'aria-selected': String(d.rel === docsView!.tab),
          onclick: () => {
            docsView!.tab = d.rel;
            renderDocs();
          },
        },
        docLabel(item, d.rel),
      ),
    ),
  );
  tabs.hidden = docs.length < 2;

  const body = $('docs-body');
  const current = docs.find((d) => d.rel === docsView!.tab);
  if (current) {
    const isBlock = !!item && current.rel === blockRel(item);
    // A task entry starts with "TASK-050: Title", which the panel header already shows.
    body.innerHTML = md(isBlock ? current.markdown.replace(/^[^\n]*\n?/, '') : current.markdown);
    body.prepend(h('p', { class: 'docs-path' }, isBlock ? `${item!.rel}, line ${item!.line + 1}` : current.rel));
  } else if (plain) {
    body.replaceChildren(h('div', { class: 'docs-empty' }, h('p', {}, p && (p.docs.has(plain.rel) || p.docQuestions.some((q) => q.rel === plain.rel)) ? `Loading ${plain.rel}…` : `${plain.rel} isn't there any more.`)));
  } else {
    const what = item?.kind ?? 'task';
    const message = item?.kind === 'phase'
      ? 'This phase has no document yet.'
      : item?.legacy
      ? 'This task has no detail under it in the task file.'
      : item?.done
        ? `This ${what} has no spec or summary.`
        : `No spec yet. The agent writes one before starting work on this ${what}.`;
    body.replaceChildren(h('div', { class: 'docs-empty' }, h('p', {}, message)));
  }

  const actions = $('docs-actions');
  actions.replaceChildren();
  if (p && item) {
    if (!item.done) {
      actions.append(h('button', { class: 'button primary', type: 'button', onclick: () => runAction(p, 'start', item) }, 'Start now'));
      actions.append(h('button', { class: 'button', type: 'button', title: 'A background subagent does the work in its own git worktree', onclick: () => runAction(p, 'startSubagent', item) }, 'Start in subagent'));
      const queued = p.priorities.includes(item.key);
      actions.append(h('button', { class: 'button quiet', type: 'button', onclick: () => prioritise(p, item) }, queued ? 'Remove from queue' : 'Prioritise'));
    } else {
      actions.append(h('button', { class: 'button', type: 'button', onclick: () => runAction(p, 'summarise', item) }, 'Summarise work done'));
      actions.append(h('button', { class: 'button', type: 'button', onclick: () => runAction(p, 'reinvestigate', item) }, 'Reinvestigate'));
    }
  }
  actions.hidden = !actions.childElementCount;
}

function closeDocs(): void {
  const was = docsView;
  docsView = undefined;
  questionViewKey = '';
  $('docs-panel').hidden = true;
  if (was?.doc) renderHeader();
  if (was?.question) renderQuestions(true);
}

// ---------- board ----------

function phaseStatusClass(status: string): string {
  if (status.startsWith('done')) return 'done';
  if (status.startsWith('in progress')) return 'doing';
  if (status.startsWith('dropped')) return 'dropped';
  return 'planned';
}

function trackedItems(file?: TaskFile): TaskItem[] {
  if (!file) return [];
  const inTasks = file.items.filter((i) => i.section?.toLowerCase() === 'tasks');
  return inTasks.length ? inTasks : file.items;
}

function segmentBar(items: TaskItem[]): HTMLElement {
  const done = items.filter((i) => i.state === 'done').length;
  const total = items.filter((i) => i.state !== 'cancelled').length;
  const label = `${done} of ${total} tasks done`;
  if (items.length > 40 || !items.length) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return h('div', { class: 'bar continuous', role: 'img', 'aria-label': label }, h('span', { style: `width:${pct}%` }));
  }
  return h('div', { class: 'bar', role: 'img', 'aria-label': label }, ...items.map((i) => h('span', { class: `seg ${i.state}` })));
}

function docChips(p: Proj, item: BoardItem): HTMLElement | null {
  const chips: HTMLElement[] = [];
  const add = (rel: string | undefined, label: string) => {
    if (rel && p.docs.has(rel)) chips.push(h('button', { class: 'chip', type: 'button', onclick: () => showProgress(p, item), title: rel }, label));
  };
  add(item.spec, 'spec');
  add(item.summary, 'summary');
  return chips.length ? h('span', { class: 'chips' }, ...chips) : null;
}

function flag(): HTMLElement {
  const f = h('span', { class: 'flag', title: 'Prioritised' });
  f.append(svgIcon(ICON_FLAG));
  return f;
}

/** "waits on TASK-094" for unfinished dependencies, and Blocked by reasons, on open tasks. */
// ---------- what blocks a task ----------

const ID_IN_TEXT = /\b(?:TASK-\d+(?:\.\d+)*|[TB]\d+)\b/g;
const QUIET_WORDS = new Set(
  'waiting wait until which what should would could there their about need needs with from that this have will when where blocked block question questions decide decided decision answer open user owner the and for are not yet any'.split(' '),
);
const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !QUIET_WORDS.has(w)));

/** The open question a "Blocked by" reason is about: the one sharing most words with it, its own document first. */
function questionFor(p: Proj, item: BoardItem, reason: string): OpenQuestion | undefined {
  const reasonWords = words(reason);
  let best: OpenQuestion | undefined;
  let bestScore = 0;
  for (const q of p.docQuestions) {
    const qWords = words(q.text);
    let score = [...reasonWords].filter((w) => qWords.has(w)).length;
    if (!score) continue;
    if (q.rel === item.rel) score += 0.5;
    if (score > bestScore) [best, bestScore] = [q, score];
  }
  // "Blocked by: open question" with nothing to match on: the first one in the task's own document.
  return best ?? (/\bquestion/i.test(reason) ? p.docQuestions.find((q) => q.rel === item.rel) : undefined);
}

/** Show a task or bug on the board: open its phase, scroll to it and flash it. */
function revealItem(p: Proj, key: string): void {
  const target = boardIndex.get(key);
  if (!target) return;
  if (target.kind === 'task') {
    const phaseKey = target.legacy ? target.section ?? 'Tasks' : target.phase;
    if (phaseKey && !p.expanded.has(phaseKey)) {
      p.userToggled = true;
      p.expanded.add(phaseKey);
      renderTasks();
    }
  }
  const el = $('tasks').querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  if (!el) return showProgress(p, target);
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  el.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
}

function hintLink(label: string, title: string, run: () => void, cls: string): HTMLElement {
  return h('button', { class: `hint-link ${cls}`, type: 'button', title, onclick: run }, label);
}

/** "waits on T4" for unfinished dependencies and each Blocked by reason, each one a link to what blocks it. */
function waitHints(p: Proj, item: BoardItem, items: Map<string, BoardItem>): HTMLElement | null {
  if (item.done || item.state === 'cancelled') return null;
  const waiting = (item.dependsOn ?? []).filter((id) => {
    const dep = items.get(id);
    return dep && !dep.done && dep.state !== 'cancelled';
  });
  const parts: Child[] = [];
  if (waiting.length) {
    parts.push(
      h(
        'span',
        { class: 'waits' },
        'waits on ',
        ...waiting.flatMap((id, n) => [n ? ', ' : '', hintLink(id, `Go to ${id}: ${items.get(id)!.title}`, () => revealItem(p, id), 'waits')]),
      ),
    );
  }
  for (const reason of item.blockedBy ?? []) {
    const ids = [...new Set(reason.match(ID_IN_TEXT) ?? [])].filter((id) => items.has(id) && id !== item.key);
    const question = ids.length ? undefined : questionFor(p, item, reason);
    const label = `blocked: ${reason}`;
    if (ids.length) parts.push(hintLink(label, `Go to ${ids.join(', ')}`, () => revealItem(p, ids[0]), 'blocked'));
    else if (question) parts.push(hintLink(label, `Open the question: ${question.text.split('\n')[0]}`, () => openQuestion(p, question.id), 'blocked'));
    else parts.push(hintLink(label, 'Show where this is recorded', () => showProgress(p, item, docBlocks(item) ? blockRel(item) : undefined), 'blocked'));
  }
  return parts.length ? h('span', { class: 'hints' }, ...parts) : null;
}

let boardIndex = new Map<string, BoardItem>();

function taskRow(p: Proj, file: TaskFile, t: TaskItem): HTMLElement {
  const item = taskItem(p, file, t);
  const prioritised = p.priorities.includes(item.key);
  const box = h('button', {
    class: `check ${t.state}`,
    type: 'button',
    role: 'checkbox',
    'aria-checked': t.state === 'done' ? 'true' : t.state === 'doing' ? 'mixed' : 'false',
    'aria-label': item.title,
    title: t.state === 'done' ? 'Mark not done' : 'Mark done',
    onclick: () => send({ type: 'toggleTask', project: p.dir, rel: file.rel, line: t.line, text: t.text }),
  });
  return h(
    'li',
    { class: `task ${t.state}${prioritised ? ' prioritised' : ''}`, style: `--depth:${t.depth}`, dataset: { key: item.key } },
    box,
    h(
      'span',
      { class: 'task-main' },
      t.id ? h('span', { class: 'item-id' }, t.id) : null,
      h('span', { class: 'task-text' }, item.title),
      prioritised ? flag() : null,
      docChips(p, item),
      waitHints(p, item, boardIndex),
    ),
    moreButton(p, item),
  );
}

const taskList = (p: Proj, file: TaskFile, items: TaskItem[]) => h('ul', { class: 'task-list' }, ...items.map((i) => taskRow(p, file, i)));

function bugRow(p: Proj, file: TaskFile, b: BugEntry): HTMLElement {
  const item = bugItem(p, file, b);
  const prioritised = p.priorities.includes(item.key);
  return h(
    'li',
    { class: `bug ${b.status.replace(/[^a-z]+/g, '-')}${prioritised ? ' prioritised' : ''}`, dataset: { key: item.key } },
    h('span', { class: 'item-id bug-id' }, b.id),
    h(
      'span',
      { class: 'task-main' },
      h('span', { class: 'bug-title' }, b.title),
      prioritised ? flag() : null,
      h('span', { class: 'bug-meta' }, h('span', { class: 'bug-status' }, b.status), docChips(p, item)),
    ),
    moreButton(p, item),
  );
}

/** A phase's head row with its ⋯ menu beside it (a button can't hold another button). */
function phaseTop(p: Proj, item: BoardItem | undefined, head: HTMLElement): HTMLElement {
  if (!item) return head;
  if (p.priorities.includes(item.key)) head.querySelector('.phase-goal')?.append(flag());
  return h('div', { class: 'phase-top' }, head, moreButton(p, item));
}

function renderPriorities(p: Proj): void {
  const section = $('priorities-section');
  const items = allItems(p);
  const queued = p.priorities.map((k) => items.get(k)).filter((x): x is BoardItem => !!x);
  section.hidden = !queued.length;
  const open = queued.filter((q) => !q.done).length;
  const next = isFree(p) ? nextQueued(p) : undefined;
  $('priorities-count').replaceChildren(
    open ? `${open} queued` : '',
    next ? h('button', { class: 'link-button', type: 'button', title: `Start ${itemRef(next) || next.title} now`, onclick: () => runAction(p, 'start', next) }, 'Start next') : '',
  );
  $('priorities').replaceChildren(
    ...queued.map((it) =>
      h(
        'li',
        { class: `priority kind-${it.kind}${it.done ? ' done' : ''}${it.kind === 'bug' && !it.done ? ' open-bug' : ''}` },
        h('span', { class: 'item-id' }, itemRef(it) || '·'),
        h('button', { class: 'priority-title', type: 'button', onclick: () => showProgress(p, it), title: 'Show progress' }, it.title),
        h('span', { class: 'priority-state' }, it.kind === 'bug' ? it.status : it.state === 'doing' ? 'in progress' : it.done ? 'done' : ''),
        moreButton(p, it),
      ),
    ),
  );
}

function renderTasks(): void {
  const p = active;
  const tasksEl = $('tasks');
  $('delivery-section').hidden = !p;
  if (!p) {
    $('priorities-section').hidden = true;
    return;
  }
  renderPriorities(p);
  boardIndex = allItems(p);

  const files = p.tasks;
  const legacy = files.find((f) => f.kind === 'legacy');
  if (legacy) return renderLegacy(p, legacy, files);
  const index = files.find((f) => f.kind === 'index');
  const phases = files.filter((f) => f.kind === 'phase');
  const bugs = files.find((f) => f.kind === 'bugs');
  const others = files.filter((f) => f.kind === 'other');
  const summary = $('tasks-summary');

  if (!files.length) {
    summary.textContent = '';
    tasksEl.replaceChildren(h('div', { class: 'empty small' }, h('p', {}, 'No task.md yet. The board fills in as soon as task.md or tasks/*.md appear.')));
    return;
  }

  const rows = index?.phases ?? [];
  const currentRow = rows.find((r) => !['done', 'dropped'].includes(phaseStatusClass(r.status)));
  if (!p.userToggled && currentRow) p.expanded = new Set([currentRow.number]);

  const spine = h('ol', { class: 'spine' });
  const shown = new Set<string>();
  for (const row of rows) {
    const doc = phaseDocFor(row, phases);
    if (doc) shown.add(doc.rel);
    const items = trackedItems(doc);
    const cls = phaseStatusClass(row.status);
    const open = p.expanded.has(row.number);
    const done = items.filter((i) => i.state === 'done').length;
    const counted = items.filter((i) => i.state !== 'cancelled').length;
    const head = h(
      'button',
      {
        class: 'phase-head',
        type: 'button',
        'aria-expanded': String(open),
        onclick: () => {
          p.userToggled = true;
          if (open) p.expanded.delete(row.number);
          else p.expanded.add(row.number);
          renderTasks();
        },
      },
      h('span', { class: 'phase-num' }, row.number),
      h(
        'span',
        { class: 'phase-main' },
        h('span', { class: 'phase-goal' }, doc?.title.replace(PHASE_PREFIX, '') || row.goal || `Phase ${row.number}`),
        h('span', { class: 'phase-status' }, row.status || 'planned', counted ? `, ${done} of ${counted}` : ''),
      ),
    );
    spine.append(
      h(
        'li',
        { class: `phase ${cls}${row === currentRow ? ' current' : ''}` },
        phaseTop(p, boardIndex.get(`P${row.number}`), head),
        items.length ? segmentBar(items) : null,
        open && doc ? taskList(p, doc, items) : null,
        open && !doc ? h('p', { class: 'phase-missing' }, row.doc ? `${row.doc} not found` : 'No phase document linked') : null,
      ),
    );
  }

  const sections: HTMLElement[] = [];
  if (rows.length) sections.push(spine);
  else if (index) sections.push(h('p', { class: 'muted small' }, 'task.md has no phase table yet.'));

  for (const ph of phases.filter((x) => !shown.has(x.rel))) {
    sections.push(h('section', { class: 'loose' }, h('h3', {}, ph.title), segmentBar(trackedItems(ph)), taskList(p, ph, trackedItems(ph)), h('p', { class: 'muted small' }, 'Not listed in task.md')));
  }

  if (bugs?.bugs) {
    const open = bugs.bugs.filter((b) => b.status === 'open' || b.status === 'in progress');
    sections.push(
      h(
        'section',
        { class: 'bugs' },
        h('h3', {}, 'Bugs', h('span', { class: 'count' }, open.length ? `${open.length} open` : 'none open')),
        h('ul', { class: 'bug-list' }, ...bugs.bugs.map((b) => bugRow(p, bugs, b))),
      ),
    );
  }

  for (const f of others) sections.push(h('section', { class: 'loose' }, h('h3', {}, f.title), segmentBar(f.items), taskList(p, f, f.items)));

  const allTasks = phases.flatMap((ph) => trackedItems(ph));
  const doneAll = allTasks.filter((i) => i.state === 'done').length;
  summary.textContent = allTasks.length ? `${doneAll}/${allTasks.filter((i) => i.state !== 'cancelled').length}` : '';
  tasksEl.replaceChildren(...sections);
}

/**
 * Older format: one TASK.md whose "## Section" headings group the tasks. Each section with
 * tasks becomes a step on the spine; its status comes from its top-level tasks.
 */
function renderLegacy(p: Proj, file: TaskFile, files: TaskFile[]): void {
  const sections = legacySections(file);
  const statusOf = legacyStatus;
  // Sections in this format aren't always in delivery order: prefer one already in progress.
  const current = sections.find((s) => statusOf(s.items) === 'in progress') ?? sections.find((s) => statusOf(s.items) !== 'done');
  if (!p.userToggled && current) p.expanded = new Set([current.name]);

  const spine = h('ol', { class: 'spine' });
  sections.forEach((sec, n) => {
    const status = statusOf(sec.items);
    const top = sec.items.filter((i) => i.depth === 0);
    const done = top.filter((i) => i.state === 'done').length;
    const counted = top.filter((i) => i.state !== 'cancelled').length;
    const open = p.expanded.has(sec.name);
    spine.append(
      h(
        'li',
        { class: `phase ${phaseStatusClass(status)}${sec === current ? ' current' : ''}` },
        phaseTop(
          p,
          boardIndex.get(`section:${sec.name}`),
          h(
            'button',
            {
              class: 'phase-head',
              type: 'button',
              'aria-expanded': String(open),
              onclick: () => {
                p.userToggled = true;
                if (open) p.expanded.delete(sec.name);
                else p.expanded.add(sec.name);
                renderTasks();
              },
            },
            h('span', { class: 'phase-num' }, String(n + 1)),
            h('span', { class: 'phase-main' }, h('span', { class: 'phase-goal' }, sec.name), h('span', { class: 'phase-status' }, status, `, ${done} of ${counted}`)),
          ),
        ),
        segmentBar(top),
        open ? taskList(p, file, sec.items) : null,
      ),
    );
  });

  const parts: HTMLElement[] = [spine];
  // A tasks/bugs.md beside an older TASK.md still shows.
  const bugs = files.find((f) => f.kind === 'bugs');
  if (bugs?.bugs) {
    const openBugs = bugs.bugs.filter((b) => b.status === 'open' || b.status === 'in progress');
    parts.push(
      h(
        'section',
        { class: 'bugs' },
        h('h3', {}, 'Bugs', h('span', { class: 'count' }, openBugs.length ? `${openBugs.length} open` : 'none open')),
        h('ul', { class: 'bug-list' }, ...bugs.bugs.map((b) => bugRow(p, bugs, b))),
      ),
    );
  }
  for (const f of files.filter((x) => x.kind === 'other' || x.kind === 'phase')) {
    parts.push(h('section', { class: 'loose' }, h('h3', {}, f.title), segmentBar(f.items), taskList(p, f, f.items)));
  }

  const top = file.items.filter((i) => i.depth === 0);
  $('tasks-summary').textContent = `${top.filter((i) => i.state === 'done').length}/${top.filter((i) => i.state !== 'cancelled').length}`;
  $('tasks').replaceChildren(...parts);
}

// ---------- projects list ----------

function projectState(p: Proj): { cls: string; label: string } {
  if (p.pending.size) return { cls: 'needs-you', label: 'Needs you' };
  if (p.busy) return { cls: 'working', label: 'Working' };
  const live = p.processes.filter((x) => ['running', 'pending', 'paused'].includes(x.status) && !x.ambient).length;
  if (live) return { cls: 'background', label: `${live} running` };
  return { cls: 'idle', label: p.unseen ? 'New reply' : '' };
}

function renderProjects(): void {
  const list = $('project-list');
  const all = [...projects.values()];
  if (!all.length) return void list.replaceChildren(h('li', { class: 'muted small no-projects' }, 'No projects open.'));
  list.replaceChildren(
    ...all.map((p, i) => {
      const st = projectState(p);
      const closeBtn = h('button', { class: 'project-close', type: 'button', 'aria-label': `Close ${p.name}`, title: 'Close project' });
      closeBtn.append(svgIcon(ICON_CLOSE));
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeProject(p);
      });
      return h(
        'li',
        { class: `project-item ${st.cls}${p === active ? ' active' : ''}${p.unseen && p !== active ? ' unseen' : ''}` },
        h(
          'button',
          {
            class: 'project-switch',
            type: 'button',
            'aria-current': p === active ? 'true' : undefined,
            title: `${p.dir}${i < 9 ? `  (Ctrl+${i + 1})` : ''}`,
            onclick: () => activate(p),
          },
          h('span', { class: 'project-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'project-title' }, p.name),
          st.label ? h('span', { class: 'project-state' }, st.label) : null,
        ),
        closeBtn,
      );
    }),
  );
}

// ---------- processes & session ----------

const KIND_LABEL: Record<string, string> = { shell: 'Shell', monitor: 'Monitor', subagent: 'Subagent', workflow: 'Workflow', other: 'Task' };

function renderProcesses(): void {
  const el = $('processes');
  const p = active;
  if (!p) {
    el.replaceChildren();
    $('proc-summary').textContent = '';
    return;
  }
  const live = p.processes.filter((x) => ['running', 'pending', 'paused'].includes(x.status));
  const ended = p.processes.filter((x) => !live.includes(x));
  $('proc-summary').textContent = live.length ? String(live.length) : '';

  const row = (x: ProcessInfo, isLive: boolean) =>
    h(
      'li',
      { class: `proc ${x.kind} ${isLive ? 'live' : 'ended'} status-${x.status}${x.ambient ? ' ambient' : ''}` },
      h(
        'div',
        { class: 'proc-head' },
        h('span', { class: 'proc-kind' }, KIND_LABEL[x.kind] ?? x.rawType),
        h('span', { class: 'proc-time', dataset: { start: String(x.startedAt) } }, elapsed(x.startedAt, x.endedAt)),
        isLive
          ? h('button', { class: 'button tiny quiet', type: 'button', title: `Stop ${x.description}`, onclick: () => send({ type: 'stopProcess', project: p.dir, id: x.id }) }, 'Stop')
          : h('span', { class: 'proc-status' }, x.status),
      ),
      h('div', { class: 'proc-desc' }, x.description),
      x.command && x.command !== x.description ? h('code', { class: 'proc-cmd' }, x.command) : null,
      x.summary || x.lastTool ? h('div', { class: 'proc-summary' }, x.summary ?? `Last used ${x.lastTool}`) : null,
    );

  const parts: HTMLElement[] = [
    live.length
      ? h('ul', { class: 'proc-list' }, ...live.map((x) => row(x, true)))
      : h('p', { class: 'muted small' }, 'Nothing running. Background shells, monitors and subagents show up here.'),
  ];
  if (ended.length) parts.push(h('details', { class: 'finished' }, h('summary', {}, `Finished (${ended.length})`), h('ul', { class: 'proc-list' }, ...ended.map((x) => row(x, false)))));
  const wasOpen = el.querySelector<HTMLDetailsElement>('details.finished')?.open;
  el.replaceChildren(...parts);
  if (wasOpen) el.querySelector<HTMLDetailsElement>('details.finished')!.open = true;
}

setInterval(() => {
  document.querySelectorAll<HTMLElement>('.proc.live .proc-time').forEach((t) => (t.textContent = elapsed(Number(t.dataset.start))));
}, 1000);

function loginLabel(src: string): { text: string; ok: boolean } {
  if (src === 'oauth') return { text: 'Claude subscription', ok: true };
  if (src === 'none') return { text: 'Claude login', ok: true };
  return { text: `API key (${src})`, ok: false };
}

function renderSession(): void {
  const dl = $('session');
  const p = active;
  const fw = p?.framework;
  const s = p?.session;
  const rows: [string, Node | string][] = [];

  if (fw) {
    const shadowed = fw.agentsMd && fw.claudeMd.length > 0 && !fw.claudeMdImportsAgents;
    rows.push([
      'Rules',
      fw.agentsMd
        ? h('span', { class: shadowed ? 'warn-text' : '' }, shadowed ? `AGENTS.md is ignored: ${fw.claudeMd[0]} takes priority and doesn't reference it` : 'AGENTS.md')
        : fw.claudeMd.length
          ? fw.claudeMd.join(', ')
          : h('span', { class: 'muted' }, 'No AGENTS.md or CLAUDE.md'),
    ]);
    const claudeSkills = fw.skills.length;
    const agentSkills = fw.agentsSkills.length;
    if (agentSkills || claudeSkills) {
      rows.push([
        'Standards',
        agentSkills && !claudeSkills
          ? `${agentSkills} in .agents/skills, loaded through the AGENTS.md table`
          : `${claudeSkills} skills the agent can load on its own${agentSkills ? `, ${agentSkills} in .agents/skills` : ''}`,
      ]);
    }
    if (fw.hooks.length) rows.push(['Hooks', fw.hooks.join(', ')]);
    if (fw.agents.length) rows.push(['Agents', fw.agents.join(', ')]);
  }
  if (p) {
    const prov = providerOf(p);
    const local = prov.kind !== 'subscription';
    const edit = h('button', { class: 'link-button', type: 'button', onclick: openSettings }, 'Change');
    rows.push(['Provider', h('span', {}, local ? `${prov.name} at ${prov.baseUrl}` : prov.name, ' ', edit)]);
    if (local) rows.push(['Billing', 'Local model, no Anthropic usage']);
  }
  if (s) {
    const login = loginLabel(s.apiKeySource);
    rows.push(['Model', s.model]);
    if (providerOf(p!).kind === 'subscription') rows.push(['Billing', h('span', { class: login.ok ? '' : 'warn-text' }, login.text)]);
    if (s.mcpServers.length) rows.push(['MCP', s.mcpServers.map((m) => `${m.name} (${m.status})`).join(', ')]);
  }
  if (p?.lastTurn) rows.push(['Last turn', `${(p.lastTurn.durationMs / 1000).toFixed(1)}s, ${p.lastTurn.outputTokens.toLocaleString()} tokens out`]);
  if (p && !s) rows.push(['', h('span', { class: 'muted' }, 'The agent starts with your first message.')]);
  dl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

function closeProject(p: Proj): void {
  const working = p.busy || p.processes.some((x) => x.status === 'running');
  if (working && !confirm(`The agent is still working in ${p.name}. Close it and stop that work?`)) return;
  send({ type: 'close', project: p.dir });
}

function projectMenu(p: Proj): MenuItem[] {
  const editors: MenuItem[] = editorList.length
    ? editorList.map((e) => ({ label: e.name, run: () => send({ type: 'openWith', project: p.dir, editor: e.id }) }))
    : [{ label: 'No editors found', disabled: true }];
  const items: MenuItem[] = [
    { label: 'Open directory', run: () => send({ type: 'openFolder', project: p.dir }) },
    { label: 'Open with', submenu: editors },
  ];
  if (planRel(p)) items.push({ label: 'Show plan', run: () => togglePlan(p) });
  items.push({ label: 'Copy path', run: () => void navigator.clipboard?.writeText(p.dir) });
  items.push({ label: 'Close project', run: () => closeProject(p) });
  return items;
}

function renderHeader(): void {
  const p = active;
  $('project-header').hidden = !p;
  if (!p) return void (document.title = 'Slop Factory');
  // With a plan.md the name opens it as the project summary.
  const plan = planRel(p);
  $('project-name').replaceChildren(
    plan
      ? h('button', { class: 'project-name-button', type: 'button', title: `Show ${plan}`, 'aria-expanded': String(planOpen(p)), 'aria-controls': 'docs-panel', onclick: () => togglePlan(p) }, p.name)
      : p.name,
  );
  $('project-path').textContent = `‎${p.dir}‎`;
  $('project-path').title = p.dir;
  const fw = p.framework;
  $('framework-badge').textContent = fw?.agentsMd ? (fw.agentsSkills.length ? `AGENTS.md with ${fw.agentsSkills.length} standards` : 'AGENTS.md') : '';
  document.title = `${p.name} – Slop Factory`;
}

// Claude Code's working indicator cycles through these glyphs.
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
let spinnerTimer: number | undefined;

function renderComposer(): void {
  const p = active;
  const prompt = $<HTMLTextAreaElement>('prompt');
  const hasText = prompt.value.trim().length > 0;
  prompt.disabled = !p;
  prompt.placeholder = p ? `Message the agent about ${p.name}` : 'Open a project to start';
  const mode = $<HTMLSelectElement>('permission-mode');
  mode.disabled = !p;
  // Auto mode's safety checks run on Anthropic's servers, so it needs the Claude subscription.
  const autoOption = mode.querySelector<HTMLOptionElement>('option[value=auto]')!;
  const local = !!p && providerOf(p).kind !== 'subscription';
  autoOption.disabled = local;
  autoOption.textContent = local ? 'Auto mode (needs Claude subscription)' : 'Auto mode';
  if (p) mode.value = p.mode;
  mode.title =
    p?.mode === 'auto'
      ? 'Routine actions are approved automatically; risky ones ask first'
      : p?.mode === 'bypassPermissions'
        ? 'Every action runs without asking (--dangerously-skip-permissions). Auto mode is the safer hands-off choice.'
        : 'How the agent asks before acting';
  const prov = $<HTMLSelectElement>('provider');
  prov.disabled = !p;
  prov.replaceChildren(...providerList.map((x) => h('option', { value: x.id }, x.name)));
  prov.value = p?.providerId ?? 'subscription';
  const busy = !!p?.busy;
  $('stop').hidden = !busy;
  $('send').hidden = busy && !hasText;
  $<HTMLButtonElement>('send').disabled = !p || !hasText;

  const act = $('activity');
  act.hidden = !busy;
  $('activity-text').textContent = p?.status === 'compacting' ? 'Compacting conversation…' : 'Working…';
  const spin = act.querySelector<HTMLElement>('.spinner')!;
  if (busy && spinnerTimer === undefined && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let n = 0;
    spinnerTimer = window.setInterval(() => (spin.textContent = SPINNER[n++ % SPINNER.length]), 120);
  } else if (!busy && spinnerTimer !== undefined) {
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }
}

function renderWelcome(): void {
  const host = $('transcripts');
  const existing = host.querySelector('.welcome');
  if (projects.size) return void existing?.remove();
  if (!existing) {
    host.append(
      h(
        'div',
        { class: 'empty welcome' },
        h('p', {}, 'Create or open a project to start. The agent picks up its AGENTS.md, skills and settings, and its task.md shows up on the left.'),
        h(
          'div',
          { class: 'welcome-actions' },
          h('button', { class: 'button primary', type: 'button', onclick: newProjectDialog }, 'New project'),
          h('button', { class: 'button', type: 'button', onclick: () => void openProject() }, 'Open a folder'),
        ),
      ),
    );
  }
}

function renderAll(): void {
  renderProjects();
  renderHeader();
  renderTasks();
  renderQuestions();
  renderProcesses();
  renderSession();
  renderComposer();
  renderWelcome();
}

function activate(p: Proj | undefined): void {
  const prompt = $<HTMLTextAreaElement>('prompt');
  if (active) active.draft = prompt.value;
  for (const x of projects.values()) x.transcript.hidden = x !== p;
  active = p;
  if (p) {
    p.unseen = false;
    prompt.value = p.draft;
    store('slop-factory:active', p.dir);
    requestAnimationFrame(() => (p.transcript.scrollTop = p.transcript.scrollHeight));
    if (docsView && docsView.project !== p.dir) closeDocs();
  } else {
    prompt.value = '';
    closeDocs();
  }
  closeMenu(false);
  renderAll();
  if (p) prompt.focus();
}

// ---------- events ----------

let pendingOpen: string | null = null;
// The project to show once everything has reopened, read once at start-up.
let restoreActive: string | null = null;

function onEvent(e: SidecarEvent): void {
  switch (e.type) {
    case 'ready':
      return;
    case 'providers':
      providerList = e.list;
      renderComposer();
      renderSession();
      return;
    case 'probe':
      return onProbe(e.requestId, e.ok, e.models, e.error);
    case 'createProgress':
    case 'projectCreated':
      return onCreateEvent(e);
    case 'editors':
      editorList = e.list;
      return;
    case 'mcpServers':
      return onMcpServers(e);
    case 'auth':
    case 'loginUrl':
    case 'loginLine':
    case 'loginDone':
      return onLoginEvent(e);
    case 'globalNotice':
      if (active) notice(active, e.level, e.text);
      else console.warn(e.text);
      if ($<HTMLDialogElement>('provider-dialog').open) $('probe-status').textContent = e.text;
      return;
  }

  if (e.type === 'project') {
    let p = projects.get(e.project);
    if (!p) {
      p = newProject(e.project, e.name);
      projects.set(e.project, p);
      saveOpenProjects();
    } else {
      // A replay (window reloaded): rebuild the transcript from scratch.
      p.liveText.clear();
      p.toolCards.clear();
      p.permissionCards.clear();
      p.pending.clear();
    }
    p.framework = e.framework;
    p.mode = e.permissionMode;
    p.providerId = e.providerId;
    p.replaying = true;
    emptyTranscript(p);
    if (!active || restoreActive === p.dir || pendingOpen === p.dir) {
      if (restoreActive === p.dir) restoreActive = null;
      if (pendingOpen === p.dir) pendingOpen = null;
      activate(p);
    } else renderProjects();
    return;
  }

  const p = projects.get(e.project);
  if (!p) return;
  const isActive = p === active;
  const markUnseen = () => {
    if (!isActive && !p.replaying) p.unseen = true;
  };

  switch (e.type) {
    case 'replayDone':
      p.replaying = false;
      p.transcript.scrollTop = p.transcript.scrollHeight;
      break;
    case 'closed':
      p.transcript.remove();
      projects.delete(e.project);
      saveOpenProjects();
      if (docsView?.project === e.project) closeDocs();
      if (isActive) activate([...projects.values()][0]);
      else renderProjects();
      return;
    case 'session':
      p.session = e.info;
      break;
    case 'mode':
      p.mode = e.mode;
      if (isActive) renderComposer();
      break;
    case 'provider':
      p.providerId = e.providerId;
      p.session = undefined;
      p.lastTurn = undefined;
      if (isActive) {
        renderComposer();
        renderSession();
      }
      break;
    case 'busy': {
      const finished = p.busy && !e.busy;
      if (finished) markUnseen();
      p.busy = e.busy;
      p.status = e.status;
      if (finished && !p.replaying) startQueued(p);
      break;
    }
    case 'user':
      userMessage(p, e.text, e.action);
      scrollToEnd(p);
      p.freshTurn = true;
      break;
    case 'assistantDelta':
      return assistantDelta(p, e.msgId, e.index, e.text);
    case 'assistantText':
      assistantFinal(p, e.msgId, e.text, e.parent);
      if (e.parent) return;
      noteReply(p, e.msgId, e.text);
      if (isActive) renderQuestions();
      return;
    case 'askQuestions':
      askQuestions(p, e.id, e.questions);
      break;
    case 'thinking':
      return;
    case 'toolUse':
      return toolUse(p, e.id, e.name, e.input, e.parent);
    case 'toolResult':
      return toolResult(p, e.toolUseId, e.isError, e.preview);
    case 'permissionRequest':
      permissionRequest(p, e.id, e.toolName, e.input, e.reason);
      break;
    case 'permissionResolved':
      if (p.asked.delete(e.id) && isActive) {
        if (docsView?.question === `ask:${e.id}`) afterAnswer(p);
        else renderQuestions();
      }
      return markAnswered(p, e.id, 'Cancelled');
    case 'turnEnd':
      p.lastTurn = e;
      if (e.isError) notice(p, 'error', e.errors?.length ? e.errors.join('\n') : 'The turn ended with an error.');
      break;
    case 'processes':
      p.processes = e.list;
      break;
    case 'tasks':
      p.tasks = e.files;
      p.docs = new Set(e.docs);
      p.docQuestions = e.questions ?? [];
      refreshDocs(p);
      break;
    case 'priorities':
      p.priorities = e.order;
      break;
    case 'docs':
      if (docsView && docsView.project === p.dir && docsView.requestId === e.requestId) {
        docsView.docs = e.docs;
        renderDocs();
      }
      return;
    case 'notice':
      notice(p, e.level, e.text);
      break;
  }

  renderProjects();
  if (!isActive) return;
  switch (e.type) {
    case 'session':
    case 'turnEnd':
      return renderSession();
    case 'busy':
      renderPriorities(p);
      return renderComposer();
    case 'processes':
      return renderProcesses();
    case 'askQuestions':
      // Claude waits on the answer, so the question opens straight away unless you're mid-way through something else.
      if (!p.replaying && (!docsView || docsView.question)) openQuestion(p, `ask:${e.id}`);
      else renderQuestions();
      return renderComposer();
    case 'tasks':
    case 'priorities':
      renderTasks();
      renderQuestions();
      renderHeader();
      if (docsView) renderDocs();
      return;
  }
}

// ---------- model providers ----------

const PRESET: Record<string, { baseUrl: string; authToken: string }> = {
  ollama: { baseUrl: 'http://localhost:11434', authToken: 'ollama' },
  llamacpp: { baseUrl: 'http://127.0.0.1:8080', authToken: 'local' },
  custom: { baseUrl: 'http://127.0.0.1:4000', authToken: '' },
};
let editing: ProviderConfig | undefined;
let probeId = '';

function providerForm(): HTMLFormElement {
  return $<HTMLFormElement>('provider-form');
}

function field(name: string): HTMLInputElement {
  return providerForm().elements.namedItem(name) as HTMLInputElement;
}

function openProviderDialog(existing?: ProviderConfig): void {
  editing = existing;
  const form = providerForm();
  form.reset();
  const kind = existing?.kind && existing.kind !== 'subscription' ? existing.kind : 'ollama';
  (form.querySelector(`input[name=kind][value=${kind}]`) as HTMLInputElement).checked = true;
  field('baseUrl').value = existing?.baseUrl ?? PRESET[kind].baseUrl;
  field('authToken').value = existing?.authToken ?? PRESET[kind].authToken;
  field('model').value = existing?.model ?? '';
  field('smallModel').value = existing?.smallModel ?? '';
  field('name').value = existing?.name ?? '';
  $('provider-dialog-title').textContent = existing ? `Edit ${existing.name}` : 'Use a local model';
  $('provider-delete').hidden = !existing;
  $('provider-save').textContent = existing ? 'Save' : 'Save and use';
  $('probe-status').textContent = '';
  $('provider-models').replaceChildren();
  $<HTMLDialogElement>('provider-dialog').showModal();
  probe();
}

function probe(): void {
  probeId = Math.random().toString(36).slice(2);
  $('probe-status').textContent = 'Looking for models…';
  send({ type: 'probeProvider', requestId: probeId, baseUrl: field('baseUrl').value, authToken: field('authToken').value || undefined });
}

function onProbe(requestId: string, ok: boolean, models: string[], error?: string): void {
  if (requestId !== probeId) return;
  $('provider-models').replaceChildren(...models.map((m) => h('option', { value: m })));
  if (!ok) $('probe-status').textContent = `${error ?? 'No answer.'} Check the server is running, or type the model name.`;
  else if (!models.length) $('probe-status').textContent = 'The server answered but listed no models. Pull or load one, or type its name.';
  else {
    $('probe-status').textContent = `Found ${models.length} model${models.length === 1 ? '' : 's'}: ${models.slice(0, 6).join(', ')}${models.length > 6 ? '…' : ''}`;
    if (!field('model').value) field('model').value = models[0];
  }
}

function wireProviderDialog(): void {
  const dialog = $<HTMLDialogElement>('provider-dialog');
  const form = providerForm();
  form.querySelectorAll<HTMLInputElement>('input[name=kind]').forEach((r) =>
    r.addEventListener('change', () => {
      const preset = PRESET[r.value];
      const known = Object.values(PRESET).map((x) => x.baseUrl);
      if (!field('baseUrl').value || known.includes(field('baseUrl').value)) field('baseUrl').value = preset.baseUrl;
      if (!field('authToken').value || Object.values(PRESET).some((x) => x.authToken === field('authToken').value)) field('authToken').value = preset.authToken;
      probe();
    }),
  );
  field('baseUrl').addEventListener('change', probe);
  $('probe').addEventListener('click', probe);
  $('provider-cancel').addEventListener('click', () => dialog.close());
  $('provider-delete').addEventListener('click', () => {
    if (editing && confirm(`Delete ${editing.name}? Projects using it go back to your Claude subscription.`)) {
      send({ type: 'deleteProvider', id: editing.id });
      dialog.close();
    }
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!form.reportValidity()) return;
    const kind = (form.querySelector('input[name=kind]:checked') as HTMLInputElement).value as ProviderConfig['kind'];
    send({
      type: 'saveProvider',
      provider: {
        id: editing?.id ?? '',
        name: field('name').value,
        kind,
        baseUrl: field('baseUrl').value,
        authToken: field('authToken').value,
        model: field('model').value,
        smallModel: field('smallModel').value || undefined,
      },
      useFor: editing ? undefined : active?.dir,
    });
    dialog.close();
  });

  $('provider').addEventListener('change', (ev) => {
    const sel = ev.target as HTMLSelectElement;
    const p = active;
    if (!p) return;
    if (sel.value === p.providerId) return;
    const working = p.busy || p.processes.some((x) => x.status === 'running');
    if (working && !confirm(`Switching model restarts the agent in ${p.name} and stops what it's doing. Switch anyway?`)) {
      sel.value = p.providerId;
      return;
    }
    send({ type: 'setProvider', project: p.dir, providerId: sel.value });
  });
}

// ---------- wiring ----------

// ---------- new project ----------

let creating: string | undefined; // requestId of the project being created

const kebab = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '');

function newProjectDialog(): void {
  const dialog = $<HTMLDialogElement>('new-project-dialog');
  const form = $<HTMLFormElement>('new-project-form');
  form.reset();
  const parent = form.elements.namedItem('parent') as HTMLInputElement;
  parent.value = load('slop-factory:new-project-parent') ?? '';
  $('np-log').hidden = true;
  $('np-log').textContent = '';
  $('np-error').hidden = true;
  updateNewProject();
  dialog.showModal();
  (form.elements.namedItem('name') as HTMLInputElement).focus();
}

function updateNewProject(): void {
  const form = $<HTMLFormElement>('new-project-form');
  const value = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
  const git = (form.elements.namedItem('git') as HTMLInputElement).checked;
  $('np-remote-field').hidden = !git;
  const folder = kebab(value('name'));
  const parent = value('parent').replace(/[\\/]+$/, '');
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  $('np-target').textContent = folder && parent ? `Creates ${parent}${sep}${folder}` : '';
}

function wireNewProjectDialog(): void {
  const dialog = $<HTMLDialogElement>('new-project-dialog');
  const form = $<HTMLFormElement>('new-project-form');
  form.addEventListener('input', updateNewProject);
  $('np-cancel').addEventListener('click', () => dialog.close());
  $('np-browse').addEventListener('click', async () => {
    const picked = await bridge?.pickFolder();
    if (!picked) return;
    (form.elements.namedItem('parent') as HTMLInputElement).value = picked;
    updateNewProject();
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (creating || !form.reportValidity()) return;
    const value = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
    const git = (form.elements.namedItem('git') as HTMLInputElement).checked;
    creating = Math.random().toString(36).slice(2);
    store('slop-factory:new-project-parent', value('parent'));
    $('np-error').hidden = true;
    $('np-log').hidden = false;
    $('np-log').textContent = '';
    $<HTMLButtonElement>('np-create').disabled = true;
    $('np-create').textContent = 'Creating…';
    send({
      type: 'createProject',
      requestId: creating,
      request: {
        name: value('name'),
        parent: value('parent'),
        git,
        remote: git ? value('remote') || undefined : undefined,
        framework: (form.querySelector('input[name=framework]:checked') as HTMLInputElement).value as 'full' | 'basic' | 'none',
      },
    });
  });
}

function onCreateEvent(e: Extract<SidecarEvent, { type: 'createProgress' | 'projectCreated' }>): void {
  if (e.requestId !== creating) return;
  const log = $('np-log');
  if (e.type === 'createProgress') {
    log.textContent += `${e.line}\n`;
    log.scrollTop = log.scrollHeight;
    return;
  }
  creating = undefined;
  $<HTMLButtonElement>('np-create').disabled = false;
  $('np-create').textContent = 'Create project';
  if (!e.ok || !e.dir) {
    $('np-error').textContent = e.error ?? "Couldn't create the project.";
    $('np-error').hidden = false;
    return;
  }
  $<HTMLDialogElement>('new-project-dialog').close();
  void openProject(e.dir);
}

// ---------- settings ----------

type Theme = 'system' | 'light' | 'dark';

function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
applyTheme((load('slop-factory:theme') as Theme | null) ?? 'system');

let mcpList: McpEntry[] = [];
let mcpEditing: McpEntry | undefined;
let mcpChanged = false;
let mcpPending = false; // a save or removal is on its way

const SCOPE_LABEL: Record<McpScope, string> = { user: 'All my projects', project: 'This project, shared', local: 'This project, just me' };

function openSettings(): void {
  mcpChanged = false;
  closeMcpForm();
  renderSettings();
  send({ type: 'listMcp', project: active?.dir });
  $<HTMLDialogElement>('settings-dialog').showModal();
}

function mcpSummary(c: Record<string, unknown>): string {
  if (typeof c.url === 'string') return `${String(c.type ?? 'http').toUpperCase()} ${c.url}`;
  return [c.command, ...(Array.isArray(c.args) ? c.args : [])].map((x) => String(x)).join(' ');
}

function renderSettings(): void {
  const p = active;
  const theme = (load('slop-factory:theme') as Theme | null) ?? 'system';
  $('theme-picker').querySelectorAll<HTMLInputElement>('input').forEach((r) => (r.checked = r.value === theme));
  $('model-for').textContent = p ? `The model ${p.name} uses. Switching starts a new conversation there.` : 'Open a project to choose its model.';
  $('local-models').replaceChildren(
    ...providerList
      .filter((x) => x.kind !== 'subscription')
      .map((x) =>
        h(
          'li',
          {},
          h('span', { class: 'settings-item-main' }, h('strong', {}, x.name), h('span', { class: 'muted' }, `${x.model} at ${x.baseUrl}`)),
          h('button', { class: 'button quiet', type: 'button', onclick: () => openProviderDialog(x) }, 'Edit'),
        ),
      ),
  );
  $('mcp-restart').hidden = !(p && mcpChanged);
  const scopes: McpScope[] = p ? ['user', 'project', 'local'] : ['user'];
  const groups = scopes
    .map((scope) => ({ scope, list: mcpList.filter((m) => m.scope === scope) }))
    .filter((g) => g.list.length)
    .map((g) =>
      h(
        'div',
        { class: 'mcp-group' },
        h('h4', {}, SCOPE_LABEL[g.scope]),
        h(
          'ul',
          { class: 'settings-list' },
          ...g.list.map((m) =>
            h(
              'li',
              {},
              h('span', { class: 'settings-item-main' }, h('strong', {}, m.name), h('code', { class: 'muted' }, mcpSummary(m.config))),
              h('button', { class: 'button quiet', type: 'button', onclick: () => openMcpForm(m) }, 'Edit'),
              h(
                'button',
                {
                  class: 'button quiet danger',
                  type: 'button',
                  onclick: () => {
                    if (!confirm(`Remove the MCP server ${m.name}?`)) return;
                    mcpPending = true;
                    send({ type: 'removeMcp', project: p?.dir, name: m.name, scope: m.scope });
                  },
                },
                'Remove',
              ),
            ),
          ),
        ),
      ),
    );
  $('mcp-list').replaceChildren(...(groups.length ? groups : [h('p', { class: 'settings-note' }, p ? 'No MCP servers yet.' : 'No MCP servers for all projects yet. Open a project to see its own.')]));
}

const mcpForm = () => $<HTMLFormElement>('mcp-form');
const mcpField = (name: string) => mcpForm().elements.namedItem(name) as HTMLInputElement;

function updateMcpForm(): void {
  const transport = (mcpForm().querySelector('input[name=transport]:checked') as HTMLInputElement).value;
  const stdio = transport === 'stdio';
  $('mcp-command-field').hidden = !stdio;
  $('mcp-url-field').hidden = stdio;
  mcpField('command').required = stdio;
  mcpField('url').required = !stdio;
  $('mcp-pairs-label').replaceChildren(stdio ? 'Environment variables ' : 'Headers ', h('small', {}, stdio ? '(one KEY=value per line)' : '(one Name: value per line)'));
}

const quoteArg = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(a) : a);

function openMcpForm(existing?: McpEntry): void {
  mcpEditing = existing;
  const form = mcpForm();
  form.reset();
  $('mcp-error').hidden = true;
  (form.elements.namedItem('scope') as HTMLSelectElement).querySelectorAll('option').forEach((o) => (o.disabled = !active && o.value !== 'user'));
  if (existing) {
    const c = existing.config;
    mcpField('name').value = existing.name;
    (form.elements.namedItem('scope') as HTMLSelectElement).value = existing.scope;
    const transport = typeof c.url === 'string' ? String(c.type ?? 'http') : 'stdio';
    form.querySelectorAll<HTMLInputElement>('input[name=transport]').forEach((r) => (r.checked = r.value === transport));
    if (transport === 'stdio') mcpField('command').value = [String(c.command ?? ''), ...(Array.isArray(c.args) ? c.args.map(String) : [])].map(quoteArg).join(' ');
    else mcpField('url').value = String(c.url);
    const pairs = (transport === 'stdio' ? c.env : c.headers) as Record<string, string> | undefined;
    (form.elements.namedItem('pairs') as HTMLTextAreaElement).value = Object.entries(pairs ?? {})
      .map(([k, v]) => (transport === 'stdio' ? `${k}=${v}` : `${k}: ${v}`))
      .join('\n');
  } else (form.elements.namedItem('scope') as HTMLSelectElement).value = active ? 'local' : 'user';
  updateMcpForm();
  form.hidden = false;
  $('mcp-add').hidden = true;
  mcpField('name').focus();
}

function closeMcpForm(): void {
  mcpEditing = undefined;
  mcpForm().hidden = true;
  $('mcp-add').hidden = false;
}

function splitCommand(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]));
}

function wireSettings(): void {
  const dialog = $<HTMLDialogElement>('settings-dialog');
  $('open-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => dialog.close());
  $('theme-picker').addEventListener('change', (ev) => {
    const theme = (ev.target as HTMLInputElement).value as Theme;
    store('slop-factory:theme', theme === 'system' ? null : theme);
    applyTheme(theme);
  });
  $('add-local-model').addEventListener('click', () => openProviderDialog());
  $('mcp-add').addEventListener('click', () => openMcpForm());
  $('mcp-cancel').addEventListener('click', closeMcpForm);
  $('mcp-restart').addEventListener('click', () => {
    if (!active) return;
    send({ type: 'restartSession', project: active.dir });
    mcpChanged = false;
    renderSettings();
  });
  mcpForm().addEventListener('change', updateMcpForm);
  mcpForm().addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = mcpForm();
    if (!form.reportValidity()) return;
    const transport = (form.querySelector('input[name=transport]:checked') as HTMLInputElement).value;
    const pairs: Record<string, string> = {};
    for (const line of (form.elements.namedItem('pairs') as HTMLTextAreaElement).value.split('\n')) {
      const at = transport === 'stdio' ? line.indexOf('=') : line.search(/[:=]/);
      if (at > 0) pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const has = Object.keys(pairs).length > 0;
    let config: Record<string, unknown>;
    if (transport === 'stdio') {
      const [command, ...args] = splitCommand(mcpField('command').value.trim());
      config = { type: 'stdio', command, args, ...(has ? { env: pairs } : {}) };
    } else config = { type: transport, url: mcpField('url').value.trim(), ...(has ? { headers: pairs } : {}) };
    mcpPending = true;
    send({
      type: 'saveMcp',
      project: active?.dir,
      server: { name: mcpField('name').value.trim(), scope: (form.elements.namedItem('scope') as HTMLSelectElement).value as McpScope, config },
      previous: mcpEditing ? { name: mcpEditing.name, scope: mcpEditing.scope } : undefined,
    });
  });
}

function onMcpServers(e: Extract<SidecarEvent, { type: 'mcpServers' }>): void {
  if ((e.project ?? undefined) !== active?.dir) return;
  mcpList = e.list;
  if (mcpPending) {
    mcpPending = false;
    if (e.error) {
      $('mcp-error').textContent = e.error;
      $('mcp-error').hidden = false;
    } else {
      mcpChanged = true;
      closeMcpForm();
    }
  }
  renderSettings();
}

// ---------- sign in ----------

let loginUrl = '';
let loginSkipped = false; // chose a local model instead, for this run

function showLogin(state: AuthState): void {
  const dialog = $<HTMLDialogElement>('login-dialog');
  if (state.loggedIn || loginSkipped) {
    if (dialog.open) dialog.close();
    return;
  }
  if (state.error) {
    $('login-error').textContent = state.error;
    $('login-error').hidden = false;
  }
  if (!dialog.open) {
    $('login-start').hidden = false;
    $('login-waiting').hidden = true;
    dialog.showModal();
  }
}

function wireLoginDialog(): void {
  const dialog = $<HTMLDialogElement>('login-dialog');
  // Signing in (or choosing a local model) is the way out.
  dialog.addEventListener('cancel', (ev) => ev.preventDefault());
  const start = (consoleAccount: boolean) => {
    loginUrl = '';
    $('login-error').hidden = true;
    $('login-start').hidden = true;
    $('login-waiting').hidden = false;
    $('login-url').hidden = true;
    send({ type: 'login', console: consoleAccount });
    $('login-code').focus();
  };
  $('login-go').addEventListener('click', () => start(false));
  $('login-console').addEventListener('click', () => start(true));
  $('login-url').addEventListener('click', () => loginUrl && send({ type: 'openUrl', url: loginUrl }));
  $('login-code-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const code = $<HTMLInputElement>('login-code').value.trim();
    if (code) send({ type: 'loginCode', code });
  });
  $('login-recheck').addEventListener('click', () => send({ type: 'checkAuth' }));
  $('login-local').addEventListener('click', () => {
    loginSkipped = true;
    send({ type: 'cancelLogin' });
    dialog.close();
    openProviderDialog();
  });
}

function onLoginEvent(e: Extract<SidecarEvent, { type: 'auth' | 'loginUrl' | 'loginLine' | 'loginDone' }>): void {
  switch (e.type) {
    case 'auth':
      return showLogin(e.state);
    case 'loginUrl':
      loginUrl = e.url;
      $('login-url').hidden = false;
      return;
    case 'loginLine':
      return;
    case 'loginDone':
      if (!e.ok) {
        $('login-start').hidden = false;
        $('login-waiting').hidden = true;
        $('login-error').textContent = e.error ? `Sign-in didn't finish: ${e.error}` : "Sign-in didn't finish.";
        $('login-error').hidden = false;
      }
      return;
  }
}

function addProjectMenu(): MenuItem[] {
  return [
    { label: 'New project…', run: newProjectDialog },
    { label: 'Open a folder…', run: () => void openProject() },
  ];
}

async function openProject(dir?: string | null): Promise<void> {
  const picked = dir ?? (await bridge?.pickFolder());
  if (!picked) return;
  const clean = picked.replace(/[\\/]+$/, '');
  const known = projects.get(clean);
  if (known) return activate(known);
  pendingOpen = clean;
  send({ type: 'open', projectDir: clean });
}

function submit(): void {
  const prompt = $<HTMLTextAreaElement>('prompt');
  const text = prompt.value.trim();
  if (!text || !active) return;
  send({ type: 'send', project: active.dir, text });
  prompt.value = '';
  active.draft = '';
  renderComposer();
}

async function init(): Promise<void> {
  document.querySelectorAll('.app-version').forEach((el) => (el.textContent = `v${__APP_VERSION__}`));
  renderAll();
  bridge = await createBridge();
  bridge.onEvent(onEvent);
  send({ type: 'listEditors' });
  send({ type: 'checkAuth' });

  $('add-project').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const b = $('add-project');
    if (menuAnchor === b) return closeMenu();
    openMenu(b, addProjectMenu());
  });
  wireNewProjectDialog();
  wireLoginDialog();
  wireSettings();
  $('composer').addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });
  $('prompt').addEventListener('input', renderComposer);
  $('prompt').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      submit();
    }
  });
  $('stop').addEventListener('click', () => {
    if (!active) return;
    // Stopping Claude also pauses the queue, so the next item doesn't start in its place.
    active.holdQueue = true;
    send({ type: 'interrupt', project: active.dir });
  });
  $('permission-mode').addEventListener('change', (ev) => {
    if (!active) return;
    active.mode = (ev.target as HTMLSelectElement).value as PermissionModeName;
    send({ type: 'setPermissionMode', project: active.dir, mode: active.mode });
  });
  $('docs-close').addEventListener('click', closeDocs);
  $('project-menu').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const b = $('project-menu');
    if (menuAnchor === b) return closeMenu();
    if (active) openMenu(b, projectMenu(active));
  });
  wireProviderDialog();

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('docs-panel').hidden && menuEl.hidden) closeDocs();
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && /^[1-9]$/.test(ev.key)) {
      const p = [...projects.values()][Number(ev.key) - 1];
      if (p) {
        ev.preventDefault();
        activate(p);
      }
    }
    if (mod && ev.key.toLowerCase() === 'o') {
      ev.preventDefault();
      void openProject();
    }
  });

  // Reopen what was open last time. Projects still running in the sidecar replay their state.
  const fromUrl = new URLSearchParams(location.search).getAll('project');
  let saved: string[] = [];
  try {
    saved = JSON.parse(load('slop-factory:projects') ?? '[]');
  } catch {
    saved = [];
  }
  restoreActive = fromUrl.length ? fromUrl[fromUrl.length - 1] : load('slop-factory:active');
  for (const dir of new Set([...saved, ...fromUrl])) send({ type: 'open', projectDir: dir });
}

void init();

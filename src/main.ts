import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/source-serif-4';
import './styles.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { createBridge, type Bridge } from './bridge';
import type {
  ActionItem,
  BugEntry,
  DocContent,
  FrameworkInfo,
  ItemAction,
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
  draft: string;
  unseen: boolean;
  replaying: boolean;
}

const projects = new Map<string, Proj>();
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
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
const saveOpenProjects = () => store('claude-desk:projects', JSON.stringify([...projects.keys()]));

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
    draft: '',
    unseen: false,
    replaying: false,
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

function allItems(p: Proj): Map<string, BoardItem> {
  const map = new Map<string, BoardItem>();
  for (const f of p.tasks) {
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
    h('div', { class: 'empty' }, h('p', {}, `Claude has ${p.name}'s rules loaded. Ask for something, or use the ⋯ menu on a task to start it.`)),
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
    { class: 'permission', role: 'group', 'aria-label': `Claude wants to use ${toolName}` },
    h('p', { class: 'permission-title' }, `Claude wants to use ${toolName}`),
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

const ACTION_LABEL: Record<ItemAction, string> = { start: 'Start', reinvestigate: 'Reinvestigate', summarise: 'Summarise' };

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

// ---------- menus ----------

const menuEl = $('menu');
let menuAnchor: HTMLElement | null = null;

interface MenuItem {
  label: string;
  run: () => void;
}

function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenu(false);
  menuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  menuEl.replaceChildren(
    ...items.map((it) =>
      h(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          role: 'menuitem',
          onclick: () => {
            closeMenu();
            it.run();
          },
        },
        it.label,
      ),
    ),
  );
  menuEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth;
  const mh = menuEl.offsetHeight;
  menuEl.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left))}px`;
  menuEl.style.top = `${r.bottom + mh + 8 > window.innerHeight ? r.top - mh - 4 : r.bottom + 4}px`;
  menuEl.querySelector<HTMLButtonElement>('button')?.focus();
}

function closeMenu(refocus = true): void {
  if (menuEl.hidden) return;
  menuEl.hidden = true;
  menuAnchor?.setAttribute('aria-expanded', 'false');
  if (refocus && menuAnchor?.isConnected) menuAnchor.focus();
  menuAnchor = null;
}

menuEl.addEventListener('keydown', (ev) => {
  const items = [...menuEl.querySelectorAll<HTMLButtonElement>('.menu-item')];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (ev.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
  else if (ev.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
  else if (ev.key === 'Escape' || ev.key === 'Tab') closeMenu();
  else return;
  ev.preventDefault();
});
document.addEventListener('pointerdown', (ev) => {
  if (!menuEl.hidden && !menuEl.contains(ev.target as Node) && !menuAnchor?.contains(ev.target as Node)) closeMenu(false);
});

function itemMenu(p: Proj, item: BoardItem): MenuItem[] {
  const prioritised = p.priorities.includes(item.key);
  const items: MenuItem[] = [{ label: prioritised ? 'Remove priority' : 'Prioritise', run: () => send({ type: 'togglePriority', project: p.dir, key: item.key }) }];
  const progressLabel = item.legacy && !item.spec && !item.summary ? 'Show details' : 'Show progress';
  if (!item.done) {
    items.push({ label: item.kind === 'bug' ? 'Start fix with a subagent' : 'Start with a subagent', run: () => runAction(p, 'start', item) });
    items.push({ label: progressLabel, run: () => showProgress(p, item) });
  } else {
    items.push({ label: progressLabel, run: () => showProgress(p, item) });
    items.push({ label: 'Summarise work done', run: () => runAction(p, 'summarise', item) });
    items.push({ label: 'Reinvestigate with a subagent', run: () => runAction(p, 'reinvestigate', item) });
  }
  return items;
}

function runAction(p: Proj, action: ItemAction, item: BoardItem): void {
  send({ type: 'runAction', project: p.dir, action, item: toActionItem(item) });
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

let docsView: { project: string; key: string; requestId: string; tab: string; docs: DocContent[] } | undefined;

function docPaths(item: BoardItem): string[] {
  return [item.spec, item.summary, ...item.docLinks.map((l) => l.rel)].filter((x): x is string => !!x);
}

/** Older-format tasks carry their detail inline: show the entry itself. */
const docBlocks = (item: BoardItem) => (item.legacy && item.hasDetails ? [{ rel: item.rel, line: item.line }] : undefined);
const blockRel = (item: BoardItem) => `${item.rel}#L${item.line + 1}`;

function showProgress(p: Proj, item: BoardItem): void {
  const requestId = Math.random().toString(36).slice(2);
  // Finished work opens on its summary; anything else on its spec.
  const tab = (item.done ? item.summary : item.spec) ?? item.spec ?? item.summary ?? (docBlocks(item) ? blockRel(item) : '');
  docsView = { project: p.dir, key: item.key, requestId, tab, docs: [] };
  send({ type: 'readDocs', project: p.dir, requestId, key: item.key, paths: docPaths(item), blocks: docBlocks(item) });
  renderDocs();
  $('docs-panel').hidden = false;
  $('docs-close').focus();
}

function refreshDocs(p: Proj): void {
  if (!docsView || docsView.project !== p.dir) return;
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
  const item = p ? allItems(p).get(docsView.key) : undefined;
  $('docs-ref').textContent = item?.id ?? '';
  $('docs-title').textContent = item?.title ?? docsView.key;

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
  } else {
    const what = item?.kind === 'bug' ? 'bug' : 'task';
    const message = item?.legacy
      ? 'This task has no detail under it in the task file.'
      : item?.done
        ? `This ${what} has no spec or summary.`
        : `No spec yet. Claude writes one before starting work on this ${what}.`;
    body.replaceChildren(h('div', { class: 'docs-empty' }, h('p', {}, message)));
  }

  const actions = $('docs-actions');
  actions.replaceChildren();
  if (p && item) {
    if (!item.done) actions.append(h('button', { class: 'button primary', type: 'button', onclick: () => runAction(p, 'start', item) }, item.kind === 'bug' ? 'Start fix with a subagent' : 'Start with a subagent'));
    else {
      actions.append(h('button', { class: 'button', type: 'button', onclick: () => runAction(p, 'summarise', item) }, 'Summarise work done'));
      actions.append(h('button', { class: 'button', type: 'button', onclick: () => runAction(p, 'reinvestigate', item) }, 'Reinvestigate'));
    }
  }
}

function closeDocs(): void {
  docsView = undefined;
  $('docs-panel').hidden = true;
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
function waitHints(item: BoardItem, items: Map<string, BoardItem>): HTMLElement | null {
  if (item.done || item.state === 'cancelled') return null;
  const waiting = (item.dependsOn ?? []).filter((id) => {
    const dep = items.get(id);
    return dep && !dep.done && dep.state !== 'cancelled';
  });
  const parts: Child[] = [];
  if (waiting.length) parts.push(h('span', { class: 'waits' }, `waits on ${waiting.join(', ')}`));
  for (const r of item.blockedBy ?? []) parts.push(h('span', { class: 'blocked' }, `blocked: ${r}`));
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
    { class: `task ${t.state}${prioritised ? ' prioritised' : ''}`, style: `--depth:${t.depth}` },
    box,
    h(
      'span',
      { class: 'task-main' },
      t.id ? h('span', { class: 'item-id' }, t.id) : null,
      h('span', { class: 'task-text' }, item.title),
      prioritised ? flag() : null,
      docChips(p, item),
      waitHints(item, boardIndex),
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
    { class: `bug ${b.status.replace(/[^a-z]+/g, '-')}${prioritised ? ' prioritised' : ''}` },
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

function renderPriorities(p: Proj): void {
  const section = $('priorities-section');
  const items = allItems(p);
  const queued = p.priorities.map((k) => items.get(k)).filter((x): x is BoardItem => !!x);
  section.hidden = !queued.length;
  $('priorities-count').textContent = queued.length ? `${queued.filter((q) => !q.done).length} open` : '';
  $('priorities').replaceChildren(
    ...queued.map((it) =>
      h(
        'li',
        { class: `priority kind-${it.kind}${it.done ? ' done' : ''}${it.kind === 'bug' && !it.done ? ' open-bug' : ''}` },
        h('span', { class: 'item-id' }, it.id ?? '·'),
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

  const byDoc = new Map(phases.map((ph) => [ph.rel, ph]));
  const byNum = new Map(phases.map((ph) => [ph.phaseNumber ?? '', ph]));
  const rows = index?.phases ?? [];
  const currentRow = rows.find((r) => !['done', 'dropped'].includes(phaseStatusClass(r.status)));
  if (!p.userToggled && currentRow) p.expanded = new Set([currentRow.number]);

  const spine = h('ol', { class: 'spine' });
  const shown = new Set<string>();
  for (const row of rows) {
    const doc = (row.doc && byDoc.get(row.doc)) || byNum.get(row.number);
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
        h('span', { class: 'phase-goal' }, doc?.title.replace(/^Phase\s+\d+\s*[:\-–]\s*/i, '') || row.goal || `Phase ${row.number}`),
        h('span', { class: 'phase-status' }, row.status || 'planned', counted ? `, ${done} of ${counted}` : ''),
      ),
    );
    spine.append(
      h(
        'li',
        { class: `phase ${cls}${row === currentRow ? ' current' : ''}` },
        head,
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
  const sections: { name: string; items: TaskItem[] }[] = [];
  for (const it of file.items) {
    const name = it.section ?? 'Tasks';
    let sec = sections[sections.length - 1];
    if (!sec || sec.name !== name) sections.push((sec = { name, items: [] }));
    sec.items.push(it);
  }
  const statusOf = (items: TaskItem[]) => {
    const top = items.filter((i) => i.depth === 0 && i.state !== 'cancelled');
    if (top.length && top.every((i) => i.state === 'done')) return 'done';
    if (items.some((i) => i.state === 'done' || i.state === 'doing')) return 'in progress';
    return 'planned';
  };
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
        const working = p.busy || p.processes.some((x) => x.status === 'running');
        if (working && !confirm(`Claude is still working in ${p.name}. Close it and stop that work?`)) return;
        send({ type: 'close', project: p.dir });
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
          : `${claudeSkills} skills Claude can load on its own${agentSkills ? `, ${agentSkills} in .agents/skills` : ''}`,
      ]);
    }
    if (fw.hooks.length) rows.push(['Hooks', fw.hooks.join(', ')]);
    if (fw.agents.length) rows.push(['Agents', fw.agents.join(', ')]);
  }
  if (p) {
    const prov = providerOf(p);
    const local = prov.kind !== 'subscription';
    const edit = local ? h('button', { class: 'link-button', type: 'button', onclick: () => openProviderDialog(prov) }, 'Edit') : null;
    rows.push(['Provider', h('span', {}, local ? `${prov.name} at ${prov.baseUrl}` : prov.name, edit ? ' ' : null, edit)]);
    if (local) rows.push(['Billing', 'Local model, no Anthropic usage']);
  }
  if (s) {
    const login = loginLabel(s.apiKeySource);
    rows.push(['Model', s.model]);
    if (providerOf(p!).kind === 'subscription') rows.push(['Billing', h('span', { class: login.ok ? '' : 'warn-text' }, login.text)]);
    if (s.mcpServers.length) rows.push(['MCP', s.mcpServers.map((m) => `${m.name} (${m.status})`).join(', ')]);
  }
  if (p?.lastTurn) rows.push(['Last turn', `${(p.lastTurn.durationMs / 1000).toFixed(1)}s, ${p.lastTurn.outputTokens.toLocaleString()} tokens out`]);
  if (p && !s) rows.push(['', h('span', { class: 'muted' }, 'Claude Code starts with your first message.')]);
  dl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

function renderHeader(): void {
  const p = active;
  $('project-header').hidden = !p;
  if (!p) return void (document.title = 'Claude Desk');
  $('project-name').textContent = p.name;
  $('project-path').textContent = `‎${p.dir}‎`;
  $('project-path').title = p.dir;
  const fw = p.framework;
  $('framework-badge').textContent = fw?.agentsMd ? (fw.agentsSkills.length ? `AGENTS.md with ${fw.agentsSkills.length} standards` : 'AGENTS.md') : '';
  document.title = `${p.name} – Claude Desk`;
}

// Claude Code's working indicator cycles through these glyphs.
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
let spinnerTimer: number | undefined;

function renderComposer(): void {
  const p = active;
  const prompt = $<HTMLTextAreaElement>('prompt');
  const hasText = prompt.value.trim().length > 0;
  prompt.disabled = !p;
  prompt.placeholder = p ? `Message Claude about ${p.name}` : 'Open a project to start';
  const mode = $<HTMLSelectElement>('permission-mode');
  mode.disabled = !p;
  if (p) mode.value = p.mode;
  const prov = $<HTMLSelectElement>('provider');
  prov.disabled = !p;
  prov.replaceChildren(
    ...providerList.map((x) => h('option', { value: x.id }, x.kind === 'subscription' ? x.name : x.name)),
    h('option', { value: '__add' }, 'Use a local model…'),
  );
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
        h('p', {}, 'Open a project folder to start. Claude picks up its AGENTS.md, skills and settings, and its task.md shows up on the left.'),
        h('button', { class: 'button primary', type: 'button', onclick: () => void openProject() }, 'Open a project'),
      ),
    );
  }
}

function renderAll(): void {
  renderProjects();
  renderHeader();
  renderTasks();
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
    store('claude-desk:active', p.dir);
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
    case 'provider':
      p.providerId = e.providerId;
      p.session = undefined;
      p.lastTurn = undefined;
      if (isActive) {
        renderComposer();
        renderSession();
      }
      break;
    case 'busy':
      if (p.busy && !e.busy) markUnseen();
      p.busy = e.busy;
      p.status = e.status;
      break;
    case 'user':
      userMessage(p, e.text, e.action);
      break;
    case 'assistantDelta':
      return assistantDelta(p, e.msgId, e.index, e.text);
    case 'assistantText':
      return assistantFinal(p, e.msgId, e.text, e.parent);
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
      return renderComposer();
    case 'processes':
      return renderProcesses();
    case 'tasks':
    case 'priorities':
      renderTasks();
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
    if (sel.value === '__add') {
      sel.value = p.providerId;
      return openProviderDialog();
    }
    if (sel.value === p.providerId) return;
    const working = p.busy || p.processes.some((x) => x.status === 'running');
    if (working && !confirm(`Switching model restarts Claude Code in ${p.name} and stops what it's doing. Switch anyway?`)) {
      sel.value = p.providerId;
      return;
    }
    send({ type: 'setProvider', project: p.dir, providerId: sel.value });
  });
}

// ---------- wiring ----------

async function openProject(dir?: string | null): Promise<void> {
  const picked = dir ?? (await bridge?.pickFolder());
  if (!picked) return;
  const clean = picked.replace(/[\\/]+$/, '');
  const known = projects.get(clean);
  if (known) return activate(known);
  pendingOpen = clean;
  send({ type: 'open', projectDir: clean, permissionMode: 'default' });
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
  renderAll();
  bridge = await createBridge();
  bridge.onEvent(onEvent);

  $('add-project').addEventListener('click', () => void openProject());
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
  $('stop').addEventListener('click', () => active && send({ type: 'interrupt', project: active.dir }));
  $('permission-mode').addEventListener('change', (ev) => {
    if (!active) return;
    active.mode = (ev.target as HTMLSelectElement).value as PermissionModeName;
    send({ type: 'setPermissionMode', project: active.dir, mode: active.mode });
  });
  $('docs-close').addEventListener('click', closeDocs);
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
    saved = JSON.parse(load('claude-desk:projects') ?? '[]');
  } catch {
    saved = [];
  }
  restoreActive = fromUrl.length ? fromUrl[fromUrl.length - 1] : load('claude-desk:active');
  for (const dir of new Set([...saved, ...fromUrl])) send({ type: 'open', projectDir: dir, permissionMode: 'default' });
}

void init();

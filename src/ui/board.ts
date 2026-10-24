import type { BugEntry, OpenQuestion, TaskFile, TaskItem } from '../../sidecar/src/protocol';
import { BoardItem, PHASE_PREFIX, allItems, bugItem, itemRef, legacySections, legacyStatus, phaseDocFor, taskItem } from './board-model';
import { blockRel, docBlocks, showProgress } from './docs';
import { $, Child, ICON_CLOSE, ICON_FLAG, h, svgIcon } from './dom';
import { runAction } from './menus';
import { openQuestion, where } from './questions';
import { isFree, laneOf, moreButton, nextQueued, startSubagentQueued } from './queue';
import { Proj, active, send } from './state';

// ---------- board ----------

export function phaseStatusClass(status: string): string {
  if (status.startsWith('done')) return 'done';
  if (status.startsWith('in progress')) return 'doing';
  if (status.startsWith('dropped')) return 'dropped';
  return 'planned';
}

export function trackedItems(file?: TaskFile): TaskItem[] {
  if (!file) return [];
  const inTasks = file.items.filter((i) => i.section?.toLowerCase() === 'tasks');
  return inTasks.length ? inTasks : file.items;
}

export function segmentBar(items: TaskItem[]): HTMLElement {
  const done = items.filter((i) => i.state === 'done').length;
  const total = items.filter((i) => i.state !== 'cancelled').length;
  const label = `${done} of ${total} tasks done`;
  if (items.length > 40 || !items.length) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return h('div', { class: 'bar continuous', role: 'img', 'aria-label': label }, h('span', { style: `width:${pct}%` }));
  }
  return h('div', { class: 'bar', role: 'img', 'aria-label': label }, ...items.map((i) => h('span', { class: `seg ${i.state}` })));
}

export function docChips(p: Proj, item: BoardItem): HTMLElement | null {
  const chips: HTMLElement[] = [];
  const add = (rel: string | undefined, label: string) => {
    if (rel && p.docs.has(rel)) chips.push(h('button', { class: 'chip', type: 'button', onclick: () => showProgress(p, item), title: rel }, label));
  };
  add(item.spec, 'spec');
  add(item.summary, 'summary');
  return chips.length ? h('span', { class: 'chips' }, ...chips) : null;
}

export function flag(): HTMLElement {
  const f = h('span', { class: 'flag', title: 'Prioritised' });
  f.append(svgIcon(ICON_FLAG));
  return f;
}

/** "waits on TASK-094" for unfinished dependencies, and Blocked by reasons, on open tasks. */
// ---------- what blocks a task ----------

export const ID_IN_TEXT = /\b(?:TASK-\d+(?:\.\d+)*|[TB]\d+)\b/g;
export const QUIET_WORDS = new Set(
  'waiting wait until which what should would could there their about need needs with from that this have will when where blocked block question questions decide decided decision answer open user owner the and for are not yet any'.split(' '),
);
export const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !QUIET_WORDS.has(w)));

/** The open question a "Blocked by" reason is about: the one sharing most words with it, its own document first. */
export function questionFor(p: Proj, item: BoardItem, reason: string): OpenQuestion | undefined {
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
export function revealItem(p: Proj, key: string): void {
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

export function hintLink(label: string, title: string, run: () => void, cls: string): HTMLElement {
  return h('button', { class: `hint-link ${cls}`, type: 'button', title, onclick: run }, label);
}

/** "waits on T4" for unfinished dependencies and each Blocked by reason, each one a link to what blocks it. */
export function waitHints(p: Proj, item: BoardItem, items: Map<string, BoardItem>): HTMLElement | null {
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

export let boardIndex = new Map<string, BoardItem>();

export function taskRow(p: Proj, file: TaskFile, t: TaskItem): HTMLElement {
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

export const taskList = (p: Proj, file: TaskFile, items: TaskItem[]) => h('ul', { class: 'task-list' }, ...items.map((i) => taskRow(p, file, i)));

export function bugRow(p: Proj, file: TaskFile, b: BugEntry): HTMLElement {
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
export function phaseTop(p: Proj, item: BoardItem | undefined, head: HTMLElement): HTMLElement {
  if (!item) return head;
  if (p.priorities.includes(item.key)) head.querySelector('.phase-goal')?.append(flag());
  return h('div', { class: 'phase-top' }, head, moreButton(p, item));
}

export function dequeueButton(p: Proj, it: BoardItem): HTMLButtonElement {
  const b = h('button', { class: 'more dequeue', type: 'button', title: 'Remove from the queue', 'aria-label': `Remove ${itemRef(it) || it.title} from the queue` }) as HTMLButtonElement;
  b.append(svgIcon(ICON_CLOSE));
  b.addEventListener('click', () => send({ type: 'togglePriority', project: p.dir, key: it.key }));
  return b;
}

export function renderPriorities(p: Proj): void {
  const section = $('priorities-section');
  const items = allItems(p);
  const queued = p.priorities.map((k) => items.get(k)).filter((x): x is BoardItem => !!x);
  section.hidden = !queued.length;
  const open = queued.filter((q) => !q.done).length;
  const next = isFree(p) ? nextQueued(p) : undefined;
  // The subagent lane stalls after Stop or a reload; Start next picks it up too.
  const nextSub = p.laneRun ? undefined : nextQueued(p, undefined, 'subagent');
  $('priorities-count').replaceChildren(
    open ? `${open} queued` : '',
    next || nextSub
      ? h(
          'button',
          {
            class: 'link-button',
            type: 'button',
            title: 'Start the next queued item now',
            onclick: () => {
              p.holdQueue = false;
              if (next) runAction(p, 'start', next);
              startSubagentQueued(p);
              renderPriorities(p);
            },
          },
          'Start next',
        )
      : '',
  );
  $('priorities').replaceChildren(
    ...queued.map((it) =>
      h(
        'li',
        { class: `priority kind-${it.kind}${it.done ? ' done' : ''}${it.kind === 'bug' && !it.done ? ' open-bug' : ''}` },
        h('span', { class: 'item-id' }, itemRef(it) || '·'),
        h('button', { class: 'priority-title', type: 'button', onclick: () => showProgress(p, it), title: 'Show progress' }, it.title),
        h(
          'span',
          { class: 'priority-state' },
          p.laneRun?.key === it.key ? 'starting' : it.kind === 'bug' ? it.status : it.state === 'doing' ? 'in progress' : it.done ? 'done' : '',
          laneOf(p, it.key) === 'subagent' ? h('span', { class: 'lane-tag', title: 'Starts in a background subagent with its own worktree' }, 'subagent') : null,
        ),
        dequeueButton(p, it),
        moreButton(p, it),
      ),
    ),
  );
}

export function renderTasks(): void {
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
export function renderLegacy(p: Proj, file: TaskFile, files: TaskFile[]): void {
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

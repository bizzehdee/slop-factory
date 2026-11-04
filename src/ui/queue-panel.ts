import type { TaskStart } from '../../sidecar/src/protocol';
import { BoardItem, allItems, itemRef } from './board-model';
import { showProgress } from './docs';
import { $, Child, ICON_CLOSE, h, svgIcon } from './dom';
import { defaultTaskStart, laneOf, moreButton, pump, setQueueRunning, waitingOn, waitsForBackground } from './queue';
import { renderSettings } from './settings';
import { Proj, active, send } from './state';

// ---------- the queue panel, at the top of the right sidebar ----------

const START_WORDS: Record<TaskStart, string> = {
  current: 'the conversation as it is',
  compact: 'the conversation, compacted first',
  new: 'a new conversation',
};

/** Set where this project's tasks start, from the queue panel or Settings. null: the default. */
export function setTaskStart(p: Proj, mode: TaskStart | null): void {
  p.taskStart = mode;
  send({ type: 'setProjectTaskStart', project: p.dir, mode });
  if ($<HTMLDialogElement>('settings-dialog').open) renderSettings();
  renderQueue(p);
  pump(p);
}

// Rows can be dragged into a new order, or moved with Alt+Up and Alt+Down.
let dragKey: string | undefined;

function moveTo(p: Proj, order: string[], key: string, before: string | undefined): void {
  const rest = order.filter((k) => k !== key);
  const at = before ? rest.indexOf(before) : rest.length;
  rest.splice(at < 0 ? rest.length : at, 0, key);
  if (rest.join('\n') !== order.join('\n')) send({ type: 'reorderQueue', project: p.dir, order: rest });
}

function draggableRow(p: Proj, key: string, order: string[], props: Record<string, unknown>, ...children: Child[]): HTMLElement {
  const li = h('li', { ...props, draggable: 'true', tabindex: 0, dataset: { key }, title: 'Drag to change the order (or Alt+Up / Alt+Down)' }, ...children);
  li.addEventListener('dragstart', (ev) => {
    dragKey = key;
    li.classList.add('dragging');
    ev.dataTransfer?.setData('text/plain', key);
  });
  li.addEventListener('dragend', () => {
    dragKey = undefined;
    li.classList.remove('dragging');
    document.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
  });
  li.addEventListener('dragover', (ev) => {
    if (!dragKey || dragKey === key) return;
    ev.preventDefault();
    li.classList.add('drop-before');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-before'));
  li.addEventListener('drop', (ev) => {
    ev.preventDefault();
    li.classList.remove('drop-before');
    if (dragKey && dragKey !== key) moveTo(p, order, dragKey, key);
  });
  li.addEventListener('keydown', (ev) => {
    if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
    ev.preventDefault();
    const i = order.indexOf(key);
    const before = ev.key === 'ArrowUp' ? order[i - 1] : order[i + 2];
    if (ev.key === 'ArrowUp' && i === 0) return;
    moveTo(p, order, key, before);
  });
  return li;
}

function dequeueButton(p: Proj, it: BoardItem): HTMLButtonElement {
  const b = h('button', { class: 'more dequeue', type: 'button', title: 'Remove from the queue', 'aria-label': `Remove ${itemRef(it) || it.title} from the queue` }) as HTMLButtonElement;
  b.append(svgIcon(ICON_CLOSE));
  b.addEventListener('click', () => send({ type: 'togglePriority', project: p.dir, key: it.key }));
  return b;
}

/** A row for an item the queue has started and is still running. */
function nowRow(p: Proj, it: BoardItem, where: string): HTMLElement {
  return h(
    'li',
    { class: `priority now kind-${it.kind}` },
    h('span', { class: 'item-id' }, itemRef(it) || '·'),
    h('button', { class: 'priority-title', type: 'button', onclick: () => showProgress(p, it), title: 'Show progress' }, it.title),
    h('span', { class: 'priority-state' }, where),
  );
}

export function renderQueue(p: Proj | undefined): void {
  const section = $('queue-section');
  section.hidden = !p;
  if (!p || p !== active) return;
  const items = allItems(p);
  const queued = p.priorities.map((k) => items.get(k)).filter((x): x is BoardItem => !!x);
  const open = queued.filter((q) => !q.done).length;

  const run = $<HTMLButtonElement>('queue-run');
  run.textContent = p.queueRunning ? 'Pause' : 'Run';
  run.setAttribute('aria-pressed', String(p.queueRunning));
  run.title = p.queueRunning ? 'Pause the queue: what is running finishes, and nothing more starts' : 'Run the queue: each item starts in turn as the one before it ends';
  section.classList.toggle('running', p.queueRunning);
  $('queue-count').textContent = open ? `${open} queued` : '';

  const own = $<HTMLSelectElement>('queue-task-start');
  own.options[0].textContent = `Default: ${START_WORDS[defaultTaskStart()]}`;
  own.value = p.taskStart ?? '';

  const status = $('queue-status');
  const say = waitsForBackground(p)
    ? 'Waiting for the work running in the background to end, so the next task can start in a new conversation.'
    : !queued.length
      ? 'Add tasks and bugs from their ⋯ menu.'
      : !p.queueRunning
        ? 'Paused. Run starts the next item as soon as the agent is free.'
        : '';
  status.textContent = say;
  status.hidden = !say;

  const now: HTMLElement[] = [];
  const current = p.busy && p.queueCurrent ? items.get(p.queueCurrent) : undefined;
  if (current) now.push(nowRow(p, current, 'running'));
  const lane = p.laneRun ? items.get(p.laneRun.key) : undefined;
  if (lane) now.push(nowRow(p, lane, 'running in a subagent'));
  $('queue-now').replaceChildren(...now);
  $('queue-now').hidden = !now.length;

  const order = queued.map((q) => q.key);
  $('queue').replaceChildren(
    ...queued.map((it) =>
      draggableRow(
        p,
        it.key,
        order,
        { class: `priority kind-${it.kind}${it.done ? ' done' : ''}${it.kind === 'bug' && !it.done ? ' open-bug' : ''}` },
        h('span', { class: 'item-id' }, itemRef(it) || '·'),
        h('button', { class: 'priority-title', type: 'button', onclick: () => showProgress(p, it), title: 'Show progress' }, it.title),
        h(
          'span',
          { class: 'priority-state' },
          (!it.done && waitingOn(it, items)) || (it.kind === 'bug' ? it.status : it.state === 'doing' ? 'in progress' : it.done ? 'done' : ''),
          laneOf(p, it.key) === 'subagent' ? h('span', { class: 'lane-tag', title: 'Starts in a background subagent with its own worktree' }, 'subagent') : null,
        ),
        dequeueButton(p, it),
        moreButton(p, it),
      ),
    ),
  );
}

export function wireQueuePanel(): void {
  $('queue-run').addEventListener('click', () => {
    if (!active) return;
    setQueueRunning(active, !active.queueRunning);
    renderQueue(active);
  });
  $('queue-task-start').addEventListener('change', (ev) => {
    if (!active) return;
    setTaskStart(active, ((ev.target as HTMLSelectElement).value || null) as TaskStart | null);
  });
}

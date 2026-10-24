import type { QueueLane, TaskItem } from '../../sidecar/src/protocol';
import { trackedItems } from './board';
import { BoardItem, allItems, legacySections, taskItem } from './board-model';
import { ICON_MORE, h, svgIcon } from './dom';
import { closeMenu, itemMenu, menuAnchor, openMenu, runAction } from './menus';
import { Proj, send } from './state';

// ---------- priority queue: prioritised items start, in order, whenever Claude is free ----------

export const isFree = (p: Proj) => !p.busy && !p.pending.size;

export const laneOf = (p: Proj, key: string): QueueLane => (p.subagentLane.has(key) ? 'subagent' : 'main');

export function nextQueued(p: Proj, skip?: string, lane: QueueLane = 'main'): BoardItem | undefined {
  const items = allItems(p);
  for (const key of p.priorities) {
    const it = items.get(key);
    if (it && !it.done && key !== skip && laneOf(p, key) === lane) return it;
  }
  return undefined;
}

/** A phase's open tasks, top level only, in the order its document lists them. */
export function phaseTasks(p: Proj, phase: BoardItem): BoardItem[] {
  const open = (t: TaskItem) => t.depth === 0 && (t.state === 'todo' || t.state === 'doing');
  if (phase.legacy) {
    const file = p.tasks.find((f) => f.kind === 'legacy');
    const sec = file && legacySections(file).find((s) => s.name === phase.title);
    return file && sec ? sec.items.filter(open).map((t) => taskItem(p, file, t)) : [];
  }
  const doc = p.tasks.find((f) => f.kind === 'phase' && f.rel === phase.rel);
  return doc ? trackedItems(doc).filter(open).map((t) => taskItem(p, doc, t)) : [];
}

/** Start a phase's first open task now and queue the rest behind it, in the same lane. */
export function startPhase(p: Proj, phase: BoardItem, lane: QueueLane): void {
  const [first, ...rest] = phaseTasks(p, phase);
  // No task list yet: hand the agent the phase itself.
  if (!first) return runAction(p, lane === 'main' ? 'start' : 'startSubagent', phase);
  if (rest.length) send({ type: 'enqueue', project: p.dir, keys: rest.map((t) => t.key), lane, front: true });
  if (lane === 'main') return runAction(p, 'start', first);
  if (!p.laneRun) p.laneRun = { key: first.key, known: liveSubagents(p) };
  runAction(p, 'startSubagent', first);
}

export const liveSubagents = (p: Proj) => new Set(p.processes.filter((x) => x.kind === 'subagent' && ['running', 'pending'].includes(x.status)).map((x) => x.id));

/** Start the next subagent-lane item once the one before it has finished. */
export function startSubagentQueued(p: Proj): void {
  if (p.laneRun || p.holdQueue) return;
  const next = nextQueued(p, undefined, 'subagent');
  if (!next) return;
  p.laneRun = { key: next.key, known: liveSubagents(p) };
  runAction(p, 'startSubagent', next);
}

/** Follow the subagent-lane item: find the background subagent it became, and move on when that ends. */
export function trackLane(p: Proj): void {
  const run = p.laneRun;
  if (!run || p.replaying) return;
  if (!run.processId) {
    const started = p.processes.find((x) => x.kind === 'subagent' && !run.known.has(x.id));
    if (started) run.processId = started.id;
    return;
  }
  const proc = p.processes.find((x) => x.id === run.processId);
  if (proc && ['running', 'pending', 'paused'].includes(proc.status)) return;
  p.laneRun = undefined;
  startSubagentQueued(p);
}

/** Queue an item to start after the current work, or take it off the queue. */
export function prioritise(p: Proj, item: BoardItem): void {
  if (item.kind === 'phase') {
    const tasks = phaseTasks(p, item).filter((t) => !p.priorities.includes(t.key));
    if (tasks.length) {
      send({ type: 'enqueue', project: p.dir, keys: tasks.map((t) => t.key), lane: 'main', front: false });
      const ahead = isFree(p) ? nextQueued(p) : undefined;
      if (isFree(p)) runAction(p, 'start', ahead ?? tasks[0]);
      return;
    }
  }
  if (p.priorities.includes(item.key)) return send({ type: 'togglePriority', project: p.dir, key: item.key });
  const ahead = isFree(p) ? nextQueued(p, item.key) : undefined;
  // Nothing running and nothing queued ahead of it: there's no current work to wait for.
  if (isFree(p) && !ahead) return runAction(p, 'start', item);
  send({ type: 'togglePriority', project: p.dir, key: item.key });
  if (ahead) runAction(p, 'start', ahead);
}

/** Claude just finished a turn: start the next queued item, unless you stopped it or it failed. */
export function startQueued(p: Proj): void {
  const held = p.holdQueue || !!p.lastTurn?.isError || !!p.lastTurn?.stopped;
  p.holdQueue = false;
  if (held) return;
  // A subagent-lane start that never became a background subagent has run its course with the turn.
  if (p.laneRun && !p.laneRun.processId) {
    p.laneRun = undefined;
    startSubagentQueued(p);
  }
  if (!isFree(p)) return;
  const next = nextQueued(p);
  if (next) runAction(p, 'start', next);
}

export function moreButton(p: Proj, item: BoardItem): HTMLButtonElement {
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

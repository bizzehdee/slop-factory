import type { LaneRun, QueueLane, TaskItem, TaskStart } from '../../sidecar/src/protocol';
import { trackedItems } from './board';
import { BoardItem, allItems, legacySections, taskItem } from './board-model';
import { ICON_MORE, h, svgIcon } from './dom';
import { closeMenu, itemMenu, menuAnchor, openMenu, runAction } from './menus';
import { Proj, load, send } from './state';
import { notice } from './transcript';

// ---------- the queue: while it runs, each item starts in turn as the one before it ends ----------
//
// The window runs the queue, not the agent: it starts one item at a time, in the way Settings says
// tasks start (as the conversation is, compacted first, or a new conversation), so that rule holds
// for every item whatever the agent would have done with a list. It has two lanes: "main" items
// start in the conversation as each turn ends; "subagent" items start in a background subagent as
// the previous one ends.

export const isFree = (p: Proj) => !p.busy && !p.pending.size;

export const laneOf = (p: Proj, key: string): QueueLane => (p.subagentLane.has(key) ? 'subagent' : 'main');

/** Where tasks start unless a project chooses otherwise: the default in Settings. */
export const defaultTaskStart = (): TaskStart => (load('slop-factory:task-start') as TaskStart | null) ?? 'current';

/** Where this project's tasks start: its own choice, else the default. */
export const taskStartOf = (p: Proj): TaskStart => p.taskStart ?? defaultTaskStart();

/** Anything the agent left running in the background: a new conversation would end it. */
export const backgroundWork = (p: Proj) => p.processes.some((x) => ['running', 'pending'].includes(x.status));

/** A start the agent hasn't picked up yet; after a while it's taken to have gone astray. */
const startPending = (p: Proj) => p.startSent !== undefined && Date.now() - p.startSent < 15_000;

/**
 * Whether the conversation lane can take its next item: the agent is free, and, when tasks start in
 * a new conversation, nothing is left running that starting one would end. The queue waits for
 * that rather than starting the task some other way.
 */
export const mainLaneFree = (p: Proj) => isFree(p) && !startPending(p) && !(taskStartOf(p) === 'new' && backgroundWork(p));

/** The queue is held up only by background work it won't end by starting a new conversation. */
export const waitsForBackground = (p: Proj) => p.queueRunning && isFree(p) && taskStartOf(p) === 'new' && backgroundWork(p) && !!nextQueued(p);

/**
 * Why an item can't start yet: a task it depends on isn't finished, or it has a Blocked by reason.
 * Undefined when it's free to start.
 */
export function waitingOn(item: BoardItem, items: Map<string, BoardItem>): string | undefined {
  const deps = (item.dependsOn ?? []).filter((id) => {
    const dep = items.get(id);
    return dep && !dep.done && dep.state !== 'cancelled';
  });
  if (deps.length) return `waits on ${deps.join(', ')}`;
  if (item.blockedBy?.length) return 'blocked';
  return undefined;
}

/** The next queued item in a lane that can start now. Waiting and blocked items keep their place. */
export function nextQueued(p: Proj, skip?: string, lane: QueueLane = 'main'): BoardItem | undefined {
  const items = allItems(p);
  for (const key of p.priorities) {
    const it = items.get(key);
    if (it && !it.done && key !== skip && laneOf(p, key) === lane && !waitingOn(it, items)) return it;
  }
  return undefined;
}

/** Record the subagent-lane item running now, in the sidecar too, so a reloaded window keeps following it. */
export function setLaneRun(p: Proj, run: LaneRun | undefined): void {
  p.laneRun = run;
  send({ type: 'setLaneRun', project: p.dir, run: run ?? null });
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

/** Run or pause the queue. Running starts whatever can start now; pausing lets the current item finish. */
export function setQueueRunning(p: Proj, running: boolean): void {
  if (p.queueRunning === running) return;
  p.queueRunning = running;
  send({ type: 'setQueueRunning', project: p.dir, running });
  if (running) pump(p);
}

/**
 * Start a phase's first task that can start now and queue the rest behind it, in order, in the
 * same lane, and set the queue running so they follow. Tasks waiting on others wait in the queue
 * until they're clear.
 */
export function startPhase(p: Proj, phase: BoardItem, lane: QueueLane): void {
  const tasks = phaseTasks(p, phase);
  // No task list yet: hand the agent the phase itself.
  if (!tasks.length) return runAction(p, lane === 'main' ? 'start' : 'startSubagent', phase);
  const items = allItems(p);
  const first = tasks.find((t) => !waitingOn(t, items));
  const rest = tasks.filter((t) => t !== first);
  if (rest.length) send({ type: 'enqueue', project: p.dir, keys: rest.map((t) => t.key), lane, front: true });
  if (first) {
    if (lane === 'main') runAction(p, 'start', first);
    else {
      if (!p.laneRun) setLaneRun(p, { key: first.key, known: liveSubagents(p) });
      runAction(p, 'startSubagent', first);
    }
  }
  if (rest.length) setQueueRunning(p, true);
  if (!first) notice(p, 'info', `Every open task in ${phase.title} is waiting on something, so they're queued and start as they're cleared.`);
}

export const liveSubagents = (p: Proj) => p.processes.filter((x) => x.kind === 'subagent' && ['running', 'pending'].includes(x.status)).map((x) => x.id);

/** Start the next subagent-lane item once the one before it has finished. */
function startSubagentQueued(p: Proj): void {
  if (p.laneRun || !p.queueRunning) return;
  const next = nextQueued(p, undefined, 'subagent');
  if (!next) return;
  setLaneRun(p, { key: next.key, known: liveSubagents(p) });
  p.queueRan = true;
  runAction(p, 'startSubagent', next);
}

/**
 * Start whatever the running queue can start now, one item per lane at a time. Safe to call after
 * any change: to the queue, the task files, the agent's state or what's running in the background.
 */
export function pump(p: Proj): void {
  if (!p.queueRunning || p.replaying) return;
  startSubagentQueued(p);
  if (!mainLaneFree(p)) return;
  const next = nextQueued(p);
  if (!next) return;
  p.queueRan = true;
  p.queueCurrent = next.key;
  runAction(p, 'start', next, true);
}

/** Follow the subagent-lane item: find the background subagent it became, and move on when that ends. */
export function trackLane(p: Proj): void {
  const run = p.laneRun;
  if (!run || p.replaying) return;
  if (!run.processId) {
    const started = p.processes.find((x) => x.kind === 'subagent' && !run.known.includes(x.id));
    if (started) setLaneRun(p, { ...run, processId: started.id });
    return;
  }
  const proc = p.processes.find((x) => x.id === run.processId);
  if (proc && ['running', 'pending', 'paused'].includes(proc.status)) return;
  setLaneRun(p, undefined);
}

/** Add an item to the queue, or take it off. A phase adds its open tasks, in order. A running queue starts it when its turn comes. */
export function toggleQueued(p: Proj, item: BoardItem): void {
  if (item.kind === 'phase') {
    const tasks = phaseTasks(p, item).filter((t) => !p.priorities.includes(t.key));
    if (tasks.length) return void send({ type: 'enqueue', project: p.dir, keys: tasks.map((t) => t.key), lane: 'main', front: false });
  }
  send({ type: 'togglePriority', project: p.dir, key: item.key });
}

/**
 * The agent just finished a turn. A stopped or failed turn pauses the queue, so nothing starts in
 * its place until you say; otherwise the next item starts.
 */
export function turnEnded(p: Proj): void {
  p.queueCurrent = undefined;
  p.startSent = undefined;
  // A subagent-lane start that never became a background subagent has run its course with the turn.
  if (p.laneRun && !p.laneRun.processId) setLaneRun(p, undefined);
  if (p.queueRunning && (p.lastTurn?.stopped || p.lastTurn?.isError)) {
    setQueueRunning(p, false);
    if (p.priorities.length) notice(p, 'info', `The queue is paused because the last turn ${p.lastTurn.stopped ? 'was stopped' : 'ended with an error'}. Press Run to carry on.`);
    return;
  }
  pump(p);
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

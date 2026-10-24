import type { TaskFile, Workstream } from '../../sidecar/src/protocol';
import { allItems, BoardItem } from './board-model';
import { revealItem } from './board';
import { closeDocs, docsView, setDocsView, showDoc } from './docs';
import { $, h } from './dom';
import { Proj, send } from './state';

// ---------- workstreams: tasks/workstream.md's streams, each run by its own agent at the same time ----------

type StreamState = 'done' | 'running' | 'waiting' | 'ready';

interface StreamView {
  ws: Workstream;
  items: { id: string; item?: BoardItem }[];
  done: number;
  state: StreamState;
  waitingOn: string[]; // streams still to finish first
}

const LIVE = ['running', 'pending', 'paused'];
const picked = new Map<string, Set<string>>(); // per project: the streams ticked to run

export const workstreamFile = (p: Proj): TaskFile | undefined => p.tasks.find((f) => f.kind === 'workstreams');

/** Each stream with its tasks' progress on the board, and whether it can start. */
function streamViews(p: Proj): StreamView[] {
  const streams = workstreamFile(p)?.workstreams ?? [];
  const items = allItems(p);
  const base = streams.map((ws) => {
    const list = ws.tasks.map((id) => ({ id, item: items.get(id) }));
    const done = list.filter((x) => x.item?.done).length;
    // The prompt asks for each subagent to be described as "Workstream W1: ...".
    const running = p.processes.some((x) => x.kind === 'subagent' && LIVE.includes(x.status) && new RegExp(`\\b${ws.id}\\b`).test(x.description));
    return { ws, items: list, done, running };
  });
  const finished = new Set(base.filter((b) => b.items.length && b.done === b.items.length).map((b) => b.ws.id));
  return base.map((b) => {
    const waitingOn = b.ws.waitsOn.filter((id) => !finished.has(id) && streams.some((s) => s.id === id));
    const state: StreamState = finished.has(b.ws.id) ? 'done' : b.running ? 'running' : waitingOn.length ? 'waiting' : 'ready';
    return { ws: b.ws, items: b.items, done: b.done, state, waitingOn };
  });
}

const STATE_TEXT: Record<StreamState, string> = { done: 'done', running: 'running', waiting: 'waiting', ready: 'ready' };

function chosen(p: Proj, views: StreamView[]): Set<string> {
  let set = picked.get(p.dir);
  const ready = views.filter((v) => v.state === 'ready').map((v) => v.ws.id);
  if (!set) picked.set(p.dir, (set = new Set(ready)));
  // Streams that finished or started since are no longer picks.
  for (const id of set) if (!views.some((v) => v.ws.id === id && (v.state === 'ready' || v.state === 'waiting'))) set.delete(id);
  return set;
}

export function findWorkstreams(p: Proj): void {
  send({ type: 'findWorkstreams', project: p.dir });
}

/** The board's Workstreams section: the streams at a glance, or an offer to find some. */
export function workstreamSection(p: Proj): HTMLElement | null {
  const file = workstreamFile(p);
  if (!file) {
    const open = [...allItems(p).values()].filter((i) => i.kind !== 'phase' && !i.done).length;
    if (open < 2) return null;
    return h(
      'section',
      { class: 'workstreams offer' },
      h('h3', {}, 'Workstreams'),
      h('p', { class: 'muted small' }, 'Agents can work on separate streams of tasks at the same time, each in its own worktree. ', h('button', { class: 'link-button', type: 'button', onclick: () => findWorkstreams(p), title: 'Ask the agent to look through the tasks for work that can run in parallel, and write tasks/workstream.md' }, 'Find workstreams')),
    );
  }
  const views = streamViews(p);
  const ready = views.filter((v) => v.state === 'ready').length;
  return h(
    'section',
    { class: 'workstreams' },
    h('h3', {}, 'Workstreams', h('span', { class: 'count' }, views.length ? `${ready} ready` : 'none listed')),
    h(
      'ul',
      { class: 'stream-list' },
      ...views.map((v) =>
        h(
          'li',
          { class: `stream ${v.state}` },
          h('button', { class: 'stream-open', type: 'button', onclick: () => openWorkstreams(p) }, h('span', { class: 'stream-id' }, v.ws.id), h('span', { class: 'stream-name' }, v.ws.name)),
          h('span', { class: 'stream-progress', title: `${v.done} of ${v.items.length} tasks done` }, `${v.done}/${v.items.length}`),
          h('span', { class: `stream-state ${v.state}`, title: v.state === 'waiting' ? `Waits on ${v.waitingOn.join(', ')}` : '' }, v.state === 'waiting' ? `after ${v.waitingOn.join(', ')}` : STATE_TEXT[v.state]),
        ),
      ),
    ),
    views.length ? h('button', { class: 'button small', type: 'button', onclick: () => openWorkstreams(p) }, ready > 1 ? `Run ${ready} in parallel…` : 'Run workstreams…') : null,
  );
}

export function openWorkstreams(p: Proj): void {
  picked.delete(p.dir); // start from the streams ready now
  setDocsView({ project: p.dir, key: 'workstreams', requestId: '', tab: '', docs: [], workstreams: true });
  renderWorkstreamsView(p);
  $('docs-panel').hidden = false;
  $('docs-close').focus();
}

export function renderWorkstreamsView(p: Proj | undefined): void {
  if (!p || !docsView?.workstreams) return;
  const file = workstreamFile(p);
  $('docs-tabs').hidden = true;
  $('docs-ref').textContent = 'Workstreams';
  $('docs-title').textContent = file ? 'Run streams of tasks at the same time' : 'No workstreams yet';
  const body = $('docs-body');
  const actions = $('docs-actions');
  if (!file) {
    body.replaceChildren(h('div', { class: 'docs-empty' }, h('p', {}, 'tasks/workstream.md lists streams of tasks that separate agents can work through at the same time. The agent can look through the task list and write it.')));
    actions.hidden = false;
    actions.replaceChildren(h('button', { class: 'button primary', type: 'button', onclick: () => (findWorkstreams(p), closeDocs()) }, 'Find workstreams'));
    return;
  }
  const views = streamViews(p);
  const set = chosen(p, views);
  const runButton = h('button', { class: 'button primary', type: 'button' });
  const update = () => {
    runButton.textContent = set.size > 1 ? `Run ${set.size} at the same time` : set.size ? `Run ${[...set][0]}` : 'Pick streams to run';
    runButton.toggleAttribute('disabled', !set.size);
  };
  runButton.addEventListener('click', () => {
    if (!set.size) return;
    send({ type: 'runWorkstreams', project: p.dir, ids: views.filter((v) => set.has(v.ws.id)).map((v) => v.ws.id) });
    set.clear();
    closeDocs();
  });
  body.replaceChildren(
    h('p', { class: 'docs-path' }, `${file.rel}. Each stream runs in a background subagent with its own git worktree; review and merge each one under Worktrees when it finishes.`),
    ...(views.length
      ? views.map((v) => {
          const can = v.state === 'ready' || v.state === 'waiting';
          const box = h('input', { type: 'checkbox', checked: set.has(v.ws.id), disabled: !can, 'aria-describedby': `ws-${v.ws.id}-state` }) as HTMLInputElement;
          box.addEventListener('change', () => {
            if (box.checked) set.add(v.ws.id);
            else set.delete(v.ws.id);
            update();
          });
          return h(
            'section',
            { class: `stream-card ${v.state}` },
            h(
              'label',
              { class: 'stream-card-head' },
              box,
              h('span', { class: 'stream-id' }, v.ws.id),
              h('span', { class: 'stream-name' }, v.ws.name),
              h('span', { id: `ws-${v.ws.id}-state`, class: `stream-state ${v.state}` }, v.state === 'waiting' ? `waits on ${v.waitingOn.join(', ')}` : STATE_TEXT[v.state]),
            ),
            h(
              'ol',
              { class: 'stream-tasks' },
              ...v.items.map(({ id, item }) =>
                h(
                  'li',
                  { class: item?.done ? 'done' : '' },
                  item
                    ? h('button', { class: 'link-button', type: 'button', onclick: () => revealItem(p, id) }, `${id}: ${item.title}`)
                    : h('span', { class: 'muted' }, `${id} isn't on the board`),
                ),
              ),
            ),
            v.ws.touches ? h('p', { class: 'stream-touches' }, 'Touches ', h('code', {}, v.ws.touches)) : null,
          );
        })
      : [h('div', { class: 'docs-empty' }, h('p', {}, `${file.rel} has no "## W1: name" streams.`))]),
  );
  actions.hidden = false;
  actions.replaceChildren(
    runButton,
    h('button', { class: 'button quiet', type: 'button', onclick: () => showDoc(p, file.rel, 'Workstreams', file.rel) }, 'Open workstream.md'),
    h('button', { class: 'button quiet', type: 'button', title: 'Ask the agent to look through the tasks again and rewrite tasks/workstream.md', onclick: () => (findWorkstreams(p), closeDocs()) }, 'Find again'),
  );
  update();
}

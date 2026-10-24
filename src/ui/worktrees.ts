import type { WorktreeInfo } from '../../sidecar/src/protocol';
import { docsView, setDocsView, closeDocs } from './docs';
import { $, h } from './dom';
import { Proj, active, send } from './state';

// ---------- worktrees: review, merge or discard the branches subagents worked on ----------

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function summary(w: WorktreeInfo): string {
  const parts = [w.ahead ? plural(w.ahead, 'commit') : 'no commits', plural(w.files.length, 'file')];
  if (w.uncommitted) parts.push(`${w.uncommitted} not committed`);
  return parts.join(' · ');
}

export function refreshWorktrees(p: Proj): void {
  send({ type: 'listWorktrees', project: p.dir });
}

function merge(p: Proj, w: WorktreeInfo): void {
  const note = w.uncommitted ? `\n\n${plural(w.uncommitted, 'file')} in it aren't committed and won't be merged.` : '';
  if (!confirm(`Merge ${w.branch} into ${w.base}?${note}`)) return;
  send({ type: 'mergeWorktree', project: p.dir, path: w.path });
  if (docsView?.worktree === w.path) closeDocs();
}

function discard(p: Proj, w: WorktreeInfo): void {
  if (!confirm(`Discard ${w.branch}? Its worktree and branch are deleted, with ${plural(w.ahead, 'commit')} and any uncommitted changes.`)) return;
  send({ type: 'discardWorktree', project: p.dir, path: w.path });
  if (docsView?.worktree === w.path) closeDocs();
}

/** For a branch that won't merge cleanly, or needs its loose ends tidied first. */
function askAgentToMerge(p: Proj, w: WorktreeInfo): void {
  send({
    type: 'send',
    project: p.dir,
    text:
      `Merge the branch ${w.branch} (worktree ${w.path}) into ${w.base}. Commit anything left uncommitted in the worktree first, ` +
      'resolve any conflicts so both sides keep working, run the tests, and tell me what you changed while merging. ' +
      'Then remove the worktree and the branch.',
  });
  closeDocs();
}

export function renderWorktrees(): void {
  const p = active;
  const list = p?.worktrees ?? [];
  $('worktrees-section').hidden = !list.length;
  $('worktrees-count').textContent = list.length ? String(list.length) : '';
  if (!p) return;
  $('worktrees').replaceChildren(
    ...list.map((w) =>
      h(
        'div',
        { class: 'worktree' },
        h(
          'button',
          { class: 'worktree-main', type: 'button', title: `Review ${w.branch}`, onclick: () => reviewWorktree(p, w) },
          h('span', { class: 'worktree-branch' }, w.branch),
          w.agent ? h('span', { class: 'q-tag' }, 'subagent') : null,
          h('span', { class: 'worktree-meta' }, summary(w)),
        ),
        h(
          'div',
          { class: 'worktree-actions' },
          h('button', { class: 'link-button', type: 'button', disabled: !w.ahead, onclick: () => merge(p, w) }, 'Merge'),
          h('button', { class: 'link-button danger', type: 'button', onclick: () => discard(p, w) }, 'Discard'),
        ),
      ),
    ),
  );
}

export function reviewWorktree(p: Proj, w: WorktreeInfo): void {
  const requestId = Math.random().toString(36).slice(2);
  setDocsView({ project: p.dir, key: `worktree:${w.path}`, requestId, tab: '', docs: [], worktree: w.path });
  send({ type: 'worktreeDiff', project: p.dir, path: w.path, requestId });
  renderWorktreeView(p);
  $('docs-panel').hidden = false;
  $('docs-close').focus();
}

/** A unified diff as a list of files, each with its lines coloured. */
export function diffView(diff: string): HTMLElement {
  const files: { name: string; lines: string[] }[] = [];
  let cur: { name: string; lines: string[] } | undefined;
  for (const line of diff.split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      files.push((cur = { name: head[2], lines: [] }));
      continue;
    }
    if (line.startsWith('# ')) {
      files.push((cur = { name: line.slice(2), lines: [] }));
      continue;
    }
    if (!cur || /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(line)) continue;
    cur.lines.push(line);
  }
  if (!files.length) return h('div', { class: 'docs-empty' }, h('p', {}, 'No changes yet.'));
  return h(
    'div',
    { class: 'diff' },
    ...files.map((f) => {
      const pre = h('pre', { class: 'diff-lines' });
      const frag = document.createDocumentFragment();
      for (const l of f.lines) {
        const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
        frag.append(h('span', { class: cls }, l || ' '), '\n');
      }
      pre.append(frag);
      return h('details', { class: 'diff-file', open: true }, h('summary', {}, f.name), f.lines.length ? pre : null);
    }),
  );
}

export function renderWorktreeView(p: Proj | undefined): void {
  const view = docsView;
  const w = p?.worktrees.find((x) => x.path === view?.worktree);
  $('docs-tabs').hidden = true;
  const actions = $('docs-actions');
  if (!p || !view || !w) {
    $('docs-ref').textContent = 'Worktree';
    $('docs-title').textContent = 'Gone';
    $('docs-body').replaceChildren(h('div', { class: 'docs-empty' }, h('p', {}, 'This worktree has been merged or removed.')));
    actions.replaceChildren();
    actions.hidden = true;
    return;
  }
  $('docs-ref').textContent = w.agent ? 'Subagent worktree' : 'Worktree';
  $('docs-title').textContent = w.branch;
  $('docs-body').replaceChildren(
    h('p', { class: 'docs-path' }, `${summary(w)} · against ${w.base} · ${w.path}`),
    view.diff === undefined ? h('div', { class: 'docs-empty' }, h('p', {}, 'Loading the changes…')) : diffView(view.diff),
  );
  actions.hidden = false;
  actions.replaceChildren(
    h('button', { class: 'button primary', type: 'button', disabled: !w.ahead, onclick: () => merge(p, w) }, `Merge into ${w.base}`),
    h('button', { class: 'button', type: 'button', title: 'The agent commits loose ends, resolves conflicts and runs the tests', onclick: () => askAgentToMerge(p, w) }, 'Ask the agent to merge'),
    h('button', { class: 'button quiet danger', type: 'button', onclick: () => discard(p, w) }, 'Discard'),
  );
}

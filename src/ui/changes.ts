import type { ProjectEvent } from '../../sidecar/src/protocol';
import { docsView, setDocsView } from './docs';
import { $, h } from './dom';
import { Proj, send } from './state';
import { appendEntry, relPath } from './transcript';

// ---------- what each turn changed, with a diff and an undo (the SDK's file checkpoints) ----------

export interface FileEdit {
  tool: string;
  file: string;
  before?: string; // Edit, MultiEdit: the text replaced
  after: string; // the text written
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** The edits a tool call made, from its own input. */
function editsOf(p: Proj, name: string, input: unknown): FileEdit[] {
  const i = (input ?? {}) as Record<string, unknown>;
  const file = relPath(p, String(i.file_path ?? i.notebook_path ?? ''));
  if (name === 'Write') return [{ tool: name, file, after: String(i.content ?? '') }];
  if (name === 'NotebookEdit') return [{ tool: name, file, after: String(i.new_source ?? '') }];
  if (name === 'MultiEdit' && Array.isArray(i.edits)) {
    return (i.edits as Record<string, unknown>[]).map((e) => ({ tool: name, file, before: String(e.old_string ?? ''), after: String(e.new_string ?? '') }));
  }
  return [{ tool: name, file, before: String(i.old_string ?? ''), after: String(i.new_string ?? '') }];
}

/** A new turn: its edits are collected until it ends. A message sent mid-turn waits for its own turn. */
export function startTurn(p: Proj, e: Extract<ProjectEvent, { type: 'user' }>): void {
  if (!e.uuid) return;
  if (p.turnUuid) return void p.queuedTurns.push(e.uuid);
  p.turnUuid = e.uuid;
  p.turnEdits = [];
}

export function noteToolUse(p: Proj, name: string, input: unknown, parent: string | null): void {
  if (parent || !EDIT_TOOLS.has(name) || !p.turnUuid) return;
  p.turnEdits.push(...editsOf(p, name, input));
}

export function clearQueuedTurns(p: Proj): void {
  p.queuedTurns = [];
  if (!p.turnEdits.length) p.turnUuid = undefined;
}

/** At the end of a turn that changed files, a line saying which, with Review and Undo. */
export function endTurn(p: Proj): void {
  const uuid = p.turnUuid;
  const edits = p.turnEdits;
  // The next message waiting starts the next turn (even after Stop, which ends only this one).
  p.turnUuid = p.queuedTurns.shift();
  p.turnEdits = [];
  if (!uuid || !edits.length) return;
  p.turnChanges.set(uuid, edits);
  const files = [...new Set(edits.map((e) => e.file))];
  const card = h(
    'div',
    { class: 'turn-changes', dataset: { uuid } },
    h('span', { class: 'turn-changes-text' }, `Changed ${files.length === 1 ? files[0] : `${files.length} files: ${files.join(', ')}`}`),
    h('button', { class: 'link-button', type: 'button', onclick: () => reviewChanges(p, uuid) }, 'Review'),
    h('button', { class: 'link-button undo', type: 'button', title: 'Put these files back as they were before this turn, along with any later changes to them', onclick: () => send({ type: 'rewindFiles', project: p.dir, uuid, dryRun: true }) }, 'Undo'),
  );
  p.changeCards.set(uuid, card);
  appendEntry(p, card);
}

/** The dry run says what an undo would do; ask, then do it. */
export function onRewound(p: Proj, e: Extract<ProjectEvent, { type: 'rewound' }>): void {
  const card = p.changeCards.get(e.uuid);
  if (!e.canRewind) {
    if (!p.replaying) alert(`Can't undo this turn: ${e.error ?? 'its checkpoint is gone'}.`);
    return;
  }
  if (e.dryRun) {
    if (p.replaying) return;
    const files = e.filesChanged ?? [];
    const list = files.map((f) => `• ${relPath(p, f)}`).join('\n');
    if (confirm(`Put ${files.length} file${files.length === 1 ? '' : 's'} back as they were before this turn? Later changes to them are undone too.\n\n${list}`)) {
      send({ type: 'rewindFiles', project: p.dir, uuid: e.uuid, dryRun: false });
    }
    return;
  }
  if (card) {
    card.classList.add('undone');
    card.querySelector('.undo')?.replaceWith(h('span', { class: 'turn-changes-done' }, 'Undone'));
  }
}

export function reviewChanges(p: Proj, uuid: string): void {
  setDocsView({ project: p.dir, key: `changes:${uuid}`, requestId: '', tab: '', docs: [], changes: uuid });
  renderChangesView(p);
  $('docs-panel').hidden = false;
  $('docs-close').focus();
}

function lines(text: string, mark: '+' | '-', cls: string): HTMLElement[] {
  return text.replace(/\n$/, '').split('\n').map((l) => h('span', { class: cls }, `${mark}${l}`));
}

export function renderChangesView(p: Proj | undefined): void {
  const uuid = docsView?.changes;
  const edits = (uuid && p?.turnChanges.get(uuid)) || [];
  $('docs-tabs').hidden = true;
  $('docs-ref').textContent = 'Changes';
  const files = [...new Set(edits.map((e) => e.file))];
  $('docs-title').textContent = files.length === 1 ? files[0] : `${files.length} files`;
  $('docs-body').replaceChildren(
    h(
      'div',
      { class: 'diff' },
      ...files.map((file) => {
        const pre = h('pre', { class: 'diff-lines' });
        for (const e of edits.filter((x) => x.file === file)) {
          if (pre.childNodes.length) pre.append(h('span', { class: 'hunk' }, '…'), '\n');
          const rows = [...(e.before !== undefined ? lines(e.before, '-', 'del') : []), ...lines(e.after, '+', 'add')];
          for (const r of rows) pre.append(r, '\n');
        }
        return h('details', { class: 'diff-file', open: true }, h('summary', {}, file), pre);
      }),
    ),
  );
  const card = uuid ? p?.changeCards.get(uuid) : undefined;
  const actions = $('docs-actions');
  actions.hidden = !p || !uuid || !!card?.classList.contains('undone');
  actions.replaceChildren(
    p && uuid ? h('button', { class: 'button', type: 'button', onclick: () => send({ type: 'rewindFiles', project: p.dir, uuid, dryRun: true }) }, 'Undo these changes') : '',
  );
}

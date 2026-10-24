import type { DocContent } from '../../sidecar/src/protocol';
import { BoardItem, allItems, itemRef } from './board-model';
import { renderHeader } from './chrome';
import { $, h, md } from './dom';
import { runAction } from './menus';
import { questionViewKey, renderQuestionView, renderQuestions, resetQuestionView, where } from './questions';
import { prioritise } from './queue';
import { renderWorktreeView } from './worktrees';
import { Proj, projects, send } from './state';
import { renderSubagentView } from './subagents';
import { renderChangesView } from './changes';
import { renderUsageView } from './usage';
import { renderWorkstreamsView } from './workstreams';
import { renderUncommitted, type UncommittedView } from './git';

// ---------- progress panel (spec and summary) ----------

// A single document (plan.md, or where an open question lives) shows under doc: and its key.
export interface PlainDoc {
  rel: string;
  ref: string;
  title: string;
}
export let docsView:
  | { project: string; key: string; requestId: string; tab: string; docs: DocContent[]; doc?: PlainDoc; question?: string; worktree?: string; diff?: string; subagent?: string; changes?: string; usage?: boolean; workstreams?: boolean; uncommitted?: UncommittedView }
  | undefined;
export const setDocsView = (view: typeof docsView) => (docsView = view);

export const planRel = (p: Proj) => [...p.docs].find((rel) => rel.toLowerCase() === 'plan.md');
export const planOpen = (p: Proj) => docsView?.project === p.dir && !!docsView.doc && docsView.doc.rel === planRel(p);

export function togglePlan(p: Proj): void {
  if (planOpen(p)) return closeDocs();
  const rel = planRel(p);
  if (rel) showDoc(p, rel, p.name, 'Plan');
}

export function showDoc(p: Proj, rel: string, title: string, ref = ''): void {
  const requestId = Math.random().toString(36).slice(2);
  const key = `doc:${rel}`;
  docsView = { project: p.dir, key, requestId, tab: rel, docs: [], doc: { rel, ref, title } };
  send({ type: 'readDocs', project: p.dir, requestId, key, paths: [rel] });
  renderDocs();
  renderHeader();
  $('docs-panel').hidden = false;
  $('docs-close').focus();
}

export function docPaths(item: BoardItem): string[] {
  return [item.spec, item.summary, ...item.docLinks.map((l) => l.rel)].filter((x): x is string => !!x);
}

/** A task with detail lines under it (Depends on, Blocked by, an older TASK.md's whole entry) shows that entry too. */
export const docBlocks = (item: BoardItem) => (item.kind === 'task' && item.hasDetails ? [{ rel: item.rel, line: item.line }] : undefined);
export const blockRel = (item: BoardItem) => `${item.rel}#L${item.line + 1}`;

export function showProgress(p: Proj, item: BoardItem, openOn?: string): void {
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

export function refreshDocs(p: Proj): void {
  if (!docsView || docsView.project !== p.dir || docsView.question || docsView.worktree || docsView.subagent || docsView.changes) return;
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

export function docLabel(item: BoardItem | undefined, rel: string): string {
  if (item && rel === blockRel(item)) return 'Task';
  if (item?.spec === rel) return 'Spec';
  if (item?.summary === rel) return 'Summary';
  return item?.docLinks.find((l) => l.rel === rel)?.label || rel.split('/').pop()!.replace(/\.md$/, '');
}

export function renderDocs(): void {
  const panel = $('docs-panel');
  if (!docsView) return void (panel.hidden = true);
  const p = projects.get(docsView.project);
  if (docsView.question) return renderQuestionView(p, docsView.question);
  if (docsView.worktree) return renderWorktreeView(p);
  if (docsView.subagent) return renderSubagentView(p);
  if (docsView.changes) return renderChangesView(p);
  if (docsView.usage) return renderUsageView(p);
  if (docsView.workstreams) return renderWorkstreamsView(p);
  if (docsView.uncommitted) return renderUncommitted(p);
  resetQuestionView();
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

export function closeDocs(): void {
  const was = docsView;
  docsView = undefined;
  resetQuestionView();
  $('docs-panel').hidden = true;
  if (was?.doc) renderHeader();
  if (was?.question) renderQuestions(true);
}

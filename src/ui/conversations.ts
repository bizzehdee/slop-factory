import type { SessionEntry } from '../../sidecar/src/protocol';
import { docsView, setDocsView } from './docs';
import { $, h } from './dom';
import { send, type Proj } from './state';

// ---------- a project's conversations: open, rename, branch or delete one ----------

const ago = (ms: number): string => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: s > 300 * 86_400 ? 'numeric' : undefined });
};

export function openConversations(p: Proj): void {
  setDocsView({ project: p.dir, key: 'sessions', requestId: '', tab: '', docs: [], sessions: true });
  send({ type: 'listSessions', project: p.dir });
  renderConversationsView(p);
  $('docs-panel').hidden = false;
  $('docs-close').focus();
}

export function renderConversationsView(p: Proj | undefined): void {
  if (!p || !docsView?.sessions) return;
  $('docs-tabs').hidden = true;
  $('docs-ref').textContent = p.account?.name ? `Conversations · ${p.account.name}` : 'Conversations';
  $('docs-title').textContent = p.name;
  const body = $('docs-body');
  const list = p.sessions?.list;
  const row = (s: SessionEntry) =>
    h(
      'li',
      { class: `session-row${s.current ? ' current' : ''}` },
      h(
        'div',
        { class: 'session-main' },
        h('strong', { class: 'session-title' }, s.title),
        h('span', { class: 'muted small' }, [s.current ? 'Open now' : '', ago(s.modified), s.branch ? `on ${s.branch}` : ''].filter(Boolean).join(' · ')),
      ),
      h(
        'div',
        { class: 'session-actions' },
        s.current ? null : h('button', { class: 'button tiny', type: 'button', onclick: () => send({ type: 'resumeSession', project: p.dir, sessionId: s.id }) }, 'Open'),
        h('button', { class: 'button tiny quiet', type: 'button', title: 'Start a copy of this conversation and carry on in it, leaving this one as it is', onclick: () => send({ type: 'forkSession', project: p.dir, sessionId: s.id }) }, 'Branch'),
        h('button', { class: 'button tiny quiet', type: 'button', onclick: () => rename(p, s) }, 'Rename'),
        s.current ? null : h('button', { class: 'button tiny quiet danger', type: 'button', onclick: () => remove(p, s) }, 'Delete'),
      ),
    );
  body.replaceChildren(
    p.sessions?.error
      ? h('p', { class: 'field-hint warn-text' }, p.sessions.error)
      : !list
        ? h('p', { class: 'muted' }, 'Looking for conversations…')
        : list.length
          ? h('ul', { class: 'session-list' }, ...list.map(row))
          : h('div', { class: 'docs-empty' }, h('p', {}, 'No conversations yet. They show here once the agent has been asked something.')),
  );
  const actions = $('docs-actions');
  actions.hidden = false;
  actions.dataset.agent = '';
  actions.replaceChildren(h('button', { class: 'button', type: 'button', onclick: () => ($('new-conversation') as HTMLButtonElement).click() }, 'New conversation'), h('button', { class: 'button quiet', type: 'button', onclick: () => ($('docs-close') as HTMLButtonElement).click() }, 'Back to the conversation'));
}

function rename(p: Proj, s: SessionEntry): void {
  const title = prompt('Name this conversation:', s.title)?.trim();
  if (title && title !== s.title) send({ type: 'renameSession', project: p.dir, sessionId: s.id, title });
}

function remove(p: Proj, s: SessionEntry): void {
  if (confirm(`Delete “${s.title}”?\n\nIts record is removed from disk and can’t be brought back.`)) send({ type: 'deleteSession', project: p.dir, sessionId: s.id });
}

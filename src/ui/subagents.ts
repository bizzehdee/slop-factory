import type { ProjectEvent } from '../../sidecar/src/protocol';
import { docsView, setDocsView } from './docs';
import { $, h, md } from './dom';
import { Proj, send } from './state';
import { toolSummary } from './transcript';

// ---------- a subagent's own transcript, live, beside the conversation ----------

type AgentEvent = Extract<ProjectEvent, { type: 'assistantText' | 'toolUse' | 'toolResult' }>;

/** Keep what a subagent says and does, and update its view if it's open. */
export function recordAgentEvent(p: Proj, e: AgentEvent): void {
  if (!e.agent) return;
  const log = p.agentLogs.get(e.agent) ?? [];
  log.push(e);
  p.agentLogs.set(e.agent, log);
  if (docsView?.project === p.dir && docsView.subagent === e.agent) renderSubagentView(p);
}

export function openSubagent(p: Proj, agentId: string): void {
  setDocsView({ project: p.dir, key: `agent:${agentId}`, requestId: '', tab: '', docs: [], subagent: agentId });
  // A subagent that ran before this window opened: read its transcript from disk.
  if (!p.agentLogs.get(agentId)?.length) send({ type: 'subagentLog', project: p.dir, agentId });
  renderSubagentView(p);
  $('docs-panel').hidden = false;
  $('docs-close').focus();
}

export function onSubagentLog(p: Proj, agentId: string, events: ProjectEvent[]): void {
  if (!events.length || p.agentLogs.get(agentId)?.length) return;
  p.agentLogs.set(agentId, events.filter((e): e is AgentEvent => e.type === 'assistantText' || e.type === 'toolUse' || e.type === 'toolResult'));
  if (docsView?.subagent === agentId) renderSubagentView(p);
}

const LIVE = ['running', 'pending', 'paused'];

export function renderSubagentView(p: Proj | undefined): void {
  const id = docsView?.subagent;
  if (!p || !id) return;
  const proc = p.processes.find((x) => x.id === id);
  const live = !!proc && LIVE.includes(proc.status);
  $('docs-tabs').hidden = true;
  $('docs-ref').textContent = `Subagent · ${live ? 'working' : proc?.status ?? 'finished'}`;
  $('docs-title').textContent = proc?.description ?? id;

  const body = $('docs-body');
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  const log = p.agentLogs.get(id) ?? [];
  const entries = log.map((e) => {
    if (e.type === 'assistantText') {
      const el = h('div', { class: 'agent-text' });
      el.innerHTML = md(e.text);
      return el;
    }
    if (e.type === 'toolUse') {
      const s = toolSummary(p, e.name, e.input);
      return h('div', { class: 'agent-step' }, h('span', { class: 'tool-name' }, s.label), s.detail ? h('code', {}, s.detail) : null);
    }
    return h('div', { class: `agent-result${e.isError ? ' error' : ''}` }, e.preview.split('\n')[0].slice(0, 200) || '(no output)');
  });
  body.replaceChildren(
    h('div', { class: 'agent-log' }, ...(entries.length ? entries : [h('div', { class: 'docs-empty' }, h('p', {}, live ? 'Waiting for it to say something…' : 'Nothing recorded for this subagent.'))])),
  );
  if (proc?.summary && !live) body.append(h('p', { class: 'agent-summary' }, proc.summary));
  if (atBottom || live) body.scrollTop = body.scrollHeight;

  const actions = $('docs-actions');
  actions.hidden = false;
  // Keep what's being typed while the view refreshes under it.
  const typed = actions.querySelector<HTMLTextAreaElement>('.agent-say textarea');
  const draft = typed && actions.dataset.agent === id ? typed.value : '';
  const focused = !!typed && document.activeElement === typed;
  actions.dataset.agent = id;
  const say = h('textarea', { rows: '2', placeholder: `Message ${proc?.description ?? 'the subagent'}`, 'aria-label': 'Message this subagent' }) as HTMLTextAreaElement;
  say.value = draft;
  const tell = () => {
    const text = say.value.trim();
    if (!text) return;
    send({ type: 'messageSubagent', project: p.dir, agentId: id, name: proc?.description ?? id, text });
    // The main agent carries it over, so it is in the main conversation too.
    p.agentLogs.set(id, [...(p.agentLogs.get(id) ?? []), { type: 'assistantText', agent: id, text: `**You:** ${text}` } as AgentEvent]);
    say.value = '';
    renderSubagentView(p);
  };
  say.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      tell();
    }
  });
  actions.replaceChildren(
    h(
      'div',
      { class: 'agent-say' },
      say,
      h(
        'div',
        { class: 'agent-say-row' },
        h('button', { class: 'button primary', type: 'button', onclick: tell }, 'Send to subagent'),
        live ? h('button', { class: 'button', type: 'button', onclick: () => send({ type: 'stopProcess', project: p.dir, id }) }, 'Stop this subagent') : '',
        h('button', { class: 'button quiet agent-back', type: 'button', onclick: () => ($('docs-close') as HTMLButtonElement).click() }, 'Back to main agent'),
      ),
      h('p', { class: 'muted small' }, 'Sent through the main agent, which passes it on. A subagent that has finished may not pick it up.'),
    ),
  );
  if (focused) say.focus();
}

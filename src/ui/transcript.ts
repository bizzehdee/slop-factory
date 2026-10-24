import { renderProjects } from './chrome';
import { h, md } from './dom';
import { Proj, active, send } from './state';

// ---------- transcript ----------

export function stickToBottom(p: Proj, fn: () => void): void {
  const t = p.transcript;
  const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  fn();
  if (atBottom && !p.replaying) t.scrollTop = t.scrollHeight;
}

export const appendEntry = (p: Proj, el: HTMLElement) => stickToBottom(p, () => p.transcript.append(el));

export function emptyTranscript(p: Proj): void {
  p.transcript.replaceChildren(
    h('div', { class: 'empty' }, h('p', {}, `The agent has ${p.name}'s rules loaded. Ask for something, or use the ⋯ menu on a task to start it.`)),
  );
}

export function assistantDelta(p: Proj, msgId: string, index: number, text: string): void {
  const key = `${msgId}:${index}`;
  let el = p.liveText.get(key);
  if (!el) {
    el = h('div', { class: 'msg assistant streaming' });
    el.dataset.raw = '';
    p.liveText.set(key, el);
    appendEntry(p, el);
  }
  el.dataset.raw += text;
  stickToBottom(p, () => (el!.textContent = el!.dataset.raw ?? ''));
}

export function assistantFinal(p: Proj, msgId: string, text: string, parent: string | null): void {
  if (parent) return nestUnder(p, parent, h('div', { class: 'sub-text' }, text.slice(0, 300)));
  const entry = [...p.liveText.entries()].find(([k]) => k.startsWith(msgId + ':'));
  let el: HTMLElement;
  if (entry) {
    p.liveText.delete(entry[0]);
    el = entry[1];
  } else {
    el = h('div', { class: 'msg assistant' });
    appendEntry(p, el);
  }
  el.classList.remove('streaming');
  stickToBottom(p, () => (el.innerHTML = md(text)));
}

export function relPath(p: Proj, file: string): string {
  const root = p.dir.replace(/[\\/]+$/, '');
  for (const sep of ['/', '\\']) if (file.startsWith(root + sep)) return file.slice(root.length + 1);
  return file;
}

// Tool calls are drawn the way Claude Code's terminal shows them: Name(argument).
export function toolSummary(p: Proj, name: string, input: unknown): { label: string; detail?: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? (v.startsWith('/') || /^[A-Za-z]:\\/.test(v) ? relPath(p, v) : v) : undefined);
  switch (name) {
    case 'Bash':
      return { label: 'Bash', detail: str(i.command) };
    case 'Monitor':
      return { label: 'Monitor', detail: str(i.description) ?? str(i.command) };
    case 'Read':
      return { label: 'Read', detail: str(i.file_path) };
    case 'Write':
      return { label: 'Write', detail: str(i.file_path) };
    case 'Edit':
    case 'MultiEdit':
      return { label: 'Update', detail: str(i.file_path) };
    case 'Grep':
      return { label: 'Search', detail: str(i.pattern) ? `pattern: "${i.pattern}"` : undefined };
    case 'Glob':
      return { label: 'Search', detail: str(i.pattern) };
    case 'Skill':
      return { label: 'Skill', detail: str(i.skill) ?? str(i.name) };
    case 'Task':
    case 'Agent':
      return { label: str(i.subagent_type) ? `Task: ${i.subagent_type}` : 'Task', detail: str(i.description) };
    case 'TodoWrite':
      return { label: 'Update Todos' };
    case 'WebSearch':
      return { label: 'Web Search', detail: str(i.query) };
    case 'WebFetch':
      return { label: 'Fetch', detail: str(i.url) };
    default:
      return { label: name, detail: JSON.stringify(input)?.slice(0, 160) };
  }
}

export function firstLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return 'Done';
  const head = lines[0].length > 140 ? lines[0].slice(0, 139) + '…' : lines[0];
  return lines.length > 1 ? `${head}  (+${lines.length - 1} lines)` : head;
}

// Claude Code summarises some results instead of echoing them.
export function resultLine(tool: string, preview: string): string {
  const lines = preview.split('\n').filter((l) => l.trim()).length;
  if (tool === 'Read') return `Read ${lines} line${lines === 1 ? '' : 's'}`;
  if ((tool === 'Grep' || tool === 'Glob') && lines) return `Found ${lines} result${lines === 1 ? '' : 's'}`;
  return firstLine(preview);
}

export function ledgerCall(s: { label: string; detail?: string }): HTMLElement {
  return h('span', { class: 'tool-call' }, h('span', { class: 'tool-name' }, s.label), s.detail ? h('span', { class: 'tool-arg' }, `(${s.detail})`) : null);
}

export function nestUnder(p: Proj, parentToolId: string, el: HTMLElement): void {
  const card = p.toolCards.get(parentToolId);
  if (!card) return;
  let list = card.querySelector<HTMLElement>('.sub-steps');
  if (!list) {
    list = h('div', { class: 'sub-steps' });
    card.append(list);
  }
  stickToBottom(p, () => list!.append(el));
}

export function toolUse(p: Proj, id: string, name: string, input: unknown, parent: string | null): void {
  const s = toolSummary(p, name, input);
  if (parent) {
    const line = h('div', { class: 'sub-step' }, ledgerCall(s));
    p.toolCards.set(id, line);
    return nestUnder(p, parent, line);
  }
  const card = h(
    'details',
    { class: `tool tool-${name.toLowerCase()} pending`, dataset: { tool: name } },
    h(
      'summary',
      {},
      h('span', { class: 'tool-line' }, h('span', { class: 'bullet', 'aria-hidden': 'true' }), ledgerCall(s)),
      h('span', { class: 'tool-result' }, h('span', { class: 'elbow', 'aria-hidden': 'true' }, '⎿'), h('span', { class: 'tool-result-text' }, 'Running…')),
    ),
    h('pre', { class: 'tool-input' }, JSON.stringify(input, null, 2)),
  );
  p.toolCards.set(id, card);
  appendEntry(p, card);
}

export function toolResult(p: Proj, toolUseId: string, isError: boolean, preview: string): void {
  const card = p.toolCards.get(toolUseId);
  if (!card) return;
  card.classList.remove('pending');
  card.classList.toggle('failed', isError);
  if (card.tagName !== 'DETAILS') return;
  const text = card.querySelector('.tool-result-text');
  if (text) text.textContent = isError ? `Error: ${firstLine(preview)}` : resultLine(card.dataset.tool ?? '', preview);
  if (preview.trim()) {
    card.append(h('pre', { class: 'tool-output' }, preview));
    if (isError) (card as HTMLDetailsElement).open = true;
  }
}

export function permissionRequest(p: Proj, id: string, toolName: string, input: unknown, reason?: string): void {
  p.pending.add(id);
  const s = toolSummary(p, toolName, input);
  const decide = (decision: 'allow' | 'always' | 'deny') => {
    send({ type: 'permissionReply', project: p.dir, id, decision });
    markAnswered(p, id, decision === 'deny' ? 'Denied' : decision === 'always' ? 'Allowed for this session' : 'Allowed once');
  };
  const card = h(
    'div',
    { class: 'permission', role: 'group', 'aria-label': `The agent wants to use ${toolName}` },
    h('p', { class: 'permission-title' }, `The agent wants to use ${toolName}`),
    s.detail ? h('code', { class: 'permission-detail' }, s.detail) : null,
    reason ? h('p', { class: 'permission-reason' }, reason) : null,
    h(
      'div',
      { class: 'permission-actions' },
      h('button', { class: 'button primary', type: 'button', onclick: () => decide('allow') }, 'Allow once'),
      h('button', { class: 'button', type: 'button', onclick: () => decide('always') }, 'Allow for session'),
      h('button', { class: 'button quiet', type: 'button', onclick: () => decide('deny') }, 'Deny'),
    ),
  );
  p.permissionCards.set(id, card);
  appendEntry(p, card);
  if (p === active && !p.replaying) card.querySelector<HTMLButtonElement>('button')?.focus();
}

export function markAnswered(p: Proj, id: string, outcome: string): void {
  p.pending.delete(id);
  const card = p.permissionCards.get(id);
  if (card && !card.classList.contains('answered')) {
    card.classList.add('answered');
    card.querySelector('.permission-actions')?.replaceChildren(h('span', { class: 'permission-outcome' }, outcome));
  }
  p.permissionCards.delete(id);
  renderProjects();
}

export function notice(p: Proj, level: 'info' | 'warn' | 'error', text: string): void {
  appendEntry(p, h('div', { class: `notice ${level}`, role: level === 'error' && !p.replaying ? 'alert' : undefined }, text));
}

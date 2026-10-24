import type { McpEntry, McpScope, SidecarEvent, TaskStart } from '../../sidecar/src/protocol';
import { submit } from './app';
import { $, h } from './dom';
import { field, openProviderDialog } from './providers';
import { active, load, projects, providerList, send, store } from './state';
import { notificationsOn, setNotifications } from './notify';
import { renderAccounts, wireAccounts } from './accounts';

// ---------- settings ----------

export type Theme = 'system' | 'light' | 'dark';

export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
applyTheme((load('slop-factory:theme') as Theme | null) ?? 'system');

export let mcpList: McpEntry[] = [];
export let mcpEditing: McpEntry | undefined;
export let mcpChanged = false;
export let mcpPending = false; // a save or removal is on its way

export const SCOPE_LABEL: Record<McpScope, string> = { user: 'All my projects', project: 'This project, shared', local: 'This project, just me' };

export function openSettings(): void {
  mcpChanged = false;
  closeMcpForm();
  renderSettings();
  send({ type: 'listMcp', project: active?.dir });
  send({ type: 'listAccounts' });
  $<HTMLDialogElement>('settings-dialog').showModal();
}

export function mcpSummary(c: Record<string, unknown>): string {
  if (typeof c.url === 'string') return `${String(c.type ?? 'http').toUpperCase()} ${c.url}`;
  return [c.command, ...(Array.isArray(c.args) ? c.args : [])].map((x) => String(x)).join(' ');
}

export function renderSettings(): void {
  const p = active;
  const theme = (load('slop-factory:theme') as Theme | null) ?? 'system';
  $('theme-picker').querySelectorAll<HTMLInputElement>('input').forEach((r) => (r.checked = r.value === theme));
  $<HTMLInputElement>('notify-toggle').checked = notificationsOn();
  const globalStart = load('slop-factory:task-start') ?? 'current';
  $<HTMLSelectElement>('task-start').value = globalStart;
  // A project can start its tasks differently from the default.
  $('task-start-project-row').hidden = !p;
  if (p) {
    $('task-start-project-label').textContent = `In ${p.name}`;
    const words = $<HTMLSelectElement>('task-start').selectedOptions[0]?.textContent?.toLowerCase() ?? 'the current conversation';
    $('task-start-default').textContent = `The default (${words})`;
    $<HTMLSelectElement>('task-start-project').value = p.taskStart ?? '';
  }
  renderAccounts();
  $('model-for').textContent = p ? `The model ${p.name} uses. Switching starts a new conversation there.` : 'Open a project to choose its model.';
  $('local-models').replaceChildren(
    ...providerList
      .filter((x) => x.kind !== 'subscription')
      .map((x) =>
        h(
          'li',
          {},
          h('span', { class: 'settings-item-main' }, h('strong', {}, x.name), h('span', { class: 'muted' }, `${x.model} at ${x.baseUrl}`)),
          h('button', { class: 'button quiet', type: 'button', onclick: () => openProviderDialog(x) }, 'Edit'),
        ),
      ),
  );
  $('mcp-restart').hidden = !(p && mcpChanged);
  const scopes: McpScope[] = p ? ['user', 'project', 'local'] : ['user'];
  const groups = scopes
    .map((scope) => ({ scope, list: mcpList.filter((m) => m.scope === scope) }))
    .filter((g) => g.list.length)
    .map((g) =>
      h(
        'div',
        { class: 'mcp-group' },
        h('h4', {}, SCOPE_LABEL[g.scope]),
        h(
          'ul',
          { class: 'settings-list' },
          ...g.list.map((m) =>
            h(
              'li',
              {},
              h('span', { class: 'settings-item-main' }, h('strong', {}, m.name), h('code', { class: 'muted' }, mcpSummary(m.config))),
              h('button', { class: 'button quiet', type: 'button', onclick: () => openMcpForm(m) }, 'Edit'),
              h(
                'button',
                {
                  class: 'button quiet danger',
                  type: 'button',
                  onclick: () => {
                    if (!confirm(`Remove the MCP server ${m.name}?`)) return;
                    mcpPending = true;
                    send({ type: 'removeMcp', project: p?.dir, name: m.name, scope: m.scope });
                  },
                },
                'Remove',
              ),
            ),
          ),
        ),
      ),
    );
  $('mcp-list').replaceChildren(...(groups.length ? groups : [h('p', { class: 'settings-note' }, p ? 'No MCP servers yet.' : 'No MCP servers for all projects yet. Open a project to see its own.')]));
}

export const mcpForm = () => $<HTMLFormElement>('mcp-form');
export const mcpField = (name: string) => mcpForm().elements.namedItem(name) as HTMLInputElement;

export function updateMcpForm(): void {
  const transport = (mcpForm().querySelector('input[name=transport]:checked') as HTMLInputElement).value;
  const stdio = transport === 'stdio';
  $('mcp-command-field').hidden = !stdio;
  $('mcp-url-field').hidden = stdio;
  mcpField('command').required = stdio;
  mcpField('url').required = !stdio;
  $('mcp-pairs-label').replaceChildren(stdio ? 'Environment variables ' : 'Headers ', h('small', {}, stdio ? '(one KEY=value per line)' : '(one Name: value per line)'));
}

export const quoteArg = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(a) : a);

export function openMcpForm(existing?: McpEntry): void {
  mcpEditing = existing;
  const form = mcpForm();
  form.reset();
  $('mcp-error').hidden = true;
  (form.elements.namedItem('scope') as HTMLSelectElement).querySelectorAll('option').forEach((o) => (o.disabled = !active && o.value !== 'user'));
  if (existing) {
    const c = existing.config;
    mcpField('name').value = existing.name;
    (form.elements.namedItem('scope') as HTMLSelectElement).value = existing.scope;
    const transport = typeof c.url === 'string' ? String(c.type ?? 'http') : 'stdio';
    form.querySelectorAll<HTMLInputElement>('input[name=transport]').forEach((r) => (r.checked = r.value === transport));
    if (transport === 'stdio') mcpField('command').value = [String(c.command ?? ''), ...(Array.isArray(c.args) ? c.args.map(String) : [])].map(quoteArg).join(' ');
    else mcpField('url').value = String(c.url);
    const pairs = (transport === 'stdio' ? c.env : c.headers) as Record<string, string> | undefined;
    (form.elements.namedItem('pairs') as HTMLTextAreaElement).value = Object.entries(pairs ?? {})
      .map(([k, v]) => (transport === 'stdio' ? `${k}=${v}` : `${k}: ${v}`))
      .join('\n');
  } else (form.elements.namedItem('scope') as HTMLSelectElement).value = active ? 'local' : 'user';
  updateMcpForm();
  form.hidden = false;
  $('mcp-add').hidden = true;
  mcpField('name').focus();
}

export function closeMcpForm(): void {
  mcpEditing = undefined;
  mcpForm().hidden = true;
  $('mcp-add').hidden = false;
}

export function splitCommand(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]));
}

export function wireSettings(): void {
  const dialog = $<HTMLDialogElement>('settings-dialog');
  $('open-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => dialog.close());
  $('theme-picker').addEventListener('change', (ev) => {
    const theme = (ev.target as HTMLInputElement).value as Theme;
    store('slop-factory:theme', theme === 'system' ? null : theme);
    applyTheme(theme);
  });
  wireAccounts();
  $('add-local-model').addEventListener('click', () => openProviderDialog());
  $('notify-toggle').addEventListener('change', (ev) => setNotifications((ev.target as HTMLInputElement).checked));
  $('task-start').addEventListener('change', (ev) => {
    const mode = (ev.target as HTMLSelectElement).value;
    store('slop-factory:task-start', mode === 'current' ? null : mode);
    renderSettings();
  });
  $('task-start-project').addEventListener('change', (ev) => {
    if (!active) return;
    const mode = (ev.target as HTMLSelectElement).value as TaskStart | '';
    active.taskStart = mode || null;
    send({ type: 'setProjectTaskStart', project: active.dir, mode: mode || null });
  });
  $('fetch-minutes').addEventListener('change', (ev) => send({ type: 'gitSettings', fetchMinutes: Number((ev.target as HTMLSelectElement).value) }));
  $('mcp-add').addEventListener('click', () => openMcpForm());
  $('mcp-cancel').addEventListener('click', closeMcpForm);
  $('mcp-restart').addEventListener('click', () => {
    if (!active) return;
    send({ type: 'restartSession', project: active.dir });
    mcpChanged = false;
    renderSettings();
  });
  mcpForm().addEventListener('change', updateMcpForm);
  mcpForm().addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = mcpForm();
    if (!form.reportValidity()) return;
    const transport = (form.querySelector('input[name=transport]:checked') as HTMLInputElement).value;
    const pairs: Record<string, string> = {};
    for (const line of (form.elements.namedItem('pairs') as HTMLTextAreaElement).value.split('\n')) {
      const at = transport === 'stdio' ? line.indexOf('=') : line.search(/[:=]/);
      if (at > 0) pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const has = Object.keys(pairs).length > 0;
    let config: Record<string, unknown>;
    if (transport === 'stdio') {
      const [command, ...args] = splitCommand(mcpField('command').value.trim());
      config = { type: 'stdio', command, args, ...(has ? { env: pairs } : {}) };
    } else config = { type: transport, url: mcpField('url').value.trim(), ...(has ? { headers: pairs } : {}) };
    mcpPending = true;
    send({
      type: 'saveMcp',
      project: active?.dir,
      server: { name: mcpField('name').value.trim(), scope: (form.elements.namedItem('scope') as HTMLSelectElement).value as McpScope, config },
      previous: mcpEditing ? { name: mcpEditing.name, scope: mcpEditing.scope } : undefined,
    });
  });
}

export function onMcpServers(e: Extract<SidecarEvent, { type: 'mcpServers' }>): void {
  if ((e.project ?? undefined) !== active?.dir) return;
  mcpList = e.list;
  if (mcpPending) {
    mcpPending = false;
    if (e.error) {
      $('mcp-error').textContent = e.error;
      $('mcp-error').hidden = false;
    } else {
      mcpChanged = true;
      closeMcpForm();
    }
  }
  renderSettings();
}

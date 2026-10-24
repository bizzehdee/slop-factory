import type { ProcessInfo } from '../../sidecar/src/protocol';
import { openProject } from './app';
import { renderTasks } from './board';
import { closeDocs, docsView, planOpen, planRel, togglePlan } from './docs';
import { $, ICON_CLOSE, elapsed, h, svgIcon } from './dom';
import { MenuItem, closeMenu, submenu } from './menus';
import { newProjectDialog } from './newproject';
import { renderQuestions } from './questions';
import { openSettings } from './settings';
import { Proj, active, editorList, load, projects, providerList, providerOf, send, setActive, store } from './state';
import { refreshWorktrees, renderWorktrees } from './worktrees';

// ---------- projects list ----------

export function projectState(p: Proj): { cls: string; label: string } {
  if (p.pending.size) return { cls: 'needs-you', label: 'Needs you' };
  if (p.busy) return { cls: 'working', label: 'Working' };
  const live = p.processes.filter((x) => ['running', 'pending', 'paused'].includes(x.status) && !x.ambient).length;
  if (live) return { cls: 'background', label: `${live} running` };
  return { cls: 'idle', label: p.unseen ? 'New reply' : '' };
}

export function renderProjects(): void {
  const list = $('project-list');
  const all = [...projects.values()];
  if (!all.length) return void list.replaceChildren(h('li', { class: 'muted small no-projects' }, 'No projects open.'));
  list.replaceChildren(
    ...all.map((p, i) => {
      const st = projectState(p);
      const closeBtn = h('button', { class: 'project-close', type: 'button', 'aria-label': `Close ${p.name}`, title: 'Close project' });
      closeBtn.append(svgIcon(ICON_CLOSE));
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeProject(p);
      });
      return h(
        'li',
        { class: `project-item ${st.cls}${p === active ? ' active' : ''}${p.unseen && p !== active ? ' unseen' : ''}` },
        h(
          'button',
          {
            class: 'project-switch',
            type: 'button',
            'aria-current': p === active ? 'true' : undefined,
            title: `${p.dir}${i < 9 ? `  (Ctrl+${i + 1})` : ''}`,
            onclick: () => activate(p),
          },
          h('span', { class: 'project-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'project-title' }, p.name),
          st.label ? h('span', { class: 'project-state' }, st.label) : null,
        ),
        closeBtn,
      );
    }),
  );
}

// ---------- processes & session ----------

export const KIND_LABEL: Record<string, string> = { shell: 'Shell', monitor: 'Monitor', subagent: 'Subagent', workflow: 'Workflow', other: 'Task' };

export function renderProcesses(): void {
  const el = $('processes');
  const p = active;
  if (!p) {
    el.replaceChildren();
    $('proc-summary').textContent = '';
    return;
  }
  const live = p.processes.filter((x) => ['running', 'pending', 'paused'].includes(x.status));
  const ended = p.processes.filter((x) => !live.includes(x));
  $('proc-summary').textContent = live.length ? String(live.length) : '';

  const row = (x: ProcessInfo, isLive: boolean) =>
    h(
      'li',
      { class: `proc ${x.kind} ${isLive ? 'live' : 'ended'} status-${x.status}${x.ambient ? ' ambient' : ''}` },
      h(
        'div',
        { class: 'proc-head' },
        h('span', { class: 'proc-kind' }, KIND_LABEL[x.kind] ?? x.rawType),
        h('span', { class: 'proc-time', dataset: { start: String(x.startedAt) } }, elapsed(x.startedAt, x.endedAt)),
        isLive
          ? h('button', { class: 'button tiny quiet', type: 'button', title: `Stop ${x.description}`, onclick: () => send({ type: 'stopProcess', project: p.dir, id: x.id }) }, 'Stop')
          : h('span', { class: 'proc-status' }, x.status),
      ),
      h('div', { class: 'proc-desc' }, x.description),
      x.command && x.command !== x.description ? h('code', { class: 'proc-cmd' }, x.command) : null,
      x.summary || x.lastTool ? h('div', { class: 'proc-summary' }, x.summary ?? `Last used ${x.lastTool}`) : null,
    );

  const parts: HTMLElement[] = [
    live.length
      ? h('ul', { class: 'proc-list' }, ...live.map((x) => row(x, true)))
      : h('p', { class: 'muted small' }, 'Nothing running. Background shells, monitors and subagents show up here.'),
  ];
  if (ended.length) parts.push(h('details', { class: 'finished' }, h('summary', {}, `Finished (${ended.length})`), h('ul', { class: 'proc-list' }, ...ended.map((x) => row(x, false)))));
  const wasOpen = el.querySelector<HTMLDetailsElement>('details.finished')?.open;
  el.replaceChildren(...parts);
  if (wasOpen) el.querySelector<HTMLDetailsElement>('details.finished')!.open = true;
}

setInterval(() => {
  document.querySelectorAll<HTMLElement>('.proc.live .proc-time').forEach((t) => (t.textContent = elapsed(Number(t.dataset.start))));
}, 1000);

export function loginLabel(src: string): { text: string; ok: boolean } {
  if (src === 'oauth') return { text: 'Claude subscription', ok: true };
  if (src === 'none') return { text: 'Claude login', ok: true };
  return { text: `API key (${src})`, ok: false };
}

export function renderSession(): void {
  const dl = $('session');
  const p = active;
  const fw = p?.framework;
  const s = p?.session;
  const rows: [string, Node | string][] = [];

  if (fw) {
    const shadowed = fw.agentsMd && fw.claudeMd.length > 0 && !fw.claudeMdImportsAgents;
    rows.push([
      'Rules',
      fw.agentsMd
        ? h('span', { class: shadowed ? 'warn-text' : '' }, shadowed ? `AGENTS.md is ignored: ${fw.claudeMd[0]} takes priority and doesn't reference it` : 'AGENTS.md')
        : fw.claudeMd.length
          ? fw.claudeMd.join(', ')
          : h('span', { class: 'muted' }, 'No AGENTS.md or CLAUDE.md'),
    ]);
    const claudeSkills = fw.skills.length;
    const agentSkills = fw.agentsSkills.length;
    if (agentSkills || claudeSkills) {
      rows.push([
        'Standards',
        agentSkills && !claudeSkills
          ? `${agentSkills} in .agents/skills, loaded through the AGENTS.md table`
          : `${claudeSkills} skills the agent can load on its own${agentSkills ? `, ${agentSkills} in .agents/skills` : ''}`,
      ]);
    }
    if (fw.hooks.length) rows.push(['Hooks', fw.hooks.join(', ')]);
    if (fw.agents.length) rows.push(['Agents', fw.agents.join(', ')]);
  }
  if (p) {
    const prov = providerOf(p);
    const local = prov.kind !== 'subscription';
    const edit = h('button', { class: 'link-button', type: 'button', onclick: openSettings }, 'Change');
    rows.push(['Provider', h('span', {}, local ? `${prov.name} at ${prov.baseUrl}` : prov.name, ' ', edit)]);
    if (local) rows.push(['Billing', 'Local model, no Anthropic usage']);
  }
  if (s) {
    const login = loginLabel(s.apiKeySource);
    rows.push(['Model', s.model]);
    if (providerOf(p!).kind === 'subscription') rows.push(['Billing', h('span', { class: login.ok ? '' : 'warn-text' }, login.text)]);
    if (s.mcpServers.length) rows.push(['MCP', s.mcpServers.map((m) => `${m.name} (${m.status})`).join(', ')]);
  }
  if (p?.lastTurn) rows.push(['Last turn', `${(p.lastTurn.durationMs / 1000).toFixed(1)}s, ${p.lastTurn.outputTokens.toLocaleString()} tokens out`]);
  if (p && !s) rows.push(['', h('span', { class: 'muted' }, 'The agent starts with your first message.')]);
  dl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

export function closeProject(p: Proj): void {
  const working = p.busy || p.processes.some((x) => x.status === 'running');
  if (working && !confirm(`The agent is still working in ${p.name}. Close it and stop that work?`)) return;
  send({ type: 'close', project: p.dir });
}

export function projectMenu(p: Proj): MenuItem[] {
  const editors: MenuItem[] = editorList.length
    ? editorList.map((e) => ({ label: e.name, run: () => send({ type: 'openWith', project: p.dir, editor: e.id }) }))
    : [{ label: 'No editors found', disabled: true }];
  const items: MenuItem[] = [
    { label: 'Open directory', run: () => send({ type: 'openFolder', project: p.dir }) },
    { label: 'Open with', submenu: editors },
    {
      label: 'New conversation',
      run: () => {
        if (p.busy && !confirm(`The agent is working in ${p.name}. Stop it and start a new conversation?`)) return;
        send({ type: 'restartSession', project: p.dir, fresh: true });
      },
    },
  ];
  if (planRel(p)) items.push({ label: 'Show plan', run: () => togglePlan(p) });
  items.push({ label: 'Copy path', run: () => void navigator.clipboard?.writeText(p.dir) });
  items.push({ label: 'Close project', run: () => closeProject(p) });
  return items;
}

export function renderHeader(): void {
  const p = active;
  $('project-header').hidden = !p;
  if (!p) return void (document.title = 'Slop Factory');
  // With a plan.md the name opens it as the project summary.
  const plan = planRel(p);
  $('project-name').replaceChildren(
    plan
      ? h('button', { class: 'project-name-button', type: 'button', title: `Show ${plan}`, 'aria-expanded': String(planOpen(p)), 'aria-controls': 'docs-panel', onclick: () => togglePlan(p) }, p.name)
      : p.name,
  );
  $('project-path').textContent = `‎${p.dir}‎`;
  $('project-path').title = p.dir;
  const fw = p.framework;
  $('framework-badge').textContent = fw?.agentsMd ? (fw.agentsSkills.length ? `AGENTS.md with ${fw.agentsSkills.length} standards` : 'AGENTS.md') : '';
  document.title = `${p.name} – Slop Factory`;
}

// Claude Code's working indicator cycles through these glyphs.
export const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
export let spinnerTimer: number | undefined;

export function renderComposer(): void {
  const p = active;
  const prompt = $<HTMLTextAreaElement>('prompt');
  const hasText = prompt.value.trim().length > 0;
  prompt.disabled = !p;
  prompt.placeholder = p ? `Message the agent about ${p.name}` : 'Open a project to start';
  const mode = $<HTMLSelectElement>('permission-mode');
  mode.disabled = !p;
  // Auto mode's safety checks run on Anthropic's servers, so it needs the Claude subscription.
  const autoOption = mode.querySelector<HTMLOptionElement>('option[value=auto]')!;
  const local = !!p && providerOf(p).kind !== 'subscription';
  autoOption.disabled = local;
  autoOption.textContent = local ? 'Auto mode (needs Claude subscription)' : 'Auto mode';
  if (p) mode.value = p.mode;
  mode.title =
    p?.mode === 'auto'
      ? 'Routine actions are approved automatically; risky ones ask first'
      : p?.mode === 'bypassPermissions'
        ? 'Every action runs without asking (--dangerously-skip-permissions). Auto mode is the safer hands-off choice.'
        : 'How the agent asks before acting';
  const prov = $<HTMLSelectElement>('provider');
  prov.disabled = !p;
  prov.replaceChildren(...providerList.map((x) => h('option', { value: x.id }, x.name)));
  prov.value = p?.providerId ?? 'subscription';
  const busy = !!p?.busy;
  $('stop').hidden = !busy;
  $('send').hidden = busy && !hasText;
  $<HTMLButtonElement>('send').disabled = !p || !hasText;

  const act = $('activity');
  act.hidden = !busy;
  $('activity-text').textContent = p?.status === 'compacting' ? 'Compacting conversation…' : 'Working…';
  const spin = act.querySelector<HTMLElement>('.spinner')!;
  if (busy && spinnerTimer === undefined && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let n = 0;
    spinnerTimer = window.setInterval(() => (spin.textContent = SPINNER[n++ % SPINNER.length]), 120);
  } else if (!busy && spinnerTimer !== undefined) {
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }
}

export function renderWelcome(): void {
  const host = $('transcripts');
  const existing = host.querySelector('.welcome');
  if (projects.size) return void existing?.remove();
  if (!existing) {
    host.append(
      h(
        'div',
        { class: 'empty welcome' },
        h('p', {}, 'Create or open a project to start. The agent picks up its AGENTS.md, skills and settings, and its task.md shows up on the left.'),
        h(
          'div',
          { class: 'welcome-actions' },
          h('button', { class: 'button primary', type: 'button', onclick: newProjectDialog }, 'New project'),
          h('button', { class: 'button', type: 'button', onclick: () => void openProject() }, 'Open a folder'),
        ),
      ),
    );
  }
}

export function renderAll(): void {
  renderProjects();
  renderHeader();
  renderTasks();
  renderQuestions();
  renderProcesses();
  renderWorktrees();
  renderSession();
  renderComposer();
  renderWelcome();
}

export function activate(p: Proj | undefined): void {
  const prompt = $<HTMLTextAreaElement>('prompt');
  if (active) active.draft = prompt.value;
  for (const x of projects.values()) x.transcript.hidden = x !== p;
  setActive(p);
  if (p) {
    p.unseen = false;
    prompt.value = p.draft;
    store('slop-factory:active', p.dir);
    requestAnimationFrame(() => (p.transcript.scrollTop = p.transcript.scrollHeight));
    if (docsView && docsView.project !== p.dir) closeDocs();
    refreshWorktrees(p);
  } else {
    prompt.value = '';
    closeDocs();
  }
  closeMenu(false);
  renderAll();
  if (p) prompt.focus();
}

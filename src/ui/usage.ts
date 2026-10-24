import type { Gauge, Gauges, PlanLimit } from '../../sidecar/src/protocol';
import { docsView, setDocsView } from './docs';
import { $, h } from './dom';
import { Proj, providerOf, send } from './state';

// ---------- what each project has used, and how close the subscription is to its limits ----------

export let planLimit: PlanLimit | undefined;
export const setPlanLimit = (l: PlanLimit) => (planLimit = l);

// The subscription's windows are the account's, whichever project last reported them.
export let accountLimits: Pick<Gauges, 'fiveHour' | 'week'> = {};
export function noteGauges(p: Proj, g: Gauges): void {
  p.gauges = g;
  if (g.fiveHour || g.week) accountLimits = { fiveHour: g.fiveHour ?? accountLimits.fiveHour, week: g.week ?? accountLimits.week };
}

/** The gauge for a window: reported directly, or else from the agent's latest limit notice. */
function windowGauge(which: 'five_hour' | 'seven_day'): Gauge | undefined {
  const direct = which === 'five_hour' ? accountLimits.fiveHour : accountLimits.week;
  if (direct) return direct;
  if (planLimit?.window === which && planLimit.utilization != null) return { used: planLimit.utilization, resetsAt: planLimit.resetsAt ? planLimit.resetsAt * 1000 : undefined };
  return undefined;
}

function resets(t?: number): string {
  if (!t) return '';
  const d = new Date(t);
  const soon = t - Date.now() < 20 * 3_600_000;
  return `Resets ${soon ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function gauge(label: string, used: number | undefined, value: string, note: string): HTMLElement {
  const pct = used == null ? undefined : Math.round(Math.min(1, Math.max(0, used)) * 100);
  const level = pct == null ? '' : pct >= 90 ? ' full' : pct >= 75 ? ' high' : '';
  return h(
    'div',
    {
      class: `gauge${level}`,
      role: 'meter',
      'aria-label': label,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': pct ?? null,
      'aria-valuetext': `${value}${note ? `, ${note}` : ''}`,
    },
    h('div', { class: 'gauge-head' }, h('span', { class: 'gauge-label' }, label), h('span', { class: 'gauge-value' }, value)),
    h('div', { class: 'gauge-track' }, h('div', { class: 'gauge-fill', style: `width: ${pct ?? 0}%` })),
    note ? h('div', { class: 'gauge-note' }, note) : '',
  );
}

/** 5-hour and weekly limits on the subscription, and how full the conversation's context is. */
export function renderGauges(p: Proj | undefined): void {
  const host = $('gauges');
  const rows: HTMLElement[] = [];
  if (p && !isLocal(p)) {
    for (const [which, label] of [['five_hour', '5-hour limit'], ['seven_day', 'Weekly limit']] as const) {
      const g = windowGauge(which);
      if (g) rows.push(gauge(label, g.used, `${Math.round(g.used * 100)}%`, resets(g.resetsAt)));
    }
  }
  const c = p?.gauges?.context;
  if (p && c) {
    const used = c.max ? c.tokens / c.max : undefined;
    const value = c.max ? `${tokens(c.tokens)} / ${tokens(c.max)}` : `${tokens(c.tokens)} tokens`;
    const server = providerOf(p).kind === 'ollama' ? 'Ollama' : providerOf(p).kind === 'llamacpp' ? 'llama.cpp' : 'the server';
    const note = !isLocal(p) ? (used != null && used >= 0.75 ? 'Older messages get summarised as it fills' : '') : c.fromServer ? `Window size from ${server}` : `${server} didn’t say how big its window is`;
    rows.push(gauge('Context', used, value, note));
  }
  host.hidden = !rows.length;
  host.replaceChildren(...rows);
}

const WINDOW: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly',
  overage: 'extra usage',
};

export const money = (n: number) => (n >= 100 ? `$${Math.round(n)}` : n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : '<$0.01');
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const isLocal = (p: Proj) => providerOf(p).kind !== 'subscription';

/** "Today $1.20 · 48k tokens", or tokens alone for a local model, which costs nothing. */
export function usageSummary(p: Proj): string | undefined {
  const u = p.usage;
  if (!u?.total.turns) return undefined;
  const t = u.today;
  const all = u.total.inputTokens + u.total.outputTokens + u.total.cacheReadTokens + u.total.cacheWriteTokens;
  const today = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  if (isLocal(p)) return `Today ${tokens(today)} tokens · ${tokens(all)} all told`;
  return `Today ${money(t.costUsd)} · ${money(u.total.costUsd)} all told`;
}

export function limitText(l: PlanLimit): string {
  // A limit this version doesn't know by name is just "your usage limit".
  const win = (l.window && WINDOW[l.window]) || 'usage';
  const used = l.utilization != null ? `${Math.round(l.utilization * 100)}% of your ${win} limit used` : l.status === 'rejected' ? `${win} limit reached` : `Within your ${win} limit`;
  const reset = l.resetsAt ? `, resets ${new Date(l.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  return used + reset;
}

export function openUsage(p: Proj): void {
  setDocsView({ project: p.dir, key: 'usage', requestId: '', tab: '', docs: [], usage: true });
  renderUsageView(p);
  $('docs-panel').hidden = false;
  $('docs-close').focus();
}

export function renderUsageView(p: Proj | undefined): void {
  if (!p || !docsView?.usage) return;
  const u = p.usage;
  const local = isLocal(p);
  $('docs-tabs').hidden = true;
  $('docs-ref').textContent = 'Usage';
  $('docs-title').textContent = p.name;
  const body = $('docs-body');
  if (!u?.total.turns) {
    body.replaceChildren(h('div', { class: 'docs-empty' }, h('p', {}, 'Nothing used yet. Usage is counted from each finished turn, including subagents.')));
    $('docs-actions').hidden = true;
    return;
  }
  const t = u.total;
  const stat = (label: string, value: string, note?: string) => h('div', { class: 'usage-stat' }, h('span', { class: 'usage-value' }, value), h('span', { class: 'usage-label' }, label), note ? h('span', { class: 'usage-note' }, note) : '');
  const value = (d: { costUsd: number; tokens: number }) => (local ? d.tokens : d.costUsd);
  const peak = Math.max(...u.days.map(value), local ? 1 : 0.01);
  const fmt = (d: { costUsd: number; tokens: number }) => (local ? `${tokens(d.tokens)} tokens` : money(d.costUsd));
  body.replaceChildren(
    h(
      'div',
      { class: 'usage' },
      h(
        'div',
        { class: 'usage-stats' },
        local ? stat('tokens all told', tokens(t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens), 'Local model: no charges') : stat('all told', money(t.costUsd), 'Estimated; your subscription covers it'),
        stat('today', local ? tokens(u.today.inputTokens + u.today.outputTokens + u.today.cacheReadTokens + u.today.cacheWriteTokens) : money(u.today.costUsd), `${u.today.turns} turn${u.today.turns === 1 ? '' : 's'}`),
        stat('turns', String(t.turns), `${minutes(t.durationMs)} working`),
      ),
      h('h3', {}, 'Last 14 days'),
      h(
        'div',
        { class: 'usage-chart', role: 'img', 'aria-label': u.days.map((d) => `${d.date}: ${fmt(d)}`).join(', ') },
        ...u.days.map((d) =>
          h(
            'div',
            { class: 'usage-day', title: `${new Date(`${d.date}T12:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}: ${fmt(d)}, ${d.turns} turn${d.turns === 1 ? '' : 's'}` },
            h('div', { class: 'usage-bar', style: `height: ${value(d) ? Math.max(3, (value(d) / peak) * 100) : 0}%` }),
            h('span', { class: 'usage-date' }, String(Number(d.date.slice(8)))),
          ),
        ),
      ),
      h('h3', {}, 'Tokens'),
      h(
        'table',
        { class: 'usage-table' },
        h(
          'tbody',
          {},
          ...([
            ['Input', t.inputTokens],
            ['Output', t.outputTokens],
            ['Read from cache', t.cacheReadTokens],
            ['Written to cache', t.cacheWriteTokens],
          ] as [string, number][]).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v.toLocaleString()))),
        ),
      ),
      u.models.length > 1 || (u.models.length === 1 && !local)
        ? h(
            'div',
            {},
            h('h3', {}, 'By model'),
            h('table', { class: 'usage-table' }, h('tbody', {}, ...u.models.map((m) => h('tr', {}, h('th', {}, m.model), h('td', {}, local ? `${tokens(m.tokens)} tokens` : `${money(m.costUsd)} · ${tokens(m.tokens)} tokens`))))),
          )
        : '',
      u.since ? h('p', { class: 'docs-path' }, `Counted since ${new Date(u.since).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}.`) : '',
    ),
  );
  const actions = $('docs-actions');
  actions.hidden = false;
  actions.replaceChildren(
    h(
      'button',
      {
        class: 'button quiet',
        type: 'button',
        onclick: () => {
          if (confirm(`Start counting ${p.name}'s usage from zero?`)) send({ type: 'resetUsage', project: p.dir });
        },
      },
      'Reset',
    ),
  );
}

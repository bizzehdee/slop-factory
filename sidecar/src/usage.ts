import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configDir } from './names.js';
import type { ProjectUsage, UsageTotals } from './protocol.js';

// What each project has used: cost, tokens, turns and time, all told and by day and model, kept
// in ~/.slop-factory/usage.json so it survives restarts. A session's result carries running totals
// for the whole conversation, so each turn adds the difference from the last totals seen for that
// conversation; those are kept too, so a conversation picked up after a restart isn't counted twice.

export interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

interface Snapshot {
  costUsd: number;
  models: Record<string, ModelTotals>;
  at: number;
}

interface ProjectLedger {
  since: string;
  total: UsageTotals;
  days: Record<string, UsageTotals>;
  models: Record<string, { costUsd: number; tokens: number }>;
}

interface Ledger {
  projects: Record<string, ProjectLedger>;
  sessions: Record<string, Snapshot>;
}

const DAYS_SHOWN = 14;
const SESSIONS_KEPT = 200;

const zero = (): UsageTotals => ({ costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0 });
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function add(into: UsageTotals, d: UsageTotals): void {
  for (const k of Object.keys(into) as (keyof UsageTotals)[]) into[k] += d[k];
}

/** This turn's share of a conversation's running totals. A drop means the totals were reset (/clear). */
export function turnDelta(prev: Snapshot | undefined, costUsd: number, models: Record<string, ModelTotals>): { cost: number; models: Record<string, ModelTotals> } {
  const reset = !prev || costUsd < prev.costUsd || Object.entries(models).some(([m, u]) => prev.models[m] && u.outputTokens < prev.models[m].outputTokens);
  const base = reset ? undefined : prev;
  const out: Record<string, ModelTotals> = {};
  for (const [m, u] of Object.entries(models)) {
    const b = base?.models[m];
    out[m] = {
      inputTokens: u.inputTokens - (b?.inputTokens ?? 0),
      outputTokens: u.outputTokens - (b?.outputTokens ?? 0),
      cacheReadInputTokens: u.cacheReadInputTokens - (b?.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: u.cacheCreationInputTokens - (b?.cacheCreationInputTokens ?? 0),
      costUSD: u.costUSD - (b?.costUSD ?? 0),
    };
  }
  return { cost: Math.max(0, costUsd - (base?.costUsd ?? 0)), models: out };
}

export class UsageLedger {
  private ledger: Ledger = { projects: {}, sessions: {} };
  private loaded?: Promise<void>;
  constructor(private file = path.join(configDir(), 'usage.json')) {}

  private load(): Promise<void> {
    return (this.loaded ??= fs
      .readFile(this.file, 'utf8')
      .then((raw) => {
        const j = JSON.parse(raw);
        this.ledger = { projects: j.projects ?? {}, sessions: j.sessions ?? {} };
      })
      .catch(() => undefined));
  }

  private writing = Promise.resolve();

  /** Writes go one after another, so two projects finishing at once can't interleave them. */
  private save(): Promise<void> {
    const keep = Object.entries(this.ledger.sessions).sort((a, b) => b[1].at - a[1].at).slice(0, SESSIONS_KEPT);
    this.ledger.sessions = Object.fromEntries(keep);
    const text = JSON.stringify(this.ledger) + '\n';
    this.writing = this.writing
      .then(() => fs.mkdir(path.dirname(this.file), { recursive: true }))
      .then(() => fs.writeFile(this.file, text, 'utf8'))
      .catch(() => undefined);
    return this.writing;
  }

  /** Add a finished turn from its conversation's running totals; returns the project's usage. */
  async record(dir: string, sessionId: string, costUsd: number, models: Record<string, ModelTotals>, durationMs: number, now = Date.now()): Promise<ProjectUsage> {
    await this.load();
    const { cost, models: delta } = turnDelta(this.ledger.sessions[sessionId], costUsd, models);
    this.ledger.sessions[sessionId] = { costUsd, models, at: now };
    const turn = zero();
    turn.costUsd = cost;
    turn.turns = 1;
    turn.durationMs = durationMs;
    const proj = (this.ledger.projects[dir] ??= { since: new Date(now).toISOString(), total: zero(), days: {}, models: {} });
    for (const [m, u] of Object.entries(delta)) {
      turn.inputTokens += u.inputTokens;
      turn.outputTokens += u.outputTokens;
      turn.cacheReadTokens += u.cacheReadInputTokens;
      turn.cacheWriteTokens += u.cacheCreationInputTokens;
      const pm = (proj.models[m] ??= { costUsd: 0, tokens: 0 });
      pm.costUsd += u.costUSD;
      pm.tokens += u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
    }
    add(proj.total, turn);
    add((proj.days[day(now)] ??= zero()), turn);
    await this.save();
    return this.view(dir, now);
  }

  async get(dir: string, now = Date.now()): Promise<ProjectUsage> {
    await this.load();
    return this.view(dir, now);
  }

  async reset(dir: string, now = Date.now()): Promise<ProjectUsage> {
    await this.load();
    delete this.ledger.projects[dir];
    await this.save();
    return this.view(dir, now);
  }

  private view(dir: string, now: number): ProjectUsage {
    const proj = this.ledger.projects[dir];
    const days: ProjectUsage['days'] = [];
    for (let i = DAYS_SHOWN - 1; i >= 0; i--) {
      const date = day(now - i * 86_400_000);
      const d = proj?.days[date] ?? zero();
      days.push({ date, costUsd: d.costUsd, tokens: d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWriteTokens, turns: d.turns });
    }
    return {
      since: proj?.since,
      total: proj ? { ...proj.total } : zero(),
      today: proj?.days[day(now)] ? { ...proj.days[day(now)] } : zero(),
      days,
      models: Object.entries(proj?.models ?? {})
        .map(([model, v]) => ({ model, ...v }))
        .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    };
  }
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ActionItem, ItemAction } from './protocol.js';

// Prompts sent to Claude when you press a board button. Override any of them in
// .claude-desk.json under "prompts". Placeholders: {ref} {title} {file} {specPath}
// {summaryPath} {docs} {where}. They lean on the project's own standards (AGENTS.md and the
// task-tracking standard) rather than restating them. {where} says where the work runs, from
// whereNow or whereSubagent; a start prompt without it gets it added at the end.
export const DEFAULT_PROMPTS: Record<string, string> = {
  startTask:
    'Start work on {ref} ({title}) from {file}.\n\n' +
    '{where} Follow AGENTS.md and the task-tracking standard: investigate first, write {specPath} ' +
    'before any other change, and write {summaryPath} when the work ends.',
  startBug:
    'Start fixing {ref} ({title}) from {file}.\n\n' +
    '{where} Follow AGENTS.md and the task-tracking standard: diagnose by elimination, write ' +
    '{specPath} before changing code, fix it with a regression test, and write {summaryPath} when ' +
    'the work ends.',
  startLegacyTask:
    'Start work on {ref} ({title}) from {file}.\n\n' +
    "{where} Follow AGENTS.md and the task's own entry in {file}: read its References first, then " +
    'build exactly its Deliverable within its Scope until every Acceptance criterion is met. Mark it ' +
    '[~] while you work and [x] only when it is done and its tests pass.',
  startPhase:
    'Work through {ref} ({title}), {file}.\n\n' +
    '{where} Follow AGENTS.md and the task-tracking standard: take its open tasks in order, ' +
    'respecting their dependencies, and give each one its spec before changing code and its ' +
    'summary when it is done.',
  startLegacySection:
    'Work through the "{title}" section of {file}.\n\n' +
    "{where} Follow AGENTS.md and each task's own entry: take the section's open tasks in order, " +
    'respecting Depends on, read their References first, and meet every Acceptance criterion. Mark ' +
    'each [~] while you work and [x] only when it is done and its tests pass.',
  whereNow: 'Do it here in this conversation.',
  whereSubagent:
    'Run it in a background subagent with worktree isolation (the Agent tool with isolation: ' +
    '"worktree"), so it works on its own copy of the repository in parallel with anything else ' +
    'going on here. When it finishes, tell me its branch and what changed so I can review and ' +
    'merge it.',
  reinvestigate:
    'Re-investigate {ref} ({title}) from {file}.\n\n' +
    'Run it in a background subagent. Read {docs}, check the code still does what that work ' +
    'delivered, and run the tests that cover it. Report what you find without changing code. ' +
    'If something is wrong, propose a new task or bug the way the task-tracking standard says.',
  summarise:
    'Summarise the work done on {ref} ({title}) from {file}. Use {docs} if they exist, plus the ' +
    'git history and the code. Keep it short, and do not edit any files.',
};

export interface DeskPrompts {
  [k: string]: string;
}

function startKey(item: ActionItem): string {
  if (item.kind === 'bug') return 'startBug';
  if (item.kind === 'phase') return item.legacy ? 'startLegacySection' : 'startPhase';
  return item.legacy ? 'startLegacyTask' : 'startTask';
}

export function promptFor(action: ItemAction, item: ActionItem, prompts: DeskPrompts): string {
  const pick = (key: string) => prompts[key] ?? DEFAULT_PROMPTS[key];
  // Spec and summary names exist only for "T<n>" / "B<n>" ids (the current standard).
  const num = /^[TB](\d+)$/.exec(item.id ?? '')?.[1];
  const kindWord = item.kind === 'bug' ? 'BUG' : 'TASK';
  const specPath = item.spec ?? (num ? `specs/spec-${kindWord}-${num}.md` : 'its spec');
  const summaryPath = item.summary ?? (num ? `summaries/summary-${kindWord}-${num}.md` : 'its summary');
  const docs =
    item.kind === 'phase'
      ? item.legacy ? `the entries in its section of ${item.rel}` : `its phase document ${item.rel} and its tasks' specs and summaries`
      : item.legacy
        ? [`its entry in ${item.rel}`, item.spec, item.summary].filter(Boolean).join(' and ')
        : [item.spec, item.summary].filter(Boolean).join(' and ') || 'its spec and summary';

  const starting = action === 'start' || action === 'startSubagent';
  let template = pick(starting ? startKey(item) : action);
  // Overrides written before {where} existed still say where the work runs.
  if (starting && !template.includes('{where}')) template += '\n\n{where}';
  const values: Record<string, string> = {
    ref: item.kind === 'phase' ? (item.phase ? `phase ${item.phase}` : `the "${item.title}" section`) : item.id ?? `the task "${item.title}"`,
    title: item.title,
    file: item.rel,
    specPath,
    summaryPath,
    docs,
    where: action === 'startSubagent' ? pick('whereSubagent') : action === 'start' ? pick('whereNow') : '',
  };
  return template.replace(/\{(\w+)\}/g, (all, k: string) => values[k] ?? all);
}

/** Priority order for a project, kept in .claude-desk/priorities.json beside your code. */
export class Priorities {
  private order: string[] = [];
  private file: string;

  constructor(root: string) {
    this.file = path.join(root, '.claude-desk', 'priorities.json');
  }

  async load(): Promise<string[]> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.order = Array.isArray(raw.order) ? raw.order.filter((k: unknown) => typeof k === 'string') : [];
    } catch {
      this.order = [];
    }
    return this.order;
  }

  list(): string[] {
    return [...this.order];
  }

  /** Add to the end of the queue, or remove if already there. */
  async toggle(key: string): Promise<string[]> {
    this.order = this.order.includes(key) ? this.order.filter((k) => k !== key) : [...this.order, key];
    return this.save();
  }

  /** Take an item off the queue, e.g. once it has started. */
  async remove(key: string): Promise<string[]> {
    if (!this.order.includes(key)) return this.list();
    this.order = this.order.filter((k) => k !== key);
    return this.save();
  }

  private async save(): Promise<string[]> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ order: this.order }, null, 2) + '\n', 'utf8');
    return this.list();
  }
}

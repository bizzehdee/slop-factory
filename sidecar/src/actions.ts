import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ActionItem, ItemAction } from './protocol.js';

// Prompts sent to Claude when you press a board button. Override any of them in
// .claude-desk.json under "prompts". Placeholders: {ref} {title} {file} {specPath}
// {summaryPath} {docs}. They lean on the project's own standards (AGENTS.md and the
// task-tracking standard) rather than restating them.
export const DEFAULT_PROMPTS: Record<string, string> = {
  startTask:
    'Start work on {ref} ({title}) from {file}.\n\n' +
    'Run it in a background subagent so this conversation stays free. Follow AGENTS.md and the ' +
    'task-tracking standard: investigate first, write {specPath} before any other change, and ' +
    'write {summaryPath} when the work ends.',
  startBug:
    'Start fixing {ref} ({title}) from {file}.\n\n' +
    'Run it in a background subagent so this conversation stays free. Follow AGENTS.md and the ' +
    'task-tracking standard: diagnose by elimination, write {specPath} before changing code, fix ' +
    'it with a regression test, and write {summaryPath} when the work ends.',
  startLegacyTask:
    'Start work on {ref} ({title}) from {file}.\n\n' +
    'Run it in a background subagent so this conversation stays free. Follow AGENTS.md and the ' +
    "task's own entry in {file}: read its References first, then build exactly its Deliverable " +
    'within its Scope until every Acceptance criterion is met. Mark it [~] while you work and [x] ' +
    'only when it is done and its tests pass.',
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

export function promptFor(action: ItemAction, item: ActionItem, prompts: DeskPrompts): string {
  // Spec and summary names exist only for "T<n>" / "B<n>" ids (the current standard).
  const num = /^[TB](\d+)$/.exec(item.id ?? '')?.[1];
  const kindWord = item.kind === 'bug' ? 'BUG' : 'TASK';
  const specPath = item.spec ?? (num ? `specs/spec-${kindWord}-${num}.md` : 'its spec');
  const summaryPath = item.summary ?? (num ? `summaries/summary-${kindWord}-${num}.md` : 'its summary');
  const docs = item.legacy
    ? [`its entry in ${item.rel}`, item.spec, item.summary].filter(Boolean).join(' and ')
    : [item.spec, item.summary].filter(Boolean).join(' and ') || 'its spec and summary';

  const key = action === 'start' ? (item.kind === 'bug' ? 'startBug' : item.legacy ? 'startLegacyTask' : 'startTask') : action;
  const template = prompts[key] ?? DEFAULT_PROMPTS[key];
  const values: Record<string, string> = {
    ref: item.id ?? `the task "${item.title}"`,
    title: item.title,
    file: item.rel,
    specPath,
    summaryPath,
    docs,
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
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ order: this.order }, null, 2) + '\n', 'utf8');
    return this.list();
  }
}

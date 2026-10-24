import type { ActionItem, BugEntry, PhaseRow, TaskFile, TaskItem, TaskState } from '../../sidecar/src/protocol';
import { phaseStatusClass } from './board';
import { Proj } from './state';

// ---------- board model ----------

export interface BoardItem extends ActionItem {
  state: TaskState | 'bug';
  status?: string; // bugs
  line: number;
  text?: string; // tasks: the raw line text, for toggling
  docLinks: { label: string; rel: string }[];
  hasDetails?: boolean;
  dependsOn?: string[];
  blockedBy?: string[];
  section?: string; // tasks: the heading they sit under (an older TASK.md's sections are its phases)
}

export const isSpec = (l: { label: string; rel: string }) => /spec/i.test(l.label) || /(^|\/)spec[-_]/i.test(l.rel);
export const isSummary = (l: { label: string; rel: string }) => /summar/i.test(l.label) || /(^|\/)summary[-_]/i.test(l.rel);

export function conventionDoc(p: Proj, kind: 'spec' | 'summary', item: { kind: 'task' | 'bug'; id?: string }): string | undefined {
  // Only "T<n>" / "B<n>" ids have standard spec and summary names.
  const num = /^[TB](\d+)$/.exec(item.id ?? '')?.[1];
  if (!num) return undefined;
  const rel = `${kind === 'spec' ? 'specs/spec' : 'summaries/summary'}-${item.kind === 'bug' ? 'BUG' : 'TASK'}-${num}.md`;
  return p.docs.has(rel) ? rel : undefined;
}

/** A doc counts when its file exists: linked from the item first, then the standard's file name. */
export function resolveDocs(p: Proj, base: { kind: 'task' | 'bug'; id?: string }, links: { label: string; rel: string }[]) {
  const linkedSpec = links.find(isSpec)?.rel;
  const linkedSummary = links.find(isSummary)?.rel;
  return {
    spec: (linkedSpec && p.docs.has(linkedSpec) ? linkedSpec : undefined) ?? conventionDoc(p, 'spec', base) ?? linkedSpec,
    summary: (linkedSummary && p.docs.has(linkedSummary) ? linkedSummary : undefined) ?? conventionDoc(p, 'summary', base) ?? linkedSummary,
  };
}

export function taskItem(p: Proj, file: TaskFile, t: TaskItem): BoardItem {
  return {
    key: t.id ?? `${file.rel}#${t.title}`,
    kind: 'task',
    id: t.id,
    title: t.title || t.text,
    rel: file.rel,
    phase: file.phaseNumber,
    done: t.state === 'done',
    state: t.state,
    line: t.line,
    text: t.text,
    docLinks: t.links,
    legacy: file.kind === 'legacy',
    hasDetails: t.hasDetails,
    dependsOn: t.dependsOn,
    blockedBy: t.blockedBy,
    section: t.section,
    ...resolveDocs(p, { kind: 'task', id: t.id }, t.links),
  };
}

export function bugItem(p: Proj, file: TaskFile, b: BugEntry): BoardItem {
  return {
    key: b.id,
    kind: 'bug',
    id: b.id,
    title: b.title,
    rel: file.rel,
    done: b.status === 'fixed' || b.status === "won't fix",
    state: 'bug',
    status: b.status,
    line: b.line,
    docLinks: b.links,
    ...resolveDocs(p, { kind: 'bug', id: b.id }, b.links),
  };
}

// Phases (and older TASK.md sections) can be queued and started like tasks.

export const PHASE_PREFIX = /^Phase\s+\d+\s*[:\-–]\s*/i;

export function phaseDocFor(row: PhaseRow, phases: TaskFile[]): TaskFile | undefined {
  return (row.doc && phases.find((ph) => ph.rel === row.doc)) || phases.find((ph) => ph.phaseNumber === row.number);
}

export function phaseItem(row: PhaseRow, doc: TaskFile | undefined, indexRel: string): BoardItem {
  const cls = phaseStatusClass(row.status);
  return {
    key: `P${row.number}`,
    kind: 'phase',
    title: doc?.title.replace(PHASE_PREFIX, '') || row.goal || `Phase ${row.number}`,
    rel: doc?.rel ?? indexRel,
    phase: row.number,
    done: cls === 'done' || cls === 'dropped',
    state: cls === 'done' ? 'done' : cls === 'doing' ? 'doing' : cls === 'dropped' ? 'cancelled' : 'todo',
    line: 0,
    docLinks: doc ? [{ label: 'Phase', rel: doc.rel }] : [],
  };
}

export interface LegacySection {
  name: string;
  items: TaskItem[];
}

export function legacySections(file: TaskFile): LegacySection[] {
  const sections: LegacySection[] = [];
  for (const it of file.items) {
    const name = it.section ?? 'Tasks';
    let sec = sections[sections.length - 1];
    if (!sec || sec.name !== name) sections.push((sec = { name, items: [] }));
    sec.items.push(it);
  }
  return sections;
}

export function legacyStatus(items: TaskItem[]): string {
  const top = items.filter((i) => i.depth === 0 && i.state !== 'cancelled');
  if (top.length && top.every((i) => i.state === 'done')) return 'done';
  if (items.some((i) => i.state === 'done' || i.state === 'doing')) return 'in progress';
  return 'planned';
}

export function sectionItem(file: TaskFile, sec: LegacySection): BoardItem {
  const status = legacyStatus(sec.items);
  return {
    key: `section:${sec.name}`,
    kind: 'phase',
    title: sec.name,
    rel: file.rel,
    legacy: true,
    done: status === 'done',
    state: status === 'done' ? 'done' : status === 'in progress' ? 'doing' : 'todo',
    line: 0,
    docLinks: [],
  };
}

/** The short label shown before an item's title: T5, B2, P2. */
export const itemRef = (it: BoardItem) => it.id ?? (it.kind === 'phase' ? (it.phase ? `P${it.phase}` : '§') : '');

export function allItems(p: Proj): Map<string, BoardItem> {
  const map = new Map<string, BoardItem>();
  const index = p.tasks.find((f) => f.kind === 'index');
  const phases = p.tasks.filter((f) => f.kind === 'phase');
  for (const row of index?.phases ?? []) {
    const it = phaseItem(row, phaseDocFor(row, phases), index!.rel);
    map.set(it.key, it);
  }
  for (const f of p.tasks) {
    if (f.kind === 'legacy') for (const sec of legacySections(f)) {
      const it = sectionItem(f, sec);
      map.set(it.key, it);
    }
    if (f.kind === 'phase' || f.kind === 'other' || f.kind === 'legacy') for (const t of f.items) {
      const it = taskItem(p, f, t);
      map.set(it.key, it);
    }
    if (f.kind === 'bugs') for (const b of f.bugs ?? []) {
      const it = bugItem(p, f, b);
      map.set(it.key, it);
    }
  }
  return map;
}

export const toActionItem = (b: BoardItem): ActionItem => ({
  key: b.key,
  kind: b.kind,
  id: b.id,
  title: b.title,
  rel: b.rel,
  phase: b.phase,
  done: b.done,
  legacy: b.legacy,
  spec: b.spec,
  summary: b.summary,
});

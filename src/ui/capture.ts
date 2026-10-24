import { legacySections, phaseDocFor } from './board-model';
import { planRel } from './docs';
import { $, h } from './dom';
import { closeMenu, menuAnchor, openMenu } from './menus';
import { Proj, active, send } from './state';

// ---------- quick capture: a task, bug or open question added straight to the project's files ----------

type Kind = 'task' | 'bug' | 'question';
let kind: Kind = 'task';

const form = () => $<HTMLFormElement>('capture-form');
const field = <T extends HTMLElement = HTMLInputElement>(name: string) => form().elements.namedItem(name) as unknown as T;

/** Where a new task can go: each phase document, or an older TASK.md's sections. */
function taskPlaces(p: Proj): { value: string; label: string }[] {
  const legacy = p.tasks.find((f) => f.kind === 'legacy');
  if (legacy) return legacySections(legacy).map((s) => ({ value: `${legacy.rel}|${s.name}`, label: s.name }));
  const index = p.tasks.find((f) => f.kind === 'index');
  const phases = p.tasks.filter((f) => f.kind === 'phase');
  return (index?.phases ?? [])
    .map((row) => ({ row, doc: phaseDocFor(row, phases) }))
    .filter((x) => x.doc)
    .map(({ row, doc }) => ({ value: doc!.rel, label: `Phase ${row.number}: ${doc!.title.replace(/^Phase\s+\d+\s*[:\-–]\s*/i, '') || row.goal}` }));
}

/** Where an open question can go: the plan, its section documents, the phase documents. */
function questionPlaces(p: Proj): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const plan = planRel(p);
  if (plan) out.push({ value: plan, label: `${plan} (the whole project)` });
  for (const rel of new Set(p.docQuestions.map((q) => q.rel).filter((r) => r.startsWith('docs/')))) out.push({ value: rel, label: rel });
  for (const f of p.tasks.filter((x) => x.kind === 'phase')) out.push({ value: f.rel, label: f.title });
  return out;
}

export function openCapture(p: Proj, what: Kind): void {
  kind = what;
  form().reset();
  const places = what === 'task' ? taskPlaces(p) : what === 'question' ? questionPlaces(p) : [];
  $('capture-title').textContent = what === 'task' ? 'Add a task' : what === 'bug' ? 'Report a bug' : 'Add an open question';
  $('capture-text-label').textContent = what === 'task' ? 'What it delivers' : what === 'bug' ? 'What goes wrong' : 'The question';
  $('capture-where-label').textContent = what === 'task' ? 'Phase' : 'Document';
  $('capture-where-field').hidden = what === 'bug';
  $('capture-details-field').hidden = what !== 'bug';
  field<HTMLSelectElement>('where').replaceChildren(...places.map((x) => h('option', { value: x.value }, x.label)));
  $('capture-note').textContent =
    what === 'task' && !places.length
      ? 'This project has no phase documents yet. Ask the agent to plan its phases first.'
      : what === 'question' && !places.length
        ? 'This project has no plan.md or phase documents to hold questions yet.'
        : what === 'task'
          ? 'It gets the next free task number, and a line in the phase’s revision history.'
          : what === 'bug'
            ? 'It goes in tasks/bugs.md with the next bug number, marked open.'
            : 'It goes under the document’s Open questions.';
  ($('capture-dialog') as HTMLDialogElement).showModal();
  field('title').focus();
}

export function captureMenu(p: Proj) {
  return [
    { label: 'Add a task…', run: () => openCapture(p, 'task') },
    { label: 'Report a bug…', run: () => openCapture(p, 'bug') },
    { label: 'Add an open question…', run: () => openCapture(p, 'question') },
  ];
}

export function wireCapture(): void {
  const dialog = $('capture-dialog') as HTMLDialogElement;
  $('capture-cancel').addEventListener('click', () => dialog.close());
  $('capture').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const b = $('capture');
    if (menuAnchor === b) return closeMenu();
    if (active) openMenu(b, captureMenu(active));
  });
  form().addEventListener('submit', (ev) => {
    ev.preventDefault();
    const p = active;
    if (!p || !form().reportValidity()) return;
    const where = field<HTMLSelectElement>('where').value;
    if (kind !== 'bug' && !where) return;
    const [rel, section] = where.split('|');
    send({ type: 'capture', project: p.dir, kind, title: field('title').value, rel: kind === 'bug' ? undefined : rel, section, details: field<HTMLTextAreaElement>('details').value });
    dialog.close();
  });
}

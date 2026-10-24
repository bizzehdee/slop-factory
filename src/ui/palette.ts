import { openProject } from './app';
import { allItems } from './board-model';
import { revealItem } from './board';
import { openCapture } from './capture';
import { activate } from './chrome';
import { planRel, showDoc } from './docs';
import { $, h } from './dom';
import { newProjectDialog } from './newproject';
import { openQuestion, openRows, questionTitle } from './questions';
import { openSettings } from './settings';
import { Proj, active, projects } from './state';
import { findWorkstreams, openWorkstreams, workstreamFile } from './workstreams';

// ---------- Ctrl+K: find a project, task, bug, phase, question, document or message, and go to it ----------

interface Hit {
  kind: string; // the badge: Project, Task, Bug, Phase, Question, Document, Message, Action
  label: string;
  detail?: string;
  haystack: string;
  run: () => void;
}

const MAX = 40;
let hits: Hit[] = [];
let at = 0;

const dialog = () => $<HTMLDialogElement>('palette');
const input = () => $<HTMLInputElement>('palette-input');

/** Go to a project first, then to something in it. */
const inProject = (p: Proj, run: () => void) => () => {
  if (active !== p) activate(p);
  run();
};

function flashMessage(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function actions(): Hit[] {
  const list: Hit[] = [
    { kind: 'Action', label: 'New project…', haystack: 'new project create', run: newProjectDialog },
    { kind: 'Action', label: 'Open a folder…', haystack: 'open folder project', run: () => void openProject() },
    { kind: 'Action', label: 'Settings', haystack: 'settings theme model mcp servers notifications', run: openSettings },
  ];
  const p = active;
  if (p) {
    const plan = planRel(p);
    if (plan) list.push({ kind: 'Action', label: 'Show the plan', detail: plan, haystack: 'plan show summary', run: () => showDoc(p, plan, p.name, 'Plan') });
    list.push(
      { kind: 'Action', label: workstreamFile(p) ? 'Run workstreams…' : 'Find workstreams', haystack: 'workstreams parallel agents streams', run: () => (workstreamFile(p) ? openWorkstreams(p) : findWorkstreams(p)) },
      { kind: 'Action', label: 'Add a task…', haystack: 'add task new capture', run: () => openCapture(p, 'task') },
      { kind: 'Action', label: 'Report a bug…', haystack: 'report bug add new capture', run: () => openCapture(p, 'bug') },
      { kind: 'Action', label: 'Add an open question…', haystack: 'add open question new capture', run: () => openCapture(p, 'question') },
    );
  }
  return list.map((x) => ({ ...x, haystack: `${x.label} ${x.haystack}`.toLowerCase() }));
}

function everything(): Hit[] {
  const out: Hit[] = [];
  // The active project's things come first.
  const ordered = [...projects.values()].sort((a, b) => Number(b === active) - Number(a === active));
  for (const p of ordered) {
    if (p !== active) out.push({ kind: 'Project', label: p.name, detail: p.dir, haystack: `${p.name} ${p.dir}`.toLowerCase(), run: () => activate(p) });
    const where = projects.size > 1 ? p.name : undefined;
    for (const it of allItems(p).values()) {
      const kind = it.kind === 'phase' ? 'Phase' : it.kind === 'bug' ? 'Bug' : 'Task';
      const label = `${it.id ? `${it.id}: ` : ''}${it.title}`;
      out.push({ kind, label, detail: [it.done ? 'done' : '', where].filter(Boolean).join(' · ') || undefined, haystack: `${kind} ${label}`.toLowerCase(), run: inProject(p, () => revealItem(p, it.key)) });
    }
    for (const q of openRows(p)) {
      const label = questionTitle(q.text);
      out.push({ kind: 'Question', label, detail: q.source?.rel ?? where, haystack: `question ${q.text}`.toLowerCase(), run: inProject(p, () => openQuestion(p, q.id)) });
    }
    for (const rel of [...p.docs].sort()) {
      out.push({ kind: 'Document', label: rel, detail: where, haystack: `document ${rel}`.toLowerCase(), run: inProject(p, () => showDoc(p, rel, rel)) });
    }
    for (const el of p.transcript.querySelectorAll<HTMLElement>('.msg.user, .msg.assistant')) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push({ kind: el.classList.contains('user') ? 'You said' : 'Reply', label: text.slice(0, 120), detail: where, haystack: text.toLowerCase(), run: inProject(p, () => flashMessage(el)) });
    }
  }
  return out;
}

/** Every word typed must appear; labels that start with the query rank first. */
function search(query: string): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...actions(), ...[...projects.values()].filter((p) => p !== active).map((p) => ({ kind: 'Project', label: p.name, detail: p.dir, haystack: '', run: () => activate(p) }))];
  const words = q.split(/\s+/);
  const scored: { hit: Hit; score: number }[] = [];
  for (const hit of [...actions(), ...everything()]) {
    if (!words.every((w) => hit.haystack.includes(w))) continue;
    const label = hit.label.toLowerCase();
    const score = (label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2) + (hit.kind === 'You said' || hit.kind === 'Reply' ? 3 : 0);
    scored.push({ hit, score });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, MAX).map((x) => x.hit);
}

function render(): void {
  hits = search(input().value);
  if (at >= hits.length) at = 0;
  const list = $('palette-results');
  list.replaceChildren(
    ...(hits.length
      ? hits.map((x, i) =>
          h(
            'li',
            {
              id: `palette-${i}`,
              role: 'option',
              class: 'palette-item',
              'aria-selected': String(i === at),
              onmousedown: (ev: MouseEvent) => ev.preventDefault(),
              onclick: () => go(i),
              onmousemove: () => {
                if (at !== i) {
                  at = i;
                  highlight();
                }
              },
            },
            h('span', { class: 'palette-kind' }, x.kind),
            h('span', { class: 'palette-label' }, x.label),
            x.detail ? h('span', { class: 'palette-detail' }, x.detail) : '',
          ),
        )
      : [h('li', { class: 'palette-empty' }, 'Nothing matches.')]),
  );
  highlight();
}

function highlight(): void {
  $('palette-results')
    .querySelectorAll<HTMLElement>('.palette-item')
    .forEach((el, i) => el.setAttribute('aria-selected', String(i === at)));
  if (hits.length) input().setAttribute('aria-activedescendant', `palette-${at}`);
  else input().removeAttribute('aria-activedescendant');
  $('palette-results').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function go(i: number): void {
  const hit = hits[i];
  if (!hit) return;
  dialog().close();
  hit.run();
}

export function openPalette(): void {
  if (dialog().open) return dialog().close();
  input().value = '';
  at = 0;
  render();
  dialog().showModal();
  input().focus();
}

export function wirePalette(): void {
  input().addEventListener('input', () => {
    at = 0;
    render();
  });
  input().addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (hits.length) at = (at + (ev.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
      highlight();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      go(at);
    }
  });
  // A click on the backdrop closes it.
  dialog().addEventListener('click', (ev) => {
    if (ev.target === dialog()) dialog().close();
  });
}

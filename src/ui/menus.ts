import type { ItemAction } from '../../sidecar/src/protocol';
import { BoardItem, toActionItem } from './board-model';
import { showProgress } from './docs';
import { $, h } from './dom';
import { phaseTasks, prioritise, startPhase } from './queue';
import { Proj, send } from './state';

// ---------- menus ----------

export const menuEl = $('menu');
export let menuAnchor: HTMLElement | null = null;
export let submenu: { el: HTMLElement; parent: HTMLButtonElement } | null = null;

export interface MenuItem {
  label: string;
  run?: () => void;
  submenu?: MenuItem[];
  disabled?: boolean;
}

export function menuButton(it: MenuItem, inSubmenu: boolean): HTMLButtonElement {
  if (it.submenu) {
    const b = h(
      'button',
      { class: 'menu-item has-submenu', type: 'button', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      h('span', {}, it.label),
      h('span', { class: 'menu-caret', 'aria-hidden': 'true' }, '›'),
    ) as HTMLButtonElement;
    b.addEventListener('click', () => openSubmenu(b, it.submenu!, true));
    b.addEventListener('mouseenter', () => openSubmenu(b, it.submenu!, false));
    return b;
  }
  const b = h(
    'button',
    {
      class: 'menu-item',
      type: 'button',
      role: 'menuitem',
      disabled: it.disabled,
      onclick: () => {
        closeMenu();
        it.run?.();
      },
    },
    it.label,
  ) as HTMLButtonElement;
  if (!inSubmenu) b.addEventListener('mouseenter', closeSubmenu);
  return b;
}

export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenu(false);
  menuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  menuEl.replaceChildren(...items.map((it) => menuButton(it, false)));
  menuEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth;
  const mh = menuEl.offsetHeight;
  menuEl.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left))}px`;
  menuEl.style.top = `${r.bottom + mh + 8 > window.innerHeight ? r.top - mh - 4 : r.bottom + 4}px`;
  menuEl.querySelector<HTMLButtonElement>('button')?.focus();
}

/** A flyout beside its parent item: to the right, or to the left when there's no room. */
export function openSubmenu(parent: HTMLButtonElement, items: MenuItem[], focus: boolean): void {
  if (submenu?.parent !== parent) {
    closeSubmenu();
    const el = h('div', { class: 'menu submenu', role: 'menu' }, ...items.map((it) => menuButton(it, true)));
    document.body.append(el);
    el.addEventListener('keydown', (ev) => menuKeys(ev, el));
    submenu = { el, parent };
    parent.setAttribute('aria-expanded', 'true');
    const r = parent.getBoundingClientRect();
    const right = r.right + 4 + el.offsetWidth < window.innerWidth;
    el.style.left = `${right ? r.right + 4 : Math.max(8, r.left - el.offsetWidth - 4)}px`;
    el.style.top = `${Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, r.top - 4))}px`;
  }
  if (focus) submenu!.el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}

export function closeSubmenu(): void {
  if (!submenu) return;
  submenu.parent.setAttribute('aria-expanded', 'false');
  submenu.el.remove();
  submenu = null;
}

export function closeMenu(refocus = true): void {
  closeSubmenu();
  if (menuEl.hidden) return;
  menuEl.hidden = true;
  menuAnchor?.setAttribute('aria-expanded', 'false');
  if (refocus && menuAnchor?.isConnected) menuAnchor.focus();
  menuAnchor = null;
}

export function menuKeys(ev: KeyboardEvent, el: HTMLElement): void {
  const items = [...el.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)')];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  const current = items[i];
  const inSubmenu = el !== menuEl;
  if (ev.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
  else if (ev.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
  else if (ev.key === 'ArrowRight' && current?.classList.contains('has-submenu')) current.click();
  else if (inSubmenu && (ev.key === 'ArrowLeft' || ev.key === 'Escape')) {
    const parent = submenu?.parent;
    closeSubmenu();
    parent?.focus();
  } else if (ev.key === 'Escape' || ev.key === 'Tab') closeMenu();
  else return;
  ev.preventDefault();
  ev.stopPropagation();
}

menuEl.addEventListener('keydown', (ev) => menuKeys(ev, menuEl));
document.addEventListener('pointerdown', (ev) => {
  const t = ev.target as Node;
  if (!menuEl.hidden && !menuEl.contains(t) && !submenu?.el.contains(t) && !menuAnchor?.contains(t)) closeMenu(false);
});

export function progressLabel(item: BoardItem): string | undefined {
  if (item.kind === 'phase') return item.docLinks.length ? 'Show phase document' : undefined;
  return item.legacy && !item.spec && !item.summary ? 'Show details' : 'Show progress';
}

export const PRIORITISE_LABEL = 'Prioritise (start after current work)';

export function itemMenu(p: Proj, item: BoardItem): MenuItem[] {
  const queued = p.priorities.includes(item.key);
  const items: MenuItem[] = [];
  const progress = progressLabel(item);
  if (item.kind === 'phase' && !item.done) {
    // A phase starts as its open tasks, queued in order; each can come off the queue later.
    const tasks = phaseTasks(p, item);
    const inQueue = tasks.filter((t) => p.priorities.includes(t.key));
    items.push({ label: tasks.length ? 'Prioritise its tasks' : PRIORITISE_LABEL, run: () => prioritise(p, item) });
    items.push({ label: tasks.length > 1 ? 'Start now, queue the rest' : 'Start now', run: () => startPhase(p, item, 'main') });
    items.push({ label: tasks.length > 1 ? 'Start in subagent, queue the rest' : 'Start in subagent (own worktree)', run: () => startPhase(p, item, 'subagent') });
    if (inQueue.length) items.push({ label: `Remove its ${inQueue.length} queued task${inQueue.length > 1 ? 's' : ''}`, run: () => inQueue.forEach((t) => send({ type: 'togglePriority', project: p.dir, key: t.key })) });
    if (progress) items.push({ label: progress, run: () => showProgress(p, item) });
    return items;
  }
  if (!item.done) {
    items.push({ label: queued ? 'Remove from queue' : PRIORITISE_LABEL, run: () => prioritise(p, item) });
    items.push({ label: 'Start now', run: () => runAction(p, 'start', item) });
    items.push({ label: 'Start in subagent (own worktree)', run: () => runAction(p, 'startSubagent', item) });
    if (progress) items.push({ label: progress, run: () => showProgress(p, item) });
  } else {
    if (queued) items.push({ label: 'Remove from queue', run: () => prioritise(p, item) });
    if (progress) items.push({ label: progress, run: () => showProgress(p, item) });
    items.push({ label: 'Summarise work done', run: () => runAction(p, 'summarise', item) });
    if (item.kind !== 'phase') items.push({ label: 'Reinvestigate with a subagent', run: () => runAction(p, 'reinvestigate', item) });
  }
  return items;
}

export function runAction(p: Proj, action: ItemAction, item: BoardItem): void {
  if (action === 'start' || action === 'startSubagent') p.holdQueue = false;
  send({ type: 'runAction', project: p.dir, action, item: toActionItem(item) });
}

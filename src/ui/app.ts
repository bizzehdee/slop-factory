import { createBridge } from '../bridge';
import type { PermissionModeName } from '../../sidecar/src/protocol';
import { activate, projectMenu, renderAll, renderComposer } from './chrome';
import { closeDocs } from './docs';
import { $ } from './dom';
import { onEvent, pendingOpen, restoreActive, setPendingOpen, setRestoreActive } from './events';
import { wireLoginDialog } from './login';
import { MenuItem, closeMenu, menuAnchor, menuEl, openMenu } from './menus';
import { newProjectDialog, wireNewProjectDialog } from './newproject';
import { wireProviderDialog } from './providers';
import { wireSettings } from './settings';
import { active, bridge, load, projects, send, setBridge } from './state';
import { wireCapture } from './capture';
import { slashKey, takeAttachments, wireComposer } from './composer';
import { openPalette, wirePalette } from './palette';
import { wireGit } from './git';

export function addProjectMenu(): MenuItem[] {
  return [
    { label: 'New project…', run: newProjectDialog },
    { label: 'Open a folder…', run: () => void openProject() },
  ];
}

export async function openProject(dir?: string | null): Promise<void> {
  const picked = dir ?? (await bridge?.pickFolder());
  if (!picked) return;
  const clean = picked.replace(/[\\/]+$/, '');
  const known = projects.get(clean);
  if (known) return activate(known);
  setPendingOpen(clean);
  send({ type: 'open', projectDir: clean });
}

export function submit(): void {
  const prompt = $<HTMLTextAreaElement>('prompt');
  const text = prompt.value.trim();
  if (!active || (!text && !active.attachments.length)) return;
  const attachments = takeAttachments(active);
  send({ type: 'send', project: active.dir, text, ...(attachments.length ? { attachments } : {}) });
  prompt.value = '';
  active.draft = '';
  renderComposer();
}

export async function init(): Promise<void> {
  document.querySelectorAll('.app-version').forEach((el) => (el.textContent = `v${__APP_VERSION__}`));
  renderAll();
  const b = setBridge(await createBridge());
  b.onEvent(onEvent);
  send({ type: 'listEditors' });
  send({ type: 'checkAuth' });

  $('add-project').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const b = $('add-project');
    if (menuAnchor === b) return closeMenu();
    openMenu(b, addProjectMenu());
  });
  wireNewProjectDialog();
  wireLoginDialog();
  wireSettings();
  wireCapture();
  wireComposer();
  wirePalette();
  wireGit();
  $('open-palette').addEventListener('click', openPalette);
  $('composer').addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });
  $('prompt').addEventListener('input', renderComposer);
  $('prompt').addEventListener('keydown', (ev) => {
    if (slashKey(ev)) return;
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      submit();
    }
  });
  $('stop').addEventListener('click', () => {
    if (!active) return;
    // Stopping Claude also pauses the queue, so the next item doesn't start in its place.
    active.holdQueue = true;
    send({ type: 'interrupt', project: active.dir });
  });
  $('permission-mode').addEventListener('change', (ev) => {
    if (!active) return;
    active.mode = (ev.target as HTMLSelectElement).value as PermissionModeName;
    send({ type: 'setPermissionMode', project: active.dir, mode: active.mode });
  });
  $('docs-close').addEventListener('click', closeDocs);
  $('project-menu').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const b = $('project-menu');
    if (menuAnchor === b) return closeMenu();
    if (active) openMenu(b, projectMenu(active));
  });
  wireProviderDialog();

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('docs-panel').hidden && menuEl.hidden && !document.querySelector('dialog[open]')) closeDocs();
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && /^[1-9]$/.test(ev.key)) {
      const p = [...projects.values()][Number(ev.key) - 1];
      if (p) {
        ev.preventDefault();
        activate(p);
      }
    }
    if (mod && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      openPalette();
    }
    if (mod && ev.key.toLowerCase() === 'o') {
      ev.preventDefault();
      void openProject();
    }
  });

  // Reopen what was open last time. Projects still running in the sidecar replay their state.
  const fromUrl = new URLSearchParams(location.search).getAll('project');
  let saved: string[] = [];
  try {
    saved = JSON.parse(load('slop-factory:projects') ?? '[]');
  } catch {
    saved = [];
  }
  setRestoreActive(fromUrl.length ? fromUrl[fromUrl.length - 1] : load('slop-factory:active'));
  for (const dir of new Set([...saved, ...fromUrl])) send({ type: 'open', projectDir: dir });
}

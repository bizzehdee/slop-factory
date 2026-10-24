import type { SidecarEvent } from '../../sidecar/src/protocol';
import { openProject, submit } from './app';
import { $ } from './dom';
import { field } from './providers';
import { bridge, load, send, store } from './state';

// ---------- wiring ----------

// ---------- new project ----------

export let creating: string | undefined; // requestId of the project being created

export const kebab = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '');

export function newProjectDialog(): void {
  const dialog = $<HTMLDialogElement>('new-project-dialog');
  const form = $<HTMLFormElement>('new-project-form');
  form.reset();
  const parent = form.elements.namedItem('parent') as HTMLInputElement;
  parent.value = load('slop-factory:new-project-parent') ?? '';
  $('np-log').hidden = true;
  $('np-log').textContent = '';
  $('np-error').hidden = true;
  updateNewProject();
  dialog.showModal();
  (form.elements.namedItem('name') as HTMLInputElement).focus();
}

export function updateNewProject(): void {
  const form = $<HTMLFormElement>('new-project-form');
  const value = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
  const git = (form.elements.namedItem('git') as HTMLInputElement).checked;
  $('np-remote-field').hidden = !git;
  const folder = kebab(value('name'));
  const parent = value('parent').replace(/[\\/]+$/, '');
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  $('np-target').textContent = folder && parent ? `Creates ${parent}${sep}${folder}` : '';
}

export function wireNewProjectDialog(): void {
  const dialog = $<HTMLDialogElement>('new-project-dialog');
  const form = $<HTMLFormElement>('new-project-form');
  form.addEventListener('input', updateNewProject);
  $('np-cancel').addEventListener('click', () => dialog.close());
  $('np-browse').addEventListener('click', async () => {
    const picked = await bridge?.pickFolder();
    if (!picked) return;
    (form.elements.namedItem('parent') as HTMLInputElement).value = picked;
    updateNewProject();
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (creating || !form.reportValidity()) return;
    const value = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
    const git = (form.elements.namedItem('git') as HTMLInputElement).checked;
    creating = Math.random().toString(36).slice(2);
    store('slop-factory:new-project-parent', value('parent'));
    $('np-error').hidden = true;
    $('np-log').hidden = false;
    $('np-log').textContent = '';
    $<HTMLButtonElement>('np-create').disabled = true;
    $('np-create').textContent = 'Creating…';
    send({
      type: 'createProject',
      requestId: creating,
      request: {
        name: value('name'),
        parent: value('parent'),
        git,
        remote: git ? value('remote') || undefined : undefined,
        framework: (form.querySelector('input[name=framework]:checked') as HTMLInputElement).value as 'full' | 'basic' | 'none',
        description: (form.elements.namedItem('description') as HTMLTextAreaElement).value.trim() || undefined,
      },
    });
  });
}

export function onCreateEvent(e: Extract<SidecarEvent, { type: 'createProgress' | 'projectCreated' }>): void {
  if (e.requestId !== creating) return;
  const log = $('np-log');
  if (e.type === 'createProgress') {
    log.textContent += `${e.line}\n`;
    log.scrollTop = log.scrollHeight;
    return;
  }
  creating = undefined;
  $<HTMLButtonElement>('np-create').disabled = false;
  $('np-create').textContent = 'Create project';
  if (!e.ok || !e.dir) {
    $('np-error').textContent = e.error ?? "Couldn't create the project.";
    $('np-error').hidden = false;
    return;
  }
  $<HTMLDialogElement>('new-project-dialog').close();
  void openProject(e.dir);
}

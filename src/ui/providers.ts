import type { ProviderConfig } from '../../sidecar/src/protocol';
import { submit } from './app';
import { $, h } from './dom';
import { active, load, send } from './state';

// ---------- model providers ----------

export const PRESET: Record<string, { baseUrl: string; authToken: string }> = {
  ollama: { baseUrl: 'http://localhost:11434', authToken: 'ollama' },
  llamacpp: { baseUrl: 'http://127.0.0.1:8080', authToken: 'local' },
  custom: { baseUrl: 'http://127.0.0.1:4000', authToken: '' },
};
export let editing: ProviderConfig | undefined;
export let probeId = '';

export function providerForm(): HTMLFormElement {
  return $<HTMLFormElement>('provider-form');
}

export function field(name: string): HTMLInputElement {
  return providerForm().elements.namedItem(name) as HTMLInputElement;
}

export function openProviderDialog(existing?: ProviderConfig): void {
  editing = existing;
  const form = providerForm();
  form.reset();
  const kind = existing?.kind && existing.kind !== 'subscription' ? existing.kind : 'ollama';
  (form.querySelector(`input[name=kind][value=${kind}]`) as HTMLInputElement).checked = true;
  field('baseUrl').value = existing?.baseUrl ?? PRESET[kind].baseUrl;
  field('authToken').value = existing?.authToken ?? PRESET[kind].authToken;
  field('model').value = existing?.model ?? '';
  field('smallModel').value = existing?.smallModel ?? '';
  field('name').value = existing?.name ?? '';
  $('provider-dialog-title').textContent = existing ? `Edit ${existing.name}` : 'Use a local model';
  $('provider-delete').hidden = !existing;
  $('provider-save').textContent = existing ? 'Save' : 'Save and use';
  $('probe-status').textContent = '';
  $('provider-models').replaceChildren();
  $<HTMLDialogElement>('provider-dialog').showModal();
  probe();
}

export function probe(): void {
  probeId = Math.random().toString(36).slice(2);
  $('probe-status').textContent = 'Looking for models…';
  send({ type: 'probeProvider', requestId: probeId, baseUrl: field('baseUrl').value, authToken: field('authToken').value || undefined });
}

export function onProbe(requestId: string, ok: boolean, models: string[], error?: string): void {
  if (requestId !== probeId) return;
  $('provider-models').replaceChildren(...models.map((m) => h('option', { value: m })));
  if (!ok) $('probe-status').textContent = `${error ?? 'No answer.'} Check the server is running, or type the model name.`;
  else if (!models.length) $('probe-status').textContent = 'The server answered but listed no models. Pull or load one, or type its name.';
  else {
    $('probe-status').textContent = `Found ${models.length} model${models.length === 1 ? '' : 's'}: ${models.slice(0, 6).join(', ')}${models.length > 6 ? '…' : ''}`;
    if (!field('model').value) field('model').value = models[0];
  }
}

export function wireProviderDialog(): void {
  const dialog = $<HTMLDialogElement>('provider-dialog');
  const form = providerForm();
  form.querySelectorAll<HTMLInputElement>('input[name=kind]').forEach((r) =>
    r.addEventListener('change', () => {
      const preset = PRESET[r.value];
      const known = Object.values(PRESET).map((x) => x.baseUrl);
      if (!field('baseUrl').value || known.includes(field('baseUrl').value)) field('baseUrl').value = preset.baseUrl;
      if (!field('authToken').value || Object.values(PRESET).some((x) => x.authToken === field('authToken').value)) field('authToken').value = preset.authToken;
      probe();
    }),
  );
  field('baseUrl').addEventListener('change', probe);
  $('probe').addEventListener('click', probe);
  $('provider-cancel').addEventListener('click', () => dialog.close());
  $('provider-delete').addEventListener('click', () => {
    if (editing && confirm(`Delete ${editing.name}? Projects using it go back to your Claude subscription.`)) {
      send({ type: 'deleteProvider', id: editing.id });
      dialog.close();
    }
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!form.reportValidity()) return;
    const kind = (form.querySelector('input[name=kind]:checked') as HTMLInputElement).value as ProviderConfig['kind'];
    send({
      type: 'saveProvider',
      provider: {
        id: editing?.id ?? '',
        name: field('name').value,
        kind,
        baseUrl: field('baseUrl').value,
        authToken: field('authToken').value,
        model: field('model').value,
        smallModel: field('smallModel').value || undefined,
      },
      useFor: editing ? undefined : active?.dir,
    });
    dialog.close();
  });

  $('provider').addEventListener('change', (ev) => {
    const sel = ev.target as HTMLSelectElement;
    const p = active;
    if (!p) return;
    if (sel.value === p.providerId) return;
    const working = p.busy || p.processes.some((x) => x.status === 'running');
    if (working && !confirm(`Switching model restarts the agent in ${p.name} and stops what it's doing. Switch anyway?`)) {
      sel.value = p.providerId;
      return;
    }
    send({ type: 'setProvider', project: p.dir, providerId: sel.value });
  });
}

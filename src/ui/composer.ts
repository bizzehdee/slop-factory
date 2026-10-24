import type { Attachment, CommandInfo } from '../../sidecar/src/protocol';
import { renderComposer } from './chrome';
import { $, h, svgIcon, ICON_CLOSE } from './dom';
import { active, Proj } from './state';

// ---------- the message box: files added to a message, and the "/" command picker ----------

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE = 5 * 1024 * 1024; // the model's limit for one image
const MAX_PDF = 20 * 1024 * 1024;
const MAX_TEXT = 256 * 1024;

let attachError = '';

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A dropped, pasted or picked file as an attachment, or why it can't be one. */
async function readAttachment(file: File): Promise<Attachment | string> {
  const name = file.name || (file.type.startsWith('image/') ? `pasted.${file.type.split('/')[1]}` : 'file');
  if (IMAGE_TYPES.has(file.type)) {
    if (file.size > MAX_IMAGE) return `${name} is ${size(file.size)}; images can be up to ${size(MAX_IMAGE)}.`;
    return { name, kind: 'image', mediaType: file.type, data: base64(await file.arrayBuffer()) };
  }
  if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
    if (file.size > MAX_PDF) return `${name} is ${size(file.size)}; PDFs can be up to ${size(MAX_PDF)}.`;
    return { name, kind: 'pdf', mediaType: 'application/pdf', data: base64(await file.arrayBuffer()) };
  }
  if (file.size > MAX_TEXT) return `${name} is ${size(file.size)}; text files can be up to ${size(MAX_TEXT)}.`;
  const text = await file.text();
  // Anything else is attached as text, as long as it is text.
  if (text.includes('\u0000')) return `${name} isn't an image, a PDF or a text file, so it can't be attached.`;
  return { name, kind: 'text', mediaType: file.type || 'text/plain', data: text };
}

export async function addFiles(p: Proj, files: File[]): Promise<void> {
  const errors: string[] = [];
  for (const f of files) {
    const a = await readAttachment(f);
    if (typeof a === 'string') errors.push(a);
    else p.attachments.push(a);
  }
  attachError = errors.join(' ');
  if (p === active) renderComposer();
}

export function takeAttachments(p: Proj): Attachment[] {
  const list = p.attachments;
  p.attachments = [];
  attachError = '';
  return list;
}

export function renderAttachments(): void {
  const p = active;
  const host = $('attachments');
  const list = p?.attachments ?? [];
  host.hidden = !list.length && !attachError;
  host.replaceChildren(
    ...list.map((a, i) =>
      h(
        'span',
        { class: `attachment-chip ${a.kind}`, title: a.kind === 'text' ? `${a.name} · ${size(a.data.length)}` : a.name },
        a.kind === 'image' ? h('img', { src: `data:${a.mediaType};base64,${a.data}`, alt: '' }) : h('span', { class: 'attachment-kind' }, a.kind === 'pdf' ? 'PDF' : 'TXT'),
        h('span', { class: 'attachment-name' }, a.name),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': `Remove ${a.name}`,
            onclick: () => {
              p!.attachments.splice(i, 1);
              attachError = '';
              renderComposer();
              $('prompt').focus();
            },
          },
          svgIcon(ICON_CLOSE),
        ),
      ),
    ),
    attachError ? h('span', { class: 'attachment-error', role: 'alert' }, attachError) : '',
  );
}

// ---------- "/" picker ----------

let picks: CommandInfo[] = [];
let pickAt = 0;

/** The commands matching what's typed after "/", while the message is just a command name. */
function matches(p: Proj, value: string): CommandInfo[] {
  const m = /^\/(\S*)$/.exec(value);
  if (!m) return [];
  const q = m[1].toLowerCase();
  const known = p.commands.length ? p.commands : (p.session?.slashCommands ?? []).map((name) => ({ name, description: '' }));
  // Names that start with what's typed, then names that contain it, then (from three letters)
  // descriptions with a word that starts with it.
  const name = (c: CommandInfo) => c.name.toLowerCase();
  const starts = known.filter((c) => name(c).startsWith(q));
  const inName = known.filter((c) => !name(c).startsWith(q) && name(c).includes(q));
  const word = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  const inDesc = q.length >= 3 ? known.filter((c) => !name(c).includes(q) && word.test(c.description)) : [];
  return [...starts, ...inName, ...inDesc].slice(0, 12);
}

export function renderSlashMenu(): void {
  const p = active;
  const menu = $('slash-menu');
  const prompt = $<HTMLTextAreaElement>('prompt');
  picks = p && document.activeElement === prompt ? matches(p, prompt.value) : [];
  if (pickAt >= picks.length) pickAt = 0;
  menu.hidden = !picks.length;
  prompt.setAttribute('aria-expanded', String(!!picks.length));
  menu.replaceChildren(
    ...picks.map((c, i) =>
      h(
        'li',
        {
          id: `slash-${i}`,
          role: 'option',
          class: 'slash-item',
          'aria-selected': String(i === pickAt),
          onmousedown: (ev: MouseEvent) => {
            ev.preventDefault(); // keep the focus in the message box
            choose(i);
          },
        },
        h('span', { class: 'slash-name' }, `/${c.name}`),
        c.argumentHint ? h('span', { class: 'slash-hint' }, c.argumentHint) : '',
        c.description ? h('span', { class: 'slash-desc' }, c.description) : '',
      ),
    ),
  );
  if (picks.length) prompt.setAttribute('aria-activedescendant', `slash-${pickAt}`);
  else prompt.removeAttribute('aria-activedescendant');
  menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function choose(i: number): void {
  const c = picks[i];
  if (!c) return;
  const prompt = $<HTMLTextAreaElement>('prompt');
  prompt.value = `/${c.name} `;
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  picks = [];
  renderComposer();
}

/** Keys the picker takes while it's open; true when it handled the key. */
export function slashKey(ev: KeyboardEvent): boolean {
  if (!picks.length) return false;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    pickAt = (pickAt + (ev.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length;
    renderSlashMenu();
  } else if (ev.key === 'Enter' || ev.key === 'Tab') {
    // Enter on a complete command name sends it, as typed.
    const prompt = $<HTMLTextAreaElement>('prompt');
    if (ev.key === 'Enter' && picks[pickAt]?.name === prompt.value.slice(1)) return false;
    choose(pickAt);
  } else if (ev.key === 'Escape') {
    picks = [];
    $('slash-menu').hidden = true;
  } else return false;
  ev.preventDefault();
  ev.stopPropagation();
  return true;
}

// ---------- wiring ----------

export function wireComposer(): void {
  const prompt = $<HTMLTextAreaElement>('prompt');
  const form = $('composer');
  const input = $<HTMLInputElement>('attach-input');
  $('attach').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (active && input.files?.length) void addFiles(active, [...input.files]);
    input.value = '';
    prompt.focus();
  });
  prompt.addEventListener('paste', (ev) => {
    const files = [...(ev.clipboardData?.files ?? [])];
    // Copied text often comes with a picture of itself; the text is what's meant.
    if (!active || !files.length || ev.clipboardData?.types.includes('text/plain')) return;
    ev.preventDefault();
    void addFiles(active, files);
  });
  const dragging = (ev: DragEvent) => !!active && !!ev.dataTransfer?.types.includes('Files');
  form.addEventListener('dragover', (ev) => {
    if (!dragging(ev)) return;
    ev.preventDefault();
    form.classList.add('dropping');
  });
  form.addEventListener('dragleave', (ev) => {
    if (!form.contains(ev.relatedTarget as Node | null)) form.classList.remove('dropping');
  });
  form.addEventListener('drop', (ev) => {
    form.classList.remove('dropping');
    if (!dragging(ev)) return;
    ev.preventDefault();
    void addFiles(active!, [...(ev.dataTransfer?.files ?? [])]);
  });
  prompt.addEventListener('focus', renderSlashMenu);
  prompt.addEventListener('blur', () => ($('slash-menu').hidden = true));
}

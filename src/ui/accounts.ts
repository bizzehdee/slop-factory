import type { AccountEntry } from '../../sidecar/src/protocol';
import { $, h } from './dom';
import { signInTo } from './login';
import type { MenuItem } from './menus';
import { accountList, active, send, type Proj } from './state';

// ---------- the Claude logins the app can run projects under ----------

/** "Work · me@example.com · max": what is known about a login. */
export const accountText = (a: AccountEntry): string => [a.name, a.email, a.plan].filter(Boolean).join(' · ');

export function renderAccountBadge(): void {
  const badge = $('account-badge');
  const a = active?.account;
  // One login with nothing known about it needs no line; two or more logins always do.
  badge.hidden = !a || (accountList.length < 2 && !a.email);
  badge.textContent = a ? (accountList.length > 1 ? accountText(a) : [a.email, a.plan].filter(Boolean).join(' · ')) : '';
}

/** The project menu's choice of login, when there is more than one to choose from. */
export function accountMenu(p: Proj): MenuItem[] {
  if (accountList.length < 2) return [];
  const follows = p.account?.followsDefault !== false;
  return [
    {
      label: 'Account',
      submenu: [
        ...accountList.map((a) => ({ label: `${a.name}${a.email ? ` · ${a.email}` : ''}`, checked: p.account?.id === a.id && !follows, run: () => send({ type: 'setAccount', project: p.dir, account: a.id }) })),
        { label: 'Follow the default account', checked: follows, run: () => send({ type: 'setAccount', project: p.dir, account: null }) },
      ],
    },
  ];
}

export function renderAccounts(error?: string): void {
  const p = active;
  $('accounts-for').textContent = p ? `${p.name} runs under ${p.account?.name ?? 'the default account'}. Switching starts that account’s conversation for the project.` : 'Open a project to choose its account.';
  const row = $('account-project-row');
  row.hidden = !p || accountList.length < 2;
  if (p) {
    const picker = $<HTMLSelectElement>('account-picker');
    const def = accountList.find((a) => a.isDefault);
    picker.replaceChildren(
      h('option', { value: '' }, `The default${def ? ` (${def.name})` : ''}`),
      ...accountList.map((a) => h('option', { value: a.id }, a.name)),
    );
    picker.value = p.account?.followsDefault === false ? p.account.id : '';
  }
  $('accounts-list').replaceChildren(
    ...accountList.map((a) =>
      h(
        'li',
        { class: 'account-row' },
        h(
          'span',
          { class: 'settings-item-main' },
          h('strong', {}, a.name, a.isDefault ? h('span', { class: 'account-tag' }, 'default') : ''),
          h('span', { class: 'muted' }, [a.email, a.plan, a.loggedIn === false ? 'not signed in' : a.loggedIn ? '' : 'checking…'].filter(Boolean).join(' · ') || (a.id === 'default' ? 'The login Claude Code already has on this computer' : 'Signed in')),
        ),
        a.loggedIn === false ? h('button', { class: 'button', type: 'button', onclick: () => signInTo(a) }, 'Sign in') : h('button', { class: 'button quiet', type: 'button', title: 'Sign in again, e.g. as someone else', onclick: () => signInTo(a) }, 'Sign in again'),
        a.isDefault ? null : h('button', { class: 'button quiet', type: 'button', onclick: () => send({ type: 'setDefaultAccount', id: a.id }) }, 'Make default'),
        a.id === 'default' ? null : h('button', { class: 'button quiet', type: 'button', onclick: () => rename(a) }, 'Rename'),
        a.id === 'default' ? null : h('button', { class: 'button quiet danger', type: 'button', onclick: () => remove(a) }, 'Remove'),
      ),
    ),
  );
  const err = $('account-error');
  err.hidden = !error;
  err.textContent = error ?? '';
}

function rename(a: AccountEntry): void {
  const name = prompt(`Rename ${a.name} to:`, a.name)?.trim();
  if (name && name !== a.name) send({ type: 'renameAccount', id: a.id, name });
}

function remove(a: AccountEntry): void {
  if (confirm(`Remove ${a.name} from Slop Factory?\n\nIts sign-in and conversations stay on disk. Projects using it move to the default account.`)) send({ type: 'removeAccount', id: a.id });
}

export function wireAccounts(): void {
  $('account-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $<HTMLInputElement>('account-name');
    const name = input.value.trim();
    if (!name) return;
    send({ type: 'addAccount', name });
    input.value = '';
  });
  $('account-picker').addEventListener('change', (ev) => {
    if (active) send({ type: 'setAccount', project: active.dir, account: (ev.target as HTMLSelectElement).value || null });
  });
}

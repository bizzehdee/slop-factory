import type { AccountEntry, AuthState, SidecarEvent } from '../../sidecar/src/protocol';
import { submit } from './app';
import { $ } from './dom';
import { openProviderDialog } from './providers';
import { accountList, send } from './state';

// ---------- sign in ----------

export let loginUrl = '';
export let loginSkipped = false; // chose a local model instead, for this run
let loginAccount: AccountEntry | undefined; // signing in another account, from Settings: the dialog can be cancelled

/** Sign in one of the accounts, from Settings. */
export function signInTo(a: AccountEntry): void {
  loginAccount = a;
  const dialog = $<HTMLDialogElement>('login-dialog');
  $('login-title').textContent = `Sign in to ${a.name}`;
  $('login-error').hidden = true;
  $('login-start').hidden = false;
  $('login-waiting').hidden = true;
  $('login-local').hidden = true;
  $('login-cancel').hidden = false;
  if (!dialog.open) dialog.showModal();
}

function endAccountSignIn(): void {
  loginAccount = undefined;
  $('login-title').textContent = 'Sign in with Claude';
  $('login-local').hidden = false;
  $('login-cancel').hidden = true;
}

export function showLogin(state: AuthState): void {
  const dialog = $<HTMLDialogElement>('login-dialog');
  if (loginAccount) return; // the dialog is for another account just now
  if (state.loggedIn || loginSkipped) {
    if (dialog.open) dialog.close();
    return;
  }
  if (state.error) {
    $('login-error').textContent = state.error;
    $('login-error').hidden = false;
  }
  if (!dialog.open) {
    $('login-start').hidden = false;
    $('login-waiting').hidden = true;
    dialog.showModal();
  }
}

export function wireLoginDialog(): void {
  const dialog = $<HTMLDialogElement>('login-dialog');
  // Signing in (or choosing a local model) is the way out.
  dialog.addEventListener('cancel', (ev) => ev.preventDefault());
  const start = (consoleAccount: boolean) => {
    loginUrl = '';
    $('login-error').hidden = true;
    $('login-start').hidden = true;
    $('login-waiting').hidden = false;
    $('login-url').hidden = true;
    send({ type: 'login', console: consoleAccount, ...(loginAccount ? { account: loginAccount.id } : {}) });
    $('login-code').focus();
  };
  $('login-go').addEventListener('click', () => start(false));
  $('login-console').addEventListener('click', () => start(true));
  $('login-cancel').addEventListener('click', () => {
    send({ type: 'cancelLogin' });
    endAccountSignIn();
    dialog.close();
  });
  $('login-url').addEventListener('click', () => loginUrl && send({ type: 'openUrl', url: loginUrl }));
  $('login-code-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const code = $<HTMLInputElement>('login-code').value.trim();
    if (code) send({ type: 'loginCode', code });
  });
  $('login-recheck').addEventListener('click', () => send({ type: 'checkAuth' }));
  $('login-local').addEventListener('click', () => {
    loginSkipped = true;
    send({ type: 'cancelLogin' });
    dialog.close();
    openProviderDialog();
  });
}

export function onLoginEvent(e: Extract<SidecarEvent, { type: 'auth' | 'loginUrl' | 'loginLine' | 'loginDone' }>): void {
  switch (e.type) {
    case 'auth':
      return showLogin(e.state);
    case 'loginUrl':
      loginUrl = e.url;
      $('login-url').hidden = false;
      return;
    case 'loginLine':
      return;
    case 'loginDone':
      if (e.ok && loginAccount) {
        endAccountSignIn();
        $<HTMLDialogElement>('login-dialog').close();
        return;
      }
      if (!e.ok) {
        $('login-start').hidden = false;
        $('login-waiting').hidden = true;
        $('login-error').textContent = e.error ? `Sign-in didn't finish: ${e.error}` : "Sign-in didn't finish.";
        $('login-error').hidden = false;
      }
      return;
  }
}

import type { AuthState, SidecarEvent } from '../../sidecar/src/protocol';
import { submit } from './app';
import { $ } from './dom';
import { openProviderDialog } from './providers';
import { send } from './state';

// ---------- sign in ----------

export let loginUrl = '';
export let loginSkipped = false; // chose a local model instead, for this run

export function showLogin(state: AuthState): void {
  const dialog = $<HTMLDialogElement>('login-dialog');
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
    send({ type: 'login', console: consoleAccount });
    $('login-code').focus();
  };
  $('login-go').addEventListener('click', () => start(false));
  $('login-console').addEventListener('click', () => start(true));
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
      if (!e.ok) {
        $('login-start').hidden = false;
        $('login-waiting').hidden = true;
        $('login-error').textContent = e.error ? `Sign-in didn't finish: ${e.error}` : "Sign-in didn't finish.";
        $('login-error').hidden = false;
      }
      return;
  }
}

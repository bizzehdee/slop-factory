import { $, h, svgIcon } from './dom';

const ICON_BRANCH =
  '<g fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="5" cy="3.5" r="1.6"/><circle cx="5" cy="12.5" r="1.6"/><circle cx="11" cy="5.5" r="1.6"/><path d="M5 5.1v5.8M11 7.1c0 2.5-6 1.8-6 3.8"/></g>';
import { MenuItem, closeMenu, menuAnchor, openMenu } from './menus';
import { Proj, active, send } from './state';

// ---------- git: where the project's branch stands, and fetch, pull, push and commit ----------

export let fetchMinutes = 5;
export const setFetchMinutes = (n: number) => (fetchMinutes = n);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function pull(p: Proj): void {
  // Pulling changes files; the agent may be part-way through changing them too.
  if (p.busy && !confirm(`The agent is working in ${p.name}. Pull now anyway? Files it is working on may change under it.`)) return;
  send({ type: 'gitPull', project: p.dir });
}
const push = (p: Proj) => send({ type: 'gitPush', project: p.dir });
const commit = (p: Proj) => send({ type: 'gitCommit', project: p.dir });

export function gitMenu(p: Proj): MenuItem[] {
  const g = p.git;
  if (!g?.repo) return [];
  const items: MenuItem[] = [
    { label: g.remotes.length ? 'Fetch now' : 'Fetch now (no remote)', disabled: !g.remotes.length || !!g.running, run: () => send({ type: 'gitFetch', project: p.dir }) },
    { label: g.behind ? `Pull ${plural(g.behind, 'commit')}` : 'Pull', disabled: !g.upstream || !!g.running, run: () => pull(p) },
    g.upstream
      ? { label: g.ahead ? `Push ${plural(g.ahead, 'commit')}` : 'Push', disabled: !g.ahead || !!g.running, run: () => push(p) }
      : { label: g.remotes.length ? `Publish ${g.branch ?? 'branch'}` : 'Publish (no remote)', disabled: !g.remotes.length || !g.branch || !!g.running, run: () => push(p) },
    { label: g.changed + g.untracked ? `Commit ${plural(g.changed + g.untracked, 'change')}…` : 'Commit…', disabled: !(g.changed + g.untracked), run: () => commit(p) },
    { label: 'Pull automatically', checked: g.autoPull, run: () => send({ type: 'setAutoPull', project: p.dir, on: !g.autoPull }) },
  ];
  const facts = [
    g.upstream ? `Tracks ${g.upstream}` : g.branch ? `${g.branch} isn’t on a remote yet` : 'Not on a branch',
    g.fetchError ? `Last fetch failed: ${g.fetchError}` : g.lastFetch ? `Fetched ${ago(g.lastFetch)}` : g.remotes.length && fetchMinutes ? `Fetches every ${plural(fetchMinutes, 'minute')}` : '',
  ].filter(Boolean);
  return [...items, ...facts.map((label) => ({ label, disabled: true, note: true }))];
}

/** The git line under the project's path: branch, what to pull and push, what's uncommitted. */
export function renderGit(): void {
  const host = $('git-status');
  const p = active;
  const g = p?.git;
  host.hidden = !g;
  if (!p || !g) return void host.replaceChildren();
  if (!g.available) {
    return void host.replaceChildren(
      h('span', { class: 'muted' }, 'git isn’t installed. '),
      h('button', { class: 'link-button', type: 'button', onclick: () => send({ type: 'openUrl', url: 'https://git-scm.com/downloads' }) }, 'Get git'),
    );
  }
  if (!g.repo) {
    return void host.replaceChildren(
      h('span', { class: 'muted' }, 'Not a git repository. '),
      h('button', { class: 'link-button', type: 'button', onclick: () => send({ type: 'gitInit', project: p.dir }) }, 'Initialise git'),
    );
  }
  const branch = h(
    'button',
    { id: 'git-branch', class: 'git-branch', type: 'button', title: 'Git actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    svgIcon(ICON_BRANCH),
    g.detached ? 'detached HEAD' : g.branch ?? '',
  );
  branch.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (menuAnchor === branch) return closeMenu();
    openMenu(branch, gitMenu(p));
    // Something may have changed outside the app; the menu updates when the answer comes.
    send({ type: 'gitRefresh', project: p.dir });
  });
  const chip = (label: string, title: string, run: () => void, cls = '') => h('button', { class: `git-chip ${cls}`, type: 'button', title, disabled: !!g.running, onclick: run }, label);
  const running = g.running ? h('span', { class: 'git-running' }, g.running === 'fetch' ? 'Fetching…' : g.running === 'pull' ? 'Pulling…' : 'Pushing…') : null;
  const uncommitted = g.changed + g.untracked;
  const parts: (Node | null)[] = [
    branch,
    running,
    g.behind ? chip(`↓${g.behind}`, `Pull ${plural(g.behind, 'commit')} from ${g.upstream}${g.ahead ? ` (it has diverged: ${g.ahead} to push too)` : ''}`, () => pull(p), 'pull') : null,
    g.ahead && g.upstream ? chip(`↑${g.ahead}`, `Push ${plural(g.ahead, 'commit')} to ${g.upstream}`, () => push(p), 'push') : null,
    !g.upstream && g.branch && g.remotes.length ? chip('Publish', `Push ${g.branch} and track it on ${g.remotes.includes('origin') ? 'origin' : g.remotes[0]}`, () => push(p), 'push') : null,
    uncommitted ? chip(`${uncommitted} uncommitted`, 'Ask the agent to commit these changes', () => commit(p), 'changes') : null,
    g.conflicts ? h('span', { class: 'git-conflicts warn-text' }, plural(g.conflicts, 'conflict')) : null,
    g.fetchError ? h('span', { class: 'git-warn warn-text', title: `Last fetch failed: ${g.fetchError}` }, '!') : null,
  ];
  const menuOpen = menuAnchor?.id === 'git-branch';
  host.replaceChildren(...parts.filter((x): x is Node => !!x));
  // The menu was open on the button just replaced: keep it open, with what's true now.
  if (menuOpen) openMenu(branch, gitMenu(p));
}

/** Coming back to the window: check where the repository stands, at most every few seconds. */
let lastFocusRefresh = 0;
export function wireGit(): void {
  window.addEventListener('focus', () => {
    if (!active?.git?.repo || Date.now() - lastFocusRefresh < 5_000) return;
    lastFocusRefresh = Date.now();
    send({ type: 'gitRefresh', project: active.dir });
  });
  send({ type: 'gitSettings' });
}

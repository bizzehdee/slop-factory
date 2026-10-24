import type { FrameworkStatus } from '../../sidecar/src/protocol';
import { $, h } from './dom';
import type { MenuItem } from './menus';
import { Proj, active, send } from './state';

// ---------- agent-framework: is the project's copy the current one, with an offer to upgrade ----------

function headline(s: FrameworkStatus): string {
  if (s.installed && s.current && s.installed !== s.current) return `agent-framework is out of date (${s.installed} → ${s.current})`;
  const n = (s.differ ?? 0) + (s.missing ?? 0);
  if (n) return `${n} agent-framework file${n === 1 ? ' differs' : 's differ'} from version ${s.current ?? 'current'}`;
  return 'agent-framework has files left over from an earlier version';
}

function upgrade(p: Proj): void {
  if (
    !confirm(
      `Upgrading rewrites agent-framework’s files in ${p.name}${p.frameworkStatus?.kind === 'basic' ? ' (the task tracking section of AGENTS.md)' : ''}. ` +
        'Any edits you’ve made to them are replaced. Every change shows under “uncommitted” for you to look over before it’s committed.\n\nUpgrade now?',
    )
  )
    return;
  send({ type: 'frameworkUpgrade', project: p.dir });
}

/** The line under the git status offering the upgrade, when there's one to offer. */
export function renderFramework(): void {
  const host = $('framework-update');
  const p = active;
  const s = p?.frameworkStatus;
  const show = !!p && !!s && s.kind !== 'none' && !s.error && (s.upgrading || (s.outdated && !s.dismissed));
  host.hidden = !show;
  if (!p || !s || !show) return void host.replaceChildren();
  if (s.upgrading) return void host.replaceChildren(h('span', { class: 'muted' }, 'Upgrading agent-framework…'));
  host.replaceChildren(
    h('span', { class: 'framework-update-text' }, headline(s)),
    h(
      'button',
      {
        class: 'git-chip push',
        type: 'button',
        disabled: p.busy || !!s.checking,
        title: p.busy ? 'Once the agent has finished working here, so the files don’t change under it' : 'Bring this project’s agent-framework files up to date',
        onclick: () => upgrade(p),
      },
      s.installed && s.current && s.installed === s.current ? 'Restore' : 'Upgrade',
    ),
    h('button', { class: 'link-button', type: 'button', title: 'Hide this until agent-framework changes again', onclick: () => send({ type: 'frameworkDismiss', project: p.dir }) }, 'Not now'),
  );
}

export function frameworkMenu(p: Proj): MenuItem[] {
  const s = p.frameworkStatus;
  if (!s || s.kind === 'none') return [];
  return [{ label: s.checking ? 'Checking agent-framework…' : 'Check agent-framework', disabled: !!s.checking || !!s.upgrading, run: () => send({ type: 'frameworkCheck', project: p.dir }) }];
}

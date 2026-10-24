import { Proj, active, bridge, load, store } from './state';

// ---------- desktop notifications: when a project needs you, finishes, or empties its queue ----------

export type NotifyKind = 'needsYou' | 'finished' | 'queueDone';

export const notificationsOn = () => load('slop-factory:notifications') !== 'off';
export const setNotifications = (on: boolean) => store('slop-factory:notifications', on ? null : 'off');

/** Tell the person, unless they're already looking at this project. */
export function notify(p: Proj, kind: NotifyKind, detail?: string): void {
  if (!notificationsOn() || p.replaying) return;
  if (document.hasFocus() && p === active) return;
  const body =
    kind === 'needsYou'
      ? detail ?? 'The agent is waiting for you.'
      : kind === 'finished'
        ? detail ?? 'The agent has finished.'
        : 'Everything in Up next has started.';
  void bridge?.notify(p.name, body).catch(() => undefined);
}

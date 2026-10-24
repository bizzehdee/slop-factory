import { type Bridge } from '../bridge';
import type { AccountEntry, SessionEntry, AskedQuestion, Attachment, CommandInfo, Gauges, GitInfo, FrameworkStatus, ModelOption, ProjectUsage, TaskStart, EditorInfo, FrameworkInfo, OpenQuestion, PermissionModeName, ProcessInfo, ProjectEvent, ProviderConfig, SessionInfo, TaskFile, UiCommand, WorktreeInfo, LaneRun } from '../../sidecar/src/protocol';
import { $, h } from './dom';
import { ChatQuestion } from './questions';
import type { FileEdit } from './changes';

// ---------- state ----------

export type TurnEnd = Extract<ProjectEvent, { type: 'turnEnd' }>;

export interface Proj {
  dir: string;
  name: string;
  framework?: FrameworkInfo;
  session?: SessionInfo;
  mode: PermissionModeName;
  providerId: string;
  busy: boolean;
  status?: string | null;
  processes: ProcessInfo[];
  tasks: TaskFile[];
  docs: Set<string>;
  priorities: string[];
  expanded: Set<string>;
  userToggled: boolean;
  lastTurn?: TurnEnd;
  transcript: HTMLElement;
  liveText: Map<string, HTMLElement>;
  toolCards: Map<string, HTMLElement>;
  permissionCards: Map<string, HTMLElement>;
  pending: Set<string>;
  asked: Map<string, AskedQuestion[]>; // open AskUserQuestion calls
  docQuestions: OpenQuestion[];
  chatQuestions: ChatQuestion[];
  freshTurn: boolean; // the next reply replaces the conversation's questions
  answerDrafts: Map<string, string>;
  selectedQuestions: Set<string>;
  answeredQuestions: Set<string>;
  draft: string;
  unseen: boolean;
  replaying: boolean;
  holdQueue: boolean; // set by Stop: the queue waits until you start something again
  subagentLane: Set<string>; // queued keys that start in a background subagent
  laneRun?: LaneRun; // the subagent-lane item running now
  worktrees: WorktreeInfo[];
  lastReply?: string; // the agent's latest reply, for notifications
  turnUuid?: string; // the message the current turn answers, a checkpoint to undo back to
  turnEdits: FileEdit[];
  queuedTurns: string[]; // messages sent while a turn was under way: each starts a turn of its own

  turnChanges: Map<string, FileEdit[]>; // each turn's edits, by its message
  changeCards: Map<string, HTMLElement>;
  queueRan?: boolean; // the queue started something since the last notification
  attachments: Attachment[]; // files added to the message being written
  commands: CommandInfo[]; // what the "/" picker offers
  usage?: ProjectUsage;
  git?: GitInfo;
  models?: { list: ModelOption[]; current: string | null; error?: string }; // what the model picker offers
  account?: AccountEntry; // the login it runs under
  sessions?: { list: SessionEntry[]; error?: string }; // its conversations, when the list has been asked for
  frameworkStatus?: FrameworkStatus; // whether its agent-framework is the current one
  gauges?: Gauges;
  taskStart?: TaskStart | null; // this project's own choice of where tasks start; null: the default
  agentLogs: Map<string, Extract<ProjectEvent, { type: 'assistantText' | 'toolUse' | 'toolResult' }>[]>; // each subagent's own messages, by its task id
}


export const projects = new Map<string, Proj>();
export let editorList: EditorInfo[] = [];
export let accountList: AccountEntry[] = [];
export let providerList: ProviderConfig[] = [{ id: 'subscription', name: 'Claude subscription', kind: 'subscription' }];
export const providerOf = (p: Proj) => providerList.find((x) => x.id === p.providerId) ?? providerList[0];
export let active: Proj | undefined;
export let bridge: Bridge | undefined;

export const send = (cmd: UiCommand) => bridge?.send(cmd);

// Other modules read these live; these setters are the only way to change them from outside.
export const setActive = (p: Proj | undefined) => (active = p);
export const setBridge = (b: Bridge) => (bridge = b);
export const setAccountList = (list: AccountEntry[]) => (accountList = list);
export const setProviderList = (list: ProviderConfig[]) => (providerList = list);
export const setEditorList = (list: EditorInfo[]) => (editorList = list);

// Settings the sidecar keeps in ~/.slop-factory/config.json, as a desktop webview needn't keep its
// own storage. The window keeps a copy too, only so the theme is right before the sidecar answers.
const SHARED = new Set(['slop-factory:theme', 'slop-factory:notifications', 'slop-factory:new-project-parent', 'slop-factory:task-start']);
const prefKey = (key: string) => key.replace(/^slop-factory:/, '');
let prefs: Record<string, string> | undefined; // the sidecar's settings, once it has said

function localStore(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
function localLoad(key: string): string | null {
  try {
    // Earlier builds, called Claude Desk, kept these under claude-desk:.
    return localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^slop-factory:/, 'claude-desk:'));
  } catch {
    return null;
  }
}

export function store(key: string, value: string | null): void {
  localStore(key, value);
  if (!SHARED.has(key)) return;
  if (prefs) {
    if (value == null) delete prefs[prefKey(key)];
    else prefs[prefKey(key)] = value;
  }
  send({ type: 'setPref', key: prefKey(key), value });
}
export function load(key: string): string | null {
  if (prefs && SHARED.has(key)) return prefs[prefKey(key)] ?? null;
  return localLoad(key);
}

/** The sidecar's settings arrived. Any it doesn't have yet, an earlier version kept here: hand them over. */
export function receivePrefs(from: Record<string, string>): void {
  prefs = { ...from };
  for (const key of SHARED) {
    const local = localLoad(key);
    if (prefs[prefKey(key)] === undefined && local != null) {
      prefs[prefKey(key)] = local;
      send({ type: 'setPref', key: prefKey(key), value: local });
    }
    localStore(key, prefs[prefKey(key)] ?? null);
  }
}
export const saveOpenProjects = () => store('slop-factory:projects', JSON.stringify([...projects.keys()]));

export function newProject(dir: string, name: string): Proj {
  const transcript = h('div', { class: 'transcript', role: 'log', 'aria-live': 'polite', hidden: true });
  $('transcripts').append(transcript);
  return {
    dir,
    name,
    mode: 'default',
    providerId: 'subscription',
    busy: false,
    processes: [],
    tasks: [],
    docs: new Set(),
    priorities: [],
    expanded: new Set(),
    userToggled: false,
    transcript,
    liveText: new Map(),
    toolCards: new Map(),
    permissionCards: new Map(),
    pending: new Set(),
    asked: new Map(),
    docQuestions: [],
    chatQuestions: [],
    freshTurn: false,
    answerDrafts: new Map(),
    selectedQuestions: new Set(),
    answeredQuestions: new Set(),
    draft: '',
    unseen: false,
    replaying: false,
    holdQueue: false,
    subagentLane: new Set(),
    worktrees: [],
    agentLogs: new Map(),
    attachments: [],
    commands: [],
    turnEdits: [],
    queuedTurns: [],
    turnChanges: new Map(),
    changeCards: new Map(),
  };
}

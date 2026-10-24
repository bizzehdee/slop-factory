import { type Bridge } from '../bridge';
import type { AskedQuestion, EditorInfo, FrameworkInfo, OpenQuestion, PermissionModeName, ProcessInfo, ProjectEvent, ProviderConfig, SessionInfo, TaskFile, UiCommand, WorktreeInfo, LaneRun } from '../../sidecar/src/protocol';
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
  turnChanges: Map<string, FileEdit[]>; // each turn's edits, by its message
  changeCards: Map<string, HTMLElement>;
  queueRan?: boolean; // the queue started something since the last notification
  agentLogs: Map<string, Extract<ProjectEvent, { type: 'assistantText' | 'toolUse' | 'toolResult' }>[]>; // each subagent's own messages, by its task id
}


export const projects = new Map<string, Proj>();
export let editorList: EditorInfo[] = [];
export let providerList: ProviderConfig[] = [{ id: 'subscription', name: 'Claude subscription', kind: 'subscription' }];
export const providerOf = (p: Proj) => providerList.find((x) => x.id === p.providerId) ?? providerList[0];
export let active: Proj | undefined;
export let bridge: Bridge | undefined;

export const send = (cmd: UiCommand) => bridge?.send(cmd);

// Other modules read these live; these setters are the only way to change them from outside.
export const setActive = (p: Proj | undefined) => (active = p);
export const setBridge = (b: Bridge) => (bridge = b);
export const setProviderList = (list: ProviderConfig[]) => (providerList = list);
export const setEditorList = (list: EditorInfo[]) => (editorList = list);

export function store(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
export function load(key: string): string | null {
  try {
    // Earlier builds, called Claude Desk, kept these under claude-desk:.
    return localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^slop-factory:/, 'claude-desk:'));
  } catch {
    return null;
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
    turnEdits: [],
    turnChanges: new Map(),
    changeCards: new Map(),
  };
}

// Messages exchanged between the UI and the sidecar.
// Each message is one JSON object per line on the sidecar's stdin/stdout.
// The UI imports these types too (type-only), so keep this file free of runtime imports.

export type PermissionModeName = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

/** Where Claude Code sends model requests. Local servers must speak Anthropic's /v1/messages. */
export interface ProviderConfig {
  id: string;
  name: string;
  kind: 'subscription' | 'ollama' | 'llamacpp' | 'custom';
  baseUrl?: string;
  authToken?: string;
  model?: string;
  smallModel?: string; // used for quick background calls; defaults to model
}

// ---------- UI -> sidecar ----------
// Every command except "open" names the project it is for (its absolute folder path).

/** Something on the board a button can act on: a task line or a bug entry. */
export interface ActionItem {
  key: string; // "T5", "B2", or "<file>#<line text>" for an unnumbered task
  kind: 'task' | 'bug';
  id?: string;
  title: string;
  rel: string; // file the item lives in
  phase?: string; // phase number, for tasks
  done: boolean;
  legacy?: boolean; // from an older-format TASK.md: the entry itself holds the detail
  spec?: string; // rel path, when the spec exists
  summary?: string; // rel path, when the summary exists
}

export type ItemAction = 'start' | 'reinvestigate' | 'summarise';

export type UiCommand =
  | { type: 'open'; projectDir: string; permissionMode?: PermissionModeName }
  | { type: 'close'; project: string }
  | { type: 'send'; project: string; text: string }
  | { type: 'interrupt'; project: string }
  | { type: 'stopProcess'; project: string; id: string }
  | { type: 'permissionReply'; project: string; id: string; decision: 'allow' | 'always' | 'deny'; message?: string }
  | { type: 'setPermissionMode'; project: string; mode: PermissionModeName }
  | { type: 'toggleTask'; project: string; rel: string; line: number; text: string }
  | { type: 'togglePriority'; project: string; key: string }
  | { type: 'readDocs'; project: string; requestId: string; key: string; paths: string[]; blocks?: { rel: string; line: number }[] }
  | { type: 'runAction'; project: string; action: ItemAction; item: ActionItem }
  | { type: 'setProvider'; project: string; providerId: string }
  | { type: 'saveProvider'; provider: ProviderConfig; useFor?: string }
  | { type: 'deleteProvider'; id: string }
  | { type: 'probeProvider'; requestId: string; baseUrl: string; authToken?: string };

// ---------- sidecar -> UI ----------

export type TaskState = 'todo' | 'doing' | 'done' | 'cancelled';

export interface DocLink {
  label: string; // link text, e.g. "Spec"
  rel: string; // project-relative path the link points at
}

export interface TaskItem {
  line: number; // 0-based line number in the file
  depth: number; // nesting level, 0 = top level
  state: TaskState;
  text: string; // the line after the checkbox, exactly as written
  id?: string; // "T5" or "TASK-050.1" when the line starts with one followed by ":"
  title: string; // text without the id prefix and without doc links
  links: DocLink[]; // markdown links on the line that point at .md files
  section?: string; // nearest heading above the item
  dependsOn?: string[]; // ids from a "**Depends on:**" field under the item
  blockedBy?: string[]; // reasons from a "**Blocked by:**" field, as written (split on ";")
  hasDetails?: boolean; // the item has indented detail lines under it
}

// Matches the agent-framework task-tracking standard:
//   task.md                  -> 'index'  (phase table)
//   tasks/task_phase_<n>.md  -> 'phase'  (checkbox tasks under "## Tasks")
//   tasks/bugs.md            -> 'bugs'   ("### B<n>: title" entries with "- Status:" lines)
//   TASK.md with no phase table -> 'legacy' (older format: "## Section" groups of
//                               "- [ ] TASK-001: title" entries with detail fields under each)
// Anything else matched by the task globs is 'other' and just shows its checkboxes.
export type TaskFileKind = 'index' | 'phase' | 'bugs' | 'legacy' | 'other';

export interface PhaseRow {
  number: string;
  goal: string;
  status: string; // planned | in progress | done | dropped (free text, lowercased)
  doc?: string; // rel path of the linked phase document
}

export interface BugEntry {
  id: string; // B2
  title: string;
  status: string; // open | in progress | fixed | won't fix
  reported?: string;
  line: number;
  links: DocLink[]; // from "- Spec:" / "- Summary:" lines and other .md links in the entry
}

export interface TaskFile {
  rel: string; // path relative to the project root, forward slashes
  kind: TaskFileKind;
  title: string; // first H1, or the file path
  phaseNumber?: string;
  items: TaskItem[];
  phases?: PhaseRow[];
  bugs?: BugEntry[];
  mtime: number;
}

export type ProcessKind = 'shell' | 'monitor' | 'subagent' | 'workflow' | 'other';

export interface ProcessInfo {
  id: string;
  kind: ProcessKind;
  rawType: string;
  status: string; // running | completed | failed | stopped | killed | ...
  description: string;
  command?: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  lastTool?: string;
  ambient?: boolean;
}

export interface FrameworkInfo {
  agentsMd: boolean; // AGENTS.md at the project root
  agentsSkills: string[]; // .agents/skills/<name>/SKILL.md
  claudeMd: string[]; // CLAUDE.md files found in the project
  claudeMdImportsAgents: boolean; // a CLAUDE.md that mentions AGENTS.md, so the rules still load
  settingsFiles: string[];
  agents: string[];
  skills: string[];
  commands: string[];
  hooks: string[]; // hook event names configured in project settings
}

export interface SessionInfo {
  model: string;
  cwd: string;
  apiKeySource: string; // 'oauth' means your Claude subscription login
  claudeCodeVersion: string;
  permissionMode: string;
  tools: string[];
  skills: string[];
  agents: string[];
  mcpServers: { name: string; status: string }[];
  slashCommands: string[];
}

export interface DocContent {
  rel: string;
  markdown: string;
}

/** Events about one project. The sidecar adds `project` (its folder path) to each. */
export type ProjectEvent =
  | { type: 'project'; dir: string; name: string; framework: FrameworkInfo; taskGlobs: string[]; permissionMode: PermissionModeName; providerId: string }
  | { type: 'provider'; providerId: string }
  | { type: 'mode'; mode: PermissionModeName }
  | { type: 'closed' }
  | { type: 'session'; info: SessionInfo }
  | { type: 'busy'; busy: boolean; status?: string | null }
  | { type: 'user'; text: string; action?: { kind: ItemAction; key: string } }
  | { type: 'assistantDelta'; msgId: string; index: number; text: string }
  | { type: 'assistantText'; msgId: string; text: string; parent: string | null }
  | { type: 'thinking'; msgId: string; text: string }
  | { type: 'toolUse'; id: string; name: string; input: unknown; parent: string | null }
  | { type: 'toolResult'; toolUseId: string; isError: boolean; preview: string }
  | { type: 'permissionRequest'; id: string; toolName: string; input: unknown; reason?: string }
  | { type: 'permissionResolved'; id: string }
  | { type: 'turnEnd'; durationMs: number; numTurns: number; isError: boolean; inputTokens: number; outputTokens: number; costUsd: number; errors?: string[] }
  | { type: 'processes'; list: ProcessInfo[] }
  | { type: 'tasks'; files: TaskFile[]; docs: string[] } // docs: watched specs, summaries and the root plan.md that exist
  | { type: 'priorities'; order: string[] }
  | { type: 'docs'; requestId: string; key: string; docs: DocContent[] }
  | { type: 'replayDone' }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

/** Events not tied to one project. */
export type GlobalEvent =
  | { type: 'ready'; sdkVersion: string }
  | { type: 'providers'; list: ProviderConfig[] }
  | { type: 'probe'; requestId: string; ok: boolean; models: string[]; error?: string }
  | { type: 'globalNotice'; level: 'info' | 'warn' | 'error'; text: string };

export type SidecarEvent = GlobalEvent | (ProjectEvent & { project: string });

// Slop Factory sidecar: one Claude Code session and one task watcher per open project,
// all running at once. Speaks newline-delimited JSON on stdin (commands) and stdout (events).
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { AgentSession } from './agent.js';
import { FakeSession, fakeDelete, fakeFork, fakeRename, fakeSessions } from './fake-agent.js';
import { shareConfig } from './shared.js';
import { deleteConversation, forkConversation, renameConversation, sessionList } from './sessions.js';
import { loadHistory } from './history.js';
import { TaskWatcher, loadTaskConfig } from './tasks.js';
import { scanFramework } from './framework.js';
import { DEFAULT_PROMPTS, Priorities, planPrompt, promptFor, workstreamsPrompt, type DeskPrompts } from './actions.js';
import { DEFAULT_ACCOUNT, ProviderStore, probeModels } from './providers.js';
import { createProject } from './newproject.js';
import { installedEditors, openInEditor } from './editors.js';
import { authStatus, LoginFlow } from './auth.js';
import { listMcp, removeMcp, saveMcp } from './mcp.js';
import { discardWorktree, listWorktrees, mergeWorktree, worktreeDiff } from './worktrees.js';
import { addBug, addQuestion, addTask } from './capture.js';
import { UsageLedger } from './usage.js';
import { GitMonitor, uncommittedChanges } from './git.js';
import { FrameworkMonitor } from './frameworkupdate.js';
import { serverContextWindow } from './context.js';
import { fixPath } from './shellpath.js';
import { appVersion, loadProjectSettings, migrateConfigDir, readProjectSettings } from './names.js';
import type { AccountEntry, ModelOption, LaneRun, PermissionModeName, ProjectEvent, ProviderConfig, SentAction, SidecarEvent, UiCommand } from './protocol.js';

fixPath();

// stdout is the protocol channel. Anything else that tries to print goes to stderr.
const writeOut = process.stdout.write.bind(process.stdout);
// The window has gone (closed, or the app is quitting): there's no one left to talk to.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});
console.log = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n');
console.info = console.log;

function emit(e: SidecarEvent): void {
  writeOut(JSON.stringify(e) + '\n');
}

// Make sure Claude Code uses your subscription login rather than a stray API key in the environment.
if (process.env.ANTHROPIC_API_KEY && process.env.SLOP_FACTORY_ALLOW_API_KEY !== '1') {
  delete process.env.ANTHROPIC_API_KEY;
  process.stderr.write('[desk] Ignoring ANTHROPIC_API_KEY so usage goes through your Claude login. Set SLOP_FACTORY_ALLOW_API_KEY=1 to keep it.\n');
}

// Started from a terminal where Claude Code is running, the app inherits that session's identity;
// each project's agent is a session of its own, so drop it rather than join that conversation.
for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID']) {
  delete process.env[name];
}

// Events that make up the transcript are kept so a reloaded window can rebuild it.
// State events (tasks, processes, ...) only need their latest value.
const TRANSCRIPT = new Set<ProjectEvent['type']>([
  'user', 'assistantText', 'toolUse', 'toolResult', 'permissionRequest', 'askQuestions', 'permissionResolved', 'turnEnd', 'notice',
]);
const LATEST = new Set<ProjectEvent['type']>(['session', 'commands', 'usage', 'planLimit', 'gauges', 'models', 'account', 'git', 'framework', 'taskStart', 'busy', 'processes', 'tasks', 'priorities', 'worktrees']);
const MAX_TRANSCRIPT = 3000;

interface Project {
  dir: string;
  out: (e: ProjectEvent) => void;
  session: Session;
  tasks: TaskWatcher;
  priorities: Priorities;
  prompts: DeskPrompts;
  projectEvent: ProjectEvent;
  transcript: ProjectEvent[];
  latest: Map<string, ProjectEvent>;
  openPermissions: Set<string>;
  laneRun?: LaneRun | null;
  git: GitMonitor;
  framework: FrameworkMonitor;
  onEvent?: (e: ProjectEvent) => void;
}

const projects = new Map<string, Project>();

// The interface tests run against a scripted agent instead of a real one.
const FAKE_AGENT = process.env.SLOP_FACTORY_FAKE_AGENT === '1';
type Session = AgentSession | FakeSession;
/** A session that remembers its conversation id, so the project can pick it up after a restart. */
/** A local provider with the context window its server gives the model, for the agent to work within. */
async function withContext(provider: ProviderConfig): Promise<ProviderConfig> {
  // Another login shares your own settings, skills and the like.
  if (provider.configDir) await shareConfig(provider.configDir).catch(() => undefined);
  if (provider.kind === 'subscription') return provider;
  const contextTokens = await serverContextWindow(provider).catch(() => undefined);
  return contextTokens ? { ...provider, contextTokens } : provider;
}

function newSession(dir: string, mode: PermissionModeName, out: (e: ProjectEvent) => void, provider: ProviderConfig, resume?: string): Session {
  const s = FAKE_AGENT ? new FakeSession(dir, mode, out, provider, resume) : new AgentSession(dir, mode, out, provider, resume);
  // The login it started under keeps the conversation, even if the project moves to another meanwhile.
  const account = providers.accountFor(dir).id;
  s.onSession = (id) => void providers.setSession(dir, id, account).catch(() => undefined);
  s.onAccount = (info) =>
    void providers
      .cacheAccountInfo(account, info)
      .then(async () => {
        if (providers.accountFor(dir).id === account) out({ type: 'account', account: providers.entryFor(dir) });
        emit({ type: 'accounts', list: await accountList() });
      })
      .catch(() => undefined);
  s.onUsage = (id, cost, models, ms) => void usage.record(dir, id, cost, models, ms).then((u) => out({ type: 'usage', usage: u }), () => undefined);
  return s;
}
const loadConversation = (id: string, dir: string, login?: string) => (FAKE_AGENT ? Promise.resolve(FakeSession.history(id, login)) : loadHistory(id, dir, login));
// The tests have no real logins: another account counts as signed in once its sign-in has been "done".
const checkAuth = (login?: string) => (FAKE_AGENT ? Promise.resolve({ loggedIn: !login || existsSync(path.join(login, '.fake-login')), method: 'fake' }) : authStatus(login));

/** The logins the app knows, each with whether it's signed in. */
async function accountList(): Promise<AccountEntry[]> {
  return Promise.all(providers.accountList().map(async (a) => ({ ...a, loggedIn: (await checkAuth(providers.account(a.id)?.dir)).loggedIn })));
}
const emitAccounts = async (error?: string) => emit({ type: 'accounts', list: await accountList(), ...(error ? { error } : {}) });
const providers = new ProviderStore();
const usage = new UsageLedger();

function projectEmitter(p: Pick<Project, 'dir' | 'transcript' | 'latest' | 'openPermissions' | 'onEvent'>) {
  return (e: ProjectEvent): void => {
    if (TRANSCRIPT.has(e.type)) {
      p.transcript.push(e);
      if (p.transcript.length > MAX_TRANSCRIPT) p.transcript.splice(0, p.transcript.length - MAX_TRANSCRIPT);
    }
    if (LATEST.has(e.type)) p.latest.set(e.type, e);
    if (e.type === 'permissionRequest' || e.type === 'askQuestions') p.openPermissions.add(e.id);
    if (e.type === 'permissionResolved') p.openPermissions.delete(e.id);
    emit({ ...e, project: p.dir });
    p.onEvent?.(e);
  };
}

const queueEvent = (q: Priorities, laneRun?: LaneRun | null): ProjectEvent => ({ type: 'priorities', order: q.list(), subagent: q.subagentKeys(), laneRun: laneRun ?? null });

async function loadPrompts(dir: string): Promise<DeskPrompts> {
  const raw = await readProjectSettings(dir);
  if (!raw.prompts || typeof raw.prompts !== 'object') return {};
  // Only text replaces a prompt; anything else (a typo, a number) leaves the built-in one.
  return Object.fromEntries(Object.entries(raw.prompts).filter(([, v]) => typeof v === 'string' && v.trim())) as DeskPrompts;
}

/** Send a reopened window everything it needs to rebuild this project's view. */
function replay(p: Project): void {
  const send = (e: ProjectEvent) => emit({ ...e, project: p.dir });
  send({ ...(p.projectEvent as Extract<ProjectEvent, { type: 'project' }>), permissionMode: p.session.mode, providerId: p.session.provider.id });
  // Answered permission prompts are followed by their permissionResolved, so only open ones stay pending.
  for (const e of p.transcript) send(e);
  for (const e of p.latest.values()) send(e);
  send({ type: 'replayDone' });
}

// New projects' first messages, sent when each opens: "start a plan for ..." from its description.
const firstMessages = new Map<string, { description: string; name: string }>();

// Projects part-way through opening. The window hears about a project before it's ready, and its
// commands for it wait here rather than fail.
const opening = new Map<string, Promise<void>>();

function openProject(dirIn: string, requested?: PermissionModeName): Promise<void> {
  const dir = path.resolve(dirIn);
  const existing = projects.get(dir);
  if (existing) {
    replay(existing);
    return Promise.resolve();
  }
  const pending = opening.get(dir);
  if (pending) return pending;
  const done = startProject(dir, requested).finally(() => opening.delete(dir));
  opening.set(dir, done);
  return done;
}

async function startProject(dir: string, requested?: PermissionModeName): Promise<void> {
  // Each project reopens in the mode you last chose for it.
  const mode = requested ?? providers.modeFor(dir);

  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`Not a folder: ${dir}`);

  const shell: Pick<Project, 'dir' | 'transcript' | 'latest' | 'openPermissions' | 'onEvent'> = { dir, transcript: [], latest: new Map(), openPermissions: new Set() };
  const out = projectEmitter(shell);

  const [config, prompts, framework] = await Promise.all([loadTaskConfig(dir), loadPrompts(dir), scanFramework(dir)]);
  const provider = await withContext(providers.forProject(dir));
  const projectEvent: ProjectEvent = { type: 'project', dir, name: path.basename(dir), framework, taskGlobs: config.taskGlobs, permissionMode: mode, providerId: provider.id };
  out(projectEvent);
  out({ type: 'account', account: providers.entryFor(dir) });
  const { problem } = await loadProjectSettings(dir);
  if (problem) out({ type: 'notice', level: 'warn', text: `${problem} Fix it and reopen the project.` });

  const priorities = new Priorities(dir);
  await priorities.load();
  out(queueEvent(priorities));
  void usage.get(dir).then((u) => out({ type: 'usage', usage: u }), () => undefined);
  out({ type: 'taskStart', mode: providers.ownTaskStart(dir) });

  const tasks = new TaskWatcher(dir, config, (files, docs, questions) => out({ type: 'tasks', files, docs, questions }));
  // Pick up the project's last conversation, showing what it said before.
  const previous = providers.sessionFor(dir);
  const history = previous ? await loadConversation(previous, dir, provider.configDir).catch(() => []) : [];
  for (const e of history) out(e);
  if (history.length) out({ type: 'notice', level: 'info', text: 'Picked up where you left off.', action: 'newConversation' });
  const session = newSession(dir, mode, out, provider, history.length ? previous : undefined);
  const git = new GitMonitor(dir, {
    fetchMinutes: () => providers.fetchMinutes,
    autoPull: () => providers.autoPull(dir),
    agentBusy: () => project.session.busy,
    emit: (info) => out({ type: 'git', info }),
    notice: (level, text) => out({ type: 'notice', level, text }),
  });
  const fwMonitor = new FrameworkMonitor(dir, {
    emit: (status) => out({ type: 'framework', status }),
    notice: (level, text) => out({ type: 'notice', level, text }),
    dismissed: () => providers.frameworkDismissed(dir),
    undismiss: () => providers.dismissFramework(dir, null),
    agentBusy: () => project.session.busy,
    changed: () => git.poke(),
  });
  const project: Project = { ...shell, out, session, tasks, priorities, prompts, projectEvent, git, framework: fwMonitor };
  projects.set(dir, project);
  void providers.projectOpened(dir).catch(() => undefined);
  // A turn ending, task files changing or a worktree merging can all move the repository on.
  shell.onEvent = (e) => {
    if (e.type === 'turnEnd' || e.type === 'tasks' || e.type === 'worktrees' || (e.type === 'busy' && !e.busy)) git.poke();
  };
  git.start();
  fwMonitor.start();

  tasks.start();
  session.processes.clear();
  session.start();
  void sendModels(project);
  const first = firstMessages.get(dir);
  if (first) {
    firstMessages.delete(dir);
    session.send(planPrompt(first.description), { kind: 'plan', key: first.name });
  }
  // The window treats a project as replaying until this arrives, as it does for a reopened one.
  out({ type: 'replayDone' });
}

async function closeProject(dir: string): Promise<void> {
  const p = projects.get(dir);
  if (!p) return;
  projects.delete(dir);
  p.git.stop();
  p.framework.stop();
  p.session.close();
  await p.tasks.stop();
  emit({ type: 'closed', project: dir });
}

/**
 * Start a task in the project's conversation, as Settings says: as it is, compacted first, or in a
 * new conversation. The last two keep the tokens each task sends down. A new conversation would
 * end work still running here, so then it compacts instead.
 */
async function startTask(p: Project, prompt: string, action: { kind: SentAction; key: string }): Promise<void> {
  let mode = providers.taskStart(p.dir);
  if (mode === 'new') {
    const processes = (p.latest.get('processes') as Extract<ProjectEvent, { type: 'processes' }> | undefined)?.list ?? [];
    const running = p.session.busy || processes.some((x) => x.status === 'running' || x.status === 'pending');
    if (!running) {
      await restartSession(p, true);
      p.session.send(prompt, action);
      return;
    }
    mode = 'compact';
    p.out({ type: 'notice', level: 'info', text: 'Work is still running here, so this task starts in the current conversation, compacted, rather than a new one.' });
  }
  if (mode === 'compact' && p.session.hasConversation) return void p.session.compactThen(prompt, action);
  p.session.send(prompt, action);
}

/** Restart a project's agent: so it picks up changed MCP servers (same conversation), or to start afresh. */
/**
 * The models the project can switch to: what the subscription offers, by alias and then earlier
 * versions, or what the local server has.
 */
async function sendModels(p: Project): Promise<void> {
  const session = p.session;
  const provider = session.provider;
  const local = provider.kind !== 'subscription';
  try {
    let models: ModelOption[];
    if (local) {
      const names = provider.baseUrl ? await probeModels(provider.baseUrl, provider.authToken) : [];
      // The configured model stays listed, though the server didn't name it.
      if (provider.model && !names.includes(provider.model)) names.unshift(provider.model);
      models = names.map((n) => ({ value: n, label: n }));
    } else {
      models = (await session.supportedModels()).map((m) => ({ value: m.value, label: m.displayName, description: m.description, older: m.value.startsWith('claude-') }));
    }
    if (p.session !== session) return; // restarted meanwhile: the new session sends its own
    p.out({ type: 'models', models, current: local ? (provider.model ?? null) : (provider.model ?? 'default') });
  } catch (err) {
    if (p.session === session) p.out({ type: 'models', models: [], current: provider.model ?? null, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Switch the project's model. On the subscription it changes for the replies from here on; a local
 * model restarts the agent on it, carrying the conversation on, so its context window is the new
 * model's. While the agent is working, a local model changes like the subscription's, and the rest
 * follows at the next start.
 */
async function switchModel(p: Project, model: string | null): Promise<void> {
  const base = providers.get(p.session.provider.id);
  const chosen = model === 'default' ? null : model;
  await providers.setModel(p.dir, base.id, chosen);
  const local = base.kind !== 'subscription';
  const value = chosen ?? (local ? base.model : undefined);
  if (local && !p.session.busy) {
    await restartSession(p, false, `Switched to ${value}. The conversation carries on.`);
    return;
  }
  await p.session.setModel(value);
  p.session.provider = { ...p.session.provider, model: value };
  void sendModels(p);
  const label = (p.latest.get('models') as Extract<ProjectEvent, { type: 'models' }> | undefined)?.models.find((m) => m.value === (chosen ?? 'default'))?.label ?? value ?? 'the default model';
  p.out({ type: 'notice', level: 'info', text: `Switched to ${label} for the replies from here on.` });
}

async function restartSession(p: Project, fresh: boolean, note?: string): Promise<void> {
  const mode = p.session.mode;
  // The project's provider as it's set now, with the model it picked.
  const provider = await withContext(providers.forProject(p.dir));
  p.session.close();
  const resume = fresh ? undefined : providers.sessionFor(p.dir);
  if (fresh) void providers.setSession(p.dir, undefined);
  p.session = newSession(p.dir, mode, p.out, provider, resume);
  p.session.processes.clear();
  p.session.start();
  p.latest.delete('session');
  void sendModels(p);
  p.out({ type: 'notice', level: 'info', text: note ?? (fresh ? 'Started a new conversation.' : 'Restarted the agent. The conversation carries on.') });
}

/** Restart a project's Claude Code session on another provider. The task board keeps running. */
async function switchProvider(p: Project, providerId: string): Promise<void> {
  const provider = await withContext(await providers.setForProject(p.dir, providerId));
  const mode = p.session.mode;
  p.session.close();
  await providers.setSession(p.dir, undefined);
  p.session = newSession(p.dir, mode, p.out, provider);
  p.session.processes.clear();
  p.session.start();
  p.latest.delete('session');
  void sendModels(p);
  p.out({ type: 'provider', providerId: provider.id });
  p.out({
    type: 'notice',
    level: 'info',
    text: provider.kind === 'subscription' ? 'Switched to your Claude subscription. This starts a new conversation.' : `Switched to ${provider.name} at ${provider.baseUrl}. This starts a new conversation.`,
  });
}

/** Show another of a project's conversations (or an empty one) and carry on in it. */
async function openConversation(p: Project, sessionId: string | undefined, note: string): Promise<void> {
  const mode = p.session.mode;
  const provider = await withContext(providers.forProject(p.dir));
  const history = sessionId ? await loadConversation(sessionId, p.dir, provider.configDir).catch(() => []) : [];
  p.session.close();
  await providers.setSession(p.dir, sessionId);
  p.transcript.splice(0);
  p.out({ type: 'conversationReset' });
  for (const e of history) p.out(e);
  p.out({ type: 'replayDone' });
  p.session = newSession(p.dir, mode, p.out, provider, history.length ? sessionId : undefined);
  p.session.processes.clear();
  p.session.start();
  p.latest.delete('session');
  p.out({ type: 'busy', busy: false });
  void sendModels(p);
  p.out({ type: 'notice', level: 'info', text: note });
}

/** A project moves to another login: its own conversation there, if it has one, and its own sign-in. */
async function switchAccount(p: Project, account: string | null): Promise<void> {
  const before = providers.accountFor(p.dir).id;
  await providers.setProjectAccount(p.dir, account);
  const now = providers.entryFor(p.dir);
  p.out({ type: 'account', account: now });
  if (now.id === before) return;
  const name = providers.accountFor(p.dir).name;
  const signedIn = (await checkAuth(providers.accountFor(p.dir).dir)).loggedIn;
  await openConversation(p, providers.sessionFor(p.dir), `Now using ${name}. ${providers.sessionFor(p.dir) ? 'Its last conversation here carries on.' : 'This starts a new conversation, as each login keeps its own.'}${signedIn ? '' : ' It isn’t signed in yet: sign in under Settings → Accounts.'}`);
}

const listing = (p: Project) => {
  const login = providers.accountFor(p.dir).dir;
  return { login, current: providers.sessionFor(p.dir) };
};

async function sendSessions(p: Project): Promise<void> {
  const { login, current } = listing(p);
  try {
    p.out({ type: 'sessions', list: FAKE_AGENT ? fakeSessions(p.dir, login, current) : await sessionList(p.dir, login, current) });
  } catch (err) {
    p.out({ type: 'sessions', list: [], error: err instanceof Error ? err.message : String(err) });
  }
}

const login = new LoginFlow(
  (url) => emit({ type: 'loginUrl', url }),
  (line) => emit({ type: 'loginLine', line }),
  async (ok, error) => {
    emit({ type: 'loginDone', ok, error });
    emit({ type: 'auth', state: await checkAuth() });
    await emitAccounts();
    if (ok) await restartSignedIn(signingIn);
  },
);
let signingIn: string | undefined; // the login being signed in, when it isn't the default

/** Projects on a login that has just signed in start their agent again, now that it can work. */
async function restartSignedIn(account: string | undefined): Promise<void> {
  for (const p of projects.values()) {
    if (providers.accountFor(p.dir).id !== (account ?? DEFAULT_ACCOUNT) || p.session.busy) continue;
    await restartSession(p, false, 'Signed in. The agent has started again.');
  }
}

/** Show a folder in Finder, Explorer or the desktop's file manager, or a web page in the browser. */
function openInFileManager(dir: string): Promise<void> {
  const url = /^https:\/\//.test(dir);
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [dir]] : process.platform === 'win32' ? (url ? ['cmd', ['/c', 'start', '""', dir]] : ['explorer', [dir]]) : ['xdg-open', [dir]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.once('error', (err) => reject(new Error(`Couldn't open the folder with ${cmd}: ${err.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const failed = (what: string) => (err: unknown): never => {
  throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}`);
};

function need(dir: string): Project {
  const p = projects.get(dir);
  if (!p) throw new Error(`That project isn't open: ${dir}`);
  return p;
}

async function handle(cmd: UiCommand): Promise<void> {
  if ('project' in cmd && cmd.project) await opening.get(cmd.project)?.catch(() => undefined);
  switch (cmd.type) {
    case 'open':
      return openProject(cmd.projectDir, cmd.permissionMode).catch(async (err) => {
        // A folder that has gone since last time isn't tried again at the next start.
        if (!(await fs.stat(path.resolve(cmd.projectDir)).catch(() => null))?.isDirectory()) await providers.projectClosed(path.resolve(cmd.projectDir));
        throw err;
      });
    case 'close':
      await providers.projectClosed(path.resolve(cmd.project));
      return closeProject(cmd.project);
    case 'openProjects': {
      const { list, active } = providers.openProjects;
      return emit({ type: 'openProjects', list, active });
    }
    case 'getPrefs':
      return emit({ type: 'prefs', prefs: providers.prefs });
    case 'setPref':
      if (!/^[a-z][a-z0-9-]{0,40}$/.test(cmd.key)) throw new Error(`Not a setting: ${cmd.key}`);
      return providers.setPref(cmd.key, typeof cmd.value === 'string' ? cmd.value.slice(0, 4096) : null);
    case 'setProjectTaskStart': {
      const p = need(cmd.project);
      await providers.setProjectTaskStart(p.dir, cmd.mode);
      return p.out({ type: 'taskStart', mode: providers.ownTaskStart(p.dir) });
    }
    case 'setActiveProject':
      return providers.setActiveProject(path.resolve(cmd.project));
    case 'openFolder':
      return openInFileManager(need(cmd.project).dir);
    case 'openWith':
      return openInEditor(cmd.editor, need(cmd.project).dir);
    case 'listEditors':
      emit({ type: 'editors', list: await installedEditors() });
      return;
    case 'checkAuth':
      emit({ type: 'auth', state: await checkAuth() });
      return;
    case 'login': {
      const account = cmd.account && cmd.account !== DEFAULT_ACCOUNT ? providers.account(cmd.account) : undefined;
      if (cmd.account && cmd.account !== DEFAULT_ACCOUNT && !account) throw new Error('That account is gone.');
      signingIn = account?.id;
      if (!FAKE_AGENT) return login.start(cmd.console, account?.dir);
      // The tests don't open a browser: signing in is a file in the account's folder.
      if (account) await fs.writeFile(path.join(account.dir!, '.fake-login'), '');
      emit({ type: 'loginDone', ok: true });
      emit({ type: 'auth', state: await checkAuth() });
      await emitAccounts();
      return restartSignedIn(signingIn);
    }
    case 'listAccounts':
      return emitAccounts();
    case 'addAccount':
      try {
        await providers.addAccount(cmd.name);
      } catch (err) {
        return emitAccounts(err instanceof Error ? err.message : String(err));
      }
      return emitAccounts();
    case 'renameAccount':
      await providers.renameAccount(cmd.id, cmd.name);
      for (const p of projects.values()) p.out({ type: 'account', account: providers.entryFor(p.dir) });
      return emitAccounts();
    case 'removeAccount': {
      const moved = (await providers.removeAccount(cmd.id)).filter((d) => projects.has(d));
      const follow = [...projects.values()].filter((p) => !moved.includes(p.dir));
      for (const dir of moved) await openConversation(need(dir), providers.sessionFor(dir), `That account was removed. Now using ${providers.accountFor(dir).name}.`);
      for (const p of follow) p.out({ type: 'account', account: providers.entryFor(p.dir) });
      return emitAccounts();
    }
    case 'setDefaultAccount': {
      const before = new Map([...projects.values()].filter((p) => providers.follows(p.dir)).map((p) => [p.dir, providers.accountFor(p.dir).id]));
      if (!(await providers.setDefaultAccount(cmd.id))) return emitAccounts();
      // Projects that follow the default move with it.
      for (const [dir, was] of before) {
        const p = need(dir);
        p.out({ type: 'account', account: providers.entryFor(dir) });
        if (providers.accountFor(dir).id !== was) await openConversation(p, providers.sessionFor(dir), `The default account is now ${providers.accountFor(dir).name}, so this project uses it.`);
      }
      return emitAccounts();
    }
    case 'setAccount':
      return switchAccount(need(cmd.project), cmd.account);
    case 'listSessions':
      return sendSessions(need(cmd.project));
    case 'resumeSession': {
      const p = need(cmd.project);
      if (p.session.busy) return p.out({ type: 'notice', level: 'warn', text: 'The agent is working. Stop it, or wait for it to finish, before opening another conversation.' });
      await openConversation(p, cmd.sessionId, 'Opened that conversation. It carries on from here.');
      return sendSessions(p);
    }
    case 'renameSession': {
      const p = need(cmd.project);
      const title = cmd.title.trim().slice(0, 200);
      if (title) {
        const { login: dirOf } = listing(p);
        if (FAKE_AGENT) fakeRename(cmd.sessionId, title, dirOf);
        else await renameConversation(cmd.sessionId, title, p.dir, dirOf);
      }
      return sendSessions(p);
    }
    case 'forkSession': {
      const p = need(cmd.project);
      if (p.session.busy) return p.out({ type: 'notice', level: 'warn', text: 'The agent is working. Stop it, or wait for it to finish, before branching a conversation.' });
      const { login: dirOf } = listing(p);
      const copy = FAKE_AGENT ? fakeFork(cmd.sessionId, dirOf) : await forkConversation(cmd.sessionId, p.dir, dirOf);
      await openConversation(p, copy, 'Branched that conversation. This is the copy, so the original stays as it was.');
      return sendSessions(p);
    }
    case 'deleteSession': {
      const p = need(cmd.project);
      const { login: dirOf, current } = listing(p);
      if (cmd.sessionId === current) return p.out({ type: 'notice', level: 'warn', text: 'That is the conversation open now. Open another, or start a new one, before deleting it.' });
      if (FAKE_AGENT) fakeDelete(cmd.sessionId, dirOf);
      else await deleteConversation(cmd.sessionId, p.dir, dirOf);
      return sendSessions(p);
    }
    case 'loginCode':
      return login.sendCode(cmd.code);
    case 'cancelLogin':
      return login.cancel();
    case 'listMcp':
      emit({ type: 'mcpServers', project: cmd.project, list: await listMcp(cmd.project) });
      return;
    case 'saveMcp':
    case 'removeMcp': {
      let error: string | undefined;
      try {
        if (cmd.type === 'saveMcp') await saveMcp(cmd.project, cmd.server, cmd.previous);
        else await removeMcp(cmd.project, cmd.name, cmd.scope);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      emit({ type: 'mcpServers', project: cmd.project, list: await listMcp(cmd.project), error });
      return;
    }
    case 'restartSession':
      return restartSession(need(cmd.project), !!cmd.fresh);
    case 'rewindFiles': {
      const p = need(cmd.project);
      let result: Awaited<ReturnType<typeof p.session.rewindFiles>>;
      try {
        result = await p.session.rewindFiles(cmd.uuid, cmd.dryRun);
      } catch (err) {
        result = { canRewind: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!cmd.dryRun && result.canRewind) {
        const n = result.filesChanged?.length ?? 0;
        p.out({ type: 'notice', level: 'info', text: `Undid the changes to ${n} file${n === 1 ? '' : 's'}.` });
      }
      return p.out({ type: 'rewound', uuid: cmd.uuid, dryRun: cmd.dryRun, ...result });
    }
    case 'subagentLog': {
      const p = need(cmd.project);
      return p.out({ type: 'subagentLog', agentId: cmd.agentId, events: await p.session.subagentLog(cmd.agentId) });
    }
    case 'listWorktrees': {
      const p = need(cmd.project);
      return p.out({ type: 'worktrees', list: await listWorktrees(p.dir) });
    }
    case 'worktreeDiff': {
      const p = need(cmd.project);
      return p.out({ type: 'worktreeDiff', path: cmd.path, requestId: cmd.requestId, diff: await worktreeDiff(p.dir, cmd.path) });
    }
    case 'mergeWorktree':
    case 'discardWorktree': {
      const p = need(cmd.project);
      try {
        const done = cmd.type === 'mergeWorktree' ? await mergeWorktree(p.dir, cmd.path) : await discardWorktree(p.dir, cmd.path);
        p.out({ type: 'notice', level: 'info', text: done });
      } finally {
        p.out({ type: 'worktrees', list: await listWorktrees(p.dir) });
      }
      return;
    }
    case 'openUrl':
      if (!/^https:\/\/[^\s"]+$/.test(cmd.url)) throw new Error('Only https links open from here.');
      return openInFileManager(cmd.url);
    case 'gitSettings':
      if (typeof cmd.fetchMinutes === 'number') await providers.setFetchMinutes(cmd.fetchMinutes);
      return emit({ type: 'gitSettings', fetchMinutes: providers.fetchMinutes });
    case 'gitChanges': {
      const p = need(cmd.project);
      try {
        const { files, diff, more } = await uncommittedChanges(p.dir);
        p.out({ type: 'gitChanges', requestId: cmd.requestId, files, diff, more });
      } catch (err) {
        p.out({ type: 'gitChanges', requestId: cmd.requestId, files: [], diff: '', more: 0, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    case 'gitRefresh':
      return need(cmd.project).git.refresh();
    case 'gitFetch':
      return need(cmd.project).git.fetch(true).catch(failed("Couldn't fetch"));
    case 'gitPull':
      return need(cmd.project).git.pull().catch(failed("Couldn't pull"));
    case 'gitPush':
      return need(cmd.project).git.push().catch(failed("Couldn't push"));
    case 'gitInit':
      return need(cmd.project).git.init().catch(failed("Couldn't make this a git repository"));
    case 'setModel':
      return switchModel(need(cmd.project), cmd.model);
    case 'frameworkCheck':
      return need(cmd.project).framework.check(true);
    case 'frameworkUpgrade':
      return need(cmd.project).framework.upgrade();
    case 'frameworkDismiss': {
      const p = need(cmd.project);
      if (!p.framework.status.current) return;
      await providers.dismissFramework(p.dir, p.framework.status.current);
      return p.out({ type: 'framework', status: { ...p.framework.status, dismissed: true } });
    }
    case 'setAutoPull': {
      const p = need(cmd.project);
      await providers.setAutoPull(p.dir, cmd.on);
      return p.git.refresh();
    }
    case 'gitCommit': {
      const p = need(cmd.project);
      p.session.send(p.prompts.commitChanges ?? DEFAULT_PROMPTS.commitChanges, { kind: 'commit', key: 'uncommitted changes' });
      return;
    }
    case 'resetUsage': {
      const p = need(cmd.project);
      p.out({ type: 'usage', usage: await usage.reset(p.dir) });
      return;
    }
    case 'send':
      if (cmd.text.trim() || cmd.attachments?.length) need(cmd.project).session.send(cmd.text, undefined, cmd.attachments);
      return;
    case 'messageSubagent': {
      if (!cmd.text.trim()) return;
      // A subagent can only be reached by the agent that started it, through its SendMessage tool.
      need(cmd.project).session.send(
        `Pass this message to the subagent "${cmd.name}" (agent id ${cmd.agentId}) with SendMessage, word for word, then carry on:\n\n${cmd.text}`,
      );
      return;
    }
    case 'interrupt':
      return need(cmd.project).session.interrupt();
    case 'stopProcess':
      return need(cmd.project).session.stopProcess(cmd.id);
    case 'permissionReply':
      return need(cmd.project).session.replyPermission(cmd.id, cmd.decision, cmd.message);
    case 'answerQuestions':
      return need(cmd.project).session.answerQuestions(cmd.id, cmd.answers);
    case 'setPermissionMode': {
      const p = need(cmd.project);
      const mode = await p.session.setPermissionMode(cmd.mode);
      if (mode === cmd.mode) await providers.setMode(p.dir, mode);
      p.out({ type: 'mode', mode });
      return;
    }
    case 'toggleTask':
      return need(cmd.project).tasks.toggle(cmd.rel, cmd.line, cmd.text);
    case 'togglePriority': {
      const p = need(cmd.project);
      await p.priorities.toggle(cmd.key);
      return p.out(queueEvent(p.priorities, p.laneRun));
    }
    case 'enqueue': {
      const p = need(cmd.project);
      await p.priorities.enqueue(cmd.keys, cmd.lane, !!cmd.front);
      return p.out(queueEvent(p.priorities, p.laneRun));
    }
    case 'reorderQueue': {
      const p = need(cmd.project);
      await p.priorities.reorder(cmd.order);
      return p.out(queueEvent(p.priorities, p.laneRun));
    }
    case 'capture': {
      const p = need(cmd.project);
      const title = cmd.title.trim();
      if (!title) throw new Error('Give it a title.');
      if (cmd.kind === 'bug') {
        const id = await addBug(p.dir, title, cmd.details ?? '');
        return p.out({ type: 'notice', level: 'info', text: `Added ${id}: ${title} to tasks/bugs.md.` });
      }
      if (!cmd.rel) throw new Error('Choose where it goes.');
      if (cmd.kind === 'question') {
        await addQuestion(p.dir, cmd.rel, title);
        return p.out({ type: 'notice', level: 'info', text: `Added the question to ${cmd.rel}.` });
      }
      const id = await addTask(p.dir, cmd.rel, title, p.tasks.snapshot().map((f) => f.rel), cmd.section);
      return p.out({ type: 'notice', level: 'info', text: `Added ${id}: ${title} to ${cmd.rel}.` });
    }
    case 'setLaneRun': {
      const p = need(cmd.project);
      p.laneRun = cmd.run;
      return p.out(queueEvent(p.priorities, p.laneRun));
    }
    case 'readDocs': {
      const p = need(cmd.project);
      const blocks = await Promise.all((cmd.blocks ?? []).slice(0, 5).map((b) => p.tasks.readBlock(b.rel, b.line)));
      const docs = [...blocks.filter((b): b is { rel: string; markdown: string } => !!b), ...(await p.tasks.readDocs(cmd.paths))];
      return projectEmitter(p)({ type: 'docs', requestId: cmd.requestId, key: cmd.key, docs });
    }
    case 'runWorkstreams': {
      const p = need(cmd.project);
      const files = p.tasks.snapshot();
      const file = files.find((f) => f.kind === 'workstreams');
      const streams = (file?.workstreams ?? []).filter((s) => cmd.ids.includes(s.id));
      if (!file || !streams.length) throw new Error('Those workstreams are no longer in tasks/workstream.md.');
      // Task and bug titles, so each subagent's brief says what its tasks are.
      const titles = new Map<string, string>();
      for (const f of files) {
        for (const t of f.items) if (t.id) titles.set(t.id, t.title);
        for (const b of f.bugs ?? []) titles.set(b.id, b.title);
      }
      p.session.send(workstreamsPrompt(streams, titles, file.rel, p.prompts), { kind: 'runWorkstreams', key: streams.map((s) => s.id).join(', ') });
      return;
    }
    case 'findWorkstreams': {
      const p = need(cmd.project);
      p.session.send(p.prompts.findWorkstreams ?? DEFAULT_PROMPTS.findWorkstreams, { kind: 'findWorkstreams', key: 'tasks/workstream.md' });
      return;
    }
    case 'runAction': {
      const p = need(cmd.project);
      // Once something starts it is no longer waiting in the priority queue.
      if ((cmd.action === 'start' || cmd.action === 'startSubagent') && p.priorities.list().includes(cmd.item.key)) {
        await p.priorities.remove(cmd.item.key);
        p.out(queueEvent(p.priorities, p.laneRun));
      }
      const prompt = promptFor(cmd.action, cmd.item, p.prompts);
      const action = { kind: cmd.action, key: cmd.item.key };
      if (cmd.action === 'start') return startTask(p, prompt, action);
      p.session.send(prompt, action);
      return;
    }
    case 'setProvider':
      return switchProvider(need(cmd.project), cmd.providerId);
    case 'saveProvider': {
      const saved = await providers.upsert(cmd.provider);
      emit({ type: 'providers', list: providers.list() });
      // Projects already on this provider pick up the edit.
      for (const p of projects.values()) {
        if (p.session.provider.id === saved.id || p.dir === cmd.useFor) await switchProvider(p, saved.id);
      }
      return;
    }
    case 'deleteProvider': {
      const affected = await providers.remove(cmd.id);
      emit({ type: 'providers', list: providers.list() });
      for (const dir of affected) {
        const p = projects.get(dir);
        if (p) await switchProvider(p, 'subscription');
      }
      return;
    }
    case 'createProject':
      try {
        const dir = await createProject(cmd.request, (line) => emit({ type: 'createProgress', requestId: cmd.requestId, line }));
        // Its first message goes once it opens and its agent has started.
        if (cmd.request.description?.trim()) firstMessages.set(path.resolve(dir), { description: cmd.request.description, name: cmd.request.name });
        emit({ type: 'projectCreated', requestId: cmd.requestId, ok: true, dir });
      } catch (err) {
        emit({ type: 'projectCreated', requestId: cmd.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    case 'probeProvider':
      try {
        emit({ type: 'probe', requestId: cmd.requestId, ok: true, models: await probeModels(cmd.baseUrl, cmd.authToken) });
      } catch (err) {
        emit({ type: 'probe', requestId: cmd.requestId, ok: false, models: [], error: err instanceof Error ? err.message : String(err) });
      }
      return;
  }
}

function reportError(cmd: UiCommand | undefined, err: unknown): void {
  const text = err instanceof Error ? err.message : String(err);
  const project = cmd && 'project' in cmd ? cmd.project : cmd?.type === 'open' ? path.resolve(cmd.projectDir) : undefined;
  if (project && projects.has(project)) emit({ type: 'notice', level: 'error', text, project });
  else emit({ type: 'globalNotice', level: 'error', text });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let cmd: UiCommand;
  try {
    cmd = JSON.parse(line);
  } catch {
    return reportError(undefined, 'Sidecar received malformed JSON.');
  }
  started.then(() => handle(cmd)).catch((err) => reportError(cmd, err));
});
rl.on('close', async () => {
  await Promise.allSettled([...projects.keys()].map(closeProject));
  // Settings and usage still being written are finished, so quitting can't lose them.
  await Promise.allSettled([providers.flush(), usage.flush()]);
  process.exit(0);
});

function sdkVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const entry = req.resolve('@anthropic-ai/claude-agent-sdk');
    return JSON.parse(readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

// Commands that arrive while the provider list loads wait for it.
const started = migrateConfigDir()
  .catch((err) => process.stderr.write(`[desk] Couldn't move ~/.claude-desk: ${String(err)}\n`))
  .then(() => providers.load())
  .then(() => {
    emit({ type: 'ready', sdkVersion: sdkVersion(), appVersion: appVersion() });
    emit({ type: 'providers', list: providers.list() });
  });

// Claude Desk sidecar: one Claude Code session and one task watcher per open project,
// all running at once. Speaks newline-delimited JSON on stdin (commands) and stdout (events).
import { createInterface } from 'node:readline';
import { readFileSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { AgentSession } from './agent.js';
import { TaskWatcher, loadTaskConfig } from './tasks.js';
import { scanFramework } from './framework.js';
import { Priorities, promptFor, type DeskPrompts } from './actions.js';
import { ProviderStore, probeModels } from './providers.js';
import type { PermissionModeName, ProjectEvent, SidecarEvent, UiCommand } from './protocol.js';

// stdout is the protocol channel. Anything else that tries to print goes to stderr.
const writeOut = process.stdout.write.bind(process.stdout);
console.log = (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n');
console.info = console.log;

function emit(e: SidecarEvent): void {
  writeOut(JSON.stringify(e) + '\n');
}

// Make sure Claude Code uses your subscription login rather than a stray API key in the environment.
if (process.env.ANTHROPIC_API_KEY && process.env.CLAUDE_DESK_ALLOW_API_KEY !== '1') {
  delete process.env.ANTHROPIC_API_KEY;
  process.stderr.write('[desk] Ignoring ANTHROPIC_API_KEY so usage goes through your Claude login. Set CLAUDE_DESK_ALLOW_API_KEY=1 to keep it.\n');
}

// Events that make up the transcript are kept so a reloaded window can rebuild it.
// State events (tasks, processes, ...) only need their latest value.
const TRANSCRIPT = new Set<ProjectEvent['type']>([
  'user', 'assistantText', 'toolUse', 'toolResult', 'permissionRequest', 'permissionResolved', 'turnEnd', 'notice',
]);
const LATEST = new Set<ProjectEvent['type']>(['session', 'busy', 'processes', 'tasks', 'priorities']);
const MAX_TRANSCRIPT = 3000;

interface Project {
  dir: string;
  out: (e: ProjectEvent) => void;
  session: AgentSession;
  tasks: TaskWatcher;
  priorities: Priorities;
  prompts: DeskPrompts;
  projectEvent: ProjectEvent;
  transcript: ProjectEvent[];
  latest: Map<string, ProjectEvent>;
  openPermissions: Set<string>;
}

const projects = new Map<string, Project>();
const providers = new ProviderStore();

function projectEmitter(p: Pick<Project, 'dir' | 'transcript' | 'latest' | 'openPermissions'>) {
  return (e: ProjectEvent): void => {
    if (TRANSCRIPT.has(e.type)) {
      p.transcript.push(e);
      if (p.transcript.length > MAX_TRANSCRIPT) p.transcript.splice(0, p.transcript.length - MAX_TRANSCRIPT);
    }
    if (LATEST.has(e.type)) p.latest.set(e.type, e);
    if (e.type === 'permissionRequest') p.openPermissions.add(e.id);
    if (e.type === 'permissionResolved') p.openPermissions.delete(e.id);
    emit({ ...e, project: p.dir });
  };
}

async function loadPrompts(dir: string): Promise<DeskPrompts> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, '.claude-desk.json'), 'utf8'));
    return raw?.prompts && typeof raw.prompts === 'object' ? raw.prompts : {};
  } catch {
    return {};
  }
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

async function openProject(dirIn: string, mode: PermissionModeName = 'default'): Promise<void> {
  const dir = path.resolve(dirIn);
  const existing = projects.get(dir);
  if (existing) return replay(existing);

  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`Not a folder: ${dir}`);

  const shell = { dir, transcript: [] as ProjectEvent[], latest: new Map<string, ProjectEvent>(), openPermissions: new Set<string>() };
  const out = projectEmitter(shell);

  const [config, prompts, framework] = await Promise.all([loadTaskConfig(dir), loadPrompts(dir), scanFramework(dir)]);
  const provider = providers.forProject(dir);
  const projectEvent: ProjectEvent = { type: 'project', dir, name: path.basename(dir), framework, taskGlobs: config.taskGlobs, permissionMode: mode, providerId: provider.id };
  out(projectEvent);

  const priorities = new Priorities(dir);
  out({ type: 'priorities', order: await priorities.load() });

  const tasks = new TaskWatcher(dir, config, (files, docs) => out({ type: 'tasks', files, docs }));
  const session = new AgentSession(dir, mode, out, provider);
  const project: Project = { ...shell, out, session, tasks, priorities, prompts, projectEvent };
  projects.set(dir, project);

  tasks.start();
  session.processes.clear();
  session.start();
}

async function closeProject(dir: string): Promise<void> {
  const p = projects.get(dir);
  if (!p) return;
  projects.delete(dir);
  p.session.close();
  await p.tasks.stop();
  emit({ type: 'closed', project: dir });
}

/** Restart a project's Claude Code session on another provider. The task board keeps running. */
async function switchProvider(p: Project, providerId: string): Promise<void> {
  const provider = await providers.setForProject(p.dir, providerId);
  const mode = p.session.mode;
  p.session.close();
  p.session = new AgentSession(p.dir, mode, p.out, provider);
  p.session.processes.clear();
  p.session.start();
  p.latest.delete('session');
  p.out({ type: 'provider', providerId: provider.id });
  p.out({
    type: 'notice',
    level: 'info',
    text: provider.kind === 'subscription' ? 'Switched to your Claude subscription. This starts a new conversation.' : `Switched to ${provider.name} at ${provider.baseUrl}. This starts a new conversation.`,
  });
}

function need(dir: string): Project {
  const p = projects.get(dir);
  if (!p) throw new Error(`That project isn't open: ${dir}`);
  return p;
}

async function handle(cmd: UiCommand): Promise<void> {
  switch (cmd.type) {
    case 'open':
      return openProject(cmd.projectDir, cmd.permissionMode);
    case 'close':
      return closeProject(cmd.project);
    case 'send':
      if (cmd.text.trim()) need(cmd.project).session.send(cmd.text);
      return;
    case 'interrupt':
      return need(cmd.project).session.interrupt();
    case 'stopProcess':
      return need(cmd.project).session.stopProcess(cmd.id);
    case 'permissionReply':
      return need(cmd.project).session.replyPermission(cmd.id, cmd.decision, cmd.message);
    case 'setPermissionMode':
      return need(cmd.project).session.setPermissionMode(cmd.mode);
    case 'toggleTask':
      return need(cmd.project).tasks.toggle(cmd.rel, cmd.line, cmd.text);
    case 'togglePriority': {
      const p = need(cmd.project);
      return projectEmitter(p)({ type: 'priorities', order: await p.priorities.toggle(cmd.key) });
    }
    case 'readDocs': {
      const p = need(cmd.project);
      return projectEmitter(p)({ type: 'docs', requestId: cmd.requestId, key: cmd.key, docs: await p.tasks.readDocs(cmd.paths) });
    }
    case 'runAction': {
      const p = need(cmd.project);
      p.session.send(promptFor(cmd.action, cmd.item, p.prompts), { kind: cmd.action, key: cmd.item.key });
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
const started = providers.load().then(() => {
  emit({ type: 'ready', sdkVersion: sdkVersion() });
  emit({ type: 'providers', list: providers.list() });
});

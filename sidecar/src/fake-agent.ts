import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { messagesToEvents } from './history.js';
import { configDir } from './names.js';
import type { AskedQuestion, ItemAction, PermissionModeName, ProjectEvent, ProviderConfig } from './protocol.js';
import { SUBSCRIPTION } from './providers.js';
import { ProcessTracker } from './processes.js';

// A scripted stand-in for AgentSession, for the interface tests (SLOP_FACTORY_FAKE_AGENT=1).
// It never calls a model: what it does depends on words in the message.
//   "ask me"       asks two multiple-choice questions and replies with the answers
//   "permission"   asks to run a shell command first
//   "questions"    replies with a numbered list of questions
//   "subagent"     runs a background subagent for a moment
//   "slow"         takes a few seconds, so a test can press Stop
//   anything else  replies "Done: <first line of the message>"

export const ASKED: AskedQuestion[] = [
  {
    question: 'Which database should we use?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'SQLite (Recommended)', description: 'One file, nothing to run.' },
      { label: 'Postgres', description: 'A server, more features.' },
    ],
  },
  {
    question: 'Which platforms matter?',
    header: 'Platforms',
    multiSelect: true,
    options: [
      { label: 'Web (Recommended)', description: 'Runs anywhere.' },
      { label: 'Desktop', description: 'Windows, macOS and Linux.' },
    ],
  },
];

export class FakeSession {
  readonly processes: ProcessTracker;
  private pendingTurns = 0;
  private waiting = new Map<string, (answer: unknown) => void>();
  private timers = new Set<NodeJS.Timeout>();
  private stopTurn?: () => void;

  constructor(
    private cwd: string,
    private permissionMode: PermissionModeName,
    private emit: (e: ProjectEvent) => void,
    readonly provider: ProviderConfig = SUBSCRIPTION,
    private resume?: string,
  ) {
    this.processes = new ProcessTracker((list) => this.emit({ type: 'processes', list }));
  }

  onSession?: (id: string) => void;
  private sessionId = '';
  private subagents = new Map<string, ProjectEvent[]>();

  async subagentLog(agentId: string): Promise<ProjectEvent[]> {
    return this.subagents.get(agentId) ?? [];
  }

  /** Its conversations are kept like Claude Code's, one file each, so they can be picked up. */
  static history(id: string): ProjectEvent[] {
    try {
      const lines = readFileSync(path.join(configDir(), 'fake-sessions', `${id}.jsonl`), 'utf8').split('\n').filter(Boolean);
      return messagesToEvents(lines.map((l) => JSON.parse(l)));
    } catch {
      return [];
    }
  }

  private record(type: 'user' | 'assistant', text: string): void {
    const dir = path.join(configDir(), 'fake-sessions');
    mkdirSync(dir, { recursive: true });
    const message = type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] };
    appendFileSync(path.join(dir, `${this.sessionId}.jsonl`), JSON.stringify({ type, uuid: randomUUID(), message, parent_tool_use_id: null }) + '\n');
  }

  start(): void {
    this.sessionId = this.resume ?? randomUUID();
    this.onSession?.(this.sessionId);
    this.emit({
      type: 'session',
      info: {
        model: 'fake-model',
        cwd: this.cwd,
        apiKeySource: 'none',
        claudeCodeVersion: 'fake',
        permissionMode: this.permissionMode,
        tools: ['Bash', 'Read', 'Edit', 'AskUserQuestion', 'Agent'],
        skills: [],
        agents: [],
        mcpServers: [],
        slashCommands: ['compact', 'review'],
      },
    });
  }

  get busy(): boolean {
    return this.pendingTurns > 0;
  }

  get mode(): PermissionModeName {
    return this.permissionMode;
  }

  send(text: string, action?: { kind: ItemAction; key: string }): void {
    this.pendingTurns++;
    this.emit({ type: 'user', text, action });
    this.emit({ type: 'busy', busy: true });
    this.record('user', text);
    void this.turn(text);
  }

  async interrupt(): Promise<void> {
    this.stopTurn?.();
  }

  async stopProcess(id: string): Promise<void> {
    this.processes.ended({ task_id: id, status: 'stopped', summary: 'Stopped' });
  }

  async setPermissionMode(mode: PermissionModeName): Promise<PermissionModeName> {
    this.permissionMode = mode;
    return mode;
  }

  replyPermission(id: string, decision: 'allow' | 'always' | 'deny'): void {
    this.waiting.get(id)?.(decision);
  }

  answerQuestions(id: string, answers?: Record<string, string>): void {
    this.waiting.get(id)?.(answers ?? null);
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.stopTurn?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms);
      this.timers.add(t);
    });
  }

  private ask<T>(id: string, event: ProjectEvent): Promise<T> {
    return new Promise((resolve) => {
      this.waiting.set(id, (answer) => {
        this.waiting.delete(id);
        this.emit({ type: 'permissionResolved', id });
        resolve(answer as T);
      });
      this.emit(event);
    });
  }

  private reply(text: string): void {
    const msgId = `msg_${randomUUID()}`;
    this.emit({ type: 'assistantDelta', msgId, index: 0, text: text.slice(0, 10) });
    this.emit({ type: 'assistantText', msgId, text, parent: null });
    this.record('assistant', text);
  }

  private async turn(text: string): Promise<void> {
    let stopped = false;
    const stop = new Promise<void>((resolve) => (this.stopTurn = () => ((stopped = true), resolve())));
    const lower = text.toLowerCase();
    const work = (async () => {
      await this.sleep(60);
      if (lower.includes('permission')) {
        const id = randomUUID();
        const decision = await this.ask<string>(id, { type: 'permissionRequest', id, toolName: 'Bash', input: { command: 'npm test' } });
        if (decision !== 'deny') this.emit({ type: 'toolUse', id: `tool_${id}`, name: 'Bash', input: { command: 'npm test' }, parent: null });
      }
      if (lower.includes('ask me')) {
        const id = randomUUID();
        const answers = await this.ask<Record<string, string> | null>(id, { type: 'askQuestions', id, questions: ASKED });
        return this.reply(answers ? `Thanks. ${Object.values(answers).join('; ')}.` : "I'll wait for your answer in the chat.");
      }
      if (lower.includes('questions')) {
        return this.reply('Before I start:\n\n1. Which database should we use?\n2. Do you need offline support?');
      }
      if (lower.includes('subagent')) {
        const taskId = `task_${randomUUID().slice(0, 8)}`;
        const toolId = `tool_${taskId}`;
        this.emit({ type: 'toolUse', id: toolId, name: 'Agent', input: { description: 'Work in a worktree', isolation: 'worktree' }, parent: null });
        this.processes.started({ task_id: taskId, task_type: 'local_agent', description: 'Work in a worktree', tool_use_id: toolId });
        // What the subagent says and does, tagged with it, as forwardSubagentText delivers it.
        const said: ProjectEvent[] = [
          { type: 'assistantText', msgId: `sub_${taskId}_1`, text: 'Reading the task and its spec.', parent: toolId, agent: taskId },
          { type: 'toolUse', id: `sub_${taskId}_t`, name: 'Bash', input: { command: 'npm test' }, parent: toolId, agent: taskId },
          { type: 'toolResult', toolUseId: `sub_${taskId}_t`, isError: false, preview: '12 passing', agent: taskId },
        ];
        this.subagents.set(taskId, said);
        for (const e of said) this.emit(e);
        await this.sleep(lower.includes('slow') ? 3000 : 400);
        const last: ProjectEvent = { type: 'assistantText', msgId: `sub_${taskId}_2`, text: 'All done; the work is committed on its branch.', parent: toolId, agent: taskId };
        said.push(last);
        this.emit(last);
        this.processes.ended({ task_id: taskId, status: 'completed', summary: 'Finished in its worktree.' });
        return this.reply('The subagent has finished.');
      }
      if (lower.includes('slow')) await this.sleep(4000);
      this.reply(`Done: ${text.split('\n')[0].slice(0, 80)}`);
    })();
    await Promise.race([work, stop]);
    this.stopTurn = undefined;
    this.pendingTurns = Math.max(0, this.pendingTurns - 1);
    this.emit({ type: 'turnEnd', durationMs: 100, numTurns: 1, isError: false, stopped, inputTokens: 10, outputTokens: 20, costUsd: 0 });
    if (this.pendingTurns === 0) this.emit({ type: 'busy', busy: false });
  }
}

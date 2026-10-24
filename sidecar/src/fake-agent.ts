import { randomUUID } from 'node:crypto';
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
  ) {
    this.processes = new ProcessTracker((list) => this.emit({ type: 'processes', list }));
  }

  start(): void {
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
        this.processes.started({ task_id: taskId, task_type: 'local_agent', description: 'Work in a worktree' });
        await this.sleep(400);
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

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { messagesToEvents } from './history.js';
import { messageContent } from './attachments.js';
import type { ModelTotals } from './usage.js';
import { serverContextWindow } from './context.js';
import { configDir } from './names.js';
import type { AskedQuestion, Attachment, SentAction, PermissionModeName, ProjectEvent, ProviderConfig } from './protocol.js';
import { SUBSCRIPTION } from './providers.js';
import { ProcessTracker } from './processes.js';

// A scripted stand-in for AgentSession, for the interface tests (SLOP_FACTORY_FAKE_AGENT=1).
// It never calls a model: what it does depends on words in the message.
//   "ask me"       asks two multiple-choice questions and replies with the answers
//   "permission"   asks to run a shell command first
//   "questions"    replies with a numbered list of questions
//   "subagent"     runs a background subagent for a moment
//   "slow"         takes a few seconds, so a test can press Stop
//   "edit"         adds a line to notes.txt in the project, with a checkpoint to undo it
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
    public provider: ProviderConfig = SUBSCRIPTION, // its model follows a switch made while it runs
    private resume?: string,
  ) {
    this.processes = new ProcessTracker((list) => this.emit({ type: 'processes', list }));
    this.model = provider.model ?? 'fake-model';
  }

  onSession?: (id: string) => void;
  onUsage?: (sessionId: string, costUsd: number, models: Record<string, ModelTotals>, durationMs: number) => void;
  private turns: Promise<void> = Promise.resolve();
  private totals = { costUsd: 0, out: 0 }; // the conversation's running totals, as a real result carries them
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

  private record(type: 'user' | 'assistant', text: string | unknown[]): void {
    const dir = path.join(configDir(), 'fake-sessions');
    mkdirSync(dir, { recursive: true });
    const message = type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] };
    appendFileSync(path.join(dir, `${this.sessionId}.jsonl`), JSON.stringify({ type, uuid: randomUUID(), message, parent_tool_use_id: null }) + '\n');
  }

  private model: string;

  /** Like the subscription's list: the current models by alias, then earlier versions by id. */
  async supportedModels(): Promise<{ value: string; displayName: string; description: string; resolvedModel?: string }[]> {
    return [
      { value: 'default', displayName: 'Default (recommended)', description: 'Fake Opus · The usual choice', resolvedModel: 'fake-opus' },
      { value: 'opus', displayName: 'Fake Opus', description: 'The usual choice', resolvedModel: 'fake-opus' },
      { value: 'sonnet', displayName: 'Fake Sonnet', description: 'Quicker', resolvedModel: 'fake-sonnet' },
      { value: 'claude-fake-opus-old', displayName: 'Fake Opus (earlier)', description: 'An earlier version' },
    ];
  }

  async setModel(model: string | undefined): Promise<void> {
    this.model = model ?? this.provider.model ?? 'fake-model';
    this.emitSession();
  }

  start(): void {
    this.sessionId = this.resume ?? randomUUID();
    this.onSession?.(this.sessionId);
    this.emitSession();
  }

  private emitSession(): void {
    this.emit({
      type: 'session',
      info: {
        model: this.model,
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
    this.emit({
      type: 'commands',
      commands: [
        { name: 'compact', description: 'Clear the conversation but keep a summary of it in context' },
        { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
        { name: 'task-tracking', description: 'Track tasks and bugs in task.md' },
      ],
    });
  }

  private holds = 0; // a compaction before a task: the session stays busy until the task is sent
  private idleWaiters: ((stopped: boolean) => void)[] = [];
  private sentAny = false;

  get busy(): boolean {
    return this.pendingTurns > 0 || this.holds > 0;
  }

  /** Whether there's a conversation to compact: something sent, or one picked up from before. */
  get hasConversation(): boolean {
    return this.sentAny || !!this.resume;
  }

  /**
   * Compact the conversation, then send. The session stays busy in between, so finishing the
   * compaction doesn't look like the end of the work (the queue would start the next item).
   * Stopping the compaction stops the task too.
   */
  async compactThen(text: string, action: { kind: SentAction; key: string }): Promise<void> {
    this.holds++;
    try {
      this.send('/compact', { kind: 'compact', key: action.key });
      const stopped = await new Promise<boolean>((resolve) => this.idleWaiters.push(resolve));
      if (!stopped) this.send(text, action);
    } finally {
      this.holds--;
      if (!this.busy) this.emit({ type: 'busy', busy: false });
    }
  }

  /** Every turn sent so far has ended: let a compactThen carry on. */
  private settleWaiters(stopped: boolean): void {
    if (this.pendingTurns === 0) this.idleWaiters.splice(0).forEach((resolve) => resolve(stopped));
  }

  get mode(): PermissionModeName {
    return this.permissionMode;
  }

  send(text: string, action?: { kind: SentAction; key: string }, attachments: Attachment[] = []): void {
    this.pendingTurns++;
    this.sentAny = true;
    const uuid = randomUUID();
    this.turnIds.push(uuid);
    const names = attachments.map((a) => a.name);
    this.emit({ type: 'user', text, action, uuid, ...(names.length ? { attachments: names } : {}) });
    this.emit({ type: 'busy', busy: true });
    this.record('user', messageContent(text, attachments));
    // One turn at a time: a message sent mid-turn waits for its own, as with the real agent.
    this.turns = this.turns.then(() => this.turn(text, uuid, names));
  }

  // Checkpoints, as enableFileCheckpointing keeps them: each file's content before a turn first changed it.
  private turnIds: string[] = [];
  private backups = new Map<string, Map<string, string | null>>();

  private changeFile(uuid: string, file: string, next: string): string {
    const abs = path.join(this.cwd, file);
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    const saved = this.backups.get(uuid) ?? new Map<string, string | null>();
    if (!saved.has(file)) saved.set(file, before);
    this.backups.set(uuid, saved);
    writeFileSync(abs, next);
    return before ?? '';
  }

  async rewindFiles(uuid: string, dryRun: boolean): Promise<{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }> {
    const from = this.turnIds.indexOf(uuid);
    if (from < 0) return { canRewind: false, error: 'No checkpoint for that message.' };
    // The earliest saved state of each file at or after this turn is how it was when the turn began.
    const restore = new Map<string, string | null>();
    for (const id of this.turnIds.slice(from)) for (const [f, c] of this.backups.get(id) ?? []) if (!restore.has(f)) restore.set(f, c);
    if (!restore.size) return { canRewind: false, error: 'Nothing changed since that message.' };
    if (!dryRun) {
      for (const [f, c] of restore) {
        if (c === null) rmSync(path.join(this.cwd, f), { force: true });
        else writeFileSync(path.join(this.cwd, f), c);
      }
      for (const id of this.turnIds.slice(from)) this.backups.delete(id);
    }
    return { canRewind: true, filesChanged: [...restore.keys()], insertions: 0, deletions: restore.size };
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

  /** A background subagent in a worktree, as the Agent tool runs one. */
  private async subagent(description: string, slow: boolean): Promise<void> {
    const taskId = `task_${randomUUID().slice(0, 8)}`;
    const toolId = `tool_${taskId}`;
    this.emit({ type: 'toolUse', id: toolId, name: 'Agent', input: { description, isolation: 'worktree' }, parent: null });
    this.processes.started({ task_id: taskId, task_type: 'local_agent', description, tool_use_id: toolId });
    // What the subagent says and does, tagged with it, as forwardSubagentText delivers it.
    const said: ProjectEvent[] = [
      { type: 'assistantText', msgId: `sub_${taskId}_1`, text: 'Reading the task and its spec.', parent: toolId, agent: taskId },
      { type: 'toolUse', id: `sub_${taskId}_t`, name: 'Bash', input: { command: 'npm test' }, parent: toolId, agent: taskId },
      { type: 'toolResult', toolUseId: `sub_${taskId}_t`, isError: false, preview: '12 passing', agent: taskId },
    ];
    this.subagents.set(taskId, said);
    for (const e of said) this.emit(e);
    await this.sleep(slow ? 3000 : 400);
    const last: ProjectEvent = { type: 'assistantText', msgId: `sub_${taskId}_2`, text: 'All done; the work is committed on its branch.', parent: toolId, agent: taskId };
    said.push(last);
    this.emit(last);
    this.processes.ended({ task_id: taskId, status: 'completed', summary: 'Finished in its worktree.' });
  }

  private async turn(text: string, uuid: string, attached: string[] = []): Promise<void> {
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
      if (text.trim() === '/compact') {
        await this.sleep(lower.includes('slow') ? 2000 : 150);
        return this.reply('Conversation compacted.');
      }
      if (lower.includes('several tools')) {
        // A run of calls, as the agent makes while it looks around.
        const calls: [string, unknown, string][] = [
          ['Read', { file_path: path.join(this.cwd, 'plan.md') }, '# A small app'],
          ['Grep', { pattern: 'export' }, 'src/app.js'],
          ['Bash', { command: 'npm test' }, '12 passing'],
        ];
        for (const [name, input, out] of calls) {
          const id = `tool_${randomUUID().slice(0, 8)}`;
          this.emit({ type: 'toolUse', id, name, input, parent: null });
          await this.sleep(30);
          this.emit({ type: 'toolResult', toolUseId: id, isError: false, preview: out });
        }
        return this.reply('I had a look around.');
      }
      if (lower.includes('tool that hangs')) {
        // A call whose result never comes before the turn is stopped.
        this.emit({ type: 'toolUse', id: `tool_${randomUUID().slice(0, 8)}`, name: 'Bash', input: { command: 'sleep 600' }, parent: null });
        await this.sleep(10_000);
        if (stopped) return;
        return this.reply('Finished waiting.');
      }
      if (lower.includes('choose a provider')) {
        return this.reply(
          'You dismissed the questions, so reply with your pick and I will record it in plan.md and take it off the open questions list:\n\n' +
            '1. **Stripe (Recommended):** official Node SDK and hosted card entry.\n2. **PayPal:** clients can pay with a PayPal account.\n\n' +
            'Which of these should take the card payments?',
        );
      }
      if (lower.includes('questions')) {
        return this.reply('Before I start:\n\n1. Which database should we use?\n2. Do you need offline support?');
      }
      if (lower.includes('find the work') && lower.includes('workstream')) {
        writeFileSync(
          path.join(this.cwd, 'tasks', 'workstream.md'),
          '# Workstreams\n\n## W1: Email and scheduling\n- Tasks: T4, T3\n- Touches: server/email/\n- Waits on: none\n\n' +
            '## W2: Reports\n- Tasks: T5, B1\n- Touches: web/reports/\n- Waits on: none\n\n## Revision history\n\n| Date | Change |\n|---|---|\n| 2026-10-24 | First version. |\n',
        );
        return this.reply('I found 2 workstreams and wrote them to tasks/workstream.md.');
      }
      if (lower.startsWith('run these workstreams')) {
        const streams = [...text.matchAll(/^- (W\d+): ([^.]+)\./gm)].map((m) => `${m[1]}: ${m[2]}`);
        await Promise.all(streams.map((s) => this.subagent(`Workstream ${s}`, lower.includes('slow'))));
        return this.reply(`All ${streams.length} workstreams have finished.`);
      }
      if (lower.includes('subagent')) {
        await this.subagent('Work in a worktree', lower.includes('slow'));
        return this.reply('The subagent has finished.');
      }
      if (lower.includes('edit')) {
        const before = existsSync(path.join(this.cwd, 'notes.txt')) ? readFileSync(path.join(this.cwd, 'notes.txt'), 'utf8') : '';
        const line = `${text.split('\n')[0]}\n`;
        this.changeFile(uuid, 'notes.txt', before + line);
        const id = `edit_${randomUUID().slice(0, 8)}`;
        this.emit({ type: 'toolUse', id, name: before ? 'Edit' : 'Write', input: before ? { file_path: path.join(this.cwd, 'notes.txt'), old_string: before, new_string: before + line } : { file_path: path.join(this.cwd, 'notes.txt'), content: line }, parent: null });
        this.emit({ type: 'toolResult', toolUseId: id, isError: false, preview: 'The file notes.txt has been updated.' });
      }
      if (lower.includes('limit')) this.emit({ type: 'planLimit', limit: { status: 'allowed_warning', window: 'five_hour', utilization: 0.82, resetsAt: Math.floor(Date.now() / 1000) + 7200 } });
      if (lower.includes('slow')) await this.sleep(4000);
      if (attached.length) return this.reply(`I can see ${attached.join(', ')}.`);
      this.reply(`Done: ${text.split('\n')[0].slice(0, 80)}`);
    })();
    await Promise.race([work, stop]);
    this.stopTurn = undefined;
    this.pendingTurns = Math.max(0, this.pendingTurns - 1);
    this.totals.costUsd += 0.25;
    this.totals.out += 20;
    this.onUsage?.(this.sessionId, this.totals.costUsd, { 'fake-model': { inputTokens: 10 * (this.totals.out / 20), outputTokens: this.totals.out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: this.totals.costUsd } }, 100);
    this.emit({ type: 'turnEnd', durationMs: 100, numTurns: 1, isError: false, stopped, inputTokens: 10, outputTokens: 20, costUsd: this.totals.costUsd });
    // Gauges as the real agent reports them: the context grows with each turn.
    const tokens = 18_000 + 6_000 * (this.totals.out / 20);
    if (this.provider.kind === 'subscription') {
      const hour = 3_600_000;
      this.emit({ type: 'gauges', gauges: { fiveHour: { used: 0.42, resetsAt: Date.now() + 2 * hour }, week: { used: 0.86, resetsAt: Date.now() + 75 * hour }, context: { tokens, max: 200_000 } } });
    } else {
      const max = (await serverContextWindow(this.provider).catch(() => undefined)) ?? this.provider.contextTokens;
      this.emit({ type: 'gauges', gauges: { context: { tokens, max, fromServer: !!max } } });
    }
    this.settleWaiters(stopped);
    if (!this.busy) this.emit({ type: 'busy', busy: false });
  }
}

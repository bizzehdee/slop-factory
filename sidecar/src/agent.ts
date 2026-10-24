import {
  getSubagentMessages,
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionResult,
  type PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { AskedQuestion, Attachment, Gauge, Gauges, SentAction, PermissionModeName, ProjectEvent, ProviderConfig } from './protocol.js';
import { sessionSettings, SUBSCRIPTION } from './providers.js';
import { ProcessTracker } from './processes.js';
import { messagesToEvents } from './history.js';
import { messageContent } from './attachments.js';
import type { ModelTotals } from './usage.js';
import { serverContextWindow } from './context.js';

/** An async queue we hand to query() as its prompt, so one Claude Code session lives across many turns. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(msg: SDKUserMessage): void {
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type PendingPermission = {
  resolve: (r: PermissionResult) => void;
  suggestions?: PermissionUpdate[];
  input: Record<string, unknown>;
};

const PREVIEW_CHARS = 4000;

function resultPreview(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, PREVIEW_CHARS);
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : `[${(b as { type?: string })?.type ?? 'block'}]`))
      .join('\n')
      .slice(0, PREVIEW_CHARS);
  }
  return '';
}

function askedQuestions(input: Record<string, unknown>): AskedQuestion[] {
  const list = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
  return list.map((q) => ({
    question: String(q.question ?? ''),
    header: String(q.header ?? ''),
    multiSelect: !!q.multiSelect,
    options: (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : []).map((o) => ({ label: String(o.label ?? ''), description: String(o.description ?? '') })),
  }));
}

export class AgentSession {
  private q?: Query;
  private input = new InputQueue();
  private abort = new AbortController();
  private pendingTurns = 0;
  private permissions = new Map<string, PendingPermission>();
  readonly processes: ProcessTracker;

  constructor(
    private cwd: string,
    private permissionMode: PermissionModeName,
    private emit: (e: ProjectEvent) => void,
    readonly provider: ProviderConfig = SUBSCRIPTION,
    private resume?: string, // a conversation to pick up
  ) {
    this.processes = new ProcessTracker((list) => this.emit({ type: 'processes', list }));
  }

  /** Told the conversation's id once Claude Code starts, so it can be picked up later. */
  onSession?: (id: string) => void;
  /** A turn ended: the conversation's running totals, for the usage ledger. */
  onUsage?: (sessionId: string, costUsd: number, models: Record<string, ModelTotals>, durationMs: number) => void;
  private sessionId?: string;

  /** A subagent's transcript from Claude Code's files, for one the window didn't see live. */
  async subagentLog(agentId: string): Promise<ProjectEvent[]> {
    const id = this.sessionId ?? this.resume;
    if (!id) return [];
    return messagesToEvents((await getSubagentMessages(id, agentId, { dir: this.cwd })) as Parameters<typeof messagesToEvents>[0]).map((e) => ({ ...e, agent: agentId }) as ProjectEvent);
  }

  start(): void {
    const { env, model } = sessionSettings(this.provider);
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        abortController: this.abort,
        // Load the same things the CLI would: your user settings plus the project's
        // CLAUDE.md, .claude/settings.json (hooks, permissions), agents, skills and commands.
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        permissionMode: this.permissionMode,
        includePartialMessages: true,
        // Subagents' own text too, tagged with the subagent, so the window can show each one's transcript.
        forwardSubagentText: true,
        // Back up files before the agent changes them, so a turn's changes can be undone.
        enableFileCheckpointing: true,
        // AskUserQuestion reaches canUseTool like any tool; the Questions panel renders it.
        canUseTool: (toolName, input, opts) => this.askPermission(toolName, input, opts),
        stderr: (data) => process.stderr.write(`[claude] ${data}`),
        ...(env ? { env } : {}),
        ...(model ? { model } : {}),
        ...(this.resume ? { resume: this.resume } : {}),
      },
    });
    void this.pump();
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
    this.emit({ type: 'user', text, action, uuid, ...(attachments.length ? { attachments: attachments.map((a) => a.name) } : {}) });
    this.emit({ type: 'busy', busy: true });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: messageContent(text, attachments) },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
      uuid,
    } as SDKUserMessage);
  }

  /** Put the files the agent changed back as they were when that message was sent (checkpoints). */
  async rewindFiles(uuid: string, dryRun: boolean): Promise<{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }> {
    if (!this.q) return { canRewind: false, error: 'The agent has not started yet.' };
    return this.q.rewindFiles(uuid, { dryRun });
  }

  async interrupt(): Promise<void> {
    if (this.pendingTurns > 0) this.interrupted = true;
    await this.q?.interrupt();
  }

  private interrupted = false; // Stop was pressed: the turn's end is a stop, not an error

  async stopProcess(id: string): Promise<void> {
    await this.q?.stopTask(id);
  }

  /** Returns the mode actually in effect: Claude Code can refuse auto mode (model, plan or provider). */
  async setPermissionMode(mode: PermissionModeName): Promise<PermissionModeName> {
    const previous = this.permissionMode;
    try {
      await this.q?.setPermissionMode(mode);
      this.permissionMode = mode;
    } catch (err) {
      this.emit({ type: 'notice', level: 'warn', text: `The agent didn't switch to ${mode === 'auto' ? 'auto mode' : mode}: ${err instanceof Error ? err.message : String(err)}` });
      this.permissionMode = previous;
    }
    return this.permissionMode;
  }

  replyPermission(id: string, decision: 'allow' | 'always' | 'deny', message?: string): void {
    const p = this.permissions.get(id);
    if (!p) return;
    this.permissions.delete(id);
    if (decision === 'deny') p.resolve({ behavior: 'deny', message: message || 'The user declined this action.' });
    else p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: decision === 'always' ? p.suggestions : undefined });
    this.emit({ type: 'permissionResolved', id });
  }

  /** Answer an AskUserQuestion call: answers keyed by question text, or none to dismiss it. */
  answerQuestions(id: string, answers?: Record<string, string>): void {
    const p = this.permissions.get(id);
    if (!p) return;
    this.permissions.delete(id);
    if (!answers) p.resolve({ behavior: 'deny', message: 'The user dismissed these questions and will answer in the conversation instead.' });
    else p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers } });
    this.emit({ type: 'permissionResolved', id });
  }

  close(): void {
    for (const [id] of this.permissions) this.replyPermission(id, 'deny', 'Session closed.');
    this.input.close();
    this.q?.close();
    this.abort.abort();
  }

  private askPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; decisionReason?: string },
  ): Promise<PermissionResult> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.permissions.set(id, { resolve, suggestions: opts.suggestions, input });
      opts.signal.addEventListener('abort', () => {
        if (this.permissions.delete(id)) {
          this.emit({ type: 'permissionResolved', id });
          resolve({ behavior: 'deny', message: 'Cancelled.' });
        }
      });
      if (toolName === 'AskUserQuestion') this.emit({ type: 'askQuestions', id, questions: askedQuestions(input) });
      else this.emit({ type: 'permissionRequest', id, toolName, input, reason: opts.decisionReason });
    });
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q!) this.handle(msg);
    } catch (err) {
      if (!this.abort.signal.aborted) this.emit({ type: 'notice', level: 'error', text: `The agent session ended: ${String(err)}` });
    } finally {
      this.pendingTurns = 0;
      this.settleWaiters(true);
      this.emit({ type: 'busy', busy: false });
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        return this.handleSystem(msg);

      case 'stream_event': {
        if (msg.parent_tool_use_id) return; // don't stream subagent chatter into the main transcript
        const ev = msg.event as { type: string; index?: number; message?: { id: string }; delta?: { type: string; text?: string } };
        if (ev.type === 'message_start' && ev.message) this.currentMsgId = ev.message.id;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          this.emit({ type: 'assistantDelta', msgId: this.currentMsgId, index: ev.index ?? 0, text: ev.delta.text });
        }
        return;
      }

      case 'assistant': {
        const parent = msg.parent_tool_use_id;
        const agent = (msg as { agent_id?: string }).agent_id;
        for (const block of msg.message.content as unknown as { type: string; [k: string]: unknown }[]) {
          if (block.type === 'text') this.emit({ type: 'assistantText', msgId: msg.message.id, text: String(block.text ?? ''), parent, agent });
          else if (block.type === 'thinking' && !parent && block.thinking) this.emit({ type: 'thinking', msgId: msg.message.id, text: String(block.thinking) });
          else if (block.type === 'tool_use') {
            const id = String(block.id);
            this.processes.noteToolUse(id, block.input);
            this.emit({ type: 'toolUse', id, name: String(block.name), input: block.input, parent, agent });
          }
        }
        if (msg.error) this.emit({ type: 'notice', level: 'error', text: `The agent reported an error: ${msg.error}` });
        return;
      }

      case 'user': {
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        const agent = (msg as { agent_id?: string }).agent_id;
        for (const block of content as { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            this.emit({ type: 'toolResult', toolUseId: block.tool_use_id, isError: !!block.is_error, preview: resultPreview(block.content), agent });
          }
        }
        return;
      }

      case 'rate_limit_event': {
        const r = msg.rate_limit_info;
        // A fraction; a percentage is taken as one too, in case that changes.
        const used = r.utilization != null && r.utilization > 1 ? r.utilization / 100 : r.utilization;
        this.emit({ type: 'planLimit', limit: { status: r.status, window: r.rateLimitType, utilization: used, resetsAt: r.resetsAt } });
        // Keep the gauges current too, in case the usage figures can't be asked for.
        const g = used != null ? { used, resetsAt: r.resetsAt ? r.resetsAt * 1000 : undefined } : undefined;
        if (g && r.rateLimitType === 'five_hour') this.limits.fiveHour = g;
        if (g && r.rateLimitType === 'seven_day') this.limits.week = g;
        return;
      }

      case 'result': {
        // Messages sent mid-turn can be folded into one turn, so one result can answer several:
        // trust the count of sends still waiting when the agent reports it.
        const waiting = (msg as { queued_turn_count?: number }).queued_turn_count;
        this.pendingTurns = typeof waiting === 'number' ? waiting : Math.max(0, this.pendingTurns - 1);
        if (this.sessionId && msg.modelUsage) this.onUsage?.(this.sessionId, msg.total_cost_usd ?? 0, msg.modelUsage, msg.duration_ms);
        const stopped = this.interrupted;
        this.interrupted = false;
        // Internal diagnostics ride along in errors; they mean nothing to the person reading.
        const errors = msg.subtype === 'success' ? undefined : msg.errors?.filter((e) => !e.startsWith('[ede_diagnostic]'));
        this.emit({
          type: 'turnEnd',
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
          isError: msg.is_error && !stopped,
          stopped,
          inputTokens: msg.usage?.input_tokens ?? 0,
          outputTokens: msg.usage?.output_tokens ?? 0,
          costUsd: msg.total_cost_usd ?? 0,
          errors: stopped ? undefined : errors,
        });
        this.settleWaiters(stopped);
        if (!this.busy) this.emit({ type: 'busy', busy: false });
        void this.reportGauges();
        return;
      }

      default:
        return;
    }
  }

  private currentMsgId = '';

  private limitsAt = 0;
  private limits: Pick<Gauges, 'fiveHour' | 'week'> = {};

  /** The Session panel's gauges, after each turn: the context, and the subscription's usage windows. */
  private async reportGauges(): Promise<void> {
    const q = this.q;
    if (!q) return;
    const gauges: Gauges = {};
    const c = await q.getContextUsage({ detail: 'summary' }).catch(() => undefined);
    if (this.provider.kind !== 'subscription') {
      // A local model: the server knows the real window; only the context applies.
      const max = (await serverContextWindow(this.provider).catch(() => undefined)) ?? this.provider.contextTokens;
      gauges.context = { tokens: c?.totalTokens ?? 0, max: max ?? c?.maxTokens, fromServer: !!max };
    } else {
      if (c) gauges.context = { tokens: c.totalTokens, max: c.maxTokens };
      // The windows change slowly; ask at most once a minute.
      if (Date.now() - this.limitsAt > 60_000) {
        this.limitsAt = Date.now();
        const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => undefined);
        const gauge = (w?: { utilization: number | null; resets_at: string | null } | null): Gauge | undefined =>
          w && w.utilization != null ? { used: Math.min(1, Math.max(0, w.utilization / 100)), resetsAt: w.resets_at ? Date.parse(w.resets_at) || undefined : undefined } : undefined;
        if (u?.rate_limits) this.limits = { fiveHour: gauge(u.rate_limits.five_hour), week: gauge(u.rate_limits.seven_day) };
      }
      Object.assign(gauges, this.limits);
    }
    this.emit({ type: 'gauges', gauges });
  }

  private emitCommands(list: { name: string; description: string; argumentHint?: string }[]): void {
    this.emit({ type: 'commands', commands: list.map((c) => ({ name: c.name, description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) })) });
  }

  private handleSystem(msg: Extract<SDKMessage, { type: 'system' }>): void {
    switch (msg.subtype) {
      case 'init':
        this.sessionId = msg.session_id;
        if (msg.session_id) this.onSession?.(msg.session_id);
        this.emit({
          type: 'session',
          info: {
            model: msg.model,
            cwd: msg.cwd,
            apiKeySource: msg.apiKeySource,
            claudeCodeVersion: msg.claude_code_version,
            permissionMode: msg.permissionMode,
            tools: msg.tools,
            skills: msg.skills ?? [],
            agents: msg.agents ?? [],
            mcpServers: msg.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
            slashCommands: msg.slash_commands,
          },
        });
        void this.q?.supportedCommands().then((c) => this.emitCommands(c), () => undefined);
        // Claude Code may start in a different mode than asked (auto mode can be unavailable).
        if (msg.permissionMode && msg.permissionMode !== this.permissionMode) {
          const asked = this.permissionMode;
          this.permissionMode = msg.permissionMode as PermissionModeName;
          this.emit({ type: 'mode', mode: this.permissionMode });
          if (asked === 'auto') this.emit({ type: 'notice', level: 'warn', text: `Auto mode isn't available for this session, so the agent started in "${msg.permissionMode}" mode instead.` });
        }
        if (this.provider.kind === 'subscription' && msg.apiKeySource !== 'oauth' && msg.apiKeySource !== 'none') {
          this.emit({ type: 'notice', level: 'warn', text: `The agent is signed in with "${msg.apiKeySource}", not your subscription login. Usage may be billed to the API.` });
        }
        return;
      case 'commands_changed':
        return this.emitCommands(msg.commands);
      case 'background_tasks_changed':
        return this.processes.replaceLive(msg.tasks);
      case 'task_started':
        return this.processes.started(msg);
      case 'task_updated':
        return this.processes.updated(msg);
      case 'task_progress':
        return this.processes.progress(msg);
      case 'task_notification':
        return this.processes.ended(msg);
      case 'status':
        this.emit({ type: 'busy', busy: this.pendingTurns > 0, status: msg.status });
        return;
      case 'api_retry':
        this.emit({ type: 'notice', level: 'warn', text: `API retry ${msg.attempt}/${msg.max_retries} (${msg.error})` });
        return;
      case 'compact_boundary':
        this.emit({ type: 'notice', level: 'info', text: 'Conversation compacted to free up context.' });
        return;
      default:
        return;
    }
  }
}

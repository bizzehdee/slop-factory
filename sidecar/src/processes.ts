import type { ProcessInfo, ProcessKind } from './protocol.js';

const MAX_ENDED = 30;
const LIVE = new Set(['running', 'pending', 'paused']);

export function kindOf(rawType: string): ProcessKind {
  const t = rawType.toLowerCase();
  if (t.includes('monitor')) return 'monitor';
  if (t.includes('bash') || t.includes('shell')) return 'shell';
  if (t.includes('agent')) return 'subagent';
  if (t.includes('workflow')) return 'workflow';
  return 'other';
}

type LiveTask = { task_id: string; task_type: string; description: string; ambient?: boolean };

/**
 * Tracks background shells, monitors and subagents from the SDK's task events.
 * `background_tasks_changed` is the authoritative live set; the task_* events add detail
 * (start time, status changes, end summaries) and let us keep recently finished ones on screen.
 */
export class ProcessTracker {
  private map = new Map<string, ProcessInfo>();
  private commandsByToolUse = new Map<string, string>();
  private taskToolUse = new Map<string, string>();

  constructor(private onChange: (list: ProcessInfo[]) => void) {}

  /** Remember the command behind a Bash/Monitor tool call so we can show it next to its task. */
  noteToolUse(toolUseId: string, input: unknown): void {
    const cmd = (input as { command?: unknown } | null)?.command;
    if (typeof cmd === 'string') this.commandsByToolUse.set(toolUseId, cmd);
  }

  started(m: { task_id: string; task_type?: string; description: string; tool_use_id?: string; ambient?: boolean; subagent_type?: string }): void {
    const rawType = m.task_type ?? (m.subagent_type ? 'local_agent' : 'unknown');
    const prev = this.map.get(m.task_id);
    if (m.tool_use_id) this.taskToolUse.set(m.task_id, m.tool_use_id);
    this.map.set(m.task_id, {
      ...prev,
      id: m.task_id,
      kind: kindOf(rawType),
      rawType,
      status: 'running',
      description: m.description || prev?.description || rawType,
      command: this.commandFor(m.task_id) ?? prev?.command,
      startedAt: prev?.startedAt ?? Date.now(),
      endedAt: undefined,
      ambient: m.ambient,
    });
    this.emit();
  }

  updated(m: { task_id: string; patch: { status?: string; description?: string; end_time?: number; error?: string } }): void {
    const p = this.map.get(m.task_id);
    if (!p) return;
    if (m.patch.status) p.status = m.patch.status;
    if (m.patch.description) p.description = m.patch.description;
    if (m.patch.error) p.summary = m.patch.error;
    if (!LIVE.has(p.status)) p.endedAt = m.patch.end_time ?? Date.now();
    this.emit();
  }

  progress(m: { task_id: string; last_tool_name?: string; summary?: string }): void {
    const p = this.map.get(m.task_id);
    if (!p) return;
    if (m.last_tool_name) p.lastTool = m.last_tool_name;
    if (m.summary) p.summary = m.summary;
    this.emit();
  }

  ended(m: { task_id: string; status: string; summary: string }): void {
    const p = this.map.get(m.task_id);
    if (!p) return;
    p.status = m.status;
    p.summary = m.summary || p.summary;
    p.endedAt = p.endedAt ?? Date.now();
    this.emit();
  }

  /** REPLACE semantics: anything we think is live but isn't in this list has ended. */
  replaceLive(tasks: LiveTask[]): void {
    const live = new Set(tasks.map((t) => t.task_id));
    for (const p of this.map.values()) {
      if (LIVE.has(p.status) && !live.has(p.id)) {
        p.status = 'ended';
        p.endedAt = Date.now();
      }
    }
    for (const t of tasks) {
      const p = this.map.get(t.task_id);
      if (p) {
        p.status = LIVE.has(p.status) ? p.status : 'running';
        p.description = t.description || p.description;
        p.ambient = t.ambient;
        p.endedAt = undefined;
      } else {
        this.map.set(t.task_id, {
          id: t.task_id,
          kind: kindOf(t.task_type),
          rawType: t.task_type,
          status: 'running',
          description: t.description,
          command: this.commandFor(t.task_id),
          startedAt: Date.now(),
          ambient: t.ambient,
        });
      }
    }
    this.emit();
  }

  list(): ProcessInfo[] {
    const all = [...this.map.values()];
    const live = all.filter((p) => LIVE.has(p.status)).sort((a, b) => b.startedAt - a.startedAt);
    const ended = all
      .filter((p) => !LIVE.has(p.status))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, MAX_ENDED);
    // Forget ended entries beyond the cap.
    const keep = new Set([...live, ...ended].map((p) => p.id));
    for (const id of this.map.keys()) if (!keep.has(id)) this.map.delete(id);
    return [...live, ...ended];
  }

  clear(): void {
    this.map.clear();
    this.commandsByToolUse.clear();
    this.taskToolUse.clear();
    this.emit();
  }

  private commandFor(taskId: string): string | undefined {
    const tu = this.taskToolUse.get(taskId);
    return tu ? this.commandsByToolUse.get(tu) : undefined;
  }

  private emit(): void {
    this.onChange(this.list());
  }
}

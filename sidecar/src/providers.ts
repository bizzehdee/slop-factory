import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountEntry, PermissionModeName, ProviderConfig, TaskStart } from './protocol.js';

// Where model providers live. Each project remembers which one it uses.
// Claude Code talks to any server that speaks Anthropic's Messages API (/v1/messages),
// which Ollama and llama.cpp's llama-server both do natively.

export const SUBSCRIPTION: ProviderConfig = { id: 'subscription', name: 'Claude subscription', kind: 'subscription' };

export const PRESETS: Record<'ollama' | 'llamacpp' | 'custom', Omit<ProviderConfig, 'id' | 'name' | 'model'>> = {
  ollama: { kind: 'ollama', baseUrl: 'http://localhost:11434', authToken: 'ollama' },
  llamacpp: { kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080', authToken: 'local' },
  custom: { kind: 'custom', baseUrl: 'http://127.0.0.1:4000', authToken: '' },
};

interface DeskState {
  providers: ProviderConfig[];
  projectProvider: Record<string, string>;
  projectMode: Record<string, PermissionModeName>;
  defaultMode?: PermissionModeName; // the last mode chosen anywhere; new projects start in it
  projectSession: Record<string, string>; // each project's conversation, picked up after a restart
  projectAutoPull: Record<string, boolean>; // projects that pull by themselves when it's safe
  gitFetchMinutes?: number; // how often open projects fetch; 0 never (default 5)
  openProjects?: string[]; // what was open when the app last closed, reopened at start; absent before this was kept here
  activeProject?: string; // the one that was showing
  prefs?: Record<string, string>; // the window's settings: theme, notifications, where new projects go
  projectTaskStart?: Record<string, TaskStart>; // projects whose tasks start differently from the default
  projectModel?: Record<string, { provider: string; model: string }>; // the model each project picked, on the provider it was picked for
  frameworkDismissed?: Record<string, string>; // the agent-framework version each project said "not now" to
  accounts?: StoredAccount[]; // Claude logins besides the one on this computer
  defaultAccount?: string;
  projectAccount?: Record<string, string>; // the login each project picked
  accountInfo?: Record<string, { email?: string; organization?: string; plan?: string }>; // what Claude Code said each login is, as of the last session
}

export interface StoredAccount {
  id: string;
  name: string;
  dir: string; // its Claude Code config folder
}

export const DEFAULT_ACCOUNT = 'default';
const DEFAULT_NAME = 'This computer’s login';

const MODES: PermissionModeName[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const TASK_STARTS: TaskStart[] = ['current', 'compact', 'new'];

import { appVersion, configDir, writeFileAtomic } from './names.js';

export { configDir };

export class ProviderStore {
  private state: DeskState = { providers: [], projectProvider: {}, projectMode: {}, projectSession: {}, projectAutoPull: {} };
  private file = path.join(configDir(), 'config.json');

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.state = {
        providers: Array.isArray(raw.providers) ? raw.providers.filter(isProvider) : [],
        projectProvider: raw.projectProvider && typeof raw.projectProvider === 'object' ? raw.projectProvider : {},
        projectMode: raw.projectMode && typeof raw.projectMode === 'object' ? raw.projectMode : {},
        defaultMode: MODES.includes(raw.defaultMode) ? raw.defaultMode : undefined,
        projectSession: raw.projectSession && typeof raw.projectSession === 'object' ? raw.projectSession : {},
        projectAutoPull: raw.projectAutoPull && typeof raw.projectAutoPull === 'object' ? raw.projectAutoPull : {},
        gitFetchMinutes: typeof raw.gitFetchMinutes === 'number' && raw.gitFetchMinutes >= 0 ? raw.gitFetchMinutes : undefined,
        openProjects: Array.isArray(raw.openProjects) ? raw.openProjects.filter((d: unknown) => typeof d === 'string') : undefined,
        activeProject: typeof raw.activeProject === 'string' ? raw.activeProject : undefined,
        projectTaskStart: raw.projectTaskStart && typeof raw.projectTaskStart === 'object' ? Object.fromEntries(Object.entries(raw.projectTaskStart).filter(([, v]) => TASK_STARTS.includes(v as TaskStart))) as Record<string, TaskStart> : undefined,
        projectModel: raw.projectModel && typeof raw.projectModel === 'object' ? Object.fromEntries(Object.entries(raw.projectModel).filter(([, v]) => !!v && typeof (v as { provider?: unknown }).provider === 'string' && typeof (v as { model?: unknown }).model === 'string')) as Record<string, { provider: string; model: string }> : undefined,
        frameworkDismissed: raw.frameworkDismissed && typeof raw.frameworkDismissed === 'object' ? Object.fromEntries(Object.entries(raw.frameworkDismissed).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined,
        accounts: Array.isArray(raw.accounts) ? raw.accounts.filter((a: StoredAccount) => !!a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.dir === 'string') : undefined,
        defaultAccount: typeof raw.defaultAccount === 'string' ? raw.defaultAccount : undefined,
        projectAccount: raw.projectAccount && typeof raw.projectAccount === 'object' ? Object.fromEntries(Object.entries(raw.projectAccount).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined,
        accountInfo: raw.accountInfo && typeof raw.accountInfo === 'object' ? raw.accountInfo : undefined,
        prefs: raw.prefs && typeof raw.prefs === 'object' ? Object.fromEntries(Object.entries(raw.prefs).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined,
      };
    } catch {
      /* first run */
    }
  }

  list(): ProviderConfig[] {
    return [SUBSCRIPTION, ...this.state.providers];
  }

  get(id: string | undefined): ProviderConfig {
    return this.list().find((p) => p.id === id) ?? SUBSCRIPTION;
  }

  /** The project's provider, with the model the project picked on it, if it picked one. */
  forProject(dir: string): ProviderConfig {
    const p = this.get(this.state.projectProvider[dir]);
    const model = this.modelFor(dir, p.id);
    const configDir = this.accountFor(dir).dir;
    return { ...p, ...(model ? { model } : {}), ...(configDir ? { configDir } : {}) };
  }

  // ---------- accounts ----------

  private stored(id: string): StoredAccount | undefined {
    return (this.state.accounts ?? []).find((a) => a.id === id);
  }

  /** The default login first, then the ones added here. */
  accountList(): AccountEntry[] {
    const info = this.state.accountInfo ?? {};
    const defaultId = this.defaultAccountId;
    const entry = (id: string, name: string): AccountEntry => ({ id, name, ...info[id], isDefault: id === defaultId });
    return [entry(DEFAULT_ACCOUNT, DEFAULT_NAME), ...(this.state.accounts ?? []).map((a) => entry(a.id, a.name))];
  }

  get defaultAccountId(): string {
    const id = this.state.defaultAccount;
    return id && this.stored(id) ? id : DEFAULT_ACCOUNT;
  }

  /** The login a project runs under; dir is undefined for the one on this computer. */
  accountFor(project: string): { id: string; name: string; dir?: string } {
    const picked = this.state.projectAccount?.[project];
    const a = this.stored(picked && this.stored(picked) ? picked : this.defaultAccountId);
    return a ?? { id: DEFAULT_ACCOUNT, name: DEFAULT_NAME };
  }

  account(id: string): { id: string; name: string; dir?: string } | undefined {
    return id === DEFAULT_ACCOUNT ? { id, name: DEFAULT_NAME } : this.stored(id);
  }

  entryFor(project: string): AccountEntry {
    const id = this.accountFor(project).id;
    return { ...this.accountList().find((a) => a.id === id)!, followsDefault: this.follows(project) };
  }

  async addAccount(name: string): Promise<StoredAccount> {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new Error('Give the account a name.');
    if (this.accountList().some((a) => a.name.toLowerCase() === clean.toLowerCase())) throw new Error(`There is already an account called ${clean}.`);
    const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account';
    let id = base;
    for (let n = 2; id === DEFAULT_ACCOUNT || this.stored(id); n++) id = `${base}-${n}`;
    const dir = path.join(configDir(), 'accounts', id);
    await fs.mkdir(dir, { recursive: true });
    const a = { id, name: clean, dir };
    this.state.accounts = [...(this.state.accounts ?? []), a];
    await this.save();
    return a;
  }

  async renameAccount(id: string, name: string): Promise<void> {
    const a = this.stored(id);
    const clean = name.trim().slice(0, 60);
    if (!a || !clean) return;
    a.name = clean;
    await this.save();
  }

  /** Forgotten here only: its folder, sign-in and conversations stay where they are. */
  async removeAccount(id: string): Promise<string[]> {
    if (!this.stored(id)) return [];
    this.state.accounts = (this.state.accounts ?? []).filter((a) => a.id !== id);
    const moved = Object.entries(this.state.projectAccount ?? {}).filter(([, v]) => v === id).map(([k]) => k);
    for (const dir of moved) delete this.state.projectAccount![dir];
    if (this.state.defaultAccount === id) delete this.state.defaultAccount;
    if (this.state.accountInfo) delete this.state.accountInfo[id];
    await this.save();
    return moved;
  }

  /** Whether the default changed. */
  async setDefaultAccount(id: string): Promise<boolean> {
    if (!this.account(id)) return false;
    const before = this.defaultAccountId;
    if (id === DEFAULT_ACCOUNT) delete this.state.defaultAccount;
    else this.state.defaultAccount = id;
    await this.save();
    return before !== this.defaultAccountId;
  }

  follows(project: string): boolean {
    const picked = this.state.projectAccount?.[project];
    return !picked || !this.stored(picked);
  }

  async setProjectAccount(project: string, id: string | null): Promise<void> {
    const map = (this.state.projectAccount ??= {});
    if (id && this.account(id)) map[project] = id;
    else delete map[project];
    await this.save();
  }

  async cacheAccountInfo(id: string, info: { email?: string; organization?: string; plan?: string }): Promise<void> {
    const have = (this.state.accountInfo ??= {});
    const same = JSON.stringify(have[id]) === JSON.stringify(info);
    have[id] = info;
    if (!same) await this.save();
  }

  async setForProject(dir: string, id: string): Promise<ProviderConfig> {
    const p = this.get(id);
    if (p.id === SUBSCRIPTION.id) delete this.state.projectProvider[dir];
    else this.state.projectProvider[dir] = p.id;
    await this.save();
    return this.forProject(dir);
  }

  /** The conversation a project picks up when it opens again. */
  sessionFor(dir: string): string | undefined {
    return this.state.projectSession[this.sessionKey(dir)];
  }

  /** Each login keeps its own conversations, so a project remembers one per login. */
  private sessionKey(dir: string, account = this.accountFor(dir).id): string {
    return account === DEFAULT_ACCOUNT ? dir : `${dir}\n${account}`;
  }

  async setSession(dir: string, id: string | undefined, account?: string): Promise<void> {
    const key = this.sessionKey(dir, account);
    if (this.state.projectSession[key] === id) return;
    if (id) this.state.projectSession[key] = id;
    else delete this.state.projectSession[key];
    await this.save();
  }

  /** The projects to reopen, and the one to show; undefined when the app has never kept them. */
  get openProjects(): { list: string[] | undefined; active: string | undefined } {
    return { list: this.state.openProjects, active: this.state.activeProject };
  }

  async projectOpened(dir: string): Promise<void> {
    const list = this.state.openProjects ?? [];
    if (list.includes(dir)) return;
    this.state.openProjects = [...list, dir];
    await this.save();
  }

  /** Closed by you, not by the app quitting: it isn't reopened next time. */
  async projectClosed(dir: string): Promise<void> {
    this.state.openProjects = (this.state.openProjects ?? []).filter((d) => d !== dir);
    if (this.state.activeProject === dir) this.state.activeProject = undefined;
    await this.save();
  }

  async setActiveProject(dir: string): Promise<void> {
    if (this.state.activeProject === dir) return;
    this.state.activeProject = dir;
    await this.save();
  }

  /** The window's settings, kept here so they outlast the window's own storage. */
  get prefs(): Record<string, string> {
    return { ...(this.state.prefs ?? {}) };
  }

  async setPref(key: string, value: string | null): Promise<void> {
    const prefs = { ...(this.state.prefs ?? {}) };
    if (value == null) delete prefs[key];
    else prefs[key] = value;
    this.state.prefs = prefs;
    await this.save();
  }

  /** Where a project's tasks start: its own choice, else the default in Settings, else as it is. */
  taskStart(dir: string): TaskStart {
    const own = this.state.projectTaskStart?.[dir];
    if (own) return own;
    const global = this.state.prefs?.['task-start'] as TaskStart | undefined;
    return global && TASK_STARTS.includes(global) ? global : 'current';
  }

  ownTaskStart(dir: string): TaskStart | null {
    return this.state.projectTaskStart?.[dir] ?? null;
  }

  async setProjectTaskStart(dir: string, mode: TaskStart | null): Promise<void> {
    const map = { ...(this.state.projectTaskStart ?? {}) };
    if (mode && TASK_STARTS.includes(mode)) map[dir] = mode;
    else delete map[dir];
    this.state.projectTaskStart = map;
    await this.save();
  }

  /** The model this project picked on this provider, if it picked one. */
  modelFor(dir: string, providerId: string): string | undefined {
    const m = this.state.projectModel?.[dir];
    return m?.provider === providerId ? m.model : undefined;
  }

  async setModel(dir: string, providerId: string, model: string | null): Promise<void> {
    const map = { ...(this.state.projectModel ?? {}) };
    if (model) map[dir] = { provider: providerId, model };
    else delete map[dir];
    this.state.projectModel = map;
    await this.save();
  }

  /** The agent-framework version this project was last told "not now" about, if any. */
  frameworkDismissed(dir: string): string | undefined {
    return this.state.frameworkDismissed?.[dir];
  }

  async dismissFramework(dir: string, version: string | null): Promise<void> {
    const map = { ...(this.state.frameworkDismissed ?? {}) };
    if (version) map[dir] = version;
    else delete map[dir];
    this.state.frameworkDismissed = map;
    await this.save();
  }

  autoPull(dir: string): boolean {
    return !!this.state.projectAutoPull[dir];
  }

  async setAutoPull(dir: string, on: boolean): Promise<void> {
    if (on) this.state.projectAutoPull[dir] = true;
    else delete this.state.projectAutoPull[dir];
    await this.save();
  }

  /** How often open projects fetch from their remotes, in minutes; 0 is never. */
  get fetchMinutes(): number {
    return this.state.gitFetchMinutes ?? 5;
  }

  async setFetchMinutes(minutes: number): Promise<void> {
    this.state.gitFetchMinutes = Math.max(0, Math.round(minutes));
    await this.save();
  }

  /** The permission mode a project opens in: its own last choice, else the last one chosen anywhere. */
  modeFor(dir: string): PermissionModeName {
    const m = this.state.projectMode[dir] ?? this.state.defaultMode;
    return m && MODES.includes(m) ? m : 'default';
  }

  async setMode(dir: string, mode: PermissionModeName): Promise<void> {
    if (!MODES.includes(mode)) return;
    this.state.projectMode[dir] = mode;
    this.state.defaultMode = mode;
    await this.save();
  }

  async upsert(input: ProviderConfig): Promise<ProviderConfig> {
    if (input.kind === 'subscription') throw new Error("The subscription provider can't be edited.");
    if (!input.baseUrl || !/^https?:\/\//i.test(input.baseUrl)) throw new Error('Base URL must start with http:// or https://');
    if (!input.model?.trim()) throw new Error('Choose a model.');
    const p: ProviderConfig = {
      id: input.id || `${input.kind}-${Date.now().toString(36)}`,
      name: input.name?.trim() || `${input.kind === 'ollama' ? 'Ollama' : input.kind === 'llamacpp' ? 'llama.cpp' : 'Local'} (${input.model})`,
      kind: input.kind,
      baseUrl: input.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''),
      authToken: input.authToken ?? '',
      model: input.model.trim(),
      smallModel: input.smallModel?.trim() || undefined,
    };
    const i = this.state.providers.findIndex((x) => x.id === p.id);
    if (i >= 0) this.state.providers[i] = p;
    else this.state.providers.push(p);
    await this.save();
    return p;
  }

  async remove(id: string): Promise<string[]> {
    this.state.providers = this.state.providers.filter((p) => p.id !== id);
    const affected = Object.entries(this.state.projectProvider).filter(([, v]) => v === id).map(([k]) => k);
    for (const dir of affected) delete this.state.projectProvider[dir];
    await this.save();
    return affected;
  }

  private writing: Promise<void> = Promise.resolve();

  /** Writes go one after another, so several projects opening at once can't interleave them. */
  private save(): Promise<void> {
    const text = JSON.stringify(this.state, null, 2) + '\n';
    const write = () => writeFileAtomic(this.file, text, 0o600);
    this.writing = this.writing.then(write, write);
    return this.writing;
  }

  /** Wait for any write still under way, before the sidecar exits. */
  flush(): Promise<void> {
    return this.writing.catch(() => undefined);
  }
}

function isProvider(x: unknown): x is ProviderConfig {
  const p = x as ProviderConfig;
  return !!p && typeof p.id === 'string' && typeof p.kind === 'string' && p.kind !== 'subscription';
}

/**
 * The environment and model for a Claude Code session on this provider.
 * Subscription: inherit the environment (minus any stray API key, removed at start-up).
 * Local: point every model role at the chosen model so nothing tries to reach Anthropic.
 */
export function sessionSettings(p: ProviderConfig): { env?: Record<string, string | undefined>; model?: string } {
  // Another login: its own Claude Code folder, with its sign-in and history.
  const account = p.configDir ? { CLAUDE_CONFIG_DIR: p.configDir } : {};
  if (p.kind === 'subscription') return { ...(p.configDir ? { env: { ...process.env, ...account } } : {}), ...(p.model ? { model: p.model } : {}) };
  if (!p.baseUrl || !p.model) return {};
  const small = p.smallModel || p.model;
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...account,
    ANTHROPIC_BASE_URL: p.baseUrl,
    ANTHROPIC_AUTH_TOKEN: p.authToken || 'local',
    ANTHROPIC_MODEL: p.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: p.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: p.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    ANTHROPIC_SMALL_FAST_MODEL: small,
    CLAUDE_CODE_SUBAGENT_MODEL: p.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: `slop-factory/${appVersion()}`,
  };
  // The agent knows only Anthropic models' windows: tell it the local server's, so it compacts in time.
  if (p.contextTokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(p.contextTokens);
  // Don't let subscription credentials or an API key override the local server.
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return { env, model: p.model };
}

/** Ask a server which models it has. Works with Ollama and llama-server (OpenAI-style /v1/models). */
export async function probeModels(baseUrl: string, authToken?: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const ctrl = AbortSignal.timeout(5000);
  const tryJson = async (url: string) => {
    const res = await fetch(url, { headers, signal: ctrl });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  let names: string[] = [];
  try {
    const j = await tryJson(`${base}/v1/models`);
    names = ((j.data as { id?: string }[]) ?? []).map((m) => m.id ?? '').filter(Boolean);
  } catch (first) {
    try {
      const j = await tryJson(`${base}/api/tags`); // Ollama's own listing
      names = ((j.models as { name?: string }[]) ?? []).map((m) => m.name ?? '').filter(Boolean);
    } catch {
      throw first instanceof Error && first.name === 'TimeoutError' ? new Error(`No answer from ${base} within 5 seconds.`) : new Error(`Couldn't reach ${base}: ${String((first as Error).message ?? first)}`);
    }
  }
  return [...new Set(names)].sort();
}

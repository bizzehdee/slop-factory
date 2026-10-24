import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { AuthState } from './protocol.js';

const run = promisify(execFile);

/**
 * The Claude Code binary the SDK runs: its platform package, as the SDK looks it up, or a `claude`
 * on PATH. Either way it shares the login a Claude Code install made, so a signed-in CLI means a
 * signed-in app.
 */
export function claudeBinary(): string {
  if (process.env.SLOP_FACTORY_CLAUDE) return process.env.SLOP_FACTORY_CLAUDE;
  const req = createRequire(import.meta.url);
  const exe = process.platform === 'win32' ? '.exe' : '';
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of process.platform === 'linux' ? [base, `${base}-musl`] : [base]) {
    try {
      return req.resolve(`${pkg}/claude${exe}`);
    } catch {
      /* not installed for this platform */
    }
  }
  return 'claude';
}

/** The environment for the Claude Code binary under one login: its own config folder, or the computer's default. */
const loginEnv = (configDir?: string) => (configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env);

export async function authStatus(configDir?: string): Promise<AuthState> {
  try {
    const { stdout } = await run(claudeBinary(), ['auth', 'status', '--json'], { timeout: 30_000, windowsHide: true, env: loginEnv(configDir) });
    const json = JSON.parse(stdout);
    return { loggedIn: !!json.loggedIn, method: json.authMethod, provider: json.apiProvider };
  } catch (err) {
    // "auth status" exits non-zero when signed out, still printing its JSON.
    const out = (err as { stdout?: string }).stdout;
    try {
      const json = JSON.parse(out ?? '');
      return { loggedIn: !!json.loggedIn, method: json.authMethod, provider: json.apiProvider };
    } catch {
      return { loggedIn: false, error: `Couldn't check your Claude login: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

const URL_IN_TEXT = /https:\/\/\S+/;

/**
 * "claude auth login" with its prompts relayed: it opens the sign-in page itself, prints the
 * address in case it couldn't, and may ask for the code the page shows afterwards.
 */
export class LoginFlow {
  private child?: ChildProcess;

  constructor(
    private onUrl: (url: string) => void,
    private onLine: (line: string) => void,
    private onExit: (ok: boolean, message?: string) => void,
  ) {}

  start(console = false, configDir?: string): void {
    this.cancel();
    const child = spawn(claudeBinary(), ['auth', 'login', console ? '--console' : '--claudeai'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: loginEnv(configDir) });
    this.child = child;
    let tail = '';
    let sentUrl = false;
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) {
        const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
        if (!clean) continue;
        this.onLine(clean);
        const url = URL_IN_TEXT.exec(clean)?.[0];
        if (url && !sentUrl) {
          sentUrl = true;
          this.onUrl(url);
        }
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('error', (err) => this.onExit(false, err.message));
    child.once('exit', (code) => {
      if (this.child === child) this.child = undefined;
      const last = tail
        .split(/\r?\n/)
        .map((l) => l.replace(/^.*Paste code here if prompted >\s*/, '').trim())
        .filter(Boolean)
        .pop();
      this.onExit(code === 0, code === 0 ? undefined : last || `claude auth login exited with ${code}`);
    });
  }

  /** The code the sign-in page shows, for the prompt "Paste code here". */
  sendCode(code: string): void {
    this.child?.stdin?.write(code.trim() + '\n');
  }

  cancel(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

import type { ProviderConfig } from './protocol.js';

// How many tokens a local model server actually gives each conversation. The agent only knows
// the windows of Anthropic's models, so for a local model the server is asked: llama.cpp says in
// /props, Ollama in /api/ps for a loaded model or the num_ctx it was set up with in /api/show.

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; tokens: number | undefined }>();

const positive = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined);

/** llama.cpp's GET /props: the context each slot gets. */
export function parseLlamaProps(json: unknown): number | undefined {
  const j = (json ?? {}) as { default_generation_settings?: { n_ctx?: number }; n_ctx?: number };
  return positive(j.default_generation_settings?.n_ctx) ?? positive(j.n_ctx);
}

/** llama.cpp's GET /slots, for builds whose /props doesn't say. */
export function parseLlamaSlots(json: unknown): number | undefined {
  return Array.isArray(json) ? positive((json[0] as { n_ctx?: number } | undefined)?.n_ctx) : undefined;
}

/** Ollama's GET /api/ps: the context a loaded model is running with. */
export function parseOllamaPs(json: unknown, model: string): number | undefined {
  const models = ((json ?? {}) as { models?: { name?: string; model?: string; context_length?: number }[] }).models ?? [];
  const bare = (s = '') => s.replace(/:latest$/, '');
  const m = models.find((x) => bare(x.name) === bare(model) || bare(x.model) === bare(model));
  return positive(m?.context_length);
}

/** Ollama's POST /api/show: the num_ctx a model is set up with, if it sets one. */
export function parseOllamaShow(json: unknown): number | undefined {
  const params = ((json ?? {}) as { parameters?: string }).parameters ?? '';
  const m = /^\s*num_ctx\s+(\d+)/m.exec(params);
  return m ? positive(Number(m[1])) : undefined;
}

async function getJson(url: string, token?: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** The context window a local provider's server gives its model, or undefined if it won't say. */
export async function serverContextWindow(p: ProviderConfig, now = Date.now()): Promise<number | undefined> {
  if (p.kind === 'subscription' || !p.baseUrl) return undefined;
  const key = `${p.baseUrl}|${p.model ?? ''}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.tokens;
  const base = p.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const token = p.authToken && p.authToken !== 'local' ? p.authToken : undefined;
  const attempt = async (fn: () => Promise<number | undefined>) => fn().catch(() => undefined);
  const llama = async () => (await attempt(async () => parseLlamaProps(await getJson(`${base}/props`, token)))) ?? (await attempt(async () => parseLlamaSlots(await getJson(`${base}/slots`, token))));
  const ollama = async () =>
    (await attempt(async () => parseOllamaPs(await getJson(`${base}/api/ps`, token), p.model ?? ''))) ??
    (await attempt(async () => parseOllamaShow(await getJson(`${base}/api/show`, token, { model: p.model }))));
  // A server added as "Other" could be either kind.
  const tokens = p.kind === 'llamacpp' ? await llama() : p.kind === 'ollama' ? await ollama() : (await llama()) ?? (await ollama());
  cache.set(key, { at: now, tokens });
  return tokens;
}

export const clearContextCache = () => cache.clear();

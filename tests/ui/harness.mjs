// Starts the interface against a scripted agent (sidecar/src/fake-agent.ts) and gives each test
// a fresh browser page and a fixture project. Run with: npm run test:ui
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const URL_BASE = 'http://127.0.0.1:1420/';

async function waitForHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} didn't come up`);
}

/** Bridge + Vite + browser, shared by every test in a file. */
export async function startApp() {
  const work = await mkdtemp(path.join(tmpdir(), 'slop-ui-'));
  const env = { ...process.env, SLOP_FACTORY_FAKE_AGENT: '1', SLOP_FACTORY_CONFIG_DIR: path.join(work, 'config') };
  const bridge = () => spawn(process.execPath, [path.join(root, 'scripts', 'dev-bridge.mjs')], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const procs = [bridge(), spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '1420', '--strictPort'], { cwd: root, env, stdio: 'ignore' })];
  await waitForHttp(URL_BASE, 30_000);
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  let n = 0;
  return {
    work,
    /** A new page with nothing remembered, opened on the given project folders. */
    async open(...dirs) {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      // Record desktop notifications instead of showing them.
      await context.addInitScript(() => {
        window.__notes = [];
        window.Notification = class {
          static permission = 'granted';
          static requestPermission = async () => 'granted';
          constructor(title, opts) {
            window.__notes.push({ title, body: opts?.body ?? '' });
          }
        };
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const query = dirs.map((d) => `project=${encodeURIComponent(d)}`).join('&');
      await page.goto(`${URL_BASE}?${query}`);
      if (dirs.length) await page.waitForSelector('#project-header:not([hidden])', { timeout: 15_000 });
      page.errors = errors;
      return page;
    },
    /** Stop the bridge and its sidecar and start fresh ones, as quitting and reopening the app does. */
    async restartSidecar() {
      const old = procs[0];
      const gone = new Promise((r) => old.once('exit', r));
      old.kill('SIGINT');
      await gone;
      await new Promise((r) => setTimeout(r, 300));
      procs[0] = bridge();
      await new Promise((r) => setTimeout(r, 500));
    },
    /** A project on disk laid out the agent-framework way. */
    async project(files = {}) {
      const dir = path.join(work, `p${++n}`);
      const all = { ...FIXTURE, ...files };
      for (const [rel, text] of Object.entries(all)) {
        if (text == null) continue;
        await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await writeFile(path.join(dir, rel), text);
      }
      return dir;
    },
    async stop() {
      await browser.close();
      // SIGINT lets the bridge close the sidecar's input so it shuts down cleanly.
      for (const p of procs) p.kill('SIGINT');
      await new Promise((r) => setTimeout(r, 300));
      await rm(work, { recursive: true, force: true });
    },
  };
}

export const FIXTURE = {
  'plan.md': '# Demo plan\n\nA small app.\n\n## Open questions\n\n- Which licence should we use?\n- Do we need offline support? (left open by the user, 2026-10-01)\n',
  'task.md': '# Tasks\n\n| Phase | Goal | Status | Document |\n|---|---|---|---|\n| 1 | Build | done | [Phase 1](tasks/task_phase_1.md) |\n| 2 | Export | in progress | [Phase 2](tasks/task_phase_2.md) |\n',
  'tasks/task_phase_1.md': '# Phase 1: Build\n\n## Tasks\n\n- [x] T1: Base\n',
  'tasks/task_phase_2.md':
    '# Phase 2: Export\n\n## Tasks\n\n- [x] T2: Schema\n- [ ] T3: Scheduler\n  - **Depends on:** T4\n- [ ] T4: Email\n  - **Blocked by:** waiting on SMTP creds\n- [ ] T5: Report\n\n## Open questions\n\n- Which SMTP provider should email use?\n',
  'tasks/bugs.md': '# Bugs\n\n### B1: Export fails\n- Status: open\n',
};

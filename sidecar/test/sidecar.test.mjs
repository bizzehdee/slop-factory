import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseTaskMarkdown, parseTaskFile, TaskWatcher, DEFAULT_TASK_CONFIG } from '../dist/tasks.js';
import { ProcessTracker, kindOf } from '../dist/processes.js';
import { Priorities, promptFor } from '../dist/actions.js';
import { parseOpenQuestions } from '../dist/questions.js';

const sample = `# Auth rework

## Backend
- [x] Add token table
- [ ] Rotate keys
  - [/] Write rotation job
  - [-] Manual script (dropped)
    * [ ] deeply nested

\`\`\`md
- [ ] not a task, inside a code fence
\`\`\`

## Frontend
1. [ ] Login form
2. [X] Logout button
Some prose with [ ] brackets that isn't a task.
`;

test('parses checkboxes, states, nesting, sections and title', () => {
  const { title, items } = parseTaskMarkdown(sample, 'auth/task.md');
  assert.equal(title, 'Auth rework');
  assert.deepEqual(
    items.map((i) => [i.text, i.state, i.depth, i.section]),
    [
      ['Add token table', 'done', 0, 'Backend'],
      ['Rotate keys', 'todo', 0, 'Backend'],
      ['Write rotation job', 'doing', 1, 'Backend'],
      ['Manual script (dropped)', 'cancelled', 1, 'Backend'],
      ['deeply nested', 'todo', 2, 'Backend'],
      ['Login form', 'todo', 0, 'Frontend'],
      ['Logout button', 'done', 0, 'Frontend'],
    ],
  );
  assert.equal(items[0].line, 3);
});

test('falls back to the path when there is no H1', () => {
  assert.equal(parseTaskMarkdown('- [ ] a', 'x/tasks.md').title, 'x/tasks.md');
});


// Examples taken from the agent-framework task-tracking standard.
const indexMd = `# Tasks

## Phases

| Phase | Goal | Status | Document |
|---|---|---|---|
| 1 | Sign-up, sign-in, and account settings. | done | [Phase 1](tasks/task_phase_1.md) |
| 2 | Scheduled report export. | In Progress | [Phase 2](tasks/task_phase_2.md) |

Bugs: [tasks/bugs.md](tasks/bugs.md)

## Revision history

| Date | Change |
|---|---|
| 2026-03-01 | Created. |
`;

const bugsMd = `# Bugs

### B2: Export fails for a report with no rows
- Reported: 2026-03-05
- Status: open
- Observed: The export returns a 500 error.

### B1: Typo on sign-in page
- Reported: 2026-02-11
- Status: fixed
`;

test('reads the phase table from task.md', () => {
  const f = parseTaskFile(indexMd, 'task.md');
  assert.equal(f.kind, 'index');
  assert.deepEqual(f.phases, [
    { number: '1', goal: 'Sign-up, sign-in, and account settings.', status: 'done', doc: 'tasks/task_phase_1.md' },
    { number: '2', goal: 'Scheduled report export.', status: 'in progress', doc: 'tasks/task_phase_2.md' },
  ]);
});

test('reads bug entries', () => {
  const f = parseTaskFile(bugsMd, 'tasks/bugs.md');
  assert.equal(f.kind, 'bugs');
  assert.deepEqual(f.bugs.map((b) => [b.id, b.title, b.status, b.reported]), [
    ['B2', 'Export fails for a report with no rows', 'open', '2026-03-05'],
    ['B1', 'Typo on sign-in page', 'fixed', '2026-02-11'],
  ]);
});

test('phase documents get their number and sectioned tasks', () => {
  const f = parseTaskFile('# Phase 3: Billing\n\n## Goal\nx\n\n## Tasks\n- [ ] a\n- [x] b\n\n## Done when\n- [ ] p95 < 200ms\n', 'tasks/task_phase_3.md');
  assert.equal(f.kind, 'phase');
  assert.equal(f.phaseNumber, '3');
  assert.deepEqual(f.items.map((i) => i.section), ['Tasks', 'Tasks', 'Done when']);
});

const waitFor = async (fn, ms = 4000) => {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
};

test('watcher follows the framework layout, reacts to edits, and toggles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'desk-'));
  try {
    await mkdir(path.join(root, 'tasks'), { recursive: true });
    await mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'task.md'), indexMd);
    await writeFile(path.join(root, 'tasks/task_phase_2.md'), '# Phase 2: Export\n\n## Tasks\n- [ ] one\n- [x] two\n');
    await writeFile(path.join(root, 'tasks/task_phase_10.md'), '# Phase 10: Later\r\n\r\n## Tasks\r\n- [ ] sprint item\r\n');
    await writeFile(path.join(root, 'tasks/bugs.md'), bugsMd);
    await writeFile(path.join(root, 'README.md'), '- [ ] not tracked\n');
    await writeFile(path.join(root, 'docs/task.md'), '- [ ] not tracked either\n');
    await writeFile(path.join(root, 'node_modules/pkg/task.md'), '- [ ] ignored\n');

    let latest = [];
    var w = new TaskWatcher(root, DEFAULT_TASK_CONFIG, (files) => (latest = files));
    w.start();

    await waitFor(() => latest.length === 4);
    assert.deepEqual(latest.map((f) => [f.rel, f.kind]), [
      ['task.md', 'index'],
      ['tasks/task_phase_2.md', 'phase'],
      ['tasks/task_phase_10.md', 'phase'],
      ['tasks/bugs.md', 'bugs'],
    ]);
    assert.equal(latest[0].phases.length, 2);
    assert.equal(latest[3].bugs.length, 2);

    // Live edit on disk shows up.
    await writeFile(path.join(root, 'tasks/task_phase_2.md'), '# Phase 2: Export\n\n## Tasks\n- [ ] one\n- [x] two\n- [ ] three\n');
    await waitFor(() => latest.find((f) => f.rel === 'tasks/task_phase_2.md')?.items.length === 3);

    // Toggle from the UI writes the file, and the watcher picks up the change.
    await w.toggle('tasks/task_phase_2.md', 3, 'one');
    assert.match(await readFile(path.join(root, 'tasks/task_phase_2.md'), 'utf8'), /- \[x\] one/);
    await waitFor(() => latest.find((f) => f.rel === 'tasks/task_phase_2.md')?.items[0].state === 'done');

    // CRLF files keep their line endings.
    await w.toggle('tasks/task_phase_10.md', 3, 'sprint item');
    assert.equal(await readFile(path.join(root, 'tasks/task_phase_10.md'), 'utf8'), '# Phase 10: Later\r\n\r\n## Tasks\r\n- [x] sprint item\r\n');

    // Stale toggles are refused rather than clobbering a changed line.
    await assert.rejects(w.toggle('tasks/task_phase_2.md', 3, 'something else'), /changed on disk/);
    await assert.rejects(w.toggle('../outside.md', 0, 'x'), /Not a tracked/);

    // Deleting a file drops it.
    await rm(path.join(root, 'tasks/task_phase_10.md'));
    await waitFor(() => latest.length === 3);
  } finally {
    await w?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('process tracker merges task events with the live set', () => {
  let list = [];
  const t = new ProcessTracker((l) => (list = l));

  t.noteToolUse('tu1', { command: 'npm run dev', run_in_background: true });
  t.started({ task_id: 'b1', task_type: 'local_bash', description: 'Dev server', tool_use_id: 'tu1' });
  t.replaceLive([
    { task_id: 'b1', task_type: 'local_bash', description: 'Dev server' },
    { task_id: 'm1', task_type: 'monitor', description: 'Watch test output' },
  ]);
  assert.equal(list.length, 2);
  const shell = list.find((p) => p.id === 'b1');
  assert.equal(shell.kind, 'shell');
  assert.equal(shell.command, 'npm run dev');
  assert.equal(list.find((p) => p.id === 'm1').kind, 'monitor');

  t.ended({ task_id: 'b1', status: 'completed', summary: 'exited 0' });
  assert.equal(list[0].id, 'm1', 'live tasks sort first');
  assert.equal(list[1].status, 'completed');
  assert.equal(list[1].summary, 'exited 0');

  // Monitor drops out of the live set without a notification: marked ended.
  t.replaceLive([]);
  assert.equal(list.find((p) => p.id === 'm1').status, 'ended');

  assert.equal(kindOf('local_agent'), 'subagent');
  assert.equal(kindOf('local_workflow'), 'workflow');
});

test('task lines give their T-number, a clean title and their spec/summary links', () => {
  const f = parseTaskFile(
    '# Phase 2: Export\n\n## Tasks\n- [x] T5: Schedule exports from the admin screen. [Spec](../specs/spec-TASK-5.md) [Summary](../summaries/summary-TASK-5.md)\n- [ ] T6: Email delivery, see [docs](https://example.com)\n- [ ] Unnumbered task\n',
    'tasks/task_phase_2.md',
  );
  const [t5, t6, plain] = f.items;
  assert.equal(t5.id, 'T5');
  assert.equal(t5.title, 'Schedule exports from the admin screen.');
  assert.deepEqual(t5.links, [
    { label: 'Spec', rel: 'specs/spec-TASK-5.md' },
    { label: 'Summary', rel: 'summaries/summary-TASK-5.md' },
  ]);
  assert.equal(t6.title, 'Email delivery, see docs', 'web links keep their text and are not docs');
  assert.deepEqual(t6.links, []);
  assert.equal(plain.id, undefined);
  assert.equal(plain.title, 'Unnumbered task');
});

test('bug entries pick up Spec and Summary lines', () => {
  const f = parseTaskFile(
    '# Bugs\n\n### B2: Export fails\n- Reported: 2026-03-05\n- Status: in progress\n- Spec: [spec-BUG-2](../specs/spec-BUG-2.md)\n- Summary: [summary-BUG-2](../summaries/summary-BUG-2.md)\n\n### B1: Typo\n- Status: fixed\n',
    'tasks/bugs.md',
  );
  assert.deepEqual(f.bugs[0].links, [
    { label: 'Spec', rel: 'specs/spec-BUG-2.md' },
    { label: 'Summary', rel: 'summaries/summary-BUG-2.md' },
  ]);
  assert.equal(f.bugs[0].status, 'in progress');
  assert.deepEqual(f.bugs[1].links, []);
});

test('priorities toggle in click order and persist to .slop-factory/priorities.json', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'desk-'));
  try {
    const p = new Priorities(root);
    assert.deepEqual(await p.load(), []);
    await p.toggle('T5');
    await p.toggle('B2');
    assert.deepEqual(await p.toggle('T7'), ['T5', 'B2', 'T7']);
    assert.deepEqual(await p.toggle('B2'), ['T5', 'T7']);
    const saved = JSON.parse(await readFile(path.join(root, '.slop-factory/priorities.json'), 'utf8'));
    assert.deepEqual(saved.order, ['T5', 'T7']);
    assert.deepEqual(await new Priorities(root).load(), ['T5', 'T7']);
    // A queue saved by the app under its old name still loads.
    const old = await mkdtemp(path.join(tmpdir(), 'desk-'));
    await mkdir(path.join(old, '.claude-desk'));
    await writeFile(path.join(old, '.claude-desk/priorities.json'), JSON.stringify({ order: ['B1'] }));
    assert.deepEqual(await new Priorities(old).load(), ['B1']);
    await rm(old, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('action prompts follow the spec/summary naming and honour overrides', () => {
  const task = { key: 'T5', kind: 'task', id: 'T5', title: 'Scheduler', rel: 'tasks/task_phase_2.md', done: false };
  const start = promptFor('start', task, {});
  assert.match(start, /Start work on T5 \(Scheduler\)/);
  assert.match(start, /specs\/spec-TASK-5\.md/);
  assert.match(start, /summaries\/summary-TASK-5\.md/);
  assert.match(start, /here in this conversation/);
  assert.doesNotMatch(start, /subagent/);
  const parallel = promptFor('startSubagent', task, {});
  assert.match(parallel, /background subagent with worktree isolation/);
  assert.match(parallel, /isolation: "worktree"/);
  assert.doesNotMatch(parallel, /\{where\}/);

  const bug = { key: 'B2', kind: 'bug', id: 'B2', title: 'Export fails', rel: 'tasks/bugs.md', done: true, spec: 'specs/spec-BUG-2.md', summary: 'summaries/summary-BUG-2.md' };
  assert.match(promptFor('reinvestigate', bug, {}), /Read specs\/spec-BUG-2\.md and summaries\/summary-BUG-2\.md/);
  assert.match(promptFor('start', bug, {}), /regression test/);
  assert.equal(promptFor('summarise', bug, { summarise: 'Sum up {ref}: {title}' }), 'Sum up B2: Export fails');
});

test('local providers point every model role at the local server and drop cloud credentials', async () => {
  const { sessionSettings, SUBSCRIPTION } = await import('../dist/providers.js');
  assert.deepEqual(sessionSettings(SUBSCRIPTION), {}, 'subscription keeps the inherited environment');

  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-should-not-leak';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api-should-not-leak';
  const { env, model } = sessionSettings({ id: 'x', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', authToken: 'ollama', model: 'qwen3-coder', smallModel: 'qwen3:4b' });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;

  assert.equal(model, 'qwen3-coder');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:11434');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'ollama');
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(env[k], 'qwen3-coder', k);
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'qwen3:4b');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwen3:4b');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.ok(env.PATH, 'keeps PATH so tools still run');
});

test('provider store normalises addresses, remembers per-project choice, and resets on delete', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'desk-cfg-'));
  process.env.SLOP_FACTORY_CONFIG_DIR = dir;
  try {
    const { ProviderStore } = await import('../dist/providers.js');
    const store = new ProviderStore();
    await store.load();
    assert.deepEqual(store.list().map((p) => p.id), ['subscription']);
    const saved = await store.upsert({ id: '', name: '', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080/v1/', model: 'qwen3-coder' });
    assert.equal(saved.baseUrl, 'http://127.0.0.1:8080');
    assert.equal(saved.name, 'llama.cpp (qwen3-coder)');
    await store.setForProject('/proj/a', saved.id);

    const again = new ProviderStore();
    await again.load();
    assert.equal(again.forProject('/proj/a').id, saved.id);
    assert.equal(again.forProject('/proj/b').id, 'subscription');
    assert.deepEqual(await again.remove(saved.id), ['/proj/a']);
    assert.equal(again.forProject('/proj/a').id, 'subscription');
    await assert.rejects(again.upsert({ id: '', name: '', kind: 'ollama', baseUrl: 'localhost:11434', model: 'x' }), /http/);
  } finally {
    delete process.env.SLOP_FACTORY_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// A made-up file in the older TASK.md layout: "## Section" groups, TASK-<n> ids, detail fields.
const legacyMd = `# Tasks

Ordered tasks. Status: \`[ ]\` not started, \`[~]\` in progress, \`[x]\` done.

## How to use this file

- Work on a task only when asked.

## Essential

- [x] TASK-001: Initialise the repository
  - **Deliverable:** A git repository.
  - **Depends on:** none
- [x] TASK-002: Match engine
  - **Deliverable:** An engine.
  - **Subtasks** (do in order):
    - [x] TASK-002.1: Skeleton
      - **Depends on:** TASK-099
    - [x] TASK-002.2: Rules
  - **Depends on:** TASK-001

## Release

- [~] TASK-003: Signed builds
  - **Deliverable:** Tagged builds.
  - **Depends on:** TASK-002, TASK-004
  - **Blocked by:** Open question 5 (hosting); Apple Developer account
- [ ] TASK-004: Store page
  - **Depends on:** none
`;

test('older TASK.md: sections, TASK ids, subtasks, dependencies and blocked reasons', () => {
  const f = parseTaskFile(legacyMd, 'TASK.md');
  assert.equal(f.kind, 'legacy');
  assert.equal(f.phases, undefined);
  assert.deepEqual(
    f.items.map((i) => [i.id, i.state, i.depth, i.section]),
    [
      ['TASK-001', 'done', 0, 'Essential'],
      ['TASK-002', 'done', 0, 'Essential'],
      ['TASK-002.1', 'done', 1, 'Essential'],
      ['TASK-002.2', 'done', 1, 'Essential'],
      ['TASK-003', 'doing', 0, 'Release'],
      ['TASK-004', 'todo', 0, 'Release'],
    ],
  );
  const byId = Object.fromEntries(f.items.map((i) => [i.id, i]));
  assert.equal(byId['TASK-002'].title, 'Match engine');
  assert.deepEqual(byId['TASK-002'].dependsOn, ['TASK-001'], "a field after the subtasks still belongs to the parent");
  assert.deepEqual(byId['TASK-002.1'].dependsOn, ['TASK-099'], "the subtask's own field");
  assert.equal(byId['TASK-001'].dependsOn, undefined, '"none" is no dependency');
  assert.deepEqual(byId['TASK-003'].dependsOn, ['TASK-002', 'TASK-004']);
  assert.deepEqual(byId['TASK-003'].blockedBy, ['Open question 5 (hosting)', 'Apple Developer account']);
  assert.ok(byId['TASK-003'].hasDetails);
});

test('a TASK.md with a phase table is still the current format', () => {
  assert.equal(parseTaskFile(indexMd, 'TASK.md').kind, 'index');
});

test('older TASK.md: the progress view gets the task entry, dedented, without its checkbox', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'desk-'));
  let w;
  try {
    await writeFile(path.join(root, 'TASK.md'), legacyMd);
    let latest = [];
    w = new TaskWatcher(root, DEFAULT_TASK_CONFIG, (files) => (latest = files));
    w.start();
    await waitFor(() => latest.length === 1);
    assert.equal(latest[0].kind, 'legacy');
    const line = latest[0].items.find((i) => i.id === 'TASK-002.1').line;
    const block = await w.readBlock('TASK.md', line);
    assert.equal(block.rel, `TASK.md#L${line + 1}`);
    assert.equal(block.markdown, 'TASK-002.1: Skeleton\n  - **Depends on:** TASK-099');
    const parent = await w.readBlock('TASK.md', latest[0].items.find((i) => i.id === 'TASK-002').line);
    assert.match(parent.markdown, /^TASK-002: Match engine\n  - \*\*Deliverable:\*\*/);
    assert.match(parent.markdown, /TASK-002\.2: Rules\n  - \*\*Depends on:\*\* TASK-001$/);
    assert.equal(await w.readBlock('TASK.md', 0), undefined, 'not a task line');
  } finally {
    await w?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('the root plan.md is watched as a doc, in any case, even with custom docGlobs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'desk-'));
  let w;
  try {
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs/plan.md'), '# Not the project plan\n');
    let docs;
    w = new TaskWatcher(root, { ...DEFAULT_TASK_CONFIG, docGlobs: [] }, (_files, d) => (docs = d));
    w.start();
    await waitFor(() => docs !== undefined);
    assert.deepEqual(docs, []);
    await writeFile(path.join(root, 'PLAN.md'), '# Plan\n\nShip it.\n');
    await waitFor(() => docs.length === 1);
    assert.deepEqual(docs, ['PLAN.md']);
    assert.deepEqual(await w.readDocs(['PLAN.md']), [{ rel: 'PLAN.md', markdown: '# Plan\n\nShip it.\n' }]);
    await rm(path.join(root, 'PLAN.md'));
    await waitFor(() => docs.length === 0);
  } finally {
    await w?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('phases and older sections start as a whole, and old overrides still say where to run', () => {
  const phase = { key: 'P2', kind: 'phase', title: 'Export', rel: 'tasks/task_phase_2.md', phase: '2', done: false };
  assert.match(promptFor('start', phase, {}), /^Work through phase 2 \(Export\), tasks\/task_phase_2\.md\./);
  assert.match(promptFor('startSubagent', phase, {}), /worktree/);
  const section = { key: 'section:Core', kind: 'phase', title: 'Core', rel: 'TASK.md', done: false, legacy: true };
  assert.match(promptFor('start', section, {}), /^Work through the "Core" section of TASK\.md\./);
  assert.match(promptFor('summarise', { ...section, done: true }, {}), /the entries in its section of TASK\.md/);
  const task = { key: 'T5', kind: 'task', id: 'T5', title: 'Scheduler', rel: 'tasks/task_phase_2.md', done: false };
  assert.equal(promptFor('startSubagent', task, { startTask: 'Do {ref}.', whereSubagent: 'Elsewhere.' }), 'Do T5.\n\nElsewhere.');
});

test('older-format start prompt works from the entry, not a spec', () => {
  const item = { key: 'TASK-003', kind: 'task', id: 'TASK-003', title: 'Signed builds', rel: 'TASK.md', done: false, legacy: true };
  const prompt = promptFor('start', item, {});
  assert.match(prompt, /Start work on TASK-003 \(Signed builds\) from TASK\.md/);
  assert.match(prompt, /Deliverable/);
  assert.doesNotMatch(prompt, /spec-TASK/);
  assert.match(promptFor('reinvestigate', { ...item, done: true }, {}), /Read its entry in TASK\.md/);
});

test('permission mode is remembered per project, and the last choice becomes the default', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'desk-cfg-'));
  process.env.SLOP_FACTORY_CONFIG_DIR = dir;
  try {
    const { ProviderStore } = await import('../dist/providers.js');
    const store = new ProviderStore();
    await store.load();
    assert.equal(store.modeFor('/proj/a'), 'default');
    await store.setMode('/proj/a', 'auto');
    await store.setMode('/proj/b', 'acceptEdits');
    await store.setMode('/proj/c', 'not-a-mode');
    const again = new ProviderStore();
    await again.load();
    assert.equal(again.modeFor('/proj/a'), 'auto');
    assert.equal(again.modeFor('/proj/b'), 'acceptEdits');
    assert.equal(again.modeFor('/proj/new'), 'acceptEdits', 'new projects start in the last mode chosen');
  } finally {
    delete process.env.SLOP_FACTORY_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test('open questions come from the Open questions section, with left-open items marked', () => {
  const src = [
    '# Phase 2: Export',
    '',
    '## Tasks',
    '- [ ] T3: Scheduler?',
    '',
    '## Open questions',
    '',
    '- Which SMTP provider do we use? Decides: Darren.',
    '  Options so far: SES or Postmark.',
    '- Do exports need a retention limit? (left open by the user, 2026-10-01)',
    '',
    '```',
    '- not a question, in a fence',
    '```',
    '',
    '## Revision history',
    '- Which is not a question either?',
  ].join('\n');
  const qs = parseOpenQuestions(src, 'tasks/task_phase_2.md');
  assert.deepEqual(qs.map((q) => [q.id, q.line, q.doc]), [
    ['tasks/task_phase_2.md#L8', 7, 'Phase 2: Export'],
    ['tasks/task_phase_2.md#L10', 9, 'Phase 2: Export'],
  ]);
  assert.equal(qs[0].text, 'Which SMTP provider do we use? Decides: Darren.\nOptions so far: SES or Postmark.');
  assert.equal(qs[0].leftOpen, undefined);
  assert.equal(qs[1].text, 'Do exports need a retention limit?');
  assert.equal(qs[1].leftOpen, '2026-10-01');
  assert.deepEqual(parseOpenQuestions('# Plan\n\n## Open questions\n\nNone.\n', 'plan.md'), []);
  assert.deepEqual(parseOpenQuestions('# Plan\n\n## Open questions\n\n- None.\n', 'plan.md'), []);
});

test('the watcher gathers open questions from plan.md, docs/ and phase documents, plan first', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'desk-'));
  let w;
  try {
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await mkdir(path.join(root, 'tasks'), { recursive: true });
    await writeFile(path.join(root, 'tasks/task_phase_1.md'), '# Phase 1: Build\n\n## Open questions\n- Phase question?\n');
    await writeFile(path.join(root, 'docs/stack.md'), '# Stack\n\n## Open questions\n- Which database?\n');
    await writeFile(path.join(root, 'plan.md'), '# Plan\n\n## Open questions\n- Who are the users?\n');
    await writeFile(path.join(root, 'README.md'), '# Readme\n\n## Open questions\n- Not watched?\n');
    let questions = [];
    w = new TaskWatcher(root, DEFAULT_TASK_CONFIG, (_f, _d, q) => (questions = q));
    w.start();
    await waitFor(() => questions.length === 3);
    assert.deepEqual(questions.map((q) => q.rel), ['plan.md', 'docs/stack.md', 'tasks/task_phase_1.md']);
    await writeFile(path.join(root, 'docs/stack.md'), '# Stack\n\n## Open questions\nNone.\n');
    await waitFor(() => questions.length === 2);
  } finally {
    await w?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('basic AGENTS.md is the task-tracking standard alone, a level down, with fenced examples untouched', async () => {
  const { basicAgentsMd, folderFor } = await import('../dist/newproject.js');
  const standard = '---\nname: task-tracking\n---\n\n# Task tracking\n\n## Delivery phases\n\nSee the plan ([[project-planning]]). Commit per [[git-and-commits]].\n\n```markdown\n# Tasks\n```\n';
  const out = basicAgentsMd(standard);
  assert.match(out, /^# Agent instructions\n/);
  assert.match(out, /\n## Task tracking\n\n### Delivery phases\n/);
  assert.match(out, /See the plan\. Commit per the git and commits standard\./);
  assert.match(out, /```markdown\n# Tasks\n```/);
  assert.doesNotMatch(out, /name: task-tracking/);
  assert.equal(folderFor('Slop Factory!'), 'slop-factory');
});

test('createProject makes the folder, a git repo with its remote, and the chosen framework', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'desk-new-'));
  const prev = process.env.SLOP_FACTORY_CONFIG_DIR;
  process.env.SLOP_FACTORY_CONFIG_DIR = path.join(root, 'config');
  try {
    const { execFileSync } = await import('node:child_process');
    // A stand-in framework copy, so the test needs no network (its pull fails and the copy is used).
    const fw = path.join(root, 'config', 'agent-framework');
    await mkdir(path.join(fw, 'standards'), { recursive: true });
    await writeFile(path.join(fw, 'standards', 'task-tracking.md'), '---\nname: task-tracking\n---\n\n# Task tracking\n\n## Bugs\n\nKeep tasks/bugs.md.\n');
    await writeFile(path.join(fw, 'install.sh'), 'echo "# full install" > "$1/AGENTS.md"\n');
    execFileSync('git', ['init', '-q', fw]);
    const { createProject } = await import('../dist/newproject.js');
    const log = [];
    const parent = path.join(root, 'code');
    await mkdir(parent);

    const basic = await createProject({ name: 'Slop Factory', parent, git: true, remote: 'git@github.com:me/slop.git', framework: 'basic' }, (l) => log.push(l));
    assert.equal(basic, path.join(parent, 'slop-factory'));
    assert.match(await readFile(path.join(basic, 'AGENTS.md'), 'utf8'), /### Bugs\n\nKeep tasks\/bugs\.md\./);
    assert.equal(execFileSync('git', ['-C', basic, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim(), 'git@github.com:me/slop.git');

    const full = await createProject({ name: 'Full', parent, git: false, framework: 'full' }, (l) => log.push(l));
    assert.equal(await readFile(path.join(full, 'AGENTS.md'), 'utf8'), '# full install\n');
    await assert.rejects(stat(path.join(full, '.git')));

    await assert.rejects(createProject({ name: 'Full', parent, git: false, framework: 'none' }, () => {}), /isn't empty/);
    await assert.rejects(createProject({ name: ' ', parent, git: false, framework: 'none' }, () => {}), /name/);
  } finally {
    if (prev === undefined) delete process.env.SLOP_FACTORY_CONFIG_DIR;
    else process.env.SLOP_FACTORY_CONFIG_DIR = prev;
    await rm(root, { recursive: true, force: true });
  }
});

test('enqueue puts a phase\'s tasks at the front or back, in their lane, and remove clears the lane', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'desk-'));
  try {
    const q = new Priorities(root);
    await q.load();
    await q.toggle('B1');
    await q.enqueue(['T7', 'T8'], 'subagent', true);
    assert.deepEqual(q.list(), ['T7', 'T8', 'B1']);
    assert.deepEqual(q.subagentKeys(), ['T7', 'T8']);
    await q.enqueue(['T8', 'T9'], 'main', false);
    assert.deepEqual(q.list(), ['T7', 'B1', 'T8', 'T9']);
    assert.deepEqual(q.subagentKeys(), ['T7']);
    await q.remove('T7');
    const again = new Priorities(root);
    assert.deepEqual(await again.load(), ['B1', 'T8', 'T9']);
    assert.deepEqual(again.subagentKeys(), []);
    await again.enqueue(['T10'], 'subagent', false);
    const third = new Priorities(root);
    await third.load();
    assert.deepEqual(third.subagentKeys(), ['T10']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worktrees: list a subagent branch, diff it, merge it, refuse a conflicting merge, discard', async () => {
  const { listWorktrees, worktreeDiff, mergeWorktree, discardWorktree } = await import('../dist/worktrees.js');
  const { execFileSync } = await import('node:child_process');
  const root = await mkdtemp(path.join(tmpdir(), 'desk-wt-'));
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  try {
    g(root, 'init', '-q', '-b', 'main');
    await writeFile(path.join(root, 'a.txt'), 'one\n');
    g(root, 'add', '.');
    g(root, 'commit', '-qm', 'start');
    assert.deepEqual(await listWorktrees(root), []);

    const wt = path.join(root, '.claude', 'worktrees', 'agent-1');
    g(root, 'worktree', 'add', '-q', '-b', 'agent-1', wt);
    await writeFile(path.join(wt, 'a.txt'), 'one\ntwo\n');
    g(wt, 'commit', '-qam', 'two');
    await writeFile(path.join(wt, 'b.txt'), 'draft\n');

    const [info] = await listWorktrees(root);
    assert.deepEqual({ branch: info.branch, base: info.base, ahead: info.ahead, files: info.files, uncommitted: info.uncommitted, agent: info.agent }, {
      branch: 'agent-1', base: 'main', ahead: 1, files: ['a.txt'], uncommitted: 1, agent: true,
    });
    const diff = await worktreeDiff(root, wt);
    assert.match(diff, /\+two/);
    assert.match(diff, /new file, not committed: b\.txt/);

    assert.match(await mergeWorktree(root, wt), /Merged agent-1 into main \(1 commit\)/);
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');

    // A branch that conflicts with main leaves main as it was.
    const wt2 = path.join(root, '.claude', 'worktrees', 'agent-2');
    g(root, 'worktree', 'add', '-q', '-b', 'agent-2', wt2, 'HEAD~1');
    await writeFile(path.join(wt2, 'a.txt'), 'other\n');
    g(wt2, 'commit', '-qam', 'other');
    await assert.rejects(mergeWorktree(root, wt2), /doesn't merge cleanly into main, so nothing was changed/);
    assert.equal(g(root, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');

    assert.match(await discardWorktree(root, wt2), /Discarded agent-2/);
    assert.deepEqual((await listWorktrees(root)).map((w) => w.branch), ['agent-1']);
    assert.doesNotMatch(g(root, 'branch'), /agent-2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stored conversation becomes the events that show it, without Claude Code\'s own additions', async () => {
  const { messagesToEvents } = await import('../dist/history.js');
  const events = messagesToEvents([
    { type: 'user', uuid: 'u1', parent_tool_use_id: null, message: { role: 'user', content: 'Fix the bug' } },
    { type: 'user', uuid: 'u0', parent_tool_use_id: null, message: { role: 'user', content: '<system-reminder>internal</system-reminder>' } },
    { type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', uuid: 'u2', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt', is_error: false }] } },
    { type: 'assistant', uuid: 'a2', parent_tool_use_id: 'tu9', message: { content: [{ type: 'text', text: 'subagent says hi' }] } },
  ]);
  assert.deepEqual(events, [
    { type: 'user', text: 'Fix the bug' },
    { type: 'assistantText', msgId: 'msg_1', text: 'Looking.', parent: null },
    { type: 'toolUse', id: 'tu1', name: 'Bash', input: { command: 'ls' }, parent: null },
    { type: 'toolResult', toolUseId: 'tu1', isError: false, preview: 'a.txt' },
    { type: 'assistantText', msgId: 'a2', text: 'subagent says hi', parent: 'tu9' },
  ]);
});

test('attached files go to the model as blocks and come back as attachments', async () => {
  const { messageContent } = await import('../dist/attachments.js');
  const { messagesToEvents } = await import('../dist/history.js');
  assert.equal(messageContent('Just text'), 'Just text');
  const content = messageContent('Look at these', [
    { name: 'shot.png', kind: 'image', mediaType: 'image/png', data: 'AAAA' },
    { name: 'spec.pdf', kind: 'pdf', mediaType: 'application/pdf', data: 'BBBB' },
    { name: 'a "b".txt', kind: 'text', mediaType: 'text/plain', data: 'hello' },
  ]);
  assert.deepEqual(content, [
    { type: 'text', text: 'Look at these' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' }, title: 'spec.pdf' },
    { type: 'text', text: '<attached-file name="a _b_.txt">\nhello\n</attached-file>' },
  ]);
  // Files alone, with no text, are a message too.
  assert.deepEqual(messageContent('  ', [{ name: 'x.txt', kind: 'text', mediaType: 'text/plain', data: 'x' }]), [{ type: 'text', text: '<attached-file name="x.txt">\nx\n</attached-file>' }]);
  assert.deepEqual(messagesToEvents([{ type: 'user', uuid: 'u1', parent_tool_use_id: null, message: { role: 'user', content } }]), [
    { type: 'user', text: 'Look at these', attachments: ['image', 'spec.pdf', 'a _b_.txt'] },
  ]);
});

test('quick capture writes tasks, bugs and questions in the standard formats', async () => {
  const { nextId, insertTask, insertLegacyTask, insertBug, insertQuestion } = await import('../dist/capture.js');
  const date = new Date().toISOString().slice(0, 10);
  assert.equal(nextId(['- [x] T4: a\n- [ ] T12: b', 'T7 waits on T9'], 'T'), 13);
  assert.equal(nextId(['### B2: x\n### B5: y'], 'B'), 6);
  const phase = '# Phase 2: Export\n\n## Tasks\n\n- [ ] T3: One\n\n## Done when\n\n- Shipped.\n\n## Revision history\n\n| Date | Change |\n|---|---|\n| 2026-10-01 | First. |\n';
  const withTask = insertTask(phase, 'T13', 'Two');
  assert.match(withTask, /- \[ \] T3: One\n- \[ \] T13: Two\n\n## Done when/);
  assert.match(withTask, new RegExp(`\\| 2026-10-01 \\| First\\. \\|\\n\\| ${date} \\| Added T13: Two \\|`));
  assert.match(insertTask('# Phase 9: New\n', 'T1', 'First'), /# Phase 9: New\n\n## Tasks\n\n- \[ \] T1: First/);
  assert.match(insertLegacyTask('# Tasks\n\n## Core\n\n- [ ] TASK-001: a\n\n## Later\n', 'Core', 'TASK-002', 'b'), /TASK-001: a\n- \[ \] TASK-002: b\n\n## Later/);
  assert.equal(insertBug('# Bugs\n\n### B1: Old\n- Status: fixed\n', 'B2', 'Crash on save', 'Happens with empty files'), `# Bugs\n\n### B1: Old\n- Status: fixed\n\n### B2: Crash on save\n- Status: open\n- Reported: ${date}\n- Happens with empty files\n`);
  assert.match(insertBug('', 'B1', 'First', ''), /^# Bugs\n\n### B1: First\n- Status: open/);
  assert.match(insertQuestion('# Stack\n\n## Open questions\n\nNone.\n\n## Revision history\n', 'Which database?'), /## Open questions\n\n- Which database\?\n\n## Revision history/);
  assert.match(insertQuestion('# Plan\n\nText.\n\n## Revision history\n\n| a | b |\n', 'Who decides?'), /Text\.\n\n## Open questions\n\n- Who decides\?\n\n## Revision history/);
});

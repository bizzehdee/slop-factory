import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { startApp } from './harness.mjs';

let app;
before(async () => (app = await startApp()));
after(async () => app?.stop());

const task = (page, text) => page.locator('.task', { hasText: text }).first();

async function itemMenu(page, row) {
  await row.hover();
  await row.locator('.more').first().click();
  return page.locator('#menu .menu-item');
}

async function idle(page) {
  await page.waitForSelector('#stop', { state: 'hidden', timeout: 15_000 });
}

test('the board shows phases, tasks and bugs, and follows edits on disk', async () => {
  const dir = await app.project();
  const page = await app.open(dir);
  await page.waitForSelector('.phase.current');
  assert.match(await page.textContent('.phase.current'), /Export/);
  assert.equal(await page.locator('.phase.current .task').count(), 4);
  assert.match(await page.textContent('.bug-list'), /B1/);
  await writeFile(path.join(dir, 'tasks/task_phase_2.md'), (await readFile(path.join(dir, 'tasks/task_phase_2.md'), 'utf8')).replace('- [ ] T5: Report', '- [x] T5: Report'));
  await page.waitForSelector('.task.done:has-text("Report")');
  assert.deepEqual(page.errors, []);
});

test('the project name opens plan.md', async () => {
  const page = await app.open(await app.project());
  await page.click('.project-name-button');
  await page.waitForSelector('#docs-body h1');
  assert.match(await page.textContent('#docs-body'), /A small app/);
});

test('a reply keeps the conversation scrolled to the end', async () => {
  const page = await app.open(await app.project());
  for (let i = 0; i < 8; i++) {
    await page.fill('#prompt', `Message ${i}\n${'line\n'.repeat(6)}`);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`.msg.assistant:has-text("Done: Message ${i}")`);
  }
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  const gap = await page.$eval('.transcript:not([hidden])', (t) => t.scrollHeight - t.scrollTop - t.clientHeight);
  assert.ok(gap < 5, `transcript is ${gap}px from the bottom`);
});

test('prioritised work waits for the current turn, and Stop holds the queue', async () => {
  const page = await app.open(await app.project());
  await page.fill('#prompt', 'Do something slow');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#stop:not([hidden])');
  await (await itemMenu(page, task(page, 'Report'))).filter({ hasText: 'Prioritise' }).click();
  await page.waitForSelector('.priority:has-text("T5")');
  await page.click('#stop');
  await page.waitForSelector('.notice:has-text("Stopped.")');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.msg.user.action').count(), 0, 'nothing started after Stop');
  await page.click('#priorities-count .link-button');
  await page.waitForSelector('.msg.user.action:has-text("T5")');
  await idle(page);
  assert.equal(await page.locator('.priority').count(), 0);
});

test('starting a phase starts the first task that can start and queues the rest, which can be removed', async () => {
  const page = await app.open(await app.project());
  // Keep the agent busy so the queue holds still while the test looks at it.
  await page.fill('#prompt', 'Do something slow');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#stop:not([hidden])');
  await page.hover('.phase.current .phase-top');
  await page.click('.phase.current .phase-top .more');
  await page.click('#menu .menu-item:has-text("Start now, queue the rest")');
  // T3 waits on T4 and T4 is blocked, so T5 goes first.
  await page.waitForSelector('.msg.user.action:has-text("T5")');
  await page.waitForSelector('.priority:has-text("T4")');
  assert.deepEqual(await page.$$eval('.priority .item-id', (els) => els.map((e) => e.textContent)), ['T3', 'T4']);
  const row = (id) => page.locator('.priority', { has: page.locator('.item-id', { hasText: new RegExp(`^${id}$`) }) });
  assert.match(await row('T3').locator('.priority-state').textContent(), /waits on T4/);
  assert.match(await row('T4').locator('.priority-state').textContent(), /blocked/);
  await row('T4').locator('.dequeue').click();
  await page.waitForFunction(() => document.querySelectorAll('.priority').length === 1);
  // When the agent is free, T3 still waits: nothing else starts.
  await idle(page);
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.msg.user.action').count(), 1);
});

test('a queued task waiting on another starts once that one is ticked done', async () => {
  const dir = await app.project();
  const page = await app.open(dir);
  await page.fill('#prompt', 'Do something slow');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#stop:not([hidden])');
  await (await itemMenu(page, task(page, 'Scheduler'))).filter({ hasText: 'Prioritise' }).click();
  await page.waitForSelector('.priority:has-text("T3")');
  await idle(page);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.msg.user.action').count(), 0, 'T3 waits on T4');
  const file = path.join(dir, 'tasks/task_phase_2.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace('- [ ] T4: Email', '- [x] T4: Email'));
  await page.waitForSelector('.msg.user.action:has-text("T3")', { timeout: 10_000 });
});

test('the subagent lane carries on through a window reload', async () => {
  const dir = await app.project({
    'task.md': '# Tasks\n\n| Phase | Goal | Status | Document |\n|---|---|---|---|\n| 1 | Docs | in progress | [Phase 1](tasks/task_phase_1.md) |\n',
    'tasks/task_phase_1.md': '# Phase 1: Docs\n\n## Tasks\n\n- [ ] T1: Slow guide\n- [ ] T2: Index\n',
    'tasks/task_phase_2.md': null,
  });
  let page = await app.open(dir);
  await page.hover('.phase.current .phase-top');
  await page.click('.phase.current .phase-top .more');
  await page.click('#menu .menu-item:has-text("Start in subagent, queue the rest")');
  await page.waitForSelector('.proc.live:has-text("Work in a worktree")');
  await page.reload();
  await page.waitForSelector('#project-header:not([hidden])');
  // T1's subagent finishes after the reload; the lane still starts T2.
  await page.waitForSelector('.msg.user.action:has-text("T2")', { timeout: 15_000 });
});

test('open questions list the plan and the reply, and an answer goes to the agent', async () => {
  const page = await app.open(await app.project());
  await page.waitForSelector('.q-row:has-text("licence")');
  assert.ok(await page.locator('.q-row.left-open:has-text("offline")').count());
  await page.fill('#prompt', 'Any questions?');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.q-group:has-text("From the conversation") .q-row:has-text("database")');
  await page.click('.q-row:has-text("licence") .q-open');
  await page.fill('#docs-body .q-answer', 'BSD 3-Clause');
  await page.click('#docs-actions button:has-text("Send answer")');
  await page.waitForSelector('.msg.user:has-text("BSD 3-Clause")');
  assert.equal(await page.locator('.q-row:has-text("licence")').count(), 0);
});

test("the agent's multiple-choice questions open with recommendations and send the picks", async () => {
  const page = await app.open(await app.project());
  await page.fill('#prompt', 'Please ask me about the stack');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#docs-body .ask-form');
  assert.equal(await page.locator('.ask-option.recommended').count(), 2);
  assert.equal(await page.isDisabled('#docs-actions .button.primary'), true);
  await page.check('.ask-option:has-text("Postgres") input');
  await page.check('.ask-option:has-text("Web") input');
  await page.check('.ask-option:has-text("Desktop") input');
  await page.click('#docs-actions .button.primary');
  await page.waitForSelector('.msg.assistant:has-text("Thanks. Postgres; Web (Recommended), Desktop.")');
});

test('waits-on and blocked hints go to what blocks the task', async () => {
  const page = await app.open(await app.project());
  await page.click('.hint-link.waits:has-text("T4")');
  await page.waitForSelector('.task.flash:has-text("Email")');
  await page.click('.hint-link.blocked:has-text("SMTP")');
  await page.waitForSelector('#docs-title:has-text("SMTP provider")');
});

test('a permission prompt waits for an answer', async () => {
  const page = await app.open(await app.project());
  await page.fill('#prompt', 'Needs permission to run tests');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.permission:has-text("Bash")');
  await page.click('.permission .button.primary');
  await page.waitForSelector('.msg.assistant:has-text("Done: Needs permission")');
});

test('the theme setting sticks across a reload', async () => {
  const page = await app.open(await app.project());
  await page.click('#open-settings');
  await page.check('#theme-picker input[value=dark]');
  await page.reload();
  await page.waitForSelector('#project-header:not([hidden])');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
});

test('a new project gets its folder and git repository, then opens', async () => {
  const page = await app.open();
  await page.click('#add-project');
  await page.click('#menu .menu-item:has-text("New project")');
  await page.fill('#new-project-form input[name=name]', 'Fresh Start');
  await page.fill('#np-parent', app.work);
  await page.check('#new-project-form input[value=none]');
  await page.click('#np-create');
  await page.waitForSelector('#project-name:has-text("fresh-start")');
  await stat(path.join(app.work, 'fresh-start', '.git'));
});

test("a subagent's worktree can be reviewed, merged or discarded", async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = await app.project({ 'src/app.js': 'export const answer = 41;\n' });
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  g(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, '.gitignore'), '.claude/\n.slop-factory/\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'start');
  const one = path.join(dir, '.claude', 'worktrees', 'agent-fix');
  const two = path.join(dir, '.claude', 'worktrees', 'agent-spike');
  g(dir, 'worktree', 'add', '-q', '-b', 'agent-fix', one);
  g(dir, 'worktree', 'add', '-q', '-b', 'agent-spike', two);
  await writeFile(path.join(one, 'src/app.js'), 'export const answer = 42;\n');
  g(one, 'commit', '-qam', 'Fix the answer');
  await writeFile(path.join(one, 'notes.md'), 'draft\n');

  const page = await app.open(dir);
  page.on('dialog', (d) => d.accept());
  await page.waitForSelector('.worktree:has-text("agent-fix")');
  assert.match(await page.textContent('.worktree:has-text("agent-fix") .worktree-meta'), /1 commit · 1 file · 1 not committed/);
  await page.click('.worktree:has-text("agent-fix") .worktree-main');
  await page.waitForSelector('.diff-lines .add:has-text("answer = 42")');
  assert.ok(await page.locator('.diff-file summary:has-text("notes.md")').count());
  await page.click('#docs-actions button:has-text("Merge into main")');
  await page.waitForSelector('.notice:has-text("Merged agent-fix into main")');
  assert.equal(await readFile(path.join(dir, 'src/app.js'), 'utf8'), 'export const answer = 42;\n');

  await page.click('.worktree:has-text("agent-spike") button:has-text("Discard")');
  await page.waitForSelector('.notice:has-text("Discarded agent-spike")');
  await page.waitForFunction(() => !document.querySelector('.worktree')?.textContent?.includes('agent-spike'));
});

test('a conversation carries on after the app restarts, until New conversation', async () => {
  const dir = await app.project();
  let page = await app.open(dir);
  await page.fill('#prompt', 'Remember the word marmalade');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.assistant:has-text("Done: Remember the word marmalade")');
  await page.close();
  await app.restartSidecar();
  page = await app.open(dir);
  await page.waitForSelector('.msg.user:has-text("Remember the word marmalade")');
  await page.waitForSelector('.notice:has-text("Picked up where you left off")');
  assert.equal(await page.locator('.notice.error').count(), 0, 'no errors while the project reopens');
  await page.click('#project-menu');
  await page.click('#menu .menu-item:has-text("New conversation")');
  await page.waitForSelector('.notice:has-text("Started a new conversation.")');
  await page.close();
  await app.restartSidecar();
  page = await app.open(dir);
  await page.waitForSelector('#project-header:not([hidden])');
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.msg.user:has-text("marmalade")').count(), 0);
});

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
    await idle(page);
  }
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

test('starting a phase starts its first task and queues the rest, which can be removed', async () => {
  const page = await app.open(await app.project());
  // Keep the agent busy so the queue holds still while the test looks at it.
  await page.fill('#prompt', 'Do something slow');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#stop:not([hidden])');
  await page.hover('.phase.current .phase-top');
  await page.click('.phase.current .phase-top .more');
  await page.click('#menu .menu-item:has-text("Start now, queue the rest")');
  await page.waitForSelector('.msg.user.action:has-text("T3")');
  await page.waitForSelector('.priority:has-text("T4")');
  assert.deepEqual(await page.$$eval('.priority .item-id', (els) => els.map((e) => e.textContent)), ['T4', 'T5']);
  await page.click('.priority:has-text("T4") .dequeue');
  await page.waitForFunction(() => document.querySelectorAll('.priority').length === 1);
  // When the agent is free, the queue moves on to what's left: T5, not the removed T4.
  await page.waitForSelector('.msg.user.action:has-text("T5")', { timeout: 15_000 });
  assert.equal(await page.locator('.msg.user.action:has-text("T4")').count(), 0);
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

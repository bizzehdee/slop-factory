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
  // No description: the agent isn't sent anything.
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.transcript:not([hidden]) .msg.user').count(), 0);

  // With one, its first message asks the agent to start a plan for it.
  await page.click('#add-project');
  await page.click('#menu .menu-item:has-text("New project")');
  await page.fill('#new-project-form input[name=name]', 'Invoicer');
  await page.fill('#new-project-form textarea[name=description]', '  An invoicing app for freelancers  ');
  await page.fill('#np-parent', app.work);
  await page.check('#new-project-form input[value=none]');
  await page.click('#np-create');
  await page.waitForSelector('#project-name:has-text("invoicer")');
  await page.waitForSelector('.transcript:not([hidden]) .msg.user.action:has-text("Start a plan")');
  assert.equal(
    (await page.textContent('.transcript:not([hidden]) .msg.user.action .action-prompt')).trim(),
    'Start a plan, and await more instructions for: An invoicing app for freelancers',
  );
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

test("a subagent's own transcript can be watched live, and read again after a reload", async () => {
  const page = await app.open(await app.project());
  await page.fill('#prompt', 'Run a slow subagent on this');
  await page.keyboard.press('Enter');
  await page.click('.proc.live:has-text("Work in a worktree") button:has-text("View")');
  await page.waitForSelector('#docs-ref:has-text("Subagent · working")');
  await page.waitForSelector('.agent-text:has-text("Reading the task and its spec.")');
  assert.match(await page.textContent('.agent-step'), /Bash\s*npm test/);
  // It keeps updating as the subagent works, then shows it finished.
  await page.waitForSelector('.agent-text:has-text("All done")', { timeout: 10_000 });
  await page.waitForSelector('#docs-ref:has-text("completed")');
  await page.reload();
  await page.waitForSelector('#project-header:not([hidden])');
  await page.click('.tool-agent .agent-view');
  await page.waitForSelector('.agent-text:has-text("All done")');
});

test('a project you are not looking at notifies you when it finishes or needs you', async () => {
  const a = await app.project();
  const b = await app.project();
  const page = await app.open(a, b);
  const nameA = path.basename(a);
  await page.click(`.project-switch:has-text("${nameA}")`);
  await page.fill('#prompt', 'Do something slow');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#stop:not([hidden])');
  await page.click(`.project-switch:has-text("${path.basename(b)}")`);
  await page.waitForFunction(() => window.__notes.length > 0, null, { timeout: 15_000 });
  const notes = await page.evaluate(() => window.__notes);
  assert.deepEqual(notes[0], { title: nameA, body: 'Done: Do something slow' });
  // Turned off in Settings, nothing more arrives.
  await page.click('#open-settings');
  await page.uncheck('#notify-toggle');
  await page.click('#settings-close');
  await page.click(`.project-switch:has-text("${nameA}")`);
  await page.fill('#prompt', 'Needs permission to run tests');
  await page.keyboard.press('Enter');
  await page.click(`.project-switch:has-text("${path.basename(b)}")`);
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.__notes.length), 1);
});

test("a turn's changes are listed, can be reviewed, and can be undone", async () => {
  const dir = await app.project({ 'notes.txt': 'start\n' });
  const page = await app.open(dir);
  page.on('dialog', (d) => d.accept());
  await page.fill('#prompt', 'Please edit the notes');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.turn-changes:has-text("Changed notes.txt")');
  assert.equal(await readFile(path.join(dir, 'notes.txt'), 'utf8'), 'start\nPlease edit the notes\n');
  await page.fill('#prompt', 'Edit them again');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.turn-changes').length === 2);
  await page.click('.turn-changes >> nth=0 >> button:has-text("Review")');
  await page.waitForSelector('#docs-body .diff-lines .add:has-text("+Please edit the notes")');
  await page.click('#docs-close');
  // Undoing the first turn puts the file back as it was before it, taking the later change with it.
  await page.click('.turn-changes >> nth=0 >> button:has-text("Undo")');
  await page.waitForSelector('.turn-changes.undone');
  await page.waitForSelector('.notice:has-text("Undid the changes to 1 file.")');
  assert.equal(await readFile(path.join(dir, 'notes.txt'), 'utf8'), 'start\n');
});

test('a task, a bug and an open question can be added from the board', async () => {
  const dir = await app.project();
  const page = await app.open(dir);
  await page.waitForSelector('.phase.current'); // the phases the dialog offers have loaded
  const capture = async (item, fill) => {
    await page.click('#capture');
    await page.click(`#menu .menu-item:has-text("${item}")`);
    await fill();
    await page.click('#capture-form button[type=submit]');
  };
  await capture('Add a task', async () => {
    await page.fill('#capture-form input[name=title]', 'CSV export');
    await page.selectOption('#capture-form select[name=where]', 'tasks/task_phase_2.md');
  });
  await page.waitForSelector('.task:has-text("CSV export") .item-id:has-text("T6")');
  assert.match(await readFile(path.join(dir, 'tasks/task_phase_2.md'), 'utf8'), /- \[ \] T5: Report\n- \[ \] T6: CSV export\n/);
  await capture('Report a bug', async () => {
    await page.fill('#capture-form input[name=title]', 'Totals are off by one');
    await page.fill('#capture-form textarea[name=details]', 'Seen on the March report');
  });
  await page.waitForSelector('.bug:has-text("Totals are off by one")');
  assert.match(await readFile(path.join(dir, 'tasks/bugs.md'), 'utf8'), /### B2: Totals are off by one\n- Status: open\n- Reported: .*\n- Seen on the March report/);
  await capture('Add an open question', async () => {
    await page.fill('#capture-form input[name=title]', 'Do reports need a logo?');
    await page.selectOption('#capture-form select[name=where]', 'plan.md');
  });
  await page.waitForSelector('.q-row:has-text("Do reports need a logo?")');
});

test('the queue can be put in a new order by keyboard or by dragging', async () => {
  const dir = await app.project();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(dir, '.slop-factory'), { recursive: true });
  await writeFile(path.join(dir, '.slop-factory/priorities.json'), JSON.stringify({ order: ['T5', 'B1', 'T4'] }));
  const page = await app.open(dir);
  const ids = () => page.$$eval('.priority .item-id', (els) => els.map((e) => e.textContent));
  await page.waitForSelector('.priority');
  assert.deepEqual(await ids(), ['T5', 'B1', 'T4']);
  await page.focus('.priority >> nth=0');
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForFunction(() => document.querySelector('.priority .item-id')?.textContent === 'B1');
  assert.deepEqual(await ids(), ['B1', 'T5', 'T4']);
  await page.dragAndDrop('.priority >> nth=2', '.priority >> nth=0');
  await page.waitForFunction(() => document.querySelector('.priority .item-id')?.textContent === 'T4');
  assert.deepEqual(await ids(), ['T4', 'B1', 'T5']);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, '.slop-factory/priorities.json'), 'utf8')).order, ['T4', 'B1', 'T5']);
});

test('images and text files can be attached by picking, pasting or dropping them', async () => {
  const page = await app.open(await app.project());
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#attach-input', [
    { name: 'screen.png', mimeType: 'image/png', buffer: png },
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') },
  ]);
  await page.waitForSelector('.attachments .attachment-chip.image img');
  assert.equal(await page.locator('.attachments .attachment-chip').count(), 2);
  // A binary file that isn't an image or PDF is refused, with the reason.
  await page.setInputFiles('#attach-input', [{ name: 'tool.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 0]) }]);
  await page.waitForSelector('.attachment-error:has-text("tool.bin")');
  // One can be removed again; a dropped file joins the rest.
  await page.click('.attachment-chip:has-text("notes.md") button');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['a,b\n1,2\n'], 'data.csv', { type: 'text/csv' }));
    document.querySelector('#composer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.attachment-chip:has-text("data.csv")');
  // Files can be sent without any text.
  assert.equal(await page.isEnabled('#send'), true);
  await page.click('#send');
  await page.waitForSelector('.msg.assistant:has-text("I can see screen.png, data.csv.")');
  assert.equal(await page.locator('.msg.user .attachment-chip').count(), 2);
  assert.equal(await page.locator('.attachments').isHidden(), true);
  // The message keeps its attachments after a reload.
  await page.reload();
  await page.waitForSelector('.msg.user .attachment-chip:has-text("data.csv")');
  assert.deepEqual(page.errors, []);
});

test('typing / offers commands and skills', async () => {
  const page = await app.open(await app.project());
  await page.click('#prompt');
  await page.keyboard.type('/re');
  await page.waitForSelector('#slash-menu:not([hidden]) .slash-item');
  assert.match(await page.textContent('#slash-menu .slash-item[aria-selected="true"]'), /\/review/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#slash-menu', { state: 'hidden' });
  await page.fill('#prompt', '');
  await page.keyboard.type('/');
  await page.waitForSelector('#slash-menu .slash-item:has-text("task-tracking")');
  await page.keyboard.type('track');
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#prompt'), '/task-tracking ');
  await page.waitForSelector('#slash-menu', { state: 'hidden' });
});

test('Ctrl+K finds tasks, questions and messages, and goes to them', async () => {
  const page = await app.open(await app.project());
  await page.fill('#prompt', 'Remember the word pineapple');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.assistant:has-text("pineapple")');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#palette[open]');
  await page.keyboard.type('t5 report');
  await page.waitForSelector('.palette-item[aria-selected="true"]:has-text("T5")');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#palette', { state: 'hidden' });
  await page.waitForSelector('.task.flash:has-text("Report")');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('pineapple');
  await page.waitForSelector('.palette-item:has-text("pineapple")');
  await page.locator('.palette-item', { hasText: 'You said' }).click();
  await page.waitForSelector('.msg.user.flash:has-text("pineapple")');
  await page.click('#open-palette');
  await page.keyboard.type('settings');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#settings-dialog[open]');
  assert.deepEqual(page.errors, []);
});

test("each project's usage is counted and shown, with the plan's limit", async () => {
  const page = await app.open(await app.project());
  for (const text of ['First thing', 'Second thing, near the limit']) {
    await page.fill('#prompt', text);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`.msg.assistant:has-text("Done: ${text}")`);
  }
  await page.waitForSelector('#session dd:has-text("Today $0.50")');
  // Gauges: the 5-hour and weekly windows, and the context.
  await page.waitForSelector('#gauges .gauge[aria-label="Context"]');
  assert.equal(await page.getAttribute('#gauges .gauge[aria-label="5-hour limit"]', 'aria-valuenow'), '42');
  assert.match(await page.textContent('#gauges .gauge[aria-label="5-hour limit"]'), /42%.*Resets/);
  assert.equal(await page.getAttribute('#gauges .gauge[aria-label="Weekly limit"]', 'class'), 'gauge high');
  assert.match(await page.textContent('#gauges .gauge[aria-label="Context"]'), /30k \/ 200k/);
  await page.click('#session .link-button:has-text("Details")');
  await page.waitForSelector('.usage-stats');
  assert.match(await page.textContent('.usage-stats'), /\$0\.50/);
  assert.equal(await page.locator('.usage-day').count(), 14);
  // It's still there after a reload, and can be reset.
  await page.reload();
  await page.waitForSelector('#session dd:has-text("Today $0.50")');
  page.once('dialog', (d) => d.accept());
  await page.click('#session .link-button:has-text("Details")');
  await page.click('#docs-actions button:has-text("Reset")');
  await page.waitForSelector('.docs-empty:has-text("Nothing used yet")');
  assert.deepEqual(page.errors, []);
});

test('the agent can find workstreams, and they run at the same time', async () => {
  const dir = await app.project();
  const page = await app.open(dir);
  // No tasks/workstream.md yet: the board offers to find some.
  await page.click('.workstreams.offer .link-button:has-text("Find workstreams")');
  await page.waitForSelector('.msg.user.action:has-text("Find workstreams")');
  await page.waitForSelector('.workstreams .stream:has-text("Email and scheduling")');
  assert.match(await page.textContent('.workstreams h3'), /2 ready/);
  await page.click('.workstreams button:has-text("Run 2 in parallel")');
  await page.waitForSelector('.stream-card:has-text("Reports")');
  assert.match(await page.textContent('.stream-card:has-text("Reports")'), /T5: Report/);
  // Untick one, then tick it again: the button says what runs.
  await page.click('.stream-card:has-text("Reports") input[type=checkbox]');
  assert.equal((await page.textContent('#docs-actions .button.primary')).trim(), 'Run W1');
  await page.click('.stream-card:has-text("Reports") input[type=checkbox]');
  await page.click('#docs-actions button:has-text("Run 2 at the same time")');
  await page.waitForSelector('.msg.user.action:has-text("W1, W2")');
  // Both subagents work at once, then finish.
  await page.waitForFunction(() => document.querySelectorAll('#processes li').length >= 2);
  assert.match(await page.textContent('#processes'), /Workstream W1: Email and scheduling/);
  assert.match(await page.textContent('#processes'), /Workstream W2: Reports/);
  await page.waitForSelector('.msg.assistant:has-text("All 2 workstreams have finished.")');
  assert.deepEqual(page.errors, []);
});

test('a message sent while the agent is busy gets its own changes and undo', async () => {
  const page = await app.open(await app.project());
  await page.fill('#prompt', 'Do something slow');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#stop:not([hidden])');
  await page.fill('#prompt', 'Then edit the notes');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.turn-changes:has-text("notes.txt")', { timeout: 15_000 });
  assert.equal(await page.locator('.turn-changes').count(), 1);
  // It survives a reload, too.
  await page.reload();
  await page.waitForSelector('.turn-changes:has-text("notes.txt")');
});

test("a reply's answer options aren't listed as questions; its question is", async () => {
  const page = await app.open(await app.project());
  await page.fill('#prompt', 'Choose a provider for me');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#questions :text("Which of these should take the card payments?")');
  const text = await page.textContent('#questions');
  assert.doesNotMatch(text, /Stripe/);
  assert.doesNotMatch(text, /PayPal/);
});

test('git: initialise, publish, fetch and pull, push, and commit through the agent', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const dir = await app.project();
  const page = await app.open(dir);
  const fetchNow = async () => {
    await page.click('#git-branch');
    await page.click('#menu .menu-item:has-text("Fetch now")');
  };

  await page.click('#git-status .link-button:has-text("Initialise git")');
  await page.waitForSelector('#git-branch');
  const root = await mkdtemp(path.join(tmpdir(), 'git-ui-'));
  const remote = path.join(root, 'remote.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  g(dir, 'checkout', '-qb', 'main');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'First');
  g(dir, 'remote', 'add', 'origin', remote);

  // A branch that isn't on the remote yet is published with its upstream.
  await fetchNow();
  await page.click('.git-chip:has-text("Publish")');
  await page.waitForSelector('.notice:has-text("now tracks origin/main")');
  assert.match(await page.textContent('#git-branch'), /main/);

  // Someone else pushes: fetching shows it and Pull brings it in.
  const other = path.join(root, 'other');
  g(root, 'clone', '-q', remote, 'other');
  await writeFile(path.join(other, 'theirs.txt'), 'from elsewhere');
  g(other, 'add', '.');
  g(other, 'commit', '-qm', 'Theirs');
  g(other, 'push', '-q');
  await fetchNow();
  await page.click('.git-chip.pull:has-text("↓1")');
  await page.waitForSelector('.notice:has-text("Pulled 1 commit from origin/main.")');
  assert.equal(await readFile(path.join(dir, 'theirs.txt'), 'utf8'), 'from elsewhere');

  // A local commit is pushed.
  await writeFile(path.join(dir, 'mine.txt'), 'mine');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'Mine');
  await fetchNow();
  await page.click('.git-chip.push:has-text("↑1")');
  await page.waitForSelector('.notice:has-text("Pushed 1 commit to origin/main.")');
  assert.match(g(remote, 'log', '--oneline', 'main'), /Mine/);

  // Uncommitted work: the chip shows what it is; only the panel's button asks for a commit.
  await writeFile(path.join(dir, 'scratch.txt'), 'wip');
  await writeFile(path.join(dir, 'theirs.txt'), 'changed here');
  await fetchNow();
  await page.click('.git-chip.changes:has-text("2 uncommitted")');
  await page.waitForSelector('.changed.untracked:has-text("scratch.txt")');
  assert.match(await page.textContent('.changed.modified'), /M\s*theirs\.txt/);
  await page.waitForSelector('.diff-lines .del:has-text("from elsewhere")');
  await page.waitForSelector('.diff-lines .add:has-text("changed here")');
  await page.waitForSelector('.diff-lines .add:has-text("wip")');
  await page.click('#docs-actions button:has-text("Close")');
  await page.waitForSelector('#docs-panel', { state: 'hidden' });
  assert.equal(await page.locator('.msg.user.action:has-text("Commit changes")').count(), 0, 'looking commits nothing');
  await page.click('.git-chip.changes');
  await page.click('#docs-actions button:has-text("Ask the agent to commit")');
  await page.waitForSelector('.msg.user.action:has-text("Commit changes")');
  await page.waitForSelector('#docs-panel', { state: 'hidden' });

  // Pulling by itself is a per-project switch.
  await page.click('#git-branch');
  await page.click('#menu .menu-item:has-text("Pull automatically")');
  await page.waitForTimeout(300);
  await page.click('#git-branch');
  assert.equal(await page.getAttribute('#menu .menu-item:has-text("Pull automatically")', 'aria-checked'), 'true');
  assert.deepEqual(page.errors, []);
});

test("a local model's context gauge is sized by its server, with no subscription limits", async () => {
  const http = await import('node:http');
  // A stand-in llama.cpp server: its models, and the context each slot gets.
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'qwen3-coder' }] }));
    if (req.url === '/props') return res.end(JSON.stringify({ default_generation_settings: { n_ctx: 32768 } }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const page = await app.open(await app.project());
    await page.click('#open-settings');
    await page.click('#settings-dialog button:has-text("Add a local model")');
    await page.check('#provider-form input[name=kind][value=llamacpp]');
    await page.fill('#provider-form input[name=baseUrl]', `http://127.0.0.1:${port}`);
    await page.fill('#provider-form input[name=model]', 'qwen3-coder');
    await page.click('#provider-save');
    await page.waitForSelector('.notice:has-text("Switched to")');
    await page.keyboard.press('Escape');
    await page.fill('#prompt', 'Hello');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#gauges .gauge[aria-label="Context"]');
    assert.match(await page.textContent('#gauges'), /24k \/ 33k.*Window size from llama\.cpp/);
    assert.equal(await page.locator('#gauges .gauge').count(), 1, 'only the context: a local model has no subscription limits');
  } finally {
    server.close();
  }
});

test('a run of tool calls folds into one group, and a call left running stops looking busy when the turn ends', async () => {
  const page = await app.open(await app.project());
  await page.fill('#prompt', 'Use several tools');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.assistant:has-text("I had a look around.")');
  const group = page.locator('.transcript:not([hidden]) details.tool-group');
  assert.equal(await group.count(), 1);
  assert.equal(await group.locator('.tool-group-body > details.tool').count(), 3);
  assert.equal(await group.evaluate((g) => g.open), false, 'folded until you open it');
  assert.match(await group.locator(':scope > summary').textContent(), /3 tool calls.*Read · Search · Bash/);
  assert.equal(await page.locator('.transcript:not([hidden]) details.tool.pending').count(), 0);
  await group.locator(':scope > summary').click();
  assert.equal(await group.locator('.tool-group-body > details.tool').first().isVisible(), true);

  await page.fill('#prompt', 'Run a tool that hangs');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.transcript:not([hidden]) details.tool.pending');
  await page.click('#stop');
  await page.waitForSelector('.transcript:not([hidden]) details.tool.unfinished:has-text("Stopped")');
  assert.equal(await page.locator('.transcript:not([hidden]) details.tool.pending').count(), 0, 'nothing still blinking');
  assert.deepEqual(page.errors, []);
});

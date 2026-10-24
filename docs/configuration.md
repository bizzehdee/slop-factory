# Project settings: `.slop-factory.json`

Slop Factory works without any setup. It reads the task-tracking files the
[agent framework](https://github.com/bizzehdee/agent-framework) uses and sends the agent
well-tested instructions when you click **Start now**, **Start in subagent** and the other board
actions. A `.slop-factory.json` file lets a project change both of those things:

- **which files the board reads**: where your tasks, specs and other documents live, and what to
  skip;
- **what the board asks the agent to do**: the text of every message a board action sends.

Everything in the file is optional. Leave out a setting and the built-in behaviour is used.

- [Where the file goes](#where-the-file-goes)
- [A complete example](#a-complete-example)
- [Settings at a glance](#settings-at-a-glance)
- [`taskGlobs`: where your tasks are](#taskglobs-where-your-tasks-are)
- [`docGlobs`: specs, summaries and other documents](#docglobs-specs-summaries-and-other-documents)
- [`ignore`: folders to skip](#ignore-folders-to-skip)
- [`prompts`: what the board asks the agent](#prompts-what-the-board-asks-the-agent)
- [Recipes](#recipes)
- [Workstreams file format](#workstreams-file-format)
- [The `.slop-factory` folder](#the-slop-factory-folder)
- [Troubleshooting](#troubleshooting)

## Where the file goes

Put `.slop-factory.json` in the project's top folder, next to `task.md`:

```text
my-project/
├── .slop-factory.json
├── task.md
├── plan.md
├── tasks/
├── specs/
└── summaries/
```

- The file is read when the project opens. After editing it, close the project (project menu ▸
  **Close project**) and open it again.
- It is plain JSON: double quotes around every key and string, no comments, and no comma after
  the last item.
- Commit it, so everyone who opens the project gets the same board and the same instructions.
- Projects set up with Slop Factory's earlier name, Claude Desk, may have a `.claude-desk.json`
  instead. It is still read when there is no `.slop-factory.json`. Rename it whenever you like.

## A complete example

Every setting, with its built-in value. You only need the lines you want to change.

```json
{
  "taskGlobs": ["task.md", "tasks/*.md"],
  "docGlobs": ["specs/*.md", "summaries/*.md"],
  "ignore": ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/target/**"],
  "prompts": {
    "whereNow": "Do it here in this conversation.",
    "summarise": "Summarise the work done on {ref} ({title}) from {file}. Use {docs} if they exist, plus the git history and the code. Keep it short, and do not edit any files."
  }
}
```

## Settings at a glance

| Setting | Type | Built-in value | What it changes |
|---|---|---|---|
| `taskGlobs` | list of file patterns | `["task.md", "tasks/*.md"]` | Which files fill the **Delivery** board. |
| `docGlobs` | list of file patterns | `["specs/*.md", "summaries/*.md"]` | Which documents the board links to and the panel can show. |
| `ignore` | list of file patterns | `node_modules`, `.git`, `dist`, `build`, `target` | Folders never looked in. |
| `prompts` | object of named texts | the built-in instructions | What each board action asks the agent to do. |

File patterns are matched against paths relative to the project folder, written with forward
slashes on every system (`tasks/task_phase_1.md`, never `tasks\task_phase_1.md`). Upper and lower
case are treated the same. The usual wildcards work:

| Pattern | Matches |
|---|---|
| `*` | any characters within one folder name: `tasks/*.md` matches `tasks/bugs.md`, not `tasks/old/a.md` |
| `**` | any number of folders: `docs/**/*.md` matches `docs/a.md` and `docs/adr/0001.md` |
| `{a,b}` | either: `{task,TODO}.md` matches `task.md` and `TODO.md` |
| `?` | one character |

Files and folders whose names start with a dot are only matched by patterns that spell the dot
out (`.notes/*.md`).

## `taskGlobs`: where your tasks are

The files that fill the **Delivery** board. Slop Factory decides what each file is from its name:

| File | Shown as |
|---|---|
| `task.md` (or `TASK.md`) at the top of the project, with a phase table | the list of phases, in delivery order |
| `TASK.md` at the top of the project with no phase table | the older one-file format: each `## Section` is a phase, `TASK-001` entries are its tasks |
| `task_phase_<n>.md`, in any folder | phase *n*'s document: its checkbox tasks, their links, dependencies and blockers |
| `bugs.md`, in any folder | the bug list (`### B1: title` entries with a `- Status:` line) |
| `workstream.md` or `workstreams.md`, in any folder | streams of tasks agents can run at the same time ([format](#workstreams-file-format)) |
| any other matching file | a plain checklist of its `- [ ]` items, under the file's title |

An empty list, or one with nothing usable in it, falls back to the built-in patterns.

**Tasks kept in another folder:**

```json
{
  "taskGlobs": ["planning/task.md", "planning/tasks/*.md"]
}
```

`planning/task.md` isn't at the top of the project, so it shows as a plain checklist. To keep the
phase table, leave `task.md` at the top and move only the phase documents:

```json
{
  "taskGlobs": ["task.md", "planning/tasks/*.md"]
}
```

**A monorepo where each package keeps its own phase documents:**

```json
{
  "taskGlobs": ["task.md", "tasks/*.md", "packages/*/tasks/*.md"]
}
```

**A plain to-do file as well:**

```json
{
  "taskGlobs": ["task.md", "tasks/*.md", "TODO.md"]
}
```

## `docGlobs`: specs, summaries and other documents

The documents Slop Factory keeps track of, so the board can show **Spec** and **Summary** links
on tasks and bugs, and the panel can open them.

- `plan.md` at the top of the project is always tracked, whatever this says: clicking the project
  name shows it.
- Open questions are always gathered from `plan.md`, every `.md` file directly in `docs/`, and the
  phase documents, whatever this says.
- `[]` tracks nothing beyond `plan.md`.

Spec and summary links come from two places: the links written on a task or bug
(`[Spec](../specs/spec-TASK-5.md)`), and files named the way the agent framework names them
(`specs/spec-TASK-5.md`, `summaries/summary-BUG-2.md`) when those files are tracked here.

**Specs and summaries kept somewhere else:**

```json
{
  "docGlobs": ["design/specs/*.md", "design/summaries/*.md"]
}
```

Files named the framework's way are only found without a link in the top-level `specs/` and
`summaries/` folders. Elsewhere, the board finds each one through the link written on its task or
bug, such as `[Spec](../design/specs/spec-TASK-5.md)`.

**Architecture decision records too:**

```json
{
  "docGlobs": ["specs/*.md", "summaries/*.md", "docs/adr/*.md"]
}
```

## `ignore`: folders to skip

Folders Slop Factory never looks in, even when a pattern above would match something inside them.
Large generated folders are worth listing: skipping them keeps the board quick in big projects.

Your list **replaces** the built-in one rather than adding to it, so repeat the built-in entries
you still want:

```json
{
  "ignore": ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/target/**", "**/vendor/**", "archive/**"]
}
```

## `prompts`: what the board asks the agent

Every board action sends the agent a message built from a prompt. Each prompt has a name; give one
a new text under `prompts` and that action sends your text instead. Prompts you leave out keep
their built-in text, so you can change one without copying the rest.

### Which prompt each action uses

| You choose | On | Prompt | Then |
|---|---|---|---|
| **Start now** or **Start in subagent** | a task | `startTask` | `{where}` becomes `whereNow` or `whereSubagent` |
| **Start now** or **Start in subagent** | a bug | `startBug` | as above |
| **Start now** or **Start in subagent** | a phase | `startPhase` | as above |
| **Start now** or **Start in subagent** | a task in an older `TASK.md` | `startLegacyTask` | as above |
| **Start now** or **Start in subagent** | a section of an older `TASK.md` | `startLegacySection` | as above |
| **Reinvestigate** | a finished task, bug or phase | `reinvestigate` | |
| **Summarise work done** | a finished task, bug or phase | `summarise` | |
| **Run workstreams** | the streams you pick | `runWorkstreams` | |
| **Find workstreams** | the board | `findWorkstreams` | |
| **Commit** | the uncommitted changes, from the git line under the project's name | `commitChanges` | |

Items in **Up next** use the same prompts when their turn comes: **Start now** for the main
queue, **Start in subagent** for items queued to run in a subagent.

### Placeholders

Write a placeholder in braces and it is replaced with details of the item when the message is
sent. A placeholder a prompt doesn't support is sent as written.

| Placeholder | Becomes | Example |
|---|---|---|
| `{ref}` | the item's id; `phase <n>` for a phase; `the "<name>" section` for an older section; `the task "<title>"` for a task with no id | `T5`, `B2`, `phase 2` |
| `{title}` | the item's title | `Schedule exports from the admin screen` |
| `{file}` | the file the item is in (a phase's own document, for a phase) | `tasks/task_phase_2.md` |
| `{specPath}` | where its spec is, or will go | `specs/spec-TASK-5.md` |
| `{summaryPath}` | where its summary is, or will go | `summaries/summary-TASK-5.md` |
| `{docs}` | the documents that record the work, in words | `specs/spec-TASK-5.md and summaries/summary-TASK-5.md` |
| `{where}` | the text of `whereNow` or `whereSubagent` | `Do it here in this conversation.` |

`{specPath}` and `{summaryPath}` use the link written on the item when there is one, else the
agent framework's name for it. For a task or bug without a `T<n>` or `B<n>` id they become
`its spec` and `its summary`.

Which prompts can use which placeholders:

| Prompt | Placeholders |
|---|---|
| `startTask`, `startBug`, `startPhase`, `startLegacyTask`, `startLegacySection` | `{ref}` `{title}` `{file}` `{specPath}` `{summaryPath}` `{docs}` `{where}` |
| `reinvestigate`, `summarise` | `{ref}` `{title}` `{file}` `{specPath}` `{summaryPath}` `{docs}` |
| `whereNow`, `whereSubagent` | the start prompt's, apart from `{where}`: their text takes the place of `{where}` before the rest are filled in |
| `runWorkstreams` | `{streams}` (one line per stream: its id, name, tasks in order with their titles, and what it touches), `{file}` |
| `findWorkstreams` | none |
| `commitChanges` | none |

A start prompt without `{where}` still says where the work runs: the `whereNow` or
`whereSubagent` text is added at the end. Put `{where}` in yourself to choose where it goes.

### Built-in prompts

These are the texts used when you don't replace them. Copy one as a starting point for your own.

<details>
<summary><code>startTask</code></summary>

```text
Start work on {ref} ({title}) from {file}.

{where} Follow AGENTS.md and the task-tracking standard: investigate first, write {specPath} before any other change, and write {summaryPath} when the work ends.
```

</details>

<details>
<summary><code>startBug</code></summary>

```text
Start fixing {ref} ({title}) from {file}.

{where} Follow AGENTS.md and the task-tracking standard: diagnose by elimination, write {specPath} before changing code, fix it with a regression test, and write {summaryPath} when the work ends.
```

</details>

<details>
<summary><code>startPhase</code></summary>

```text
Work through {ref} ({title}), {file}.

{where} Follow AGENTS.md and the task-tracking standard: take its open tasks in order, respecting their dependencies, and give each one its spec before changing code and its summary when it is done.
```

</details>

<details>
<summary><code>startLegacyTask</code></summary>

```text
Start work on {ref} ({title}) from {file}.

{where} Follow AGENTS.md and the task's own entry in {file}: read its References first, then build exactly its Deliverable within its Scope until every Acceptance criterion is met. Mark it [~] while you work and [x] only when it is done and its tests pass.
```

</details>

<details>
<summary><code>startLegacySection</code></summary>

```text
Work through the "{title}" section of {file}.

{where} Follow AGENTS.md and each task's own entry: take the section's open tasks in order, respecting Depends on, read their References first, and meet every Acceptance criterion. Mark each [~] while you work and [x] only when it is done and its tests pass.
```

</details>

<details>
<summary><code>whereNow</code></summary>

```text
Do it here in this conversation.
```

</details>

<details>
<summary><code>whereSubagent</code></summary>

```text
Run it in a background subagent with worktree isolation (the Agent tool with isolation: "worktree"), so it works on its own copy of the repository in parallel with anything else going on here. Have it commit its work on its branch and leave the worktree in place, so I can review and merge it from Slop Factory. When it finishes, tell me its branch and what changed.
```

</details>

<details>
<summary><code>reinvestigate</code></summary>

```text
Re-investigate {ref} ({title}) from {file}.

Run it in a background subagent. Read {docs}, check the code still does what that work delivered, and run the tests that cover it. Report what you find without changing code. If something is wrong, propose a new task or bug the way the task-tracking standard says.
```

</details>

<details>
<summary><code>summarise</code></summary>

```text
Summarise the work done on {ref} ({title}) from {file}. Use {docs} if they exist, plus the git history and the code. Keep it short, and do not edit any files.
```

</details>

<details>
<summary><code>commitChanges</code></summary>

```text
Commit the uncommitted changes in this repository. Read the diff first, then group related changes into logical commits with clear messages, following AGENTS.md and the conventions in the project's git history. Leave out anything that shouldn't be committed, such as secrets, build output or files that belong in .gitignore, and tell me about them. Don't push.
```

</details>

<details>
<summary><code>runWorkstreams</code></summary>

```text
Run these workstreams from {file} at the same time. Start them all now, each in its own background subagent with worktree isolation (the Agent tool with isolation: "worktree"), so each works on its own copy of the repository in parallel with the others. Describe each subagent as "Workstream <id>: <name>".

{streams}

Tell each subagent to work through its tasks in the order listed, following AGENTS.md and the task-tracking standard: a spec before changing code, tests, a summary when each task ends, and the task ticked in its phase document, committing each task on its branch. It stays within the code its workstream touches and stops to report rather than change what another workstream owns. Have each leave its worktree in place, so I can review and merge it from Slop Factory. When they finish, tell me each branch and what changed.
```

Keep the line asking for each subagent to be described as `Workstream <id>: <name>`: that is how
the board tells which stream is running.

</details>

<details>
<summary><code>findWorkstreams</code></summary>

````text
Find the work in this project that separate agents could do at the same time, and write it down as workstreams in tasks/workstream.md.

Look through task.md, the phase documents in tasks/ and tasks/bugs.md for open tasks and bugs. Read their specs and the code as far as you need to tell what each will change. Group them into workstreams: each is a sequence of tasks that build on each other or change the same code, and shares no files with the other streams, so their branches merge cleanly. Respect every dependency and the phase order. A stream that can only start once another is merged says so in Waits on. Leave out work that can't run alongside anything else.

Use exactly this format, numbering streams W1 upwards:

```markdown
# Workstreams

Work that can run at the same time, each stream in its own git worktree.

## W1: <what the stream delivers>
- Tasks: T12, T13, B4
- Touches: <directories or modules it changes>
- Waits on: none

## W2: <name>
- Tasks: T14, T15
- Touches: <...>
- Waits on: W1

## Not in a stream

- T16: <why it has to run on its own>

## Revision history

| Date | Change |
|---|---|
| <YYYY-MM-DD> | First version. |
```

List each stream's tasks in the order to do them. Then show me the streams, and don't start any of them.
````

</details>

### Writing prompts in JSON

A prompt is a JSON string, so:

- start a new line with `\n` (`\n\n` for a blank line);
- write a double quote inside the text as `\"`;
- write a backslash as `\\`.

```json
{
  "prompts": {
    "summarise": "Summarise {ref} (\"{title}\") in three bullet points.\n\nDon't change any files."
  }
}
```

## Recipes

### Open a pull request from each subagent

```json
{
  "prompts": {
    "whereSubagent": "Run it in a background subagent with worktree isolation (the Agent tool with isolation: \"worktree\"). Have it commit its work on a branch named after {ref}, push the branch, and open a draft pull request describing what changed. When it finishes, tell me the pull request's link."
  }
}
```

`whereNow` and `whereSubagent` can use the start prompt's placeholders (`{ref}` here): they are
put in place of `{where}` before the placeholders are filled in.

### Skip specs and summaries

For a quick prototype where the framework's paperwork isn't wanted:

```json
{
  "prompts": {
    "startTask": "Build {ref}: {title} (from {file}).\n\n{where} Don't write a spec or a summary. Add tests for what you build, run them, and tick the task in {file} when they pass.",
    "startBug": "Fix {ref}: {title} (from {file}).\n\n{where} Don't write a spec or a summary. Write a test that fails because of the bug, fix it, and set the bug's status to fixed.",
    "startPhase": "Work through {ref} ({title}) in {file}, one task at a time in order.\n\n{where} Don't write specs or summaries. Commit each task when its tests pass."
  }
}
```

### Ask before anything is changed

```json
{
  "prompts": {
    "startTask": "Look into {ref} ({title}) from {file} and write {specPath}.\n\n{where} Then stop and show me the plan in the spec. Don't change any other file until I say go."
  }
}
```

### Run the project's own checks first

```json
{
  "prompts": {
    "whereNow": "Do it here in this conversation. Before you start, run `npm test` and tell me if anything already fails.",
    "summarise": "Summarise the work done on {ref} ({title}) for the release notes: one sentence for users, then a short list of what changed for developers. Use {docs} and the git history. Don't edit any files."
  }
}
```

### A team writing in another language

```json
{
  "prompts": {
    "startTask": "Commence le travail sur {ref} ({title}) dans {file}.\n\n{where} Suis AGENTS.md : écris {specPath} avant toute modification, puis {summaryPath} à la fin.",
    "whereNow": "Fais-le ici, dans cette conversation.",
    "whereSubagent": "Fais-le dans un sous-agent en arrière-plan, isolé dans son propre worktree git (l'outil Agent avec isolation: \"worktree\"). Qu'il valide son travail sur sa branche et laisse le worktree en place pour que je puisse le relire."
  }
}
```

### Tasks in a monorepo, with generated folders skipped

```json
{
  "taskGlobs": ["task.md", "tasks/*.md", "apps/*/tasks/*.md", "packages/*/tasks/*.md"],
  "docGlobs": ["specs/*.md", "summaries/*.md", "apps/*/specs/*.md", "packages/*/specs/*.md"],
  "ignore": ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/target/**", "**/.next/**", "**/coverage/**"]
}
```

## Workstreams file format

`tasks/workstream.md` (or anywhere `taskGlobs` matches a `workstream.md` or `workstreams.md`)
lists streams of tasks that separate agents can work through at the same time, each in its own
git worktree. **Find workstreams** on the board asks the agent to write it; you can also write or
edit it yourself.

```markdown
# Workstreams

## W1: Export API
- Tasks: T12, T13, B4
- Touches: server/export/, db/migrations/
- Waits on: none

## W2: Export screen
- Tasks: T14, T15
- Touches: web/src/export/
- Waits on: W1

## Not in a stream

- T16: changes the shared config loader, so it runs on its own.
```

- Each stream is a `## W<n>: <name>` heading. Other headings (`## Not in a stream`,
  `## Revision history`) are notes and are left alone.
- `- Tasks:` lists task and bug ids in the order to do them. Without a Tasks line, the ids in the
  list under the heading are used.
- `- Touches:` says which parts of the code the stream owns. It goes to the agent working on it.
- `- Waits on:` names streams that must finish first. A waiting stream isn't picked to run by
  default, but you can still pick it.

The board shows each stream's progress from its tasks' checkboxes, and whether it is ready,
waiting, running or done.

## The `.slop-factory` folder

Slop Factory also keeps a `.slop-factory` folder in the project:

| File | Holds |
|---|---|
| `.slop-factory/priorities.json` | the **Up next** queue: its order, and which items run in a subagent |

Commit it to share the queue with everyone working on the project, or add `.slop-factory/` to
`.gitignore` to keep each person's queue their own. Older projects may have a `.claude-desk`
folder instead; it is still read.

Settings that belong to you rather than to a project (sign-in, local models, theme, notifications,
MCP servers you add for yourself, and usage figures) are kept in your home folder, in
`~/.slop-factory`, and changed from **Settings**.

## Troubleshooting

**My change didn't do anything.** The file is read when the project opens: close the project and
open it again.

**The project says the file is being ignored.** It isn't valid JSON, or isn't an object. The
message names the problem. Common causes are a comma after the last item, single quotes instead
of double quotes, a line break inside a string (use `\n`), and comments. Until it's fixed, the
built-in settings are used.

**The board is empty.** Check `taskGlobs` against your paths: they're relative to the project
folder and use forward slashes. A pattern inside an `ignore`d folder never matches.

**A prompt still sends the old text.** Check its name against the [table above](#which-prompt-each-action-uses):
names are case-sensitive, and a prompt that isn't text (a number, a list) is skipped.

**A placeholder arrives as written.** That prompt doesn't support it; see
[which prompts can use which placeholders](#placeholders).

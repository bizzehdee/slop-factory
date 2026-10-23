# Claude Desk

A desktop app for working with Claude Code across several projects that use
[agent-framework](https://github.com/bizzehdee/agent-framework). It looks and feels like the
Claude desktop apps, and runs Claude Code underneath, so your `AGENTS.md`, skills, settings and
hooks load exactly as they do in the CLI.

## What it does

- **Several projects at once.** Each open project has its own Claude Code session, running in
  parallel. Switch from the sidebar or with Ctrl/Cmd+1–9; work in the others keeps going. The
  sidebar shows which projects are working, have something running in the background, or need you
  to answer a permission prompt.
- **A live delivery board** built from `task.md` (the phase table), `tasks/task_phase_<n>.md`
  (each phase's `T<n>` tasks) and `tasks/bugs.md`. It updates the moment a file changes on disk,
  whether Claude or you changed it, and you can tick tasks from the board.
- **A ⋯ menu on every task, bug and phase** (older TASK.md sections count as phases):
  - Prioritise (start after current work). Queued items wait under **Up next** and start one at a
    time, in order, each time Claude finishes a turn. If Claude is free and nothing is queued ahead,
    it starts straight away. Pressing Stop pauses the queue until you start something; **Start next**
    picks it back up. An item leaves the queue once it starts.
  - Start now. Sends Claude the work in this project's own conversation.
  - Start in subagent (own worktree). Claude runs the work in a background subagent with
    `isolation: "worktree"`, so it gets its own git worktree and branch and works in parallel with
    the conversation. Its task-file edits land in that worktree until you merge it. Claude Code's
    `worktree.baseRef` setting decides whether the branch starts from `origin`'s default branch
    (the default) or your local `HEAD`.
  - Show progress (a task's spec and summary) or Show phase document.
  - Summarise work done and reinvestigate with a subagent (finished items).
- **Questions.** The right bar lists every open question: the items under **Open questions** in
  `plan.md`, `docs/*.md` and the phase documents (as the project-planning and task-tracking
  standards keep them), plus the questions in Claude's latest reply. Click one to open it beside the
  conversation and type an answer, or tick several and choose **Ask as choices**: Claude then asks
  them with its multiple-choice `AskUserQuestion` tool, two to four options each, with every option
  it recommends marked. Those choice questions open by themselves when Claude asks, and answering a
  question moves on to the next. Answers to documented questions ask Claude to record the decision
  and take the question off its list. Items marked "(left open by the user, date)" show as left open.
- **Project summary.** Click the project's name above the board to read its `plan.md`, rendered.
  The ⋯ beside the name opens the project folder in your file manager (Finder, Explorer, or
  `xdg-open` on Linux), shows the plan, copies the path or closes the project.
- **Permission modes per project:** Ask before acting, Accept file edits, Auto mode, Plan only or
  Skip all permission checks, chosen in the message box. Auto mode lets Claude Code's safety
  classifier approve routine actions and ask only about risky ones. Skip all permission checks is
  `bypassPermissions` (the CLI's `--dangerously-skip-permissions`): nothing is checked at all. Each project reopens in the mode you last chose for
  it, and newly opened projects start in your most recent choice. Auto mode needs the Claude
  subscription (its checks run on Anthropic's servers), so it's unavailable for projects on a local
  model; if Claude Code refuses it, the app says so and shows the mode actually in effect.
- **Running processes:** background shells, monitors and subagents, with elapsed time, the command
  and a Stop button.
- **Local models.** Any project can use Ollama or llama.cpp instead of your Claude subscription.
  Claude Code still does the agentic work (tools, edits, shells, subagents, your rules); only the
  model calls go to your server.

## Older TASK.md format

Projects that still use a single `TASK.md` work too. When `TASK.md` has no phase table but does
have checkbox tasks, the board reads it in the older layout:

- Each `## Section` with tasks becomes a step on the spine. Sections without tasks (such as "How to
  use this file") are skipped. The board opens on the first section already in progress.
- Tasks are `- [ ] TASK-001: Title`, with subtasks such as `TASK-050.1` nested under their parent.
  `[~]` shows as in progress. Section progress counts top-level tasks only.
- An open task shows **waits on TASK-094** while anything in its **Depends on** field is unfinished,
  and each **Blocked by** reason as written. Both are links: an id goes to that task or bug on the
  board, a reason that matches an open question opens the question, and any other reason opens the
  task's own entry where it is written. The same applies to the current format's tasks.
- **Show details** opens the task's own entry (Deliverable, Scope, Acceptance criteria and so on) as
  formatted markdown, since this format has no separate spec files.
- **Start now** and **Start in subagent** tell Claude to work from that entry: read its References, then build its
  Deliverable within its Scope until every acceptance criterion is met. Override it with
  `prompts.startLegacyTask` in `.claude-desk.json`.

## Specs, summaries and priorities

The progress view follows the task-tracking standard: it uses the `[Spec]` / `[Summary]` links on
a task line or the `Spec:` / `Summary:` lines on a bug entry, and falls back to
`specs/spec-TASK-<n>.md`, `specs/spec-BUG-<n>.md`, `summaries/summary-TASK-<n>.md` and
`summaries/summary-BUG-<n>.md`. Finished work opens on its summary; anything else on its spec.

Priorities aren't part of the standard, and editing task lines would count as a revision under it,
so they live in `.claude-desk/priorities.json` in the project, keyed by `T<n>` / `B<n>`. Commit it
to share the queue, or add it to `.gitignore`.

## Local models (Ollama, llama.cpp)

Pick **Use a local model…** from the model menu in the message box. The dialog fills in the usual
address for each server, finds the models it has loaded, and switches the current project to it.

| Server | Default address | Notes |
|---|---|---|
| Ollama | `http://localhost:11434` | Token `ollama` (ignored). Run `ollama pull qwen3-coder` first. |
| llama.cpp | `http://127.0.0.1:8080` | Start `llama-server` with a model that supports tool calls. |
| Other | any | Must speak Anthropic's Messages API (`/v1/messages`). |

Both Ollama and llama-server speak Anthropic's Messages API natively, so no proxy is needed. A
server that only offers OpenAI's chat-completions API needs a translating proxy such as LiteLLM in
front of it.

Under the hood the session sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` and
the default Opus/Sonnet/Haiku, subagent and small/fast model variables to your choice, and removes
any Claude login or API key from that session's environment so nothing reaches Anthropic. Local
models need tool calling and a long context (32k tokens or more) to do agentic work well.
Switching provider restarts that project's Claude Code session and starts a new conversation.

Providers are saved in `~/.claude-desk/config.json`, along with which project uses which and each
project's permission mode.

## How it works

```
┌──────────────────── Tauri window (src/) ─────────────────────┐
│ projects + board │ conversation + progress │ running, session │
└─────────────┬────────────────────────────────────────────────┘
              │ invoke / events (one JSON message per line)
┌─────────────┴──────────────── src-tauri/ ────────────────────┐
│ Rust shell: starts the sidecar once, relays messages          │
└─────────────┬────────────────────────────────────────────────┘
              │ stdin / stdout
┌─────────────┴──────────────── sidecar/ ──────────────────────┐
│ Node: per project, a Claude Agent SDK session + task watcher  │
└──────────────────────────────────────────────────────────────┘
```

- `sidecar/src/index.ts` keeps every open project's session, task watcher and a transcript
  buffer. Reloading the window replays it, so nothing is lost.
- `sidecar/src/agent.ts` is one long-lived Claude Code session. It uses
  `settingSources: ['user', 'project', 'local']` so your framework loads, streams replies,
  forwards permission prompts, and tracks background tasks from the SDK's task events.
- `sidecar/src/tasks.ts` watches task, spec and summary files and parses them per the standard.
- `sidecar/src/actions.ts` holds the board button prompts and the priority queue.
- `sidecar/src/providers.ts` stores model providers and builds each session's environment.
- `sidecar/src/protocol.ts` is the full message contract between the UI and the sidecar.

## Requirements

- Node 18 or newer, on your `PATH`.
- Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. On Linux:

  ```bash
  # Fedora
  sudo dnf install dbus-devel pkgconf-pkg-config webkit2gtk4.1-devel openssl-devel curl wget file \
    libappindicator-gtk3-devel librsvg2-devel libxdo-devel
  sudo dnf group install "c-development"

  # Ubuntu / Debian
  sudo apt install libdbus-1-dev pkg-config libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  A build that stops with "The system library `dbus-1` … was not found" is missing `dbus-devel`
  (Fedora) or `libdbus-1-dev` (Ubuntu).
- For your Claude subscription: Claude Code logged in. Run `claude` once and sign in, or create a
  token with `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN`.

## Run it

```bash
npm install
npm run sidecar:install
npm run tauri dev
```

To work on the interface in a normal browser without rebuilding Rust:

```bash
npm run dev:browser
# then open http://127.0.0.1:1420/?project=/absolute/path/to/your/project
```

Tests (task parsing in both formats, file watching, priorities, prompts, providers, process tracking):

```bash
npm test
```

## Billing

On your subscription, the sidecar removes `ANTHROPIC_API_KEY` from its environment before
starting Claude Code, so a stray key can't quietly switch you to API billing. Set
`CLAUDE_DESK_ALLOW_API_KEY=1` if you do want to use a key. The Session panel shows which login
Claude Code actually used and warns you if it isn't your subscription.

Anthropic's rules for subscription use in your own tools changed several times in 2026. A personal
app on your own machine using your own login is the supported case; check the
[Agent SDK help article](https://support.claude.com/en/articles/15036540) for the current position.

## Settings

A `.claude-desk.json` in a project can change which files are read and the prompts the board
buttons send:

```json
{
  "taskGlobs": ["task.md", "tasks/*.md"],
  "docGlobs": ["specs/*.md", "summaries/*.md"],
  "ignore": ["**/node_modules/**", "**/.git/**"],
  "prompts": {
    "startTask": "Start work on {ref} ({title}) from {file}.\n\n{where} ...",
    "startBug": "...",
    "startPhase": "...",
    "whereNow": "Do it here in this conversation.",
    "whereSubagent": "Run it in a background subagent with worktree isolation...",
    "reinvestigate": "...",
    "summarise": "..."
  }
}
```

Prompt placeholders: `{ref}` `{title}` `{file}` `{specPath}` `{summaryPath}` `{docs}` `{where}`.
`{where}` is `whereNow` for Start now and `whereSubagent` for Start in subagent; a start prompt
without it (one written before it existed) gets it added at the end. The start prompts are
`startTask`, `startBug`, `startLegacyTask`, `startPhase` and `startLegacySection`. The defaults are
in `sidecar/src/actions.ts`.

Task checkboxes understand `[ ]` to do, `[x]` done, `[/]` or `[~]` in progress and `[-]` dropped.

Environment variables:

| Variable | Effect |
|---|---|
| `CLAUDE_DESK_NODE` | Full path to `node`. Useful on macOS, where apps don't inherit your shell `PATH`. |
| `CLAUDE_DESK_SIDECAR` | Path to a different sidecar `index.js`. |
| `CLAUDE_DESK_CONFIG_DIR` | Where providers are saved instead of `~/.claude-desk`. |
| `CLAUDE_DESK_ALLOW_API_KEY` | `1` keeps `ANTHROPIC_API_KEY` instead of removing it. |
| `CLAUDE_DESK_CLAUDE` | Path to the `claude` binary used to check and make the sign-in, instead of the one bundled with the SDK. |

## Known gaps

- "View session" for a subagent's own transcript isn't there yet; its steps show folded under the
  Task call that started it.
- Release builds bundle the sidecar's JavaScript but not Node itself, so Node must be installed.
- Conversations live as long as the app runs; quitting the app ends them.

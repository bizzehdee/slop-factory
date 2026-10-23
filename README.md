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
- **A ⋯ menu on every task and bug:**
  - Prioritise / remove priority. Prioritised items form a queue at the top of the board.
  - Start with a subagent (open items) or reinvestigate with a subagent (finished items). These
    send Claude a prompt that runs the work in a background subagent, following your
    task-tracking standard.
  - Show progress. Opens the item's spec and summary as formatted markdown.
  - Summarise work done (finished items).
- **Running processes:** background shells, monitors and subagents, with elapsed time, the command
  and a Stop button.
- **Local models.** Any project can use Ollama or llama.cpp instead of your Claude subscription.
  Claude Code still does the agentic work (tools, edits, shells, subagents, your rules); only the
  model calls go to your server.

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

Providers are saved in `~/.claude-desk/config.json`, along with which project uses which.

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
- Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS
  (on Linux that includes WebKitGTK 4.1).
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

Tests (task parsing, file watching, priorities, prompts, providers, process tracking):

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
    "startTask": "Start work on {ref} ({title}) from {file}. Run it in a background subagent...",
    "startBug": "...",
    "reinvestigate": "...",
    "summarise": "..."
  }
}
```

Prompt placeholders: `{ref}` `{title}` `{file}` `{specPath}` `{summaryPath}` `{docs}`. The
defaults are in `sidecar/src/actions.ts`.

Task checkboxes understand `[ ]` to do, `[x]` done, `[/]` or `[~]` in progress and `[-]` dropped.

Environment variables:

| Variable | Effect |
|---|---|
| `CLAUDE_DESK_NODE` | Full path to `node`. Useful on macOS, where apps don't inherit your shell `PATH`. |
| `CLAUDE_DESK_SIDECAR` | Path to a different sidecar `index.js`. |
| `CLAUDE_DESK_CONFIG_DIR` | Where providers are saved instead of `~/.claude-desk`. |
| `CLAUDE_DESK_ALLOW_API_KEY` | `1` keeps `ANTHROPIC_API_KEY` instead of removing it. |

## Known gaps

- Claude's multiple-choice questions (the `AskUserQuestion` tool) aren't rendered yet, so the tool
  is turned off and Claude asks in plain text instead.
- "View session" for a subagent's own transcript isn't there yet; its steps show folded under the
  Task call that started it.
- Release builds bundle the sidecar's JavaScript but not Node itself, so Node must be installed.
- Conversations live as long as the app runs; quitting the app ends them.

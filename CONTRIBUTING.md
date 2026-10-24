# Contributing to Slop Factory

This file is for working on Slop Factory itself. To use it, see the [README](README.md).

## How it fits together

```
┌──────────────────── Tauri window (src/) ─────────────────────┐
│ projects + board │ conversation + panels │ questions, running │
└─────────────┬────────────────────────────────────────────────┘
              │ invoke / events (one JSON message per line)
┌─────────────┴──────────────── src-tauri/ ────────────────────┐
│ Rust shell: starts the sidecar once, relays messages          │
└─────────────┬────────────────────────────────────────────────┘
              │ stdin / stdout
┌─────────────┴──────────────── sidecar/ ──────────────────────┐
│ Node: per project, an Agent SDK session + a file watcher      │
└──────────────────────────────────────────────────────────────┘
```

- `sidecar/src/index.ts` keeps every open project's session, watcher and a transcript buffer.
  Reloading the window replays it, so nothing is lost.
- `sidecar/src/agent.ts` is one long-lived agent session per project. It uses
  `settingSources: ['user', 'project', 'local']` so the project's rules load, streams replies,
  forwards permission prompts and `AskUserQuestion` calls, and tracks background tasks.
- `sidecar/src/tasks.ts` watches task, spec, summary and plan files and parses them.
  `sidecar/src/questions.ts` reads their **Open questions** sections.
- `sidecar/src/actions.ts` holds the board's prompts and the two-lane priority queue.
- `sidecar/src/providers.ts` stores model providers and builds each session's environment.
- `sidecar/src/auth.ts` checks and makes the sign-in with the SDK's bundled engine;
  `sidecar/src/mcp.ts` lists and changes MCP servers through it.
- `sidecar/src/newproject.ts` creates projects and installs agent-framework;
  `sidecar/src/editors.ts` finds editors for **Open with**.
- `sidecar/src/history.ts` rebuilds a resumed conversation's transcript from the SDK's stored
  messages; `sidecar/src/attachments.ts` turns attached files into message blocks.
- `sidecar/src/worktrees.ts` lists, diffs, merges and discards subagent worktrees;
  `sidecar/src/capture.ts` adds tasks, bugs and open questions to the project's files;
  `sidecar/src/usage.ts` keeps each project's usage tally.
- `sidecar/src/fake-agent.ts` is the scripted agent the interface tests run against.
- `sidecar/src/names.ts` holds the app's name, version, storage locations and the project's
  `.slop-factory.json` (documented for users in [docs/configuration.md](docs/configuration.md)).
- `sidecar/src/protocol.ts` is the whole message contract between the window and the sidecar.
- `src/main.ts` starts the interface in `src/ui/`, written without a framework: `app.ts` wires it
  up, `events.ts` handles the sidecar's events, and each area has its own module (board, queue,
  questions, docs, menus, settings, worktrees, subagents, changes, composer, palette, usage,
  workstreams and so on). `src/styles.css` holds the styles.

## Requirements

- Node 24 (`.node-version`). The installers carry their own Node 24, fetched by
  `scripts/fetch-node.mjs`, so people installing the app don't need Node.
- Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. On Linux:

  ```bash
  # Ubuntu / Debian
  sudo apt install libdbus-1-dev pkg-config libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf

  # Fedora
  sudo dnf install dbus-devel pkgconf-pkg-config webkit2gtk4.1-devel openssl-devel curl wget file \
    libappindicator-gtk3-devel librsvg2-devel libxdo-devel
  sudo dnf group install "c-development"
  ```

  A build that stops with "The system library `dbus-1` … was not found" is missing `dbus-devel`
  (Fedora) or `libdbus-1-dev` (Ubuntu).

## Run it from source

```bash
npm install
npm run sidecar:install
npm run tauri dev
```

To work on the interface in a normal browser, without the Rust shell:

```bash
npm run dev:browser
# then open http://127.0.0.1:1420/?project=/absolute/path/to/a/project
```

## Tests and checks

```bash
npm test          # sidecar: task parsing, watching, questions, queue, prompts, providers, new projects
npm run test:ui   # the interface in a real browser, against a scripted agent
npm run build     # interface type check and production build
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

CI runs all four on every pull request.

`npm run test:ui` starts the dev bridge and Vite with `SLOP_FACTORY_FAKE_AGENT=1`, which swaps the
agent for `sidecar/src/fake-agent.ts`: a scripted session that replies, asks questions, asks for
permission or runs a subagent depending on words in the message, without calling any model. The
tests are in `tests/ui/`; they need ports 1420 and 1421 free and Playwright's Chromium
(`npx playwright install chromium`).

## Building installers

```bash
scripts/build.sh                  # Linux: deb, rpm, AppImage. macOS: app, dmg
scripts/build.sh --universal      # macOS: one app for Apple silicon and Intel
pwsh scripts/build.ps1            # Windows: NSIS setup and MSI
```

Both take a version (`--version 1.2.3`, `-Version 1.2.3`), stamped into every manifest by
`scripts/set-version.mjs`. The installers land under `src-tauri/target/`.

Both scripts first fetch Node 24 for the target with `scripts/fetch-node.mjs` (the newest 24.x,
checked against Node's SHA-256 sums) into `src-tauri/binaries/`, and build with
`src-tauri/tauri.release.conf.json`, which adds it as an `externalBin`. The app runs that copy;
development builds use the `node` on your `PATH`.

The agent SDK ships its engine as one npm package per platform and npm installs only this
machine's. `scripts/fetch-sdk-binaries.mjs` adds others; the universal Mac build uses it for both
Mac architectures.

## Releases

Push a tag `vX.Y.Z`. The release workflow stamps X.Y.Z as the version, builds Windows amd64,
Linux amd64 and macOS universal, uploads the installers to a draft release, and publishes it once
every platform has finished.

## Environment variables

| Variable | Effect |
|---|---|
| `SLOP_FACTORY_NODE` | Full path to the `node` that runs the sidecar, instead of the one the installer carries. |
| `SLOP_FACTORY_SIDECAR` | Path to a different sidecar `index.js`. |
| `SLOP_FACTORY_CONFIG_DIR` | Where settings are kept instead of `~/.slop-factory`. |
| `SLOP_FACTORY_ALLOW_API_KEY` | `1` keeps `ANTHROPIC_API_KEY` instead of removing it. |
| `SLOP_FACTORY_CLAUDE` | Path to the engine binary used for sign-in and MCP changes, instead of the SDK's own. |

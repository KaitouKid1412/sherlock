# Sherlock

> A local-first, multi-pane research UI for Claude. Splits long conversations into resizable side-by-side panels so older answers don't scroll out of view while you ask follow-ups.

Sherlock installs in two Terminal pastes and runs as a normal macOS app: double-click `Sherlock` in `/Applications` and a browser tab opens to your local server. Updates land silently on the next launch — there are no prompts, no "Restart to apply" banners.

---

## What Sherlock is, and who it's for

Sherlock turns claude.ai's single-thread chat into a multi-column research workspace. Every conversation is still one linear Claude session (no forks, full context preserved on every turn), but you can split the transcript across resizable columns and rows so prior answers stay in view while you ask follow-ups. Sherlock runs entirely on your machine and uses your existing **Claude Pro or Max** subscription via the Claude Code CLI — no separate API key, no extra spend.

Best for people who do long-form research sessions with Claude — learning a new domain, building mental models from extended answers, technical writing.

---

## For users

### Prerequisites

| Requirement | Notes |
|---|---|
| macOS 11 Big Sur or later | Apple Silicon recommended; Intel supported |
| Claude **Pro** or **Max** subscription | Used by the underlying CLI for auth |
| Claude Code CLI installed and signed in | One-time setup; see Step 1 below |
| Node.js 20+ | The Sherlock installer fetches the official `.pkg` for you if missing |

You do **not** need an Anthropic API key, a developer account, Homebrew, or any paid hosting. Sherlock uses your existing claude.ai login through the official CLI.

### Step 1 — install the Claude Code CLI (one-time, ~2 minutes)

The Claude Code CLI is the engine Sherlock wraps. You install it once and forget about it.

1. Open **Terminal** (`Cmd + Space` → "Terminal" → Enter).
2. Paste and run:

   ```sh
   curl -fsSL https://claude.ai/install.sh | bash
   ```

3. Sign in:

   ```sh
   claude login
   ```

   A browser window opens. Sign in with the same email you use on claude.ai.

4. Verify:

   ```sh
   claude /status
   ```

   The `Auth` line should say *subscription* — **not** *API key*. If it says API key, remove `ANTHROPIC_API_KEY` from your shell profile (`.zshrc` / `.bash_profile`) and restart Terminal.

### Step 2 — install Sherlock (one-time, ~1 minute)

Paste this into the same Terminal window:

```sh
curl -fsSL https://raw.githubusercontent.com/KaitouKid1412/sherlock/main/install.sh | bash
```

The installer will:

1. Check that Node.js 20+ is installed (and open the official Node `.pkg` installer GUI for you if it isn't — click through, then re-run the line above).
2. Clone Sherlock into `~/Library/Application Support/Sherlock`.
3. Install dependencies and build the frontend.
4. Place `Sherlock.app` in `/Applications`.

You can close Terminal when it's done.

### Step 3 — launch Sherlock

Open Sherlock the same way you open any Mac app:

- Double-click **Sherlock** in `/Applications`, **or**
- `Cmd + Space` → type "sherlock" → Enter, **or**
- Drag it onto your Dock once and click from there.

A browser tab opens at `http://127.0.0.1:7777` with Sherlock ready to use.

### Updates — completely automatic

You never click "update". Every time you launch Sherlock, it quietly fetches the latest code from the `release` branch in the background. The new version applies on your **next** launch. No banners, no restarts, no `.dmg` downloads.

### Quitting Sherlock

Sherlock's server runs in the background while any browser tab is open. To fully stop it, close all Sherlock tabs — the server self-shuts-down ~30 seconds later. Re-launching from the app icon starts it again instantly.

### Troubleshooting

| Symptom | Fix |
|---|---|
| First launch shows nothing | Check `~/Library/Application Support/Sherlock/launcher.log` and `server.log` |
| `claude not found` errors in panes | Quit (close all tabs, wait 30s), then re-launch — Sherlock re-reads `PATH` on startup |
| `Auth: API key` warning | Remove `ANTHROPIC_API_KEY` from your shell profile, restart Terminal, restart Sherlock |
| Blank panes / no response | Run `claude /status` in Terminal — your subscription may be rate-limited or expired |
| Force-reinstall | Re-run the `curl … install.sh` line; it's idempotent |
| Logs | `~/Library/Application Support/Sherlock/{launcher,server,update}.log` |

---

## For developers

### Prerequisites

- **Node.js 20+** — install via [Homebrew](https://formulae.brew.sh/formula/node) (`brew install node@20`) or [nodejs.org](https://nodejs.org)
- **npm 10+** — bundled with Node
- **Claude Code CLI** installed and authenticated (see [Step 1](#step-1--install-the-claude-code-cli-one-time-2-minutes) above)
- macOS — primary dev platform; Linux likely works (untested at time of writing)

### Setup

```sh
git clone https://github.com/KaitouKid1412/sherlock.git
cd sherlock
npm install
npm run dev
```

Then open <http://localhost:5173> in your browser.

In dev mode, Vite serves the frontend on port 5173 with hot-module reload, and proxies `/api/*` requests to the Fastify server on port 7777. There's no separate build step while developing — edit and save.

### Available scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run both server and frontend concurrently. The usual dev command. |
| `npm run dev:server` | Run only the Fastify backend (tsx watch mode) |
| `npm run dev:web` | Run only the Vite frontend |
| `npm run build` | Production build of the frontend into `dist/` (alias: `build:web`) |
| `npm start` | Production server — `NODE_ENV=production`, serves `dist/` over Fastify on `:7777`, opens the default browser, and self-shuts-down 30s after the last browser tab closes. What the packaged `.app` runs. |
| `npm run type-check` | Full TypeScript check (no emit) — run this before pushing |
| `npm run probe` | Diagnostic. Runs the Claude CLI twice and dumps every stream-json event to `scripts/probe-output.jsonl`. Useful when CLI output shapes change or when debugging the parser. |

### Project layout

```
sherlock/
├── server/                  # Fastify backend that wraps the `claude` CLI
│   ├── index.ts             # boot + /api/health
│   ├── panes.ts             # state, REST + SSE endpoints, turn queue
│   ├── claude-runner.ts     # subprocess spawn + env scrub (no API key leakage)
│   ├── stream-parser.ts     # NDJSON → typed SSE events
│   ├── sse.ts               # raw SSE helpers for Fastify
│   └── history.ts           # parses ~/.claude/projects/.../*.jsonl for the History sidebar
├── web/                     # React + Vite frontend
│   ├── App.tsx
│   ├── main.tsx
│   ├── styles.css
│   ├── components/
│   │   ├── PaneColumn.tsx   # column-level layout, row/column resize
│   │   ├── PaneView.tsx     # one pane: header + transcript + input
│   │   ├── InputBar.tsx
│   │   ├── MarkdownMessage.tsx
│   │   ├── ToolUseCard.tsx
│   │   ├── HistorySidebar.tsx
│   │   ├── SelectionToolbar.tsx
│   │   ├── ConfirmModal.tsx
│   │   └── ErrorToast.tsx
│   ├── state/
│   │   ├── panes.ts         # Zustand store for conversations, turns, history
│   │   └── confirm.ts       # Zustand store for the custom "Sherlock says" modal
│   └── lib/
│       └── sse-client.ts
├── types/
│   └── events.ts            # shared event types between server and web
├── scripts/
│   └── probe-cli.ts         # diagnostic CLI probe (M0)
└── vite.config.ts
```

### Architecture in one paragraph

Each Sherlock conversation = exactly one Claude Code session, identified by a UUID Sherlock mints client-side and passes to the CLI on the first turn via `--session-id`. Every subsequent turn uses `--resume <same-id>` so Claude sees the full history (no forks, no `--fork-session`). "Continue in new column" is purely a visual split of the single linear transcript across columns and rows; the conversation chain underneath is unaffected. Server-side, all turns are serialized via a queue because concurrent `--resume` on the same session would race on the on-disk JSONL and Claude Code's session state. The frontend is React + Zustand; the server streams text deltas to it over SSE. Conversation persistence is delegated entirely to Claude Code, which writes a JSONL file per session under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The History sidebar reads that directory.

### How to release (maintainer)

Sherlock has no build pipeline and no `.dmg`. The `.app` users have installed is a 3-line shell-script launcher that pulls fresh code from a `release` branch on every launch. To ship to users:

```sh
# Work on main as usual
git commit -m "fix: …"
git push origin main

# When ready to ship to teammates:
git push origin main:release
```

Every running Sherlock instance picks up the new `release` tip on the *next* launch — no rebuild, no `.dmg`, no auto-updater. If `main` is broken, nothing reaches users until you push to `release`, so `release` is your safety lane.

### Packaging files

| Path | What it is |
|---|---|
| `install.sh` | One-line curl installer that clones the repo into `~/Library/Application Support/Sherlock`, installs deps, builds the frontend, and copies `Sherlock.app` to `/Applications`. |
| `scripts/launcher.sh` | What the `.app` actually runs. Reuses an already-running server, or starts one, then kicks off a background `git fetch` of the `release` branch for the *next* launch. |
| `packaging/Sherlock.app/` | The hand-rolled macOS app bundle (`Info.plist` + a shell-script `MacOS/Sherlock`). No signing, no electron-builder — `install.sh` just `cp -R`'s it into `/Applications`. |
| `npm start` | Production server: `vite build`-style static frontend served by Fastify on a single port, opens the browser on boot, writes the chosen port to `~/Library/Application Support/Sherlock/port.txt`, self-shuts-down 30s after the last browser tab closes. |

### Contributing

Open an issue or PR on GitHub. No formal process yet — small project. Please run `npm run type-check` before pushing.

---

## License

MIT *(planned for v0.1.0 release).*

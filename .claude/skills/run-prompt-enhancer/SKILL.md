---
name: run-prompt-enhancer
description: Build, run, and drive the Prompt Enhancer Vite/React app. Use when asked to start prompt-enhancer, run its dev server, take a screenshot of its UI, or interact with the running app (click buttons, read the admin system-prompt panel, check for console errors).
---

Prompt Enhancer is a Vite + React SPA (`npm run dev`, no backend of its own —
it talks directly to Anthropic/Ollama from the browser). There's no test
suite and no build-time server, so "running" it means starting the Vite dev
server and driving it with a headless-Chromium script — `driver.mjs` in this
directory. `chromium-cli` isn't installed in this container, so this driver
is a small hand-rolled stand-in with the same shape (pipe commands to stdin,
one per line).

All paths below are relative to the repo root (`/home/arebholz/www/prompt-enhancer/`).

## Prerequisites

Node + npm (already present). No `apt-get` packages were needed — Chromium
ran headless in this container with no extra system libraries, using
`--no-sandbox`.

## Setup

The driver has its own tiny `package.json` in this skill directory, kept out
of the app's own dependency graph:

```bash
cd .claude/skills/run-prompt-enhancer && npm install
```

That pulls in `playwright` (pinned `1.61.1`). If this is the first time
Playwright has ever run on this machine, also fetch the browser binary
(one-time, ~180MB, cached at `~/.cache/ms-playwright/` and shared across any
project):

```bash
npx --yes playwright install chromium
```

(`npx playwright install --with-deps` will try `sudo apt-get` and fail in a
no-sudo container — skip `--with-deps`; the plain chromium download ran fine
headless without it.)

## Build

No build step needed to run it — `npm run dev` serves from source. (`npm run
build` also works and produces `dist/`, but isn't required for driving the
UI.)

## Run (agent path)

1. Start the dev server in the background and wait for it to answer:

```bash
npm run dev > /tmp/dev-server.log 2>&1 &
timeout 30 bash -c 'until curl -sf http://localhost:5173 >/dev/null; do sleep 1; done'
```

2. Pipe commands to the driver:

```bash
node .claude/skills/run-prompt-enhancer/driver.mjs <<'EOF'
nav http://localhost:5173
wait-for text=Prompt Enhancer
screenshot home
EOF
```

Screenshots land in `.claude/skills/run-prompt-enhancer/screenshots/<name>.png`
(absolute path is echoed back as `OK screenshot <path>` — read that file to
actually look at it).

3. Stop the server when done:

```bash
pkill -f "vite"
```

For iterative debugging, run the driver under tmux instead of a one-shot
heredoc, and `send-keys` one command at a time — it stays open reading stdin
until you send `quit`:

```bash
tmux new-session -d -s app -x 200 -y 50
tmux send-keys -t app 'node .claude/skills/run-prompt-enhancer/driver.mjs' Enter
tmux send-keys -t app 'nav http://localhost:5173' Enter
tmux send-keys -t app 'wait-for text=Prompt Enhancer' Enter
tmux capture-pane -t app -p
```

### Driver commands

| command | what it does |
|---|---|
| `nav <url>` | `page.goto(url)`, waits for network idle |
| `wait-for text=<text>` | wait for an element containing that text |
| `wait-for <selector>` | wait for any Playwright selector (CSS, `xpath=`, `text=`) |
| `click <selector>` | click an element |
| `fill <selector> <text...>` | fill an input/textarea |
| `press <key>` | keyboard key, e.g. `Enter` |
| `value <selector>` | print `inputValue()` of a field |
| `text <selector>` | print `innerText()` of an element |
| `eval <js>` | `page.evaluate(js)`, prints the JSON result |
| `screenshot [name]` | full-page PNG, prints the saved path |
| `console` / `console --errors` | dump collected console messages (all / errors+pageerrors only) |
| `quit` | close the browser and exit |

Selectors accept anything Playwright accepts, including `button:has-text("...")`
and `xpath=...`. `text=` in `wait-for` is shorthand for `text=<value>` and
maps to Playwright's text engine.

## Run (human path)

```bash
npm run dev   # → opens a Vite dev server at http://localhost:5173. Ctrl-C to stop.
```

Open it in a real browser; there's nothing to build first.

## Test

No test suite exists in this repo. `npm run build` is the only automated
check (catches import/syntax errors); there is no `npm test`.

---

## Gotchas

- **The admin "System Prompt" textarea is not the first `<textarea>` on the
  page** — the "Your Scene" textarea comes first in DOM order. Select it
  relative to its label instead:
  `xpath=//*[contains(text(),"System Prompt")]/following::textarea[1]`.
- **`playwright install --with-deps` fails** in this container — no `sudo`,
  and it tries to `apt-get install` system libs non-interactively. Plain
  `playwright install chromium` (no `--with-deps`) downloaded fine and the
  browser ran headless with just `--no-sandbox`; no missing `.so` errors
  were hit.
- **Admin mode + Frame Mode both gate the System Prompt content.** To see
  the frame-mode-specific system prompt you must both toggle Admin mode
  *and* expand the "System Prompt" `<details>`-style section (click its
  header) before reading the textarea's `value`.
- **`npm install` for the driver lives in this skill directory**, not the
  repo root — it has its own `package.json` so Playwright never touches the
  app's real `package.json`/lockfile. `cd` there before `npm install`.

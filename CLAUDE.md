# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
npm install      # first time only
npm run dev      # dev server at http://localhost:5173
npm run build    # production build → dist/
npm run preview  # serve the production build locally
```

## Backend configuration

The app supports three backends, configured via `.env` or the ⚙ Backend panel in the UI:

**Anthropic Claude API** (recommended — set in `.env`):
```
VITE_API_KEY=sk-ant-…
```
An `sk-ant-` key automatically sets the base URL to `https://api.anthropic.com/v1`. No other config needed.

**Grok API (xAI)**:
```
VITE_API_KEY=xai-…
```
An `xai-` key automatically sets the base URL to `https://api.x.ai/v1`. xAI's endpoint is OpenAI-compatible, so it needs no special browser headers — same `Authorization: Bearer <key>` path as Ollama.

**Ollama (local)**: `OLLAMA_ORIGINS=*` must be set before starting Ollama. Default base URL is `http://localhost:11434/v1`.

`.env` values override localStorage on every page load. `VITE_API_BASE` can override the base URL explicitly. The `.env` file is gitignored.

### Anthropic API — how it works in the browser

Anthropic's API requires three headers for browser (CORS) access, sent automatically when `cfg.base` contains `anthropic.com`:
- `x-api-key: <key>`
- `anthropic-version: 2023-06-01`
- `anthropic-dangerous-direct-browser-access: true`

Grok (xAI) and Ollama both use `Authorization: Bearer <key>`. The `authHeaders(cfg)` function in `api.js` selects the right set based on `isAnthropic(cfg.base)`. `isGrok(cfg.base)` (base contains `api.x.ai`) is used for UI labeling/placeholders and to gate provider-specific request quirks. Do **not** add `format: 'json'` to requests when using Anthropic or Grok — it is Ollama-specific and is already gated in `callOllama` (both cloud providers are excluded via the internal `isCloud` check).

## Architecture

React 18 + Vite. Source is split across `src/`:

| File | Purpose |
|---|---|
| `src/constants.js` | All system prompts, option arrays, and the `TARGETS` object |
| `src/api.js` | `callOllama`, `fetchModels`, config persistence, model auto-pickers |
| `src/utils.js` | Pure helpers: `recommendRes`, `ratioLabel`, `snap32`, shared style objects |
| `src/components/ConfigBar.jsx` | Collapsible backend settings panel with Ollama / Claude API presets |
| `src/components/ImagePanel.jsx` | Image drop zone, resolution picker, crop tool with canvas export |
| `src/components/ScriptwriterPanel.jsx` | 3-phase scriptwriter pipeline (see below) |
| `src/App.jsx` | Main component — all UI state, the two-stage pipeline, admin mode, history |

The legacy single-file `prompt_enhancer_ollama.html` is kept for reference but is no longer the active version.

### Two-stage pipeline

1. **Stage 1 — Vision** (`captionImages()` in App): sends image(s) to a vision model using a target-specific system prompt. Returns a plain-text frame description.
2. **Stage 2 — Writer** (`runWriter()` in App): sends the frame description + user controls to a writer model. The writer's system prompt encodes all domain rules for the selected generation target.

Text-only inputs skip stage 1. The "3 variants" mode runs stage 2 three times in parallel at temperatures `[0.3, 0.7, 1.0]`.

### Generation targets

Controlled by the `TARGETS` object in `constants.js`. Current targets: `ltx`, `ltx_guide` (LTX-2.3 video), `kling` (Kling AI video), `flux` (FLUX.dev image), `flux2klein` (FLUX.2 Klein image), `krea2turbo` (Krea 2 Turbo image), `sdxl` (SDXL Danbooru-tag image), `threed` (3D-print miniature), `scriptwriter` (3-phase pipeline).

Each target declares:
- `system` — writer system prompt
- `resolutions` — resolution preset array
- `show` — flags controlling which UI controls appear: `{ duration, camera, dialogue, frameMode, twoStage }`
- `visionPrompt` — system prompt passed to the vision model in stage 1 (image targets, plus `kling` — a video target whose vision prompt overrides `VISION_PROMPT_LTX_SINGLE` in single-image mode)
- `durations` / `durationHint` — (optional) per-target duration presets replacing the LTX `DURATION_OPTIONS`, and hint text under the picker (`kling` uses 5s/10s)
- `presetNote` — (optional) note shown under the resolution presets in `ImagePanel`, replacing the LTX/FLUX default text

The `scriptwriter` target has `type: 'scriptwriter'` and renders `<ScriptwriterPanel>` instead of the normal scene/image/generate UI.

### Scriptwriter pipeline (`scriptwriter` target)

`ScriptwriterPanel.jsx` runs three sequential LLM calls with user-review gates between each:

1. **Phase 1 — Script** (`SYSTEM_PROMPT_SCRIPTWRITER`): story idea → JSON `{ title, scenes[{ id, title, setting, description, dialogues[] }] }`. Shown as editable structured cards.
2. **Phase 2 — Director's cut** (`SYSTEM_PROMPT_DIRECTOR`): scene list → JSON `{ shots[{ shot_number, scene_id, scene_title, camera_framing, camera_movement, lighting_mood, visual_action }] }`. Shown as editable shot cards.
3. **Phase 3 — LTX prompts** (`buildLtxGuideSystemPrompt('single')`): each shot fires a parallel `callOllama` call using the LTX guide writer prompt's single-frame-mode variant (shots are one continuous action, never first/last-frame interpolation), with shot fields mapped to the standard `runWriter` user-message format. Output is plain text, not JSON.

Phases 1 & 2 use `callOllama(..., { format: 'json' })` (Ollama JSON mode; ignored on Anthropic). Phase 3 does not — it reuses the existing LTX writer path.

### Admin mode

A toggle in the header. When on: after stage 1 completes, `enhance()` pauses and populates two editable textareas (system prompt + user message) instead of calling the writer. `sendToWriter()` fires stage 2 from whatever is in the textareas. `pendingSnapshotRef` (useRef) holds the generation snapshot between phases.

### State and persistence

All UI state lives in `useState` hooks inside `App`. Two things persist to `localStorage`:
- **Backend config** (`ollama-enhancer-config`): base URL, API key, temperature.
- **Generation history** (`gen-history`): last 10 runs, each with a settings snapshot and output texts.

`VITE_API_KEY` / `VITE_API_BASE` from `.env` override localStorage values on every page load.

### Prompt length control

`PROMPT_LENGTH_OPTIONS` (Concise / Standard / Detailed) in `constants.js` maps to `PROMPT_LENGTH_INJECT` — instruction strings appended to the writer's user message in `runWriter()` as `lengthPart`. Default is `'standard'`. The `concise` key injects nothing (lets the system prompt's native length guidance stand).

### System prompts

The constants in `constants.js` are the core domain knowledge of the tool. Changes here have the highest impact on output quality:

| Constant | Used for |
|---|---|
| `SYSTEM_PROMPT_LTX` | Writer system prompt for LTX-2.3 video generation (full text, all frame-mode sections included) |
| `SYSTEM_PROMPT_LTX_GUIDE` | LTX-2.3 writer prompt — guide-aligned variant (longer, sequential-friendly), full text |
| `buildLtxSystemPrompt` / `buildLtxGuideSystemPrompt` | Build the actual system prompt sent per generation: base intro + REST are always included, but the FIRST–LAST / FIRST–MID–LAST frame-mode section is only appended when `frameMode` matches, so the other mode's prose isn't sent as wasted tokens. `TARGETS.ltx`/`ltx_guide` expose this as `buildSystem(frameMode)`; call via `systemPromptFor(target, frameMode)` rather than reading `target.system` directly. Also used by the scriptwriter pipeline's Phase 3 with `frameMode: 'single'` (a shot is always one continuous action, never frame interpolation). |
| `SYSTEM_PROMPT_KLING` | Writer system prompt for Kling AI video — mode-aware: text-to-video (official Subject + Movement + Scene + optional Camera/Lighting/Atmosphere formula, 30–60 words) vs. image-to-video (motion-only, 20–40 words, never re-describes the image; anchors every movement to a named subject). Always outputs `PROMPT:` + `NEGATIVE PROMPT:` blocks — negatives are un-prefixed exclusion terms (<30 words) aimed at stability/consistency |
| `SYSTEM_PROMPT_FLUX` | Writer system prompt for FLUX.dev image generation |
| `SYSTEM_PROMPT_FLUX2_KLEIN` | Writer system prompt for FLUX.2 Klein (Qwen3 encoder, no CLIP 77-token cap, no negative prompts) |
| `SYSTEM_PROMPT_KREA2_TURBO` | Writer system prompt for Krea 2 Turbo — one natural-language paragraph, no tags/weights/negations, style anchor for non-photo media, matches detail level to input |
| `SYSTEM_PROMPT_SDXL` | Writer system prompt for SDXL — outputs Danbooru-style tags with `POSITIVE:` / `NEGATIVE:` sections |
| `SYSTEM_PROMPT_3D` | Writer system prompt for 3D-print miniature — FLUX prompt with strict geometry/printability constraints |
| `SYSTEM_PROMPT_SCRIPTWRITER` | Phase 1 of the scriptwriter pipeline — story idea → structured JSON scene list |
| `SYSTEM_PROMPT_DIRECTOR` | Phase 2 of the scriptwriter pipeline — scene list → JSON shot list sized for LTX-2.3 clips |
| `VISION_PROMPT_LTX_SINGLE` | Vision prompt for single first-frame input (LTX) |
| `VISION_PROMPT_LTX_FIRSTLAST` | Vision prompt for first+last frame interpolation (LTX) |
| `VISION_PROMPT_LTX_FIRSTMIDLAST` | Vision prompt for first+mid+last frame interpolation (LTX) |
| `VISION_PROMPT_KLING` | Vision prompt stored on the `kling` target; names the subject and movable background elements as motion anchors for the I2V writer |
| `VISION_PROMPT_FLUX` | Vision prompt stored on the `flux` target in TARGETS |
| `VISION_PROMPT_FLUX2_KLEIN` | Vision prompt stored on the `flux2klein` target; instructs spatial relationship descriptions |
| `VISION_PROMPT_KREA2_TURBO` | Vision prompt stored on the `krea2turbo` target; full-sentence description in Style → Subject → Environment → Lighting/Camera → Color/Mood order |
| `VISION_PROMPT_SDXL` | Vision prompt stored on the `sdxl` target; extracts Danbooru tags from reference images instead of prose |
| `VISION_PROMPT_3D` | Vision prompt stored on the `threed` target; extracts character class, armor, and weapon details |

### SDXL target notes

Unlike FLUX/LTX targets, `sdxl` outputs **two labeled blocks** (`POSITIVE:` and `NEGATIVE:`) of comma-separated Danbooru tags. The writer system prompt enforces strict tag ordering (quality tokens → subject count → character details → pose → setting → composition → lighting → style) and always includes a negative prompt. There is no SD-style weighting syntax — tag order carries the weight signal. `SDXL_RESOLUTIONS` includes the 4:3 pair (1152×896 / 896×1152) not present in `FLUX_RESOLUTIONS`.

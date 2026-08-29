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
| `src/comfy.js` | `uploadImage` — copies loaded input image(s) into a local ComfyUI instance's `input/` folder via its `/upload/image` API |
| `src/utils.js` | Pure helpers: `recommendRes`, `ratioLabel`, `snap32`, shared style objects; `cyrb53` / `imageHash` / `visionCacheKey` (sync hashing for the vision caption cache) |
| `src/imageDrag.js` | Module-scope holder for an in-app image drag payload (`setDragImage` / `takeDragImage` / `hasDragImage`, `DRAG_MIME`). HTML DnD can only carry strings, so a base64 image is kept here and only a marker MIME goes on the `dataTransfer`. In DEV it also exposes `window.__peImageDrag` (compiled out of prod) so the headless driver / console can reach the payload |
| `src/components/ConfigBar.jsx` | Collapsible backend settings panel with Ollama / Claude API presets |
| `src/components/ImagePanel.jsx` | Image drop zone, resolution picker, crop tool with canvas export. Also accepts an in-app image drop and a `seed={{data,nonce}}` prop that pushes a picked history image into the panel |
| `src/components/HistoryImageGallery.jsx` | Collapsible grid of every unique input image across all history entries (deduped on base64). Each thumbnail is `draggable` (drop onto any image slot) and, when `onPick` is passed, click-to-add |
| `src/components/AdaptPanel.jsx` | "⇄ Adapt to text-only prompt" — re-target a completed (or restored) image-based generation to a text-only prompt for a chosen target + model (see below) |
| `src/adapt.js` | Pure logic for `AdaptPanel`: `ADAPT_TARGETS`, `foldCaption()`, `buildStylePart()` (extracted from `enhance()` — also used by the main pipeline), `buildAdaptUserText()` |
| `src/components/ScriptwriterPanel.jsx` | 3-phase scriptwriter pipeline (see below) |
| `src/App.jsx` | Main component — all UI state, the two-stage pipeline, admin mode, history |

The legacy single-file `prompt_enhancer_ollama.html` is kept for reference but is no longer the active version.

### Two-stage pipeline

1. **Stage 1 — Vision** (`captionImages()` in App): sends image(s) to a vision model using a target-specific system prompt. Returns `{ text, stats }` (`stats = { fromCache, fresh }`). In `ref` mode it fires one call per reference image; every other mode makes a single call over 1–3 frames.
2. **Stage 2 — Writer** (`runWriter()` in App): sends the frame description + user controls to a writer model. The writer's system prompt encodes all domain rules for the selected generation target.

Text-only inputs skip stage 1. The "3 variants" mode runs stage 2 three times in parallel at temperatures `[0.3, 0.7, 1.0]`.

**Vision caption cache.** Every vision `callOllama` funnels through `cachedVision(content, system, stats)` inside `captionImages()`. The key is `visionCacheKey(effectiveVision, system, content)` (`src/utils.js`) — model id + `cyrb53` of the system prompt + each `content` block positionally (`cyrb53` of text blocks, `imageHash` = length-prefixed `cyrb53` of the base64 for image blocks). It auto-invalidates on any model / prompt / scene / role-`visionFocus` / frame-order / image-bytes change, and — because history snapshots store raw image bytes — an image reused via `restore()` or the history gallery re-hashes to the same key and hits. Two tiers: an L1 `captionMemRef` (`useRef(Map)`, session) and an L2 IndexedDB `captions` store (survives reloads). Cache reads/writes are best-effort (`.catch(() => {})`). The old identity-keyed `visionCacheRef` / `refCaptionCacheRef` are gone; `enhance()` no longer has a pre-vision gate. The vision `<details>` summary shows "· N cached, M described" from `stats`; ⚙ Backend has a "Clear caption cache" button (`clearCaptions()` + `captionMemRef.current.clear()`).

### Generation targets

Controlled by the `TARGETS` object in `constants.js`. Current targets: `ltx`, `ltx_guide` (LTX-2.3 video), `kling` (Kling AI video), `minimax_h3` (MiniMax H3 audio-video, 5 modes), `flux` (FLUX.dev image), `flux2klein` (FLUX.2 Klein image), `krea2turbo` (Krea 2 Turbo image), `sdxl` (SDXL Danbooru-tag image), `threed` (3D-print miniature), `dramabox` (DramaBox TTS), `scriptwriter` (3-phase pipeline).

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

All UI state lives in `useState` hooks inside `App`. Three things persist to `localStorage`:
- **Backend config** (`ollama-enhancer-config`): base URL, API key, temperature.
- **ComfyUI copy config** (`prompt-enhancer-comfy-config`): just the ComfyUI server URL (default `http://127.0.0.1:8188`) used by the "⇪ Copy to ComfyUI input" button — see below.
- **Project list** (`prompt-enhancer-projects`): a plain array of project name strings (`loadProjects`/`saveProjects` in `src/db.js`). Names only — this keeps empty projects (created but with no generations yet) alive across reloads; the per-generation link lives on the history entry itself (see below).

`VITE_API_KEY` / `VITE_API_BASE` from `.env` override localStorage values on every page load.

**Generation history** persists to IndexedDB (`src/db.js` — DB `prompt-enhancer`, **`DB_VERSION` 2**, `onupgradeneeded` is a flat set of idempotent "create if missing" store guards). Two object stores: `history` (keyPath `id`, `ts` index; schema-less `put`/`getAll`/`delete`/`clear`, no entry-count cap) and `captions` (keyPath `key`, `ts` index) — the L2 vision-caption cache, helpers `getCaption(key)` / `putCaption(key, caption)` / `clearCaptions()`.

**Project folders.** Each history entry carries an optional `project` field (a name string, or `null` = Unfiled). The **Project** picker (under "Generate for") sets `activeProject`, which `saveHistory` / `saveScriptHistory` stamp onto every new entry; the scriptwriter re-saves the same `id` across its three phases, so `saveScriptHistory` preserves a project the user reassigned in the meantime rather than resetting it. Existing entries are reassigned in place via a per-card `<select>` (`entryProjectSelect` → `assignEntryProject` → `setHistoryEntryProject(id, project)`, a read-modify-write so it works on entries saved before the field existed). `allProjects` (a `useMemo`) is the union of the persisted list and every name referenced by an entry, so a project stays selectable even if its localStorage record is lost.

**History filters.** A filter bar (shown when `history.length > 1`) narrows `visibleHistory` by four independent, AND-combined criteria: **project** (`historyFilter`: `all` / `unfiled` / a name), **target** (`histTargetFilter`: `all` / a target id — `entryTargetId(h)` returns `'scriptwriter'` for scriptwriter-type entries, `h.target` otherwise), **writer model** (`histModelFilter`: `all` / an exact model string — options are `modelFilterLabel(m)` = `"<provider> · <model>"` where `modelProvider` classifies a model string as Claude / Grok / Ollama), and **image inputs** (`histImageFilter`: `all` / `with` / `without` — `entryHasImages(h)` is true if any of `firstImg` / `midImg` / `lastImg` / a non-empty `refImages` / a `vision` model is present). Each select only renders when the history holds more than one distinct value for it. `histFiltersActive` gates the **Reset** button and switches the header count to `visible/total`. All four helper functions (`entryTargetId`, `entryTargetLabel`, `entryHasImages`, `modelProvider`, `modelFilterLabel`) are module-level pure functions near `buildVariants`. `renameProject` / `deleteProject` bulk-update affected entries (delete → entries become Unfiled); `restore()` also sets `activeProject` to the restored entry's project. `importHistory` registers any project names it sees in the imported entries. Entries predating this feature simply have no `project` key and read as Unfiled. `migrateFromLocalStorage()` one-time-migrates any pre-existing `localStorage` `gen-history` data (an older, capped-at-10-runs format) into IndexedDB on first load. Each entry's snapshot includes any input image(s) used — full `{ base64, mediaType, fileName, hash }` data (plus `role`/`preserve`/`note` for MiniMax H3 reference images, and a separate `refAudio` for the H3 voice-timbre reference), not just a filename — so `restore()` repopulates the live image panels (`firstImg`/`midImg`/`lastImg`/`refImages`) directly from history, making a restored entry immediately usable again (regenerate, ZIP export, "Copy to ComfyUI input"). The snapshot also stores `caption` (the assembled vision description) so a restored/history-selected image-based entry can be re-targeted by `AdaptPanel` without re-running vision, and adapt-produced entries carry `adaptedFrom: { target, frameMode, ts }`. Entries saved before this existed only have a filename string; `restore()` and the history-list thumbnail rendering both check for object-shaped image data and fall back to the old label-only behavior for those, so no migration was needed.

### Reusing images from history

`HistoryImageGallery` (rendered just above the image panels whenever `showImage`, i.e. every target except `scriptwriter` / `dramabox`) walks every history entry and collects the unique input images (`firstImg`/`midImg`/`lastImg` + each `refImages[]`). `collectImages(history)` returns `{ images, stats }`: images are deduped via a `Map` keyed on a **cheap composite** (`fileName|len|head64|tail64`) rather than the full multi-MB base64, sorted newest-first; `stats` (`{entries, rawFields, objWithBase64, collected}`) drives a DEV-only diagnostic — `console.debug` every history change plus a `console.warn` if `collected === 0 && objWithBase64 > 0` (a real traversal/gate bug). **Legacy history entries that stored only a filename string** never pass the `typeof im === 'object' && im.base64` gate (same gate the history-list thumbnails use) and are silently skipped — no explanatory UI. The section **auto-expands the first time it has ≥1 image** (session-sticky via a ref once the user toggles it); when a history exists but has no byte-backed images it still shows the collapsed `(0)` toggle with a one-line stats-aware empty state. The visible grid is capped at `CAP = 60` (with a "showing 60 of N" note), thumbnails are `loading="lazy" decoding="async"`, and the grid scrolls internally (`maxHeight: 340`).

Loaded image objects and history-snapshot image fields carry a `hash` field (`imageHash(base64)` from `src/utils.js`) — added in `ImagePanel`/`MinimaxRefPanel` load paths, `pickHistoryImage`, `restore`, and the `runWriter` snapshot. It is threaded through the drag/pick payload so downstream code reuses it (`d.hash || imageHash(d.base64)`); the vision cache does not depend on it (it always re-hashes bytes), so legacy entries without a stored `hash` still work.

Each thumbnail is `draggable`; `onDragStart` calls `setDragImage({base64,mediaType,fileName,hash})` (payload held in `src/imageDrag.js` module scope) and puts only `DRAG_MIME` on the `dataTransfer`. `ImagePanel` and `MinimaxRefPanel` both check `hasDragImage(e.dataTransfer)` in their `onDrop` and, if set, call `takeDragImage()` — `ImagePanel` via a no-resize `loadFromData()`, `MinimaxRefPanel` by appending a ref object (default role, `strong` preservation). Clicking a thumbnail routes through `App.pickHistoryImage(data)`: in MiniMax `ref` mode it appends to `refImages` (cap 6); otherwise it bumps `seeds.{first|mid|last}` (a `{data,nonce}` object) which `ImagePanel`'s `useEffect([seed?.nonce])` picks up and loads — filling the first empty frame in `firstlast` / `firstmidlast`. `seeds` is reset by `switchMode` / `switchTarget`.

### Copying input images to ComfyUI

Whenever an input image is loaded (any `frameMode`, any image-capable target), a "⇪ Copy to ComfyUI input" button appears next to the image panel(s), alongside a small ComfyUI server URL field. Clicking it calls `uploadImage()` in `src/comfy.js` for each currently-loaded image (reusing the same `currentImages()` helper the ZIP export uses for naming/ordering), which `POST`s each one to ComfyUI's own `/upload/image` endpoint — landing them in ComfyUI's `input/` folder, ready to pick from a `LoadImage` node's dropdown. Like Ollama's `OLLAMA_ORIGINS=*`, this needs ComfyUI started with `--enable-cors-header` for the browser to reach it. This is intentionally minimal — no workflow JSON, no prompt injection, no queueing; it only moves image bytes into ComfyUI's input folder.

### Prompt length control

`PROMPT_LENGTH_OPTIONS` (Concise / Standard / Detailed) in `constants.js` maps to `PROMPT_LENGTH_INJECT` — instruction strings appended to the writer's user message in `runWriter()` as `lengthPart`. Default is `'standard'`. The `concise` key injects nothing (lets the system prompt's native length guidance stand).

### Adapt to text-only prompt

`AdaptPanel` (rendered after the results, gated on `caption || adaptSourceOverride`) re-targets a completed — or restored, or history-selected — image-based generation into a **text-only** prompt for a **different target + model**, with the vision/image descriptions folded into the prose so no reference image is needed. The panel has its own destination-target button row (`ADAPT_TARGETS` in `src/adapt.js` = every target except `scriptwriter` / `dramabox`), an independent model `<select>`/`<input>`, an inherited-but-overridable duration (video targets) and aspect ratio (`minimax_h3` only), and a checkbox to also feed the original prompt as an intent reference. It calls `callOllama(model, buildAdaptUserText(...), systemPromptFor(dest, 'single'), cfg, cfg.temperature)` and, on success, **saves a new standard history entry** (`target: destTarget`, `frameMode: 'single'`, no images, `vision: null`, `adaptedFrom: { target, frameMode, ts }`) via `App.saveHistory` — the live workspace / target / `results` are never touched.

`src/adapt.js`:
- `foldCaption(caption, sourceFrameMode)` — strips caption scaffolding: `ref`-block `Image N — role: X, preservation: Y (marker): …` → `X: …` (drops the H3-only preservation/marker), `Requested use of this reference:` → inline `(intended use: …)`, `Audio 1 —` line dropped; `firstlast`/`firstmidlast` `FIRST FRAME:` / `CHANGE:` etc. relabelled to `Opening state:` / `What changes over the shot:`; single/prose passes through.
- `buildAdaptUserText({ destTarget, scene, foldedCaption, duration, aspectRatio, stylePart, lengthPart, audio, originalPrompt })` — mirrors the matching text-only branch of `runWriter()`, swapping the frame/ref block for a "Visual details to incorporate (… there is NO reference image …)" block (labelled "Reference image description:" for image targets, so their inert "if a reference-image description is provided…" clause activates).
- `buildStylePart(opts)` — the `stylePart` construction (style + creativity + dialogue + "things to avoid") extracted from `enhance()`; `enhance()` calls it with the real target `type` (byte-identical output), `AdaptPanel` with `forceNonImageWording: true`.

`App.jsx`: the `runWriter` snapshot now stores `caption: frameDescription || null`; `restore()` rehydrates it (`setCaption(h.caption || '')`), so a restored image-based entry can be adapted without re-running vision. A history card shows a `⇄ Adapt` button when `h.caption` is truthy, which sets `adaptSourceOverride` (cleared by `switchTarget` / `enhance` / `restore`). `LTX_INTRO` / `LTX_GUIDE_INTRO` gained a two-sentence "if NO frame description is given (pure text request)" clause (also fixes the pre-existing bare text-only LTX path).

### System prompts

The constants in `constants.js` are the core domain knowledge of the tool. Changes here have the highest impact on output quality:

| Constant | Used for |
|---|---|
| `SYSTEM_PROMPT_LTX` | Writer system prompt for LTX-2.3 video generation (full text, all frame-mode sections included). `LTX_INTRO` has a "if NO frame description is given (pure text request)" clause for text-only / adapt runs |
| `SYSTEM_PROMPT_LTX_GUIDE` | LTX-2.3 writer prompt — guide-aligned variant (longer, sequential-friendly), full text. `LTX_GUIDE_INTRO` has the same text-only clause |
| `buildLtxSystemPrompt` / `buildLtxGuideSystemPrompt` | Build the actual system prompt sent per generation: base intro + REST are always included, but the FIRST–LAST / FIRST–MID–LAST frame-mode section is only appended when `frameMode` matches, so the other mode's prose isn't sent as wasted tokens. `TARGETS.ltx`/`ltx_guide` expose this as `buildSystem(frameMode)`; call via `systemPromptFor(target, frameMode)` rather than reading `target.system` directly. Also used by the scriptwriter pipeline's Phase 3 with `frameMode: 'single'` (a shot is always one continuous action, never frame interpolation). |
| `SYSTEM_PROMPT_KLING` | Writer system prompt for Kling AI video — mode-aware: text-to-video (official Subject + Movement + Scene + optional Camera/Lighting/Atmosphere formula, 30–60 words) vs. image-to-video (motion-only, 20–40 words, never re-describes the image; anchors every movement to a named subject). Always outputs `PROMPT:` + `NEGATIVE PROMPT:` blocks — negatives are un-prefixed exclusion terms (<30 words) aimed at stability/consistency |
| `SYSTEM_PROMPT_MINIMAX_H3` | Writer system prompt for MiniMax H3 audio-video — one compiler prompt covering all five modes (T2VA / I2VA / L2VA / FL2VA / Ref2VA), selected by the `MODE:` line in the user message. Encodes H3-specific failure modes from the `h3-storyboard` skill: rule 3a (expression-beat density — ≤2 facial beats per shot or the face averages to still; split emotional moments into 2–3s single-beat shots), tail-collapse margin (last ~1.5s), camera-before-face / no-eyeline-to-lens (rule 4), dialogue spreads mouth motion across the whole shot so post-speech beats move to the next shot and dialogue shots don't carry background continuity (rule 6), emotion as observable action ordered brow→eye→mouth (rule 9), transitions hidden behind an occluder not crossfaded (rule 10), never "nothing changes" (rule 11), size/distance as cropping relationships not fractions/units (rule 12), no on-camera collisions or liquid volume and no phantom-object names (rule 13) |
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
| `VISION_PROMPT_MINIMAX_H3_REF` | Vision prompt for `minimax_h3` reference images (`ref` frame mode); a 3–5 sentence description. `App.jsx` `captionImages()` appends the selected role's `visionFocus` string (from `MINIMAX_H3_REF_ROLES`) to the per-image request text so the caption concentrates on what that role needs (a Style ref → palette/light, a Wardrobe ref → garment only, etc.); because that text is part of the vision cache key (`visionCacheKey`), changing a role re-captions just that image. The role label + preservation marker + any per-image `note` are attached to each caption line in `App.jsx` (outside the cache — editing `note`/`preserve` updates the block without re-running vision) |

### SDXL target notes

Unlike FLUX/LTX targets, `sdxl` outputs **two labeled blocks** (`POSITIVE:` and `NEGATIVE:`) of comma-separated Danbooru tags. The writer system prompt enforces strict tag ordering (quality tokens → subject count → character details → pose → setting → composition → lighting → style) and always includes a negative prompt. There is no SD-style weighting syntax — tag order carries the weight signal. `SDXL_RESOLUTIONS` includes the 4:3 pair (1152×896 / 896×1152) not present in `FLUX_RESOLUTIONS`.

### MiniMax H3 target notes

`minimax_h3` compiles to H3's own schema — either three fields (`integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`) or, in `Ref2VA`, six fields (`subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / soundscape / music). Frame mode maps to H3 mode: no image = T2VA, one image = I2VA, `last` = L2VA, `firstlast` = FL2VA, `ref` = Ref2VA (up to 6 role-tagged reference images via `MinimaxRefPanel.jsx`, each with a `MINIMAX_H3_REF_ROLES` role, a `MINIMAX_H3_PRESERVE_OPTIONS` preservation marker, and an optional free-text `note` on how to use it). `MinimaxRefPanel` also renders non-blocking amber hints for risky reference sets (wardrobe with no identity ref, ≥2 identity refs, ≥2 "Exact" locks) and an optional single **voice-timbre audio reference** (`refAudio`, ≤10 MB) — when present, `captionImages()` appends an `Audio 1 — voice-timbre reference (marker: reference): …` line and `SYSTEM_PROMPT_MINIMAX_H3`'s Ref2VA block emits a `<Audio 1>` `subject_definitions` line + a `reference`-marker `retention_analysis` line. Entering `ref` mode seeds `h3RatioId` to `port916` (9:16 portrait — the validated Ref2VA short-drama format); the ratio buttons only highlight on a real `h3RatioId` match. `App.jsx` `runWriter()` builds the `MODE:` line, frame/reference block, `Aspect ratio:` line (from `h3RatioId` / `MINIMAX_H3_RESOLUTIONS` for T2VA/Ref2VA; "derived from the input image(s)" otherwise), `Target duration:`, and the soundscape/music sections. The snapshot persists `note` per ref image and `refAudio`, and `restore()` repopulates both.

The `.claude/skills/h3-storyboard` skill is the source for the performance and physics rules in `SYSTEM_PROMPT_MINIMAX_H3` (rules 3a, 4, 6, 9–13) — all empirically derived from real H3 output, not docs. Consult it (and its `SOURCES.md` verification table) before revising those rules.

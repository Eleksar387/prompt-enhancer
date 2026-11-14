# Audit — current MiniMax H3 enhancer (2026-11-14)

Scope: the plan in `PLAN-h3-prompt-enhancer-v2.md` assumed a greenfield enhancer. It is not: this React/Vite app (+ Node history sidecar) already is the enhancer. This is the one-page map of where H3 prompt quality is decided today.

## Main pipeline (`target === 'minimax_h3'`) — the primary quality target
1. **Inputs** (`App.jsx` workspace state, snapshotted via `WORKSPACE_FIELDS`, `src/workspace.js`): short idea (`scene`), duration, aspect ratio, style/creativity, dialogue + delivery + spoken language, soundscape, music, ≤6 role-tagged reference images (`MinimaxRefPanel`: role, preservation, note, timeline anchor `atSeconds`, per-image `loraId`), ≤2 voice refs (`refAudios`, bound to an image via `subjectRef`), LoRA chips (`activeLoras`).
2. **`enhance()`** (`App.jsx` ~1522): Manual mode → `buildManualH3` (zero AI); else guards models, builds `stylePart`/`lengthPart` (`buildStylePart`, `src/adapt.js`).
3. **Stage 1 vision** — `captionImages()` (~1300): one cached vision call per reference (`cachedVision`, role-focused prompts). Output: `Image N — role: …, preservation: …: <caption>` block + `Audio N —` lines.
4. **Stage 2 writer** — `runWriter()` (~1639): `buildWriterUserText()` (`src/adapt.js:361`) assembles `MODE:` line + caption block + duration/ratio/soundscape/music + idea + stylePart; system = `systemPromptFor(t, frameMode)` → **`SYSTEM_PROMPT_MINIMAX_H3`** (`src/constants.js:1384`, ~320 lines); one `callOllama` (or 3 variants) via `runWriterCall()` (~1151). Admin mode can pause/edit the message (`admin.pause`).
5. **Post-processing**: `withLoraTriggers()` repair (`src/loras.js`), `H3SyntaxBadge` → `checkH3Prompt` (`src/h3PromptCheck.js`: label skeleton, first line, tag syntax, ≤7000 chars; warnings only), history save (`buildSnapshot` → sidecar).
6. Non-AI siblings: Manual mode (`buildManualH3`) and "✍ Manual Prompt" template (`buildH3Template`), both in `src/manualH3.js`.

## What `SYSTEM_PROMPT_MINIMAX_H3` is (and is not)
Rules 1–15 are **format + H3-physics**: language/tags, style opening (1a), observable actions (3), expression-beat density (3a), camera phrasing (4), cuts (5), dialogue timing/tags (6, 6a), soundscape/music (7–8), emotion-as-action (9–11), cropping not numbers (12), don't name what shouldn't appear (13), length/output (14–15). Mode-specific schema follows. **Nothing in it decides story**: no reversal/stakes, no "what must the audience feel → camera", no dialogue-does-work or word budget, no clip-level purpose. `creativity` only modulates tone. The model compiles whatever the idea gives it, so a thin idea → a thin prompt.

## Scriptwriter (secondary)
3 phases (`ScriptwriterPanel.jsx`): Phase 1 `SYSTEM_PROMPT_SCRIPTWRITER` (script + bible, `emotional_turn`), Phase 2 `SYSTEM_PROMPT_DIRECTOR_H3` (clips: `shot_type`, `primary_beat`, `eyeline`, `dialogue`, `reference_images`), Phase 3 `SYSTEM_PROMPT_MINIMAX_H3` per clip. Has a decision layer, but no per-shot `purpose`, no reversal/advantage tracking, no continuity state beyond bible ids, no critic.

## Gap table vs PLAN-h3-prompt-enhancer-v2
| Plan item | Status |
|---|---|
| Treatment / beats / shot list before H3 syntax | Missing in main pipeline; partial in Scriptwriter |
| Reversal per clip, purposeful camera, dialogue budget | Missing everywhere |
| Critic/revise loop | Missing (only syntax badge + code checks like `isMergeEligible`) |
| H3 validator | Partial: `h3PromptCheck.js` (skeleton/tags). Missing: `[reference generation]` tag, audio-line, negative-phrasing, `(Sx)`↔dialogue, word budget |
| Per-stage model routing | Missing (one writer + one vision model; `cfg` in `src/api.js`) |
| Continuity across clips | Missing |
| Previz notes input | Missing (timeline anchors exist, not previz) |
| Craft knowledge files | Missing; h3-storyboard skill covers H3 physics only |
| Reusable | `parseJSON`, `callOllama`, `WORKSPACE_FIELDS`, `rerunFromCaption` pattern, `H3SyntaxBadge`, DEV `window.__peLast*` stashes, vitest prompt snapshots |

## Constraints carried into the design
Ref2VA numbering/preservation markers, per-voice audio lines, LoRA trigger placement, Admin mode, queue/Full Auto, history/restore/Adapt/ZIP/Director export must all keep working; toggle-off must be byte-identical. Dialogue format in this repo is `[Language] "…"` (not `<d>`), see CLAUDE.md. No negative prompts / CFG in H3 (rule 13 already encodes positive-only wording).

## Baseline
`eval/baseline/*.json` (gitignored — real, private history content): 5 real Ref2VA runs spanning 1–6 refs, 0–1 voice, 0–2 LoRAs, 8–15 s, short (27 chars) to long (821) ideas, 3 writer models incl. one local Ollama. Regenerate: `node eval/extract-baseline.mjs <entryId …>`. Mordheim alley spec: `eval/inputs/mordheim-alley.md` (no Mordheim run exists in history yet).

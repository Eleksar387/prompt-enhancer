# Progress — feature/h3-prompt-v2

## Step 0 — audit + baseline (2026-11-14)
- `docs/audit.md` written (map of current pipeline + gap table).
- `eval/extract-baseline.mjs` + 5 real baseline entries in `eval/baseline/` (gitignored, private).
- Open: Mordheim alley input needs user's reference images (`eval/inputs/mordheim-alley.md`).

## Script-quality overhaul — Phase 0 (2026-11-15)
- `eval/extract-script-baseline.mjs` (list + slim dump) and `docs/script-diagnosis.md` written. No app code changed.
- Finding: real clips average 6.6 s (31 % ≤5 s), typical film = 1 scene / ~25 s; hypothesis "4 s micro-scenes" only partly holds, "no craft" and "Phase 2 has no time budget" confirmed. Stopped for user review before Phase 1.

## Script-quality overhaul — Phase 1 (2026-11-15) — scene budget + clip packer
- `src/clipPacker.js` (pure, 26 tests in `test/clipPacker.test.js`): `sceneBudget` (runtime → scenes ≈ runtime/15 s), `runtimeLine`/`sceneTimeLine`, `clampH3Duration` (4–15, previously unclamped), beat-aware `mergeBlocker`/`planPack`/`unpackableScenes` (≤2 facial beats per clip, same scene/location/cast, no dialogue, pacing cap tight 15 s / standard 12 s / loose off).
- `ScriptwriterPanel`: "Target runtime" picker (Auto/30/60/90 s; Guided + Full Auto, hidden in Source mode) replaces "Maximum number of scenes" with a scene budget; `duration_s` per scene (normalised 5–40); Phase 2 receives a per-scene time budget; the packer runs for every H3 run except Loose (was Full-Auto-tight only); a live "N clips · Ns · avg" note lists scenes still split and why; manual ⇄ Merge nudge now names the blocker.
- Prompts: Scriptwriter gets a TARGET RUNTIME rule (one dramatic unit per scene, but/therefore links, escalation, closing image) + `duration_s` in the schema; Director H3 now plans by time (prefer one 8–15 s clip per scene with internal [Shot N] cuts), "when in doubt split" restricted to SUBJECT LOCK triggers. Beat density rule untouched. `PACING_LINE` is now in seconds.
- Re-pack of the 30 stored films with the packer alone: 153 → 139 clips (avg 7.3 s). Small, because most clips are `performance` (1 beat each) and the 2-beat cap is deliberately kept; the bigger lever is the Director prompt/time budget, which needs a live run to measure.
- Not yet verified live (needs a writer model): Phase 1/2 output with runtime 60 s. `npm test` (628) and `vite build` pass.

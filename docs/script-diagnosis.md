# Script diagnosis — Scriptwriter output (Phase 0, 2026-11-15)

Data: all 30 Scriptwriter history entries that reached Phase 2 (`node eval/extract-script-baseline.mjs --list`); 3 read in detail (slim dumps in `eval/baseline/script-*.json`, gitignored).
Mordheim alley: **not available** (no run in history, reference images pending — `eval/inputs/mordheim-alley.md`).

## Aggregate numbers (30 films, 153 clips)
| Metric | Value |
|---|---|
| Median film | **1 scene, 3–5 clips, ~20–30 s total** |
| Films with >1 scene | 7 of 30 (all but one were Source-mode adaptations or user-raised caps) |
| Avg clip length | **6.6 s** (not 4 s) |
| Clips ≤5 s | 48 / 153 (31 %) |
| Clips ≥10 s | very few (a 15 s single-clip film is the outlier) |
| Avg clips / scene | 2.6 |
| Dialogue density | low (≈0.3 words/s on the sample) |

## Detail reads
- **"Der Zweite Atem"** (Full Auto, 1 scene, 4 clips, 29 s): a genuine reversal (fake kill → hand closes on ankle), but it is a *single gag*, not an arc; no hook/stakes/choice. The turn is carried by a 5 s insert clip.
- **"Plop! Der Brief"** (Source mode, 6 scenes, 11 clips, 80 s): faithful adaptation of a user-supplied letter. Scenes are vignettes ("and then she…"), each with a mood flip but no causal chain (no but/therefore); ends on contentment, no landing image chosen. 7 of 11 clips are `performance`; 2 clips per scene at 6–9 s.
- **A position-list prompt** (3 scenes, 9 clips, 53 s): scenes are variations on one action; only the last has an `emotional_turn` (a phone ring). Clips 5–7 s, a repeated action/performance/action pattern — the "list of actions" failure in its purest form, but it is driven by the *idea*, not the pipeline.

## Where granularity is decided (code evidence)
- **Phase 1 does not micro-split.** `SYSTEM_PROMPT_SCRIPTWRITER` (`src/constants.js:925–930`) says 10–40 s/scene, "ceiling, not a quota", UI default 1 scene (`ScriptwriterPanel.jsx:601`; Full Auto forces 1, l.1663).
- **Phase 2 splits clips.** `SYSTEM_PROMPT_DIRECTOR_H3` l.1082–1103: "usually 2–4 clips per scene", split complex moments into "2–4 second clips", SUBJECT LOCK "when in doubt split one clip too many", default insert clip per `emotional_turn`, "~4s for a complex beat". `PACING_LINE` (`ScriptwriterPanel.jsx:529`) states clips-per-scene (~2 / ~3), not seconds. Durations are never clamped (`duration || 7`, l.1155).
- The only deterministic packer is the tight-pacing merge (`isMergeEligible` l.1850), limited to establishing/action clips.

## Verdict on the handover's hypotheses
| Hypothesis | Result |
|---|---|
| Planning unit is clip length, not dramatic unit (Phase 2) | **Confirmed**: Phase 2 gets no per-scene time budget and is told to subdivide each scene. |
| Scripts fragment into ~4 s micro-scenes | **Partly rejected**: avg clip is 6.6 s; 31 % ≤5 s. The bigger issue is the *opposite scale*: typical output is a 1-scene, ~25 s film. A 60–90 s / 4–6 scene film (the handover target) only occurs when the user raises the cap or uses Source mode. |
| No craft: weak arc/causality/ending | **Confirmed**: Phase 1 has only a minimalism rule (one premise/turn/ending); no hook, but/therefore, ending-first, curve, stakes, choice, motif, signature image. Reversals appear mostly as one-line `emotional_turn` mood flips, not value reversals. |

## Implication for Phase 1 (to confirm with the user)
Clip packing alone will lift avg clip from ~6.6 s toward 8–12 s but will **not** fix story quality or the 1-scene default. The runtime/scene budget (60–90 s, 4–6 scenes) conflicts with today's "micro-film, 1 scene" Phase 1 prompt and default — that belongs in Phase 2, and the Phase 1 Director/packer work should be scoped accordingly.

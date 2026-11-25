# PLAN: Prompt Enhancer v2 — from "prompt expander" to "mini film-development pipeline"

Hand this file to Claude Code. Work through the phases in order. Do not skip Phase 0.

## 1. Context

- I have an existing prompt enhancer for **MiniMax H3 Ref2VA** (reference-to-video+audio), run inside ComfyUI (Pinokio, Windows 11). It can call local **Ollama** models and API models (e.g. Sonnet).
- Problem: outputs are shallow. Story, cinematic feel, dialogue and camera guidance are weak, even with a strong API model.
- Diagnosis: the current enhancer *expands* a prompt (adjectives, lighting, generic camera move). Nobody decides what the scene is about, who wants what, or what changes. A bigger model polishes that emptiness better but it stays empty.
- Direction: put **filmmaking craft first, H3 syntax last**. Split creative decisions (treatment, beats, shots, dialogue) from the mechanical translation into H3's format.
- Current real use case (use as the primary test case): a Matrix-style fight, **Witchhunter vs Skaven in a narrow Mordheim alley**, built from short scenes (about 4 s each) with two RefMods ("witchhunter", "skaven"), an alley background picture, and a **previz video used only for camera angles, positioning and timing**.

## 2. Goals

1. Every generated scene contains a real dramatic turn (a reversal), not just atmosphere.
2. Dialogue is short, in character, does work (threaten / deflect / reveal / reverse power), and fits the clip duration.
3. Camera guidance is motivated (tied to an emotional or informational purpose), varied in shot size, and limited to what H3 actually obeys.
4. Continuity across scenes (who has the advantage, injuries, prop positions, voices).
5. Final output is a valid H3 Ref2VA prompt in the official six-section format.
6. Cheap local models only do the mechanical last stage; strong models do the creative stages. Model routing is configurable per stage.

## 3. Non-goals

- No new video model integrations. No ComfyUI workflow changes unless Phase 0 shows the enhancer is wired in through a node that must change.
- Do not paste large copyrighted book excerpts into the repo. Distilled operational rules only, written in our own words.

## 4. Hard constraints from the H3 setup (do not violate)

- One text block: visuals + shot list + audio together.
- **Always include an explicit audio line.** Quoted dialogue gets voice + lip sync.
- H3 runs with BasicGuider only: **no CFG, no negative prompt**. Unwanted elements must be excluded through positive wording.
- For R2V, describe the *continuation from the reference image*, not a new scene.
- Ref2VA schema sections: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`.
- Label conventions: `<Picture N>`, `<Subject N>`, `<Video N>`; `(Sx)` speaker labels; the `[reference generation]` tag is required in the summary section.
- Duration: local runs are short (4 s scenes now; hosted API max 15 s). Multi-shot inside one generation uses "SHOT / CUT TO" style directions.
- Canonical references (check for updates, do not rely on memory): official H3 prompt guides on Hugging Face (`VIDEO_PROMPT_WRITING_GUIDE_ref_en.md` for R2V, `..._base_en.md` for others) and the official H3 agent skills at `github.com/MiniMax-AI/MiniMax-H3/tree/main/skills`. There is also a local skill `h3-ref2va-prompt-writer`; reuse its schema knowledge instead of re-deriving it.

## 5. Target architecture

```
user idea + character/scene inputs
        |
  [Stage 1] TREATMENT      (strong model, temp high)  -> treatment.json
        |
  [Stage 2] BEAT SHEET     (strong model)             -> beats.json (per scene)
        |
  [Stage 3] SHOT LIST      (strong or good local)     -> shots.json (per scene, incl. dialogue + audio beats)
        |
  [Stage 4] CRITIC/REVISE  (strong model, rubric)     -> pass/fail + fixes, loop max 2x
        |
  [Stage 5] H3 TRANSLATION (local Ollama OK, temp low)-> six-section Ref2VA prompt
        |
  [Stage 6] VALIDATOR      (deterministic code)       -> schema/label/length checks
```

State carried across scenes (`continuity.json`): location layout, who has the advantage, injuries/damage, prop positions, each character's voice sheet and physical tells, motifs.

Per-stage model routing in a config file (e.g. `models.yaml`), so I can swap local/API per stage without code changes.

## 6. Craft knowledge assets (separate files, loaded into stage prompts)

Store as small markdown files in the repo (suggest `craft/`), each 10–15 operational rules written in our own words. Stages load only what they need.

- `craft/story_in_short_clips.md`
  - A clip holds ONE dramatic turn: a value flips (winning->losing, confident->afraid, hunter->hunted). No reversal = rejected.
  - Start late (in medias res), skip setup.
  - Props carry meaning (one concrete, slightly unusual detail per scene).
  - Information gap (viewer knows something a character does not) creates tension.
  - Each scene's ending creates the next scene's problem.
- `craft/dialogue.md`
  - Word budget by duration (heuristic: about 2–3 words/s including pauses; a 4 s clip fits roughly 6–8 words. **Calibrate against real H3 outputs in Phase 5**).
  - Each line must do work: threaten, deflect, reveal, or reverse the power balance. No lines that describe what is visible.
  - Subtext, interruption, one-liners, answering a different question.
  - Per-character voice sheet: cadence, vocabulary, a physical tell. Included in every scene call.
  - Audio is storytelling: breath, footsteps on wet stone, a distant bell, silence before a hit. Give audio its own beats.
- `craft/camera.md`
  - Rule: the camera answers "what must the audience feel or know right now?". If no answer, lock off.
  - Emotion->camera lookup table (power: low angle + slow push; vulnerability: high angle, small in frame; dread: static wide with empty space where the threat enters; panic: handheld, cropped, short shots; intimacy/decision: close-up, shallow focus, stillness; fight geography: wide enough to read both fighters and the space).
  - Shot-size variety (wide -> medium -> close -> insert; never 3+ identical sizes in a row).
  - Coverage logic: 180-degree rule, screen direction, eyelines, cut on action, reaction shots.
  - One camera move per shot.
  - Banned defaults: "cinematic", "dynamic camera", reflexive "slow dolly in".
  - **Only prescribe moves that the H3 camera test (Phase 5) showed H3 follows.** Everything else goes into previz or editing.
- `craft/action_fights.md`
  - Fight = story: opening advantage, reversal, environmental trick (alley narrowness, falling debris), a cost (a hit that changes how someone moves), decisive beat.
  - Geography clarity beats speed; show cause and effect; slow-motion moments land harder against grounded action.
  - When a previz video is supplied, it owns camera/position/timing. The enhancer adds the emotional and narrative layer and must not contradict the previz.
- `craft/clichés_banned.md` — list of overused phrases and moves to forbid, extended over time.
- `craft/exemplars/` — 3–5 director-style shot breakdowns (short, dense, in our own words), used as few-shot examples. Start with Mordheim-style fight scenes.
- Optional `craft/sources.md` — short list of book/film references the rules were distilled from (Murch's priority order for edit decisions: emotion > story > rhythm > eye-trace > screen-plane > 3D space; Bruce Block's contrast/affinity; Katz's shot staging; McKee's value change). References only, no quoted passages.

## 7. Data schemas (define as JSON Schema or Pydantic; validate every stage output)

- `treatment`: premise, tone, visual motif, per-character `{want, obstacle, voice_sheet, tells}`, sequence arc (reversals per scene).
- `beat`: `{scene_id, intention, obstacle, outcome, reversal, advantage_after, duration_s}`.
- `shot`: `{shot_id, size, camera_height, lens_feel, move (0..1 only), purpose (required, one sentence), action, dialogue [{speaker, line, words}], audio_beats[]}`.
- `continuity`: updated after every scene.
- Validators: dialogue words <= budget(duration); `purpose` non-empty; shot-size variety rule; total shot durations == scene duration.

## 8. Phases

### Phase 0 — Audit (no code changes yet)
- [ ] Locate the existing enhancer in this repo/system. Document: entry point, current system prompt(s), model calls, how it's invoked from ComfyUI, config, output format. Write `docs/audit.md`.
- [ ] Collect 5 representative inputs (include the Mordheim alley scene 1) and the current outputs as a **baseline set** in `eval/baseline/`.
- [ ] Identify what already exists that can be reused (H3 schema handling, validators, UI).
- **Acceptance:** `docs/audit.md` exists and I can read in one page how the current enhancer works. Stop and show me before Phase 1 if the architecture is very different from section 5.

### Phase 1 — Craft assets + schemas
- [ ] Create `craft/*.md` files from section 6 (our own words, operational rules, short).
- [ ] Implement schemas + validators from section 7 with unit tests.
- [ ] Add `models.yaml` for per-stage routing; default: Stages 1–4 -> API model, Stage 5 -> local Ollama.
- **Acceptance:** schemas and validators have passing tests; craft files reviewed by me.

### Phase 2 — Stages 1–3 (treatment, beats, shot list)
- [ ] Implement each stage as an isolated, individually runnable step with structured JSON output.
- [ ] Anti-shallowness mechanics: stage 1 produces 3–5 distinct concepts, a selector picks one against the rubric; banned-cliché list injected; every scene must name its reversal.
- [ ] Temperature per stage (high for concepts, low for translation); configurable.
- [ ] Continuity state updated after each scene and passed into the next.
- **Acceptance:** for the Mordheim test case, produce a 4-scene sequence where each scene has a named reversal, dialogue within budget, and a justified camera purpose per shot.

### Phase 3 — Critic loop + validator
- [ ] Rubric (pass/fail items): reversal present; every shot has a purpose; dialogue within word budget and doing work; shot-size variety; audio used as a beat; no banned clichés; continuity consistent; does not contradict previz notes.
- [ ] Critic returns per-item verdicts plus concrete fixes; revise at most 2 loops; log all verdicts.
- **Acceptance:** critic demonstrably rejects the baseline-style shallow output on at least 3 of 5 baseline inputs when fed through the new rubric.

### Phase 4 — Stage 5 H3 translation + Stage 6 validator
- [ ] Translator takes `shots.json` + `continuity.json` + reference labels and emits the six-section Ref2VA prompt. Input is structured, so a small local model should suffice; test with the local Ollama models I already run and report which ones pass.
- [ ] Deterministic validator checks: all six sections present, label conventions, `[reference generation]` tag, explicit audio line, no negative-prompt phrasing, quoted dialogue has `(Sx)` speaker labels.
- [ ] Preserve existing ComfyUI integration so the output drops into the current workflow unchanged.
- **Acceptance:** validator passes on all outputs; one real H3 render per test scene produced and viewed by me.

### Phase 5 — Evaluation with H3 itself
- [ ] **Camera obedience grid:** same scene, vary only the camera phrase (low angle, high angle, push-in, pull-out, handheld, static wide, pan, tracking, etc.). Output a table of what H3 follows reliably / partially / ignores -> feeds `craft/camera.md` (the allowed-moves list).
- [ ] **Dialogue calibration:** same line at 4 s / 6 s / 8 s with different word counts; find the real word budget where lip sync stays clean -> update `craft/dialogue.md` and the validator.
- [ ] **A/B:** old enhancer vs new pipeline on the 5 baseline inputs; pairwise comparison by me (blind, shuffled) plus an LLM judge as a cheap secondary signal.
- **Acceptance:** report in `docs/eval.md` with the tables, the chosen budgets, and the A/B result.

### Phase 6 — Packaging
- [ ] CLI + config docs; a `README` with a how-to for adding exemplars and banned clichés.
- [ ] Optional: a "previz notes" input field so I can attach camera/positioning/timing info from my previz video as structured text that the pipeline must respect.
- [ ] Optional later: reuse the same pipeline for the SUSS product turntable video (different craft file set: product reveal, light, rhythm instead of fight choreography).

## 9. Working rules for Claude Code

- Keep context small: work one phase at a time; summarize at the end of each phase in `docs/progress.md`.
- Ask before changing the ComfyUI side or deleting existing files.
- Verify claims about H3 behavior with actual renders, not assumptions. Record results in `docs/`.
- Prefer small, testable steps; commit after each phase.
- If the audit shows a different architecture than assumed in section 5, propose adjustments before building.

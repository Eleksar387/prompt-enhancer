# HANDOVER: Script quality overhaul for the H3 prompt enhancer

Audience: Claude Code. This builds on `PLAN-h3-prompt-enhancer-v2.md` (staged pipeline, craft assets, H3 evaluation). Read that first if it is in the repo. This document adds the *script-level* problems found after the first minimal version was built and tested.

## 1. Problems observed (after running the first version)

1. **Bad story arc.** Scripts are lists of actions ("and then... and then..."), not causal chains with a build, a reversal and a landing.
2. **Micro-scenes.** The script breaks every scene into tiny sub-scenes (about 4 s each). MiniMax H3 handles scenes up to about 15 s well, so this fragmentation is not required by the model.
3. **Weak adherence to filmmaking best practice.** Dramatic turns, motivated camera, rhythm, dialogue that does work, visual motifs and strong endings are missing or generic.

## 2. Root cause (working hypothesis, verify in Phase 0)

The planning unit is the **clip length**, not the **dramatic unit**. If the pipeline thinks in 4 s chunks, the LLM fills each chunk with an action. That produces "and then" sequences. Fix: plan top-down and treat clip length as a final packing step.

Target hierarchy:

```
Story -> Sequences -> Scenes (one dramatic unit each) -> Shots -> Clips (technical packing, <= 15 s)
```

- **Scene** = one place, one conflict, one turn (a value flips: winning->losing, confident->afraid, hunter->hunted).
- **Shot** = one camera setup with a stated purpose.
- **Clip** = one H3 generation (target 8–15 s). A clip may contain 2–4 shots using "SHOT / CUT TO" directions.
- A 60–90 s film should come out as roughly **4–6 scenes**. The model must be told this budget up front.

## 3. Principles to encode (craft knowledge)

Write these as short operational rules in our own words (no long quotes from books).

### Story
- One idea per film: a single strong "what if", situation or irony.
- Choose a structure deliberately from a library (see section 5). Examples: compressed three-act (about 25/50/25); Pixar spine ("Every day... until one day... because of that... until finally..."); Kishotenketsu (setup, development, unexpected twist, reconciliation, no conflict required); rule-of-three escalation; bookend/circular; standoff (long build, very fast payoff).
- Causality test between every pair of beats: the link must be "but" or "therefore", never "and then".
- Design the **ending first** (last image + emotional landing), then work backwards.
- Hook in the first seconds. Within the first 10–15% the viewer must know who wants what and what is in the way.
- Enter late, leave early.

### Character and stakes
- Character is revealed by choices under pressure with a cost (run or stand, mercy or kill). Every film needs at least one such choice.
- The viewer needs someone to root for, or a fascinating antagonist. Give the protagonist an early moment of competence or vulnerability.
- Stakes must be visible (in frame, or through a ticking clock, or shrinking options).

### Tension and rhythm
- Prefer dramatic irony (viewer knows more than the character) over pure surprise.
- Pacing is contrast. No constant intensity. Fights need stillness, a held beat after a hit, breathing room.
- Plan an **emotional curve** before writing (Vonnegut-style shapes: man in a hole, Cinderella, etc.). A flat stretch is a defect.

### Visual, sound, editing
- Editing is the primary storytelling tool: juxtaposition, match cuts, cut on action, sound bridges. Priority for edit decisions: emotion > story > rhythm > eye-trace > screen-plane/3D continuity.
- Visual motif + colour script: colour, light and framing change with the story (e.g. tighter framing as pressure rises).
- Sound as story: silence before impact, a recurring sound motif, diegetic cues.
- One theme so the ending reads as an argument.
- Genre contract: know the conventions, subvert exactly one.
- Define one **signature image** (the shot people remember) per film.

### AI-video-specific: turn limits into style
- Complex two-person physical contact is hard for current video models. Use classic implication: show before, sound, reaction, aftermath (not the blow); silhouettes, POV, inserts, cutaways, off-screen action.
- Longer scenes (up to 15 s) + internal cuts are preferred over many 4 s clips.
- Keep characters consistent via reference subjects; do not plan shots that depend on perfect identity across fast cuts.

## 4. Illustration (invented, for shape only)

Alley fight, bad: 12 four-second micro-actions (draws, lunges, parries...).
Alley fight, better: 4 dramatic scenes:
1. **Dread** — hunter enters the alley and senses he is not alone (about 15 s, mostly stillness and sound).
2. **Competence** — first contact; he dominates; audience enjoys it.
3. **Reversal** — lantern dies / more enemies appear; he is now the prey.
4. **Choice and cost** — decisive decision with a price; ends on the signature image.

## 5. Target pipeline changes

Replace or extend the current script generation with the following front end. Keep the existing H3 translation and validator stages unchanged unless Phase 0 shows otherwise.

1. **Logline + ending generator.** Produce 5 candidate loglines (who wants what, what's the obstacle, what's the ticking clock) each with a candidate final image. Present to the user to pick (human-in-the-loop; this is the highest-leverage taste decision). Support a non-interactive mode that auto-selects via the critic.
2. **Structure selector.** A library of templates (standoff, hunter-becomes-prey, rule-of-three escalation, bookend, Kishotenketsu, Pixar spine, compressed three-act) as small files in `craft/structures/`. Select one per project (user override allowed).
3. **Emotional curve plan.** Before writing scenes, output a target curve (tension/emotion per beat, 1–10) with the planned reversal points.
4. **Scene planner (dramatic units).** Output scenes with: intention, obstacle, turn, outcome, value before/after, causal link to previous ("but"/"therefore"), approx duration, and the signature-image placement. Enforce the scene-count budget from total target runtime.
5. **Shot planner.** Per scene: shots with size, camera height, one move at most, purpose (one sentence), implied-vs-shown decision for violence, dialogue (word-budgeted), audio beats. Include planned cut points.
6. **Clip packer.** Deterministic code (not an LLM) that packs scenes/shots into clips of 8–15 s (configurable max, default 15). Rules: never split a scene across clips unless it exceeds the max; prefer one clip per scene; list internal cuts as "SHOT / CUT TO". Report any scene that cannot be packed.
7. **Critic / "audience" pass.** A different model call that reads the script cold and reports: per-beat tension/emotion ratings (compare with target curve), flat stretches, missing reversal, "and then" links, unmotivated shots, dialogue that only describes, weak ending, hook strength in the first 3 s. Max 2 revise loops, all verdicts logged.
8. **Writers'-room roles (optional config).** Writer, director, editor, sceptical audience as separate prompts/personas. Make this switchable so the cost can be compared against a single-call version.
9. Existing stages: H3 six-section translation + deterministic validator (unchanged; consume the clip packer's output).

All stage outputs are structured JSON validated against schemas; model routing per stage stays in `models.yaml` (strong model for 1–5 and 7, local Ollama only for H3 translation).

## 6. Phases

### Phase 0 — Diagnose (no code changes)
- [ ] Take 3 scripts the current pipeline produced (include the Mordheim alley sequence). For each, produce `docs/script-diagnosis.md`: scene count, average scene duration, number of true reversals, number of "and then" links, dialogue words vs duration, shot-size variety, ending quality.
- [ ] Find where in the code the 4 s scene granularity is decided (prompt text, constants, schema, validator). Document it.
- [ ] Confirm or reject the root-cause hypothesis in section 2 with evidence from the code/prompts.
- **Acceptance:** diagnosis doc exists; show me before building.

### Phase 1 — Hierarchy + clip packer
- [ ] Introduce the scene -> shot -> clip hierarchy in schemas.
- [ ] Implement the deterministic clip packer with unit tests (scene longer than max, several short scenes, internal cut markers).
- [ ] Remove the hard-coded 4 s scene granularity; clip max is a config value.
- **Acceptance:** an existing script re-packs into far fewer, longer clips without changing its content.

### Phase 2 — Story front end
- [ ] Implement logline+ending generator, structure library, emotional-curve plan, scene planner.
- [ ] Add craft files: `craft/story_structure.md`, `craft/structures/*.md`, `craft/emotional_curve.md`, update `craft/camera.md`, `craft/dialogue.md`, `craft/action_fights.md`, `craft/implication_over_depiction.md`, `craft/clichés_banned.md`.
- [ ] Interactive pick of logline (CLI prompt) + non-interactive fallback.
- **Acceptance:** for the Mordheim brief, 3 different loglines with different structures, each producing 4–6 scenes with named turns and "but/therefore" links.

### Phase 3 — Critic / audience pass
- [ ] Implement the critic with the checks in section 5.7. Rate per-beat tension, compare with the target curve.
- [ ] Ensure the critic runs on a different model or at least a fresh context from the writer.
- **Acceptance:** it flags the baseline (old) scripts as failing on at least arc and micro-scene fragmentation, and passes at least one new script.

### Phase 4 — Evaluation corpus (calibration)
- [ ] Break down 8–10 well-regarded short films / fight scenes (user can add titles) into beats: duration, scene count, reversals per minute, average shot length, ending type. Store as data in `eval/corpus/` with our own summaries only (no copied text).
- [ ] Use the numbers as targets in the scene planner/critic and 2–3 summaries as few-shot exemplars.
- **Acceptance:** `docs/corpus-stats.md` with the table; planner/critic read targets from it.

### Phase 5 — A/B and H3 verification
- [ ] Old vs new scripts for the same 3 briefs, rendered through H3 (existing translation stage). Blind pairwise comparison by me; LLM-judge as a secondary signal.
- [ ] Verify with real renders that 8–15 s multi-shot clips with "SHOT / CUT TO" come out coherent; record the maximum shots per clip that H3 handles well.
- [ ] Verify the implied-violence technique (cutaway/aftermath) works better than depicted contact.
- **Acceptance:** `docs/eval.md` with results and updated limits (max shots per clip, usable camera moves).

### Phase 6 — Packaging
- [ ] README: how to add structures, exemplars, banned clichés; how to run each stage alone; config reference.
- [ ] Optional: previz-notes input (camera/positions/timing text from the previz video) that the shot planner must respect.

## 7. Working rules

- One phase at a time; summarize in `docs/progress.md`; commit after each phase.
- Prefer deterministic code for anything that is a rule (packing, budgets, validators). Use LLMs only for creative decisions and judgment.
- Do not assume H3 behaviour: verify with renders and record results.
- Ask before changing the ComfyUI side or deleting existing files.
- If Phase 0 contradicts the hypothesis or the architecture in this document, stop and propose adjustments first.

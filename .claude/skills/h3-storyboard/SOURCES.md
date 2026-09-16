# Sources and verification status

Every entry in this skill is drawn from real production runs, not copied from documentation.
Neither the official nor community skills cover shot breakdown and performance (see below).

## Verified (with controlled comparison)

| Finding | Verification method | Date |
|---|---|---|
| **Beat density is the main factor in performance success/failure** | Ref2VA 243-frame three-version comparison, fixed seed, **variables isolated one at a time**:<br>A: one shot, 9 beats, no dialogue → 37–42 dB (face doesn't move)<br>B: three shots, one beat each, no dialogue → 22–23 dB (expression lands)<br>C: three shots, one beat each, plus `<d>` → 19 dB (larger magnitude)<br>**A→B changes only the shot structure, B→C changes only one line of dialogue** | 2026-08-26 |
| **Size needs to be expressed as a cropping relationship** | Same shot, four versions: fraction phrasing 45%/52%, cropping-relationship phrasing 69%/70% | 2026-08-25 |
| **Leave aspect/shape ratio to the reference image** | Text specifying 1.75:1 produced a 0.96 square across three consecutive generations; feeding a blank reference image worked on the first try | 2026-08-25 |
| **Mouth shape fills the whole shot, doesn't close at the next beat** | Dialogue tagged at 3.400, next beat at 4.000; frame-by-frame mouth PSNR showed motion starting at 2.17s and continuing to the video's end at 5.12s, 2.96s total | 2026-08-26 |
| **Cap on how large a full-body subject can be in a portrait frame is ~50–60%** | A character roughly as wide as tall measured 52%/61%/61% in 9:16; cropping the bottom to show only the upper body measured 69–70% in another episode using the same trick | 2026-08-27 |
| **If what a character should be looking at isn't in frame, they'll look at the camera** | Occurred in three separate shots: looking down at a small object on a table, speaking to someone crouching, looking sideways at a TV. The first two attempts to fix it by "adding motion" (looking up, turning the head) both failed because that motion conflicted with the story's requirements; switching the camera position to the direction the character was already looking worked all three times | 2026-08-28 |
| **The last mile of performance is solved in editing** | Two shots each got four prompt rewrites without fixing the pacing problem (a 1.35s-slow reaction; a transition 3.7s apart that was too smooth); inserting a cutaway shot to cover the gap and pull the two emotional ends closer together fixed both, one edit each | 2026-08-28 |
| **A deliberate design change can also be hidden inside closed eyes** | Within the same shot — eyes close at 2.25s, and by 3.75s when they open the eye design has already switched to match a different pinned reference image, with no cut in between. This overturns the earlier conclusion that "a design change requires a cut to switch it" | 2026-08-27 |
| **When a reference image has a "half-lidded" variant, writing "eyelids come down" gets pulled toward half-lidded** | Elsewhere in the same production run, writing `eyelids come down again ... close all the way` still resulted in the half-lidded design instead of fully closed | 2026-08-27 |
| **Hiding an emotional transition inside closed eyes works** | Writing it as A→B produced an unnatural transition on render; changing it to "eyes close → brows release while eyes are closed → eyes open already in the new state" gave a clean transition confirmed frame by frame. Side finding: the cut specified in the spec didn't actually happen — closing the eyes alone was enough | 2026-08-27 |
| **Unit-based distances get ignored** | Writing `a hand's width short of the base`, the rendered liquid still flooded right up to the base anyway. Fixed by rewriting it as "a gap of dry wood as wide as the figurine is tall between the two" | 2026-08-26 |
| **Liquid spreads onto a surface it shouldn't touch** | Prompt wrote `coffee glistening around its base` + `light glowing through the wet film`; render showed the coffee stain spreading across the figurine's entire face. Fixed by rewriting it as "the stain stops a hand's width away" + explicitly stating the front surface stays completely dry | 2026-08-26 |
| **Collisions and liquid volume are impossible** | Asking H3 to shoot "a hand knocks over a cup, coffee spreads and floods a small object": the hand never made contact with the cup throughout, the coffee volume far exceeded a cup's worth and kept flowing, the edge was hard like a sticker, and the key contact moment never happened. Changed to "an arm sweeps across frame → cut → the already-happened result" and it worked | 2026-08-26 |
| **`<d>` reallocates shot time** | A 243-frame, four-shot video differing only by one line of VO dialogue (same seed, same reference images, same `ref_image_size=max`). The shot carrying dialogue went from 55→84 frames (spec called for 74); the adjacent shot dropped from 56→42 frames. Peak facial-motion change went from 30.2→28.5 dB | 2026-08-26 |
| **`ref_audio_0` can't be used as a sound source** | A 6-second real-voice timbre reference generating a new line of dialogue (wiring confirmed correct): pitch 192.8→222.2 Hz, range 175→117 Hz, accent still drifted, had an electronic/synthetic quality. But mouth shape and breathing rhythm were correct.<br>⚠️ The first test was accidentally wired to `ref_video_audio_0`, so the reference had no effect at all and threw no error; this data was only obtained after rewiring correctly | 2026-08-26 |
| **Tail collapse** | All three of episode 00's G1/G4/G5 generations collapsed 1.2–1.7 seconds before the clip's end | 2026-08-24 |
| **Static-image alpha fade needs `-loop 1`** | The overlay didn't appear at all and threw no error; adding `-loop 1` fixed it | 2026-08-25 |


## Partially verified (plausible but not isolated)

| Rule | What was observed | Why it doesn't count as verified yet |
|---|---|---|
| **Dialogue sacrifices background continuity** | Both dialogue versions (`match`, `max`) lost the background character outside the window in Shot 4, and the floor-to-ceiling window degraded into an ordinary window; the no-dialogue version kept both | The no-dialogue version only ran once — n=1 vs n=2. The direction is consistent, but generation variance can't be ruled out |


| Item | Known | Unknown |
|---|---|---|
| **"Nothing changes" bleeds outward** | The A group, which had that line, had a shot where nothing moved at all | **The A group also had a second variable — "nine beats crammed into one shot"** — the two were never tested separately. The B/C groups that removed that line also split the shot at the same time.<br>Right now all that can be said is "don't write it" is the safe practice, not that it's the primary cause |

| **A→B state transitions get interpolated into a "rubber face"** | Writing `the crease between her eyebrows smooths out and releases` produced an unnatural emotional transition on render. Attributed to the model cross-dissolving between the start and end states | The phenomenon was observed and the sentence pattern identified, but the "hide it inside closed eyes" fix hasn't been verified on a real render yet |

## Unverified (inferred, awaiting real-world testing)

- **Where exactly the beat-count ceiling sits** — only known that 9 beats gets flattened and 1 beat works; nothing in between has been tested
- Whether the emotional physiological order (brow→eye→mouth) is actually executed in that sequence — the three-version comparison only verified "did it move," not "was the order correct"
- Large-body alternatives for silent characters — not yet tested on a real render (though the B group proved a character can perform without dialogue, so this item is less urgent)
- How perceptually visible the increment `<d>` produces (23 dB → 19 dB) actually is — only has the numbers, no blind test has been done
- Whether swapping in a longer/shorter audio reference sample, or multiple samples, improves timbre transfer — only one 6-second sample has been tried
- **Whether per-shot second ranges help** — starting 2026-09-16, `SYSTEM_PROMPT_MINIMAX_H3` appends a second range derived from the existing cut timestamps after every `[Shot N]` (e.g. `[Shot 1] (0.00–4.00s)`, `At 4.00s, ... [Shot 2] (4.00–10.00s)`), on the theory that it makes timing more explicit and shot boundaries more controllable. This is a brand-new addition with no controlled experiment yet (ranges vs. no ranges, all other variables held fixed) verifying whether it actually improves coherence or controllability — do not cite it as a verified conclusion. What IS known to be ignored by H3 is fine-grained timestamps *within* a shot (see "mouth shape fills the whole shot" above — a dialogue cutoff timestamp was not honored), but that finding measured sub-second precision *inside* a shot, not the boundary *between* shots (rule 5's increasing cut timestamps already depend on the latter being honored) — these are different claims, and one cannot stand in as verification for the other

## Coverage by official and community sources (checked 2026-08-26)

| Source | Shot breakdown | Expression/performance |
|---|---|---|
| MiniMax's official `h3-prompt-writing` skill | ❌ | ❌ |
| MiniMax's official prompt-writing guides (both the base and ref originals) | ❌ | ❌ |
| `alperktt/awesome-minimax-h3-skills` | ⚠️ Only "deriving shot count from a duration table" | ❌ |
| `instann/minimax-h3-director` | ⚠️ Listed on the roadmap, not implemented | ❌ |
| `teskor-hub/minimax-h3-skill` | ❌ | ❌ |
| the local `minimax-h3` skill | ❌ | ❌ |

⚠️ **Note a common mix-up**: online claims that "H3 is good at microexpressions, eyebrow twitches, jaw shifts" etc. are actually describing **Hailuo 02/2.3 — the hosted API model**, not the H3 open-weights model. The hosted version also has MiniMax's own prompt rewriter in front of it; the ComfyUI path here has none — text goes straight into the tokenizer verbatim.

## Provenance

All of this comes from the actual production of a serialized short drama (9:16 portrait, Ref2VA, local ComfyUI generation, ~60 seconds / 6 segments / 1100–1400 frames per episode). None of it is inferred from documentation.

## Revision log

**2026-08-26**: The first version attributed the main cause to the `<d>` dialogue tag — **that was wrong**. The failing and succeeding versions at the time changed two things at once (shot structure + dialogue), without isolating them. Only after re-running "shorter shots split apart, but without adding `<d>`" was it confirmed: **the main cause is beat density; dialogue is only a contributing factor**.

This entry is kept because it's a lesson in itself — **change only one variable at a time, or the attribution can end up backwards**.

**2026-08-26 (later the same day)**: The first `ref_audio_0` test was **wired to the wrong node** — it connected to `ref_video_audio_0` instead. The reference had no effect at all, and ComfyUI **threw no error**, so that data looked normal but actually tested nothing. The conclusion only held after rewiring correctly.

The other side of the same lesson: **no error doesn't mean it's wired correctly**.

**2026-09-14**: The app's `SYSTEM_PROMPT_MINIMAX_H3` (and Manual mode's template) changed to no longer use the `<d>` tag — the dialogue format changed from `<d>[Language] text</d>` to `[Language] "text"`. This was a deliberate choice made by the user **after** seeing both the "`<d>` reallocates shot time" and "dialogue sacrifices background continuity" records above — **not** because those records were disproven or contradicted by new evidence. In other words: the effect of `<d>` on shot time allocation is **presumed to still exist** for now; it's just that under the new format there has been no controlled experiment yet verifying whether the same effect occurs, or at what magnitude. If `<d>` is reintroduced later, or if you want to confirm whether the new format has the same time-stealing effect, the two records above are still valid and require re-testing before drawing conclusions — don't assume that removing the tag by itself solved the background-continuity problem.

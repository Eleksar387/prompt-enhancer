// MiniMax H3 writer prompt for small local models (profile 'compact', see
// src/modelProfiles.js — currently Cydonia-24B). The full V2 prompt (h3Prompt.js) is
// ~12k characters of dense rules; a 24B model at Q2 loses the output structure under
// that load. This one is short, shows the output as a literal skeleton with «…»
// placeholders (no sample sentences, so nothing can be copied into the output), and
// ends with a NEVER list that mirrors the failures seen in real Cydonia output.
// Section order is additionally enforced in code (src/h3Normalize.js).

import {
  header, SECTION_T2VA, SECTION_I2VA, SECTION_L2VA, SECTION_FL2VA,
  ALIGNMENT_PREFACE, CLOSING, R3A,
} from './h3Prompt'

const RULES = `RULES
1. Write in English, present tense, in playback order. Never leave a non-English scene or sound word in the output: translate it ("grillen" becomes "crickets chirping"). Only spoken dialogue (with a [Language] tag) and visible on-screen text may be quoted in another language.
2. Start with ONE sentence naming the visual style (live-action, 2D-animated, 3D CG, …) plus light and palette. Then the shots.
3. Shots: about 1 shot for 4–8 seconds, 2–3 for 9–12, 3–4 for 13–15. Shot 1 is written "[Shot 1] (0.00–4.00s) …". Every later shot starts "At 4.00s, the camera cuts to [Shot 2] (4.00–8.00s) …". Ranges are contiguous and the last one ends at the target duration. Always square brackets for [Shot N] and angle brackets for <Picture N>.
4. Each shot has ONE camera move, always stated: Zoom In/Out, Push In/Pull Out, Pan Left/Right, Truck Left/Right, Tilt Up/Down, Pedestal Up/Down, Arc Shot, Tracking Shot, Static Shot — with "small" or "large" amplitude and "slow" or "fast" speed. If no move has a job, write a locked-off frame positively. Never write a list of forbidden moves.
5. One small visible turn, not a story. Spend words on action, camera and sound; the references already fix faces, outfits and rooms.
${R3A.replace(/^3a\./, '6.')}
7. Emotion is shown as action (breath, shoulders, eyes, hands), never named. Never write that a character "holds still" or that nothing changes. End the last shot while something is still moving; never describe a hold, a pause or the final seconds.
8. Dialogue is tagged [English] "…" (or the "Primary language:") with the quoted words only inside the quotes. A shot that carries a line contains only that delivery. Use the supplied spoken dialogue word for word. Without supplied dialogue write NO speech, EXCEPT when an Audio voice-timbre reference is present: then write ONE short in-character line (6–12 words) for that subject.
9. overall_soundscape: 1–4 sentences, ambience and physical sounds only, never dialogue; tie one sound to a moment. Use the user's sound notes. non_diegetic_music: audience-only score in 1–3 sentences of instrumentation, tempo and rhythm; write exactly N/A when the user's music note is "none", "silence" or no music.
10. Keep the whole prompt under 6,000 characters. Cut adjectives before cutting action, camera or the ending.`

const REF_SKELETON = `OUTPUT FORMAT — Ref2VA (the images arrive as "Image N — role: …, preservation: …: <caption>"; optional "Audio N" voice lines)
Write exactly these six sections, in this order, each starting with its label on its own line, one blank line between sections. No "---" lines, no markdown, no extra fields, no text before the first label or after the last section.

subject_definitions:
«one line for EVERY "Image N" and every "Audio N" given, in order — count them first; Location, Style and Pose images need a line too, see SUBJECT LINES»

summary:
«[reference generation] or [reference generation + audio reference] then one or two plain sentences on what the video shows»

retention_analysis:
«one line for EVERY label defined in subject_definitions, including each <Picture N>, see RETENTION LINES»

detailed_description:
«style sentence, then [Shot 1] (0.00–Xs) … with the cut and range format from rule 3»

overall_soundscape:
«rule 9»

non_diegetic_music:
«rule 9»

SUBJECT LINES
- Person / identity image: "<Subject 1> is the «role» from <Picture N>, preserving «3–6 comma-separated concrete attributes copied from the caption and the user's note»." Copy age, hair, build exactly as the caption or note states; never invent or change them.
- Wardrobe image: "<Subject M> is the garment from <Picture N>: cut, fabric, colour, fit" and say the wearer's face and body are NOT carried over.
- Location or Style image: a standalone line "<Picture N> is the location reference for «place», guiding «what it contributes»." It gets NO <Subject>.
- Pose / Composition image: "<Picture N> is a storyboard reference for [Shot k], defining viewpoint, placement and shot order." It gets NO <Subject>.
- Audio line: "<Audio N> is the voice-timbre reference for <Subject k> (S1). Only timbre, pitch and delivery are referenced, never the original words."
- <Picture N> always keeps the number of its "Image N". <Subject M> numbers only images that define a subject.

RETENTION LINES — one per label defined above, same order, exactly this shape:
<Subject 1> (appears in [Shot 1]): «marker» - «short reason»
<Picture 2> (location reference for [Shot 1]): «marker» - «short reason»
<Audio 1>: reference - «short reason»
«marker» is ONLY one of: fully_preserved, partially_preserved, attribute_transfer, weak_reference — copy the word in parentheses after "preservation:" on that image's line (Inspiration → weak_reference; never write "inspiration" or "strong"). Audio uses only "reference". Cite only [Shot N] markers that exist in detailed_description. Never write a speaker ID (S1…) in this section.

detailed_description: 150–350 words. Name each subject by its <Subject N> label, with at most a few words of appearance at first mention. Cite <Picture N> where a framing or place applies.`

const REF_NEVER = `NEVER — each of these has broken real outputs:
- Never start with "integrated_multimodal_description:" and never output a field of another mode. The first characters are "subject_definitions:".
- Never put "---", "***", a code fence or a heading between sections.
- Never write "Image 1", "Image 2" … in the output. Write <Picture N>.
- Preservation words or markers (strong, weak_reference, partially_preserved …) appear ONLY in retention_analysis, never in the other sections.
- Never invent a marker such as "strong_preservation".
- Never write judgments or filler: "emotionally resonant", "immersive", "intimate", "perfectly synchronized", "precisely 8 seconds", "adhering to the user's request", "cinematic".
- Never repeat the same sound in more than one section; sounds belong in overall_soundscape only (the Audio line states timbre only).
- Never contradict yourself (a "serene" face with a "wide smile"). Pick one.`

const modeSection = (frameMode) => {
  if (frameMode === 'ref') return `${REF_SKELETON}\n\n${REF_NEVER}`
  const modes = { last: [SECTION_L2VA], firstlast: [SECTION_FL2VA], firstmidlast: [SECTION_FL2VA] }[frameMode] || [SECTION_T2VA, SECTION_I2VA]
  const preface = modes.some(m => m !== SECTION_T2VA) ? `${ALIGNMENT_PREFACE}\n\n` : ''
  return `OUTPUT FORMAT\n\n${preface}${modes.join('\n\n')}\n\nNo "---" lines, no markdown, no extra fields.`
}

export function buildH3SystemCompact(frameMode) {
  const modes = frameMode === 'ref' ? ['Ref2VA']
    : frameMode === 'last' ? ['L2VA']
    : (frameMode === 'firstlast' || frameMode === 'firstmidlast') ? ['FL2VA']
    : ['T2VA', 'I2VA']
  return [header(modes), RULES, modeSection(frameMode), CLOSING].join('\n\n')
}

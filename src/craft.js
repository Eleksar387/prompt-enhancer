// Creative-direction rules for MiniMax H3 prompts (main pipeline only).
//
// SYSTEM_PROMPT_MINIMAX_H3 (constants.js) is about FORMAT and H3 PHYSICS. It says
// nothing about what makes a clip worth watching, so a thin idea came out as a
// thin prompt. This block adds that taste layer on top. It is plain text on
// purpose — edit the rules here, no code involved. The h3-storyboard physics rules
// (3a, 4, 5, 6, 9–13) stay authoritative: if a craft idea can't be done within
// them, change the idea, never the physics rule.
//
// Appended by craftSystemPrompt(); switched by the "Creative craft rules"
// checkbox in ⚙ Backend (cfg.craftRules, default on). Off = the old prompt,
// byte for byte. The Scriptwriter's per-clip prompts do NOT use this block —
// there the director has already decided the story.

export const CRAFT_CLICHES = [
  'cinematic', 'dynamic camera', 'epic', 'stunning', 'breathtaking', 'masterpiece',
  'a sense of', 'palpable tension', 'electric atmosphere', 'time seems to slow',
  'dramatic lighting', 'slow push-in on the face (as a reflex)', 'sparks fly',
]

export const CRAFT_BLOCK = `

CREATIVE DIRECTION (the physics and format rules above always win; this layer decides what is worth filming)
The goal is ONE interesting moment, not a story. Do not try to fit a plot into the clip.
Banned words, anywhere in the prompt including the style opening: ${CRAFT_CLICHES.join('; ')}. Use the plain, exact word instead.
C1. ONE TURN. Give the clip a single small shift that the viewer can see — attention moves, power tips, a mask slips, a plan goes slightly wrong, something is noticed. The clip should end in a different state than it started, even if only by a degree. The turn is never just the main action itself (undressing, posing, walking in): it is what happens around or because of it — a noticed presence, a mistake, an interruption, a reaction, a change of mind. A clip that only holds a pose or a mood while the light changes has no turn.
C2. A THIN IDEA IS AN INVITATION. When the user gives little (a place, a pose, a few words, or nothing), invent ONE specific moment that fits the references, instead of padding with atmosphere. Choose the less obvious but still plausible option: what is she doing a second before the obvious thing? Never override anything the user did write.
C3. ONE CONCRETE DETAIL. Include one specific, physical, slightly unexpected detail that belongs to this character and place — a prop used the wrong way, an odd gesture, how a surface catches light, what the hands do when the face is busy. Specific beats pretty: "a thumbnail scraping at a chipped tile edge" over "soft, intimate atmosphere".
C4. CAMERA HAS A JOB. Every camera choice answers: what must the viewer feel or notice right now? Close and still for decision or intimacy; wider with empty space where something will enter for dread; handheld and cropped for panic or urgency; low angle for power, high angle for vulnerability. If you cannot name the job, use a static shot. At most one camera move per shot, and vary the shot size when there are several shots (no three identical sizes in a row). Do not write "cinematic" or "dynamic camera", and do not default to a slow push-in.
C5. DIALOGUE DOES WORK. Spoken lines (written or invented) are short and in character: they threaten, deflect, tease, reveal, answer a different question, or flip who has the upper hand. A line never describes what the viewer can already see. Avoid the stock invitation or command line ("come here", "touch me", "I'm waiting for you" and their translations) — write what THIS character would say to THIS person at this exact moment, with a reason behind it: a tease, a dry remark, a half-question, something that answers what just happened. Keep it to what fits comfortably in the duration (roughly 2–3 words per second, including pauses) and give each speaker a distinct cadence. Silence and a breath before the line are part of it.
C6. SOUND IS A BEAT. In overall_soundscape / the audio line, give at least one specific sound tied to a moment in the clip (a breath caught, a bare foot on wet tile, a zipper, a distant door) rather than only a general ambience. Say where it lands.
C7. SHOW, DON'T LABEL. Convert any mood word into something the camera can see or the microphone can hear (this extends rule 9 to the whole prompt, not just the face).
C8. AVOID THE STOCK PHRASES (see the banned-word list at the top). Prefer the plain, exact word.
C9. NO COMMENTARY. The output describes the video only. Never write notes to the reader or the model about the prompt itself ("stated clearly:", "the scene shows explicit …", "this is the detail", "for emphasis"). Do not repeat a framing fact twice; say it once, as part of the action.
C10. SPEND WORDS ON ACTION, NOT ON RE-DESCRIBING REFERENCES. Everything the references already fix (face, outfit, room) is cited by label, not repeated; the freed words go to the turn, the detail, the camera job and the sound.
Before writing, silently decide: the turn, the one detail, the camera job, the sound. Then write only the finished H3 prompt. These rules and their labels (C1–C10, "the turn", "the concrete detail", "the camera job") are private instructions: never name, quote or label them in the output — the prompt just describes what happens.`

// `base` = the system prompt the target would normally send. Only the MiniMax H3
// writer gets the block, and only when the setting is on (undefined = on).
export const craftSystemPrompt = (base, targetId, enabled = true) =>
  enabled && targetId === 'minimax_h3' ? base + CRAFT_BLOCK : base

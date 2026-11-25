// H3 prompt-writing notes added 2026-11-25 from user-supplied third-party observations
// (not yet measured in-house — see .claude/skills/h3-storyboard/SOURCES.md). One source of
// truth for BOTH the legacy SYSTEM_PROMPT_MINIMAX_H3 (constants.js) and buildH3SystemV2
// (h3Prompt.js), so the two can't drift apart.

// Appended to rule 4 (camera).
export const R4_FACING = ` After a camera move, restate which way the subject faces and where they sit in frame — H3 does not track facing on its own, so say what a camera would see.`

// Appended to rule 5 (cuts / shot marks).
export const R5_REAL_CUTS = `
   SHOT MARKS ARE FOR REAL CUTS. A timed [Shot N] mark tends to make the picture jump, so use one only where the content really changes (new place, subject, viewpoint or time). Continuous action in one place is written as sentences inside ONE shot, never split into shots just to separate moments. A hard cut between near-identical stills often renders as a fade — cut only when the next shot looks clearly different.`

// Appended to rule 6 TIMING (dialogue).
export const R6_LINE_LAST = ` Put the spoken line LAST in its shot, with the action before it and nothing long left over after it — with time to spare after a line, H3 may keep talking in the same voice.`

// New rules 13a / 13b — inserted between rule 13 and rule 14.
export const R13A = `13a. NOTHING EXISTS UNLESS A LINE SAYS SO. Birds hang still until a line names them, traffic is absent until written, and a car leaves without the person if getting in was never written. Write every action whose consequence you need (the person gets in, then the car pulls away). This is the opposite risk to rule 13: name what must appear, and never name what must not.`
export const R13B = `13b. CONTENT H3 DRAWS BADLY FROM A REFERENCE. Doors and handles, trips and falls, sitting down, someone vanishing into an effect, and an explosion behind a runner usually fail. Stage around them as rule 13 does: start the subject already seated, cut to the settled aftermath, or keep the door off-screen. Product shots, mood pieces, big weather and quiet two-person scenes render best. Faces are weakest at small size — prefer a medium shot over a distant face, and do not describe fine facial detail the frame cannot show.`

// Added to the Ref2VA detailed_description guidance only (needs reference pictures).
export const REF_PLACE_AND_LOOK = `KEEPING THE PLACE, THE LOOK AND THE SUBJECT: when a picture of a person is given and the place must differ from that picture's own background, name the place in every shot and add the line "The background of <Picture N> is not kept." — otherwise the picture's own background tends to come back after a few seconds, and longer clips drift back to it unless the prompt names the place. A written non-photographic look (pencil, watercolor, claymation) falls back to a photo after a couple of shots, so repeat it briefly in every later shot. Describe only what the pictures show: do not invent unseen sides or parts (a cat seen from the front grows a tail in side views) — keep such views out of frame or state the feature from the caption.`

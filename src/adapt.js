import { TARGETS, STYLE_OPTIONS, spokenLanguageDirective, caps, ROLE_NONE } from './constants'
import { loraInstruction } from './loras'

// Destination targets for "Adapt to text-only prompt" — every writer-capable
// visual target. scriptwriter has no single-call writer path; dramabox is a TTS
// delivery prompt where folding image descriptions is meaningless.
export const ADAPT_TARGETS = Object.values(TARGETS)
  .filter(t => t.id !== 'scriptwriter' && t.id !== 'dramabox')
  .map(t => ({ id: t.id, label: t.label }))

// The style / creativity / dialogue / "things to avoid" suffix appended to the
// writer user message. Extracted verbatim from enhance() so the main pipeline is
// byte-identical; the adapt panel passes forceNonImageWording so the creativity
// clause never talks about "recreating the reference" (there is no reference).
// `spokenLang` is the spoken-language id, or null for a target that produces no
// speech — its presence is the gate, so the caller (which knows the target's
// show.spokenLang flag) decides, not this function. `loras` is the active LoRA
// list (see src/loras.js) and `targetId` is only needed to shape the LoRA
// instruction for H3's field layout.
export function buildStylePart({
  style, creativity, targetType, showDialogue, dialogue = '', delivery = '', negative = '',
  forceNonImageWording = false, spokenLang = null, loras = null, targetId = '',
}) {
  const styleObj = STYLE_OPTIONS.find(s => s.id === style)
  const creativityText = creativity === 'balanced' ? ''
    : (!forceNonImageWording && targetType === 'image')
      ? (creativity === 'faithful'
          ? '\n\nImage fidelity: FAITHFUL — recreate the reference closely; keep its subject, composition and palette, deviating only slightly.'
          : '\n\nImage fidelity: LOOSE — treat the reference as rough inspiration only. Invent freely, take creative risks, and prioritize the chosen style over literal resemblance.')
      : (!forceNonImageWording && targetType === 'text')
      ? (creativity === 'faithful'
          ? '\n\nEmotional latitude: FAITHFUL — keep the delivery grounded and true to a plain, literal reading of the idea; minimal embellishment.'
          : '\n\nEmotional latitude: LOOSE — push the delivery further; take bigger risks with intensity, arc, and phrasing.')
      : (creativity === 'faithful'
          ? '\n\nCreative latitude: FAITHFUL — keep the proposed motion minimal and literal to the scene.'
          : '\n\nCreative latitude: LOOSE — be genuinely inventive and surprising with the action, framing and atmosphere (within the model\'s motion limits); don\'t settle for the obvious motion.')
  return (styleObj && styleObj.id !== 'auto'
    ? `\n\nStyle / mood — let this genuinely shape the mood and treatment, but keep the scene believable and the subject intact unless the style itself calls for breaking realism (e.g. surreal). Favor clever, well-judged choices over crude exaggeration: ${styleObj.label} — ${styleObj.hint}`
    : '')
    + creativityText
    // With a spoken language pinned, "EXACT words" would contradict the translate
    // instruction that follows it — so the wording shifts to "these are the words,
    // rendered in that language".
    + (showDialogue && dialogue.trim()
      ? `\n\nSpoken dialogue — ${spokenLang
          ? 'these are the words to be spoken; put them in quotation marks, in the language named below (translate them if they are not already in it)'
          : 'include these EXACT words in quotation marks'}, broken into short phrases with physical acting beats between them${delivery.trim() ? `; delivery/voice: ${delivery.trim()}` : ''}:\n"${dialogue.trim()}"`
      : '')
    // targetType 'text' is DramaBox, the one target whose whole output is spoken
    // performance rather than a description of one.
    + (spokenLang ? spokenLanguageDirective(spokenLang, { wholePrompt: targetType === 'text' }) : '')
    + loraInstruction(loras, targetId)
    + (negative.trim()
      ? `\n\nThings to avoid — the user does not want these in the result: ${negative.trim()}. Do not depict or describe them; if one is a plausible default the model might add by mistake, actively steer the prompt away from it by describing the correct/positive alternative rather than using a negation. Only add a negative-prompt line or field for these terms if the OUTPUT FORMAT rules above already define one for this target — never invent a negative-prompt field or line that isn't part of this target's defined output format.`
      : '')
}

const FL_RELABEL = [
  [/^FIRST→MID CHANGE:/i, 'What changes from opening to midpoint:'],
  [/^MID→LAST CHANGE:/i, 'What changes from midpoint to close:'],
  [/^FIRST FRAME:/i, 'Opening state:'],
  [/^MID FRAME:/i, 'Midpoint state:'],
  [/^LAST FRAME:/i, 'Closing state:'],
  [/^CHANGE:/i, 'What changes over the shot:'],
]

// Strip caption scaffolding so the description reads as plain visual detail the
// writer should fold into a text-only prompt.
export function foldCaption(caption, sourceFrameMode, { hasDialogue = false } = {}) {
  const text = (caption || '').trim()
  if (!text) return ''

  if (sourceFrameMode === 'ref') {
    const out = []
    let sawAudio = false   // H3 takes up to two Audio N lines — fold to one note, not one per line
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd()
      const img = line.match(/^Image\s+\d+\s+—\s+role:\s+(.+?),\s+preservation:\s+.+?:\s*(.*)$/)
      if (img) { out.push(`${img[1]}: ${img[2]}`); continue }
      const note = line.match(/^\s+Requested use of this reference:\s*(.*)$/)
      if (note && out.length) {
        out[out.length - 1] = `${out[out.length - 1]} (intended use: ${note[1]})`
        continue
      }
      if (/^Audio\s+\d+\s+—\s+voice-timbre reference/i.test(line)) {
        if (hasDialogue && !sawAudio) { out.push('Voice: reference timbre only — natural delivery.'); sawAudio = true }
        continue
      }
      out.push(line)
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  if (sourceFrameMode === 'firstlast' || sourceFrameMode === 'firstmidlast') {
    return text.split('\n').map(raw => {
      const line = raw.trimEnd()
      for (const [re, label] of FL_RELABEL) {
        if (re.test(line)) return line.replace(re, label)
      }
      return line
    }).join('\n')
  }

  return text
}

// ── per-reference caption reading (History gallery) ─────────────────────────
// A ref-mode entry's `caption` is ONE shared block — one "Image N — role: X,
// preservation: Y (marker): <caption>" line per reference image, built by
// captionImages() (src/App.jsx) and already parsed the same way by
// foldCaption() above. Editing used to write BACK into this block (splicing
// just one line) — but a regex match against a semi-structured blob is
// fragile, and a non-matching line (any entry already damaged by an earlier
// version of this same fix, or any block that just doesn't parse) made the
// splice a **guaranteed silent no-op**: the user's edit was discarded and
// the original text sent back unchanged, while the UI still reported
// success. Saving a reference image's caption now always writes directly to
// that image's own `refImages[i].caption` field instead (a plain
// array-index update in App.jsx's `saveRefImageCaption` — see there) — this
// function is READ-ONLY now, used purely as a legacy-display fallback for an
// image that hasn't been individually re-saved yet (including one whose
// shared block is already corrupted — that block is simply never written
// through again, corrupted or not).
const REF_IMAGE_LINE_RE = /^Image\s+(\d+)\s+—\s+role:\s+(.+?),\s+preservation:\s+(.+?):\s*(.*)$/

// Image N's own caption text within a ref-mode block, or null if that image's
// line isn't present (a malformed/legacy block, or N out of range) — the
// caller falls back to an empty starting caption in that case.
export function extractRefImageCaption(fullText, imageIndex1based) {
  for (const line of (fullText || '').split('\n')) {
    const m = line.match(REF_IMAGE_LINE_RE)
    if (m && Number(m[1]) === imageIndex1based) return m[4]
  }
  return null
}

// The single, shared way to resolve what caption text to show for one
// reference image under a given role. Priority: the new structural
// `im.captions[roleId]` map (role-specific "🤖 Describe with AI" runs write
// only here) → the legacy flat `im.caption` string, but ONLY for the image's
// own assigned role (that field was never role-aware — it's whatever the
// original captioning pass wrote) → the even-older shared-block extraction
// above, same own-role-only restriction → empty. Never writes anything.
// Used by both HistoryImageGallery.jsx (the multi-role info panel) and
// HistoryPanel.jsx (the plain history-card editor) so a save made through
// either one is never shown as stale/reverted by the other.
export function resolveRefCaption(im, roleId, blockText, refImageIndex) {
  if (im?.captions && im.captions[roleId] != null) return im.captions[roleId]
  const ownRole = im?.role || ROLE_NONE
  if (roleId !== ownRole) return ''
  if (im?.caption) return im.caption
  return refImageIndex != null ? (extractRefImageCaption(blockText, refImageIndex) || '') : ''
}

const sceneOr = (scene, fallback) => (scene && scene.trim() ? scene.trim() : fallback)

// ── per-target field blocks, shared by both message builders ───────────────
// A target with caps.audioFields / caps.ratioPicker writes those fields into its
// prompt, and BOTH a fresh generation and an adapt run have to describe them the
// same way. They were written out twice, identically, in two functions — so adding
// an H3 field meant remembering to add it in both, with nothing to catch a miss.
// The two messages are still separate (they are different documents with different
// block orders and different wording), but these pieces are not.

// The ambient-sound and audience-music pair. Both "not specified" fallbacks tell
// the model to decide rather than leaving the field blank, which is what stops H3
// emitting an empty soundscape.
export const audioFieldsPart = (soundscape = '', music = '') =>
  `\n\nAmbient / diegetic sound (overall_soundscape): ${(soundscape || '').trim() || 'not specified — invent restrained ambience that fits the scene.'}`
  + `\n\nAudience-only music (non_diegetic_music): ${(music || '').trim() || 'not specified — decide whether music serves this scene; if not, use N/A.'}`

// A concrete aspect ratio, named with its note so the model knows the orientation.
export const ratioLinePart = (ratio) =>
  (ratio ? `Aspect ratio: ${ratio.label} (${ratio.note})\n` : '')

const VISUAL_BLOCK_VIDEO = 'Visual details to incorporate (from a reference image used earlier; there is NO reference image now — establish them in the opening phrase, then describe what happens over time; do not call them a "frame"):'
const VISUAL_BLOCK_H3 = 'Visual details to incorporate (these came from reference image(s) used in an earlier generation; there is NO reference image this time — describe them fresh as part of the prompt, never call them a "frame" or "reference"):'

// The writer user message for an adapt run. Mirrors the matching text-only branch
// of runWriter(). If a folded caption is given (image-based source) it goes in as
// "visual details to incorporate"; if not (text-only source), the original prompt
// itself becomes the source to re-express for the new target.
export function buildAdaptUserText({
  destTarget, scene = '', foldedCaption = '', sourceLabel = '',
  duration = '', aspectRatio = null, stylePart = '', lengthPart = '',
  audio = null, originalPrompt = '',
}) {
  const dest = TARGETS[destTarget]
  const hasCap = !!(foldedCaption && foldedCaption.trim())
  const op = (originalPrompt || '').trim()
  const from = sourceLabel || 'a different model'
  const originalBlock = !op ? ''
    : hasCap
      ? `\n\nFor reference only — the prompt produced for the original generation (${from}). Match its level of detail and creative intent, but this is a DIFFERENT target and output format, so do not copy its structure or wording:\n${op}`
      : `\n\nSOURCE PROMPT — written for ${from}. Re-express its full content — subject, action, camera, mood, everything it establishes — as a prompt for THIS target, in THIS target's own format and conventions. Keep what it says; change only how it's said:\n${op}`
  const material = hasCap ? 'the visual details below' : 'the source prompt below'

  if (caps(destTarget).structured) {
    const ratioLine = ratioLinePart(aspectRatio)
    const scenePart = `Scene / action:\n${sceneOr(scene, `No separate scene note — draw the moment from ${material}.`)}`
    const visualPart = hasCap ? `\n\n${VISUAL_BLOCK_H3}\n${foldedCaption}` : ''
    const audioPart = audioFieldsPart(audio?.soundscape, audio?.music)
    return `MODE: T2VA\n\n${ratioLine}Target duration: ${duration}\n\n${scenePart}${visualPart}${audioPart}${stylePart}${lengthPart}${originalBlock}`
  }

  if (dest.type === 'image') {
    const scenePart = `Image description / subject:\n${sceneOr(scene, `Base the image on ${material}.`)}`
    const visualPart = hasCap ? `\n\nReference image description:\n${foldedCaption}` : ''
    return `${scenePart}${visualPart}${stylePart}${lengthPart}${originalBlock}`
  }

  // ltx / ltx_guide / kling
  const scenePart = `Basic scene description:\n${sceneOr(scene, `No separate scene note — draw the motion from ${material}.`)}`
  const visualPart = hasCap ? `\n\n${VISUAL_BLOCK_VIDEO}\n${foldedCaption}` : ''
  return `Target duration: ${duration}\n\n${scenePart}${visualPart}${stylePart}${lengthPart}${originalBlock}`
}


// ── the generate-mode user message ─────────────────────────────────────────
// The MiniMax H3 frameMode -> MODE mapping, shared by the AI writer path
// (buildWriterUserText below) and Manual mode's zero-AI assembly (App.jsx's
// enhance()) — both need the identical ternary, so it lives in one place.
// `hasImg` is deliberately a separate argument from "is there a first-frame
// image loaded", not derived from it here: the AI path passes whether vision
// actually produced a description (vision can fail independently of an image
// being loaded), while Manual mode (no vision step) passes image presence
// directly — each call site decides which question it's answering.
export function h3ModeFor(frameMode, hasImg) {
  return frameMode === 'last' ? 'L2VA'
    : frameMode === 'firstlast' ? 'FL2VA'
    : frameMode === 'ref' ? 'Ref2VA'
    : hasImg ? 'I2VA' : 'T2VA'
}

// The writer's user message for a fresh generation, moved here verbatim from
// runWriter() so it sits beside buildAdaptUserText — the two are the same job for
// the same targets, and keeping them in one file is what makes their overlap
// visible (and snapshot-testable) instead of letting them drift apart unnoticed.
//
// `frameDescription` is the assembled vision caption, or null for a text-only run.
// `stylePart` / `lengthPart` are the shared suffixes from buildStylePart() and
// PROMPT_LENGTH_INJECT. `hasImg` distinguishes I2VA from T2VA, and is not the same
// question as "is frameDescription set" — vision can fail.
export function buildWriterUserText({
  target, targetType, frameMode, scene = '', duration = '',
  frameDescription = null, hasImg = false,
  ratio = null, soundscape = '', music = '',
  stylePart = '', lengthPart = '',
}) {
  if (caps(target).structured) {
    const mode = h3ModeFor(frameMode, hasImg)
    // A ratio is named only when nothing else fixes it: a text-only run, or
    // reference mode where the references do not set the frame. Every image-driven
    // mode inherits the input's ratio and must not be told to override it.
    const ratioLine = (frameMode === 'single' && !hasImg) || frameMode === 'ref'
      ? ratioLinePart(ratio)
      : 'Aspect ratio: derived from the input image(s) — do not override it.\n'
    const frameBlock = frameMode === 'last'
      ? (frameDescription ? `LAST FRAME (already established — the clip must end here; do not restate it, only describe the plausible path that leads to it):\n${frameDescription}\n\n` : '')
      : frameMode === 'firstlast'
      ? (frameDescription ? `FIRST FRAME and LAST FRAME (already established — do not restate their static contents, only describe the transition):\n${frameDescription}\n\n` : '')
      : frameMode === 'ref'
      ? `Reference images:\n${frameDescription}\n\n`
      : frameDescription ? `FIRST FRAME (already established — do not restate it; only describe what happens over time):\n${frameDescription}\n\n` : ''
    const scenePart = scene.trim()
      ? `Scene / action:\n${scene}`
      : frameMode === 'last' ? 'No description provided — propose a plausible action path that leads naturally to the last frame.'
      : frameMode === 'firstlast' ? 'No description provided — infer the natural motion that carries the scene from the first frame to the last.'
      : frameMode === 'ref' ? 'No description provided — propose a fitting scene using the reference images above.'
      : hasImg ? 'No scene description provided — propose ONE fitting cinematic moment of motion that suits the frame.'
      : 'No scene description provided.'
    const audioPart = audioFieldsPart(soundscape, music)
    return `MODE: ${mode}\n\n${frameBlock}${ratioLine}Target duration: ${duration}\n\n${scenePart}${stylePart}${audioPart}${lengthPart}`
  }

  if (targetType === 'image') {
    const ref = frameDescription ? `Reference image description:\n${frameDescription}\n\n` : ''
    const scenePart = scene.trim()
      ? `Image description / subject:\n${scene}`
      : (frameDescription ? 'No extra description — base the FLUX prompt on the reference description above.' : 'No description provided.')
    return `${ref}${scenePart}${stylePart}${lengthPart}`
  }

  // A text target's whole output is the performance; the scene stands alone.
  if (targetType === 'text') {
    return `${scene.trim()}${stylePart}${lengthPart}`
  }

  if (frameMode === 'firstmidlast') {
    const frames = frameDescription ? `Frames (already established — do not restate their static contents):\n${frameDescription}\n\n` : ''
    const scenePart = scene.trim()
      ? `Transition description:\n${scene}`
      : 'No description provided — infer the natural motion that carries the scene through both transitions.'
    return `MODE: First-mid-last-frame interpolation. The clip begins on the FIRST frame, passes through the MID frame at approximately the halfway point, and ends on the LAST frame; describe the two-phase motion and camera as one continuous arc with a clear beat at the mid frame.\n\n${frames}Target duration: ${duration}\n\n${scenePart}${stylePart}${lengthPart}`
  }

  if (frameMode === 'firstlast') {
    const frames = frameDescription ? `Frames (already established — do not restate their static contents):\n${frameDescription}\n\n` : ''
    const scenePart = scene.trim()
      ? `Transition description:\n${scene}`
      : 'No description provided — infer the natural motion that carries the scene from the first frame to the last.'
    return `MODE: First-to-last-frame interpolation. The clip begins exactly on the FIRST frame and ends exactly on the LAST frame; describe the motion and camera that bridge them.\n\n${frames}Target duration: ${duration}\n\n${scenePart}${stylePart}${lengthPart}`
  }

  // single / last — one frame, or none at all
  const frame = frameDescription ? `FIRST FRAME (already established — do not restate it; only describe what happens over time):\n${frameDescription}\n\n` : ''
  const scenePart = scene.trim()
    ? `Basic scene description:\n${scene}`
    : (frameDescription ? 'No scene description provided — propose ONE fitting cinematic moment of motion that suits the frame.' : 'No scene description provided.')
  return `${frame}Target duration: ${duration}\n\n${scenePart}${stylePart}${lengthPart}`
}

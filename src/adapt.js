import { TARGETS, STYLE_OPTIONS } from './constants'

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
export function buildStylePart({
  style, creativity, targetType, showDialogue, dialogue = '', delivery = '', negative = '',
  forceNonImageWording = false,
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
    + (showDialogue && dialogue.trim()
      ? `\n\nSpoken dialogue — include these EXACT words in quotation marks, broken into short phrases with physical acting beats between them${delivery.trim() ? `; delivery/voice: ${delivery.trim()}` : ''}:\n"${dialogue.trim()}"`
      : '')
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
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd()
      const img = line.match(/^Image\s+\d+\s+—\s+role:\s+(.+?),\s+preservation:\s+.+?:\s*(.*)$/)
      if (img) { out.push(`${img[1]}: ${img[2]}`); continue }
      const note = line.match(/^\s+Requested use of this reference:\s*(.*)$/)
      if (note && out.length) {
        out[out.length - 1] = `${out[out.length - 1]} (intended use: ${note[1]})`
        continue
      }
      if (/^Audio\s+1\s+—\s+voice-timbre reference/i.test(line)) {
        if (hasDialogue) out.push('Voice: reference timbre only — natural delivery.')
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

const sceneOr = (scene, fallback) => (scene && scene.trim() ? scene.trim() : fallback)

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

  if (destTarget === 'minimax_h3') {
    const ratioLine = aspectRatio
      ? `Aspect ratio: ${aspectRatio.label} (${aspectRatio.note})\n`
      : ''
    const scenePart = `Scene / action:\n${sceneOr(scene, `No separate scene note — draw the moment from ${material}.`)}`
    const visualPart = hasCap ? `\n\n${VISUAL_BLOCK_H3}\n${foldedCaption}` : ''
    const audioPart = `\n\nAmbient / diegetic sound (overall_soundscape): ${(audio?.soundscape || '').trim() || 'not specified — invent restrained ambience that fits the scene.'}`
      + `\n\nAudience-only music (non_diegetic_music): ${(audio?.music || '').trim() || 'not specified — decide whether music serves this scene; if not, use N/A.'}`
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

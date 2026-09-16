// Pure, non-AI syntax/structure checker for MiniMax H3 output — both
// AI-generated (main pipeline, Scriptwriter Ref2VA/T2VA clips) and, as a
// calibration oracle, Manual mode's own deterministic assembleManualH3()
// output (see test/h3PromptCheck.test.js). Exists because the writer LLM's
// adherence to SYSTEM_PROMPT_MINIMAX_H3's required field-label skeleton
// (constants.js ~1508-1633) is model-dependent: a weaker/smaller model can
// return fluent, tag-correct prose that simply omits every field label, which
// MiniMax H3 cannot parse. No AI call here — regex/string checks only.
//
// The field-skeleton check (required labels present, in order) is the one
// that matters and is high-confidence — it is what actually failed in the
// case that motivated this module. Everything else here is a warning, never
// an error: an over-strict checker trains the user to ignore the badge.

import { findMalformedTags, parseShots, parseShotLabelUsage, numberSubjects } from './manualH3'

const BASE3 = ['integrated_multimodal_description:', 'overall_soundscape:', 'non_diegetic_music:']
const REF2VA_LABELS = ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']

const REQUIRED_LABELS = { T2VA: BASE3, I2VA: BASE3, L2VA: BASE3, FL2VA: BASE3, Ref2VA: REF2VA_LABELS }

const MAX_CHARS = 7000

// Anchored at line-start, never a bare substring search. The broken output
// that motivated this module contains "non_diegetic_music" mid-sentence in
// plain prose ("The non_diegetic_music swells faintly under her words…") — a
// substring check would false-pass exactly the case this exists to catch.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const labelIndex = (text, label) => {
  const m = new RegExp(`^\\s*${escapeRe(label)}`, 'm').exec(text)
  return m ? m.index : -1
}

function checkLabelSkeleton(text, labels) {
  const errors = []
  const positions = labels.map(label => ({ label, index: labelIndex(text, label) }))
  for (const { label, index } of positions) {
    if (index === -1) errors.push(`Missing required field "${label}".`)
  }
  let lastIndex = -1
  let lastLabel = null
  for (const { label, index } of positions) {
    if (index === -1) continue
    if (lastIndex !== -1 && index <= lastIndex) {
      errors.push(`"${label}" appears before "${lastLabel}" — expected order: ${labels.join(' → ')}`)
    }
    lastIndex = index
    lastLabel = label
  }
  return errors
}

// Loose, presence-based match for the mode-specific opening sentence — the
// exact wording varies slightly by shot number (see manualH3.js's
// assembleI2VA/L2VA/FL2VA), so this checks for the fixed phrases rather than
// a byte-exact template.
function checkFirstLine(text, mode) {
  const trimmed = (text || '').trim()
  if (mode === 'T2VA') {
    return trimmed.startsWith('integrated_multimodal_description:')
      ? [] : ['Output must start with "integrated_multimodal_description:" — found something else first.']
  }
  if (mode === 'Ref2VA') {
    return trimmed.startsWith('subject_definitions:')
      ? [] : ['Output must start with "subject_definitions:" — found something else first.']
  }
  if (mode === 'I2VA') {
    const ok = /For the target video, at 0\.00 seconds/.test(trimmed) && /<Picture 1>/.test(trimmed)
      && /\[Shot \d+\]/.test(trimmed) && /is fully referenced/.test(trimmed)
    return ok ? [] : ['Output must begin with the I2VA alignment sentence ("For the target video, at 0.00 seconds… <Picture 1> (from [Shot N]) is fully referenced.").']
  }
  if (mode === 'L2VA') {
    const ok = /How the reference pictures align with the target video/.test(trimmed) && /<Picture 1>/.test(trimmed)
      && /aligns with the/.test(trimmed) && /mark of the target video/.test(trimmed)
    return ok ? [] : ['Output must begin with the L2VA alignment sentence ("How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.").']
  }
  if (mode === 'FL2VA') {
    // Deliberately unbracketed — the one exception to the [Shot N]/<Picture N>
    // bracket rule (constants.js:1531-1539) — checked for literally.
    const ok = /How the reference pictures align with the target video/.test(trimmed)
      && /Picture 1 \(from Shot 1\)/.test(trimmed) && /Picture 2 \(from Shot/.test(trimmed)
    return ok ? [] : ['Output must begin with the FL2VA alignment sentence ("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark…; Picture 2 (from Shot N) aligns with the S.SS-second mark…") — note this one line is deliberately unbracketed.']
  }
  return []
}

const checkFence = (text) => /^```/.test((text || '').trim())
  ? ['Output is wrapped in a markdown code fence — should be plain text.'] : []

// Ref2VA cross-check: every <Subject N>/<Picture N> used in the text should
// have a matching reference image, and every supplied reference should be
// mentioned somewhere. Adapted from validateManualH3's Ref2VA branch
// (manualH3.js) — same logic, applied to generated rather than typed text.
function checkRefCrossReference(text, refImages) {
  const warnings = []
  const entries = numberSubjects(refImages || [])
  const { usage } = parseShotLabelUsage(text)
  for (const label of Object.keys(usage)) {
    const [kind, numStr] = label.split(' ')
    const num = Number(numStr)
    const known = kind === 'Picture'
      ? entries.some(e => e.pictureN === num)
      : entries.some(e => e.subjectM === num)
    if (!known) warnings.push(`Text references <${label}>, but no reference image defines it.`)
  }
  for (const e of entries) {
    const label = e.subjectM ? `Subject ${e.subjectM}` : `Picture ${e.pictureN}`
    if (!usage[label] || !usage[label].length) {
      warnings.push(`Reference image for <${label}> is never mentioned in the generated text.`)
    }
  }
  return warnings
}

// `mode` is one of T2VA/I2VA/L2VA/FL2VA/Ref2VA. `refImages`/`refAudios` are
// only used for the Ref2VA cross-check. `ok` reflects errors only — warnings
// never flip the badge from green, or it would rarely show green at all.
export function checkH3Prompt(text, { mode, refImages = [] } = {}) {
  const body = text || ''
  if (!body.trim()) return { ok: false, errors: ['Output is empty.'], warnings: [] }

  const labels = REQUIRED_LABELS[mode] || BASE3
  const errors = [
    ...checkFence(body),
    ...checkLabelSkeleton(body, labels),
    ...checkFirstLine(body, mode),
  ]

  const warnings = []
  for (const f of findMalformedTags(body)) {
    warnings.push(`Found "${f.found}" — MiniMax H3 expects exact "${f.suggestion}".`)
  }
  const shots = parseShots(body)
  if (!shots.length) {
    warnings.push('No [Shot N] markers found anywhere in the output.')
  } else {
    const nums = shots.map(s => s.n)
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] <= nums[i - 1]) {
        warnings.push(`Shot numbers are not strictly increasing (found [Shot ${nums[i]}] after [Shot ${nums[i - 1]}]).`)
        break
      }
    }
  }
  if (mode === 'Ref2VA') warnings.push(...checkRefCrossReference(body, refImages))
  if (body.length > MAX_CHARS) {
    warnings.push(`Output is ${body.length} characters — over the ~${MAX_CHARS}-character guideline.`)
  }

  return { ok: errors.length === 0, errors, warnings }
}

// "Manual mode" for the standalone MiniMax H3 pipeline — the user writes the
// story/shot breakdown themselves, directly in H3's own inline tag syntax
// ([Shot N], <Subject N>, <Picture N>, [Language] "…", (Sk)), and this module
// deterministically wraps it into a schema-correct H3 prompt with ZERO AI
// calls: no vision captioning, no writer LLM. It reuses only what's already
// captured with zero AI — each reference image's `role`/`preserve`/`note`
// (MinimaxRefPanel.jsx) plus the typed soundscape/music/duration.
//
// Every shape below is anchored to SYSTEM_PROMPT_MINIMAX_H3 (src/constants.js,
// currently ~1282-1582) — the same schema the writer LLM is taught to
// produce, so this module's output is byte-compatible with what a human
// reviewing an AI-mode result already expects, just assembled by code instead
// of a model. Pure — no React, no fetch — same spirit as workspace.js /
// adapt.js / loras.js, and tested the same direct input -> exact output way
// (test/manualH3.test.js).
//
// Deliberate limitation: unlike AI mode, this NEVER folds two references into
// one <Subject N> (SYSTEM_PROMPT_MINIMAX_H3's "unambiguously the same person"
// judgment call needs a caption/context read this module doesn't have) — every
// non-pose reference gets its own Subject number. Flag this to the user in the
// UI copy as a visible, deliberate divergence from AI-mode output.

import { MINIMAX_H3_PRESERVE_OPTIONS } from './constants'

// ── tag parsing ──────────────────────────────────────────────────────────
// Pure text scanning — the user is expected to write the tags themselves
// (taught via an in-app cheat-sheet), so "which shot is this label in" is a
// mechanical lookup, not a judgment call.

// Every [Shot N] marker's span. A marker's own "[Shot N]" text counts as
// inside its own shot (matches how a reader would read it); `end` is the next
// marker's start, or the text's length for the last one.
export function parseShots(text) {
  const body = text || ''
  const re = /\[Shot (\d+)\]/g
  const marks = []
  let m
  while ((m = re.exec(body))) marks.push({ n: Number(m[1]), start: m.index })
  return marks.map((mk, i) => ({ n: mk.n, start: mk.start, end: i + 1 < marks.length ? marks[i + 1].start : body.length }))
}

// Every <Subject N>/<Picture N> occurrence, keyed by canonical label ("Subject 1",
// "Picture 2"), mapped to the sorted-unique [Shot N] numbers whose span contains
// it. An occurrence before the first [Shot N] marker (or when there are none at
// all) is bucketed under shot 0 — callers treat a 0-only list as "unplaced".
export function parseShotLabelUsage(text) {
  const body = text || ''
  const shots = parseShots(body)
  const shotNumbers = [...new Set(shots.map(s => s.n))]
  const usage = {}
  const re = /<(Subject|Picture)\s+(\d+)>/g
  let m
  while ((m = re.exec(body))) {
    const label = `${m[1]} ${m[2]}`
    const shot = shots.find(s => m.index >= s.start && m.index < s.end)
    const n = shot ? shot.n : 0
    if (!usage[label]) usage[label] = []
    if (!usage[label].includes(n)) usage[label].push(n)
  }
  for (const k of Object.keys(usage)) usage[k].sort((a, b) => a - b)
  return { shotNumbers, usage }
}

// Speaker-ID bindings the user typed themselves, e.g. "<Subject 2> (S1)".
// First occurrence per subject wins.
export function parseSubjectSpeakers(text) {
  const body = text || ''
  const out = {}
  const re = /<Subject\s+(\d+)>\s*\((S\d+)\)/g
  let m
  while ((m = re.exec(body))) {
    const subj = Number(m[1])
    if (!(subj in out)) out[subj] = m[2]
  }
  return out
}

// Near-miss tag forms H3's own parser would choke on — wrong case, a missing
// or doubled space, a missing bracket. Reported for the user to fix, never
// silently auto-corrected (a silent rewrite could paper over the user
// pointing at the wrong shot/subject entirely).
export function findMalformedTags(text) {
  const body = text || ''
  const found = []
  const shotNear = /\[\s*shot\s*(\d+)\s*\]/gi
  let m
  while ((m = shotNear.exec(body))) {
    const suggestion = `[Shot ${m[1]}]`
    if (m[0] !== suggestion) found.push({ found: m[0], suggestion, index: m.index })
  }
  const tagNear = /<\s*(subject|picture)\s*(\d+)\s*>/gi
  while ((m = tagNear.exec(body))) {
    const word = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
    const suggestion = `<${word} ${m[2]}>`
    if (m[0] !== suggestion) found.push({ found: m[0], suggestion, index: m.index })
  }
  return found.sort((a, b) => a.index - b.index)
}

// "[Shot 1] and [Shot 2]" / "[Shot 1], [Shot 2] and [Shot 3]" — subject_definitions'
// pose-reference line (constants.js ~1517-1519).
const joinShotsAnd = (nums) => {
  const items = nums.map(n => `[Shot ${n}]`)
  if (items.length <= 1) return items[0] || ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
// "[Shot 1], [Shot 3]" — retention_analysis' plain-comma form (constants.js ~1552-1554).
const joinShotsComma = (nums) => nums.map(n => `[Shot ${n}]`).join(', ')

const joinAnd = (items) => {
  if (items.length <= 1) return items[0] || ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// ── reference metadata → schema vocabulary ─────────────────────────────────

const preserveById = (id) => MINIMAX_H3_PRESERVE_OPTIONS.find(p => p.id === id) || MINIMAX_H3_PRESERVE_OPTIONS[1]
// The retention_analysis "reason" clause reuses MINIMAX_H3_PRESERVE_OPTIONS'
// own hint text (single source of truth) rather than a parallel table.
export const retentionReason = (preserveId) => preserveById(preserveId).hint

const ROLE_NOUN = {
  subject_identity: 'subject', product_object: 'product/object',
  environment: 'environment', style: 'style reference',
}
// Used only when a reference's own `note` is empty — Manual mode has no
// vision caption to fall back on, so this is the generic stand-in.
const ROLE_FALLBACK_NOTE = {
  subject_identity: "this subject's face, build and identity as shown",
  product_object: 'this object\'s geometry, materials and any visible labeling as shown',
  environment: "this location's layout and lighting as shown",
  style: "this reference's palette, lighting and aesthetic as shown",
}

// One Subject per non-pose reference, in refImages order — see the module
// header on why this module never folds two references into one Subject.
// <Picture N> always keeps the reference's 1-based list position; <Subject M>
// numbers 1,2,3… only across subject-defining (non-pose) references, so the
// two numbers won't always line up (constants.js ~1506-1509).
export function numberSubjects(refImages) {
  let subjectN = 0
  return (refImages || []).map((image, i) => {
    const pictureN = i + 1
    const subjectM = image.role === 'pose_composition' ? null : ++subjectN
    return { image, pictureN, subjectM }
  })
}

// MM:SS.mmm — the exact timestamp format SYSTEM_PROMPT_MINIMAX_H3's rule 5
// cut-timestamp convention already uses ("At MM:SS.mmm, …"), and the one
// H3_MULTIFRAME_ADDENDUM (constants.js) prescribes for an Add Guide anchor's
// definition/retention lines below. Single source of truth — ScriptwriterPanel.jsx
// imports this instead of keeping its own private copy.
export const formatTimestamp = (seconds) => {
  const s = Math.max(0, Number(seconds) || 0)
  const m = Math.floor(s / 60)
  const rem = (s - m * 60).toFixed(3).padStart(6, '0')
  return `${String(m).padStart(2, '0')}:${rem}`
}

const isAnchored = (image) => image.atSeconds != null && Number.isFinite(Number(image.atSeconds))

// minimax-h3-multireference-prompt-spec.md §2: "A picture can play two roles
// … If it plays both roles, describe both roles in subject_definitions" — but
// the spec's own worked example (§2) and minimal template (§8) always do this
// as TWO SEPARATE lines, one <Subject M> (semantic role, unmodified) and one
// <Picture N> (keyframe role) — never merged into one sentence via "It is
// also …". A Pose/Composition reference has no separate <Subject M> line to
// begin with, so ITS one line simply switches wording (shot-list → anchor)
// rather than gaining a second line — see buildAnchorDefinitionLine/
// buildAnchorRetentionLine below for the subject-bearing case, added
// separately in assembleRef2VA.
function buildSubjectDefinitionLine(entry, { usage }) {
  const { image, pictureN, subjectM } = entry
  const picTag = `<Picture ${pictureN}>`
  if (image.role === 'pose_composition') {
    if (isAnchored(image)) {
      return `${picTag} is a storyboard keyframe for the target composition at ${formatTimestamp(image.atSeconds)}.`
    }
    const shots = usage[`Picture ${pictureN}`] || []
    if (!shots.length) {
      return `${picTag} is a storyboard reference (not referenced in the text), defining its intended viewpoint, subject placement, and shot order.`
    }
    const pronoun = shots.length > 1 ? 'their' : 'its'
    return `${picTag} is a storyboard reference for ${joinShotsAnd(shots)}, defining ${pronoun} viewpoint, subject placement, and shot order.`
  }
  const subjTag = `<Subject ${subjectM}>`
  const note = (image.note || '').trim()
  if (image.role === 'wardrobe') {
    const detail = note ? ` (${note})` : ''
    return `${subjTag} is the wardrobe from ${picTag}, scoped to the garment only — cut, fabric, color, pattern, and fit${detail}. The face, body, and identity of whoever is wearing it in that reference photo are NOT carried over; only the clothing transfers onto the video's actual subject.`
  }
  const roleNoun = ROLE_NOUN[image.role] || 'subject'
  const attrs = note || ROLE_FALLBACK_NOTE[image.role] || 'as shown in the reference image'
  return `${subjTag} is the ${roleNoun} from ${picTag}, preserving ${attrs}.`
}

function buildRetentionLine(entry, { usage }) {
  const { image, pictureN, subjectM } = entry
  const marker = preserveById(image.preserve).marker
  const label = image.role === 'pose_composition' ? `Picture ${pictureN}` : `Subject ${subjectM}`
  if (image.role === 'pose_composition' && isAnchored(image)) {
    return `<${label}> (target composition at ${formatTimestamp(image.atSeconds)}): ${marker} - use it as the target pose, framing, and scene state at that time.`
  }
  const reason = retentionReason(image.preserve)
  if (image.role === 'pose_composition') {
    const shots = usage[`Picture ${pictureN}`] || []
    const paren = shots.length ? `storyboard reference for ${joinShotsComma(shots)}` : 'storyboard reference (not referenced in the text)'
    return `<${label}> (${paren}): ${marker} - ${reason}`
  }
  const shots = usage[label] || []
  const paren = shots.length ? `appears in ${joinShotsComma(shots)}` : 'not referenced in the text'
  return `<${label}> (${paren}): ${marker} - ${reason}`
}

// The separate <Picture N> lines a subject-bearing anchored reference ALSO
// gets (spec §2/§5.3/§8) — appended after the per-entry lines above, never
// replacing or merging into the <Subject M> line. Not called for
// Pose/Composition (its one line already switches wording in place, above).
const buildAnchorDefinitionLine = (entry) =>
  `<Picture ${entry.pictureN}> is a storyboard keyframe for the target composition at ${formatTimestamp(entry.image.atSeconds)}.`

const buildAnchorRetentionLine = (entry) =>
  `<Picture ${entry.pictureN}> (target composition at ${formatTimestamp(entry.image.atSeconds)}): ${preserveById(entry.image.preserve).marker} - use it as the target pose, framing, and scene state at that time.`

// Ordered "reached the composition" sentences — mirrors H3_MULTIFRAME_ADDENDUM's
// own detailed_description example ("at 00:01.500, the continuous movement
// reaches the composition defined by <Picture 2>"). Used by buildTemplateBody
// (the "Manual Prompt" template) and buildManualSeed (so raw-tag Manual mode's
// seed demonstrates the syntax too) — never by the AI writer path, which
// ignores anchors entirely.
export function anchorSentences(refImages) {
  return numberSubjects(refImages || [])
    .filter(e => isAnchored(e.image))
    .sort((a, b) => Number(a.image.atSeconds) - Number(b.image.atSeconds))
    .map(e => `At ${formatTimestamp(e.image.atSeconds)}, the continuous movement reaches the composition defined by <Picture ${e.pictureN}>.`)
}

const buildAudioSubjectLine = (audioN, subjectM, speakerId) =>
  `<Audio ${audioN}> is the voice-timbre reference for <Subject ${subjectM}> (${speakerId}). Only its timbre, pitch and delivery are referenced; none of its original wording is carried across.`

const buildAudioRetentionLine = (audioN) =>
  `<Audio ${audioN}>: reference - timbre, pitch and delivery only; wording is original.`

// Each refAudios[i] binds to a subject via its own `subjectRef` — the hash of
// the reference image it belongs to (set explicitly in MinimaxRefPanel; a
// stable content hash rather than the volatile `id`, since ids are
// regenerated on history restore — mirrors ScriptwriterPanel's own
// refKey(im) = im.hash pinning). No positional guessing.
export function bindAudioToSubjects(refImages, refAudios) {
  const entries = numberSubjects(refImages)
  return (refAudios || []).map((a, i) => {
    const entry = entries.find(e => e.image.hash && e.image.hash === a.subjectRef)
    if (!entry || entry.subjectM == null) return null
    return { audioN: i + 1, subjectM: entry.subjectM }
  })
}

function buildSummary(entries, refAudios) {
  const parts = ['reference generation']
  if ((refAudios || []).length) parts.push('audio reference')
  if (entries.some(e => isAnchored(e.image))) parts.push('keyframe completion')
  const marker = `[${parts.join(' + ')}]`
  const labels = entries.map(e => e.subjectM ? `<Subject ${e.subjectM}>` : `<Picture ${e.pictureN}>`)
  if (!labels.length) return marker
  const verb = labels.length === 1 ? 'appears' : 'appear'
  return `${marker} ${joinAnd(labels)} ${verb} across the target video as described in detailed_description below.`
}

// ── validation ───────────────────────────────────────────────────────────
// Errors block assembly (a malformed/ambiguous prompt is worse than none);
// warnings surface in the UI but never block — Manual mode still produces a
// schema-valid prompt around them.

export function validateManualH3({ mode, storyText, soundscape, refImages, refAudios, duration }) {
  const errors = []
  const warnings = []
  const text = storyText || ''
  const shots = parseShots(text)

  if (!shots.length) {
    errors.push('Your story text has no [Shot N] markers — every shot must be marked, e.g. "[Shot 1] Cinematic, live-action, …".')
  }
  for (const f of findMalformedTags(text)) {
    errors.push(`Found "${f.found}" — MiniMax H3 requires exact "${f.suggestion}".`)
  }
  const nums = shots.map(s => s.n)
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] <= nums[i - 1]) {
      warnings.push(`Shot numbers are not strictly increasing (found [Shot ${nums[i]}] after [Shot ${nums[i - 1]}]).`)
      break
    }
  }
  if (!(soundscape || '').trim()) {
    errors.push('Soundscape is required in Manual mode — nothing invents it; type "silence" for none.')
  }

  if (mode === 'Ref2VA') {
    const entries = numberSubjects(refImages)
    const { usage } = parseShotLabelUsage(text)

    for (const label of Object.keys(usage)) {
      const [kind, numStr] = label.split(' ')
      const num = Number(numStr)
      const known = kind === 'Picture'
        ? entries.some(e => e.pictureN === num)
        : entries.some(e => e.subjectM === num)
      if (!known) {
        // <Subject N> is the confusing one — it skips any Pose/Composition
        // reference, so it does not always match an image's list position
        // the way <Picture N> does. Point at the actual count and, when a
        // pose reference is present, name the likely cause rather than just
        // "not found" (MinimaxRefPanel.jsx shows the resolved tag on each
        // card in Manual mode for exactly this reason).
        let hint = ''
        if (kind === 'Subject') {
          const maxSubject = entries.reduce((m, e) => (e.subjectM != null && e.subjectM > m ? e.subjectM : m), 0)
          hint = entries.some(e => e.image.role === 'pose_composition')
            ? ` You have ${maxSubject} subject-bearing reference(s) — <Subject N> numbers skip any Pose/Composition reference, so it may not match that image's position in your list; check the "→ <Subject N>" tag shown on each reference card.`
            : ` You have ${maxSubject} subject-bearing reference(s) — check the "→ <Subject N>" tag shown on each reference card.`
        }
        errors.push(`Your text uses <${label}> but there is no reference image defining it.${hint}`)
      }
    }
    for (const e of entries) {
      const label = e.subjectM ? `Subject ${e.subjectM}` : `Picture ${e.pictureN}`
      if (!usage[label] || !usage[label].length) {
        warnings.push(`<${label}> is never used in your story text — it will still be listed, marked "not referenced in the text".`)
      }
    }

    const speakers = parseSubjectSpeakers(text)
    const bindings = bindAudioToSubjects(refImages, refAudios)
    ;(refAudios || []).forEach((a, i) => {
      const b = bindings[i]
      if (!b) { errors.push(`Audio ${i + 1} has no assigned subject — pick one in the reference panel above.`); return }
      if (!speakers[b.subjectM]) {
        errors.push(`Audio ${i + 1} is bound to <Subject ${b.subjectM}>, but your text never gives that subject a speaker id like "(S1)".`)
      }
    })

    // Add Guide timeline anchors — non-blocking, mirrors the Scriptwriter's
    // own two checks (ScriptwriterPanel.jsx's per-clip anchor row).
    const dur = parseFloat(duration) || 0
    const anchored = (refImages || []).filter(isAnchored)
    if (dur > 0) {
      for (const im of anchored) {
        const t = Number(im.atSeconds)
        if (t < 0 || t > dur) warnings.push(`An Add Guide anchor at ${formatSeconds(t)}s is outside the ${formatSeconds(dur)}s duration.`)
      }
    }
    const times = anchored.map(im => Number(im.atSeconds))
    if (new Set(times).size !== times.length) warnings.push('Two Add Guide anchors share the same time.')
  }

  return { errors, warnings }
}

// ── per-mode assembly ───────────────────────────────────────────────────
// Field-label rule (constants.js ~1461): the output must literally start
// with "integrated_multimodal_description:" (T2VA/I2VA/L2VA/FL2VA) or
// "subject_definitions:" (Ref2VA); overall_soundscape:/non_diegetic_music:
// always keep their own labels too.

// "8 seconds" -> "8.00" — the S.SS form the alignment preambles use.
export const formatSeconds = (duration) => (parseFloat(duration) || 0).toFixed(2)

// Rule 8: N/A exactly when blank or "none"/"silence" — never invented otherwise.
const musicField = (music) => {
  const m = (music || '').trim()
  return (!m || /^(none|silence)$/i.test(m)) ? 'N/A' : m
}

const base3Fields = ({ storyText, soundscape, music }) =>
  `integrated_multimodal_description: ${(storyText || '').trim()}\n\noverall_soundscape: ${(soundscape || '').trim()}\n\nnon_diegetic_music: ${musicField(music)}`

export function assembleT2VA(input) {
  return base3Fields(input)
}

export function assembleI2VA(input) {
  const shots = parseShots(input.storyText)
  const firstShot = shots.length ? shots[0].n : 1
  const align = `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot ${firstShot}]) is fully referenced.`
  return `${align}\n\n${base3Fields(input)}`
}

export function assembleL2VA(input) {
  const shots = parseShots(input.storyText)
  const lastShot = shots.length ? Math.max(...shots.map(s => s.n)) : 1
  const align = `How the reference pictures align with the target video — <Picture 1> (from [Shot ${lastShot}]) aligns with the ${formatSeconds(input.duration)}-second mark of the target video.`
  return `${align}\n\n${base3Fields(input)}`
}

// Deliberately unbracketed — the one exception to the [Shot N]/<Picture N>
// bracket rule (constants.js ~1350-1352, ~1491-1499), reproduced verbatim.
export function assembleFL2VA(input) {
  const shots = parseShots(input.storyText)
  const lastShot = shots.length ? Math.max(...shots.map(s => s.n)) : 1
  const align = `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${lastShot}) aligns with the ${formatSeconds(input.duration)}-second mark of the target video.`
  return `${align}\n\n${base3Fields(input)}`
}

export function assembleRef2VA({ storyText, soundscape, music, refImages, refAudios }) {
  const entries = numberSubjects(refImages)
  const { usage } = parseShotLabelUsage(storyText)
  const speakers = parseSubjectSpeakers(storyText)
  const bindings = bindAudioToSubjects(refImages, refAudios)

  const subjectDefLines = entries.map(e => buildSubjectDefinitionLine(e, { usage }))
  const retentionLines = entries.map(e => buildRetentionLine(e, { usage }))
  // A subject-bearing anchored reference gets its own separate <Picture N>
  // line in BOTH sections, appended after the per-entry lines above (matches
  // the spec's own ordering — every <Subject M> line first, then <Picture N>
  // lines) — never merged into the <Subject M> line. Pose/Composition is
  // excluded: its one line already switched wording in place, above.
  for (const e of entries) {
    if (e.image.role === 'pose_composition' || !isAnchored(e.image)) continue
    subjectDefLines.push(buildAnchorDefinitionLine(e))
    retentionLines.push(buildAnchorRetentionLine(e))
  }
  bindings.forEach((b) => {
    if (!b) return
    const speakerId = speakers[b.subjectM] || `S${b.subjectM}`
    subjectDefLines.push(buildAudioSubjectLine(b.audioN, b.subjectM, speakerId))
    retentionLines.push(buildAudioRetentionLine(b.audioN))
  })

  return [
    `subject_definitions:\n${subjectDefLines.join('\n')}`,
    `summary:\n${buildSummary(entries, refAudios)}`,
    `retention_analysis:\n${retentionLines.join('\n')}`,
    `detailed_description:\n${(storyText || '').trim()}`,
    `overall_soundscape: ${(soundscape || '').trim()}`,
    `non_diegetic_music: ${musicField(music)}`,
  ].join('\n\n')
}

const MODE_ASSEMBLERS = { T2VA: assembleT2VA, I2VA: assembleI2VA, L2VA: assembleL2VA, FL2VA: assembleFL2VA, Ref2VA: assembleRef2VA }

export function assembleManualH3(mode, input) {
  const fn = MODE_ASSEMBLERS[mode]
  if (!fn) throw new Error(`Unknown MiniMax H3 mode: ${mode}`)
  return fn(input)
}

// One entry point for App.jsx: validate, then assemble only if nothing blocks.
export function buildManualH3({ mode, storyText, soundscape, music, duration, refImages, refAudios }) {
  const { errors, warnings } = validateManualH3({ mode, storyText, soundscape, refImages, refAudios, duration })
  if (errors.length) return { ok: false, text: null, errors, warnings }
  const text = assembleManualH3(mode, { storyText, soundscape, music, duration, refImages, refAudios })
  return { ok: true, text, errors: [], warnings }
}

// ── Manual-mode seed text ───────────────────────────────────────────────
// Dropped straight into the Scene textarea (App.jsx) the moment Manual mode
// switches on over a blank field, so there is real, editable example prose to
// start from. Built from the ACTUAL configured reference set — right count,
// right roles named — rather than a fixed example, so it stays true to what
// the user will actually have to write tags for.

const PLAIN_SEED =
  '[Shot 1] Cinematic, live-action, a woman turns towards the door…\n'
  + 'At 00:03.500, the camera cuts to her, who says, [German] "Wir müssen gehen."\n'
  + '[Shot 2] …'

// Shared by buildManualSeed (below) and buildTemplateBody (the "Manual
// Prompt" template builder, further down) — the subject-weaving clause
// construction ("<Subject 2> stands by the window, wearing <Subject 1>'s
// jacket, framed against…") is the same regardless of what fills in the
// dialogue around it. Returns null when there's nothing to weave (no
// non-pose reference images).
export function buildSubjectClauseParts(refImages) {
  const entries = numberSubjects(refImages || []).filter(e => e.image.role !== 'pose_composition')
  if (!entries.length) return null

  const byRole = (role) => entries.find(e => e.image.role === role)
  const identity = byRole('subject_identity')
  const wardrobe = byRole('wardrobe')
  const product = byRole('product_object')
  const environment = byRole('environment')
  const style = byRole('style')

  const mainSubject = identity || product
  let mainClause
  if (mainSubject) {
    mainClause = mainSubject === identity
      ? `<Subject ${mainSubject.subjectM}> stands by the window`
      : `<Subject ${mainSubject.subjectM}> sits on the table`
  } else if (wardrobe) {
    mainClause = `a figure wearing <Subject ${wardrobe.subjectM}>'s jacket stands by the window`
  } else {
    mainClause = 'a woman stands by the window'
  }
  if (wardrobe && mainSubject) mainClause += `, wearing <Subject ${wardrobe.subjectM}>'s jacket`
  if (environment) mainClause += `, framed against the backdrop from <Picture ${environment.pictureN}>`
  const opener = style ? `In a look drawn from <Picture ${style.pictureN}>, ` : ''

  return { entries, identity, wardrobe, product, environment, style, mainSubject, mainClause, opener }
}

export function buildManualSeed(refImages, refAudios) {
  // Demonstrate the Add Guide anchor syntax in the seed too — unlike the
  // "Manual Prompt" template, nothing else teaches this in the raw-tag path.
  const anchorLines = anchorSentences(refImages)
  const withAnchors = (text) => anchorLines.length ? `${text}\n${anchorLines.join('\n')}` : text

  const parts = buildSubjectClauseParts(refImages)
  if (!parts) return withAnchors(PLAIN_SEED)
  const { mainSubject, mainClause, opener } = parts

  // Every subject a voice reference is explicitly bound to (the "Voice" select
  // on that reference's own card) needs its own speaker line — rule 6a: a
  // voice reference with no supplied words still needs one to act on, and
  // Manual mode's own validation blocks exactly this gap (an <Audio N> bound
  // to a subject that never gets a speaker id). So when 1-2 audios are bound,
  // the seed writes one [Language] "…" line per bound subject, each its own
  // shot, each its own speaker id (S1, S2…) in binding order — never just the
  // main subject, since the bound subject may be a different reference
  // entirely (e.g. a voice bound to the wardrobe or environment subject).
  // With no bound audio at all, fall back to the single generic line as before.
  const bound = bindAudioToSubjects(refImages || [], refAudios || [])
    .filter(Boolean)
    .map((b, i) => ({ subjectM: b.subjectM, speakerId: `S${i + 1}` }))
  const DIALOGUE_LINES = ['Wir müssen gehen.', 'Ich bin gleich so weit.']

  if (bound.length) {
    let out = `[Shot 1] Cinematic, live-action, ${opener}${mainClause}…\n`
      + `At 00:03.500, the camera cuts to <Subject ${bound[0].subjectM}> (${bound[0].speakerId}), who says, [German] "${DIALOGUE_LINES[0]}"`
    let shotN = 2
    for (let i = 1; i < bound.length; i++) {
      out += `\n[Shot ${shotN}] At 00:0${3 + shotN * 3}.000, the camera cuts to <Subject ${bound[i].subjectM}> (${bound[i].speakerId}), who says, [German] "${DIALOGUE_LINES[i] || DIALOGUE_LINES[0]}"`
      shotN++
    }
    out += `\n[Shot ${shotN}] …`
    return withAnchors(out)
  }

  const speakerTag = mainSubject ? `<Subject ${mainSubject.subjectM}> (S1)` : 'her'
  return withAnchors(`[Shot 1] Cinematic, live-action, ${opener}${mainClause}…\n`
    + `At 00:03.500, the camera cuts to ${speakerTag}, who says, [German] "${DIALOGUE_LINES[0]}"\n`
    + `[Shot 2] …`)
}

// ── settings-derived template ("Manual Prompt" button) ─────────────────────
// A THIRD, independent action from Manual mode above: instead of the user
// writing tag syntax themselves, this instantly assembles a full H3-schema
// draft from whatever the normal AI-mode fields (Style/Dialogue/Spoken
// Language/Duration/Aspect Ratio/Soundscape/Music/references) already hold,
// with the free descriptive-prose field left as an unmissable placeholder to
// hand-edit. Still zero AI calls, and it reuses assembleManualH3 (above) for
// the actual schema shape rather than re-deriving it.
//
// Scaffolding text uses «guillemets», never [ ]/< > — those are live H3
// tokens (parseShots/findMalformedTags scan for them, and H3SyntaxBadge runs
// on every result automatically in the UI), so a bracketed placeholder would
// misparse as a real, broken tag on a fresh, unedited draft.

const TEMPLATE_SOUNDSCAPE_PLACEHOLDER = '«describe the ambience — e.g. wind, distant traffic, room tone»'

const templateNote = ({ ratioOrient, ratioToken, duration, styleHint, avoidHint, scene }) => {
  const ratioPart = [ratioOrient, ratioToken].filter(Boolean).join(' ')
  const bits = [ratioPart, `~${formatSeconds(duration)}s`]
  if (styleHint) bits.push(`style: ${styleHint}`)
  if (avoidHint) bits.push(`avoid: ${avoidHint}`)
  const settingsLine = bits.filter(Boolean).join(', ')
  const sceneNote = (scene || '').trim()
    ? `Starting notes from your Scene field: "${scene.trim()}"`
    : 'Describe the scene here.'
  return `«TODO — replace this placeholder. ${settingsLine}. ${sceneNote} Add more shot blocks as this scene grows.»`
}

// The dialogue field is transcribed verbatim, tagged with the chosen spoken
// language — never translated (same limitation as Manual mode above, which
// doesn't translate either; the user is expected to already type it in the
// target language, or fix it by hand in the draft).
const templateDialogueLine = (spokenLangTag, dialogue, delivery) => {
  const d = (dialogue || '').trim()
  if (!d || !spokenLangTag) return ''
  const deliveryNote = (delivery || '').trim() ? `, delivery: ${delivery.trim()}` : ''
  return `${spokenLangTag} "${d}"${deliveryNote}`
}

// Everything below is wrapped in one `[Shot 1] …` block on purpose — no
// trailing placeholder second shot in any mode, so parseShots never has to
// treat a "…" continuation as a real shot boundary (this also keeps the
// I2VA/L2VA/FL2VA alignment sentence anchored to a real, single shot).
export function buildTemplateBody({ mode, refImages, refAudios, scene, dialogue, delivery, spokenLangTag, ratioToken, ratioOrient, duration, styleHint, avoidHint }) {
  const note = templateNote({ ratioOrient, ratioToken, duration, styleHint, avoidHint, scene })
  const spoken = templateDialogueLine(spokenLangTag, dialogue, delivery)
  // Add Guide timeline anchors — Ref2VA only (no reference images in any
  // other mode), any role, chronologically ordered.
  const anchorLines = mode === 'Ref2VA' ? anchorSentences(refImages) : []
  const withAnchors = (text) => anchorLines.length ? `${text}\n${anchorLines.join('\n')}` : text

  const parts = mode === 'Ref2VA' ? buildSubjectClauseParts(refImages) : null
  if (!parts) {
    return withAnchors(spoken ? `[Shot 1] ${note}\nThe subject says, ${spoken}.` : `[Shot 1] ${note}`)
  }

  const { mainSubject, mainClause, opener } = parts
  const bound = bindAudioToSubjects(refImages || [], refAudios || []).filter(Boolean)
  // A subject with a bound voice reference gets the line if one exists;
  // otherwise the main identity/product subject does — same priority
  // buildManualSeed already uses for its own hardcoded example dialogue.
  const speakingSubject = bound.length ? bound[0].subjectM : (mainSubject ? mainSubject.subjectM : null)

  let body = `[Shot 1] ${note} ${opener}${mainClause}…`
  if (spoken && speakingSubject != null) {
    // The literal "(S1)" speaker tag here is required, not decorative:
    // assembleRef2VA resolves a bound audio's speaker via
    // parseSubjectSpeakers(storyText), which only matches "<Subject N> (Sk)"
    // — without this line, subject_definitions would still assert a speaker
    // id that the body itself never actually gives that subject.
    body += `\nThe camera cuts to <Subject ${speakingSubject}> (S1), who says, ${spoken}.`
  } else if (spoken) {
    body += `\n${spoken}`
  }
  return withAnchors(body)
}

export function buildH3Template({ mode, scene, duration, refImages, refAudios, soundscape, music, dialogue, delivery, spokenLangTag, ratioToken, ratioOrient, styleHint, avoidHint }) {
  const body = buildTemplateBody({ mode, refImages, refAudios, scene, dialogue, delivery, spokenLangTag, ratioToken, ratioOrient, duration, styleHint, avoidHint })
  // Manual mode's own validateManualH3 requires soundscape non-blank; this
  // path has no validation gate at all, so an empty setting must not
  // silently produce "overall_soundscape: " with nothing after it.
  const soundscapeText = (soundscape || '').trim() || TEMPLATE_SOUNDSCAPE_PLACEHOLDER
  const text = assembleManualH3(mode, { storyText: body, soundscape: soundscapeText, music, duration, refImages, refAudios })
  return { text }
}

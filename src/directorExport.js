// Pure builder: a Scriptwriter film -> the `timeline_data` JSON of the
// ComfyUI-MiniMaxH3-Director node (github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director).
//
// The whole film becomes ONE timeline: every clip is a consecutive text segment, the cast /
// location / style references become the Director's subject slots (images inline as base64,
// which is how the Director itself stores them), and the film-level look / soundscape /
// music fill its global boxes. The Director compiles its own H3 prompt from this, so the
// per-clip Phase-3 prompt text is deliberately NOT used here.
//
// No React, no fetch — tested directly (test/directorExport.test.js).

import { parseH3Sections, splitShots, cleanShotText } from './directorShots'

export const DIRECTOR_FPS = 24
export const DIRECTOR_MAX_SUBJECTS = 9          // MAX_SUBJECT_SLOTS in the Director
export const DIRECTOR_MAX_SECONDS = 15          // H3's trained envelope
// Voice files are staged by the ComfyUI bridge; this token is swapped for the real
// `prompt_enhancer_runs/<run-id>` folder (relative to ComfyUI's input/) on Load Film.
export const DIRECTOR_RUN_TOKEN = '__PE_RUN__'

const KIND_BY_LINK = {
  character: 'person', location: 'environment', wardrobe: 'clothing',
  style: 'style', prop: 'prop', pose: 'pose',
}
const KIND_BY_ROLE = {
  subject_identity: 'person', environment: 'environment', wardrobe: 'clothing',
  style: 'style', product_object: 'object', pose_composition: 'pose',
}
export const directorKind = (im) => KIND_BY_LINK[im?.linkType] || KIND_BY_ROLE[im?.role] || 'object'

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

// "Name: line" -> { name, line }; a bare line has no speaker.
const splitSpeaker = (d) => {
  const m = String(d).match(/^\s*([^:]{1,40}?)\s*(?:\([^)]*\))?\s*:\s*(.+)$/s)
  return m ? { name: m[1].trim(), line: m[2].trim() } : { name: '', line: String(d).trim() }
}

const clipText = (shot) => {
  const parts = [
    shot.camera_framing,
    shot.primary_beat || shot.visual_action,
    shot.eyeline ? `Eyeline: ${shot.eyeline}` : '',
    shot.lighting_mood,
  ].map(s => String(s || '').trim()).filter(Boolean)
  return parts.map(p => /[.!?]$/.test(p) ? p : p + '.').join(' ')
}


// ── timeline anchors (Add Guide) → Director timeline images ────────────────────
// The Director turns a main-track image segment into a <Picture N>: a segment WITH text is
// "the first frame of [Shot k]" (refRole auto) or "a storyboard reference for [Shot k]"
// (refRole storyboard). An anchor image therefore goes ON the shot it falls in and spans the
// whole shot — no extra or empty segments.

const imageSegFields = (a) => ({
  imageB64: a.image.b64,
  fileName: a.image.name || 'anchor.jpg',
  retention: a.retention || 'fully_preserved',
  refRole: a.refRole || 'auto',
  refDesc: (a.description || '').trim(),
  refNote: '',
})

/**
 * Put each anchor's image on the segment (shot/clip) that contains its time — text kept, length
 * unchanged. One image per segment. A second anchor in an already-taken segment moves to the
 * nearest segment without an image; if there is none it is left out. Both cases are reported.
 * @returns {{ segments: Array, warnings: string[] }}
 */
export function attachAnchorsToSegments(segments, anchors = [], fps = DIRECTOR_FPS) {
  const out = segments.map(sg => ({ ...sg }))
  const warnings = []
  const lastEnd = out.length ? out[out.length - 1].start + out[out.length - 1].length : 0
  const label = (an) => an.image.name || 'an image'
  const secs = (f) => (f / fps).toFixed(1)
  for (const an of [...anchors].sort((x, y) => x.atFrames - y.atFrames)) {
    if (an.atFrames < 0 || an.atFrames > lastEnd) { warnings.push(`Timeline anchor "${label(an)}" at ${secs(an.atFrames)} s is outside the ${secs(lastEnd)} s timeline — left out.`); continue }
    const idx = out.findIndex(sg => an.atFrames >= sg.start && an.atFrames < sg.start + sg.length)
    let i = idx >= 0 ? idx : out.length - 1
    if (out[i].type === 'image') {
      const dist = (sg) => (an.atFrames < sg.start ? sg.start - an.atFrames : an.atFrames - (sg.start + sg.length))
      const free = out.map((sg, k) => ({ sg, k })).filter(({ sg }) => sg.type !== 'image').sort((x, y) => dist(x.sg) - dist(y.sg))[0]
      if (!free) { warnings.push(`Shot ${i + 1} already has an image — "${label(an)}" (anchor at ${secs(an.atFrames)} s) was left out. Add a shot or move the anchor.`); continue }
      warnings.push(`Shot ${i + 1} already has an image — "${label(an)}" (anchor at ${secs(an.atFrames)} s) moved to shot ${free.k + 1}.`)
      i = free.k
    }
    out[i] = { ...out[i], type: 'image', ...imageSegFields(an) }
  }
  return { segments: out, warnings }
}

/**
 * @param {object} a
 * @param {object} a.script            Phase-1 bible (title, look, soundscape, music, language, characters, locations, scenes)
 * @param {object} a.directorsCut      { shots: [...] }
 * @param {Array}  a.refImages         Scriptwriter references ({ base64, mediaType, caption, linkType, linkId, role, preserve, fileName })
 * @param {Array}  a.voiceRefs         ({ id, characterId, base64, fileName }) — `voiceFile(v)` supplies the zip path
 * @param {(v)=>string|undefined} a.voiceFile  zip path of a staged voice file, or undefined if none
 * @param {(im)=>string} a.entityName  display name of a reference's character/location ('' if none)
 * @param {(m:string)=>string} a.preserveMarker  preservation id -> Director retention value
 */
export function buildDirectorTimeline({
  script, directorsCut, refImages = [], voiceRefs = [], voiceFile = () => undefined,
  entityName = () => '', preserveMarker = () => 'fully_preserved', fps = DIRECTOR_FPS,
  // (shot) => [{ im: <reference with base64>, atSeconds }] — a clip's Add-Guide anchors
  anchorsForShot = () => [],
}) {
  const warnings = []
  const shots = directorsCut?.shots || []

  // --- segments: one per clip, back to back ---
  const segments = []
  let cursor = 0
  shots.forEach((shot, i) => {
    const length = Math.max(1, Math.round((Number(shot.duration) || 5) * fps))
    segments.push({ id: `pe${i + 1}`, start: cursor, length, prompt: '', type: 'text', isEndFrame: false })
    cursor += length
  })
  const totalFrames = cursor
  const totalSeconds = totalFrames / fps
  if (totalSeconds > DIRECTOR_MAX_SECONDS) {
    warnings.push(`Film is ${totalSeconds.toFixed(1)} s — H3 is trained for up to ${DIRECTOR_MAX_SECONDS} s per render. Trim or split it in the Director.`)
  }

  // --- subjects: one per captioned reference that has image bytes ---
  // clip anchors first: an anchored pose/composition reference is ONLY an anchor, not a subject
  const clipStarts = segments.map(sg => sg.start)
  const anchorList = []
  const anchoredPose = new Set()
  shots.forEach((shot, i) => {
    for (const { im, atSeconds } of anchorsForShot(shot) || []) {
      const t = Number(atSeconds)
      if (!im || !im.base64 || !Number.isFinite(t)) continue
      if (im.role === 'pose_composition') anchoredPose.add(im)
      if (t < 0 || t * fps > segments[i].length) { warnings.push(`Clip ${shot.shot_number || i + 1}: anchor at ${t} s is outside the clip — left out.`); continue }
      anchorList.push({
        atFrames: clipStarts[i] + Math.round(t * fps),
        image: { b64: `data:${im.mediaType || 'image/jpeg'};base64,${im.base64}`, name: im.fileName || 'anchor.jpg' },
        retention: preserveMarker(im.preserve),
        description: (im.caption || '').trim(),
        refRole: im.role === 'pose_composition' ? 'storyboard' : 'auto',
      })
    }
  })
  const usable = (refImages || []).filter(im => im.base64 && im.caption && im.caption.trim() && !anchoredPose.has(im))
  if (usable.length > DIRECTOR_MAX_SUBJECTS) {
    warnings.push(`${usable.length} references but the Director has ${DIRECTOR_MAX_SUBJECTS} subject slots — the rest were left out.`)
  }
  const used = usable.slice(0, DIRECTOR_MAX_SUBJECTS)
  const subjects = used.map((im) => {
    const name = entityName(im) || im.note || ''
    const voice = (voiceRefs || []).find(v => v.characterId && im.linkType === 'character' && v.characterId === im.linkId)
    const vfile = voice && voiceFile(voice)
    return {
      images: [{ b64: `data:${im.mediaType || 'image/jpeg'};base64,${im.base64}`, name: im.fileName || `${name || 'reference'}.jpg` }],
      description: im.caption.trim(),
      shortName: name,
      kind: directorKind(im),
      retention: preserveMarker(im.preserve),
      retentionNote: '',
      voice: vfile ? { audioFile: `${DIRECTOR_RUN_TOKEN}/${vfile}`, fileName: voice.fileName || vfile.split('/').pop(), seconds: 0 } : null,
    }
  })
  const slotOfChar = new Map()   // character id -> 1-based subject slot
  used.forEach((im, i) => { if (im.linkType === 'character' && im.linkId && !slotOfChar.has(im.linkId)) slotOfChar.set(im.linkId, i + 1) })
  while (subjects.length < 3) subjects.push({ images: [], description: '', shortName: '', kind: 'person', retention: 'fully_preserved', retentionNote: '', voice: null })
  const hasRefs = used.length > 0

  // --- clip prompt text (dialogue as Director `@refN [Lang] says: line` lines) ---
  const chars = script?.characters || []
  const lang = String(script?.language || '').trim()
  shots.forEach((shot, i) => {
    const scene = (script?.scenes || []).find(s => String(s.id) === String(shot.scene_id))
    const dialogues = Array.isArray(shot.dialogue) ? shot.dialogue : (Array.isArray(scene?.dialogues) ? scene.dialogues : [])
    const lines = dialogues.filter(d => d && String(d).trim()).map((d) => {
      const { name, line } = splitSpeaker(d)
      const c = name && chars.find(ch => ch.name && slug(ch.name) === slug(name))
      const slot = c && slotOfChar.get(c.id)
      const tag = slot && hasRefs ? `@ref${slot}` : `@voice(${name || 'a speaker'})`
      return `${tag}${lang ? ` [${lang}]` : ''} says: ${line}`
    })
    const text = clipText(shot)
    if (!text && !lines.length) warnings.push(`Clip ${shot.shot_number || i + 1} has no text.`)
    segments[i].prompt = [text, ...lines].filter(Boolean).join('\n')
  })
  const laid = attachAnchorsToSegments(segments, anchorList, fps)
  warnings.push(...laid.warnings)
  if (hasRefs && shots.some(s => Array.isArray(s.refs))) {
    warnings.push('Per-clip reference pinning does not carry over: a single Director timeline sends every subject for the whole film.')
  }

  const timeline = {
    mainTrackEnabled: true, audioTrackEnabled: true, motionTrackEnabled: true,
    propHeight: 90, globalPropHeight: 114, showFilenames: true,
    overrideAudio: false, inpaint_audio: true,
    global_prompt: [script?.look, ...chars.map(c => c.appearance ? `${c.name}: ${c.appearance}${c.wardrobe ? `, ${c.wardrobe}` : ''}` : '')]
      .map(s => String(s || '').trim()).filter(Boolean).join('\n'),
    retake_global_prompt: '',
    overall_soundscape: script?.soundscape || '',
    non_diegetic_music: script?.music || '',
    retakeMode: false, retakeStart: 24, retakeLength: 48, retakePrompt: '', retakeStrength: 1, retakeVideo: null,
    normalStartFrame: 0, normalDurationFrames: totalFrames,
    reference_mode: hasRefs ? 'REF2VA' : 'OFF',
    prompt_format: 'minimax',
    analyzeProvider: 'ollama', analyzeBaseUrl: '', analyzeModel: '',
    subjectSlotCount: Math.max(3, used.length),
    subjects,
    segments: laid.segments, motionSegments: [], audioSegments: [],
  }
  return { timeline, totalFrames, totalSeconds, fps, warnings }
}

/**
 * The main (single-generation) MiniMax H3 pipeline's counterpart of buildDirectorTimeline:
 * ONE clip → a one-segment timeline. Reference-mode images become subject slots (role →
 * kind, preservation → retention, description = the image's own described text, else its
 * note); a voice sample bound to an image (`subjectRef` = that image's hash) rides on that
 * subject. The typed Scene is the segment text (the Director writes its own prompt from it).
 *
 * @param {object} a
 * @param {string} a.scene, a.dialogue, a.delivery, a.language (label, e.g. 'German')
 * @param {number|null} a.durationSec
 * @param {Array}  a.refImages  [{ base64, mediaType, fileName, role, preserve, note, hash, captions }]
 * @param {Array}  a.refAudios  [{ subjectRef }] — index i is zip file voiceFiles[i]
 * @param {string[]} a.voiceFiles zip paths of the voice files, same order as refAudios
 * @param {(im)=>string} a.describe  the image's described text under its role ('' if none)
 */
export function buildSingleDirectorTimeline({
  scene = '', dialogue = '', delivery = '', language = '', durationSec = null,
  refImages = [], refAudios = [], voiceFiles = [], describe = () => '',
  soundscape = '', music = '', style = '', preserveMarker = () => 'fully_preserved', fps = DIRECTOR_FPS,
  generatedText = '',
}) {
  const warnings = []
  const secs = Number(durationSec) > 0 ? Number(durationSec) : 8
  const frames = Math.round(secs * fps)
  if (secs > DIRECTOR_MAX_SECONDS) warnings.push(`Clip is ${secs} s — H3 is trained for up to ${DIRECTOR_MAX_SECONDS} s.`)

  const isAnchored = (im) => im.atSeconds != null && im.atSeconds !== '' && Number.isFinite(Number(im.atSeconds))
  // A pose/composition reference that is anchored is ONLY a timeline anchor (it has no subject).
  const withBytes = (refImages || []).filter(im => im.base64 && !(isAnchored(im) && im.role === 'pose_composition'))
  if (withBytes.length > DIRECTOR_MAX_SUBJECTS) warnings.push(`${withBytes.length} references but the Director has ${DIRECTOR_MAX_SUBJECTS} subject slots — the rest were left out.`)
  const used = withBytes.slice(0, DIRECTOR_MAX_SUBJECTS)
  const subjects = used.map((im) => {
    const idx = (refAudios || []).findIndex(a => a && a.subjectRef && a.subjectRef === im.hash)
    const vfile = idx >= 0 ? voiceFiles[idx] : undefined
    return {
      images: [{ b64: `data:${im.mediaType || 'image/jpeg'};base64,${im.base64}`, name: im.fileName || 'reference.jpg' }],
      description: (describe(im) || im.note || '').trim(),
      shortName: (im.note || '').trim().slice(0, 40),
      kind: directorKind(im),
      retention: preserveMarker(im.preserve),
      retentionNote: '',
      voice: vfile ? { audioFile: `${DIRECTOR_RUN_TOKEN}/${vfile}`, fileName: vfile.split('/').pop(), seconds: 0 } : null,
    }
  })
  const firstPerson = used.findIndex(im => directorKind(im) === 'person')
  while (subjects.length < 3) subjects.push({ images: [], description: '', shortName: '', kind: 'person', retention: 'fully_preserved', retentionNote: '', voice: null })

  const lines = []
  if (String(dialogue).trim()) {
    const speaker = used.findIndex((im, i) => subjects[i].voice) >= 0
      ? used.findIndex((im, i) => subjects[i].voice) : firstPerson
    const tag = speaker >= 0 ? `@ref${speaker + 1}` : '@voice(a speaker)'
    const how = String(delivery).trim() || 'says'
    // one tagged line per spoken line (the Director only lifts a line that starts with the tag)
    String(dialogue).split(/\r?\n/).map(l => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean)
      .forEach(l => lines.push(`${tag}${language ? ` [${language}]` : ''} ${how}: ${l}`))
  }
  let text = [String(scene).trim(), ...lines].filter(Boolean).join('\n')

  // The generated prompt's own shots become the segments (one per shot, each with its text).
  const sections = generatedText ? parseH3Sections(generatedText) : null
  const parsed = sections?.detailed ? splitShots(sections.detailed, secs) : null
  const nonPose = (refImages || []).filter(im => im.role !== 'pose_composition')
  const clean = (t) => cleanShotText(t, {
    subjectSlotOf: (M) => { const i = used.indexOf(nonPose[M - 1]); return i >= 0 ? i + 1 : null },
    speakerRef: (n) => {
      const voiced = subjects.findIndex(sj => sj.voice)
      const person = used.findIndex(im => directorKind(im) === 'person')
      const first = voiced >= 0 ? voiced : person
      if (n && n > 1) return '@voice(another speaker)'
      return first >= 0 ? `@ref${first + 1}` : '@voice(a speaker)'
    },
  })
  let baseSegments
  let globalPrompt = ''
  if (parsed && parsed.shots.length) {
    let prevEnd = 0
    baseSegments = parsed.shots.map((sh, i) => {
      const end = i === parsed.shots.length - 1 ? frames : Math.min(frames, Math.max(prevEnd + 1, Math.round(sh.endSec * fps)))
      const seg = { id: `pe${i + 1}`, start: prevEnd, length: end - prevEnd, prompt: clean(sh.text), type: 'text', isEndFrame: false }
      prevEnd = end
      return seg
    })
    globalPrompt = clean(parsed.global)
  } else {
    if (!text) warnings.push('No Scene text — write the shot prompt in the Director.')
    baseSegments = [{ id: 'pe1', start: 0, length: frames, prompt: text, type: 'text', isEndFrame: false }]
  }
  const soundText = (sections && sections.soundscape) || soundscape || ''
  const musicText = (sections && sections.music) || music || ''

  const anchors = (refImages || []).filter(im => im.base64 && isAnchored(im)).map(im => ({
    atFrames: Math.round(Number(im.atSeconds) * fps),
    image: { b64: `data:${im.mediaType || 'image/jpeg'};base64,${im.base64}`, name: im.fileName || 'anchor.jpg' },
    retention: preserveMarker(im.preserve),
    description: describe(im) || im.note || '',
    refRole: im.role === 'pose_composition' ? 'storyboard' : 'auto',
  }))
  const laid = attachAnchorsToSegments(baseSegments, anchors, fps)

  const timeline = {
    mainTrackEnabled: true, audioTrackEnabled: true, motionTrackEnabled: true,
    propHeight: 90, globalPropHeight: 114, showFilenames: true,
    overrideAudio: false, inpaint_audio: true,
    global_prompt: globalPrompt,
    retake_global_prompt: '',
    overall_soundscape: soundText,
    non_diegetic_music: musicText,
    retakeMode: false, retakeStart: 24, retakeLength: 48, retakePrompt: '', retakeStrength: 1, retakeVideo: null,
    normalStartFrame: 0, normalDurationFrames: frames,
    reference_mode: used.length ? 'REF2VA' : 'OFF',
    prompt_format: 'minimax',
    analyzeProvider: 'ollama', analyzeBaseUrl: '', analyzeModel: '',
    subjectSlotCount: Math.max(3, used.length),
    subjects,
    segments: laid.segments,
    motionSegments: [], audioSegments: [],
  }
  warnings.push(...laid.warnings)
  return { timeline, totalFrames: frames, totalSeconds: secs, fps, warnings }
}

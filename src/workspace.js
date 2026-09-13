// The compose panel's fields, declared once.
//
// Why this exists: adding one field to the workspace used to mean editing four
// places — buildSnapshot(), restore(), applyQueueItemToWorkspace() and the Full
// Auto job spec — and the last two were already ~55 lines of byte-identical
// duplicate (the imgFromHistory/imgFrom closures were literally the same code
// twice). Both of the last two features, the spoken-language picker and the LoRA
// selection, had to be threaded through all four by hand. Miss one and the symptom
// is silent: a restored generation quietly loses a setting.
//
// Now there is one table. A new field is one row here plus one entry in App's
// SETTERS map, and snapshot/restore/queue can no longer disagree about it.
//
// Everything in this file is pure — no React, no DOM — so it is unit-testable and
// the round trip can be asserted directly.

import { TARGETS, DEFAULT_SPOKEN_LANG, MINIMAX_H3_REF_ROLES, caps } from './constants'
import { imageHash, presetById } from './utils'

// ── image (de)serialization ────────────────────────────────────────────────
// A snapshot stores just the bytes and their identity; the live workspace also
// wants a previewUrl to render and a content hash for the vision cache. Entries
// saved before images were stored kept only a filename STRING — those must read
// back as absent, not as a broken image, which is what the `.base64` gate does.

export const imgToSnap = (im) => (im
  ? { base64: im.base64, mediaType: im.mediaType, fileName: im.fileName, hash: im.hash || imageHash(im.base64) }
  : null)

export const imgFromSnap = (v) => ((v && typeof v === 'object' && v.base64)
  ? {
      base64: v.base64,
      mediaType: v.mediaType || 'image/jpeg',
      previewUrl: `data:${v.mediaType || 'image/jpeg'};base64,${v.base64}`,
      fileName: v.fileName,
      hash: v.hash || imageHash(v.base64),
    }
  : null)

export const refImagesToSnap = (list) => (list || []).map(im => ({
  base64: im.base64, mediaType: im.mediaType, fileName: im.fileName,
  role: im.role, preserve: im.preserve, note: im.note || '',
  hash: im.hash || imageHash(im.base64),
}))

// `newId` is injected so this stays pure — App passes generateId from db.js.
export const refImagesFromSnap = (list, newId) => (Array.isArray(list)
  ? list.filter(im => im && typeof im === 'object' && im.base64).map(im => ({
      id: newId(),
      base64: im.base64,
      mediaType: im.mediaType || 'image/jpeg',
      previewUrl: `data:${im.mediaType || 'image/jpeg'};base64,${im.base64}`,
      fileName: im.fileName,
      role: im.role || MINIMAX_H3_REF_ROLES[0].id,
      preserve: im.preserve || 'strong',
      note: im.note || '',
      hash: im.hash || imageHash(im.base64),
    }))
  : [])

export const refAudioToSnap = (a) => (a
  ? { base64: a.base64, mediaType: a.mediaType, fileName: a.fileName }
  : null)

export const refAudioFromSnap = (a) => ((a && typeof a === 'object' && a.base64)
  ? { base64: a.base64, mediaType: a.mediaType || 'audio/mpeg', fileName: a.fileName }
  : null)

// ── the field table ────────────────────────────────────────────────────────
// Each row: the snapshot key, the workspace key, and optionally
//   when(w)  — omit the field from the snapshot unless the target uses it, so a
//              FLUX entry carries no soundscape and a DramaBox one no ratio.
//              A gated-out field is written as `empty` (default '') rather than
//              dropped, exactly as the hand-written version did.
//   to(w)    — workspace value → snapshot value (default: copy as-is)
//   from(v, snap) — snapshot value → workspace value (default: copy as-is)
// `fallback` is what `from` yields for a snapshot that predates the field.

// Gates read the target's declared capabilities, not its id — so a second
// audio-video target would carry its soundscape and ratio without editing this file.
const hasRatio = (w) => !!caps(w.target).ratioPicker
const hasAudio = (w) => !!caps(w.target).audioFields
const hasRefs = (w) => !!caps(w.target).refImages && w.frameMode === 'ref'

export const WORKSPACE_FIELDS = [
  { snap: 'target',      state: 'target' },
  { snap: 'duration',    state: 'duration' },
  { snap: 'style',       state: 'style' },
  { snap: 'creativity',  state: 'creativity' },
  { snap: 'frameMode',   state: 'frameMode' },
  { snap: 'negative',    state: 'negative',  fallback: '' },
  { snap: 'scene',       state: 'scene',     fallback: '' },

  { snap: 'dialogue',   state: 'dialogue', when: w => w.show.dialogue, empty: '', fallback: '' },
  { snap: 'delivery',   state: 'delivery', when: w => w.show.dialogue, empty: '', fallback: '' },
  { snap: 'spokenLang', state: 'spokenLangId', when: w => w.show.spokenLang, empty: '', fallback: DEFAULT_SPOKEN_LANG,
    from: v => v || DEFAULT_SPOKEN_LANG },

  { snap: 'loraIds', state: 'activeLoraIds', fallback: [],
    from: v => (Array.isArray(v) ? v : []) },

  { snap: 'firstImg', state: 'firstImg', to: w => imgToSnap(w.firstImg), from: imgFromSnap, fallback: null },
  { snap: 'midImg',   state: 'midImg',   to: w => imgToSnap(w.midImg),   from: imgFromSnap, fallback: null },
  { snap: 'lastImg',  state: 'lastImg',  to: w => imgToSnap(w.lastImg),  from: imgFromSnap, fallback: null },

  // The snapshot stores the human-readable label so an entry stays meaningful if
  // the preset table is ever renumbered; the workspace holds the preset id.
  { snap: 'ratio', state: 'h3RatioId', when: hasRatio, empty: null, fallback: '',
    to: w => (presetById(w.h3RatioId, TARGETS[w.target].resolutions) || TARGETS[w.target].resolutions[0]).label,
    from: (label, snap) => TARGETS[snap.target]?.resolutions?.find(r => r.label === label)?.id || '' },

  { snap: 'soundscape', state: 'soundscape', when: hasAudio, empty: '', fallback: '' },
  { snap: 'music',      state: 'music',      when: hasAudio, empty: '', fallback: '' },

  { snap: 'refImages', state: 'refImages', when: hasRefs, empty: null, fallback: [],
    to: w => refImagesToSnap(w.refImages) },
  { snap: 'refAudio', state: 'refAudio', when: hasRefs, empty: null, fallback: null,
    to: w => refAudioToSnap(w.refAudio) },
]

// `refImages` needs an id generator, which a pure module cannot have — the caller
// injects one and this is the only field that uses it.
const REF_IMAGES_FIELD = 'refImages'

// Workspace → snapshot. `meta` carries the parts that are not compose fields:
// the writer/vision model actually used, the output count, and the assembled
// vision caption (null for a text-only run).
export function buildSnapshot(w, { model, vision, outputCount, caption = null } = {}) {
  const snap = { ts: Date.now(), outputCount, model, vision }
  for (const f of WORKSPACE_FIELDS) {
    if (f.when && !f.when(w)) { snap[f.snap] = 'empty' in f ? f.empty : ''; continue }
    snap[f.snap] = f.to ? f.to(w) : w[f.state]
  }
  snap.caption = caption || null
  return snap
}

// Snapshot → workspace values, ready to hand to App's setters. One
// implementation for restore() and for loading a queued item, which is the point:
// they used to be two copies that could drift.
export function snapshotToWorkspace(snap, { newId } = {}) {
  const out = {}
  for (const f of WORKSPACE_FIELDS) {
    const raw = snap[f.snap]
    if (f.snap === REF_IMAGES_FIELD) { out[f.state] = refImagesFromSnap(raw, newId); continue }
    if (f.snap === 'refAudio') { out[f.state] = refAudioFromSnap(raw); continue }
    if (f.from) { out[f.state] = f.from(raw, snap); continue }
    // A missing OR null value falls back, so an entry saved before the field
    // existed never puts null into a controlled input.
    out[f.state] = (raw == null && 'fallback' in f) ? f.fallback : raw
  }
  return out
}

// ── generation gates ───────────────────────────────────────────────────────
// The same six-branch frame-mode question was written out four times in App
// (addToQueue, enhance, hasImgNow, canGenerate) plus a fifth variant for
// proposeMode. Precedence matters and is preserved: an image-type target answers
// on firstImg alone and never consults frameMode.

const IMAGE_HUNGRY_MODES = new Set(['firstlast', 'firstmidlast', 'last', 'ref'])

// Does the workspace hold the input image(s) this target/mode needs? Also the
// answer to "will this run use the vision model".
export function hasRequiredImages(w) {
  if (w.targetType === 'image') return !!w.firstImg
  switch (w.frameMode) {
    case 'firstlast':    return !!(w.firstImg && w.lastImg)
    case 'firstmidlast': return !!(w.firstImg && w.midImg && w.lastImg)
    case 'last':         return !!w.firstImg
    case 'ref':          return (w.refImages || []).length > 0
    default:             return !!w.firstImg
  }
}

// Is there enough to generate at all? Image-first modes need their frames; every
// other case needs either a typed scene or one image to describe.
export function canGenerate(w) {
  if (w.targetType !== 'image' && IMAGE_HUNGRY_MODES.has(w.frameMode)) return hasRequiredImages(w)
  return !!(w.scene || '').trim() || !!w.firstImg
}

// No typed scene, but images to read → the writer proposes the scene from them.
export function isProposeMode(w) {
  return !(w.scene || '').trim() && hasRequiredImages(w)
}

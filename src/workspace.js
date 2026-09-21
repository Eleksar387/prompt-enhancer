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

import { TARGETS, DEFAULT_SPOKEN_LANG, MINIMAX_H3_REF_ROLES, caps, normalizeRole } from './constants'
import { imageHash, presetById } from './utils'

// ── image (de)serialization ────────────────────────────────────────────────
// A snapshot stores just the bytes and their identity; the live workspace also
// wants a previewUrl to render and a content hash for the vision cache. Entries
// saved before images were stored kept only a filename STRING — those must read
// back as absent, not as a broken image, which is what the `.base64` gate does.

export const imgToSnap = (im) => (im
  ? { base64: im.base64, mediaType: im.mediaType, fileName: im.fileName, hash: im.hash || imageHash(im.base64), ...(im.role ? { role: im.role } : {}) }
  : null)

export const imgFromSnap = (v) => ((v && typeof v === 'object' && v.base64)
  ? {
      base64: v.base64,
      mediaType: v.mediaType || 'image/jpeg',
      previewUrl: `data:${v.mediaType || 'image/jpeg'};base64,${v.base64}`,
      fileName: v.fileName,
      hash: v.hash || imageHash(v.base64),
      ...(v.role ? { role: v.role } : {}),
    }
  : null)

export const refImagesToSnap = (list) => (list || []).map(im => ({
  base64: im.base64, mediaType: im.mediaType, fileName: im.fileName,
  role: im.role, preserve: im.preserve, note: im.note || '',
  // The character-kind LoRA (if any) assigned directly on this reference's own
  // card — see "Per-reference LoRA/voice binding" in MinimaxRefPanel.jsx.
  loraId: im.loraId || null,
  // Add Guide timeline anchor (seconds) — see manualH3.js's anchorSentences /
  // App.jsx's "Manual Prompt" template and Manual mode assembler.
  atSeconds: im.atSeconds ?? null,
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
      loraId: im.loraId || null,
      atSeconds: im.atSeconds ?? null,
      hash: im.hash || imageHash(im.base64),
    }))
  : [])

// H3's audio input takes up to two voice-timbre samples (ref_audio_0 /
// ref_audio_1), so this is an array (max 2), not a single object. Entries
// saved before the second slot was wired up stored one bare object under
// this same snapshot key — refAudiosFromSnap accepts either shape and
// normalizes to an array, so an old entry restores as a one-item list.
export const refAudiosToSnap = (list) => (list || []).map(a => ({
  base64: a.base64, mediaType: a.mediaType, fileName: a.fileName,
  // Manual mode's Audio→Subject binding — the linked reference image's
  // content hash (stable across restore), not its volatile id. Absent for an
  // AI-mode-only entry or one saved before this existed.
  subjectRef: a.subjectRef || null,
}))

// `newId` is injected (App passes generateId from db.js) so the restored list
// gets stable React keys, the same as refImagesFromSnap; omit it and entries
// come back without an `id` (fine for a pure round-trip assertion in tests).
export const refAudiosFromSnap = (v, newId) => {
  const list = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : [])
  return list
    .filter(a => a && typeof a === 'object' && a.base64)
    .map(a => ({
      ...(newId ? { id: newId() } : {}),
      base64: a.base64, mediaType: a.mediaType || 'audio/mpeg', fileName: a.fileName,
      subjectRef: a.subjectRef || null,
    }))
    .slice(0, 2)
}

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
  // "Write it yourself" — MiniMax H3's zero-AI manual assembly mode (src/manualH3.js).
  // Meaningless for a non-H3 target but harmless to carry, same as activeLoraIds.
  { snap: 'manualMode', state: 'manualMode', fallback: false,
    from: v => v === true },
  { snap: 'negative',    state: 'negative',  fallback: '' },
  { snap: 'scene',       state: 'scene',     fallback: '' },

  { snap: 'dialogue',   state: 'dialogue', when: w => w.show.dialogue, empty: '', fallback: '' },
  { snap: 'delivery',   state: 'delivery', when: w => w.show.dialogue, empty: '', fallback: '' },
  { snap: 'spokenLang', state: 'spokenLangId', when: w => w.show.spokenLang, empty: '', fallback: DEFAULT_SPOKEN_LANG,
    from: v => v || DEFAULT_SPOKEN_LANG },

  { snap: 'loraIds', state: 'activeLoraIds', fallback: [],
    from: v => (Array.isArray(v) ? v : []) },
  // Which named character each active *character*-kind LoRA's trigger belongs
  // to, for a generation with more than one active at once — keyed by LoRA id,
  // set in LoraPanel next to that LoRA's chip once it's toggled on. Mirrors the
  // Scriptwriter's own cast→LoRA binding (there it's `c.lora` on a bible
  // character; here there is no bible, so the name is typed directly).
  { snap: 'loraSubjects', state: 'loraSubjects', fallback: {},
    from: v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {} },

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
  { snap: 'refAudio', state: 'refAudios', when: hasRefs, empty: null, fallback: [],
    to: w => refAudiosToSnap(w.refAudios) },
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
    if (f.snap === 'refAudio') { out[f.state] = refAudiosFromSnap(raw, newId); continue }
    if (f.from) { out[f.state] = f.from(raw, snap); continue }
    // A missing OR null value falls back, so an entry saved before the field
    // existed never puts null into a controlled input.
    out[f.state] = (raw == null && 'fallback' in f) ? f.fallback : raw
  }
  // A single-image snapshot's own `caption` IS that image's description (a
  // history entry's vision text, possibly hand-edited since; a queued item's
  // "Reuse image" description). Attach it to the loaded image so captionImages()
  // reuses it instead of asking the vision model again — filed under the
  // image's role (a snapshot's caption describes the image as that role saw it;
  // General for one saved before roles). Read fresh from the snapshot every
  // time — never stored on the image record itself, so a later
  // edit of the entry's description can't leave a stale copy behind. Multi-frame
  // and reference-mode captions cover several images and are never attached.
  const cap = typeof snap.caption === 'string' ? snap.caption.trim() : ''
  if (cap && out.firstImg && (!snap.frameMode || snap.frameMode === 'single' || snap.frameMode === 'last')) {
    out.firstImg = { ...out.firstImg, captions: { [normalizeRole(out.firstImg.role)]: cap } }
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

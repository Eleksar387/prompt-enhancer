import { useState, useRef, useEffect } from 'react'
import { flushSync } from 'react-dom'
import JSZip from 'jszip'
import { callOllama, isCloud } from '../api'
import {
  // The writer and director prompts this panel drives directly. The per-target
  // prompts (clip writers, frame-still writers) are NOT imported any more — they
  // come from the target table via clipSystem / FRAME_SYSTEM, so adding a target
  // does not mean adding an import here.
  SYSTEM_PROMPT_SCRIPTWRITER, SYSTEM_PROMPT_SCRIPTWRITER_SOURCE, SYSTEM_PROMPT_DIRECTOR, SYSTEM_PROMPT_DIRECTOR_H3,
  VISION_PROMPT_SCRIPTWRITER, VISION_PROMPT_MINIMAX_H3_REF,
  MINIMAX_H3_RESOLUTIONS, MINIMAX_H3_REF_ROLES, MINIMAX_H3_PRESERVE_OPTIONS, H3_MULTIFRAME_ADDENDUM,
  aspectParts, aspectSceneHint, aspectFramingHint,
  SCRIPTWRITER_NSFW_LINE, SCRIPTWRITER_NSFW_VISION_LINE,
  SPOKEN_LANGUAGES, DEFAULT_SPOKEN_LANG, spokenLangDef,
  TARGETS, caps, targetsWithCap,
} from '../constants'
import { btn, shrinkToJpeg, imageHash, mapWithConcurrency } from '../utils'
import { lorasByIds, loraInstruction, withLoraTriggers } from '../loras'
import { generateId } from '../db'
import { loadComfyCfg, saveComfyCfg, sendShot, fetchComfyOutputs, fetchComfyImageBlob } from '../comfy'
import ScriptwriterRefImages from './ScriptwriterRefImages'
import ScriptwriterVoiceRefs from './ScriptwriterVoiceRefs'
import LoraPanel from './LoraPanel'
import HistoryImageGallery from './HistoryImageGallery'
import QueuePanel from './QueuePanel'
import H3SyntaxBadge from './H3SyntaxBadge'

const GENRE_OPTIONS = [
  { id: 'auto',     label: 'Auto' },
  { id: 'drama',    label: 'Drama' },
  { id: 'thriller', label: 'Thriller' },
  { id: 'sci-fi',   label: 'Sci-fi' },
  { id: 'comedy',   label: 'Comedy' },
  { id: 'horror',   label: 'Horror' },
]

// Full Auto start-guard — the run ids this page session has already kicked
// off. A run starts when App bumps `scriptwriterKey`, mounting a fresh panel
// whose mount effect calls Phase 1. Any OTHER remount of a panel still
// holding a live `autoJob` — React Fast Refresh during development, above
// all — re-runs that effect and would restart the film from scratch. This
// has to sit at module scope: a ref would be reset by the very remount it
// needs to survive. App mints a new runId per deliberate start, so a ▶ Run
// retry of the same queue item is a different id and is never suppressed.
const startedAutoRuns = new Set()

const NSFW_HINT = 'Adult content — nudity, sex, graphic violence and other mature themes are allowed and written plainly, in the reference descriptions, the script, the director\u2019s cut and the clip prompts alike. Off keeps every call work-safe.'

// Full Auto mode synthesizes this as the "Story idea" line instead of asking
// the user to type one — the reference images (+ genre, + an optional
// one-line hint) carry the whole premise. runPhase1 itself is untouched: it
// just sees a normal idea string plus the usual reference-image block.
const AUTO_IDEA_BASE = 'Invent a complete, concrete short-film premise, cast, and plot entirely from the attached reference images and the chosen genre. Make confident creative choices — do not ask for more input or leave anything vague.'
const buildAutoIdea = (hint) => (hint && hint.trim())
  ? `${AUTO_IDEA_BASE}\n\nStory hint from the user (incorporate this): ${hint.trim()}`
  : AUTO_IDEA_BASE

// A writer-model response that declines the request outright reads as prose,
// not JSON — parseJSON already fails it, but as an indistinguishable "invalid
// JSON" error, which several call sites (the automatic merge pass, Full
// Auto's per-clip Phase 3) treat as a transient hiccup to skip past and keep
// going. A real content refusal is not transient — matching one of these
// openers marks the error `isRefusal: true` so those call sites stop the
// whole script instead of quietly continuing to the next call.
const REFUSAL_PATTERNS = [
  /\bI can'?t help with this request\b/i,
  /\bI can'?t (?:create|produce|generate|write|assist with|help (?:you )?with)\b/i,
  /\bI'?m not able to (?:create|produce|generate|help|assist)\b/i,
  /\bI won'?t (?:create|produce|generate|write)\b/i,
  /\bI cannot (?:create|produce|generate|write|assist|help)\b/i,
  /\bI(?:'?m| am) unable to (?:create|produce|generate|help|assist)\b/i,
  /\bI do not feel comfortable\b/i,
  /\bnon-consensual sexual\b/i,
  /\bsexual(?:ized|ly explicit)? (?:deepfake|content)\b.*\bwon'?t produce\b/i,
  /\bdepicting (?:that|an?) (?:identifiable )?person\b.*\b(?:nude|sexualiz)/i,
]
const looksLikeRefusal = (text) => {
  const t = (text || '').trim()
  if (!t) return false
  // Test only the opening — a refusal states itself up front, and this keeps
  // a long legitimate clip prompt (thousands of chars) cheap to check without
  // risking a false match buried somewhere in its body.
  return REFUSAL_PATTERNS.some(re => re.test(t.slice(0, 2000)))
}

const field = (extra = {}) => ({
  width: '100%', boxSizing: 'border-box',
  background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 6,
  padding: '8px 10px', color: 'var(--pe-ink)', fontSize: 13, outline: 'none',
  fontFamily: 'inherit', lineHeight: 1.5, transition: 'border-color 0.15s',
  ...extra,
})

const card = {
  background: 'var(--pe-rail)', border: '1px solid var(--pe-line)',
  borderRadius: 10, padding: '14px 16px', marginBottom: 12,
}

const lbl = {
  fontSize: 13.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase',
  letterSpacing: '0.5px', display: 'block', marginBottom: 4,
}

const genBtn = (disabled) => ({
  padding: '10px 24px', borderRadius: 8, border: 'none',
  background: disabled ? 'var(--pe-line)' : 'var(--pe-accent)',
  color: disabled ? 'var(--pe-ink-3)' : '#fff',
  fontSize: 14, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
})

// Small neutral action link/button used around attached frame images.
const ghostBtn = {
  padding: '3px 9px', borderRadius: 5, border: '1px solid var(--pe-line)',
  background: 'var(--pe-surface)', color: 'var(--pe-ink-3)', fontSize: 12.5, cursor: 'pointer',
}

// Image targets a reference-frame still (or a character portrait) can be generated
// for. Labels and system prompts come from the target table — `caps.frameTarget`
// marks a target as offered here — so adding one is a table edit rather than an
// edit to this file. Only the display ORDER lives here, the same way TARGET_GROUPS
// orders the main rail, and anything marked frameTarget but missing from the order
// is swept in at the end so a newly-added target is never silently hidden.
//
// Z-Image Turbo is the default here (see PORTRAIT_DEFAULT_TARGET below) and is a
// registered target like the rest, so nothing about it is special-cased any more.
const FRAME_TARGET_ORDER = ['flux', 'flux2klein', 'zimage', 'sdxl']
export const FRAME_TARGETS = [
  ...FRAME_TARGET_ORDER,
  ...targetsWithCap('frameTarget').map(t => t.id).filter(id => !FRAME_TARGET_ORDER.includes(id)),
].map(id => {
  const t = TARGETS[id]
  return caps(t).frameTarget ? { id, label: t.short || t.label.split(' \u00b7 ')[0] } : null
}).filter(Boolean)

export const FRAME_SYSTEM = Object.fromEntries(
  FRAME_TARGETS.map(f => [f.id, TARGETS[f.id].system]))

// What a character portrait is generated with unless the user picks otherwise. Its
// id is persisted in saved portrait drafts, so it is named once here.
export const PORTRAIT_DEFAULT_TARGET = 'zimage'

// Which writer produces a clip prompt, per the target table (`clipSystem`).
const clipSystemFor = (id) => TARGETS[id]?.clipSystem

// Phase 3 output model — one global choice for the whole run. Chosen on the
// script-review screen so the Director (phase 2) can specialise for it.
const DEFAULT_PROMPT_TARGET = 'minimax_h3'

// Clip-prompt targets, from the table (`caps.clipTarget`), default first.
export const PROMPT_TARGETS = targetsWithCap('clipTarget')
  .map(t => ({ id: t.id, label: t.clipLabel || t.short || t.label.split(' \u00b7 ')[0] }))
  .sort((a, b) => (a.id === DEFAULT_PROMPT_TARGET ? -1 : b.id === DEFAULT_PROMPT_TARGET ? 1 : 0))
const PROMPT_TARGET_LABEL = Object.fromEntries(PROMPT_TARGETS.map(t => [t.id, t.label]))
const DEFAULT_ASPECT_RATIO = 'land169'   // 16:9 landscape — film default

// Resolve the aspect-ratio state id to its MINIMAX_H3_RESOLUTIONS entry (used as
// the target-agnostic aspect-ratio list — only its orientation/ratio token
// matters here, not the H3 pixel dimensions).
const aspectRes = (id) => MINIMAX_H3_RESOLUTIONS.find(r => r.id === id) || MINIMAX_H3_RESOLUTIONS[0]
const aspectToken = (id) => aspectParts(aspectRes(id)).token || '16:9'

// Reference-image link types → a sensible default H3 role. The user can override
// the role per image; the link (which character / location it is) drives which
// shots the reference is attached to in the Ref2VA phase-3 output.
const REF_LINK_TYPES = [
  { id: 'character', label: 'Character', role: 'subject_identity', preserve: 'exact'       },  // lock the face
  { id: 'wardrobe',  label: 'Wardrobe',  role: 'wardrobe',         preserve: 'strong'      },
  { id: 'location',  label: 'Location',  role: 'environment',      preserve: 'guide'       },  // transfer the room, don't pixel-lock
  { id: 'style',     label: 'Style',     role: 'style',            preserve: 'inspiration' },
  { id: 'prop',      label: 'Prop',      role: 'product_object',   preserve: 'strong'      },
  { id: 'pose',      label: 'Pose',      role: 'pose_composition', preserve: 'guide'       },  // staging only — the look comes from the script
]
const linkTypeDef  = (id) => REF_LINK_TYPES.find(t => t.id === id) || null
const roleDef      = (id) => MINIMAX_H3_REF_ROLES.find(r => r.id === id) || MINIMAX_H3_REF_ROLES[0]
const preserveDef  = (id) => MINIMAX_H3_PRESERVE_OPTIONS.find(p => p.id === id) || MINIMAX_H3_PRESERVE_OPTIONS[1]
const roleLabel     = (id) => roleDef(id).label
const preserveLabel = (id) => preserveDef(id).label
const preserveMarker = (id) => preserveDef(id).marker

const FRAME_KEYS = ['first', 'mid', 'last']
const FRAME_LABELS = { first: 'First frame', mid: 'Mid frame', last: 'Last frame' }

const emptyFrameEntry = () => ({
  frames: {
    first: { target: 'flux', text: '', image: null, loading: false, error: '' },
    mid:   { target: 'flux', text: '', image: null, loading: false, error: '' },
    last:  { target: 'flux', text: '', image: null, loading: false, error: '' },
  }
})

// Persisted frame entries carry only { target, text, image }; rebuild the
// transient loading/error fields and tolerate a missing / older shape.
const rehydrateFrameEntry = (fp) => ({
  frames: Object.fromEntries(FRAME_KEYS.map(k => [k, {
    target: fp?.frames?.[k]?.target || 'flux',
    text:   fp?.frames?.[k]?.text   || '',
    image:  fp?.frames?.[k]?.image  || null,
    loading: false, error: '',
  }])),
})

const serializeFramePrompts = (fps) => (fps || []).map(fp => ({
  frames: Object.fromEntries(FRAME_KEYS.map(k => {
    const f = fp.frames[k]
    return [k, { target: f.target, text: f.text, image: f.image || null }]
  })),
}))

// --- reference images ------------------------------------------------------
const MAX_REF_IMAGES = 6
const REF_MAX_DIM = 1536

// Persisted shape — no id/previewUrl; bytes under `base64` (matches the
// standard-entry / refImages convention elsewhere in the app). `linkType`/`linkId`
// tie a reference to a named character or location in the script bible; `role`/
// `preserve` are the H3 Ref2VA role + preservation marker. `generated` marks a
// portrait the tool rendered (vs. a photo the user uploaded).
const serializeRefImages = (imgs) => (imgs || []).map(im => ({
  base64: im.base64 || null,
  mediaType: im.mediaType || 'image/jpeg',
  fileName: im.fileName || 'reference.jpg',
  note: im.note || '',
  caption: im.caption || '',
  linkType: im.linkType || '',
  linkId: im.linkId || '',
  role: im.role || '',
  preserve: im.preserve || 'strong',
  generated: !!im.generated,
  hash: im.hash || (im.base64 ? imageHash(im.base64) : ''),
}))

const rehydrateRefImage = (d) => ({
  id: generateId(),
  base64: d.base64 || null,
  mediaType: d.mediaType || 'image/jpeg',
  previewUrl: d.base64 ? `data:${d.mediaType || 'image/jpeg'};base64,${d.base64}` : null,
  fileName: d.fileName || 'reference.jpg',
  note: d.note || '',
  caption: d.caption || '',
  linkType: d.linkType || '',
  linkId: d.linkId || '',
  role: d.role || '',
  preserve: d.preserve || 'strong',
  generated: !!d.generated,
  hash: d.hash || (d.base64 ? imageHash(d.base64) : ''),
})

// --- voice references ------------------------------------------------------
// A few seconds of speech per character, guiding H3's timbre, pitch and
// delivery. Never words: the spoken lines always come from the script's own
// dialogue, so a clip the Director left silent stays silent. `characterId` is a
// bible id ("c1"); '' means "the default voice for whoever speaks", which is
// what a Full Auto upload necessarily is - it is queued before any cast exists.
const MAX_VOICE_REFS = 6

const serializeVoiceRefs = (vs) => (vs || []).map(v => ({
  base64: v.base64 || null,
  mediaType: v.mediaType || 'audio/mpeg',
  fileName: v.fileName || 'voice.mp3',
  characterId: v.characterId || '',
}))

const rehydrateVoiceRef = (d) => ({
  id: generateId(),
  base64: d.base64 || null,
  mediaType: d.mediaType || 'audio/mpeg',
  fileName: d.fileName || 'voice.mp3',
  characterId: d.characterId || '',
})

// Stable identifier for a reference image across serialize / rehydrate (the
// in-memory `id` is regenerated on load). Used to pin an explicit reference set
// on a clip (shot.refs).
const refKey = (im) => im.hash || (im.caption || '').trim() || im.fileName || ''

// MM:SS.mmm — the exact timestamp format SYSTEM_PROMPT_MINIMAX_H3's rule 5
// cut-timestamp convention already uses ("At MM:SS.mmm, …"), reused here for
// Timeline-anchor sentences so both share one clock format in the prompt.
const formatTimestamp = (seconds) => {
  const s = Math.max(0, Number(seconds) || 0)
  const m = Math.floor(s / 60)
  const rem = (s - m * 60).toFixed(3).padStart(6, '0')
  return `${String(m).padStart(2, '0')}:${rem}`
}

// Tidy one finished H3 clip prompt. The writer model regularly (a) wraps the
// output in a ```lang fence and (b) drops the leading field label, emitting a
// bare "[Shot 1] …" instead of "integrated_multimodal_description: [Shot 1] …"
// (T2VA) / "subject_definitions: …" (Ref2VA). H3 needs that first label, so
// re-attach it deterministically.
const normalizeH3Prompt = (raw, isRef) => {
  let t = (raw || '').trim()
    .replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
  const label = isRef ? 'subject_definitions:' : 'integrated_multimodal_description:'
  const has = isRef
    ? /^\s*subject_definitions\s*:/i.test(t)
    : /^\s*integrated_multimodal_description\s*:/i.test(t)
  // Only prepend when the body clearly starts with the description itself (a
  // shot marker or ordinary opening prose) — never in front of some other field.
  if (!has && /^\s*(\[Shot\s*\d+\]|<Picture\b|<Subject\b|In\b|At\b|The\b|From\b|A\b|An\b|On\b)/i.test(t)) {
    t = `${label} ${t}`
  }
  return t
}

// System prompt for "🔊 Attach voice reference" — a narrow, low-temperature
// patch call used instead of a full ✦ Rewrite when the only thing that
// changed is which voice-timbre reference(s) a clip carries. A full rewrite
// re-writes the whole clip from scratch at temp 0.85, which can drift the
// visual description for the sake of what should be a boilerplate audio
// pointer; this call is given the clip's own already-generated text verbatim
// and told to change nothing else. H3's audio input takes up to two separate
// voice-timbre samples (Audio 1 / Audio 2), one per speaking subject.
const VOICE_PATCH_SYSTEM = `You edit ONE existing MiniMax H3 video-generation prompt to attach, update, or remove its voice-timbre reference(s). You are given the clip's current, already-finished prompt text below — reproduce it exactly, word for word, section for section, EXCEPT for the Audio-reference addition/update/removal described here. Do not rewrite, rephrase, shorten, or otherwise touch anything else in it, even if you would phrase it differently.

You are given one or two voice-timbre references to attach, labelled "Audio 1" and (if present) "Audio 2". Make the text's Audio references match this set EXACTLY: update any that already match a given one, add any that are missing, and remove any "<Audio N>" reference already in the text that is NOT in the given set (renumber the remaining ones contiguously as Audio 1, Audio 2 if a removal leaves a gap). If neither Audio 1 nor Audio 2 is given, remove every existing Audio reference from the text entirely (all three of the spots below).

Two possible formats — use whichever the given text is already in:
- Six-field format (starts with "subject_definitions:"): each Audio N gets one line at the end of the subject_definitions section: "<Audio N> is the voice-timbre reference for <Subject k> (Sk)." — pick k as the subject who speaks that reference's dialogue, reusing that subject's number exactly as already used elsewhere in the text (never invent a new one, never point two different Audio N lines at the same subject). If the summary section's opening bracketed marker doesn't already include "audio reference", add it (joined with " + ") when at least one Audio reference remains, or remove it when none do. Each Audio N gets one line at the end of retention_analysis: "<Audio N>: reference - " plus a short reason.
- Three-field format (starts with "integrated_multimodal_description:"): weave one short clause per Audio reference into integrated_multimodal_description, right where that speaking character is introduced or first shown speaking, noting their voice is guided by a voice-timbre reference — timbre, pitch and delivery only, never its original wording or a transcript.

In both formats, each reference is described only as: never transcribe or guess at its original wording — reference ONLY its timbre, pitch and delivery for the speaking subject.

Output ONLY the complete corrected prompt text. No preamble, no commentary, no code fence, no explanation of what you changed.`

// The H3 Director's per-clip `reference_images` — 1-based numbers into the
// numbered "Reference images" block (= the captioned refs in array order) —
// resolved to refKey[]. Returns null when the field is absent (clip stays on
// the auto default), or [] when the Director explicitly wants no reference.
const resolveRefSelection = (indices, captioned) => {
  if (!Array.isArray(indices)) return null
  const keys = []
  for (const n of indices) {
    const im = captioned[Number(n) - 1]
    if (im) { const k = refKey(im); if (!keys.includes(k)) keys.push(k) }
  }
  return keys
}

// Name of the bible entry a reference points at, for the folded-in text block.
const refEntityName = (im, script) => {
  if (im.linkType === 'character') return (script?.characters || []).find(c => c.id === im.linkId)?.name || ''
  if (im.linkType === 'location')  return (script?.locations  || []).find(l => l.id === im.linkId)?.name || ''
  return ''
}

// The text block folded into a phase's user message — captioned images only.
const assembleRefBlock = (refImages, heading, script = null) => {
  const done = (refImages || []).filter(im => im.caption && im.caption.trim())
  if (!done.length) return ''
  const lines = done.map((im, i) => {
    const bits = []
    if (im.linkType) bits.push(linkTypeDef(im.linkType)?.label || im.linkType)
    const name = refEntityName(im, script)
    if (name) bits.push(`"${name}"`)
    if (im.note && im.note.trim()) bits.push(`note: ${im.note.trim()}`)
    const tag = bits.length ? ` (${bits.join(' — ')})` : ''
    return `Image ${i + 1}${tag}: ${im.caption.trim()}`
  })
  return `\n\n${heading}\n${lines.join('\n')}`
}

const REF_HEADING_CANON =
  'Reference images provided by the user (treat these as canon for how the people, places, and props in this film look — fold each one into the matching character or location in the bible):'
const REF_HEADING_DIRECTOR =
  'Reference images provided by the user (keep every shot visually consistent with these — same faces, wardrobe, and locations):'
const REF_HEADING_SHOT =
  'Reference images provided by the user (keep this shot visually consistent with these — same faces, wardrobe, and location):'
const REF_HEADING_LITE =
  'Continuity references — keep the character(s), wardrobe, and location consistent with these descriptions; do NOT add them as new elements and do NOT describe them verbatim:'

// --- id normalisation ----------------------------------------------------
// LLMs do not keep the c1/l1 ids stable (or emit them at all), and put names in
// scenes[].characters / shots[].characters. Everything downstream — the cast-card
// link dropdown, refImages[].linkId, shotRefs() — needs canonical ids, so we
// assign them ourselves and resolve names against them.
const slug = (s) => String(s ?? '').trim().toLowerCase()

// Assign c1..cN / l1..lN, then rewrite every scene's characters[]/location_id to
// those ids (resolving whatever the model wrote — id, name, or nothing).
const normalizeScript = (data) => {
  if (!data || typeof data !== 'object') return data
  const characters = Array.isArray(data.characters) ? data.characters : []
  const locations = Array.isArray(data.locations) ? data.locations : []
  const cIdByAny = new Map()
  const chars = characters.map((c, i) => {
    const id = `c${i + 1}`
    if (c?.id) cIdByAny.set(slug(c.id), id)
    if (c?.name) cIdByAny.set(slug(c.name), id)
    cIdByAny.set(slug(id), id)
    return { ...c, id }
  })
  const lIdByAny = new Map()
  const locs = locations.map((l, i) => {
    const id = `l${i + 1}`
    if (l?.id) lIdByAny.set(slug(l.id), id)
    if (l?.name) lIdByAny.set(slug(l.name), id)
    lIdByAny.set(slug(id), id)
    return { ...l, id }
  })
  const resolveChar = (v) => cIdByAny.get(slug(v)) || null
  const resolveLoc = (v) => lIdByAny.get(slug(v)) || null
  const scenes = (Array.isArray(data.scenes) ? data.scenes : []).map((s, i) => {
    const raw = Array.isArray(s?.characters) ? s.characters
      : (Array.isArray(s?.dialogues) ? s.dialogues.map(d => String(d).split(':')[0]) : [])
    const ids = [...new Set(raw.map(resolveChar).filter(Boolean))]
    return {
      ...s,
      id: s?.id ?? i + 1,
      characters: ids,
      location_id: resolveLoc(s?.location_id) || locs[0]?.id || '',
    }
  })
  // format_note: the writer's own flag that the idea was really a bigger story
  // narrowed to fit the micro-film length. Coerce to a plain string (or '').
  const format_note = typeof data.format_note === 'string' ? data.format_note.trim() : ''
  return { ...data, format_note, characters: chars, locations: locs, scenes }
}

// Rewrite each shot's characters[]/location_id/scene_id against a normalized script.
const normalizeDirectorsCut = (data, script) => {
  if (!data || !Array.isArray(data.shots)) return data
  const cIdByAny = new Map()
  for (const c of script?.characters || []) { cIdByAny.set(slug(c.id), c.id); if (c.name) cIdByAny.set(slug(c.name), c.id) }
  const lIdByAny = new Map()
  for (const l of script?.locations || []) { lIdByAny.set(slug(l.id), l.id); if (l.name) lIdByAny.set(slug(l.name), l.id) }
  const scenes = script?.scenes || []
  const resolveScene = (v, idx) => {
    const hit = scenes.find(s => String(s.id) === String(v))
    if (hit) return hit.id
    const byTitle = scenes.find(s => slug(s.title) && slug(s.title) === slug(v))
    if (byTitle) return byTitle.id
    return scenes[Math.min(idx, Math.max(0, scenes.length - 1))]?.id ?? v
  }
  const shots = data.shots.map((sh, i) => {
    const raw = Array.isArray(sh?.characters) ? sh.characters : []
    return {
      ...sh,
      scene_id: resolveScene(sh?.scene_id, i),
      characters: [...new Set(raw.map(v => cIdByAny.get(slug(v))).filter(Boolean))],
      location_id: lIdByAny.get(slug(sh?.location_id)) || sh?.location_id || '',
    }
  })
  return { ...data, shots }
}

// Re-sequence shot_number 1..N after an insert / remove.
const renumberShots = (shots) => (shots || []).map((s, i) => ({ ...s, shot_number: i + 1 }))

// A fresh, mostly-empty clip that inherits its context from an adjacent clip
// (scene, location, cast, look) so it slots in cleanly. shot_number is set by
// renumberShots; the AI ✦ Rewrite fills the beat / camera fields.
const blankShot = (neighbor, isH3now, script) => {
  const scene0 = script?.scenes?.[0] || null
  return {
    shot_number: 0,
    scene_id: neighbor?.scene_id ?? scene0?.id ?? 1,
    scene_title: neighbor?.scene_title ?? scene0?.title ?? '',
    shot_type: isH3now ? 'performance' : undefined,
    characters: Array.isArray(neighbor?.characters) ? [...neighbor.characters] : [],
    location_id: neighbor?.location_id ?? scene0?.location_id ?? '',
    camera_framing: '', camera_movement: '', eyeline: '',
    primary_beat: '', visual_action: '',
    dialogue: [],
    lighting_mood: neighbor?.lighting_mood ?? script?.look ?? '',
    duration: isH3now ? 7 : 4,
    notes: 'inserted clip — needs a beat',
  }
}

// Pure "what's missing and where" half of the dialogue-coverage fix — see
// fillDialogueGaps (inside the component, below) for the LLM half that
// actually writes each missing clip. Verified against a real run (a
// sourceMode letter adaptation): SYSTEM_PROMPT_DIRECTOR_H3's DIALOGUE rule
// already says "copy each line verbatim", but that only governs how to
// format a line the model decides to place — nothing requires that EVERY
// scene dialogue/narration line end up in some clip. Under "fewest clips"
// pressure (a scene with several V.O. lines needs that many dedicated
// clips, since a voiceover line "claims the whole clip" per the same rule)
// the model resolves the conflict by silently dropping lines instead of
// adding clips — 12 of 17 scene lines were missing in the entry that
// surfaced this. Same lesson as isMergeEligible/mergeShotPair above it in
// this file: prompt wording alone ("verbatim") wasn't enough, so this closes
// the gap deterministically instead of relying on more prose.
//
// Returns one entry per scene that has at least one uncovered line:
// { sceneId, anchor, lines }. `anchor` is the shot index this scene's
// missing lines should be inserted after — the LAST shot carrying that
// scene_id in the current list, not forced into scene-contiguous order, so a
// scene that gets cross-cut with another (a frame narrative cutting back to
// a flashback and back) still gets its line placed where that scene last
// actually appears. A scene that contributed no shots at all anchors after
// the nearest earlier scene that did, or -1 (insert at the very start).
const normDialogue = (s) => String(s || '').trim().replace(/\s+/g, ' ')

export const findMissingDialogue = (shots, script) => {
  const scenes = script?.scenes || []
  const list = Array.isArray(shots) ? shots : []
  if (!scenes.length || !list.length) return []
  const lastIdxByScene = new Map()
  list.forEach((s, i) => lastIdxByScene.set(String(s.scene_id), i))
  const gaps = []
  scenes.forEach((scene, sceneIdx) => {
    const lines = (Array.isArray(scene?.dialogues) ? scene.dialogues : []).filter(d => d && String(d).trim())
    if (!lines.length) return
    const covered = new Set(
      list
        .filter(s => String(s.scene_id) === String(scene.id))
        .flatMap(s => Array.isArray(s.dialogue) ? s.dialogue.map(normDialogue) : [])
    )
    const missing = lines.filter(l => !covered.has(normDialogue(l)))
    if (!missing.length) return
    let anchor = lastIdxByScene.get(String(scene.id))
    if (anchor === undefined) {
      anchor = -1
      for (let j = sceneIdx - 1; j >= 0; j--) {
        const a = lastIdxByScene.get(String(scenes[j].id))
        if (a !== undefined) { anchor = a; break }
      }
    }
    gaps.push({ sceneId: scene.id, anchor, lines: missing })
  })
  return gaps
}

const PACING_OPTIONS = [
  { id: 'tight',    label: 'Tight'    },
  { id: 'standard', label: 'Standard' },
  { id: 'loose',    label: 'Loose'    },
]
const PACING_LINE = {
  tight:    'Pacing: TIGHT — use the fewest clips that respect the two-beat limit. Aim for ~2 clips per scene; split only when a clip truly exceeds two facial beats.',
  standard: 'Pacing: STANDARD — about 3 clips per scene.',
  loose:    'Pacing: LOOSE — extra coverage is welcome; more reaction and insert clips are fine.',
}

const STEPS = ['Script', "Director's Cut", 'Video Prompts']

export default function ScriptwriterPanel({
  cfg, writerModel, visionModel = '', initialState = null, onSaveHistory = null,
  history = [],
  library = [], onAddLibraryImages = null, onRemoveLibraryImage = null,
  onSaveLibraryCaption = null, onSetLibraryRole = null, onDescribeLibraryImage = null,
  comfyCfg: comfyCfgProp = null, setComfyCfg: setComfyCfgProp = null,
  // The LoRA library is owned by App.jsx (shared with the standalone workspace
  // and persisted there); this panel only reads it and edits it through the
  // callback. Which style LoRAs a film uses is local state below.
  loras = [], onSaveLoras = null,
  // Full Auto: `autoJob` is a queued job spec ({ refImages, voiceRefs, genre, mature,
  // hint, pacing, spokenLang, loraIds } plus a per-start `runId` — see startedAutoRuns) to
  // run headlessly on mount — see the mount effect below. `onAutoJobDone`
  // reports { ok, error? } back to App.jsx once phase reaches 'done' (or a
  // phase fails). `onQueueAutoJob` queues a new job from the Full Auto input
  // screen. `queueProps` is the same prop shape App.jsx feeds QueuePanel,
  // reused here (filtered) for the embedded Full Auto queue view.
  autoJob = null, onAutoJobDone = null, onQueueAutoJob = null, queueProps = null,
  // The SAME "⚙ Admin" toggle in App.jsx's sticky header — passed down rather
  // than kept as separate local state so there is only ever one Admin switch
  // in the whole app, not a second one a user can miss or confuse with the
  // first. See reviewPhase1/reviewPhase2 below for what it does here.
  adminMode = false,
}) {
  const sessionId = useRef(initialState?.id || generateId())
  const visModel = visionModel || writerModel

  // ComfyUI handoff config — use the shared one from App when provided, else a
  // self-contained local copy so the panel still works standalone.
  const [comfyCfgLocal, setComfyCfgLocal] = useState(loadComfyCfg)
  const comfyCfg = comfyCfgProp || comfyCfgLocal
  const setComfyCfg = setComfyCfgProp || setComfyCfgLocal
  useEffect(() => { if (!setComfyCfgProp) saveComfyCfg(comfyCfgLocal) }, [comfyCfgLocal, setComfyCfgProp])
  // { key: "<shotIdx>-<frameKey>" | null, state: 'idle'|'sending'|'done'|'error', error }
  const [comfyFrame, setComfyFrame] = useState({ key: null, state: 'idle', error: '' })

  const [phase, setPhase] = useState(initialState?.phase || 'input')
  const [idea, setIdea] = useState(initialState?.idea || '')
  const [genre, setGenre] = useState(initialState?.genre || 'auto')
  // NSFW toggle. Every LLM call in the chain reads `nsfwLine`, so the rating
  // set here survives all the way to the clip prompts instead of being applied
  // once and lost at the next hand-off. Off by default; a restored session (and
  // a queued Full Auto job) keeps whatever it was saved with.
  const [mature, setMature] = useState(initialState?.mature ?? false)
  const nsfwLine = mature ? SCRIPTWRITER_NSFW_LINE : ''
  // Guided-mode only: treat `idea` as a complete source text (a letter, a
  // diary entry) to dramatize faithfully rather than a one-line pitch to
  // invent from — swaps the Phase 1 writer prompt and raises the scene cap.
  const [sourceMode, setSourceMode] = useState(initialState?.sourceMode ?? false)
  const sceneCap = sourceMode ? 15 : 5
  // Admin mode (the `adminMode` prop, same switch as App.jsx's header button):
  // Phase 1 / Phase 2 pause right before they send and let the exact system +
  // user message be read and edited first. Built fresh here rather than
  // reusing App.jsx's useAdminReview, which is keyed to one target's prompt —
  // the Scriptwriter has three distinct phases, each its own system prompt.
  // Phase 3 fires one call per clip in parallel; those stay console-inspectable
  // (window.__peLastH3Messages) plus the existing per-clip "✦ Rewrite" button,
  // rather than N editable review panels. Never used for a Full Auto run —
  // see the autoActive checks at each pause site.
  const [reviewPhase1, setReviewPhase1] = useState(null)   // { system, user, refs } | null
  const [reviewPhase2, setReviewPhase2] = useState(null)   // { system, user, refs } | null
  const [sceneCount, setSceneCount] = useState(initialState?.sceneCount || 1)
  // Normalise on load so restored / older / model-broken entries self-repair
  // (the c1/l1 ids the whole ref-attachment path depends on).
  const [script, setScript] = useState(() => initialState?.script ? normalizeScript(initialState.script) : null)
  const [directorsCut, setDirectorsCut] = useState(() =>
    initialState?.directorsCut && initialState?.script
      ? normalizeDirectorsCut(initialState.directorsCut, normalizeScript(initialState.script))
      : (initialState?.directorsCut || null))
  const [finalPrompts, setFinalPrompts] = useState(() => {
    const h3 = (initialState?.promptTarget || DEFAULT_PROMPT_TARGET) === 'minimax_h3'
    // Re-attach a dropped first field label on older / model-broken entries.
    return (initialState?.finalPrompts || []).map(p => ({
      ...p, loading: false, error: '',
      text: h3 && p.text ? normalizeH3Prompt(p.text, /<Subject\s*\d/.test(p.text)) : p.text,
    }))
  })
  const [framePrompts, setFramePrompts] = useState(() => {
    if (initialState?.framePrompts?.length) return initialState.framePrompts.map(rehydrateFrameEntry)
    if (initialState?.directorsCut?.shots?.length) return initialState.directorsCut.shots.map(() => emptyFrameEntry())
    return []
  })
  // Phase 3 output model + (H3-only) aspect ratio.
  const [promptTarget, setPromptTarget] = useState(initialState?.promptTarget || DEFAULT_PROMPT_TARGET)
  const [aspectRatio, setAspectRatio]   = useState(initialState?.aspectRatio ?? initialState?.h3Ratio ?? DEFAULT_ASPECT_RATIO)
  const [pacing, setPacing]             = useState(initialState?.pacing || 'standard')
  // Active *style* LoRAs for this film. Character LoRAs are deliberately NOT
  // activated here: they are bound to a cast member in the bible and resolved
  // per clip (see lorasForShot), so a two-lead film never sprays both leads'
  // triggers over every shot.
  const [activeLoraIds, setActiveLoraIds] = useState(() =>
    Array.isArray(initialState?.loraIds) ? initialState.loraIds : [])
  // The language the cast speaks. This picker SEEDS the film: Phase 1 is told to
  // write its dialogue in it and `script.language` is set from it. From then on
  // `script.language` (hand-editable in the script view, and what all four
  // langLine sites read) is the authority — that is how a language outside these
  // three, say Japanese, stays reachable.
  const [spokenLangId, setSpokenLangId] = useState(initialState?.spokenLang || DEFAULT_SPOKEN_LANG)
  // Transient per-entity portrait/still generator state (the resulting image is
  // persisted as a refImages entry, not here). Key: "c1" | "l1".
  const [portraitDraft, setPortraitDraft] = useState({})
  const [error, setError] = useState('')
  const [rawFallback, setRawFallback] = useState('')
  const [copied, setCopied] = useState(null)
  const [copiedAll, setCopiedAll] = useState(false)
  const [copiedFrame, setCopiedFrame] = useState(null)
  const [exporting, setExporting] = useState(false)
  // Per-item AI re-write: index of the scene being rewritten on the script
  // screen / the clip being rewritten by the Director (dircut screen) /
  // re-prompted by phase 3 (video-prompts screen).
  const [sceneBusy, setSceneBusy] = useState(null)
  const [shotBusy, setShotBusy] = useState(null)
  const [promptBusy, setPromptBusy] = useState(null)
  // Fold state for the Director's-Cut clip/shot cards and the Video-Prompts
  // cards — both lists get long fast (10+ clips, each with a full field set
  // or a multi-paragraph prompt), so every card starts folded and opens only
  // on click. Index-keyed (not persisted — purely transient view state); the
  // insert/remove/merge handlers below keep the indices in step with the
  // splices they already do to directorsCut.shots/finalPrompts.
  const [expandedShots, setExpandedShots] = useState(() => new Set())
  const [expandedPrompts, setExpandedPrompts] = useState(() => new Set())
  const toggleShotExpanded = (si) => setExpandedShots(prev => {
    const next = new Set(prev)
    next.has(si) ? next.delete(si) : next.add(si)
    return next
  })
  const togglePromptExpanded = (i) => setExpandedPrompts(prev => {
    const next = new Set(prev)
    next.has(i) ? next.delete(i) : next.add(i)
    return next
  })
  // Re-key an expanded-index Set across a splice, same shape as renumberShots
  // above but for view state that lives outside directorsCut/finalPrompts.
  const shiftExpandedForInsert = (set, atIndex) => {
    const next = new Set()
    set.forEach(i => next.add(i >= atIndex ? i + 1 : i))
    return next
  }
  const shiftExpandedForRemove = (set, si) => {
    const next = new Set()
    set.forEach(i => { if (i !== si) next.add(i > si ? i - 1 : i) })
    return next
  }
  const shiftExpandedForMerge = (set, si) => {
    const next = new Set()
    set.forEach(i => { if (i !== si && i !== si + 1) next.add(i > si + 1 ? i - 1 : i) })
    return next
  }
  // ComfyUI output picker: { key: "<shotIdx>-<frameKey>" | null, loading, error, items: [] }
  const [picker, setPicker] = useState({ key: null, loading: false, error: '', items: [] })
  // { key | null, state: 'idle'|'fetching'|'error', error } — the fetch+encode of a chosen image
  const [attach, setAttach] = useState({ key: null, state: 'idle', error: '' })
  const [refImages, setRefImages] = useState(() => (initialState?.refImages || []).map(rehydrateRefImage))
  const [voiceRefs, setVoiceRefs] = useState(() => (initialState?.voiceRefs || []).map(rehydrateVoiceRef))
  // { state: 'idle' | 'reading' | 'error', done, total, error }
  const [refCaptionStatus, setRefCaptionStatus] = useState({ state: 'idle', done: 0, total: 0, error: '' })
  const captioning = refCaptionStatus.state === 'reading'

  // Full Auto — Guided/Full-Auto toggle on the input screen (UI only), the
  // optional one-line hint text, and the auto-chain machinery for a queued
  // job (see the two useEffects after runPhase1/2/3 below).
  const [autoMode, setAutoMode] = useState(false)
  const [autoHint, setAutoHint] = useState('')
  const [autoActive, setAutoActive] = useState(!!autoJob)
  const [autoQueueOpen, setAutoQueueOpen] = useState(true)
  // Full Auto's own Pacing choice — deliberately separate from the shared
  // Guided-mode `pacing` state below (which stays 'standard' by default;
  // those users already see and control it on the Script screen). Full Auto
  // never reaches that screen, so it needs its own visible picker, and its
  // default is 'tight' since that's the value that actually keeps clip
  // counts down for an autonomous run.
  const [autoPacing, setAutoPacing] = useState('tight')
  const autoDoneRef = useRef(false)

  const reset = () => {
    sessionId.current = generateId()
    setPhase('input'); setIdea(''); setGenre('auto'); setSourceMode(false); setSceneCount(1)
    setScript(null); setDirectorsCut(null); setFinalPrompts([]); setFramePrompts([])
    setPromptTarget(DEFAULT_PROMPT_TARGET); setAspectRatio(DEFAULT_ASPECT_RATIO); setPacing('standard'); setPortraitDraft({})
    setError(''); setRawFallback(''); setCopied(null); setCopiedAll(false)
    setSceneBusy(null); setShotBusy(null); setPromptBusy(null)
    setComfyFrame({ key: null, state: 'idle', error: '' })
    setPicker({ key: null, loading: false, error: '', items: [] })
    setAttach({ key: null, state: 'idle', error: '' })
    setRefImages([])
    setRefCaptionStatus({ state: 'idle', done: 0, total: 0, error: '' })
  }

  const parseJSON = (text) => {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    try { return JSON.parse(clean) }
    catch {
      setRawFallback(text)
      if (looksLikeRefusal(text)) {
        throw Object.assign(
          new Error(`The model refused this request: "${text.trim()}"`),
          { isRefusal: true }
        )
      }
      throw new Error('LLM returned invalid JSON. Try a stronger model or click Retry.')
    }
  }

  // --- reference images: upload + vision captioning -----------------------
  const fileToRef = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.onload = () => shrinkToJpeg(reader.result, REF_MAX_DIM, 0.85)
      .then(({ base64, mediaType }) => resolve({
        id: generateId(), base64, mediaType,
        previewUrl: `data:${mediaType};base64,${base64}`,
        fileName: file.name || 'reference.jpg', note: '', caption: '',
        linkType: '', linkId: '', role: '', preserve: 'strong', generated: false,
        hash: imageHash(base64),
      }))
      .catch(reject)
    reader.readAsDataURL(file)
  })

  // Guess which bible entry an untyped reference belongs to, from its note/filename.
  const guessRefLink = (im) => {
    if (im.linkType || !script) return null
    const hay = `${im.note || ''} ${im.fileName || ''}`.toLowerCase()
    const c = (script.characters || []).find(x => x.name && hay.includes(x.name.toLowerCase()))
    if (c) { const d = linkTypeDef('character'); return { linkType: 'character', linkId: c.id, role: d.role, preserve: d.preserve } }
    const l = (script.locations || []).find(x => x.name && hay.includes(x.name.toLowerCase()))
    if (l) { const d = linkTypeDef('location'); return { linkType: 'location', linkId: l.id, role: d.role, preserve: d.preserve } }
    return null
  }

  const addRefFiles = async (fileList) => {
    const room = MAX_REF_IMAGES - refImages.length
    const files = Array.from(fileList || []).filter(f => f.type.startsWith('image/')).slice(0, room)
    const added = []
    for (const f of files) { try { const r = await fileToRef(f); added.push({ ...r, ...(guessRefLink(r) || {}) }) } catch { /* skip bad file */ } }
    if (added.length) setRefImages(prev => [...prev, ...added])
  }

  // Reuse an image picked from the "Reuse image from history" gallery — added as
  // a new reference image, fuzzy-linked to the bible by note/filename. A caption
  // carried over from a past reference is kept as-is; otherwise it is described
  // on the spot (best-effort, like the on-card uploads).
  const addRefFromHistory = (d) => {
    if (!d?.base64 || refImages.length >= MAX_REF_IMAGES) return
    const dupe = refImages.some(im =>
      (im.hash && d.hash && im.hash === d.hash) || (im.base64 && im.base64 === d.base64))
    if (dupe) return
    const hash = d.hash || imageHash(d.base64)
    const base = {
      id: generateId(), base64: d.base64, mediaType: d.mediaType || 'image/jpeg',
      previewUrl: `data:${d.mediaType || 'image/jpeg'};base64,${d.base64}`,
      fileName: d.fileName || 'reference.jpg', note: d.note || '', caption: d.caption || '',
      linkType: '', linkId: '', role: d.role || '', preserve: 'strong', generated: false, hash,
    }
    const withLink = { ...base, ...(guessRefLink(base) || {}) }
    const next = [...refImages, withLink]
    setRefImages(next)
    if (withLink.caption) persistState(undefined, next)
    else captionRefImages({ imgs: next }).then(c => persistState(undefined, c)).catch(() => {})
  }

  const removeRefImage   = (id) => setRefImages(prev => prev.filter(im => im.id !== id))
  const addVoiceRef      = (d) => setVoiceRefs(prev => prev.length >= MAX_VOICE_REFS ? prev : [...prev, rehydrateVoiceRef(d)])
  const removeVoiceRef   = (id) => setVoiceRefs(prev => prev.filter(v => v.id !== id))
  const setVoiceCharacter = (id, characterId) => setVoiceRefs(prev => prev.map(v => v.id === id ? { ...v, characterId } : v))
  const updateRefNote    = (id, note) => setRefImages(prev => prev.map(im => {
    if (im.id !== id) return im
    const g = guessRefLink({ ...im, note })
    return { ...im, note, ...(g || {}) }
  }))
  const updateRefCaption = (id, caption) => setRefImages(prev => prev.map(im => im.id === id ? { ...im, caption } : im))
  const updateRefField   = (id, patch)   => setRefImages(prev => prev.map(im => im.id === id ? { ...im, ...patch } : im))

  // Backfill a link TARGET for any reference that has a link type but no target —
  // by name match (note/caption) or, failing that, the sole entry of that kind.
  // Runs whenever the bible changes so restored / half-linked refs self-heal.
  useEffect(() => {
    if (!script) return
    setRefImages(prev => {
      let changed = false
      const cs = script.characters || [], ls = script.locations || []
      const next = prev.map(im => {
        if (im.linkId || !im.linkType) return im
        const isChar = im.linkType === 'character' || im.linkType === 'wardrobe'
        const list = isChar ? cs : im.linkType === 'location' ? ls : []
        if (!list.length) return im
        const hay = `${im.note || ''} ${im.caption || ''}`.toLowerCase()
        const byName = list.find(e => e.name && hay.includes(e.name.toLowerCase()))
        const linkId = byName?.id || (list.length === 1 ? list[0].id : '')
        if (!linkId) return im
        changed = true
        return { ...im, linkId }
      })
      return changed ? next : prev
    })
  }, [script])
  // Set a reference's link type + default H3 role/preservation, and auto-select
  // the link target when the bible has exactly one candidate of that kind.
  const setRefLinkType   = (id, linkType) => setRefImages(prev => prev.map(im => {
    if (im.id !== id) return im
    const d = linkTypeDef(linkType)
    const cs = script?.characters || [], ls = script?.locations || []
    const linkId =
      ((linkType === 'character' || linkType === 'wardrobe' || linkType === 'pose') && cs.length === 1) ? cs[0].id
      : (linkType === 'location' && ls.length === 1) ? ls[0].id
      : ''
    return { ...im, linkType, linkId, role: d?.role || im.role, preserve: d?.preserve || im.preserve }
  })
  )

  // Describe every image lacking a caption (or all, with force). `imgs` overrides
  // the live refImages state (for a just-appended image not yet flushed). Returns
  // the updated array so callers can use it without waiting on setState.
  const captionRefImages = async ({ force = false, imgs = null } = {}) => {
    const source = imgs || refImages
    const targets = source.filter(im => im.base64 && (force || !im.caption?.trim()))
    if (!targets.length) return source
    if (!visModel) {
      setRefCaptionStatus({ state: 'error', done: 0, total: targets.length,
        error: 'No vision model available — pick or type one in the left rail.' })
      throw new Error('no vision model')
    }
    setRefCaptionStatus({ state: 'reading', done: 0, total: targets.length, error: '' })
    let done = 0
    // Sequential against a local Ollama: its parallel slots blend concurrent
    // multimodal requests, so describing several references at once returns
    // mixed descriptions. Cloud providers isolate requests — fan those out.
    const outcomes = await mapWithConcurrency(targets, isCloud(cfg.base) ? targets.length : 1, async (im) => {
      // Once a reference is typed (character / location / style / …), describe it
      // through the H3 role-focused vision prompt so a wardrobe ref covers only the
      // garment, a style ref only palette/light, etc. Untyped refs (pre-bible) use
      // the general scriptwriter vision prompt.
      const focus = im.role ? (roleDef(im.role).visionFocus || '') : ''
      const sys = im.role ? (roleDef(im.role).visionSystem || VISION_PROMPT_MINIMAX_H3_REF) : VISION_PROMPT_SCRIPTWRITER
      const noteBit = im.note && im.note.trim()
        ? ` The user's note on how it will be used: "${im.note.trim()}".`
        : ''
      const content = [
        { type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.base64 } },
        { type: 'text', text: `Describe this reference image as instructed.${focus ? ' ' + focus : ''}${noteBit}${mature ? SCRIPTWRITER_NSFW_VISION_LINE : ''}`.trim() },
      ]
      try {
        const { text } = await callOllama(visModel, content, sys, cfg, 0.3)
        // A vision-model refusal resolves normally (no thrown error) — without
        // this check its refusal prose would be stored as the caption, then
        // folded into every downstream Phase 1/2/3 message by assembleRefBlock,
        // silently poisoning the rest of the run.
        if (looksLikeRefusal(text)) {
          return { id: im.id, error: Object.assign(new Error(text.trim()), { isRefusal: true }) }
        }
        done++; setRefCaptionStatus(s => ({ ...s, done }))
        return { id: im.id, caption: (text || '').trim() }
      } catch (e) {
        return { id: im.id, error: e }
      }
    })
    const byId = new Map()
    const failed = []
    outcomes.forEach(o => { if (o.error) failed.push(o); else byId.set(o.id, o.caption) })
    const updated = source.map(im => byId.has(im.id) ? { ...im, caption: byId.get(im.id) } : im)
    setRefImages(updated)
    setRefCaptionStatus(failed.length
      ? { state: 'error', done, total: targets.length,
          error: `${failed.length} image${failed.length === 1 ? '' : 's'} couldn't be described: ${failed[0].error?.message || 'unknown error'}` }
      : { state: 'idle', done, total: targets.length, error: '' })
    // A refusal on any reference image means this image is the problem — stop
    // the whole script here rather than returning `updated` and letting the
    // caller fold the (missing) caption into the next call anyway.
    const refusal = failed.find(f => f.error?.isRefusal)
    if (refusal) {
      throw Object.assign(
        new Error(`The vision model refused to describe a reference image: "${refusal.error.message}"`),
        { isRefusal: true }
      )
    }
    return updated
  }

  // The film's spoken language: the hand-editable script field wins once a film
  // exists, the picker is the seed before that. Used for the Scriptwriter's own
  // Phase-1 instruction; Phases 2 and 3 read script.language directly.
  const pickedLangLabel = spokenLangDef(spokenLangId).label
  const filmLangLabel = (script?.language || '').trim() || pickedLangLabel
  const spokenLangLine = (label) =>
    `\nSpoken language: ${label} — write every "dialogues" line in natural, idiomatic ${label}`
    + `, and set "language" to "${label}".`

  const activeLoras = lorasByIds(loras, activeLoraIds)
  const toggleLora = (id) => setActiveLoraIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  const loraById = (id) => (loras || []).find(l => l.id === id) || null

  // Which LoRA triggers one clip carries: every active style LoRA, plus the
  // bound LoRA of each cast member actually in that clip. `subject` carries the
  // character's name so the instruction can say where the token belongs.
  const lorasForShot = (shot) => {
    const scene = script?.scenes?.find(sc => String(sc.id) === String(shot?.scene_id))
    const ids = Array.isArray(shot?.characters) && shot.characters.length ? shot.characters : (scene?.characters || [])
    const bound = (script?.characters || [])
      .filter(c => ids.includes(c.id) && c.lora)
      .map(c => { const l = loraById(c.lora); return l ? { ...l, subject: c.name } : null })
      .filter(Boolean)
    return [...activeLoras, ...bound]
  }

  // --- history payload assembly (shared by all four save sites) -----------
  const basePayload = (phaseName, refsOverride) => {
    const refs = refsOverride || refImages
    return {
      id: sessionId.current, ts: Date.now(), type: 'scriptwriter',
      model: writerModel,
      vision: refs.some(im => im.caption && im.caption.trim()) ? visModel : null,
      idea: idea.trim(), genre, mature, sourceMode, sceneCount, phase: phaseName,
      promptTarget, aspectRatio, pacing, spokenLang: spokenLangId, loraIds: activeLoraIds,
      // Full Auto's `idea` is a fixed ~180-char boilerplate instruction plus
      // the user's hint appended after it (see buildAutoIdea) — a plain
      // 80-char truncation of `idea` (as the History card does) always shows
      // the boilerplate, never the hint. Save the hint separately so the
      // History card can show the part a human actually wrote.
      fullAuto: !!autoJob, fullAutoHint: autoJob?.hint || '',
      refImages: serializeRefImages(refs),
      voiceRefs: serializeVoiceRefs(voiceRefs),
    }
  }

  // History + blobs live in the sidecar now (server/): image bytes are split out,
  // content-addressed and deduped on disk, so there is no per-record size cap to
  // guard against any more (the old 12 MB IndexedDB limit + its lossy trimming
  // are gone).
  const commitHistory = (payload) => {
    if (!onSaveHistory) return
    onSaveHistory(payload)
  }

  const runPhase1 = async () => {
    if (!idea.trim()) return
    setError(''); setRawFallback('')
    let refs = refImages
    if (refImages.some(im => im.base64 && !im.caption?.trim())) {
      try { refs = await captionRefImages() }
      catch (e) {
        setError(e?.isRefusal
          ? e.message
          : 'Could not read the reference images (see the note above). Fix the vision model or remove the images to continue.')
        return
      }
    }
    const genreHint = genre === 'auto' ? 'Infer a suitable genre from the story idea.' : `Genre: ${genre}`
    const refBlock = assembleRefBlock(refs, REF_HEADING_CANON)
    const sceneHint = aspectSceneHint(aspectRes(aspectRatio))
    const formatLine = sceneHint ? `\nDelivery format: ${sceneHint}` : ''
    const userMsg = `Story idea: ${idea.trim()}\n${genreHint}${spokenLangLine(pickedLangLabel)}\nMaximum number of scenes: ${sceneCount}${formatLine}${nsfwLine}${refBlock}\n\nOutput only valid JSON.`
    const phase1System = sourceMode ? SYSTEM_PROMPT_SCRIPTWRITER_SOURCE : SYSTEM_PROMPT_SCRIPTWRITER
    // DEV-only prompt inspection, independent of Admin mode below — lets a prod
    // (or non-admin) run be checked too. Open the browser console
    // (npm run dev) and read window.__peLastPhase1Message.
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      window.__peLastPhase1Message = { system: phase1System, user: userMsg }
    }
    // Full Auto (autoActive) always sends straight through — an admin pause
    // there would hang the queued job, since nothing would ever click Send.
    if (adminMode && !autoActive) {
      setReviewPhase1({ system: phase1System, user: userMsg, refs })
      return
    }
    await sendPhase1(phase1System, userMsg, refs)
  }
  // The actual Phase 1 call + result handling — split out of runPhase1 so
  // Admin mode can hold the assembled message for review/edit first and call
  // this only once the user clicks Send (see reviewPhase1 above).
  const sendPhase1 = async (system, userMsg, refs) => {
    setPhase('scripting')
    try {
      const { text } = await callOllama(writerModel, userMsg, system, cfg, 0.7, { format: 'json' })
      // Force the picked language in: a model that ignored the instruction and
      // wrote "English" here would otherwise carry that wrong value through
      // every later phase via script.language.
      const data = { ...normalizeScript(parseJSON(text)), language: pickedLangLabel }
      setScript(data)
      setPhase('script')
      commitHistory({ ...basePayload('script', refs), script: data, directorsCut: null, finalPrompts: null })
    } catch (e) {
      setError(e.message)
      setPhase('input')
    }
  }
  // Reassigned every render (like enhanceRef in App.jsx) so the Full Auto
  // mount effect below always calls the *current* closure — see runPhase1.
  const phase1Ref = useRef(null)
  phase1Ref.current = runPhase1

  // Ask the Scriptwriter for a fresh version of ONE scene, in place. Keeps the
  // scene id and the cast/location bible; the rest of the scene is rewritten and
  // re-resolved against the bible via normalizeScript.
  const regenerateScene = async (si) => {
    if (sceneBusy !== null || !script?.scenes?.[si]) return
    const scene = script.scenes[si]
    setSceneBusy(si); setError(''); setRawFallback('')
    const genreHint = genre === 'auto' ? 'Infer the genre from the story.' : `Genre: ${genre}`
    const refBlock = assembleRefBlock(refImages, REF_HEADING_CANON, script)
    const sceneHint = aspectSceneHint(aspectRes(aspectRatio))
    const formatLine = sceneHint ? `\nDelivery format: ${sceneHint}` : ''
    const userMsg =
      `Story idea: ${idea.trim()}\n${genreHint}${spokenLangLine(filmLangLabel)}${formatLine}${nsfwLine}\n\n`
      + `You already wrote this script (title, bible and all scenes):\n${JSON.stringify(script, null, 2)}${refBlock}\n\n`
      + `Rewrite ONLY scene ${scene.id}${scene.title ? ` ("${scene.title}")` : ''}. `
      + `Give a fresh version of the same story beat — you may change the action, blocking or dialogue — but keep it consistent with the surrounding scenes, reuse the existing characters and locations by their exact names, and keep the same scene "id". `
      + `Output only valid JSON: {"scenes":[ <the one rewritten scene object, exactly the same fields as before> ]}.`
    try {
      const { text } = await callOllama(writerModel, userMsg, sourceMode ? SYSTEM_PROMPT_SCRIPTWRITER_SOURCE : SYSTEM_PROMPT_SCRIPTWRITER, cfg, 0.85, { format: 'json' })
      const raw = parseJSON(text)
      const arr = Array.isArray(raw?.scenes) ? raw.scenes : raw?.scene ? [raw.scene] : (raw && raw.title == null && raw.id != null ? [raw] : [])
      const fresh = arr[0]
      if (!fresh || typeof fresh !== 'object') throw new Error('The model did not return a rewritten scene.')
      const merged = { ...scene, ...fresh, id: scene.id }
      const nextScript = normalizeScript({ ...script, scenes: script.scenes.map((s, i) => i === si ? merged : s) })
      setScript(nextScript)
      setRawFallback('')
      commitHistory({ ...basePayload('script'), script: nextScript, directorsCut: directorsCut || null, finalPrompts: null })
    } catch (e) {
      setError(e.message)
    } finally {
      setSceneBusy(null)
    }
  }

  const runPhase2 = async () => {
    // Re-running replaces the existing clip breakdown (and any prompts built from
    // it). Stepping forward via the dots keeps them; make the destructive path
    // explicit.
    if (directorsCut && typeof window !== 'undefined' && !window.confirm(
      `Re-run the Director's Cut? This replaces the current clip breakdown${finalPrompts.length ? ' and the generated prompts' : ''}.\n\nTo keep them, use the steps at the top to move forward instead.`
    )) return
    setError(''); setRawFallback('')
    const isH3 = promptTarget === 'minimax_h3'
    // Describe any linked-but-undescribed references first (like runPhase1 /
    // runPhase3) so the Director sees the full numbered reference list and can
    // pick per clip.
    let refs = refImages
    if (isH3 && refImages.some(im => im.base64 && !im.caption?.trim())) {
      try { refs = await captionRefImages() }
      catch (e) {
        // A refusal means a reference image is the problem — stop here rather
        // than folding a missing caption into the Director call anyway. Any
        // other captioning failure keeps the pre-existing best-effort behavior.
        if (e?.isRefusal) { setError(e.message); return }
      }
    }
    const refBlock = assembleRefBlock(refs, REF_HEADING_DIRECTOR, script)
    const lookLine = isH3 && script?.look?.trim() ? `\n\nFilm look: ${script.look.trim()}` : ''
    const langLine = isH3 && script?.language?.trim() ? `\nPrimary language: ${script.language.trim()}` : ''
    const pacingLine = isH3 ? `\n${PACING_LINE[pacing] || PACING_LINE.standard}` : ''
    const framingHint = aspectFramingHint(aspectRes(aspectRatio))
    const framingLine = framingHint ? `\nFraming for delivery: ${framingHint}` : ''
    const userMsg = `Script:\n${JSON.stringify(script, null, 2)}${lookLine}${langLine}${pacingLine}${framingLine}${nsfwLine}${refBlock}\n\nOutput only valid JSON.`
    const phase2System = isH3 ? SYSTEM_PROMPT_DIRECTOR_H3 : SYSTEM_PROMPT_DIRECTOR
    // See the note by window.__peLastPhase1Message above — same idea, one
    // phase later. This is the one to check when a scene the script clearly
    // wrote (a flashback, say) isn't showing up right in the clip breakdown:
    // it's the actual JSON the Director received.
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      window.__peLastPhase2Message = { system: phase2System, user: userMsg }
    }
    // See the matching gate in runPhase1 — a Full Auto run must never pause.
    if (adminMode && !autoActive) {
      setReviewPhase2({ system: phase2System, user: userMsg, refs, isH3 })
      return
    }
    await sendPhase2(phase2System, userMsg, refs, isH3)
  }
  // The actual Phase 2 call + result handling — split out of runPhase2 so
  // Admin mode can hold the assembled message for review/edit first (see
  // reviewPhase2 above).
  const sendPhase2 = async (system, userMsg, refs, isH3) => {
    setFinalPrompts([])
    setPhase('directing')
    try {
      const { text } = await callOllama(writerModel, userMsg, system, cfg, 0.7, { format: 'json' })
      const data = normalizeDirectorsCut(parseJSON(text), script)
      // The Director's per-clip reference_images → the shot.refs pin the chips
      // and Phase 3 already consume. Same list + order as assembleRefBlock.
      const capd = (refs || []).filter(im => im.caption && im.caption.trim())
      data.shots = data.shots.map(s => {
        const { reference_images, ...rest } = s
        const picked = isH3 ? resolveRefSelection(reference_images, capd) : null
        return {
          ...rest,
          duration: s.duration || (isH3 ? 7 : 4),
          ...(picked ? { refs: picked } : {}),
        }
      })
      // Full Auto, Pacing: TIGHT — deterministic merge pass. Prompt wording
      // alone (PACING_LINE, the insert/establishing exceptions) did not
      // reduce clip count across repeated live tests, weak and strong model
      // alike — see isMergeEligible's comment. Guided-mode runs (autoActive
      // false) are completely unaffected.
      if (isH3 && autoActive && pacing === 'tight') {
        let i = 0
        while (i < data.shots.length - 1) {
          if (isMergeEligible(data.shots[i], data.shots[i + 1])) {
            try { data.shots = await mergeShotPair(data.shots, i, refs) }
            catch (e) {
              // A refusal means this script's content is the problem, not this
              // one merge call — retrying the next pair would likely just hit
              // the same refusal again. Stop the whole job here; the outer
              // catch below reports it as a failed run instead of a "finished"
              // one with a quietly skipped clip.
              if (e?.isRefusal) throw e
              i++ // otherwise leave this pair split rather than aborting the job
            }
          } else {
            i++
          }
        }
      }
      // Deterministic reconciliation — every H3 run, not just Full Auto tight
      // pacing: the DIALOGUE rule's "copy verbatim" wording alone doesn't
      // reliably keep every scene line in the clip list (see findMissingDialogue
      // above). A refusal here propagates out to the catch below, same as the
      // merge pass just above.
      if (isH3) {
        data.shots = await fillDialogueGaps(data.shots, refs)
      }
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        window.__peLastDirectorRefs = data.shots.map(s => ({ shot: s.shot_number, refs: s.refs }))
      }
      const freshFrames = data.shots.map(() => emptyFrameEntry())
      setDirectorsCut(data)
      setFramePrompts(freshFrames)
      setPhase('dircut')
      commitHistory({
        ...basePayload('dircut'),
        script, directorsCut: data, finalPrompts: null,
        framePrompts: serializeFramePrompts(freshFrames),
      })
    } catch (e) {
      setError(e.message)
      setPhase('script')
    }
  }
  const phase2Ref = useRef(null)
  phase2Ref.current = runPhase2

  // The AUTO default set of captioned references for one clip: every described
  // reference on every clip (the main-app Ref2VA model — works for a single-lead
  // film). Only when the film has 2+ identity references do we narrow the
  // face/wardrobe refs to the characters present in that clip (id OR name).
  const autoShotRefs = (shot, scene, refsList = refImages) => {
    const captioned = (refsList || []).filter(im => im.caption && im.caption.trim())
    if (!captioned.length) return []
    const faces = captioned.filter(im => im.role === 'subject_identity' || im.linkType === 'character')
    if (faces.length <= 1) return captioned
    const present = new Set()
    const chars = (Array.isArray(shot.characters) && shot.characters.length ? shot.characters : scene?.characters) || []
    for (const cid of chars) {
      present.add(cid)
      const c = (script?.characters || []).find(x => x.id === cid)
      if (c?.name) present.add(c.name.toLowerCase())
    }
    return captioned.filter(im => {
      if (im.linkType !== 'character' && im.linkType !== 'wardrobe' && im.linkType !== 'pose') return true  // env / style / prop stay global
      if (!im.linkId) return true                                                 // unlinked face ref — can't narrow it
      const c = (script?.characters || []).find(x => x.id === im.linkId)
      return present.has(im.linkId) || (c?.name && present.has(c.name.toLowerCase()))
    })
  }

  // Captioned references phase 3 actually attaches to one clip. If the user has
  // pinned an explicit set on the clip (shot.refs — an array of reference keys,
  // possibly empty), honour it exactly; otherwise use the auto default. Pinning
  // is how you keep a wardrobe / prop reference out of the clips where it is not
  // yet on screen (e.g. the shirt worn under a still-closed coat).
  const shotRefs = (shot, scene, refsList = refImages) => {
    const captioned = (refsList || []).filter(im => im.caption && im.caption.trim())
    if (!captioned.length) return []
    if (Array.isArray(shot?.refs)) {
      const want = new Set(shot.refs)
      return captioned.filter(im => want.has(refKey(im)))
    }
    return autoShotRefs(shot, scene, refsList)
  }

  // Toggle one reference on/off for a clip. First edit seeds the pinned set from
  // whatever is currently effective (the auto set), then adds/removes the ref.
  const toggleShotRef = (si, im) => {
    const shot = directorsCut?.shots?.[si]
    if (!shot || shotBusy !== null || promptBusy !== null) return
    const scene = script?.scenes?.find(s => String(s.id) === String(shot.scene_id))
    const base = Array.isArray(shot.refs) ? shot.refs : shotRefs(shot, scene).map(refKey)
    const k = refKey(im)
    const next = base.includes(k) ? base.filter(x => x !== k) : [...base, k]
    const nextCut = { ...directorsCut, shots: directorsCut.shots.map((s, i) => i === si ? { ...s, refs: next } : s) }
    setDirectorsCut(nextCut)
    persistState(undefined, undefined, nextCut)
  }

  // Drop the pinned set — back to the auto default.
  const resetShotRefs = (si) => {
    if (shotBusy !== null || promptBusy !== null) return
    const nextCut = { ...directorsCut, shots: directorsCut.shots.map((s, i) => {
      if (i !== si || !Array.isArray(s.refs)) return s
      const { refs, ...rest } = s
      return rest
    }) }
    setDirectorsCut(nextCut)
    persistState(undefined, undefined, nextCut)
  }

  // Timeline anchors (Add Guide) — hand-pinned by the user, never proposed by
  // the Director LLM: whether a given photo genuinely depicts a specific
  // mid-clip composition is a fact about the image, not something derivable
  // from the script. `shot.anchors` is `[{ refKey, atSeconds }]`; an anchor is
  // only meaningful for a reference currently attached to the clip (present
  // in shotRefs()'s result) — that's what lets the prompt address it as
  // <Picture N> at all. A stale anchor left behind after the ref was detached
  // is harmless: every reader filters anchors against the live attached set.
  const shotAnchors = (shot) => Array.isArray(shot?.anchors) ? shot.anchors : []

  const anchorFor = (shot, im) => {
    const k = refKey(im)
    return shotAnchors(shot).find(a => a.refKey === k)?.atSeconds
  }

  // atSeconds === null/undefined/'' removes the anchor (back to a plain
  // semantic reference); any finite number sets/replaces it.
  const setShotAnchor = (si, refKeyStr, atSeconds) => {
    const shot = directorsCut?.shots?.[si]
    if (!shot || shotBusy !== null || promptBusy !== null) return
    const existing = shotAnchors(shot)
    const clear = atSeconds === null || atSeconds === undefined || atSeconds === ''
    const next = clear
      ? existing.filter(a => a.refKey !== refKeyStr)
      : [...existing.filter(a => a.refKey !== refKeyStr), { refKey: refKeyStr, atSeconds: Number(atSeconds) }]
    const nextCut = { ...directorsCut, shots: directorsCut.shots.map((s, i) => i === si ? { ...s, anchors: next } : s) }
    setDirectorsCut(nextCut)
    persistState(undefined, undefined, nextCut)
  }

  // The anchors that actually apply to a clip's Ref2VA prompt: shot.anchors
  // filtered to references still attached (`refs`, already resolved via
  // shotRefs()), resolved to their Picture N position in that SAME array (the
  // <Picture N> == Image N invariant SYSTEM_PROMPT_MINIMAX_H3 requires), and
  // sorted chronologically — the order the prompt text and the manifest's
  // guides[] both want, independent of `refs`' own (declaration/pin) order.
  const activeAnchorsForRefs = (shot, refs) => {
    const pics = shotAnchors(shot)
      .map(a => {
        const i = refs.findIndex(im => refKey(im) === a.refKey)
        return i === -1 ? null : { pictureN: i + 1, atSeconds: a.atSeconds, refKey: a.refKey }
      })
      .filter(Boolean)
    return pics.sort((a, b) => a.atSeconds - b.atSeconds)
  }

  // An explicit [] means this clip is deliberately silent (every shot the
  // Director writes carries this field, per its schema and blankShot()) - only
  // a genuinely missing field (pre-dialogue-field legacy entries) falls back to
  // the scene's dialogue.
  const shotDialogues = (shot, scene) => Array.isArray(shot?.dialogue)
    ? shot.dialogue.filter(d => d && d.trim())
    : (Array.isArray(scene?.dialogues) ? scene.dialogues.filter(d => d && d.trim()) : [])

  // MiniMax H3's audio input takes up to two separate voice-timbre samples
  // (ref_audio_0 / ref_audio_1 — <Audio 1> / <Audio 2> in the schema), so a
  // shot can carry TWO voice references, not just one.
  const MAX_VOICES_PER_SHOT = 2

  // Which voice reference(s) (0–2) apply to a shot. Only a shot that actually
  // carries dialogue gets any: a sample guides how an existing line sounds, it
  // never authorises inventing one, so a clip the Director left silent stays
  // silent. `shot.voiceCharacterIds` is an explicit pin — an array of bible
  // character ids set via the "Voice references for this clip" chips (`[]` =
  // deliberately none) — and wins outright when present. Otherwise,
  // auto-resolution in order: the "Name:" prefix on each dialogue line, then
  // every cast member who actually has a linked sample, then any unlinked
  // ("default voice") samples. Whenever a step would need to guess which TWO
  // of three-or-more candidates to send, it sends none instead — pin the set
  // by hand rather than have the app guess wrong.
  const voicesForShot = (shot, scene, dialogues) => {
    if (!voiceRefs.length || !dialogues.length) return []
    const chars = script?.characters || []
    const byChar = (id) => voiceRefs.find(v => v.characterId === id && v.base64)
    if (Array.isArray(shot?.voiceCharacterIds)) {
      return shot.voiceCharacterIds
        .map(id => { const v = byChar(id); return v ? { ...v, speaker: chars.find(c => c.id === id)?.name || '' } : null })
        .filter(Boolean)
        .slice(0, MAX_VOICES_PER_SHOT)
    }
    const named = [...new Set(dialogues
      // Strip a trailing "(V.O.)" (or any parenthetical) so a narrator's
      // voiceover line still matches her bible name — and her voice-timbre
      // reference, if one is attached.
      .map(d => String(d).split(':')[0].trim().replace(/\s*\([^)]*\)\s*$/, '').trim())
      .filter(n => n && n.length < 40))]
    const hits = named
      .map(n => chars.find(c => c.name && slug(c.name) === slug(n)))
      .filter(Boolean)
      .map(c => ({ v: byChar(c.id), name: c.name }))
      .filter(x => x.v)
    if (hits.length >= 1 && hits.length <= MAX_VOICES_PER_SHOT) return hits.map(h => ({ ...h.v, speaker: h.name }))
    if (hits.length > MAX_VOICES_PER_SHOT) return []
    const cast = (shot.characters?.length ? shot.characters : scene?.characters) || []
    const castHits = cast
      .map(id => ({ v: byChar(id), name: chars.find(c => c.id === id)?.name || '' }))
      .filter(x => x.v)
    if (castHits.length >= 1 && castHits.length <= MAX_VOICES_PER_SHOT) return castHits.map(h => ({ ...h.v, speaker: h.name }))
    if (castHits.length > MAX_VOICES_PER_SHOT) return []
    const loose = voiceRefs.filter(v => !v.characterId && v.base64)
    if (loose.length >= 1 && loose.length <= MAX_VOICES_PER_SHOT) return loose.map(v => ({ ...v, speaker: '' }))
    return []
  }

  // Toggle one voice reference on/off for a clip, capped at MAX_VOICES_PER_SHOT.
  // First edit seeds an explicit set from whatever is currently effective (the
  // auto set), mirroring toggleShotRef/shotRefs for image references.
  const toggleShotVoice = (si, characterId) => {
    const shot = directorsCut?.shots?.[si]
    if (!shot || shotBusy !== null || promptBusy !== null) return
    const scene = script?.scenes?.find(s => String(s.id) === String(shot.scene_id))
    const base = Array.isArray(shot.voiceCharacterIds)
      ? shot.voiceCharacterIds
      : voicesForShot(shot, scene, shotDialogues(shot, scene))
          .map(v => v.characterId)
          .filter(Boolean)
    let next
    if (base.includes(characterId)) next = base.filter(id => id !== characterId)
    else if (base.length >= MAX_VOICES_PER_SHOT) return   // already 2 pinned — drop one first
    else next = [...base, characterId]
    const nextCut = { ...directorsCut, shots: directorsCut.shots.map((s, i) => i === si ? { ...s, voiceCharacterIds: next } : s) }
    setDirectorsCut(nextCut)
    persistState(undefined, undefined, nextCut)
  }

  // Drop the pinned set — back to the auto default.
  const resetShotVoice = (si) => {
    if (shotBusy !== null || promptBusy !== null) return
    const nextCut = { ...directorsCut, shots: directorsCut.shots.map((s, i) => {
      if (i !== si || !Array.isArray(s.voiceCharacterIds)) return s
      const { voiceCharacterIds, ...rest } = s
      return rest
    }) }
    setDirectorsCut(nextCut)
    persistState(undefined, undefined, nextCut)
  }

  // One H3 user message per shot. Emits MODE: Ref2VA (with a role-tagged reference
  // block byte-compatible with App.jsx's ref-mode captions, which SYSTEM_PROMPT_
  // MINIMAX_H3's Ref2VA parser reads) when the shot has captioned references;
  // otherwise MODE: T2VA with the bible's appearance text inlined so the look
  // still carries. Section labels match the minimax_h3 branch of runWriter().
  const buildH3ShotMessage = (shot, ratio, refsList = refImages) => {
    const scene = script?.scenes?.find(s => String(s.id) === String(shot.scene_id))
    const refs = shotRefs(shot, scene, refsList)
    const isRef = refs.length > 0
    const anchors = isRef ? activeAnchorsForRefs(shot, refs) : []

    const dialogues = shotDialogues(shot, scene)
    const dialogueBlock = dialogues.length
      ? `\n\nSpoken dialogue (verbatim — this clip carries only this delivery):\n${dialogues.join('\n')}`
      : ''

    // H3 takes up to two voice references per clip (ref_audio_0 / ref_audio_1),
    // numbered "Audio 1" / "Audio 2" independently of the image references —
    // labelled exactly as the Ref2VA section of SYSTEM_PROMPT_MINIMAX_H3
    // expects to read them.
    const voices = voicesForShot(shot, scene, dialogues)
    const voiceLine = voices.length
      ? voices.map((voice, vi) =>
          `Audio ${vi + 1} — voice-timbre reference (marker: reference): file "${voice.fileName}"${voice.speaker ? ` — the voice of ${voice.speaker}` : ''}. Reference ONLY its timbre, pitch and delivery for the speaking subject; never transcribe or guess at its original wording. The spoken words are the dialogue given below and nothing else.`
        ).join('\n\n') + '\n\n'
      : ''

    const action = (shot.primary_beat || shot.visual_action || '').trim()
    const eyeLine = shot.eyeline?.trim() ? `\nEyeline: ${shot.eyeline.trim()}` : ''
    const langLine = script?.language?.trim() ? `\nPrimary language: ${script.language.trim()}` : ''
    const lookLine = script?.look?.trim() ? `\nFilm look: ${script.look.trim()}` : ''

    let head, block = ''
    if (isRef) {
      head = 'MODE: Ref2VA'
      const lines = refs.map((im, i) => {
        let line = `Image ${i + 1} — role: ${roleLabel(im.role)}, preservation: ${preserveLabel(im.preserve)} (${preserveMarker(im.preserve)}): ${im.caption.trim()}`
        const name = refEntityName(im, script)
        const use = name
          ? (im.linkType === 'location' ? `the "${name}" environment` : im.linkType === 'wardrobe' ? `the wardrobe worn by ${name}` : `plays ${name}`)
          : im.linkType === 'pose'
          ? `the body pose and framing to copy${im.note && im.note.trim() ? ` — ${im.note.trim()}` : ''}`
          : (im.note && im.note.trim() ? im.note.trim() : linkTypeDef(im.linkType)?.label || 'reference')
        line += `\n   Requested use of this reference: ${use}`
        return line
      })
      const anchorBlock = anchors.length
        ? `Timeline anchors (Add Guide — continuous, not automatically a cut):\n${anchors.map(a => `<Picture ${a.pictureN}> — target composition at ${formatTimestamp(a.atSeconds)}`).join('\n')}\n\n`
        : ''
      block = `Reference images:\n${lines.join('\n\n')}\n\n${anchorBlock}${voiceLine}`
    } else {
      head = 'MODE: T2VA'
      const chars = Array.isArray(shot.characters) && shot.characters.length ? shot.characters : (scene?.characters || [])
      // A "(V.O.)" narrator may not be visible in this shot (she's narrating a
      // memory of something she didn't witness), so `chars` alone can miss her
      // bible entry — pull her in too, just for the voice/appearance context
      // below, without touching `shot.characters` itself (that stays the
      // Director's own on-screen/reference-image decision).
      const voNames = dialogues.map(d => (/^(.+?)\s*\(V\.O\.\)\s*:/i.exec(d) || [])[1]).filter(Boolean)
      const voIds = voNames
        .map(n => (script?.characters || []).find(c => c.name && slug(c.name) === slug(n))?.id)
        .filter(Boolean)
      const bibleChars = (script?.characters || []).filter(c => chars.includes(c.id) || voIds.includes(c.id))
      const loc = (script?.locations || []).find(l => l.id === (shot.location_id || scene?.location_id))
      const cLines = bibleChars.map(c => `- ${c.name}: ${(c.appearance || '').trim()}${c.wardrobe ? ` Wardrobe: ${c.wardrobe.trim()}` : ''}`)
      block = [
        cLines.length ? `Characters in this shot (hold their look consistent; never restate it as on-screen text):\n${cLines.join('\n')}` : '',
        loc ? `Location — ${loc.name}: ${(loc.description || '').trim()}` : '',
      ].filter(Boolean).join('\n')
      if (block) block += '\n\n'
      block += voiceLine
    }

    const soundscape = scene?.sound_mood?.trim() || script?.soundscape?.trim()
      || 'not specified — invent restrained ambience that fits the scene.'
    const musicRaw = script?.music?.trim()
    const music = musicRaw && /^(none|n\/a|silence|no music)$/i.test(musicRaw) ? 'N/A'
      : (scene?.sound_mood?.trim() && /music|score|song|track/i.test(scene.sound_mood) ? scene.sound_mood.trim()
      : musicRaw || 'not specified — decide whether music serves this scene; if not, use N/A.')

    return `${head}\n\n`
      + `${block}`
      + `Aspect ratio: ${ratio.label} (${ratio.note})${langLine}${lookLine}\n`
      + `Target duration: ${shot.duration || 7} seconds\n\n`
      + `Scene / action:\n${action}\n\n`
      + `Requested camera moves (incorporate these):\n- ${shot.camera_movement || 'Static — the frame never moves'}\n- ${shot.camera_framing || 'Medium shot'}${eyeLine}\n\n`
      + `Style / mood: ${shot.lighting_mood || script?.look || 'natural'}${dialogueBlock}`
      + `\n\nAmbient / diegetic sound (overall_soundscape): ${soundscape}`
      + `\n\nAudience-only music (non_diegetic_music): ${music}`
  }

  // The system prompt for one shot's phase-3 call: the target's normal clip
  // writer prompt, plus H3_MULTIFRAME_ADDENDUM only when this H3 clip actually
  // carries a Timeline anchor still attached to the clip (mirrors
  // buildH3ShotMessage's own anchors computation, so the addendum is present
  // exactly when the "Timeline anchors" block it explains is present).
  const clipSystemForShot = (shot) => {
    const base = clipSystemFor(promptTarget)
    if (promptTarget !== 'minimax_h3') return base
    const scene = script?.scenes?.find(s => String(s.id) === String(shot.scene_id))
    const refs = shotRefs(shot, scene)
    return activeAnchorsForRefs(shot, refs).length ? base + H3_MULTIFRAME_ADDENDUM : base
  }

  // The phase-3 user message for one shot — H3 (Ref2VA/T2VA) or LTX. Shared by
  // the full run and the per-clip "Rewrite" button on the video-prompts screen.
  const buildShotPromptMsg = (shot, refs, ratio) => {
    const loraPart = loraInstruction(lorasForShot(shot), promptTarget)
    if (promptTarget === 'minimax_h3') return buildH3ShotMessage(shot, ratio, refs) + loraPart + nsfwLine
    const action = shot.visual_action || shot.primary_beat || ''
    const ltxRefBlock = assembleRefBlock(refs, REF_HEADING_SHOT, script)
    const framingHint = aspectFramingHint(ratio)
    const aspectLine = `Aspect ratio: ${aspectParts(ratio).token || '16:9'}${framingHint ? `\n${framingHint}` : ''}\n\n`
    return `${aspectLine}Target duration: ${shot.duration || 4} seconds\n\nBasic scene description:\n${action}\n\nRequested camera moves (incorporate these):\n- ${shot.camera_movement}\n- ${shot.camera_framing}\n\nStyle / mood: ${shot.lighting_mood}${ltxRefBlock}${loraPart}${nsfwLine}`
  }

  const runPhase3 = async () => {
    const hadPrompts = finalPrompts.some(p => p.text && p.text.trim())
    if (hadPrompts && typeof window !== 'undefined' && !window.confirm(
      'Re-generate every prompt? This replaces the ones you have.\n\nTo tweak just one, use its ✦ Rewrite button on the Video Prompts screen.'
    )) return
    setError('')
    const shots = directorsCut.shots
    const isH3 = promptTarget === 'minimax_h3'

    // A linked-but-not-yet-described reference would silently drop its clip to
    // T2VA — caption any outstanding ones first (like runPhase1 does).
    let refs = refImages
    if (isH3 && refImages.some(im => im.base64 && !im.caption?.trim())) {
      try { refs = await captionRefImages() }
      catch (e) {
        // A refusal means a reference image is the problem — stop before
        // spending a single clip-prompt call on it. Any other captioning
        // failure keeps the pre-existing best-effort behavior.
        if (e?.isRefusal) { setError(e.message); return }
      }
    }

    const initial = shots.map(s => ({
      shotNumber: s.shot_number, sceneTitle: s.scene_title,
      text: '', usage: null, loading: true, error: '',
    }))
    setFinalPrompts(initial)
    setPhase('prompting')

    const ratio = aspectRes(aspectRatio)
    const results = new Array(shots.length)
    const userMsgs = shots.map((shot) => buildShotPromptMsg(shot, refs, ratio))
    // Per-shot, not one shared constant — an H3 clip carrying a Timeline
    // anchor gets clipSystemFor(...) + H3_MULTIFRAME_ADDENDUM, every other
    // clip (H3 or LTX) gets the plain target system prompt unchanged.
    const systemPrompts = shots.map((shot) => clipSystemForShot(shot))
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      window.__peLastH3Messages = shots.map((s, i) => ({
        shot: s.shot_number, mode: (/^MODE:\s*(\w+)/.exec(userMsgs[i]) || [])[1] || null,
        system: systemPrompts[i], msg: userMsgs[i],
      }))
    }
    // Clip calls fire with bounded concurrency (below) — once sent, a refusal
    // on one clip can't un-send another's already-in-flight request. What we
    // CAN stop is treating the result as a normal finished film: a refusal
    // means this script's own content is the problem, not a one-off model
    // hiccup, so it should never quietly land on the 'done' screen reporting
    // ok. The cap (rather than firing all clips at once) matters once a
    // source-text film's raised scene ceiling pushes clip counts well past
    // the usual 8–14 — see the "Preserve source text" toggle above.
    let refusal = null
    await mapWithConcurrency(shots, 6, (shot, i) => {
      const userMsg = userMsgs[i]
      const isRefShot = /^MODE:\s*Ref2VA/.test(userMsg)
      // Frozen at generation time — the H3 mode this specific clip's text was
      // actually written for, never recomputed later from the live reference
      // set (a clip's pinned references can change after this without
      // retroactively rewriting its already-generated text — see
      // "Per-clip reference pinning" — so a live recompute would validate a
      // stale prompt against the wrong mode).
      const h3Mode = isH3 ? (isRefShot ? 'Ref2VA' : 'T2VA') : null
      return callOllama(writerModel, userMsg, systemPrompts[i], cfg, 0.7)
        .then(({ text: raw, usage }) => {
          if (looksLikeRefusal(raw)) throw Object.assign(new Error(raw.trim()), { isRefusal: true })
          const text = withLoraTriggers(isH3 ? normalizeH3Prompt(raw, isRefShot) : raw, lorasForShot(shot), promptTarget)
          setFinalPrompts(prev => prev.map((p, idx) => idx === i ? { ...p, text, usage, loading: false, h3Mode } : p))
          results[i] = { shotNumber: shot.shot_number, sceneTitle: shot.scene_title, text, h3Mode }
        })
        .catch(e => {
          if (e?.isRefusal && !refusal) refusal = { shotNumber: shot.shot_number, message: e.message }
          setFinalPrompts(prev => prev.map((p, idx) => idx === i ? { ...p, loading: false, error: e.message } : p))
          results[i] = { shotNumber: shot.shot_number, sceneTitle: shot.scene_title, text: '' }
        })
    })
    if (refusal) {
      // Stop here instead of advancing to 'done' — land back on the
      // Director's-Cut screen (where clips can be inspected/removed/rewritten)
      // with the refusal surfaced as the run's error, same as any other phase
      // failure. finalPrompts is left as-is (each clip already carries its own
      // text or error from the loop above) rather than cleared, so a Guided
      // run where most clips succeeded doesn't lose that work — only the
      // history commit below is skipped, so nothing is persisted yet.
      setError(`Clip ${refusal.shotNumber} was refused by the model: "${refusal.message}" — stopped. Remove or replace the reference image(s)/hint responsible, then retry.`)
      setPhase('dircut')
      return
    }
    setPhase('done')
    commitHistory({
      ...basePayload('done', refs),
      script, directorsCut, finalPrompts: results,
      framePrompts: serializeFramePrompts(framePrompts),
    })
  }
  const phase3Ref = useRef(null)
  phase3Ref.current = runPhase3

  // Full Auto — mount effect: seed a queued job's state and kick off Phase 1.
  // Runs exactly once per fresh mount (App.jsx forces a real remount per queue
  // run via a bumped `scriptwriterKey`). flushSync is required here: without
  // it, phase1Ref.current() would run against the *previous* render's closure
  // (empty idea/refImages) rather than the state just set above it — the same
  // problem App.jsx's runQueueItem solves for enhance() via enhanceRef. The
  // seed+kickoff is deferred one tick (setTimeout 0) so flushSync always runs
  // in its own fresh task, never nested inside the mount commit this effect
  // itself is part of — calling flushSync directly inside the effect body
  // triggers React's "flushSync was called from inside a lifecycle method"
  // warning on this particular mount-via-remount path.
  useEffect(() => {
    if (!autoJob) return
    const runId = autoJob.runId
    if (runId) {
      if (startedAutoRuns.has(runId)) {
        // A remount mid-run. Restarting is the wrong answer, but so is
        // returning quietly: the remount already threw away the state the
        // run needed, so onAutoJobDone would never fire and App's promise
        // would hang, pinning the queue item on 'running' forever. Report it
        // as a failed run instead — that resolves the promise and puts the
        // item back to retryable via ▶ Run, which is the honest outcome.
        onAutoJobDone?.({ ok: false, error: 'The Scriptwriter panel reloaded while this film was running, interrupting it. Press ▶ Run to start it again.' })
        return
      }
      startedAutoRuns.add(runId)
    }
    const t = setTimeout(() => {
      flushSync(() => {
        setRefImages((autoJob.refImages || []).map(rehydrateRefImage))
        setVoiceRefs((autoJob.voiceRefs || []).map(rehydrateVoiceRef))
        setGenre(autoJob.genre || 'auto')
        setMature(!!autoJob.mature)
        setSceneCount(1); setAspectRatio(DEFAULT_ASPECT_RATIO)
        setPromptTarget(DEFAULT_PROMPT_TARGET); setPacing(autoJob.pacing || 'tight')
        setSpokenLangId(autoJob.spokenLang || DEFAULT_SPOKEN_LANG)
        setActiveLoraIds(Array.isArray(autoJob.loraIds) ? autoJob.loraIds : [])
        setIdea(buildAutoIdea(autoJob.hint))
        setAutoActive(true)
      })
      phase1Ref.current()
    }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount only
  }, [])

  // Full Auto — phase-watcher: auto-advance to the next phase as soon as the
  // previous one lands, with no manual review click. The `!error` guard stops
  // this from re-firing after a phase's own catch block reverts `phase`
  // backward (runPhase1 -> 'input', runPhase2 -> 'script') on failure — those
  // are reported back as a failed job instead of retried automatically.
  // A clip refusal in runPhase3 (or the automatic merge pass inside
  // runPhase2, on Pacing: TIGHT) reverts phase to 'dircut'/'script' with
  // `error` set the same way, for the same reason: a refusal means the
  // job's content is the problem, so it must NOT be reported ok.
  useEffect(() => {
    if (!autoActive || autoDoneRef.current) return
    if (phase === 'script' && script && !error) { phase2Ref.current() }
    else if (phase === 'dircut' && directorsCut && !error) { phase3Ref.current() }
    else if (phase === 'done') {
      autoDoneRef.current = true; setAutoActive(false)
      onAutoJobDone?.({ ok: true })
    } else if (error && (phase === 'input' || phase === 'script' || phase === 'dircut')) {
      autoDoneRef.current = true; setAutoActive(false)
      onAutoJobDone?.({ ok: false, error })
    }
  }, [phase, error])

  // Ask the Director for a fresh take on ONE clip/shot, in place. Keeps the
  // shot_number / scene_id / scene_title and the parallel framePrompts slot; the
  // rest of the breakdown is rewritten. `opts.cut` overrides the (possibly
  // not-yet-flushed) directorsCut state — used by insertShot. `opts.bridge` (or
  // an empty beat) switches the wording to "write a NEW clip between the
  // neighbours" rather than "rewrite this one".
  const regenerateShot = async (si, opts = {}) => {
    if (shotBusy !== null || promptBusy !== null) return
    const cut = opts.cut || directorsCut
    if (!cut?.shots?.[si]) return
    const shot = cut.shots[si]
    const isH3now = promptTarget === 'minimax_h3'
    const noun = isH3now ? 'clip' : 'shot'
    const scene = script?.scenes?.find(s => String(s.id) === String(shot.scene_id))
    const isNew = opts.bridge || !(shot.primary_beat || shot.visual_action || '').trim()
    const prev = cut.shots[si - 1], next = cut.shots[si + 1]
    setShotBusy(si); setError(''); setRawFallback('')
    const refBlock = assembleRefBlock(refImages, REF_HEADING_DIRECTOR, script)
    const lookLine = isH3now && script?.look?.trim() ? `\n\nFilm look: ${script.look.trim()}` : ''
    const langLine = isH3now && script?.language?.trim() ? `\nPrimary language: ${script.language.trim()}` : ''
    const pacingLine = isH3now ? `\n${PACING_LINE[pacing] || PACING_LINE.standard}` : ''
    const framingHint = aspectFramingHint(aspectRes(aspectRatio))
    const framingLine = framingHint ? `\nFraming for delivery: ${framingHint}` : ''
    const task = isNew
      ? `Write a NEW ${noun} to sit between ${noun} ${prev?.shot_number ?? '(start of the film)'} and ${noun} ${next?.shot_number ?? '(end of the film)'}`
        + `${scene?.title ? ` in scene "${scene.title}"` : ''}. Add a beat that improves the pacing or coverage between them — a reaction, an insert cutaway, a connective action, or (if the moment genuinely needs it) a new person entering, a location change, or a costume change. Only match both neighbours' subject list where nothing has actually changed — don't force continuity onto a real subject-list change; follow SUBJECT LOCK instead and give it its own reference_images pin. Keep the same "scene_id".`
      : `Rewrite ONLY ${noun} number ${shot.shot_number}${scene?.title ? ` (scene "${scene.title}")` : ''}. `
        + `Give a fresh interpretation of the same story moment — a different framing, camera move, or beat is fine — but keep it continuous with the ${noun}s immediately before and after it, and keep the same "shot_number" and "scene_id".`
    const userMsg =
      `Script:\n${JSON.stringify(script, null, 2)}${lookLine}${langLine}${pacingLine}${framingLine}${nsfwLine}${refBlock}\n\n`
      + `You already broke this script into the following ${noun}s:\n${JSON.stringify(cut.shots, null, 2)}\n\n`
      + `${task} `
      + `Output only valid JSON: {"shots":[ <the one ${noun} object, exactly the same fields as the others> ]}.`
    try {
      const { text } = await callOllama(writerModel, userMsg, isH3now ? SYSTEM_PROMPT_DIRECTOR_H3 : SYSTEM_PROMPT_DIRECTOR, cfg, 0.85, { format: 'json' })
      const raw = parseJSON(text)
      const arr = Array.isArray(raw?.shots) ? raw.shots : raw?.shot ? [raw.shot] : Array.isArray(raw) ? raw : []
      const fresh = (normalizeDirectorsCut({ shots: arr }, script).shots || [])[0]
      if (!fresh) throw new Error(`The model did not return a ${noun}.`)
      // A returned reference_images re-picks this clip (the beat may have
      // changed — e.g. the face is now visible); otherwise keep the existing pin.
      const capd = (refImages || []).filter(im => im.caption && im.caption.trim())
      const picked = isH3now ? resolveRefSelection(fresh.reference_images, capd) : null
      const { reference_images, ...freshRest } = fresh
      const merged = {
        ...freshRest,
        shot_number: shot.shot_number,
        scene_id: shot.scene_id,
        scene_title: shot.scene_title,
        duration: fresh.duration || shot.duration || (isH3now ? 7 : 4),
        ...(picked ? { refs: picked } : (Array.isArray(shot.refs) ? { refs: shot.refs } : {})),
        // A regenerated shot's dialogue can change, but a hand-pinned voice
        // selection is a deliberate choice about WHO speaks with WHICH
        // sample — the Director's JSON has no field for it, so it must be
        // carried over explicitly or it silently reverts to auto.
        ...(Array.isArray(shot.voiceCharacterIds) ? { voiceCharacterIds: shot.voiceCharacterIds } : {}),
      }
      const nextCut = { ...cut, shots: cut.shots.map((s, i) => i === si ? merged : s) }
      setDirectorsCut(nextCut)
      setRawFallback('')
      setExpandedShots(prev => new Set(prev).add(si))
      persistState(undefined, undefined, nextCut)
    } catch (e) {
      setError(e.message)
    } finally {
      setShotBusy(null)
    }
  }

  // Insert / remove a clip on the Director's-Cut screen. framePrompts AND
  // finalPrompts (populated once the user has been to the Video-Prompts screen
  // and stepped back) are strictly index-parallel, so they move in lockstep;
  // shot_number is re-sequenced; the index-keyed transient pickers are reset.
  const emptyPromptEntry = (shot) => ({
    shotNumber: shot?.shot_number || 0, sceneTitle: shot?.scene_title || '',
    text: '', usage: null, loading: false, error: '',
  })
  const renumberPrompts = (prompts) => (prompts || []).map((p, i) => ({ ...p, shotNumber: i + 1 }))
  const clearShotTransients = () => {
    setPicker({ key: null, loading: false, error: '', items: [] })
    setComfyFrame({ key: null, state: 'idle', error: '' })
    setAttach({ key: null, state: 'idle', error: '' })
  }
  const insertShot = (atIndex) => {
    if (phase !== 'dircut' || shotBusy !== null || promptBusy !== null || !directorsCut) return
    const isH3now = promptTarget === 'minimax_h3'
    const neighbor = directorsCut.shots[atIndex - 1] || directorsCut.shots[atIndex] || null
    const nextShots = renumberShots([
      ...directorsCut.shots.slice(0, atIndex),
      blankShot(neighbor, isH3now, script),
      ...directorsCut.shots.slice(atIndex),
    ])
    const nextCut = { ...directorsCut, shots: nextShots }
    const nextFrames = [
      ...framePrompts.slice(0, atIndex), emptyFrameEntry(), ...framePrompts.slice(atIndex),
    ]
    const nextPrompts = finalPrompts.length
      ? renumberPrompts([...finalPrompts.slice(0, atIndex), emptyPromptEntry(nextShots[atIndex]), ...finalPrompts.slice(atIndex)])
      : finalPrompts
    setDirectorsCut(nextCut)
    setFramePrompts(nextFrames)
    if (finalPrompts.length) setFinalPrompts(nextPrompts)
    clearShotTransients()
    setExpandedShots(prev => shiftExpandedForInsert(prev, atIndex).add(atIndex))
    setExpandedPrompts(prev => shiftExpandedForInsert(prev, atIndex))
    persistState(nextFrames, undefined, nextCut, undefined, nextPrompts)
    regenerateShot(atIndex, { cut: nextCut, bridge: true })
  }
  const removeShot = (si) => {
    if (phase !== 'dircut' || shotBusy !== null || promptBusy !== null || !directorsCut || directorsCut.shots.length <= 1) return
    const nextCut = { ...directorsCut, shots: renumberShots(directorsCut.shots.filter((_, i) => i !== si)) }
    const nextFrames = framePrompts.filter((_, i) => i !== si)
    const nextPrompts = finalPrompts.length ? renumberPrompts(finalPrompts.filter((_, i) => i !== si)) : finalPrompts
    setDirectorsCut(nextCut)
    setFramePrompts(nextFrames)
    if (finalPrompts.length) setFinalPrompts(nextPrompts)
    clearShotTransients()
    setExpandedShots(prev => shiftExpandedForRemove(prev, si))
    setExpandedPrompts(prev => shiftExpandedForRemove(prev, si))
    persistState(nextFrames, undefined, nextCut, undefined, nextPrompts)
  }

  // --- Clip merging (manual button + Full-Auto automatic pass) ------------
  // Four rounds of trying to get the Director to self-limit clip count via
  // prompt wording (PACING_LINE, then conditional insert/establishing rules
  // scoped to Pacing: TIGHT) produced no measurable reduction — confirmed
  // against both a non-reasoning and a reasoning-capable model. The prompt
  // enumerates four legitimate shot_type values, and every model tested
  // reaches for all of them regardless of how strongly pacing asks it not
  // to. This is the deterministic alternative: decide in code which clips
  // are safe to combine, then ask the model only the narrow, tractable
  // question "merge these two specific compatible clips" — never the open
  // question "how many clips should this scene have," which is what kept
  // failing.
  //
  // isMergeEligible is deliberately conservative: shot_type 'establishing'
  // and 'action' are H3's own "does not count toward beat density"
  // categories (see the BEAT DENSITY rule in SYSTEM_PROMPT_DIRECTOR_H3) —
  // the only shot types this ever touches. It will under-merge a locomotion
  // beat the model mislabeled 'performance' (as happened once in testing),
  // but it will never risk merging two real facial/emotional beats — that
  // would violate the one rule in h3-storyboard with direct empirical
  // (PSNR) backing, which this project has been careful not to touch.
  const sameIdSet = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    const sa = [...a].map(String).sort(), sb = [...b].map(String).sort()
    return sa.every((v, i) => v === sb[i])
  }
  const NO_BEAT_SHOT_TYPES = new Set(['establishing', 'action'])
  const isMergeEligible = (a, b) => !!a && !!b
    && NO_BEAT_SHOT_TYPES.has(a.shot_type) && NO_BEAT_SHOT_TYPES.has(b.shot_type)
    && String(a.scene_id) === String(b.scene_id)
    && String(a.location_id ?? '') === String(b.location_id ?? '')
    && sameIdSet(a.characters, b.characters)
    && !(a.dialogue?.length) && !(b.dialogue?.length)
    && (Number(a.duration) || 0) + (Number(b.duration) || 0) <= 15

  // The one shared LLM call, used by both the manual button and the
  // automatic Full-Auto pass in runPhase2. Mirrors regenerateShot's "bridge"
  // message-building pattern, but scoped to combining exactly two adjacent,
  // already-known-compatible clips into one.
  const mergeShotPair = async (shots, i, refsForCall) => {
    const a = shots[i], b = shots[i + 1]
    const isH3now = promptTarget === 'minimax_h3'
    const noun = isH3now ? 'clip' : 'shot'
    const scene = script?.scenes?.find(s => String(s.id) === String(a.scene_id))
    const refBlock = assembleRefBlock(refsForCall || refImages, REF_HEADING_DIRECTOR, script)
    const lookLine = isH3now && script?.look?.trim() ? `\n\nFilm look: ${script.look.trim()}` : ''
    const langLine = isH3now && script?.language?.trim() ? `\nPrimary language: ${script.language.trim()}` : ''
    const userMsg =
      `Script:\n${JSON.stringify(script, null, 2)}${lookLine}${langLine}${nsfwLine}${refBlock}\n\n`
      + `You already broke this script into the following ${noun}s:\n${JSON.stringify(shots, null, 2)}\n\n`
      + `Merge ${noun} ${a.shot_number} and ${noun} ${b.shot_number}${scene?.title ? ` (scene "${scene.title}")` : ''} into ONE ${noun} that covers both actions in sequence. `
      + `They share the same scene, location and cast, and neither needs its own facial/emotional beat — this is a pure locomotion/setup run. `
      + `Use ONE camera move for the whole thing, and keep "duration" within the 4-15s H3 cap. `
      + `Keep "scene_id": ${JSON.stringify(a.scene_id)}. `
      + `Output only valid JSON: {"shots":[ <the one merged ${noun}, exactly the same fields as the others> ]}.`
    const { text } = await callOllama(writerModel, userMsg, isH3now ? SYSTEM_PROMPT_DIRECTOR_H3 : SYSTEM_PROMPT_DIRECTOR, cfg, 0.6, { format: 'json' })
    const raw = parseJSON(text)
    const arr = Array.isArray(raw?.shots) ? raw.shots : raw?.shot ? [raw.shot] : Array.isArray(raw) ? raw : []
    const fresh = (normalizeDirectorsCut({ shots: arr }, script).shots || [])[0]
    if (!fresh) throw new Error(`The model did not return a merged ${noun}.`)
    const { reference_images, ...freshRest } = fresh
    const capd = (refsForCall || refImages || []).filter(im => im.caption && im.caption.trim())
    const picked = isH3now ? resolveRefSelection(reference_images, capd) : null
    const mergedRefs = Array.isArray(a.refs) || Array.isArray(b.refs)
      ? [...new Set([...(a.refs || []), ...(b.refs || [])])]
      : undefined
    const mergedVoices = Array.isArray(a.voiceCharacterIds) || Array.isArray(b.voiceCharacterIds)
      ? [...new Set([...(a.voiceCharacterIds || []), ...(b.voiceCharacterIds || [])])].slice(0, MAX_VOICES_PER_SHOT)
      : undefined
    const merged = {
      ...freshRest,
      shot_number: a.shot_number,
      scene_id: a.scene_id,
      scene_title: a.scene_title,
      duration: Math.min(15, fresh.duration || ((Number(a.duration) || 0) + (Number(b.duration) || 0)) || 7),
      ...(picked ? { refs: picked } : (mergedRefs ? { refs: mergedRefs } : {})),
      ...(mergedVoices ? { voiceCharacterIds: mergedVoices } : {}),
    }
    return renumberShots([...shots.slice(0, i), merged, ...shots.slice(i + 2)])
  }

  // The LLM half of the dialogue-coverage fix — findMissingDialogue (module
  // scope, above) finds WHERE a line is missing; this writes the one clip
  // that delivers it. Mirrors mergeShotPair's shape: same shot-list-as-
  // context message, same Director system prompt, scoped to one narrow
  // question. After the call returns, "dialogue" is FORCED back to the exact
  // original line regardless of what the model wrote there — the same
  // belt-and-suspenders reasoning as withLoraTriggers repairing a mangled
  // token: the prompt already asks for verbatim and that alone isn't
  // reliable enough to trust for an "exactly" requirement.
  const writeDialogueClip = async ({ scene, neighbor, line }, shots, refsForCall, capd) => {
    const isVO = /\(V\.O\.\)\s*:/i.test(line)
    const refBlock = assembleRefBlock(refsForCall || refImages, REF_HEADING_DIRECTOR, script)
    const lookLine = script?.look?.trim() ? `\n\nFilm look: ${script.look.trim()}` : ''
    const langLine = script?.language?.trim() ? `\nPrimary language: ${script.language.trim()}` : ''
    const sceneName = scene?.title || String(scene?.id ?? '')
    const task =
      `The script also contains the following line in scene "${sceneName}", which none of the clips above currently deliver: ${JSON.stringify(line)}\n\n`
      + `Write ONE NEW clip whose entire job is to deliver this exact line. Reproduce it VERBATIM, character for character, as the clip's sole "dialogue" entry — never paraphrase, shorten, translate, or drop any part of it. `
      + (isVO
        ? `It is off-screen narration (a "(V.O.)" line): the on-screen action does not need to depict what the line describes — simple continuity business (a physical action, a gesture, a held reaction) that fits the scene is enough. `
        : '')
      + `Place it in scene "${sceneName}"${neighbor ? `, right after clip ${neighbor.shot_number}` : ' at the start of the film'}. `
      + `Keep "scene_id": ${JSON.stringify(scene?.id)}.`
    const userMsg =
      `Script:\n${JSON.stringify(script, null, 2)}${lookLine}${langLine}${nsfwLine}${refBlock}\n\n`
      + `You already broke this script into the following clips:\n${JSON.stringify(shots, null, 2)}\n\n`
      + `${task} `
      + `Output only valid JSON: {"shots":[ <the one new clip, exactly the same fields as the others> ]}.`
    const { text } = await callOllama(writerModel, userMsg, SYSTEM_PROMPT_DIRECTOR_H3, cfg, 0.6, { format: 'json' })
    const raw = parseJSON(text)
    const arr = Array.isArray(raw?.shots) ? raw.shots : raw?.shot ? [raw.shot] : Array.isArray(raw) ? raw : []
    const fresh = (normalizeDirectorsCut({ shots: arr }, script).shots || [])[0]
    if (!fresh) throw new Error('The model did not return a clip.')
    const { reference_images, ...freshRest } = fresh
    const picked = resolveRefSelection(reference_images, capd)
    return {
      ...freshRest,
      scene_id: scene?.id ?? freshRest.scene_id,
      scene_title: scene?.title ?? freshRest.scene_title,
      dialogue: [line],
      shot_number: 0,
      duration: fresh.duration || 6,
      ...(picked ? { refs: picked } : {}),
    }
  }

  // Degrades gracefully rather than losing the line outright: used only when
  // writeDialogueClip's call errors (bad JSON, network) — a refusal is NOT
  // caught here, it propagates and stops the run, same policy as everywhere
  // else a writer-model refusal can surface (see "Content refusals" in
  // CLAUDE.md) — a fallback would risk quietly masking a real content issue.
  const fallbackDialogueClip = ({ scene, neighbor, line }) => ({
    ...blankShot(neighbor, true, script),
    scene_id: scene?.id ?? neighbor?.scene_id,
    scene_title: scene?.title ?? neighbor?.scene_title,
    shot_type: 'performance',
    primary_beat: 'Delivers a line of narration; no other beat in this clip.',
    dialogue: [line],
    duration: 6,
    notes: 'auto-inserted to preserve a source dialogue line — the write-up call for it failed; needs a human pass.',
  })

  // Runs after Phase 2 parses the Director's response (H3 only — LTX's shot
  // schema has no "dialogue" field to reconcile). One clip-writing call per
  // missing line, bounded like Phase 3's per-clip calls (a dense source-text
  // letter can produce a dozen-plus gaps at once). Insertions are grouped by
  // anchor and spliced back in a single pass, preserving both scene order
  // (gaps/jobs are built by walking script.scenes in order) and each scene's
  // own line order.
  const fillDialogueGaps = async (shots, refsForCall) => {
    const gaps = findMissingDialogue(shots, script)
    if (!gaps.length) return shots
    const jobs = []
    for (const gap of gaps) {
      const scene = script?.scenes?.find(s => String(s.id) === String(gap.sceneId))
      const neighbor = shots[gap.anchor] || shots[gap.anchor + 1] || null
      for (const line of gap.lines) jobs.push({ gap, scene, neighbor, line })
    }
    const capd = (refsForCall || refImages || []).filter(im => im.caption && im.caption.trim())
    const written = new Array(jobs.length)
    await mapWithConcurrency(jobs, 6, async (job, idx) => {
      try {
        written[idx] = await writeDialogueClip(job, shots, refsForCall, capd)
      } catch (e) {
        if (e?.isRefusal) throw e
        written[idx] = fallbackDialogueClip(job)
      }
    })
    const byAnchor = new Map()
    jobs.forEach((job, idx) => {
      const list = byAnchor.get(job.gap.anchor) || []
      list.push(written[idx])
      byAnchor.set(job.gap.anchor, list)
    })
    const result = [...(byAnchor.get(-1) || [])]
    shots.forEach((s, i) => {
      result.push(s)
      if (byAnchor.has(i)) result.push(...byAnchor.get(i))
    })
    return renumberShots(result)
  }

  // Manual trigger — "⇄ Merge" button on the Director's-Cut screen. The user
  // picks the pair; a mismatched pair (different scene/location/cast, or
  // either carries dialogue) gets a confirm prompt rather than a hard block,
  // same pattern as "↻ Re-run Director's Cut" — full manual override stays
  // available, just with a nudge.
  const mergeShots = async (si) => {
    if (phase !== 'dircut' || shotBusy !== null || promptBusy !== null || !directorsCut) return
    const a = directorsCut.shots[si], b = directorsCut.shots[si + 1]
    if (!a || !b) return
    if (!isMergeEligible(a, b) && typeof window !== 'undefined' && !window.confirm(
      `Clip ${a.shot_number} and ${b.shot_number} differ in scene, location, or cast — or one carries dialogue. Merging them may not read correctly. Merge anyway?`
    )) return
    setShotBusy(si); setError('')
    try {
      const nextShots = await mergeShotPair(directorsCut.shots, si, refImages)
      const nextCut = { ...directorsCut, shots: nextShots }
      const nextFrames = [...framePrompts.slice(0, si), framePrompts[si] || emptyFrameEntry(), ...framePrompts.slice(si + 2)]
      const nextPrompts = finalPrompts.length
        ? renumberPrompts([...finalPrompts.slice(0, si), emptyPromptEntry(nextShots[si]), ...finalPrompts.slice(si + 2)])
        : finalPrompts
      setDirectorsCut(nextCut)
      setFramePrompts(nextFrames)
      if (finalPrompts.length) setFinalPrompts(nextPrompts)
      clearShotTransients()
      setExpandedShots(prev => shiftExpandedForMerge(prev, si).add(si))
      setExpandedPrompts(prev => shiftExpandedForMerge(prev, si))
      persistState(nextFrames, undefined, nextCut, undefined, nextPrompts)
    } catch (e) {
      setError(e.message)
    } finally {
      setShotBusy(null)
    }
  }

  // Slim dashed "insert a clip here" bar shown between / around clip cards.
  const insertBar = (idx) => (
    <button key={`ins-${idx}`} onClick={() => insertShot(idx)}
      disabled={shotBusy !== null || promptBusy !== null}
      title="Insert a blank clip here — the AI writes a beat that bridges the neighbours"
      style={{
        width: '100%', border: '1px dashed var(--pe-accent-line)', background: 'transparent',
        color: 'var(--pe-accent-ink)', borderRadius: 8, padding: '5px 0', margin: '0 0 10px',
        fontSize: 12.5, cursor: (shotBusy !== null || promptBusy !== null) ? 'wait' : 'pointer',
      }}>
      + Insert clip{shotBusy !== null || promptBusy !== null ? '' : ' (AI writes it)'}
    </button>
  )

  // Re-run phase 3 for ONE clip only — a fresh prompt in place, higher
  // temperature. Used on the Video-Prompts screen.
  const regeneratePrompt = async (idx) => {
    if (promptBusy !== null || shotBusy !== null || !directorsCut?.shots?.[idx]) return
    const shot = directorsCut.shots[idx]
    const isH3now = promptTarget === 'minimax_h3'
    setPromptBusy(idx); setError('')
    setExpandedPrompts(prev => new Set(prev).add(idx))
    setFinalPrompts(prev => prev.map((p, i) => i === idx ? { ...p, loading: true, error: '' } : p))
    let refs = refImages
    if (isH3now && refImages.some(im => im.base64 && !im.caption?.trim())) {
      try { refs = await captionRefImages() }
      catch (e) {
        if (e?.isRefusal) {
          setFinalPrompts(prev => prev.map((p, i) => i === idx ? { ...p, loading: false, error: e.message } : p))
          setPromptBusy(null)
          return
        }
      }
    }
    const ratio = aspectRes(aspectRatio)
    const systemPrompt = clipSystemForShot(shot)
    try {
      const userMsg = buildShotPromptMsg(shot, refs, ratio)
      const { text: raw, usage } = await callOllama(writerModel, userMsg, systemPrompt, cfg, 0.85)
      // Phase 3 output is plain text, not JSON — parseJSON's refusal check
      // never runs on it. A refused clip must not be saved as if it were a
      // real prompt (this used to happen silently here).
      if (looksLikeRefusal(raw)) throw Object.assign(new Error(raw.trim()), { isRefusal: true })
      const isRefShot = /^MODE:\s*Ref2VA/.test(userMsg)
      const text = withLoraTriggers(isH3now ? normalizeH3Prompt(raw, isRefShot) : raw, lorasForShot(shot), promptTarget)
      // Frozen at generation time — see the matching comment in runPhase3.
      const h3Mode = isH3now ? (isRefShot ? 'Ref2VA' : 'T2VA') : null
      let saved = null
      setFinalPrompts(prev => {
        const next = prev.map((p, i) => i === idx ? { ...p, text, usage, loading: false, error: '', h3Mode } : p)
        saved = next
        return next
      })
      if (saved) commitHistory({
        ...basePayload('done', refs),
        script, directorsCut,
        finalPrompts: saved.map(p => ({ shotNumber: p.shotNumber, sceneTitle: p.sceneTitle, text: p.text || '', usage: p.usage || null, h3Mode: p.h3Mode || null })),
        framePrompts: serializeFramePrompts(framePrompts),
      })
    } catch (e) {
      setFinalPrompts(prev => prev.map((p, i) => i === idx ? { ...p, loading: false, error: e.message } : p))
    } finally {
      setPromptBusy(null)
    }
  }

  // Attach/update this clip's voice-timbre reference(s) WITHOUT a full
  // ✦ Rewrite — a narrow, low-temperature patch call (VOICE_PATCH_SYSTEM)
  // given the clip's existing text verbatim and told to change only the Audio
  // references. H3 only; a clip with no resolvable voice reference never
  // shows the button that calls this (see the Video-Prompts screen).
  const attachVoiceReference = async (idx) => {
    if (promptBusy !== null || shotBusy !== null || !directorsCut?.shots?.[idx]) return
    const shot = directorsCut.shots[idx]
    const scene = script?.scenes?.find(s => String(s.id) === String(shot.scene_id))
    const dialogues = shotDialogues(shot, scene)
    const voices = voicesForShot(shot, scene, dialogues)
    const existing = finalPrompts[idx]?.text || ''
    if (!voices.length || !existing.trim()) return
    setPromptBusy(idx); setError('')
    setExpandedPrompts(prev => new Set(prev).add(idx))
    setFinalPrompts(prev => prev.map((p, i) => i === idx ? { ...p, loading: true, error: '' } : p))
    const voiceLines = voices.map((voice, vi) =>
      `Audio ${vi + 1}: file "${voice.fileName}"${voice.speaker ? ` — the voice of ${voice.speaker}` : ''}. Reference ONLY its timbre, pitch and delivery for the speaking subject; never transcribe or guess at its original wording. The spoken words stay exactly whatever dialogue the current text already carries.`
    ).join('\n')
    const userMsg = `Voice-timbre reference(s) to attach:\n${voiceLines}\n\nCurrent prompt text for this clip:\n${existing}`
    try {
      const { text: raw, usage } = await callOllama(writerModel, userMsg, VOICE_PATCH_SYSTEM, cfg, 0.2)
      if (looksLikeRefusal(raw)) throw Object.assign(new Error(raw.trim()), { isRefusal: true })
      const isRefFlag = /^\s*subject_definitions\s*:/i.test(existing) || /^\s*subject_definitions\s*:/i.test(raw)
      const text = withLoraTriggers(normalizeH3Prompt(raw, isRefFlag), lorasForShot(shot), promptTarget)
      const h3Mode = isRefFlag ? 'Ref2VA' : 'T2VA'
      let saved = null
      setFinalPrompts(prev => {
        const next = prev.map((p, i) => i === idx ? { ...p, text, usage, loading: false, error: '', h3Mode } : p)
        saved = next
        return next
      })
      if (saved) commitHistory({
        ...basePayload('done', refImages),
        script, directorsCut,
        finalPrompts: saved.map(p => ({ shotNumber: p.shotNumber, sceneTitle: p.sceneTitle, text: p.text || '', usage: p.usage || null, h3Mode: p.h3Mode || null })),
        framePrompts: serializeFramePrompts(framePrompts),
      })
    } catch (e) {
      setFinalPrompts(prev => prev.map((p, i) => i === idx ? { ...p, loading: false, error: e.message } : p))
    } finally {
      setPromptBusy(null)
    }
  }

  // --- bible editing helpers (film fields, cast, locations) ---------------
  const genId = (prefix, list) => {
    let n = (list?.length || 0) + 1
    const taken = new Set((list || []).map(x => x.id))
    while (taken.has(`${prefix}${n}`)) n++
    return `${prefix}${n}`
  }
  const updateFilmField = (field_, val) => setScript(prev => ({ ...prev, [field_]: val }))
  // Acknowledge + clear the writer's "this idea is bigger than the format" note.
  const dismissFormatNote = () => {
    const next = { ...script, format_note: '' }
    setScript(next)
    persistState(undefined, undefined, undefined, undefined, undefined, next)
  }
  const updateCharacter = (ci, field_, val) => setScript(prev => ({
    ...prev, characters: (prev.characters || []).map((c, i) => i === ci ? { ...c, [field_]: val } : c),
  }))
  const addCharacter = () => setScript(prev => ({
    ...prev, characters: [...(prev.characters || []), { id: genId('c', prev.characters), name: 'NEW CHARACTER', role_in_story: 'supporting', appearance: '', wardrobe: '', voice: '' }],
  }))
  const removeCharacter = (ci) => setScript(prev => ({
    ...prev, characters: (prev.characters || []).filter((_, i) => i !== ci),
  }))
  const updateLocation = (li, field_, val) => setScript(prev => ({
    ...prev, locations: (prev.locations || []).map((l, i) => i === li ? { ...l, [field_]: val } : l),
  }))
  const addLocation = () => setScript(prev => ({
    ...prev, locations: [...(prev.locations || []), { id: genId('l', prev.locations), name: 'New location', description: '' }],
  }))
  const removeLocation = (li) => setScript(prev => ({
    ...prev, locations: (prev.locations || []).filter((_, i) => i !== li),
  }))
  const toggleSceneCharacter = (si, cid) => setScript(prev => ({
    ...prev, scenes: prev.scenes.map((s, i) => {
      if (i !== si) return s
      const cur = Array.isArray(s.characters) ? s.characters : []
      return { ...s, characters: cur.includes(cid) ? cur.filter(x => x !== cid) : [...cur, cid] }
    }),
  }))

  // Scene editing helpers
  const updateScene = (si, field_, val) => setScript(prev => ({
    ...prev, scenes: prev.scenes.map((s, i) => i === si ? { ...s, [field_]: val } : s),
  }))
  const updateDialogue = (si, di, val) => setScript(prev => ({
    ...prev, scenes: prev.scenes.map((s, i) => i === si
      ? { ...s, dialogues: s.dialogues.map((d, j) => j === di ? val : d) } : s),
  }))
  const addDialogue = (si) => setScript(prev => ({
    ...prev, scenes: prev.scenes.map((s, i) => i === si ? { ...s, dialogues: [...s.dialogues, ''] } : s),
  }))
  const removeDialogue = (si, di) => setScript(prev => ({
    ...prev, scenes: prev.scenes.map((s, i) => i === si
      ? { ...s, dialogues: s.dialogues.filter((_, j) => j !== di) } : s),
  }))

  // Shot editing helpers
  const updateShot = (si, field_, val) => setDirectorsCut(prev => ({
    ...prev, shots: prev.shots.map((s, i) => i === si ? { ...s, [field_]: val } : s),
  }))

  // Frame prompt helpers
  const generateFramePrompt = async (shotIdx, frameKey) => {
    const shot = directorsCut.shots[shotIdx]
    const target = framePrompts[shotIdx].frames[frameKey].target
    const framePos = frameKey === 'first' ? 'start (first)' : frameKey === 'mid' ? 'middle' : 'end (last)'
    // A tag-based writer (SDXL) is confused by a prose continuity block, so its table
    // row opts out with refBlockInFrames: false. Anything that does not say otherwise
    // gets the block — including Z-Image Turbo, which has no table row at all — which
    // is exactly what the old `target !== 'sdxl'` test did.
    const refBlock = (caps(target).refBlockInFrames ?? true)
      ? assembleRefBlock(refImages, REF_HEADING_LITE, script)
      : ''
    const action = shot.visual_action || shot.primary_beat || ''
    const shotLoras = lorasForShot(shot)
    const userMsg = `Generate a still image prompt for the ${framePos} frame of a ${shot.duration || 4}-second video clip.\n\nShot ${shot.shot_number} — ${shot.scene_title}\nCamera framing: ${shot.camera_framing}\nLighting/mood: ${shot.lighting_mood}\nVisual action: ${action}\nTarget aspect ratio: ${aspectToken(aspectRatio)} — compose for this frame shape.\n\nThis is the ${framePos} of the clip. Describe the exact visual state at this moment as a still image.${refBlock}${loraInstruction(shotLoras, target)}`

    setFramePrompts(prev => prev.map((fp, i) => i !== shotIdx ? fp : {
      ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], loading: true, error: '' } }
    }))
    try {
      const { text: raw } = await callOllama(writerModel, userMsg, FRAME_SYSTEM[target], cfg, 0.7)
      const text = withLoraTriggers(raw, shotLoras, target)
      setFramePrompts(prev => prev.map((fp, i) => i !== shotIdx ? fp : {
        ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], text, loading: false } }
      }))
    } catch (e) {
      setFramePrompts(prev => prev.map((fp, i) => i !== shotIdx ? fp : {
        ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], loading: false, error: e.message } }
      }))
    }
  }

  const setFrameTarget = (shotIdx, frameKey, target) => {
    setFramePrompts(prev => prev.map((fp, i) => i !== shotIdx ? fp : {
      ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], target } }
    }))
  }

  const editFramePrompt = (shotIdx, frameKey, val) => {
    setFramePrompts(prev => prev.map((fp, i) => i !== shotIdx ? fp : {
      ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], text: val } }
    }))
  }

  // Pushes one generated frame-image prompt to the Prompt Enhancer Bridge node
  // pack in ComfyUI (same slot mechanism the main app's "→ ComfyUI" button uses).
  // No input images in the scriptwriter flow, so the shot carries an empty image set.
  const sendFrameToComfy = async (shotIdx, frameKey) => {
    const fp = framePrompts[shotIdx]?.frames[frameKey]
    if (!fp?.text) return
    const shot = directorsCut.shots[shotIdx]
    const ck = `${shotIdx}-${frameKey}`
    setComfyFrame({ key: ck, state: 'sending', error: '' })
    try {
      await sendShot({
        positive: fp.text, negative: '', target: fp.target,
        duration: shot.duration || 4, frameMode: 'single',
        shot: shot.shot_number, scene: shot.scene_title, frame: frameKey,
        images: { first: '', mid: '', last: '', ref: [] },
      }, comfyCfg.url, comfyCfg.slot)
      setComfyFrame({ key: ck, state: 'done', error: '' })
      setTimeout(() => setComfyFrame(prev =>
        prev.key === ck && prev.state === 'done' ? { key: null, state: 'idle', error: '' } : prev), 2500)
    } catch (e) {
      setComfyFrame({ key: ck, state: 'error', error: e.message })
    }
  }

  // Re-save the whole session under the same id at the CURRENT phase — used after
  // a frame image, a cast portrait, or a reference edit lands between phases. Pass
  // the just-computed framePrompts / refImages arrays to sidestep state-update lag.
  //
  // Debounced: this fires from ~15 call sites, several in quick succession during
  // captioning / portrait rendering, and each save ships the WHOLE session. A
  // trailing debounce is safe precisely because every call is a full snapshot
  // under one stable id — last-write-wins loses no intermediate artifact. The
  // timer is flushed on unmount (below), which also covers "navigate away" since
  // that remounts the panel.
  const persistTimer = useRef(null)
  const persistArgs = useRef(null)
  const persistNowRef = useRef(null)   // always the current-render persistStateNow

  // Scroll target for the Director's-Cut "no described references" banners'
  // "↑ Jump to Reference Images" button — the panel is always on screen
  // (column 2, gated only on phase !== 'prompting'), just possibly scrolled
  // out of view; this brings it back rather than claiming a destination
  // screen that doesn't exist.
  const refImagesPanelRef = useRef(null)
  const scrollToRefImages = () => refImagesPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const persistStateNow = (framePromptsOverride, refsOverride, cutOverride, phaseOverride, promptsOverride, scriptOverride) => {
    const scr = scriptOverride || script
    if (!onSaveHistory || !scr) return
    // Always store every artifact that exists, regardless of the current screen —
    // the record must carry the WHOLE path (script → cut → prompts) so a restore
    // can drop the user back on any step with the others intact. `phase` alone
    // says which screen they were last on.
    const fp = promptsOverride !== undefined ? promptsOverride : finalPrompts
    commitHistory({
      ...basePayload(phaseOverride || phase, refsOverride || refImages),
      script: scr,
      directorsCut: cutOverride || directorsCut || null,
      finalPrompts: (fp && fp.length)
        ? fp.map(p => ({ shotNumber: p.shotNumber, sceneTitle: p.sceneTitle, text: p.text || '', usage: p.usage || null }))
        : null,
      framePrompts: serializeFramePrompts(framePromptsOverride || framePrompts),
    })
  }
  persistNowRef.current = persistStateNow
  const flushPersist = () => {
    if (!persistTimer.current) return
    clearTimeout(persistTimer.current)
    persistTimer.current = null
    const a = persistArgs.current
    persistArgs.current = null
    if (a) persistNowRef.current(...a)
  }
  const persistState = (...args) => {
    persistArgs.current = args
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null
      const a = persistArgs.current
      persistArgs.current = null
      if (a) persistNowRef.current(...a)
    }, 600)
  }
  // Flush a pending save on unmount (covers "navigate away", which remounts) and
  // on a page reload / tab close inside the 600 ms window.
  useEffect(() => {
    const onBeforeUnload = () => flushPersist()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => { window.removeEventListener('beforeunload', onBeforeUnload); flushPersist() }
  }, [])

  // The user can jump between finished steps at will (the stepper dots and the
  // "← Back to …" buttons) — pure navigation, never re-runs the LLM. Each jump is
  // written to history so a restore lands on the same screen.
  const stepReachable = (target) => {
    if (target === 'script') return !!script
    if (target === 'dircut') return !!directorsCut
    if (target === 'done')   return finalPrompts.length > 0
    return false
  }
  const navBusy = () => ['scripting', 'directing', 'prompting'].includes(phase)
    || sceneBusy !== null || shotBusy !== null || promptBusy !== null
  const navigateTo = (target) => {
    if (navBusy() || phase === target || !stepReachable(target)) return
    setPhase(target)
    setError(''); setRawFallback('')
    persistState(undefined, undefined, undefined, target)
  }

  // --- pull a rendered image back from ComfyUI --------------------------------
  const loadPickerItems = async (key) => {
    setPicker({ key, loading: true, error: '', items: [] })
    try {
      const items = await fetchComfyOutputs(comfyCfg.url, { max: 24 })
      setPicker({ key, loading: false, error: items.length ? '' : 'No recent ComfyUI outputs found. Render one first, then Refresh.', items })
    } catch (e) {
      setPicker({ key, loading: false, error: e.message, items: [] })
    }
  }

  const openPickerKey = (key) => {
    if (picker.key === key) { setPicker({ key: null, loading: false, error: '', items: [] }); return }
    loadPickerItems(key)
  }
  const openPicker = (shotIdx, frameKey) => openPickerKey(`${shotIdx}-${frameKey}`)

  const attachImage = async (shotIdx, frameKey, item) => {
    const key = `${shotIdx}-${frameKey}`
    setAttach({ key, state: 'fetching', error: '' })
    try {
      const blob = await fetchComfyImageBlob(item.viewUrl)
      const { base64, mediaType, width, height } = await shrinkToJpeg(blob, 1536, 0.85)
      const image = {
        b64: base64, mediaType, width, height,
        source: { filename: item.filename, subfolder: item.subfolder, type: item.type },
        ts: Date.now(),
      }
      const next = framePrompts.map((fp, i) => i !== shotIdx ? fp : {
        ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], image } },
      })
      setFramePrompts(next)
      setAttach({ key: null, state: 'idle', error: '' })
      setPicker({ key: null, loading: false, error: '', items: [] })
      persistState(next)
    } catch (e) {
      setAttach({ key, state: 'error', error: e.message })
    }
  }

  const removeFrameImage = (shotIdx, frameKey) => {
    const next = framePrompts.map((fp, i) => i !== shotIdx ? fp : {
      ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], image: null } },
    })
    setFramePrompts(next)
    persistState(next)
  }

  // --- cast / location portrait references --------------------------------
  // Generate a still-image prompt for a bible entry, render it in ComfyUI, and
  // attach the render back as that entry's H3 identity / environment reference.
  const entityByKey = (key) => {
    const c = (script?.characters || []).find(x => x.id === key)
    if (c) return { kind: 'character', ent: c }
    const l = (script?.locations || []).find(x => x.id === key)
    if (l) return { kind: 'location', ent: l }
    return null
  }
  // A typed reference "belongs to" a bible entry if its linkId points there, or —
  // when it has no linkId — if it is the only entry of that kind, or its
  // note/caption names the entry. Keeps the cast card in sync with the panel
  // even when the user set a link type but not an explicit target.
  const refBelongsTo = (im, key, kind) => {
    if (im.linkId === key) return true
    if (im.linkId) return false
    const list = kind === 'character' ? (script?.characters || []) : (script?.locations || [])
    const ent = list.find(x => x.id === key)
    if (!ent) return false
    if (list.length === 1) return true
    const hay = `${im.note || ''} ${im.caption || ''}`.toLowerCase()
    return !!ent.name && hay.includes(ent.name.toLowerCase())
  }
  const refForEntity = (key) => {
    const isChar = (script?.characters || []).some(c => c.id === key)
    const types = isChar ? ['character', 'wardrobe'] : ['location']
    return (refImages || []).find(im => types.includes(im.linkType) && refBelongsTo(im, key, isChar ? 'character' : 'location'))
  }
  const patchPortrait = (key, patch) => setPortraitDraft(prev => ({ ...prev, [key]: { target: PORTRAIT_DEFAULT_TARGET, text: '', loading: false, error: '', ...prev[key], ...patch } }))
  const startPortrait = (key) => patchPortrait(key, {})

  const generatePortraitPrompt = async (key) => {
    const found = entityByKey(key)
    if (!found) return
    const { kind, ent } = found
    const target = portraitDraft[key]?.target || PORTRAIT_DEFAULT_TARGET
    const look = script?.look?.trim() ? `\nFilm look (match palette and lighting): ${script.look.trim()}` : ''
    // A character plate is exactly where that character's own LoRA belongs.
    const entLora = kind === 'character' && ent.lora ? loraById(ent.lora) : null
    const portraitLoras = [...activeLoras, ...(entLora ? [{ ...entLora, subject: ent.name }] : [])]
    const loraPart = loraInstruction(portraitLoras, target)
    const userMsg = kind === 'character'
      ? `Generate a CHARACTER REFERENCE PORTRAIT for a film — a clean identity plate, not a dramatic shot. Front view, eye level, neutral relaxed expression, direct to camera, plain mid-grey seamless background, soft even key light, framed head to waist. No text, no props, no hard shadows, no motion blur.\n\nCharacter: ${ent.name}\nAppearance: ${(ent.appearance || '').trim()}\nWardrobe: ${(ent.wardrobe || '').trim()}${look}`
      : `Generate an ESTABLISHING STILL of a film location — eye-level, natural lens, no people, no text. It will be used as an environment reference.\n\nLocation: ${ent.name}\n${(ent.description || '').trim()}${look}`
    patchPortrait(key, { loading: true, error: '' })
    try {
      const { text: raw } = await callOllama(writerModel, userMsg + loraPart, FRAME_SYSTEM[target] || FRAME_SYSTEM[PORTRAIT_DEFAULT_TARGET], cfg, 0.6)
      patchPortrait(key, { text: withLoraTriggers(raw, portraitLoras, target), loading: false })
    } catch (e) {
      patchPortrait(key, { loading: false, error: e.message })
    }
  }

  const sendPortraitToComfy = async (key) => {
    const d = portraitDraft[key]
    const found = entityByKey(key)
    if (!d?.text || !found) return
    const ck = `portrait:${key}`
    setComfyFrame({ key: ck, state: 'sending', error: '' })
    try {
      await sendShot({
        positive: d.text, negative: '', target: d.target || PORTRAIT_DEFAULT_TARGET,
        duration: 4, frameMode: 'single',
        shot: 0, scene: `${found.kind} ${found.ent.name}`, frame: 'portrait',
        images: { first: '', mid: '', last: '', ref: [] },
      }, comfyCfg.url, comfyCfg.slot)
      setComfyFrame({ key: ck, state: 'done', error: '' })
      setTimeout(() => setComfyFrame(prev => prev.key === ck && prev.state === 'done' ? { key: null, state: 'idle', error: '' } : prev), 2500)
    } catch (e) {
      setComfyFrame({ key: ck, state: 'error', error: e.message })
    }
  }

  const attachPortraitImage = async (key, item) => {
    const found = entityByKey(key)
    if (!found) return
    const pk = `portrait:${key}`
    setAttach({ key: pk, state: 'fetching', error: '' })
    try {
      const blob = await fetchComfyImageBlob(item.viewUrl)
      const { base64, mediaType } = await shrinkToJpeg(blob, REF_MAX_DIM, 0.85)
      const isChar = found.kind === 'character'
      const newRef = {
        id: generateId(), base64, mediaType,
        previewUrl: `data:${mediaType};base64,${base64}`,
        fileName: `${found.ent.name}-${isChar ? 'portrait' : 'location'}.jpg`,
        note: found.ent.name,
        caption: '',
        linkType: isChar ? 'character' : 'location',
        linkId: key,
        role: isChar ? 'subject_identity' : 'environment',
        preserve: isChar ? 'exact' : 'guide',
        generated: true,
        hash: imageHash(base64),
      }
      const existing = refForEntity(key)
      const next = existing
        ? refImages.map(im => im.id === existing.id ? newRef : im)
        : [...refImages, newRef]
      setRefImages(next)
      setAttach({ key: null, state: 'idle', error: '' })
      setPicker({ key: null, loading: false, error: '', items: [] })
      // caption the new portrait through the role-focused H3 vision prompt
      if (visModel) {
        try {
          const focus = roleDef(newRef.role).visionFocus || ''
          const { text } = await callOllama(visModel, [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: `Describe this reference image as instructed. ${focus}`.trim() },
          ], VISION_PROMPT_MINIMAX_H3_REF, cfg, 0.3)
          const captioned = next.map(im => im.id === newRef.id ? { ...im, caption: (text || '').trim() } : im)
          setRefImages(captioned)
          persistState(undefined, captioned)
        } catch { persistState(undefined, next) }
      } else {
        persistState(undefined, next)
      }
    } catch (e) {
      setAttach({ key: pk, state: 'error', error: e.message })
    }
  }

  const removeEntityRef = (key) => {
    const ex = refForEntity(key)
    if (!ex) return
    const next = refImages.filter(im => im.id !== ex.id)
    setRefImages(next)
    persistState(undefined, next)
  }

  // Upload a photo straight into a cast/location card — sets link + role and
  // captions it, so the user never touches the separate reference panel.
  const uploadPortrait = async (key, fileList) => {
    const found = entityByKey(key)
    const file = Array.from(fileList || []).find(f => f.type.startsWith('image/'))
    if (!found || !file) return
    let base
    try { base = await fileToRef(file) } catch { return }
    const isChar = found.kind === 'character'
    const ref = { ...base, note: found.ent.name,
      linkType: isChar ? 'character' : 'location', linkId: key,
      role: isChar ? 'subject_identity' : 'environment', preserve: isChar ? 'exact' : 'guide' }
    const existing = refForEntity(key)
    const next = existing ? refImages.map(im => im.id === existing.id ? ref : im) : [...refImages, ref]
    setRefImages(next)
    persistState(undefined, next)
    try { const c = await captionRefImages({ imgs: next }); persistState(undefined, c) } catch { /* leave uncaptioned */ }
  }

  const describeEntityRef = (key) => {
    const ex = refForEntity(key)
    if (!ex) return
    // Blank this one's caption so the non-force pass targets only it.
    const list = refImages.map(im => im.id === ex.id ? { ...im, caption: '' } : im)
    captionRefImages({ imgs: list }).then(c => persistState(undefined, c)).catch(() => {})
  }

  // One clip's header line(s): number, scene, duration, mode, and which
  // reference images to load. `refs` = shotRefs() for that clip.
  const clipHeader = (p, shot, refs) => {
    const isH3now = promptTarget === 'minimax_h3'
    if (!isH3now || !shot) return `— Clip ${p.shotNumber} · ${p.sceneTitle} · ${shot?.duration || 4}s`
    const hScene = script?.scenes?.find(s => String(s.id) === String(shot.scene_id))
    const clipVoices = voicesForShot(shot, hScene, shotDialogues(shot, hScene))
    const anchors = activeAnchorsForRefs(shot, refs)
    return [
      `— Clip ${p.shotNumber} · ${p.sceneTitle} · ${shot.duration || 7}s · ${refs.length ? 'Ref2VA' : 'T2VA'}`,
      refs.length
        ? `  Load references: ${refs.map(im => `${refEntityName(im, script) || im.note || roleLabel(im.role)} (${roleLabel(im.role)}, ${preserveLabel(im.preserve)})`).join('; ')}`
        : '  No references — text-to-video',
      anchors.length
        ? `  Add Guide timeline anchors: ${anchors.map(a => `<Picture ${a.pictureN}> @ ${formatTimestamp(a.atSeconds)}`).join('; ')}`
        : '',
      clipVoices.length
        ? `  Load voice reference${clipVoices.length > 1 ? 's' : ''}: ${clipVoices.map(v => `${v.fileName}${v.speaker ? ` (${v.speaker})` : ''}`).join('; ')}`
        : '',
    ].filter(Boolean).join('\n')
  }
  const clipRefsFor = (i) => {
    const shot = (directorsCut?.shots || [])[i]
    const scene = script?.scenes?.find(s => String(s.id) === String(shot?.scene_id))
    return shot ? shotRefs(shot, scene) : []
  }

  const copyAll = () => {
    const shots = directorsCut?.shots || []
    const blocks = finalPrompts.filter(p => p.text).map((p, i) =>
      `${clipHeader(p, shots[i], clipRefsFor(i))}\n\n${p.text}`)
    navigator.clipboard.writeText(blocks.join('\n\n═══\n\n'))
    setCopiedAll(true)
    setTimeout(() => setCopiedAll(false), 2000)
  }

  // Export the whole cut: every clip prompt, the reference-image pack (portraits +
  // uploads, named by the character/location they belong to), any attached LTX
  // frame images, and script/director JSON — as one ZIP.
  const fileSafe = (s) => String(s || '').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').slice(0, 60) || 'untitled'
  const imgExt = (mt) => ((mt || 'image/jpeg').split('/')[1] || 'jpg').replace('jpeg', 'jpg')
  const audioExt = (mt) => ((mt || 'audio/mpeg').split('/')[1] || 'mp3').replace('mpeg', 'mp3').replace('x-', '')
  const exportBundle = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const zip = new JSZip()
      const isH3now = promptTarget === 'minimax_h3'
      const shots = directorsCut?.shots || []
      const done = finalPrompts.filter(p => p.text)

      // per-clip prompt files + combined markdown
      const pad = (n) => String(n).padStart(2, '0')
      const allMd = []
      done.forEach((p, i) => {
        const header = clipHeader(p, shots[i], clipRefsFor(i))
        zip.file(`prompts/clip-${pad(p.shotNumber || i + 1)}.txt`, `${header}\n\n${p.text}\n`)
        allMd.push(`## Clip ${p.shotNumber} — ${p.sceneTitle}\n\n${header}\n\n\`\`\`\n${p.text}\n\`\`\``)
      })
      zip.file('prompts.md', `# ${script?.title || 'Untitled'} — ${isH3now ? 'MiniMax H3' : 'LTX'} prompts\n\n${allMd.join('\n\n---\n\n')}\n`)

      // reference image pack. `refFileByKey` records the exact filename each
      // image was given here, keyed by refKey() — manifest.json (below) looks
      // filenames up through this map rather than recomputing the naming
      // logic, so it can never point at a file that doesn't actually exist.
      const refMd = ['# Reference images\n']
      const refFileByKey = new Map()
      ;(refImages || []).forEach((im, i) => {
        const name = refEntityName(im, script) || im.note || im.fileName || `ref-${i + 1}`
        const base = `${im.linkId ? im.linkId + '-' : ''}${fileSafe(name)}`
        const fname = `references/${base || 'ref-' + (i + 1)}.${imgExt(im.mediaType)}`
        if (im.base64) {
          zip.file(fname, im.base64, { base64: true })
          refFileByKey.set(refKey(im), fname)
        }
        refMd.push(`## ${name}${im.linkType ? ` — ${linkTypeDef(im.linkType)?.label || im.linkType}` : ''}`)
        refMd.push(`role: ${roleLabel(im.role || '—')} · preservation: ${preserveLabel(im.preserve || 'strong')}${im.generated ? ' · generated' : ''}`)
        refMd.push(`\n${im.caption?.trim() || '(not described)'}\n`)
      })
      if ((refImages || []).length) zip.file('references.md', refMd.join('\n'))

      // voice-reference pack, named by the character each sample belongs to.
      // `voiceFileById` is the same trick as refFileByKey above: the manifest
      // looks filenames up here rather than recomputing them, so it can never
      // point at a file that was skipped for having no bytes.
      const voiceFileById = new Map()
      ;(voiceRefs || []).forEach((v, i) => {
        if (!v.base64) return
        const who = (script?.characters || []).find(c => c.id === v.characterId)?.name || 'any-speaker'
        const fname = `voices/${fileSafe(who)}-${i + 1}.${audioExt(v.mediaType)}`
        zip.file(fname, v.base64, { base64: true })
        voiceFileById.set(v.id, fname)
      })

      // manifest.json — the machine-readable index for automation (e.g. the
      // comfyui-prompt-enhancer-bridge node pack): per clip, its prompt file,
      // duration, and its reference images IN THE EXACT ORDER their "Image N"
      // labels appear inside that clip's prompt text (clipRefsFor(i) is the
      // same shotRefs() call buildH3ShotMessage used to generate that text,
      // against the same refImages array, so the order matches by construction).
      const manifest = {
        title: script?.title || 'Untitled',
        target: promptTarget,
        aspectRatio: aspectToken(aspectRatio),
        clips: done.map((p, i) => {
          const shot = shots[i]
          // Keep refs/file lookups paired by index (not two independently
          // filtered arrays) so a reference with a caption but no saved file
          // (shouldn't happen, but don't let it silently shift every
          // subsequent "Image N" mapping if it ever does) drops cleanly
          // instead of desyncing the rest of the list.
          // Same clip, same resolution the prompt text was built from, so the
          // manifest never disagrees with what the prompt actually asked for.
          const vScene = script?.scenes?.find(s => String(s.id) === String(shot?.scene_id))
          const vv = (isH3now && shot) ? voicesForShot(shot, vScene, shotDialogues(shot, vScene)) : []
          const voices = vv
            .map(v => voiceFileById.get(v.id) ? { file: voiceFileById.get(v.id), speaker: v.speaker || '' } : null)
            .filter(Boolean)
          // Timeline anchors (Add Guide): additive `anchor` field on the
          // matching references[] entry — that array's order/meaning (Image
          // N numbering, matches the prompt text by construction) is
          // otherwise untouched. `guides` is a SEPARATE, chronologically
          // sorted view for the comfyui-prompt-enhancer-bridge's
          // PEClipGuideImage nodes, which need "1st guide in time, 2nd guide
          // in time, …", not "1st Image N, 2nd Image N, …".
          const references = (isH3now ? clipRefsFor(i) : [])
            .map(im => {
              const file = refFileByKey.get(refKey(im))
              if (!file) return null
              const atSeconds = shot ? shotAnchors(shot).find(a => a.refKey === refKey(im))?.atSeconds : undefined
              const anchor = atSeconds != null ? { atSeconds, frameIdx: Math.round(atSeconds * 24) } : null
              return { file, role: im.role || '', preserve: im.preserve || '', ...(anchor ? { anchor } : {}) }
            })
            .filter(Boolean)
          const guides = references
            .filter(r => r.anchor)
            .map(r => ({ file: r.file, atSeconds: r.anchor.atSeconds, frameIdx: r.anchor.frameIdx }))
            .sort((a, b) => a.atSeconds - b.atSeconds)
          return {
            clipNumber: p.shotNumber || i + 1,
            sceneTitle: p.sceneTitle || '',
            // promptFile points at the human-readable .txt (header + text);
            // promptText is the raw generated text alone (no header) so a
            // consumer never has to parse clipHeader()'s prose back out.
            promptFile: `prompts/clip-${pad(p.shotNumber || i + 1)}.txt`,
            promptText: p.text || '',
            mode: references.length ? 'Ref2VA' : 'T2VA',
            durationSec: shot?.duration || (isH3now ? 7 : 4),
            voices,
            outputName: `clip-${pad(p.shotNumber || i + 1)}`,
            references,
            guides,
          }
        }),
      }
      zip.file('manifest.json', JSON.stringify(manifest, null, 2))

      // LTX attached frame images
      ;(framePrompts || []).forEach((fp, si) => FRAME_KEYS.forEach(k => {
        const img = fp?.frames?.[k]?.image
        if (img?.b64) zip.file(`frames/shot-${pad((shots[si]?.shot_number) || si + 1)}-${k}.${imgExt(img.mediaType)}`, img.b64, { base64: true })
      }))

      // machine-readable + a human README
      zip.file('script.json', JSON.stringify(script, null, 2))
      if (directorsCut) zip.file('directors-cut.json', JSON.stringify(directorsCut, null, 2))
      zip.file('README.md', [
        `# ${script?.title || 'Untitled'}`,
        script?.logline ? `\n_${script.logline}_\n` : '',
        `- Output: ${isH3now ? 'MiniMax H3' : 'LTX-2.3'} · ${aspectToken(aspectRatio)}`,
        script?.look ? `- Look: ${script.look}` : '',
        script?.language ? `- Language: ${script.language}` : '',
        script?.soundscape ? `- Soundscape: ${script.soundscape}` : '',
        script?.music ? `- Music: ${script.music}` : '',
        `- ${done.length} clip${done.length === 1 ? '' : 's'}, ${(refImages || []).filter(im => im.base64).length} reference image${(refImages || []).filter(im => im.base64).length === 1 ? '' : 's'}`,
        (voiceRefs || []).filter(v => v.base64).length
          ? `- ${(voiceRefs || []).filter(v => v.base64).length} voice reference${(voiceRefs || []).filter(v => v.base64).length === 1 ? '' : 's'} in \`voices/\` — timbre only; each clip's header names the one to load`
          : '',
        `\n## Cast\n${(script?.characters || []).map(c => `- **${c.name}** — ${c.appearance || ''}${c.wardrobe ? ` · wardrobe: ${c.wardrobe}` : ''}`).join('\n')}`,
        `\n## Locations\n${(script?.locations || []).map(l => `- **${l.name}** — ${l.description || ''}`).join('\n')}`,
      ].filter(Boolean).join('\n'))

      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      // <Title>-video-<model>-<date> — scriptwriter output is always video
      // (minimax_h3 / ltx are both TARGETS[...].type === 'video'), even though
      // the same zip may also carry per-frame image prompts as a bonus.
      const modelSlug = isH3now ? 'minimax' : 'ltx'
      a.download = `${fileSafe(script?.title || 'scriptwriter')}-video-${modelSlug}-${new Date().toISOString().slice(0, 10)}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }
  const copyOne = (idx) => {
    navigator.clipboard.writeText(finalPrompts[idx].text)
    setCopied(idx)
    setTimeout(() => setCopied(null), 2000)
  }
  const editPrompt = (idx, val) => setFinalPrompts(prev => prev.map((p, i) => i === idx ? { ...p, text: val } : p))

  // Portrait / establishing-still generator embedded in a cast or location card.
  const renderPortrait = (key) => {
    const ref = refForEntity(key)
    const d = portraitDraft[key]
    const found = entityByKey(key)
    const isChar = found?.kind === 'character'
    const ck = `portrait:${key}`
    const cs = comfyFrame.key === ck ? comfyFrame.state : 'idle'
    return (
      <div style={{ marginTop: 8, borderTop: '1px solid var(--pe-line-soft)', paddingTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ ...lbl, margin: 0 }}>{isChar ? 'Identity reference' : 'Location reference'}</span>
          {ref?.previewUrl && (
            <img src={ref.previewUrl} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--pe-line)' }} />
          )}
          <span style={{ fontSize: 12.5, color: ref ? (ref.caption?.trim() ? 'var(--pe-ok)' : 'var(--pe-danger)') : 'var(--pe-ink-3)' }}>
            {ref ? (ref.generated ? '✓ generated' : '✓ uploaded') + (ref.caption?.trim() ? ' · described' : ' · ⚠ not described') : 'none — Upload a photo or Generate one'}
          </span>
          {ref && !ref.caption?.trim() && (
            <button onClick={() => describeEntityRef(key)} disabled={captioning}
              style={{ ...ghostBtn, color: 'var(--pe-accent-ink)', borderColor: 'var(--pe-accent-line)' }}>
              {captioning ? 'Describing…' : '👁 Describe'}
            </button>
          )}
          <label style={{ ...ghostBtn, display: 'inline-block' }}>
            {ref ? 'Replace' : 'Upload'}
            <input type="file" accept="image/*" hidden onChange={e => { uploadPortrait(key, e.target.files); e.target.value = '' }} />
          </label>
          {ref && <button onClick={() => removeEntityRef(key)} style={ghostBtn}>Remove</button>}
          {!d && <button onClick={() => startPortrait(key)} style={{ ...ghostBtn, color: 'var(--pe-accent-ink)', borderColor: 'var(--pe-accent-line)' }}>
            {ref ? 'Regenerate' : 'Generate ' + (isChar ? 'portrait' : 'still')}
          </button>}
        </div>
        {d && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {FRAME_TARGETS.map(t => (
                <button key={t.id} onClick={() => patchPortrait(key, { target: t.id })} style={btn((d.target || PORTRAIT_DEFAULT_TARGET) === t.id)}>{t.label}</button>
              ))}
              <button onClick={() => generatePortraitPrompt(key)} disabled={d.loading}
                style={{ ...ghostBtn, color: 'var(--pe-accent-ink)', borderColor: 'var(--pe-accent-line)', background: 'var(--pe-accent-bg)' }}>
                {d.loading ? 'Writing…' : d.text ? 'Rewrite prompt' : 'Write prompt'}
              </button>
              <button onClick={() => setPortraitDraft(prev => { const n = { ...prev }; delete n[key]; return n })} style={ghostBtn}>Close</button>
            </div>
            {d.error && <div style={{ fontSize: 12.5, color: 'var(--pe-danger)', marginBottom: 4 }}>{d.error}</div>}
            {d.text && (
              <>
                <textarea value={d.text} onChange={e => patchPortrait(key, { text: e.target.value })} spellCheck={false}
                  rows={Math.max(3, Math.ceil(d.text.length / 80))}
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '8px 10px', fontSize: 13, lineHeight: 1.6, color: 'var(--pe-accent-ink)', fontFamily: 'var(--pe-mono)', resize: 'vertical', outline: 'none' }} />
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  <button onClick={() => sendPortraitToComfy(key)} disabled={comfyFrame.state === 'sending'} style={ghostBtn}>
                    {cs === 'sending' ? 'Sending…' : cs === 'done' ? '✓ Sent' : cs === 'error' ? '✕ Failed' : '→ ComfyUI'}
                  </button>
                  <button onClick={() => openPickerKey(ck)} style={{ ...ghostBtn, ...(picker.key === ck ? { color: 'var(--pe-accent-ink)', borderColor: 'var(--pe-accent-line)' } : {}) }}>
                    ＋ Attach render
                  </button>
                </div>
              </>
            )}
            {attach.key === ck && attach.state === 'fetching' && <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', marginTop: 6 }}>Fetching image…</div>}
            {attach.key === ck && attach.state === 'error' && <div style={{ fontSize: 12.5, color: 'var(--pe-danger)', marginTop: 6 }}>{attach.error}</div>}
            {picker.key === ck && (
              <div style={{ marginTop: 8, padding: 10, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--pe-ink-3)' }}>
                    {picker.loading ? 'Loading recent ComfyUI outputs…' : `${picker.items.length} recent output${picker.items.length === 1 ? '' : 's'} · newest first`}
                  </span>
                  <button onClick={() => loadPickerItems(ck)} disabled={picker.loading} style={ghostBtn}>Refresh</button>
                  <button onClick={() => setPicker({ key: null, loading: false, error: '', items: [] })} style={{ ...ghostBtn, marginLeft: 'auto' }}>Close</button>
                </div>
                {picker.error && <div style={{ fontSize: 12.5, color: 'var(--pe-danger)', marginBottom: 6 }}>{picker.error}</div>}
                {picker.items.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
                    {picker.items.map((it, ii) => (
                      <img key={ii} src={it.viewUrl} loading="lazy" alt={it.filename}
                        onClick={() => attachPortraitImage(key, it)}
                        style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6, border: '1px solid var(--pe-line)', cursor: 'pointer', background: 'var(--pe-surface)' }} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const stepIdx = ['input', 'scripting', 'script', 'directing'].includes(phase) ? 0
    : phase === 'dircut' ? 1
    : 2
  const STEP_PHASE = ['script', 'dircut', 'done']

  const isLoading = ['scripting', 'directing', 'prompting'].includes(phase) || !!reviewPhase1 || !!reviewPhase2
  const isH3 = promptTarget === 'minimax_h3'
  const H3_DURATIONS = [4, 5, 6, 7, 8, 10, 12, 15]
  const LTX_DURATIONS = [4, 8, 12, 16, 20]
  const characterNames = (ids) => (script?.characters || []).filter(c => (ids || []).includes(c.id)).map(c => c.name).join(', ')

  const focusBorder = (e) => { e.target.style.borderColor = 'var(--pe-accent)' }
  const blurBorder  = (e) => { e.target.style.borderColor = 'var(--pe-line)' }
  const navBtn = { padding: '8px 16px', borderRadius: 8, border: '1px solid var(--pe-line)', background: 'none', color: 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer' }

  // Admin mode (the header's "⚙ Admin" switch, App.jsx): renders right under
  // the button that would otherwise have sent straight to the AI, not up at
  // the top of the screen — the point is to review the message you're about
  // to send without losing your place in the workflow.
  const renderAdminReview = (label, review, setReview, send) => review && (
    <div style={{ marginTop: 10, padding: '14px 16px', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-accent-ink)', marginBottom: 10 }}>
        ⚙ Admin — review before {label} sends
      </div>
      <label style={{ ...lbl, marginBottom: 4 }}>System prompt</label>
      <textarea value={review.system} onChange={e => setReview(r => ({ ...r, system: e.target.value }))}
        rows={8} spellCheck={false}
        style={{ ...field({ resize: 'vertical', fontFamily: 'var(--pe-mono)', fontSize: 12.5, marginBottom: 10, width: '100%' }) }} />
      <label style={{ ...lbl, marginBottom: 4 }}>User message</label>
      <textarea value={review.user} onChange={e => setReview(r => ({ ...r, user: e.target.value }))}
        rows={10} spellCheck={false}
        style={{ ...field({ resize: 'vertical', fontFamily: 'var(--pe-mono)', fontSize: 12.5, marginBottom: 10, width: '100%' }) }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => { const r = review; setReview(null); send(r) }}
          style={{ ...ghostBtn, color: 'var(--pe-accent-ink)', borderColor: 'var(--pe-accent-line)' }}>✦ Send to AI</button>
        <button onClick={() => setReview(null)} style={ghostBtn}>Cancel</button>
      </div>
    </div>
  )

  return (
    <>
    {/* Left half of the center column: the input workspace — reference images,
        voice refs, and the Phase-1 idea/genre form. Stays in place across
        phases (refs/voice are editable through 'done' — only 'prompting'
        itself, Phase 3's batch of writer calls in flight, locks them) the
        same way an image panel stays put on every other target while its
        result appears in the third column. */}
    <div style={{ gridColumn: '2', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {/* Reuse an image from a past generation as a reference (same block as the
          other targets; picking adds it to the reference images below). Stays
          available in phase 'done' too — see "Per-clip reference pinning": a
          reference can be added/attached to a clip even after Phase 3 has run. */}
      {phase !== 'prompting' && (
        <HistoryImageGallery
          history={history}
          onPick={addRefFromHistory}
          pickHint="adds it as a reference image (link it to a character, wardrobe, location, style or prop below)"
          library={library} onAddLibraryImages={onAddLibraryImages} onRemoveLibraryImage={onRemoveLibraryImage}
          onSaveLibraryCaption={onSaveLibraryCaption} onSetLibraryRole={onSetLibraryRole}
          onDescribeLibraryImage={onDescribeLibraryImage}
        />
      )}

      {/* Reference images — editable through 'done' (so a reference can still be
          added/attached to a finished clip); locked only while Phase 3 is
          actively running (a batch of parallel writer calls already in flight). */}
      <ScriptwriterRefImages
        images={refImages}
        editable={phase !== 'prompting'}
        status={refCaptionStatus}
        busy={isLoading || captioning}
        max={MAX_REF_IMAGES}
        onAddFiles={addRefFiles}
        onRemove={removeRefImage}
        onNote={updateRefNote}
        onCaption={updateRefCaption}
        onDescribe={(force) => captionRefImages({ force }).catch(() => {})}
        linkTypes={REF_LINK_TYPES}
        characters={script?.characters || []}
        locations={script?.locations || []}
        roles={MINIMAX_H3_REF_ROLES}
        preserves={MINIMAX_H3_PRESERVE_OPTIONS}
        onLinkType={setRefLinkType}
        onField={updateRefField}
        panelRef={refImagesPanelRef}
        h3={isH3}
      />

      <ScriptwriterVoiceRefs
        voices={voiceRefs}
        editable={phase !== 'prompting'}
        busy={isLoading || captioning}
        max={MAX_VOICE_REFS}
        characters={script?.characters || []}
        onAdd={addVoiceRef}
        onRemove={removeVoiceRef}
        onCharacter={setVoiceCharacter}
      />

      {/* Phase 1 — input */}
      {['input', 'scripting'].includes(phase) && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button onClick={() => setAutoMode(false)} disabled={isLoading} style={btn(!autoMode)}>Guided</button>
            <button onClick={() => setAutoMode(true)} disabled={isLoading} style={btn(autoMode)}>Full Auto</button>
          </div>

          {!autoMode ? (
            <>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Story Idea</label>
                <textarea value={idea} onChange={e => setIdea(e.target.value)} rows={sourceMode ? 10 : 4} disabled={isLoading}
                  placeholder={sourceMode
                    ? 'Paste the full source text here — a letter, a diary entry, a short piece of prose. The film will dramatize it scene by scene, in order.'
                    : 'e.g. A retired deep-sea diver finds a mysterious package washed ashore — and recognizes the handwriting on it as her own.'}
                  style={{ ...field({ resize: 'vertical' }) }}
                  onFocus={focusBorder} onBlur={blurBorder} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12.5, color: 'var(--pe-ink-3)', cursor: isLoading ? 'default' : 'pointer' }}>
                  <input type="checkbox" checked={sourceMode} disabled={isLoading}
                    onChange={e => { const v = e.target.checked; setSourceMode(v); if (!v) setSceneCount(c => Math.min(c, 5)) }} />
                  This is a finished text (letter, diary, story) — dramatize its actual content rather than inventing
                </label>
              </div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 8 }}>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Genre</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'stretch' }}>
                    {GENRE_OPTIONS.map(g => (
                      <button key={g.id} type="button" onClick={() => setGenre(g.id)} disabled={isLoading} style={btn(genre === g.id)}>{g.label}</button>
                    ))}
                    <span aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', background: 'var(--pe-line)', margin: '0 4px' }} />
                    <button type="button" onClick={() => setMature(v => !v)} disabled={isLoading} title={NSFW_HINT} style={btn(mature)}>NSFW</button>
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Language <span style={{ textTransform: 'none', letterSpacing: 0 }}>(spoken)</span></label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {SPOKEN_LANGUAGES.map(l => (
                      <button key={l.id} type="button" onClick={() => setSpokenLangId(l.id)} disabled={isLoading} title={l.label} style={btn(spokenLangId === l.id)}>{l.short}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Scenes (max)</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => setSceneCount(v => Math.max(1, v - 1))} disabled={isLoading || sceneCount <= 1}
                      style={{ ...btn(false), padding: '4px 12px', fontSize: 15 }}>−</button>
                    <span style={{ fontSize: 15, color: 'var(--pe-accent-ink)', fontWeight: 600, minWidth: 18, textAlign: 'center' }}>{sceneCount}</span>
                    <button onClick={() => setSceneCount(v => Math.min(sceneCap, v + 1))} disabled={isLoading || sceneCount >= sceneCap}
                      style={{ ...btn(false), padding: '4px 12px', fontSize: 15 }}>+</button>
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Aspect Ratio</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {MINIMAX_H3_RESOLUTIONS.map(r => (
                      <button key={r.id} onClick={() => !isLoading && setAspectRatio(r.id)} title={r.note} disabled={isLoading}
                        style={btn(aspectRatio === r.id)}>{aspectParts(r).token}</button>
                    ))}
                  </div>
                </div>
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', margin: '0 0 20px', lineHeight: 1.5, maxWidth: 560 }}>
                {sourceMode ? (
                  <>This dramatizes your source text scene by scene, in the order it's written — nothing is invented that the text doesn't say or clearly imply, though the visuals, blocking and performance are built out for camera.
                  "Scenes (max)" is a ceiling: raise it enough to cover the whole text; scenes still only split on a genuine break (a new passage, a time jump, a location change), not just to fill the count.</>
                ) : (
                  <>This writes a <strong>very short film</strong> (~45 s–3 min): one premise, one turn, one ending — it opens already inside the moment, not before it.
                  1–2 scenes in a single location is the tightest form; more scenes mean more time and usually a second location.
                  "Scenes (max)" is a ceiling, not a target — a single continuous moment becomes one scene even if you raise it.</>
                )}
              </p>
              <LoraPanel
                loras={loras} activeIds={activeLoraIds} kinds={['style']} editable={!isLoading}
                onToggle={toggleLora} onSaveLoras={onSaveLoras}
                hint={'(style LoRAs for the whole film — a character LoRA is bound to a cast member in the Cast list instead)'} />
              <button onClick={runPhase1} disabled={!idea.trim() || isLoading || captioning} style={genBtn(!idea.trim() || isLoading || captioning)}>
                {captioning ? '👁 Reading reference images…' : phase === 'scripting' ? '✦ Writing script…' : '✦ Write Script'}
              </button>
              {renderAdminReview('Phase 1 (Script)', reviewPhase1, setReviewPhase1, (r) => sendPhase1(r.system, r.user, r.refs))}
            </>
          ) : (
            <div>
              <p style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', margin: '0 0 14px', lineHeight: 1.5, maxWidth: 560 }}>
                Full Auto writes the entire film — premise, cast, director's cut, and video prompts — on its own from
                your reference images. Add at least one image above, pick a genre, then queue it; queued films run
                one after another with no review clicks in between.
              </p>
              <div style={{ marginBottom: 14, maxWidth: 420 }}>
                <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Story hint (optional)</label>
                <input type="text" value={autoHint} onChange={e => setAutoHint(e.target.value)} disabled={isLoading}
                  placeholder="e.g. a betrayal between old friends — leave empty to let the AI invent freely"
                  style={field({})} onFocus={focusBorder} onBlur={blurBorder} />
              </div>
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Genre</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'stretch' }}>
                  {GENRE_OPTIONS.map(g => (
                    <button key={g.id} type="button" onClick={() => setGenre(g.id)} disabled={isLoading} style={btn(genre === g.id)}>{g.label}</button>
                  ))}
                  <span aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', background: 'var(--pe-line)', margin: '0 4px' }} />
                  <button type="button" onClick={() => setMature(v => !v)} disabled={isLoading} title={NSFW_HINT} style={btn(mature)}>NSFW</button>
                </div>
              </div>
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Language <span style={{ textTransform: 'none', letterSpacing: 0 }}>(what the cast speaks)</span></label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {SPOKEN_LANGUAGES.map(l => (
                    <button key={l.id} type="button" onClick={() => setSpokenLangId(l.id)} disabled={isLoading} title={l.label} style={btn(spokenLangId === l.id)}>{l.short}</button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pacing <span style={{ textTransform: 'none', letterSpacing: 0 }}>(how many clips per scene)</span></label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {PACING_OPTIONS.map(p => (
                    <button key={p.id} onClick={() => setAutoPacing(p.id)} disabled={isLoading} style={btn(autoPacing === p.id)}>{p.label}</button>
                  ))}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', marginTop: 6 }}>
                  Tight = fewest clips that still respect H3's two-beat limit, plus an automatic merge pass for
                  same-scene locomotion clips. Loose = more reaction &amp; insert clips.
                </div>
              </div>
              <LoraPanel
                loras={loras} activeIds={activeLoraIds} kinds={['style']} editable={!isLoading}
                onToggle={toggleLora} onSaveLoras={onSaveLoras}
                hint={'(style LoRAs for the whole film — a character LoRA is bound to a cast member in the Cast list instead)'} />
              <button
                onClick={() => onQueueAutoJob?.({ refImages: serializeRefImages(refImages), voiceRefs: serializeVoiceRefs(voiceRefs), genre, mature, hint: autoHint.trim(), pacing: autoPacing, spokenLang: spokenLangId, loraIds: activeLoraIds })}
                disabled={refImages.length === 0 || isLoading || captioning}
                style={genBtn(refImages.length === 0 || isLoading || captioning)}>
                + Add to Queue (Full Auto)
              </button>
              {queueProps && (
                <div style={{ marginTop: 8 }}>
                  <QueuePanel
                    {...queueProps}
                    queue={(queueProps.queue || []).filter(q => q.kind === 'scriptwriter-auto')}
                    open={autoQueueOpen}
                    onToggleOpen={() => setAutoQueueOpen(v => !v)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>

    {/* Right half: the results column — stepper + error, then whichever
        phase's review screen is current (script bible, director's cut,
        final prompts). Mirrors every other target's layout: the workspace
        stays in the compose column, the output goes in the third column. */}
    <div style={{ gridColumn: '3', display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
      {/* Phase stepper — dots for finished steps are clickable (jump back or
          forward without re-running the AI) */}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {STEPS.map((step, i) => {
          const target = STEP_PHASE[i]
          const canJump = phase !== target && !navBusy() && stepReachable(target)
          return (
          <div key={step} style={{ display: 'flex', alignItems: 'center' }}>
            <div
              onClick={canJump ? () => navigateTo(target) : undefined}
              title={canJump ? `Go to ${step}` : undefined}
              style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: canJump ? 'pointer' : 'default' }}>
              <div style={{
                width: 22, height: 22, borderRadius: '50%', border: '2px solid',
                borderColor: i <= stepIdx ? 'var(--pe-accent)' : canJump ? 'var(--pe-accent-line)' : 'var(--pe-line)',
                background: i < stepIdx ? 'var(--pe-accent)' : i === stepIdx ? 'var(--pe-accent-bg)' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13.5, color: i <= stepIdx ? 'var(--pe-accent-ink)' : canJump ? 'var(--pe-accent-ink)' : 'var(--pe-line)', fontWeight: 700, flexShrink: 0,
              }}>
                {i < stepIdx ? '✓' : i + 1}
              </div>
              <span style={{ fontSize: 13, color: i <= stepIdx ? 'var(--pe-accent-ink)' : canJump ? 'var(--pe-accent-ink)' : 'var(--pe-line)', fontWeight: i === stepIdx ? 600 : 400, textDecoration: canJump ? 'underline' : 'none', textUnderlineOffset: 3 }}>
                {step}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ width: 32, height: 1, background: i < stepIdx ? 'var(--pe-accent)' : 'var(--pe-line)', margin: '0 8px' }} />
            )}
          </div>
          )
        })}
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '12px 14px', background: 'var(--pe-danger-bg)', border: '1px solid var(--pe-danger-line)', borderRadius: 8, fontSize: 13, color: 'var(--pe-danger)' }}>
          {error}
          {rawFallback && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', marginBottom: 6 }}>Raw LLM output:</div>
              <textarea readOnly value={rawFallback} rows={6}
                style={{ ...field({ background: 'var(--pe-danger-bg)', color: 'var(--pe-danger)', fontSize: 13, fontFamily: 'monospace', resize: 'vertical' }) }} />
            </div>
          )}
        </div>
      )}

      {/* Phase 2 — script review + cast/location bible */}
      {['script', 'directing'].includes(phase) && script && (
        <div>
          {script.format_note && script.format_note.trim() && (
            <div style={{
              marginBottom: 16, padding: '11px 14px', display: 'flex', gap: 10, alignItems: 'flex-start',
              background: 'var(--pe-warn-bg)', border: '1px solid var(--pe-warn-line)',
              borderRadius: 8, fontSize: 12.5, lineHeight: 1.55, color: 'var(--pe-warn)',
            }}>
              <span style={{ flexShrink: 0 }}>⚠</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>The idea is bigger than a very short film.</strong> {script.format_note.trim()}
                {' '}This script is a narrowed-down slice of it — if you meant the whole story, it needs a longer format.
              </div>
              <button onClick={dismissFormatNote} title="Dismiss"
                style={{ flexShrink: 0, background: 'none', border: 'none', color: 'inherit', fontSize: 14, cursor: 'pointer', padding: 0, lineHeight: 1 }}>
                ✕
              </button>
            </div>
          )}
          {/* The idea/hint that produced this script — otherwise invisible once the
              input screen (phase 'input'/'scripting') is behind you. Restoring a
              past entry, or just moving forward in the same session, both hide that
              screen; this is the one place to check what was actually submitted. */}
          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Story Idea <span style={{ textTransform: 'none', letterSpacing: 0 }}>(as submitted)</span></label>
            <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', lineHeight: 1.5, whiteSpace: 'pre-wrap', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 12px' }}>
              {(autoJob || initialState?.fullAuto)
                ? ((autoJob?.hint ?? initialState?.fullAutoHint)?.trim() || '(Full Auto — AI invented freely, no hint given)')
                : (idea.trim() || '—')}
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Film Title</label>
            <input value={script.title || ''} onChange={e => updateFilmField('title', e.target.value)}
              style={{ ...field({ fontSize: 15, fontWeight: 600, color: 'var(--pe-ink)' }) }}
              onFocus={focusBorder} onBlur={blurBorder} />
          </div>
          {'logline' in script && (
            <div style={{ marginBottom: 10 }}>
              <label style={lbl}>Logline</label>
              <input value={script.logline || ''} onChange={e => updateFilmField('logline', e.target.value)}
                style={field()} onFocus={focusBorder} onBlur={blurBorder} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <div style={{ flex: '1 1 320px' }}>
              <label style={lbl}>Look <span style={{ ...lbl, textTransform: 'none', letterSpacing: 0, display: 'inline' }}>(applied to every shot)</span></label>
              <textarea value={script.look || ''} onChange={e => updateFilmField('look', e.target.value)} rows={2}
                style={{ ...field({ resize: 'vertical' }) }} onFocus={focusBorder} onBlur={blurBorder} />
            </div>
            <div style={{ width: 160 }}>
              <label style={lbl}>Language <span style={{ textTransform: 'none', letterSpacing: 0 }}>(spoken)</span></label>
              <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                {SPOKEN_LANGUAGES.map(l => (
                  <button key={l.id} type="button" title={l.label}
                    onClick={() => { setSpokenLangId(l.id); updateFilmField('language', l.label) }}
                    style={{ ...btn((script.language || '').trim().toLowerCase() === l.label.toLowerCase()), padding: '4px 10px' }}>{l.short}</button>
                ))}
              </div>
              {/* Free text stays the authority — type any language the three
                  buttons don't cover and none of them highlights. */}
              <input value={script.language || ''} onChange={e => updateFilmField('language', e.target.value)}
                style={field()} onFocus={focusBorder} onBlur={blurBorder} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <div style={{ flex: '1 1 260px' }}>
              <label style={lbl}>Soundscape <span style={{ textTransform: 'none', letterSpacing: 0 }}>(ambient / diegetic — every clip)</span></label>
              <input value={script.soundscape || ''} onChange={e => updateFilmField('soundscape', e.target.value)}
                placeholder="e.g. faint cassette hiss, burning incense, wooden floorboards"
                style={field()} onFocus={focusBorder} onBlur={blurBorder} />
            </div>
            <div style={{ flex: '1 1 260px' }}>
              <label style={lbl}>Music <span style={{ textTransform: 'none', letterSpacing: 0 }}>(score approach, or “none”)</span></label>
              <input value={script.music || ''} onChange={e => updateFilmField('music', e.target.value)}
                placeholder="e.g. 1980s dark-wave synth, reverb guitar, slow swell"
                style={field()} onFocus={focusBorder} onBlur={blurBorder} />
            </div>
          </div>

          {/* Output model — chosen here so the Director specialises for it */}
          <div style={{ ...card, marginBottom: 16 }}>
            <label style={lbl}>Output Model</label>
            {phase === 'script' ? (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {PROMPT_TARGETS.map(pt => (
                  <button key={pt.id} onClick={() => setPromptTarget(pt.id)} style={btn(promptTarget === pt.id)}>{pt.label}</button>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13.5, color: 'var(--pe-accent-ink)', fontWeight: 600 }}>{PROMPT_TARGET_LABEL[promptTarget] || promptTarget}</div>
            )}
            <div style={{ marginTop: 12 }}>
              <label style={lbl}>Aspect Ratio</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {MINIMAX_H3_RESOLUTIONS.map(r => {
                  const editable = phase === 'input' || phase === 'script'
                  return (
                    <button key={r.id} onClick={() => editable && setAspectRatio(r.id)} title={r.note}
                      disabled={!editable} style={btn(aspectRatio === r.id)}>{aspectParts(r).token}</button>
                  )
                })}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', marginTop: 8 }}>
                Steers scene scale, the Director's framing, and the clip prompts. 16:9 for cinema / landscape,
                9:16 for short-form &amp; social.
              </div>
              {promptTarget === 'minimax_h3' && (
                <div style={{ marginTop: 12 }}>
                  <label style={lbl}>Pacing <span style={{ textTransform: 'none', letterSpacing: 0 }}>(how many clips per scene)</span></label>
                  {phase === 'script' ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {PACING_OPTIONS.map(p => (
                        <button key={p.id} onClick={() => setPacing(p.id)} style={btn(pacing === p.id)}>{p.label}</button>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 13.5, color: 'var(--pe-accent-ink)', fontWeight: 600 }}>{PACING_OPTIONS.find(p => p.id === pacing)?.label || 'Standard'}</div>
                  )}
                  <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', marginTop: 6 }}>
                    Tight = fewest clips that still respect H3's two-beat limit. Loose = more reaction &amp; insert clips.
                    You can still insert or remove clips on the next screen.
                  </div>
                </div>
              )}
            </div>
          </div>

          <LoraPanel
            loras={loras} activeIds={activeLoraIds} kinds={['style']} editable={!isLoading}
            onToggle={toggleLora} onSaveLoras={onSaveLoras}
            hint={'(style LoRAs for every clip — bind a character LoRA to its character below)'} />

          {/* Cast bible */}
          {Array.isArray(script.characters) && (
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Cast</label>
              {script.characters.map((c, ci) => (
                <div key={c.id || ci} style={card}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <input value={c.name} onChange={e => updateCharacter(ci, 'name', e.target.value)}
                      style={{ ...field({ flex: 1, fontWeight: 600 }) }} onFocus={focusBorder} onBlur={blurBorder} />
                    <input value={c.role_in_story || ''} onChange={e => updateCharacter(ci, 'role_in_story', e.target.value)}
                      style={{ ...field({ width: 130, fontSize: 12.5 }) }} onFocus={focusBorder} onBlur={blurBorder} />
                    <button onClick={() => removeCharacter(ci)} style={{ ...ghostBtn, color: 'var(--pe-danger)', borderColor: 'var(--pe-danger-line)' }}>✕</button>
                  </div>
                  <label style={lbl}>Appearance</label>
                  <textarea value={c.appearance || ''} onChange={e => updateCharacter(ci, 'appearance', e.target.value)} rows={2}
                    style={{ ...field({ resize: 'vertical', marginBottom: 6 }) }} onFocus={focusBorder} onBlur={blurBorder} />
                  <label style={lbl}>Wardrobe</label>
                  <input value={c.wardrobe || ''} onChange={e => updateCharacter(ci, 'wardrobe', e.target.value)}
                    style={{ ...field({ marginBottom: 6 }) }} onFocus={focusBorder} onBlur={blurBorder} />
                  <label style={lbl}>Voice</label>
                  <input value={c.voice || ''} onChange={e => updateCharacter(ci, 'voice', e.target.value)}
                    style={field()} onFocus={focusBorder} onBlur={blurBorder} />
                  {(loras || []).some(l => l.kind === 'character' && l.trigger.trim()) && (
                    <>
                      <label style={{ ...lbl, marginTop: 6 }}>Character LoRA <span style={{ textTransform: 'none', letterSpacing: 0 }}>(its trigger rides only the clips this character is in)</span></label>
                      <select value={c.lora || ''} onChange={e => updateCharacter(ci, 'lora', e.target.value)} style={field()}>
                        <option value="">— none —</option>
                        {(loras || []).filter(l => l.kind === 'character' && l.trigger.trim()).map(l => (
                          <option key={l.id} value={l.id}>{l.name.trim() || l.trigger.trim()}</option>
                        ))}
                      </select>
                    </>
                  )}
                  {renderPortrait(c.id)}
                </div>
              ))}
              <button onClick={addCharacter} style={{ fontSize: 13, color: 'var(--pe-accent)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '3px 10px', cursor: 'pointer' }}>+ Add character</button>
            </div>
          )}

          {/* Location bible */}
          {Array.isArray(script.locations) && (
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Locations</label>
              {script.locations.map((l, li) => (
                <div key={l.id || li} style={card}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <input value={l.name} onChange={e => updateLocation(li, 'name', e.target.value)}
                      style={{ ...field({ flex: 1, fontWeight: 600 }) }} onFocus={focusBorder} onBlur={blurBorder} />
                    <button onClick={() => removeLocation(li)} style={{ ...ghostBtn, color: 'var(--pe-danger)', borderColor: 'var(--pe-danger-line)' }}>✕</button>
                  </div>
                  <textarea value={l.description || ''} onChange={e => updateLocation(li, 'description', e.target.value)} rows={2}
                    style={{ ...field({ resize: 'vertical' }) }} onFocus={focusBorder} onBlur={blurBorder} />
                  {renderPortrait(l.id)}
                </div>
              ))}
              <button onClick={addLocation} style={{ fontSize: 13, color: 'var(--pe-accent)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '3px 10px', cursor: 'pointer' }}>+ Add location</button>
            </div>
          )}

          <label style={lbl}>Scenes</label>
          {script.scenes.map((scene, si) => (
            <div key={si} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 13.5, color: 'var(--pe-accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', flexShrink: 0 }}>
                  Scene {scene.id}
                </span>
                <input value={scene.title} onChange={e => updateScene(si, 'title', e.target.value)}
                  style={{ ...field({ flex: 1, fontWeight: 600 }) }}
                  onFocus={focusBorder} onBlur={blurBorder} />
                {phase === 'script' && (
                  <button onClick={() => regenerateScene(si)} disabled={sceneBusy !== null}
                    title="Have the AI write a fresh version of this scene"
                    style={{ ...ghostBtn, flexShrink: 0, color: 'var(--pe-accent-ink)', borderColor: 'var(--pe-accent-line)',
                      background: 'var(--pe-accent-bg)', cursor: sceneBusy !== null ? 'wait' : 'pointer' }}>
                    {sceneBusy === si ? '✦ Rewriting…' : '✦ Rewrite'}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                <div style={{ flex: '1 1 220px' }}>
                  <label style={lbl}>Setting</label>
                  <input value={scene.setting} onChange={e => updateScene(si, 'setting', e.target.value)}
                    style={{ ...field({ fontFamily: 'monospace', fontSize: 13.5 }) }}
                    onFocus={focusBorder} onBlur={blurBorder} />
                </div>
                {Array.isArray(script.locations) && script.locations.length > 0 && (
                  <div style={{ width: 170 }}>
                    <label style={lbl}>Location</label>
                    <select value={scene.location_id || ''} onChange={e => updateScene(si, 'location_id', e.target.value)}
                      style={{ ...field({ fontSize: 12.5 }) }}>
                      <option value="">—</option>
                      {script.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </div>
                )}
              </div>
              {Array.isArray(script.characters) && script.characters.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <label style={lbl}>Characters present</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {script.characters.map(c => (
                      <button key={c.id} onClick={() => toggleSceneCharacter(si, c.id)}
                        style={btn(Array.isArray(scene.characters) && scene.characters.includes(c.id))}>
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Description</label>
                <textarea value={scene.description} onChange={e => updateScene(si, 'description', e.target.value)} rows={3}
                  style={{ ...field({ resize: 'vertical' }) }}
                  onFocus={focusBorder} onBlur={blurBorder} />
              </div>
              {'emotional_turn' in scene && (
                <div style={{ marginBottom: 10 }}>
                  <label style={lbl}>Emotional turn <span style={{ textTransform: 'none', letterSpacing: 0 }}>(observable change, or leave empty)</span></label>
                  <input value={scene.emotional_turn || ''} onChange={e => updateScene(si, 'emotional_turn', e.target.value || null)}
                    style={field()} onFocus={focusBorder} onBlur={blurBorder} />
                </div>
              )}
              {isH3 && (
                <div style={{ marginBottom: 10 }}>
                  <label style={lbl}>Sound / music for this scene <span style={{ textTransform: 'none', letterSpacing: 0 }}>(optional — overrides the film default)</span></label>
                  <input value={scene.sound_mood || ''} onChange={e => updateScene(si, 'sound_mood', e.target.value || null)}
                    style={field()} onFocus={focusBorder} onBlur={blurBorder} />
                </div>
              )}
              <div>
                <label style={lbl}>Dialogue</label>
                {scene.dialogues.map((line, di) => (
                  <div key={di} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                    <input value={line} onChange={e => updateDialogue(si, di, e.target.value)}
                      style={{ ...field({ flex: 1, fontFamily: 'monospace', fontSize: 13.5 }) }}
                      onFocus={focusBorder} onBlur={blurBorder} />
                    <button onClick={() => removeDialogue(si, di)}
                      style={{ padding: '4px 9px', borderRadius: 5, border: '1px solid var(--pe-line)', background: 'none', color: 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>
                      ✕
                    </button>
                  </div>
                ))}
                <button onClick={() => addDialogue(si)}
                  style={{ fontSize: 13, color: 'var(--pe-accent)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', marginTop: 2 }}>
                  + Add line
                </button>
              </div>
            </div>
          ))}
          <button onClick={runPhase2} disabled={phase === 'directing' || sceneBusy !== null} style={{ ...genBtn(phase === 'directing' || sceneBusy !== null), marginTop: 6 }}>
            {phase === 'directing' ? "✦ Writing director's cut…"
              : sceneBusy !== null ? '✦ Rewriting a scene…'
              : directorsCut ? "↻ Re-run Director's Cut" : "→ Director's Cut"}
          </button>
          {renderAdminReview("Phase 2 (Director's Cut)", reviewPhase2, setReviewPhase2, (r) => sendPhase2(r.system, r.user, r.refs, r.isH3))}
          {directorsCut && phase === 'script' && (
            <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button onClick={() => navigateTo('dircut')} disabled={navBusy()} style={navBtn}>→ Director's Cut (keep current)</button>
              {finalPrompts.length > 0 && (
                <button onClick={() => navigateTo('done')} disabled={navBusy()} style={navBtn}>→ Video Prompts (keep current)</button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Phase 3 — director's cut review */}
      {['dircut', 'prompting', 'done'].includes(phase) && directorsCut && (
        <div>
          {framePrompts.some(fp => fp && FRAME_KEYS.some(k => fp.frames[k].text)) && (
            <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ ...lbl, margin: 0 }}>ComfyUI</span>
              <input value={comfyCfg.url}
                onChange={e => setComfyCfg({ ...comfyCfg, url: e.target.value })}
                placeholder="http://127.0.0.1:8188"
                style={{ ...field({ width: 200, fontSize: 13 }) }}
                onFocus={focusBorder} onBlur={blurBorder} />
              <input value={comfyCfg.slot}
                onChange={e => setComfyCfg({ ...comfyCfg, slot: e.target.value })}
                placeholder="default"
                style={{ ...field({ width: 100, fontSize: 13 }) }}
                onFocus={focusBorder} onBlur={blurBorder} />
              <span style={{ fontSize: 12.5, color: 'var(--pe-ink-3)' }}>
                push slot for → ComfyUI · also the source for ＋ Attach image (needs --enable-cors-header)
              </span>
            </div>
          )}
          {/* Reference status — tells the user whether clips will be Ref2VA or T2VA.
              Two distinct "nothing will help" cases used to share one message
              ("no described references") whether zero images were ever added or
              some were added but never captioned — and pointed at a nonexistent
              "Script screen" (the panel is always on screen, in column 2, just
              possibly scrolled out of view — see refImagesPanelRef above). */}
          {isH3 && (() => {
            const uploaded = (refImages || []).length
            const capt = (refImages || []).filter(im => im.caption && im.caption.trim()).length
            const sceneOf = (s) => script?.scenes?.find(x => String(x.id) === String(s.scene_id))
            const ref2 = directorsCut.shots.filter(s => shotRefs(s, sceneOf(s)).length > 0).length
            const total = directorsCut.shots.length
            const tone = capt === 0 ? 'danger' : ref2 < total ? 'ink-3' : 'ok'
            const msg = uploaded === 0
              ? '⚠ No reference images yet — every clip generates as text-to-video (T2VA), so faces and locations will drift between clips. Add one in Reference Images, above the Story Idea box, for each recurring character/location.'
              : capt === 0
              ? `⚠ ${uploaded} reference image${uploaded === 1 ? '' : 's'} added but not yet described — every clip still generates as text-to-video (T2VA) until at least one is. Click "Describe images" in Reference Images to caption them now, or they'll be described automatically the next time you write/rewrite the script.`
              : ref2 < total
              ? `${ref2} of ${total} clips will generate with references (Ref2VA); the other ${total - ref2} run as T2VA.`
              : `✓ All ${total} clips generate as Ref2VA from ${capt} described reference${capt === 1 ? '' : 's'}.`
            return (
              <div style={{ ...card, fontSize: 12.5, lineHeight: 1.5,
                color: tone === 'danger' ? 'var(--pe-danger)' : tone === 'ok' ? 'var(--pe-ok)' : 'var(--pe-ink-3)',
                background: tone === 'danger' ? 'var(--pe-danger-bg)' : tone === 'ok' ? 'var(--pe-ok-bg)' : 'var(--pe-rail)',
                borderColor: tone === 'danger' ? 'var(--pe-danger-line)' : tone === 'ok' ? 'var(--pe-ok-bg)' : 'var(--pe-line)' }}>
                {msg}
                {capt === 0 && (
                  <button onClick={scrollToRefImages}
                    style={{ display: 'block', marginTop: 6, fontSize: 12, color: 'inherit', background: 'none', border: '1px solid currentColor', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>
                    ↑ Jump to Reference Images
                  </button>
                )}
              </div>
            )
          })()}

          {directorsCut.shots.length > 1 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
              <button onClick={() => setExpandedShots(new Set(directorsCut.shots.map((_, i) => i)))} style={ghostBtn}>Expand all</button>
              <button onClick={() => setExpandedShots(new Set())} style={ghostBtn}>Collapse all</button>
            </div>
          )}
          {directorsCut.shots.map((shot, si) => {
            const expanded = expandedShots.has(si) || shotBusy === si
            return (
            <div key={si}>
              {phase === 'dircut' && insertBar(si)}
              <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: expanded ? 10 : 0, flexWrap: 'wrap' }}>
                <button onClick={() => toggleShotExpanded(si)}
                  title={expanded ? 'Collapse' : 'Expand'}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 auto', minWidth: 0,
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit', font: 'inherit' }}>
                  <span style={{ fontSize: 11, color: 'var(--pe-ink-3)', flexShrink: 0, display: 'inline-block',
                    transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'none' }}>▸</span>
                  <span style={{ fontSize: 13.5, color: 'var(--pe-accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', flexShrink: 0 }}>
                    {isH3 ? 'Clip' : 'Shot'} {shot.shot_number}
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--pe-ink-3)', flexShrink: 0 }}>{shot.scene_title}</span>
                  {isH3 && shot.shot_type && (
                    <span style={{ fontSize: 11.5, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}>{shot.shot_type}</span>
                  )}
                  {isH3 && shotAnchors(shot).length > 0 && (
                    <span title={`${shotAnchors(shot).length} Timeline anchor(s) (Add Guide) pinned on this clip`}
                      style={{ fontSize: 11.5, color: 'var(--pe-ink-3)', border: '1px solid var(--pe-line)', borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}>
                      🕐 {shotAnchors(shot).length}
                    </span>
                  )}
                  {!expanded && (
                    <span style={{ fontSize: 12, color: 'var(--pe-ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                      — {(isH3 ? shot.primary_beat : shot.visual_action) || 'no beat written yet'} · {shot.duration || (isH3 ? 7 : 4)}s
                    </span>
                  )}
                </button>
                {phase === 'dircut' && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => regenerateShot(si)} disabled={shotBusy !== null || promptBusy !== null}
                      title={`Have the AI write a fresh version of this ${isH3 ? 'clip' : 'shot'}`}
                      style={{ ...ghostBtn, color: 'var(--pe-accent-ink)', borderColor: 'var(--pe-accent-line)',
                        background: 'var(--pe-accent-bg)', cursor: (shotBusy !== null || promptBusy !== null) ? 'wait' : 'pointer' }}>
                      {shotBusy === si ? '✦ Rewriting…' : '✦ Rewrite'}
                    </button>
                    {si < directorsCut.shots.length - 1 && (
                      <button onClick={() => mergeShots(si)} disabled={shotBusy !== null || promptBusy !== null}
                        title={`Combine this ${isH3 ? 'clip' : 'shot'} with the next one into a single clip`}
                        style={{ ...ghostBtn, cursor: (shotBusy !== null || promptBusy !== null) ? 'wait' : 'pointer' }}>
                        {shotBusy === si ? '⇄ Merging…' : '⇄ Merge'}
                      </button>
                    )}
                    <button onClick={() => removeShot(si)}
                      disabled={directorsCut.shots.length <= 1 || shotBusy !== null || promptBusy !== null}
                      title={directorsCut.shots.length <= 1 ? 'A film needs at least one clip' : `Remove this ${isH3 ? 'clip' : 'shot'}`}
                      style={{ ...ghostBtn, color: 'var(--pe-danger)', borderColor: 'var(--pe-danger-line)',
                        cursor: (directorsCut.shots.length <= 1 || shotBusy !== null || promptBusy !== null) ? 'not-allowed' : 'pointer' }}>
                      ✕
                    </button>
                  </div>
                )}
              </div>
              {expanded && <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={lbl}>Camera Framing</label>
                  <input value={shot.camera_framing || ''} onChange={e => updateShot(si, 'camera_framing', e.target.value)}
                    style={field()} onFocus={focusBorder} onBlur={blurBorder} />
                </div>
                <div>
                  <label style={lbl}>Camera Movement</label>
                  <input value={shot.camera_movement || ''} onChange={e => updateShot(si, 'camera_movement', e.target.value)}
                    style={field()} onFocus={focusBorder} onBlur={blurBorder} />
                </div>
              </div>
              {isH3 && (
                <div style={{ marginBottom: 10 }}>
                  <label style={lbl}>Eyeline <span style={{ textTransform: 'none', letterSpacing: 0 }}>(what they look at + whether it is in frame)</span></label>
                  <input value={shot.eyeline || ''} onChange={e => updateShot(si, 'eyeline', e.target.value)}
                    style={field()} onFocus={focusBorder} onBlur={blurBorder} />
                </div>
              )}
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Lighting / Mood</label>
                <input value={shot.lighting_mood || ''} onChange={e => updateShot(si, 'lighting_mood', e.target.value)}
                  style={field()} onFocus={focusBorder} onBlur={blurBorder} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>{isH3 ? 'Primary beat' : 'Visual Action'}</label>
                <textarea
                  value={isH3 ? (shot.primary_beat || '') : (shot.visual_action || '')}
                  onChange={e => updateShot(si, isH3 ? 'primary_beat' : 'visual_action', e.target.value)} rows={2}
                  style={{ ...field({ resize: 'vertical' }) }} onFocus={focusBorder} onBlur={blurBorder} />
              </div>

              {/* Duration */}
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Duration</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(isH3 ? H3_DURATIONS : LTX_DURATIONS).map(s => (
                    <button key={s} onClick={() => updateShot(si, 'duration', s)}
                      style={btn(shot.duration === s || (!shot.duration && s === (isH3 ? 7 : 4)))}>
                      {s}s
                    </button>
                  ))}
                </div>
              </div>

              {/* H3: which references phase 3 will attach to this clip */}
              {isH3 && (() => {
                const scene = script?.scenes?.find(s => String(s.id) === String(shot.scene_id))
                const captioned = (refImages || []).filter(im => im.caption && im.caption.trim())
                const active = new Set(shotRefs(shot, scene).map(refKey))
                const pinned = Array.isArray(shot.refs)
                // Also editable on the finished Video-Prompts screen ('done') —
                // that's how a reference gets added/attached to a clip after the
                // fact, without navigating back to Director's Cut.
                const refsEditable = phase === 'dircut' || phase === 'done'
                const editable = refsEditable && shotBusy === null && promptBusy === null
                return (
                  <div style={{ marginBottom: 10, borderTop: '1px solid var(--pe-line-soft)', paddingTop: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                      <label style={{ ...lbl, marginBottom: 0 }}>References attached to this clip</label>
                      {refsEditable && pinned && (
                        <button onClick={() => resetShotRefs(si)} disabled={!editable}
                          style={{ fontSize: 11.5, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '2px 7px', cursor: editable ? 'pointer' : 'not-allowed' }}>
                          reset to auto
                        </button>
                      )}
                      <span style={{ fontSize: 12, marginLeft: 'auto', color: active.size ? 'var(--pe-ok)' : 'var(--pe-ink-3)' }}>
                        → MODE: {active.size ? 'Ref2VA' : 'T2VA'}
                      </span>
                    </div>
                    {captioned.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)' }}>
                        No described references yet — add &amp; describe one for {characterNames(shot.characters) || 'this clip’s characters'} in Reference Images (left), or this clip runs as MODE: T2VA from the bible text.
                      </div>
                    ) : editable ? (
                      <>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          {captioned.map((im, ri) => {
                            const on = active.has(refKey(im))
                            const anchorSec = on ? anchorFor(shot, im) : undefined
                            return (
                              <span key={ri} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                <button onClick={() => toggleShotRef(si, im)}
                                  title={on ? 'Attached to this clip — click to drop it' : 'Not attached — click to add it to this clip'}
                                  style={{
                                    fontSize: 12, borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
                                    border: `1px solid ${on ? 'var(--pe-accent-line)' : 'var(--pe-line)'}`,
                                    background: on ? 'var(--pe-accent-bg)' : 'transparent',
                                    color: on ? 'var(--pe-accent-ink)' : 'var(--pe-ink-3)',
                                    textDecoration: on ? 'none' : 'line-through',
                                  }}>
                                  {on ? '✓ ' : ''}{refEntityName(im, script) || im.note || im.fileName || roleLabel(im.role)} · {roleLabel(im.role)}
                                </button>
                                {on && (
                                  <input type="number" min={0} max={shot.duration || 7} step={0.1}
                                    value={anchorSec ?? ''} placeholder="not anchored"
                                    title="Add Guide timeline anchor — the second inside this clip where this image's composition should be reached (optional; leave blank for a plain semantic reference)"
                                    onChange={(e) => setShotAnchor(si, refKey(im), e.target.value === '' ? null : e.target.value)}
                                    style={{
                                      width: 76, fontSize: 11.5, borderRadius: 4, padding: '2px 5px',
                                      border: `1px solid ${anchorSec != null ? 'var(--pe-accent-line)' : 'var(--pe-line)'}`,
                                      background: 'var(--pe-bg-2)', color: 'var(--pe-ink)',
                                    }} />
                                )}
                                {on && anchorSec != null && <span style={{ fontSize: 11, color: 'var(--pe-ink-3)' }}>s</span>}
                              </span>
                            )
                          })}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--pe-ink-3)', marginTop: 6 }}>
                          {pinned
                            ? 'Pinned set — only the ticked references go into this clip. The Director pre-selects these (dropping e.g. a face reference where the face is hidden); click a chip to change it, or “reset to auto”.'
                            : 'Auto — every described reference for this clip’s characters. Click a chip to pin an exact set.'}
                          {' '}An attached reference can also be given an Add Guide timeline anchor (a second inside this clip) if your ComfyUI workflow uses chained Add Guide nodes — leave blank for a plain reference.
                        </div>
                        {(() => {
                          const secs = captioned.filter(im => active.has(refKey(im))).map(im => anchorFor(shot, im)).filter(v => v != null)
                          const dur = shot.duration || 7
                          const warnings = []
                          if (secs.some(s => s < 0 || s > dur)) warnings.push(`An anchor is outside this clip's 0–${dur}s duration.`)
                          if (new Set(secs).size !== secs.length) warnings.push('Two anchors share the same time.')
                          return warnings.length ? (
                            <div style={{ fontSize: 11.5, color: 'var(--pe-warn)', marginTop: 4 }}>
                              ⚠ {warnings.join(' ')}
                            </div>
                          ) : null
                        })()}
                        {phase === 'done' && (
                          <div style={{ fontSize: 11.5, color: 'var(--pe-accent-ink)', marginTop: 4 }}>
                            This clip’s prompt text above was written with the previous set — click ✦ Rewrite below to regenerate it with your change.
                          </div>
                        )}
                      </>
                    ) : active.size ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {[...active].map((k, ri) => {
                          const im = captioned.find(x => refKey(x) === k)
                          if (!im) return null
                          return (
                            <span key={ri} style={{ fontSize: 12, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 4, padding: '2px 7px' }}>
                              {refEntityName(im, script) || im.note || roleLabel(im.role)} · {roleLabel(im.role)}
                            </span>
                          )
                        })}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)' }}>
                        None — this clip runs as MODE: T2VA from the bible text.
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* H3: which voice-timbre reference(s) — up to 2 (Audio 1 / Audio 2) —
                  this clip carries. Only relevant when the clip has dialogue and at
                  least one bible character has a linked voice sample. */}
              {isH3 && (() => {
                const scene = script?.scenes?.find(s => String(s.id) === String(shot.scene_id))
                const dialogues = shotDialogues(shot, scene)
                if (!dialogues.length) return null
                const candidates = (voiceRefs || []).filter(v => v.base64 && v.characterId)
                if (!candidates.length) return null
                const active = new Set(voicesForShot(shot, scene, dialogues).map(v => v.characterId).filter(Boolean))
                const pinned = Array.isArray(shot.voiceCharacterIds)
                const refsEditable = phase === 'dircut' || phase === 'done'
                const editable = refsEditable && shotBusy === null && promptBusy === null
                const nameOf = (id) => (script?.characters || []).find(c => c.id === id)?.name || id
                return (
                  <div style={{ marginBottom: 10, borderTop: '1px solid var(--pe-line-soft)', paddingTop: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                      <label style={{ ...lbl, marginBottom: 0 }}>Voice references for this clip</label>
                      {refsEditable && pinned && (
                        <button onClick={() => resetShotVoice(si)} disabled={!editable}
                          style={{ fontSize: 11.5, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '2px 7px', cursor: editable ? 'pointer' : 'not-allowed' }}>
                          reset to auto
                        </button>
                      )}
                      <span style={{ fontSize: 12, marginLeft: 'auto', color: active.size ? 'var(--pe-ok)' : 'var(--pe-ink-3)' }}>
                        {active.size ? `${active.size} of 2 attached` : 'none'}
                      </span>
                    </div>
                    {editable ? (
                      <>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {candidates.map((v, vi) => {
                            const on = active.has(v.characterId)
                            const atCap = !on && active.size >= MAX_VOICES_PER_SHOT
                            return (
                              <button key={vi} onClick={() => toggleShotVoice(si, v.characterId)} disabled={atCap}
                                title={on ? 'Attached — click to drop it' : atCap ? 'Two voices already attached — drop one first (H3 takes at most two)' : 'Not attached — click to add it to this clip'}
                                style={{
                                  fontSize: 12, borderRadius: 4, padding: '2px 8px',
                                  cursor: atCap ? 'not-allowed' : 'pointer',
                                  border: `1px solid ${on ? 'var(--pe-accent-line)' : 'var(--pe-line)'}`,
                                  background: on ? 'var(--pe-accent-bg)' : 'transparent',
                                  color: atCap ? 'var(--pe-line)' : on ? 'var(--pe-accent-ink)' : 'var(--pe-ink-3)',
                                  textDecoration: on ? 'none' : 'line-through',
                                }}>
                                {on ? '✓ ' : ''}{nameOf(v.characterId)}
                              </button>
                            )
                          })}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--pe-ink-3)', marginTop: 6 }}>
                          {pinned
                            ? 'Pinned set — H3 takes at most two voice-timbre samples per clip (ref_audio_0 / ref_audio_1). Click a chip to change it, or “reset to auto”.'
                            : 'Auto — resolved from who speaks in this clip’s dialogue. Click a chip to pin an exact set (max 2).'}
                        </div>
                        {phase === 'done' && (
                          <div style={{ fontSize: 11.5, color: 'var(--pe-accent-ink)', marginTop: 4 }}>
                            This clip’s prompt text above was written with the previous set — click 🔊 Attach/Update voice or ✦ Rewrite below to fold your change in.
                          </div>
                        )}
                      </>
                    ) : active.size ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {[...active].map((id, vi) => (
                          <span key={vi} style={{ fontSize: 12, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 4, padding: '2px 7px' }}>
                            {nameOf(id)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)' }}>
                        None resolved — {candidates.length > MAX_VOICES_PER_SHOT ? 'more than two candidates speak in this clip; pin which two, or none' : 'multiple characters here have samples and none was auto-picked; pin one or two, or leave silent'}.
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Frame image prompts — LTX interpolation frames only */}
              {!isH3 && framePrompts[si] && (
                <div style={{ marginTop: 4, borderTop: '1px solid var(--pe-line-soft)', paddingTop: 12 }}>
                  <label style={lbl}>Frame Image Prompts</label>
                  {FRAME_KEYS.map(fk => {
                    const fp = framePrompts[si].frames[fk]
                    const ck = `${si}-${fk}`
                    return (
                      <div key={fk} style={{ marginBottom: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 5 }}>
                          <span style={{ fontSize: 13, color: 'var(--pe-accent-ink)', fontWeight: 600, minWidth: 72 }}>
                            {FRAME_LABELS[fk]}
                          </span>
                          {FRAME_TARGETS.map(t => (
                            <button key={t.id} onClick={() => setFrameTarget(si, fk, t.id)}
                              style={btn(fp.target === t.id)}>{t.label}</button>
                          ))}
                          <button onClick={() => generateFramePrompt(si, fk)} disabled={fp.loading}
                            style={{
                              marginLeft: 'auto', padding: '4px 12px', borderRadius: 6,
                              border: `1px solid ${fp.loading ? 'var(--pe-line)' : 'var(--pe-accent-line)'}`,
                              background: fp.loading ? 'var(--pe-line-soft)' : 'var(--pe-accent-bg)',
                              color: fp.loading ? 'var(--pe-ink-3)' : 'var(--pe-accent-ink)',
                              fontSize: 13, fontWeight: 600,
                              cursor: fp.loading ? 'not-allowed' : 'pointer',
                            }}>
                            {fp.loading ? 'Generating…' : fp.text ? 'Regenerate' : 'Generate'}
                          </button>
                          {fp.text && !fp.loading && (
                            <button onClick={() => {
                              navigator.clipboard.writeText(fp.text)
                              setCopiedFrame(ck)
                              setTimeout(() => setCopiedFrame(null), 2000)
                            }}
                              style={{
                                padding: '4px 10px', borderRadius: 6, border: '1px solid var(--pe-line)',
                                background: copiedFrame === ck ? 'var(--pe-ok-bg)' : 'var(--pe-surface)',
                                color: copiedFrame === ck ? 'var(--pe-ok)' : 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer',
                              }}>
                              {copiedFrame === ck ? '✓' : 'Copy'}
                            </button>
                          )}
                          {fp.text && !fp.loading && (() => {
                            const cs = comfyFrame.key === ck ? comfyFrame.state : 'idle'
                            return (
                              <button onClick={() => sendFrameToComfy(si, fk)}
                                disabled={comfyFrame.state === 'sending'}
                                title={cs === 'error' ? comfyFrame.error
                                  : `Pushes this ${FRAME_LABELS[fk].toLowerCase()} prompt to ComfyUI slot "${comfyCfg.slot || 'default'}" for the Prompt Enhancer Bridge nodes to read.`}
                                style={{
                                  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--pe-line)',
                                  background: cs === 'done' ? 'var(--pe-ok-bg)' : cs === 'error' ? 'var(--pe-danger-bg)' : 'var(--pe-surface)',
                                  color: cs === 'done' ? 'var(--pe-ok)' : cs === 'error' ? 'var(--pe-danger)' : 'var(--pe-ink-3)',
                                  fontSize: 13, cursor: comfyFrame.state === 'sending' ? 'wait' : 'pointer',
                                }}>
                                {cs === 'sending' ? 'Sending…' : cs === 'done' ? '✓ Sent' : cs === 'error' ? '✕ Failed' : '→ ComfyUI'}
                              </button>
                            )
                          })()}
                          {fp.text && !fp.loading && (
                            <button onClick={() => openPicker(si, fk)}
                              title="Pick a rendered image from ComfyUI's recent outputs and attach it to this frame."
                              style={{
                                padding: '4px 10px', borderRadius: 6, border: '1px solid var(--pe-line)',
                                background: picker.key === ck ? 'var(--pe-accent-bg)' : 'var(--pe-surface)',
                                color: picker.key === ck ? 'var(--pe-accent-ink)' : 'var(--pe-ink-3)',
                                fontSize: 13, cursor: 'pointer',
                              }}>
                              {fp.image ? '🖼 Change image' : '＋ Attach image'}
                            </button>
                          )}
                        </div>
                        {fp.error && <div style={{ fontSize: 13.5, color: 'var(--pe-danger)', marginBottom: 4 }}>{fp.error}</div>}
                        {fp.text && (
                          <textarea value={fp.text} onChange={e => editFramePrompt(si, fk, e.target.value)}
                            rows={Math.max(3, Math.ceil(fp.text.length / 80))} spellCheck={false}
                            style={{
                              width: '100%', boxSizing: 'border-box', background: 'var(--pe-rail)',
                              border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 12px',
                              fontSize: 13.5, lineHeight: 1.7, color: 'var(--pe-accent-ink)',
                              fontFamily: 'var(--pe-mono)', resize: 'vertical', outline: 'none',
                              transition: 'border-color 0.15s',
                            }}
                            onFocus={focusBorder} onBlur={blurBorder} />
                        )}

                        {fp.image && (
                          <div style={{ marginTop: 8 }}>
                            <img src={`data:${fp.image.mediaType};base64,${fp.image.b64}`} alt={`${FRAME_LABELS[fk]} render`}
                              style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 8, border: '1px solid var(--pe-line)', display: 'block' }} />
                            <div style={{ display: 'flex', gap: 8, marginTop: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12, color: 'var(--pe-ink-3)' }}>
                                {fp.image.width}×{fp.image.height} · {fp.image.source?.filename}
                              </span>
                              <button onClick={() => openPicker(si, fk)} style={ghostBtn}>Replace</button>
                              <a href={`data:${fp.image.mediaType};base64,${fp.image.b64}`}
                                download={fp.image.source?.filename || `shot${shot.shot_number}-${fk}.jpg`}
                                style={{ ...ghostBtn, textDecoration: 'none' }}>Download</a>
                              <button onClick={() => removeFrameImage(si, fk)} style={{ ...ghostBtn, color: 'var(--pe-danger)', borderColor: 'var(--pe-danger-line)' }}>Remove</button>
                            </div>
                          </div>
                        )}

                        {attach.key === ck && attach.state === 'fetching' && (
                          <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', marginTop: 6 }}>Fetching image…</div>
                        )}
                        {attach.key === ck && attach.state === 'error' && (
                          <div style={{ fontSize: 13, color: 'var(--pe-danger)', marginTop: 6 }}>{attach.error}</div>
                        )}

                        {picker.key === ck && (
                          <div style={{ marginTop: 8, padding: 10, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12.5, color: 'var(--pe-ink-3)' }}>
                                {picker.loading ? 'Loading recent ComfyUI outputs…'
                                  : `${picker.items.length} recent output${picker.items.length === 1 ? '' : 's'} · newest first`}
                              </span>
                              <button onClick={() => loadPickerItems(ck)} disabled={picker.loading} style={ghostBtn}>Refresh</button>
                              <button onClick={() => setPicker({ key: null, loading: false, error: '', items: [] })} style={{ ...ghostBtn, marginLeft: 'auto' }}>Close</button>
                            </div>
                            {picker.error && <div style={{ fontSize: 13, color: 'var(--pe-danger)', marginBottom: 6 }}>{picker.error}</div>}
                            {picker.items.length > 0 && (
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                                {picker.items.map((it, ii) => (
                                  <img key={ii} src={it.viewUrl} loading="lazy" alt={it.filename}
                                    title={`${it.filename}${it.subfolder ? ` (${it.subfolder})` : ''}${it.type === 'temp' ? ' · preview' : ''}`}
                                    onClick={() => attachImage(si, fk, it)}
                                    style={{
                                      width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6,
                                      border: '1px solid var(--pe-line)', cursor: 'pointer', background: 'var(--pe-surface)',
                                    }} />
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              </>}
              </div>
            </div>
          )})}
          {phase === 'dircut' && insertBar(directorsCut.shots.length)}

          {/* Output model was chosen on the script screen */}
          <div style={{ ...card, marginTop: 6, fontSize: 13, color: 'var(--pe-ink-3)' }}>
            Output: <span style={{ color: 'var(--pe-accent-ink)', fontWeight: 600 }}>{PROMPT_TARGET_LABEL[promptTarget] || promptTarget}</span>
            {` · ${aspectToken(aspectRatio)}`}
            {isH3 && <> · Ref2VA where a clip has linked references, T2VA otherwise</>}
          </div>

          {phase === 'dircut' && (
            <>
              <button onClick={runPhase3} style={{ ...genBtn(false), marginTop: 6 }}>
                {finalPrompts.some(p => p.text && p.text.trim())
                  ? `↻ Re-generate all ${PROMPT_TARGET_LABEL[promptTarget] || 'Video'} Prompts`
                  : `→ Generate ${PROMPT_TARGET_LABEL[promptTarget] || 'Video'} Prompts`}
              </button>
              <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                <button onClick={() => navigateTo('script')} disabled={navBusy()} style={navBtn}>← Back to Script</button>
                {finalPrompts.length > 0 && (
                  <button onClick={() => navigateTo('done')} disabled={navBusy()} style={navBtn}>→ Video Prompts (keep current)</button>
                )}
              </div>
            </>
          )}

          {/* Final LTX prompts */}
          {['prompting', 'done'].includes(phase) && finalPrompts.length > 0 && (
            <div style={{ marginTop: 28 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{PROMPT_TARGET_LABEL[promptTarget] || 'Video'} Prompts</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {finalPrompts.length > 1 && (
                    <>
                      <button onClick={() => setExpandedPrompts(new Set(finalPrompts.map((_, i) => i)))} style={ghostBtn}>Expand all</button>
                      <button onClick={() => setExpandedPrompts(new Set())} style={ghostBtn}>Collapse all</button>
                    </>
                  )}
                  {phase === 'done' && (
                    <>
                      <button onClick={copyAll}
                        style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--pe-line)', background: copiedAll ? 'var(--pe-ok-bg)' : 'var(--pe-surface)', color: copiedAll ? 'var(--pe-ok)' : 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer' }}>
                        {copiedAll ? '✓ Copied all' : 'Copy all'}
                      </button>
                      <button onClick={exportBundle} disabled={exporting}
                        style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--pe-accent-line)', background: 'var(--pe-accent-bg)', color: 'var(--pe-accent-ink)', fontSize: 13, fontWeight: 600, cursor: exporting ? 'wait' : 'pointer' }}>
                        {exporting ? 'Zipping…' : '⬇ Export ZIP'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {finalPrompts.map((p, i) => {
                  const expanded = expandedPrompts.has(i) || p.loading || !!p.error
                  return (
                  <div key={i}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: expanded ? 6 : 0, gap: 10 }}>
                      <button onClick={() => togglePromptExpanded(i)}
                        title={expanded ? 'Collapse' : 'Expand'}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 auto', minWidth: 0,
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit', font: 'inherit' }}>
                        <span style={{ fontSize: 11, color: 'var(--pe-ink-3)', flexShrink: 0, display: 'inline-block',
                          transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'none' }}>▸</span>
                        <span style={{ fontSize: 13, color: 'var(--pe-accent)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600, flexShrink: 0 }}>Shot {p.shotNumber}</span>
                        <span style={{ fontSize: 13, color: 'var(--pe-ink-3)', flexShrink: 0 }}>{p.sceneTitle}</span>
                        {!expanded && p.text && (
                          <span style={{ fontSize: 12, color: 'var(--pe-ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                            — {p.text.replace(/\s+/g, ' ').trim()}
                          </span>
                        )}
                      </button>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                        {p.usage && <span style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>in {p.usage.input_tokens} · out {p.usage.output_tokens} tokens</span>}
                        {phase === 'done' && !p.loading && isH3 && directorsCut?.shots?.[i] && (() => {
                          const shot = directorsCut.shots[i]
                          const scene = script?.scenes?.find(s => String(s.id) === String(shot.scene_id))
                          const voices = voicesForShot(shot, scene, shotDialogues(shot, scene))
                          if (!voices.length) return null
                          const already = /audio\s*1/i.test(p.text || '')
                          const label = voices.map(v => v.speaker || v.fileName).join(' + ')
                          return (
                            <button onClick={() => attachVoiceReference(i)} disabled={promptBusy !== null || shotBusy !== null}
                              title={`Attach ${voices.map(v => `"${v.fileName}"`).join(' + ')} as this clip's voice-timbre reference${voices.length > 1 ? 's' : ''} — a small targeted edit, the rest of the prompt is left exactly as is (unlike ✦ Rewrite)`}
                              style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--pe-line)', background: 'var(--pe-surface)', color: 'var(--pe-ink-2)', fontSize: 13, fontWeight: 600, cursor: (promptBusy !== null || shotBusy !== null) ? 'wait' : 'pointer' }}>
                              {promptBusy === i ? '🔊 Attaching…' : already ? `🔊 Update voice (${label})` : `🔊 Attach voice (${label})`}
                            </button>
                          )
                        })()}
                        {phase === 'done' && !p.loading && directorsCut?.shots?.[i] && (
                          <button onClick={() => regeneratePrompt(i)} disabled={promptBusy !== null || shotBusy !== null}
                            title="Have the AI write a fresh prompt for this clip"
                            style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--pe-accent-line)', background: 'var(--pe-accent-bg)', color: 'var(--pe-accent-ink)', fontSize: 13, fontWeight: 600, cursor: (promptBusy !== null || shotBusy !== null) ? 'wait' : 'pointer' }}>
                            {promptBusy === i ? '✦ Rewriting…' : '✦ Rewrite'}
                          </button>
                        )}
                        {p.text && !p.loading && (
                          <button onClick={() => copyOne(i)}
                            style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--pe-line)', background: copied === i ? 'var(--pe-ok-bg)' : 'var(--pe-surface)', color: copied === i ? 'var(--pe-ok)' : 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer' }}>
                            {copied === i ? '✓ Copied' : 'Copy'}
                          </button>
                        )}
                      </div>
                    </div>
                    {expanded && <>
                    {p.loading && (
                      <div style={{ padding: '18px 20px', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, fontSize: 13, color: 'var(--pe-ink-3)' }}>Generating…</div>
                    )}
                    {p.error && (
                      <div style={{ padding: '12px 14px', background: 'var(--pe-danger-bg)', border: '1px solid var(--pe-danger-line)', borderRadius: 8, fontSize: 13, color: 'var(--pe-danger)' }}>Error: {p.error}</div>
                    )}
                    {p.text && (
                      <textarea value={p.text} onChange={e => editPrompt(i, e.target.value)}
                        rows={Math.max(4, Math.ceil(p.text.length / 70))} spellCheck={false}
                        style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '18px 20px', fontSize: 13.5, lineHeight: 1.8, color: 'var(--pe-ink)', whiteSpace: 'pre-wrap', fontFamily: 'var(--pe-mono)', resize: 'vertical', outline: 'none', transition: 'border-color 0.15s' }}
                        onFocus={focusBorder} onBlur={blurBorder} />
                    )}
                    {isH3 && p.text && !p.loading && directorsCut?.shots?.[i] && (() => {
                      const shot = directorsCut.shots[i]
                      const scene = script?.scenes?.find(s => String(s.id) === String(shot.scene_id))
                      const refs = shotRefs(shot, scene)
                      // A pre-existing entry (saved before h3Mode was stamped
                      // on finalPrompts) has no p.h3Mode — fall back to the
                      // same signal buildH3ShotMessage itself uses (captioned
                      // references present -> Ref2VA, none -> T2VA).
                      const mode = p.h3Mode || (refs.length ? 'Ref2VA' : 'T2VA')
                      return <H3SyntaxBadge text={p.text} mode={mode} refImages={refs} anchors={activeAnchorsForRefs(shot, refs)} />
                    })()}
                    </>}
                  </div>
                )})}
              </div>
              {phase === 'done' && (
                <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
                  <button onClick={() => navigateTo('script')} disabled={navBusy()} style={navBtn}>← Back to Script</button>
                  <button onClick={() => navigateTo('dircut')} disabled={navBusy()} style={navBtn}>← Back to Director's Cut</button>
                  <button onClick={reset} style={{ ...navBtn, padding: '8px 18px' }}>← Start over</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
    </>
  )
}

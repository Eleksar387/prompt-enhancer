// RefMod library for MiniMax H3's MiniMaxH3RefModsLoader node.
//
// Unlike a LoRA, a RefMod has no trigger word / activation phrase at all —
// confirmed against the installed ComfyUI-MiniMaxH3Mod pack's own README
// ("Neither the filename nor description is a trigger, and <Subject n> is
// not automatically bound to a loader slot" / "RefMod currently has no
// <Name> trigger parser"). It loads purely via `file` + `strength` on the
// MiniMaxH3RefModsLoader/Apply nodes; the pack's own recommended usage is to
// just describe the subject/action in the prompt naturally. `note` (optional,
// free text on what the RefMod represents) exists only to help the writer's
// natural description line up with what's actually loaded — it is never
// inserted into the prompt verbatim.
//
// Deliberately smaller than loras.js: no `kind` (RefMods have no
// character/style split) and no trigger-repair pass (there is nothing to
// repair).
//
// Store shape, one entry per RefMod the user owns:
//   { id, name, note, description, role, file, strength }
//
// `description` is the RefMod's VISIBLE LOOK (face/build/clothing/setting) in plain
// prose — typed by hand or produced once from an image by the vision model
// (describeRefModImage). Without it the writer only has a name and is told not
// to guess, so a RefMod-only film gets a prompt that never says what is visible.
// It is writer-facing text only: never part of the bridge manifest.

import { makeLocalStore } from './localStore'
import { caps, MINIMAX_H3_REF_ROLES, MINIMAX_H3_PRESERVE_OPTIONS } from './constants'

export const REF_MOD_STORE_KEY = 'prompt-enhancer-refmods'

// What a RefMod stands for, as an H3 reference role (pose is excluded — a RefMod
// loads an identity / outfit / prop / place / look, not a body pose). Drives the
// virtual Ref2VA reference line (role label + preservation marker).
export const REF_MOD_DEFAULT_ROLE = 'subject_identity'
export const REF_MOD_ROLE_IDS = ['subject_identity', 'wardrobe', 'product_object', 'environment', 'style']
// Preservation default per role — the same defaults the Scriptwriter uses for a
// linked reference (character locks the face, a location transfers the room).
const REF_MOD_PRESERVE = { subject_identity: 'exact', environment: 'guide', wardrobe: 'strong', product_object: 'strong', style: 'inspiration' }

export const sanitizeRefMods = (list) => (Array.isArray(list) ? list : [])
  .filter(r => r && typeof r === 'object')
  .map(r => ({
    id: String(r.id || ''),
    name: typeof r.name === 'string' ? r.name : '',
    note: typeof r.note === 'string' ? r.note : '',
    description: typeof r.description === 'string' ? r.description : '',
    role: REF_MOD_ROLE_IDS.includes(r.role) ? r.role : REF_MOD_DEFAULT_ROLE,
    file: typeof r.file === 'string' ? r.file : '',
    strength: Number.isFinite(Number(r.strength)) && r.strength !== '' && r.strength != null ? Number(r.strength) : 1,
  }))
  .filter(r => r.id)

const refModStore = makeLocalStore(REF_MOD_STORE_KEY, { parse: sanitizeRefMods })
export const loadRefMods = refModStore.load
export const saveRefMods = (list) => refModStore.save(list || [])

export const refModHasFile = (r) => !!(r && typeof r.file === 'string' && r.file.trim())

// Equality-only normalization (never storage/display) — MiniMaxH3RefModsLoader
// reports extensionless, forward-slash-normalized names, but a hand-typed entry
// could still carry a backslash, so this still guards against that.
export const normalizeRefModFile = (f) => (f || '').trim().replace(/\\/g, '/').toLowerCase()

// Every active RefMod matched by id — there is no "usable" gate (no trigger
// to be missing), unlike loras.js's lorasByIds/loraUsable.
export const refModsByIds = (list, ids) =>
  (Array.isArray(ids) ? ids : []).map(id => (list || []).find(r => r.id === id)).filter(Boolean)

// manifest.json `refMods` for one clip/generation — mirrors loraManifestEntries
// in src/loras.js exactly. Deduped by file, capped at the bridge workflow's
// PEClipRefMod slots.
export const MAX_REF_MOD_SLOTS = 3

// The RefMods that actually load, in slot order: has a file, deduped by file,
// strength above zero (a zero-strength RefMod contributes nothing), capped at the
// bridge workflow's slots. The manifest and every prompt tag (<Subject 1>, …)
// derive from THIS list, so the prompt never cites a RefMod ComfyUI isn't loading.
export function selectRefMods(library, ids) {
  const seen = new Set()
  const out = []
  for (const id of [...new Set(Array.isArray(ids) ? ids : [])]) {
    const r = (library || []).find(x => x.id === id)
    if (!refModHasFile(r)) continue
    const file = r.file.trim()
    if (seen.has(file)) continue
    const strength = Number.isFinite(r.strength) ? r.strength : 1
    if (strength <= 0) continue
    seen.add(file)
    out.push({ refMod: r, file, strength })
  }
  return out.slice(0, MAX_REF_MOD_SLOTS)
}
export const refModManifestEntries = (library, ids) =>
  selectRefMods(library, ids).map(({ file, strength }) => ({ file, strength }))

// The virtual references for the writer. A RefMod goes straight into the
// conditioning stream — there is NO image and NO positional <Picture n> tag; the
// prompt just names what it is: <Subject 1>, <Location 1>, … (a counter per tag, in
// slot order). <Subject M> continues after any real subject-defining reference
// images so a real <Subject 1> and a RefMod never collide.
export const REF_MOD_TAG = {
  subject_identity: 'Subject', environment: 'Location', wardrobe: 'Wardrobe', product_object: 'Object', style: 'Style',
}
// -> [{ refMod, file, strength, tag, index, label: '<Subject 1>', role, preserve }]
export function refModLabels(library, ids, { realSubjectCount = 0 } = {}) {
  const counts = { Subject: realSubjectCount }
  return selectRefMods(library, ids).map((e) => {
    const role = REF_MOD_ROLE_IDS.includes(e.refMod.role) ? e.refMod.role : REF_MOD_DEFAULT_ROLE
    const tag = REF_MOD_TAG[role]
    counts[tag] = (counts[tag] || 0) + 1
    return { ...e, tag, index: counts[tag], label: `<${tag} ${counts[tag]}>`, role, preserve: REF_MOD_PRESERVE[role] || 'strong' }
  })
}

// One line per RefMod for the writer's reference block: the tag it is cited by, its
// role and preservation marker (so retention_analysis has one), and its visible
// look. Never an "Image N" / <Picture n>.
export function refModReferenceLines(labels) {
  return (labels || []).map(l => {
    const role = MINIMAX_H3_REF_ROLES.find(r => r.id === l.role) || MINIMAX_H3_REF_ROLES[0]
    const pres = MINIMAX_H3_PRESERVE_OPTIONS.find(p => p.id === l.preserve) || MINIMAX_H3_PRESERVE_OPTIONS[1]
    const r = l.refMod
    const look = (r.description || '').trim() || [r.name, r.note].map(x => (x || '').trim()).filter(Boolean).join(' — ') || 'a loaded RefMod'
    return `RefMod ${l.label} — role: ${role.label}, preservation: ${pres.label} (${pres.marker}) [loaded straight into the video model; no image, no <Picture> tag]: ${look}`
  }).join('\n\n')
}

// --- voice-timbre references ------------------------------------------------
// A voice (refAudios[i]) binds to ONE target through `subjectRef`: an image's content
// hash (existing), or `refmod:<id>` for a RefMod subject. A stale RefMod id simply
// resolves to nothing (unbound), like an unmatched hash.
const REFMOD_VOICE_PREFIX = 'refmod:'
export const refModVoiceKey = (id) => `${REFMOD_VOICE_PREFIX}${id}`
export const isRefModVoiceKey = (k) => typeof k === 'string' && k.startsWith(REFMOD_VOICE_PREFIX)

// Audio lines for the writer message. `only`: 'all' (default), 'refmod' (just the
// RefMod-bound ones) or 'rest' (everything else) — numbering always follows the
// audio's own position, so "Audio N" matches <Audio N> whichever subset is emitted.
export function buildAudioBlock(audios, { refs = [], refModLabels: labels = [], roleLabel = (x) => x, only = 'all' } = {}) {
  return (audios || []).map((a, i) => {
    const rm = isRefModVoiceKey(a.subjectRef)
    if (only === 'refmod' && !rm) return null
    if (only === 'rest' && rm) return null
    let note = ''
    if (rm) {
      const l = (labels || []).find(x => x.tag === 'Subject' && refModVoiceKey(x.refMod.id) === a.subjectRef)
      if (l) note = ` — the voice of ${l.label}${l.refMod.name ? ` (${l.refMod.name})` : ''}`
    } else {
      const boundIdx = refs.findIndex(im => im.hash && im.hash === a.subjectRef)
      if (boundIdx >= 0) note = ` — for the subject in Image ${boundIdx + 1} (${roleLabel(refs[boundIdx].role)})`
    }
    return `Audio ${i + 1} — voice-timbre reference (marker: reference)${note}: file "${a.fileName}". Reference ONLY the timbre, pitch and delivery for the speaking subject; never transcribe or guess at its original wording. If no spoken dialogue is supplied elsewhere in this message, write one short line for that subject yourself so the voice reference has speech to act on.`
  }).filter(Boolean).join('\n\n')
}

// Opt-in, the OPPOSITE default from targetTakesLoras — RefMods only make sense
// for a target that actually has a MiniMaxH3RefModsLoader node behind it.
export const targetTakesRefMods = (targetId) => caps(targetId).refMods === true

// --- the writer-facing instruction -----------------------------------------
//
// There is no token to reproduce, so the only useful thing to tell the writer
// is the OPPOSITE of what it would otherwise do: a RefMod loads a specific
// visual concept — an identity, an outfit, a prop, a location — directly
// into the model, so inventing a competing, specific description of that
// same thing in prose fights the loaded reference instead of reinforcing
// it (this cost real identity fidelity once in practice — a RefMod-bound
// character still got a fully invented, generic physical description
// because this function returned '' whenever the RefMod's own `note` was
// empty, which is the common case for a quick single-RefMod setup). This
// now fires for ANY active RefMod regardless of whether a `note` was ever
// typed — an undescribed RefMod still needs "don't guess," it just can't
// also be told the specific name of whichever subject/story-element it is.
// `note`/`subject`, when present, are surfaced as identifying context only
// ("this is what it's for"), never as prose to restate — exactly the
// pack's own documented usage ("prompt for a candy racer in a karting
// scene," never a physical description of the racer).

const refModLine = (r) => {
  const who = (r.subject || '').trim() || r.name.trim() || 'this generation\'s subject'
  const note = r.note.trim()
  const look = (r.description || '').trim()
  if (look) return `- ${who} — visible look: ${look}${note ? ` (represents: ${note})` : ''}`
  return note ? `- ${who} — represents: ${note}` : `- ${who}`
}

export const refModHasLook = (r) => !!(r && typeof r.description === 'string' && r.description.trim())

// Film-level canon block for Scriptwriter Phases 1 and 2: only RefMods that have a
// description (a bare name tells those phases nothing). Empty when none do.
export function refModCanonBlock(active, targetId = 'minimax_h3') {
  if (!targetTakesRefMods(targetId)) return ''
  const list = (active || []).filter(refModHasLook)
  if (!list.length) return ''
  return `\n\nRefMods loaded into the video model for this film — treat their descriptions as canon for what these `
    + `characters / outfits / props / places actually look like. Write the cast and location bible (and any shot) `
    + `consistently with them, folding each into the matching character or location (match by name or note); never `
    + `invent a different look for what a RefMod covers:\n${list.map(refModLine).join('\n')}`
}

// `labels` (from refModLabels) switches to Ref2VA wording: the RefMods are virtual
// references that already appear as "Image N" lines in the message, so the writer
// must CITE them by their <Subject M> / <Location M> tag rather than avoid or re-narrate them.
export function refModInstruction(active, targetId, labels = null) {
  if (!targetTakesRefMods(targetId)) return ''
  const list = active || []
  if (!list.length) return ''
  if (labels && labels.length) {
    return `\n\nRefMod reference(s) for this generation are the lines starting "RefMod <Tag N>". Each is loaded straight into the video model's `
      + `conditioning — there is no image and no <Picture> tag, so never write or invent a <Picture N> for it. Cite it ONLY by the tag shown on its line `
      + `(<Subject 1>, <Location 1>, …): define it in subject_definitions ("<Subject 1> is …, preserving …" with no "from <Picture N>"), give it a `
      + `retention_analysis line, and use the tag in the shots where it appears. Do NOT re-narrate its look in the action text — the look is carried by the `
      + `reference; build the scene and camera from the scene brief.`
  }
  const described = list.filter(refModHasLook)
  const bare = list.filter(r => !refModHasLook(r))
  const head = `\n\nActive RefMod reference(s) for this generation — each one loads a specific visual concept `
    + `(an identity, outfit, prop, or location) directly into the model by file; there is no activation word, `
    + `trigger token or <Subject n> tag for them, and they are never named or quoted in the prose.`
  const lookPart = described.length
    ? ` For the element each "visible look" line below stands for, DESCRIBE what is visible in the prompt — `
      + `face, build, clothing, setting as given — consistently with that description; never contradict it or `
      + `invent a different look:\n${described.map(refModLine).join('\n')}`
    : ''
  const barePart = bare.length
    ? ` For the element each of the following stands in for, do NOT invent new, specific visual details of your own `
      + `(face, hair, build, exact garment pattern, exact room layout, etc.) — describe it in general, neutral terms `
      + `and let the loaded reference supply the actual look, the same way the official usage example does ("prompt `
      + `for a candy racer in a karting scene" — the scene and action, never a physical description of the racer):\n`
      + `${bare.map(refModLine).join('\n')}`
    : ''
  return head + lookPart + barePart
}

// One-off vision call: an image of what the RefMod depicts -> the editable
// "visible look" text. `call(model, content, system)` is injected (App wraps
// cachedVision, the Scriptwriter wraps callOllama) so this stays pure and
// testable; the image itself is never stored, only the returned text.
export async function describeRefModImage(call, { model, base64, mediaType, hint = '' }, visionSystem) {
  if (!model) throw new Error('No vision model selected — pick one to describe an image.')
  const note = (hint || '').trim()
  const text = await call(model, [
    { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
    { type: 'text', text: `Describe what is visible in this image so a video writer can reproduce the look in words.${note ? ` Intended use: ${note}.` : ''}` },
  ], visionSystem)
  const out = String(text || '').trim()
  if (!out) throw new Error('The vision model returned no description.')
  return out
}

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
//   { id, name, note, description, file, strength }
//
// `description` is the RefMod's VISIBLE LOOK (face/build/clothing/setting) in plain
// prose — typed by hand or produced once from an image by the vision model
// (describeRefModImage). Without it the writer only has a name and is told not
// to guess, so a RefMod-only film gets a prompt that never says what is visible.
// It is writer-facing text only: never part of the bridge manifest.

import { makeLocalStore } from './localStore'
import { caps } from './constants'

export const REF_MOD_STORE_KEY = 'prompt-enhancer-refmods'

export const sanitizeRefMods = (list) => (Array.isArray(list) ? list : [])
  .filter(r => r && typeof r === 'object')
  .map(r => ({
    id: String(r.id || ''),
    name: typeof r.name === 'string' ? r.name : '',
    note: typeof r.note === 'string' ? r.note : '',
    description: typeof r.description === 'string' ? r.description : '',
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
export function refModManifestEntries(library, ids) {
  const seen = new Set()
  const out = []
  for (const id of [...new Set(Array.isArray(ids) ? ids : [])]) {
    const r = (library || []).find(x => x.id === id)
    if (!refModHasFile(r)) continue
    const file = r.file.trim()
    if (seen.has(file)) continue
    seen.add(file)
    out.push({ file, strength: Number.isFinite(r.strength) ? r.strength : 1 })
  }
  return out.slice(0, MAX_REF_MOD_SLOTS)
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

export function refModInstruction(active, targetId) {
  if (!targetTakesRefMods(targetId)) return ''
  const list = active || []
  if (!list.length) return ''
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

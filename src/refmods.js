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
//   { id, name, note, file, strength }

import { makeLocalStore } from './localStore'
import { caps } from './constants'

export const REF_MOD_STORE_KEY = 'prompt-enhancer-refmods'

export const sanitizeRefMods = (list) => (Array.isArray(list) ? list : [])
  .filter(r => r && typeof r === 'object')
  .map(r => ({
    id: String(r.id || ''),
    name: typeof r.name === 'string' ? r.name : '',
    note: typeof r.note === 'string' ? r.note : '',
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
  return note ? `- ${who} — represents: ${note}` : `- ${who}`
}

export function refModInstruction(active, targetId) {
  if (!targetTakesRefMods(targetId)) return ''
  const list = active || []
  if (!list.length) return ''
  return `\n\nActive RefMod reference(s) for this generation — each one loads a specific visual concept `
    + `(an identity, outfit, prop, or location) directly into the model by file; there is no activation word, `
    + `trigger token or <Subject n> tag for them, and they are never named or quoted in the prose. For the `
    + `element each one below stands in for, do NOT invent new, specific visual details of your own (face, hair, `
    + `build, exact garment pattern, exact room layout, etc.) — describe it in general, neutral terms and let the `
    + `loaded reference supply the actual look, the same way the official usage example does ("prompt for a candy `
    + `racer in a karting scene" — the scene and action, never a physical description of the racer):\n`
    + `${list.map(refModLine).join('\n')}`
}

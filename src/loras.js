// LoRA trigger words.
//
// A LoRA only fires when its trigger token appears in the positive prompt, and
// the token is an activation key rather than a word: "aidmaMJ6.1" reworded as
// "aidma MJ 6.1", pluralized or re-capitalized silently does nothing. So this
// module does two things — tells the writer about the active triggers (so it can
// place each one next to what it belongs to), and repairs the finished prompt by
// prepending any token that came back missing or mangled.
//
// Store shape, one entry per LoRA the user owns:
//   { id, name, trigger, kind: 'character' | 'style', note }
//
// `kind` decides how it binds: a 'character' LoRA can be attached to a cast
// member in the Scriptwriter and then rides only the clips that character
// appears in; a 'style' LoRA applies to the whole generation. `name` and `note`
// are for the user's own benefit and never reach a model.

import { makeLocalStore } from './localStore'
import { caps, TARGETS } from './constants'

export const LORA_STORE_KEY = 'prompt-enhancer-loras'
export const LORA_KINDS = [
  { id: 'character', label: 'Character', short: 'C' },
  { id: 'style',     label: 'Style',     short: 'S' },
]

// Every field is re-checked on read rather than trusted: the stored library is
// user-typed, may predate a field, and a malformed entry reaching a prompt would
// put junk in front of a model. An unreadable store degrades to an empty library.
export const sanitizeLoras = (list) => (Array.isArray(list) ? list : [])
  .filter(l => l && typeof l === 'object')
  .map(l => ({
    id: String(l.id || ''),
    name: typeof l.name === 'string' ? l.name : '',
    trigger: typeof l.trigger === 'string' ? l.trigger : '',
    kind: l.kind === 'style' ? 'style' : 'character',
    note: typeof l.note === 'string' ? l.note : '',
  }))
  .filter(l => l.id)

const loraStore = makeLocalStore(LORA_STORE_KEY, { parse: sanitizeLoras })
export const loadLoras = loraStore.load
export const saveLoras = (list) => loraStore.save(list || [])

// A LoRA is usable only once it has a trigger — an entry the user started typing
// and left half-finished must never reach a prompt.
export const loraUsable = (l) => !!(l && typeof l.trigger === 'string' && l.trigger.trim())

export const lorasByIds = (list, ids) =>
  (Array.isArray(ids) ? ids : []).map(id => (list || []).find(l => l.id === id)).filter(loraUsable)

// Whether triggers mean anything for this target. False only where there is no
// diffusion model behind the prompt at all (DramaBox, a TTS delivery prompt) —
// declared as `caps.loras` in the target table rather than named here.
export const targetTakesLoras = (targetId) => caps(targetId).loras !== false

// --- the writer-facing instruction -----------------------------------------

// `subject` is what a character trigger should sit next to when the caller knows
// it (the bound character's name); without one the instruction just says "the
// character it names".
const triggerLine = (l) => {
  const where = l.kind === 'style'
    ? 'style trigger — put it in the opening style phrase'
    : `character trigger${l.subject ? ` for ${l.subject}` : ''} — put it immediately before or after the first mention of the character it names`
  return `- ${l.trigger}   (${where})`
}

export function loraInstruction(active, targetId) {
  const usable = (active || []).filter(loraUsable)
  if (!usable.length || !targetTakesLoras(targetId)) return ''
  // A target whose output is a labelled multi-field block needs to be told which
  // field the tokens may appear in; prose targets do not.
  const fields = TARGETS[targetId]?.loraInject?.fields
  return `\n\nLoRA trigger tokens — these are model activation keys, not words. Reproduce each one EXACTLY as written below, `
    + `character for character:\n${usable.map(triggerLine).join('\n')}\n`
    + `Never translate, pluralize, re-capitalize, hyphenate, space out, abbreviate or explain a token, and never wrap `
    + `one in quotation marks. Each token appears once. They are not on-screen text, not dialogue, and not something `
    + `to describe — they are tokens the image model needs to read.`
    + (fields
      ? ` In this format they belong in the ${fields[0]} (or ${fields[1]}) field only: `
        + `never in summary, subject_definitions, retention_analysis, overall_soundscape or non_diegetic_music, and `
        + `never inside a <d> tag or inside quotes — text in those places is spoken aloud or rendered on screen in the video.`
      : '')
}

// --- the repair ------------------------------------------------------------

// Compared with whitespace collapsed and case ignored, so "ohwx  Woman" counts
// as present. Anything else — a hyphen, a split token, a dropped digit — reads
// as missing, which is the intent: the LoRA would not have fired either.
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ')

export function missingTriggers(text, active) {
  const hay = norm(text)
  return (active || []).filter(loraUsable)
    .map(l => l.trigger.trim())
    .filter(t => !hay.includes(norm(t)))
}

// Dedupes triggers that repeat across LoRAs (two character LoRAs sharing a
// token) while keeping the order they were activated in.
const uniq = (arr) => arr.filter((v, i) => arr.indexOf(v) === i)

// Insert `tokens` at the start of the BODY of field `label` in an H3 prompt.
// The separator group is matched and kept so the tokens land after it, not on
// the label line: a label written "detailed_description:\n[Shot 1] …" keeps its
// line break and the tokens open the body below it, while an inline
// "detailed_description: [Shot 1] …" keeps its single space.
// Returns null when the label isn't there, so the caller can fall back.
const injectAfterLabel = (text, label, tokens) => {
  const re = new RegExp(`^([ \\t]*${label}[ \\t]*:)([ \\t]*\\n?[ \\t]*)`, 'im')
  const m = text.match(re)
  if (!m) return null
  const head = m[1] + (m[2] || ' ')
  const at = m.index + m[0].length
  return `${text.slice(0, m.index)}${head}${tokens.join(', ')}. ${text.slice(at)}`
}

export function withLoraTriggers(text, active, targetId) {
  const body = text || ''
  if (!body.trim() || !targetTakesLoras(targetId)) return body
  const missing = uniq(missingTriggers(body, active))
  if (!missing.length) return body

  // Where a repaired token may go is a property of the target's output FORMAT, so
  // the target table declares it (`loraInject`) instead of this function knowing
  // the names of targets. Two shapes exist:
  //
  //   afterLabel  a labelled section the tokens lead, as comma-joined tags. SDXL's
  //               POSITIVE:/NEGATIVE: pair — and they must never reach NEGATIVE,
  //               where they would suppress the LoRA rather than fire it.
  //   fields      a labelled multi-field block where prepending would break the
  //               format, so the tokens open the body of the first field that is
  //               actually present (H3's detailed_description in Ref2VA mode, or
  //               integrated_multimodal_description in the base modes).
  //
  // Either way, a format that turns out not to contain its own label falls back to
  // a plain prepend rather than dropping the token.
  const inject = TARGETS[targetId]?.loraInject

  if (inject?.afterLabel) {
    const sep = inject.separator ?? ', '
    const m = body.match(new RegExp(`^([ \\t]*${inject.afterLabel}[ \\t]*:[ \\t]*\\n?)`, 'im'))
    if (m) {
      const at = m.index + m[0].length
      return `${body.slice(0, at)}${missing.join(', ')}${sep}${body.slice(at)}`
    }
    return `${missing.join(', ')}${sep}${body}`
  }

  if (inject?.fields) {
    for (const field of inject.fields) {
      const out = injectAfterLabel(body, field, missing)
      if (out) return out
    }
  }

  return `${missing.join(', ')}. ${body}`
}

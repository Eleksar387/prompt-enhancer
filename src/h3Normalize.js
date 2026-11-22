// Deterministic repair of a MiniMax H3 prompt's section structure, for small writer
// models (profile 'compact', src/modelProfiles.js) that emit the right sections in
// the wrong order, put "---" lines between them, or prepend a field of another mode.
// Pure text: no model call, never invents content. Correct input comes back
// byte-identical; text with no recognised field label comes back unchanged.

import { MINIMAX_H3_PRESERVE_OPTIONS } from './constants'

const ORDER = {
  Ref2VA: ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'],
  base: ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'],
}
const ALL_LABELS = [...new Set([...ORDER.Ref2VA, ...ORDER.base])]
// A label at the start of a line, optionally wrapped in markdown bold/heading marks.
const LABEL_RE = new RegExp(`^[ \\t]*(?:#+[ \\t]*)?(?:\\*\\*)?(${ALL_LABELS.join('|')})(?:\\*\\*)?[ \\t]*:(?:\\*\\*)?[ \\t]*`, 'i')
const NOISE_LINE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,}|```[a-z]*)[ \t]*$/

export function normalizeH3Sections(text, mode, { musicOff = false, refs = null } = {}) {
  if (!text || typeof text !== 'string') return text
  const order = mode === 'Ref2VA' ? ORDER.Ref2VA : ORDER.base
  const sections = new Map()      // label -> body lines (first occurrence wins)
  const preamble = []
  let cur = null                  // label being filled, or '_skip' for a discarded duplicate / foreign field
  let sawLabel = false
  for (const line of text.split('\n')) {
    const m = line.match(LABEL_RE)
    if (m) {
      sawLabel = true
      const label = m[1].toLowerCase()
      if (!order.includes(label) || sections.has(label)) { cur = '_skip'; continue }
      cur = label
      const rest = line.slice(m[0].length)
      sections.set(label, { inline: !!rest.trim(), lines: rest.trim() ? [rest] : [] })
      continue
    }
    if (NOISE_LINE.test(line)) continue
    if (cur === null) preamble.push(line)
    else if (cur !== '_skip') sections.get(cur).lines.push(line)
  }
  if (!sawLabel || !sections.size) return text

  const out = []
  // Base modes may open with an alignment line before the first label; Ref2VA has none.
  const pre = preamble.join('\n').trim()
  if (pre && mode !== 'Ref2VA') out.push(pre)
  for (const label of order) {
    if (!sections.has(label)) continue
    const sec = sections.get(label)
    let body = sec.lines.join('\n').trim()
    if (label === 'non_diegetic_music' && musicOff) body = 'N/A'
    if (mode === 'Ref2VA' && refs?.length) {
      if (label === 'subject_definitions') body = ensurePictureLines(body, refs, 'def')
      if (label === 'retention_analysis') body = ensurePictureLines(body, refs, 'ret')
    }
    // Keep the original shape: a field the writer opened on the label line stays inline.
    out.push(sec.inline || !body ? `${label}: ${body}`.trimEnd() : `${label}:\n${body}`)
  }
  return out.join('\n\n')
}


// ── reference coverage (Ref2VA) ─────────────────────────────────────────────
// A small writer tends to skip Location / Style / Pose images (they get no
// <Subject>, so they look optional) and to invent preservation markers. The app
// knows every reference's role and marker exactly, so: each such image is
// guaranteed a <Picture N> line in subject_definitions and retention_analysis,
// and the marker on those retention lines is forced to the image's own.
// Subject-bearing images (identity / wardrobe / product) are left to the writer,
// which may legitimately fold two of them into one <Subject>.
const PICTURE_ONLY = { environment: 'location', style: 'style', pose_composition: 'pose' }
const markerFor = (preserve) => (MINIMAX_H3_PRESERVE_OPTIONS.find(p => p.id === preserve) || MINIMAX_H3_PRESERVE_OPTIONS[1]).marker
const hintFor = (preserve) => (MINIMAX_H3_PRESERVE_OPTIONS.find(p => p.id === preserve) || MINIMAX_H3_PRESERVE_OPTIONS[1]).hint

function defLine(kind, n) {
  if (kind === 'location') return `<Picture ${n}> is the location reference, guiding the layout, setting and lighting of the place as shown in the reference image.`
  if (kind === 'style') return `<Picture ${n}> is the style reference, guiding the palette, lighting and look as shown in the reference image.`
  return `<Picture ${n}> is a storyboard reference, defining viewpoint, subject placement and shot order.`
}

function ensurePictureLines(body, refs, which) {
  const lines = body.split('\n')
  refs.forEach((r, i) => {
    const kind = PICTURE_ONLY[r.role]
    if (!kind) return
    const tag = `<Picture ${i + 1}>`
    const at = lines.findIndex(l => l.trimStart().startsWith(tag))
    if (which === 'def') {
      if (at === -1) lines.push(defLine(kind, i + 1))
      return
    }
    const marker = markerFor(r.preserve)
    if (at === -1) { lines.push(`${tag} (${kind} reference): ${marker} - ${hintFor(r.preserve)}.`); return }
    // Force the image's own marker onto the writer's line, keeping its reason.
    lines[at] = lines[at].replace(/^(\s*<Picture \d+>[^:\n]*:\s*)[A-Za-z_]+(\s+-\s)/, `$1${marker}$2`)
  })
  return lines.join('\n').trim()
}

// The user's Audience-only music note asks for no music at all.
export const musicIsOff = (music) => /^\s*(none|no music|silence|silent|kein(e)?( musik)?|n\/a)\s*\.?\s*$/i.test(music || '')

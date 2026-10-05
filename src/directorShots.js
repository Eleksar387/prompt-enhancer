// Pure parsing of a GENERATED MiniMax H3 prompt into what the Director timeline needs:
// the global style paragraph, one text per shot (with its time range) and the sound blocks —
// plus a cleaner that turns H3's own tags into the Director's syntax. The Director writes its
// own <Subject>/<Picture> declarations, speaker IDs and <d> tags from its timeline, so tags the
// writer already emitted would collide with its numbering. No React, no fetch.

const LABEL_RE = /^(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):[ \t]*/gim

/** Split an H3 prompt into its labelled fields. `N/A` sound blocks come back empty. */
export function parseH3Sections(text) {
  const src = String(text || '')
  const marks = []
  let m
  LABEL_RE.lastIndex = 0
  while ((m = LABEL_RE.exec(src))) marks.push({ key: m[1].toLowerCase(), at: m.index, bodyAt: m.index + m[0].length })
  const out = { detailed: '', soundscape: '', music: '' }
  marks.forEach((mk, i) => {
    const body = src.slice(mk.bodyAt, i + 1 < marks.length ? marks[i + 1].at : src.length).trim()
    if (mk.key === 'detailed_description' || mk.key === 'integrated_multimodal_description') out.detailed = body
    else if (mk.key === 'overall_soundscape') out.soundscape = /^n\/?a\.?$/i.test(body) ? '' : body
    else if (mk.key === 'non_diegetic_music') out.music = /^n\/?a\.?$/i.test(body) ? '' : body
  })
  // an unlabelled prompt is all description
  if (!marks.length) out.detailed = src.trim()
  return out
}

const SHOT_RE = /\[Shot\s+(\d+)\]\s*(?:\(\s*([\d.]+)\s*[–—-]\s*([\d.]+)\s*s?\s*\))?/gi
// the connective the writer leaves at the end of a shot before the next marker
const TRAILING_CUT_RE = /\s*(?:At\s+[\d:.]+\s*s?,?\s*)?(?:the\s+)?(?:(?:camera|shot|scene)\s+)?(?:cuts?|switch(?:es)?|changes?|moves?|jumps?)\s+to\s*$|\s*At\s+[\d:.]+\s*s?,?\s*$/i
const LEADING_RE = /^(?:[,:;\s]+|At\s+[\d:.]+\s*s?,\s*)+/i

/**
 * Text before `[Shot 1]` is the global paragraph; each `[Shot N] (a–bs)` block is a shot.
 * Shots without times are spread evenly over `totalSec`. No markers → one shot.
 */
export function splitShots(detailed, totalSec = 0) {
  const src = String(detailed || '')
  const found = []
  let m
  SHOT_RE.lastIndex = 0
  while ((m = SHOT_RE.exec(src))) {
    found.push({ n: Number(m[1]), start: m[2] != null ? Number(m[2]) : null, end: m[3] != null ? Number(m[3]) : null, at: m.index, bodyAt: m.index + m[0].length })
  }
  if (!found.length) return { global: '', shots: src.trim() ? [{ n: 1, startSec: 0, endSec: totalSec, text: src.trim() }] : [] }
  const global = src.slice(0, found[0].at).trim()
  const shots = found.map((f, i) => {
    let text = src.slice(f.bodyAt, i + 1 < found.length ? found[i + 1].at : src.length)
    text = text.replace(TRAILING_CUT_RE, '').replace(LEADING_RE, '').trim()
    return { n: f.n, startSec: f.start, endSec: f.end, text }
  })
  // fill / normalise the times so the shots tile [0, total] with no gaps
  const total = totalSec || shots.reduce((mx, s) => Math.max(mx, s.endSec || 0), 0)
  shots.forEach((s, i) => {
    if (s.startSec == null) s.startSec = i === 0 ? 0 : shots[i - 1].endSec ?? (total * i) / shots.length
    if (s.endSec == null) s.endSec = i + 1 < shots.length && shots[i + 1].startSec != null ? shots[i + 1].startSec : (total * (i + 1)) / shots.length
  })
  shots[0].startSec = 0
  for (let i = 1; i < shots.length; i++) shots[i].startSec = shots[i - 1].endSec
  if (total) shots[shots.length - 1].endSec = total
  return { global, shots: shots.filter(s => s.text) }
}

const capitalise = (s) => s.replace(/^(\s*)([a-z])/, (_, sp, c) => sp + c.toUpperCase())

/**
 * H3 tags → Director syntax for ONE shot's text.
 * @param {(M:number)=>number|null} subjectSlotOf  writer `<Subject M>` → Director 1-based slot
 * @param {(sNum:number|null)=>string} speakerRef  writer speaker id (S1…) → `@refK` / `@voice(…)`
 */
export function cleanShotText(text, { subjectSlotOf = () => null, speakerRef = () => '@voice(a speaker)' } = {}) {
  let t = String(text || '')

  // 1) lift each `[Lang] "…"` sentence into its own `@ref` line, keeping its place in the text
  t = t.replace(/([^.!?\n]*?)\[([A-Za-z][A-Za-z ]*)\]\s*["“]([^"”]+)["”][.!?]?/g, (all, prefix, lang, quote) => {
    const s = prefix.match(/\(S(\d+)\)/)
    const delivery = prefix.match(/^[\s\S]*\bin (?:an?|the) ([^()]*?\b(?:voice|tone)\b[^,()]*)/i)
    const how = delivery ? `says in ${/^[aeiou]/i.test(delivery[1]) ? 'an' : 'a'} ${delivery[1].trim()}` : 'says'
    return `\n${speakerRef(s ? Number(s[1]) : null)} [${lang.trim()}] ${how}: ${quote.trim()}\n`
  })

  // 2) phrases that only exist to point at a <Picture N> (the Director declares those itself)
  t = t.replace(/(?:^|(?<=[.!?]\s)|(?<=\n))\s*The\s+(?:shot'?s?\s+)?(?:framing|keyframe|shot|composition|storyboard)[^.<:\n]*?<Picture\s*\d+>(?:\s*(?:,|and)\s*<Picture\s*\d+>)*\s*[:.]?\s*/gi, '')
  t = t.replace(/\s*<Picture\s*\d+>/g, ' the reference')

  // 3) speaker markers, then the subject tags
  t = t.replace(/\s*\(S\d+\)/g, '')
  t = t.replace(/<Subject\s*(\d+)>/g, (_, n) => {
    const slot = subjectSlotOf(Number(n))
    return slot ? `@ref${slot}` : 'the subject'
  })

  // tidy: one line per paragraph, no doubled spaces / orphan punctuation
  return t.split('\n').map(l => capitalise(l.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').replace(/^[.,;:\s]+/, '').trim())).filter(Boolean).join('\n')
}

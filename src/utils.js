import { CAMERA_GROUPS } from './constants'

export const presetById = (id, presets) => presets.find(p => p.id === id)

export const snap32 = (n) => Math.round(n / 32) * 32

export const btn = (active) => ({
  padding: '6px 14px', borderRadius: 6, border: '1px solid',
  borderColor: active ? '#7c6af7' : '#333',
  background: active ? '#2d2060' : '#1a1a2e',
  color: active ? '#c4b8ff' : '#888',
  fontSize: 12, cursor: 'pointer', transition: 'all 0.15s',
})

export const selStyle = {
  width: '100%', boxSizing: 'border-box', background: '#12121f',
  border: '1px solid #2e2e44', borderRadius: 8, padding: '9px 12px',
  color: '#e0e0f0', fontSize: 13, outline: 'none', cursor: 'pointer',
}

export const moveLabel = (id) =>
  CAMERA_GROUPS.flatMap(g => g.moves).find(m => m.id === id)?.label || id

export function recommendRes(nw, nh, presets) {
  const r = nw / nh
  let best = null, bestScore = Infinity
  for (const p of presets) {
    const aspectDiff = Math.abs(Math.log(r / p.ratio))
    const cropW = r > p.ratio ? nh * p.ratio : nw
    const upscale = p.w > cropW + 1
    let score = aspectDiff * 100 + (upscale ? 10 : 0)
    score += upscale ? p.w * 1e-5 : -p.w * 1e-5
    if (score < bestScore) { bestScore = score; best = p }
  }
  return best.id
}

export function ratioLabel(r) {
  const known = [[16/9,'16:9'],[9/16,'9:16'],[3/2,'3:2'],[2/3,'2:3'],[4/3,'4:3'],[3/4,'3:4'],[1,'1:1'],[21/9,'21:9'],[5/4,'5:4']]
  let best = '', d = Infinity
  for (const [v, l] of known) { const diff = Math.abs(Math.log(r / v)); if (diff < d) { d = diff; best = l } }
  return best
}

// Rough syllable estimate for English/German dialogue text — counts vowel-sound
// clusters per word (incl. umlauts), with a light adjustment for a silent English
// trailing "e" ("large", not "little"). Good enough for a live budget counter, not
// a real phonetic count.
export function estimateSyllables(text) {
  const words = (text || '').toLowerCase().match(/[a-zà-öø-ÿ']+/gi) || []
  let total = 0
  for (const w of words) {
    const groups = w.match(/[aeiouyäöü]+/g) || []
    let n = groups.length
    if (n > 1 && /[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) n -= 1
    total += Math.max(1, n)
  }
  return total
}

// Very rough English/German detector — just enough to pick which SPS budget
// below applies, not a real language ID.
export function looksGerman(text) {
  if (/[äöüß]/i.test(text || '')) return true
  const words = (text || '').toLowerCase().match(/[a-zà-öø-ÿ']+/gi) || []
  if (!words.length) return false
  const markers = new Set(['der','die','das','und','ist','nicht','ich','du','wir','ein','eine','einen',
    'sie','mit','sich','auf','wird','war','hat','haben','uns','euch','müssen','sofort','jetzt','kein','keine'])
  return words.filter(w => markers.has(w)).length / words.length > 0.15
}

// Practical speech-time budget for spoken dialogue in a video-generation prompt.
// Natural human speech runs ~4-6+ syllables/sec, but video models need slack for
// pacing buffers (lead-in, reaction beats, mouth-shape transitions) — recommended
// budget is ~2.5-3.0 syll/s for English, ~2.0-2.5 syll/s for German (longer
// compound words need fewer syllables to say the same thing). Usable speech time
// assumes ~1.5s of a clip goes to pre/post-roll, not spoken words.
export function syllableBudget(durationValue, text) {
  const m = String(durationValue || '').match(/(\d+(?:\.\d+)?)\s*seconds?/)
  const seconds = m ? parseFloat(m[1]) : null
  const german = looksGerman(text)
  const [spsLo, spsHi] = german ? [2.0, 2.5] : [2.5, 3.0]
  const count = estimateSyllables(text)
  if (seconds == null) return { count, seconds: null, german, spsLo, spsHi, min: null, max: null }
  const usable = Math.max(0, seconds - 1.5)
  return { count, seconds, german, spsLo, spsHi, min: Math.round(usable * spsLo), max: Math.round(usable * spsHi) }
}

import { CAMERA_GROUPS, spokenLangDef } from './constants'

// public-domain cyrb53 (Bryc) — fast 53-bit non-crypto string hash, base-36 out.
// Used only for cache keys, never security.
// NOTE: cyrb53 + imageHash are copied byte-identical into `server/hash.mjs` (the
// sidecar keys blob files by imageHash(base64)). Keep the two in sync or blob
// dedupe and the vision-caption cache silently break.
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

// Content fingerprint of an image's base64 payload. Length-prefixed to cut
// collisions further. Stable for byte-identical bytes across reload / restore /
// re-upload of the same source file (same browser build).
export const imageHash = (base64) => `${base64.length.toString(36)}-${cyrb53(base64)}`

// Cache key for one vision call. Folds in the model, the system prompt, and each
// content block positionally (text hashed, images content-hashed) so it
// auto-invalidates on any model / prompt / scene / role / frame-order / bytes
// change. Vision temperature is fixed at 0.3 everywhere, folded in as a literal.
export function visionCacheKey(model, system, content) {
  const parts = content.map(b =>
    b.type === 'text' ? `t:${cyrb53(b.text || '')}` : `i:${imageHash(b.source.data)}`)
  return `v2|t0.3|${model}|s:${cyrb53(system || '')}|${parts.join('|')}`
}

// Run `fn(item, i)` over `items` with at most `limit` promises in flight at
// once, keeping results in input order. Rejects on the first error, like
// Promise.all. `limit <= 1` runs everything strictly sequentially — needed for
// vision calls against a local Ollama, whose parallel slots cross-contaminate
// concurrent multimodal (image) requests so two references get a blended
// description. Cloud providers handle concurrent requests independently, so the
// caller passes a higher limit for those.
export async function mapWithConcurrency(items, limit, fn) {
  const list = items || []
  const results = new Array(list.length)
  const workers = Math.max(1, Math.min(limit || 1, list.length))
  let next = 0
  const run = async () => {
    while (next < list.length) {
      const i = next++
      results[i] = await fn(list[i], i)
    }
  }
  await Promise.all(Array.from({ length: workers }, run))
  return results
}

// Fetch a blob URL (e.g. the sidecar's /api/blob/<hash>) and return just its
// base64 payload — the shape the image panels / vision / ComfyUI paths expect.
// History rows no longer carry image bytes inline, so drag/pick from the history
// gallery resolves them on demand through here.
export function blobUrlToBase64(url) {
  return fetch(url)
    .then((r) => { if (!r.ok) throw new Error(`blob fetch ${r.status}`); return r.blob() })
    .then((blob) => new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '')
      fr.onerror = () => reject(fr.error || new Error('read failed'))
      fr.readAsDataURL(blob)
    }))
}

// Re-encode an image to a bounded-size JPEG via canvas. `src` may be a Blob, a
// data/object URL string, or an already-loaded HTMLImageElement. Clamps the
// longest edge to `maxPx`, encodes at `quality`, and drops to 0.7 if the result
// is still over ~4 MB. Resolves { base64, mediaType, width, height }.
export function shrinkToJpeg(src, maxPx = 1536, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const encode = (img, revokeUrl) => {
      try {
        let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height
        if (w > maxPx || h > maxPx) {
          if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx }
          else { w = Math.round(w * maxPx / h); h = maxPx }
        }
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        let dataUrl = canvas.toDataURL('image/jpeg', quality)
        if (dataUrl.length * 0.75 > 4 * 1024 * 1024) dataUrl = canvas.toDataURL('image/jpeg', 0.7)
        resolve({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', width: w, height: h })
      } catch (e) { reject(e) }
      finally { if (revokeUrl) URL.revokeObjectURL(revokeUrl) }
    }
    if (src instanceof HTMLImageElement && src.complete) return encode(src, null)
    const objUrl = src instanceof Blob ? URL.createObjectURL(src) : src
    const img = new Image()
    img.onload = () => encode(img, src instanceof Blob ? objUrl : null)
    img.onerror = () => { if (src instanceof Blob) URL.revokeObjectURL(objUrl); reject(new Error('Image failed to decode')) }
    img.src = objUrl
  })
}

export const presetById = (id, presets) => presets.find(p => p.id === id)

export const snap32 = (n) => Math.round(n / 32) * 32

export const btn = (active) => ({
  padding: '9px 15px', borderRadius: 8, border: '1px solid',
  borderColor: active ? 'var(--pe-accent-line)' : 'var(--pe-line)',
  background: active ? 'var(--pe-accent-bg)' : 'var(--pe-surface)',
  color: active ? 'var(--pe-accent-ink)' : 'var(--pe-ink-2)',
  fontSize: 15, fontWeight: active ? 600 : 500, cursor: 'pointer', transition: 'all 0.12s',
})

export const selStyle = {
  width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)',
  border: '1px solid var(--pe-line)', borderRadius: 8, padding: '11px 12px',
  color: 'var(--pe-ink)', fontSize: 15, outline: 'none', cursor: 'pointer',
}

// Section label — the small upper-case caption above a control group.
export const lbl = {
  fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block',
  marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em',
}

// Inline "· note" text that trails a label (not upper-case, muted).
export const lblNote = { color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }

// Muted helper paragraph under a control.
export const hint = { fontSize: 14, color: 'var(--pe-ink-3)', lineHeight: 1.5 }

// A white grouping card.
export const card = {
  background: 'var(--pe-surface)', border: '1px solid var(--pe-line)',
  borderRadius: 12, padding: 20,
}

// A textarea in the compose column.
export const taStyle = {
  width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)',
  border: '1px solid var(--pe-line)', borderRadius: 8, padding: '13px 15px',
  color: 'var(--pe-ink)', fontSize: 15, resize: 'vertical', outline: 'none',
  lineHeight: 1.6, transition: 'border-color 0.15s', fontFamily: 'var(--pe-mono)',
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
// budget per language lives in SPOKEN_LANGUAGES (`sps`) — roughly 2.5-3.0 syll/s
// for English, 2.0-2.5 for German (longer compound words need fewer syllables to
// say the same thing). Usable speech time assumes ~1.5s of a clip goes to
// pre/post-roll, not spoken words.
//
// `langId` is the user's explicit spoken-language pick and wins when given; with
// no pick we fall back to guessing from the text, which is what every caller did
// before the picker existed. When the picked language differs from the language
// the text is written in, the count is only indicative — the writer translates
// the line before it is spoken.
export function syllableBudget(durationValue, text, langId = null) {
  const m = String(durationValue || '').match(/(\d+(?:\.\d+)?)\s*seconds?/)
  const seconds = m ? parseFloat(m[1]) : null
  const def = langId ? spokenLangDef(langId) : null
  const german = def ? def.id === 'de' : looksGerman(text)
  const [spsLo, spsHi] = def ? def.sps : (german ? [2.0, 2.5] : [2.5, 3.0])
  const langLabel = def ? def.label : (german ? 'German' : 'English')
  const count = estimateSyllables(text)
  const base = { count, german, langLabel, spsLo, spsHi }
  if (seconds == null) return { ...base, seconds: null, min: null, max: null }
  const usable = Math.max(0, seconds - 1.5)
  return { ...base, seconds, min: Math.round(usable * spsLo), max: Math.round(usable * spsHi) }
}

// Pure helpers for spoken dialogue in an H3 prompt: `<d>[Language] words</d>` (the older `[Language] "…"` form is still recognised so restored history keeps its tint).
export const H3_LANG_TAGS = ['Arabic', 'Chinese', 'English', 'French', 'German', 'Italian', 'Japanese', 'Korean', 'Portuguese', 'Russian', 'Spanish']

const DIALOGUE_RE = new RegExp(`<d>\\s*\\[(?:${H3_LANG_TAGS.join('|')})\\][^<]*</d>|\\[(?:${H3_LANG_TAGS.join('|')})\\]\\s*(?:"[^"]*"|“[^”]*”)`, 'g')

// Split text into [{ text, dialogue }] segments (concatenating them gives back `text`).
export function splitDialogue(text) {
  const s = String(text || '')
  const out = []
  let last = 0
  for (const m of s.matchAll(DIALOGUE_RE)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), dialogue: false })
    out.push({ text: m[0], dialogue: true })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ text: s.slice(last), dialogue: false })
  return out
}

// H3 has no cross-cut dialogue syntax we rely on; drop the tags a writer may still emit.
export function stripCrossCutTags(text) {
  if (typeof text !== 'string') return text
  return text.replace(/[ \t]*<(?:scenetrans|cutoff)>[ \t]*/gi, ' ').replace(/ {2,}/g, ' ').replace(/ ([,.;])/g, '$1')
}

const SPEECH_CUE = /talk|explain|speak|spoke|say|says|narrat|monolog|discuss|dialog|chat|tell/i
export const sceneRequestsSpeech = (scene) => SPEECH_CUE.test(scene || '')

// words that fit, from a syllableBudget() result (~1.4 syllables per word)
export function wordBudget(b) {
  if (!b || b.min == null) return null
  return [Math.max(1, Math.round(b.min / 1.4)), Math.max(1, Math.round(b.max / 1.4))]
}

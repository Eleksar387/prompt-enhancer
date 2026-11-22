// Parses the Story step's reply: three numbered options ("1. TITLE\n lines…").
// Falls back to ONE option holding the whole text when the numbering is missing,
// so a model that ignores the format still gives the user something usable.
export function parseStoryOptions(text) {
  const t = String(text || '').replace(/^```[a-z]*\n?|```$/gim, '').trim()
  if (!t) return []
  const parts = t.split(/^\s*(?=[1-9][.)]\s)/m).map(x => x.trim()).filter(Boolean)
  const opts = parts
    .filter(x => /^[1-9][.)]\s/.test(x))
    .map(x => x.replace(/^[1-9][.)]\s*/, '').trim())
    .filter(Boolean)
  return opts.length >= 2 ? opts.slice(0, 3) : [t]
}

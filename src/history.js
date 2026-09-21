// Pure helpers for reading a saved history entry.
//
// Moved out of App.jsx so both App (which filters the list) and HistoryPanel
// (which renders it) can use them without one importing the other, and so they
// can be unit-tested. Every one of these has to cope with entries saved by older
// versions of the app: a legacy entry may store an image as a bare filename
// string instead of an object, may have no `project` key at all, and a
// scriptwriter entry has a completely different shape from a standard one. None
// of them may throw on a shape they don't recognise.

import { TARGETS } from './constants'

// A scriptwriter entry has no `target`; it is identified by `type`.
export const entryTargetId = (h) => (h.type === 'scriptwriter' ? 'scriptwriter' : h.target)

export const entryTargetLabel = (id) => (id === 'scriptwriter' ? 'Scriptwriter' : TARGETS[id]?.label || id)

export const entryHasImages = (h) => !!(
  h.firstImg || h.midImg || h.lastImg ||
  (Array.isArray(h.refImages) && h.refImages.length) ||
  h.vision
)

// Flattened, lowercased text of one history entry for the free-text search box.
// Skips image bytes; covers the scene, vision caption, generated output(s),
// project, model and target label (and the scriptwriter's idea / script / shots).
export const entrySearchText = (h) => {
  const parts = [h.project, h.model, entryTargetLabel(entryTargetId(h))]
  if (h.type === 'scriptwriter') {
    parts.push(h.idea, h.script?.title, h.script?.logline, h.script?.look)
    for (const c of h.script?.characters || []) parts.push(c.name, c.appearance, c.wardrobe)
    for (const l of h.script?.locations || []) parts.push(l.name, l.description)
    parts.push(JSON.stringify(h.script?.scenes || ''), JSON.stringify(h.directorsCut?.shots || ''))
    for (const p of h.finalPrompts || []) parts.push(p.text, p.sceneTitle)
    for (const im of h.refImages || []) parts.push(im.note, im.caption)
  } else {
    parts.push(h.scene, h.caption, h.negative, h.dialogue, h.style)
    for (const o of h.outputs || []) parts.push(o.text, o.label)
  }
  return parts.filter(Boolean).join('  ').toLowerCase()
}

export const modelProvider = (m) => {
  const s = (m || '').toLowerCase()
  if (!s) return '—'
  // MiniMax H3 Manual mode's sentinel model label (src/manualH3.js) — no
  // provider actually ran, so it must not read as "Ollama".
  if (s === 'manual') return 'Manual'
  // The "✍ Manual Prompt" settings-derived template button (src/manualH3.js's
  // buildH3Template) — also no provider ran, and distinct from raw-tag
  // Manual mode above so the two are filterable separately in History.
  if (s === 'template') return 'Template'
  if (s.includes('claude') || s.includes('anthropic')) return 'Claude'
  if (s.includes('grok')) return 'Grok'
  // OpenRouter model ids are always provider-prefixed (`openai/gpt-4o`, `google/gemini-…`);
  // an Ollama tag never contains a slash, so this is a safe way to tell them apart without
  // threading cfg.base through here.
  if (s.includes('/')) return 'OpenRouter'
  return 'Ollama'
}

export const modelFilterLabel = (m) => `${modelProvider(m)} · ${m}`

// The five independent, AND-combined list filters. `all` means "don't filter".
export const HISTORY_FILTER_DEFAULTS = {
  project: 'all', target: 'all', model: 'all', image: 'all', search: '',
}

export const historyFiltersActive = (f) => (
  f.project !== 'all' || f.target !== 'all' || f.model !== 'all' || f.image !== 'all' || f.search.trim() !== ''
)

// One entry against the filter set. `getSearchText(h)` is injected rather than
// computed here, and called only when there is actually something to search for:
// building the haystack is the expensive part (a scriptwriter entry
// JSON.stringifies its scenes and shots), and the caller caches it per entry.
export const entryMatchesFilters = (h, f, getSearchText) => {
  if (f.project === 'unfiled' && h.project) return false
  if (f.project !== 'all' && f.project !== 'unfiled' && h.project !== f.project) return false
  if (f.target !== 'all' && entryTargetId(h) !== f.target) return false
  if (f.model !== 'all' && h.model !== f.model) return false
  if (f.image === 'with' && !entryHasImages(h)) return false
  if (f.image === 'without' && entryHasImages(h)) return false
  const terms = f.search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length) {
    const hay = getSearchText(h) || ''
    if (!terms.every(t => hay.includes(t))) return false
  }
  return true
}

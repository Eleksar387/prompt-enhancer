// History entry reading and list filtering.
//
// These helpers used to be inline in App.jsx (the filter predicate was a
// six-branch `if` chain inside a useMemo). They were moved into src/history.js so
// both App and HistoryPanel could share them — which means the filter semantics
// were rewritten, and this file is what pins them to the old behaviour: 'all'
// means don't filter, 'unfiled' means no project, search terms are
// whitespace-split and ALL must match, and every helper has to survive a legacy
// entry shape (an image stored as a bare filename string, no project key at all,
// a scriptwriter entry with no `target`).

import { describe, it, expect, vi } from 'vitest'
import {
  entryTargetId, entryTargetLabel, entryHasImages, entrySearchText,
  modelProvider, modelFilterLabel,
  HISTORY_FILTER_DEFAULTS, historyFiltersActive, entryMatchesFilters,
} from '../src/history.js'

const std = (over = {}) => ({
  id: 'e1', ts: 1000, type: 'standard', target: 'minimax_h3', model: 'qwen2.5:14b',
  scene: 'A woman at a window', project: 'Film A', outputs: [{ label: 'q', text: 'a cinematic shot' }],
  ...over,
})
const script = (over = {}) => ({
  id: 's1', ts: 2000, type: 'scriptwriter', model: 'claude-opus-5', idea: 'a heist gone wrong',
  script: { title: 'Nightfall', characters: [{ name: 'Anna' }], scenes: [{ id: 1, title: 'Rooftop' }] },
  ...over,
})

const filters = (over = {}) => ({ ...HISTORY_FILTER_DEFAULTS, ...over })
const matches = (h, f) => entryMatchesFilters(h, filters(f), entrySearchText)

describe('entryTargetId / entryTargetLabel', () => {
  it('reads a standard entry from its target', () => {
    expect(entryTargetId(std())).toBe('minimax_h3')
    expect(entryTargetLabel('minimax_h3')).toBe('MiniMax H3 · Video')
  })

  it('identifies a scriptwriter entry by type, not target', () => {
    expect(entryTargetId(script())).toBe('scriptwriter')
    expect(entryTargetLabel('scriptwriter')).toBe('Scriptwriter')
  })

  it('falls back to the raw id for a target that no longer exists', () => {
    expect(entryTargetLabel('retired_model')).toBe('retired_model')
  })
})

describe('entryHasImages', () => {
  it('is true for any frame slot, a ref image, or a vision model', () => {
    expect(entryHasImages(std({ firstImg: { url: '/api/blob/x' } }))).toBe(true)
    expect(entryHasImages(std({ midImg: { url: '/x' } }))).toBe(true)
    expect(entryHasImages(std({ lastImg: { url: '/x' } }))).toBe(true)
    expect(entryHasImages(std({ refImages: [{ url: '/x' }] }))).toBe(true)
    expect(entryHasImages(std({ vision: 'llava' }))).toBe(true)
  })

  it('is false with no image input at all', () => {
    expect(entryHasImages(std())).toBe(false)
    expect(entryHasImages(std({ refImages: [] }))).toBe(false)
  })

  it('accepts a legacy filename-string image', () => {
    expect(entryHasImages(std({ firstImg: 'photo.jpg' }))).toBe(true)
  })
})

describe('entrySearchText', () => {
  it('covers a standard entry’s scene, caption, negative, dialogue and outputs', () => {
    const hay = entrySearchText(std({ caption: 'RAINY WINDOW', negative: 'watermark', dialogue: 'Go now' }))
    for (const term of ['a woman at a window', 'rainy window', 'watermark', 'go now', 'a cinematic shot', 'film a']) {
      expect(hay).toContain(term)
    }
  })

  it('covers a scriptwriter entry’s idea, title, cast and scenes', () => {
    const hay = entrySearchText(script())
    expect(hay).toContain('a heist gone wrong')
    expect(hay).toContain('nightfall')
    expect(hay).toContain('anna')
    expect(hay).toContain('rooftop')   // reached via JSON.stringify of scenes
  })

  it('is lowercased and skips empty fields', () => {
    expect(entrySearchText({ id: 'x', model: 'QWEN' })).not.toMatch(/[A-Z]/)
  })

  it('survives an entry with almost nothing on it', () => {
    expect(() => entrySearchText({ id: 'x' })).not.toThrow()
    expect(() => entrySearchText({ id: 'x', type: 'scriptwriter' })).not.toThrow()
  })
})

describe('modelProvider / modelFilterLabel', () => {
  it('classifies by substring', () => {
    expect(modelProvider('claude-opus-5')).toBe('Claude')
    expect(modelProvider('anthropic/whatever')).toBe('Claude')
    expect(modelProvider('grok-4')).toBe('Grok')
    expect(modelProvider('x-ai/grok-4')).toBe('Grok')
    expect(modelProvider('openai/gpt-4o')).toBe('OpenRouter')
    expect(modelProvider('google/gemini-2.5-flash')).toBe('OpenRouter')
    expect(modelProvider('qwen2.5:14b')).toBe('Ollama')
    expect(modelProvider('')).toBe('—')
    expect(modelProvider(undefined)).toBe('—')
  })

  it('labels as provider · model', () => {
    expect(modelFilterLabel('grok-4')).toBe('Grok · grok-4')
  })
})

describe('historyFiltersActive', () => {
  it('is false for the defaults', () => {
    expect(historyFiltersActive(HISTORY_FILTER_DEFAULTS)).toBe(false)
  })

  it('is true as soon as any one filter moves', () => {
    expect(historyFiltersActive(filters({ project: 'Film A' }))).toBe(true)
    expect(historyFiltersActive(filters({ target: 'sdxl' }))).toBe(true)
    expect(historyFiltersActive(filters({ model: 'grok-4' }))).toBe(true)
    expect(historyFiltersActive(filters({ image: 'with' }))).toBe(true)
    expect(historyFiltersActive(filters({ search: 'window' }))).toBe(true)
  })

  it('ignores a whitespace-only search', () => {
    expect(historyFiltersActive(filters({ search: '   ' }))).toBe(false)
  })
})

describe('entryMatchesFilters', () => {
  it('passes everything with the defaults', () => {
    expect(matches(std())).toBe(true)
    expect(matches(script())).toBe(true)
  })

  describe('project', () => {
    it('matches an exact name', () => {
      expect(matches(std(), { project: 'Film A' })).toBe(true)
      expect(matches(std(), { project: 'Film B' })).toBe(false)
    })

    it('"unfiled" excludes anything with a project', () => {
      expect(matches(std(), { project: 'unfiled' })).toBe(false)
      expect(matches(std({ project: null }), { project: 'unfiled' })).toBe(true)
      expect(matches({ id: 'x', ts: 1 }, { project: 'unfiled' })).toBe(true)   // no project key at all
    })
  })

  describe('target', () => {
    it('matches the resolved target id, including scriptwriter', () => {
      expect(matches(std(), { target: 'minimax_h3' })).toBe(true)
      expect(matches(std(), { target: 'sdxl' })).toBe(false)
      expect(matches(script(), { target: 'scriptwriter' })).toBe(true)
      expect(matches(script(), { target: 'minimax_h3' })).toBe(false)
    })
  })

  describe('model', () => {
    it('matches the exact model string, not the provider', () => {
      expect(matches(std(), { model: 'qwen2.5:14b' })).toBe(true)
      expect(matches(std(), { model: 'qwen2.5' })).toBe(false)
    })
  })

  describe('image', () => {
    const withImg = std({ firstImg: { url: '/x' } })
    it('with / without split the list', () => {
      expect(matches(withImg, { image: 'with' })).toBe(true)
      expect(matches(withImg, { image: 'without' })).toBe(false)
      expect(matches(std(), { image: 'with' })).toBe(false)
      expect(matches(std(), { image: 'without' })).toBe(true)
    })
  })

  describe('search', () => {
    it('is a substring match, case-insensitive', () => {
      expect(matches(std(), { search: 'WINDOW' })).toBe(true)
      expect(matches(std(), { search: 'bicycle' })).toBe(false)
    })

    it('ANDs whitespace-split terms', () => {
      expect(matches(std(), { search: 'woman window' })).toBe(true)
      expect(matches(std(), { search: 'woman bicycle' })).toBe(false)
    })

    it('collapses extra whitespace rather than searching for empty terms', () => {
      expect(matches(std(), { search: '  woman   window  ' })).toBe(true)
    })

    it('never builds the haystack when there is nothing to search for', () => {
      const getText = vi.fn(() => '')
      entryMatchesFilters(std(), filters({ project: 'Film A' }), getText)
      expect(getText).not.toHaveBeenCalled()
      entryMatchesFilters(std(), filters({ search: 'x' }), getText)
      expect(getText).toHaveBeenCalledOnce()
    })
  })

  it('ANDs the criteria together', () => {
    const h = std({ firstImg: { url: '/x' } })
    expect(matches(h, { project: 'Film A', target: 'minimax_h3', image: 'with', search: 'woman' })).toBe(true)
    expect(matches(h, { project: 'Film A', target: 'minimax_h3', image: 'without', search: 'woman' })).toBe(false)
  })
})

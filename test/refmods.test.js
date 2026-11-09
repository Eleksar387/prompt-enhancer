// RefMod library handling — a parallel, simpler system to loras.js (no kind,
// and — unlike LoRA — no trigger word: RefMod has none).
// Mirrors test/loras.test.js's structure minus every kind/trigger-specific case.

import { describe, it, expect } from 'vitest'
import {
  sanitizeRefMods, refModHasFile, normalizeRefModFile,
  refModsByIds, targetTakesRefMods, refModInstruction, refModManifestEntries,
} from '../src/refmods.js'
import { TARGETS } from '../src/constants.js'

const R = [
  { id: 'a', name: 'Chrome Visor', note: 'chrome visor helmet look', file: 'armor/chromevisor', strength: 0.8 },
]

describe('sanitizeRefMods', () => {
  it('fills defaults and coerces strength', () => {
    const [r] = sanitizeRefMods([{ id: 'x' }])
    expect(r).toEqual({ id: 'x', name: '', note: '', file: '', strength: 1 })
  })
  it('drops entries without an id', () => {
    expect(sanitizeRefMods([{ name: 'no id' }])).toEqual([])
  })
  it('coerces a numeric-string strength', () => {
    expect(sanitizeRefMods([{ id: 'x', strength: '0.4' }])[0].strength).toBe(0.4)
  })
  it('returns [] for non-array input', () => {
    expect(sanitizeRefMods(null)).toEqual([])
    expect(sanitizeRefMods(undefined)).toEqual([])
  })
})

describe('refModHasFile', () => {
  it('requires a non-empty file', () => {
    expect(refModHasFile(R[0])).toBe(true)
    expect(refModHasFile({ id: 'x', file: '' })).toBe(false)
  })
})

describe('normalizeRefModFile', () => {
  it('equates backslash and forward-slash separators', () => {
    expect(normalizeRefModFile('armor\\chromevisor')).toBe(normalizeRefModFile('armor/chromevisor'))
  })
  it('is case-insensitive and trims whitespace', () => {
    expect(normalizeRefModFile('  Armor/ChromeVisor  ')).toBe('armor/chromevisor')
  })
  it('returns empty string for empty/undefined input', () => {
    expect(normalizeRefModFile('')).toBe('')
    expect(normalizeRefModFile(undefined)).toBe('')
  })
})

describe('refModsByIds', () => {
  const lib = [...R, { id: 'b', name: 'Blank', file: '' }]
  it('has no usable gate — a file-less RefMod is still returned', () => {
    expect(refModsByIds(lib, ['a', 'b']).map(r => r.id)).toEqual(['a', 'b'])
  })
  it('ignores an id with no matching entry', () => {
    expect(refModsByIds(lib, ['a', 'missing']).map(r => r.id)).toEqual(['a'])
  })
})

describe('targetTakesRefMods', () => {
  it('is true only for minimax_h3, false for every other target', () => {
    for (const id of Object.keys(TARGETS)) {
      expect(targetTakesRefMods(id)).toBe(id === 'minimax_h3')
    }
  })
})

describe('refModInstruction', () => {
  it('is empty with none active', () => {
    expect(refModInstruction([], 'minimax_h3')).toBe('')
  })
  it('is empty on a target that has not opted in', () => {
    expect(refModInstruction(R, 'flux')).toBe('')
  })
  it('still fires when the active RefMod has no note — the real-world regression case', () => {
    // An empty-note RefMod used to get ZERO writer guidance at all, so the
    // writer invented a fully generic, unrelated physical description for
    // whatever it was supposed to represent. It must say "don't invent"
    // regardless of whether a note was ever typed in.
    const out = refModInstruction([{ id: 'x', name: '', note: '', file: 'f', strength: 1 }], 'minimax_h3')
    expect(out).not.toBe('')
    expect(out).toContain('do NOT invent')
    expect(out).toContain('general, neutral terms')
    expect(out).toContain('this generation\'s subject')
  })
  it('names what the RefMod represents, with no token/trigger wording', () => {
    const out = refModInstruction(R, 'minimax_h3')
    expect(out).toContain('chrome visor helmet look')
    expect(out).toContain('no activation word, trigger token')
    expect(out).not.toContain('trigger tokens')
  })
  it('falls back to the RefMod\'s own name when no subject is set', () => {
    const out = refModInstruction(R, 'minimax_h3')
    expect(out).toMatch(/^- Chrome Visor — represents: chrome visor helmet look$/m)
  })
  it('attributes the note to a named subject once r.subject is set, overriding name', () => {
    const withSubject = [{ ...R[0], subject: 'Mara' }]
    const out = refModInstruction(withSubject, 'minimax_h3')
    expect(out).toContain('Mara — represents: chrome visor helmet look')
  })
})

describe('RefMod files for the ComfyUI bridge', () => {
  const lib = sanitizeRefMods([
    { id: 'a', name: 'A', file: ' armor/chromevisor ', strength: '0.6' },
    { id: 'b', name: 'B', file: 'characters/mara' },
    { id: 'c', name: 'NoFile' },
    { id: 'd', name: 'Dup', file: 'armor/chromevisor' },
  ])

  it('sanitizeRefMods defaults file to "" and strength to 1', () => {
    expect(lib[2].file).toBe('')
    expect(lib[2].strength).toBe(1)
    expect(lib[0].strength).toBe(0.6)
    expect(refModHasFile(lib[2])).toBe(false)
  })

  it('exports file-bearing entries only, in id order, deduped by file, trimmed', () => {
    expect(refModManifestEntries(lib, ['a', 'c', 'b', 'd'])).toEqual([
      { file: 'armor/chromevisor', strength: 0.6 },
      { file: 'characters/mara', strength: 1 },
    ])
  })

  it('caps at 3 slots', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, file: `f${i}`, strength: 1 }))
    expect(refModManifestEntries(many, many.map(m => m.id))).toHaveLength(3)
  })
})

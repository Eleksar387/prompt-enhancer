// RefMod library handling — a parallel, simpler system to loras.js (no kind,
// and — unlike LoRA — no trigger word: RefMod has none).
// Mirrors test/loras.test.js's structure minus every kind/trigger-specific case.

import { describe, it, expect } from 'vitest'
import {
  refModVoiceKey, buildAudioBlock,
  sanitizeRefMods, refModHasFile, normalizeRefModFile,
  refModsByIds, targetTakesRefMods, refModInstruction, refModManifestEntries,
  refModHasLook, refModCanonBlock, describeRefModImage,
  selectRefMods, refModLabels, refModReferenceLines,
} from '../src/refmods.js'
import { TARGETS } from '../src/constants.js'

const R = [
  { id: 'a', name: 'Chrome Visor', note: 'chrome visor helmet look', file: 'armor/chromevisor', strength: 0.8 },
]

describe('sanitizeRefMods', () => {
  it('fills defaults and coerces strength', () => {
    const [r] = sanitizeRefMods([{ id: 'x' }])
    expect(r).toEqual({ id: 'x', name: '', note: '', description: '', role: 'subject_identity', file: '', strength: 1 })
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

describe('RefMod visible look (description)', () => {
  const L = [{ id: 'm', name: 'Mara', note: 'the witchhunter', description: 'A tall woman in a weathered black coat and wide-brimmed hat.', file: 'f', strength: 1 }]
  it('sanitizeRefMods keeps a string description and drops junk', () => {
    expect(sanitizeRefMods([{ id: 'x', description: 'a look' }])[0].description).toBe('a look')
    expect(sanitizeRefMods([{ id: 'x', description: 5 }])[0].description).toBe('')
  })
  it('refModHasLook needs a non-blank description', () => {
    expect(refModHasLook(L[0])).toBe(true)
    expect(refModHasLook({ ...L[0], description: '  ' })).toBe(false)
  })
  it('instruction tells the writer to DESCRIBE a described RefMod consistently, not to avoid it', () => {
    const out = refModInstruction(L, 'minimax_h3')
    expect(out).toContain('visible look: A tall woman in a weathered black coat')
    expect(out).toContain('DESCRIBE what is visible')
    expect(out).not.toContain('do NOT invent')
  })
  it('mixed list: described gets the describe wording, bare keeps "do NOT invent"', () => {
    const out = refModInstruction([...L, { id: 'b', name: 'Visor', note: '', file: 'g', strength: 1 }], 'minimax_h3')
    expect(out).toContain('visible look: A tall woman')
    expect(out).toContain('do NOT invent')
    expect(out).toMatch(/^- Visor$/m)
  })
  it('refModCanonBlock lists only described RefMods; empty otherwise / off-target', () => {
    expect(refModCanonBlock([{ id: 'b', name: 'Visor', note: '', file: 'g', strength: 1 }])).toBe('')
    expect(refModCanonBlock(L, 'flux')).toBe('')
    const out = refModCanonBlock(L)
    expect(out).toContain('canon')
    expect(out).toContain('Mara — visible look: A tall woman')
    expect(out).toContain('(represents: the witchhunter)')
  })
  it('description never reaches the bridge manifest', () => {
    expect(refModManifestEntries(L, ['m'])).toEqual([{ file: 'f', strength: 1 }])
  })
  it('describeRefModImage passes an image block + system, trims, and rejects empty / no model', async () => {
    let seen
    const call = async (m, content, sys) => { seen = { m, content, sys }; return '  A knight in chrome armor.  ' }
    const out = await describeRefModImage(call, { model: 'v', base64: 'AAA', mediaType: 'image/png', hint: 'chrome knight' }, 'SYS')
    expect(out).toBe('A knight in chrome armor.')
    expect(seen.m).toBe('v')
    expect(seen.sys).toBe('SYS')
    expect(seen.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } })
    expect(seen.content[1].text).toContain('chrome knight')
    await expect(describeRefModImage(call, { model: '', base64: 'x' }, 'S')).rejects.toThrow(/vision model/)
    await expect(describeRefModImage(async () => ' ', { model: 'v', base64: 'x' }, 'S')).rejects.toThrow(/no description/)
  })
})

describe('RefMod virtual references (Ref2VA labels)', () => {
  const lib = sanitizeRefMods([
    { id: 'a', name: 'Mara', description: 'A tall woman in a black coat.', file: 'chars/mara', strength: 1 },
    { id: 'b', name: 'Alley', note: 'rain-slick alley', role: 'environment', file: 'places/alley', strength: 0.8 },
    { id: 'z', name: 'Zero', file: 'x/zero', strength: 0 },
    { id: 'n', name: 'NoFile' },
    { id: 'd', name: 'Dup', file: 'chars/mara' },
    { id: 'e', name: 'Fourth', file: 'x/e' },
    { id: 'f', name: 'Fifth', file: 'x/f' },
  ])
  it('selectRefMods: slot order, deduped by file, no-file and zero-strength dropped, capped at 3', () => {
    const sel = selectRefMods(lib, ['a', 'z', 'n', 'b', 'd', 'e', 'f'])
    expect(sel.map(s => s.file)).toEqual(['chars/mara', 'places/alley', 'x/e'])
  })
  it('manifest entries come from the same selection (zero-strength no longer exported)', () => {
    expect(refModManifestEntries(lib, ['a', 'z', 'b'])).toEqual([
      { file: 'chars/mara', strength: 1 }, { file: 'places/alley', strength: 0.8 },
    ])
  })
  it('refModLabels tags each RefMod by what it is, counted per tag in slot order — never <Picture n>', () => {
    const l = refModLabels(lib, ['a', 'b'])
    expect(l.map(x => [x.label, x.role, x.preserve])).toEqual([
      ['<Subject 1>', 'subject_identity', 'exact'],
      ['<Location 1>', 'environment', 'guide'],
    ])
    expect(l.every(x => !/Picture/.test(x.label))).toBe(true)
  })
  it('<Subject M> continues after real subject-defining reference images', () => {
    expect(refModLabels(lib, ['a'], { realSubjectCount: 1 })[0].label).toBe('<Subject 2>')
  })
  it('two subjects count up; a location starts its own counter', () => {
    const two = sanitizeRefMods([
      { id: 'p', name: 'P', file: 'a/p' }, { id: 'q', name: 'Q', file: 'a/q' },
      { id: 'r', name: 'R', file: 'a/r', role: 'environment' },
    ])
    expect(refModLabels(two, ['p', 'q', 'r']).map(x => x.label)).toEqual(['<Subject 1>', '<Subject 2>', '<Location 1>'])
  })
  it('reference lines carry the tag, role, marker and look — no Image N, no <Picture n>', () => {
    const out = refModReferenceLines(refModLabels(lib, ['a', 'b']))
    expect(out).toContain('RefMod <Subject 1> — role: Subject / Identity, preservation: Exact (fully_preserved) [loaded straight into the video model; no image, no <Picture> tag]: A tall woman in a black coat.')
    expect(out).toContain('RefMod <Location 1> — role: Location, preservation: Guide (attribute_transfer)')
    expect(out).toContain('Alley — rain-slick alley') // no description -> name + note
    expect(out).not.toMatch(/Image \d/)
  })
  it('instruction with labels asks the writer to CITE the tag and never invent a <Picture N>', () => {
    const out = refModInstruction([lib[0]], 'minimax_h3', refModLabels(lib, ['a']))
    expect(out).toContain('subject_definitions')
    expect(out).toContain('never write or invent a <Picture N>')
    expect(out).not.toContain('do NOT invent')
  })
  it('an unknown role falls back to subject_identity', () => {
    expect(sanitizeRefMods([{ id: 'x', role: 'pose_composition' }])[0].role).toBe('subject_identity')
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

describe('RefMod-only writer message (main app path)', () => {
  it('buildWriterUserText in ref mode carries MODE: Ref2VA and the RefMod reference line', async () => {
    const { buildWriterUserText, buildStylePart } = await import('../src/adapt.js')
    const lib = sanitizeRefMods([{ id: 'a', name: 'Mara', description: 'A tall woman in a black coat.', file: 'chars/mara' }])
    const labels = refModLabels(lib, ['a'])
    const msg = buildWriterUserText({
      target: 'minimax_h3', targetType: 'video', frameMode: 'ref', scene: 'She crosses the alley.', duration: '8 seconds',
      frameDescription: refModReferenceLines(labels), hasImg: false, refModsOnly: true,
      ratio: null, soundscape: 'rain', music: '', stylePart: '', lengthPart: '',
    })
    expect(msg.startsWith('MODE: Ref2VA')).toBe(true)
    expect(msg).toContain('RefMod <Subject 1> — role: Subject / Identity')
    expect(msg).toContain('no <Picture N> tags')
    expect(msg).toContain('A tall woman in a black coat.')
    expect(msg).not.toContain('integrated_multimodal_description')
    const style = buildStylePart({ targetType: 'video', refMods: lib, refModLabels: labels, targetId: 'minimax_h3' })
    expect(style).toContain('subject_definitions')
    expect(style).not.toContain('do NOT invent')
  })
})

describe('RefMod voice binding', () => {
  const lib = [{ id: 'a', name: 'Mara', note: '', description: 'tall', role: 'subject_identity', file: 'mara', strength: 1 }]
  const labels = refModLabels(lib, ['a'], { realSubjectCount: 1 })
  const audios = [{ fileName: 'v.mp3', subjectRef: refModVoiceKey('a') }, { fileName: 'w.mp3', subjectRef: 'h1' }]

  it('names the RefMod subject (numbering from refModLabels)', () => {
    const b = buildAudioBlock(audios, { refModLabels: labels, only: 'refmod' })
    expect(b).toContain('Audio 1 —')
    expect(b).toContain('the voice of <Subject 2> (Mara)')
    expect(b).not.toContain('Audio 2')
  })
  it("'rest' leaves RefMod-bound voices out and keeps the original image wording", () => {
    const b = buildAudioBlock(audios, { refs: [{ hash: 'h1', role: 'subject_identity' }], roleLabel: x => x, only: 'rest' })
    expect(b).toContain('Audio 2 — voice-timbre reference (marker: reference) — for the subject in Image 1 (subject_identity)')
    expect(b).not.toContain('Audio 1')
  })
  it('a stale RefMod id is emitted unbound', () => {
    const b = buildAudioBlock([{ fileName: 'v.mp3', subjectRef: 'refmod:gone' }], { refModLabels: labels, only: 'refmod' })
    expect(b).toContain('Audio 1 — voice-timbre reference (marker: reference): file')
  })
})

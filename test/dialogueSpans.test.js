import { describe, it, expect } from 'vitest'
import { splitDialogue, stripCrossCutTags, sceneRequestsSpeech, wordBudget } from '../src/dialogueSpans'

describe('splitDialogue', () => {
  it('splits tag+quote and round-trips', () => {
    const t = 'She says, [English] "Hello there." Then [German] "Tschüss" ends.'
    const s = splitDialogue(t)
    expect(s.map(x => x.text).join('')).toBe(t)
    expect(s.filter(x => x.dialogue).map(x => x.text)).toEqual(['[English] "Hello there."', '[German] "Tschüss"'])
  })
  it('ignores untagged quotes and empty input', () => {
    expect(splitDialogue('a "sign" here').every(x => !x.dialogue)).toBe(true)
    expect(splitDialogue('')).toEqual([])
  })
})
describe('stripCrossCutTags', () => {
  it('removes scenetrans/cutoff', () => {
    expect(stripCrossCutTags('unique,<scenetrans>" x <scenetrans>[English] "y"')).not.toMatch(/scenetrans/)
    expect(stripCrossCutTags('end <cutoff>')).not.toMatch(/cutoff/)
  })
})
describe('speech helpers', () => {
  it('detects speech cues and budgets words', () => {
    expect(sceneRequestsSpeech('She talks about art')).toBe(true)
    expect(sceneRequestsSpeech('She opens the door')).toBe(false)
    expect(wordBudget({ min: 16, max: 20 })).toEqual([11, 14])
    expect(wordBudget({ min: null })).toBeNull()
  })
})

import { refModLabels, countRealSubjects } from '../src/refmods'
describe('RefMod subject numbering', () => {
  it('location/style/pose images do not shift <Subject 1>', () => {
    const imgs = [{ role: 'environment' }, { role: 'style' }, { role: 'pose_composition' }]
    expect(countRealSubjects(imgs)).toBe(0)
    expect(countRealSubjects([...imgs, { role: 'subject_identity' }])).toBe(1)
    const lib = [{ id: 'a', file: 'x', strength: 1, role: 'subject_identity' }]
    expect(refModLabels(lib, ['a'], { realSubjectCount: countRealSubjects(imgs) })[0].label).toBe('<Subject 1>')
  })
})

// LoRA trigger handling: what counts as "the token made it into the prompt",
// and where a repair is allowed to put a token it had to add back.
//
// Ported from the throwaway script the feature was originally verified with, so
// the assertions survive into CI instead of living in /tmp.
//
// The point of the per-target cases: a blind prepend would corrupt two output
// formats. SDXL's tokens must never land in NEGATIVE (they would suppress the
// LoRA), and H3's must land in the one prose field — never in summary /
// retention_analysis / the sound fields, and never inside a <d> tag or quotes,
// because in H3 those become spoken audio and on-screen text.

import { describe, it, expect } from 'vitest'
import {
  missingTriggers, withLoraTriggers, loraInstruction, lorasByIds,
  targetTakesLoras, loraUsable,
} from '../src/loras.js'

const L = [
  { id: 'a', name: 'Anna', trigger: 'ohwx woman', kind: 'character', note: '' },
  { id: 's', name: 'MJ',   trigger: 'aidmaMJ6.1', kind: 'style',     note: '' },
]

describe('missingTriggers', () => {
  it('finds nothing when both tokens are present verbatim', () => {
    expect(missingTriggers('a photo of ohwx woman, aidmaMJ6.1', L)).toEqual([])
  })

  it('ignores case and collapsed whitespace', () => {
    expect(missingTriggers('OHWX  Woman and AidmaMJ6.1', L)).toEqual([])
  })

  it('treats a spaced-out token as missing — the LoRA would not fire either', () => {
    expect(missingTriggers('ohwx woman, aidma MJ 6.1', L)).toEqual(['aidmaMJ6.1'])
  })

  it('treats a hyphenated token as missing', () => {
    expect(missingTriggers('ohwx-woman, aidmaMJ6.1', L)).toEqual(['ohwx woman'])
  })

  it('reports both when neither is there', () => {
    expect(missingTriggers('a woman in a room', L)).toHaveLength(2)
  })

  it('skips an entry whose trigger is blank', () => {
    expect(missingTriggers('anything', [{ id: 'x', trigger: '   ', kind: 'style' }])).toEqual([])
  })
})

describe('withLoraTriggers — plain prose targets', () => {
  it('prepends both missing tokens', () => {
    expect(withLoraTriggers('A woman stands at a window.', L, 'flux'))
      .toBe('ohwx woman, aidmaMJ6.1. A woman stands at a window.')
  })

  it('is a no-op with no active LoRAs', () => {
    expect(withLoraTriggers('A woman.', [], 'flux')).toBe('A woman.')
  })

  it('is a no-op when nothing is missing', () => {
    const t = 'ohwx woman, aidmaMJ6.1, a woman.'
    expect(withLoraTriggers(t, L, 'flux')).toBe(t)
  })

  it('adds only the token that is actually missing', () => {
    expect(withLoraTriggers('aidmaMJ6.1, a woman.', L, 'flux'))
      .toBe('ohwx woman. aidmaMJ6.1, a woman.')
  })

  it('leaves DramaBox alone — a TTS prompt has no diffusion model', () => {
    const t = 'She whispers, "Go."'
    expect(withLoraTriggers(t, L, 'dramabox')).toBe(t)
  })

  it('leaves empty text alone', () => {
    expect(withLoraTriggers('', L, 'flux')).toBe('')
    expect(withLoraTriggers('   ', L, 'flux')).toBe('   ')
  })
})

describe('withLoraTriggers — SDXL', () => {
  const out = withLoraTriggers('POSITIVE:\n1girl, window, daylight\n\nNEGATIVE:\nblurry, watermark', L, 'sdxl')

  it('puts the tokens at the head of POSITIVE', () => {
    expect(out).toMatch(/POSITIVE:\nohwx woman, aidmaMJ6\.1, 1girl/)
  })

  it('never touches NEGATIVE', () => {
    expect(out).toMatch(/NEGATIVE:\nblurry, watermark$/)
  })

  it('falls back to a prepend when there is no POSITIVE label', () => {
    expect(withLoraTriggers('1girl, window', L, 'sdxl')).toBe('ohwx woman, aidmaMJ6.1, 1girl, window')
  })
})

describe('withLoraTriggers — MiniMax H3', () => {
  const ref2va = [
    'summary:', '[reference generation] A woman turns from a window.', '',
    'subject_definitions:', '<Subject 1> is the woman from <Picture 1>.', '',
    'retention_analysis:', '<Subject 1> (appears in [Shot 1]): fully_preserved - face held.', '',
    'detailed_description:', '[Shot 1] Cinematic, live-action, a medium shot frames the woman.', '',
    'overall_soundscape:', 'Room tone and distant traffic.', '',
    'non_diegetic_music:', 'N/A',
  ].join('\n')
  const out = withLoraTriggers(ref2va, L, 'minimax_h3')

  it('opens the detailed_description body, below its label', () => {
    expect(out).toMatch(/detailed_description:\nohwx woman, aidmaMJ6\.1\. \[Shot 1\]/)
  })

  it('leaves summary, retention_analysis and the sound fields untouched', () => {
    expect(out).toMatch(/summary:\n\[reference generation\] A woman turns/)
    expect(out).toMatch(/retention_analysis:\n<Subject 1>/)
    expect(out).toMatch(/overall_soundscape:\nRoom tone/)
    expect(out).toMatch(/non_diegetic_music:\nN\/A/)
  })

  it('uses integrated_multimodal_description in the base modes', () => {
    const base = 'integrated_multimodal_description: [Shot 1] Live-action, a wide shot.\n\noverall_soundscape: Wind.'
    expect(withLoraTriggers(base, L, 'minimax_h3'))
      .toMatch(/^integrated_multimodal_description: ohwx woman, aidmaMJ6\.1\. \[Shot 1\]/)
  })

  it('falls back to a prepend when neither field is present', () => {
    expect(withLoraTriggers('summary:\nsomething odd', L, 'minimax_h3'))
      .toBe('ohwx woman, aidmaMJ6.1. summary:\nsomething odd')
  })
})

describe('library helpers', () => {
  it('loraUsable requires a non-empty trigger', () => {
    expect(loraUsable(L[0])).toBe(true)
    expect(loraUsable({ id: 'x', trigger: '  ' })).toBe(false)
    expect(loraUsable(null)).toBe(false)
  })

  it('lorasByIds resolves in selection order and drops unknown ids', () => {
    expect(lorasByIds(L, ['s', 'nope', 'a']).map(l => l.id)).toEqual(['s', 'a'])
    expect(lorasByIds(L, null)).toEqual([])
  })

  it('targetTakesLoras excludes only dramabox', () => {
    expect(targetTakesLoras('flux')).toBe(true)
    expect(targetTakesLoras('minimax_h3')).toBe(true)
    expect(targetTakesLoras('dramabox')).toBe(false)
  })
})

describe('loraInstruction', () => {
  it('is empty for dramabox, for no LoRAs, and for a half-finished entry', () => {
    expect(loraInstruction(L, 'dramabox')).toBe('')
    expect(loraInstruction([], 'flux')).toBe('')
    expect(loraInstruction([{ id: 'x', name: 'wip', trigger: '   ', kind: 'style' }], 'flux')).toBe('')
  })

  it('names both tokens and forbids the mangling modes', () => {
    const s = loraInstruction(L, 'flux')
    expect(s).toContain('ohwx woman')
    expect(s).toContain('aidmaMJ6.1')
    expect(s).toMatch(/never translate, pluralize, re-capitalize, hyphenate, space out/i)
  })

  it('adds the H3 field restriction only for H3', () => {
    expect(loraInstruction(L, 'minimax_h3')).toContain('detailed_description')
    expect(loraInstruction(L, 'flux')).not.toContain('detailed_description')
  })

  it('names the bound character when one is given', () => {
    expect(loraInstruction([{ ...L[0], subject: 'ANNA' }], 'flux')).toContain('for ANNA')
  })
})

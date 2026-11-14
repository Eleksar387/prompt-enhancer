// The condensed MiniMax H3 writer prompt (src/h3Prompt.js). It is a rewrite, so the
// risk is silently losing a constraint — these tests pin what must survive: the
// empirical h3-storyboard rules verbatim, the exact alignment lines, the per-mode
// sections, and the contradictions the rewrite exists to remove.
import { describe, it, expect } from 'vitest'
import { TARGETS } from '../src/constants.js'
import { buildH3SystemV2 } from '../src/h3Prompt.js'
import { CRAFT_CLICHES } from '../src/craft.js'

const legacy = TARGETS.minimax_h3.system
const slice = (a, z) => { const i = legacy.indexOf(a); return legacy.slice(i, legacy.indexOf(z, i + 1)).trimEnd() }

describe('buildH3SystemV2', () => {
  const ref = buildH3SystemV2('ref')
  const single = buildH3SystemV2('single')
  const last = buildH3SystemV2('last')
  const firstlast = buildH3SystemV2('firstlast')

  it('is much shorter than legacy', () => {
    expect(ref.length).toBeLessThan(28000)
    expect(single.length).toBeLessThan(22000)
    expect(ref.length).toBeLessThan(legacy.length)
  })

  it('keeps the empirical h3-storyboard rules (3a, 9–13) and 8, 14, 15 verbatim', () => {
    for (const [a, z] of [['3a. EXPRESSION-BEAT', '4. Camera:'], ['8. non_diegetic_music', '9. EMOTION IS'],
      ['9. EMOTION IS', '14. Keep the whole prompt'], ['14. Keep the whole prompt', 'MODE-SPECIFIC OUTPUT']]) {
      const block = slice(a, z)
      for (const m of [ref, single, last, firstlast]) expect(m).toContain(block)
    }
  })

  it('keeps rule 7 and the Ref2VA summary / retention sections verbatim', () => {
    const r7 = slice('7. overall_soundscape', '8. non_diegetic_music')
    expect(ref).toContain(r7.replace(/\s*$/, ''))
    expect(ref).toContain(slice('summary:\nBegin with a square-bracketed', 'retention_analysis:\nOne line per label'))
    expect(ref).toContain(slice('retention_analysis:\nOne line per label', 'detailed_description:\nOpen with'))
  })

  it('sends only the active mode’s output section', () => {
    expect(ref).toContain('subject_definitions:')
    expect(ref).toContain('LABEL NUMBERING')
    expect(ref).not.toContain('T2VA (no reference image)')
    expect(ref).not.toContain('FL2VA (a FIRST FRAME')
    expect(single).toContain('T2VA (no reference image)')
    expect(single).toContain('I2VA (one FIRST FRAME')
    expect(single).not.toContain('LABEL NUMBERING')
    expect(single).not.toContain('L2VA (one LAST FRAME')
    expect(last).toContain('L2VA (one LAST FRAME')
    expect(last).not.toContain('I2VA (one FIRST FRAME')
    expect(firstlast).toContain('FL2VA (a FIRST FRAME')
    expect(buildH3SystemV2('firstmidlast')).toBe(firstlast)
  })

  it('carries the exact alignment lines of the keyframe modes', () => {
    expect(slice('I2VA (one FIRST', 'L2VA (one LAST')).toBeTruthy()
    for (const [m, [a, z]] of [[single, ['I2VA (one FIRST', 'L2VA (one LAST']], [last, ['L2VA (one LAST', 'FL2VA (a FIRST']], [firstlast, ['FL2VA (a FIRST', 'Ref2VA (one or more']]]) {
      expect(m).toContain(slice(a, z))
    }
    // the unbracketed FL2VA line is a named exception to the bracket rule — only there
    expect(firstlast).toContain('the single exception is the FL2VA alignment line')
    expect(ref).not.toContain('the single exception is the FL2VA alignment line')
  })

  it('lists the modes it may compile for in the INPUT line', () => {
    expect(ref).toContain('MODE: Ref2VA"')
    expect(single).toContain('MODE: T2VA" | "I2VA"')
  })

  it('has no contradictions with the creative layer', () => {
    // one camera stance: a move needs a job, otherwise a stated locked-off frame
    expect(ref).not.toContain('Default to a MOVE')
    expect(ref).toContain('If you cannot name the job')
    // "cinematic" only ever appears inside the banned-word list
    const stripped = ref.replace(`Banned words, anywhere in the prompt including the style opening: ${CRAFT_CLICHES.join('; ')}.`, '')
    expect(stripped.toLowerCase()).not.toContain('cinematic')
    expect(ref.toLowerCase().split('cinematic').length - 1).toBe(1)
  })

  it('keeps the dialogue and voice-reference rules', () => {
    for (const needle of ['[Language]', '<cutoff>', '<scenetrans>', '6a. A VOICE REFERENCE WITH NO SUPPLIED WORDS', 'S1,S2', '(V.O.)', '[Arabic] [Chinese]']) {
      expect(ref).toContain(needle)
    }
    expect(single).toContain('never write an <Audio N> label')
    expect(ref).toContain('is declared as an <Audio N> line in subject_definitions')
  })

  it('ends with the start-of-output reminder, and carries no copyable example gesture', () => {
    for (const m of [ref, single, last, firstlast]) expect(m.endsWith('no closing remark.')).toBe(true)
    expect(ref).not.toContain('thumbnail')
  })

  it('carries the main-branch writer improvements (1b, rule 3 tail, rule 4 spread, 6b)', () => {
    for (const m of [ref, single, last, firstlast]) {
      expect(m).toContain('INVENT SPECIFICS, DON\'T DEFAULT TO GENERIC')
      expect(m).toContain('let the shot end mid-motion')
      expect(m).toContain('equally valid FIRST choices')
      expect(m).toContain('6b. NO VOICE REFERENCE EITHER')
      expect(m).toContain('rules 6a/6b')
    }
    // every numbered rule heading the legacy prompt has also exists in V2
    for (const h of legacy.match(/^(\d+[ab]?)\. /gm)) if (h !== '1b. ') expect(ref).toContain(h)  // 1b lives in the creative block
  })

  it('never teaches a stated hold at the end (no copyable "final 1.5 seconds" sentence)', () => {
    for (const m of [ref, single, last, firstlast]) {
      expect(m).not.toContain('through the final 1.5 seconds')
      expect(m).not.toContain('She holds the look')
      expect(m).not.toMatch(/settles? (without|with no)/i)
      expect(m).toContain('Never write a sentence about the final seconds')
    }
  })

  it('tells the writer not to leak its own rules', () => {
    expect(ref).toContain('never name, quote or label them in the output')
  })
})

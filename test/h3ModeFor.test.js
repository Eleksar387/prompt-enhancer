// h3ModeFor: the single frameMode -> MiniMax H3 MODE mapping shared by
// buildWriterUserText (src/adapt.js), Manual mode (App.jsx), and restore()'s
// fallback for a pre-existing history entry that predates h3Mode being
// stamped on outputs (App.jsx reads o.h3Mode ?? h3ModeFor(h.frameMode, !!h.firstImg)).

import { describe, it, expect } from 'vitest'
import { h3ModeFor } from '../src/adapt.js'

describe('h3ModeFor', () => {
  it('maps every frameMode to its MiniMax H3 mode', () => {
    expect(h3ModeFor('last', false)).toBe('L2VA')
    expect(h3ModeFor('firstlast', false)).toBe('FL2VA')
    expect(h3ModeFor('ref', false)).toBe('Ref2VA')
    expect(h3ModeFor('single', true)).toBe('I2VA')
    expect(h3ModeFor('single', false)).toBe('T2VA')
  })

  it('frameMode wins over hasImg for last/firstlast/ref — hasImg only disambiguates single', () => {
    expect(h3ModeFor('ref', true)).toBe('Ref2VA')
    expect(h3ModeFor('last', true)).toBe('L2VA')
    expect(h3ModeFor('firstlast', true)).toBe('FL2VA')
  })

  it('matches the flagged history entry that motivated the syntax checker (frameMode: ref -> Ref2VA, restore fallback path)', () => {
    // 1789563116037-iizpez.json: target minimax_h3, frameMode 'ref', firstImg
    // null. restore()'s legacy fallback is h3ModeFor(h.frameMode, !!h.firstImg).
    expect(h3ModeFor('ref', !!null)).toBe('Ref2VA')
  })
})

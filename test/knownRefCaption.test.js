import { describe, it, expect } from 'vitest'
import { knownRefCaption } from '../src/adapt'

describe('knownRefCaption', () => {
  it('prefers the per-image record', () => {
    const meta = { h1: { captions: { subject_identity: ' from record ' } } }
    const im = { role: 'subject_identity', captions: { subject_identity: 'session' }, caption: 'legacy' }
    expect(knownRefCaption(im, meta, 'subject_identity', 'h1')).toBe('from record')
  })
  it('falls back to session captions, then legacy flat caption (own role only)', () => {
    expect(knownRefCaption({ role: 'environment', captions: { environment: 'sess' } }, {}, 'environment', 'h')).toBe('sess')
    expect(knownRefCaption({ role: 'environment', caption: 'old' }, {}, 'environment', 'h')).toBe('old')
    expect(knownRefCaption({ role: 'environment', caption: 'old' }, {}, 'style', 'h')).toBe('')
  })
  it('does not use text from another role, and treats blanks as unknown', () => {
    const meta = { h1: { captions: { style: 'style text' } } }
    expect(knownRefCaption({ role: 'subject_identity' }, meta, 'subject_identity', 'h1')).toBe('')
    expect(knownRefCaption({ captions: { style: '   ' } }, {}, 'style', 'h')).toBe('')
    expect(knownRefCaption(null, undefined, 'style', 'h')).toBe('')
  })
})

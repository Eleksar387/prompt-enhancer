import { describe, it, expect } from 'vitest'
import {
  buildDistillUserText, distillBudget, shouldDistill, acceptDistilled, buildWriterUserText,
  H3_REF_DISTILL_SYSTEM, buildH3RefDistillUserText, splitDistilledCaptions,
} from '../src/adapt'

const block = 'Image 1 — role: Subject / Identity: a woman with red hair.\n\nImage 2 — role: Style: muted teal palette.'

describe('multi-reference distill helpers', () => {
  it('only triages two or more references', () => {
    expect(shouldDistill(1)).toBe(false)
    expect(shouldDistill(2)).toBe(true)
  })
  it('keeps the budget bounded as the count grows', () => {
    expect(distillBudget(2).perImage).toBe(25)
    expect(distillBudget(5).total).toBeLessThanOrEqual(100)
    expect(distillBudget(5).perImage).toBe(20)
  })
  it('includes the brief when typed, and says the references are the brief when not', () => {
    expect(buildDistillUserText({ scene: 'a fisherman at dawn', block, count: 2 })).toContain('a fisherman at dawn')
    expect(buildDistillUserText({ scene: '  ', block, count: 2 })).toContain('the references ARE the brief')
  })
  it('accepts only one Image N line per reference', () => {
    expect(acceptDistilled(block, 2)).toBe(block)
    expect(acceptDistilled('I cannot help with that.', 2)).toBeNull()
    expect(acceptDistilled('Image 1 — role: Style: teal.', 2)).toBeNull()
    expect(acceptDistilled('', 2)).toBeNull()
  })
  it('caps reference carry-over in the multi-reference writer message', () => {
    const msg = buildWriterUserText({
      target: 'flux2klein', targetType: 'image', frameMode: 'single', scene: 'x',
      frameDescription: block, hasImg: true, refRoles: ['subject_identity', 'style'],
    })
    expect(msg).toContain('at most ~60 words')
  })
})

describe('MiniMax H3 Ref2VA reference-caption distill', () => {
  // Deliberately the SAME bare "Image N — role: <Role>: <description>" shape
  // the still-image pass uses — H3's own preservation-marker / "Requested
  // use" lines are never sent to the trimmer (see H3_REF_DISTILL_SYSTEM's
  // comment in src/adapt.js for why: those fields are load-bearing, and
  // trusting an LLM to reproduce them verbatim is the kind of prose-only fix
  // this codebase avoids). The caller rebuilds H3's own lines in code from
  // the trimmed captions via splitDistilledCaptions.
  it('reuses the format-agnostic budget/acceptance helpers, unchanged', () => {
    expect(acceptDistilled(block, 2)).toBe(block)
    expect(shouldDistill(1)).toBe(false)
    expect(shouldDistill(2)).toBe(true)
  })
  it('includes the scene/action brief when typed, and says the references are the brief when not', () => {
    expect(buildH3RefDistillUserText({ scene: 'she turns from the window', block, count: 2 }))
      .toContain('she turns from the window')
    expect(buildH3RefDistillUserText({ scene: '', block, count: 2 }))
      .toContain('the references ARE the brief')
  })
  it('tells the trimmer the writer, not the reference description, owns the scene', () => {
    expect(H3_REF_DISTILL_SYSTEM).toContain('the writer decides the scene, not this description')
    expect(H3_REF_DISTILL_SYSTEM).toContain('Image N — role: <Role>:')
  })
  it('splits an accepted block back into one trimmed caption per image, in order', () => {
    expect(splitDistilledCaptions(block, 2)).toEqual(['a woman with red hair.', 'muted teal palette.'])
  })
  it('rejects a split that does not yield exactly `count` non-empty captions', () => {
    expect(splitDistilledCaptions(block, 3)).toBeNull()
    expect(splitDistilledCaptions('Image 1 — role: Subject / Identity: \n\nImage 2 — role: Style: teal.', 2)).toBeNull()
    expect(splitDistilledCaptions('', 2)).toBeNull()
  })
  it('a malformed or refused trim (wrong line count / prose) is rejected by acceptDistilled, leaving the caller to fall back to the full captions', () => {
    expect(acceptDistilled('I cannot help with that.', 2)).toBeNull()
    expect(acceptDistilled('Image 1 — role: Style: teal.', 2)).toBeNull()
    expect(acceptDistilled('', 2)).toBeNull()
  })
})

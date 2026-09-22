import { describe, it, expect } from 'vitest'
import { buildDistillUserText, distillBudget, shouldDistill, acceptDistilled, buildWriterUserText } from '../src/adapt'

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

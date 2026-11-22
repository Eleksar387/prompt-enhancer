import { describe, it, expect } from 'vitest'
import { buildRefineUserText, REFINE_SYSTEM_ADDENDUM } from '../src/adapt'

describe('buildRefineUserText', () => {
  it('carries the current prompt, the request and the context', () => {
    const t = buildRefineUserText({ currentPrompt: ' A cat. ', instruction: ' make it night ', scene: 'cat on roof', caption: 'grey cat', h3Mode: 'T2VA', targetLabel: 'MiniMax H3' })
    expect(t).toContain('Target: MiniMax H3')
    expect(t).toContain('MODE: T2VA')
    expect(t).toContain('Original scene / idea:\ncat on roof')
    expect(t).toContain('Reference description (from the input image(s)):\ngrey cat')
    expect(t).toContain('CURRENT PROMPT:\nA cat.')
    expect(t).toContain('CHANGE REQUEST:\nmake it night')
    expect(t.indexOf('CURRENT PROMPT')).toBeLessThan(t.indexOf('CHANGE REQUEST'))
  })
  it('omits empty context blocks', () => {
    const t = buildRefineUserText({ currentPrompt: 'x', instruction: 'y' })
    expect(t).not.toContain('Original scene')
    expect(t).not.toContain('MODE:')
    expect(t).not.toContain('Target:')
  })
  it('addendum demands the same format', () => {
    expect(REFINE_SYSTEM_ADDENDUM).toMatch(/identical output format/)
  })
})

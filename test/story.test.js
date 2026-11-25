import { describe, it, expect } from 'vitest'
import { SYSTEM_PROMPT_STORY, SYSTEM_PROMPT_SCRIPTWRITER } from '../src/constants.js'
import { parseStoryOptions } from '../src/storyOptions.js'

describe('Scriptwriter story step', () => {
  it('story prompt asks for an arc, a twist and three options', () => {
    expect(SYSTEM_PROMPT_STORY).toContain('THREE different story options')
    expect(SYSTEM_PROMPT_STORY).toMatch(/twist/i)
    expect(SYSTEM_PROMPT_STORY).toMatch(/ARC/)
  })
  it('script prompt treats a Story to dramatize block as canon, twist included', () => {
    expect(SYSTEM_PROMPT_SCRIPTWRITER).toContain('"Story to dramatize" block, it is canon')
    expect(SYSTEM_PROMPT_SCRIPTWRITER).toContain('Never trim or soften the twist')
  })
  it('parses three numbered options', () => {
    const o = parseStoryOptions('1. ONE\nline a\nline b\n\n2. TWO\nline c\n\n3. THREE\nline d')
    expect(o).toEqual(['ONE\nline a\nline b', 'TWO\nline c', 'THREE\nline d'])
  })
  it('falls back to the whole text when unnumbered', () => {
    expect(parseStoryOptions('just a story\nof lines')).toEqual(['just a story\nof lines'])
    expect(parseStoryOptions('')).toEqual([])
  })
})

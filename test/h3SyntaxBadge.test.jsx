// Smoke-render H3SyntaxBadge — confirms it actually mounts without a
// browser (no headless Chromium available in this environment) and that its
// rendered markup reflects checkH3Prompt's verdict: green "well-formed" for
// good input, an amber/red "N issue(s)" summary for the real broken entry
// that motivated this whole feature, and nothing at all when there's no text
// or no mode yet (nothing generated).

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import H3SyntaxBadge from '../src/components/H3SyntaxBadge.jsx'
import { buildManualH3 } from '../src/manualH3.js'

describe('H3SyntaxBadge', () => {
  it('renders the green well-formed state for schema-correct T2VA output', () => {
    const { text } = buildManualH3({
      mode: 'T2VA', storyText: '[Shot 1] Cinematic, live-action, a woman turns towards the door.',
      soundscape: 'quiet room tone', music: '', duration: '8 seconds', refImages: [], refAudios: [],
    })
    const html = renderToStaticMarkup(<H3SyntaxBadge text={text} mode="T2VA" />)
    expect(html).toContain('looks well-formed')
    expect(html).not.toContain('issue')
  })

  it('renders an issue summary for the real broken Ref2VA entry (missing every field label)', () => {
    const broken = "The target video blends gothic aesthetic with Star Wars iconography. [Shot 1] (0.00–4.00s) <Subject 1> stands in the room. The non_diegetic_music swells faintly under her words."
    const html = renderToStaticMarkup(<H3SyntaxBadge text={broken} mode="Ref2VA" />)
    expect(html).toContain('issue')
    expect(html).toMatch(/⚠|issue/i)
  })

  it('renders nothing with no text yet', () => {
    expect(renderToStaticMarkup(<H3SyntaxBadge text="" mode="T2VA" />)).toBe('')
  })

  it('renders nothing with no mode (not an H3 generation)', () => {
    expect(renderToStaticMarkup(<H3SyntaxBadge text="some text" mode={null} />)).toBe('')
  })
})

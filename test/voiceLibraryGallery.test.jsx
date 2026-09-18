import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import VoiceLibraryGallery, { voiceLibraryRows, VoiceLibraryRow } from '../src/components/VoiceLibraryGallery.jsx'

describe('voiceLibraryRows', () => {
  it('filters out items with no url', () => {
    const rows = voiceLibraryRows([
      { id: 'v1', url: '/api/blob/h1', fileName: 'a.mp3', ts: 1 },
      { id: 'v2', fileName: 'b.mp3', ts: 2 }, // no url — never persisted correctly, skip
    ])
    expect(rows.map(r => r.id)).toEqual(['v1'])
  })

  it('sorts newest-first by ts', () => {
    const rows = voiceLibraryRows([
      { id: 'old', url: '/api/blob/a', ts: 1 },
      { id: 'new', url: '/api/blob/b', ts: 5 },
      { id: 'mid', url: '/api/blob/c', ts: 3 },
    ])
    expect(rows.map(r => r.id)).toEqual(['new', 'mid', 'old'])
  })

  it('maps characterName through as-is, including an empty string', () => {
    const rows = voiceLibraryRows([
      { id: 'v1', url: '/api/blob/a', fileName: 'mara.mp3', characterName: 'Mara', ts: 1 },
      { id: 'v2', url: '/api/blob/b', fileName: 'unnamed.mp3', ts: 2 },
    ])
    expect(rows.find(r => r.id === 'v1').characterName).toBe('Mara')
    expect(rows.find(r => r.id === 'v2').characterName).toBe('')
  })
})

describe('VoiceLibraryGallery (SSR smoke)', () => {
  it('renders empty-state copy and no <audio> tag when the library is empty and open by default', () => {
    // Collapsed by default (open only flips via a useEffect, which SSR never
    // runs) — with no onAddFiles and no rows, the component returns null.
    const html = renderToStaticMarkup(<VoiceLibraryGallery library={[]} onAddFiles={() => {}} />)
    expect(html).toContain('♻ Reuse voice (0)')
    expect(html).not.toContain('<audio')
  })
})

describe('VoiceLibraryRow (SSR smoke)', () => {
  const item = { id: 'v1', url: '/api/blob/h1', fileName: 'clip.mp3', mediaType: 'audio/mpeg', characterName: 'Mara', ts: 1 }

  it('renders an <audio> element with the item url, and the character name', () => {
    const html = renderToStaticMarkup(<VoiceLibraryRow item={item} onPick={() => {}} onRemove={() => {}} onRename={() => {}} />)
    expect(html).toContain('<audio')
    expect(html).toContain('src="/api/blob/h1"')
    expect(html).toContain('value="Mara"')
    expect(html).toContain('clip.mp3')
  })

  it('shows the "— unnamed —" placeholder when characterName is blank', () => {
    const html = renderToStaticMarkup(<VoiceLibraryRow item={{ ...item, characterName: '' }} onPick={() => {}} />)
    expect(html).toContain('— unnamed —')
  })
})

// Smoke-render the components the history section was split into.
//
// Server-rendering them with react-dom/server (already a dependency — no test
// renderer needed) is enough to catch the whole class of mistake a component
// split invites: a prop that was renamed on one side only, a helper left behind
// in the old file, an entry shape the card does not guard. esbuild happily
// compiles all of those; this fails on them.
//
// It is deliberately about "does it render the right facts", not about markup
// details — no snapshots here, so a styling change never breaks these.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import HistoryPanel from '../src/components/HistoryPanel.jsx'

const actions = {
  restore: () => {}, remove: () => {}, adapt: () => {}, assignProject: () => {},
  saveCaption: () => {}, clearAll: () => {}, exportAll: () => {}, importFiles: () => {},
}
const filters = { project: 'all', target: 'all', model: 'all', image: 'all', search: '' }

const render = (over = {}) => renderToStaticMarkup(
  <HistoryPanel
    history={[]} visible={[]} open projects={[]} restoringId={null}
    actions={actions} filters={filters} setFilter={() => {}} resetFilters={() => {}}
    filtersActive={false} targets={[]} models={[]} onToggleOpen={() => {}}
    {...over}
  />,
)

const standard = {
  id: 'e1', ts: 1735689600000, type: 'standard', target: 'minimax_h3', model: 'qwen2.5:14b',
  outputCount: 1, style: 'dramatic', creativity: 'balanced', duration: '8 seconds',
  scene: 'A woman turns from a window', dialogue: 'Wir müssen gehen', delivery: 'urgent',
  soundscape: 'rain on glass', music: 'none', negative: 'watermark', caption: 'a rainy window',
  moves: ['dolly_in'], frameMode: 'ref', project: 'Film A',
  firstImg: { url: '/api/blob/aaa', fileName: 'in.jpg' },
  refImages: [{ url: '/api/blob/bbb', fileName: 'ref.jpg', role: 'character' }],
  outputs: [{
    label: 'qwen2.5:14b', text: 'detailed_description: a medium shot',
    images: [{ url: '/api/blob/ccc' }],
    video: { url: '/api/blob/ddd', duration: 8, blobRef: 'ddd' },
  }],
}

const scriptEntry = {
  id: 's1', ts: 1735689600000, type: 'scriptwriter', model: 'claude-opus-5', phase: 'done',
  promptTarget: 'minimax_h3', idea: 'a heist gone wrong on a rooftop',
  script: { title: 'Nightfall', characters: [{ name: 'Anna' }, { name: 'Mo' }], scenes: [{ id: 1 }, { id: 2 }] },
  directorsCut: { shots: [{ shot_number: 1 }, { shot_number: 2 }] },
  finalPrompts: [
    { shotNumber: 1, sceneTitle: 'Rooftop', text: 'summary: they climb' },
    { shotNumber: 2, sceneTitle: 'Stairwell', text: '' },
  ],
  refImages: [{ url: '/api/blob/eee', fileName: 'anna.jpg', note: 'lead' }],
  framePrompts: [{ frames: { first: { image: { url: '/api/blob/fff' } } } }],
}

describe('HistoryPanel', () => {
  it('renders the empty state', () => {
    expect(render()).toContain('No history yet.')
  })

  it('says when filters hide everything', () => {
    const html = render({ history: [standard], visible: [], filtersActive: true })
    expect(html).toContain('No generations match these filters.')
  })

  it('shows visible/total in the header only while filtering', () => {
    expect(render({ history: [standard, scriptEntry], visible: [standard], filtersActive: true }))
      .toContain('History (1/2)')
    expect(render({ history: [standard, scriptEntry], visible: [standard, scriptEntry] }))
      .toContain('History (2)')
  })

  it('renders nothing but the header when collapsed', () => {
    const html = render({ history: [standard], visible: [standard], open: false })
    expect(html).not.toContain('A woman turns from a window')
    expect(html).not.toContain('Export ↓')
  })

  it('hides the filter bar for a single entry', () => {
    expect(render({ history: [standard], visible: [standard] })).not.toContain('Search history…')
    expect(render({ history: [standard, scriptEntry], visible: [standard, scriptEntry] }))
      .toContain('Search history…')
  })

  it('only offers a filter select when there is more than one value for it', () => {
    const two = { history: [standard, scriptEntry], visible: [standard, scriptEntry] }
    expect(render({ ...two, targets: ['minimax_h3'], models: ['qwen2.5:14b'] })).not.toContain('All targets')
    expect(render({ ...two, targets: ['minimax_h3', 'scriptwriter'] })).toContain('All targets')
    expect(render({ ...two, models: ['qwen2.5:14b', 'claude-opus-5'] })).toContain('All models')
  })
})

describe('StandardCard', () => {
  const html = render({ history: [standard], visible: [standard] })

  it('renders the settings line', () => {
    expect(html).toContain('MiniMax H3 · Video')
    expect(html).toContain('qwen2.5:14b')
    expect(html).toContain('8 seconds')
    expect(html).toContain('Dramatic')
    expect(html).toContain('reference')
  })

  it('renders scene, dialogue, audio and negative', () => {
    expect(html).toContain('A woman turns from a window')
    expect(html).toContain('Wir müssen gehen')
    expect(html).toContain('urgent')
    expect(html).toContain('rain on glass')
    expect(html).toContain('watermark')
  })

  it('resolves camera move ids to labels', () => {
    expect(html).toContain('Dolly-in')
  })

  it('renders input, reference, render and video outputs by blob url', () => {
    for (const hash of ['aaa', 'bbb', 'ccc', 'ddd']) expect(html).toContain(`/api/blob/${hash}`)
  })

  it('renders the generated prompt text', () => {
    expect(html).toContain('detailed_description: a medium shot')
  })

  it('offers Adapt only when there are outputs', () => {
    expect(html).toContain('⇄ Adapt')
    const noOut = { ...standard, outputs: [] }
    expect(render({ history: [noOut], visible: [noOut] })).not.toContain('⇄ Adapt')
  })

  it('shows a restore-in-progress label on the entry being restored', () => {
    expect(render({ history: [standard], visible: [standard], restoringId: 'e1' })).toContain('Restoring…')
    expect(html).toContain('Restore settings')
  })

  it('falls back to a note when the scene came from an image', () => {
    const h = { ...standard, scene: '' }
    expect(render({ history: [h], visible: [h] })).toContain('(proposed from image)')
  })

  it('renders a legacy filename-string image as text, not a broken img', () => {
    const h = { ...standard, firstImg: 'old-photo.jpg', refImages: [], outputs: [] }
    const out = render({ history: [h], visible: [h] })
    expect(out).toContain('old-photo.jpg')
    expect(out).not.toContain('src="old-photo.jpg"')
  })

  it('survives an entry carrying almost nothing', () => {
    const bare = { id: 'x', ts: 1735689600000, type: 'standard' }
    expect(() => render({ history: [bare], visible: [bare] })).not.toThrow()
  })
})

describe('ScriptCard', () => {
  const html = render({ history: [scriptEntry], visible: [scriptEntry] })

  it('renders the pipeline summary', () => {
    expect(html).toContain('Scriptwriter')
    expect(html).toContain('claude-opus-5')
    expect(html).toContain('Done')
    expect(html).toContain('2 scenes')
    expect(html).toContain('2 cast')
    expect(html).toContain('2 clips')          // promptTarget h3 → "clips", not "shots"
    expect(html).toContain('1 H3 prompts')     // only the one with text counts
  })

  it('renders the title, cast and idea', () => {
    expect(html).toContain('Nightfall')
    expect(html).toContain('Anna, Mo')
    expect(html).toContain('a heist gone wrong on a rooftop')
  })

  it('renders reference and frame-still thumbnails', () => {
    expect(html).toContain('/api/blob/eee')
    expect(html).toContain('/api/blob/fff')
  })

  it('lists only prompts that have text', () => {
    expect(html).toContain('Shot 1 · Rooftop')
    expect(html).not.toContain('Shot 2 · Stairwell')
  })

  it('calls LTX clips "shots" when that is the target', () => {
    const ltx = { ...scriptEntry, promptTarget: 'ltx' }
    const out = render({ history: [ltx], visible: [ltx] })
    expect(out).toContain('2 shots')
    expect(out).toContain('1 LTX prompts')
  })

  it('prefers the Full Auto hint over the boilerplate idea', () => {
    const auto = { ...scriptEntry, fullAuto: true, fullAutoHint: 'something with rain' }
    const out = render({ history: [auto], visible: [auto] })
    expect(out).toContain('🎬 Full Auto')
    expect(out).toContain('something with rain')
    expect(out).not.toContain('a heist gone wrong on a rooftop')
  })

  it('says so when Full Auto got no hint at all', () => {
    const auto = { ...scriptEntry, fullAuto: true }
    expect(render({ history: [auto], visible: [auto] })).toContain('AI invented freely')
  })

  it('survives a session saved before the director phase', () => {
    const early = { id: 's2', ts: 1735689600000, type: 'scriptwriter', model: 'm', phase: 'script' }
    expect(() => render({ history: [early], visible: [early] })).not.toThrow()
    expect(render({ history: [early], visible: [early] })).toContain('Script')
  })
})

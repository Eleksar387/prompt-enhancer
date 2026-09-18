// Smoke-render AdaptPanel after its twelve pass-through props were collapsed into
// one `workspace` object. A missing key in that object is now a runtime crash
// rather than an undefined prop, so it is worth a render test — esbuild cannot see
// it, and the panel only appears once a generation has produced a prompt.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AdaptPanel from '../src/components/AdaptPanel.jsx'
import { TARGETS } from '../src/constants.js'

const workspace = {
  targetType: 'video', show: TARGETS.minimax_h3.show,
  target: 'minimax_h3', duration: '8 seconds', style: 'dramatic', creativity: 'balanced',
  frameMode: 'ref', negative: 'watermark', scene: 'she turns from the window',
  dialogue: 'Wir müssen gehen', delivery: 'urgent', spokenLangId: 'de', activeLoraIds: ['s'], loraSubjects: { s: 'Mara' },
  firstImg: null, midImg: null, lastImg: null,
  h3RatioId: 'port916', soundscape: 'rain', music: '', refImages: [], refAudios: [],
  promptLength: 'standard',
}

const render = (over = {}) => renderToStaticMarkup(
  <AdaptPanel
    caption="a rainy window" scene={workspace.scene}
    sourceFrameMode="ref" sourceTarget="minimax_h3"
    originalPrompt="detailed_description: a medium shot"
    fromHistory sourceTs={1735689600000}
    models={['qwen2.5:14b']} defaultModel="qwen2.5:14b"
    cfg={{ base: 'http://x', apiKey: '', temperature: 0.7 }}
    workspace={workspace}
    activeLoras={[{ id: 's', trigger: 'aidmaMJ6.1', kind: 'style' }]}
    onSaveAdapt={() => {}} onClose={() => {}}
    {...over}
  />,
)

describe('AdaptPanel', () => {
  it('renders open when opened from a history entry', () => {
    const html = render()
    expect(html).toContain('Adapt')
    expect(html).toContain('Target duration')
  })

  it('renders collapsed for the live workspace', () => {
    expect(render({ fromHistory: false })).not.toContain('Target duration')
  })

  it('reads every value it needs out of the workspace object', () => {
    // A key missing from `workspace` would throw here rather than silently
    // producing an undefined prompt field later.
    for (const key of Object.keys(workspace)) {
      const { [key]: _dropped, ...missing } = workspace
      // show/targetType are structural; the rest must at worst render empty.
      if (key === 'show' || key === 'targetType' || key === 'target') continue
      expect(() => render({ workspace: missing })).not.toThrow()
    }
  })

  it('defaults its destination to the source target when that target is adaptable', () => {
    expect(render()).toContain('MiniMax H3')
  })

  it('survives a source target that cannot be adapted to', () => {
    expect(() => render({ sourceTarget: 'scriptwriter' })).not.toThrow()
  })

  it('accepts the autoRun prop from the history "→ Text2Video" shortcut without throwing', () => {
    // Effects (and so the actual auto-run call) don't fire under
    // renderToStaticMarkup — this only guards against a prop-shape crash.
    expect(() => render({ autoRun: true })).not.toThrow()
  })
})

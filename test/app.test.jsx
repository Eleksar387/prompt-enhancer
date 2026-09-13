// Render the whole App once, on the server.
//
// This is here because of a bug this refactor actually introduced: a hook was
// moved above the useState it takes an argument from, which is a temporal-dead-zone
// ReferenceError on the very first render — and esbuild, vitest and the module
// transform all compiled it happily. Only calling App() finds it.
//
// So this asserts almost nothing about the markup. Its job is to execute App's
// render path and catch the classes of mistake that a large state refactor
// introduces: a value used before its declaration, a hook moved into a branch, a
// destructure of something undefined, a helper left behind in another file.
//
// Effects do not run during server rendering, so nothing here touches the sidecar,
// the model backend or IndexedDB — only localStorage, which the state initializers
// read synchronously and which is stubbed below.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import App from '../src/App.jsx'
import { CFG_KEY } from '../src/api.js'
import { COMFY_CFG_KEY } from '../src/comfy.js'
import { LORA_STORE_KEY } from '../src/loras.js'

const stubStorage = (initial = {}) => {
  const data = { ...initial }
  globalThis.localStorage = {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v) },
    removeItem: (k) => { delete data[k] },
  }
}

beforeEach(() => stubStorage())
afterEach(() => { delete globalThis.localStorage })

describe('App renders', () => {
  it('renders on a first visit with nothing stored', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Prompt Enhancer')
  })

  it('renders the compose column and the target rail', () => {
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Generate for')
    // The rail splits each target label on ' · ' into name + kind spans.
    expect(html).toContain('MiniMax H3')             // the default target
    expect(html).toContain('Scriptwriter')
    expect(html).toContain('DramaBox')
  })

  it('renders the history section, empty', () => {
    expect(renderToStaticMarkup(<App />)).toContain('History')
  })

  it('renders with a stored backend config, ComfyUI config and LoRA library', () => {
    stubStorage({
      [CFG_KEY]: JSON.stringify({ base: 'https://api.x.ai/v1', apiKey: 'xai-test', temperature: 0.4 }),
      [COMFY_CFG_KEY]: JSON.stringify({ url: 'http://127.0.0.1:8188', slot: 'b' }),
      [LORA_STORE_KEY]: JSON.stringify([
        { id: 'a', name: 'Anna', trigger: 'ohwx woman', kind: 'character', note: '' },
        { id: 's', name: 'MJ', trigger: 'aidmaMJ6.1', kind: 'style', note: '' },
      ]),
    })
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Prompt Enhancer')
    expect(html).toContain('Anna')          // the LoRA chips render
    expect(html).toContain('MJ')
  })

  it('renders when every stored value is corrupt', () => {
    stubStorage({ [CFG_KEY]: '{{{', [COMFY_CFG_KEY]: 'null', [LORA_STORE_KEY]: '"not an array"' })
    expect(() => renderToStaticMarkup(<App />)).not.toThrow()
  })

  it('renders with no localStorage at all (private mode)', () => {
    delete globalThis.localStorage
    expect(() => renderToStaticMarkup(<App />)).not.toThrow()
  })
})

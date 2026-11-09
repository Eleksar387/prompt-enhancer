import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { unloadOllamaModels } from '../src/api'

describe('unloadOllamaModels', () => {
  let f
  beforeEach(() => { f = vi.fn(); vi.stubGlobal('fetch', f) })
  afterEach(() => vi.unstubAllGlobals())

  it('does nothing for a cloud base or when disabled', async () => {
    await unloadOllamaModels({ base: 'https://api.anthropic.com/v1', unloadAfter: true })
    await unloadOllamaModels({ base: 'http://localhost:11434/v1', unloadAfter: false })
    expect(f).not.toHaveBeenCalled()
  })

  it('evicts each loaded model via the native API', async () => {
    f.mockResolvedValueOnce({ ok: true, json: async () => ({ models: [{ name: 'a:1' }, { name: 'b:2' }] }) })
    f.mockResolvedValue({ ok: true })
    await unloadOllamaModels({ base: 'http://localhost:11434/v1/', unloadAfter: true })
    expect(f.mock.calls[0][0]).toBe('http://localhost:11434/api/ps')
    const bodies = f.mock.calls.slice(1).map(c => { expect(c[0]).toBe('http://localhost:11434/api/generate'); return JSON.parse(c[1].body) })
    expect(bodies).toEqual([{ model: 'a:1', keep_alive: 0 }, { model: 'b:2', keep_alive: 0 }])
  })

  it('never throws on network failure', async () => {
    f.mockRejectedValue(new Error('down'))
    await expect(unloadOllamaModels({ base: 'http://localhost:11434/v1', unloadAfter: true })).resolves.toBeUndefined()
  })
})

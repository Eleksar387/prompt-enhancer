// fetchComfyLoraFiles: reading the lora file list off ComfyUI's /object_info
// for a lora-loader node class, since ComfyUI has no dedicated "list loras"
// endpoint. Covers both COMBO wire shapes it may report, the LoraLoader →
// LoraLoaderModelOnly fallback, and that a real network failure is not
// silently retried as if the class just "wasn't found".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchComfyLoraFiles, fetchComfyRefModFiles } from '../src/comfy.js'

describe('fetchComfyLoraFiles', () => {
  let f
  beforeEach(() => { f = vi.fn(); vi.stubGlobal('fetch', f) })
  afterEach(() => vi.unstubAllGlobals())

  it('reads the legacy [[...files], {...}] COMBO shape off LoraLoader', async () => {
    f.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ LoraLoader: { input: { required: { lora_name: [['a.safetensors', 'MinimaxH3\\b.safetensors'], {}] } } } }),
    })
    const out = await fetchComfyLoraFiles('http://127.0.0.1:8188')
    expect(out).toEqual(['a.safetensors', 'MinimaxH3\\b.safetensors'])
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][0]).toBe('http://127.0.0.1:8188/object_info/LoraLoader')
  })

  it('reads the newer [\'COMBO\', { options }] COMBO shape', async () => {
    f.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ LoraLoader: { input: { required: { lora_name: ['COMBO', { options: ['x.safetensors'] }] } } } }),
    })
    const out = await fetchComfyLoraFiles('http://127.0.0.1:8188')
    expect(out).toEqual(['x.safetensors'])
  })

  it('falls back to LoraLoaderModelOnly when LoraLoader is absent', async () => {
    f.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    f.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ LoraLoaderModelOnly: { input: { required: { lora_name: [['only.safetensors'], {}] } } } }),
    })
    const out = await fetchComfyLoraFiles('http://127.0.0.1:8188')
    expect(out).toEqual(['only.safetensors'])
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls[1][0]).toBe('http://127.0.0.1:8188/object_info/LoraLoaderModelOnly')
  })

  it('throws when neither class is present', async () => {
    f.mockResolvedValue({ ok: true, json: async () => ({}) })
    await expect(fetchComfyLoraFiles('http://127.0.0.1:8188')).rejects.toThrow(/neither a LoraLoader nor a LoraLoaderModelOnly/)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('propagates a network failure immediately, without trying the second class', async () => {
    f.mockRejectedValue(new Error('down'))
    await expect(fetchComfyLoraFiles('http://127.0.0.1:8188')).rejects.toThrow(/Network error reaching ComfyUI/)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('returns an empty array when the lora folder is empty, not an error', async () => {
    f.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ LoraLoader: { input: { required: { lora_name: [[], {}] } } } }),
    })
    await expect(fetchComfyLoraFiles('http://127.0.0.1:8188')).resolves.toEqual([])
  })
})

describe('fetchComfyRefModFiles', () => {
  let f
  beforeEach(() => { f = vi.fn(); vi.stubGlobal('fetch', f) })
  afterEach(() => vi.unstubAllGlobals())

  it('reads mod_1 off MiniMaxH3RefModsLoader and filters the "(none)" sentinel', async () => {
    f.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ MiniMaxH3RefModsLoader: { input: { required: { mod_1: [['(none)', 'armor/chromevisor', 'characters/mara'], {}] } } } }),
    })
    const out = await fetchComfyRefModFiles('http://127.0.0.1:8188')
    expect(out).toEqual(['armor/chromevisor', 'characters/mara'])
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][0]).toBe('http://127.0.0.1:8188/object_info/MiniMaxH3RefModsLoader')
  })

  it('throws a pack-specific message on a 200 {} response, with no fallback call', async () => {
    f.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    await expect(fetchComfyRefModFiles('http://127.0.0.1:8188')).rejects.toThrow(/MiniMaxH3RefModsLoader/)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('propagates a network failure immediately', async () => {
    f.mockRejectedValue(new Error('down'))
    await expect(fetchComfyRefModFiles('http://127.0.0.1:8188')).rejects.toThrow(/Network error reaching ComfyUI/)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('returns an empty array when only the sentinel is present, not an error', async () => {
    f.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ MiniMaxH3RefModsLoader: { input: { required: { mod_1: [['(none)'], {}] } } } }),
    })
    await expect(fetchComfyRefModFiles('http://127.0.0.1:8188')).resolves.toEqual([])
  })
})

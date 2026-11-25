import { describe, it, expect, vi, afterEach } from 'vitest'
import { isLlamaCpp, isCloud, providerOf, callOllama } from '../src/api'

describe('llama.cpp backend', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('recognises llama-server on port 8080 and treats it as local', () => {
    for (const b of ['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', 'http://localhost:8080'])
      expect(isLlamaCpp(b)).toBe(true)
    expect(isLlamaCpp('http://localhost:11434/v1')).toBe(false)
    expect(isLlamaCpp('http://localhost:80801/v1')).toBe(false)
    expect(isCloud('http://localhost:8080/v1')).toBe(false)
    expect(providerOf('http://localhost:8080/v1')).toBe('llamacpp')
    expect(providerOf('https://openrouter.ai/api/v1')).toBe('openrouter')
  })

  const run = async (base) => {
    let body
    vi.stubGlobal('fetch', vi.fn(async (_u, init) => {
      body = JSON.parse(init.body)
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] }) }
    }))
    await callOllama('m', 'hi', 'sys', { base, maxTokens: 100 }, 0.5, { format: 'json' })
    return body
  }

  it('sends response_format (not format) to llama-server in JSON mode', async () => {
    const b = await run('http://localhost:8080/v1')
    expect(b.response_format).toEqual({ type: 'json_object' })
    expect(b.format).toBeUndefined()
  })

  it('keeps Ollama-style format for a generic local base', async () => {
    const b = await run('http://localhost:11434/v1')
    expect(b.format).toBe('json')
    expect(b.response_format).toBeUndefined()
  })
})

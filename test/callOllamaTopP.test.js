import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { callOllama } from '../src/api'

const ok = { ok: true, json: async () => ({ choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }], usage: {} }) }
const body = (f, i = 0) => JSON.parse(f.mock.calls[i][1].body)

describe('callOllama top_p', () => {
  let f
  beforeEach(() => { f = vi.fn(); vi.stubGlobal('fetch', f) })
  afterEach(() => vi.unstubAllGlobals())
  const base = { base: 'http://localhost:11434/v1', apiKey: '', maxTokens: 256 }

  it('sends top_p when set', async () => {
    f.mockResolvedValue(ok)
    await callOllama('m', 'hi', 'sys', { ...base, topP: 0.9 }, 0.7)
    expect(body(f).top_p).toBe(0.9)
  })

  it('omits top_p when unset', async () => {
    f.mockResolvedValue(ok)
    await callOllama('m', 'hi', 'sys', base, 0.7)
    expect('top_p' in body(f)).toBe(false)
  })

  it('retries without top_p when the server rejects it', async () => {
    f.mockResolvedValueOnce({ ok: false, status: 400, clone() { return this }, json: async () => ({ error: { message: '`temperature` and `top_p` cannot both be specified' } }) })
    f.mockResolvedValueOnce(ok)
    await callOllama('m', 'hi', 'sys', { ...base, topP: 0.9 }, 0.7)
    expect(f).toHaveBeenCalledTimes(2)
    expect('top_p' in body(f, 1)).toBe(false)
  })
})

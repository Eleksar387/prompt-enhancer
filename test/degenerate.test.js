// Repetition-loop guard in callOllama (src/api.js): a local model that loops
// ("silver handles, silver handles, …") must be retried once, then rejected — never
// returned to the caller or saved to history.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { looksDegenerate, callOllama } from '../src/api.js'

const loop = 'she lifts the silver handles, ' + 'silver handles, '.repeat(400)
const prose = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')
const cfg = { base: 'http://localhost:11434/v1', apiKey: '', maxTokens: 100 }
const reply = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }) })

afterEach(() => vi.unstubAllGlobals())

describe('looksDegenerate', () => {
  it('flags a repetition loop', () => expect(looksDegenerate(loop)).toBe(true))
  it('passes ordinary text of any length', () => {
    expect(looksDegenerate(prose)).toBe(false)
    expect(looksDegenerate('short answer')).toBe(false)
    expect(looksDegenerate('')).toBe(false)
  })
  it('passes a repetitive-looking but real structure (JSON-ish list)', () => {
    const json = JSON.stringify({ shots: Array.from({ length: 60 }, (_, i) => ({ shot_number: i, description: `a different thing happens number ${i} in room ${i * 7}` })) })
    expect(looksDegenerate(json)).toBe(false)
  })
})

describe('callOllama loop guard', () => {
  it('retries once, colder and with a repetition penalty, and returns the good retry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(loop)).mockResolvedValueOnce(reply('a fine answer'))
    vi.stubGlobal('fetch', fetchMock)
    const out = await callOllama('m', 'hi', 'sys', cfg, 0.9)
    expect(out.text).toBe('a fine answer')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(body.temperature).toBe(0.3)
    expect(body.frequency_penalty).toBe(0.3)
  })

  it('throws a useful error when the retry loops too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(loop)))
    await expect(callOllama('m', 'hi', 'sys', cfg, 0.9)).rejects.toThrow(/stuck repeating itself.*context length/s)
  })

  it('does not retry a normal answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(prose))
    vi.stubGlobal('fetch', fetchMock)
    await callOllama('m', 'hi', 'sys', cfg, 0.9)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

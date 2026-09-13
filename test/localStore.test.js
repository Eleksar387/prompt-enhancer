// The localStorage store shared by the backend config, the ComfyUI config and the
// LoRA library.
//
// The failure modes tested here are the reason the three copies all had a
// try/catch: this code runs inside useState initializers, so anything it throws
// blanks the whole app. A private-mode browser, blocked site data or a cleared
// store can all make localStorage raise on access rather than return null, and the
// stored value is always from some earlier version of the app.
//
// There is no DOM in this environment, so localStorage is stubbed — which also
// lets each hostile case be provoked directly.

import { describe, it, expect, afterEach } from 'vitest'
import { makeLocalStore } from '../src/localStore.js'
import { sanitizeLoras } from '../src/loras.js'

const stub = (initial = {}) => {
  const data = { ...initial }
  globalThis.localStorage = {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v) },
    removeItem: (k) => { delete data[k] },
  }
  return data
}

const throwingStub = () => {
  globalThis.localStorage = {
    getItem: () => { throw new DOMException('blocked') },
    setItem: () => { throw new DOMException('quota') },
  }
}

afterEach(() => { delete globalThis.localStorage })

describe('makeLocalStore with defaults', () => {
  const DEFAULTS = { url: 'http://127.0.0.1:8188', slot: 'default' }

  it('returns the defaults when nothing is stored', () => {
    stub()
    expect(makeLocalStore('k', { defaults: DEFAULTS }).load()).toEqual(DEFAULTS)
  })

  it('round-trips a saved value', () => {
    stub()
    const s = makeLocalStore('k', { defaults: DEFAULTS })
    s.save({ url: 'http://other:9000', slot: 'b' })
    expect(s.load()).toEqual({ url: 'http://other:9000', slot: 'b' })
  })

  it('fills in a setting added after the value was stored', () => {
    stub({ k: JSON.stringify({ url: 'http://old' }) })
    expect(makeLocalStore('k', { defaults: DEFAULTS }).load())
      .toEqual({ url: 'http://old', slot: 'default' })
  })

  it('lets a stored value override a default', () => {
    stub({ k: JSON.stringify({ slot: 'mine' }) })
    expect(makeLocalStore('k', { defaults: DEFAULTS }).load().slot).toBe('mine')
  })

  it('falls back to the defaults on unparseable data', () => {
    stub({ k: '{not json' })
    expect(makeLocalStore('k', { defaults: DEFAULTS }).load()).toEqual(DEFAULTS)
  })

  it('writes to the key it was given, as JSON', () => {
    const data = stub()
    makeLocalStore('mykey', { defaults: DEFAULTS }).save({ url: 'x', slot: 'y' })
    expect(JSON.parse(data.mykey)).toEqual({ url: 'x', slot: 'y' })
  })
})

describe('makeLocalStore with a parse function', () => {
  const store = () => makeLocalStore('loras', { parse: sanitizeLoras })

  it('hands the parsed value straight through', () => {
    stub({ loras: JSON.stringify([{ id: 'a', name: 'Anna', trigger: 'ohwx woman', kind: 'character', note: '' }]) })
    expect(store().load()).toEqual([{ id: 'a', name: 'Anna', trigger: 'ohwx woman', kind: 'character', note: '' }])
  })

  it('gives the parser null when nothing is stored', () => {
    stub()
    expect(store().load()).toEqual([])
  })

  it('rejects a stored value of the wrong shape', () => {
    stub({ loras: JSON.stringify({ not: 'an array' }) })
    expect(store().load()).toEqual([])
  })
})

describe('sanitizeLoras', () => {
  it('drops entries without an id — they can never be selected', () => {
    expect(sanitizeLoras([{ trigger: 'x' }, { id: '', trigger: 'y' }])).toEqual([])
  })

  it('drops non-objects', () => {
    expect(sanitizeLoras(['a', null, 42, { id: 'ok' }])).toHaveLength(1)
  })

  it('coerces every field to the expected type', () => {
    const [l] = sanitizeLoras([{ id: 7, name: 42, trigger: null, kind: 'nonsense', note: {} }])
    expect(l).toEqual({ id: '7', name: '', trigger: '', kind: 'character', note: '' })
  })

  it('keeps kind: style but defaults anything else to character', () => {
    expect(sanitizeLoras([{ id: 'a', kind: 'style' }])[0].kind).toBe('style')
    expect(sanitizeLoras([{ id: 'a' }])[0].kind).toBe('character')
  })
})

describe('hostile storage', () => {
  it('load returns the defaults instead of throwing when access is blocked', () => {
    throwingStub()
    expect(() => makeLocalStore('k', { defaults: { a: 1 } }).load()).not.toThrow()
    expect(makeLocalStore('k', { defaults: { a: 1 } }).load()).toEqual({ a: 1 })
  })

  it('save swallows a quota error', () => {
    throwingStub()
    expect(() => makeLocalStore('k').save({ big: 'x' })).not.toThrow()
  })

  it('load survives localStorage not existing at all', () => {
    delete globalThis.localStorage
    expect(makeLocalStore('k', { defaults: { a: 1 } }).load()).toEqual({ a: 1 })
    expect(makeLocalStore('k', { parse: sanitizeLoras }).load()).toEqual([])
  })

  it('save survives localStorage not existing at all', () => {
    delete globalThis.localStorage
    expect(() => makeLocalStore('k').save({ a: 1 })).not.toThrow()
  })

  it('returns null with no defaults and nothing stored', () => {
    stub()
    expect(makeLocalStore('k').load()).toBeNull()
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { notifyDone, setNotifyEnabled, setNotifyQuiet, notifyEnabled } from '../src/notify'

const store = new Map()
const lsStub = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }

describe('notifyDone', () => {
  let made
  beforeEach(() => {
    made = []
    store.clear()
    globalThis.localStorage = lsStub
    globalThis.document = { hidden: true, hasFocus: () => false }
    globalThis.window = { focus() {} }
    setNotifyQuiet(false)
    globalThis.Notification = class { constructor(t, o) { made.push([t, o]) } close() {} }
    Notification.permission = 'granted'
  })
  it('fires only when enabled + granted + background', () => {
    expect(notifyDone('a')).toBe(false)           // not enabled
    setNotifyEnabled(true)
    expect(notifyDone('a', 'b')).toBe(true)
    expect(made).toHaveLength(1)
    Notification.permission = 'denied'
    expect(notifyDone('a')).toBe(false)
    Notification.permission = 'granted'
    document.hidden = false
    document.hasFocus = () => true
    expect(notifyDone('a')).toBe(false)           // foreground
  })
  it('quiet mode suppresses unless forced; no Notification is a no-op', () => {
    setNotifyEnabled(true)
    setNotifyQuiet(true)
    expect(notifyDone('a')).toBe(false)
    expect(notifyDone('a', '', { force: true })).toBe(true)
    delete globalThis.Notification
    expect(notifyDone('a')).toBe(false)
  })
  it('survives a throwing localStorage', () => {
    globalThis.localStorage = { getItem() { throw new Error('x') }, setItem() { throw new Error('x') } }
    expect(notifyEnabled()).toBe(false)
    expect(() => setNotifyEnabled(true)).not.toThrow()
  })
})

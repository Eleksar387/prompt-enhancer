// Browser notification when a generation finishes while this tab is in the background.
// Opt-in (localStorage + the browser's own permission). No React, no fetch.

const KEY = 'prompt-enhancer-notify'
let quiet = false

export const notifySupported = () => typeof Notification !== 'undefined'

export function notifyEnabled() {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function setNotifyEnabled(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* private mode etc. */ }
}

/** Must be called from a click. Resolves to 'granted' | 'denied' | 'default' | 'unsupported'. */
export async function requestNotifyPermission() {
  if (!notifySupported()) return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  try { return await Notification.requestPermission() } catch { return 'denied' }
}

/** Suppress per-item notifications while a queue run reports one summary instead. */
export function setNotifyQuiet(on) { quiet = !!on }

const inBackground = () => typeof document !== 'undefined' && (document.hidden || !document.hasFocus())

export function notifyDone(title, body = '', { force = false } = {}) {
  if (!notifySupported() || !notifyEnabled() || Notification.permission !== 'granted') return false
  if ((quiet && !force) || !inBackground()) return false
  try {
    const n = new Notification(title, { body, tag: 'prompt-enhancer-done' })
    n.onclick = () => { try { window.focus() } catch { /* */ } n.close() }
    return true
  } catch { return false }
}

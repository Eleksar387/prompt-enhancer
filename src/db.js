// History + caption cache live in the local sidecar (server/), reached at /api/*
// (Vite proxies it in dev, `vite preview` in prod). This replaces the old
// browser-IndexedDB store, which was silently wiped twice — see CLAUDE.md
// "State and persistence" and the plan. The legacy IndexedDB code is kept, unwired,
// in src/db.idb.js and is read once by migrateFromIndexedDB().

import { getAllHistory as idbGetAllHistory, getAllCaptions as idbGetAllCaptions } from './db.idb.js'

const API = '/api'

// App wires this to a persistent "history server unreachable — nothing is being
// saved" banner. Every write goes through apiFetch, so one place raises it.
let onWriteError = null
export function setWriteErrorHandler(fn) { onWriteError = fn }

async function apiFetch(path, opts = {}) {
  const { quiet, ...init } = opts
  const isWrite = init.method && init.method !== 'GET'
  let res
  try {
    res = await fetch(API + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    })
  } catch (e) {
    if (isWrite && !quiet) onWriteError?.(e)
    throw e
  }
  if (!res.ok) {
    const err = new Error(`${init.method || 'GET'} ${path} → ${res.status}`)
    if (isWrite && !quiet) onWriteError?.(err)
    throw err
  }
  if (res.status === 204) return null
  const ct = res.headers.get('content-type') || ''
  return ct.includes('json') ? res.json() : res.text()
}

// ── health ─────────────────────────────────────────────────────────────────
export async function checkHealth() {
  const r = await fetch(API + '/health', { cache: 'no-store' })
  if (!r.ok) throw new Error(`health ${r.status}`)
  return r.json() // { ok, entries }
}

// ── history ────────────────────────────────────────────────────────────────
// Metadata only: blob-bearing fields come back as { blobRef, hash, mediaType, url }
// with NO bytes. Renamed from getAllHistory so a missed call site fails loudly.
export function listHistory() {
  return apiFetch('/history')
}

// One entry. inline:true → blob fields rehydrated to real base64 (for restore()).
export function getHistoryEntry(id, { inline = false } = {}) {
  return apiFetch(`/history/${encodeURIComponent(id)}${inline ? '?inline=1' : ''}`)
}

export function addHistoryEntry(entry) {
  return apiFetch(`/history/${encodeURIComponent(entry.id)}`, {
    method: 'PUT', body: JSON.stringify(entry),
  })
}

export function updateHistoryEntry(id, patch) {
  return apiFetch(`/history/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  })
}

export function setHistoryEntryProject(id, project) {
  return updateHistoryEntry(id, { project: project || null })
}

export function deleteHistoryEntry(id) {
  return apiFetch(`/history/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function clearHistory() {
  return apiFetch('/history/clear', { method: 'POST' })
}

// ── queue ──────────────────────────────────────────────────────────────────
// Pending "generate this later" items, persisted server-side so a reload
// doesn't lose them. Metadata-only list (no bytes), same contract as history.
export function listQueue() {
  return apiFetch('/queue')
}

export function getQueueItem(id, { inline = false } = {}) {
  return apiFetch(`/queue/${encodeURIComponent(id)}${inline ? '?inline=1' : ''}`)
}

export function addQueueItem(item) {
  return apiFetch(`/queue/${encodeURIComponent(item.id)}`, {
    method: 'PUT', body: JSON.stringify(item),
  })
}

export function updateQueueItem(id, patch) {
  return apiFetch(`/queue/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  })
}

export function deleteQueueItem(id) {
  return apiFetch(`/queue/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function clearQueue() {
  return apiFetch('/queue/clear', { method: 'POST' })
}

// ── projects (was localStorage — now async) ────────────────────────────────
export async function loadProjects() {
  try { return await apiFetch('/projects') } catch { return [] }
}
export function saveProjects(list) {
  return apiFetch('/projects', { method: 'PUT', body: JSON.stringify(list) })
}

// ── caption cache (L2) ─────────────────────────────────────────────────────
export async function getCaption(key) {
  const r = await apiFetch(`/captions/${encodeURIComponent(key)}`)
  return r ? r.caption : null
}
export function putCaption(key, caption) {
  // L2 cache write — a failure here just means a re-describe next time, not lost
  // work, so it must not raise the "nothing is being saved" banner.
  return apiFetch(`/captions/${encodeURIComponent(key)}`, {
    method: 'PUT', body: JSON.stringify({ caption }), quiet: true,
  })
}
export function clearCaptions() {
  return apiFetch('/captions/clear', { method: 'POST' })
}

// ── import / export ────────────────────────────────────────────────────────
export function importEntries(entries, captions) {
  return apiFetch('/import', {
    method: 'POST', body: JSON.stringify({ entries, captions }),
  })
}
// exportHistory in App downloads this directly (full, with bytes).
export const HISTORY_EXPORT_URL = API + '/export?inline=1'

// ── one-shot migrations ────────────────────────────────────────────────────
export function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Old capped-10 localStorage['gen-history'] (predates IndexedDB) → sidecar.
export async function migrateFromLocalStorage() {
  try {
    const raw = localStorage.getItem('gen-history')
    if (!raw) return
    const items = JSON.parse(raw)
    if (Array.isArray(items) && items.length) {
      await importEntries(items.map((it) => ({ ...it, id: it.id || generateId(), type: it.type || 'standard' })))
    }
    localStorage.removeItem('gen-history')
  } catch { /* best effort */ }
}

// Browser IndexedDB (the previous store) → sidecar. Runs once; the IndexedDB is
// left intact as a cold backup. Guard flag so it never re-imports.
const IDB_MIGRATED_KEY = 'idb-migrated-v1'
export async function migrateFromIndexedDB() {
  try {
    if (localStorage.getItem(IDB_MIGRATED_KEY)) return
    const [entries, capRecords] = await Promise.all([
      idbGetAllHistory().catch(() => []),
      idbGetAllCaptions().catch(() => []),
    ])
    if (entries.length || capRecords.length) {
      const captions = {}
      for (const r of capRecords) if (r && r.key) captions[r.key] = r.caption
      await importEntries(entries, captions)
    }
    localStorage.setItem(IDB_MIGRATED_KEY, String(Date.now()))
  } catch { /* best effort — retried next load until the flag is set */ }
}

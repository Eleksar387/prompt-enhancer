import { join } from 'node:path'
import { readdirSync, readFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { DIRS, PROJECTS_FILE, atomicWrite } from './paths.mjs'
import { ingestEntry, rehydrateEntry, stripEntry } from './ingest.mjs'

// ── history ────────────────────────────────────────────────────────────────
// In-memory index of STORED entries (blob refs, no bytes → a few KB each).
// Disk is the source of truth; the index is derived and rebuilt on boot, so a
// bad index is never a data-loss vector. Single process, single user → no locks.

const index = new Map() // id → stored entry

const entryFile = (id) => join(DIRS.entries, `${encodeURIComponent(id)}.json`)

export function loadIndex() {
  index.clear()
  let files = []
  try { files = readdirSync(DIRS.entries).filter((f) => f.endsWith('.json')) } catch { return }
  for (const f of files) {
    try {
      const e = JSON.parse(readFileSync(join(DIRS.entries, f), 'utf8'))
      if (e && e.id) index.set(e.id, e)
    } catch (err) {
      console.error(`[store] skipping unreadable entry ${f}: ${err.message}`)
    }
  }
  console.log(`[store] ${index.size} history entries loaded from ${DIRS.entries}`)
}

const byTsDesc = (a, b) => (b.ts || 0) - (a.ts || 0)

export function listHistory() {
  return [...index.values()].sort(byTsDesc).map(stripEntry)
}

export function getHistory(id, { inline = false } = {}) {
  const e = index.get(id)
  if (!e) return null
  return inline ? rehydrateEntry(e) : stripEntry(e)
}

// Upsert. `full` carries inline bytes; we ingest (split blobs) then persist.
export function putHistory(full) {
  if (!full || !full.id) throw new Error('entry needs an id')
  const stored = ingestEntry(full)
  atomicWrite(entryFile(full.id), JSON.stringify(stored, null, 2))
  index.set(full.id, stored)
  return full.id
}

// Shallow-merge a patch (may carry inline blobs) into an existing entry.
// No-op if the id is gone (matches the old updateHistoryEntry contract).
export function patchHistory(id, patch) {
  const cur = index.get(id)
  if (!cur) return null
  const merged = { ...rehydrateEntry(cur), ...patch, id }
  return putHistory(merged)
}

export function trashDir(sub) {
  const d = join(DIRS.trash, sub)
  mkdirSync(d, { recursive: true })
  return d
}

// Soft delete — move the entry file into trash/<ISO-ts>/. Blobs stay.
export function deleteHistory(id) {
  const src = entryFile(id)
  index.delete(id)
  if (existsSync(src)) {
    renameSync(src, join(trashDir(new Date().toISOString().replace(/[:.]/g, '-')), `${encodeURIComponent(id)}.json`))
  }
  return true
}

// Soft clear — move every entry file into one trash/<ISO-ts>/ folder.
export function clearHistory() {
  const dest = trashDir(new Date().toISOString().replace(/[:.]/g, '-'))
  let moved = 0
  for (const id of [...index.keys()]) {
    const src = entryFile(id)
    if (existsSync(src)) { renameSync(src, join(dest, `${encodeURIComponent(id)}.json`)); moved++ }
  }
  index.clear()
  return moved
}

export function historyCount() { return index.size }

// ── projects ───────────────────────────────────────────────────────────────
export function loadProjects() {
  try {
    const arr = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'))
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : []
  } catch { return [] }
}
export function saveProjects(list) {
  const clean = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()) : []
  atomicWrite(PROJECTS_FILE, JSON.stringify(clean, null, 2))
  return clean
}

// ── caption cache ──────────────────────────────────────────────────────────
// One file per key (keys are long visionCacheKey strings). Per-file writes mean
// the up-to-6 concurrent putCaption() calls from ref-mode captioning never race.
const captionFile = (key) => join(DIRS.captions, `${encodeURIComponent(key)}.json`)

export function getCaption(key) {
  try { return JSON.parse(readFileSync(captionFile(key), 'utf8')).caption ?? null } catch { return null }
}
export function putCaption(key, caption) {
  atomicWrite(captionFile(key), JSON.stringify({ caption, ts: Date.now() }))
}
export function clearCaptions() {
  let n = 0
  try {
    for (const f of readdirSync(DIRS.captions)) {
      if (f.endsWith('.json')) {
        renameSync(join(DIRS.captions, f), join(trashDir(`captions-${new Date().toISOString().replace(/[:.]/g, '-')}`), f))
        n++
      }
    }
  } catch { /* none */ }
  return n
}

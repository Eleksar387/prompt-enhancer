import { join } from 'node:path'
import { readdirSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { DIRS, atomicWrite } from './paths.mjs'
import { ingestEntry, rehydrateEntry, stripEntry } from './ingest.mjs'
import { trashDir } from './store.mjs'

// ── queue ─────────────────────────────────────────────────────────────────
// Pending "generate this later" items — same on-disk shape and blob machinery
// as history entries (ingestEntry/rehydrateEntry/stripEntry, content-addressed
// blobs), but a separate store: a queue item isn't a record of a generation,
// it's a request for one. Sorted ascending (FIFO) — history is newest-first,
// the queue is oldest-first (process what was added earliest, first).

const index = new Map() // id → stored item

const itemFile = (id) => join(DIRS.queue, `${encodeURIComponent(id)}.json`)

export function loadQueueIndex() {
  index.clear()
  let files = []
  try { files = readdirSync(DIRS.queue).filter((f) => f.endsWith('.json')) } catch { return }
  for (const f of files) {
    try {
      const e = JSON.parse(readFileSync(join(DIRS.queue, f), 'utf8'))
      if (!e || !e.id) continue
      // A `running` item on disk with no process actually running it is just a
      // stuck state left by a crash or reload mid-run — demote it back to
      // `queued` so "Process all" picks it up again instead of it hanging forever.
      if (e.status === 'running') e.status = 'queued'
      index.set(e.id, e)
    } catch (err) {
      console.error(`[queueStore] skipping unreadable item ${f}: ${err.message}`)
    }
  }
  console.log(`[queueStore] ${index.size} queue items loaded from ${DIRS.queue}`)
}

const byCreatedAsc = (a, b) => (a.createdAt || 0) - (b.createdAt || 0)

export function listQueue() {
  return [...index.values()].sort(byCreatedAsc).map(stripEntry)
}

export function getQueue(id, { inline = false } = {}) {
  const e = index.get(id)
  if (!e) return null
  return inline ? rehydrateEntry(e) : stripEntry(e)
}

// Upsert. `full` carries inline bytes; we ingest (split blobs) then persist.
export function putQueue(full) {
  if (!full || !full.id) throw new Error('queue item needs an id')
  const stored = ingestEntry(full)
  atomicWrite(itemFile(full.id), JSON.stringify(stored, null, 2))
  index.set(full.id, stored)
  return full.id
}

// Shallow-merge a patch into an existing item. No-op if the id is gone.
export function patchQueue(id, patch) {
  const cur = index.get(id)
  if (!cur) return null
  const merged = { ...rehydrateEntry(cur), ...patch, id }
  return putQueue(merged)
}

// Soft delete — move the item file into trash/<ISO-ts>/. Blobs stay (shared
// content-addressed store with history; nothing to reclaim per-item).
export function deleteQueue(id) {
  const src = itemFile(id)
  index.delete(id)
  if (existsSync(src)) {
    renameSync(src, join(trashDir(`queue-${new Date().toISOString().replace(/[:.]/g, '-')}`), `${encodeURIComponent(id)}.json`))
  }
  return true
}

// Soft clear — move every queue item file into one trash/<ISO-ts>/ folder.
export function clearQueue() {
  const dest = trashDir(`queue-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  let moved = 0
  for (const id of [...index.keys()]) {
    const src = itemFile(id)
    if (existsSync(src)) { renameSync(src, join(dest, `${encodeURIComponent(id)}.json`)); moved++ }
  }
  index.clear()
  return moved
}

export function queueCount() { return index.size }

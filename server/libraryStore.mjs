import { join } from 'node:path'
import { readdirSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { DIRS, atomicWrite } from './paths.mjs'
import { ingestEntry, stripEntry } from './ingest.mjs'
import { trashDir } from './store.mjs'

// ── library ───────────────────────────────────────────────────────────────
// Standalone reusable images — not tied to any generation. Same on-disk shape
// and blob machinery as history/queue (ingestEntry/stripEntry, content-addressed
// blobs), but items are flat: { id, ts, fileName, mediaType, base64 }. Because
// blobPaths.mjs's mapBlobNodes treats ANY object carrying a `base64` key as a
// whole blob node — including the top-level object itself — ingestEntry/
// stripEntry work on this flat shape directly, with no nested wrapper needed.
// Sorted newest-first (browsing library, like history — not a work queue).

const index = new Map() // id → stored item

const itemFile = (id) => join(DIRS.library, `${encodeURIComponent(id)}.json`)

export function loadLibraryIndex() {
  index.clear()
  let files = []
  try { files = readdirSync(DIRS.library).filter((f) => f.endsWith('.json')) } catch { return }
  for (const f of files) {
    try {
      const e = JSON.parse(readFileSync(join(DIRS.library, f), 'utf8'))
      if (!e || !e.id) continue
      index.set(e.id, e)
    } catch (err) {
      console.error(`[libraryStore] skipping unreadable item ${f}: ${err.message}`)
    }
  }
  console.log(`[libraryStore] ${index.size} library items loaded from ${DIRS.library}`)
}

const byTsDesc = (a, b) => (b.ts || 0) - (a.ts || 0)

export function listLibrary() {
  return [...index.values()].sort(byTsDesc).map(stripEntry)
}

// Upsert. `full` carries inline bytes; we ingest (split into a blob) then persist.
export function putLibrary(full) {
  if (!full || !full.id) throw new Error('library item needs an id')
  const stored = ingestEntry(full)
  atomicWrite(itemFile(full.id), JSON.stringify(stored, null, 2))
  index.set(full.id, stored)
  return full.id
}

// Shallow-merge a patch into an existing item. Unlike putQueue/patchQueue,
// this never rehydrates/re-ingests — a patch here only ever touches `role`/
// `captions` (see App.jsx's saveLibraryCaption/setLibraryRole), never a blob
// field, so merging straight onto the already-ingested stored record (which
// still carries its blobRef/hash/bytesKey untouched) is correct and avoids
// a pointless re-read-and-rewrite of the image bytes on every caption edit.
// No-op if the id is gone.
export function patchLibrary(id, patch) {
  const cur = index.get(id)
  if (!cur) return null
  const merged = { ...cur, ...patch, id }
  atomicWrite(itemFile(id), JSON.stringify(merged, null, 2))
  index.set(id, merged)
  return id
}

// Soft delete — move the item file into trash/<ISO-ts>/. The blob itself stays
// (shared content-addressed store with history/queue; nothing to reclaim
// per-item, and another entry may still reference the same bytes).
export function deleteLibrary(id) {
  const src = itemFile(id)
  index.delete(id)
  if (existsSync(src)) {
    renameSync(src, join(trashDir(`library-${new Date().toISOString().replace(/[:.]/g, '-')}`), `${encodeURIComponent(id)}.json`))
  }
  return true
}

export function libraryCount() { return index.size }

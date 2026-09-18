import { join } from 'node:path'
import { readdirSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { DIRS, atomicWrite } from './paths.mjs'
import { ingestEntry, stripEntry } from './ingest.mjs'
import { trashDir } from './store.mjs'

// ── voice library ─────────────────────────────────────────────────────────
// Standalone reusable voice-timbre samples — not tied to any generation.
// Same on-disk shape and blob machinery as the image library (ingestEntry/
// stripEntry, content-addressed blobs — both are media-type-agnostic, so
// mediaType: 'audio/*' works unchanged). Items are flat:
// { id, ts, fileName, mediaType, base64, characterName }. Sorted newest-first.

const index = new Map() // id → stored item

const itemFile = (id) => join(DIRS.voiceLibrary, `${encodeURIComponent(id)}.json`)

export function loadVoiceLibraryIndex() {
  index.clear()
  let files = []
  try { files = readdirSync(DIRS.voiceLibrary).filter((f) => f.endsWith('.json')) } catch { return }
  for (const f of files) {
    try {
      const e = JSON.parse(readFileSync(join(DIRS.voiceLibrary, f), 'utf8'))
      if (!e || !e.id) continue
      index.set(e.id, e)
    } catch (err) {
      console.error(`[voiceLibraryStore] skipping unreadable item ${f}: ${err.message}`)
    }
  }
  console.log(`[voiceLibraryStore] ${index.size} voice library items loaded from ${DIRS.voiceLibrary}`)
}

const byTsDesc = (a, b) => (b.ts || 0) - (a.ts || 0)

export function listVoiceLibrary() {
  return [...index.values()].sort(byTsDesc).map(stripEntry)
}

// Upsert. `full` carries inline bytes; we ingest (split into a blob) then persist.
export function putVoiceLibrary(full) {
  if (!full || !full.id) throw new Error('voice library item needs an id')
  const stored = ingestEntry(full)
  atomicWrite(itemFile(full.id), JSON.stringify(stored, null, 2))
  index.set(full.id, stored)
  return full.id
}

// Whitelisted shallow-merge patch — unlike putVoiceLibrary/putLibrary, this
// never re-ingests, so a patch must never be allowed to smuggle a raw
// `base64` field onto a record that already holds blobRef/hash/bytesKey.
// `characterName` is the only field this feature ever patches.
const PATCHABLE = new Set(['characterName'])

export function patchVoiceLibrary(id, patch) {
  const cur = index.get(id)
  if (!cur) return null
  const safe = {}
  for (const k of Object.keys(patch || {})) if (PATCHABLE.has(k)) safe[k] = patch[k]
  const merged = { ...cur, ...safe, id }
  atomicWrite(itemFile(id), JSON.stringify(merged, null, 2))
  index.set(id, merged)
  return id
}

// Soft delete — move the item file into trash/<ISO-ts>/. The blob itself
// stays (shared content-addressed store; nothing to reclaim per-item).
export function deleteVoiceLibrary(id) {
  const src = itemFile(id)
  index.delete(id)
  if (existsSync(src)) {
    renameSync(src, join(trashDir(`voice-library-${new Date().toISOString().replace(/[:.]/g, '-')}`), `${encodeURIComponent(id)}.json`))
  }
  return true
}

export function voiceLibraryCount() { return index.size }

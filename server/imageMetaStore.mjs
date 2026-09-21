import { readFileSync } from 'node:fs'
import { IMAGE_META_FILE, atomicWrite } from './paths.mjs'

// ── per-image metadata ───────────────────────────────────────────────────
// ONE record per image, keyed by its content hash (imageHash of the bytes —
// the same key the blob store uses), shared by every generation and by the
// "Reuse image" gallery: { [hash]: { role, captions: { [roleId]: text }, ts } }.
// History entries and library items still carry their own role/caption fields
// (a generation's record of what it used); this store is what the app treats
// as the image's CURRENT role and per-role descriptions, so a newer generation
// using the same image can never shadow or overwrite them.
// One small JSON file, in-memory index, atomic writes (like projects.json).

let meta = {}

export function loadImageMeta() {
  try {
    const parsed = JSON.parse(readFileSync(IMAGE_META_FILE, 'utf8'))
    meta = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    meta = {}
  }
  console.log(`[imageMetaStore] ${Object.keys(meta).length} image records loaded`)
}

export function listImageMeta() {
  return meta
}

// Merge a patch into one image's record. `role` replaces (null clears it);
// `captions` merges PER ROLE KEY, so two writers touching different roles of
// the same image can't clobber each other. An unknown hash is created.
export function patchImageMeta(hash, patch) {
  if (!hash || typeof hash !== 'string') throw new Error('image meta needs a hash')
  const cur = meta[hash] || { role: null, captions: {} }
  const next = { ...cur, ts: Date.now() }
  if (patch && 'role' in patch) next.role = patch.role || null
  if (patch && patch.captions && typeof patch.captions === 'object') {
    next.captions = { ...(cur.captions || {}) }
    for (const [k, v] of Object.entries(patch.captions)) {
      if (typeof v === 'string') next.captions[k] = v
    }
  }
  meta = { ...meta, [hash]: next }
  atomicWrite(IMAGE_META_FILE, JSON.stringify(meta, null, 2))
  return next
}

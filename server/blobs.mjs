import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { DIRS, atomicWrite } from './paths.mjs'
import { imageHash } from './hash.mjs'

// Content-addressed blob store. Key = imageHash(base64) — the SAME hash the
// client already stamps onto image nodes and folds into its vision-cache key.
// Two entries that reference the same image share one file on disk.
//
// Blobs are NEVER garbage-collected: an orphaned blob wastes a few KB, a
// wrongly-deleted one loses data. Disk is cheap.

const blobPath = (hash) => join(DIRS.blobs, hash)
const typePath = (hash) => join(DIRS.blobs, `${hash}.type`)

export function hasBlob(hash) {
  return existsSync(blobPath(hash))
}

// base64 → hash. Writes `<hash>` (raw bytes) + `<hash>.type` (media type) once.
export function putBlob(base64, mediaType = 'application/octet-stream') {
  const hash = imageHash(base64)
  if (!hasBlob(hash)) {
    atomicWrite(blobPath(hash), Buffer.from(base64, 'base64'))
    atomicWrite(typePath(hash), String(mediaType || 'application/octet-stream'))
  } else if (!existsSync(typePath(hash))) {
    atomicWrite(typePath(hash), String(mediaType || 'application/octet-stream'))
  }
  return hash
}

// hash → { base64, mediaType } or null.
export function getBlob(hash) {
  if (!hasBlob(hash)) return null
  const buf = readFileSync(blobPath(hash))
  let mediaType = 'application/octet-stream'
  try { mediaType = readFileSync(typePath(hash), 'utf8').trim() || mediaType } catch { /* older blob */ }
  return { base64: buf.toString('base64'), buf, mediaType }
}

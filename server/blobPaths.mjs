// Which nodes inside a history entry carry image/audio/video bytes.
//
// Rather than enumerate paths (firstImg, refImages[], outputs[].images[],
// framePrompts[].frames[k].image, …) — which drift every time the entry shape
// changes — we treat ANY plain object that has a `base64` or `b64` string
// property as a blob node. That is exactly the shape every byte-carrying node in
// buildSnapshot() / serializeRefImages() / serializeFramePrompts() uses, and
// nothing else in an entry looks like it.
//
// `transform(node, key)` is called for each blob node (key = 'base64' | 'b64').
// Return value replaces the node in place. Used by both ingest and rehydrate.

const BLOB_KEYS = ['base64', 'b64']

function blobKeyOf(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  for (const k of BLOB_KEYS) if (typeof obj[k] === 'string' && obj[k]) return k
  return null
}

export function mapBlobNodes(value, transform) {
  if (Array.isArray(value)) {
    return value.map((v) => mapBlobNodes(v, transform))
  }
  if (value && typeof value === 'object') {
    const key = blobKeyOf(value)
    if (key) return transform(value, key)
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapBlobNodes(v, transform)
    return out
  }
  return value
}

// A rehydrated blob node — `{ blobRef, hash, mediaType, ... }` with no bytes.
export function isRef(obj) {
  return obj && typeof obj === 'object' && typeof obj.blobRef === 'string'
}

export function mapRefNodes(value, transform) {
  if (Array.isArray(value)) return value.map((v) => mapRefNodes(v, transform))
  if (value && typeof value === 'object') {
    if (isRef(value)) return transform(value)
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapRefNodes(v, transform)
    return out
  }
  return value
}

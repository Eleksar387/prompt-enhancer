import { mapBlobNodes, mapRefNodes } from './blobPaths.mjs'
import { putBlob, getBlob } from './blobs.mjs'

// Full entry (base64 inline) → stored entry (blob nodes replaced by refs).
// Each blob node `{ base64|b64, mediaType, ...siblings }` becomes
// `{ blobRef: <hash>, hash: <hash>, bytesKey: 'base64'|'b64', mediaType, ...siblings }`.
// bytesKey records which key held the bytes so rehydrate restores it exactly —
// client code (buildSnapshot uses `base64`, outputs/frames use `b64`) is unchanged.
export function ingestEntry(entry) {
  return mapBlobNodes(entry, (node, key) => {
    const { [key]: base64, ...rest } = node
    const hash = putBlob(base64, node.mediaType)
    return { ...rest, blobRef: hash, hash, bytesKey: key, mediaType: node.mediaType || rest.mediaType }
  })
}

// Stored entry → full entry (bytes read back from disk under the original key).
// A blob missing on disk leaves the node as a ref (never throws) so one lost
// blob can't make a whole entry unreadable.
export function rehydrateEntry(entry) {
  return mapRefNodes(entry, (ref) => {
    const blob = getBlob(ref.blobRef)
    const key = ref.bytesKey || 'base64'
    const { blobRef, bytesKey, ...rest } = ref
    if (!blob) return ref
    return { ...rest, [key]: blob.base64, mediaType: rest.mediaType || blob.mediaType }
  })
}

// Stored entry → view for GET (no bytes, but a ready-to-use <img src>).
export function stripEntry(entry) {
  return mapRefNodes(entry, (ref) => {
    const { bytesKey, ...rest } = ref
    return { ...rest, url: `/api/blob/${ref.blobRef}` }
  })
}

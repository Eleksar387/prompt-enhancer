// ─────────────────────────────────────────────────────────────────────────────
// MUST STAY BYTE-IDENTICAL WITH `src/utils.js` (cyrb53 + imageHash).
// The client hashes an image's base64 for its vision-caption cache key
// (visionCacheKey); this server hashes the same base64 for the blob filename.
// If the two implementations ever diverge, blob dedupe breaks AND every restored
// history entry misses the caption cache. Change both files together.
// ─────────────────────────────────────────────────────────────────────────────

// public-domain cyrb53 (Bryc) — fast 53-bit non-crypto string hash, base-36 out.
// Used only for cache keys / content addressing, never security.
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

// Content fingerprint of an image's base64 payload. Length-prefixed to cut
// collisions further. 53-bit hash: a collision across the low hundreds of images
// a single user accumulates is accepted risk (see the plan) — do NOT swap for
// SHA-256, that would break parity with the client's vision cache.
export const imageHash = (base64) => `${base64.length.toString(36)}-${cyrb53(base64)}`

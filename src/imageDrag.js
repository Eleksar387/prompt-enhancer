// In-app image drag payload.
//
// HTML drag-and-drop can only carry strings, and a base64 image is up to a few
// MB — serialising that through dataTransfer.setData is slow and flaky. So we
// keep the actual payload here in module scope and put only a marker MIME type
// on the dataTransfer, then read the payload back on drop.

export const DRAG_MIME = 'application/x-pe-image'

let payload = null

export const setDragImage = (obj) => { payload = obj }
export const peekDragImage = () => payload
export const takeDragImage = () => { const p = payload; payload = null; return p }

export const hasDragImage = (dt) => {
  if (!dt) return false
  try { return Array.from(dt.types || []).includes(DRAG_MIME) } catch { return false }
}

// DEV-only seam: the payload lives in module scope (base64 is too big for
// dataTransfer), which a headless driver can't reach. Compiled out of prod.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__peImageDrag = { setDragImage, peekDragImage, takeDragImage, hasDragImage, DRAG_MIME }
}

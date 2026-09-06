import { useState, useMemo, useRef, useEffect } from 'react'
import { MINIMAX_H3_REF_ROLES } from '../constants'
import { DRAG_MIME, setDragImage } from '../imageDrag'

const roleLabel = (id) => MINIMAX_H3_REF_ROLES.find(r => r.id === id)?.label || id

const CAP = 60  // most thumbnails to render at once

// Cheap dedupe key — avoids holding a second reference to every multi-MB base64
// string as a Map key. Length + head + tail + filename is unique enough for our
// inputs (all normalised to <=1536px JPEG on load).
const keyOf = (b, fileName) => `${fileName || ''}|${b.length}|${b.slice(0, 64)}|${b.slice(-64)}`

// Walk every history entry and collect the unique images it stored — both the
// input images (first/mid/last/ref frames) and any Grok-rendered output images
// (`outputs[].images[]`, which key their bytes under `b64`). Returns
// { images (newest-first), stats } — stats drives the DEV diagnostic and the
// empty-state copy. Legacy entries that stored only a filename string never pass
// the base64 gate, so they are silently skipped.
function collectImages(history) {
  const byKey = new Map()
  const stats = { entries: (history || []).length, rawFields: 0, objWithBase64: 0, collected: 0 }
  const consider = (im, ts, slot) => {
    if (im == null) return
    stats.rawFields++
    const b64 = typeof im === 'object' ? (im.base64 || im.b64) : null
    if (!b64) return
    stats.objWithBase64++
    const key = keyOf(b64, im.fileName)
    const prev = byKey.get(key)
    if (prev && prev.ts >= ts) { prev.uses++; return }
    const isRender = slot === 'render'
    byKey.set(key, {
      key,
      base64: b64,
      mediaType: im.mediaType || 'image/jpeg',
      fileName: im.fileName || (isRender ? `grok-render.${(im.mediaType || 'image/png').split('/')[1] || 'png'}` : 'image.jpg'),
      hash: im.hash || null,
      role: im.role || null,
      note: im.note || '',
      render: isRender ? (im.upscaled ? '🎨 2K' : '🎨') : null,
      slot,
      ts,
      uses: prev ? prev.uses + 1 : 1,
    })
  }
  for (const h of history || []) {
    const ts = h.ts || 0
    consider(h.firstImg, ts, 'first')
    consider(h.midImg, ts, 'mid')
    consider(h.lastImg, ts, 'last')
    if (Array.isArray(h.refImages)) h.refImages.forEach(im => consider(im, ts, 'ref'))
    if (Array.isArray(h.outputs)) {
      for (const o of h.outputs) {
        if (o && Array.isArray(o.images)) o.images.forEach(im => consider(im, ts, 'render'))
      }
    }
  }
  stats.collected = byKey.size
  return { images: [...byKey.values()].sort((a, b) => b.ts - a.ts), stats }
}

export default function HistoryImageGallery({ history, onPick, pickHint }) {
  const [open, setOpen] = useState(false)
  const touchedRef = useRef(false)
  const { images, stats } = useMemo(() => collectImages(history), [history])

  // Open it the first time images are available so it's actually discoverable;
  // once the user toggles it themselves, respect that for the rest of the session.
  useEffect(() => {
    if (!touchedRef.current && images.length > 0) setOpen(true)
  }, [images.length])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    console.debug('[HistoryImageGallery]', stats)
    if (stats.collected === 0 && stats.objWithBase64 > 0)
      console.warn(`[HistoryImageGallery] BUG: ${stats.objWithBase64} stored image object(s) but 0 collected`)
  }, [stats])

  // No history at all — stay out of the way entirely.
  if (images.length === 0 && stats.entries === 0) return null

  const toggle = () => { touchedRef.current = true; setOpen(v => !v) }

  const onDragStart = (e, img) => {
    setDragImage({ base64: img.base64, mediaType: img.mediaType, fileName: img.fileName, hash: img.hash })
    try {
      e.dataTransfer.setData(DRAG_MIME, img.fileName || '1')
      e.dataTransfer.setData('text/plain', img.fileName || 'image')
      e.dataTransfer.effectAllowed = 'copy'
    } catch { /* older browsers */ }
  }

  const shown = images.slice(0, CAP)

  return (
    <div style={{ marginBottom: 16 }}>
      <button
        onClick={toggle}
        style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--pe-ink-3)', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.5px' }}
      >
        <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        ♻ Reuse image from history ({images.length})
      </button>

      {open && (
        <div style={{ marginTop: 10, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '12px 14px' }}>
          {images.length === 0 ? (
            <p style={{ fontSize: 13, color: stats.objWithBase64 > 0 ? 'var(--pe-warn)' : 'var(--pe-ink-3)', margin: 0, lineHeight: 1.6 }}>
              {stats.objWithBase64 > 0
                ? `Found ${stats.objWithBase64} stored image${stats.objWithBase64 > 1 ? 's' : ''} but none could be read — this looks like a bug.`
                : "No reusable images yet — run a generation with an image loaded and it'll show up here."}
            </p>
          ) : (<>
          <p style={{ fontSize: 13, color: 'var(--pe-ink-3)', margin: '0 0 10px', lineHeight: 1.5 }}>
            Every image used in a past generation. Drag one onto an image slot below{onPick ? ', or click it' : ''}
            {pickHint ? ` — ${pickHint}` : ''}.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8, maxHeight: 340, overflowY: 'auto' }}>
            {shown.map((img) => (
              <div
                key={img.key}
                draggable
                onDragStart={(e) => onDragStart(e, img)}
                onClick={onPick ? () => onPick({ base64: img.base64, mediaType: img.mediaType, fileName: img.fileName, hash: img.hash }) : undefined}
                title={`${img.fileName}${img.render ? ' · Grok render' : ''}${img.role ? ` · ${roleLabel(img.role)}` : ''}${img.note ? ` · "${img.note}"` : ''}\n${new Date(img.ts).toLocaleString()}${img.uses > 1 ? ` · used ${img.uses}×` : ''}`}
                style={{
                  position: 'relative', aspectRatio: '4 / 3', borderRadius: 6, overflow: 'hidden',
                  border: '1px solid var(--pe-line)', background: 'var(--pe-surface)',
                  cursor: onPick ? 'pointer' : 'grab',
                }}
              >
                <img
                  src={`data:${img.mediaType};base64,${img.base64}`}
                  alt={img.fileName}
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
                />
                {(img.role || img.render) && (
                  <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, fontSize: 9, lineHeight: '13px', padding: '1px 4px', background: 'rgba(8,8,16,0.78)', color: 'var(--pe-accent-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {img.render || roleLabel(img.role)}
                  </span>
                )}
              </div>
            ))}
          </div>
          {images.length > CAP && (
            <p style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', margin: '8px 0 0' }}>
              Showing {CAP} of {images.length} — older ones are still restorable from History.
            </p>
          )}
          </>)}
        </div>
      )}
    </div>
  )
}

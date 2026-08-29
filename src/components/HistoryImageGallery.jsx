import { useState, useMemo } from 'react'
import { MINIMAX_H3_REF_ROLES } from '../constants'
import { DRAG_MIME, setDragImage } from '../imageDrag'

const roleLabel = (id) => MINIMAX_H3_REF_ROLES.find(r => r.id === id)?.label || id

// Walk every history entry and collect the unique input images it stored.
// Dedupe on the base64 payload; keep the most recent occurrence's metadata.
function collectImages(history) {
  const byData = new Map()
  const consider = (im, ts, slot) => {
    if (!im || typeof im !== 'object' || !im.base64) return
    const prev = byData.get(im.base64)
    if (prev && prev.ts >= ts) { prev.uses++; return }
    byData.set(im.base64, {
      base64: im.base64,
      mediaType: im.mediaType || 'image/jpeg',
      fileName: im.fileName || 'image.jpg',
      role: im.role || null,
      note: im.note || '',
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
  }
  return [...byData.values()].sort((a, b) => b.ts - a.ts)
}

export default function HistoryImageGallery({ history, onPick, pickHint }) {
  const [open, setOpen] = useState(false)
  const images = useMemo(() => collectImages(history), [history])

  // Nothing to reuse and no history at all — stay out of the way entirely.
  if (images.length === 0 && (history || []).length === 0) return null

  const onDragStart = (e, img) => {
    setDragImage({ base64: img.base64, mediaType: img.mediaType, fileName: img.fileName })
    try {
      e.dataTransfer.setData(DRAG_MIME, img.fileName || '1')
      e.dataTransfer.setData('text/plain', img.fileName || 'image')
      e.dataTransfer.effectAllowed = 'copy'
    } catch { /* older browsers */ }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#777', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}
      >
        <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        ♻ Reuse image from history ({images.length})
      </button>

      {open && (
        <div style={{ marginTop: 10, background: '#0e0e1c', border: '1px solid #2e2e44', borderRadius: 10, padding: '12px 14px' }}>
          {images.length === 0 ? (
            <p style={{ fontSize: 11.5, color: '#777', margin: 0, lineHeight: 1.6 }}>
              No reusable images yet. An image is saved here once you run a generation with one loaded
              (use the <strong style={{ color: '#9a8fd8' }}>+ Add reference image</strong> box below to load one now).
              History entries from older versions saved only the filename, not the image itself.
            </p>
          ) : (<>
          <p style={{ fontSize: 11, color: '#666', margin: '0 0 10px', lineHeight: 1.5 }}>
            Every image used in a past generation. Drag one onto an image slot below{onPick ? ', or click it' : ''}
            {pickHint ? ` — ${pickHint}` : ''}.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8 }}>
            {images.map((img) => (
              <div
                key={img.base64.slice(0, 32) + img.base64.length}
                draggable
                onDragStart={(e) => onDragStart(e, img)}
                onClick={onPick ? () => onPick({ base64: img.base64, mediaType: img.mediaType, fileName: img.fileName }) : undefined}
                title={`${img.fileName}${img.role ? ` · ${roleLabel(img.role)}` : ''}${img.note ? ` · "${img.note}"` : ''}\n${new Date(img.ts).toLocaleString()}${img.uses > 1 ? ` · used ${img.uses}×` : ''}`}
                style={{
                  position: 'relative', aspectRatio: '4 / 3', borderRadius: 6, overflow: 'hidden',
                  border: '1px solid #2e2e44', background: '#12121f',
                  cursor: onPick ? 'pointer' : 'grab',
                }}
              >
                <img
                  src={`data:${img.mediaType};base64,${img.base64}`}
                  alt={img.fileName}
                  draggable={false}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
                />
                {img.role && (
                  <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, fontSize: 9, lineHeight: '13px', padding: '1px 4px', background: 'rgba(8,8,16,0.78)', color: '#9a8fd8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {roleLabel(img.role)}
                  </span>
                )}
              </div>
            ))}
          </div>
          </>)}
        </div>
      )}
    </div>
  )
}

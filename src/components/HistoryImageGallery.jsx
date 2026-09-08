import { useState, useMemo, useRef, useEffect } from 'react'
import { MINIMAX_H3_REF_ROLES } from '../constants'
import { DRAG_MIME, setDragImage } from '../imageDrag'

const roleLabel = (id) => MINIMAX_H3_REF_ROLES.find(r => r.id === id)?.label || id

const CAP = 60  // most thumbnails to render at once

// Cheap dedupe key — avoids holding a second reference to every multi-MB base64
// string as a Map key. Length + head + tail + filename is unique enough for our
// inputs (all normalised to <=1536px JPEG on load).
const keyOf = (b, fileName) => `${fileName || ''}|${b.length}|${b.slice(0, 64)}|${b.slice(-64)}`

// Which frame(s) the entry's `caption` string actually covers, for the label on
// the description panel. Input images in first/last/mid+last modes share one
// combined caption; ref mode shares one assembled block.
const captionScope = (frameMode, slot) => {
  if (slot === 'render') return 'render'
  if (slot === 'ref') return 'ref'
  if (frameMode === 'firstlast' || frameMode === 'firstmidlast') return 'multi'
  return 'single'
}

// Walk every history entry and collect the unique images it stored — both the
// input images (first/mid/last/ref frames) and any Grok-rendered output images
// (`outputs[].images[]`, which key their bytes under `b64`). Returns
// { images (newest-first), stats } — stats drives the DEV diagnostic and the
// empty-state copy. Legacy entries that stored only a filename string never pass
// the base64 gate, so they are silently skipped. Each collected image also
// carries the vision description from the newest generation that used it
// (`caption` + `captionScope`/`entryId` so it can be read and edited in place).
function collectImages(history) {
  const byKey = new Map()
  const stats = { entries: (history || []).length, rawFields: 0, objWithBase64: 0, collected: 0 }
  const consider = (im, ts, slot, ctx) => {
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
      // Description shown/edited in the info panel. Renders use the model's
      // revised prompt (read-only); a per-image caption wins when stored (the
      // Scriptwriter keeps one per reference), else the entry's vision caption.
      caption: isRender ? (im.revisedPrompt || '') : (im.caption || ctx.caption || ''),
      captionScope: captionScope(ctx.frameMode, slot),
      entryId: ctx.entryId || null,
      ts,
      uses: prev ? prev.uses + 1 : 1,
    })
  }
  for (const h of history || []) {
    const ts = h.ts || 0
    const ctx = { caption: h.caption || '', frameMode: h.frameMode, entryId: h.id || null }
    consider(h.firstImg, ts, 'first', ctx)
    consider(h.midImg, ts, 'mid', ctx)
    consider(h.lastImg, ts, 'last', ctx)
    if (Array.isArray(h.refImages)) h.refImages.forEach(im => consider(im, ts, 'ref', ctx))
    if (Array.isArray(h.outputs)) {
      for (const o of h.outputs) {
        if (o && Array.isArray(o.images)) o.images.forEach(im => consider(im, ts, 'render', ctx))
      }
    }
  }
  stats.collected = byKey.size
  return { images: [...byKey.values()].sort((a, b) => b.ts - a.ts), stats }
}

const SCOPE_LABEL = {
  single: 'Vision description of this image',
  multi: 'Vision description (covers all frames of that generation)',
  ref: 'Vision description (covers all reference images of that generation)',
  render: 'Revised prompt (from the image model)',
}

// Read + edit one collected image's stored description.
function ImageInfoPanel({ img, onSaveCaption, onClose }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(img.caption)
  const [flash, setFlash] = useState(false)
  useEffect(() => { setEditing(false); setDraft(img.caption); setFlash(false) }, [img.key, img.caption])

  const canEdit = !!onSaveCaption && !!img.entryId && img.slot !== 'render'

  const save = async () => {
    await onSaveCaption(img.entryId, draft)
    setEditing(false)
    setFlash(true)
    setTimeout(() => setFlash(false), 1800)
  }

  return (
    <div style={{ marginTop: 10, background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <img
          src={`data:${img.mediaType};base64,${img.base64}`}
          alt={img.fileName}
          style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--pe-line)', flexShrink: 0 }}
        />
        <span style={{ minWidth: 0, flex: 1, fontSize: 11.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.4px', lineHeight: 1.35 }}>
          {SCOPE_LABEL[img.captionScope] || 'Description'}{flash ? ' · ✓ saved' : ''}
        </span>
        <button onClick={onClose} style={{ fontSize: 12, color: 'var(--pe-ink-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>✕</button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--pe-ink-3)', marginBottom: 6 }}>
        {new Date(img.ts).toLocaleString()}{img.uses > 1 ? ` · used ${img.uses}× (most recent shown)` : ''}
      </div>

      {editing ? (
        <>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
            rows={Math.min(16, Math.max(5, draft.split('\n').length + 1))}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, lineHeight: 1.55, color: 'var(--pe-ink-2)', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '6px 8px', fontFamily: 'inherit', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button onClick={save} style={{ fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 10px', cursor: 'pointer' }}>Save</button>
            <button onClick={() => { setDraft(img.caption); setEditing(false) }} style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, color: img.caption ? 'var(--pe-ink-2)' : 'var(--pe-ink-3)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
            {img.caption || (img.slot === 'render'
              ? 'No revised prompt was stored for this render.'
              : 'No vision description was stored — this image was used in a text-only or pre-vision generation.')}
          </div>
          {canEdit && (
            <button onClick={() => { setDraft(img.caption); setEditing(true) }}
              style={{ marginTop: 6, fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>
              ✎ Edit description
            </button>
          )}
        </>
      )}
    </div>
  )
}

export default function HistoryImageGallery({ history, onPick, pickHint, onSaveCaption }) {
  const [open, setOpen] = useState(false)
  const [infoFor, setInfoFor] = useState(null)  // img.key of the open info panel
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
  const infoImg = infoFor ? shown.find(i => i.key === infoFor) : null

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
            {pickHint ? ` — ${pickHint}` : ''}. Click the <strong>i</strong> badge to read or edit an image's vision description.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8, maxHeight: 340, overflowY: 'auto' }}>
            {shown.map((img) => (
              <div
                key={img.key}
                draggable
                onDragStart={(e) => onDragStart(e, img)}
                onClick={onPick ? () => onPick({
                  base64: img.base64, mediaType: img.mediaType, fileName: img.fileName, hash: img.hash,
                  // Only a per-reference caption/role carries meaning to another
                  // reference slot; a frame/render description does not.
                  caption: img.slot === 'ref' ? img.caption : '',
                  role: img.slot === 'ref' ? img.role : null,
                  note: img.slot === 'ref' ? img.note : '',
                }) : undefined}
                title={`${img.fileName}${img.render ? ' · Grok render' : ''}${img.role ? ` · ${roleLabel(img.role)}` : ''}${img.note ? ` · "${img.note}"` : ''}\n${new Date(img.ts).toLocaleString()}${img.uses > 1 ? ` · used ${img.uses}×` : ''}`}
                style={{
                  position: 'relative', aspectRatio: '4 / 3', borderRadius: 6, overflow: 'hidden',
                  border: `1px solid ${infoFor === img.key ? 'var(--pe-accent-line)' : 'var(--pe-line)'}`,
                  outline: infoFor === img.key ? '2px solid var(--pe-accent-line)' : 'none',
                  background: 'var(--pe-surface)',
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
                <button
                  onClick={(e) => { e.stopPropagation(); setInfoFor(k => k === img.key ? null : img.key) }}
                  title="Read / edit the vision description"
                  style={{
                    position: 'absolute', top: 3, right: 3, width: 18, height: 18, borderRadius: '50%',
                    border: 'none', cursor: 'pointer', fontSize: 12, fontStyle: 'italic', fontWeight: 700,
                    fontFamily: 'Georgia, "Times New Roman", serif', lineHeight: '18px',
                    padding: 0, textAlign: 'center', background: infoFor === img.key ? 'var(--pe-accent-ink)' : 'rgba(8,8,16,0.72)', color: '#fff',
                  }}
                >i</button>
                {(img.role || img.render) && (
                  <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, fontSize: 9, lineHeight: '13px', padding: '1px 4px', background: 'rgba(8,8,16,0.78)', color: 'var(--pe-accent-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {img.render || roleLabel(img.role)}
                  </span>
                )}
              </div>
            ))}
          </div>
          {infoImg && (
            <ImageInfoPanel img={infoImg} onSaveCaption={onSaveCaption} onClose={() => setInfoFor(null)} />
          )}
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

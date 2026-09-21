import { useRef, useState } from 'react'
import { IMAGE_ROLES, imageRoleDef } from '../constants'
import { imageHash, shrinkToJpeg } from '../utils'
import { hasDragImage, takeDragImage, resolveDragImage } from '../imageDrag'

// Additional reference images for a still-image target, beside the primary
// Reference Image card. Each one carries its own role (Pose / Subject / Style /
// Location / Wardrobe / Object, or General): the vision step describes it for
// that role only, and the writer takes only that aspect from it.
//
// The list itself lives in App (`imgs.refImages`) — this is just the UI. Adding
// goes through `onAdd` (App's addStillRef: dedupe, cap, id) so a picked history
// image, a dropped file and a chosen file all take the same path.

const lbl = { fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }
const sel = { fontSize: 13.5, color: 'var(--pe-ink-2)', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '4px 8px', maxWidth: '100%' }

export default function ImageRefsPanel({ images, max, roleOf, imageMeta, onAdd, onRoleChange, onRemove }) {
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef(null)
  const full = images.length >= max

  const addFiles = async (files) => {
    setError('')
    for (const file of Array.from(files || []).filter(f => f.type?.startsWith('image/'))) {
      try {
        const { base64, mediaType } = await shrinkToJpeg(file, 1536, 0.85)
        onAdd({ base64, mediaType, fileName: file.name, hash: imageHash(base64) })
      } catch (e) {
        setError(`Couldn't read ${file.name}: ${e.message}`)
      }
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false)
    if (hasDragImage(e.dataTransfer)) {
      const d = takeDragImage()
      if (d) resolveDragImage(d).then(r => r && onAdd(r)).catch(() => {})
      return
    }
    addFiles(e.dataTransfer.files)
  }
  const onDragOver = (e) => {
    if (hasDragImage(e.dataTransfer) || (e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); setDragOver(true) }
  }
  const onDragLeave = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }

  const described = (im, roleId) => !!(imageMeta?.[im.hash]?.captions?.[roleId] || im.captions?.[roleId])

  return (
    <div style={{ marginBottom: 16 }} data-testid="image-refs-panel">
      <label style={lbl}>
        More references{' '}
        <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>
          (optional — a pose, a character, a style, a location… each used only for its role · {images.length}/{max})
        </span>
      </label>

      {images.map((im, i) => {
        const role = roleOf(im)
        const def = imageRoleDef(role)
        return (
          <div key={im.id || im.hash || i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 12px', marginBottom: 8, background: 'var(--pe-surface)', border: '1px solid var(--pe-accent-line)', borderRadius: 8 }}>
            <img src={im.previewUrl} alt={`reference ${i + 2}`} style={{ width: 64, height: 48, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--pe-line)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{im.fileName}</div>
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Role</label>
                <select aria-label={`Role of reference ${i + 2}`} value={role} onChange={e => onRoleChange(im.id, e.target.value)} style={sel}>
                  {IMAGE_ROLES.map(r => (
                    <option key={r.id} value={r.id}>{r.icon} {r.label}{described(im, r.id) ? ' — described' : ''}</option>
                  ))}
                </select>
              </div>
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--pe-ink-3)' }}>
                {def.id === 'general' ? 'the whole image may inform the prompt' : `only ${def.imageUse} is taken from this image`}
              </div>
            </div>
            <button onClick={() => onRemove(im.id)} aria-label={`Remove reference ${i + 2}`}
              style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--pe-danger-line)', background: 'var(--pe-danger-bg)', color: 'var(--pe-danger)', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>Remove</button>
          </div>
        )
      })}

      {!full && (
        <div
          onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
          onClick={() => fileRef.current?.click()}
          style={{ padding: '12px 14px', textAlign: 'center', fontSize: 13.5, color: 'var(--pe-ink-3)', cursor: 'pointer', background: dragOver ? 'var(--pe-rail)' : 'transparent', border: `1px dashed ${dragOver ? 'var(--pe-accent)' : 'var(--pe-line)'}`, borderRadius: 8, transition: 'border-color 0.15s' }}>
          + Add a reference image <span style={{ opacity: 0.8 }}>— click, or drop one here / from the history gallery</span>
          <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => addFiles(e.target.files)} />
        </div>
      )}
      {error && <div style={{ marginTop: 6, fontSize: 13, color: 'var(--pe-danger)' }}>{error}</div>}
    </div>
  )
}

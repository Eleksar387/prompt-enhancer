import { useRef } from 'react'
import { MINIMAX_H3_REF_ROLES, MINIMAX_H3_PRESERVE_OPTIONS } from '../constants'
import { generateId } from '../db'

const MAX_IMAGES = 6
const MAX_DIM = 1536

const lbl = { fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }
const miniSel = { background: '#12121f', border: '1px solid #2e2e44', borderRadius: 6, padding: '5px 8px', color: '#e0e0f0', fontSize: 12, outline: 'none', cursor: 'pointer' }

const loadFile = (file, onLoaded) => {
  if (!file) return
  const reader = new FileReader()
  reader.onload = (e) => {
    const img = new Image()
    img.onload = () => {
      let w = img.width, h = img.height
      if (w > MAX_DIM || h > MAX_DIM) {
        if (w >= h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM }
        else { w = Math.round(w * MAX_DIM / h); h = MAX_DIM }
      }
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      let dataUrl = canvas.toDataURL('image/jpeg', 0.85)
      if (dataUrl.length * 0.75 > 4 * 1024 * 1024) dataUrl = canvas.toDataURL('image/jpeg', 0.7)
      onLoaded({
        id: generateId(),
        base64: dataUrl.split(',')[1], mediaType: 'image/jpeg',
        previewUrl: dataUrl, fileName: file.name,
        role: MINIMAX_H3_REF_ROLES[0].id, preserve: 'strong',
      })
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(file)
}

export default function MinimaxRefPanel({ images, onChange }) {
  const fileInputRef = useRef(null)

  const addImage = (file) => {
    if (!file || images.length >= MAX_IMAGES) return
    loadFile(file, (obj) => onChange([...images, obj]))
  }
  const onFileChange = (e) => { addImage(e.target.files[0]); e.target.value = '' }
  const onDrop = (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith('image/')) addImage(f) }
  const removeImage = (id) => onChange(images.filter(im => im.id !== id))
  const updateImage = (id, patch) => onChange(images.map(im => im.id === id ? { ...im, ...patch } : im))

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={lbl}>
        Reference Images <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>(up to {MAX_IMAGES} — each with a role and preservation strength)</span>
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {images.map((im, i) => (
          <div key={im.id} style={{ padding: '12px 14px', background: '#12121f', border: '1px solid #3a2f6e', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
              <img src={im.previewUrl} alt="ref" style={{ width: 72, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid #2e2e44', flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 12, color: '#888' }}>Image {i + 1} · <span style={{ color: '#666' }}>{im.fileName}</span></div>
              <button onClick={() => removeImage(im.id)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #3a2040', background: '#1e1020', color: '#f87171', fontSize: 11, cursor: 'pointer', flexShrink: 0 }}>Remove</button>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 180px' }}>
                <label style={{ fontSize: 10, color: '#666', display: 'block', marginBottom: 4 }}>Role</label>
                <select style={{ ...miniSel, width: '100%' }} value={im.role} onChange={e => updateImage(im.id, { role: e.target.value })} title={MINIMAX_H3_REF_ROLES.find(r => r.id === im.role)?.hint}>
                  {MINIMAX_H3_REF_ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </div>
              <div style={{ flex: '1 1 180px' }}>
                <label style={{ fontSize: 10, color: '#666', display: 'block', marginBottom: 4 }}>Preservation</label>
                <select style={{ ...miniSel, width: '100%' }} value={im.preserve} onChange={e => updateImage(im.id, { preserve: e.target.value })} title={MINIMAX_H3_PRESERVE_OPTIONS.find(p => p.id === im.preserve)?.hint}>
                  {MINIMAX_H3_PRESERVE_OPTIONS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
            </div>
          </div>
        ))}

        {images.length < MAX_IMAGES && (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={onDrop} onDragOver={e => e.preventDefault()}
            style={{ padding: '16px', borderRadius: 8, border: '1px dashed #2e2e44', background: '#0e0e1c', textAlign: 'center', cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#5a4fcf'; e.currentTarget.style.background = '#12122a' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#2e2e44'; e.currentTarget.style.background = '#0e0e1c' }}
          >
            <div style={{ fontSize: 13, color: '#666' }}>+ Add reference image ({images.length}/{MAX_IMAGES})</div>
            <div style={{ fontSize: 11, color: '#444', marginTop: 3 }}>Click or drag & drop — JPG, PNG, WebP</div>
          </div>
        )}
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileChange} style={{ display: 'none' }} />
    </div>
  )
}

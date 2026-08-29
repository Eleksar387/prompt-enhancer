import { useRef, useState } from 'react'
import { MINIMAX_H3_REF_ROLES, MINIMAX_H3_PRESERVE_OPTIONS } from '../constants'
import { generateId } from '../db'
import { hasDragImage, takeDragImage } from '../imageDrag'

const MAX_IMAGES = 6
const MAX_DIM = 1536
const MAX_AUDIO_BYTES = 10 * 1024 * 1024

const lbl = { fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }
const miniSel = { background: '#12121f', border: '1px solid #2e2e44', borderRadius: 6, padding: '5px 8px', color: '#e0e0f0', fontSize: 12, outline: 'none', cursor: 'pointer' }
const noteInput = { width: '100%', boxSizing: 'border-box', background: '#12121f', border: '1px solid #2e2e44', borderRadius: 6, padding: '6px 9px', color: '#e0e0f0', fontSize: 12, outline: 'none' }

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
        role: MINIMAX_H3_REF_ROLES[0].id, preserve: 'strong', note: '',
      })
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(file)
}

const loadAudio = (file, onLoaded, onError) => {
  if (!file) return
  if (file.size > MAX_AUDIO_BYTES) { onError?.('Audio file is over 10 MB — use a short (a few seconds) clip.'); return }
  const reader = new FileReader()
  reader.onload = (e) => {
    const dataUrl = e.target.result
    onLoaded({ base64: dataUrl.split(',')[1], mediaType: file.type || 'audio/mpeg', fileName: file.name })
  }
  reader.readAsDataURL(file)
}

function refWarnings(images) {
  const out = []
  const roles = images.map(im => im.role)
  const hasWardrobe = roles.includes('wardrobe')
  const identityCount = roles.filter(r => r === 'subject_identity').length
  const exactCount = images.filter(im => im.preserve === 'exact').length
  if (hasWardrobe && identityCount === 0)
    out.push('No Subject / Identity reference — the person wearing this outfit will come from your scene text.')
  if (identityCount >= 2)
    out.push('Multiple identity references — H3 tends to blend faces. Use one per character and describe the others in the scene text.')
  if (exactCount >= 2)
    out.push("Several “Exact” locks — H3 satisfies them loosely when they compete. Reserve “Exact” for the one that matters most.")
  return out
}

const refFromData = (d) => ({
  id: generateId(),
  base64: d.base64, mediaType: d.mediaType || 'image/jpeg',
  previewUrl: `data:${d.mediaType || 'image/jpeg'};base64,${d.base64}`,
  fileName: d.fileName || 'from-history.jpg',
  role: MINIMAX_H3_REF_ROLES[0].id, preserve: 'strong', note: '',
})

export default function MinimaxRefPanel({ images, onChange, audio, onAudioChange }) {
  const fileInputRef = useRef(null)
  const audioInputRef = useRef(null)
  const [audioError, setAudioError] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const addImage = (file) => {
    if (!file || images.length >= MAX_IMAGES) return
    loadFile(file, (obj) => onChange([...images, obj]))
  }
  const onFileChange = (e) => { addImage(e.target.files[0]); e.target.value = '' }
  // Accepts both an OS file drop and an in-app image dragged from the history gallery.
  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false)
    if (images.length >= MAX_IMAGES) return
    if (hasDragImage(e.dataTransfer)) {
      const d = takeDragImage()
      if (d) onChange([...images, refFromData(d)])
      return
    }
    const f = e.dataTransfer.files[0]
    if (f?.type.startsWith('image/')) addImage(f)
  }
  const onDragOver = (e) => {
    if (hasDragImage(e.dataTransfer) || Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault()
      if (images.length < MAX_IMAGES) setDragOver(true)
    }
  }
  const removeImage = (id) => onChange(images.filter(im => im.id !== id))
  const updateImage = (id, patch) => onChange(images.map(im => im.id === id ? { ...im, ...patch } : im))

  const takeAudio = (file) => { setAudioError(''); loadAudio(file, (obj) => { onAudioChange(obj) }, setAudioError) }
  const onAudioFileChange = (e) => { takeAudio(e.target.files[0]); e.target.value = '' }
  const onAudioDrop = (e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith('audio/')) takeAudio(f) }

  const warnings = refWarnings(images)

  return (
    <div
      style={{ marginBottom: 16, borderRadius: 10, outline: dragOver ? '2px dashed #7c6af7' : '2px dashed transparent', outlineOffset: 4, transition: 'outline-color 0.15s' }}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }}
    >
      <label style={lbl}>
        Reference Images <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>(up to {MAX_IMAGES} — each with a role and preservation strength{images.length < MAX_IMAGES ? '; drag from history to add' : ''})</span>
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
            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 10, color: '#666', display: 'block', marginBottom: 4 }}>Note <span style={{ color: '#555' }}>(optional)</span></label>
              <input
                style={noteInput} value={im.note || ''}
                onChange={e => updateImage(im.id, { note: e.target.value })}
                placeholder={'How to use this reference — e.g. "same coat, make it red" or "this is the antagonist"'}
              />
            </div>
          </div>
        ))}

        {images.length < MAX_IMAGES && (
          <div
            onClick={() => fileInputRef.current?.click()}
            style={{ padding: '16px', borderRadius: 8, border: '1px dashed #2e2e44', background: '#0e0e1c', textAlign: 'center', cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#5a4fcf'; e.currentTarget.style.background = '#12122a' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#2e2e44'; e.currentTarget.style.background = '#0e0e1c' }}
          >
            <div style={{ fontSize: 13, color: '#666' }}>+ Add reference image ({images.length}/{MAX_IMAGES})</div>
            <div style={{ fontSize: 11, color: '#444', marginTop: 3 }}>Click or drag & drop — JPG, PNG, WebP</div>
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: '#f0b070', lineHeight: 1.5 }}>⚠ {w}</div>
          ))}
        </div>
      )}

      <label style={{ ...lbl, marginTop: 16 }}>
        Voice-Timbre Reference <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>(optional — a few seconds of speech; guides mouth/breath rhythm, not the final audio)</span>
      </label>
      {audio ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#12121f', border: '1px solid #3a2f6e', borderRadius: 8 }}>
          <span style={{ fontSize: 16 }}>🎙</span>
          <div style={{ flex: 1, fontSize: 12, color: '#888' }}>Audio 1 · <span style={{ color: '#666' }}>{audio.fileName}</span></div>
          <button onClick={() => { setAudioError(''); onAudioChange(null) }} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #3a2040', background: '#1e1020', color: '#f87171', fontSize: 11, cursor: 'pointer', flexShrink: 0 }}>Remove</button>
        </div>
      ) : (
        <div
          onClick={() => audioInputRef.current?.click()}
          onDrop={onAudioDrop} onDragOver={e => e.preventDefault()}
          style={{ padding: '14px', borderRadius: 8, border: '1px dashed #2e2e44', background: '#0e0e1c', textAlign: 'center', cursor: 'pointer' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#5a4fcf'; e.currentTarget.style.background = '#12122a' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#2e2e44'; e.currentTarget.style.background = '#0e0e1c' }}
        >
          <div style={{ fontSize: 13, color: '#666' }}>+ Add voice reference</div>
          <div style={{ fontSize: 11, color: '#444', marginTop: 3 }}>Click or drag & drop — MP3, WAV, M4A · ≤10 MB</div>
        </div>
      )}
      {audioError && <div style={{ fontSize: 11, color: '#f87171', marginTop: 6, lineHeight: 1.5 }}>{audioError}</div>}

      <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileChange} style={{ display: 'none' }} />
      <input ref={audioInputRef} type="file" accept="audio/*" onChange={onAudioFileChange} style={{ display: 'none' }} />
    </div>
  )
}

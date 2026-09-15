import { useRef, useState, useEffect, memo } from 'react'
import { MINIMAX_H3_REF_ROLES, MINIMAX_H3_PRESERVE_OPTIONS } from '../constants'
import { generateId } from '../db'
import { imageHash } from '../utils'
import { loraUsable } from '../loras'
import { numberSubjects } from '../manualH3'
import { hasDragImage, takeDragImage, resolveDragImage } from '../imageDrag'

const MAX_IMAGES = 6
const MAX_DIM = 1536
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const MAX_AUDIOS = 2   // H3's audio input: ref_audio_0 / ref_audio_1

const lbl = { fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }
const miniSel = { background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '5px 8px', color: 'var(--pe-ink)', fontSize: 13.5, outline: 'none', cursor: 'pointer' }
const noteInput = { width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '6px 9px', color: 'var(--pe-ink)', fontSize: 13.5, outline: 'none' }

// A native <select>'s open-list rendering is the OS's own listbox on this
// user's setup — confirmed live that it ignores BOTH `color` and
// `background-color` on <option> (some Linux/GTK builds don't expose that
// layer to page CSS at all), so highlighting an already-described role
// isn't achievable with a plain <select> here. This is a small self-styled
// replacement — a button showing the current role, toggling a normal
// absolutely-positioned <div> list on click — so a described option's green
// background/text is actual page CSS, not a hint to a native widget that
// may or may not honor it. `captions` is the picked image's role → text map
// (see refFromData / App.jsx's pickHistoryImage); `describedRole` decides
// which roles show as "— described".
function RoleSelect({ value, captions, onChange, title }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDocDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDocDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const current = MINIMAX_H3_REF_ROLES.find(r => r.id === value) || MINIMAX_H3_REF_ROLES[0]
  const describedNow = !!captions?.[value]

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(v => !v)} title={title}
        style={{ ...miniSel, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          background: describedNow ? 'var(--pe-ok-bg)' : miniSel.background, color: describedNow ? 'var(--pe-ok)' : miniSel.color }}>
        <span>{current.icon} {current.label}{describedNow ? ' — described' : ''}</span>
        <span aria-hidden style={{ fontSize: 10, opacity: 0.7, flexShrink: 0 }}>▾</span>
      </button>
      {open && (
        <div role="listbox" style={{
          position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 30,
          background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 6,
          boxShadow: '0 6px 18px rgba(0,0,0,0.22)', maxHeight: 230, overflowY: 'auto',
        }}>
          {MINIMAX_H3_REF_ROLES.map(r => {
            const described = !!captions?.[r.id]
            return (
              <div key={r.id} role="option" aria-selected={r.id === value}
                onClick={() => { onChange(r.id); setOpen(false) }}
                title={r.hint}
                style={{
                  padding: '6px 8px', fontSize: 13.5, cursor: 'pointer',
                  background: described ? 'var(--pe-ok-bg)' : (r.id === value ? 'var(--pe-rail)' : 'transparent'),
                  color: described ? 'var(--pe-ok)' : 'var(--pe-ink)',
                  fontWeight: r.id === value ? 600 : 400,
                }}
              >
                {r.icon} {r.label}{described ? ' — described' : ''}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

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
      const base64 = dataUrl.split(',')[1]
      onLoaded({
        id: generateId(),
        base64, mediaType: 'image/jpeg',
        previewUrl: dataUrl, fileName: file.name,
        role: MINIMAX_H3_REF_ROLES[0].id, preserve: 'strong', note: '', loraId: null,
        hash: imageHash(base64),
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
    onLoaded({ id: generateId(), base64: dataUrl.split(',')[1], mediaType: file.type || 'audio/mpeg', fileName: file.name, subjectRef: null })
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
  // Carry over the dropped image's own role/note (see App.jsx's
  // pickHistoryImage — same reasoning) instead of always resetting to the
  // first role. `captions` (role → text map, gallery-only data) feeds the
  // Role dropdown's "already described" marker below.
  role: d.role || MINIMAX_H3_REF_ROLES[0].id, preserve: 'strong', note: d.note || '', loraId: null,
  hash: d.hash || imageHash(d.base64),
  captions: d.captions || {},
})

// A reference image's LoRA and voice binding both live on the image's OWN
// card (LoRA: `im.loraId`; voice: the linked audio's own `subjectRef`,
// pointing back at `im.hash` — set from here via `setImageVoice`) rather than
// scattered across a separate LoRA panel and a separate audio-card picker —
// "assign the image, and its LoRA/voice right there with it." Works in both
// the normal AI-driven pipeline and Manual mode (see src/manualH3.js); the
// AI path reads `im.loraId` via App.jsx's `activeLoras` and the bound voice
// via `captionImages()`'s audioBlock, Manual mode via `bindAudioToSubjects()`.
// `manualMode` only still matters for the Note field's placeholder text below.
function MinimaxRefPanel({ images, onChange, audios, onAudiosChange, loras = [], manualMode = false }) {
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
      if (d) resolveDragImage(d).then(r => r && onChange([...images, refFromData(r)])).catch(() => {})
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

  const takeAudio = (file) => {
    if (audios.length >= MAX_AUDIOS) return
    setAudioError('')
    loadAudio(file, (obj) => onAudiosChange([...audios, obj]), setAudioError)
  }
  const onAudioFileChange = (e) => { takeAudio(e.target.files[0]); e.target.value = '' }
  const onAudioDrop = (e) => { e.preventDefault(); e.stopPropagation(); if (audios.length >= MAX_AUDIOS) return; const f = e.dataTransfer.files[0]; if (f?.type.startsWith('audio/')) takeAudio(f) }
  const removeAudio = (id) => { setAudioError(''); onAudiosChange(audios.filter(a => a.id !== id)) }

  // Subject-bearing references only — a Pose/Composition image never defines
  // a <Subject N>, so it's not a valid LoRA/audio binding target.
  const subjectBearing = images.filter(im => im.role !== 'pose_composition')
  const characterLoras = loras.filter(l => l.kind === 'character' && loraUsable(l))

  // <Picture N> always matches an image's list position, but <Subject M>
  // skips Pose/Composition images — so "Image 4" is not necessarily
  // "<Subject 4>" once a pose reference sits earlier in the list. In Manual
  // mode the user has to type these tags themselves with no other way to
  // look them up, so show the actual resolved tag(s) right on each card
  // (same numbering `src/manualH3.js`'s assembler and validator use).
  const numberedEntries = numberSubjects(images)

  // One voice per reference image, set from the image's own card. subjectRef
  // lives on the audio (the join key), so this is a derived write: clear this
  // image's OLD claim (whichever audio pointed at it) before writing the new
  // one — and if the newly-picked audio previously pointed at a DIFFERENT
  // image, that other image's claim silently drops too, since it's a single
  // scalar field per audio. Same idea as ScriptwriterVoiceRefs' characterId.
  const setImageVoice = (imageHashVal, audioId) => {
    onAudiosChange(audios.map(a => {
      if (a.subjectRef === imageHashVal && a.id !== audioId) return { ...a, subjectRef: null }
      if (a.id === audioId) return { ...a, subjectRef: imageHashVal }
      return a
    }))
  }

  const warnings = refWarnings(images)

  return (
    <div
      style={{ marginBottom: 16, borderRadius: 10, outline: dragOver ? '2px dashed var(--pe-accent)' : '2px dashed transparent', outlineOffset: 4, transition: 'outline-color 0.15s' }}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }}
    >
      <label style={lbl}>
        Reference Images <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>(up to {MAX_IMAGES} — each with a role and preservation strength{images.length < MAX_IMAGES ? '; drag from history to add' : ''})</span>
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {images.map((im, i) => (
          <div key={im.id} style={{ padding: '12px 14px', background: 'var(--pe-surface)', border: '1px solid var(--pe-accent-line)', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
              <img src={im.previewUrl} alt="ref" style={{ width: 72, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--pe-line)', flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 13.5, color: 'var(--pe-ink-3)' }}>
                Image {i + 1} · <span style={{ color: 'var(--pe-ink-3)' }}>{im.fileName}</span>
                {manualMode && (
                  <span style={{ marginLeft: 8, fontSize: 12.5, color: 'var(--pe-accent-ink)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {numberedEntries[i]?.subjectM != null
                      ? `→ <Subject ${numberedEntries[i].subjectM}> (<Picture ${numberedEntries[i].pictureN}>)`
                      : `→ <Picture ${numberedEntries[i]?.pictureN}> only — no Subject (Pose/Composition)`}
                  </span>
                )}
              </div>
              <button onClick={() => removeImage(im.id)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--pe-danger-line)', background: 'var(--pe-danger-bg)', color: 'var(--pe-danger)', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>Remove</button>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 180px' }}>
                <label style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 4 }}>Role</label>
                <RoleSelect value={im.role} captions={im.captions} onChange={roleId => updateImage(im.id, { role: roleId })}
                  title={`${MINIMAX_H3_REF_ROLES.find(r => r.id === im.role)?.hint || ''}${im.captions?.[im.role]
                    ? ' · already described for this role — the cached description will be reused'
                    : ' · not described for this role yet — a fresh AI description will be generated'}`} />
              </div>
              <div style={{ flex: '1 1 180px' }}>
                <label style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 4 }}>Preservation</label>
                <select style={{ ...miniSel, width: '100%' }} value={im.preserve} onChange={e => updateImage(im.id, { preserve: e.target.value })} title={MINIMAX_H3_PRESERVE_OPTIONS.find(p => p.id === im.preserve)?.hint}>
                  {MINIMAX_H3_PRESERVE_OPTIONS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
            </div>
            {im.role !== 'pose_composition' && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                <div style={{ flex: '1 1 180px' }}>
                  <label style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 4 }}>LoRA</label>
                  <select style={{ ...miniSel, width: '100%' }} value={im.loraId || ''} onChange={e => updateImage(im.id, { loraId: e.target.value || null })}>
                    <option value="">— none —</option>
                    {characterLoras.map(l => <option key={l.id} value={l.id}>{l.name.trim() || l.trigger.trim()}</option>)}
                  </select>
                </div>
                <div style={{ flex: '1 1 180px' }}>
                  <label style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 4 }}>Voice</label>
                  <select
                    style={{ ...miniSel, width: '100%' }}
                    value={audios.find(a => a.subjectRef === im.hash)?.id || ''}
                    onChange={e => setImageVoice(im.hash, e.target.value)}
                  >
                    <option value="">— none —</option>
                    {audios.map((a, ai) => <option key={a.id} value={a.id}>Audio {ai + 1} · {a.fileName}</option>)}
                  </select>
                </div>
              </div>
            )}
            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 4 }}>Note <span style={{ color: 'var(--pe-ink-3)' }}>(optional)</span></label>
              <input
                style={noteInput} value={im.note || ''}
                onChange={e => updateImage(im.id, { note: e.target.value })}
                placeholder={manualMode
                  ? 'What this reference contributes, in a few words — e.g. "her face, hair and build" — used verbatim in the assembled prompt'
                  : 'How to use this reference — e.g. "same coat, make it red" or "this is the antagonist"'}
              />
            </div>
          </div>
        ))}

        {images.length < MAX_IMAGES && (
          <div
            onClick={() => fileInputRef.current?.click()}
            style={{ padding: '16px', borderRadius: 8, border: '1px dashed var(--pe-line)', background: 'var(--pe-rail)', textAlign: 'center', cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--pe-accent)'; e.currentTarget.style.background = 'var(--pe-rail)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--pe-line)'; e.currentTarget.style.background = 'var(--pe-rail)' }}
          >
            <div style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>+ Add reference image ({images.length}/{MAX_IMAGES})</div>
            <div style={{ fontSize: 13, color: 'var(--pe-line)', marginTop: 3 }}>Click or drag & drop — JPG, PNG, WebP</div>
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 13, color: 'var(--pe-warn)', lineHeight: 1.5 }}>⚠ {w}</div>
          ))}
        </div>
      )}

      <label style={{ ...lbl, marginTop: 16 }}>
        Voice-Timbre Reference{audios.length > 1 ? 's' : ''} <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>(optional — up to {MAX_AUDIOS}, one per speaking subject; a few seconds of speech each, guides mouth/breath rhythm, not the final audio)</span>
      </label>
      {audios.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: audios.length < MAX_AUDIOS ? 8 : 0 }}>
          {audios.map((a, i) => (
            <div key={a.id || i} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 14px', background: 'var(--pe-surface)', border: '1px solid var(--pe-accent-line)', borderRadius: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 16 }}>🎙</span>
                <div style={{ flex: 1, fontSize: 13.5, color: 'var(--pe-ink-3)' }}>Audio {i + 1} · <span style={{ color: 'var(--pe-ink-3)' }}>{a.fileName}</span></div>
                <button onClick={() => removeAudio(a.id)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--pe-danger-line)', background: 'var(--pe-danger-bg)', color: 'var(--pe-danger)', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>Remove</button>
              </div>
              {/* The binding is set from the image's own card ("Voice" select
                  above) — this is just a read-only reflection so the audio
                  list stays scannable without hunting through every image. */}
              <div style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>
                {(() => {
                  const linked = subjectBearing.find(im => im.hash === a.subjectRef)
                  return linked
                    ? `→ linked to Image ${images.indexOf(linked) + 1} (${MINIMAX_H3_REF_ROLES.find(r => r.id === linked.role)?.label || linked.role})`
                    : 'Not linked to a reference image — set this from the image card above.'
                })()}
              </div>
            </div>
          ))}
        </div>
      )}
      {audios.length < MAX_AUDIOS && (
        <div
          onClick={() => audioInputRef.current?.click()}
          onDrop={onAudioDrop} onDragOver={e => e.preventDefault()}
          style={{ padding: '14px', borderRadius: 8, border: '1px dashed var(--pe-line)', background: 'var(--pe-rail)', textAlign: 'center', cursor: 'pointer' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--pe-accent)'; e.currentTarget.style.background = 'var(--pe-rail)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--pe-line)'; e.currentTarget.style.background = 'var(--pe-rail)' }}
        >
          <div style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>+ Add voice reference ({audios.length}/{MAX_AUDIOS})</div>
          <div style={{ fontSize: 13, color: 'var(--pe-line)', marginTop: 3 }}>Click or drag & drop — MP3, WAV, M4A · ≤10 MB</div>
        </div>
      )}
      {audioError && <div style={{ fontSize: 13, color: 'var(--pe-danger)', marginTop: 6, lineHeight: 1.5 }}>{audioError}</div>}

      <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileChange} style={{ display: 'none' }} />
      <input ref={audioInputRef} type="file" accept="audio/*" onChange={onAudioFileChange} style={{ display: 'none' }} />
    </div>
  )
}

// Memoized: images/audio are state values and both onChange props are useState
// setters, so up to six reference thumbnails stop re-rendering on every keystroke
// elsewhere in the compose column.
export default memo(MinimaxRefPanel)

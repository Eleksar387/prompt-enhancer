import { useRef, useState } from 'react'

// Presentational multi-image reference panel for the Scriptwriter. All state
// (the images, their notes, their AI captions, the caption-run status) lives in
// ScriptwriterPanel; this component only renders and raises events.

const lbl = {
  fontSize: 13.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase',
  letterSpacing: '0.5px', display: 'block', marginBottom: 6,
}
const lblNote = { color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }

const noteInput = {
  width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)',
  border: '1px solid var(--pe-line)', borderRadius: 6, padding: '7px 9px',
  color: 'var(--pe-ink)', fontSize: 13, outline: 'none', fontFamily: 'inherit',
}
const capArea = {
  ...noteInput, lineHeight: 1.6, resize: 'vertical', color: 'var(--pe-accent-ink)',
  fontFamily: 'var(--pe-mono)', fontSize: 12.5,
}
const describeBtn = (disabled) => ({
  padding: '6px 14px', borderRadius: 6, border: '1px solid var(--pe-accent-line)',
  background: disabled ? 'var(--pe-line)' : 'var(--pe-accent-bg)',
  color: disabled ? 'var(--pe-ink-3)' : 'var(--pe-accent-ink)',
  fontSize: 13, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
})

export default function ScriptwriterRefImages({
  images, editable, status, busy, max,
  onAddFiles, onRemove, onNote, onCaption, onDescribe,
}) {
  const fileInputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  if (!editable && images.length === 0) return null

  const allCaptioned = images.length > 0 && images.every(im => im.caption && im.caption.trim())

  // ---- read-only summary (phases after the script exists) ------------------
  if (!editable) {
    return (
      <details style={{ marginBottom: 16, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '10px 14px' }}>
        <summary style={{ fontSize: 13, color: 'var(--pe-ink-3)', cursor: 'pointer' }}>
          Reference images ({images.length})
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          {images.map((im, i) => (
            <div key={im.id || i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {im.base64 ? (
                <img src={im.previewUrl} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--pe-line)', flexShrink: 0 }} />
              ) : (
                <span style={{ width: 48, height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 10, color: 'var(--pe-ink-3)', border: '1px solid var(--pe-line)', borderRadius: 4 }}>
                  image not stored
                </span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                {im.note && im.note.trim() && (
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--pe-ink-2)', marginBottom: 2 }}>{im.note.trim()}</div>
                )}
                <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {im.caption?.trim() || 'Not described.'}
                </div>
              </div>
            </div>
          ))}
        </div>
      </details>
    )
  }

  // ---- editable (phase input / scripting) ---------------------------------
  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false)
    if (busy) return
    if (e.dataTransfer.files?.length) onAddFiles(e.dataTransfer.files)
  }

  return (
    <div
      style={{ marginBottom: 16, borderRadius: 10, outline: dragOver ? '2px dashed var(--pe-accent)' : '2px dashed transparent', outlineOffset: 4, transition: 'outline-color 0.15s' }}
      onDrop={onDrop}
      onDragOver={(e) => { if ((e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); setDragOver(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }}
    >
      <label style={lbl}>
        Reference Images <span style={lblNote}>(optional — up to {max}; each gets a note and an AI description the script is built from)</span>
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {images.map((im, i) => (
          <div key={im.id} style={{ padding: '12px 14px', background: 'var(--pe-surface)', border: '1px solid var(--pe-accent-line)', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
              <img src={im.previewUrl} alt="ref" style={{ width: 72, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--pe-line)', flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 13.5, color: 'var(--pe-ink-3)' }}>Image {i + 1} · {im.fileName}</div>
              <button onClick={() => onRemove(im.id)} disabled={busy}
                style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--pe-danger-line)', background: 'var(--pe-danger-bg)', color: 'var(--pe-danger)', fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer', flexShrink: 0 }}>
                Remove
              </button>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 4 }}>Note <span style={lblNote}>(optional)</span></label>
              <input style={noteInput} value={im.note || ''} disabled={busy}
                onChange={e => onNote(im.id, e.target.value)}
                placeholder={'How to use this reference — e.g. "the protagonist", "the farmhouse at dusk"'} />
            </div>
            <div>
              <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 4 }}>Description</label>
              {im.caption && im.caption.trim() ? (
                <textarea style={capArea} rows={3} value={im.caption} disabled={busy} onChange={e => onCaption(im.id, e.target.value)} spellCheck={false} />
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', fontStyle: 'italic' }}>
                  Not described yet — will be read automatically when you write the script.
                </div>
              )}
            </div>
          </div>
        ))}

        {images.length < max && !busy && (
          <div
            onClick={() => fileInputRef.current?.click()}
            style={{ padding: 16, borderRadius: 8, border: '1px dashed var(--pe-line)', background: 'var(--pe-rail)', textAlign: 'center', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--pe-accent)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--pe-line)' }}
          >
            <div style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>+ Add reference image ({images.length}/{max})</div>
            <div style={{ fontSize: 13, color: 'var(--pe-line)', marginTop: 3 }}>Click or drag &amp; drop — JPG, PNG, WebP</div>
          </div>
        )}
      </div>

      {images.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <button
            onClick={() => onDescribe(allCaptioned)}
            disabled={busy}
            style={describeBtn(busy)}>
            {status.state === 'reading' ? 'Reading…' : allCaptioned ? '↻ Re-describe' : '👁 Describe images'}
          </button>
          {status.state === 'reading' && (
            <span style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>
              Reading reference images… ({status.done}/{status.total})
            </span>
          )}
          {status.state === 'error' && status.error && (
            <span style={{ fontSize: 13, color: 'var(--pe-danger)' }}>{status.error}</span>
          )}
        </div>
      )}

      <input ref={fileInputRef} type="file" accept="image/*" multiple hidden
        onChange={e => { onAddFiles(e.target.files); e.target.value = '' }} />
    </div>
  )
}

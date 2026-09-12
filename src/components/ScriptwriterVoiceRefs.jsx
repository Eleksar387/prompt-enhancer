import { useRef, useState } from 'react'

// Presentational voice-reference panel for the Scriptwriter. All state lives in
// ScriptwriterPanel; this component only renders and raises events.
//
// A voice reference is a few seconds of speech that guides H3's timbre, pitch
// and delivery for ONE character. It never supplies words: the spoken lines
// always come from the script's own dialogue, so a clip the Director left
// silent stays silent. Linking is by character because that is the unit a voice
// actually belongs to — an unlinked clip is treated as the default voice for
// whoever speaks, which is what a Full Auto upload (queued before any cast
// exists) necessarily is.

const MAX_VOICE_BYTES = 10 * 1024 * 1024

const lbl = {
  fontSize: 13.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase',
  letterSpacing: '0.5px', display: 'block', marginBottom: 6,
}
const lblNote = { color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }
const sel = {
  background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 6,
  padding: '5px 7px', color: 'var(--pe-ink)', fontSize: 12.5, outline: 'none', fontFamily: 'inherit',
}

export default function ScriptwriterVoiceRefs({
  voices = [], editable, busy, max = 6, characters = [], onAdd, onRemove, onCharacter,
}) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const [err, setErr] = useState('')

  if (!editable && voices.length === 0) return null

  const nameOf = (id) => characters.find(c => c.id === id)?.name || ''

  // ---- read-only summary (phases after the prompts exist) -----------------
  if (!editable) {
    return (
      <details style={{ marginBottom: 16, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '10px 14px' }}>
        <summary style={{ fontSize: 13, color: 'var(--pe-ink-3)', cursor: 'pointer' }}>
          Voice references ({voices.length})
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {voices.map((v, i) => (
            <div key={v.id || i} style={{ fontSize: 12.5, color: 'var(--pe-ink-3)' }}>
              Audio {i + 1} · {v.fileName}
              <span style={{ color: 'var(--pe-ink-3)' }}>
                {' — '}{nameOf(v.characterId) || 'any speaker'}
              </span>
            </div>
          ))}
        </div>
      </details>
    )
  }

  // ---- editable ------------------------------------------------------------
  const take = (file) => {
    if (!file) return
    if (!file.type.startsWith('audio/')) { setErr('That is not an audio file.'); return }
    if (file.size > MAX_VOICE_BYTES) { setErr('Audio file is over 10 MB — a few seconds of speech is plenty.'); return }
    setErr('')
    const reader = new FileReader()
    reader.onload = (e) => onAdd({
      base64: String(e.target.result).split(',')[1],
      mediaType: file.type || 'audio/mpeg',
      fileName: file.name,
    })
    reader.readAsDataURL(file)
  }

  const onDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
    if (busy || voices.length >= max) return
    take(e.dataTransfer.files?.[0])
  }

  const full = voices.length >= max

  return (
    <div
      style={{ marginBottom: 16, borderRadius: 10, outline: dragOver ? '2px dashed var(--pe-accent)' : '2px dashed transparent', outlineOffset: 4, transition: 'outline-color 0.15s' }}
      onDrop={onDrop}
      onDragOver={(e) => { if ((e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); setDragOver(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }}
    >
      <label style={lbl}>
        Voice References <span style={lblNote}>(optional — a few seconds of speech per character; guides timbre and delivery, never the words)</span>
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {voices.map((v, i) => (
          <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', background: 'var(--pe-surface)', border: '1px solid var(--pe-accent-line)', borderRadius: 8 }}>
            <span style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', flexShrink: 0 }}>Audio {i + 1}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--pe-ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.fileName}</span>
            <select
              style={{ ...sel, flexShrink: 0, maxWidth: 180 }}
              value={v.characterId || ''}
              disabled={busy}
              title={characters.length ? 'Which character speaks with this voice' : 'The cast appears once the script has been written'}
              onChange={e => onCharacter(v.id, e.target.value)}
            >
              <option value="">Any speaker</option>
              {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button onClick={() => onRemove(v.id)} disabled={busy}
              style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--pe-danger-line)', background: 'var(--pe-danger-bg)', color: 'var(--pe-danger)', fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer', flexShrink: 0 }}>
              Remove
            </button>
          </div>
        ))}
      </div>

      {!full && (
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          style={{ marginTop: voices.length ? 8 : 0, padding: '8px 14px', borderRadius: 6, border: '1px dashed var(--pe-line)', background: 'transparent', color: 'var(--pe-ink-3)', fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer' }}>
          + Add a voice sample
        </button>
      )}

      {err && <div style={{ fontSize: 13, color: 'var(--pe-danger)', marginTop: 6, lineHeight: 1.5 }}>{err}</div>}

      <input ref={inputRef} type="file" accept="audio/*" style={{ display: 'none' }}
        onChange={(e) => { take(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}

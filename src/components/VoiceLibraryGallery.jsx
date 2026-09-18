import { useState, useRef, useEffect, memo } from 'react'

const MAX_VOICE_BYTES = 10 * 1024 * 1024   // matches MinimaxRefPanel's MAX_AUDIO_BYTES

// Maps standalone voice-library items (persisted server-side, not tied to
// any generation — see App.jsx's addVoiceLibraryFiles/voiceLibrary state)
// into a flat display row. Exported for testing, mirrors libraryTiles() in
// HistoryImageGallery.jsx. Newest first.
export function voiceLibraryRows(voiceLibrary) {
  return (voiceLibrary || [])
    .filter(v => v && v.url)
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .map(v => ({
      id: v.id,
      url: v.url,
      fileName: v.fileName || 'voice.mp3',
      mediaType: v.mediaType || 'audio/mpeg',
      characterName: v.characterName || '',
      ts: v.ts || 0,
    }))
}

// One library row: filename, an inline-editable character name, an <audio>
// player (the first audio playback anywhere in this codebase — a voice
// sample has no visual thumbnail, so this is the only way to audition one
// before picking it), and a remove button. Exported directly so it can be
// SSR-smoke-tested without depending on the parent's collapsed-by-default
// `open` state (which only flips via a useEffect that never runs under
// renderToStaticMarkup — see HistoryImageGallery's ImageInfoPanel for the
// same reasoning).
export const VoiceLibraryRow = memo(function VoiceLibraryRow({ item, onRemove, onRename, onPick, pickDisabled, pickHint }) {
  const [draft, setDraft] = useState(item.characterName)
  useEffect(() => { setDraft(item.characterName) }, [item.characterName, item.id])
  const commit = () => { if (onRename && draft !== item.characterName) onRename(item.id, draft) }

  return (
    <div
      onClick={() => { if (onPick && !pickDisabled) onPick(item) }}
      title={pickDisabled ? 'Remove a voice reference first, then click to reuse this sample' : (pickHint || undefined)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
        background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8,
        cursor: onPick && !pickDisabled ? 'pointer' : 'default',
        opacity: pickDisabled ? 0.55 : 1,
      }}
    >
      <span style={{ fontSize: 15, flexShrink: 0 }}>🎙</span>
      <div style={{ minWidth: 0, flex: '1 1 140px' }}>
        <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.fileName}</div>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onClick={e => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          placeholder="— unnamed —"
          title="Which character this voice belonged to — a plain note, not linked to any script"
          style={{ width: '100%', boxSizing: 'border-box', marginTop: 3, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '3px 6px', color: 'var(--pe-ink)', fontSize: 12.5, outline: 'none' }}
        />
      </div>
      <audio controls src={item.url} onClick={e => e.stopPropagation()} style={{ width: 190, height: 32, flexShrink: 0 }} />
      {onRemove && (
        <button
          onClick={e => { e.stopPropagation(); onRemove(item.id) }}
          title="Remove this voice sample from the library"
          style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, lineHeight: '22px', padding: 0, textAlign: 'center', background: 'var(--pe-danger-bg)', color: 'var(--pe-danger)' }}
        >✕</button>
      )}
    </div>
  )
})

// Shared "♻ Reuse voice" gallery, rendered inside both MinimaxRefPanel.jsx
// (main pipeline) and ScriptwriterVoiceRefs.jsx — each wires its own onPick
// (append a plain, unbound refAudios[i]/voiceRefs[i] item), since only the
// caller knows its own append/cap logic. A row list, not a thumbnail grid:
// unlike an image, a voice sample has no visual preview.
function VoiceLibraryGallery({ library = [], onAddFiles = null, onRemove = null, onRename = null, onPick = null, pickDisabled = false, pickHint = '' }) {
  const [open, setOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [err, setErr] = useState('')
  const touchedRef = useRef(false)
  const inputRef = useRef(null)
  const rows = voiceLibraryRows(library)

  useEffect(() => {
    if (!touchedRef.current && rows.length > 0) setOpen(true)
  }, [rows.length])

  const toggle = () => { touchedRef.current = true; setOpen(v => !v) }

  const isFileDrag = (dt) => { try { return Array.from(dt?.types || []).includes('Files') } catch { return false } }

  const acceptFiles = (files) => {
    if (!onAddFiles) return
    const list = Array.from(files || [])
    const ok = list.filter(f => f.size <= MAX_VOICE_BYTES)
    setErr(ok.length < list.length ? 'One or more files are over 10 MB and were skipped.' : '')
    if (ok.length) onAddFiles(ok)
  }

  const onDragOver = (e) => { if (onAddFiles && isFileDrag(e.dataTransfer)) { e.preventDefault(); setDragOver(true) } }
  const onDragLeave = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }
  const onDrop = (e) => {
    if (!onAddFiles || !isFileDrag(e.dataTransfer)) return
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
    acceptFiles(e.dataTransfer.files)
  }

  if (rows.length === 0 && !onAddFiles) return null

  return (
    <div
      style={{ marginTop: 10, marginBottom: 10, borderRadius: 10, outline: dragOver ? '2px dashed var(--pe-accent-line)' : 'none', outlineOffset: 2 }}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >
      <button
        onClick={toggle}
        style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--pe-ink-3)', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.5px' }}
      >
        <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        ♻ Reuse voice ({rows.length})
      </button>

      {open && (
        <div style={{ marginTop: 10, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '12px 14px' }}>
          {rows.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--pe-ink-3)', margin: 0, lineHeight: 1.6 }}>
              No saved voice samples yet — drag audio files in here, or save one from a reference above.
            </p>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--pe-ink-3)', margin: '0 0 10px', lineHeight: 1.5 }}>
              Voice samples saved from past generations{onAddFiles ? ', plus any you drag in here directly' : ''}. Click a sample to reuse it{pickHint ? ` — ${pickHint}` : ''}, or edit whose voice it is.
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
            {rows.map(item => (
              <VoiceLibraryRow key={item.id} item={item} onRemove={onRemove} onRename={onRename} onPick={onPick} pickDisabled={pickDisabled} pickHint={pickHint} />
            ))}
          </div>
          {onAddFiles && (
            <div
              onClick={() => inputRef.current?.click()}
              style={{ marginTop: 8, padding: '10px', borderRadius: 8, border: '1px dashed var(--pe-line)', background: 'var(--pe-surface)', textAlign: 'center', cursor: 'pointer' }}
            >
              <div style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>+ Add voice file(s)</div>
              <div style={{ fontSize: 12.5, color: 'var(--pe-line)', marginTop: 2 }}>Click or drag & drop — MP3, WAV, M4A · ≤10 MB each</div>
            </div>
          )}
          {err && <div style={{ fontSize: 13, color: 'var(--pe-danger)', marginTop: 6, lineHeight: 1.5 }}>{err}</div>}
        </div>
      )}
      {onAddFiles && (
        <input ref={inputRef} type="file" accept="audio/*" multiple onChange={e => { acceptFiles(e.target.files); e.target.value = '' }} style={{ display: 'none' }} />
      )}
    </div>
  )
}

export default memo(VoiceLibraryGallery)

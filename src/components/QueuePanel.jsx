import { memo } from 'react'
import { TARGETS, spokenLangDef } from '../constants'

// Pill-button style shared by the toolbar and per-item action buttons — matches
// the History panel's Export/Import/Clear/Restore/✕ buttons in App.jsx.
const pill = (color, borderVar) => ({
  fontSize: 13, color, background: 'none', border: `1px solid var(${borderVar})`,
  borderRadius: 6, padding: '3px 10px', cursor: 'pointer',
})

const STATUS_LABEL = {
  queued: { text: 'Queued', color: 'var(--pe-ink-3)' },
  running: { text: '⏳ Running…', color: 'var(--pe-accent-ink)' },
  error: { text: '✕ Error', color: 'var(--pe-danger)' },
}

function QueueCard({ item, busy, runningId, onRun, onRemove }) {
  const status = STATUS_LABEL[item.status] || STATUS_LABEL.queued
  const disabled = busy || runningId === item.id

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>{new Date(item.createdAt).toLocaleString()}</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
        <button onClick={() => onRun(item.id)} disabled={disabled} style={{ ...pill('var(--pe-accent-ink)', '--pe-accent-line'), cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}>▶ Run</button>
        <button onClick={() => onRemove(item.id)} disabled={disabled} style={{ ...pill('var(--pe-danger)', '--pe-danger-line'), cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}>✕</button>
      </div>
    </div>
  )

  // Full Auto Scriptwriter job — its snapshot is { refImages, voiceRefs, genre,
  // mature, hint, pacing, spokenLang }, nothing like the main-pipeline shape (no
  // target/model/scene).
  if (item.kind === 'scriptwriter-auto') {
    const s = item.snapshot || {}
    const genreLabel = !s.genre || s.genre === 'auto' ? 'genre: AI picks' : s.genre
    const refCount = Array.isArray(s.refImages) ? s.refImages.length : 0
    const voiceCount = Array.isArray(s.voiceRefs) ? s.voiceRefs.length : 0
    const langLabel = spokenLangDef(s.spokenLang).label
    return (
      <div style={{ background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '12px 14px' }}>
        {header}
        <div style={{ fontSize: 13.5, color: status.color, fontWeight: 600, marginBottom: 4 }}>{status.text}</div>
        <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 4 }}>
          🎬 Full Auto Film · {genreLabel} · {langLabel}{s.mature ? ' · NSFW' : ''} · {refCount} reference image{refCount === 1 ? '' : 's'}{voiceCount ? ` · ${voiceCount} voice reference${voiceCount === 1 ? '' : 's'}` : ''}
        </div>
        {s.hint && <div style={{ fontSize: 13.5, color: 'var(--pe-ink-3)' }}>“{s.hint}”</div>}
        {item.status === 'error' && item.error && (
          <div style={{ marginTop: 6, fontSize: 13, color: 'var(--pe-danger)' }}>{item.error}</div>
        )}
      </div>
    )
  }

  const { snapshot: s } = item
  const tg = TARGETS[s.target]
  const modelLabel = s.outputCount === 1 ? s.model : `${s.outputCount} variants`
  const sceneShort = s.scene && s.scene.length > 80 ? s.scene.slice(0, 80) + '…' : (s.scene || '')
  const hasImages = !!(s.firstImg || s.midImg || s.lastImg || (Array.isArray(s.refImages) && s.refImages.length > 0))

  return (
    <div style={{ background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '12px 14px' }}>
      {header}
      <div style={{ fontSize: 13.5, color: status.color, fontWeight: 600, marginBottom: 4 }}>{status.text}</div>
      <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 4 }}>
        {tg?.label || s.target} · {modelLabel}{hasImages ? ' · 📷 image input' : ''}
      </div>
      {sceneShort && <div style={{ fontSize: 13.5, color: 'var(--pe-ink-3)' }}>{sceneShort}</div>}
      {item.status === 'error' && item.error && (
        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--pe-danger)' }}>{item.error}</div>
      )}
    </div>
  )
}

// Collapsible panel of pending "generate later" items — styled after the
// History panel it sits below. Purely presentational: all state and the
// actual run/persist logic live in App.jsx.
function QueuePanel({ queue, open, onToggleOpen, busy, runningId, onRun, onRemove, onProcessAll, onStop, onClear }) {
  return (
    <div style={{ marginTop: 28, borderTop: '1px solid var(--pe-line-soft)', paddingTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <button onClick={onToggleOpen}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--pe-ink-3)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
          Queue {queue.length > 0 ? `(${queue.length})` : ''}
        </button>
        {open && queue.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {busy
              ? <button onClick={onStop} style={pill('var(--pe-danger)', '--pe-danger-line')}>■ Stop</button>
              : <button onClick={onProcessAll} style={pill('var(--pe-accent-ink)', '--pe-accent-line')}>▶ Process all</button>}
            <button onClick={onClear} disabled={busy} style={{ ...pill('var(--pe-danger)', '--pe-danger-line'), cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>Clear queue</button>
          </div>
        )}
      </div>
      {open && queue.length === 0 && (
        <div style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', padding: '8px 0' }}>Nothing queued — use "Add to Queue" to save a generation for later.</div>
      )}
      {open && queue.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {queue.map(item => (
            <QueueCard key={item.id} item={item} busy={busy} runningId={runningId} onRun={onRun} onRemove={onRemove} />
          ))}
        </div>
      )}
    </div>
  )
}

// Memoized — see the `queueActions` bundle in App.jsx, which keeps the callbacks
// identity-stable so this holds.
export default memo(QueuePanel)

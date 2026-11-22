import { useRef } from 'react'
import { splitDialogue } from '../dialogueSpans'

// A textarea whose spoken dialogue (`[Language] "…"`) is tinted. The textarea
// text is transparent and sits over a backdrop with identical typography.
export default function HighlightedTextarea({ value, onChange, rows, style, onFocus, onBlur }) {
  const back = useRef(null)
  const base = { ...style, margin: 0, width: '100%', boxSizing: 'border-box' }
  const { background } = base
  const sync = (e) => { if (back.current) { back.current.scrollTop = e.target.scrollTop; back.current.scrollLeft = e.target.scrollLeft } }
  const mirror = { ...base, position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word', borderColor: 'transparent', color: 'var(--pe-ink)', resize: 'none' }
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div ref={back} aria-hidden="true" style={{ ...mirror, background: background || 'transparent' }}>
        {splitDialogue(value).map((s, i) => s.dialogue
          ? <mark key={i} style={{ background: 'var(--pe-dialogue-bg)', color: 'var(--pe-dialogue)', borderRadius: 3, fontWeight: 500 }}>{s.text}</mark>
          : <span key={i}>{s.text}</span>)}
        {'\n'}
      </div>
      <textarea value={value} onChange={onChange} rows={rows} spellCheck={false} onScroll={sync}
        onFocus={onFocus} onBlur={onBlur}
        style={{ ...base, background: 'transparent', position: 'relative', color: 'transparent', caretColor: 'var(--pe-ink)' }} />
    </div>
  )
}

import { useMemo, useState } from 'react'
import { checkH3Prompt } from '../h3PromptCheck'

// Non-AI, post-generation syntax/structure badge for MiniMax H3 output — a
// green "looks well-formed" or an amber "N issue(s)" expandable list, next to
// a generated (or hand-edited) H3 prompt. `mode` must be the H3 mode the text
// was actually generated for (T2VA/I2VA/L2VA/FL2VA/Ref2VA), captured at
// generation time — see h3ModeFor in src/adapt.js. `refImages` powers the
// Ref2VA reference cross-check; unused for the other four modes.
export default function H3SyntaxBadge({ text, mode, refImages = [] }) {
  const [open, setOpen] = useState(false)
  const result = useMemo(() => checkH3Prompt(text, { mode, refImages }), [text, mode, refImages])
  if (!text || !mode) return null

  const { ok, errors, warnings } = result
  const issueCount = errors.length + warnings.length

  if (ok && !warnings.length) {
    return <div style={{ fontSize: 12.5, color: 'var(--pe-ok)', marginTop: 6 }}>✓ looks well-formed</div>
  }

  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ fontSize: 12.5, color: ok ? 'var(--pe-warn)' : 'var(--pe-danger)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline dotted' }}>
        {ok ? '✓' : '⚠'} {issueCount} issue{issueCount === 1 ? '' : 's'} found {open ? '▾' : '▸'}
      </button>
      {open && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
          {errors.map((e, i) => <li key={`e${i}`} style={{ color: 'var(--pe-danger)' }}>{e}</li>)}
          {warnings.map((w, i) => <li key={`w${i}`} style={{ color: 'var(--pe-warn)' }}>{w}</li>)}
        </ul>
      )}
    </div>
  )
}

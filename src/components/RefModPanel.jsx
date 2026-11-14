import { useState } from 'react'
import { normalizeRefModFile } from '../refmods'
import { btn } from '../utils'
import { generateId } from '../db'
import { fetchComfyRefModFiles } from '../comfy'

// Presentational RefMod panel — a smaller sibling of LoraPanel.jsx for
// MiniMax H3's RefMods. Unlike LoRAs, a RefMod has no trigger word at all
// (confirmed against the ComfyUI-MiniMaxH3Mod pack's own README — it loads
// purely via file/strength, with no activation phrase or <Subject n> tag),
// and no kind concept (no character-vs-style split, nothing bound to a
// reference image), so this drops everything LoraPanel has for that: the
// kind filter/buttons and the hidden-count note. Everything else — the chip
// row, the per-chip subject field (who a note describes), Manage CRUD, and
// the ComfyUI scan → checklist → import flow — mirrors it closely.

const lbl = {
  fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block',
  marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em',
}
const lblNote = { color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }
const field = (extra = {}) => ({
  background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 6,
  padding: '6px 10px', color: 'var(--pe-ink)', fontSize: 13, outline: 'none',
  fontFamily: 'inherit', boxSizing: 'border-box', ...extra,
})
const pill = (color, borderVar) => ({
  fontSize: 13, color, background: 'none', border: `1px solid var(${borderVar})`,
  borderRadius: 6, padding: '3px 10px', cursor: 'pointer',
})

// Strips any subfolder (`\` or `/`) and extension, for "similar to existing" hints only.
const basename = (f) => (f || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '')

export default function RefModPanel({
  refMods = [], activeIds = [], editable = true,
  onToggle, onSaveRefMods, hint = '',
  subjects = {}, onSubjectChange,
  comfyUrl = '',
}) {
  const [open, setOpen] = useState(false)
  const [scanState, setScanState] = useState('idle') // 'idle' | 'loading' | 'error'
  const [scanError, setScanError] = useState('')
  const [candidates, setCandidates] = useState(null) // null = closed, [] = scanned/none new, array = found
  const [checked, setChecked] = useState(new Set())

  const active = (id) => activeIds.includes(id)

  const patch = (id, changes) => onSaveRefMods?.(refMods.map(r => r.id === id ? { ...r, ...changes } : r))
  const add = () => onSaveRefMods?.([...refMods, { id: generateId(), name: '', note: '', file: '', strength: 1 }])
  const remove = (id) => onSaveRefMods?.(refMods.filter(r => r.id !== id))

  const runScan = async () => {
    setScanState('loading'); setScanError('')
    try {
      const files = await fetchComfyRefModFiles(comfyUrl)
      const existing = new Set(refMods.map(r => normalizeRefModFile(r.file)).filter(Boolean))
      const fresh = files.filter(f => !existing.has(normalizeRefModFile(f)))
      setCandidates(fresh)
      setChecked(new Set())
      setScanState('idle')
    } catch (e) {
      setScanState('error'); setScanError(e.message)
    }
  }

  const toggleChecked = (f) => setChecked(s => {
    const n = new Set(s)
    n.has(f) ? n.delete(f) : n.add(f)
    return n
  })

  const importSelected = () => {
    const toAdd = candidates
      .filter(f => checked.has(f))
      .map(f => ({ id: generateId(), name: basename(f), note: '', file: f, strength: 1 }))
    onSaveRefMods?.([...refMods, ...toAdd])
    setCandidates(null)
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <label style={lbl}>
        RefMods{' '}
        <span style={lblNote}>
          {hint || '(activate the RefMods this generation loads — they have no trigger word; they load purely via file + strength)'}
        </span>
      </label>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {refMods.map(r => {
          const showSubject = active(r.id) && onSubjectChange
          return (
            <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <button type="button" onClick={() => onToggle?.(r.id)} disabled={!editable}
                title={`${r.file || '(no ComfyUI file set yet)'}${r.note ? ` — ${r.note}` : ''}`}
                style={{ ...btn(active(r.id)), opacity: r.file.trim() ? 1 : 0.5 }}>
                {r.name.trim() || basename(r.file) || 'unnamed'}
              </button>
              {showSubject && (
                <input
                  type="text"
                  value={subjects[r.id] || ''}
                  onChange={e => onSubjectChange(r.id, e.target.value)}
                  disabled={!editable}
                  placeholder="which character/subject?"
                  title="Name of the character or subject this RefMod's note describes — only needed once more than one is relevant at the same time"
                  style={field({ fontSize: 11.5, padding: '3px 7px', width: 112 })}
                />
              )}
            </div>
          )
        })}
        {refMods.length === 0 && (
          <span style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>No RefMods yet.</span>
        )}
        <span aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', background: 'var(--pe-line)', margin: '0 4px' }} />
        <button type="button" onClick={() => setOpen(v => !v)} style={pill('var(--pe-ink-2)', '--pe-line')}>
          {open ? 'Done' : 'Manage'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 10, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '12px 14px' }}>
          <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', marginBottom: 10, lineHeight: 1.5 }}>
            RefMods have no activation phrase or trigger word — they load purely via the ComfyUI file below
            at the given strength. "What it represents" is optional and only tells the writer what the
            RefMod depicts, so the scene it writes naturally lines up with what's actually loaded; it is
            never inserted into the prompt as a token. The RefMod file itself is chosen by hand on ComfyUI's
            MiniMaxH3RefModsLoader node; the name here is for your own reference and to flag a file you've
            already imported when scanning.
          </div>
          {refMods.map(r => (
            <div key={r.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
              <div style={{ flex: '1 1 130px' }}>
                <label style={{ ...lbl, marginBottom: 4, fontSize: 12 }}>Name</label>
                <input value={r.name} onChange={e => patch(r.id, { name: e.target.value })}
                  placeholder="e.g. Chrome Visor" style={field({ width: '100%' })} />
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <label style={{ ...lbl, marginBottom: 4, fontSize: 12 }}>What it represents</label>
                <input value={r.note} onChange={e => patch(r.id, { note: e.target.value })}
                  placeholder="e.g. chrome visor helmet look — tells the writer what to describe" style={field({ width: '100%' })} />
              </div>
              <div style={{ flex: '1 1 100%', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 260px' }}>
                  <label style={{ ...lbl, marginBottom: 4, fontSize: 12 }}>ComfyUI RefMod</label>
                  <input value={r.file || ''} onChange={e => patch(r.id, { file: e.target.value })}
                    placeholder="optional — name as ComfyUI's RefMod loader lists it" spellCheck={false}
                    title="Name as ComfyUI's MiniMaxH3RefModsLoader lists it (no .safetensors extension) — used only to flag a file you've already imported."
                    style={field({ width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' })} />
                </div>
                <div style={{ width: 90 }}>
                  <label style={{ ...lbl, marginBottom: 4, fontSize: 12 }}>Strength</label>
                  <input type="number" step="0.01" min="0" max="1" value={r.strength ?? 1}
                    onChange={e => patch(r.id, { strength: e.target.value === '' ? 1 : Number(e.target.value) })}
                    style={field({ width: '100%' })} />
                </div>
              </div>
              <button type="button" onClick={() => remove(r.id)} style={pill('var(--pe-danger)', '--pe-danger-line')}>✕</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" onClick={add} style={pill('var(--pe-accent-ink)', '--pe-accent-line')}>+ Add RefMod</button>
            {comfyUrl && (
              <button type="button" onClick={runScan} disabled={scanState === 'loading'}
                style={pill('var(--pe-accent-ink)', '--pe-accent-line')}>
                {scanState === 'loading' ? 'Scanning…' : '🔄 Load from ComfyUI'}
              </button>
            )}
          </div>
          {scanState === 'error' && (
            <div style={{ fontSize: 12.5, color: 'var(--pe-danger)', marginTop: 8 }}>{scanError}</div>
          )}

          {candidates !== null && (
            <div style={{ marginTop: 10, border: '1px solid var(--pe-line)', borderRadius: 8, padding: 10 }}>
              {candidates.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>
                  No new RefMod files found on ComfyUI — everything it reports is already in your library.
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--pe-ink-3)' }}>{candidates.length} new file(s) found</span>
                    <button type="button" onClick={() => setChecked(checked.size ? new Set() : new Set(candidates))}
                      style={{ fontSize: 12, color: 'var(--pe-accent-ink)', background: 'none', border: 'none', cursor: 'pointer' }}>
                      {checked.size ? 'Select none' : 'Select all'}
                    </button>
                  </div>
                  <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                    {candidates.map(f => {
                      const base = basename(f)
                      const similar = refMods.find(r => basename(r.file || '') === base)
                      return (
                        <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 13 }}>
                          <input type="checkbox" checked={checked.has(f)} onChange={() => toggleChecked(f)} />
                          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{f}</span>
                          {similar && (
                            <span style={{ color: 'var(--pe-ink-3)', fontSize: 11.5 }}>
                              ⚠ similar to existing "{similar.name || basename(similar.file) || 'unnamed'}"
                            </span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button type="button" onClick={importSelected} disabled={checked.size === 0}
                      style={pill('var(--pe-accent-ink)', '--pe-accent-line')}>
                      Import selected ({checked.size})
                    </button>
                    <button type="button" onClick={() => setCandidates(null)} style={pill('var(--pe-ink-2)', '--pe-line')}>
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

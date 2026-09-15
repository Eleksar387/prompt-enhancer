import { useState } from 'react'
import { LORA_KINDS } from '../loras'
import { btn } from '../utils'
import { generateId } from '../db'

// Presentational LoRA panel, used by both the standalone workspace and the
// Scriptwriter. All state lives in the parent: the library (persisted, shared)
// and the per-generation active selection (saved with history and the queue).
//
// `kinds` narrows which library entries are offered as chips. The Scriptwriter
// passes ['style'], because there a character LoRA is bound to a cast member in
// the bible instead — one mechanism per question, so the two can't disagree.
//
// `subjects` (id → name) + `onSubjectChange` are the standalone-workspace
// equivalent of that bible binding: once a 'character'-kind LoRA is toggled
// active, a small inline field lets the user name who its trigger belongs to,
// so the writer isn't guessing when two character LoRAs are active at once.
// Both are optional — omitted, chips behave exactly as before.

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

const kindShort = (kind) => (LORA_KINDS.find(k => k.id === kind) || LORA_KINDS[0]).short

export default function LoraPanel({
  loras = [], activeIds = [], kinds = null, editable = true,
  onToggle, onSaveLoras, hint = '',
  subjects = {}, onSubjectChange,
}) {
  const [open, setOpen] = useState(false)

  const shown = kinds ? loras.filter(l => kinds.includes(l.kind)) : loras
  const active = (id) => activeIds.includes(id)

  const patch = (id, changes) => onSaveLoras?.(loras.map(l => l.id === id ? { ...l, ...changes } : l))
  const add = () => onSaveLoras?.([...loras, { id: generateId(), name: '', trigger: '', kind: 'character', note: '' }])
  const remove = (id) => onSaveLoras?.(loras.filter(l => l.id !== id))

  return (
    <div style={{ marginBottom: 18 }}>
      <label style={lbl}>
        LoRA Triggers{' '}
        <span style={lblNote}>
          {hint || '(activate the LoRAs this generation uses — their trigger words go into the prompt verbatim)'}
        </span>
      </label>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {shown.map(l => {
          const showSubject = l.kind === 'character' && active(l.id) && onSubjectChange
          return (
            <div key={l.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <button type="button" onClick={() => onToggle?.(l.id)} disabled={!editable}
                title={`${l.trigger || '(no trigger yet)'}${l.note ? ` — ${l.note}` : ''}`}
                style={{ ...btn(active(l.id)), opacity: l.trigger.trim() ? 1 : 0.5 }}>
                <span style={{ opacity: 0.6, marginRight: 5 }}>{kindShort(l.kind)}</span>
                {l.name.trim() || l.trigger.trim() || 'unnamed'}
              </button>
              {showSubject && (
                <input
                  type="text"
                  value={subjects[l.id] || ''}
                  onChange={e => onSubjectChange(l.id, e.target.value)}
                  disabled={!editable}
                  placeholder="which character?"
                  title="Name of the character this trigger belongs to — only needed once more than one character LoRA is active at the same time"
                  style={field({ fontSize: 11.5, padding: '3px 7px', width: 112 })}
                />
              )}
            </div>
          )
        })}
        {shown.length === 0 && (
          <span style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>
            No LoRAs yet{kinds ? ' of this kind' : ''}.
          </span>
        )}
        <span aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', background: 'var(--pe-line)', margin: '0 4px' }} />
        <button type="button" onClick={() => setOpen(v => !v)} style={pill('var(--pe-ink-2)', '--pe-line')}>
          {open ? 'Done' : 'Manage'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 10, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '12px 14px' }}>
          <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', marginBottom: 10, lineHeight: 1.5 }}>
            The trigger is the exact token the LoRA was trained with — it is copied into the prompt
            character for character, so spelling, spacing and capitalization all matter. The LoRA file
            itself is still selected in your ComfyUI workflow.
          </div>
          {loras.map(l => (
            <div key={l.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
              <div style={{ flex: '1 1 130px' }}>
                <label style={{ ...lbl, marginBottom: 4, fontSize: 12 }}>Name</label>
                <input value={l.name} onChange={e => patch(l.id, { name: e.target.value })}
                  placeholder="e.g. Anna" style={field({ width: '100%' })} />
              </div>
              <div style={{ flex: '1 1 170px' }}>
                <label style={{ ...lbl, marginBottom: 4, fontSize: 12 }}>Trigger</label>
                <input value={l.trigger} onChange={e => patch(l.id, { trigger: e.target.value })}
                  placeholder="e.g. ohwx woman" spellCheck={false}
                  style={field({ width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' })} />
              </div>
              <div>
                <label style={{ ...lbl, marginBottom: 4, fontSize: 12 }}>Kind</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  {LORA_KINDS.map(k => (
                    <button key={k.id} type="button" onClick={() => patch(l.id, { kind: k.id })}
                      style={{ ...btn(l.kind === k.id), padding: '5px 10px' }}>{k.label}</button>
                  ))}
                </div>
              </div>
              <div style={{ flex: '1 1 160px' }}>
                <label style={{ ...lbl, marginBottom: 4, fontSize: 12 }}>Note</label>
                <input value={l.note} onChange={e => patch(l.id, { note: e.target.value })}
                  placeholder="optional — file name, weight, reminder" style={field({ width: '100%' })} />
              </div>
              <button type="button" onClick={() => remove(l.id)} style={pill('var(--pe-danger)', '--pe-danger-line')}>✕</button>
            </div>
          ))}
          <button type="button" onClick={add} style={pill('var(--pe-accent-ink)', '--pe-accent-line')}>+ Add LoRA</button>
        </div>
      )}
    </div>
  )
}

// The generation-history section: header, filter bar, and one card per entry.
//
// Lifted verbatim out of App.jsx's render (it was ~240 lines of inline JSX) for
// one reason beyond file size: every card was re-created on any App state change,
// so a keystroke in the compose column re-rendered seventy cards' worth of
// markup. The cards are now their own memoized components keyed by entry id, and
// the whole panel is memoized, so it only repaints when the history, the filters
// or the restore-in-progress id actually change.
//
// That only works while every prop is stable across renders, which is why the
// callbacks arrive as one `actions` object that App keeps identity-stable.

import { memo, useEffect, useState } from 'react'
import { TARGETS, STYLE_OPTIONS, CREATIVITY_OPTIONS, ROLE_NONE } from '../constants'
import { moveLabel } from '../utils'
import { entryTargetLabel, entryHasImages, modelFilterLabel } from '../history'
import { resolveRefCaption } from '../adapt'

const card = { background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '12px 14px' }
const cardHead = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }
const cardActions = { display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }
const ts = { fontSize: 13, color: 'var(--pe-ink-3)' }
const metaLine = { fontSize: 13, color: 'var(--pe-accent-ink)', marginBottom: 6 }
const bodyLine = { fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 6 }
const dimLine = { fontSize: 13, color: 'var(--pe-ink-3)', marginBottom: 6 }
const thumbRow = { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }
const chipRow = { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }
const outBox = { background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '8px 10px' }
const outHead = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }
const outText = { fontSize: 13.5, color: 'var(--pe-ink-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'var(--pe-mono)' }
const smallBtn = { fontSize: 13, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }
const accentBtn = { fontSize: 13, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }
const copyBtn = { fontSize: 13.5, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }
const emptyNote = { fontSize: 13.5, color: 'var(--pe-ink-3)', padding: '8px 0' }
const fsel = { fontSize: 13, color: 'var(--pe-accent-ink)', background: 'var(--pe-surface)', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', maxWidth: 200 }
const thumb = (w, h) => ({ width: w, height: h, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--pe-line)' })

const restoreBtn = (restoringId, id) => ({
  fontSize: 13, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)',
  border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '3px 10px',
  cursor: restoringId ? 'wait' : 'pointer',
  opacity: restoringId && restoringId !== id ? 0.5 : 1,
})

// One reference image's own description, read/edited directly — `onSaveIndexed`
// writes it straight onto that entry's refImages[index-1].captions[im.role]
// (App.jsx's saveRefImageCaption, a plain array-index + map-key update),
// never back into the old shared text block, so a save here can never touch
// or be silently dropped by another reference's line in the same entry.
// `resolveRefCaption` (src/adapt.js) is the SAME resolver the gallery's
// multi-role info panel reads through — this card only ever shows/saves the
// image's own assigned role (no picker, no AI here), but it must resolve
// through the same priority order (structural map → legacy flat `caption` →
// legacy shared-block extraction) so a save made from either this card or
// the gallery is never displayed as stale/reverted by the other.
// AI re-description is deliberately NOT offered here (only in the "Reuse
// image from history" gallery, HistoryImageGallery.jsx) — this card shows an
// ALREADY-FINISHED generation with its own already-baked prompt text;
// re-describing a reference image here wouldn't retroactively rewrite that
// prompt, which read as broken rather than useful.
function RefImageCaptionRow({ im, index, fullCaption, onSaveIndexed }) {
  const initialText = resolveRefCaption(im, im?.role || ROLE_NONE, fullCaption, index)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initialText)
  const [flash, setFlash] = useState(false)
  const [saveError, setSaveError] = useState(false)
  useEffect(() => { if (!editing) { setDraft(initialText); setSaveError(false) } }, [initialText, editing])

  const save = async () => {
    setSaveError(false)
    try {
      await onSaveIndexed(index - 1, draft)
      setEditing(false)
      setFlash(true)
      setTimeout(() => setFlash(false), 1800)
    } catch {
      setSaveError(true)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid var(--pe-line)' }}>
      {im?.url && <img src={im.url} loading="lazy" decoding="async" alt={im.fileName} style={thumb(40, 30)} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--pe-ink-3)', marginBottom: 2 }}>
          Image {index}{im?.role ? ` · ${im.role}` : ''}{flash ? ' · ✓ saved' : ''}
        </div>
        {editing ? (
          <>
            <textarea value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}
              rows={Math.min(10, Math.max(2, draft.split('\n').length + 1))}
              style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, lineHeight: 1.5, color: 'var(--pe-ink-2)', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '5px 7px', fontFamily: 'inherit', resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <button onClick={save} style={{ fontSize: 12, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>Save</button>
              <button onClick={() => { setDraft(initialText); setEditing(false) }} style={{ fontSize: 12, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '2px 6px', cursor: 'pointer' }}>Cancel</button>
            </div>
            {saveError && <div style={{ fontSize: 12, color: 'var(--pe-danger)', marginTop: 3 }}>✗ Save failed — the history server may be unreachable. Your edit is still here; try again.</div>}
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: 'var(--pe-ink-2)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
              {initialText || <span style={{ color: 'var(--pe-ink-3)' }}>No description.</span>}
            </div>
            {onSaveIndexed && (
              <button onClick={() => { setDraft(initialText); setEditing(true) }}
                style={{ marginTop: 3, fontSize: 12, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '1px 7px', cursor: 'pointer' }}>✎ Edit</button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// The vision description stored on a history entry — read it, and (when `onSave`
// is given) edit it in place. `onSave(text)` should persist + refresh.
//
// `refImages` (ref-mode entries only) is what makes this per-image-aware: with
// more than one reference image, each gets its OWN editable row
// (`RefImageCaptionRow`, saved via `onSaveIndexed` directly onto
// refImages[i].caption) instead of one flat textarea over the shared legacy
// block — editing one used to silently overwrite (and, in an earlier version
// of this fix, silently DISCARD) every other reference's description in the
// same entry, because saving always went back through that one shared
// string. A plain array-index write can't do either: it always takes effect,
// and it can never touch a different index — including on an entry whose old
// shared `value` is already corrupted from an earlier version of this bug,
// since saving here never reads or rewrites that string again. Zero or one
// reference image falls back to the flat editor below, where there's nothing
// to keep separate.
function HistoryCaptionEditor({ value, onSave, refImages = null, onSaveIndexed = null }) {
  const perImage = (refImages && refImages.length > 0)
    ? refImages.map((im, i) => ({ im, index: i + 1 }))
    : null
  const canSplit = !!perImage && perImage.length > 1

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [flash, setFlash] = useState(false)
  const [saveError, setSaveError] = useState(false)
  useEffect(() => { if (!editing) { setDraft(value); setSaveError(false) } }, [value, editing])

  const save = async () => {
    setSaveError(false)
    try {
      await onSave(draft)
      setEditing(false)
      setFlash(true)
      setTimeout(() => setFlash(false), 1800)
    } catch {
      setSaveError(true)
    }
  }

  if (canSplit) {
    return (
      <details style={{ marginBottom: 6 }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--pe-ink-3)' }}>
          👁 vision description ({perImage.length} references, edited separately)
        </summary>
        <div style={{ marginTop: 4 }}>
          {perImage.map(p => (
            <RefImageCaptionRow key={p.index} im={p.im} index={p.index} fullCaption={value} onSaveIndexed={onSaveIndexed} />
          ))}
        </div>
      </details>
    )
  }

  if (editing) {
    return (
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', marginBottom: 4 }}>👁 vision description</div>
        <textarea value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}
          rows={Math.min(14, Math.max(3, draft.split('\n').length + 1))}
          style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, lineHeight: 1.55, color: 'var(--pe-ink-2)', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '6px 8px', fontFamily: 'inherit', resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button onClick={save} style={{ fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 10px', cursor: 'pointer' }}>Save</button>
          <button onClick={() => { setDraft(value); setEditing(false) }} style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>Cancel</button>
        </div>
        {saveError && <div style={{ fontSize: 12.5, color: 'var(--pe-danger)', marginTop: 4 }}>✗ Save failed — the history server may be unreachable. Your edit is still here; try again.</div>}
      </div>
    )
  }

  return (
    <details style={{ marginBottom: 6 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--pe-ink-3)' }}>
        👁 vision description{flash ? ' · ✓ saved' : ''}
      </summary>
      <div style={{ fontSize: 13, color: 'var(--pe-ink-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap', marginTop: 4 }}>{value}</div>
      {onSave && (
        <button onClick={() => { setDraft(value); setEditing(true) }}
          style={{ marginTop: 4, fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>✎ Edit</button>
      )}
    </details>
  )
}

// Reassign one entry to a project. '' → unfiled, '__new__' → App prompts for a name.
function ProjectSelect({ entry, projects, onAssign }) {
  return (
    <select
      value={entry.project || ''}
      onChange={e => onAssign(entry.id, e.target.value)}
      title="Assign this generation to a project"
      style={{ fontSize: 13.5, color: entry.project ? 'var(--pe-accent-ink)' : 'var(--pe-ink-3)', background: 'var(--pe-surface)', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '2px 6px', cursor: 'pointer', maxWidth: 150 }}>
      <option value="">Unfiled</option>
      {projects.map(p => <option key={p} value={p}>{p}</option>)}
      <option value="__new__">+ New project…</option>
    </select>
  )
}

const copy = (text) => navigator.clipboard.writeText(text)

// ── one scriptwriter session ────────────────────────────────────────────────
const ScriptCard = memo(function ScriptCard({ h, projects, restoringId, actions }) {
  // A Full Auto entry's `idea` is a fixed boilerplate instruction with the user's
  // hint appended after it — an 80-char cutoff of `idea` always shows the
  // boilerplate, never the hint, so prefer the separately-saved hint.
  const ideaShort = h.fullAuto
    ? (h.fullAutoHint ? (h.fullAutoHint.length > 80 ? h.fullAutoHint.slice(0, 80) + '…' : h.fullAutoHint) : '(AI invented freely — no hint given)')
    : (h.idea && h.idea.length > 80 ? h.idea.slice(0, 80) + '…' : (h.idea || ''))
  const phaseLabel = h.phase === 'done' ? 'Done' : h.phase === 'dircut' ? "Director's cut" : 'Script'
  const frameTiles = (h.framePrompts || []).flatMap((fp, si) =>
    ['first', 'mid', 'last']
      .filter(fk => fp?.frames?.[fk]?.image?.url)
      .map(fk => ({ im: fp.frames[fk].image, si, fk })))
  const prompts = (h.finalPrompts || []).filter(p => p.text)
  // What one unit of this film's output is called, per the target table — H3 makes
  // "clips", LTX makes "shots". Entries saved before the field default to a shot.
  const clipTarget = TARGETS[h.promptTarget]
  const clipNoun = clipTarget?.clipNoun || 'shot'
  const clipShort = clipTarget?.clipShort || 'LTX'
  const hasImages = h.refImages?.length > 0 || frameTiles.length > 0

  // Title/cast/idea sit above the loaded images, so they stay visible along
  // with them; with no images at all the fold moves up to right after the
  // summary line, same rule as the standard card below.
  const introBlock = (
    <>
      {h.script?.title && <div style={{ fontSize: 13.5, color: 'var(--pe-accent-ink)', fontWeight: 600, marginBottom: 4 }}>{h.script.title}</div>}
      {h.script?.characters?.length > 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', marginBottom: 4 }}>
          Cast: {h.script.characters.map(c => c.name).join(', ')}
        </div>
      )}
      {ideaShort && <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 6, fontStyle: 'italic' }}>"{ideaShort}"</div>}
    </>
  )

  return (
    <div style={card}>
      <div style={cardHead}>
        <span style={ts}>{new Date(h.ts).toLocaleString()}</span>
        <div style={cardActions}>
          <ProjectSelect entry={h} projects={projects} onAssign={actions.assignProject} />
          <button onClick={() => actions.restore(h)} disabled={!!restoringId} style={restoreBtn(restoringId, h.id)}>
            {restoringId === h.id ? 'Restoring…' : 'Restore'}
          </button>
          <button onClick={() => actions.remove(h.id)} style={smallBtn}>✕</button>
        </div>
      </div>
      <div style={{ ...metaLine, marginBottom: 4 }}>
        Scriptwriter{h.fullAuto ? ' · 🎬 Full Auto' : ''} · {h.model} · {phaseLabel}
        {h.script ? ` · ${h.script.scenes?.length ?? 0} scenes` : ''}
        {h.script?.characters?.length ? ` · ${h.script.characters.length} cast` : ''}
        {h.directorsCut ? ` · ${h.directorsCut.shots?.length ?? 0} ${clipNoun}s` : ''}
        {h.finalPrompts ? ` · ${prompts.length} ${clipShort} prompts` : ''}
      </div>
      {hasImages && introBlock}
      {h.refImages?.length > 0 && (
        <div style={chipRow}>
          {h.refImages.map((im, ii) => im.url
            ? <img key={ii} src={im.url} loading="lazy" decoding="async"
                title={`${im.note ? im.note + ' — ' : ''}${im.caption || im.fileName}`}
                style={thumb(48, 48)} />
            : <span key={ii} title={im.caption || ''}
                style={{ fontSize: 12, color: 'var(--pe-ink-3)', border: '1px solid var(--pe-line)', borderRadius: 4, padding: '2px 6px' }}>
                📄 {im.note || im.fileName}
              </span>
          )}
        </div>
      )}
      {frameTiles.length > 0 && (
        <div style={chipRow}>
          {frameTiles.map((t, ti) => (
            <img key={ti} src={t.im.url} loading="lazy" decoding="async"
              title={`Shot ${(h.directorsCut?.shots?.[t.si]?.shot_number) ?? t.si + 1} · ${t.fk} frame`}
              style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--pe-line)' }} />
          ))}
        </div>
      )}
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--pe-ink-3)' }}>
          ▸ {prompts.length} {clipShort} prompt{prompts.length === 1 ? '' : 's'}
        </summary>
        <div style={{ marginTop: 6 }}>
          {!hasImages && introBlock}
          {prompts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
              {prompts.map((p, pi) => (
                <div key={pi} style={outBox}>
                  <div style={outHead}>
                    <span style={{ fontSize: 13.5, color: 'var(--pe-accent)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Shot {p.shotNumber} · {p.sceneTitle}</span>
                    <button onClick={() => copy(p.text)} style={copyBtn}>Copy</button>
                  </div>
                  <div style={outText}>{p.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </details>
    </div>
  )
})

// ── one standard generation ────────────────────────────────────────────────
const StandardCard = memo(function StandardCard({ h, projects, restoringId, actions }) {
  const tg = TARGETS[h.target]
  const ml = h.outputCount === 1 ? h.model : '3 variants'
  const sl = STYLE_OPTIONS.find(s => s.id === h.style)?.label
  const cl = CREATIVITY_OPTIONS.find(c => c.id === h.creativity)?.label
  const moves = (h.moves || []).map(moveLabel)
  const hasImages = !!(h.firstImg || h.midImg || h.lastImg) || (h.refImages && h.refImages.length > 0)
  const outputCount = h.outputs?.length || 0

  // Legacy entries stored an image as a bare filename string; only object-shaped
  // ones have bytes on the sidecar and therefore a blob url to show.
  const frameThumb = (im, ii) => (typeof im === 'object' && im.url
    ? <img key={ii} src={im.url} loading="lazy" decoding="async" alt={im.fileName} title={im.fileName} style={thumb(40, 30)} />
    : <span key={ii} style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>{typeof im === 'string' ? im : im.fileName}</span>)

  // Everything past the anchor point (the loaded images, or — with no images —
  // the one-line summary) is folded away behind a click, same disclosure
  // pattern as the vision-description editor below it.
  const sceneBlock = (
    <>
      {moves.length > 0 && <div style={dimLine}>Camera: {moves.join(', ')}</div>}
      <div style={bodyLine}>{h.scene ? h.scene : <span style={{ color: 'var(--pe-ink-3)' }}>(proposed from image)</span>}</div>
      {h.dialogue && <div style={bodyLine}>Dialogue: "{h.dialogue}"{h.delivery ? ` (${h.delivery})` : ''}</div>}
      {h.soundscape && <div style={bodyLine}>Soundscape: {h.soundscape}</div>}
      {h.music && <div style={bodyLine}>Music: {h.music}</div>}
      {h.negative && <div style={bodyLine}>Avoid: {h.negative}</div>}
    </>
  )

  return (
    <div style={card}>
      <div style={cardHead}>
        <span style={ts}>{new Date(h.ts).toLocaleString()}</span>
        <div style={cardActions}>
          <ProjectSelect entry={h} projects={projects} onAssign={actions.assignProject} />
          {h.outputs?.length > 0 && (
            <button onClick={() => actions.adapt(h)} title="Rewrite this generation's prompt for another model" style={accentBtn}>⇄ Adapt</button>
          )}
          {h.target === 'minimax_h3' && hasImages && h.outputs?.length > 0 && (
            <button onClick={() => actions.text2video(h)} title="One-click rewrite as a text-only MiniMax H3 prompt (T2VA) — no reference images needed" style={accentBtn}>→ Text2Video</button>
          )}
          <button onClick={() => actions.restore(h)} disabled={!!restoringId} style={restoreBtn(restoringId, h.id)}>
            {restoringId === h.id ? 'Restoring…' : 'Restore settings'}
          </button>
          <button onClick={() => actions.remove(h.id)} style={smallBtn}>✕</button>
        </div>
      </div>
      <div style={metaLine}>
        {tg?.label} · {ml}{h.vision ? ` · 👁 ${h.vision}` : ''}{h.duration && tg?.type !== 'image' ? ` · ${h.duration}` : ''}{sl && sl !== 'Auto' ? ` · ${sl}` : ''}{cl && cl !== 'Balanced' ? ` · ${cl}` : ''}{h.frameMode === 'firstlast' ? ' · first→last' : h.frameMode === 'firstmidlast' ? ' · first→mid→last' : h.frameMode === 'last' ? ' · last frame' : h.frameMode === 'ref' ? ' · reference' : ''}{h.ratio ? ` · ${h.ratio}` : ''}{h.adaptedFrom ? ` · ⇄ from ${(TARGETS[h.adaptedFrom.target]?.label || h.adaptedFrom.target).split(' · ')[0]}` : ''}
      </div>
      {hasImages && sceneBlock}
      {(h.firstImg || h.midImg || h.lastImg) && (
        <div style={thumbRow}>{[h.firstImg, h.midImg, h.lastImg].filter(Boolean).map(frameThumb)}</div>
      )}
      {h.refImages && h.refImages.length > 0 && (
        <div style={thumbRow}>
          {h.refImages.map((im, ii) => (typeof im === 'object' && im.url
            ? <img key={ii} src={im.url} loading="lazy" decoding="async" alt={im.fileName} title={`${im.fileName} (${im.role})`} style={thumb(40, 30)} />
            : <span key={ii} style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>{typeof im === 'string' ? im : im.fileName}</span>
          ))}
        </div>
      )}
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--pe-ink-3)' }}>
          ▸ {outputCount} output{outputCount === 1 ? '' : 's'}
        </summary>
        <div style={{ marginTop: 6 }}>
          {!hasImages && sceneBlock}
          {h.caption && (
            <HistoryCaptionEditor value={h.caption} onSave={h.id ? (text => actions.saveCaption(h.id, text)) : null}
              refImages={h.frameMode === 'ref' ? h.refImages : null}
              onSaveIndexed={h.id ? ((idx, text) => actions.saveRefImageCaption(h.id, idx, text)) : null} />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
            {(h.outputs || []).map((o, oi) => (
              <div key={oi} style={outBox}>
                <div style={outHead}>
                  <span style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{o.label}</span>
                  <button onClick={() => copy(o.text)} style={copyBtn}>Copy</button>
                </div>
                <div style={outText}>{o.text}</div>
                {Array.isArray(o.images) && o.images.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    {o.images.map((img, k) => img.url && (
                      <img key={k} src={img.url} loading="lazy" decoding="async" alt={`render ${k + 1}`} title="🎨 Grok render" style={thumb(54, 54)} />
                    ))}
                  </div>
                )}
                {o.video && o.video.url && (
                  <div style={{ marginTop: 6 }}>
                    <a href={o.video.url}
                       target="_blank" rel="noreferrer" {...(o.video.blobRef ? { download: 'grok-video.mp4' } : {})}
                       style={{ fontSize: 13.5, color: 'var(--pe-accent-ink)', textDecoration: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 8px' }}>
                      🎬 video{o.video.duration ? ` · ${o.video.duration}s` : ''}{o.video.blobRef ? '' : ' ↗ (link may be expired)'}
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </details>
    </div>
  )
})

// ── the filter bar ─────────────────────────────────────────────────────────
// Each select only renders when the history actually holds more than one value
// for it; the search box always renders.
function FilterBar({ history, filters, setFilter, resetFilters, active, projects, targets, models }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
      <input
        type="search" value={filters.search} onChange={e => setFilter('search', e.target.value)}
        placeholder="Search history…" spellCheck={false}
        style={{ ...fsel, cursor: 'text', minWidth: 160, maxWidth: 240, color: 'var(--pe-ink)' }}
        title="Match scene, prompt text, vision caption, model or project (space = AND)"
      />
      {(projects.length > 0 || history.some(h => !h.project)) && (
        <select value={filters.project} onChange={e => setFilter('project', e.target.value)} style={fsel} title="Project">
          <option value="all">All projects</option>
          <option value="unfiled">Unfiled</option>
          {projects.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      )}
      {targets.length > 1 && (
        <select value={filters.target} onChange={e => setFilter('target', e.target.value)} style={fsel} title="Generated for">
          <option value="all">All targets</option>
          {targets.map(id => <option key={id} value={id}>{entryTargetLabel(id)}</option>)}
        </select>
      )}
      {models.length > 1 && (
        <select value={filters.model} onChange={e => setFilter('model', e.target.value)} style={fsel} title="Writer model">
          <option value="all">All models</option>
          {models.map(m => <option key={m} value={m}>{modelFilterLabel(m)}</option>)}
        </select>
      )}
      {history.some(entryHasImages) && history.some(h => !entryHasImages(h)) && (
        <select value={filters.image} onChange={e => setFilter('image', e.target.value)} style={fsel} title="Image inputs">
          <option value="all">Any input</option>
          <option value="with">With images</option>
          <option value="without">Without images</option>
        </select>
      )}
      {active && <button onClick={resetFilters} style={smallBtn}>Reset</button>}
    </div>
  )
}

// ── the section ────────────────────────────────────────────────────────────
const HistoryPanel = memo(function HistoryPanel({
  history, visible, open, onToggleOpen, projects, restoringId, actions,
  filters, setFilter, resetFilters, filtersActive, targets, models,
}) {
  return (
    <div style={{ marginTop: 28, borderTop: '1px solid var(--pe-line-soft)', paddingTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <button onClick={onToggleOpen}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--pe-ink-3)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
          History {history.length > 0 ? `(${filtersActive ? `${visible.length}/${history.length}` : history.length})` : ''}
        </button>
        {open && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button onClick={actions.exportAll} style={accentBtn}>Export ↓</button>
            <button onClick={actions.importFiles} style={accentBtn}>Import ↑</button>
            {history.length > 0 && (
              <button onClick={actions.clearAll} style={{ fontSize: 13, color: 'var(--pe-danger)', background: 'none', border: '1px solid var(--pe-danger-line)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>Clear</button>
            )}
          </div>
        )}
      </div>

      {open && history.length > 1 && (
        <FilterBar history={history} filters={filters} setFilter={setFilter} resetFilters={resetFilters}
          active={filtersActive} projects={projects} targets={targets} models={models} />
      )}
      {open && history.length === 0 && <div style={emptyNote}>No history yet.</div>}
      {open && history.length > 0 && visible.length === 0 && (
        <div style={emptyNote}>No generations match these filters.</div>
      )}
      {open && visible.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {visible.map(h => (h.type === 'scriptwriter'
            ? <ScriptCard key={h.id} h={h} projects={projects} restoringId={restoringId} actions={actions} />
            : <StandardCard key={h.id} h={h} projects={projects} restoringId={restoringId} actions={actions} />
          ))}
        </div>
      )}
    </div>
  )
})

export default HistoryPanel

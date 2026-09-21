import { useState, useMemo, useRef, useEffect, useCallback, memo } from 'react'
import { MINIMAX_H3_REF_ROLES, ROLE_NONE, roleIcon } from '../constants'
import { resolveRefCaption } from '../adapt'
import { DRAG_MIME, setDragImage, resolveDragImage } from '../imageDrag'

const roleLabel = (id) => (!id || id === ROLE_NONE) ? 'No role assigned' : (MINIMAX_H3_REF_ROLES.find(r => r.id === id)?.label || id)

const CAP = 60  // most thumbnails to render at once

// Dedupe key. History rows now carry the content hash (imageHash of the bytes)
// on every image node, so that IS the key; fall back to blobRef / url / filename
// for anything unhashed.
const keyOf = (im, url) => im.hash || im.blobRef || url || im.fileName || Math.random().toString(36)

// Which frame(s) the entry's `caption` string actually covers, for the label on
// the description panel. Input images in first/last/mid+last modes share one
// combined caption; ref mode shares one assembled block.
const captionScope = (frameMode, slot) => {
  if (slot === 'render') return 'render'
  if (slot === 'ref') return 'ref'
  if (frameMode === 'firstlast' || frameMode === 'firstmidlast') return 'multi'
  return 'single'
}

// The description a picked/dragged tile carries to a single-image target
// (FLUX.2 Klein etc.), so that target reuses it instead of re-describing the
// image with the vision model. Sent as `description` — a separate field from
// `caption`, which stays ref-slot-only (a frame/render text must never be read
// as a reference-slot caption). A multi-frame caption ("FIRST FRAME … LAST
// FRAME …") covers several images, so it is never reusable for one.
export const reusableDescription = (img) => {
  if (img.captionScope === 'multi') return ''
  return (img.caption || '').trim()
}

// Walk every history entry and collect the unique images it stored — both the
// input images (first/mid/last/ref frames) and any Grok-rendered output images
// (`outputs[].images[]`, which key their bytes under `b64`). Returns
// { images (newest-first), stats } — stats drives the DEV diagnostic and the
// empty-state copy. Legacy entries that stored only a filename string never pass
// the base64 gate, so they are silently skipped. Each collected image also
// carries the vision description from the newest generation that used it
// (`caption` + `captionScope`/`entryId` so it can be read and edited in place).
export function collectImages(history) {
  const byKey = new Map()
  const stats = { entries: (history || []).length, rawFields: 0, objWithBase64: 0, collected: 0 }
  const consider = (im, ts, slot, ctx) => {
    if (im == null || typeof im !== 'object') return
    stats.rawFields++
    const url = im.url || null   // sidecar blob URL; history rows carry no bytes
    if (!url) return
    stats.objWithBase64++
    const key = keyOf(im, url)
    const prev = byKey.get(key)
    if (prev && prev.ts >= ts) { prev.uses++; return }
    const isRender = slot === 'render'
    // A ref-mode entry's caption used to be ONE block covering every
    // reference image (see adapt.js's REF_IMAGE_LINE_RE comment), then a
    // single structural im.caption field, and is now a role-keyed map
    // (im.captions — "🤖 Describe with AI" can describe the same image under
    // several different roles, each kept separately). `resolveRefCaption`
    // (adapt.js) is the one shared place that knows the full fallback order
    // (structural map → legacy flat `caption` → legacy shared-block
    // extraction) — used here for the image's OWN assigned role only; every
    // other role's text, if any, comes straight from im.captions. Saving
    // always goes through onSaveRefImageCaption (a plain array-index +
    // map-key write — see ImageInfoPanel.save() below), never back through
    // the shared block or the flat field, so a failed/empty resolution here
    // can only ever produce an empty starting field, never lost or
    // cross-wired data.
    const refImageIndex = slot === 'ref' && ctx.refIndex != null ? ctx.refIndex + 1 : null
    const ownRoleKey = im.role || ROLE_NONE
    const captions = (!isRender && refImageIndex != null) ? { ...(im.captions || {}) } : {}
    if (refImageIndex != null && captions[ownRoleKey] == null) {
      const legacy = resolveRefCaption(im, ownRoleKey, ctx.caption, refImageIndex)
      if (legacy) captions[ownRoleKey] = legacy
    }
    const caption = isRender ? (im.revisedPrompt || '')
      : refImageIndex != null ? (captions[ownRoleKey] || '')
      : (ctx.caption || '')
    byKey.set(key, {
      key,
      url,
      mediaType: im.mediaType || 'image/jpeg',
      fileName: im.fileName || (isRender ? `grok-render.${(im.mediaType || 'image/png').split('/')[1] || 'png'}` : 'image.jpg'),
      hash: im.hash || null,
      role: im.role || null,
      note: im.note || '',
      render: isRender ? (im.upscaled ? '🎨 2K' : '🎨') : null,
      slot,
      // Description shown/edited in the info panel, for the image's OWN
      // assigned role (this is what onPick still forwards — alternate-role
      // descriptions are browse/edit-only in this panel for now, not yet
      // selectable at pick time). Renders use the model's revised prompt
      // (read-only).
      caption,
      // Every role this image has ever been described under, role id →
      // text — ref-slot images only. Powers the multi-role rows + the
      // "describe as another role" icon picker in ImageInfoPanel.
      captions,
      // 'ref-item' means "this image's position within its entry is known" —
      // it must NOT depend on whether a caption already has text (that's
      // just which VALUE to display, decided above). Gating scope on
      // "already described" was a real regression once (see git history) —
      // every ref-slot image with a known index is 'ref-item', full stop.
      captionScope: refImageIndex != null ? 'ref-item' : captionScope(ctx.frameMode, slot),
      refImageIndex,
      entryId: ctx.entryId || null,
      ts,
      uses: prev ? prev.uses + 1 : 1,
    })
  }
  for (const h of history || []) {
    const ts = h.ts || 0
    const ctx = { caption: h.caption || '', frameMode: h.frameMode, entryId: h.id || null }
    consider(h.firstImg, ts, 'first', ctx)
    consider(h.midImg, ts, 'mid', ctx)
    consider(h.lastImg, ts, 'last', ctx)
    if (Array.isArray(h.refImages)) h.refImages.forEach((im, idx) => consider(im, ts, 'ref', { ...ctx, refIndex: idx }))
    if (Array.isArray(h.outputs)) {
      for (const o of h.outputs) {
        if (o && Array.isArray(o.images)) o.images.forEach(im => consider(im, ts, 'render', ctx))
      }
    }
  }
  stats.collected = byKey.size
  return { images: [...byKey.values()].sort((a, b) => b.ts - a.ts), stats }
}

// Maps standalone library items (dropped in via the gallery's own drop zone,
// not tied to any generation — see App.jsx's addLibraryImages/library state)
// into the SAME tile shape collectImages() produces, so Tile/ImageInfoPanel
// need no per-source branching beyond `slot`. `key` is the library store's
// own id (not a content hash) — onRemoveLibraryImage needs a real id back,
// and a hash collision with a history-derived tile must never hide this
// tile's own delete button (see the no-cross-dedup merge below).
export function libraryTiles(library) {
  return (library || []).filter(im => im && im.url).map(im => {
    const captions = im.captions || {}
    const ownRoleKey = im.role || ROLE_NONE
    return {
      key: im.id,
      url: im.url,
      mediaType: im.mediaType || 'image/jpeg',
      fileName: im.fileName || 'image.jpg',
      hash: im.hash || null,
      role: im.role || null,
      note: '',
      render: null,
      slot: 'library',
      // Own-role description, same "which entry is the primary one" rule a
      // ref image's caption already follows — everything else the image has
      // been described under still lives in `captions`.
      caption: captions[ownRoleKey] || '',
      captions,
      captionScope: 'library',
      refImageIndex: null,
      entryId: null,
      ts: im.ts || 0,
      uses: 1,
    }
  })
}

const SCOPE_LABEL = {
  single: 'Vision description of this image',
  multi: 'Vision description (covers all frames of that generation)',
  ref: 'Vision description (covers all reference images of that generation)',
  'ref-item': 'Vision description of this reference image',
  library: 'Vision description of this library image',
  render: 'Revised prompt (from the image model)',
}

// Sentinel editingRole value for the non-ref-item flat editor (no role
// concept applies to a single/multi frame or a render) — never collides
// with a real MINIMAX_H3_REF_ROLES id or ROLE_NONE.
const FLAT_ROLE = 'flat'

// Read + edit one collected image's stored description(s). A ref-slot image
// can carry more than one — one per role it's ever been described under
// (img.captions, role id → text) — rendered as a stack of rows: the image's
// own assigned role first (always shown, even empty), then any other role
// with stored text, then a compact icon row to describe this SAME image
// under a role it hasn't been described under yet. Every other slot
// (single/multi frame, render) keeps the original single flat caption —
// there's no role concept for those.
export function ImageInfoPanel({
  img, onSaveCaption, onSaveRefImageCaption, onDescribeRefImage,
  onSaveLibraryCaption, onSetLibraryRole, onDescribeLibraryImage,
  onClose,
}) {
  // A library image is not tied to any entry (no entryId/refImageIndex), so
  // it uses its own id (img.key) directly — same role-keyed captions model
  // as a reference image, different save/describe target.
  const isRefItem = img.captionScope === 'ref-item' && img.refImageIndex != null
  const isLibraryItem = img.slot === 'library'
  const supportsRoles = isRefItem || isLibraryItem
  const canEdit = img.slot !== 'render' && (
    isRefItem ? (!!img.entryId && !!onSaveRefImageCaption)
    : isLibraryItem ? !!onSaveLibraryCaption
    : (!!img.entryId && !!onSaveCaption)
  )
  const canDescribe = isRefItem ? !!onDescribeRefImage : isLibraryItem ? !!onDescribeLibraryImage : false

  const ownRoleKey = img.role || ROLE_NONE

  const [editingRole, setEditingRole] = useState(null)   // role id (or FLAT_ROLE) being edited, or null
  const [draft, setDraft] = useState('')
  const [flashRole, setFlashRole] = useState(null)
  const [saveError, setSaveError] = useState(false)
  const [describingRole, setDescribingRole] = useState(null)
  const [describeError, setDescribeError] = useState('')
  const [describeErrorRole, setDescribeErrorRole] = useState(null)
  useEffect(() => {
    setEditingRole(null); setDraft(''); setFlashRole(null); setSaveError(false)
    setDescribingRole(null); setDescribeError(''); setDescribeErrorRole(null)
  }, [img.key])

  // Own role first, then any role with an already-SAVED description, PLUS —
  // this is the fix for a real bug — the role currently being edited even
  // when it has no saved description yet: clicking a picker icon for a
  // brand-new role runs describe() and sets editingRole/draft on success,
  // but without this, that role has no row to render its textarea into —
  // the state changes with no visible effect ("nothing happens").
  const shownRoles = supportsRoles
    ? [ownRoleKey, ...MINIMAX_H3_REF_ROLES.map(r => r.id).filter(id => id !== ownRoleKey && (img.captions?.[id] || id === editingRole))]
    : []
  const pickableRoles = supportsRoles ? MINIMAX_H3_REF_ROLES.filter(r => !shownRoles.includes(r.id)) : []

  const startEdit = (roleId) => {
    setDraft(roleId === FLAT_ROLE ? img.caption : (img.captions?.[roleId] || ''))
    setEditingRole(roleId)
    setSaveError(false)
  }

  const save = async (roleId) => {
    setSaveError(false)
    try {
      // A real role writes THIS image's own captions[roleId] directly (a
      // plain array-index + map-key update — App.jsx's saveRefImageCaption)
      // instead of the old whole-block save, so it can never touch or be
      // silently dropped by another reference's line — or another role's
      // description on this same image — in the same entry. A library image
      // has no entry/index at all — its own id (img.key) stands in.
      if (roleId === FLAT_ROLE) await onSaveCaption(img.entryId, draft)
      else if (isLibraryItem) await onSaveLibraryCaption(img.key, draft, roleId)
      else await onSaveRefImageCaption(img.entryId, img.refImageIndex - 1, draft, roleId)
      setEditingRole(null)
      setFlashRole(roleId)
      setTimeout(() => setFlashRole(null), 1800)
    } catch {
      setSaveError(true)
    }
  }

  // Runs the vision model fresh for ONE role and drops the result into the
  // SAME edit/Save flow as typing it by hand — it does not save on its own,
  // so an AI description the user doesn't like is one Cancel away from
  // being discarded rather than silently overwriting the stored one.
  const describe = async (roleId) => {
    setDescribeError(''); setDescribeErrorRole(null)
    setDescribingRole(roleId)
    try {
      const text = isLibraryItem
        ? await onDescribeLibraryImage(img.key, roleId)
        : await onDescribeRefImage(img.entryId, img.refImageIndex - 1, roleId)
      setDraft(text)
      setEditingRole(roleId)
    } catch (e) {
      setDescribeError(e?.message || 'Description failed.')
      setDescribeErrorRole(roleId)
    } finally {
      setDescribingRole(null)
    }
  }

  const errorNote = (roleId) => describeErrorRole === roleId && describeError
    ? <div style={{ fontSize: 12.5, color: 'var(--pe-danger)', marginTop: 4 }}>✗ {describeError}</div> : null

  return (
    <div style={{ marginTop: 10, background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <img
          src={img.url}
          alt={img.fileName}
          loading="lazy"
          decoding="async"
          style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--pe-line)', flexShrink: 0 }}
        />
        <span style={{ minWidth: 0, flex: 1, fontSize: 11.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.4px', lineHeight: 1.35 }}>
          {SCOPE_LABEL[img.captionScope] || 'Description'}
        </span>
        <button onClick={onClose} style={{ fontSize: 12, color: 'var(--pe-ink-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>✕</button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--pe-ink-3)', marginBottom: 6 }}>
        {new Date(img.ts).toLocaleString()}{img.uses > 1 ? ` · used ${img.uses}× (most recent shown)` : ''}
      </div>

      {supportsRoles ? (
        <>
          {isLibraryItem && onSetLibraryRole && (
            <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <label style={{ fontSize: 11.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Role</label>
              <select
                value={img.role || ROLE_NONE}
                onChange={e => onSetLibraryRole(img.key, e.target.value === ROLE_NONE ? null : e.target.value)}
                style={{ fontSize: 12.5, color: 'var(--pe-ink-2)', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '3px 6px' }}
              >
                <option value={ROLE_NONE}>No role assigned</option>
                {MINIMAX_H3_REF_ROLES.map(r => (
                  <option key={r.id} value={r.id}>{r.icon} {r.label}</option>
                ))}
              </select>
            </div>
          )}
          {shownRoles.map(roleId => {
            const editing = editingRole === roleId
            const text = img.captions?.[roleId] || ''
            const describing = describingRole === roleId
            return (
              <div key={roleId} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--pe-line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 14 }} title={roleLabel(roleId)}>{roleIcon(roleId)}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--pe-ink-2)' }}>{roleLabel(roleId)}</span>
                  {flashRole === roleId && <span style={{ fontSize: 11.5, color: 'var(--pe-accent-ink)' }}>· ✓ saved</span>}
                </div>
                {editing ? (
                  <>
                    <textarea
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      spellCheck={false}
                      rows={Math.min(16, Math.max(4, draft.split('\n').length + 1))}
                      style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, lineHeight: 1.55, color: 'var(--pe-ink-2)', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '6px 8px', fontFamily: 'inherit', resize: 'vertical' }}
                    />
                    <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                      <button onClick={() => save(roleId)} style={{ fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 10px', cursor: 'pointer' }}>Save</button>
                      <button onClick={() => setEditingRole(null)} style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>Cancel</button>
                      {canDescribe && (
                        <button onClick={() => describe(roleId)} disabled={describing} style={{ fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 8px', cursor: describing ? 'wait' : 'pointer', opacity: describing ? 0.6 : 1 }}>
                          {describing ? '🤖 Describing…' : '🤖 Re-describe with AI'}
                        </button>
                      )}
                    </div>
                    {saveError && <div style={{ fontSize: 12.5, color: 'var(--pe-danger)', marginTop: 4 }}>✗ Save failed — the history server may be unreachable. Your edit is still here; try again.</div>}
                    {errorNote(roleId)}
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 13, color: text ? 'var(--pe-ink-2)' : 'var(--pe-ink-3)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                      {text || 'Not described yet.'}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      {canEdit && (
                        <button onClick={() => startEdit(roleId)}
                          style={{ fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>
                          ✎ Edit
                        </button>
                      )}
                      {canDescribe && (
                        <button onClick={() => describe(roleId)} disabled={describing}
                          style={{ fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 8px', cursor: describing ? 'wait' : 'pointer', opacity: describing ? 0.6 : 1 }}>
                          {describing ? '🤖 Describing…' : (text ? '🤖 Re-describe with AI' : '🤖 Describe with AI')}
                        </button>
                      )}
                    </div>
                    {errorNote(roleId)}
                  </>
                )}
              </div>
            )
          })}
          {canDescribe && pickableRoles.length > 0 && (
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--pe-ink-3)', marginBottom: 4 }}>Describe this same image for another role:</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {pickableRoles.map(r => (
                  <button key={r.id} onClick={() => describe(r.id)} disabled={describingRole === r.id}
                    title={`Describe as ${r.label}`}
                    style={{ fontSize: 15, lineHeight: 1, width: 28, height: 28, borderRadius: 6, border: '1px solid var(--pe-line)', background: 'var(--pe-rail)', cursor: describingRole === r.id ? 'wait' : 'pointer', opacity: describingRole === r.id ? 0.6 : 1 }}>
                    {describingRole === r.id ? '…' : r.icon}
                  </button>
                ))}
              </div>
              {errorNote(describeErrorRole)}
            </div>
          )}
        </>
      ) : editingRole === FLAT_ROLE ? (
        <>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
            rows={Math.min(16, Math.max(5, draft.split('\n').length + 1))}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, lineHeight: 1.55, color: 'var(--pe-ink-2)', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '6px 8px', fontFamily: 'inherit', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <button onClick={() => save(FLAT_ROLE)} style={{ fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 10px', cursor: 'pointer' }}>Save</button>
            <button onClick={() => setEditingRole(null)} style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>Cancel</button>
          </div>
          {saveError && <div style={{ fontSize: 12.5, color: 'var(--pe-danger)', marginTop: 4 }}>✗ Save failed — the history server may be unreachable. Your edit is still here; try again.</div>}
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, color: img.caption ? 'var(--pe-ink-2)' : 'var(--pe-ink-3)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
            {img.caption || (img.slot === 'render'
              // A library image never reaches this branch — it's always
              // `supportsRoles` (see above), so it renders through the
              // role-row branch instead, even with zero captions yet.
              ? 'No revised prompt was stored for this render.'
              : 'No vision description was stored — this image was used in a text-only or pre-vision generation.')}
          </div>
          {canEdit && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <button onClick={() => startEdit(FLAT_ROLE)}
                style={{ fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>
                ✎ Edit description
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// One thumbnail. Memoized because the grid renders up to CAP of them and the
// only thing that changes per keystroke elsewhere in the app is nothing at all —
// `img` comes from a memoized collectImages() and every callback is stable, so a
// tile re-renders only when it is the one whose info panel opened or closed.
const Tile = memo(function Tile({ img, selected, onPick, onToggleInfo, onDragStart, onRemove }) {
  const pick = onPick ? async () => {
    const resolved = await resolveDragImage({ url: img.url, mediaType: img.mediaType, fileName: img.fileName, hash: img.hash })
    if (!resolved) return
    onPick({
      ...resolved,
      // Only a per-reference caption/role carries meaning to another
      // reference slot; a frame/render description does not. `captions`
      // (the full role→text map) travels too — MinimaxRefPanel's Role
      // dropdown uses it to mark which roles are already described for
      // THIS image, and the same content-addressed vision cache that
      // populated it means picking the matching role at generation time
      // reuses that exact description instead of a fresh vision call.
      caption: (img.slot === 'ref' || img.slot === 'library') ? img.caption : '',
      role: (img.slot === 'ref' || img.slot === 'library') ? img.role : null,
      note: (img.slot === 'ref' || img.slot === 'library') ? img.note : '',
      captions: (img.slot === 'ref' || img.slot === 'library') ? img.captions : {},
      description: reusableDescription(img),
    })
  } : undefined

  // Every role this image has actually been described under (img.captions,
  // populated by consider() — see above), not just its own originally
  // assigned role — so adding an alternate-role description via the info
  // panel's picker shows up here too instead of the badge staying frozen on
  // whatever it was at creation. No question-mark fallback: an image with
  // no description at all simply gets no badge, rather than a permanent
  // "no role" placeholder.
  const describedRoles = (img.slot === 'ref' || img.slot === 'library') ? MINIMAX_H3_REF_ROLES.filter(r => img.captions?.[r.id]) : []

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, img)}
      onClick={pick}
      title={`${img.fileName}${img.render ? ' · Grok render' : ''}${describedRoles.length ? ` · ${describedRoles.map(r => `${r.icon} ${r.label}`).join(', ')}` : ''}${img.note ? ` · "${img.note}"` : ''}\n${new Date(img.ts).toLocaleString()}${img.uses > 1 ? ` · used ${img.uses}×` : ''}`}
      style={{
        position: 'relative', aspectRatio: '4 / 3', borderRadius: 6, overflow: 'hidden',
        border: `1px solid ${selected ? 'var(--pe-accent-line)' : 'var(--pe-line)'}`,
        outline: selected ? '2px solid var(--pe-accent-line)' : 'none',
        background: 'var(--pe-surface)',
        cursor: onPick ? 'pointer' : 'grab',
      }}
    >
      <img
        src={img.url}
        alt={img.fileName}
        draggable={false}
        loading="lazy"
        decoding="async"
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
      />
      <button
        onClick={(e) => { e.stopPropagation(); onToggleInfo(img.key) }}
        title="Read / edit the vision description"
        style={{
          position: 'absolute', top: 3, right: 3, width: 18, height: 18, borderRadius: '50%',
          border: 'none', cursor: 'pointer', fontSize: 12, fontStyle: 'italic', fontWeight: 700,
          fontFamily: 'Georgia, "Times New Roman", serif', lineHeight: '18px',
          padding: 0, textAlign: 'center', background: selected ? 'var(--pe-accent-ink)' : 'rgba(8,8,16,0.72)', color: '#fff',
        }}
      >i</button>
      {img.slot === 'library' && onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(img.key) }}
          title="Remove this image from the library"
          style={{
            position: 'absolute', top: 3, left: 3, width: 18, height: 18, borderRadius: '50%',
            border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, lineHeight: '18px',
            padding: 0, textAlign: 'center', background: 'rgba(8,8,16,0.72)', color: '#fff',
          }}
        >✕</button>
      )}
      {(describedRoles.length > 0 || img.render) && (
        <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, fontSize: 11, lineHeight: '16px', padding: '1px 4px', background: 'rgba(8,8,16,0.78)', color: 'var(--pe-accent-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {img.render || describedRoles.map(r => r.icon).join(' ')}
        </span>
      )}
    </div>
  )
})

function HistoryImageGallery({
  history, onPick, pickHint, onSaveCaption, onSaveRefImageCaption, onDescribeRefImage,
  library = [], onAddLibraryImages = null, onRemoveLibraryImage = null,
  onSaveLibraryCaption = null, onSetLibraryRole = null, onDescribeLibraryImage = null,
}) {
  const [open, setOpen] = useState(false)
  const [infoFor, setInfoFor] = useState(null)  // img.key of the open info panel
  const [dragOver, setDragOver] = useState(false)
  const touchedRef = useRef(false)
  const { images, stats } = useMemo(() => collectImages(history), [history])

  // Library items merged in alongside the history-derived ones — no
  // cross-source dedup by hash: if a collision let a history-sourced tile
  // win, the surviving tile would have no library id and the ✕ button would
  // never render, silently orphaning the library row with no way to delete
  // it from the UI.
  const merged = useMemo(
    () => [...libraryTiles(library), ...images].sort((a, b) => b.ts - a.ts),
    [library, images],
  )

  // Open it the first time images are available so it's actually discoverable;
  // once the user toggles it themselves, respect that for the rest of the session.
  useEffect(() => {
    if (!touchedRef.current && merged.length > 0) setOpen(true)
  }, [merged.length])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    console.debug('[HistoryImageGallery]', stats)
    if (stats.collected === 0 && stats.objWithBase64 > 0)
      console.warn(`[HistoryImageGallery] BUG: ${stats.objWithBase64} stored image object(s) but 0 collected`)
  }, [stats])

  // Stable so the memoized tiles below actually stay put: there can be 60 of
  // them, each previously carrying freshly-allocated onClick/onDragStart
  // closures, re-created whenever anything in App re-rendered.
  const onDragStart = useCallback((e, img) => {
    // Only the blob URL travels — the drop target resolves bytes via
    // resolveDragImage(). role/note/captions travel too (ref-slot images
    // only), same as the click-to-pick path in Tile above, so dropping
    // straight onto MinimaxRefPanel preserves them just like clicking does.
    setDragImage({
      url: img.url, mediaType: img.mediaType, fileName: img.fileName, hash: img.hash,
      caption: (img.slot === 'ref' || img.slot === 'library') ? img.caption : '',
      role: (img.slot === 'ref' || img.slot === 'library') ? img.role : null,
      note: (img.slot === 'ref' || img.slot === 'library') ? img.note : '',
      captions: (img.slot === 'ref' || img.slot === 'library') ? img.captions : {},
      description: reusableDescription(img),
    })
    try {
      e.dataTransfer.setData(DRAG_MIME, img.fileName || '1')
      e.dataTransfer.setData('text/plain', img.fileName || 'image')
      e.dataTransfer.effectAllowed = 'copy'
    } catch { /* older browsers */ }
  }, [])
  const toggleInfo = useCallback((key) => setInfoFor(k => (k === key ? null : key)), [])

  // A real OS file drag, never the gallery's own in-app hasDragImage drag
  // (dropping a tile dragged out of this same gallery back onto it must stay
  // a no-op — it's a source, not something you re-add to itself).
  const isFileDrag = (dt) => { try { return Array.from(dt?.types || []).includes('Files') } catch { return false } }
  const onDragOver = (e) => { if (onAddLibraryImages && isFileDrag(e.dataTransfer)) { e.preventDefault(); setDragOver(true) } }
  const onDragLeave = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }
  const onDrop = (e) => {
    if (!onAddLibraryImages || !isFileDrag(e.dataTransfer)) return
    e.preventDefault(); e.stopPropagation()
    setDragOver(false)
    onAddLibraryImages(e.dataTransfer.files)
  }

  // Nothing to show AND no way to add anything — stay out of the way entirely.
  if (merged.length === 0 && stats.entries === 0 && !onAddLibraryImages) return null

  const toggle = () => { touchedRef.current = true; setOpen(v => !v) }

  const shown = merged.slice(0, CAP)
  const infoImg = infoFor ? shown.find(i => i.key === infoFor) : null

  return (
    <div
      style={{ marginBottom: 16, borderRadius: 10, outline: dragOver ? '2px dashed var(--pe-accent-line)' : 'none', outlineOffset: 2 }}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >
      <button
        onClick={toggle}
        style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--pe-ink-3)', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.5px' }}
      >
        <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        ♻ Reuse image ({merged.length})
      </button>

      {open && (
        <div style={{ marginTop: 10, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '12px 14px' }}>
          {merged.length === 0 ? (
            <p style={{ fontSize: 13, color: stats.objWithBase64 > 0 ? 'var(--pe-warn)' : 'var(--pe-ink-3)', margin: 0, lineHeight: 1.6 }}>
              {stats.objWithBase64 > 0
                ? `Found ${stats.objWithBase64} stored image${stats.objWithBase64 > 1 ? 's' : ''} but none could be read — this looks like a bug.`
                : onAddLibraryImages
                ? "No reusable images yet — run a generation with an image loaded, or drag image files in here, and they'll show up."
                : "No reusable images yet — run a generation with an image loaded and it'll show up here."}
            </p>
          ) : (<>
          <p style={{ fontSize: 13, color: 'var(--pe-ink-3)', margin: '0 0 10px', lineHeight: 1.5 }}>
            Images used in past generations{onAddLibraryImages ? ', plus any you drag in here directly' : ''}. Drag one onto an image slot below{onPick ? ', or click it' : ''}
            {pickHint ? ` — ${pickHint}` : ''}. Click the <strong>i</strong> badge to read or edit an image's vision description.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, maxHeight: 340, overflowY: 'auto' }}>
            {shown.map((img) => (
              <Tile key={img.key} img={img} selected={infoFor === img.key}
                onPick={onPick} onToggleInfo={toggleInfo} onDragStart={onDragStart} onRemove={onRemoveLibraryImage} />
            ))}
          </div>
          {infoImg && (
            <ImageInfoPanel img={infoImg} onSaveCaption={onSaveCaption} onSaveRefImageCaption={onSaveRefImageCaption} onDescribeRefImage={onDescribeRefImage}
              onSaveLibraryCaption={onSaveLibraryCaption} onSetLibraryRole={onSetLibraryRole} onDescribeLibraryImage={onDescribeLibraryImage}
              onClose={() => setInfoFor(null)} />
          )}
          {merged.length > CAP && (
            <p style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', margin: '8px 0 0' }}>
              Showing {CAP} of {merged.length} — older ones are still restorable from History.
            </p>
          )}
          </>)}
        </div>
      )}
    </div>
  )
}

// Memoized: the gallery only depends on the history array and stable callbacks,
// so it stops repainting its grid every time an unrelated field in App changes.
export default memo(HistoryImageGallery)

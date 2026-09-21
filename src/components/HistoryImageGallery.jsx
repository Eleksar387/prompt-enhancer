import { useState, useMemo, useRef, useEffect, useCallback, memo } from 'react'
import { MINIMAX_H3_REF_ROLES, IMAGE_ROLES, ROLE_NONE, ROLE_GENERAL, roleIcon, normalizeRole } from '../constants'
import { resolveRefCaption } from '../adapt'
import { DRAG_MIME, setDragImage, resolveDragImage } from '../imageDrag'

const roleLabel = (id) => IMAGE_ROLES.find(r => r.id === normalizeRole(id))?.label || id

// H3's reference dropdowns only know MINIMAX_H3_REF_ROLES — 'general' (and
// anything unknown) must reach a ref-mode pick as "no role", never as an id.
const h3RoleOrNull = (id) => (MINIMAX_H3_REF_ROLES.some(r => r.id === id) ? id : null)

// role-keyed text map with every key normalised ('_unassigned' → 'general') and
// blank entries dropped
const normCaptions = (m) => {
  const out = {}
  for (const [k, v] of Object.entries(m || {})) if (typeof v === 'string' && v.trim()) out[normalizeRole(k)] = v
  return out
}

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

// Walk every history entry and collect the unique images it stored — both the
// input images (first/mid/last/ref frames) and any Grok-rendered output images
// (`outputs[].images[]`, which key their bytes under `b64`). Returns
// { images (newest-first), stats } — stats drives the DEV diagnostic and the
// empty-state copy. Legacy entries that stored only a filename string never pass
// the base64 gate, so they are silently skipped. Each collected image also
// carries the vision description from the newest generation that used it
// (`caption` + `captionScope`/`entryId` so it can be read and edited in place).
export function collectImages(history, imageMeta = {}) {
  const byKey = new Map()
  // Everything any USE of an image (any entry, any slot) says about its role
  // and per-role descriptions, newest use winning per role. A tile is one image
  // shown once, but its descriptions must not be decided by which entry happens
  // to be newest — a later generation that used the image as a plain frame
  // (e.g. a FLUX.2 Klein run) used to replace the tile wholesale and hide the
  // role-keyed descriptions an older reference-mode entry had stored.
  const agg = new Map() // key → { captions: { role: { text, ts } }, role: { id, ts } | null }
  const stats = { entries: (history || []).length, rawFields: 0, objWithBase64: 0, collected: 0 }
  const note = (key, ts, role, caps) => {
    let a = agg.get(key)
    if (!a) { a = { captions: {}, role: null }; agg.set(key, a) }
    if (role && (!a.role || ts >= a.role.ts)) a.role = { id: role, ts }
    for (const [r, text] of Object.entries(caps)) {
      if (!a.captions[r] || ts >= a.captions[r].ts) a.captions[r] = { text, ts }
    }
  }
  const consider = (im, ts, slot, ctx) => {
    if (im == null || typeof im !== 'object') return
    stats.rawFields++
    const url = im.url || null   // sidecar blob URL; history rows carry no bytes
    if (!url) return
    stats.objWithBase64++
    const key = keyOf(im, url)
    const isRender = slot === 'render'
    // A ref-mode entry's caption used to be ONE block covering every
    // reference image (see adapt.js's REF_IMAGE_LINE_RE comment), then a
    // single structural im.caption field, and is now a role-keyed map
    // (im.captions — "🤖 Describe with AI" can describe the same image under
    // several different roles, each kept separately). `resolveRefCaption`
    // (adapt.js) is the one shared place that knows the full fallback order
    // (structural map → legacy flat `caption` → legacy shared-block
    // extraction) — used here for the image's OWN assigned role only; every
    // other role's text, if any, comes straight from im.captions.
    const refImageIndex = slot === 'ref' && ctx.refIndex != null ? ctx.refIndex + 1 : null
    const ownRoleKey = im.role || ROLE_NONE
    const refCaptions = (!isRender && refImageIndex != null) ? { ...(im.captions || {}) } : {}
    if (refImageIndex != null && refCaptions[ownRoleKey] == null) {
      const legacy = resolveRefCaption(im, ownRoleKey, ctx.caption, refImageIndex)
      if (legacy) refCaptions[ownRoleKey] = legacy
    }
    // This use's role-keyed descriptions. A frame slot's entry-level caption
    // describes that one image under the role the entry ran it with (its
    // firstImg.role, or General for entries saved before roles existed); a
    // multi-frame caption covers several images, so it belongs to none.
    const scope = captionScope(ctx.frameMode, slot)
    const useCaps = isRender ? (im.revisedPrompt ? { [ROLE_GENERAL]: im.revisedPrompt } : {})
      : refImageIndex != null ? normCaptions(refCaptions)
      : (scope === 'single' && ctx.caption) ? { [normalizeRole(im.role)]: ctx.caption }
      : {}
    note(key, ts, im.role ? normalizeRole(im.role) : null, useCaps)

    const prev = byKey.get(key)
    if (prev && prev.ts >= ts) { prev.uses++; return }
    byKey.set(key, {
      key,
      url,
      mediaType: im.mediaType || 'image/jpeg',
      fileName: im.fileName || (isRender ? `grok-render.${(im.mediaType || 'image/png').split('/')[1] || 'png'}` : 'image.jpg'),
      hash: im.hash || null,
      note: im.note || '',
      render: isRender ? (im.upscaled ? '🎨 2K' : '🎨') : null,
      slot,
      // role / caption / captions are filled in below, once every use of the
      // image has been seen (aggregation + the per-image record overlay).
      role: ROLE_GENERAL, caption: '', captions: {},
      // 'ref-item' means "this image's position within its entry is known" —
      // it must NOT depend on whether a caption already has text (that's
      // just which VALUE to display). Gating scope on "already described" was
      // a real regression once (see git history) — every ref-slot image with
      // a known index is 'ref-item', full stop.
      captionScope: refImageIndex != null ? 'ref-item' : scope,
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
  for (const tile of byKey.values()) applyRecord(tile, agg.get(tile.key), imageMeta)
  stats.collected = byKey.size
  return { images: [...byKey.values()].sort((a, b) => b.ts - a.ts), stats }
}

// Settle a tile's role + descriptions from (a) what its uses recorded and (b)
// the per-image record, which wins: it is what the app treats as the image's
// CURRENT role and per-role text (edits and fresh descriptions land there).
// Role: record → newest use that had one → General. `caption` is the text under
// the tile's own role, for callers that want a single string.
function applyRecord(tile, a, imageMeta) {
  const rec = tile.hash ? imageMeta?.[tile.hash] : null
  const captions = {}
  if (a) for (const [r, v] of Object.entries(a.captions)) captions[r] = v.text
  Object.assign(captions, normCaptions(rec?.captions))
  tile.captions = captions
  tile.role = rec?.role ? normalizeRole(rec.role) : (a?.role?.id || ROLE_GENERAL)
  tile.caption = captions[tile.role] || ''
}

// Maps standalone library items (dropped in via the gallery's own drop zone,
// not tied to any generation — see App.jsx's addLibraryImages/library state)
// into the SAME tile shape collectImages() produces, so Tile/ImageInfoPanel
// need no per-source branching beyond `slot`. `key` is the library store's
// own id (not a content hash) — onRemoveLibraryImage needs a real id back,
// and a hash collision with a history-derived tile must never hide this
// tile's own delete button (see the no-cross-dedup merge below).
export function libraryTiles(library, imageMeta = {}) {
  return (library || []).filter(im => im && im.url).map(im => {
    const tile = {
      key: im.id,
      url: im.url,
      mediaType: im.mediaType || 'image/jpeg',
      fileName: im.fileName || 'image.jpg',
      hash: im.hash || null,
      note: '',
      render: null,
      slot: 'library',
      role: ROLE_GENERAL, caption: '', captions: {},
      captionScope: 'library',
      refImageIndex: null,
      entryId: null,
      ts: im.ts || 0,
      uses: 1,
    }
    // The library record's own role/captions are one "use" of the image, like a
    // history entry's; the per-image record (imageMeta) still wins over them.
    const own = {}
    for (const [r, text] of Object.entries(normCaptions(im.captions))) own[r] = { text, ts: 0 }
    applyRecord(tile, { captions: own, role: im.role ? { id: normalizeRole(im.role), ts: 0 } : null }, imageMeta)
    return tile
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
  onSaveImageCaption, onSetImageRole, onDescribeImage,
  onClose,
}) {
  // A library image is not tied to any entry (no entryId/refImageIndex), so
  // it uses its own id (img.key) directly — same role-keyed captions model
  // as a reference image, different save/describe target.
  const isRefItem = img.captionScope === 'ref-item' && img.refImageIndex != null
  const isLibraryItem = img.slot === 'library'
  // Every image with a content hash has a role and per-role descriptions (the
  // per-image record). Only a hash-less tile (an old Grok render) is left with
  // the flat, read-only revised prompt.
  const supportsRoles = isRefItem || isLibraryItem || !!img.hash
  const canEdit = supportsRoles
    ? (!!onSaveImageCaption || (isRefItem && !!img.entryId && !!onSaveRefImageCaption) || (isLibraryItem && !!onSaveLibraryCaption))
    : img.slot !== 'render' && !!img.entryId && !!onSaveCaption
  const canDescribe = supportsRoles && (!!onDescribeImage || (isRefItem && !!onDescribeRefImage) || (isLibraryItem && !!onDescribeLibraryImage))
  const canSetRole = supportsRoles && (!!onSetImageRole || (isLibraryItem && !!onSetLibraryRole))

  const ownRoleKey = normalizeRole(img.role)

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
    ? [ownRoleKey, ...IMAGE_ROLES.map(r => r.id).filter(id => id !== ownRoleKey && (img.captions?.[id] || id === editingRole))]
    : []
  const pickableRoles = supportsRoles ? IMAGE_ROLES.filter(r => !shownRoles.includes(r.id)) : []

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
      else {
        // The entry / library record keep their own copy (the History card
        // editor reads those); the per-image record is what the rest of the
        // app reads. 'general' maps to the legacy "no role" key those two use.
        const legacyRole = roleId === ROLE_GENERAL ? ROLE_NONE : roleId
        if (isLibraryItem && onSaveLibraryCaption) await onSaveLibraryCaption(img.key, draft, legacyRole)
        else if (isRefItem && img.entryId && onSaveRefImageCaption) await onSaveRefImageCaption(img.entryId, img.refImageIndex - 1, draft, legacyRole)
        if (onSaveImageCaption) await onSaveImageCaption(img, draft, roleId)
      }
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
      const text = onDescribeImage ? await onDescribeImage(img, roleId)
        : isLibraryItem ? await onDescribeLibraryImage(img.key, roleId)
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
          {canSetRole && (
            <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <label style={{ fontSize: 11.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Role</label>
              <select
                value={ownRoleKey}
                onChange={async e => {
                  const next = e.target.value
                  if (isLibraryItem && onSetLibraryRole) await onSetLibraryRole(img.key, next === ROLE_GENERAL ? null : next)
                  if (onSetImageRole) await onSetImageRole(img, next)
                }}
                style={{ fontSize: 12.5, color: 'var(--pe-ink-2)', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '3px 6px' }}
              >
                {IMAGE_ROLES.map(r => (
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

// What a picked/dragged tile carries to its drop target. Two consumers read it:
//  - a still-image target's ImagePanel takes `imageRole` (the image's role,
//    always a real IMAGE_ROLES id) and `captions` (its role → text map) so the
//    description under the CURRENT role is reused instead of re-asked;
//  - an H3 reference slot takes `role` — only a real H3 role (General and
//    unknown ids arrive as null, so its dropdown keeps defaulting), `note`,
//    and the same `captions` map (marks which roles are already described).
// `caption`/`note` stay ref-slot/library-only as before: a frame/render text is
// not a reference-slot caption.
export const pickPayload = (img, base) => ({
  ...base,
  caption: (img.slot === 'ref' || img.slot === 'library') ? img.caption : '',
  role: (img.slot === 'ref' || img.slot === 'library') ? h3RoleOrNull(img.role) : null,
  note: (img.slot === 'ref' || img.slot === 'library') ? img.note : '',
  captions: img.captions || {},
  imageRole: normalizeRole(img.role),
})


// One thumbnail. Memoized because the grid renders up to CAP of them and the
// only thing that changes per keystroke elsewhere in the app is nothing at all —
// `img` comes from a memoized collectImages() and every callback is stable, so a
// tile re-renders only when it is the one whose info panel opened or closed.
const Tile = memo(function Tile({ img, selected, onPick, onToggleInfo, onDragStart, onRemove }) {
  const pick = onPick ? async () => {
    const resolved = await resolveDragImage({ url: img.url, mediaType: img.mediaType, fileName: img.fileName, hash: img.hash })
    if (!resolved) return
    onPick(pickPayload(img, resolved))
  } : undefined

  // Every role this image has actually been described under (img.captions,
  // populated by consider() — see above), not just its own originally
  // assigned role — so adding an alternate-role description via the info
  // panel's picker shows up here too instead of the badge staying frozen on
  // whatever it was at creation. No question-mark fallback: an image with
  // no description at all simply gets no badge, rather than a permanent
  // "no role" placeholder.
  const describedRoles = IMAGE_ROLES.filter(r => r.id !== ROLE_GENERAL && img.captions?.[r.id])
  const badge = [img.role !== ROLE_GENERAL ? roleIcon(img.role) : null, ...describedRoles.filter(r => r.id !== img.role).map(r => r.icon)].filter(Boolean)

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, img)}
      onClick={pick}
      title={`${img.fileName}${img.render ? ' · Grok render' : ''} · ${roleIcon(img.role)} ${roleLabel(img.role)}${describedRoles.length ? ` · described: ${describedRoles.map(r => `${r.icon} ${r.label}`).join(', ')}` : ''}${img.note ? ` · "${img.note}"` : ''}\n${new Date(img.ts).toLocaleString()}${img.uses > 1 ? ` · used ${img.uses}×` : ''}`}
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
      {(badge.length > 0 || img.render) && (
        <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, fontSize: 11, lineHeight: '16px', padding: '1px 4px', background: 'rgba(8,8,16,0.78)', color: 'var(--pe-accent-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {img.render || badge.join(' ')}
        </span>
      )}
    </div>
  )
})

function HistoryImageGallery({
  history, onPick, pickHint, onSaveCaption, onSaveRefImageCaption, onDescribeRefImage,
  library = [], onAddLibraryImages = null, onRemoveLibraryImage = null,
  onSaveLibraryCaption = null, onSetLibraryRole = null, onDescribeLibraryImage = null,
  imageMeta = null, onSaveImageCaption = null, onSetImageRole = null, onDescribeImage = null,
}) {
  const [open, setOpen] = useState(false)
  const [infoFor, setInfoFor] = useState(null)  // img.key of the open info panel
  const [dragOver, setDragOver] = useState(false)
  const touchedRef = useRef(false)
  const { images, stats } = useMemo(() => collectImages(history, imageMeta || {}), [history, imageMeta])

  // Library items merged in alongside the history-derived ones — no
  // cross-source dedup by hash: if a collision let a history-sourced tile
  // win, the surviving tile would have no library id and the ✕ button would
  // never render, silently orphaning the library row with no way to delete
  // it from the UI.
  const merged = useMemo(
    () => [...libraryTiles(library, imageMeta || {}), ...images].sort((a, b) => b.ts - a.ts),
    [library, images, imageMeta],
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
    setDragImage(pickPayload(img, { url: img.url, mediaType: img.mediaType, fileName: img.fileName, hash: img.hash }))
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
              onSaveImageCaption={onSaveImageCaption} onSetImageRole={onSetImageRole} onDescribeImage={onDescribeImage}
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

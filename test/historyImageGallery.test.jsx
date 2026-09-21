// End-to-end reproduction of the reported bugs around per-reference caption
// editing in the History gallery, across all rounds:
//  1. editing one image's description overwrote every other reference's
//     description in the same entry (whole-block save)
//  2. the per-line splice fix that followed was a silent no-op whenever the
//     target line didn't parse — the edit was discarded, not saved, while
//     the UI still reported success
//  3. captionScope stayed gated on "already has text", silently falling back
//     to the whole-block save path for exactly the images already fixed
// This file exercises the CURRENT (role-keyed) design: a reference image can
// be described under several different roles at once (Subject, Pose, …),
// each kept separately in refImages[i].captions[roleId] (App.jsx's
// saveRefImageCaption — mirrored here as a plain array-index + map-key
// write), which can neither silently drop an edit nor touch a sibling index
// or a sibling role, and works even on an entry whose OLD shared `caption`
// block (or OLD flat structural `caption` field) is already corrupted/legacy.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import HistoryImageGallery, { collectImages, libraryTiles, ImageInfoPanel, pickPayload } from '../src/components/HistoryImageGallery.jsx'
import { ROLE_NONE, ROLE_GENERAL } from '../src/constants.js'

const REF_CAPTION_BLOCK = [
  'Image 1 — role: Subject / Identity, preservation: Exact (fully_preserved): A woman in her thirties, dark hair.',
  'Image 2 — role: Wardrobe / Clothing, preservation: Strong (partially_preserved): A red wool coat, double-breasted.',
  'Image 3 — role: Location, preservation: Guide (attribute_transfer): An unlit room with a tall sash window.',
].join('\n\n')

const entry = (caption, refImages) => ({
  id: 'e1', ts: 1000, frameMode: 'ref', caption,
  refImages: refImages || [
    { url: '/api/blob/a', fileName: 'a.jpg', hash: 'hash-a', role: 'subject_identity' },
    { url: '/api/blob/b', fileName: 'b.jpg', hash: 'hash-b', role: 'wardrobe' },
    { url: '/api/blob/c', fileName: 'c.jpg', hash: 'hash-c', role: 'environment' },
  ],
})

// Mirrors App.jsx's saveRefImageCaption exactly: a plain map-by-index write
// into refImages[i].captions[roleId || im.role || ROLE_NONE] — never reads or
// rewrites the legacy flat `caption` field.
const saveRefImageCaption = (h, imageIndex0based, text, roleId) => ({
  ...h,
  refImages: h.refImages.map((im, i) => {
    if (i !== imageIndex0based) return im
    const key = roleId || im.role || ROLE_NONE
    return { ...im, captions: { ...(im.captions || {}), [key]: text } }
  }),
})

describe('HistoryImageGallery — per-reference caption editing (structural save)', () => {
  it('collectImages() falls back to extracting each image\'s own line from the legacy block before any structural caption exists', () => {
    const { images } = collectImages([entry(REF_CAPTION_BLOCK)])
    const byHash = Object.fromEntries(images.map(im => [im.hash, im]))
    expect(byHash['hash-a'].captionScope).toBe('ref-item')
    expect(byHash['hash-a'].caption).toBe('A woman in her thirties, dark hair.')
    expect(byHash['hash-b'].caption).toBe('A red wool coat, double-breasted.')
    expect(byHash['hash-c'].caption).toBe('An unlit room with a tall sash window.')
  })

  it('editing image 1 and saving leaves images 2 and 3 exactly as they were', () => {
    let h = entry(REF_CAPTION_BLOCK)
    const { images: images1 } = collectImages([h])
    const img1 = images1.find(im => im.hash === 'hash-a')

    h = saveRefImageCaption(h, img1.refImageIndex - 1, 'A completely different description for image 1.')

    const { images: images2 } = collectImages([h])
    const byHash2 = Object.fromEntries(images2.map(im => [im.hash, im]))
    expect(byHash2['hash-a'].caption).toBe('A completely different description for image 1.')
    expect(byHash2['hash-b'].caption).toBe('A red wool coat, double-breasted.')
    expect(byHash2['hash-c'].caption).toBe('An unlit room with a tall sash window.')
  })

  it('editing image 2 (the middle one) leaves images 1 and 3 untouched', () => {
    let h = entry(REF_CAPTION_BLOCK)
    const { images: images1 } = collectImages([h])
    const img2 = images1.find(im => im.hash === 'hash-b')

    h = saveRefImageCaption(h, img2.refImageIndex - 1, 'Now a blue jacket instead.')

    const { images: images2 } = collectImages([h])
    const byHash2 = Object.fromEntries(images2.map(im => [im.hash, im]))
    expect(byHash2['hash-a'].caption).toBe('A woman in her thirties, dark hair.')
    expect(byHash2['hash-b'].caption).toBe('Now a blue jacket instead.')
    expect(byHash2['hash-c'].caption).toBe('An unlit room with a tall sash window.')
  })

  it('editing all three images in sequence (as separate saves) ends with all three correct', () => {
    let h = entry(REF_CAPTION_BLOCK)
    for (const [hash, newText] of [['hash-a', 'Edit 1'], ['hash-b', 'Edit 2'], ['hash-c', 'Edit 3']]) {
      const { images } = collectImages([h])
      const img = images.find(im => im.hash === hash)
      h = saveRefImageCaption(h, img.refImageIndex - 1, newText)
    }
    const { images: final } = collectImages([h])
    const byHash = Object.fromEntries(final.map(im => [im.hash, im]))
    expect(byHash['hash-a'].caption).toBe('Edit 1')
    expect(byHash['hash-b'].caption).toBe('Edit 2')
    expect(byHash['hash-c'].caption).toBe('Edit 3')
  })

  // Round 4's actual regression: captionScope stayed gated on `!im.caption`,
  // a leftover from when 'ref-item' meant "nothing extracted yet, use the
  // splice fallback." Once an image had its own structural caption (i.e. any
  // image the user had already fixed), it silently fell OUT of 'ref-item'
  // scope back to plain 'ref' — hiding the "Describe with AI" button, AND
  // making a second edit save through the OLD whole-block onSaveCaption()
  // path again. 'ref-item' must depend only on "is this image's position
  // known", never on whether it already has text.
  it('stays in ref-item scope on a SECOND edit — an already-described image does not fall back to whole-block scope', () => {
    let h = entry(REF_CAPTION_BLOCK)
    const { images: images1 } = collectImages([h])
    const img1 = images1.find(im => im.hash === 'hash-a')
    expect(img1.captionScope).toBe('ref-item')

    h = saveRefImageCaption(h, img1.refImageIndex - 1, 'First edit.')

    const { images: images2 } = collectImages([h])
    const img1Again = images2.find(im => im.hash === 'hash-a')
    // This is the regression check: still 'ref-item', not demoted to 'ref'.
    expect(img1Again.captionScope).toBe('ref-item')
    expect(img1Again.caption).toBe('First edit.')

    // And a second save on the same, now-described image still only
    // touches its own line.
    h = saveRefImageCaption(h, img1Again.refImageIndex - 1, 'Second edit.')
    const { images: images3 } = collectImages([h])
    const byHash3 = Object.fromEntries(images3.map(im => [im.hash, im]))
    expect(byHash3['hash-a'].caption).toBe('Second edit.')
    expect(byHash3['hash-b'].caption).toBe('A red wool coat, double-breasted.')
    expect(byHash3['hash-c'].caption).toBe('An unlit room with a tall sash window.')
  })

  // Round 3's actual bug: extraction failing for one image made its own save
  // a guaranteed no-op (spliceRefImageCaption re-running the same failing
  // regex against the same input). The structural save can't no-op — it's
  // a plain index write regardless of what (if anything) extracted.
  it('a malformed line for one image no longer blocks saving it', () => {
    const brokenBlock = [
      'Image 1 — role: Subject / Identity, preservation: Exact (fully_preserved): A woman in her thirties, dark hair.',
      'Image 2 — role: Wardrobe / Clothing — a completely different, malformed line shape.',
      'Image 3 — role: Location, preservation: Guide (attribute_transfer): An unlit room with a tall sash window.',
    ].join('\n\n')
    let h = entry(brokenBlock)

    const { images } = collectImages([h])
    const byHash = Object.fromEntries(images.map(im => [im.hash, im]))
    expect(byHash['hash-b'].caption).toBe('')   // nothing extracted — honest empty start

    h = saveRefImageCaption(h, byHash['hash-b'].refImageIndex - 1, 'face of a woman')

    const { images: after } = collectImages([h])
    const byHashAfter = Object.fromEntries(after.map(im => [im.hash, im]))
    expect(byHashAfter['hash-b'].caption).toBe('face of a woman')   // the edit actually took
    expect(byHashAfter['hash-a'].caption).toBe('A woman in her thirties, dark hair.')
    expect(byHashAfter['hash-c'].caption).toBe('An unlit room with a tall sash window.')
  })

  // The actual stuck state after rounds 1+3: an entry's shared `caption` has
  // no recognizable per-image structure left at all (e.g. flattened by the
  // original whole-block-overwrite bug). Every image on it must still be
  // individually editable and saveable going forward.
  it('an entry whose whole caption block is already corrupted can still be repaired image by image', () => {
    let h = entry('face of a woman')   // exactly the reported corrupted state — no "Image N —" lines at all
    const { images: before } = collectImages([h])
    const byHashBefore = Object.fromEntries(before.map(im => [im.hash, im]))
    expect(byHashBefore['hash-a'].caption).toBe('')
    expect(byHashBefore['hash-b'].caption).toBe('')
    expect(byHashBefore['hash-c'].caption).toBe('')

    h = saveRefImageCaption(h, 0, 'Her face, dark hair, calm expression.')
    h = saveRefImageCaption(h, 1, 'A red wool coat.')

    const { images: after } = collectImages([h])
    const byHashAfter = Object.fromEntries(after.map(im => [im.hash, im]))
    expect(byHashAfter['hash-a'].caption).toBe('Her face, dark hair, calm expression.')
    expect(byHashAfter['hash-b'].caption).toBe('A red wool coat.')
    expect(byHashAfter['hash-c'].caption).toBe('')   // still unedited — untouched, not corrupted further
  })
})

describe('HistoryImageGallery — role-specific descriptions (multiple per image)', () => {
  it('describing an image under a role DIFFERENT from its assigned role stores separately, touching neither the own-role caption nor the legacy flat field', () => {
    let h = entry(REF_CAPTION_BLOCK)   // hash-a is role: subject_identity
    const { images: before } = collectImages([h])
    const imgA = before.find(im => im.hash === 'hash-a')
    expect(imgA.role).toBe('subject_identity')
    expect(imgA.caption).toBe('A woman in her thirties, dark hair.')   // legacy-block fallback, own role

    h = saveRefImageCaption(h, imgA.refImageIndex - 1, 'Standing upright, weight on the left leg, facing three-quarters away.', 'pose_composition')

    const { images: after } = collectImages([h])
    const imgAAfter = after.find(im => im.hash === 'hash-a')
    // Own-role description (still resolving through the legacy block) is untouched.
    expect(imgAAfter.caption).toBe('A woman in her thirties, dark hair.')
    expect(imgAAfter.captions.subject_identity).toBe('A woman in her thirties, dark hair.')
    // The new role's description lives alongside it, not instead of it.
    expect(imgAAfter.captions.pose_composition).toBe('Standing upright, weight on the left leg, facing three-quarters away.')
    // Siblings (other images) are completely unaffected.
    expect(after.find(im => im.hash === 'hash-b').caption).toBe('A red wool coat, double-breasted.')
    expect(after.find(im => im.hash === 'hash-c').caption).toBe('An unlit room with a tall sash window.')
  })

  it('describing under the own role writes to captions[ownRole], which then wins over the legacy flat field on every later read', () => {
    let h = entry(REF_CAPTION_BLOCK)
    const { images: before } = collectImages([h])
    const imgA = before.find(im => im.hash === 'hash-a')

    // No explicit roleId — defaults to the image's own assigned role, same
    // as the plain History-card editor (which never passes a 4th arg).
    h = saveRefImageCaption(h, imgA.refImageIndex - 1, 'Freshly re-described identity text.')

    const { images: after } = collectImages([h])
    const imgAAfter = after.find(im => im.hash === 'hash-a')
    expect(imgAAfter.caption).toBe('Freshly re-described identity text.')
    expect(imgAAfter.captions.subject_identity).toBe('Freshly re-described identity text.')
    // The map entry now wins even though the legacy block still has the old line.
    expect(h.refImages[0].caption).toBeUndefined()   // never written by the new save path
  })

  it('collectImages() surfaces a captions map with an entry per described role, keyed by role id', () => {
    let h = entry(REF_CAPTION_BLOCK)
    const { images: before } = collectImages([h])
    const imgB = before.find(im => im.hash === 'hash-b')   // role: wardrobe

    h = saveRefImageCaption(h, imgB.refImageIndex - 1, 'Cropped denim jacket, frayed cuffs.', 'style')
    h = saveRefImageCaption(h, imgB.refImageIndex - 1, 'A worn leather satchel with a brass buckle.', 'product_object')

    const { images: after } = collectImages([h])
    const imgBAfter = after.find(im => im.hash === 'hash-b')
    expect(imgBAfter.captions).toEqual({
      wardrobe: 'A red wool coat, double-breasted.',   // legacy-block fallback, own role
      style: 'Cropped denim jacket, frayed cuffs.',
      product_object: 'A worn leather satchel with a brass buckle.',
    })
  })

  it('an image with no assigned role is General, and describing it under a real role leaves General untouched', () => {
    let h = entry('', [
      { url: '/api/blob/x', fileName: 'x.jpg', hash: 'hash-x', role: null },
    ])
    const { images: before } = collectImages([h])
    const imgX = before[0]
    expect(imgX.role).toBe('general')   // every image always has a role
    expect(imgX.caption).toBe('')

    h = saveRefImageCaption(h, 0, 'A weathered leather armchair.', 'product_object')

    const { images: after } = collectImages([h])
    const imgXAfter = after[0]
    expect(imgXAfter.role).toBe('general')
    expect(imgXAfter.caption).toBe('')   // its own role (General) still empty
    expect(imgXAfter.captions[ROLE_GENERAL]).toBeUndefined()
    expect(imgXAfter.captions.product_object).toBe('A weathered leather armchair.')
  })

  it('a legacy "_unassigned" caption reads as the General description', () => {
    const h = entry('', [{ url: '/api/blob/x', fileName: 'x.jpg', hash: 'hash-x', captions: { [ROLE_NONE]: 'An old caption.' } }])
    const [img] = collectImages([h]).images
    expect(img.role).toBe('general')
    expect(img.caption).toBe('An old caption.')
  })
})

// Standalone reusable images dropped directly onto the gallery (not tied to
// any generation — see App.jsx's addLibraryImages/library state and the new
// GET/PUT/DELETE /api/library sidecar routes). libraryTiles() maps them into
// the same tile shape collectImages() produces so Tile/ImageInfoPanel need no
// per-source branching beyond `slot`.
describe('HistoryImageGallery — library items (dropped in directly, not from history)', () => {
  it('maps a library item into the standard tile shape, tagged for no edit/describe UI', () => {
    const [tile] = libraryTiles([
      { id: 'lib1', ts: 2000, url: '/api/blob/x', mediaType: 'image/png', fileName: 'x.png', hash: 'hash-x' },
    ])
    expect(tile.key).toBe('lib1')       // the library store's own id, not a content hash
    expect(tile.slot).toBe('library')
    expect(tile.entryId).toBeNull()     // ImageInfoPanel's canEdit/canDescribe gate off this
    expect(tile.url).toBe('/api/blob/x')
    expect(tile.ts).toBe(2000)
  })

  it('skips a library item with no resolved blob url', () => {
    expect(libraryTiles([{ id: 'lib1', ts: 1 }, null])).toEqual([])
  })

  it('merges library tiles alongside history-derived ones, newest first, with no cross-source dedup', () => {
    const h = entry(REF_CAPTION_BLOCK)   // has hash-a/b/c, ts 1000
    const lib = [{ id: 'lib1', ts: 5000, url: '/api/blob/lib', mediaType: 'image/jpeg', fileName: 'l.jpg' }]
    const { images } = collectImages([h])
    const merged = [...libraryTiles(lib), ...images].sort((a, b) => b.ts - a.ts)
    expect(merged[0].key).toBe('lib1')          // newest (ts 5000) sorts first
    expect(merged).toHaveLength(4)              // 1 library + 3 history refs — no dedup collapses them
  })

  it('renders (does not early-return null) with empty history when a library-capable caller is wired, even with zero library items yet', () => {
    const html = renderToStaticMarkup(
      <HistoryImageGallery history={[]} library={[]} onAddLibraryImages={() => {}} />,
    )
    expect(html).not.toBe('')
    expect(html).toContain('Reuse image')
  })

  it('renders a library item even with empty history', () => {
    const html = renderToStaticMarkup(
      <HistoryImageGallery
        history={[]}
        library={[{ id: 'lib1', ts: 1, url: '/api/blob/lib', mediaType: 'image/jpeg', fileName: 'l.jpg' }]}
        onAddLibraryImages={() => {}}
        onRemoveLibraryImage={() => {}}
      />,
    )
    expect(html).toContain('Reuse image (1)')
  })

  it('still returns null with no history and no library when the caller does not support adding library images', () => {
    const html = renderToStaticMarkup(<HistoryImageGallery history={[]} library={[]} />)
    expect(html).toBe('')
  })

  it('surfaces a real role/caption/captions from the source item instead of the old hardcoded empty values', () => {
    const [tile] = libraryTiles([{
      id: 'lib1', ts: 1, url: '/api/blob/x', fileName: 'x.jpg', mediaType: 'image/jpeg',
      role: 'wardrobe', captions: { wardrobe: 'A red wool coat.', style: 'Muted autumn palette.' },
    }])
    expect(tile.role).toBe('wardrobe')
    expect(tile.caption).toBe('A red wool coat.')   // own-role entry, same rule as a ref image
    expect(tile.captions).toEqual({ wardrobe: 'A red wool coat.', style: 'Muted autumn palette.' })
  })

  it('defaults caption to empty for a library item with no captions yet', () => {
    const [tile] = libraryTiles([{ id: 'lib1', ts: 1, url: '/api/blob/x', fileName: 'x.jpg' }])
    expect(tile.role).toBe('general')
    expect(tile.caption).toBe('')
    expect(tile.captions).toEqual({})
  })

  it('ImageInfoPanel shows a role select and working edit/describe controls for a library image (they showed nothing before this feature)', () => {
    const html = renderToStaticMarkup(
      <ImageInfoPanel
        img={libraryTiles([{ id: 'lib1', ts: 1, url: '/api/blob/x', fileName: 'x.jpg', mediaType: 'image/jpeg', role: 'wardrobe', captions: { wardrobe: 'A red coat.' } }])[0]}
        onSaveLibraryCaption={() => {}}
        onSetLibraryRole={() => {}}
        onDescribeLibraryImage={() => {}}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('<select')                 // the new Role selector
    expect(html).toContain('Wardrobe')                 // its own role, pre-selected
    expect(html).toContain('A red coat.')               // the own-role caption text
    expect(html).toContain('✎ Edit')                    // canEdit — gated on onSaveLibraryCaption
    expect(html).toContain('Re-describe with AI')        // canDescribe — gated on onDescribeLibraryImage
  })

  it('ImageInfoPanel shows NO edit/describe controls for a library image when the callbacks are absent', () => {
    const html = renderToStaticMarkup(
      <ImageInfoPanel
        img={libraryTiles([{ id: 'lib1', ts: 1, url: '/api/blob/x', fileName: 'x.jpg', mediaType: 'image/jpeg' }])[0]}
        onClose={() => {}}
      />,
    )
    expect(html).not.toContain('✎ Edit')
    expect(html).not.toContain('Describe with AI')
  })
})

describe('HistoryImageGallery — one role + per-role descriptions per image, across every use', () => {
  const frameEntry = (id, ts, caption, role, frameMode = 'single') => ({
    id, ts, frameMode, caption,
    firstImg: { url: '/api/blob/s', fileName: 's.jpg', hash: 'hash-s', ...(role ? { role } : {}) },
  })
  const refEntry = (ts) => ({
    id: 'r1', ts, frameMode: 'ref', caption: '',
    refImages: [{ url: '/api/blob/s', fileName: 's.jpg', hash: 'hash-s', role: 'pose_composition', captions: { pose_composition: 'Stands, weight on the left leg, arms crossed.' } }],
  })

  it('a NEWER frame-slot (Klein) run does not hide an older reference entry\'s role captions', () => {
    // This is the reported bug: the newest use of an image decided the whole tile.
    const { images } = collectImages([refEntry(1000), frameEntry('k1', 2000, 'A woman in a red coat at a window.')])
    expect(images.length).toBe(1)
    const [img] = images
    expect(img.captions.pose_composition).toBe('Stands, weight on the left leg, arms crossed.')
    expect(img.captions.general).toBe('A woman in a red coat at a window.')   // the Klein caption, filed under General
    expect(img.role).toBe('pose_composition')   // the newest EXPLICIT role — a role-less Klein use does not erase it
  })

  it('files a frame entry\'s caption under the role that entry ran the image with', () => {
    const [img] = collectImages([frameEntry('k1', 2000, 'Stands, arms crossed.', 'pose_composition')]).images
    expect(img.role).toBe('pose_composition')
    expect(img.captions).toEqual({ pose_composition: 'Stands, arms crossed.' })
    expect(img.caption).toBe('Stands, arms crossed.')
  })

  it('newest use wins per role, not per image', () => {
    const { images } = collectImages([frameEntry('a', 1000, 'old general text'), frameEntry('b', 3000, 'new general text'), refEntry(2000)])
    expect(images[0].captions.general).toBe('new general text')
    expect(images[0].captions.pose_composition).toContain('arms crossed')
  })

  it('the per-image record wins over what uses recorded, for both role and text', () => {
    const meta = { 'hash-s': { role: 'general', captions: { general: 'Edited in the gallery.', wardrobe: 'A red wool coat.' } } }
    const [img] = collectImages([refEntry(1000), frameEntry('k1', 2000, 'Klein text')], meta).images
    expect(img.role).toBe('general')
    expect(img.caption).toBe('Edited in the gallery.')
    expect(img.captions.wardrobe).toBe('A red wool coat.')
    expect(img.captions.pose_composition).toContain('arms crossed')   // untouched roles survive
  })

  it('a multi-frame caption covers several images and is filed under none of them', () => {
    const h = { ...frameEntry('m', 2000, 'FIRST FRAME: a fox. LAST FRAME: a den.', null, 'firstlast'), lastImg: { url: '/api/blob/t', fileName: 't.jpg', hash: 'hash-t' } }
    for (const img of collectImages([h]).images) expect(img.captions).toEqual({})
  })

  it('a library tile also takes the per-image record over its own fields', () => {
    const lib = [{ id: 'l1', ts: 1, url: '/api/blob/x', hash: 'hash-x', role: 'wardrobe', captions: { wardrobe: 'old' } }]
    const [tile] = libraryTiles(lib, { 'hash-x': { role: 'style', captions: { wardrobe: 'new' } } })
    expect(tile.role).toBe('style')
    expect(tile.captions.wardrobe).toBe('new')
  })
})

describe('HistoryImageGallery — pick / drag payload', () => {
  const tile = (over) => ({ slot: 'first', role: 'general', caption: '', note: '', captions: {}, ...over })
  it('always carries the real image role and the role → text map', () => {
    const p = pickPayload(tile({ role: 'pose_composition', captions: { pose_composition: 'Stands.' } }), { url: 'u' })
    expect(p.imageRole).toBe('pose_composition')
    expect(p.captions).toEqual({ pose_composition: 'Stands.' })
  })
  it('never hands General (or an unknown id) to an H3 reference slot as its role', () => {
    expect(pickPayload(tile({ slot: 'ref', role: 'general' }), {}).role).toBeNull()
    expect(pickPayload(tile({ slot: 'library', role: 'style' }), {}).role).toBe('style')
  })
  it('keeps caption/note ref-slot-only', () => {
    const p = pickPayload(tile({ slot: 'first', caption: 'frame text', note: 'n' }), {})
    expect(p.caption).toBe('')
    expect(p.note).toBe('')
  })
})

describe('ImageInfoPanel — every image has a role', () => {
  const frame = { key: 'k', url: '/api/blob/s', fileName: 's.jpg', hash: 'hash-s', slot: 'first', captionScope: 'single', role: 'general', caption: '', captions: {}, ts: 1, uses: 1, entryId: 'e1' }
  it('shows a role select and edit/describe controls on a plain frame image', () => {
    const html = renderToStaticMarkup(<ImageInfoPanel img={frame} onSaveImageCaption={() => {}} onSetImageRole={() => {}} onDescribeImage={() => {}} onClose={() => {}} />)
    expect(html).toContain('Role')
    expect(html).toContain('Pose / Composition')
    expect(html).toContain('General (whole image)')
    expect(html).toContain('Describe with AI')
  })
  it('a hash-less tile (old render) keeps the flat read-only revised prompt', () => {
    const html = renderToStaticMarkup(<ImageInfoPanel img={{ ...frame, hash: null, slot: 'render', caption: 'a revised prompt' }} onClose={() => {}} />)
    expect(html).toContain('a revised prompt')
    expect(html).not.toContain('Pose / Composition')
  })
})

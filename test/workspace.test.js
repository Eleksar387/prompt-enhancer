// The workspace field registry: snapshot ↔ restore, and the generation gates.
//
// These replaced four hand-maintained copies of the same logic in App.jsx
// (buildSnapshot, restore, applyQueueItemToWorkspace, plus five variants of the
// frame-mode image check). The round-trip tests are the point: they assert that
// what a generation SAVES is exactly what a restore READS BACK, which is the
// invariant the four copies kept breaking whenever a field was added to only
// three of them.
//
// The legacy-shape tests matter just as much. There are 72 real entries on disk,
// some predating stored image bytes (filename strings only), some predating
// spokenLang/loraIds entirely. Restoring one must never put null into a
// controlled input or invent an image that isn't there.

import { describe, it, expect } from 'vitest'
import {
  WORKSPACE_FIELDS, buildSnapshot, snapshotToWorkspace,
  hasRequiredImages, canGenerate, isProposeMode,
  imgToSnap, imgFromSnap, refImagesToSnap, refImagesFromSnap, refAudiosToSnap, refAudiosFromSnap,
} from '../src/workspace.js'
import { TARGETS, DEFAULT_SPOKEN_LANG, MINIMAX_H3_RESOLUTIONS, MINIMAX_H3_REF_ROLES } from '../src/constants.js'
import { imageHash } from '../src/utils.js'

let idCounter = 0
const newId = () => `id${++idCounter}`

const img = (name = 'a.jpg') => ({
  base64: 'QUJD', mediaType: 'image/png', fileName: name, hash: imageHash('QUJD'),
})

// A fully-populated H3 ref-mode workspace — the target that exercises every field.
const h3Workspace = () => ({
  targetType: 'video', show: TARGETS.minimax_h3.show,
  target: 'minimax_h3', duration: '8 seconds', style: 'dramatic', creativity: 'loose',
  frameMode: 'ref', negative: 'watermark', scene: 'she turns',
  dialogue: 'Wir müssen gehen', delivery: 'urgent whisper',
  spokenLangId: 'de', activeLoraIds: ['a', 'b'], loraSubjects: { a: 'Mara', b: '' },
  manualMode: true,
  firstImg: null, midImg: null, lastImg: null,
  h3RatioId: MINIMAX_H3_RESOLUTIONS[1].id, soundscape: 'rain', music: 'none',
  refImages: [{ ...img('ref.jpg'), role: 'character', preserve: 'strong', note: 'the lead' }],
  refAudios: [{ base64: 'QVVE', mediaType: 'audio/mpeg', fileName: 'voice.mp3', subjectRef: imageHash('QUJD') }],
})

// A FLUX workspace — an image target where most H3 fields are gated off.
const fluxWorkspace = () => ({
  targetType: 'image', show: TARGETS.flux.show,
  target: 'flux', duration: '5 seconds', style: 'calm', creativity: 'balanced',
  frameMode: 'single', negative: '', scene: 'a quiet room',
  dialogue: 'ignored', delivery: 'ignored', spokenLangId: 'fr', activeLoraIds: [], loraSubjects: {},
  manualMode: false,
  firstImg: img('in.jpg'), midImg: null, lastImg: null,
  h3RatioId: '', soundscape: 'ignored', music: 'ignored', refImages: [], refAudios: [],
})

const meta = { model: 'qwen2.5:14b', vision: 'llava', outputCount: 1 }

describe('image (de)serialization', () => {
  it('round-trips an image, keeping bytes and identity', () => {
    const back = imgFromSnap(imgToSnap(img()))
    expect(back.base64).toBe('QUJD')
    expect(back.mediaType).toBe('image/png')
    expect(back.fileName).toBe('a.jpg')
    expect(back.hash).toBe(imageHash('QUJD'))
  })

  it('rebuilds the preview url the panels render', () => {
    expect(imgFromSnap(imgToSnap(img())).previewUrl).toBe('data:image/png;base64,QUJD')
  })

  it('computes a hash for a snapshot saved before hashes existed', () => {
    expect(imgFromSnap({ base64: 'QUJD', fileName: 'x.jpg' }).hash).toBe(imageHash('QUJD'))
  })

  it('reads a legacy filename-string image as absent, not as an image', () => {
    expect(imgFromSnap('old-photo.jpg')).toBeNull()
    expect(imgFromSnap(null)).toBeNull()
    expect(imgFromSnap(undefined)).toBeNull()
    expect(imgFromSnap({ fileName: 'no-bytes.jpg' })).toBeNull()
  })

  it('reads a metadata-only row (blob ref, no bytes) as absent', () => {
    // This is the shape GET /api/history returns — restore() must fetch ?inline=1.
    expect(imgFromSnap({ blobRef: 'abc', hash: 'abc', url: '/api/blob/abc' })).toBeNull()
  })

  it('defaults mediaType to jpeg when a snapshot lacks it', () => {
    expect(imgFromSnap({ base64: 'QUJD' }).mediaType).toBe('image/jpeg')
  })

  it('round-trips reference images with their role, preservation and note', () => {
    const snap = refImagesToSnap(h3Workspace().refImages)
    const back = refImagesFromSnap(snap, newId)
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ role: 'character', preserve: 'strong', note: 'the lead', base64: 'QUJD' })
    expect(back[0].id).toBeTruthy()
  })

  it('gives each restored reference a fresh id', () => {
    const snap = refImagesToSnap([img('a.jpg'), img('b.jpg')])
    const back = refImagesFromSnap(snap, newId)
    expect(back[0].id).not.toBe(back[1].id)
  })

  it('defaults a reference role and preservation that were never stored', () => {
    const back = refImagesFromSnap([{ base64: 'QUJD' }], newId)
    expect(back[0].role).toBe(MINIMAX_H3_REF_ROLES[0].id)
    expect(back[0].preserve).toBe('strong')
    expect(back[0].note).toBe('')
    expect(back[0].loraId).toBeNull()
  })

  it('round-trips a reference image\'s assigned LoRA id', () => {
    const snap = refImagesToSnap([{ ...img('ref.jpg'), loraId: 'lora-1' }])
    expect(refImagesFromSnap(snap, newId)[0].loraId).toBe('lora-1')
  })

  it('round-trips a reference image\'s Add Guide timeline anchor (atSeconds)', () => {
    const snap = refImagesToSnap([{ ...img('ref.jpg'), atSeconds: 1.5 }])
    expect(snap[0].atSeconds).toBe(1.5)
    expect(refImagesFromSnap(snap, newId)[0].atSeconds).toBe(1.5)
  })

  it('defaults atSeconds to null when never anchored', () => {
    const snap = refImagesToSnap([img('ref.jpg')])
    expect(snap[0].atSeconds).toBeNull()
    expect(refImagesFromSnap(snap, newId)[0].atSeconds).toBeNull()
  })

  it('drops byte-less reference entries rather than rendering them broken', () => {
    expect(refImagesFromSnap(['old.jpg', { fileName: 'x' }, null, img()], newId)).toHaveLength(1)
    expect(refImagesFromSnap(null, newId)).toEqual([])
  })

  it('round-trips the voice-timbre audio references, up to two', () => {
    const a = { base64: 'QVVE', mediaType: 'audio/wav', fileName: 'v.wav' }
    const b = { base64: 'QkNE', mediaType: 'audio/wav', fileName: 'w.wav' }
    expect(refAudiosFromSnap(refAudiosToSnap([a, b]))).toEqual([{ ...a, subjectRef: null }, { ...b, subjectRef: null }])
    expect(refAudiosFromSnap(null)).toEqual([])
    expect(refAudiosFromSnap([{ fileName: 'no-bytes' }])).toEqual([])
  })

  it('reads a legacy single-object audio snapshot (before the second slot existed) as a one-item list', () => {
    const a = { base64: 'QVVE', mediaType: 'audio/wav', fileName: 'v.wav' }
    expect(refAudiosFromSnap(a)).toEqual([{ ...a, subjectRef: null }])
  })

  it('caps restored audio references at two', () => {
    const a = { base64: 'QVVE', mediaType: 'audio/wav', fileName: 'a.wav' }
    const b = { base64: 'QkNE', mediaType: 'audio/wav', fileName: 'b.wav' }
    const c = { base64: 'Q0RF', mediaType: 'audio/wav', fileName: 'c.wav' }
    expect(refAudiosFromSnap([a, b, c])).toEqual([{ ...a, subjectRef: null }, { ...b, subjectRef: null }])
  })

  it('round-trips a Manual-mode audio→subject binding', () => {
    const a = { base64: 'QVVE', mediaType: 'audio/wav', fileName: 'v.wav', subjectRef: 'abc123' }
    expect(refAudiosFromSnap(refAudiosToSnap([a]))).toEqual([a])
  })
})

describe('buildSnapshot', () => {
  it('carries every compose field for the target that uses them all', () => {
    const s = buildSnapshot(h3Workspace(), { ...meta, caption: 'a rainy window' })
    expect(s).toMatchObject({
      target: 'minimax_h3', duration: '8 seconds', style: 'dramatic', creativity: 'loose',
      frameMode: 'ref', negative: 'watermark', scene: 'she turns',
      dialogue: 'Wir müssen gehen', delivery: 'urgent whisper',
      spokenLang: 'de', loraIds: ['a', 'b'],
      soundscape: 'rain', music: 'none',
      model: 'qwen2.5:14b', vision: 'llava', outputCount: 1, caption: 'a rainy window',
    })
    expect(s.ts).toBeGreaterThan(0)
  })

  it('stores the ratio as its label, not its id', () => {
    const s = buildSnapshot(h3Workspace(), meta)
    expect(s.ratio).toBe(MINIMAX_H3_RESOLUTIONS[1].label)
  })

  it('falls back to the first ratio preset when none is chosen', () => {
    const s = buildSnapshot({ ...h3Workspace(), h3RatioId: '' }, meta)
    expect(s.ratio).toBe(MINIMAX_H3_RESOLUTIONS[0].label)
  })

  it('blanks the fields a target does not show', () => {
    // FLUX shows no dialogue and no spoken language, and is not H3.
    const s = buildSnapshot(fluxWorkspace(), meta)
    expect(s.dialogue).toBe('')
    expect(s.delivery).toBe('')
    expect(s.spokenLang).toBe('')
    expect(s.soundscape).toBe('')
    expect(s.music).toBe('')
    expect(s.ratio).toBeNull()
    expect(s.refImages).toBeNull()
    expect(s.refAudio).toBeNull()
  })

  it('keeps reference images only in H3 ref mode', () => {
    expect(buildSnapshot(h3Workspace(), meta).refImages).toHaveLength(1)
    const notRef = { ...h3Workspace(), frameMode: 'firstlast' }
    expect(buildSnapshot(notRef, meta).refImages).toBeNull()
    expect(buildSnapshot(notRef, meta).refAudio).toBeNull()
  })

  it('records no vision model for a text-only run', () => {
    expect(buildSnapshot(fluxWorkspace(), { ...meta, vision: null }).vision).toBeNull()
  })

  it('writes caption as null rather than an empty string', () => {
    expect(buildSnapshot(fluxWorkspace(), meta).caption).toBeNull()
    expect(buildSnapshot(fluxWorkspace(), { ...meta, caption: '' }).caption).toBeNull()
  })

  it('has a key for every declared field, always', () => {
    const s = buildSnapshot(fluxWorkspace(), meta)
    for (const f of WORKSPACE_FIELDS) expect(s).toHaveProperty(f.snap)
  })
})

describe('snapshot → workspace round trip', () => {
  it('restores every field of a full H3 ref-mode generation', () => {
    const w = h3Workspace()
    const back = snapshotToWorkspace(buildSnapshot(w, meta), { newId })
    expect(back.target).toBe(w.target)
    expect(back.duration).toBe(w.duration)
    expect(back.style).toBe(w.style)
    expect(back.creativity).toBe(w.creativity)
    expect(back.frameMode).toBe(w.frameMode)
    expect(back.negative).toBe(w.negative)
    expect(back.scene).toBe(w.scene)
    expect(back.dialogue).toBe(w.dialogue)
    expect(back.delivery).toBe(w.delivery)
    expect(back.spokenLangId).toBe(w.spokenLangId)
    expect(back.activeLoraIds).toEqual(w.activeLoraIds)
    expect(back.loraSubjects).toEqual(w.loraSubjects)
    expect(back.manualMode).toBe(w.manualMode)
    expect(back.soundscape).toBe(w.soundscape)
    expect(back.music).toBe(w.music)
    expect(back.h3RatioId).toBe(w.h3RatioId)          // label → id resolves back
    expect(back.refImages[0].base64).toBe('QUJD')
    expect(back.refAudios).toHaveLength(1)
    expect(back.refAudios[0]).toMatchObject(w.refAudios[0])
    expect(back.refAudios[0].id).toBeTruthy()
  })

  it('restores the frame images of a first→mid→last generation', () => {
    const w = {
      ...h3Workspace(), frameMode: 'firstmidlast',
      firstImg: img('1.jpg'), midImg: img('2.jpg'), lastImg: img('3.jpg'),
    }
    const back = snapshotToWorkspace(buildSnapshot(w, meta), { newId })
    expect(back.firstImg.fileName).toBe('1.jpg')
    expect(back.midImg.fileName).toBe('2.jpg')
    expect(back.lastImg.fileName).toBe('3.jpg')
  })

  it('is idempotent — restoring then re-saving produces the same snapshot', () => {
    const first = buildSnapshot(h3Workspace(), meta)
    const restored = snapshotToWorkspace(first, { newId })
    // Re-saving needs the non-field context back (targetType/show are derived from
    // the target, exactly as App does it).
    const second = buildSnapshot(
      { ...restored, targetType: 'video', show: TARGETS.minimax_h3.show },
      meta,
    )
    for (const f of WORKSPACE_FIELDS) {
      if (f.snap === 'refImages') continue   // ids are regenerated by design
      expect(second[f.snap]).toEqual(first[f.snap])
    }
    expect(second.refImages).toEqual(first.refImages)
  })
})

describe('restoring older entries', () => {
  it('defaults a spoken language that was never saved', () => {
    const back = snapshotToWorkspace({ target: 'ltx' }, { newId })
    expect(back.spokenLangId).toBe(DEFAULT_SPOKEN_LANG)
  })

  it('defaults an empty spoken language (a target that does not show it)', () => {
    expect(snapshotToWorkspace({ target: 'flux', spokenLang: '' }, { newId }).spokenLangId)
      .toBe(DEFAULT_SPOKEN_LANG)
  })

  it('defaults LoRA ids that were never saved, and rejects a non-array', () => {
    expect(snapshotToWorkspace({ target: 'ltx' }, { newId }).activeLoraIds).toEqual([])
    expect(snapshotToWorkspace({ target: 'ltx', loraIds: 'nope' }, { newId }).activeLoraIds).toEqual([])
  })

  it('defaults LoRA subjects that were never saved, and rejects a non-object', () => {
    expect(snapshotToWorkspace({ target: 'ltx' }, { newId }).loraSubjects).toEqual({})
    expect(snapshotToWorkspace({ target: 'ltx', loraSubjects: 'nope' }, { newId }).loraSubjects).toEqual({})
    expect(snapshotToWorkspace({ target: 'ltx', loraSubjects: ['nope'] }, { newId }).loraSubjects).toEqual({})
  })

  it('defaults manualMode that was never saved (an entry predating the field), and coerces a non-boolean', () => {
    expect(snapshotToWorkspace({ target: 'ltx' }, { newId }).manualMode).toBe(false)
    expect(snapshotToWorkspace({ target: 'ltx', manualMode: 'yes' }, { newId }).manualMode).toBe(false)
    expect(snapshotToWorkspace({ target: 'ltx', manualMode: true }, { newId }).manualMode).toBe(true)
  })

  it('never hands a null to a controlled text input', () => {
    const back = snapshotToWorkspace({ target: 'ltx', scene: null, negative: null, dialogue: null, soundscape: null, music: null }, { newId })
    for (const key of ['scene', 'negative', 'dialogue', 'delivery', 'soundscape', 'music']) {
      expect(back[key]).toBe('')
    }
  })

  it('reads a legacy filename-only entry as having no images', () => {
    const back = snapshotToWorkspace({ target: 'ltx', firstImg: 'shot1.jpg', lastImg: 'shot2.jpg' }, { newId })
    expect(back.firstImg).toBeNull()
    expect(back.lastImg).toBeNull()
  })

  it('leaves the ratio unset when the stored label no longer exists', () => {
    expect(snapshotToWorkspace({ target: 'minimax_h3', ratio: '999×999' }, { newId }).h3RatioId).toBe('')
  })

  it('survives a snapshot whose target was removed from the app', () => {
    expect(() => snapshotToWorkspace({ target: 'retired', ratio: '1×1' }, { newId })).not.toThrow()
  })

  it('survives an almost-empty snapshot', () => {
    expect(() => snapshotToWorkspace({}, { newId })).not.toThrow()
  })
})

describe('hasRequiredImages', () => {
  const w = (over) => ({ targetType: 'video', frameMode: 'single', refImages: [], ...over })

  it('an image target asks only about the one reference image', () => {
    expect(hasRequiredImages(w({ targetType: 'image', firstImg: img() }))).toBe(true)
    expect(hasRequiredImages(w({ targetType: 'image' }))).toBe(false)
  })

  it('ignores frameMode entirely for an image target', () => {
    // Precedence preserved from the original: the image-type branch comes first,
    // so a stale frameMode left over from another target cannot block generation.
    expect(hasRequiredImages(w({ targetType: 'image', frameMode: 'firstmidlast', firstImg: img() }))).toBe(true)
  })

  it('first→last needs both ends', () => {
    expect(hasRequiredImages(w({ frameMode: 'firstlast', firstImg: img() }))).toBe(false)
    expect(hasRequiredImages(w({ frameMode: 'firstlast', firstImg: img(), lastImg: img() }))).toBe(true)
  })

  it('first→mid→last needs all three', () => {
    expect(hasRequiredImages(w({ frameMode: 'firstmidlast', firstImg: img(), lastImg: img() }))).toBe(false)
    expect(hasRequiredImages(w({ frameMode: 'firstmidlast', firstImg: img(), midImg: img(), lastImg: img() }))).toBe(true)
  })

  it('last-frame mode reads the single loaded image', () => {
    expect(hasRequiredImages(w({ frameMode: 'last', firstImg: img() }))).toBe(true)
    expect(hasRequiredImages(w({ frameMode: 'last' }))).toBe(false)
  })

  it('reference mode needs at least one reference', () => {
    expect(hasRequiredImages(w({ frameMode: 'ref' }))).toBe(false)
    expect(hasRequiredImages(w({ frameMode: 'ref', refImages: [img()] }))).toBe(true)
  })

  it('returns a real boolean, never a truthy image object', () => {
    expect(hasRequiredImages(w({ frameMode: 'firstlast', firstImg: img(), lastImg: img() }))).toBe(true)
  })
})

describe('canGenerate', () => {
  const w = (over) => ({ targetType: 'video', frameMode: 'single', scene: '', refImages: [], ...over })

  it('a typed scene is enough on its own', () => {
    expect(canGenerate(w({ scene: 'a woman at a window' }))).toBe(true)
  })

  it('an image alone is enough — the writer proposes the scene', () => {
    expect(canGenerate(w({ firstImg: img() }))).toBe(true)
  })

  it('needs one or the other', () => {
    expect(canGenerate(w())).toBe(false)
    expect(canGenerate(w({ scene: '   ' }))).toBe(false)
  })

  it('an image-first mode ignores the scene and demands its frames', () => {
    expect(canGenerate(w({ frameMode: 'firstlast', scene: 'plenty of words' }))).toBe(false)
    expect(canGenerate(w({ frameMode: 'firstlast', firstImg: img(), lastImg: img() }))).toBe(true)
    expect(canGenerate(w({ frameMode: 'ref', scene: 'plenty of words' }))).toBe(false)
  })

  it('an image target with a stale image-first frameMode still generates from a scene', () => {
    expect(canGenerate(w({ targetType: 'image', frameMode: 'firstlast', scene: 'a room' }))).toBe(true)
  })
})

describe('isProposeMode', () => {
  const w = (over) => ({ targetType: 'video', frameMode: 'single', scene: '', refImages: [], ...over })

  it('is on when there are images but no typed scene', () => {
    expect(isProposeMode(w({ firstImg: img() }))).toBe(true)
  })

  it('is off as soon as a scene is typed', () => {
    expect(isProposeMode(w({ firstImg: img(), scene: 'she turns' }))).toBe(false)
  })

  it('is off with neither', () => {
    expect(isProposeMode(w())).toBe(false)
  })

  it('treats whitespace as no scene', () => {
    expect(isProposeMode(w({ firstImg: img(), scene: '  \n ' }))).toBe(true)
  })
})

// A single-image snapshot's caption is that image's description; restore and a
// queued run both go through snapshotToWorkspace, so attaching it here is what
// lets captionImages() skip the vision call for both.
describe('snapshotToWorkspace — reusing the saved description for a single image', () => {
  const snapOf = (over) => ({ ...buildSnapshot(fluxWorkspace(), meta), ...over })

  it('attaches the snapshot caption to the loaded image (trimmed)', () => {
    const back = snapshotToWorkspace(snapOf({ frameMode: 'single', caption: '  A red fox in snow.  ' }), { newId })
    expect(back.firstImg.captions).toEqual({ general: 'A red fox in snow.' })
  })

  it('attaches nothing when there is no caption, or no image to attach it to', () => {
    expect(snapshotToWorkspace(snapOf({ frameMode: 'single', caption: null }), { newId }).firstImg.captions).toBeUndefined()
    expect(snapshotToWorkspace({ frameMode: 'single', caption: 'A fox.' }, { newId }).firstImg).toBeNull()
  })

  it('never attaches a multi-frame or reference-mode caption to one image', () => {
    for (const frameMode of ['firstlast', 'firstmidlast', 'ref']) {
      expect(snapshotToWorkspace(snapOf({ frameMode, caption: 'FIRST FRAME: … LAST FRAME: …' }), { newId }).firstImg.captions).toBeUndefined()
    }
  })

  it('is read from the snapshot each time — imgToSnap never persists it onto the image record', () => {
    expect(imgToSnap({ ...img(), caption: 'A fox.', captions: { general: 'A fox.' } })).not.toHaveProperty('captions')
    expect(imgToSnap({ ...img(), caption: 'A fox.' })).not.toHaveProperty('caption')
  })
})

// The reuse-the-saved-description path is gated on targetType === 'image', not
// on a target id — this pins that every still-image workflow really takes it.
describe('description reuse covers every still-image target', () => {
  const IMAGE_TARGETS = ['flux', 'flux2klein', 'krea2turbo', 'zimage', 'grokimage', 'sdxl', 'threed']
  for (const id of IMAGE_TARGETS) {
    it(`${id}: image-type target; restore/queue attach the saved description to its one image`, () => {
      expect(TARGETS[id].type).toBe('image')
      const w = { ...fluxWorkspace(), target: id, targetType: TARGETS[id].type, show: TARGETS[id].show }
      expect(hasRequiredImages(w)).toBe(true)
      const snap = { ...buildSnapshot(w, meta), caption: 'A knight in dented plate armor, sword raised.' }
      const back = snapshotToWorkspace(snap, { newId })
      expect(back.firstImg.captions.general).toBe('A knight in dented plate armor, sword raised.')
    })
  }
})

describe('image role in snapshots', () => {
  it('imgToSnap / imgFromSnap keep the role, and omit it when there is none', () => {
    expect(imgFromSnap(imgToSnap({ ...img(), role: 'pose_composition' })).role).toBe('pose_composition')
    expect(imgToSnap(img())).not.toHaveProperty('role')
    expect(imgFromSnap(imgToSnap(img()))).not.toHaveProperty('role')
  })

  it('restore files the entry caption under the role the entry ran the image with', () => {
    const w = { ...fluxWorkspace(), firstImg: { ...img('in.jpg'), role: 'pose_composition' } }
    const snap = { ...buildSnapshot(w, meta), caption: 'Stands, arms crossed.' }
    const back = snapshotToWorkspace(snap, { newId })
    expect(back.firstImg.role).toBe('pose_composition')
    expect(back.firstImg.captions).toEqual({ pose_composition: 'Stands, arms crossed.' })
  })
})

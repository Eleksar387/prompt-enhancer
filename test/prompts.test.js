// GOLDEN MASTERS for everything the app sends to a model.
//
// These exist for one reason: the refactor stages that follow move prompt
// assembly around (per-target behaviour into the TARGETS table, the two drifted
// user-message builders into one, the Scriptwriter's message builders out into
// pure modules). Every one of those is supposed to be behaviour-preserving, and
// this file is what proves it.
//
// So: a failure here means a refactor changed what a model receives. Read the
// diff and fix the code. Do NOT run `vitest -u` to make it pass — that erases
// the only evidence that something changed.
//
// Two levels of detail, on purpose:
//   * System prompts are static string literals; what can break is WHICH one a
//     target/frameMode resolves to. So they are fingerprinted (length + sha256 +
//     opening words), which catches a wrong selection or an edited prompt while
//     keeping this file's snapshot readable rather than 200 KB of prose.
//   * User messages are ASSEMBLED BY CODE, so they are snapshotted in full —
//     every byte, including whitespace, because the whitespace is part of what
//     the model sees.

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  TARGETS, systemPromptFor, PROMPT_LENGTH_INJECT, SPOKEN_LANGUAGES,
  spokenLanguageDirective, MINIMAX_H3_RESOLUTIONS,
  aspectParts, aspectSceneHint, aspectFramingHint,
  caps as targetCaps, targetsWithCap,
} from '../src/constants.js'
import {
  buildStylePart, buildAdaptUserText, buildWriterUserText, foldCaption, ADAPT_TARGETS,
  audioFieldsPart, ratioLinePart, extractRefImageCaption,
} from '../src/adapt.js'
import { loraInstruction } from '../src/loras.js'

const fingerprint = (s) => {
  if (typeof s !== 'string') return String(s)
  return `${s.length} chars · sha256:${createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)} · ${JSON.stringify(s.slice(0, 80))}`
}

// Every frameMode the UI can put a target into. systemPromptFor only varies by
// it for the two LTX variants (via buildSystem), but running the full cross
// product is what would catch a target accidentally becoming mode-sensitive.
const FRAME_MODES = ['single', 'last', 'firstlast', 'firstmidlast', 'ref']

const LORAS = [
  { id: 'c', name: 'Anna', trigger: 'ohwx woman', kind: 'character', note: '' },
  { id: 's', name: 'MJ',   trigger: 'aidmaMJ6.1', kind: 'style',     note: '' },
]

describe('system prompt selection', () => {
  it('resolves one prompt per target × frameMode', () => {
    const out = {}
    for (const id of Object.keys(TARGETS)) {
      for (const mode of FRAME_MODES) {
        out[`${id} · ${mode}`] = fingerprint(systemPromptFor(TARGETS[id], mode))
      }
    }
    expect(out).toMatchSnapshot()
  })

  it('keeps the target table shape', () => {
    // Locks the whole table: a typo'd `show` key silently hides a control, and a
    // typo'd `caps` key silently turns a capability off — which is now how the app
    // decides what each target can do, so it is load-bearing.
    const out = {}
    for (const [id, t] of Object.entries(TARGETS)) {
      out[id] = {
        label: t.label, type: t.type, show: t.show, caps: t.caps,
        hasSystem: !!t.system, hasBuildSystem: !!t.buildSystem,
        visionPrompt: t.visionPrompt ? fingerprint(t.visionPrompt) : null,
        resolutions: (t.resolutions || []).map(r => r.id),
        durations: (t.durations || []).map(d => d.value ?? d.label),
        frameModeOptions: (t.frameModeOptions || []).map(f => f.id),
        defaultFrameMode: t.defaultFrameMode ?? null,
        short: t.short ?? null, slug: t.slug ?? null,
        clipNoun: t.clipNoun ?? null, clipShort: t.clipShort ?? null,
        clipLabel: t.clipLabel ?? null,
        clipSystem: t.clipSystem ? fingerprint(t.clipSystem) : null,
        defaultRefRatio: t.defaultRefRatio ?? null,
        loraInject: t.loraInject ?? null,
      }
    }
    expect(out).toMatchSnapshot()
  })

  it('exposes capabilities by id and by object, and never throws', () => {
    expect(targetCaps('minimax_h3')).toBe(TARGETS.minimax_h3.caps)
    expect(targetCaps(TARGETS.minimax_h3)).toBe(TARGETS.minimax_h3.caps)
    expect(targetCaps('no-such-target')).toEqual({})
    expect(targetCaps(undefined)).toEqual({})
    expect(targetCaps(null)).toEqual({})
  })

  it('lists targets by capability instead of by a hard-coded set', () => {
    const ids = (cap) => targetsWithCap(cap).map(t => t.id)
    expect(ids('clipTarget')).toEqual(['ltx', 'minimax_h3'])
    // The Scriptwriter's frame-still picker offers exactly these. Krea 2 and 3D Print
    // are image targets but are deliberately not offered there, matching the list
    // that has always been shown.
    expect(ids('frameTarget')).toEqual(['flux', 'flux2klein', 'zimage', 'sdxl'])
    expect(ids('loras')).not.toContain('dramabox')
    expect(ids('refImages')).toEqual(['minimax_h3'])
    expect(ids('nonsense')).toEqual([])
  })

  it('lists the adapt destinations', () => {
    expect(ADAPT_TARGETS).toMatchSnapshot()
  })
})

describe('buildStylePart — the shared user-message suffix', () => {
  // One base fixture, then one knob turned per case, so a diff points at the
  // knob that broke rather than at a wall of text.
  const base = {
    style: 'dramatic', creativity: 'balanced', targetType: 'video',
    showDialogue: true, dialogue: 'Wir müssen sofort gehen.', delivery: 'urgent whisper',
    negative: 'text overlays, watermarks', forceNonImageWording: false,
    spokenLang: null, loras: null, targetId: 'ltx',
  }
  const cases = {
    'base · video · no lang · no loras': base,
    'style auto (emits nothing)': { ...base, style: 'auto' },
    'creativity faithful · video': { ...base, creativity: 'faithful' },
    'creativity loose · video': { ...base, creativity: 'loose' },
    'creativity faithful · image': { ...base, creativity: 'faithful', targetType: 'image', targetId: 'flux' },
    'creativity loose · image': { ...base, creativity: 'loose', targetType: 'image', targetId: 'flux' },
    'creativity faithful · text (dramabox)': { ...base, creativity: 'faithful', targetType: 'text', targetId: 'dramabox' },
    'creativity faithful · forceNonImageWording': { ...base, creativity: 'faithful', targetType: 'image', forceNonImageWording: true },
    'no dialogue': { ...base, dialogue: '', delivery: '' },
    'dialogue but showDialogue false': { ...base, showDialogue: false },
    'dialogue without delivery': { ...base, delivery: '' },
    'no negative': { ...base, negative: '' },
    'spokenLang de': { ...base, spokenLang: 'de' },
    'spokenLang en': { ...base, spokenLang: 'en' },
    'spokenLang fr': { ...base, spokenLang: 'fr' },
    'spokenLang de · text target (whole prompt)': { ...base, spokenLang: 'de', targetType: 'text', targetId: 'dramabox' },
    'loras · ltx': { ...base, loras: LORAS },
    'loras · h3 (field-scoped rules)': { ...base, loras: LORAS, targetId: 'minimax_h3' },
    'loras · dramabox (excluded)': { ...base, loras: LORAS, targetId: 'dramabox', targetType: 'text' },
    'loras · character bound to a name': { ...base, loras: [{ ...LORAS[0], subject: 'ANNA' }, LORAS[1]], targetId: 'minimax_h3' },
    'everything at once': { ...base, spokenLang: 'fr', loras: LORAS, targetId: 'minimax_h3', creativity: 'loose' },
  }
  for (const [name, args] of Object.entries(cases)) {
    it(name, () => { expect(buildStylePart(args)).toMatchSnapshot() })
  }
})

describe('buildWriterUserText — the generate-mode user message', () => {
  // This path had no golden master until it was lifted out of runWriter(), which is
  // why it is covered exhaustively here: every target type × every frame mode ×
  // with and without a vision caption × with and without a typed scene. These
  // snapshots are the contract for unifying it with the adapt-mode builder.
  const CAPTION = 'A woman in a red coat stands at a rain-streaked window.'
  const base = {
    target: 'ltx', targetType: 'video', frameMode: 'single',
    scene: 'She turns away from the window.', duration: '8 seconds',
    frameDescription: null, hasImg: false,
    ratio: MINIMAX_H3_RESOLUTIONS[1], soundscape: 'rain on glass', music: 'none',
    stylePart: '\n\n[STYLE PART]', lengthPart: '\n\n[LENGTH PART]',
  }
  const h3 = { ...base, target: 'minimax_h3' }

  const cases = {
    // MiniMax H3 — the structured target, one case per MODE it emits
    'h3 T2VA (text only)': h3,
    'h3 T2VA · no scene': { ...h3, scene: '' },
    'h3 I2VA (image, single)': { ...h3, hasImg: true, frameDescription: CAPTION },
    'h3 I2VA · no scene': { ...h3, hasImg: true, frameDescription: CAPTION, scene: '' },
    'h3 I2VA · image but vision failed': { ...h3, hasImg: true, frameDescription: null },
    'h3 L2VA (last frame)': { ...h3, frameMode: 'last', hasImg: true, frameDescription: CAPTION },
    'h3 L2VA · no scene': { ...h3, frameMode: 'last', hasImg: true, frameDescription: CAPTION, scene: '' },
    'h3 FL2VA (first→last)': { ...h3, frameMode: 'firstlast', hasImg: true, frameDescription: CAPTION },
    'h3 FL2VA · no scene': { ...h3, frameMode: 'firstlast', hasImg: true, frameDescription: CAPTION, scene: '' },
    'h3 Ref2VA (references)': { ...h3, frameMode: 'ref', hasImg: true, frameDescription: CAPTION },
    'h3 Ref2VA · no scene': { ...h3, frameMode: 'ref', hasImg: true, frameDescription: CAPTION, scene: '' },
    'h3 · no soundscape or music': { ...h3, soundscape: '', music: '' },

    // image targets
    'image (flux) · scene only': { ...base, target: 'flux', targetType: 'image' },
    'image · with reference caption': { ...base, target: 'flux', targetType: 'image', hasImg: true, frameDescription: CAPTION },
    'image · caption, no scene': { ...base, target: 'flux', targetType: 'image', hasImg: true, frameDescription: CAPTION, scene: '' },
    'image · nothing at all': { ...base, target: 'flux', targetType: 'image', scene: '' },

    // text target (DramaBox)
    'text (dramabox)': { ...base, target: 'dramabox', targetType: 'text' },
    'text · empty scene': { ...base, target: 'dramabox', targetType: 'text', scene: '' },

    // video frame modes
    'video single · text only': base,
    'video single · with frame': { ...base, hasImg: true, frameDescription: CAPTION },
    'video single · frame, no scene': { ...base, hasImg: true, frameDescription: CAPTION, scene: '' },
    'video single · no scene, no frame': { ...base, scene: '' },
    'video firstlast': { ...base, frameMode: 'firstlast', hasImg: true, frameDescription: CAPTION },
    'video firstlast · no scene': { ...base, frameMode: 'firstlast', hasImg: true, frameDescription: CAPTION, scene: '' },
    'video firstmidlast': { ...base, frameMode: 'firstmidlast', hasImg: true, frameDescription: CAPTION },
    'video firstmidlast · no scene': { ...base, frameMode: 'firstmidlast', hasImg: true, frameDescription: CAPTION, scene: '' },
    'video last': { ...base, frameMode: 'last', hasImg: true, frameDescription: CAPTION },
    'video ltx_guide': { ...base, target: 'ltx_guide' },
    'video kling': { ...base, target: 'kling' },
  }
  for (const [name, args] of Object.entries(cases)) {
    it(name, () => { expect(buildWriterUserText(args)).toMatchSnapshot() })
  }

  it('image target with caption + scene: typed text is the brief, reference is supporting details after it', () => {
    const out = buildWriterUserText({ ...base, target: 'flux2klein', targetType: 'image', hasImg: true, frameDescription: CAPTION })
    const briefAt = out.indexOf('Image description (this is the brief')
    const refAt = out.indexOf('Reference image — supporting details only')
    expect(briefAt).toBe(0)
    expect(refAt).toBeGreaterThan(briefAt)
    expect(out.indexOf(base.scene)).toBeLessThan(refAt)
    expect(out.indexOf(CAPTION)).toBeGreaterThan(refAt)
    expect(out).not.toContain('BASE')
  })

  describe('still-image reference role', () => {
    const img = { ...base, target: 'flux2klein', targetType: 'image', hasImg: true, frameDescription: 'Stands, weight on the left leg, arms crossed; full-length, eye-level.' }
    it('pose role: the reference is limited to the pose and the message says not to describe the rest', () => {
      const out = buildWriterUserText({ ...img, refRole: 'pose_composition' })
      expect(out.indexOf('Image description (this is the brief')).toBe(0)
      expect(out).toContain('ROLE: Pose / Composition')
      expect(out).toContain('ONLY the body pose and the framing only')
      expect(out).toContain('do NOT describe anything else from the reference image')
      expect(out).toContain(img.frameDescription)
    })
    it('every non-General role names its own contribution', () => {
      for (const [role, phrase] of [['wardrobe', 'garments only'], ['environment', 'location/setting'], ['style', 'palette, light quality'], ['subject_identity', 'appearance'], ['product_object', 'geometry']]) {
        expect(buildWriterUserText({ ...img, refRole: role })).toContain(phrase)
      }
    })
    it('General (or no role) keeps the plain supporting-details wording', () => {
      const plain = buildWriterUserText(img)
      expect(buildWriterUserText({ ...img, refRole: 'general' })).toBe(plain)
      expect(plain).toContain('Reference image — supporting details only')
      expect(plain).not.toContain('ROLE:')
    })
    it('a role with no typed description asks for an invented scene, using the reference only for that aspect', () => {
      const out = buildWriterUserText({ ...img, scene: '', refRole: 'pose_composition' })
      expect(out).toContain('No image description provided — invent a fitting subject and setting')
      expect(out.indexOf('Reference image — ROLE')).toBe(0)
    })
    it('a role has no effect without a reference description', () => {
      const out = buildWriterUserText({ ...img, frameDescription: null, hasImg: false, refRole: 'pose_composition' })
      expect(out).not.toContain('ROLE:')
    })
  })

  it('puts the ratio line in only when the ratio is actually chosen', () => {
    // T2VA and Ref2VA name a concrete ratio; every image-driven mode inherits it.
    expect(buildWriterUserText(h3)).toContain(MINIMAX_H3_RESOLUTIONS[1].label)
    expect(buildWriterUserText({ ...h3, frameMode: 'ref', hasImg: true })).toContain(MINIMAX_H3_RESOLUTIONS[1].label)
    expect(buildWriterUserText({ ...h3, hasImg: true, frameDescription: CAPTION }))
      .toContain('derived from the input image(s)')
  })
})

describe('buildAdaptUserText — the adapt-panel user message', () => {
  const CAPTION = 'A woman in a red coat stands at a rain-streaked window.\nThe room behind her is unlit.'
  const base = {
    destTarget: 'ltx', scene: 'She turns away from the window.',
    foldedCaption: CAPTION, sourceLabel: 'MiniMax H3 · Video',
    duration: '8 seconds', aspectRatio: null,
    stylePart: '\n\n[STYLE PART]', lengthPart: '\n\n[LENGTH PART]',
    audio: null, originalPrompt: 'A cinematic shot of a woman at a window.',
  }
  const h3Ratio = MINIMAX_H3_RESOLUTIONS[0]
  const cases = {
    'ltx · caption + original': base,
    'ltx · caption, no original': { ...base, originalPrompt: '' },
    'ltx · no caption (text-only source)': { ...base, foldedCaption: '' },
    'ltx · no caption, no scene': { ...base, foldedCaption: '', scene: '' },
    'ltx · caption, no scene': { ...base, scene: '' },
    'ltx_guide': { ...base, destTarget: 'ltx_guide' },
    'kling': { ...base, destTarget: 'kling' },
    'flux (image)': { ...base, destTarget: 'flux' },
    'flux · no caption': { ...base, destTarget: 'flux', foldedCaption: '' },
    'sdxl (image)': { ...base, destTarget: 'sdxl' },
    'threed (image)': { ...base, destTarget: 'threed' },
    'minimax_h3 · full': { ...base, destTarget: 'minimax_h3', aspectRatio: h3Ratio, audio: { soundscape: 'rain on glass', music: 'none' } },
    'minimax_h3 · no ratio, no audio': { ...base, destTarget: 'minimax_h3' },
    'minimax_h3 · no caption': { ...base, destTarget: 'minimax_h3', aspectRatio: h3Ratio, foldedCaption: '' },
    'minimax_h3 · no scene': { ...base, destTarget: 'minimax_h3', aspectRatio: h3Ratio, scene: '' },
  }
  for (const [name, args] of Object.entries(cases)) {
    it(name, () => { expect(buildAdaptUserText(args)).toMatchSnapshot() })
  }
})

describe('the two builders agree on the shared field blocks', () => {
  // The point of sharing audioFieldsPart / ratioLinePart: a generate run and an
  // adapt run must describe a target's own fields identically, or the same H3
  // prompt asked for two ways gets two different soundscape instructions. These
  // assertions are the enforcement that was missing when the text was written out
  // twice by hand.
  const soundscape = 'rain on glass'
  const music = 'a low cello drone'
  const ratio = MINIMAX_H3_RESOLUTIONS[1]

  const generated = buildWriterUserText({
    target: 'minimax_h3', targetType: 'video', frameMode: 'single',
    scene: 'she turns', duration: '8 seconds', hasImg: false,
    ratio, soundscape, music, stylePart: '', lengthPart: '',
  })
  const adapted = buildAdaptUserText({
    destTarget: 'minimax_h3', scene: 'she turns', duration: '8 seconds',
    aspectRatio: ratio, audio: { soundscape, music }, stylePart: '', lengthPart: '',
  })

  it('emits the same audio block', () => {
    expect(generated).toContain(audioFieldsPart(soundscape, music))
    expect(adapted).toContain(audioFieldsPart(soundscape, music))
  })

  it('emits the same audio fallbacks when nothing is specified', () => {
    const g = buildWriterUserText({
      target: 'minimax_h3', targetType: 'video', frameMode: 'single',
      duration: '8 seconds', ratio, soundscape: '', music: '', stylePart: '', lengthPart: '',
    })
    const a = buildAdaptUserText({
      destTarget: 'minimax_h3', duration: '8 seconds', aspectRatio: ratio, audio: null,
      stylePart: '', lengthPart: '',
    })
    const fallback = audioFieldsPart('', '')
    expect(fallback).toContain('invent restrained ambience')
    expect(fallback).toContain('use N/A')
    expect(g).toContain(fallback)
    expect(a).toContain(fallback)
  })

  it('emits the same aspect-ratio line', () => {
    expect(generated).toContain(ratioLinePart(ratio))
    expect(adapted).toContain(ratioLinePart(ratio))
  })

  it('omits the ratio line entirely when no ratio is given', () => {
    expect(ratioLinePart(null)).toBe('')
  })
})

describe('foldCaption — caption scaffolding stripped per source frame mode', () => {
  const SINGLE = 'A woman in a red coat at a window. Overcast daylight.'
  const FIRSTLAST = [
    'FIRST FRAME: She faces the window, hands at her sides.',
    'LAST FRAME: She has turned to face the room.',
    'CHANGE: A quarter turn of the body; the light shifts off her face.',
  ].join('\n')
  const FIRSTMIDLAST = [
    'FIRST FRAME: She faces the window.',
    'MID FRAME: Mid-turn, weight on the back foot.',
    'LAST FRAME: She faces the room.',
    'FIRST→MID CHANGE: The turn begins.',
    'MID→LAST CHANGE: The turn completes.',
  ].join('\n')
  const REF = [
    'Image 1 — role: character, preservation: strong: A woman in her thirties, dark hair, red wool coat.',
    '  Requested use of this reference: keep the coat exactly.',
    'Image 2 — role: location, preservation: loose: An unlit room with a tall sash window.',
    'Audio 1 — voice-timbre reference: a low, breathy alto.',
  ].join('\n')
  // H3's audio input takes up to two voice-timbre samples — folding must not
  // emit one "Voice:" line per Audio N (that would read as two separate notes
  // for what's really one instruction).
  const REF_TWO_AUDIO = REF + '\nAudio 2 — voice-timbre reference: a higher, clipped tenor.'

  const cases = {
    'single': [SINGLE, 'single', {}],
    'firstlast': [FIRSTLAST, 'firstlast', {}],
    'firstmidlast': [FIRSTMIDLAST, 'firstmidlast', {}],
    'ref · no dialogue (audio line dropped)': [REF, 'ref', {}],
    'ref · with dialogue (voice line kept)': [REF, 'ref', { hasDialogue: true }],
    'ref · two audio references, with dialogue (deduped to one voice line)': [REF_TWO_AUDIO, 'ref', { hasDialogue: true }],
    'empty': ['', 'single', {}],
  }
  for (const [name, [caption, mode, opts]] of Object.entries(cases)) {
    it(name, () => { expect(foldCaption(caption, mode, opts)).toMatchSnapshot() })
  }
})

describe('extractRefImageCaption — legacy per-reference read fallback for the History gallery', () => {
  // The exact shape captionImages() (src/App.jsx) builds for ref mode: one
  // "Image N — role: X, preservation: Y (marker): <caption>" line per
  // reference, an indented note continuation on some, and Audio N lines after.
  // READ-ONLY now — saving a reference image's caption always writes
  // directly to refImages[i].caption (App.jsx's saveRefImageCaption) instead
  // of splicing back into this block; this function only supplies the
  // starting text for an image that hasn't been individually saved yet.
  const BLOCK = [
    'Image 1 — role: Subject / Identity, preservation: Exact (fully_preserved): A woman in her thirties, dark hair.',
    '   Requested use of this reference: keep the face exact.',
    'Image 2 — role: Wardrobe / Clothing, preservation: Strong (partially_preserved): A red wool coat, double-breasted.',
    'Image 3 — role: Location, preservation: Guide (attribute_transfer): An unlit room with a tall sash window.',
    'Audio 1 — voice-timbre reference (marker: reference): file "voice.mp3". Reference ONLY the timbre.',
  ].join('\n')

  it('extracts only the named image\'s own caption text', () => {
    expect(extractRefImageCaption(BLOCK, 1)).toBe('A woman in her thirties, dark hair.')
    expect(extractRefImageCaption(BLOCK, 2)).toBe('A red wool coat, double-breasted.')
    expect(extractRefImageCaption(BLOCK, 3)).toBe('An unlit room with a tall sash window.')
  })

  it('returns null for an image index that has no line in the block', () => {
    expect(extractRefImageCaption(BLOCK, 4)).toBeNull()
    expect(extractRefImageCaption('', 1)).toBeNull()
    expect(extractRefImageCaption('plain prose, not a ref block', 1)).toBeNull()
  })
})

describe('spokenLanguageDirective', () => {
  it('one directive per language × wholePrompt', () => {
    const out = {}
    for (const l of SPOKEN_LANGUAGES) {
      out[`${l.id} · suffix`] = spokenLanguageDirective(l.id)
      out[`${l.id} · wholePrompt`] = spokenLanguageDirective(l.id, { wholePrompt: true })
    }
    expect(out).toMatchSnapshot()
  })

  it('falls back to the first language on an unknown id', () => {
    expect(spokenLanguageDirective('xx')).toBe(spokenLanguageDirective(SPOKEN_LANGUAGES[0].id))
  })
})

describe('loraInstruction', () => {
  it('one instruction per target shape', () => {
    expect({
      ltx: loraInstruction(LORAS, 'ltx'),
      h3: loraInstruction(LORAS, 'minimax_h3'),
      sdxl: loraInstruction(LORAS, 'sdxl'),
      'h3 · character bound': loraInstruction([{ ...LORAS[0], subject: 'ANNA' }], 'minimax_h3'),
      'style only': loraInstruction([LORAS[1]], 'flux'),
    }).toMatchSnapshot()
  })
})

describe('length injection and aspect hints', () => {
  it('PROMPT_LENGTH_INJECT', () => { expect(PROMPT_LENGTH_INJECT).toMatchSnapshot() })

  it('aspect helpers per H3 resolution', () => {
    const out = {}
    for (const r of MINIMAX_H3_RESOLUTIONS) {
      out[r.id] = {
        parts: aspectParts(r),
        scene: aspectSceneHint(r),
        framing: aspectFramingHint(r),
      }
    }
    expect(out).toMatchSnapshot()
  })
})

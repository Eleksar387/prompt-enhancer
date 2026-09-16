// Manual mode's deterministic, zero-AI H3 prompt assembly — direct
// input -> exact output, the same style as test/workspace.test.js. The point
// of these tests is to pin down the exact schema shapes byte-for-byte, since
// nothing here is AI-checked at runtime the way the writer-LLM path is.

import { describe, it, expect } from 'vitest'
import {
  parseShots, parseShotLabelUsage, parseSubjectSpeakers, findMalformedTags,
  numberSubjects, bindAudioToSubjects, retentionReason, formatSeconds,
  assembleT2VA, assembleI2VA, assembleL2VA, assembleFL2VA, assembleRef2VA,
  assembleManualH3, validateManualH3, buildManualH3, buildManualSeed,
} from '../src/manualH3.js'

const ref = (over = {}) => ({ hash: 'h1', role: 'subject_identity', preserve: 'exact', note: '', ...over })

describe('parseShots', () => {
  it('finds every [Shot N] marker and its span', () => {
    const text = '[Shot 1] opens. [Shot 2] cuts. end.'
    const shots = parseShots(text)
    expect(shots).toHaveLength(2)
    expect(shots[0]).toMatchObject({ n: 1, start: 0 })
    expect(shots[1]).toMatchObject({ n: 2 })
    expect(shots[1].end).toBe(text.length)
  })

  it('handles two-digit shot numbers', () => {
    expect(parseShots('[Shot 10] x [Shot 11] y').map(s => s.n)).toEqual([10, 11])
  })

  it('returns nothing for text with no markers', () => {
    expect(parseShots('no shots here')).toEqual([])
  })
})

describe('parseShotLabelUsage', () => {
  it('maps a label to the shots whose span contains it', () => {
    const text = '[Shot 1] <Subject 1> stands. [Shot 2] <Subject 1> speaks. [Shot 3] <Picture 2> only here.'
    const { shotNumbers, usage } = parseShotLabelUsage(text)
    expect(shotNumbers).toEqual([1, 2, 3])
    expect(usage['Subject 1']).toEqual([1, 2])
    expect(usage['Picture 2']).toEqual([3])
  })

  it('buckets an occurrence before the first [Shot N] under shot 0', () => {
    const { usage } = parseShotLabelUsage('<Subject 1> intro. [Shot 1] then <Subject 1> again.')
    expect(usage['Subject 1']).toEqual([0, 1])
  })

  it('is empty for text with no tags at all', () => {
    expect(parseShotLabelUsage('[Shot 1] plain prose.').usage).toEqual({})
  })
})

describe('parseSubjectSpeakers', () => {
  it('reads the first speaker-id binding per subject', () => {
    expect(parseSubjectSpeakers('<Subject 2> (S1) says hi. Later <Subject 2> (S2) — ignored, first wins.'))
      .toEqual({ 2: 'S1' })
  })

  it('returns an empty object with no bindings', () => {
    expect(parseSubjectSpeakers('<Subject 1> stands there.')).toEqual({})
  })
})

describe('findMalformedTags', () => {
  it('flags a lowercase/spaced shot marker', () => {
    const found = findMalformedTags('[shot 2] happens')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ found: '[shot 2]', suggestion: '[Shot 2]' })
  })

  it('flags a missing-space subject tag', () => {
    const found = findMalformedTags('<Subject1> stands')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ found: '<Subject1>', suggestion: '<Subject 1>' })
  })

  it('does not flag correctly formed tags', () => {
    expect(findMalformedTags('[Shot 1] <Subject 1> <Picture 2>')).toEqual([])
  })
})

describe('numberSubjects', () => {
  it('numbers Pictures by list position and Subjects only across non-pose refs', () => {
    const entries = numberSubjects([
      ref({ hash: 'a', role: 'subject_identity' }),
      ref({ hash: 'b', role: 'pose_composition' }),
      ref({ hash: 'c', role: 'wardrobe' }),
    ])
    expect(entries.map(e => [e.pictureN, e.subjectM])).toEqual([[1, 1], [2, null], [3, 2]])
  })
})

describe('bindAudioToSubjects', () => {
  it('binds by explicit subjectRef hash, not position', () => {
    const refImages = [ref({ hash: 'a' }), ref({ hash: 'b', role: 'wardrobe' })]
    const refAudios = [{ subjectRef: 'b' }, { subjectRef: 'a' }]
    expect(bindAudioToSubjects(refImages, refAudios)).toEqual([
      { audioN: 1, subjectM: 2 },
      { audioN: 2, subjectM: 1 },
    ])
  })

  it('is null for an unassigned or unknown subjectRef', () => {
    const refImages = [ref({ hash: 'a' })]
    expect(bindAudioToSubjects(refImages, [{ subjectRef: null }])).toEqual([null])
    expect(bindAudioToSubjects(refImages, [{ subjectRef: 'nope' }])).toEqual([null])
  })

  it('is null when the matched reference is pose_composition (no subject)', () => {
    const refImages = [ref({ hash: 'a', role: 'pose_composition' })]
    expect(bindAudioToSubjects(refImages, [{ subjectRef: 'a' }])).toEqual([null])
  })
})

describe('retentionReason / formatSeconds', () => {
  it('reuses MINIMAX_H3_PRESERVE_OPTIONS hints', () => {
    expect(retentionReason('exact')).toMatch(/no deviation/i)
    expect(retentionReason('inspiration')).toMatch(/weak reference/i)
  })

  it('formats a duration string to two decimals', () => {
    expect(formatSeconds('8 seconds')).toBe('8.00')
    expect(formatSeconds('12 seconds')).toBe('12.00')
    expect(formatSeconds(undefined)).toBe('0.00')
  })
})

describe('assembleT2VA / I2VA / L2VA / FL2VA', () => {
  const base = { storyText: '[Shot 1] Cinematic, live-action, a woman turns.', soundscape: 'quiet room tone', music: '' }

  it('T2VA: three inline fields, music defaults to N/A', () => {
    expect(assembleT2VA(base)).toBe(
      'integrated_multimodal_description: [Shot 1] Cinematic, live-action, a woman turns.\n\n'
      + 'overall_soundscape: quiet room tone\n\n'
      + 'non_diegetic_music: N/A'
    )
  })

  it('"none" and "silence" both collapse music to N/A; a real value passes through', () => {
    expect(assembleT2VA({ ...base, music: 'none' })).toContain('non_diegetic_music: N/A')
    expect(assembleT2VA({ ...base, music: 'silence' })).toContain('non_diegetic_music: N/A')
    expect(assembleT2VA({ ...base, music: 'a slow piano theme' })).toContain('non_diegetic_music: a slow piano theme')
  })

  it('I2VA: bracketed alignment preamble naming the first shot', () => {
    const out = assembleI2VA(base)
    expect(out.split('\n\n')[0]).toBe('For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.')
    expect(out).toContain('integrated_multimodal_description:')
  })

  it('L2VA: bracketed alignment naming the final shot and S.SS duration', () => {
    const text = '[Shot 1] a. [Shot 2] b converges on the last frame.'
    const out = assembleL2VA({ storyText: text, soundscape: 'x', music: '', duration: '8 seconds' })
    expect(out.split('\n\n')[0]).toBe('How the reference pictures align with the target video — <Picture 1> (from [Shot 2]) aligns with the 8.00-second mark of the target video.')
  })

  it('FL2VA: the alignment line is byte-for-byte UNBRACKETED', () => {
    const out = assembleFL2VA({ storyText: base.storyText, soundscape: 'x', music: '', duration: '12 seconds' })
    expect(out.split('\n\n')[0]).toBe('How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 12.00-second mark of the target video.')
  })
})

describe('assembleRef2VA — the load-bearing worked example', () => {
  // (1) subject_identity, exact, noted. (2) pose_composition, guide, no note.
  // (3) wardrobe, strong, noted. Picture numbering 1,2,3; Subject numbering
  // skips the pose reference: 1,(skipped),2.
  const refImages = [
    ref({ hash: 'a', role: 'subject_identity', preserve: 'exact', note: 'her face and build' }),
    ref({ hash: 'b', role: 'pose_composition', preserve: 'guide', note: '' }),
    ref({ hash: 'c', role: 'wardrobe', preserve: 'strong', note: 'the red jacket' }),
  ]
  const storyText =
    '[Shot 1] Cinematic, live-action, <Subject 1> stands in a doorway, wearing <Subject 2>\'s jacket, '
    + 'framed by <Picture 2>\'s composition.\n'
    + 'At 00:02.000, the camera cuts to a close shot. [Shot 2] She steps forward.'

  it('emits subject_definitions in ref-list order with correct numbering per role', () => {
    const out = assembleRef2VA({ storyText, soundscape: 'ambient room tone', music: '', refImages, refAudios: [] })
    const block = out.split('\n\n')[0]
    const lines = block.replace('subject_definitions:\n', '').split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('<Subject 1> is the subject from <Picture 1>, preserving her face and build.')
    expect(lines[1]).toBe('<Picture 2> is a storyboard reference for [Shot 1], defining its viewpoint, subject placement, and shot order.')
    expect(lines[2]).toBe(
      '<Subject 2> is the wardrobe from <Picture 3>, scoped to the garment only — cut, fabric, color, pattern, and fit (the red jacket). '
      + 'The face, body, and identity of whoever is wearing it in that reference photo are NOT carried over; only the clothing transfers onto the video\'s actual subject.'
    )
  })

  it('emits retention_analysis in the SAME order, markers matching each ref\'s own preserve', () => {
    const out = assembleRef2VA({ storyText, soundscape: 'ambient room tone', music: '', refImages, refAudios: [] })
    const block = out.split('\n\n')[2]
    const lines = block.replace('retention_analysis:\n', '').split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('<Subject 1> (appears in [Shot 1]): fully_preserved - Fully preserve — no deviation')
    expect(lines[1]).toBe('<Picture 2> (storyboard reference for [Shot 1]): attribute_transfer - Transfer the requested attribute without copying unrelated content')
    expect(lines[2]).toBe('<Subject 2> (appears in [Shot 1]): partially_preserved - Preserve defining attributes; minor incidental variation allowed')
  })

  it('carries detailed_description verbatim and keeps all six labeled sections in order', () => {
    const out = assembleRef2VA({ storyText, soundscape: 'ambient room tone', music: '', refImages, refAudios: [] })
    const sections = out.split('\n\n').map(s => s.split(':')[0])
    expect(sections).toEqual(['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'])
    expect(out).toContain(`detailed_description:\n${storyText}`)
  })

  it('adds an Audio→Subject line and a matching retention line when audio is bound', () => {
    const refAudios = [{ subjectRef: 'a' }]
    const withSpeaker = storyText.replace('<Subject 1> stands', '<Subject 1> (S1) stands')
    const out = assembleRef2VA({ storyText: withSpeaker, soundscape: 'x', music: '', refImages, refAudios })
    expect(out).toContain('<Audio 1> is the voice-timbre reference for <Subject 1> (S1). Only its timbre, pitch and delivery are referenced; none of its original wording is carried across.')
    expect(out).toContain('<Audio 1>: reference - timbre, pitch and delivery only; wording is original.')
    expect(out).toContain('[reference generation + audio reference]')
  })

  it('marks a declared-but-unreferenced label instead of a shot list', () => {
    const onlyOne = [ref({ hash: 'a', role: 'subject_identity', preserve: 'exact', note: 'x' })]
    const out = assembleRef2VA({ storyText: '[Shot 1] plain prose, no tags at all.', soundscape: 'x', music: '', refImages: onlyOne, refAudios: [] })
    expect(out).toContain('<Subject 1> (not referenced in the text): fully_preserved -')
  })
})

describe('validateManualH3', () => {
  const okRef2VA = () => ({
    mode: 'Ref2VA',
    storyText: '[Shot 1] <Subject 1> (S1) says hi.',
    soundscape: 'quiet',
    refImages: [ref({ hash: 'a' })],
    refAudios: [],
  })

  it('passes a well-formed Ref2VA input', () => {
    expect(validateManualH3(okRef2VA())).toEqual({ errors: [], warnings: [] })
  })

  it('errors on missing [Shot N] markers, in every mode', () => {
    expect(validateManualH3({ mode: 'T2VA', storyText: 'no shots', soundscape: 'x' }).errors.length).toBeGreaterThan(0)
  })

  it('errors on a malformed tag', () => {
    const errs = validateManualH3({ ...okRef2VA(), storyText: '[shot 1] <Subject 1> (S1) says hi.' }).errors
    expect(errs.some(e => e.includes('[shot 1]'))).toBe(true)
  })

  it('errors on missing soundscape', () => {
    expect(validateManualH3({ ...okRef2VA(), soundscape: '' }).errors.some(e => /soundscape/i.test(e))).toBe(true)
  })

  it('errors on a tag referencing an undeclared reference', () => {
    const errs = validateManualH3({ ...okRef2VA(), storyText: '[Shot 1] <Subject 2> (S1) says hi.' }).errors
    expect(errs.some(e => e.includes('<Subject 2>'))).toBe(true)
  })

  it('explains the Subject-numbering-skips-Pose gap when a pose reference is present', () => {
    // 4 images, list position 2 is Pose/Composition — Subject numbering is
    // 1,(skipped),2,3, so "Image 4" is really <Subject 3>, not <Subject 4>.
    // This is exactly the reported confusion: the error should name the
    // actual cause, not just "not found".
    const refImages = [
      ref({ hash: 'a', role: 'subject_identity' }),
      ref({ hash: 'b', role: 'pose_composition' }),
      ref({ hash: 'c', role: 'wardrobe' }),
      ref({ hash: 'd', role: 'product_object' }),
    ]
    const errs = validateManualH3({
      mode: 'Ref2VA', storyText: '[Shot 1] <Subject 4> (S1) says hi.', soundscape: 'x', refImages, refAudios: [],
    }).errors
    const err = errs.find(e => e.includes('<Subject 4>'))
    expect(err).toMatch(/skip any Pose\/Composition reference/)
    expect(err).toMatch(/3 subject-bearing reference/)
  })

  it('errors when an audio has no assigned subject', () => {
    const errs = validateManualH3({ ...okRef2VA(), refAudios: [{ subjectRef: null }] }).errors
    expect(errs.some(e => /no assigned subject/.test(e))).toBe(true)
  })

  it('errors when an audio\'s bound subject never gets a speaker id', () => {
    const errs = validateManualH3({
      ...okRef2VA(), storyText: '[Shot 1] <Subject 1> says hi, no speaker id.',
      refAudios: [{ subjectRef: 'a' }],
    }).errors
    expect(errs.some(e => /speaker id/.test(e))).toBe(true)
  })

  it('warns (does not error) on a declared-but-unreferenced label', () => {
    const res = validateManualH3({ ...okRef2VA(), storyText: '[Shot 1] plain prose.' })
    expect(res.errors).toEqual([])
    expect(res.warnings.some(w => /never used/.test(w))).toBe(true)
  })
})

describe('assembleManualH3 dispatcher', () => {
  it('dispatches by MODE string', () => {
    expect(assembleManualH3('T2VA', { storyText: '[Shot 1] x', soundscape: 'x', music: '' })).toContain('integrated_multimodal_description:')
  })
  it('throws on an unknown mode', () => {
    expect(() => assembleManualH3('NOPE', {})).toThrow()
  })
})

describe('buildManualH3', () => {
  it('returns ok:false with no text when validation fails', () => {
    const res = buildManualH3({ mode: 'T2VA', storyText: '', soundscape: '', music: '', duration: '8 seconds', refImages: [], refAudios: [] })
    expect(res.ok).toBe(false)
    expect(res.text).toBeNull()
    expect(res.errors.length).toBeGreaterThan(0)
  })

  it('returns ok:true with assembled text when valid', () => {
    const res = buildManualH3({
      mode: 'T2VA', storyText: '[Shot 1] Cinematic, live-action, a woman turns.',
      soundscape: 'quiet', music: '', duration: '8 seconds', refImages: [], refAudios: [],
    })
    expect(res.ok).toBe(true)
    expect(res.text).toContain('integrated_multimodal_description:')
    expect(res.errors).toEqual([])
  })
})

describe('buildManualSeed', () => {
  it('falls back to the plain example with no non-pose references', () => {
    expect(buildManualSeed([])).toBe(
      '[Shot 1] Cinematic, live-action, a woman turns towards the door…\n'
      + 'At 00:03.500, the camera cuts to her, who says, [German] "Wir müssen gehen."\n'
      + '[Shot 2] …'
    )
    expect(buildManualSeed([ref({ hash: 'p', role: 'pose_composition' })])).toBe(buildManualSeed([]))
  })

  it('names every configured reference by its actual role — subject + wardrobe + location', () => {
    const refImages = [
      ref({ hash: 'a', role: 'subject_identity', preserve: 'exact', note: 'her face and build' }),
      ref({ hash: 'b', role: 'wardrobe', preserve: 'strong', note: 'the red jacket' }),
      ref({ hash: 'c', role: 'environment', preserve: 'guide', note: '' }),
    ]
    expect(buildManualSeed(refImages)).toBe(
      "[Shot 1] Cinematic, live-action, <Subject 1> stands by the window, wearing <Subject 2>'s jacket, "
      + 'framed against the backdrop from <Picture 3>…\n'
      + 'At 00:03.500, the camera cuts to <Subject 1> (S1), who says, [German] "Wir müssen gehen."\n'
      + '[Shot 2] …'
    )
  })

  it('never mentions a pose/composition reference by number', () => {
    const seed = buildManualSeed([
      ref({ hash: 'a', role: 'subject_identity' }),
      ref({ hash: 'b', role: 'pose_composition' }),
    ])
    expect(seed).not.toContain('Picture 2')
    expect(seed).toContain('<Subject 1> stands by the window')
  })

  it('a product/object reference becomes the main subject when no identity ref exists', () => {
    const seed = buildManualSeed([ref({ hash: 'a', role: 'product_object' })])
    expect(seed).toContain('<Subject 1> sits on the table')
  })

  it('a style-only reference adds the opener over the plain fallback subject', () => {
    const seed = buildManualSeed([ref({ hash: 'a', role: 'style' })])
    expect(seed).toContain('In a look drawn from <Picture 1>, a woman stands by the window')
    expect(seed).toContain('cuts to her, who says')
  })

  it('gives every audio-bound subject its own speaker line and shot — the reported bug', () => {
    // Two references, each with a voice reference explicitly bound to it
    // (the "Voice" select on the image card) — this is exactly the shape
    // that previously produced "Audio N is bound to <Subject N>, but your
    // text never gives that subject a speaker id" on the very first,
    // unedited seed.
    const refImages = [
      ref({ hash: 'a', role: 'subject_identity', note: 'her face and build' }),
      ref({ hash: 'b', role: 'wardrobe', note: 'his jacket' }),
    ]
    const refAudios = [{ id: 'audio1', subjectRef: 'a' }, { id: 'audio2', subjectRef: 'b' }]
    const seed = buildManualSeed(refImages, refAudios)
    expect(seed).toContain('<Subject 1> (S1)')
    expect(seed).toContain('<Subject 2> (S2)')
    expect(seed).toMatch(/\[German\] "[^"]*"[\s\S]*\[German\] "[^"]*"/)
    // Every shot the seed writes must be [Shot N] tagged, so the seed always
    // passes its own validator's "no [Shot N] markers" check too.
    expect(parseShots(seed).length).toBeGreaterThanOrEqual(3)
    // Sanity: the seed text itself, fed back through validation, reports no
    // missing-speaker-id error for either bound audio.
    const { errors } = validateManualH3({ mode: 'Ref2VA', storyText: seed, soundscape: 'quiet', refImages, refAudios })
    expect(errors.filter(e => /speaker id/.test(e))).toEqual([])
  })

  it('a single bound audio uses the bound subject, not necessarily the "main" one', () => {
    // Voice bound to the WARDROBE reference, not the identity one — the old
    // mainSubject-only logic would have wrongly spoken for <Subject 1> here.
    const refImages = [
      ref({ hash: 'a', role: 'subject_identity' }),
      ref({ hash: 'b', role: 'wardrobe' }),
    ]
    const refAudios = [{ id: 'audio1', subjectRef: 'b' }]
    const seed = buildManualSeed(refImages, refAudios)
    expect(seed).toContain('<Subject 2> (S1)')
    expect(seed).not.toContain('<Subject 1> (S1)')
  })

  it('an unbound audio (no subjectRef match) falls back to the single generic line', () => {
    const refImages = [ref({ hash: 'a', role: 'subject_identity' })]
    const refAudios = [{ id: 'audio1', subjectRef: null }]
    expect(buildManualSeed(refImages, refAudios)).toBe(buildManualSeed(refImages))
  })
})

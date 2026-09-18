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
  buildSubjectClauseParts, buildTemplateBody, buildH3Template,
  formatTimestamp, anchorSentences,
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

describe('buildSubjectClauseParts (extracted from buildManualSeed)', () => {
  it('is null with no non-pose references, matching buildManualSeed\'s own fallback gate', () => {
    expect(buildSubjectClauseParts([])).toBeNull()
    expect(buildSubjectClauseParts([ref({ hash: 'p', role: 'pose_composition' })])).toBeNull()
  })

  it('weaves the same mainClause/opener buildManualSeed already relies on', () => {
    const refImages = [
      ref({ hash: 'a', role: 'subject_identity' }),
      ref({ hash: 'b', role: 'wardrobe' }),
      ref({ hash: 'c', role: 'environment' }),
    ]
    const parts = buildSubjectClauseParts(refImages)
    expect(parts.mainClause).toBe("<Subject 1> stands by the window, wearing <Subject 2>'s jacket, framed against the backdrop from <Picture 3>")
    expect(parts.opener).toBe('')
    expect(parts.mainSubject.subjectM).toBe(1)
  })
})

describe('buildTemplateBody (the "Manual Prompt" button)', () => {
  const settings = { ratioOrient: 'landscape', ratioToken: '16:9', duration: '8 seconds', styleHint: 'Dramatic', avoidHint: 'neon signs' }

  it('T2VA: one [Shot 1] block, a «» placeholder note, no reference weaving', () => {
    const body = buildTemplateBody({ mode: 'T2VA', refImages: [], refAudios: [], scene: '', dialogue: '', delivery: '', spokenLangTag: null, ...settings })
    expect(body.startsWith('[Shot 1] «TODO')).toBe(true)
    expect(body).toContain('landscape 16:9, ~8.00s, style: Dramatic, avoid: neon signs')
    expect(body).toContain('Describe the scene here.')
    expect(parseShots(body)).toHaveLength(1)
    expect(findMalformedTags(body)).toEqual([])
  })

  it('echoes the typed Scene text instead of the generic fallback note', () => {
    const body = buildTemplateBody({ mode: 'T2VA', refImages: [], refAudios: [], scene: 'A queen betrayed by her advisor', dialogue: '', delivery: '', spokenLangTag: null, ...settings })
    expect(body).toContain('Starting notes from your Scene field: "A queen betrayed by her advisor"')
    expect(body).not.toContain('Describe the scene here.')
  })

  it('renders typed dialogue + delivery with the given language tag, no subject tag in a non-ref mode', () => {
    const body = buildTemplateBody({ mode: 'T2VA', refImages: [], refAudios: [], scene: '', dialogue: 'We need to leave now.', delivery: 'urgent, hushed', spokenLangTag: '[English]', ...settings })
    expect(body).toContain('The subject says, [English] "We need to leave now.", delivery: urgent, hushed.')
  })

  it('omits the dialogue line entirely when nothing is typed', () => {
    const body = buildTemplateBody({ mode: 'T2VA', refImages: [], refAudios: [], scene: '', dialogue: '', delivery: '', spokenLangTag: '[English]', ...settings })
    expect(body).not.toContain('who says')
    expect(body).not.toContain('The subject says')
  })

  it('the settings note never contains a bracket that could misparse as an H3 tag', () => {
    const body = buildTemplateBody({ mode: 'Ref2VA', refImages: [ref({ hash: 'a' })], refAudios: [], scene: 'x', dialogue: 'hi', delivery: '', spokenLangTag: '[English]', ...settings })
    const note = body.match(/«[^»]*»/)[0]
    expect(note).not.toMatch(/[[\]<>]/)
  })

  it('Ref2VA with no dialogue still weaves the subject clause with no speaker tag', () => {
    const refImages = [ref({ hash: 'a', role: 'subject_identity', note: 'her face and build' })]
    const body = buildTemplateBody({ mode: 'Ref2VA', refImages, refAudios: [], scene: '', dialogue: '', delivery: '', spokenLangTag: null, ...settings })
    expect(body).toContain('<Subject 1> stands by the window')
    expect(body).not.toContain('(S1)')
  })

  it('Ref2VA with dialogue and no bound audio attaches it to the main subject with a real (S1) tag', () => {
    const refImages = [ref({ hash: 'a', role: 'subject_identity', note: 'her face and build' })]
    const body = buildTemplateBody({ mode: 'Ref2VA', refImages, refAudios: [], scene: '', dialogue: 'We need to go.', delivery: '', spokenLangTag: '[English]', ...settings })
    expect(body).toContain('<Subject 1> (S1), who says, [English] "We need to go."')
    const { usage } = parseShotLabelUsage(body)
    expect(usage['Subject 1']).toEqual([1])
    expect(parseSubjectSpeakers(body)).toEqual({ 1: 'S1' })
  })

  it('Ref2VA with a bound voice reference attaches dialogue to the BOUND subject, not necessarily the main one', () => {
    const refImages = [
      ref({ hash: 'a', role: 'subject_identity' }),
      ref({ hash: 'b', role: 'wardrobe' }),
    ]
    const refAudios = [{ subjectRef: 'b' }]
    const body = buildTemplateBody({ mode: 'Ref2VA', refImages, refAudios, scene: '', dialogue: 'Hold still.', delivery: '', spokenLangTag: '[English]', ...settings })
    expect(body).toContain('<Subject 2> (S1), who says, [English] "Hold still."')
    expect(body).not.toContain('<Subject 1> (S1)')
  })

  it('never emits a trailing placeholder second shot, in any mode', () => {
    for (const mode of ['T2VA', 'I2VA', 'L2VA', 'FL2VA', 'Ref2VA']) {
      const body = buildTemplateBody({ mode, refImages: [ref({ hash: 'a' })], refAudios: [], scene: '', dialogue: 'hi', delivery: '', spokenLangTag: '[English]', ...settings })
      expect(parseShots(body)).toHaveLength(1)
    }
  })
})

describe('buildH3Template', () => {
  it('reuses assembleManualH3 for the schema shape — T2VA, three labeled fields', () => {
    const { text } = buildH3Template({
      mode: 'T2VA', scene: 'A queen betrayed by her advisor', duration: '8 seconds',
      refImages: [], refAudios: [], soundscape: 'quiet room tone', music: '',
      dialogue: '', delivery: '', spokenLangTag: null,
      ratioToken: '16:9', ratioOrient: 'landscape', styleHint: '', avoidHint: '',
    })
    expect(text).toContain('integrated_multimodal_description:')
    expect(text).toContain('overall_soundscape: quiet room tone')
    expect(text).toContain('non_diegetic_music: N/A')
  })

  it('substitutes a placeholder note for a blank soundscape instead of an empty field', () => {
    const { text } = buildH3Template({
      mode: 'T2VA', scene: '', duration: '8 seconds', refImages: [], refAudios: [],
      soundscape: '', music: '', dialogue: '', delivery: '', spokenLangTag: null,
      ratioToken: '16:9', ratioOrient: 'landscape', styleHint: '', avoidHint: '',
    })
    expect(text).not.toContain('overall_soundscape: \n')
    expect(text).not.toMatch(/overall_soundscape: $/m)
    expect(text).toContain('overall_soundscape: «describe the ambience')
  })

  it('Ref2VA: subject_definitions/retention_analysis reference the woven tag for real, not "not referenced"', () => {
    const refImages = [ref({ hash: 'a', role: 'subject_identity', note: 'her face and build' })]
    const { text } = buildH3Template({
      mode: 'Ref2VA', scene: '', duration: '8 seconds', refImages, refAudios: [],
      soundscape: 'quiet', music: '', dialogue: 'We need to go.', delivery: '', spokenLangTag: '[English]',
      ratioToken: '9:16', ratioOrient: 'portrait', styleHint: '', avoidHint: '',
    })
    expect(text).toContain('<Subject 1> (appears in [Shot 1]):')
    expect(text).not.toContain('not referenced in the text')
    const sections = text.split('\n\n').map(s => s.split(':')[0])
    expect(sections).toEqual(['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'])
  })

  it('L2VA/FL2VA: the alignment sentence still anchors sensibly to the single real shot', () => {
    const l2va = buildH3Template({
      mode: 'L2VA', scene: '', duration: '8 seconds', refImages: [], refAudios: [],
      soundscape: 'x', music: '', dialogue: '', delivery: '', spokenLangTag: null,
      ratioToken: '16:9', ratioOrient: 'landscape', styleHint: '', avoidHint: '',
    }).text
    expect(l2va.split('\n\n')[0]).toBe('How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 8.00-second mark of the target video.')
  })
})

describe('formatTimestamp', () => {
  it('formats seconds as MM:SS.mmm', () => {
    expect(formatTimestamp(1.5)).toBe('00:01.500')
    expect(formatTimestamp(65)).toBe('01:05.000')
    expect(formatTimestamp(0)).toBe('00:00.000')
    expect(formatTimestamp(undefined)).toBe('00:00.000')
  })
})

describe('anchorSentences (Add Guide timeline anchors)', () => {
  it('is empty with no anchored references', () => {
    expect(anchorSentences([ref({ hash: 'a' })])).toEqual([])
    expect(anchorSentences([])).toEqual([])
  })

  it('emits one sentence per anchored reference, chronologically ordered', () => {
    const refImages = [
      ref({ hash: 'a', atSeconds: 3 }),
      ref({ hash: 'b', role: 'pose_composition', atSeconds: 1.5 }),
    ]
    expect(anchorSentences(refImages)).toEqual([
      'At 00:01.500, the continuous movement reaches the composition defined by <Picture 2>.',
      'At 00:03.000, the continuous movement reaches the composition defined by <Picture 1>.',
    ])
  })

  it('ignores an unset or non-finite atSeconds', () => {
    expect(anchorSentences([ref({ hash: 'a', atSeconds: null }), ref({ hash: 'b', atSeconds: NaN })])).toEqual([])
  })
})

describe('Add Guide anchors inside assembleRef2VA', () => {
  it('adds a SEPARATE <Picture N> keyframe line, leaving the <Subject M> line unmodified — spec §2/§8', () => {
    const refImages = [ref({ hash: 'a', role: 'subject_identity', note: 'her face and build', atSeconds: 1.5 })]
    const storyText = '[Shot 1] <Subject 1> stands in a doorway.'
    const out = assembleRef2VA({ storyText, soundscape: 'x', music: '', refImages, refAudios: [] })
    const lines = out.split('\n\n')[0].replace('subject_definitions:\n', '').split('\n')
    expect(lines).toEqual([
      '<Subject 1> is the subject from <Picture 1>, preserving her face and build.',
      '<Picture 1> is a storyboard keyframe for the target composition at 00:01.500.',
    ])
  })

  it('adds a SEPARATE <Picture N> retention line too, leaving the <Subject M> line\'s normal reason unmodified', () => {
    const refImages = [ref({ hash: 'a', role: 'subject_identity', preserve: 'strong', atSeconds: 1.5 })]
    const storyText = '[Shot 1] <Subject 1> stands in a doorway.'
    const out = assembleRef2VA({ storyText, soundscape: 'x', music: '', refImages, refAudios: [] })
    const lines = out.split('\n\n')[2].replace('retention_analysis:\n', '').split('\n')
    expect(lines[0]).toBe('<Subject 1> (appears in [Shot 1]): partially_preserved - Preserve defining attributes; minor incidental variation allowed')
    // The <Picture N> line's marker also comes from the image's own preserve
    // setting (partially_preserved for "strong"), but with the addendum's
    // fixed anchor reason instead of retentionReason()'s normal hint text.
    expect(lines[1]).toBe('<Picture 1> (target composition at 00:01.500): partially_preserved - use it as the target pose, framing, and scene state at that time.')
  })

  it('works for a Pose/Composition anchor too (Picture-only, no Subject)', () => {
    const refImages = [ref({ hash: 'a', role: 'pose_composition', preserve: 'guide', atSeconds: 2 })]
    const storyText = '[Shot 1] plain prose.'
    const out = assembleRef2VA({ storyText, soundscape: 'x', music: '', refImages, refAudios: [] })
    expect(out).toContain('<Picture 1> (target composition at 00:02.000): attribute_transfer - use it as the target pose, framing, and scene state at that time.')
  })

  it('adds "keyframe completion" to the summary marker only when something is anchored', () => {
    const plain = [ref({ hash: 'a' })]
    const anchored = [ref({ hash: 'a', atSeconds: 1 })]
    const storyText = '[Shot 1] <Subject 1> stands.'
    const plainOut = assembleRef2VA({ storyText, soundscape: 'x', music: '', refImages: plain, refAudios: [] })
    const anchoredOut = assembleRef2VA({ storyText, soundscape: 'x', music: '', refImages: anchored, refAudios: [] })
    expect(plainOut).toContain('[reference generation]')
    expect(anchoredOut).toContain('[reference generation + keyframe completion]')
  })

  it('combines with an audio-reference marker: "reference generation + audio reference + keyframe completion"', () => {
    const refImages = [ref({ hash: 'a', atSeconds: 1 })]
    const refAudios = [{ subjectRef: 'a' }]
    const storyText = '[Shot 1] <Subject 1> (S1) stands.'
    const out = assembleRef2VA({ storyText, soundscape: 'x', music: '', refImages, refAudios })
    expect(out).toContain('[reference generation + audio reference + keyframe completion]')
  })

  it('an unanchored reference alongside an anchored one: both keep their normal lines, plus one extra <Picture N> line for the anchor', () => {
    const refImages = [
      ref({ hash: 'a', role: 'subject_identity', preserve: 'exact', atSeconds: 1 }),
      ref({ hash: 'b', role: 'wardrobe', preserve: 'strong' }),
    ]
    const storyText = '[Shot 1] <Subject 1> stands, wearing <Subject 2>\'s jacket.'
    const out = assembleRef2VA({ storyText, soundscape: 'x', music: '', refImages, refAudios: [] })
    const lines = out.split('\n\n')[2].replace('retention_analysis:\n', '').split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('<Subject 1> (appears in [Shot 1]): fully_preserved - Fully preserve — no deviation')
    expect(lines[1]).toBe('<Subject 2> (appears in [Shot 1]): partially_preserved - Preserve defining attributes; minor incidental variation allowed')
    expect(lines[2]).toContain('<Picture 1> (target composition at 00:01.000)')
  })

  it('Pose/Composition still gets exactly ONE line — its wording switches to the anchor form, no extra line added', () => {
    const refImages = [ref({ hash: 'a', role: 'pose_composition', preserve: 'guide', atSeconds: 2 })]
    const storyText = '[Shot 1] plain prose.'
    const out = assembleRef2VA({ storyText, soundscape: 'x', music: '', refImages, refAudios: [] })
    const defLines = out.split('\n\n')[0].replace('subject_definitions:\n', '').split('\n')
    const retLines = out.split('\n\n')[2].replace('retention_analysis:\n', '').split('\n')
    expect(defLines).toHaveLength(1)
    expect(retLines).toHaveLength(1)
    expect(defLines[0]).toBe('<Picture 1> is a storyboard keyframe for the target composition at 00:02.000.')
  })
})

describe('validateManualH3 — Add Guide anchor warnings (non-blocking)', () => {
  const base = () => ({
    mode: 'Ref2VA', storyText: '[Shot 1] <Subject 1> (S1) says hi.', soundscape: 'quiet',
    refImages: [ref({ hash: 'a' })], refAudios: [], duration: '8 seconds',
  })

  it('is clean with an in-range anchor', () => {
    const res = validateManualH3({ ...base(), refImages: [ref({ hash: 'a', atSeconds: 4 })] })
    expect(res.errors).toEqual([])
    expect(res.warnings).toEqual([])
  })

  it('warns (never errors) when an anchor is outside the duration', () => {
    const res = validateManualH3({ ...base(), refImages: [ref({ hash: 'a', atSeconds: 20 })] })
    expect(res.errors).toEqual([])
    expect(res.warnings.some(w => /outside the 8\.00s duration/.test(w))).toBe(true)
  })

  it('warns when two anchors share the same time', () => {
    const refImages = [ref({ hash: 'a', atSeconds: 2 }), ref({ hash: 'b', role: 'wardrobe', atSeconds: 2 })]
    const res = validateManualH3({ ...base(), refImages })
    expect(res.warnings.some(w => /share the same time/.test(w))).toBe(true)
  })

  it('skips the out-of-range check with no duration given', () => {
    const res = validateManualH3({ ...base(), duration: undefined, refImages: [ref({ hash: 'a', atSeconds: 999 })] })
    expect(res.warnings.some(w => /outside/.test(w))).toBe(false)
  })
})

describe('buildTemplateBody — Add Guide anchors', () => {
  const settings = { ratioOrient: 'landscape', ratioToken: '16:9', duration: '8 seconds', styleHint: '', avoidHint: '' }

  it('appends anchor sentences after the woven Ref2VA body', () => {
    const refImages = [ref({ hash: 'a', role: 'subject_identity', atSeconds: 1.5 })]
    const body = buildTemplateBody({ mode: 'Ref2VA', refImages, refAudios: [], scene: '', dialogue: '', delivery: '', spokenLangTag: null, ...settings })
    expect(body).toContain('At 00:01.500, the continuous movement reaches the composition defined by <Picture 1>.')
  })

  it('still appends an anchor sentence when the only reference is Pose/Composition (no subject-bearing entries)', () => {
    const refImages = [ref({ hash: 'a', role: 'pose_composition', atSeconds: 2 })]
    const body = buildTemplateBody({ mode: 'Ref2VA', refImages, refAudios: [], scene: '', dialogue: '', delivery: '', spokenLangTag: null, ...settings })
    expect(body).toContain('At 00:02.000, the continuous movement reaches the composition defined by <Picture 1>.')
    expect(parseShots(body)).toHaveLength(1)
  })

  it('emits nothing extra for non-Ref2VA modes, even if refImages happen to carry atSeconds', () => {
    const refImages = [ref({ hash: 'a', atSeconds: 1.5 })]
    const body = buildTemplateBody({ mode: 'T2VA', refImages, refAudios: [], scene: '', dialogue: '', delivery: '', spokenLangTag: null, ...settings })
    expect(body).not.toContain('continuous movement reaches')
  })
})

describe('buildManualSeed — demonstrates an Add Guide anchor when one is configured', () => {
  it('appends the anchor sentence to the seed', () => {
    const refImages = [ref({ hash: 'a', role: 'subject_identity', atSeconds: 1.5 })]
    const seed = buildManualSeed(refImages)
    expect(seed).toContain('At 00:01.500, the continuous movement reaches the composition defined by <Picture 1>.')
    // Still a schema-valid single-shot seed otherwise.
    expect(parseShots(seed).length).toBeGreaterThanOrEqual(1)
  })

  it('is unchanged (no anchor line) with nothing anchored — existing behavior preserved', () => {
    expect(buildManualSeed([])).toBe(
      '[Shot 1] Cinematic, live-action, a woman turns towards the door…\n'
      + 'At 00:03.500, the camera cuts to her, who says, [German] "Wir müssen gehen."\n'
      + '[Shot 2] …'
    )
  })
})

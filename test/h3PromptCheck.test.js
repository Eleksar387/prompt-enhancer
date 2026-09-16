// checkH3Prompt calibration: it must accept every schema-correct shape
// buildManualH3() deterministically produces (the ground-truth oracle for
// all 5 modes), and it must reject the actual broken output that motivated
// this module — a fluent narrative missing every Ref2VA field label, taken
// from a real history entry (target minimax_h3, frameMode 'ref').

import { describe, it, expect } from 'vitest'
import { checkH3Prompt } from '../src/h3PromptCheck.js'
import { buildManualH3 } from '../src/manualH3.js'

const ref = (over = {}) => ({ hash: 'h1', role: 'subject_identity', preserve: 'exact', note: '', ...over })

describe('checkH3Prompt — must-pass fixtures (buildManualH3 oracle)', () => {
  it('T2VA: zero errors on schema-correct output', () => {
    const { text } = buildManualH3({
      mode: 'T2VA', storyText: '[Shot 1] Cinematic, live-action, a woman turns towards the door.',
      soundscape: 'quiet room tone', music: '', duration: '8 seconds', refImages: [], refAudios: [],
    })
    expect(checkH3Prompt(text, { mode: 'T2VA' }).errors).toEqual([])
  })

  it('I2VA: zero errors on schema-correct output', () => {
    const { text } = buildManualH3({
      mode: 'I2VA', storyText: '[Shot 1] Cinematic, live-action, a woman turns towards the door.',
      soundscape: 'quiet room tone', music: '', duration: '8 seconds', refImages: [], refAudios: [],
    })
    expect(checkH3Prompt(text, { mode: 'I2VA' }).errors).toEqual([])
  })

  it('L2VA: zero errors on schema-correct output', () => {
    const { text } = buildManualH3({
      mode: 'L2VA', storyText: '[Shot 1] Cinematic, live-action, a woman turns towards the door.',
      soundscape: 'quiet room tone', music: '', duration: '8 seconds', refImages: [], refAudios: [],
    })
    expect(checkH3Prompt(text, { mode: 'L2VA' }).errors).toEqual([])
  })

  it('FL2VA: zero errors on schema-correct output', () => {
    const { text } = buildManualH3({
      mode: 'FL2VA', storyText: '[Shot 1] Cinematic, live-action, a woman turns towards the door.',
      soundscape: 'quiet room tone', music: '', duration: '8 seconds', refImages: [], refAudios: [],
    })
    expect(checkH3Prompt(text, { mode: 'FL2VA' }).errors).toEqual([])
  })

  it('Ref2VA: zero errors on schema-correct output, with reference images', () => {
    const refImages = [
      ref({ hash: 'a', role: 'subject_identity', preserve: 'exact', note: 'her face and build' }),
      ref({ hash: 'b', role: 'wardrobe', preserve: 'strong', note: 'the red jacket' }),
    ]
    const { text } = buildManualH3({
      mode: 'Ref2VA', storyText: '[Shot 1] <Subject 1> (S1) turns towards the door, wearing <Subject 2>\'s jacket, and says, [English] "We have to go."',
      soundscape: 'quiet room tone', music: '', duration: '8 seconds', refImages, refAudios: [],
    })
    const res = checkH3Prompt(text, { mode: 'Ref2VA', refImages })
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('accepts the illustrative detailed_description example prose wrapped in a well-formed Ref2VA skeleton', () => {
    // Abridged from constants.js:1611-1622 (SYSTEM_PROMPT_MINIMAX_H3's own example).
    const example = 'The target video is in a cinematic, handheld documentary style with warm practical light and a shallow depth of '
      + 'field. [Shot 1] (0.00–4.00s) <Subject 1> stands at a workbench, her hands pressed flat on its surface; a phone on '
      + 'the bench buzzes once and lights up — the trigger — and her eyes drop to it, her shoulders drawing in as she '
      + 'reads the screen. At 4.00s, the camera cuts to [Shot 2] (4.00–10.00s), a close push in with small amplitude: '
      + '<Subject 1> straightens, sets her jaw, and looks up toward the doorway (S1), saying in a clear, steady voice with '
      + 'an edge of defiance, [English] "I\'m not asking again." She holds the look, her breath steady, and settles.'
    const refImages = [ref({ hash: 'a' })]
    const text = [
      `subject_definitions:\n<Subject 1> is the subject from <Picture 1>, preserving face shape, hairstyle, build.`,
      `summary:\n[reference generation] <Subject 1> appears across the target video as described in detailed_description below.`,
      `retention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - identity locked from the reference.`,
      `detailed_description:\n${example}`,
      `overall_soundscape: a quiet workshop room tone.`,
      `non_diegetic_music: N/A`,
    ].join('\n\n')
    const res = checkH3Prompt(text, { mode: 'Ref2VA', refImages })
    expect(res.errors).toEqual([])
  })
})

describe('checkH3Prompt — must-fail fixture (real broken history entry)', () => {
  // outputs[0].text verbatim from a real history entry (target: minimax_h3,
  // frameMode: 'ref' -> Ref2VA) — the writer model (qwen3:32b) returned fluent
  // prose with correct [Shot N]/<Subject N>/<Picture N>/(S1)/[German] "…" tag
  // syntax but NONE of the six required Ref2VA field labels.
  const brokenRef2VAOutput = "The target video blends gothic aesthetic with Star Wars iconography in a deadpan, ironic juxtaposition. The style is grounded yet anachronistic, pairing Leia's timeless defiance with a punk-inspired space-age setting.  \n\n[Shot 1] (0.00–4.00s) <Subject 1> stands in the dim, band-poster-cluttered room (<Picture 2>), one hand adjusting the vintage boombox on the side table. Her hair, styled into rigid, symmetrical buns (a reinterpreted version of the original <Picture 1>'s layered, tousled look), is offset by the metallic sheen of the halter top (<Picture 3>), its gold-bronze swirls catching the twinkle of string lights. The camera lingers on the ornate crescent belt at her waist as she shifts subtly, the deep-purple skirt whispering across the plush rug. A faint hum of the boombox — its cassette tape drawer partially open — fills the ambient soundscape, layered with the muffled rustle of the lacy drapes.  \n\nAt 4.00s, the shot transitions to [Shot 2] (4.00–8.00s), a tight two-shot with the camera framed at waist height, emphasizing <Subject 1>'s cross-shoulder posture. Her face is half-shadowed, the piercing on her left eyebrow glinting as she turns, eyes narrowing with a steely, almost bored resolve. Her voice (S1), matching the confident pitch and breathy inflection of <Audio 1>, delivers in German: [German] \"Der Geist ist bei dir, immer.\" — the line spoken with a deadpan smirk, as though reciting a meme rather than an epic mantra. The non_diegetic_music swells faintly under her words, the iconic Star Wars score filtered to sound distant, almost like a radio signal bleeding through the boombox.  \n\nThe clip ends on <Picture 3>'s skirt flowing still, the string lights flickering once as the shot cuts to black. The ambient soundscape fades with a residual crackle, leaving only the music's triumphant crescendo."

  it('reports errors and is not ok', () => {
    const res = checkH3Prompt(brokenRef2VAOutput, { mode: 'Ref2VA' })
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
  })

  it('names every missing Ref2VA label', () => {
    const { errors } = checkH3Prompt(brokenRef2VAOutput, { mode: 'Ref2VA' })
    for (const label of ['subject_definitions:', 'summary:', 'retention_analysis:', 'overall_soundscape:', 'non_diegetic_music:']) {
      expect(errors.some(e => e.includes(`"${label}"`))).toBe(true)
    }
  })

  it('does NOT treat the mid-sentence "non_diegetic_music" substring as the field being present', () => {
    // The false-positive trap: brokenRef2VAOutput contains the literal
    // characters "non_diegetic_music" inside a plain sentence ("The
    // non_diegetic_music swells faintly under her words…"). A substring-only
    // check would wrongly consider the field present.
    expect(brokenRef2VAOutput.includes('non_diegetic_music')).toBe(true) // sanity: the trap is real
    const { errors } = checkH3Prompt(brokenRef2VAOutput, { mode: 'Ref2VA' })
    expect(errors.some(e => e.includes('Missing required field "non_diegetic_music:"'))).toBe(true)
  })

  it('also fails the first-line check (starts with prose, not "subject_definitions:")', () => {
    const { errors } = checkH3Prompt(brokenRef2VAOutput, { mode: 'Ref2VA' })
    expect(errors.some(e => /must start with "subject_definitions:"/.test(e))).toBe(true)
  })
})

describe('checkH3Prompt — label order and structure', () => {
  it('errors when required labels are present but out of order', () => {
    const text = 'overall_soundscape: quiet\n\nintegrated_multimodal_description: [Shot 1] x\n\nnon_diegetic_music: N/A'
    const { errors } = checkH3Prompt(text, { mode: 'T2VA' })
    expect(errors.some(e => /appears before/.test(e))).toBe(true)
  })

  it('errors on a wrapping markdown code fence', () => {
    const text = '```\nintegrated_multimodal_description: [Shot 1] x\n\noverall_soundscape: quiet\n\nnon_diegetic_music: N/A\n```'
    const { errors } = checkH3Prompt(text, { mode: 'T2VA' })
    expect(errors.some(e => /markdown code fence/.test(e))).toBe(true)
  })

  it('errors on empty output', () => {
    expect(checkH3Prompt('', { mode: 'T2VA' })).toMatchObject({ ok: false, errors: ['Output is empty.'] })
  })

  it('I2VA/L2VA/FL2VA: missing the alignment sentence is an error', () => {
    const text = 'integrated_multimodal_description: [Shot 1] x\n\noverall_soundscape: quiet\n\nnon_diegetic_music: N/A'
    expect(checkH3Prompt(text, { mode: 'I2VA' }).errors.some(e => /I2VA alignment sentence/.test(e))).toBe(true)
    expect(checkH3Prompt(text, { mode: 'L2VA' }).errors.some(e => /L2VA alignment sentence/.test(e))).toBe(true)
    expect(checkH3Prompt(text, { mode: 'FL2VA' }).errors.some(e => /FL2VA alignment sentence/.test(e))).toBe(true)
  })
})

describe('checkH3Prompt — warnings (non-blocking)', () => {
  const goodT2VA = () => buildManualH3({
    mode: 'T2VA', storyText: '[Shot 1] Cinematic, live-action, a woman turns towards the door.',
    soundscape: 'quiet room tone', music: '', duration: '8 seconds', refImages: [], refAudios: [],
  }).text

  it('flags a malformed tag as a warning, not an error', () => {
    const text = goodT2VA().replace('[Shot 1]', '[shot 1]')
    const res = checkH3Prompt(text, { mode: 'T2VA' })
    expect(res.errors).toEqual([])
    expect(res.warnings.some(w => /\[shot 1\]/.test(w))).toBe(true)
    expect(res.ok).toBe(true)
  })

  it('Ref2VA: warns on a referenced-but-undeclared <Subject N>', () => {
    const text = 'subject_definitions:\n<Subject 1> is the subject from <Picture 1>, preserving face shape.\n\n'
      + 'summary:\n[reference generation] <Subject 1> appears across the target video.\n\n'
      + 'retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - locked.\n\n'
      + 'detailed_description:\n[Shot 1] <Subject 1> and <Subject 2> stand together.\n\n'
      + 'overall_soundscape: quiet.\n\n'
      + 'non_diegetic_music: N/A'
    const res = checkH3Prompt(text, { mode: 'Ref2VA', refImages: [ref({ hash: 'a' })] })
    expect(res.warnings.some(w => /<Subject 2>/.test(w) && /no reference image/.test(w))).toBe(true)
  })

  it('Ref2VA: warns on a supplied reference never mentioned in the text', () => {
    const refImages = [ref({ hash: 'a' }), ref({ hash: 'b', role: 'wardrobe' })]
    const text = 'subject_definitions:\n<Subject 1> is the subject from <Picture 1>, preserving face shape.\n\n'
      + 'summary:\n[reference generation] <Subject 1> appears across the target video.\n\n'
      + 'retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - locked.\n\n'
      + 'detailed_description:\n[Shot 1] <Subject 1> stands alone.\n\n'
      + 'overall_soundscape: quiet.\n\n'
      + 'non_diegetic_music: N/A'
    const res = checkH3Prompt(text, { mode: 'Ref2VA', refImages })
    expect(res.warnings.some(w => /Subject 2/.test(w) && /never mentioned/.test(w))).toBe(true)
  })
})

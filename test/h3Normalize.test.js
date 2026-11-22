import { describe, it, expect } from 'vitest'
import { normalizeH3Sections, musicIsOff, captionGist, stripRatioEcho } from '../src/h3Normalize'
import { systemPromptFor, TARGETS } from '../src/constants'
import { buildH3SystemV2 } from '../src/h3Prompt'
import { h3ProfileFor } from '../src/modelProfiles'

const SIX = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']

describe('normalizeH3Sections', () => {
  it('reorders a real failing shape: stray leading field, --- separators, wrong order', () => {
    const bad = [
      'integrated_multimodal_description:', 'stray T2VA text', '', '---', '',
      'subject_definitions:', '<Subject 1> is x.', '', '---', '',
      'summary:', '[reference generation] y', '', '---', '',
      'retention_analysis:', '<Subject 1> (appears in [Shot 1]): fully_preserved - z', '', '---', '',
      'detailed_description:', 'Live-action. [Shot 1] (0.00–8.00s) …', '', '---', '',
      'overall_soundscape:', 'crickets', '', '---', '',
      'non_diegetic_music:', 'Long paragraph.',
    ].join('\n')
    const out = normalizeH3Sections(bad, 'Ref2VA', { musicOff: true })
    expect(out).not.toMatch(/---|integrated_multimodal_description|stray T2VA/)
    expect(SIX.map(l => out.indexOf(l + ':'))).toEqual([...SIX.map(l => out.indexOf(l + ':'))].sort((a, b) => a - b))
    expect(out.startsWith('subject_definitions:')).toBe(true)
    expect(out.endsWith('non_diegetic_music:\nN/A')).toBe(true)
  })
  it('puts out-of-order sections into canonical order', () => {
    const out = normalizeH3Sections('detailed_description:\nD\n\nsummary:\nS\n\nsubject_definitions:\nA', 'Ref2VA')
    expect(out).toBe('subject_definitions:\nA\n\nsummary:\nS\n\ndetailed_description:\nD')
  })
  it('returns correct input byte-identical', () => {
    const good = 'subject_definitions:\nA\n\nsummary:\nS\n\nretention_analysis:\nR\n\ndetailed_description:\nD\n\noverall_soundscape:\nO\n\nnon_diegetic_music:\nN/A'
    expect(normalizeH3Sections(good, 'Ref2VA')).toBe(good)
    const base = 'integrated_multimodal_description: [Shot 1] x\n\noverall_soundscape: y\n\nnon_diegetic_music: N/A'
    expect(normalizeH3Sections(base, 'T2VA')).toBe(base)
  })
  it('does not invent a missing label and leaves unlabelled text alone', () => {
    expect(normalizeH3Sections('summary:\nS\n\nsubject_definitions:\nA', 'Ref2VA')).toBe('subject_definitions:\nA\n\nsummary:\nS')
    expect(normalizeH3Sections('just some prose', 'Ref2VA')).toBe('just some prose')
  })
  it('keeps the alignment line of a base mode', () => {
    const t = 'For the target video, at 0.00 seconds, <Picture 1> (from [Shot 1]) is fully referenced.\n\n---\noverall_soundscape: s\n\nintegrated_multimodal_description: [Shot 1] d'
    const out = normalizeH3Sections(t, 'I2VA')
    expect(out.startsWith('For the target video')).toBe(true)
    expect(out.indexOf('integrated_multimodal_description')).toBeLessThan(out.indexOf('overall_soundscape'))
  })
  it('musicIsOff only for an explicit no-music note', () => {
    expect(musicIsOff('none')).toBe(true)
    expect(musicIsOff(' Silence. ')).toBe(true)
    expect(musicIsOff('')).toBe(false)
    expect(musicIsOff('sparse piano')).toBe(false)
  })
})

describe('compact profile prompt', () => {
  const t = TARGETS.minimax_h3
  const cyd = '/home/arebholz/models/Cydonia-24B-v4s-Q2_K.gguf'
  it('only Cydonia-class models get it', () => {
    expect(h3ProfileFor(cyd)).toBe('compact')
    expect(h3ProfileFor('qwen2.5:7b')).toBe(null)
    expect(systemPromptFor(t, 'ref', true, 'qwen2.5:7b')).toBe(buildH3SystemV2('ref'))
    expect(systemPromptFor(t, 'ref', true)).toBe(buildH3SystemV2('ref'))
    expect(systemPromptFor(t, 'ref', true, cyd)).not.toBe(buildH3SystemV2('ref'))
    expect(systemPromptFor(t, 'ref', false, cyd)).toBe(t.buildSystem ? t.buildSystem('ref') : t.system)
  })
  it('is shorter, has the skeleton and markers, and leaks no example text', () => {
    const c = systemPromptFor(t, 'ref', true, cyd)
    expect(c.length).toBeLessThan(buildH3SystemV2('ref').length)
    expect(c).toMatch(/subject_definitions:\n«/)
    for (const m of ['fully_preserved', 'partially_preserved', 'attribute_transfer', 'weak_reference']) expect(c).toContain(m)
    expect(c).not.toMatch(/edge of defiance/)
  })
  it('builds for every frame mode', () => {
    for (const fm of ['single', 'last', 'firstlast', 'firstmidlast', 'ref']) expect(systemPromptFor(t, fm, true, cyd)).toContain('OUTPUT STARTS NOW')
  })
})

describe('Ref2VA reference coverage', () => {
  const refs = [{ role: 'environment', preserve: 'inspiration' }, { role: 'environment', preserve: 'inspiration' }, { role: 'subject_identity', preserve: 'strong' }]
  const text = 'subject_definitions:\n<Subject 1> is the woman from <Picture 3>, preserving x.\n\nretention_analysis:\n<Picture 1> (location reference for [Shot 1]): inspiration - sets the view.\n<Subject 1> (appears in [Shot 2]): fully_preserved - y.\n\ndetailed_description:\nD'
  it('adds missing Picture lines and forces the image marker', () => {
    const out = normalizeH3Sections(text, 'Ref2VA', { refs })
    expect(out).toMatch(/<Picture 1> is the location reference/)
    expect(out).toMatch(/<Picture 2> is the location reference/)
    expect(out).toMatch(/<Picture 1> \(location reference for \[Shot 1\]\): weak_reference - sets the view\./)
    expect(out).toMatch(/<Picture 2> \(location reference\): weak_reference/)
    expect(out).not.toMatch(/: inspiration/)
    // identity (subject-bearing) lines are untouched
    expect(out).toContain('<Subject 1> (appears in [Shot 2]): fully_preserved - y.')
  })
  it('is a no-op without refs', () => {
    expect(normalizeH3Sections(text, 'Ref2VA')).toContain('inspiration - sets the view')
  })
})

describe('fallback Picture lines describe the image', () => {
  const cap = 'Aerial top-down view of a dense allotment-garden neighborhood on a strict grid. Roofs are dark gray.'
  it('captionGist takes the first sentence without its period', () => {
    expect(captionGist(cap)).toBe('Aerial top-down view of a dense allotment-garden neighborhood on a strict grid')
    expect(captionGist('')).toBe('')
    expect(captionGist('x'.repeat(400), 50).length).toBeLessThanOrEqual(51)
  })
  it('a missing location line carries the caption gist', () => {
    const out = normalizeH3Sections('subject_definitions:\nA\n\nretention_analysis:\nB', 'Ref2VA', { refs: [{ role: 'environment', preserve: 'inspiration', caption: cap }] })
    expect(out).toContain('<Picture 1> is the location reference — Aerial top-down view of a dense allotment-garden neighborhood on a strict grid — guiding')
  })
  it('without a caption it falls back to the generic line', () => {
    const out = normalizeH3Sections('subject_definitions:\nA\n\nretention_analysis:\nB', 'Ref2VA', { refs: [{ role: 'environment', preserve: 'inspiration' }] })
    expect(out).toContain('<Picture 1> is the location reference guiding')
  })
})

describe('ratio echo', () => {
  it('drops "9:16 portrait" from the opening style text only', () => {
    expect(stripRatioEcho('This is a 9:16 portrait shot, filmed in live-action.\n\n[Shot 1] (0.00–4.00s) A 16:9 sign hangs.'))
      .toBe('This is a shot, filmed in live-action.\n\n[Shot 1] (0.00–4.00s) A 16:9 sign hangs.')
  })
  it('leaves clean text byte-identical', () => {
    const t = 'Live-action, warm palette.\n\n[Shot 1] (0.00–4.00s) x'
    expect(stripRatioEcho(t)).toBe(t)
  })
})

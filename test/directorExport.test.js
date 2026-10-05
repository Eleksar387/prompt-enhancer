import { describe, it, expect } from 'vitest'
import { buildDirectorTimeline, DIRECTOR_RUN_TOKEN } from '../src/directorExport'

const script = {
  look: 'Warm film grain', soundscape: 'Wind', music: 'Sparse piano', language: 'German',
  characters: [{ id: 'c1', name: 'Mara', appearance: 'tall, grey coat', wardrobe: 'wool scarf' }],
  scenes: [{ id: 's1', dialogues: [] }],
}
const cut = { shots: [
  { shot_number: 1, scene_id: 's1', duration: 5, primary_beat: 'She lifts the letter', camera_framing: 'Close-up', dialogue: ['Mara: Komm her'] },
  { shot_number: 2, scene_id: 's1', duration: 7, visual_action: 'Door closes' },
] }
const ref = { base64: 'AAAA', mediaType: 'image/png', caption: 'A woman', linkType: 'character', linkId: 'c1', preserve: 'exact', fileName: 'm.png' }
const base = { script, directorsCut: cut, entityName: () => 'Mara', preserveMarker: () => 'fully_preserved' }

describe('buildDirectorTimeline', () => {
  it('lays clips out back to back in frames', () => {
    const { timeline, totalFrames, totalSeconds } = buildDirectorTimeline({ ...base, refImages: [] })
    expect(timeline.segments.map(s => [s.start, s.length])).toEqual([[0, 120], [120, 168]])
    expect(totalFrames).toBe(288)
    expect(totalSeconds).toBe(12)
    expect(timeline.normalDurationFrames).toBe(288)
    expect(timeline.reference_mode).toBe('OFF')
    expect(timeline.overall_soundscape).toBe('Wind')
  })
  it('turns a captioned reference into a subject and addresses dialogue to it', () => {
    const { timeline } = buildDirectorTimeline({ ...base, refImages: [ref] })
    expect(timeline.reference_mode).toBe('REF2VA')
    expect(timeline.subjects[0]).toMatchObject({ kind: 'person', retention: 'fully_preserved', shortName: 'Mara' })
    expect(timeline.subjects[0].images[0].b64).toBe('data:image/png;base64,AAAA')
    expect(timeline.subjects).toHaveLength(3)
    expect(timeline.segments[0].prompt).toBe('Close-up. She lifts the letter.\n@ref1 [German] says: Komm her')
  })
  it('falls back to @voice() when the speaker has no reference', () => {
    const { timeline } = buildDirectorTimeline({ ...base, refImages: [] })
    expect(timeline.segments[0].prompt).toContain('@voice(Mara) [German] says: Komm her')
  })
  it('points a character voice at the staged file via the run token', () => {
    const voiceRefs = [{ id: 'v1', characterId: 'c1', fileName: 'mara.mp3' }]
    const { timeline } = buildDirectorTimeline({ ...base, refImages: [ref], voiceRefs, voiceFile: () => 'voices/Mara-1.mp3' })
    expect(timeline.subjects[0].voice.audioFile).toBe(`${DIRECTOR_RUN_TOKEN}/voices/Mara-1.mp3`)
  })
  it('warns past 15 s and on empty clips', () => {
    const long = { shots: [{ shot_number: 1, duration: 10, primary_beat: 'a' }, { shot_number: 2, duration: 10 }] }
    const { warnings } = buildDirectorTimeline({ ...base, directorsCut: long, refImages: [] })
    expect(warnings.some(w => w.includes('20.0 s'))).toBe(true)
    expect(warnings.some(w => w.includes('Clip 2 has no text'))).toBe(true)
  })
})

import { buildSingleDirectorTimeline } from '../src/directorExport'
describe('buildSingleDirectorTimeline', () => {
  const im = (o) => ({ base64: 'AAAA', mediaType: 'image/jpeg', fileName: 'a.jpg', role: 'subject_identity', preserve: 'exact', hash: 'h1', note: 'Steffi', ...o })
  const args = { scene: 'She turns', durationSec: 8, refImages: [im(), im({ role: 'pose_composition', hash: 'h2', note: 'pose' })], describe: (i) => `desc ${i.hash}`, preserveMarker: () => 'fully_preserved' }
  it('one segment, subjects from refs, REF2VA', () => {
    const r = buildSingleDirectorTimeline(args)
    expect(r.timeline.segments).toHaveLength(1)
    expect(r.timeline.segments[0].length).toBe(192)
    expect(r.timeline.reference_mode).toBe('REF2VA')
    expect(r.timeline.subjects.map(s => s.kind).slice(0, 2)).toEqual(['person', 'pose'])
    expect(r.timeline.subjects[0].description).toBe('desc h1')
  })
  it('binds a voice by image hash and addresses dialogue to it', () => {
    const r = buildSingleDirectorTimeline({ ...args, dialogue: 'Hallo', language: 'German', refAudios: [{ subjectRef: 'h1' }], voiceFiles: ['voice-reference-1.mp3'] })
    expect(r.timeline.subjects[0].voice.audioFile).toBe('__PE_RUN__/voice-reference-1.mp3')
    expect(r.timeline.segments[0].prompt).toBe('She turns\n@ref1 [German] says: Hallo')
  })
  it('warns when there is no scene text', () => {
    expect(buildSingleDirectorTimeline({ ...args, scene: '' }).warnings.join()).toContain('No Scene text')
  })
})

describe('multi-line dialogue', () => {
  it('tags every spoken line and strips list bullets', () => {
    const r = buildSingleDirectorTimeline({ scene: 'x', dialogue: '- "A"\n- "B"', language: 'German', refImages: [{ base64: 'A', role: 'subject_identity', hash: 'h', note: 'n' }] })
    expect(r.timeline.segments[0].prompt).toBe('x\n@ref1 [German] says: "A"\n@ref1 [German] says: "B"')
  })
})

describe('timeline anchors (single clip, no generated text)', () => {
  it('anchored pose ref is an anchor only; the first image rides on the single shot, the second is reported', () => {
    const refs = [
      { base64: 'AAAA', role: 'subject_identity', hash: 'a', note: 'Steffi', atSeconds: 3 },
      { base64: 'BBBB', role: 'pose_composition', hash: 'b', note: 'pose', atSeconds: 5, fileName: 'pose.png' },
    ]
    const r = buildSingleDirectorTimeline({ scene: 'x', durationSec: 8, refImages: refs, describe: () => 'd' })
    expect(r.timeline.subjects.filter(s => s.images.length)).toHaveLength(1)
    expect(r.timeline.segments).toHaveLength(1)
    expect(r.timeline.segments[0]).toMatchObject({ type: 'image', prompt: 'x' })
    expect(r.warnings.join()).toContain('left out')
  })
})

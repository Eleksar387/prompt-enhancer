import { describe, it, expect } from 'vitest'
import { parseH3Sections, splitShots, cleanShotText } from '../src/directorShots'
import { buildSingleDirectorTimeline, attachAnchorsToSegments } from '../src/directorExport'

// Same structure as a real Ref2VA writer output (neutral content).
const PROMPT = `subject_definitions:
<Subject 1> is the woman from <Picture 1>, preserving a grey coat.
<Subject 2> is the kitchen from <Picture 2>.
<Picture 3> is a storyboard reference for [Shot 1] and [Shot 3].
summary:
[reference generation]
detailed_description:
The target video is in a warm cinematic style with soft practical light. [Shot 1] (0.00–2.70s) The framing follows <Picture 3>: an upright profile in <Subject 2>. <Subject 1> stands at the counter. On-screen, in a low, clear voice (S1), she says: [German] "Na, bist Du bereit?" At 2.70s, the camera cuts to [Shot 2] (2.70–5.20s), a closer view from her right. A man answers (S2), saying: [German] "Ja, ich wills probieren!" At 5.20s, the shot switches to [Shot 3] (5.20–8.00s). The shot's keyframe corresponds to <Picture 3>: <Subject 1> leans on the counter. The shot settles.
overall_soundscape:
Low refrigerator hum.
non_diegetic_music: N/A`

describe('parseH3Sections / splitShots', () => {
  const sec = parseH3Sections(PROMPT)
  it('reads the labelled blocks; N/A music is empty', () => {
    expect(sec.soundscape).toBe('Low refrigerator hum.')
    expect(sec.music).toBe('')
    expect(sec.detailed.startsWith('The target video')).toBe(true)
  })
  it('splits shots with times, global paragraph and no trailing connectors', () => {
    const { global, shots } = splitShots(sec.detailed, 8)
    expect(global).toContain('warm cinematic style')
    expect(shots.map(s => [s.n, s.startSec, s.endSec])).toEqual([[1, 0, 2.7], [2, 2.7, 5.2], [3, 5.2, 8]])
    expect(shots[0].text).not.toMatch(/camera cuts to\s*$/)
    expect(shots[1].text.startsWith('a closer view')).toBe(true)
  })
  it('no markers → one shot', () => {
    const { shots } = splitShots('Just one paragraph.', 6)
    expect(shots).toEqual([{ n: 1, startSec: 0, endSec: 6, text: 'Just one paragraph.' }])
  })
})

describe('cleanShotText', () => {
  const opts = { subjectSlotOf: (M) => ({ 1: 1, 2: 2 }[M] ?? null), speakerRef: (n) => (n > 1 ? '@voice(another speaker)' : '@ref1') }
  const { shots } = splitShots(parseH3Sections(PROMPT).detailed, 8)
  it('maps subjects, drops picture pointers and speaker markers, lifts dialogue lines', () => {
    const t = cleanShotText(shots[0].text, opts)
    expect(t).not.toMatch(/<Picture|\(S\d\)|<Subject/)
    expect(t).toContain('An upright profile in @ref2')   // lead-in "The framing follows <Picture 3>:" dropped
    expect(t).toContain('@ref1 stands at the counter')
    expect(t.split('\n')).toContain('@ref1 [German] says in a low, clear voice: Na, bist Du bereit?')
  })
  it('second speaker becomes @voice()', () => {
    expect(cleanShotText(shots[1].text, opts)).toContain('@voice(another speaker) [German] says: Ja, ich wills probieren!')
  })
  it('keyframe sentence leaves only the description', () => {
    expect(cleanShotText(shots[2].text, opts)).toMatch(/^@ref1 leans on the counter/)
  })
})

describe('single timeline from generated text', () => {
  const img = (o) => ({ base64: 'AAAA', mediaType: 'image/png', hash: 'h', note: 'n', ...o })
  const refs = [img({ role: 'subject_identity', hash: 'a', atSeconds: 0 }), img({ role: 'environment', hash: 'b' }), img({ role: 'pose_composition', hash: 'c', atSeconds: 4 })]
  const r = buildSingleDirectorTimeline({ scene: 'ignored scene', durationSec: 8, refImages: refs, describe: () => 'd', generatedText: PROMPT })
  it('segments are the shots, text per shot, soundscape from the result', () => {
    expect(r.timeline.segments.map(s => [s.start, s.length])).toEqual([[0, 65], [65, 60], [125, 67]])
    expect(r.timeline.segments.every(s => s.prompt)).toBe(true)
    expect(r.timeline.global_prompt).toContain('warm cinematic style')
    expect(r.timeline.overall_soundscape).toBe('Low refrigerator hum.')
    expect(r.timeline.segments[0].prompt).not.toContain('ignored scene')
  })
  it('anchor images sit on their shot (text kept, no empty segments); pose → storyboard', () => {
    const [a, b, c] = r.timeline.segments
    expect(a).toMatchObject({ type: 'image', refRole: 'auto' })
    expect(b).toMatchObject({ type: 'image', refRole: 'storyboard', start: 65 })   // 4 s falls in shot 2
    expect(c.type).toBe('text')
    expect(r.timeline.segments.some(s => !s.prompt)).toBe(false)
  })
})

describe('attachAnchorsToSegments', () => {
  const segs = [{ id: 'a', start: 0, length: 50, prompt: 'x', type: 'text' }, { id: 'b', start: 50, length: 50, prompt: 'y', type: 'text' }]
  const an = (f) => ({ atFrames: f, image: { b64: 'd', name: 'n' } })
  it('keeps text/length; a second anchor in a taken shot moves to the nearest free one', () => {
    const three = [...segs, { id: 'c', start: 100, length: 50, prompt: 'z', type: 'text' }]
    const r = attachAnchorsToSegments(three, [an(10), an(20)])
    expect(r.segments.map(s => [s.type, s.length, s.prompt])).toEqual([['image', 50, 'x'], ['image', 50, 'y'], ['text', 50, 'z']])
    expect(r.warnings[0]).toContain('moved to shot 2')
  })
  it('with no free shot the extra image is left out with a warning; nothing is split', () => {
    const r = attachAnchorsToSegments(segs, [an(10), an(60), an(20)])
    expect(r.segments).toHaveLength(2)
    expect(r.warnings.join()).toContain('left out')
  })
})

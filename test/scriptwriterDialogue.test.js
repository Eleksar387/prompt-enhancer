// findMissingDialogue is the pure, deterministic half of the fix for a
// verified bug: SYSTEM_PROMPT_DIRECTOR_H3's DIALOGUE rule says "copy each
// line verbatim from the script", but nothing requires that EVERY scene
// dialogue/narration line end up in some clip — under "fewest clips"
// pressure the model was silently dropping lines instead of adding clips
// for them (12 of 17 lines missing in the real entry that surfaced this).
// This function only detects what's missing and where it belongs; the LLM
// call that writes each missing clip (fillDialogueGaps, in the component)
// is not exercised here — same split as isMergeEligible vs mergeShotPair.

import { describe, it, expect } from 'vitest'
import { findMissingDialogue } from '../src/components/ScriptwriterPanel.jsx'

const scene = (id, dialogues) => ({ id, title: `Scene ${id}`, dialogues })
const shot = (n, sceneId, dialogue = []) => ({ shot_number: n, scene_id: sceneId, dialogue })

describe('findMissingDialogue', () => {
  it('reports nothing when every scene line is already covered', () => {
    const script = { scenes: [scene(1, ['A: hi']), scene(2, ['B: bye'])] }
    const shots = [shot(1, 1, ['A: hi']), shot(2, 2, ['B: bye'])]
    expect(findMissingDialogue(shots, script)).toEqual([])
  })

  it('finds a partially-covered scene and anchors after its last shot', () => {
    const script = { scenes: [scene(1, ['A: one', 'A: two', 'A: three'])] }
    const shots = [shot(1, 1, ['A: one']), shot(2, 1, []), shot(3, 1, ['A: three'])]
    expect(findMissingDialogue(shots, script)).toEqual([
      { sceneId: 1, anchor: 2, lines: ['A: two'] },
    ])
  })

  it('finds a scene that collapsed into a single silent clip and lost every line', () => {
    const script = { scenes: [scene(1, ['A: hello']), scene(2, ['B: hi', 'B: how are you'])] }
    const shots = [shot(1, 1, ['A: hello']), shot(2, 2, [])]
    expect(findMissingDialogue(shots, script)).toEqual([
      { sceneId: 2, anchor: 1, lines: ['B: hi', 'B: how are you'] },
    ])
  })

  it('anchors a scene that contributed zero shots after the nearest earlier scene that did', () => {
    const script = { scenes: [scene(1, []), scene(2, ['B: line']), scene(3, ['C: line'])] }
    // scene 2 never produced a shot at all (fully dropped by the Director)
    const shots = [shot(1, 1, []), shot(2, 3, ['C: line'])]
    expect(findMissingDialogue(shots, script)).toEqual([
      { sceneId: 2, anchor: 0, lines: ['B: line'] },
    ])
  })

  it('anchors at the very start (-1) when the missing scene precedes every shot', () => {
    const script = { scenes: [scene(1, ['A: line']), scene(2, ['B: line'])] }
    const shots = [shot(1, 2, ['B: line'])] // scene 1 produced nothing
    expect(findMissingDialogue(shots, script)).toEqual([
      { sceneId: 1, anchor: -1, lines: ['A: line'] },
    ])
  })

  it('anchors after the LAST occurrence of a cross-cut / interleaved scene, not the first', () => {
    // scene 1 (the present-tense frame) is cross-cut around scene 2 (a flashback):
    // shot1=scene1, shot2=scene2, shot3=scene1 again. A line scene 1 is missing
    // should land after shot3, not get forced next to shot1.
    const script = { scenes: [scene(1, ['A: before', 'A: after']), scene(2, ['B: memory'])] }
    const shots = [shot(1, 1, ['A: before']), shot(2, 2, ['B: memory']), shot(3, 1, [])]
    expect(findMissingDialogue(shots, script)).toEqual([
      { sceneId: 1, anchor: 2, lines: ['A: after'] },
    ])
  })

  it('ignores whitespace differences when deciding a line is covered', () => {
    const script = { scenes: [scene(1, ['A:   hi   there'])] }
    const shots = [shot(1, 1, ['A: hi there'])]
    expect(findMissingDialogue(shots, script)).toEqual([])
  })

  it('returns [] for a scene with no dialogue at all', () => {
    const script = { scenes: [scene(1, [])] }
    const shots = [shot(1, 1, [])]
    expect(findMissingDialogue(shots, script)).toEqual([])
  })

  it('returns [] with no scenes or no shots', () => {
    expect(findMissingDialogue([], { scenes: [scene(1, ['A: hi'])] })).toEqual([])
    expect(findMissingDialogue([shot(1, 1, [])], { scenes: [] })).toEqual([])
  })
})

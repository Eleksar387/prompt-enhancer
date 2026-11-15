import { describe, it, expect } from 'vitest'
import {
  sceneBudget, runtimeLine, normalizeSceneSeconds, sceneTimeLine, clampH3Duration,
  clipBeats, mergeBlocker, isMergeEligible, planPack, unpackableScenes, packMaxFor,
} from '../src/clipPacker.js'

const clip = (o = {}) => ({
  shot_type: 'action', scene_id: 1, location_id: 'l1', characters: ['c1'], dialogue: [], duration: 6, ...o,
})

describe('sceneBudget', () => {
  it('is null for Auto / junk', () => {
    expect(sceneBudget(0)).toBeNull()
    expect(sceneBudget(undefined)).toBeNull()
    expect(sceneBudget('x')).toBeNull()
  })
  it('maps 30/60/90 s to 2/4/6 scenes of ~15 s', () => {
    expect(sceneBudget(30)).toEqual({ runtime: 30, scenes: 2, perScene: 15 })
    expect(sceneBudget(60)).toEqual({ runtime: 60, scenes: 4, perScene: 15 })
    expect(sceneBudget(90)).toEqual({ runtime: 90, scenes: 6, perScene: 15 })
  })
  it('respects the scene cap', () => {
    expect(sceneBudget(90, 5)).toEqual({ runtime: 90, scenes: 5, perScene: 18 })
  })
  it('runtimeLine names runtime, scene count and duration_s; empty for Auto', () => {
    expect(runtimeLine(null)).toBe('')
    const l = runtimeLine(sceneBudget(60))
    expect(l).toContain('about 60 seconds')
    expect(l).toContain('4 scenes of roughly 15 seconds')
    expect(l).toContain('duration_s')
  })
})

describe('scene seconds + clip clamp', () => {
  it('normalizeSceneSeconds clamps to 5–40 or null', () => {
    expect(normalizeSceneSeconds('15')).toBe(15)
    expect(normalizeSceneSeconds(2)).toBe(5)
    expect(normalizeSceneSeconds(400)).toBe(40)
    expect(normalizeSceneSeconds(null)).toBeNull()
    expect(normalizeSceneSeconds('abc')).toBeNull()
  })
  it('sceneTimeLine lists scenes that have a budget, empty otherwise', () => {
    expect(sceneTimeLine([{ id: 1 }, { id: 2 }])).toBe('')
    const l = sceneTimeLine([{ id: 1, duration_s: 14 }, { id: 2, duration_s: 20 }, { id: 3 }])
    expect(l).toContain('scene 1 = 14s, scene 2 = 20s')
    expect(l).not.toContain('scene 3')
  })
  it('clampH3Duration keeps 4–15 and falls back for junk', () => {
    expect(clampH3Duration(2)).toBe(4)
    expect(clampH3Duration(30)).toBe(15)
    expect(clampH3Duration('9')).toBe(9)
    expect(clampH3Duration(undefined)).toBe(7)
  })
})

describe('clipBeats', () => {
  it('action/establishing carry no beat; performance/insert carry one', () => {
    expect(clipBeats(clip({ shot_type: 'action' }))).toBe(0)
    expect(clipBeats(clip({ shot_type: 'establishing' }))).toBe(0)
    expect(clipBeats(clip({ shot_type: 'performance' }))).toBe(1)
    expect(clipBeats(clip({ shot_type: 'insert' }))).toBe(1)
  })
  it('an explicit merged `beats` total wins', () => {
    expect(clipBeats(clip({ shot_type: 'performance', beats: 2 }))).toBe(2)
  })
})

describe('mergeBlocker / isMergeEligible', () => {
  it('merges same-scene no-beat clips', () => {
    expect(isMergeEligible(clip(), clip())).toBe(true)
  })
  it('merges two single-beat performance clips (2 beats = at the limit)', () => {
    const p = clip({ shot_type: 'performance', duration: 5 })
    expect(isMergeEligible(p, p)).toBe(true)
  })
  it('refuses a third beat (merged pair + another performance)', () => {
    const two = clip({ shot_type: 'performance', beats: 2, duration: 8 })
    expect(mergeBlocker(two, clip({ shot_type: 'performance', duration: 4 }))).toMatch(/3 facial/)
  })
  it('refuses across scenes, locations, cast', () => {
    expect(mergeBlocker(clip(), clip({ scene_id: 2 }))).toBe('different scenes')
    expect(mergeBlocker(clip(), clip({ location_id: 'l2' }))).toBe('different locations')
    expect(mergeBlocker(clip(), clip({ characters: ['c1', 'c2'] }))).toBe('different cast on screen')
  })
  it('refuses any clip carrying dialogue', () => {
    expect(mergeBlocker(clip(), clip({ dialogue: ['A: hi'] }))).toMatch(/dialogue/)
  })
  it('refuses a combined duration over the cap, and the cap is configurable', () => {
    const a = clip({ duration: 9 }), b = clip({ duration: 8 })
    expect(mergeBlocker(a, b)).toMatch(/17s/)
    expect(isMergeEligible(clip({ duration: 6 }), clip({ duration: 6 }), { maxClip: 12 })).toBe(true)
    expect(isMergeEligible(clip({ duration: 7 }), clip({ duration: 6 }), { maxClip: 12 })).toBe(false)
  })
  it('never exceeds the H3 15 s hard cap even if maxClip is set higher', () => {
    expect(isMergeEligible(clip({ duration: 9 }), clip({ duration: 8 }), { maxClip: 60 })).toBe(false)
  })
})

describe('planPack', () => {
  it('chains 3 compatible short clips of one scene into one', () => {
    const shots = [clip({ duration: 4 }), clip({ duration: 4 }), clip({ duration: 4 })]
    expect(planPack(shots)).toEqual({ groups: [[0, 2]], clips: 1 })
  })
  it('stops chaining at the clip cap', () => {
    const shots = [clip({ duration: 6 }), clip({ duration: 6 }), clip({ duration: 6 })]
    expect(planPack(shots, { maxClip: 12 })).toEqual({ groups: [[0, 1], [2, 2]], clips: 2 })
  })
  it('never merges across scenes', () => {
    const shots = [clip({ scene_id: 1 }), clip({ scene_id: 2 })]
    expect(planPack(shots).groups).toEqual([[0, 0], [1, 1]])
  })
  it('three performance clips pack as 2 + 1 (beat density wins over duration)', () => {
    const p = () => clip({ shot_type: 'performance', duration: 4 })
    expect(planPack([p(), p(), p()])).toEqual({ groups: [[0, 1], [2, 2]], clips: 2 })
  })
  it('a dialogue clip splits its neighbours', () => {
    const shots = [clip(), clip({ dialogue: ['A: x'] }), clip()]
    expect(planPack(shots).groups).toEqual([[0, 0], [1, 1], [2, 2]])
  })
  it('maxClip 0 (loose) packs nothing', () => {
    expect(planPack([clip(), clip()], { maxClip: 0 }).clips).toBe(2)
    expect(packMaxFor('loose')).toBe(0)
    expect(packMaxFor('tight')).toBe(15)
    expect(packMaxFor('standard')).toBe(12)
  })
  it('handles empty input', () => {
    expect(planPack([])).toEqual({ groups: [], clips: 0 })
    expect(planPack(undefined)).toEqual({ groups: [], clips: 0 })
  })
})

describe('unpackableScenes', () => {
  it('reports a scene still in several clips with the reason', () => {
    const shots = [clip({ dialogue: ['A: hi'] }), clip(), clip({ scene_id: 2 })]
    const r = unpackableScenes(shots)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ sceneId: '1', clips: 2, seconds: 12 })
    expect(r[0].reasons[0]).toMatch(/dialogue/)
  })
  it('lists nothing when every scene is one clip', () => {
    expect(unpackableScenes([clip(), clip({ scene_id: 2 })])).toEqual([])
  })
})

// Acceptance: a real-shaped 3-scene / 9-clip film (action, performance, action per
// scene, dialogue-free, 5/7/5 s) re-packs into fewer, longer clips without ever
// breaking the beat or duration limits.
describe('re-pack acceptance', () => {
  it('9 clips → 6 (action+performance folded, trailing action kept: 5+7+5 = 17 s > 15 s cap)', () => {
    const types = ['action', 'performance', 'action']
    const shots = []
    for (const sc of [1, 2, 3]) for (const t of types) shots.push(clip({ scene_id: sc, shot_type: t, duration: t === 'performance' ? 7 : 5 }))
    const { groups, clips } = planPack(shots, { maxClip: 15 })
    expect(clips).toBe(6)
    expect(groups).toEqual([[0, 1], [2, 2], [3, 4], [5, 5], [6, 7], [8, 8]])
    // every group respects the limits
    for (const [i, j] of groups) {
      const sum = shots.slice(i, j + 1).reduce((a, s) => a + s.duration, 0)
      const beats = shots.slice(i, j + 1).reduce((a, s) => a + clipBeats(s), 0)
      expect(sum).toBeLessThanOrEqual(15)
      expect(beats).toBeLessThanOrEqual(2)
    }
  })
})

// Pure scene-budget + clip-packing rules for the Scriptwriter (H3 target).
// No React, no fetch — same spirit as adapt.js / manualH3.js, tested directly in
// test/clipPacker.test.js.
//
// Why this exists (docs/script-diagnosis.md): Phase 2 used to receive no time
// budget per scene and was told to subdivide every scene, and prompt wording alone
// never reduced clip count. So the decision "which adjacent clips may be combined"
// lives here, in code; the LLM is only asked to rewrite two already-compatible
// clips as one (ScriptwriterPanel.mergeShotPair).
//
// The one hard rule this module never relaxes: BEAT DENSITY — a clip holds at most
// TWO facial/emotional beats (h3-storyboard, the one PSNR-verified rule). Packing is
// by beat count first, duration second.

export const H3_MIN_CLIP = 4
export const H3_MAX_CLIP = 15
export const MAX_BEATS_PER_CLIP = 2

// ---- Runtime → scene budget -------------------------------------------------
// One scene = one place, one conflict, one turn ≈ 12–18 s ≈ one H3 clip. So a
// 60 s film is ~4 scenes, a 90 s film ~6 (the handover's 60–90 s / 4–6 scenes).
export const RUNTIME_OPTIONS = [
  { id: 0,  label: 'Auto',  note: 'Let the writer size the film (the old behaviour — usually 1 scene, ~25 s).' },
  { id: 30, label: '~30 s', note: '≈ 2 scenes' },
  { id: 60, label: '~60 s', note: '≈ 4 scenes' },
  { id: 90, label: '~90 s', note: '≈ 6 scenes' },
]
export const SCENE_SECONDS = 15

// → null for Auto (0 / unset / junk), else { runtime, scenes, perScene }.
// `cap` is the UI scene ceiling (5 normal, 15 source mode).
export function sceneBudget(runtime, cap = 6) {
  const r = Math.round(Number(runtime) || 0)
  if (r <= 0) return null
  const scenes = Math.max(1, Math.min(cap, Math.round(r / SCENE_SECONDS)))
  return { runtime: r, scenes, perScene: Math.round(r / scenes) }
}

// The Phase-1 user-message line(s) for a budget. The system prompt's
// "Target runtime" rule says this overrides the "prefer ONE scene" guidance.
export function runtimeLine(budget) {
  if (!budget) return ''
  return `Target runtime: about ${budget.runtime} seconds. Plan ${budget.scenes} scene${budget.scenes > 1 ? 's' : ''} of roughly ${budget.perScene} seconds each — `
    + `each scene is one dramatic unit (one place, one conflict, one turn where a value flips), linked to the previous scene by "but" or "therefore", never "and then". `
    + `Give every scene a "duration_s" (integer seconds).`
}

// Coerce a model-written scene duration to an integer 5–40, or null.
export function normalizeSceneSeconds(v) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.max(5, Math.min(40, n))
}

// Phase-2 user-message lines: how long each scene should run, so the Director
// plans against time instead of "2–4 clips per scene".
export function sceneTimeLine(scenes) {
  const parts = (scenes || [])
    .map(s => [s.id, normalizeSceneSeconds(s.duration_s)])
    .filter(([, d]) => d)
  if (!parts.length) return ''
  return `Scene time budget (clips of a scene should add up to about this): ${parts.map(([id, d]) => `scene ${id} = ${d}s`).join(', ')}. `
    + `Prefer ONE clip of 8–15 s per scene, using internal [Shot N] cuts, whenever the beat-density limit and SUBJECT LOCK allow it.`
}

// Clamp a model-written clip duration to H3's valid 4–15 s (never silently unlimited).
export function clampH3Duration(v, fallback = 7) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(H3_MIN_CLIP, Math.min(H3_MAX_CLIP, n))
}

// ---- Packing ----------------------------------------------------------------
// Facial/emotional beats a clip carries. `establishing` and `action` are H3's own
// "do not count toward beat density" types. A performance clip (and an insert,
// which is usually a reaction cutaway) is one beat. A merged clip remembers its
// total in `beats` (set by mergedBeats), so chains never silently exceed the cap.
export const NO_BEAT_SHOT_TYPES = new Set(['establishing', 'action'])
export function clipBeats(shot) {
  if (!shot) return 0
  if (Number.isFinite(shot.beats)) return shot.beats
  return NO_BEAT_SHOT_TYPES.has(shot.shot_type) ? 0 : 1
}
export const mergedBeats = (a, b) => clipBeats(a) + clipBeats(b)

const sameIdSet = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  const sa = [...a].map(String).sort(), sb = [...b].map(String).sort()
  return sa.every((v, i) => v === sb[i])
}
const dur = s => Number(s?.duration) || 0

// Pacing → how long a packed clip may get. Loose keeps the Director's coverage.
export const PACK_MAX_BY_PACING = { tight: 15, standard: 12, loose: 0 }
export const packMaxFor = pacing => (pacing in PACK_MAX_BY_PACING ? PACK_MAX_BY_PACING[pacing] : PACK_MAX_BY_PACING.standard)

// Why two adjacent clips can't merge ('' = they can). One place for every rule so
// the report and the manual-merge nudge say the same thing.
export function mergeBlocker(a, b, { maxClip = H3_MAX_CLIP, maxBeats = MAX_BEATS_PER_CLIP } = {}) {
  if (!a || !b) return 'no neighbour'
  if (String(a.scene_id) !== String(b.scene_id)) return 'different scenes'
  if (String(a.location_id ?? '') !== String(b.location_id ?? '')) return 'different locations'
  if (!sameIdSet(a.characters, b.characters)) return 'different cast on screen'
  if ((a.dialogue?.length || 0) > 0 || (b.dialogue?.length || 0) > 0) return 'a clip carries dialogue (H3 gives a dialogue clip nothing else to do)'
  if (mergedBeats(a, b) > maxBeats) return `would hold ${mergedBeats(a, b)} facial/emotional beats (limit ${maxBeats})`
  if (dur(a) + dur(b) > Math.min(maxClip, H3_MAX_CLIP)) return `combined ${dur(a) + dur(b)}s exceeds the ${Math.min(maxClip, H3_MAX_CLIP)}s clip cap`
  return ''
}
export const isMergeEligible = (a, b, opts) => mergeBlocker(a, b, opts) === ''

// Scenes still in several clips after packing, with the dominant reason — the
// "report any scene that cannot be packed" the handover asks for. A scene whose
// clips all share a blocker of "different cast…" etc. is listed once with that reason.
export function unpackableScenes(shots, opts) {
  const byScene = new Map()
  ;(shots || []).forEach((s, i) => {
    const k = String(s.scene_id)
    if (!byScene.has(k)) byScene.set(k, [])
    byScene.get(k).push(i)
  })
  const out = []
  for (const [sceneId, idxs] of byScene) {
    if (idxs.length < 2) continue
    const reasons = new Set()
    for (let n = 0; n < idxs.length - 1; n++) {
      const why = mergeBlocker(shots[idxs[n]], shots[idxs[n + 1]], opts)
      if (why) reasons.add(why)
    }
    out.push({ sceneId, clips: idxs.length, seconds: idxs.reduce((a, i) => a + dur(shots[i]), 0), reasons: [...reasons] })
  }
  return out
}

// The merge plan: walk adjacent clips left to right; whenever the pair is eligible
// fold it (staying on the same index so 3+ compatible clips chain). Pure — callers
// that need an LLM rewrite per merge (the panel) use `isMergeEligible` in their own
// loop; this returns the same grouping as index ranges for tests/diagnostics.
// → { groups: [[i, j], …] (inclusive ranges over the input), clips: n }
export function planPack(shots, opts = {}) {
  const maxClip = opts.maxClip ?? H3_MAX_CLIP
  const groups = []
  if (!maxClip) return { groups: (shots || []).map((_, i) => [i, i]), clips: (shots || []).length }
  let cur = null // { start, end, shot } — shot is a running pseudo-clip
  for (let i = 0; i < (shots || []).length; i++) {
    const s = shots[i]
    if (cur && isMergeEligible(cur.shot, s, { ...opts, maxClip })) {
      cur.end = i
      cur.shot = { ...cur.shot, duration: dur(cur.shot) + dur(s), beats: mergedBeats(cur.shot, s) }
    } else {
      if (cur) groups.push([cur.start, cur.end])
      cur = { start: i, end: i, shot: s }
    }
  }
  if (cur) groups.push([cur.start, cur.end])
  return { groups, clips: groups.length }
}

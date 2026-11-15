// Scriptwriter-entry diagnostics + baseline dump (Phase 0 of the script-quality overhaul).
//   node eval/extract-script-baseline.mjs --list            table of all scriptwriter entries
//   node eval/extract-script-baseline.mjs <entryId> [...]   stats + slim dump -> eval/baseline/script-<id>.json
// Reads ~/.prompt-enhancer-data (PE_DATA_DIR overrides). Output is gitignored (private content). No image bytes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dataDir = process.env.PE_DATA_DIR || path.join(os.homedir(), '.prompt-enhancer-data')
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'baseline')
const load = id => JSON.parse(fs.readFileSync(path.join(dataDir, 'entries', `${id}.json`), 'utf8'))
const words = s => (String(s || '').match(/\S+/g) || []).length
const dur = s => +s.duration || 0

export function scriptStats(e) {
  const scenes = e.script?.scenes || []
  const shots = e.directorsCut?.shots || []
  const total = shots.reduce((a, s) => a + dur(s), 0)
  const perScene = scenes.map(sc => {
    const cl = shots.filter(s => String(s.scene_id) === String(sc.id))
    return {
      id: sc.id, title: sc.title, clips: cl.length, seconds: cl.reduce((a, s) => a + dur(s), 0),
      hasTurn: !!String(sc.emotional_turn || '').trim(),
      types: cl.map(s => s.shot_type || '?'),
    }
  })
  const dialogueWords = shots.reduce((a, s) => a + (s.dialogue || []).reduce((b, d) => b + words(d.line ?? d.text ?? d), 0), 0)
  const durs = shots.map(dur)
  return {
    id: e.id, title: e.script?.title, fullAuto: !!e.fullAuto, pacing: e.pacing, sceneCap: e.sceneCount,
    scenes: scenes.length, clips: shots.length, totalSeconds: total,
    avgClipSeconds: shots.length ? +(total / shots.length).toFixed(1) : 0,
    clipsAtOrUnder5s: durs.filter(d => d <= 5).length, clipsAtOrOver10s: durs.filter(d => d >= 10).length,
    scenesWithTurn: perScene.filter(p => p.hasTurn).length,
    avgClipsPerScene: scenes.length ? +(shots.length / scenes.length).toFixed(1) : 0,
    shotTypes: shots.reduce((m, s) => ((m[s.shot_type || '?'] = (m[s.shot_type || '?'] || 0) + 1), m), {}),
    dialogueWords, dialogueWordsPerSecond: total ? +(dialogueWords / total).toFixed(2) : 0,
    perScene,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args[0] === '--list') {
    const rows = fs.readdirSync(path.join(dataDir, 'entries')).map(f => load(f.replace(/\.json$/, '')))
      .filter(e => e.type === 'scriptwriter' && e.directorsCut?.shots?.length)
      .sort((a, b) => b.ts - a.ts).map(scriptStats)
    console.table(rows.map(({ id, title, fullAuto, scenes, clips, totalSeconds, avgClipSeconds, clipsAtOrUnder5s }) =>
      ({ id, title, fullAuto, scenes, clips, totalSeconds, avgClipSeconds, clipsAtOrUnder5s })))
    const n = rows.length, sum = k => rows.reduce((a, r) => a + r[k], 0)
    console.log(`entries with clips: ${n}; overall avg clip ${(sum('totalSeconds') / sum('clips')).toFixed(1)}s; ` +
      `${sum('clipsAtOrUnder5s')}/${sum('clips')} clips <=5s; avg clips/scene ${(sum('clips') / sum('scenes')).toFixed(1)}`)
  } else {
    fs.mkdirSync(outDir, { recursive: true })
    for (const id of args) {
      const e = load(id)
      const slim = {
        stats: scriptStats(e), idea: e.idea, genre: e.genre, pacing: e.pacing, model: e.model,
        script: e.script,
        clips: (e.directorsCut?.shots || []).map(s => ({
          n: s.shot_number, scene_id: s.scene_id, type: s.shot_type, duration: s.duration, beat: s.primary_beat || s.visual_action,
          eyeline: s.eyeline, dialogue: s.dialogue,
        })),
      }
      fs.writeFileSync(path.join(outDir, `script-${id}.json`), JSON.stringify(slim, null, 2))
      console.log('wrote', id, JSON.stringify(slim.stats, (k, v) => (k === 'perScene' ? undefined : v)))
    }
  }
}

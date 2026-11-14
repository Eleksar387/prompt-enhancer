// Dumps selected real history entries (inputs + CURRENT output) into
// eval/baseline/<id>.json so later phases can compare old vs new pipeline.
// Metadata only — no image/audio bytes. Usage:
//   node eval/extract-baseline.mjs <entryId> [...]        (reads ~/.prompt-enhancer-data)
// PE_DATA_DIR overrides the data dir. Output is gitignored (private content).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dataDir = process.env.PE_DATA_DIR || path.join(os.homedir(), '.prompt-enhancer-data')
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'baseline')
fs.mkdirSync(outDir, { recursive: true })

for (const id of process.argv.slice(2)) {
  const e = JSON.parse(fs.readFileSync(path.join(dataDir, 'entries', `${id}.json`), 'utf8'))
  const refs = (e.refImages || []).map((r, i) => ({
    n: i + 1, role: r.role, preserve: r.preserve, note: r.note || '',
    atSeconds: r.atSeconds ?? null, loraId: r.loraId || null,
    caption: r.captions?.[r.role] || r.caption || '', fileName: r.fileName || '',
  }))
  const slim = {
    id: e.id, ts: e.ts, target: e.target, frameMode: e.frameMode,
    input: {
      idea: e.scene, duration: e.duration, ratio: e.ratio, style: e.style, creativity: e.creativity,
      dialogue: e.dialogue, delivery: e.delivery, spokenLang: e.spokenLang,
      soundscape: e.soundscape, music: e.music, loraIds: e.loraIds, loraSubjects: e.loraSubjects,
      refs, refAudioCount: (e.refAudio || []).length,
    },
    model: e.model, vision: e.vision, visionCaption: e.caption,
    outputs: (e.outputs || []).map(o => ({ label: o.label, h3Mode: o.h3Mode, text: o.text })),
  }
  fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(slim, null, 2))
  console.log('wrote', id, `(${refs.length} refs, ${slim.input.refAudioCount} audio, ${slim.outputs.length} outputs)`)
}

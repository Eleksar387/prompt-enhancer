// Old vs new H3 writer prompt on ONE saved scene. Reads the scene from a baseline
// file (eval/extract-baseline.mjs), builds the user message with the app's own
// builders, calls your configured writer twice (craft rules OFF, then ON) and
// writes both results next to each other. A handful of calls, not a test suite.
//
//   npx vite-node eval/compare.mjs <entryId> [--thin "short idea"] [--model <id>]
//
// The app keeps your key in the browser (localStorage), which Node can't read. Put the
// key on the first line of eval/.key (gitignored; xai-/sk-ant-/sk-or- prefix picks the
// base URL, or add a base URL on line 2). LoRA trigger repair is not applied here
// (library is browser-side); the two columns are raw writer output.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CFG, callOllama, pickWriter, fetchModels } from '../src/api.js'
import { TARGETS, systemPromptFor, MINIMAX_H3_RESOLUTIONS, PROMPT_LENGTH_INJECT } from '../src/constants.js'
import { buildStylePart, buildWriterUserText } from '../src/adapt.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const id = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const e = JSON.parse(fs.readFileSync(path.join(here, 'baseline', `${id}.json`), 'utf8'))

const [keyLine = '', baseLine = ''] = fs.readFileSync(path.join(here, '.key'), 'utf8').split('\n').map(l => l.trim())
const baseFor = (k) => k.startsWith('sk-ant-') ? 'https://api.anthropic.com/v1' : 'https://api.x.ai/v1'
const cfg = { ...DEFAULT_CFG, apiKey: keyLine, base: baseLine || baseFor(keyLine) }
let model = flag('--model')
if (!model) model = pickWriter(await fetchModels(cfg))
const t = TARGETS.minimax_h3
const inp = e.input
const idea = flag('--thin') ?? inp.idea
const ratio = MINIMAX_H3_RESOLUTIONS.find(r => r.label === inp.ratio) || MINIMAX_H3_RESOLUTIONS[0]

const stylePart = buildStylePart({
  style: inp.style, creativity: inp.creativity, targetType: t.type, showDialogue: true,
  dialogue: inp.dialogue, delivery: inp.delivery, spokenLang: inp.spokenLang, targetId: 'minimax_h3',
})
const user = buildWriterUserText({
  target: 'minimax_h3', targetType: t.type, frameMode: e.frameMode, scene: idea, duration: inp.duration,
  frameDescription: e.visionCaption, hasImg: true, ratio, soundscape: inp.soundscape, music: inp.music,
  stylePart, lengthPart: PROMPT_LENGTH_INJECT.standard || '',
})

const run = async (craft) =>
  (await callOllama(model, user, systemPromptFor(t, e.frameMode, craft), cfg, cfg.temperature)).text

const [oldText, newText] = [await run(false), await run(true)]
const out = `# ${id} — model ${model}\n\nIDEA: ${idea}\n\n===== OLD (craft rules off) =====\n${oldText}\n\n===== NEW (craft rules on) =====\n${newText}\n`
const file = path.join(here, 'out', `${id}${flag('--thin') ? '-thin' : ''}.txt`)
fs.writeFileSync(file, out)
console.log(out)
console.log('saved', file)

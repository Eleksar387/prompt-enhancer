import { useState, useRef, useEffect } from 'react'
import { callOllama } from '../api'
import {
  SYSTEM_PROMPT_SCRIPTWRITER, SYSTEM_PROMPT_DIRECTOR, buildLtxGuideSystemPrompt,
  SYSTEM_PROMPT_FLUX, SYSTEM_PROMPT_FLUX2_KLEIN, SYSTEM_PROMPT_SDXL,
  VISION_PROMPT_SCRIPTWRITER,
} from '../constants'
import { btn, shrinkToJpeg, imageHash } from '../utils'
import { generateId } from '../db'
import { loadComfyCfg, saveComfyCfg, sendShot, fetchComfyOutputs, fetchComfyImageBlob } from '../comfy'
import ScriptwriterRefImages from './ScriptwriterRefImages'

const GENRE_OPTIONS = [
  { id: 'auto',     label: 'Auto' },
  { id: 'drama',    label: 'Drama' },
  { id: 'thriller', label: 'Thriller' },
  { id: 'sci-fi',   label: 'Sci-fi' },
  { id: 'comedy',   label: 'Comedy' },
  { id: 'horror',   label: 'Horror' },
]

const field = (extra = {}) => ({
  width: '100%', boxSizing: 'border-box',
  background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 6,
  padding: '8px 10px', color: 'var(--pe-ink)', fontSize: 13, outline: 'none',
  fontFamily: 'inherit', lineHeight: 1.5, transition: 'border-color 0.15s',
  ...extra,
})

const card = {
  background: 'var(--pe-rail)', border: '1px solid var(--pe-line)',
  borderRadius: 10, padding: '14px 16px', marginBottom: 12,
}

const lbl = {
  fontSize: 13.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase',
  letterSpacing: '0.5px', display: 'block', marginBottom: 4,
}

const genBtn = (disabled) => ({
  padding: '10px 24px', borderRadius: 8, border: 'none',
  background: disabled ? 'var(--pe-line)' : 'var(--pe-accent)',
  color: disabled ? 'var(--pe-ink-3)' : '#fff',
  fontSize: 14, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
})

// Small neutral action link/button used around attached frame images.
const ghostBtn = {
  padding: '3px 9px', borderRadius: 5, border: '1px solid var(--pe-line)',
  background: 'var(--pe-surface)', color: 'var(--pe-ink-3)', fontSize: 12.5, cursor: 'pointer',
}

const FRAME_TARGETS = [
  { id: 'flux',       label: 'Flux.dev' },
  { id: 'flux2klein', label: 'Klein'    },
  { id: 'sdxl',       label: 'SDXL'    },
]
const FRAME_SYSTEM = {
  flux: SYSTEM_PROMPT_FLUX,
  flux2klein: SYSTEM_PROMPT_FLUX2_KLEIN,
  sdxl: SYSTEM_PROMPT_SDXL,
}
const SHOT_SYSTEM_PROMPT = buildLtxGuideSystemPrompt('single')
const FRAME_KEYS = ['first', 'mid', 'last']
const FRAME_LABELS = { first: 'First frame', mid: 'Mid frame', last: 'Last frame' }

const emptyFrameEntry = () => ({
  frames: {
    first: { target: 'flux', text: '', image: null, loading: false, error: '' },
    mid:   { target: 'flux', text: '', image: null, loading: false, error: '' },
    last:  { target: 'flux', text: '', image: null, loading: false, error: '' },
  }
})

// Persisted frame entries carry only { target, text, image }; rebuild the
// transient loading/error fields and tolerate a missing / older shape.
const rehydrateFrameEntry = (fp) => ({
  frames: Object.fromEntries(FRAME_KEYS.map(k => [k, {
    target: fp?.frames?.[k]?.target || 'flux',
    text:   fp?.frames?.[k]?.text   || '',
    image:  fp?.frames?.[k]?.image  || null,
    loading: false, error: '',
  }])),
})

const serializeFramePrompts = (fps) => (fps || []).map(fp => ({
  frames: Object.fromEntries(FRAME_KEYS.map(k => {
    const f = fp.frames[k]
    return [k, { target: f.target, text: f.text, image: f.image || null }]
  })),
}))

// One scriptwriter history record over ~12 MB starts to be a liability
// (it is re-put in full on every phase save). Above it, drop reference-image
// bytes first (the caption text carries the info), then attached frame images.
const HISTORY_SOFT_LIMIT = 12 * 1024 * 1024

// --- reference images ------------------------------------------------------
const MAX_REF_IMAGES = 6
const REF_MAX_DIM = 1536

// Persisted shape — no id/previewUrl; bytes under `base64` (matches the
// standard-entry / refImages convention elsewhere in the app).
const serializeRefImages = (imgs) => (imgs || []).map(im => ({
  base64: im.base64 || null,
  mediaType: im.mediaType || 'image/jpeg',
  fileName: im.fileName || 'reference.jpg',
  note: im.note || '',
  caption: im.caption || '',
  hash: im.hash || (im.base64 ? imageHash(im.base64) : ''),
}))

const rehydrateRefImage = (d) => ({
  id: generateId(),
  base64: d.base64 || null,
  mediaType: d.mediaType || 'image/jpeg',
  previewUrl: d.base64 ? `data:${d.mediaType || 'image/jpeg'};base64,${d.base64}` : null,
  fileName: d.fileName || 'reference.jpg',
  note: d.note || '',
  caption: d.caption || '',
  hash: d.hash || (d.base64 ? imageHash(d.base64) : ''),
})

// The text block folded into a phase's user message — captioned images only.
const assembleRefBlock = (refImages, heading) => {
  const done = (refImages || []).filter(im => im.caption && im.caption.trim())
  if (!done.length) return ''
  const lines = done.map((im, i) => {
    const tag = im.note && im.note.trim() ? ` (note: ${im.note.trim()})` : ''
    return `Image ${i + 1}${tag}: ${im.caption.trim()}`
  })
  return `\n\n${heading}\n${lines.join('\n')}`
}

const REF_HEADING_CANON =
  'Reference images provided by the user (treat these as canon for how the people, places, and props in this film look — cast and set-dress around them):'
const REF_HEADING_DIRECTOR =
  'Reference images provided by the user (keep every shot visually consistent with these — same faces, wardrobe, and locations):'
const REF_HEADING_SHOT =
  'Reference images provided by the user (keep this shot visually consistent with these — same faces, wardrobe, and location):'
const REF_HEADING_LITE =
  'Continuity references — keep the character(s), wardrobe, and location consistent with these descriptions; do NOT add them as new elements and do NOT describe them verbatim:'

const STEPS = ['Script', "Director's Cut", 'LTX Prompts']

export default function ScriptwriterPanel({
  cfg, writerModel, visionModel = '', initialState = null, onSaveHistory = null,
  comfyCfg: comfyCfgProp = null, setComfyCfg: setComfyCfgProp = null,
}) {
  const sessionId = useRef(initialState?.id || generateId())
  const visModel = visionModel || writerModel

  // ComfyUI handoff config — use the shared one from App when provided, else a
  // self-contained local copy so the panel still works standalone.
  const [comfyCfgLocal, setComfyCfgLocal] = useState(loadComfyCfg)
  const comfyCfg = comfyCfgProp || comfyCfgLocal
  const setComfyCfg = setComfyCfgProp || setComfyCfgLocal
  useEffect(() => { if (!setComfyCfgProp) saveComfyCfg(comfyCfgLocal) }, [comfyCfgLocal, setComfyCfgProp])
  // { key: "<shotIdx>-<frameKey>" | null, state: 'idle'|'sending'|'done'|'error', error }
  const [comfyFrame, setComfyFrame] = useState({ key: null, state: 'idle', error: '' })

  const [phase, setPhase] = useState(initialState?.phase || 'input')
  const [idea, setIdea] = useState(initialState?.idea || '')
  const [genre, setGenre] = useState(initialState?.genre || 'auto')
  const [sceneCount, setSceneCount] = useState(initialState?.sceneCount || 3)
  const [script, setScript] = useState(initialState?.script || null)
  const [directorsCut, setDirectorsCut] = useState(initialState?.directorsCut || null)
  const [finalPrompts, setFinalPrompts] = useState(
    initialState?.finalPrompts?.map(p => ({ ...p, loading: false, error: '' })) || []
  )
  const [framePrompts, setFramePrompts] = useState(() => {
    if (initialState?.framePrompts?.length) return initialState.framePrompts.map(rehydrateFrameEntry)
    if (initialState?.directorsCut?.shots?.length) return initialState.directorsCut.shots.map(() => emptyFrameEntry())
    return []
  })
  const [error, setError] = useState('')
  const [rawFallback, setRawFallback] = useState('')
  const [copied, setCopied] = useState(null)
  const [copiedAll, setCopiedAll] = useState(false)
  const [copiedFrame, setCopiedFrame] = useState(null)
  // ComfyUI output picker: { key: "<shotIdx>-<frameKey>" | null, loading, error, items: [] }
  const [picker, setPicker] = useState({ key: null, loading: false, error: '', items: [] })
  // { key | null, state: 'idle'|'fetching'|'error', error } — the fetch+encode of a chosen image
  const [attach, setAttach] = useState({ key: null, state: 'idle', error: '' })
  const [historyNote, setHistoryNote] = useState('')
  const [refImages, setRefImages] = useState(() => (initialState?.refImages || []).map(rehydrateRefImage))
  // { state: 'idle' | 'reading' | 'error', done, total, error }
  const [refCaptionStatus, setRefCaptionStatus] = useState({ state: 'idle', done: 0, total: 0, error: '' })
  const captioning = refCaptionStatus.state === 'reading'

  const reset = () => {
    sessionId.current = generateId()
    setPhase('input'); setIdea(''); setGenre('auto'); setSceneCount(3)
    setScript(null); setDirectorsCut(null); setFinalPrompts([]); setFramePrompts([])
    setError(''); setRawFallback(''); setCopied(null); setCopiedAll(false)
    setComfyFrame({ key: null, state: 'idle', error: '' })
    setPicker({ key: null, loading: false, error: '', items: [] })
    setAttach({ key: null, state: 'idle', error: '' })
    setHistoryNote('')
    setRefImages([])
    setRefCaptionStatus({ state: 'idle', done: 0, total: 0, error: '' })
  }

  const parseJSON = (text) => {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    try { return JSON.parse(clean) }
    catch {
      setRawFallback(text)
      throw new Error('LLM returned invalid JSON. Try a stronger model or click Retry.')
    }
  }

  // --- reference images: upload + vision captioning -----------------------
  const fileToRef = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.onload = () => shrinkToJpeg(reader.result, REF_MAX_DIM, 0.85)
      .then(({ base64, mediaType }) => resolve({
        id: generateId(), base64, mediaType,
        previewUrl: `data:${mediaType};base64,${base64}`,
        fileName: file.name || 'reference.jpg', note: '', caption: '',
        hash: imageHash(base64),
      }))
      .catch(reject)
    reader.readAsDataURL(file)
  })

  const addRefFiles = async (fileList) => {
    const room = MAX_REF_IMAGES - refImages.length
    const files = Array.from(fileList || []).filter(f => f.type.startsWith('image/')).slice(0, room)
    const added = []
    for (const f of files) { try { added.push(await fileToRef(f)) } catch { /* skip bad file */ } }
    if (added.length) setRefImages(prev => [...prev, ...added])
  }

  const removeRefImage   = (id) => setRefImages(prev => prev.filter(im => im.id !== id))
  const updateRefNote    = (id, note)    => setRefImages(prev => prev.map(im => im.id === id ? { ...im, note } : im))
  const updateRefCaption = (id, caption) => setRefImages(prev => prev.map(im => im.id === id ? { ...im, caption } : im))

  // Describe every image lacking a caption (or all, with force). Returns the
  // updated array so runPhase1 can use it without waiting on setState.
  const captionRefImages = async ({ force = false } = {}) => {
    const targets = refImages.filter(im => im.base64 && (force || !im.caption?.trim()))
    if (!targets.length) return refImages
    if (!visModel) {
      setRefCaptionStatus({ state: 'error', done: 0, total: targets.length,
        error: 'No vision model available — pick or type one in the left rail.' })
      throw new Error('no vision model')
    }
    setRefCaptionStatus({ state: 'reading', done: 0, total: targets.length, error: '' })
    let done = 0
    const settled = await Promise.allSettled(targets.map(async (im) => {
      const content = [
        { type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.base64 } },
        { type: 'text', text: im.note && im.note.trim()
          ? `Describe this reference image as instructed. The user's note on how it will be used: "${im.note.trim()}".`
          : 'Describe this reference image as instructed.' },
      ]
      const { text } = await callOllama(visModel, content, VISION_PROMPT_SCRIPTWRITER, cfg, 0.3)
      done++; setRefCaptionStatus(s => ({ ...s, done }))
      return { id: im.id, caption: (text || '').trim() }
    }))
    const byId = new Map()
    settled.forEach(r => { if (r.status === 'fulfilled') byId.set(r.value.id, r.value.caption) })
    const failed = settled.filter(r => r.status === 'rejected')
    const updated = refImages.map(im => byId.has(im.id) ? { ...im, caption: byId.get(im.id) } : im)
    setRefImages(updated)
    setRefCaptionStatus(failed.length
      ? { state: 'error', done, total: targets.length,
          error: `${failed.length} image${failed.length === 1 ? '' : 's'} couldn't be described: ${failed[0].reason?.message || 'unknown error'}` }
      : { state: 'idle', done, total: targets.length, error: '' })
    return updated
  }

  // --- history payload assembly (shared by all four save sites) -----------
  const basePayload = (phaseName, refsOverride) => {
    const refs = refsOverride || refImages
    return {
      id: sessionId.current, ts: Date.now(), type: 'scriptwriter',
      model: writerModel,
      vision: refs.some(im => im.caption && im.caption.trim()) ? visModel : null,
      idea: idea.trim(), genre, sceneCount, phase: phaseName,
      refImages: serializeRefImages(refs),
    }
  }

  const commitHistory = (payload) => {
    if (!onSaveHistory) return
    const { payload: safe, dropped, droppedRefs } = guardHistorySize(payload)
    const notes = []
    if (droppedRefs) notes.push(`${droppedRefs} reference image${droppedRefs === 1 ? '' : 's'} kept as description only — the record was too large to store the pixels`)
    if (dropped)     notes.push(`${dropped} attached frame image${dropped === 1 ? '' : 's'} couldn't be saved to history`)
    setHistoryNote(notes.join('. '))
    onSaveHistory(safe)
  }

  const runPhase1 = async () => {
    if (!idea.trim()) return
    setError(''); setRawFallback('')
    let refs = refImages
    if (refImages.some(im => im.base64 && !im.caption?.trim())) {
      try { refs = await captionRefImages() }
      catch {
        setError('Could not read the reference images (see the note above). Fix the vision model or remove the images to continue.')
        return
      }
    }
    setPhase('scripting')
    const genreHint = genre === 'auto' ? 'Infer a suitable genre from the story idea.' : `Genre: ${genre}`
    const refBlock = assembleRefBlock(refs, REF_HEADING_CANON)
    const userMsg = `Story idea: ${idea.trim()}\n${genreHint}\nNumber of scenes: ${sceneCount}${refBlock}\n\nOutput only valid JSON.`
    try {
      const { text } = await callOllama(writerModel, userMsg, SYSTEM_PROMPT_SCRIPTWRITER, cfg, 0.7, { format: 'json' })
      const data = parseJSON(text)
      setScript(data)
      setPhase('script')
      commitHistory({ ...basePayload('script', refs), script: data, directorsCut: null, finalPrompts: null })
    } catch (e) {
      setError(e.message)
      setPhase('input')
    }
  }

  const runPhase2 = async () => {
    setError(''); setRawFallback('')
    setPhase('directing')
    const refBlock = assembleRefBlock(refImages, REF_HEADING_DIRECTOR)
    const userMsg = `Script:\n${JSON.stringify(script, null, 2)}${refBlock}\n\nOutput only valid JSON.`
    try {
      const { text } = await callOllama(writerModel, userMsg, SYSTEM_PROMPT_DIRECTOR, cfg, 0.7, { format: 'json' })
      const data = parseJSON(text)
      data.shots = data.shots.map(s => ({ ...s, duration: s.duration || 4 }))
      const freshFrames = data.shots.map(() => emptyFrameEntry())
      setDirectorsCut(data)
      setFramePrompts(freshFrames)
      setPhase('dircut')
      commitHistory({
        ...basePayload('dircut'),
        script, directorsCut: data, finalPrompts: null,
        framePrompts: serializeFramePrompts(freshFrames),
      })
    } catch (e) {
      setError(e.message)
      setPhase('script')
    }
  }

  const runPhase3 = async () => {
    setError('')
    const shots = directorsCut.shots
    const initial = shots.map(s => ({
      shotNumber: s.shot_number, sceneTitle: s.scene_title,
      text: '', usage: null, loading: true, error: '',
    }))
    setFinalPrompts(initial)
    setPhase('prompting')

    const refBlock = assembleRefBlock(refImages, REF_HEADING_SHOT)
    const results = new Array(shots.length)
    const proms = shots.map((shot, i) => {
      const userMsg = `Target duration: ${shot.duration || 4} seconds\n\nBasic scene description:\n${shot.visual_action}\n\nRequested camera moves (incorporate these):\n- ${shot.camera_movement}\n- ${shot.camera_framing}\n\nStyle / mood: ${shot.lighting_mood}${refBlock}`
      return callOllama(writerModel, userMsg, SHOT_SYSTEM_PROMPT, cfg, 0.7)
        .then(({ text, usage }) => {
          setFinalPrompts(prev => prev.map((p, idx) => idx === i ? { ...p, text, usage, loading: false } : p))
          results[i] = { shotNumber: shot.shot_number, sceneTitle: shot.scene_title, text }
        })
        .catch(e => {
          setFinalPrompts(prev => prev.map((p, idx) => idx === i ? { ...p, loading: false, error: e.message } : p))
          results[i] = { shotNumber: shot.shot_number, sceneTitle: shot.scene_title, text: '' }
        })
    })
    await Promise.all(proms)
    setPhase('done')
    commitHistory({
      ...basePayload('done'),
      script, directorsCut, finalPrompts: results,
      framePrompts: serializeFramePrompts(framePrompts),
    })
  }

  // Scene editing helpers
  const updateScene = (si, field_, val) => setScript(prev => ({
    ...prev, scenes: prev.scenes.map((s, i) => i === si ? { ...s, [field_]: val } : s),
  }))
  const updateDialogue = (si, di, val) => setScript(prev => ({
    ...prev, scenes: prev.scenes.map((s, i) => i === si
      ? { ...s, dialogues: s.dialogues.map((d, j) => j === di ? val : d) } : s),
  }))
  const addDialogue = (si) => setScript(prev => ({
    ...prev, scenes: prev.scenes.map((s, i) => i === si ? { ...s, dialogues: [...s.dialogues, ''] } : s),
  }))
  const removeDialogue = (si, di) => setScript(prev => ({
    ...prev, scenes: prev.scenes.map((s, i) => i === si
      ? { ...s, dialogues: s.dialogues.filter((_, j) => j !== di) } : s),
  }))

  // Shot editing helpers
  const updateShot = (si, field_, val) => setDirectorsCut(prev => ({
    ...prev, shots: prev.shots.map((s, i) => i === si ? { ...s, [field_]: val } : s),
  }))

  // Frame prompt helpers
  const generateFramePrompt = async (shotIdx, frameKey) => {
    const shot = directorsCut.shots[shotIdx]
    const target = framePrompts[shotIdx].frames[frameKey].target
    const framePos = frameKey === 'first' ? 'start (first)' : frameKey === 'mid' ? 'middle' : 'end (last)'
    // SDXL's writer is tag-based — a prose continuity block confuses it, so skip it there.
    const refBlock = target === 'sdxl' ? '' : assembleRefBlock(refImages, REF_HEADING_LITE)
    const userMsg = `Generate a still image prompt for the ${framePos} frame of a ${shot.duration || 4}-second video clip.\n\nShot ${shot.shot_number} — ${shot.scene_title}\nCamera framing: ${shot.camera_framing}\nLighting/mood: ${shot.lighting_mood}\nVisual action: ${shot.visual_action}\n\nThis is the ${framePos} of the clip. Describe the exact visual state at this moment as a still image.${refBlock}`

    setFramePrompts(prev => prev.map((fp, i) => i !== shotIdx ? fp : {
      ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], loading: true, error: '' } }
    }))
    try {
      const { text } = await callOllama(writerModel, userMsg, FRAME_SYSTEM[target], cfg, 0.7)
      setFramePrompts(prev => prev.map((fp, i) => i !== shotIdx ? fp : {
        ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], text, loading: false } }
      }))
    } catch (e) {
      setFramePrompts(prev => prev.map((fp, i) => i !== shotIdx ? fp : {
        ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], loading: false, error: e.message } }
      }))
    }
  }

  const setFrameTarget = (shotIdx, frameKey, target) => {
    setFramePrompts(prev => prev.map((fp, i) => i !== shotIdx ? fp : {
      ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], target } }
    }))
  }

  const editFramePrompt = (shotIdx, frameKey, val) => {
    setFramePrompts(prev => prev.map((fp, i) => i !== shotIdx ? fp : {
      ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], text: val } }
    }))
  }

  // Pushes one generated frame-image prompt to the Prompt Enhancer Bridge node
  // pack in ComfyUI (same slot mechanism the main app's "→ ComfyUI" button uses).
  // No input images in the scriptwriter flow, so the shot carries an empty image set.
  const sendFrameToComfy = async (shotIdx, frameKey) => {
    const fp = framePrompts[shotIdx]?.frames[frameKey]
    if (!fp?.text) return
    const shot = directorsCut.shots[shotIdx]
    const ck = `${shotIdx}-${frameKey}`
    setComfyFrame({ key: ck, state: 'sending', error: '' })
    try {
      await sendShot({
        positive: fp.text, negative: '', target: fp.target,
        duration: shot.duration || 4, frameMode: 'single',
        shot: shot.shot_number, scene: shot.scene_title, frame: frameKey,
        images: { first: '', mid: '', last: '', ref: [] },
      }, comfyCfg.url, comfyCfg.slot)
      setComfyFrame({ key: ck, state: 'done', error: '' })
      setTimeout(() => setComfyFrame(prev =>
        prev.key === ck && prev.state === 'done' ? { key: null, state: 'idle', error: '' } : prev), 2500)
    } catch (e) {
      setComfyFrame({ key: ck, state: 'error', error: e.message })
    }
  }

  // Trim a would-be-oversized history payload. Reference-image bytes go first
  // (their caption text carries what the pipeline needs), then the largest
  // attached frame images. Returns { payload, dropped, droppedRefs }.
  const guardHistorySize = (payload) => {
    if (JSON.stringify(payload).length <= HISTORY_SOFT_LIMIT) return { payload, dropped: 0, droppedRefs: 0 }
    const clone = JSON.parse(JSON.stringify(payload))
    let droppedRefs = 0
    for (const im of (clone.refImages || [])) {
      if (JSON.stringify(clone).length <= HISTORY_SOFT_LIMIT) break
      if (im.base64) { im.base64 = null; droppedRefs++ }
    }
    const imgs = []
    ;(clone.framePrompts || []).forEach((fp, si) => FRAME_KEYS.forEach(k => {
      const im = fp.frames?.[k]?.image
      if (im?.b64) imgs.push({ si, k, len: im.b64.length })
    }))
    imgs.sort((a, b) => b.len - a.len)
    let dropped = 0
    for (const it of imgs) {
      if (JSON.stringify(clone).length <= HISTORY_SOFT_LIMIT) break
      clone.framePrompts[it.si].frames[it.k].image = null
      dropped++
    }
    return { payload: clone, dropped, droppedRefs }
  }

  // Re-save the whole session under the same id at the CURRENT phase — used after
  // a frame image is attached or removed between phases. Pass the just-computed
  // framePrompts array to sidestep the state-update lag.
  const persistState = (framePromptsOverride) => {
    if (!onSaveHistory || !directorsCut) return
    commitHistory({
      ...basePayload(phase),
      script, directorsCut,
      finalPrompts: (phase === 'done' || phase === 'prompting') && finalPrompts.length
        ? finalPrompts.map(p => ({ shotNumber: p.shotNumber, sceneTitle: p.sceneTitle, text: p.text || '', usage: p.usage || null }))
        : null,
      framePrompts: serializeFramePrompts(framePromptsOverride || framePrompts),
    })
  }

  // --- pull a rendered image back from ComfyUI --------------------------------
  const loadPickerItems = async (key) => {
    setPicker({ key, loading: true, error: '', items: [] })
    try {
      const items = await fetchComfyOutputs(comfyCfg.url, { max: 24 })
      setPicker({ key, loading: false, error: items.length ? '' : 'No recent ComfyUI outputs found. Render one first, then Refresh.', items })
    } catch (e) {
      setPicker({ key, loading: false, error: e.message, items: [] })
    }
  }

  const openPicker = (shotIdx, frameKey) => {
    const key = `${shotIdx}-${frameKey}`
    if (picker.key === key) { setPicker({ key: null, loading: false, error: '', items: [] }); return }
    loadPickerItems(key)
  }

  const attachImage = async (shotIdx, frameKey, item) => {
    const key = `${shotIdx}-${frameKey}`
    setAttach({ key, state: 'fetching', error: '' })
    try {
      const blob = await fetchComfyImageBlob(item.viewUrl)
      const { base64, mediaType, width, height } = await shrinkToJpeg(blob, 1536, 0.85)
      const image = {
        b64: base64, mediaType, width, height,
        source: { filename: item.filename, subfolder: item.subfolder, type: item.type },
        ts: Date.now(),
      }
      const next = framePrompts.map((fp, i) => i !== shotIdx ? fp : {
        ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], image } },
      })
      setFramePrompts(next)
      setAttach({ key: null, state: 'idle', error: '' })
      setPicker({ key: null, loading: false, error: '', items: [] })
      persistState(next)
    } catch (e) {
      setAttach({ key, state: 'error', error: e.message })
    }
  }

  const removeFrameImage = (shotIdx, frameKey) => {
    const next = framePrompts.map((fp, i) => i !== shotIdx ? fp : {
      ...fp, frames: { ...fp.frames, [frameKey]: { ...fp.frames[frameKey], image: null } },
    })
    setFramePrompts(next)
    persistState(next)
  }

  const copyAll = () => {
    const text = finalPrompts.filter(p => p.text).map(p => p.text).join('\n\n---\n\n')
    navigator.clipboard.writeText(text)
    setCopiedAll(true)
    setTimeout(() => setCopiedAll(false), 2000)
  }
  const copyOne = (idx) => {
    navigator.clipboard.writeText(finalPrompts[idx].text)
    setCopied(idx)
    setTimeout(() => setCopied(null), 2000)
  }
  const editPrompt = (idx, val) => setFinalPrompts(prev => prev.map((p, i) => i === idx ? { ...p, text: val } : p))

  const stepIdx = ['input', 'scripting'].includes(phase) ? 0
    : ['script', 'directing'].includes(phase) ? 1
    : 2

  const isLoading = ['scripting', 'directing', 'prompting'].includes(phase)

  const focusBorder = (e) => { e.target.style.borderColor = 'var(--pe-accent)' }
  const blurBorder  = (e) => { e.target.style.borderColor = 'var(--pe-line)' }

  return (
    <div>
      {/* Phase stepper */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24 }}>
        {STEPS.map((step, i) => (
          <div key={step} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{
                width: 22, height: 22, borderRadius: '50%', border: '2px solid',
                borderColor: i <= stepIdx ? 'var(--pe-accent)' : 'var(--pe-line)',
                background: i < stepIdx ? 'var(--pe-accent)' : i === stepIdx ? 'var(--pe-accent-bg)' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13.5, color: i <= stepIdx ? 'var(--pe-accent-ink)' : 'var(--pe-line)', fontWeight: 700, flexShrink: 0,
              }}>
                {i < stepIdx ? '✓' : i + 1}
              </div>
              <span style={{ fontSize: 13, color: i <= stepIdx ? 'var(--pe-accent-ink)' : 'var(--pe-line)', fontWeight: i === stepIdx ? 600 : 400 }}>
                {step}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ width: 32, height: 1, background: i < stepIdx ? 'var(--pe-accent)' : 'var(--pe-line)', margin: '0 8px' }} />
            )}
          </div>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{ marginBottom: 16, padding: '12px 14px', background: 'var(--pe-danger-bg)', border: '1px solid var(--pe-danger-line)', borderRadius: 8, fontSize: 13, color: 'var(--pe-danger)' }}>
          {error}
          {rawFallback && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', marginBottom: 6 }}>Raw LLM output:</div>
              <textarea readOnly value={rawFallback} rows={6}
                style={{ ...field({ background: 'var(--pe-danger-bg)', color: 'var(--pe-danger)', fontSize: 13, fontFamily: 'monospace', resize: 'vertical' }) }} />
            </div>
          )}
        </div>
      )}

      {/* Reference images — editable pre-script, read-only after */}
      <ScriptwriterRefImages
        images={refImages}
        editable={['input', 'scripting'].includes(phase)}
        status={refCaptionStatus}
        busy={isLoading || captioning}
        max={MAX_REF_IMAGES}
        onAddFiles={addRefFiles}
        onRemove={removeRefImage}
        onNote={updateRefNote}
        onCaption={updateRefCaption}
        onDescribe={(force) => captionRefImages({ force }).catch(() => {})}
      />

      {/* Phase 1 — input */}
      {['input', 'scripting'].includes(phase) && (
        <div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Story Idea</label>
            <textarea value={idea} onChange={e => setIdea(e.target.value)} rows={4} disabled={isLoading}
              placeholder="e.g. A retired deep-sea diver finds a mysterious package washed ashore — and recognizes the handwriting on it as her own."
              style={{ ...field({ resize: 'vertical' }) }}
              onFocus={focusBorder} onBlur={blurBorder} />
          </div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 20 }}>
            <div>
              <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Genre</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {GENRE_OPTIONS.map(g => (
                  <button key={g.id} onClick={() => setGenre(g.id)} disabled={isLoading} style={btn(genre === g.id)}>{g.label}</button>
                ))}
              </div>
            </div>
            <div>
              <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Scenes</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => setSceneCount(v => Math.max(1, v - 1))} disabled={isLoading || sceneCount <= 1}
                  style={{ ...btn(false), padding: '4px 12px', fontSize: 15 }}>−</button>
                <span style={{ fontSize: 15, color: 'var(--pe-accent-ink)', fontWeight: 600, minWidth: 18, textAlign: 'center' }}>{sceneCount}</span>
                <button onClick={() => setSceneCount(v => Math.min(5, v + 1))} disabled={isLoading || sceneCount >= 5}
                  style={{ ...btn(false), padding: '4px 12px', fontSize: 15 }}>+</button>
              </div>
            </div>
          </div>
          <button onClick={runPhase1} disabled={!idea.trim() || isLoading || captioning} style={genBtn(!idea.trim() || isLoading || captioning)}>
            {captioning ? '👁 Reading reference images…' : phase === 'scripting' ? '✦ Writing script…' : '✦ Write Script'}
          </button>
        </div>
      )}

      {/* Phase 2 — script review */}
      {['script', 'directing'].includes(phase) && script && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <label style={lbl}>Film Title</label>
            <input value={script.title} onChange={e => setScript(s => ({ ...s, title: e.target.value }))}
              style={{ ...field({ fontSize: 15, fontWeight: 600, color: 'var(--pe-ink)' }) }}
              onFocus={focusBorder} onBlur={blurBorder} />
          </div>
          {script.scenes.map((scene, si) => (
            <div key={si} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 13.5, color: 'var(--pe-accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', flexShrink: 0 }}>
                  Scene {scene.id}
                </span>
                <input value={scene.title} onChange={e => updateScene(si, 'title', e.target.value)}
                  style={{ ...field({ flex: 1, fontWeight: 600 }) }}
                  onFocus={focusBorder} onBlur={blurBorder} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Setting</label>
                <input value={scene.setting} onChange={e => updateScene(si, 'setting', e.target.value)}
                  style={{ ...field({ fontFamily: 'monospace', fontSize: 13.5 }) }}
                  onFocus={focusBorder} onBlur={blurBorder} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Description</label>
                <textarea value={scene.description} onChange={e => updateScene(si, 'description', e.target.value)} rows={3}
                  style={{ ...field({ resize: 'vertical' }) }}
                  onFocus={focusBorder} onBlur={blurBorder} />
              </div>
              <div>
                <label style={lbl}>Dialogue</label>
                {scene.dialogues.map((line, di) => (
                  <div key={di} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                    <input value={line} onChange={e => updateDialogue(si, di, e.target.value)}
                      style={{ ...field({ flex: 1, fontFamily: 'monospace', fontSize: 13.5 }) }}
                      onFocus={focusBorder} onBlur={blurBorder} />
                    <button onClick={() => removeDialogue(si, di)}
                      style={{ padding: '4px 9px', borderRadius: 5, border: '1px solid var(--pe-line)', background: 'none', color: 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>
                      ✕
                    </button>
                  </div>
                ))}
                <button onClick={() => addDialogue(si)}
                  style={{ fontSize: 13, color: 'var(--pe-accent)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '3px 10px', cursor: 'pointer', marginTop: 2 }}>
                  + Add line
                </button>
              </div>
            </div>
          ))}
          <button onClick={runPhase2} disabled={phase === 'directing'} style={{ ...genBtn(phase === 'directing'), marginTop: 6 }}>
            {phase === 'directing' ? "✦ Writing director's cut…" : "→ Director's Cut"}
          </button>
        </div>
      )}

      {/* Phase 3 — director's cut review */}
      {['dircut', 'prompting', 'done'].includes(phase) && directorsCut && (
        <div>
          {framePrompts.some(fp => fp && FRAME_KEYS.some(k => fp.frames[k].text)) && (
            <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ ...lbl, margin: 0 }}>ComfyUI</span>
              <input value={comfyCfg.url}
                onChange={e => setComfyCfg({ ...comfyCfg, url: e.target.value })}
                placeholder="http://127.0.0.1:8188"
                style={{ ...field({ width: 200, fontSize: 13 }) }}
                onFocus={focusBorder} onBlur={blurBorder} />
              <input value={comfyCfg.slot}
                onChange={e => setComfyCfg({ ...comfyCfg, slot: e.target.value })}
                placeholder="default"
                style={{ ...field({ width: 100, fontSize: 13 }) }}
                onFocus={focusBorder} onBlur={blurBorder} />
              <span style={{ fontSize: 12.5, color: 'var(--pe-ink-3)' }}>
                push slot for → ComfyUI · also the source for ＋ Attach image (needs --enable-cors-header)
              </span>
            </div>
          )}
          {historyNote && (
            <div style={{ ...card, fontSize: 12.5, color: 'var(--pe-danger)', background: 'var(--pe-danger-bg)', borderColor: 'var(--pe-danger-line)' }}>
              {historyNote}
            </div>
          )}
          {directorsCut.shots.map((shot, si) => (
            <div key={si} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 13.5, color: 'var(--pe-accent)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', flexShrink: 0 }}>
                  Shot {shot.shot_number}
                </span>
                <span style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>{shot.scene_title}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={lbl}>Camera Framing</label>
                  <input value={shot.camera_framing} onChange={e => updateShot(si, 'camera_framing', e.target.value)}
                    style={field()} onFocus={focusBorder} onBlur={blurBorder} />
                </div>
                <div>
                  <label style={lbl}>Camera Movement</label>
                  <input value={shot.camera_movement} onChange={e => updateShot(si, 'camera_movement', e.target.value)}
                    style={field()} onFocus={focusBorder} onBlur={blurBorder} />
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Lighting / Mood</label>
                <input value={shot.lighting_mood} onChange={e => updateShot(si, 'lighting_mood', e.target.value)}
                  style={field()} onFocus={focusBorder} onBlur={blurBorder} />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Visual Action</label>
                <textarea value={shot.visual_action} onChange={e => updateShot(si, 'visual_action', e.target.value)} rows={2}
                  style={{ ...field({ resize: 'vertical' }) }} onFocus={focusBorder} onBlur={blurBorder} />
              </div>

              {/* Duration */}
              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Duration</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[4, 8, 12, 16, 20].map(s => (
                    <button key={s} onClick={() => updateShot(si, 'duration', s)}
                      style={btn(shot.duration === s || (!shot.duration && s === 4))}>
                      {s}s
                    </button>
                  ))}
                </div>
              </div>

              {/* Frame image prompts */}
              {framePrompts[si] && (
                <div style={{ marginTop: 4, borderTop: '1px solid var(--pe-line-soft)', paddingTop: 12 }}>
                  <label style={lbl}>Frame Image Prompts</label>
                  {FRAME_KEYS.map(fk => {
                    const fp = framePrompts[si].frames[fk]
                    const ck = `${si}-${fk}`
                    return (
                      <div key={fk} style={{ marginBottom: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 5 }}>
                          <span style={{ fontSize: 13, color: 'var(--pe-accent-ink)', fontWeight: 600, minWidth: 72 }}>
                            {FRAME_LABELS[fk]}
                          </span>
                          {FRAME_TARGETS.map(t => (
                            <button key={t.id} onClick={() => setFrameTarget(si, fk, t.id)}
                              style={btn(fp.target === t.id)}>{t.label}</button>
                          ))}
                          <button onClick={() => generateFramePrompt(si, fk)} disabled={fp.loading}
                            style={{
                              marginLeft: 'auto', padding: '4px 12px', borderRadius: 6, border: 'none',
                              background: fp.loading ? 'var(--pe-line)' : 'var(--pe-accent)',
                              color: fp.loading ? 'var(--pe-ink-3)' : 'var(--pe-accent-ink)', fontSize: 13,
                              cursor: fp.loading ? 'not-allowed' : 'pointer',
                            }}>
                            {fp.loading ? 'Generating…' : fp.text ? 'Regenerate' : 'Generate'}
                          </button>
                          {fp.text && !fp.loading && (
                            <button onClick={() => {
                              navigator.clipboard.writeText(fp.text)
                              setCopiedFrame(ck)
                              setTimeout(() => setCopiedFrame(null), 2000)
                            }}
                              style={{
                                padding: '4px 10px', borderRadius: 6, border: '1px solid var(--pe-line)',
                                background: copiedFrame === ck ? 'var(--pe-ok-bg)' : 'var(--pe-surface)',
                                color: copiedFrame === ck ? 'var(--pe-ok)' : 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer',
                              }}>
                              {copiedFrame === ck ? '✓' : 'Copy'}
                            </button>
                          )}
                          {fp.text && !fp.loading && (() => {
                            const cs = comfyFrame.key === ck ? comfyFrame.state : 'idle'
                            return (
                              <button onClick={() => sendFrameToComfy(si, fk)}
                                disabled={comfyFrame.state === 'sending'}
                                title={cs === 'error' ? comfyFrame.error
                                  : `Pushes this ${FRAME_LABELS[fk].toLowerCase()} prompt to ComfyUI slot "${comfyCfg.slot || 'default'}" for the Prompt Enhancer Bridge nodes to read.`}
                                style={{
                                  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--pe-line)',
                                  background: cs === 'done' ? 'var(--pe-ok-bg)' : cs === 'error' ? 'var(--pe-danger-bg)' : 'var(--pe-surface)',
                                  color: cs === 'done' ? 'var(--pe-ok)' : cs === 'error' ? 'var(--pe-danger)' : 'var(--pe-ink-3)',
                                  fontSize: 13, cursor: comfyFrame.state === 'sending' ? 'wait' : 'pointer',
                                }}>
                                {cs === 'sending' ? 'Sending…' : cs === 'done' ? '✓ Sent' : cs === 'error' ? '✕ Failed' : '→ ComfyUI'}
                              </button>
                            )
                          })()}
                          {fp.text && !fp.loading && (
                            <button onClick={() => openPicker(si, fk)}
                              title="Pick a rendered image from ComfyUI's recent outputs and attach it to this frame."
                              style={{
                                padding: '4px 10px', borderRadius: 6, border: '1px solid var(--pe-line)',
                                background: picker.key === ck ? 'var(--pe-accent-bg)' : 'var(--pe-surface)',
                                color: picker.key === ck ? 'var(--pe-accent-ink)' : 'var(--pe-ink-3)',
                                fontSize: 13, cursor: 'pointer',
                              }}>
                              {fp.image ? '🖼 Change image' : '＋ Attach image'}
                            </button>
                          )}
                        </div>
                        {fp.error && <div style={{ fontSize: 13.5, color: 'var(--pe-danger)', marginBottom: 4 }}>{fp.error}</div>}
                        {fp.text && (
                          <textarea value={fp.text} onChange={e => editFramePrompt(si, fk, e.target.value)}
                            rows={Math.max(3, Math.ceil(fp.text.length / 80))} spellCheck={false}
                            style={{
                              width: '100%', boxSizing: 'border-box', background: 'var(--pe-rail)',
                              border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 12px',
                              fontSize: 13.5, lineHeight: 1.7, color: 'var(--pe-accent-ink)',
                              fontFamily: 'var(--pe-mono)', resize: 'vertical', outline: 'none',
                              transition: 'border-color 0.15s',
                            }}
                            onFocus={focusBorder} onBlur={blurBorder} />
                        )}

                        {fp.image && (
                          <div style={{ marginTop: 8 }}>
                            <img src={`data:${fp.image.mediaType};base64,${fp.image.b64}`} alt={`${FRAME_LABELS[fk]} render`}
                              style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 8, border: '1px solid var(--pe-line)', display: 'block' }} />
                            <div style={{ display: 'flex', gap: 8, marginTop: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12, color: 'var(--pe-ink-3)' }}>
                                {fp.image.width}×{fp.image.height} · {fp.image.source?.filename}
                              </span>
                              <button onClick={() => openPicker(si, fk)} style={ghostBtn}>Replace</button>
                              <a href={`data:${fp.image.mediaType};base64,${fp.image.b64}`}
                                download={fp.image.source?.filename || `shot${shot.shot_number}-${fk}.jpg`}
                                style={{ ...ghostBtn, textDecoration: 'none' }}>Download</a>
                              <button onClick={() => removeFrameImage(si, fk)} style={{ ...ghostBtn, color: 'var(--pe-danger)', borderColor: 'var(--pe-danger-line)' }}>Remove</button>
                            </div>
                          </div>
                        )}

                        {attach.key === ck && attach.state === 'fetching' && (
                          <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', marginTop: 6 }}>Fetching image…</div>
                        )}
                        {attach.key === ck && attach.state === 'error' && (
                          <div style={{ fontSize: 13, color: 'var(--pe-danger)', marginTop: 6 }}>{attach.error}</div>
                        )}

                        {picker.key === ck && (
                          <div style={{ marginTop: 8, padding: 10, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12.5, color: 'var(--pe-ink-3)' }}>
                                {picker.loading ? 'Loading recent ComfyUI outputs…'
                                  : `${picker.items.length} recent output${picker.items.length === 1 ? '' : 's'} · newest first`}
                              </span>
                              <button onClick={() => loadPickerItems(ck)} disabled={picker.loading} style={ghostBtn}>Refresh</button>
                              <button onClick={() => setPicker({ key: null, loading: false, error: '', items: [] })} style={{ ...ghostBtn, marginLeft: 'auto' }}>Close</button>
                            </div>
                            {picker.error && <div style={{ fontSize: 13, color: 'var(--pe-danger)', marginBottom: 6 }}>{picker.error}</div>}
                            {picker.items.length > 0 && (
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                                {picker.items.map((it, ii) => (
                                  <img key={ii} src={it.viewUrl} loading="lazy" alt={it.filename}
                                    title={`${it.filename}${it.subfolder ? ` (${it.subfolder})` : ''}${it.type === 'temp' ? ' · preview' : ''}`}
                                    onClick={() => attachImage(si, fk, it)}
                                    style={{
                                      width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6,
                                      border: '1px solid var(--pe-line)', cursor: 'pointer', background: 'var(--pe-surface)',
                                    }} />
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ))}

          {phase === 'dircut' && (
            <button onClick={runPhase3} style={{ ...genBtn(false), marginTop: 6 }}>
              → Generate LTX Prompts
            </button>
          )}

          {/* Final LTX prompts */}
          {['prompting', 'done'].includes(phase) && finalPrompts.length > 0 && (
            <div style={{ marginTop: 28 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>LTX-2.3 Prompts</label>
                {phase === 'done' && (
                  <button onClick={copyAll}
                    style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid var(--pe-line)', background: copiedAll ? 'var(--pe-ok-bg)' : 'var(--pe-surface)', color: copiedAll ? 'var(--pe-ok)' : 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer' }}>
                    {copiedAll ? '✓ Copied all' : 'Copy all'}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {finalPrompts.map((p, i) => (
                  <div key={i}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div>
                        <span style={{ fontSize: 13, color: 'var(--pe-accent)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>Shot {p.shotNumber}</span>
                        <span style={{ fontSize: 13, color: 'var(--pe-ink-3)', marginLeft: 8 }}>{p.sceneTitle}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {p.usage && <span style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>in {p.usage.input_tokens} · out {p.usage.output_tokens} tokens</span>}
                        {p.text && !p.loading && (
                          <button onClick={() => copyOne(i)}
                            style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--pe-line)', background: copied === i ? 'var(--pe-ok-bg)' : 'var(--pe-surface)', color: copied === i ? 'var(--pe-ok)' : 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer' }}>
                            {copied === i ? '✓ Copied' : 'Copy'}
                          </button>
                        )}
                      </div>
                    </div>
                    {p.loading && (
                      <div style={{ padding: '18px 20px', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, fontSize: 13, color: 'var(--pe-ink-3)' }}>Generating…</div>
                    )}
                    {p.error && (
                      <div style={{ padding: '12px 14px', background: 'var(--pe-danger-bg)', border: '1px solid var(--pe-danger-line)', borderRadius: 8, fontSize: 13, color: 'var(--pe-danger)' }}>Error: {p.error}</div>
                    )}
                    {p.text && (
                      <textarea value={p.text} onChange={e => editPrompt(i, e.target.value)}
                        rows={Math.max(4, Math.ceil(p.text.length / 70))} spellCheck={false}
                        style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '18px 20px', fontSize: 13.5, lineHeight: 1.8, color: 'var(--pe-ink)', whiteSpace: 'pre-wrap', fontFamily: 'var(--pe-mono)', resize: 'vertical', outline: 'none', transition: 'border-color 0.15s' }}
                        onFocus={focusBorder} onBlur={blurBorder} />
                    )}
                  </div>
                ))}
              </div>
              {phase === 'done' && (
                <button onClick={reset}
                  style={{ marginTop: 20, padding: '8px 18px', borderRadius: 8, border: '1px solid var(--pe-line)', background: 'none', color: 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer' }}>
                  ← Start over
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

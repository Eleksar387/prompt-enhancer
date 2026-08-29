import { useState, useRef, useEffect, useCallback } from 'react'
import JSZip from 'jszip'
import {
  TARGETS, DURATION_OPTIONS, OUTPUT_COUNT_OPTIONS, VARIANT_TEMPS, VARIANT_NUDGES,
  STYLE_OPTIONS, CREATIVITY_OPTIONS, CAMERA_GROUPS,
  PROMPT_LENGTH_OPTIONS, PROMPT_LENGTH_INJECT,
  VISION_PROMPT_LTX_SINGLE, VISION_PROMPT_LTX_FIRSTLAST, VISION_PROMPT_LTX_FIRSTMIDLAST,
  DEFAULT_FRAME_MODE_OPTIONS, VISION_PROMPT_MINIMAX_H3_REF,
  MINIMAX_H3_REF_ROLES, MINIMAX_H3_PRESERVE_OPTIONS,
  systemPromptFor,
} from './constants'
import { loadCfg, saveCfg, callOllama, fetchModels, pickWriter, pickVision, isAnthropic, isGrok } from './api'
import { loadComfyCfg, saveComfyCfg, uploadImage as uploadComfyImage } from './comfy'
import {
  getAllHistory, addHistoryEntry, deleteHistoryEntry,
  clearHistory as dbClearHistory, generateId, migrateFromLocalStorage,
} from './db'
import { btn, selStyle, moveLabel, presetById, syllableBudget } from './utils'
import ConfigBar from './components/ConfigBar'
import ImagePanel from './components/ImagePanel'
import ScriptwriterPanel from './components/ScriptwriterPanel'
import MinimaxRefPanel from './components/MinimaxRefPanel'

const buildVariants = (writer) => VARIANT_TEMPS.map((temp, i) => ({
  label: `${writer} · T${temp}`,
  temp,
  nudge: VARIANT_NUDGES[i] || '',
}))

export default function App() {
  const [cfg, setCfg]                 = useState(loadCfg)
  const [models, setModels]           = useState([])
  const [modelStatus, setModelStatus] = useState({ loading: true, ok: false, error: '' })
  const [comfyCfg, setComfyCfg]       = useState(loadComfyCfg)
  const [comfyCopyStatus, setComfyCopyStatus] = useState({ state: 'idle' })

  const [target, setTarget]           = useState('minimax_h3')
  const [scene, setScene]             = useState('')
  const [duration, setDuration]       = useState('8 seconds')
  const [writerModel, setWriterModel] = useState('')
  const [visionModel, setVisionModel] = useState('grok-4.6')
  const [writerManual, setWriterManual] = useState('mistral-nemo')
  const [visionManual, setVisionManual] = useState('grok-4.6')
  const [outputCount, setOutputCount] = useState(1)
  const [style, setStyle]             = useState('nsfw')
  const [creativity, setCreativity]   = useState('balanced')
  const [promptLength, setPromptLength] = useState('standard')
  const [negative, setNegative]       = useState('')
  const [dialogue, setDialogue]       = useState('')
  const [delivery, setDelivery]       = useState('')
  const [frameMode, setFrameMode]     = useState(() => TARGETS['minimax_h3'].defaultFrameMode || 'single')
  const [firstImg, setFirstImg]       = useState(null)
  const [midImg, setMidImg]           = useState(null)
  const [lastImg, setLastImg]         = useState(null)
  const [refImages, setRefImages]     = useState([])
  const [refAudio, setRefAudio]       = useState(null)
  const [soundscape, setSoundscape]   = useState('')
  const [music, setMusic]             = useState('')
  const [h3RatioId, setH3RatioId]     = useState(
    TARGETS['minimax_h3'].defaultFrameMode === 'ref' ? 'port916' : ''
  )
  const [cameraOpen, setCameraOpen]   = useState(false)
  const [flashId, setFlashId]         = useState(null)
  const [results, setResults]         = useState([])
  const [caption, setCaption]         = useState('')
  const [visionBusy, setVisionBusy]   = useState(false)
  const [globalError, setGlobalError] = useState('')
  const [copied, setCopied]           = useState(null)
  const [history, setHistory]         = useState([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [adminMode, setAdminMode]     = useState(false)
  const [adminSystem, setAdminSystem] = useState(() => systemPromptFor(TARGETS['minimax_h3'], 'single'))
  const [adminSystemOpen, setAdminSystemOpen] = useState(false)
  const [adminUserMsg, setAdminUserMsg] = useState('')
  const [pendingSend, setPendingSend] = useState(false)
  const pendingSnapshotRef = useRef(null)
  const [scriptwriterKey, setScriptwriterKey] = useState(0)
  const [scriptwriterInitial, setScriptwriterInitial] = useState(null)
  const importInputRef = useRef(null)
  const visionCacheRef = useRef(null)
  const refCaptionCacheRef = useRef(new Map())
  const sceneTextareaRef = useRef(null)

  const t = TARGETS[target]
  const show = t.show
  const showImage = show.image !== false

  const effectiveWriter = models.length ? writerModel : writerManual.trim()
  const effectiveVision = models.length ? visionModel : visionManual.trim()

  // Skip the very first run: `cfg`'s initial value already includes any .env-derived
  // override (VITE_API_KEY/VITE_API_BASE) baked in by loadCfg(). Persisting that on
  // mount would silently clobber a saved provider choice every time .env forces one —
  // which is exactly what happened when a stray VITE_API_KEY kept resetting the saved
  // backend back to Anthropic. Only persist changes the user actually makes afterward.
  const cfgMountedRef = useRef(false)
  useEffect(() => {
    if (!cfgMountedRef.current) { cfgMountedRef.current = true; return }
    saveCfg(cfg)
  }, [cfg])
  useEffect(() => { saveComfyCfg(comfyCfg) }, [comfyCfg])
  useEffect(() => {
    migrateFromLocalStorage()
      .then(() => getAllHistory())
      .then(setHistory)
      .catch(() => {})
  }, [])

  const reloadModels = async () => {
    setModelStatus({ loading: true, ok: false, error: '' })
    try {
      const ids = await fetchModels(cfg)
      setModels(ids)
      setModelStatus({ loading: false, ok: true, error: '' })
      setWriterModel(prev => (prev && ids.includes(prev)) ? prev : pickWriter(ids))
      setVisionModel(prev => (prev && ids.includes(prev)) ? prev : pickVision(ids))
    } catch (e) {
      setModels([])
      setModelStatus({ loading: false, ok: false, error: e.message })
    }
  }
  useEffect(() => { reloadModels() }, [cfg.base, cfg.apiKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setAdminSystem(systemPromptFor(TARGETS[target], frameMode)); setPendingSend(false); setAdminUserMsg('') }, [target, frameMode])

  const refreshHistory = useCallback(() => getAllHistory().then(setHistory).catch(() => {}), [])

  const saveHistory = (snap, outputs) => {
    const entry = { ...snap, outputs, type: 'standard', id: generateId() }
    addHistoryEntry(entry).then(refreshHistory).catch(() => {})
  }
  const saveScriptHistory = useCallback((entry) => {
    addHistoryEntry(entry).then(refreshHistory).catch(() => {})
  }, [refreshHistory])

  const clearHistory = () => { dbClearHistory().then(() => setHistory([])).catch(() => setHistory([])) }
  const removeHistoryEntry = (id) => {
    deleteHistoryEntry(id).then(() => setHistory(prev => prev.filter(h => h.id !== id))).catch(() => {})
  }

  const exportHistory = () => {
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `prompt-enhancer-history-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
  const importHistory = async (file) => {
    try {
      const text = await file.text()
      const entries = JSON.parse(text)
      for (const entry of entries) { await addHistoryEntry(entry) }
      refreshHistory()
    } catch {}
  }

  const currentImages = () => {
    if (frameMode === 'ref') {
      return refImages.map((im, i) => ({ name: `reference-${i + 1}-${im.role}.jpg`, base64: im.base64 }))
    }
    if (frameMode === 'firstlast') {
      return [
        firstImg && { name: 'first-frame.jpg', base64: firstImg.base64 },
        lastImg && { name: 'last-frame.jpg', base64: lastImg.base64 },
      ].filter(Boolean)
    }
    if (frameMode === 'firstmidlast') {
      return [
        firstImg && { name: 'first-frame.jpg', base64: firstImg.base64 },
        midImg && { name: 'mid-frame.jpg', base64: midImg.base64 },
        lastImg && { name: 'last-frame.jpg', base64: lastImg.base64 },
      ].filter(Boolean)
    }
    if (frameMode === 'last') {
      return firstImg ? [{ name: 'last-frame.jpg', base64: firstImg.base64 }] : []
    }
    return firstImg ? [{ name: t.type === 'image' ? 'reference-image.jpg' : 'first-frame.jpg', base64: firstImg.base64 }] : []
  }

  const exportBundle = async () => {
    const zip = new JSZip()
    for (const img of currentImages()) zip.file(img.name, img.base64, { base64: true })
    results.forEach((r, i) => {
      if (r.text) zip.file(results.length === 1 ? 'prompt.txt' : `prompt-${i + 1}.txt`, r.text)
    })
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `prompt-enhancer-${target}-${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }

  // A previous copy's status shouldn't linger against a different set of loaded images.
  useEffect(() => { setComfyCopyStatus({ state: 'idle' }) }, [firstImg, midImg, lastImg, refImages])

  const copyImagesToComfy = async () => {
    const imgs = currentImages()
    if (!imgs.length) return
    setComfyCopyStatus({ state: 'sending' })
    try {
      for (const img of imgs) {
        await uploadComfyImage(img.base64, img.name, 'image/jpeg', comfyCfg.url)
      }
      setComfyCopyStatus({ state: 'done' })
    } catch (e) {
      setComfyCopyStatus({ state: 'error', error: e.message })
    }
  }

  const restore = (h) => {
    if (h.type === 'scriptwriter') {
      setTarget('scriptwriter')
      setScriptwriterInitial(h)
      setScriptwriterKey(k => k + 1)
      setHistoryOpen(false)
      return
    }
    setTarget(h.target); setOutputCount(h.outputCount)
    if (h.model) { setWriterModel(h.model); setWriterManual(h.model) }
    if (h.vision) { setVisionModel(h.vision); setVisionManual(h.vision) }
    setDuration(h.duration); setStyle(h.style); setCreativity(h.creativity); setFrameMode(h.frameMode)
    setScene(h.scene || ''); setDialogue(h.dialogue || ''); setDelivery(h.delivery || '')
    setNegative(h.negative || '')
    // Older entries only ever stored a filename string (no image bytes) — those
    // fall through to null/[] here, exactly like the pre-restore-support behavior.
    const imgFromHistory = (v) => (v && typeof v === 'object' && v.base64)
      ? { base64: v.base64, mediaType: v.mediaType || 'image/jpeg', previewUrl: `data:${v.mediaType || 'image/jpeg'};base64,${v.base64}`, fileName: v.fileName }
      : null
    setFirstImg(imgFromHistory(h.firstImg))
    setMidImg(imgFromHistory(h.midImg))
    setLastImg(imgFromHistory(h.lastImg))
    setRefImages(Array.isArray(h.refImages)
      ? h.refImages.filter(im => im && typeof im === 'object' && im.base64).map(im => ({
          id: generateId(), base64: im.base64, mediaType: im.mediaType || 'image/jpeg',
          previewUrl: `data:${im.mediaType || 'image/jpeg'};base64,${im.base64}`, fileName: im.fileName,
          role: im.role || MINIMAX_H3_REF_ROLES[0].id, preserve: im.preserve || 'strong', note: im.note || '',
        }))
      : [])
    setRefAudio(h.refAudio && typeof h.refAudio === 'object' && h.refAudio.base64
      ? { base64: h.refAudio.base64, mediaType: h.refAudio.mediaType || 'audio/mpeg', fileName: h.refAudio.fileName }
      : null)
    setResults([]); setCaption('')
    setSoundscape(h.soundscape || ''); setMusic(h.music || '')
    const ratioPreset = TARGETS[h.target]?.resolutions?.find(r => r.label === h.ratio)
    setH3RatioId(ratioPreset?.id || '')
  }

  const sendToWriter = async () => {
    setPendingSend(false)
    const snapshot = pendingSnapshotRef.current
    const systemToUse = adminSystem
    const userToUse = adminUserMsg
    if (outputCount === 1) {
      const lbl = effectiveWriter
      setResults([{ label: lbl, text: '', usage: null, loading: true, error: '' }])
      try {
        const { text, usage } = await callOllama(effectiveWriter, userToUse, systemToUse, cfg, cfg.temperature)
        setResults([{ label: lbl, text, usage, loading: false, error: '' }])
        if (snapshot) saveHistory(snapshot, [{ label: lbl, text }])
      } catch (e) {
        setResults([{ label: lbl, text: '', usage: null, loading: false, error: e.message }])
      }
    } else {
      const variants = buildVariants(effectiveWriter)
      setResults(variants.map(v => ({ label: v.label, text: '', usage: null, loading: true, error: '' })))
      const proms = variants.map((v, i) =>
        callOllama(effectiveWriter, userToUse + v.nudge, systemToUse, cfg, v.temp)
          .then(({ text, usage }) => {
            setResults(prev => prev.map((r, idx) => idx === i ? { ...r, text, usage, loading: false } : r))
            return { label: v.label, text }
          })
          .catch(e => {
            setResults(prev => prev.map((r, idx) => idx === i ? { ...r, loading: false, error: e.message } : r))
            return { label: v.label, text: `(error: ${e.message})` }
          })
      )
      const outs = await Promise.all(proms)
      if (snapshot) saveHistory(snapshot, outs)
    }
  }

  const insertCameraMarker = (move) => {
    const marker = `[camera: ${move.prompt}]`
    const ta = sceneTextareaRef.current
    setFlashId(move.id)
    setTimeout(() => setFlashId(id => id === move.id ? null : id), 600)
    if (!ta) {
      setScene(s => s + (s && !/\s$/.test(s) ? ' ' : '') + marker + ' ')
      return
    }
    const start = ta.selectionStart ?? scene.length
    const end = ta.selectionEnd ?? scene.length
    const before = scene.slice(0, start)
    const after = scene.slice(end)
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
    const needsTrailingSpace = after.length > 0 && !/^\s/.test(after)
    const insertText = (needsLeadingSpace ? ' ' : '') + marker + (needsTrailingSpace ? ' ' : '')
    const newValue = before + insertText + after
    const newCursor = before.length + insertText.length
    setScene(newValue)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(newCursor, newCursor)
    })
  }
  const switchMode = (m) => {
    setFrameMode(m); setFirstImg(null); setMidImg(null); setLastImg(null); setRefImages([]); setRefAudio(null)
    if (target === 'minimax_h3' && m === 'ref') setH3RatioId(prev => prev || 'port916')
  }
  const switchTarget = (id) => {
    const opts = TARGETS[id].durations || DURATION_OPTIONS
    setDuration(d => opts.some(o => o.value === d) ? d : opts[0].value)
    setTarget(id); setFirstImg(null); setMidImg(null); setLastImg(null); setRefImages([]); setRefAudio(null)
    setSoundscape(''); setMusic('')
    const nextMode = TARGETS[id].defaultFrameMode || 'single'
    setH3RatioId(id === 'minimax_h3' && nextMode === 'ref' ? 'port916' : '')
    setFrameMode(nextMode); setResults([]); setCaption('')
  }

  const captionImages = async () => {
    if (frameMode === 'ref') {
      const role = (id) => MINIMAX_H3_REF_ROLES.find(r => r.id === id) || MINIMAX_H3_REF_ROLES[0]
      const roleLabel = (id) => role(id).label
      const preserveLabel = (id) => MINIMAX_H3_PRESERVE_OPTIONS.find(p => p.id === id)?.label || id
      const preserveMarker = (id) => MINIMAX_H3_PRESERVE_OPTIONS.find(p => p.id === id)?.marker || id
      const captions = await Promise.all(refImages.map(async (im) => {
        const cacheKey = `${im.id}::${im.role}::${effectiveVision}`
        const cached = refCaptionCacheRef.current.get(cacheKey)
        if (cached != null) return cached
        const { text } = await callOllama(effectiveVision, [
          { type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.base64 } },
          { type: 'text', text: `Describe this reference image as instructed. ${role(im.role).visionFocus || ''}`.trim() },
        ], VISION_PROMPT_MINIMAX_H3_REF, cfg, 0.3)
        refCaptionCacheRef.current.set(cacheKey, text)
        return text
      }))
      const imageBlock = refImages.map((im, i) => {
        let line = `Image ${i + 1} — role: ${roleLabel(im.role)}, preservation: ${preserveLabel(im.preserve)} (${preserveMarker(im.preserve)}): ${captions[i]}`
        if (im.note && im.note.trim()) line += `\n   Requested use of this reference: ${im.note.trim()}`
        return line
      }).join('\n\n')
      if (refAudio) {
        return `${imageBlock}\n\nAudio 1 — voice-timbre reference (marker: reference): file "${refAudio.fileName}". Reference ONLY the timbre, pitch and delivery for the speaking subject; do not infer any words from it.`
      }
      return imageBlock
    }
    let system, content
    if (t.type === 'image') {
      system = t.visionPrompt
      content = [
        { type: 'image', source: { type: 'base64', media_type: firstImg.mediaType, data: firstImg.base64 } },
        { type: 'text', text: scene.trim() ? `The user's intended subject/scene: ${scene.trim()}\nDescribe the reference image in precise, prompt-ready language.` : 'Describe this reference image in precise, prompt-ready language.' },
      ]
    } else if (frameMode === 'firstmidlast') {
      system = VISION_PROMPT_LTX_FIRSTMIDLAST
      content = [
        { type: 'text', text: 'FIRST FRAME (clip starts here):' },
        { type: 'image', source: { type: 'base64', media_type: firstImg.mediaType, data: firstImg.base64 } },
        { type: 'text', text: 'MID FRAME (clip passes through here):' },
        { type: 'image', source: { type: 'base64', media_type: midImg.mediaType, data: midImg.base64 } },
        { type: 'text', text: 'LAST FRAME (clip ends here):' },
        { type: 'image', source: { type: 'base64', media_type: lastImg.mediaType, data: lastImg.base64 } },
        { type: 'text', text: 'Describe all three frames and the changes, as instructed.' },
      ]
    } else if (frameMode === 'firstlast') {
      system = VISION_PROMPT_LTX_FIRSTLAST
      content = [
        { type: 'text', text: 'FIRST FRAME (clip starts here):' },
        { type: 'image', source: { type: 'base64', media_type: firstImg.mediaType, data: firstImg.base64 } },
        { type: 'text', text: 'LAST FRAME (clip ends here):' },
        { type: 'image', source: { type: 'base64', media_type: lastImg.mediaType, data: lastImg.base64 } },
        { type: 'text', text: 'Describe both frames and the change, as instructed.' },
      ]
    } else {
      system = t.visionPrompt || VISION_PROMPT_LTX_SINGLE
      content = [
        { type: 'image', source: { type: 'base64', media_type: firstImg.mediaType, data: firstImg.base64 } },
        { type: 'text', text: 'Describe this first frame as instructed.' },
      ]
    }
    const { text } = await callOllama(effectiveVision, content, system, cfg, 0.3)
    return text
  }

  const getCachedCaption = () => {
    const c = visionCacheRef.current
    if (!c) return null
    if (c.target !== target || c.frameMode !== frameMode) return null
    if (c.firstImg !== firstImg || c.midImg !== midImg || c.lastImg !== lastImg || c.refImages !== refImages) return null
    if (c.refAudio !== refAudio) return null
    if (t.type === 'image' && c.scene !== scene) return null
    return c.description
  }
  const setCachedCaption = (description) => {
    visionCacheRef.current = { target, frameMode, scene, firstImg, midImg, lastImg, refImages, refAudio, description }
  }

  const enhance = async () => {
    const hasImg = t.type === 'image' ? !!firstImg
      : frameMode === 'firstlast' ? (firstImg && lastImg)
      : frameMode === 'firstmidlast' ? (firstImg && midImg && lastImg)
      : frameMode === 'last' ? !!firstImg
      : frameMode === 'ref' ? refImages.length > 0
      : !!firstImg
    const canGen = t.type === 'image' ? (scene.trim() || firstImg)
      : frameMode === 'firstlast' ? (firstImg && lastImg)
      : frameMode === 'firstmidlast' ? (firstImg && midImg && lastImg)
      : frameMode === 'last' ? !!firstImg
      : frameMode === 'ref' ? refImages.length > 0
      : (scene.trim() || firstImg)
    if (!canGen) return
    if (!effectiveWriter) { setGlobalError('Pick a Writer model (open ⚙ Local backend → Reload models, or type one).'); return }
    if (hasImg && !effectiveVision) { setGlobalError('Image inputs need a Vision model — pick one or type one (e.g. qwen2.5vl:7b).'); return }
    setGlobalError(''); setCopied(null); setCaption(''); setPendingSend(false)

    const styleObj = STYLE_OPTIONS.find(s => s.id === style)
    const creativityText = creativity === 'balanced' ? ''
      : t.type === 'image'
        ? (creativity === 'faithful'
            ? '\n\nImage fidelity: FAITHFUL — recreate the reference closely; keep its subject, composition and palette, deviating only slightly.'
            : '\n\nImage fidelity: LOOSE — treat the reference as rough inspiration only. Invent freely, take creative risks, and prioritize the chosen style over literal resemblance.')
        : t.type === 'text'
        ? (creativity === 'faithful'
            ? '\n\nEmotional latitude: FAITHFUL — keep the delivery grounded and true to a plain, literal reading of the idea; minimal embellishment.'
            : '\n\nEmotional latitude: LOOSE — push the delivery further; take bigger risks with intensity, arc, and phrasing.')
        : (creativity === 'faithful'
            ? '\n\nCreative latitude: FAITHFUL — keep the proposed motion minimal and literal to the scene.'
            : '\n\nCreative latitude: LOOSE — be genuinely inventive and surprising with the action, framing and atmosphere (within the model\'s motion limits); don\'t settle for the obvious motion.')
    const stylePart = (styleObj && styleObj.id !== 'auto'
      ? `\n\nStyle / mood — let this genuinely shape the mood and treatment, but keep the scene believable and the subject intact unless the style itself calls for breaking realism (e.g. surreal). Favor clever, well-judged choices over crude exaggeration: ${styleObj.label} — ${styleObj.hint}`
      : '')
      + creativityText
      + (show.dialogue && dialogue.trim()
        ? `\n\nSpoken dialogue — include these EXACT words in quotation marks, broken into short phrases with physical acting beats between them${delivery.trim() ? `; delivery/voice: ${delivery.trim()}` : ''}:\n"${dialogue.trim()}"`
        : '')
      + (negative.trim()
        ? `\n\nThings to avoid — the user does not want these in the result: ${negative.trim()}. Do not depict or describe them; if one is a plausible default the model might add by mistake, actively steer the prompt away from it by describing the correct/positive alternative rather than using a negation. Only add a negative-prompt line or field for these terms if the OUTPUT FORMAT rules above already define one for this target — never invent a negative-prompt field or line that isn't part of this target's defined output format.`
        : '')
    const lengthPart = PROMPT_LENGTH_INJECT[promptLength] || ''

    if (hasImg) {
      setResults([])
      let frameDescription
      const cached = getCachedCaption()
      if (cached != null) {
        frameDescription = cached
        setCaption(frameDescription)
      } else {
        setVisionBusy(true)
        try {
          frameDescription = await captionImages()
          setCaption(frameDescription)
          setCachedCaption(frameDescription)
        } catch (e) {
          setVisionBusy(false)
          setGlobalError(`Vision step failed (${effectiveVision}): ${e.message}`)
          return
        }
        setVisionBusy(false)
      }
      await runWriter(frameDescription, stylePart, lengthPart, hasImg)
    } else {
      await runWriter(null, stylePart, lengthPart, hasImg)
    }
  }

  const runWriter = async (frameDescription, stylePart, lengthPart, hasImg) => {
    let userText
    if (target === 'minimax_h3') {
      const mode = frameMode === 'last' ? 'L2VA'
        : frameMode === 'firstlast' ? 'FL2VA'
        : frameMode === 'ref' ? 'Ref2VA'
        : hasImg ? 'I2VA' : 'T2VA'
      const selectedRatio = presetById(h3RatioId, t.resolutions) || t.resolutions[0]
      const ratioLine = (frameMode === 'single' && !hasImg) || frameMode === 'ref'
        ? `Aspect ratio: ${selectedRatio.label} (${selectedRatio.note})\n`
        : 'Aspect ratio: derived from the input image(s) — do not override it.\n'
      const frameBlock = frameMode === 'last'
        ? (frameDescription ? `LAST FRAME (already established — the clip must end here; do not restate it, only describe the plausible path that leads to it):\n${frameDescription}\n\n` : '')
        : frameMode === 'firstlast'
        ? (frameDescription ? `FIRST FRAME and LAST FRAME (already established — do not restate their static contents, only describe the transition):\n${frameDescription}\n\n` : '')
        : frameMode === 'ref'
        ? `Reference images:\n${frameDescription}\n\n`
        : frameDescription ? `FIRST FRAME (already established — do not restate it; only describe what happens over time):\n${frameDescription}\n\n` : ''
      const scenePart = scene.trim()
        ? `Scene / action:\n${scene}`
        : frameMode === 'last' ? 'No description provided — propose a plausible action path that leads naturally to the last frame.'
        : frameMode === 'firstlast' ? 'No description provided — infer the natural motion that carries the scene from the first frame to the last.'
        : frameMode === 'ref' ? 'No description provided — propose a fitting scene using the reference images above.'
        : hasImg ? 'No scene description provided — propose ONE fitting cinematic moment of motion that suits the frame.'
        : 'No scene description provided.'
      const audioPart = `\n\nAmbient / diegetic sound (overall_soundscape): ${soundscape.trim() || 'not specified — invent restrained ambience that fits the scene.'}`
        + `\n\nAudience-only music (non_diegetic_music): ${music.trim() || 'not specified — decide whether music serves this scene; if not, use N/A.'}`
      userText = `MODE: ${mode}\n\n${frameBlock}${ratioLine}Target duration: ${duration}\n\n${scenePart}${stylePart}${audioPart}${lengthPart}`
    } else if (t.type === 'image') {
      const ref = frameDescription ? `Reference image description:\n${frameDescription}\n\n` : ''
      const scenePart = scene.trim()
        ? `Image description / subject:\n${scene}`
        : (frameDescription ? 'No extra description — base the FLUX prompt on the reference description above.' : 'No description provided.')
      userText = `${ref}${scenePart}${stylePart}${lengthPart}`
    } else if (t.type === 'text') {
      userText = `${scene.trim()}${stylePart}${lengthPart}`
    } else if (frameMode === 'firstmidlast') {
      const frames = frameDescription ? `Frames (already established — do not restate their static contents):\n${frameDescription}\n\n` : ''
      const scenePart = scene.trim()
        ? `Transition description:\n${scene}`
        : 'No description provided — infer the natural motion that carries the scene through both transitions.'
      userText = `MODE: First-mid-last-frame interpolation. The clip begins on the FIRST frame, passes through the MID frame at approximately the halfway point, and ends on the LAST frame; describe the two-phase motion and camera as one continuous arc with a clear beat at the mid frame.\n\n${frames}Target duration: ${duration}\n\n${scenePart}${stylePart}${lengthPart}`
    } else if (frameMode === 'firstlast') {
      const frames = frameDescription ? `Frames (already established — do not restate their static contents):\n${frameDescription}\n\n` : ''
      const scenePart = scene.trim()
        ? `Transition description:\n${scene}`
        : 'No description provided — infer the natural motion that carries the scene from the first frame to the last.'
      userText = `MODE: First-to-last-frame interpolation. The clip begins exactly on the FIRST frame and ends exactly on the LAST frame; describe the motion and camera that bridge them.\n\n${frames}Target duration: ${duration}\n\n${scenePart}${stylePart}${lengthPart}`
    } else {
      const frame = frameDescription ? `FIRST FRAME (already established — do not restate it; only describe what happens over time):\n${frameDescription}\n\n` : ''
      const scenePart = scene.trim()
        ? `Basic scene description:\n${scene}`
        : (frameDescription ? 'No scene description provided — propose ONE fitting cinematic moment of motion that suits the frame.' : 'No scene description provided.')
      userText = `${frame}Target duration: ${duration}\n\n${scenePart}${stylePart}${lengthPart}`
    }

    const isH3 = target === 'minimax_h3'
    const snapshot = {
      ts: Date.now(), target, outputCount, model: effectiveWriter, vision: hasImg ? effectiveVision : null,
      duration, style, creativity, frameMode, negative,
      scene, dialogue: show.dialogue ? dialogue : '', delivery: show.dialogue ? delivery : '',
      firstImg: firstImg ? { base64: firstImg.base64, mediaType: firstImg.mediaType, fileName: firstImg.fileName } : null,
      midImg: midImg ? { base64: midImg.base64, mediaType: midImg.mediaType, fileName: midImg.fileName } : null,
      lastImg: lastImg ? { base64: lastImg.base64, mediaType: lastImg.mediaType, fileName: lastImg.fileName } : null,
      ratio: isH3 ? (presetById(h3RatioId, t.resolutions) || t.resolutions[0]).label : null,
      soundscape: isH3 ? soundscape : '', music: isH3 ? music : '',
      refImages: isH3 && frameMode === 'ref'
        ? refImages.map(im => ({ base64: im.base64, mediaType: im.mediaType, fileName: im.fileName, role: im.role, preserve: im.preserve, note: im.note || '' }))
        : null,
      refAudio: isH3 && frameMode === 'ref' && refAudio
        ? { base64: refAudio.base64, mediaType: refAudio.mediaType, fileName: refAudio.fileName }
        : null,
    }

    if (adminMode) {
      setAdminUserMsg(userText)
      pendingSnapshotRef.current = snapshot
      setPendingSend(true)
      return
    }

    const activeSystem = systemPromptFor(t, frameMode)

    if (outputCount === 1) {
      const lbl = effectiveWriter
      setResults([{ label: lbl, text: '', usage: null, loading: true, error: '' }])
      try {
        const { text, usage } = await callOllama(effectiveWriter, userText, activeSystem, cfg, cfg.temperature)
        setResults([{ label: lbl, text, usage, loading: false, error: '' }])
        saveHistory(snapshot, [{ label: lbl, text }])
      } catch (e) {
        setResults([{ label: lbl, text: '', usage: null, loading: false, error: e.message }])
      }
    } else {
      const variants = buildVariants(effectiveWriter)
      setResults(variants.map(v => ({ label: v.label, text: '', usage: null, loading: true, error: '' })))
      const proms = variants.map((v, i) =>
        callOllama(effectiveWriter, userText + v.nudge, activeSystem, cfg, v.temp)
          .then(({ text, usage }) => {
            setResults(prev => prev.map((r, idx) => idx === i ? { ...r, text, usage, loading: false } : r))
            return { label: v.label, text }
          })
          .catch(e => {
            setResults(prev => prev.map((r, idx) => idx === i ? { ...r, loading: false, error: e.message } : r))
            return { label: v.label, text: `(error: ${e.message})` }
          })
      )
      const outs = await Promise.all(proms)
      saveHistory(snapshot, outs)
    }
  }

  const copy = (idx) => { navigator.clipboard.writeText(results[idx].text); setCopied(idx); setTimeout(() => setCopied(null), 2000) }
  const editResult = (idx, value) => setResults(prev => prev.map((r, i) => i === idx ? { ...r, text: value } : r))

  const writing = results.some(r => r.loading)
  const isLoading = visionBusy || writing
  const canGenerate = t.type === 'image'
    ? (!!scene.trim() || !!firstImg)
    : frameMode === 'firstlast' ? (!!firstImg && !!lastImg)
    : frameMode === 'firstmidlast' ? (!!firstImg && !!midImg && !!lastImg)
    : frameMode === 'last' ? !!firstImg
    : frameMode === 'ref' ? refImages.length > 0
    : (!!scene.trim() || !!firstImg)
  const proposeMode = !scene.trim() && (
    t.type === 'image' ? !!firstImg
    : frameMode === 'firstlast' ? (firstImg && lastImg)
    : frameMode === 'firstmidlast' ? (firstImg && midImg && lastImg)
    : frameMode === 'last' ? !!firstImg
    : frameMode === 'ref' ? refImages.length > 0
    : !!firstImg
  )
  const buttonLabel = visionBusy ? '👁 Reading images…'
    : writing ? '✦ Writing prompt…'
    : t.type === 'image'
      ? (proposeMode ? '✦ Describe image as prompt' : '✦ Enhance prompt')
      : (proposeMode
          ? (frameMode === 'firstlast' ? '✦ Propose motion between frames'
            : frameMode === 'firstmidlast' ? '✦ Propose motion through frames'
            : frameMode === 'last' ? '✦ Propose path to ending frame'
            : frameMode === 'ref' ? '✦ Propose reference-guided scene'
            : '✦ Propose scene from image')
          : '✦ Enhance Prompt')

  const sceneHint = t.type === 'image'
    ? (firstImg ? '(optional — leave blank to describe the reference image)' : '')
    : t.type === 'text'
      ? ''
      : frameMode === 'firstlast'
        ? '(optional — leave blank to let the writer propose the motion between your frames)'
        : frameMode === 'firstmidlast'
          ? '(optional — leave blank to let the writer propose the motion through all three frames)'
          : frameMode === 'last'
            ? '(optional — leave blank to let the writer propose the path to your ending frame)'
            : frameMode === 'ref'
              ? '(optional — leave blank to let the writer propose a scene from your reference images)'
              : firstImg ? '(optional — leave blank to let the writer propose one from the frame)' : ''

  const sceneLabel = t.type === 'image' ? 'Image Description' : t.type === 'text' ? 'Scene / Story Idea' : 'Your Scene'
  const scenePlaceholder = t.type === 'image'
    ? 'e.g. A weathered fisherman mending nets at dawn, harbor and boats behind him'
    : t.type === 'text'
      ? 'e.g. A queen betrayed by her advisor, cold fury building to a threat'
      : firstImg
        ? 'Leave blank to auto-propose, or describe what should happen…'
        : 'e.g. A woman walks through a rainy night market in Tokyo, stops at a noodle stall'

  const selectedRatio = target === 'minimax_h3' ? (presetById(h3RatioId, t.resolutions) || t.resolutions[0]) : null
  const ratioPicker = target === 'minimax_h3' ? (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Aspect Ratio <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>(no exact frame to derive it from — pick one explicitly)</span>
      </label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {t.resolutions.map(p => (
          <button key={p.id} onClick={() => setH3RatioId(p.id)} title={p.note} style={btn(h3RatioId === p.id)}>{p.label}</button>
        ))}
      </div>
      {frameMode === 'ref' && (
        <p style={{ fontSize: 11, color: '#555', margin: '6px 0 0', lineHeight: 1.5 }}>
          Ref2VA renders best at 9:16 portrait (the validated short-drama format).
        </p>
      )}
      {!h3RatioId && (
        <p style={{ fontSize: 11, color: '#f0b070', margin: '4px 0 0', lineHeight: 1.5 }}>
          No ratio picked — defaulting to {selectedRatio.label}.
        </p>
      )}
    </div>
  ) : null

  const genBtnDisabled = isLoading || !canGenerate || pendingSend
  const genBtnStyle = {
    padding: '10px 24px', borderRadius: 8, border: 'none',
    background: genBtnDisabled ? '#2a2a3f' : 'linear-gradient(135deg, #5a4fcf, #8b5cf6)',
    color: genBtnDisabled ? '#555' : '#fff',
    fontSize: 14, fontWeight: 600, cursor: genBtnDisabled ? 'not-allowed' : 'pointer',
    transition: 'all 0.15s', marginTop: 6,
  }

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", maxWidth: 720, margin: '0 auto', padding: '28px 20px', color: '#e8e8f0' }}>
      {/* Header */}
      <div style={{ marginBottom: 18, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: '#fff', letterSpacing: '-0.3px' }}>Prompt Enhancer</h1>
          <p style={{ fontSize: 13, color: '#888', margin: 0 }}>{t.subtitle}{showImage ? ' · two-stage: vision → writer, local Ollama' : ' · single-stage writer, local Ollama'}</p>
        </div>
        <button
          onClick={() => { setAdminMode(v => !v); setPendingSend(false) }}
          style={{ flexShrink: 0, padding: '5px 12px', borderRadius: 6, border: '1px solid', borderColor: adminMode ? '#7c6af7' : '#333', background: adminMode ? '#2d2060' : '#1a1a2e', color: adminMode ? '#c4b8ff' : '#666', fontSize: 11, cursor: 'pointer', marginTop: 4 }}
        >
          {adminMode ? '⚙ Admin: ON' : '⚙ Admin'}
        </button>
      </div>

      <ConfigBar cfg={cfg} setCfg={setCfg} models={models} modelStatus={modelStatus} reloadModels={reloadModels} />

      {/* Target */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Generate for</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.values(TARGETS).map(tg => (
            <button key={tg.id} onClick={() => switchTarget(tg.id)} style={btn(target === tg.id)}>{tg.label}</button>
          ))}
        </div>
      </div>

      {/* Models */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div style={{ flex: '1 1 240px' }}>
          <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Writer model <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>· builds the prompt</span>
          </label>
          {models.length > 0
            ? <select style={selStyle} value={writerModel} onChange={e => setWriterModel(e.target.value)}>{models.map(m => <option key={m} value={m}>{m}</option>)}</select>
            : <input style={selStyle} value={writerManual} onChange={e => setWriterManual(e.target.value)} placeholder={isAnthropic(cfg.base) ? 'claude-sonnet-4-6' : isGrok(cfg.base) ? 'grok-4' : 'mistral-nemo'} spellCheck={false} />}
        </div>
        {showImage && (
          <div style={{ flex: '1 1 240px' }}>
            <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Vision model <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>· reads image inputs</span>
            </label>
            {models.length > 0
              ? <select style={selStyle} value={visionModel} onChange={e => setVisionModel(e.target.value)}>{models.map(m => <option key={m} value={m}>{m}</option>)}</select>
              : <input style={selStyle} value={visionManual} onChange={e => setVisionManual(e.target.value)} placeholder={isAnthropic(cfg.base) ? 'claude-sonnet-4-6' : isGrok(cfg.base) ? 'grok-4' : 'qwen2.5vl:7b'} spellCheck={false} />}
          </div>
        )}
      </div>

      {target === 'scriptwriter' ? (
        <ScriptwriterPanel
          key={scriptwriterKey}
          cfg={cfg}
          writerModel={effectiveWriter}
          initialState={scriptwriterInitial}
          onSaveHistory={saveScriptHistory}
        />
      ) : (<>

      {/* Output count */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Output</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {OUTPUT_COUNT_OPTIONS.map(o => (
            <button key={o.value} onClick={() => setOutputCount(o.value)} style={btn(outputCount === o.value)}>{o.label}</button>
          ))}
        </div>
        {outputCount === 3 && <p style={{ fontSize: 11, color: '#555', margin: '6px 0 0' }}>Vision runs once; the writer then runs 3× at temperatures {VARIANT_TEMPS.join(' / ')}, each with a short literal → balanced → bold phrasing nudge so variants stay distinct even on models that ignore temperature.</p>}
      </div>

      {/* Duration */}
      {show.duration && (
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Duration</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(t.durations || DURATION_OPTIONS).map(o => (
              <button key={o.value} onClick={() => setDuration(o.value)} style={btn(duration === o.value)}>{o.label}</button>
            ))}
          </div>
          <p style={{ fontSize: 11, color: '#555', margin: '6px 0 0', lineHeight: 1.5 }}>
            {t.durationHint || (<>Sweet spot: <span style={{ color: '#9a8fd8' }}>≤10s renders cleanest</span>. 12–20s can show subject drift — consider the Extend workflow (e.g. 8s + 8s) for longer clips.</>)}
          </p>
        </div>
      )}

      {/* Style */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{t.type === 'image' ? 'Style' : 'Scene Style'}</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {STYLE_OPTIONS.map(o => (
            <button key={o.id} onClick={() => setStyle(o.id)} title={o.hint} style={btn(style === o.id)}>{o.label}</button>
          ))}
        </div>
      </div>

      {/* Creativity */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{t.type === 'image' ? 'Image Fidelity' : 'Creativity'}</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {CREATIVITY_OPTIONS.map(o => (
            <button key={o.id} onClick={() => setCreativity(o.id)} title={o.hint} style={btn(creativity === o.id)}>{o.label}</button>
          ))}
        </div>
        <p style={{ fontSize: 11, color: '#555', margin: '6px 0 0', lineHeight: 1.5 }}>
          {t.type === 'image'
            ? 'How closely the prompt recreates your reference image vs. invents something new.'
            : t.type === 'text'
              ? 'How much the delivery pushes beyond a plain, literal reading of the idea.'
              : 'How inventive the proposed motion and atmosphere should be — the first frame itself always stays fixed.'}
        </p>
      </div>

      {/* Prompt length */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Prompt Length</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PROMPT_LENGTH_OPTIONS.map(o => (
            <button key={o.id} onClick={() => setPromptLength(o.id)} title={o.hint} style={btn(promptLength === o.id)}>{o.label}</button>
          ))}
        </div>
      </div>

      {/* Scene */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {sceneLabel}{' '}
          {sceneHint && <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>{sceneHint}</span>}
        </label>
        <textarea ref={sceneTextareaRef} value={scene} onChange={e => setScene(e.target.value)} placeholder={scenePlaceholder} rows={4}
          style={{ width: '100%', boxSizing: 'border-box', background: '#12121f', border: '1px solid #2e2e44', borderRadius: 8, padding: '12px 14px', color: '#e0e0f0', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.6, transition: 'border-color 0.15s' }}
          onFocus={e => e.target.style.borderColor = '#5a4fcf'} onBlur={e => e.target.style.borderColor = '#2e2e44'} />
      </div>

      {/* Avoid */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Avoid <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>(optional — things to keep out of the result, e.g. "text, watermark", or a likely mistake to correct, e.g. "blue car", "horse in background")</span>
        </label>
        <textarea value={negative} onChange={e => setNegative(e.target.value)} placeholder="e.g. text, watermark, blue car, horse in background" rows={2}
          style={{ width: '100%', boxSizing: 'border-box', background: '#12121f', border: '1px solid #2e2e44', borderRadius: 8, padding: '10px 14px', color: '#e0e0f0', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
          onFocus={e => e.target.style.borderColor = '#5a4fcf'} onBlur={e => e.target.style.borderColor = '#2e2e44'} />
      </div>

      {/* Camera */}
      {show.camera && (
        <div style={{ marginBottom: 18 }}>
          <button
            onClick={() => setCameraOpen(v => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#777', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}
          >
            <span style={{ fontSize: 13, transition: 'transform 0.2s', display: 'inline-block', transform: cameraOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            Camera
          </button>
          {cameraOpen && (
            <div style={{ marginTop: 12, background: '#0e0e1c', border: '1px solid #2e2e44', borderRadius: 10, padding: '16px 18px' }}>
              <p style={{ fontSize: 11, color: '#666', margin: '0 0 14px', lineHeight: 1.5 }}>
                Click a move to insert it into your scene at the cursor, e.g. <code style={{ color: '#9a8fd8' }}>[camera: a slow dolly-in toward the subject]</code>.
                You can also type <code style={{ color: '#9a8fd8' }}>[camera: ...]</code> markers by hand, anywhere in the text, in your own words.
              </p>
              {CAMERA_GROUPS.map(g => (
                <div key={g.group} style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 8 }}>{g.group}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {g.moves.map(m => {
                      const flashed = flashId === m.id
                      return (
                        <button key={m.id} title={m.desc} onClick={() => insertCameraMarker(m)}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '5px 10px', borderRadius: 6, border: '1px solid', borderColor: flashed ? '#7c6af7' : '#2a2a3f', background: flashed ? '#1e1850' : '#13131f', color: flashed ? '#c4b8ff' : '#888', fontSize: 12, transition: 'all 0.15s' }}>
                          {flashed ? '✓ Inserted' : m.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #1e1e30' }}>
                <a href="https://camerapromptsgenerator.vercel.app/" target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#5a4fcf', textDecoration: 'none' }}>
                  camerapromptsgenerator.vercel.app ↗
                </a>
                <span style={{ fontSize: 11, color: '#444', marginLeft: 8 }}>— browse more angle & shot references</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dialogue */}
      {show.dialogue && (
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Dialogue <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>(optional — spoken aloud; needs 8s+ for more than a few words)</span>
          </label>
          <textarea value={dialogue} onChange={e => setDialogue(e.target.value)} placeholder="Exact words to be spoken, e.g.  We need to leave. Now." rows={2}
            style={{ width: '100%', boxSizing: 'border-box', background: '#12121f', border: '1px solid #2e2e44', borderRadius: 8, padding: '10px 14px', color: '#e0e0f0', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
            onFocus={e => e.target.style.borderColor = '#5a4fcf'} onBlur={e => e.target.style.borderColor = '#2e2e44'} />
          {dialogue.trim() && (() => {
            const b = syllableBudget(duration, dialogue)
            const over = b.max != null && b.count > b.max
            return (
              <div style={{ fontSize: 11, color: over ? '#f0b070' : '#555', marginTop: 6, lineHeight: 1.5 }}>
                {b.count} syllable{b.count === 1 ? '' : 's'}
                {b.max != null && (
                  <> · budget ≈{b.min}–{b.max} for a {b.seconds}s clip ({b.german ? 'German' : 'English'} pacing, ~{b.spsLo}–{b.spsHi} syll/s)</>
                )}
                {over && ' — too many syllables for this duration; speech may rush or get cut. Trim the line or pick a longer duration.'}
              </div>
            )
          })()}
          <input value={delivery} onChange={e => setDelivery(e.target.value)}
            placeholder="Delivery / voice / accent (optional) — e.g. calm and slow, urgent whisper, British accent"
            style={{ width: '100%', boxSizing: 'border-box', marginTop: 8, background: '#12121f', border: '1px solid #2e2e44', borderRadius: 8, padding: '9px 14px', color: '#e0e0f0', fontSize: 13, outline: 'none', transition: 'border-color 0.15s' }}
            onFocus={e => e.target.style.borderColor = '#5a4fcf'} onBlur={e => e.target.style.borderColor = '#2e2e44'} />
        </div>
      )}

      {/* Soundscape / music (MiniMax H3 only) */}
      {target === 'minimax_h3' && (
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Ambient Sound <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>(optional — overall_soundscape: ambience, physical sounds; leave blank to let the writer invent it)</span>
          </label>
          <textarea value={soundscape} onChange={e => setSoundscape(e.target.value)} placeholder="e.g. steady ventilation hum, quiet servo motors, a soft mechanical click" rows={2}
            style={{ width: '100%', boxSizing: 'border-box', background: '#12121f', border: '1px solid #2e2e44', borderRadius: 8, padding: '10px 14px', color: '#e0e0f0', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
            onFocus={e => e.target.style.borderColor = '#5a4fcf'} onBlur={e => e.target.style.borderColor = '#2e2e44'} />
          <label style={{ fontSize: 11, color: '#777', display: 'block', margin: '12px 0 6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Music <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>(optional — non_diegetic_music, audience-only; leave blank to let the writer decide, or type "none" for silence)</span>
          </label>
          <textarea value={music} onChange={e => setMusic(e.target.value)} placeholder='e.g. sparse electronic pulse, moderate tempo, restrained low synth bass — or "none"' rows={2}
            style={{ width: '100%', boxSizing: 'border-box', background: '#12121f', border: '1px solid #2e2e44', borderRadius: 8, padding: '10px 14px', color: '#e0e0f0', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
            onFocus={e => e.target.style.borderColor = '#5a4fcf'} onBlur={e => e.target.style.borderColor = '#2e2e44'} />
        </div>
      )}

      {/* Frame mode */}
      {show.frameMode && (
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Image Input</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(t.frameModeOptions || DEFAULT_FRAME_MODE_OPTIONS).map(o => (
              <button key={o.id} onClick={() => switchMode(o.id)} style={btn(frameMode === o.id)}>{o.label}</button>
            ))}
          </div>
          {(() => {
            const hint = (t.frameModeOptions || DEFAULT_FRAME_MODE_OPTIONS).find(o => o.id === frameMode)?.hint
            return hint ? <p style={{ fontSize: 11, color: '#555', margin: '6px 0 0', lineHeight: 1.5 }}>{hint}</p> : null
          })()}
        </div>
      )}

      {/* Image panels */}
      {showImage && (t.type === 'image' || frameMode === 'single' ? (
        <>
          {!firstImg && ratioPicker}
          <ImagePanel key={`${target}-single`} label="Reference Image" hint="(optional)" onChange={setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} presetNote={t.presetNote} />
        </>
      ) : frameMode === 'last' ? (
        <ImagePanel key={`${target}-lastonly`} label="Last Frame" hint="(clip ends here)" onChange={setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} />
      ) : frameMode === 'ref' ? (
        <>
          {ratioPicker}
          <MinimaxRefPanel images={refImages} onChange={setRefImages} audio={refAudio} onAudioChange={setRefAudio} />
        </>
      ) : frameMode === 'firstmidlast' ? (
        <>
          <ImagePanel key={`${target}-first`} label="First Frame" hint="(clip starts here)" onChange={setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} />
          <ImagePanel key={`${target}-mid`} label="Mid Frame" hint="(clip passes through here)" onChange={setMidImg} presets={t.resolutions} showTwoStage={show.twoStage} />
          <ImagePanel key={`${target}-last`} label="Last Frame" hint="(clip ends here)" onChange={setLastImg} presets={t.resolutions} showTwoStage={show.twoStage} />
        </>
      ) : (
        <>
          <ImagePanel key={`${target}-first`} label="First Frame" hint="(clip starts here)" onChange={setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} />
          <ImagePanel key={`${target}-last`} label="Last Frame" hint="(clip ends here)" onChange={setLastImg} presets={t.resolutions} showTwoStage={show.twoStage} />
        </>
      ))}

      {/* Copy loaded image(s) into ComfyUI's input folder */}
      {showImage && currentImages().length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          <input
            value={comfyCfg.url} onChange={e => setComfyCfg({ ...comfyCfg, url: e.target.value })}
            placeholder="http://127.0.0.1:8188" spellCheck={false}
            style={{ flex: '0 1 220px', boxSizing: 'border-box', background: '#12121f', border: '1px solid #2e2e44', borderRadius: 7, padding: '6px 10px', color: '#e0e0f0', fontSize: 12, outline: 'none' }}
          />
          <button
            onClick={copyImagesToComfy} disabled={comfyCopyStatus.state === 'sending'}
            title={comfyCopyStatus.state === 'error' ? comfyCopyStatus.error : "Uploads the loaded image(s) into ComfyUI's input/ folder via its own /upload/image API — needs ComfyUI running and started with --enable-cors-header."}
            style={{
              padding: '6px 12px', borderRadius: 6, border: '1px solid #333',
              background: comfyCopyStatus.state === 'done' ? '#1a3a2a' : comfyCopyStatus.state === 'error' ? '#2a1020' : '#1a1a2e',
              color: comfyCopyStatus.state === 'done' ? '#4ade80' : comfyCopyStatus.state === 'error' ? '#f87171' : '#9a8fd8',
              fontSize: 11.5, cursor: comfyCopyStatus.state === 'sending' ? 'wait' : 'pointer',
            }}
          >
            {comfyCopyStatus.state === 'sending' ? 'Copying…'
              : comfyCopyStatus.state === 'done' ? '✓ Copied to ComfyUI'
              : comfyCopyStatus.state === 'error' ? '✕ Failed — hover for details'
              : '⇪ Copy to ComfyUI input'}
          </button>
        </div>
      )}

      {/* Admin system prompt */}
      {adminMode && (
        <div style={{ marginBottom: 18, background: '#0e0e1c', border: '1px solid #3a2f6e', borderRadius: 10, padding: '12px 16px' }}>
          <button
            onClick={() => setAdminSystemOpen(v => !v)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#9a8fd8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: adminSystemOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
              System Prompt
            </span>
            <span style={{ fontSize: 10, color: '#555' }}>editable · sent on every generation</span>
          </button>
          {adminSystemOpen && (
            <div style={{ marginTop: 12 }}>
              <textarea value={adminSystem} onChange={e => setAdminSystem(e.target.value)} rows={12}
                style={{ width: '100%', boxSizing: 'border-box', background: '#12121f', border: '1px solid #2e2e44', borderRadius: 8, padding: '10px 12px', color: '#b0b8d0', fontSize: 12, fontFamily: 'monospace', resize: 'vertical', outline: 'none', lineHeight: 1.5 }} />
              <button onClick={() => setAdminSystem(systemPromptFor(t, frameMode))} style={{ marginTop: 6, fontSize: 11, color: '#777', background: 'none', border: '1px solid #333', borderRadius: 5, padding: '3px 10px', cursor: 'pointer' }}>Reset to default</button>
            </div>
          )}
        </div>
      )}

      {/* Admin user message review */}
      {adminMode && pendingSend && (
        <div style={{ marginBottom: 18, background: '#0e0e1c', border: '1px solid #3a2f6e', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: '#9a8fd8', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>User Message · review & edit before sending</div>
          <textarea value={adminUserMsg} onChange={e => setAdminUserMsg(e.target.value)} rows={10}
            style={{ width: '100%', boxSizing: 'border-box', background: '#12121f', border: '1px solid #2e2e44', borderRadius: 8, padding: '10px 12px', color: '#b0b8d0', fontSize: 12, fontFamily: 'monospace', resize: 'vertical', outline: 'none', lineHeight: 1.5 }} />
          <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
            <button onClick={sendToWriter} disabled={writing}
              style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: writing ? '#2a2a3f' : 'linear-gradient(135deg, #5a4fcf, #8b5cf6)', color: writing ? '#555' : '#fff', fontSize: 14, fontWeight: 600, cursor: writing ? 'not-allowed' : 'pointer', transition: 'all 0.15s' }}>
              {writing ? '✦ Writing prompt…' : '→ Send to Writer'}
            </button>
            <button onClick={() => setPendingSend(false)} disabled={writing}
              style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #333', background: 'none', color: '#666', fontSize: 13, cursor: writing ? 'not-allowed' : 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Generate button */}
      <button onClick={enhance} disabled={genBtnDisabled} style={genBtnStyle}>
        {buttonLabel}
      </button>

      {/* Global error */}
      {globalError && (
        <div style={{ marginTop: 16, padding: '12px 14px', background: '#2a1020', border: '1px solid #5a2030', borderRadius: 8, fontSize: 13, color: '#f87171' }}>{globalError}</div>
      )}

      {/* Vision caption */}
      {caption && (
        <details style={{ marginTop: 16, background: '#0e0e1c', border: '1px solid #2a2a3f', borderRadius: 8, padding: '10px 14px' }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: '#6f7a92', textTransform: 'uppercase', letterSpacing: '0.5px' }}>👁 vision description (read-only) · {effectiveVision}</summary>
          <div style={{ marginTop: 8, fontSize: 12.5, color: '#9aa6c0', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{caption}</div>
        </details>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {results.some(r => r.text) && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={exportBundle} style={{ fontSize: 11, color: '#9a8fd8', background: 'none', border: '1px solid #2d2060', borderRadius: 6, padding: '5px 12px', cursor: 'pointer' }}>
                Export ZIP (images + prompt{results.filter(r => r.text).length > 1 ? 's' : ''}) ↓
              </button>
            </div>
          )}
          {results.map((r, i) => (
            <div key={i}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{r.label}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {r.usage && <span style={{ fontSize: 11, color: '#555' }}>in {r.usage.input_tokens} · out {r.usage.output_tokens} tokens</span>}
                  {r.text && <button onClick={() => copy(i)} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #333', background: copied === i ? '#1a3a2a' : '#1a1a2e', color: copied === i ? '#4ade80' : '#888', fontSize: 11, cursor: 'pointer' }}>{copied === i ? '✓ Copied' : 'Copy'}</button>}
                </div>
              </div>
              {r.loading && <div style={{ padding: '18px 20px', background: '#0e0e1c', border: '1px solid #2e2e44', borderRadius: 10, fontSize: 13, color: '#555' }}>Generating…</div>}
              {r.error && <div style={{ padding: '12px 14px', background: '#2a1020', border: '1px solid #5a2030', borderRadius: 8, fontSize: 13, color: '#f87171' }}>Error: {r.error}</div>}
              {r.text && (
                <textarea value={r.text} onChange={e => editResult(i, e.target.value)}
                  rows={Math.max(4, Math.ceil(r.text.length / 70))} spellCheck={false}
                  style={{ width: '100%', boxSizing: 'border-box', background: '#0e0e1c', border: '1px solid #2e2e44', borderRadius: 10, padding: '18px 20px', fontSize: 13.5, lineHeight: 1.8, color: '#d0d0e8', whiteSpace: 'pre-wrap', fontFamily: "'Georgia', serif", resize: 'vertical', outline: 'none', transition: 'border-color 0.15s' }}
                  onFocus={e => e.target.style.borderColor = '#5a4fcf'} onBlur={e => e.target.style.borderColor = '#2e2e44'} />
              )}
            </div>
          ))}
        </div>
      )}
      </>)}

      {/* History */}
      <div style={{ marginTop: 28, borderTop: '1px solid #1e1e30', paddingTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <button onClick={() => setHistoryOpen(v => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#777', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: historyOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            History {history.length > 0 ? `(${history.length})` : ''}
          </button>
          {historyOpen && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input ref={importInputRef} type="file" accept=".json" style={{ display: 'none' }}
                onChange={e => { if (e.target.files[0]) importHistory(e.target.files[0]); e.target.value = '' }} />
              <button onClick={exportHistory} style={{ fontSize: 11, color: '#9a8fd8', background: 'none', border: '1px solid #2d2060', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>Export ↓</button>
              <button onClick={() => importInputRef.current?.click()} style={{ fontSize: 11, color: '#9a8fd8', background: 'none', border: '1px solid #2d2060', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>Import ↑</button>
              {history.length > 0 && <button onClick={clearHistory} style={{ fontSize: 11, color: '#a06a6a', background: 'none', border: '1px solid #3a2040', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>Clear</button>}
            </div>
          )}
        </div>
        {historyOpen && history.length === 0 && (
          <div style={{ fontSize: 12, color: '#555', padding: '8px 0' }}>No history yet.</div>
        )}
        {historyOpen && history.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {history.map((h, i) => {
              if (h.type === 'scriptwriter') {
                const ideaShort = h.idea && h.idea.length > 80 ? h.idea.slice(0, 80) + '…' : (h.idea || '')
                const phaseLabel = h.phase === 'done' ? 'Done' : h.phase === 'dircut' ? "Director's cut" : 'Script'
                return (
                  <div key={i} style={{ background: '#0e0e1c', border: '1px solid #2e2e44', borderRadius: 10, padding: '12px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: '#888' }}>{new Date(h.ts).toLocaleString()}</span>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                        <button onClick={() => restore(h)} style={{ fontSize: 11, color: '#c4b8ff', background: '#1e1850', border: '1px solid #3a2f6e', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>Restore</button>
                        <button onClick={() => removeHistoryEntry(h.id)} style={{ fontSize: 11, color: '#777', background: 'none', border: '1px solid #333', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>✕</button>
                      </div>
                    </div>
                    <div style={{ fontSize: 11.5, color: '#9a8fd8', marginBottom: 4 }}>
                      Scriptwriter · {h.model} · {phaseLabel}
                      {h.script ? ` · ${h.script.scenes?.length ?? 0} scenes` : ''}
                      {h.directorsCut ? ` · ${h.directorsCut.shots?.length ?? 0} shots` : ''}
                      {h.finalPrompts ? ` · ${h.finalPrompts.filter(p => p.text).length} prompts` : ''}
                    </div>
                    {h.script?.title && <div style={{ fontSize: 12, color: '#c4b8ff', fontWeight: 600, marginBottom: 4 }}>{h.script.title}</div>}
                    {ideaShort && <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6, fontStyle: 'italic' }}>"{ideaShort}"</div>}
                    {h.finalPrompts && h.finalPrompts.filter(p => p.text).length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                        {h.finalPrompts.filter(p => p.text).map((p, pi) => (
                          <div key={pi} style={{ background: '#12121f', border: '1px solid #2a2a3f', borderRadius: 8, padding: '8px 10px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                              <span style={{ fontSize: 10, color: '#7c6af7', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Shot {p.shotNumber} · {p.sceneTitle}</span>
                              <button onClick={() => navigator.clipboard.writeText(p.text)} style={{ fontSize: 10, color: '#888', background: 'none', border: '1px solid #333', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>Copy</button>
                            </div>
                            <div style={{ fontSize: 12.5, color: '#cfcfe0', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: "'Georgia', serif" }}>{p.text}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              }

              const tg = TARGETS[h.target]
              const ml = h.outputCount === 1 ? h.model : '3 variants'
              const sl = STYLE_OPTIONS.find(s => s.id === h.style)?.label
              const cl = CREATIVITY_OPTIONS.find(c => c.id === h.creativity)?.label
              const moves = (h.moves || []).map(moveLabel)
              return (
                <div key={i} style={{ background: '#0e0e1c', border: '1px solid #2e2e44', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: '#888' }}>{new Date(h.ts).toLocaleString()}</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                      <button onClick={() => restore(h)} style={{ fontSize: 11, color: '#c4b8ff', background: '#1e1850', border: '1px solid #3a2f6e', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>Restore settings</button>
                      <button onClick={() => removeHistoryEntry(h.id)} style={{ fontSize: 11, color: '#777', background: 'none', border: '1px solid #333', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>✕</button>
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, color: '#9a8fd8', marginBottom: 6 }}>
                    {tg?.label} · {ml}{h.vision ? ` · 👁 ${h.vision}` : ''}{h.duration && tg?.type !== 'image' ? ` · ${h.duration}` : ''}{sl && sl !== 'Auto' ? ` · ${sl}` : ''}{cl && cl !== 'Balanced' ? ` · ${cl}` : ''}{h.frameMode === 'firstlast' ? ' · first→last' : h.frameMode === 'firstmidlast' ? ' · first→mid→last' : h.frameMode === 'last' ? ' · last frame' : h.frameMode === 'ref' ? ' · reference' : ''}{h.ratio ? ` · ${h.ratio}` : ''}
                  </div>
                  {moves.length > 0 && <div style={{ fontSize: 11, color: '#777', marginBottom: 6 }}>Camera: {moves.join(', ')}</div>}
                  <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6 }}>{h.scene ? h.scene : <span style={{ color: '#666' }}>(proposed from image)</span>}</div>
                  {h.dialogue && <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6 }}>Dialogue: "{h.dialogue}"{h.delivery ? ` (${h.delivery})` : ''}</div>}
                  {h.soundscape && <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6 }}>Soundscape: {h.soundscape}</div>}
                  {h.music && <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6 }}>Music: {h.music}</div>}
                  {h.negative && <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6 }}>Avoid: {h.negative}</div>}
                  {(h.firstImg || h.midImg || h.lastImg) && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                      {[h.firstImg, h.midImg, h.lastImg].filter(Boolean).map((im, ii) =>
                        typeof im === 'object' && im.base64
                          ? <img key={ii} src={`data:${im.mediaType || 'image/jpeg'};base64,${im.base64}`} alt={im.fileName} title={im.fileName}
                              style={{ width: 40, height: 30, objectFit: 'cover', borderRadius: 4, border: '1px solid #333' }} />
                          : <span key={ii} style={{ fontSize: 11, color: '#777' }}>{im}</span>
                      )}
                    </div>
                  )}
                  {h.refImages && h.refImages.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                      {h.refImages.map((im, ii) =>
                        typeof im === 'object' && im.base64
                          ? <img key={ii} src={`data:${im.mediaType || 'image/jpeg'};base64,${im.base64}`} alt={im.fileName} title={`${im.fileName} (${im.role})`}
                              style={{ width: 40, height: 30, objectFit: 'cover', borderRadius: 4, border: '1px solid #333' }} />
                          : <span key={ii} style={{ fontSize: 11, color: '#777' }}>{im}</span>
                      )}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
                    {(h.outputs || []).map((o, oi) => (
                      <div key={oi} style={{ background: '#12121f', border: '1px solid #2a2a3f', borderRadius: 8, padding: '8px 10px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <span style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{o.label}</span>
                          <button onClick={() => navigator.clipboard.writeText(o.text)} style={{ fontSize: 10, color: '#888', background: 'none', border: '1px solid #333', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>Copy</button>
                        </div>
                        <div style={{ fontSize: 12.5, color: '#cfcfe0', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: "'Georgia', serif" }}>{o.text}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

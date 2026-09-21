import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { flushSync } from 'react-dom'
import JSZip from 'jszip'
import {
  TARGETS, TARGET_GROUPS, DURATION_OPTIONS, OUTPUT_COUNT_OPTIONS, VARIANT_TEMPS, VARIANT_NUDGES,
  GROK_IMAGE_RESOLUTIONS,
  STYLE_OPTIONS, CREATIVITY_OPTIONS, CAMERA_GROUPS,
  PROMPT_LENGTH_OPTIONS, PROMPT_LENGTH_INJECT,
  VISION_PROMPT_LTX_SINGLE, VISION_PROMPT_LTX_FIRSTLAST, VISION_PROMPT_LTX_FIRSTMIDLAST,
  DEFAULT_FRAME_MODE_OPTIONS, VISION_PROMPT_MINIMAX_H3_REF,
  MINIMAX_H3_REF_ROLES, MINIMAX_H3_PRESERVE_OPTIONS, ROLE_NONE, ROLE_GENERAL, normalizeRole, imageRoleDef,
  SPOKEN_LANGUAGES, DEFAULT_SPOKEN_LANG, spokenLangDef,
  systemPromptFor, caps, aspectParts,
} from './constants'
import { loadCfg, saveCfg, callOllama, generateImages, generateImagesGemini, generateVideo, fetchModels, pickWriter, pickVision, providerOf, isAnthropic, isGrok, isOpenRouter, isCloud } from './api'
import { loadComfyCfg, saveComfyCfg, uploadImage as uploadComfyImage, sendShot as sendComfyShot } from './comfy'
import {
  listHistory, getHistoryEntry, addHistoryEntry, deleteHistoryEntry, updateHistoryEntry,
  clearHistory as dbClearHistory, generateId, migrateFromLocalStorage, migrateFromIndexedDB,
  setHistoryEntryProject, loadProjects, saveProjects, importEntries,
  getCaption, putCaption, clearCaptions,
  listLibrary, addLibraryItem, updateLibraryItem, deleteLibraryItem,
  listImageMeta, patchImageMetaRecord,
  listVoiceLibrary, addVoiceLibraryItem, updateVoiceLibraryItem, deleteVoiceLibraryItem,
  checkHealth, setWriteErrorHandler, HISTORY_EXPORT_URL,
} from './db'
import { btn, selStyle, presetById, syllableBudget, imageHash, visionCacheKey, mapWithConcurrency, blobUrlToBase64, shrinkToJpeg } from './utils'
import { loadLoras, saveLoras, lorasByIds, withLoraTriggers, targetTakesLoras } from './loras'
import ConfigBar from './components/ConfigBar'
import ModelSelect from './components/ModelSelect'
import ImagePanel from './components/ImagePanel'
import HistoryImageGallery from './components/HistoryImageGallery'
import ScriptwriterPanel from './components/ScriptwriterPanel'
import MinimaxRefPanel from './components/MinimaxRefPanel'
import AdaptPanel from './components/AdaptPanel'
import LoraPanel from './components/LoraPanel'
import QueuePanel from './components/QueuePanel'
import HistoryPanel from './components/HistoryPanel'
import { useHistoryFilters } from './hooks/useHistoryFilters'
import { useAdminReview } from './hooks/useAdminReview'
import { useRenderSettings } from './hooks/useRenderSettings'
import { useQueue } from './hooks/useQueue'
import { useImageSlots } from './hooks/useImageSlots'
import {
  buildSnapshot as buildWorkspaceSnapshot, snapshotToWorkspace,
  hasRequiredImages, canGenerate as canGenerateFrom, isProposeMode,
  refAudiosFromSnap,
} from './workspace'
import { buildStylePart, buildWriterUserText, h3ModeFor } from './adapt'
import H3SyntaxBadge from './components/H3SyntaxBadge'
import { buildManualH3, buildManualSeed, buildH3Template } from './manualH3'

const buildVariants = (writer) => VARIANT_TEMPS.map((temp, i) => ({
  label: `${writer} · T${temp}`,
  temp,
  nudge: VARIANT_NUDGES[i] || '',
}))

// MiniMax H3 Manual mode (src/manualH3.js) — the seed text dropped straight
// into the Scene textarea (not just shown as a placeholder) the moment the
// toggle switches on with nothing typed yet is now built dynamically from the
// actual configured references by buildManualSeed() (src/manualH3.js), not a
// fixed example — see the toggle's onClick and scenePlaceholder below. The
// tag legend below is kept OUT of the seed itself (shown separately) since it
// would otherwise become literal prose in the assembled prompt.
const MANUAL_H3_LEGEND_REF =
  '[Shot N] marks each cut · <Subject N>/<Picture N> per your reference list below · '
  + '(S1) the first time a subject speaks · [Language] "…" is spoken dialogue'
const MANUAL_H3_LEGEND_DEFAULT =
  '[Shot N] marks each cut · (S1) the first time a speaker appears · [Language] "…" is spoken dialogue'

// "Generate for" rail groups, with any ungrouped target swept into a trailing
// "Other" group so a newly-added TARGETS entry is never silently hidden.
const RAIL_GROUPS = (() => {
  const grouped = new Set(TARGET_GROUPS.flatMap(g => g.ids))
  const leftover = Object.keys(TARGETS).filter(id => !grouped.has(id))
  return leftover.length ? [...TARGET_GROUPS, { label: 'Other', ids: leftover }] : TARGET_GROUPS
})()
const imgExt = (mediaType) => ((mediaType || 'image/jpeg').split('/')[1] || 'jpg').replace('jpeg', 'jpg')
const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader()
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '')
  fr.onerror = () => reject(fr.error)
  fr.readAsDataURL(blob)
})

export default function App() {
  const [cfg, setCfg]                 = useState(loadCfg)
  const [models, setModels]           = useState([])
  const [modelStatus, setModelStatus] = useState({ loading: true, ok: false, error: '' })
  const [comfyCfg, setComfyCfg]       = useState(loadComfyCfg)
  const [comfyCopyStatus, setComfyCopyStatus] = useState({ state: 'idle' })
  const [comfySendStatus, setComfySendStatus] = useState({ state: 'idle', idx: null })
  // Id of the history entry the current results were last saved as — so a 🎨 Render can
  // patch its `outputs` in place instead of spawning a new entry.
  const lastSavedEntryIdRef = useRef(null)
  const resultsRef = useRef([])            // freshest `results` for the long-running video poll
  const videoAbortRef = useRef(new Map())  // result idx -> AbortController for an in-flight video render

  const [target, setTarget]           = useState('minimax_h3')
  const [scene, setScene]             = useState('')
  const [duration, setDuration]       = useState('8 seconds')

  // The 🎨 / 🎬 render strip's settings (image aspect/count/resolution, video
  // duration/resolution/aspect/audio, provider, per-image upscale status). None of
  // it is saved in history or seen by the writer — see src/hooks/useRenderSettings.js.
  // Declared after `duration` because it follows it: rendering a clip defaults to
  // the length the prompt was written for.
  const render = useRenderSettings(duration)

  // 🎨 Render availability. Grok render needs an xAI backend; Gemini render needs only a
  // key (works on any backend). `imgProvider` is what a click actually uses.
  const grokRenderOn = isGrok(cfg.base)
  const geminiRenderOn = !!(cfg.geminiKey && cfg.geminiKey.trim())
  const canRender = grokRenderOn || geminiRenderOn
  const imgProvider = grokRenderOn && geminiRenderOn ? render.provider : (grokRenderOn ? 'grok' : 'gemini')
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
  // MiniMax H3 "Manual mode" — write the H3 prompt yourself, zero AI calls.
  // See src/manualH3.js. manualWarnings are the non-blocking notices from the
  // last successful assembly (a declared-but-unreferenced tag, etc.).
  const [manualMode, setManualMode]   = useState(false)
  const [manualWarnings, setManualWarnings] = useState([])
  // The LoRA library is shared with the Scriptwriter and persisted on every
  // edit; which of them a given generation uses is per-workspace state, so it
  // travels with history and the queue like any other input.
  const [loras, setLoras] = useState(loadLoras)
  const [activeLoraIds, setActiveLoraIds] = useState([])
  // Which named character an active *character*-kind LoRA's trigger belongs to
  // (id → name) — only meaningful with 2+ active at once, where the writer
  // otherwise has no way to tell which trigger goes with which person. Typed
  // next to that LoRA's chip in LoraPanel; a 'style' LoRA never has one.
  const [loraSubjects, setLoraSubjects] = useState({})
  const setLoraSubject = (id, name) => setLoraSubjects(prev => ({ ...prev, [id]: name }))
  const saveLoraLibrary = (list) => { setLoras(list); saveLoras(list) }
  const toggleLora = (id) => setActiveLoraIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  // The language everyone in the video speaks. Lives outside the Dialogue block
  // because a target can need it with no typed dialogue at all (H3 writes a line
  // itself for a voice reference; DramaBox is all speech and shows no Dialogue
  // block). show.spokenLang is the gate — see TARGETS.
  const [spokenLangId, setSpokenLangId] = useState(DEFAULT_SPOKEN_LANG)
  const [frameMode, setFrameMode]     = useState(() => TARGETS['minimax_h3'].defaultFrameMode || 'single')
  // Input images: the three frame slots, the H3 reference list and its voice
  // reference, plus the seed handoff for a thumbnail picked from history. They move
  // as a set (switching target or frame mode clears all of them), so they live
  // together — see src/hooks/useImageSlots.js.
  const imgs = useImageSlots()
  // A character-kind LoRA is "active" either via the free chip toggle
  // (activeLoraIds/loraSubjects — the only mechanism for H3's non-ref frame
  // modes, which have no reference images, and for every other target) OR by
  // being assigned directly on a reference image's own card (`im.loraId` —
  // MinimaxRefPanel.jsx, H3 ref mode only). Union of both, deduped; a
  // structurally-bound LoRA's `subject` names the image it belongs to
  // (consumed only by loraInstruction() in src/loras.js, writer-LLM text).
  const characterLoraIdsFromImages = imgs.refImages.map(im => im.loraId).filter(Boolean)
  const unionLoraIds = [...new Set([...activeLoraIds, ...characterLoraIdsFromImages])]
  const activeLoras = lorasByIds(loras, unionLoraIds).map(l => {
    if (l.kind !== 'character') return l
    const boundImage = imgs.refImages.find(im => im.loraId === l.id)
    if (boundImage) return { ...l, subject: `the subject in Image ${imgs.refImages.indexOf(boundImage) + 1}` }
    return loraSubjects[l.id]?.trim() ? { ...l, subject: loraSubjects[l.id].trim() } : l
  })
  const [soundscape, setSoundscape]   = useState('')
  const [music, setMusic]             = useState('')
  const [h3RatioId, setH3RatioId]     = useState(
    TARGETS['minimax_h3'].defaultFrameMode === 'ref' ? 'port916' : ''
  )
  const [cameraOpen, setCameraOpen]   = useState(false)
  const [flashId, setFlashId]         = useState(null)
  const [results, setResults]         = useState([])
  const [caption, setCaption]         = useState('')
  const [savedCaption, setSavedCaption] = useState('')  // caption as generated/restored — for hand-edit detection
  const [visionStats, setVisionStats] = useState(null)  // { fromCache, fresh } for the last vision run
  const [adaptSourceOverride, setAdaptSourceOverride] = useState(null)  // set by a history card's "⇄ Adapt"
  const [visionBusy, setVisionBusy]   = useState(false)
  const [globalError, setGlobalError] = useState('')
  const [copied, setCopied]           = useState(null)
  const [savedEditFlash, setSavedEditFlash] = useState(false)
  const [history, setHistory]         = useState([])
  const [imageMeta, setImageMeta]     = useState({})   // per-image role + per-role descriptions, by content hash — see server/imageMetaStore.mjs
  const [library, setLibrary]         = useState([])   // standalone reusable images — see "Reuse image from history"
  const [voiceLibrary, setVoiceLibrary] = useState([])  // standalone reusable voice samples — see "Reuse voice"
  const [historyOpen, setHistoryOpen] = useState(false)
  const [restoringId, setRestoringId] = useState(null)   // entry whose inline fetch is in flight
  const [projects, setProjects]       = useState([])
  const [historyDown, setHistoryDown] = useState(false)   // sidecar unreachable → banner
  const [activeProject, setActiveProject] = useState('')       // '' = save new generations unfiled
  // Admin mode — see and edit the system prompt and user message before sending.
  // Declared after `t`/`frameMode` further down would be neater, but state has to
  // come before the effects that use it; the hook itself owns the reset-on-target
  // -change effect. See src/hooks/useAdminReview.js.
  const admin = useAdminReview(TARGETS[target], frameMode)
  // Queue: pending "generate this later" items, persisted server-side (see db.js).
  // The hook owns its state and the run bookkeeping every job kind shares; the two
  // job bodies stay here, below. See src/hooks/useQueue.js.
  const queue = useQueue()
  const enhanceRef = useRef(null)      // always the freshest enhance() closure — see runQueueItem
  const [scriptwriterKey, setScriptwriterKey] = useState(0)
  const [scriptwriterInitial, setScriptwriterInitial] = useState(null)
  // Full Auto (Scriptwriter): the job snapshot fed to the next ScriptwriterPanel
  // mount, and the resolver for runScriptwriterQueueItem's pending promise —
  // see that function and ScriptwriterPanel's `autoJob`/`onAutoJobDone` props.
  const [scriptwriterAutoJob, setScriptwriterAutoJob] = useState(null)
  const scriptwriterAutoResolveRef = useRef(null)
  const importInputRef = useRef(null)
  const projectsLoadedRef = useRef(false)   // don't PUT [] over the store before the load resolves
  const captionMemRef = useRef(new Map())  // L1 for the persistent caption cache; key = visionCacheKey(...)
  const sceneTextareaRef = useRef(null)

  const t = TARGETS[target]
  const show = t.show                 // which controls render
  const tcaps = caps(t)               // what the target can actually do
  const showImage = show.image !== false
  // Reference mode: this target takes a list of role-tagged reference images
  // instead of fixed frame slots.
  const refMode = !!tcaps.refImages && frameMode === 'ref'

  const effectiveWriter = models.length ? writerModel : writerManual.trim()
  const effectiveVision = models.length ? visionModel : visionManual.trim()

  // The compose panel as one plain object, for the pure helpers in src/workspace.js
  // (snapshot building and the generation gates) and for AdaptPanel, which needs
  // most of the same values. `targetType`/`show` are what the gates and the
  // per-target field gating read.
  //
  // `promptLength` rides along but is deliberately NOT in WORKSPACE_FIELDS: it
  // shapes the instruction sent to the writer and was never saved in history, so a
  // restored entry keeps the current setting rather than an old one. The registry
  // governs what persists; this object is just "the panel right now".
  const workspace = {
    targetType: t.type, show,
    target, duration, style, creativity, frameMode, negative, scene,
    dialogue, delivery, spokenLangId, activeLoraIds, loraSubjects, manualMode,
    firstImg: imgs.firstImg, midImg: imgs.midImg, lastImg: imgs.lastImg,
    h3RatioId, soundscape, music, refImages: imgs.refImages, refAudios: imgs.refAudios,
    promptLength,
  }

  // The other direction: snapshotToWorkspace() returns exactly these keys, and
  // this is the only place that knows which setter each one belongs to. Adding a
  // compose field means one row in WORKSPACE_FIELDS and one line here.
  const applyWorkspace = (values) => {
    const setters = {
      target: setTarget, duration: setDuration, style: setStyle, creativity: setCreativity,
      frameMode: setFrameMode, negative: setNegative, scene: setScene,
      dialogue: setDialogue, delivery: setDelivery,
      spokenLangId: setSpokenLangId, activeLoraIds: setActiveLoraIds, loraSubjects: setLoraSubjects,
      manualMode: setManualMode,
      firstImg: imgs.setFirstImg, midImg: imgs.setMidImg, lastImg: imgs.setLastImg,
      h3RatioId: setH3RatioId, soundscape: setSoundscape, music: setMusic,
      refImages: imgs.setRefImages, refAudios: imgs.setRefAudios,
    }
    for (const [key, value] of Object.entries(values)) setters[key]?.(value)
  }

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
    if (!projectsLoadedRef.current) return   // set true once the initial load resolves
    saveProjects(projects).catch(() => {})
  }, [projects])

  // History + captions + projects now live in the local sidecar (src/db.js → /api).
  // Load them, run the one-shot migrations from the old browser stores, and start
  // a health poll that drives the "server unreachable" banner.
  useEffect(() => {
    setWriteErrorHandler(() => setHistoryDown(true))
    let alive = true
    const boot = async () => {
      try {
        await migrateFromLocalStorage()
        await migrateFromIndexedDB()
      } catch { /* best effort */ }
      try {
        const [hist, projs] = await Promise.all([listHistory(), loadProjects()])
        if (!alive) return
        setHistory(hist)
        setProjects(projs)
        projectsLoadedRef.current = true
        setHistoryDown(false)
      } catch {
        if (alive) setHistoryDown(true)
      }
      // Best-effort — a failed queue/library load just leaves that panel
      // empty/stale, it must not trip the "history server unreachable"
      // banner on its own.
      queue.refresh()
      listLibrary().then(setLibrary).catch(() => {})
      listImageMeta().then(m => setImageMeta(m && typeof m === 'object' ? m : {})).catch(() => {})
      listVoiceLibrary().then(setVoiceLibrary).catch(() => {})
    }
    boot()
    const ping = setInterval(() => {
      checkHealth().then(() => alive && setHistoryDown(false)).catch(() => alive && setHistoryDown(true))
    }, 20000)
    return () => { alive = false; clearInterval(ping) }
  }, [])

  // Dropdowns and the history filter list every project that either has been
  // created explicitly (persisted, may be empty) or is referenced by an entry.
  const allProjects = useMemo(() => {
    const s = new Set(projects)
    for (const h of history) if (h.project) s.add(h.project)
    return [...s].sort((a, b) => a.localeCompare(b))
  }, [projects, history])

  const ensureProject = useCallback((name) => {
    const n = (name || '').trim()
    if (!n) return
    setProjects(prev => prev.includes(n) ? prev : [...prev, n].sort((a, b) => a.localeCompare(b)))
  }, [])

  // The history list's five filters, the option lists they need, and the filtered
  // result. Everything this returns is either stable or memoized, which is what
  // lets <HistoryPanel> sit behind React.memo.
  const histFilters = useHistoryFilters(history)
  const visibleHistory = histFilters.visible

  // The writer/vision model the user last chose, kept per provider in cfg.models
  // ({ anthropic: { writer, vision }, … }) so switching backends brings back that
  // backend's own pick instead of the auto-picker's. Only explicit choices are
  // stored — an auto-pick isn't, so a better default can still replace it later.
  const rememberModel = (kind, id) => {
    const slot = providerOf(cfg.base)
    setCfg(c => ({ ...c, models: { ...c.models, [slot]: { ...c.models?.[slot], [kind]: id } } }))
  }
  const pickedProviderRef = useRef(null)  // which provider the current selection was made under

  const reloadModels = async () => {
    setModelStatus({ loading: true, ok: false, error: '' })
    const slot = providerOf(cfg.base)
    const saved = cfg.models?.[slot] || {}
    const switched = pickedProviderRef.current !== slot
    // Same provider (key change, manual refresh): keep the live selection, e.g. one a
    // history restore set. New provider: the live selection belongs to the old one.
    const choose = (prev, savedId, pick, ids) =>
      (!switched && prev && ids.includes(prev)) ? prev
        : (savedId && ids.includes(savedId)) ? savedId
        : (prev && ids.includes(prev)) ? prev
        : pick(ids)
    try {
      const ids = await fetchModels(cfg)
      setModels(ids)
      setModelStatus({ loading: false, ok: true, error: '' })
      setWriterModel(prev => choose(prev, saved.writer, pickWriter, ids))
      setVisionModel(prev => choose(prev, saved.vision, pickVision, ids))
      pickedProviderRef.current = slot
    } catch (e) {
      setModels([])
      setModelStatus({ loading: false, ok: false, error: e.message })
      if (switched) {
        if (saved.writer) setWriterManual(saved.writer)
        if (saved.vision) setVisionManual(saved.vision)
        pickedProviderRef.current = slot
      }
    }
  }
  useEffect(() => { reloadModels() }, [cfg.base, cfg.apiKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (adaptSourceOverride) document.getElementById('adapt-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [adaptSourceOverride])

  resultsRef.current = results
  const abortAllVideos = () => { videoAbortRef.current.forEach(c => c.abort()); videoAbortRef.current.clear() }
  useEffect(() => () => abortAllVideos(), [])

  // Full re-list. Only for boot, import and clear — see syncHistoryEntry below.
  const refreshHistory = useCallback(() => listHistory().then(h => { setHistory(h); setHistoryDown(false) }).catch(() => setHistoryDown(true)), [])

  // Library items are a handful of fields, written only on an explicit user
  // drop (rare, human-paced) — unlike history there's no debounced-autosave
  // hot path to optimize for, so a full re-list after every add/remove (like
  // queue.refresh()) is simplest and correct.
  const refreshLibrary = useCallback(() => listLibrary().then(setLibrary).catch(() => {}), [])

  // One role + per-role descriptions record per image, keyed by content hash.
  // Merged into local state at once (the gallery and the Reference Image panel
  // read it) and PATCHed to the sidecar, which merges `captions` per role key.
  // The returned promise rejects on a failed write so a caller's own try/catch
  // can show it — a save must never look like it worked when it did not.
  const patchImageMeta = useCallback((hash, patch) => {
    if (!hash) return Promise.resolve()
    setImageMeta(prev => {
      const cur = prev[hash] || { role: null, captions: {} }
      const next = { ...cur }
      if ('role' in patch) next.role = patch.role || null
      if (patch.captions) next.captions = { ...(cur.captions || {}), ...patch.captions }
      return { ...prev, [hash]: next }
    })
    return patchImageMetaRecord(hash, patch)
  }, [])

  // Turns each dropped image File into bytes (the same shrinkToJpeg pipeline
  // ImagePanel's own file drop uses) and PUTs it as a new library item.
  // Bounded concurrency — a multi-file drop shouldn't fire N canvas re-encodes
  // and N multi-MB PUTs all at once.
  const addLibraryImages = useCallback((files) => {
    const imgs = Array.from(files || []).filter(f => f.type?.startsWith('image/'))
    if (!imgs.length) return Promise.resolve()
    return mapWithConcurrency(imgs, 3, async (file) => {
      const { base64, mediaType } = await shrinkToJpeg(file)
      return addLibraryItem({ id: generateId(), ts: Date.now(), fileName: file.name, mediaType, base64 })
    }).finally(refreshLibrary)
  }, [refreshLibrary])

  const removeLibraryImage = useCallback((id) => deleteLibraryItem(id).then(refreshLibrary), [refreshLibrary])

  // ── voice library ("Reuse voice") ────────────────────────────────────────
  const MAX_VOICE_LIBRARY_BYTES = 10 * 1024 * 1024 // matches MinimaxRefPanel/ScriptwriterVoiceRefs' own audio cap

  const refreshVoiceLibrary = useCallback(() => listVoiceLibrary().then(setVoiceLibrary).catch(() => {}), [])

  // Direct file-picker/drop upload straight into the library — no context to
  // infer a character from, so characterName starts blank (the user types it
  // by hand). No shrinkToJpeg-equivalent re-encode: audio is stored as-is.
  const addVoiceLibraryFiles = useCallback((files) => {
    const auds = Array.from(files || []).filter(f => f.type?.startsWith('audio/') && f.size <= MAX_VOICE_LIBRARY_BYTES)
    if (!auds.length) return Promise.resolve()
    return mapWithConcurrency(auds, 3, async (file) => {
      const base64 = await blobToBase64(file)
      return addVoiceLibraryItem({ id: generateId(), ts: Date.now(), fileName: file.name, mediaType: file.type || 'audio/mpeg', base64, characterName: '' })
    }).finally(refreshVoiceLibrary)
  }, [refreshVoiceLibrary])

  const removeVoiceLibraryItem = useCallback((id) => deleteVoiceLibraryItem(id).then(refreshVoiceLibrary), [refreshVoiceLibrary])

  const renameVoiceLibraryCharacter = useCallback((id, characterName) => {
    return updateVoiceLibraryItem(id, { characterName }).then(() => {
      setVoiceLibrary(prev => prev.map(x => (x.id === id ? { ...x, characterName } : x)))
    })
  }, [])

  // Read through a ref (not a closure dependency) so this callback stays
  // stable across renders even though it needs the live library array —
  // same trick historyActionsRef uses.
  const voiceLibraryRef = useRef([])
  voiceLibraryRef.current = voiceLibrary

  // Save a currently-in-use audio item ({ base64, mediaType, fileName } —
  // id/subjectRef/characterId are irrelevant here) into the library.
  // `contextName` is an already-resolved plain string from the caller (image
  // note/role for MinimaxRefPanel, bible character name for
  // ScriptwriterVoiceRefs) — this helper does no lookups of its own.
  // Dedupes by content hash so re-saving the same sample never creates a
  // duplicate row; it tops up a blank stored name from a non-blank context,
  // but never overwrites a name the user already typed.
  const saveAudioToVoiceLibrary = useCallback((audioItem, contextName) => {
    const hash = imageHash(audioItem.base64)
    const existing = voiceLibraryRef.current.find(v => v.hash === hash)
    if (existing) {
      if (contextName && !existing.characterName) return renameVoiceLibraryCharacter(existing.id, contextName)
      return Promise.resolve()
    }
    return addVoiceLibraryItem({
      id: generateId(), ts: Date.now(), fileName: audioItem.fileName,
      mediaType: audioItem.mediaType, base64: audioItem.base64, characterName: contextName || '',
    }).then(refreshVoiceLibrary)
  }, [refreshVoiceLibrary, renameVoiceLibraryCharacter])

  // Apply ONE entry's change locally instead of re-listing everything.
  //
  // `listHistory()` is the whole metadata array — ~640 KB at 72 entries — and it
  // used to be refetched after every single mutation, including the
  // Scriptwriter's 600 ms debounced autosave, i.e. roughly once a second while
  // editing a script. Each one also handed React a brand-new `history` identity,
  // which invalidated every history memo (search index, project/target/model
  // option lists, the gallery's image walk) and repainted the whole list.
  //
  // GET /api/history/:id returns the same row in the same shape — the sidecar
  // runs stripEntry() on both routes, so blob fields arrive as { url, hash, … }
  // with no bytes either way — just without the other 71 entries. Re-sorting by
  // ts desc keeps the order the sidecar itself uses (server/store.mjs byTsDesc).
  const syncHistoryEntry = useCallback((id) => getHistoryEntry(id)
    .then(row => {
      if (!row || !row.id) return
      setHistory(prev => (prev.some(h => h.id === row.id)
        ? prev.map(h => (h.id === row.id ? row : h))
        : [row, ...prev]
      ).sort((a, b) => (b.ts || 0) - (a.ts || 0)))
      setHistoryDown(false)
    })
    .catch(() => setHistoryDown(true)), [])

  // Same idea for a field we already know the new value of on every affected
  // entry (project rename/delete): no round trip at all.
  const patchHistoryLocal = useCallback((match, patch) => {
    setHistory(prev => prev.map(h => (match(h) ? { ...h, ...patch } : h)))
  }, [])

  // Kept in a ref so saveScriptHistory (a stable useCallback passed to the
  // scriptwriter panel) always reads the current selection without churning.
  const saveCtxRef = useRef({ activeProject: '', history: [] })
  saveCtxRef.current = { activeProject, history }

  const saveHistory = (snap, outputs, trackForRender = true) => {
    const entry = { ...snap, outputs, type: 'standard', id: generateId(), project: activeProject || null }
    // Only the live workspace results should become the 🎨 Render patch target — an
    // Adapt-panel save produces a separate entry the main results don't correspond to.
    if (trackForRender) lastSavedEntryIdRef.current = entry.id
    addHistoryEntry(entry).then(() => syncHistoryEntry(entry.id)).catch(() => {})
    return entry.id
  }
  const saveScriptHistory = useCallback((entry) => {
    const { activeProject: ap, history: hist } = saveCtxRef.current
    // The scriptwriter re-saves the same id across its three phases — keep a
    // project the user reassigned in the meantime rather than resetting it.
    const existing = hist.find(h => h.id === entry.id)
    const project = existing ? (existing.project ?? null) : (ap || null)
    addHistoryEntry({ ...entry, project }).then(() => syncHistoryEntry(entry.id)).catch(() => {})
  }, [syncHistoryEntry])

  const clearHistory = () => {
    if (!window.confirm(`Delete all ${history.length} generation${history.length === 1 ? '' : 's'} from history? This cannot be undone — use "Export ↓" first if you want a backup.`)) return
    dbClearHistory().then(() => setHistory([])).catch(() => setHistory([]))
  }
  const removeHistoryEntry = (id) => {
    deleteHistoryEntry(id).then(() => setHistory(prev => prev.filter(h => h.id !== id))).catch(() => {})
  }

  // Reassign one history entry. value '' → unfiled; '__new__' → prompt for a name.
  const assignEntryProject = async (id, value) => {
    let project = value
    if (value === '__new__') {
      project = (window.prompt('New project name:') || '').trim()
      if (!project) return
    }
    if (project) ensureProject(project)
    await setHistoryEntryProject(id, project || null).catch(() => {})
    syncHistoryEntry(id)
  }

  const createProject = () => {
    const n = (window.prompt('New project name:') || '').trim()
    if (!n) return
    ensureProject(n)
    setActiveProject(n)
  }
  const renameProject = async (oldName) => {
    const n = (window.prompt(`Rename project "${oldName}" to:`, oldName) || '').trim()
    if (!n || n === oldName) return
    for (const h of history.filter(x => x.project === oldName)) {
      await setHistoryEntryProject(h.id, n).catch(() => {})
    }
    setProjects(prev => {
      const next = prev.filter(p => p !== oldName)
      if (!next.includes(n)) next.push(n)
      return next.sort((a, b) => a.localeCompare(b))
    })
    setActiveProject(p => (p === oldName ? n : p))
    histFilters.retargetProjectFilter(oldName, n)
    patchHistoryLocal(h => h.project === oldName, { project: n })
  }
  const deleteProject = async (name) => {
    const n = history.filter(x => x.project === name).length
    if (!window.confirm(`Remove project "${name}"?${n ? ` Its ${n} generation${n > 1 ? 's' : ''} become Unfiled.` : ''}`)) return
    for (const h of history.filter(x => x.project === name)) {
      await setHistoryEntryProject(h.id, null).catch(() => {})
    }
    setProjects(prev => prev.filter(p => p !== name))
    setActiveProject(p => (p === name ? '' : p))
    histFilters.retargetProjectFilter(name, null)
    patchHistoryLocal(h => h.project === name, { project: null })
  }

  const exportHistory = () => {
    // The sidecar streams the full history (with image/video bytes rehydrated).
    const a = document.createElement('a')
    a.href = HISTORY_EXPORT_URL
    a.download = `prompt-enhancer-history-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
  }
  const importHistory = async (file) => {
    try {
      const entries = JSON.parse(await file.text())
      if (!Array.isArray(entries)) return
      await importEntries(entries)
      const names = new Set(projects)
      for (const entry of entries) if (entry && entry.project) names.add(entry.project)
      setProjects([...names].sort((a, b) => a.localeCompare(b)))
      refreshHistory()
    } catch {}
  }

  // Clicking a thumbnail in the history image gallery — route it to the right
  // slot for the current frame mode. (Drag-and-drop is handled inside the panels.)
  const pickHistoryImage = (data) => {
    // A target that accepts role-tagged references collects picks into that list
    // instead of filling a frame slot; caps.refImages is also the cap.
    if (refMode) {
      if (imgs.refImages.length >= tcaps.refImages) return
      imgs.setRefImages(prev => [...prev, {
        id: generateId(), base64: data.base64, mediaType: data.mediaType || 'image/jpeg',
        previewUrl: `data:${data.mediaType || 'image/jpeg'};base64,${data.base64}`,
        fileName: data.fileName || 'from-history.jpg',
        // Carry over the picked image's own role/note (falls back to the
        // default role for a non-ref-slot pick, e.g. a render, which has
        // neither) rather than always resetting to the first role — picking
        // an image that was previously e.g. a Wardrobe reference should stay
        // a Wardrobe reference by default. `captions` (role → text map)
        // travels too, purely so MinimaxRefPanel's Role dropdown can mark
        // which roles are already described for this exact image; the
        // content-addressed vision cache is what actually makes generation
        // reuse that description when the matching role is selected.
        role: data.role || MINIMAX_H3_REF_ROLES[0].id, preserve: 'strong', note: data.note || '',
        hash: data.hash || imageHash(data.base64),
        captions: data.captions || {},
      }])
      return
    }
    if (t.type === 'image' || frameMode === 'single' || frameMode === 'last') { imgs.bumpSeed('first', data); return }
    if (frameMode === 'firstlast') { imgs.bumpSeed(!imgs.firstImg ? 'first' : 'last', data); return }
    if (frameMode === 'firstmidlast') { imgs.bumpSeed(!imgs.firstImg ? 'first' : !imgs.midImg ? 'mid' : 'last', data) }
  }
  const galleryPickHint =
    refMode ? 'to add it as a reference'
    : frameMode === 'firstlast' || frameMode === 'firstmidlast' ? 'to fill the next empty frame'
    : 'to load it as the reference image'

  const currentImages = () => {
    const mt = (im) => im.mediaType || 'image/jpeg'
    if (frameMode === 'ref') {
      return imgs.refImages.map((im, i) => ({ name: `reference-${i + 1}-${im.role}.jpg`, base64: im.base64, mediaType: mt(im), role: 'ref' }))
    }
    if (frameMode === 'firstlast') {
      return [
        imgs.firstImg && { name: 'first-frame.jpg', base64: imgs.firstImg.base64, mediaType: mt(imgs.firstImg), role: 'first' },
        imgs.lastImg && { name: 'last-frame.jpg', base64: imgs.lastImg.base64, mediaType: mt(imgs.lastImg), role: 'last' },
      ].filter(Boolean)
    }
    if (frameMode === 'firstmidlast') {
      return [
        imgs.firstImg && { name: 'first-frame.jpg', base64: imgs.firstImg.base64, mediaType: mt(imgs.firstImg), role: 'first' },
        imgs.midImg && { name: 'mid-frame.jpg', base64: imgs.midImg.base64, mediaType: mt(imgs.midImg), role: 'mid' },
        imgs.lastImg && { name: 'last-frame.jpg', base64: imgs.lastImg.base64, mediaType: mt(imgs.lastImg), role: 'last' },
      ].filter(Boolean)
    }
    if (frameMode === 'last') {
      return imgs.firstImg ? [{ name: 'last-frame.jpg', base64: imgs.firstImg.base64, mediaType: mt(imgs.firstImg), role: 'last' }] : []
    }
    return imgs.firstImg ? [{ name: t.type === 'image' ? 'reference-image.jpg' : 'first-frame.jpg', base64: imgs.firstImg.base64, mediaType: mt(imgs.firstImg), role: 'first' }] : []
  }

  // A short filename-safe slug from the scene text, standing in for a title
  // this pipeline has no dedicated field for (unlike the Scriptwriter's
  // script.title). Empty when there's no scene text to draw one from (e.g.
  // MiniMax H3 ref mode, or a pure vision-only run) — the filename then just
  // omits the title component rather than carrying a placeholder.
  const titleSlug = (text, maxWords = 8) => String(text || '').trim().toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, '').split(/\s+/).filter(Boolean).slice(0, maxWords).join('-').slice(0, 60)
  // Ids are already short and mostly clean; a target only needs its own `slug` in
  // the table where the id reads as an internal detail rather than the model name
  // people know it by (minimax_h3 -> minimax).
  const modelSlug = (id) => TARGETS[id]?.slug || id.replace(/_/g, '-')

  // Builds one zip — the shared input image(s) + shared voice-reference audio
  // (imgs.refAudios, MiniMax H3 ref mode only — [] everywhere else) plus
  // `variantResults`' prompt(s)/renders/manifest — and triggers its download.
  // Shared between the normal (all variants in one zip) and per-variant
  // ("3 variants" mode, see exportBundle below) export paths so both stay
  // byte-identical in everything except which prompt(s) they carry.
  const buildExportZip = async (variantResults, filenameSuffix) => {
    const zip = new JSZip()
    const images = currentImages()
    for (const img of images) zip.file(img.name, img.base64, { base64: true })
    ;(imgs.refAudios || []).forEach((a, i) => {
      const ext = (a.fileName && a.fileName.includes('.') ? a.fileName.split('.').pop() : imgExt(a.mediaType)).toLowerCase()
      zip.file(`voice-reference-${i + 1}.${ext}`, a.base64, { base64: true })
    })
    const single = variantResults.length === 1
    variantResults.forEach((r, i) => {
      if (r.text) zip.file(single ? 'prompt.txt' : `prompt-${i + 1}.txt`, r.text)
      ;(r.images || []).forEach((img, k) => {
        if (img.b64) zip.file(`render-${i + 1}-${k + 1}.${imgExt(img.mediaType)}`, img.b64, { base64: true })
      })
      if (r.video?.b64) zip.file(single ? 'render.mp4' : `render-${i + 1}.mp4`, r.video.b64, { base64: true })
    })
    // manifest.json — same machine-readable shape the Scriptwriter's export uses
    // (see ScriptwriterPanel.jsx's exportBundle), so the comfyui-prompt-enhancer-
    // bridge node pack can drive a single image/video generation from this export
    // too, not just a scriptwriter film. Only meaningful for image/video targets
    // (dramabox/scriptwriter aren't ComfyUI-shaped output at all); the receiving
    // ComfyUI workflow still has to be wired for PEClipPrompt/PEClipImage itself —
    // this only ships the manifest, it doesn't make an arbitrary workflow work.
    if (t.type === 'image' || t.type === 'video') {
      // Every result/variant shares the same loaded input image(s) — ordered the
      // same way `images` already is, so index N here is index N in the zip and
      // in `images` (a 'ref'-mode item also carries its semantic role/preservation
      // from imgs.refImages, not just the generic 'ref' role currentImages() gives it).
      const references = images.map((img, idx) => {
        const ref = frameMode === 'ref' ? imgs.refImages[idx] : null
        return { file: img.name, role: (ref ? ref.role : img.role) || '', preserve: ref?.preserve || '' }
      })
      // Keep each clip's original `i` (not the post-filter position) so promptFile/
      // outputName still names the same file the loop above actually wrote — a
      // failed variant among 3 must not shift the other(s)' filenames.
      const clips = variantResults
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.text)
        .map(({ r, i }) => ({
          clipNumber: i + 1,
          sceneTitle: r.label || '',
          promptFile: single ? 'prompt.txt' : `prompt-${i + 1}.txt`,
          promptText: r.text,
          mode: images.length ? `image-to-${t.type}` : `text-to-${t.type}`,
          // `duration` is a free-text label ('8 seconds', '97 frames (~4 seconds)'),
          // not a number — pull the seconds figure out the same way syllableBudget() does.
          durationSec: show.duration ? (parseFloat(String(duration || '').match(/(\d+(?:\.\d+)?)\s*seconds?/)?.[1]) || null) : null,
          outputName: single ? 'prompt' : `prompt-${i + 1}`,
          references,
        }))
      if (clips.length) {
        zip.file('manifest.json', JSON.stringify({ title: titleSlug(scene) || target, target, type: t.type, clips }, null, 2))
      }
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const title = titleSlug(scene)
    a.download = `${title ? title + '-' : ''}${t.type}-${modelSlug(target)}${filenameSuffix}-${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }

  // "3 variants" mode used to bundle all three prompts into one zip. A variant
  // is meant to be picked, not diffed after the fact, so each successful
  // variant now gets its OWN self-contained zip — shared images/audio plus
  // just that variant's prompt (and its own renders, if any) — one download
  // per variant instead of one download holding three competing prompts.
  const exportBundle = async () => {
    const successful = results.filter(r => r.text)
    if (successful.length > 1) {
      for (let i = 0; i < results.length; i++) {
        if (results[i].text) await buildExportZip([results[i]], `-variant-${i + 1}`)
      }
    } else {
      await buildExportZip(results, '')
    }
  }

  // A previous copy's status shouldn't linger against a different set of loaded images.
  useEffect(() => { setComfyCopyStatus({ state: 'idle' }) }, [imgs.firstImg, imgs.midImg, imgs.lastImg, imgs.refImages])
  // Same for a send — the shot it reported on is no longer the one on screen.
  useEffect(() => { setComfySendStatus({ state: 'idle', idx: null }) }, [imgs.firstImg, imgs.midImg, imgs.lastImg, imgs.refImages, results])

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

  // Pushes one generated prompt to the Prompt Enhancer Bridge node pack in ComfyUI,
  // uploading the current image(s) first so the shot can name them by their input/
  // filename. A workflow wired to the bridge nodes then picks it all up on the next run.
  const sendShotToComfy = async (idx) => {
    if (!results[idx]?.text) return
    setComfySendStatus({ state: 'sending', idx })
    try {
      const images = { first: '', mid: '', last: '', ref: [] }
      for (const img of currentImages()) {
        // Prefer the name ComfyUI reports back — it, not ours, is what landed in input/.
        const name = await uploadComfyImage(img.base64, img.name, 'image/jpeg', comfyCfg.url) || img.name
        if (img.role === 'ref') images.ref.push(name)
        else images[img.role] = name
      }
      await sendComfyShot(
        { positive: results[idx].text, negative, target, duration, frameMode, images },
        comfyCfg.url, comfyCfg.slot,
      )
      setComfySendStatus({ state: 'done', idx })
      setTimeout(() => setComfySendStatus(prev =>
        prev.state === 'done' && prev.idx === idx ? { state: 'idle', idx: null } : prev), 2500)
    } catch (e) {
      setComfySendStatus({ state: 'error', idx, error: e.message })
    }
  }

  // Rebuild the history entry's `outputs` from the freshest results (with `override`
  // merged into result `idx`) and patch it onto the entry the results were last saved as.
  // Reads resultsRef so a 10-minute video poll doesn't persist against a stale array.
  const persistOutputs = async (idx, override) => {
    const outs = resultsRef.current
      .map((r, i) => (i === idx ? { ...r, ...override } : r))
      .filter(r => r.text && !r.error)
      .map(r => ({
        label: r.label, text: r.text,
        ...(r.images?.length ? { images: r.images } : {}),
        ...(r.video ? { video: r.video } : {}),
      }))
    const id = lastSavedEntryIdRef.current
    if (id) await updateHistoryEntry(id, { outputs: outs }).then(() => syncHistoryEntry(id)).catch(() => {})
    else saveHistory(buildSnapshot(caption || null, hasImgNow, outs.length), outs)
  }

  // Render one generated prompt into an actual image, then patch the images onto the
  // already-saved history entry (or save a fresh one as a fallback). Provider is
  // `imgProvider` (Grok via xAI /images/{generations,edits}, or Gemini via
  // generateContent). When input image(s) are loaded, both run image-to-image.
  const renderImage = async (idx) => {
    const prompt = resultsRef.current[idx]?.text
    if (!prompt || !canRender) return
    setResults(prev => prev.map((r, i) => i === idx ? { ...r, imgLoading: true, imgError: '' } : r))
    try {
      const refs = currentImages().map(im => ({ base64: im.base64, mediaType: im.mediaType }))
      let images
      if (imgProvider === 'gemini') {
        // Gemini returns one image per call — fan out for count > 1.
        const settled = await Promise.allSettled(
          Array.from({ length: Math.max(1, render.imageCount) }, () => generateImagesGemini(prompt, {
            key: cfg.geminiKey, model: cfg.geminiImageModel, aspectRatio: render.imageAspect, images: refs.slice(0, 3),
          }))
        )
        const ok = settled.filter(s => s.status === 'fulfilled').flatMap(s => s.value)
        if (!ok.length) throw new Error(settled.find(s => s.status === 'rejected')?.reason?.message || 'Gemini render failed.')
        images = ok.map(im => ({ b64: im.b64, mediaType: im.mediaType || 'image/png', revisedPrompt: im.revisedPrompt }))
      } else {
        const imgs = await generateImages(prompt, cfg, {
          n: render.imageCount, aspectRatio: render.imageAspect, resolution: render.imageResolution,
          images: refs.slice(0, 5),
        })
        images = imgs.map(im => ({ b64: im.b64, mediaType: im.mediaType || 'image/jpeg', revisedPrompt: im.revisedPrompt }))
      }
      setResults(prev => prev.map((r, i) => i === idx ? { ...r, images, imgLoading: false } : r))
      await persistOutputs(idx, { images })
    } catch (e) {
      setResults(prev => prev.map((r, i) => i === idx ? { ...r, imgLoading: false, imgError: e.message } : r))
    }
  }

  // Render one generated prompt into a video via xAI's video API (submit + poll).
  // With an input image loaded, the first frame is used for image-to-video.
  const renderVideo = async (idx) => {
    const prompt = resultsRef.current[idx]?.text
    if (!prompt || !isGrok(cfg.base)) return
    videoAbortRef.current.get(idx)?.abort()
    const ctrl = new AbortController()
    videoAbortRef.current.set(idx, ctrl)
    const inputImg = currentImages()[0] || null
    const imageDataUri = inputImg ? `data:${inputImg.mediaType || 'image/jpeg'};base64,${inputImg.base64}` : undefined
    setResults(prev => prev.map((r, i) => i === idx ? { ...r, vidLoading: true, vidError: '', vidProgress: 0, vidStatus: 'pending' } : r))
    try {
      const { url, duration } = await generateVideo(prompt, cfg, {
        duration: render.videoDuration, resolution: render.videoResolution, aspectRatio: render.videoAspect,
        audio: render.videoAudio, image: imageDataUri, signal: ctrl.signal,
        onProgress: (s, p) => setResults(prev => prev.map((r, i) => i === idx ? { ...r, vidStatus: s, vidProgress: p } : r)),
      })
      let video = { url, mediaType: 'video/mp4', duration }
      // The video is a temporary vidgen.x.ai URL — try to capture the bytes for history /
      // offline / ZIP. A cross-origin block leaves it URL-only (still playable in <video>).
      try {
        const resp = await fetch(url, { signal: ctrl.signal })
        if (resp.ok) {
          const blob = await resp.blob()
          video = { url, b64: await blobToBase64(blob), mediaType: blob.type || 'video/mp4', duration }
        }
      } catch { /* keep URL-only */ }
      setResults(prev => prev.map((r, i) => i === idx ? { ...r, video, vidLoading: false, vidProgress: 100 } : r))
      await persistOutputs(idx, { video })
    } catch (e) {
      if (e.name === 'AbortError') setResults(prev => prev.map((r, i) => i === idx ? { ...r, vidLoading: false } : r))
      else setResults(prev => prev.map((r, i) => i === idx ? { ...r, vidLoading: false, vidError: e.message } : r))
    } finally {
      if (videoAbortRef.current.get(idx) === ctrl) videoAbortRef.current.delete(idx)
    }
  }

  // "Upscale to 2K" — re-run one rendered image through Grok img2img at resolution:2k.
  // It's an edit pass, not a true upscaler, so fine detail shifts slightly.
  const upscaleImage = async (i, k) => {
    const r = resultsRef.current[i]
    const img = r?.images?.[k]
    if (!img?.b64 || !isGrok(cfg.base)) return
    const key = `${i}-${k}`
    render.setUpStatus(s => ({ ...s, [key]: 'loading' }))
    try {
      const out = await generateImages(r.text, cfg, {
        images: [{ base64: img.b64, mediaType: img.mediaType }],
        resolution: '2k', aspectRatio: render.imageAspect,
      })
      if (!out[0]?.b64) throw new Error('No image returned')
      const newImg = { b64: out[0].b64, mediaType: out[0].mediaType || img.mediaType, revisedPrompt: out[0].revisedPrompt || img.revisedPrompt, upscaled: true }
      const nextImages = r.images.map((im, ki) => ki === k ? newImg : im)
      setResults(prev => prev.map((rr, ri) => ri === i ? { ...rr, images: nextImages } : rr))
      render.setUpStatus(s => { const n = { ...s }; delete n[key]; return n })
      await persistOutputs(i, { images: nextImages })
    } catch (e) {
      render.setUpStatus(s => ({ ...s, [key]: { error: e.message } }))
    }
  }

  const restore = async (hMeta) => {
    if (restoringId) return
    // History rows carry no image bytes — pull the full entry (blob fields
    // rehydrated) so the image panels, ComfyUI copy and ZIP export work.
    let h = hMeta
    setRestoringId(hMeta.id)
    try { h = await getHistoryEntry(hMeta.id, { inline: true }) || hMeta } catch { /* offline → settings-only restore */ }
    finally { setRestoringId(null) }
    // Continue working in the same project the restored generation belongs to.
    if (h.project) { ensureProject(h.project); setActiveProject(h.project) }
    if (h.type === 'scriptwriter') {
      setTarget('scriptwriter')
      if (h.model)  { setWriterModel(h.model);  setWriterManual(h.model) }
      if (h.vision) { setVisionModel(h.vision); setVisionManual(h.vision) }
      setScriptwriterInitial(h)
      setScriptwriterKey(k => k + 1)
      setHistoryOpen(false)
      return
    }
    // Every compose field, through the one table (src/workspace.js). Entries that
    // predate a field fall back to its default; ones that stored only an image
    // FILENAME rather than bytes read back as absent, exactly as before.
    setOutputCount(h.outputCount)
    if (h.model) { setWriterModel(h.model); setWriterManual(h.model) }
    if (h.vision) { setVisionModel(h.vision); setVisionManual(h.vision) }
    applyWorkspace(snapshotToWorkspace(h, { newId: generateId }))
    // `saved` = the text as restored, so a later hand-edit is detectable (resultsEdited).
    setResults(Array.isArray(h.outputs)
      ? h.outputs.filter(o => o && typeof o === 'object').map(o => ({ label: o.label || h.model || 'output', text: o.text || '', saved: o.text || '', usage: null, loading: false, error: '',
          // A pre-existing entry (saved before h3Mode was stamped on outputs)
          // has no o.h3Mode — fall back to deriving it the same way a fresh
          // generation would, from the snapshot's own frameMode/firstImg, so
          // H3SyntaxBadge still has a mode to check an old entry against.
          h3Mode: o.h3Mode || (h.target === 'minimax_h3' ? h3ModeFor(h.frameMode, !!h.firstImg) : null),
          images: Array.isArray(o.images) ? o.images : [], imgLoading: false, imgError: '', video: (o.video && typeof o.video === 'object' && (o.video.url || o.video.b64)) ? o.video : null, vidLoading: false, vidError: '', vidProgress: 0 }))
      : [])
    // A 🎨 Render right after a restore should patch this same entry.
    lastSavedEntryIdRef.current = h.id || null
    setCaption(h.caption || ''); setSavedCaption(h.caption || ''); setVisionStats(null); setAdaptSourceOverride(null)
    setHistoryOpen(false)
  }

  // Loads a queue item's snapshot into the live workspace — the "inputs" half
  // of restore() (target/scene/images/style/…), without restore()'s output,
  // caption, project or history-panel side effects, since a queued item hasn't
  // been run yet and hasn't chosen a project. Uses plain setters, never
  // switchTarget()/switchMode() (those clear image state as a side effect,
  // which would erase the very images just being loaded here).
  const applyQueueItemToWorkspace = (snap) => {
    setOutputCount(snap.outputCount)
    if (snap.model) { setWriterModel(snap.model); setWriterManual(snap.model) }
    if (snap.vision) { setVisionModel(snap.vision); setVisionManual(snap.vision) }
    applyWorkspace(snapshotToWorkspace(snap, { newId: generateId }))
  }

  // Captures the current compose panel exactly like a fresh generation would,
  // but as a pending queue item instead of running it now. Same validity gates
  // as enhance()'s early returns, reusing the same buildSnapshot() shape (no
  // caption yet — frameDescription is null, vision hasn't run).
  const addToQueue = () => {
    const hasImg = hasRequiredImages(workspace)
    if (!canGenerateFrom(workspace)) return
    if (!effectiveWriter) { setGlobalError('Pick a Writer model (open ⚙ Local backend → Reload models, or type one).'); return }
    if (hasImg && !effectiveVision) { setGlobalError('Image inputs need a Vision model — pick one or type one (e.g. qwen2.5vl:7b).'); return }
    // A description that came with the loaded image ("Reuse image") rides in the
    // snapshot's caption slot so the queued run reuses it instead of calling the
    // vision model (see snapshotToWorkspace). Image targets only — the only
    // place captionImages() reads it.
    const queuedRole = imageRoleOf(imgs.firstImg)
    const knownCaption = t.type === 'image'
      ? (imageMeta[imgs.firstImg?.hash]?.captions?.[queuedRole] || imgs.firstImg?.captions?.[queuedRole] || '')
      : ''
    const snapshot = buildSnapshot(knownCaption || null, hasImg, outputCount)
    queue.add({ id: generateId(), createdAt: Date.now(), status: 'queued', error: null, attempts: 0, snapshot })
  }

  // Runs one queue item: loads its snapshot into the workspace, runs the real
  // enhance() pipeline (bypassing admin-mode's pause), and on success removes
  // it from the queue — its result now lives in History like any other
  // generation. On failure it stays queued with an error, retryable via ▶ Run.
  const runQueueItem = (id) => queue.runOne(id, async (full) => {
    // flushSync so the setters below are committed before enhanceRef is read —
    // enhance() closes over this render's state, so without it the run would use
    // the previous workspace.
    flushSync(() => applyQueueItemToWorkspace(full.snapshot))
    return enhanceRef.current({ queue: true })
  })

  // Queues a Full Auto Scriptwriter job — { imgs.refImages, genre, hint } — from the
  // Full Auto tab of ScriptwriterPanel. Reuses the same queue item shape as
  // addToQueue, just tagged with `kind` so runAnyQueueItem/QueueCard can tell
  // it apart from a main-pipeline item (whose snapshot has no `kind`).
  const addScriptwriterAutoJob = (spec) => {
    queue.add({ id: generateId(), createdAt: Date.now(), status: 'queued', error: null, attempts: 0, kind: 'scriptwriter-auto', snapshot: spec })
  }

  // Runs one Full Auto Scriptwriter queue item. Unlike runQueueItem (which
  // replays a snapshot into the already-mounted main workspace), this forces a
  // fresh ScriptwriterPanel mount — via a bumped scriptwriterKey — carrying the
  // job as its `autoJob` prop; the panel imgs.seeds its own state and chains
  // Phase 1 → 2 → 3 with no review clicks, then calls `onAutoJobDone`, which
  // resolves the promise below. Same success/failure bookkeeping as
  // runQueueItem: success removes the item (its result is now a normal
  // Scriptwriter history entry), failure keeps it queued with an error,
  // retryable via ▶ Run.
  //
  // No flushSync here (unlike applyQueueItemToWorkspace/enhanceRef): this only
  // needs to get `autoJob`/`scriptwriterKey` committed as *props* before the
  // new ScriptwriterPanel instance mounts, which plain setState + the normal
  // render already guarantees — there's no same-component stale-closure hop
  // to bridge. ScriptwriterPanel's own mount effect does its own flushSync
  // for that hop; nesting one flushSync inside another (this one would fire
  // while React is still flushing this render's effects) is what React's
  // "flushSync was called from inside a lifecycle method" warning is about.
  const runScriptwriterQueueItem = (id) => queue.runOne(id, async (full) => {
    try {
      return await new Promise((resolve) => {
        scriptwriterAutoResolveRef.current = resolve
        setTarget('scriptwriter')
        setScriptwriterInitial(null)   // fresh session, not a restore
        // `runId` is minted fresh on every deliberate start — first run and
        // ▶ Run retry alike — and is what ScriptwriterPanel's mount effect
        // keys its start-guard on. A retry is therefore always allowed to run
        // again; only a *remount* of this same start (Fast Refresh, most
        // often) is suppressed. It rides on the prop copy only — the stored
        // queue item's own snapshot is left exactly as it was queued.
        setScriptwriterAutoJob({ ...full.snapshot, runId: `${id}:${generateId()}` })
        setScriptwriterKey(k => k + 1) // force a real remount
      })
    } finally {
      // Runs whether the panel reported success, failure, or threw: leaving
      // `autoJob` set would re-arm the next mount.
      scriptwriterAutoResolveRef.current = null
      setScriptwriterAutoJob(null)
    }
  })

  // Dispatches a queue item to the right runner by kind — there is one shared
  // queue, but a Full Auto Scriptwriter job needs the ScriptwriterPanel-mount
  // path above instead of the main-workspace restore-then-enhance path.
  const runAnyQueueItem = (id) => {
    const item = queue.find(id)
    return item?.kind === 'scriptwriter-auto' ? runScriptwriterQueueItem(id) : runQueueItem(id)
  }

  const processAllQueue = () => queue.processAll(runAnyQueueItem)

  // The writer fan-out: one prompt, or three temperature variants in parallel.
  //
  // Both callers come through here — a normal generation (runWriter, which
  // assembles the user message) and the admin "review the message before sending"
  // path (sendToWriter, which takes the hand-edited one). These were two separate
  // ~30-line copies of the same loading/settle/error/save dance, and the admin
  // copy had silently fallen behind: it never applied the LoRA trigger repair, so
  // reviewing a message before sending it could drop an active trigger. One
  // implementation, so that cannot happen again.
  //
  // `saved` is set alongside `text` because the hand-edit detector (resultsEdited)
  // compares the two. A null `snapshot` means "don't record this in history".
  const runWriterCall = async ({ user, system, snapshot, h3Mode = null }) => {
    // Put back any active LoRA trigger the writer dropped or mangled, in the
    // shape this target's output format expects.
    const repair = (raw) => withLoraTriggers(raw, activeLoras, target)

    if (outputCount === 1) {
      const lbl = effectiveWriter
      setResults([{ label: lbl, text: '', usage: null, loading: true, error: '', h3Mode }])
      try {
        const { text: raw, usage } = await callOllama(effectiveWriter, user, system, cfg, cfg.temperature)
        const text = repair(raw)
        setResults([{ label: lbl, text, saved: text, usage, loading: false, error: '', h3Mode }])
        if (snapshot) saveHistory(snapshot, [{ label: lbl, text, h3Mode }])
        return { ok: true }
      } catch (e) {
        setResults([{ label: lbl, text: '', usage: null, loading: false, error: e.message, h3Mode }])
        return { ok: false, error: e.message }
      }
    }

    const variants = buildVariants(effectiveWriter)
    setResults(variants.map(v => ({ label: v.label, text: '', usage: null, loading: true, error: '', h3Mode })))
    // Each variant settles its own row as it lands; a failed one records its error
    // in place and still contributes a row to the saved entry.
    const outs = await Promise.all(variants.map((v, i) =>
      callOllama(effectiveWriter, user + v.nudge, system, cfg, v.temp)
        .then(({ text: raw, usage }) => {
          const text = repair(raw)
          setResults(prev => prev.map((r, idx) => idx === i ? { ...r, text, saved: text, usage, loading: false } : r))
          return { label: v.label, text, h3Mode }
        })
        .catch(e => {
          setResults(prev => prev.map((r, idx) => idx === i ? { ...r, loading: false, error: e.message } : r))
          return { label: v.label, text: `(error: ${e.message})` }
        })
    ))
    if (snapshot) saveHistory(snapshot, outs)
    return { ok: true }
  }

  const sendToWriter = async () => {
    admin.setPending(false)
    return runWriterCall({ user: admin.userMsg, system: admin.system, snapshot: admin.snapshotRef.current, h3Mode: admin.h3ModeRef.current })
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
    abortAllVideos()
    setFrameMode(m)
    imgs.clearAll()
    // Reference mode starts on the target's preferred ratio (portrait, for H3's
    // vertical-video use) unless one was already chosen.
    const refRatio = m === 'ref' ? t.defaultRefRatio : null
    if (refRatio) setH3RatioId(prev => prev || refRatio)
  }
  const switchTarget = (id) => {
    abortAllVideos()
    const opts = TARGETS[id].durations || DURATION_OPTIONS
    setDuration(d => opts.some(o => o.value === d) ? d : opts[0].value)
    setTarget(id)
    imgs.clearAll()
    setSoundscape(''); setMusic('')
    const nextMode = TARGETS[id].defaultFrameMode || 'single'
    setH3RatioId(nextMode === 'ref' ? (TARGETS[id].defaultRefRatio || '') : '')
    setFrameMode(nextMode); setResults([]); setCaption(''); setSavedCaption(''); setVisionStats(null); setAdaptSourceOverride(null)
    setManualMode(false); setManualWarnings([])
  }

  // Every vision-model call funnels through here: content-addressed cache
  // (L1 in-memory Map -> L2 IndexedDB), so an image whose bytes + model +
  // prompt are all unchanged is never re-described, even across reloads.
  const cachedVision = async (content, system, stats, model = effectiveVision) => {
    const key = visionCacheKey(model, system, content)
    const mem = captionMemRef.current.get(key)
    if (mem != null) { stats.fromCache++; console.debug('[vision-cache] hit (mem)'); return mem }
    let persisted = null
    try { persisted = await getCaption(key) } catch { /* cache read is best-effort */ }
    if (persisted != null) {
      captionMemRef.current.set(key, persisted)
      stats.fromCache++
      console.debug('[vision-cache] hit (idb)')
      return persisted
    }
    const { text } = await callOllama(model, content, system, cfg, 0.3)
    captionMemRef.current.set(key, text)
    putCaption(key, text).catch(() => {})
    stats.fresh++
    console.debug('[vision-cache] miss -> fresh')
    return text
  }

  // The role an image currently has: the one picked on the Reference Image card
  // (or carried on a restored/queued image), else the per-image record's, else
  // General. Every image always resolves to a real role.
  const imageRoleOf = (im) => (im ? normalizeRole(im.role || imageMeta[im.hash]?.role) : ROLE_GENERAL)

  // Picking a role on the Reference Image card sets it on the loaded image AND
  // remembers it as that image's role (the per-image record), so it sticks the
  // next time the image is used anywhere.
  const onImageRoleChange = (roleId) => {
    imgs.setFirstImg(prev => (prev ? { ...prev, role: roleId } : prev))
    const h = imgs.firstImg?.hash
    if (h) patchImageMeta(h, { role: roleId }).catch(() => {})
  }

  // One vision call for one image under one role. General = a whole-image
  // description; every other role narrows it with that role's focus (Pose even
  // swaps the system prompt), exactly as a reference image's caption is written
  // in H3 ref mode — so the gallery's 🤖 Describe and a still-image generation
  // share cache keys for the same image + role.
  const describeUnderRole = (base64, mediaType, roleId, stats, model) => {
    const role = MINIMAX_H3_REF_ROLES.find(r => r.id === roleId)
    return cachedVision([
      { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
      { type: 'text', text: `Describe this reference image as instructed. ${role?.visionFocus || ''}`.trim() },
    ], role?.visionSystem || VISION_PROMPT_MINIMAX_H3_REF, stats, model)
  }

  // src overrides the live workspace state — passed by captionForEntry(h) to
  // re-describe a stored history entry's images without touching the workspace.
  const captionImages = async (src = null) => {
    const s = src || {
      frameMode, scene,
      refImages: imgs.refImages, firstImg: imgs.firstImg, midImg: imgs.midImg,
      lastImg: imgs.lastImg, refAudios: imgs.refAudios,
      targetType: t.type, visionPromptSingle: t.visionPrompt, visionModel: effectiveVision,
    }
    const model = s.visionModel || effectiveVision
    const stats = { fromCache: 0, fresh: 0 }
    if (s.frameMode === 'ref') {
      const role = (id) => MINIMAX_H3_REF_ROLES.find(r => r.id === id) || MINIMAX_H3_REF_ROLES[0]
      const roleLabel = (id) => role(id).label
      const preserveLabel = (id) => MINIMAX_H3_PRESERVE_OPTIONS.find(p => p.id === id)?.label || id
      const preserveMarker = (id) => MINIMAX_H3_PRESERVE_OPTIONS.find(p => p.id === id)?.marker || id
      // One vision call per reference image. Sequential against a local Ollama —
      // its parallel slots blend concurrent multimodal requests, so two refs come
      // back with a mixed description; cloud providers isolate requests, so fan out.
      const refs = s.refImages || []
      const captions = await mapWithConcurrency(refs, isCloud(cfg.base) ? refs.length : 1, (im) => cachedVision([
        { type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.base64 } },
        { type: 'text', text: `Describe this reference image as instructed. ${role(im.role).visionFocus || ''}`.trim() },
      ], role(im.role).visionSystem || VISION_PROMPT_MINIMAX_H3_REF, stats, model))
      const imageBlock = refs.map((im, i) => {
        let line = `Image ${i + 1} — role: ${roleLabel(im.role)}, preservation: ${preserveLabel(im.preserve)} (${preserveMarker(im.preserve)}): ${captions[i]}`
        if (im.note && im.note.trim()) line += `\n   Requested use of this reference: ${im.note.trim()}`
        return line
      }).join('\n\n')
      // H3's audio input takes up to two voice-timbre samples (ref_audio_0 /
      // ref_audio_1) — one Audio N line per reference, numbered independently
      // of the image references above. When the user explicitly bound this
      // audio to one image (MinimaxRefPanel's per-image "Voice" select), name
      // it so the writer isn't left guessing which subject it belongs to.
      const audioBlock = (s.refAudios || []).map((a, i) => {
        const boundIdx = refs.findIndex(im => im.hash && im.hash === a.subjectRef)
        const boundNote = boundIdx >= 0 ? ` — for the subject in Image ${boundIdx + 1} (${roleLabel(refs[boundIdx].role)})` : ''
        return `Audio ${i + 1} — voice-timbre reference (marker: reference)${boundNote}: file "${a.fileName}". Reference ONLY the timbre, pitch and delivery for the speaking subject; never transcribe or guess at its original wording. If no spoken dialogue is supplied elsewhere in this message, write one short line for that subject yourself so the voice reference has speech to act on.`
      }).join('\n\n')
      const text = audioBlock ? `${imageBlock}\n\n${audioBlock}` : imageBlock
      return { text, stats }
    }
    let system, content
    if (s.targetType === 'image') {
      const im = s.firstImg
      const hash = im.hash || imageHash(im.base64)
      const rec = imageMeta[hash]
      const role = imageRoleOf({ ...im, hash })
      // The description this image already has UNDER THIS ROLE — the per-image
      // record (gallery edits, earlier runs), else what came with the pick /
      // restore / queue — is used as-is: no vision request at all.
      const known = (rec?.captions?.[role] || im.captions?.[role] || '').trim()
      if (known) return { text: known, stats: { fromCache: 0, fresh: 0, reused: 1 } }
      let text
      if (role === ROLE_GENERAL) {
        // Deliberately scene-free: the typed text is the brief, so the caption
        // must describe what the image actually shows.
        text = await cachedVision([
          { type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.base64 } },
          { type: 'text', text: 'Describe this reference image in precise, prompt-ready language.' },
        ], s.visionPromptSingle, stats, model)
      } else {
        text = await describeUnderRole(im.base64, im.mediaType, role, stats, model)
      }
      // Remember it on the image, per role — described once, reused everywhere,
      // and never able to replace a different role's text or an edit (a role
      // with text returned above before getting here).
      patchImageMeta(hash, { captions: { [role]: text }, ...(rec?.role ? {} : { role }) }).catch(() => {})
      return { text, stats }
    } else if (s.frameMode === 'firstmidlast') {
      system = VISION_PROMPT_LTX_FIRSTMIDLAST
      content = [
        { type: 'text', text: 'FIRST FRAME (clip starts here):' },
        { type: 'image', source: { type: 'base64', media_type: s.firstImg.mediaType, data: s.firstImg.base64 } },
        { type: 'text', text: 'MID FRAME (clip passes through here):' },
        { type: 'image', source: { type: 'base64', media_type: s.midImg.mediaType, data: s.midImg.base64 } },
        { type: 'text', text: 'LAST FRAME (clip ends here):' },
        { type: 'image', source: { type: 'base64', media_type: s.lastImg.mediaType, data: s.lastImg.base64 } },
        { type: 'text', text: 'Describe all three frames and the changes, as instructed.' },
      ]
    } else if (s.frameMode === 'firstlast') {
      system = VISION_PROMPT_LTX_FIRSTLAST
      content = [
        { type: 'text', text: 'FIRST FRAME (clip starts here):' },
        { type: 'image', source: { type: 'base64', media_type: s.firstImg.mediaType, data: s.firstImg.base64 } },
        { type: 'text', text: 'LAST FRAME (clip ends here):' },
        { type: 'image', source: { type: 'base64', media_type: s.lastImg.mediaType, data: s.lastImg.base64 } },
        { type: 'text', text: 'Describe both frames and the change, as instructed.' },
      ]
    } else {
      system = s.visionPromptSingle || VISION_PROMPT_LTX_SINGLE
      content = [
        { type: 'image', source: { type: 'base64', media_type: s.firstImg.mediaType, data: s.firstImg.base64 } },
        { type: 'text', text: 'Describe this first frame as instructed.' },
      ]
    }
    const text = await cachedVision(content, system, stats, model)
    return { text, stats }
  }

  // Re-run the vision step for a stored history entry. Prefer the entry's
  // original vision model only when it's still available (keeps caption-cache
  // hits); otherwise use the currently-selected one — the old model id is often
  // gone (unpulled, or a different backend now).
  const captionForEntry = (h) => captionImages({
    frameMode: h.frameMode,
    refImages: Array.isArray(h.refImages) ? h.refImages : null,
    firstImg: h.firstImg, midImg: h.midImg, lastImg: h.lastImg, refAudios: refAudiosFromSnap(h.refAudio),
    scene: h.scene || '',
    targetType: TARGETS[h.target]?.type,
    visionPromptSingle: TARGETS[h.target]?.visionPrompt,
    visionModel: (h.vision && models.length && models.includes(h.vision)) ? h.vision : effectiveVision,
  })

  // `h` here is a history-list row — image nodes carry a blob `url`/`blobRef`, not
  // bytes (restore/startAdapt fetch the inline entry to get those).
  const entryHasStoredImages = (h) =>
    (Array.isArray(h.refImages) && h.refImages.some(im => im && (im.url || im.blobRef || im.base64))) ||
    [h.firstImg, h.midImg, h.lastImg].some(im => im && typeof im === 'object' && (im.url || im.blobRef || im.base64))

  // `opts.autoRun` is set by the history card's "→ Text2Video" shortcut — it
  // rides along on `adaptSourceOverride` (added to `base` so every later
  // setAdaptSourceOverride(...) call, including the async caption re-read,
  // keeps carrying it) and tells <AdaptPanel> to fire itself once its source
  // data (caption/original prompt) is ready, instead of waiting for a manual
  // "✦ Adapt prompt" click. Destination target still comes from AdaptPanel's
  // own default (the source target, when it's a valid adapt target — true for
  // minimax_h3), so no separate "forced destination" plumbing is needed.
  const startAdapt = async (h, opts = null) => {
    setHistoryOpen(false)
    const base = {
      scene: h.scene || '', frameMode: h.frameMode, sourceTarget: h.target,
      originalPrompt: h.outputs?.[0]?.text || '', ts: h.ts,
      autoRun: !!opts?.autoRun,
    }
    if (h.caption) { setAdaptSourceOverride({ ...base, caption: h.caption }); return }
    if (!entryHasStoredImages(h)) { setAdaptSourceOverride({ ...base, caption: '' }); return }
    if (!effectiveVision) {
      setGlobalError('Adapting an older generation needs a Vision model to re-read its images — pick one in the Vision model dropdown.')
      return
    }
    setAdaptSourceOverride({ ...base, caption: '', captioning: true })
    try {
      // History rows carry no image bytes — pull the inline entry so the vision
      // re-read has real base64 to send.
      const full = await getHistoryEntry(h.id, { inline: true }).catch(() => h)
      const { text } = await captionForEntry(full || h)
      setAdaptSourceOverride(prev => (prev && prev.ts === h.ts ? { ...base, caption: text } : prev))
    } catch (e) {
      setGlobalError(`Couldn't re-read the images with the Vision model "${effectiveVision}": ${e.message}`)
      setAdaptSourceOverride(prev => (prev && prev.ts === h.ts ? null : prev))
    }
  }

  // `opts` is null for a normal interactive click; the queue passes
  // `{ queue: true }` to skip the admin-mode pause (see runWriter). The return
  // value ({ok:true} / {ok:false,error}) is only consumed by the queue runner —
  // the plain onClick={enhance} handler ignores it, same as before.
  const enhance = async (opts = null) => {
    const hasImg = hasRequiredImages(workspace)
    if (!canGenerateFrom(workspace)) return { ok: false, error: 'nothing to generate' }

    // Manual mode: zero AI calls, needs neither model — short-circuit before
    // the writer/vision-model guards below. See src/manualH3.js.
    if (manualMode && target === 'minimax_h3') {
      abortAllVideos()
      setGlobalError(''); setCopied(null); setCaption(''); setSavedCaption(''); setVisionStats(null); setAdaptSourceOverride(null); admin.setPending(false)
      setManualWarnings([])

      const mode = h3ModeFor(frameMode, imgs.firstImg)
      const built = buildManualH3({
        mode, storyText: scene, soundscape, music, duration,
        refImages: imgs.refImages, refAudios: imgs.refAudios,
      })
      if (!built.ok) {
        setGlobalError(built.errors.join(' '))
        return { ok: false, error: built.errors[0] }
      }
      setManualWarnings(built.warnings)

      // Same LoRA-trigger repair the AI path applies — pure text manipulation,
      // not an AI call, and TARGETS.minimax_h3.loraInject.fields already
      // targets exactly the field names this module emits.
      const text = withLoraTriggers(built.text, activeLoras, target)
      setResults([{ label: 'manual', text, saved: text, usage: null, loading: false, error: '', h3Mode: mode }])
      const snapshot = buildWorkspaceSnapshot(workspace, { model: 'manual', vision: null, outputCount: 1, caption: null })
      saveHistory(snapshot, [{ label: 'manual', text, h3Mode: mode }])
      return { ok: true }
    }

    if (!effectiveWriter) { setGlobalError('Pick a Writer model (open ⚙ Local backend → Reload models, or type one).'); return { ok: false, error: 'no writer model' } }
    if (hasImg && !effectiveVision) { setGlobalError('Image inputs need a Vision model — pick one or type one (e.g. qwen2.5vl:7b).'); return { ok: false, error: 'no vision model' } }
    abortAllVideos()
    setGlobalError(''); setCopied(null); setCaption(''); setSavedCaption(''); setVisionStats(null); setAdaptSourceOverride(null); admin.setPending(false)

    const stylePart = buildStylePart({
      style, creativity, targetType: t.type, showDialogue: show.dialogue, dialogue, delivery, negative,
      spokenLang: show.spokenLang ? spokenLangId : null,
      loras: activeLoras, targetId: target,
    })
    const lengthPart = PROMPT_LENGTH_INJECT[promptLength] || ''

    if (hasImg) {
      setResults([])
      let frameDescription
      setVisionBusy(true)
      try {
        const { text, stats } = await captionImages()
        frameDescription = text
        setCaption(text)
        setSavedCaption(text)
        setVisionStats(stats)
      } catch (e) {
        setVisionBusy(false)
        setGlobalError(`Vision step failed (${effectiveVision}): ${e.message}`)
        return { ok: false, error: e.message }
      }
      setVisionBusy(false)
      return await runWriter(frameDescription, stylePart, lengthPart, hasImg, opts)
    } else {
      return await runWriter(null, stylePart, lengthPart, hasImg, opts)
    }
  }

  // "✍ Manual Prompt" — a THIRD, independent action for minimax_h3, distinct
  // from the raw-tag-syntax Manual mode above: instantly builds a full
  // H3-schema draft from whatever the normal AI-mode fields already hold
  // (Style/Dialogue/Spoken Language/Duration/Aspect Ratio/Soundscape/Music/
  // references), with the free-prose description left as a placeholder to
  // hand-edit. Zero AI calls — see src/manualH3.js's buildH3Template. Sits
  // next to the main generate button (only when !manualUI) rather than
  // touching enhance()/manualMode at all.
  const buildTemplatePrompt = () => {
    if (!canGenerateFrom(workspace)) return
    abortAllVideos()
    setGlobalError(''); setCopied(null); setCaption(''); setSavedCaption(''); setVisionStats(null); setAdaptSourceOverride(null); admin.setPending(false)

    const mode = h3ModeFor(frameMode, imgs.firstImg)
    const ratio = selectedRatio ? aspectParts(selectedRatio) : null
    const styleObj = STYLE_OPTIONS.find(s => s.id === style)
    const { text } = buildH3Template({
      mode, scene, duration, refImages: imgs.refImages, refAudios: imgs.refAudios,
      soundscape, music, dialogue, delivery,
      spokenLangTag: show.spokenLang ? spokenLangDef(spokenLangId).tag : null,
      ratioToken: ratio?.token, ratioOrient: ratio?.orient,
      styleHint: styleObj && styleObj.id !== 'auto' ? styleObj.label : '',
      avoidHint: negative,
    })
    const withLoras = withLoraTriggers(text, activeLoras, target)
    setResults([{ label: 'template', text: withLoras, saved: withLoras, usage: null, loading: false, error: '', h3Mode: mode }])
    const snapshot = buildWorkspaceSnapshot(workspace, { model: 'template', vision: null, outputCount: 1, caption: null })
    saveHistory(snapshot, [{ label: 'template', text: withLoras, h3Mode: mode }])
  }

  // The history snapshot for the current workspace state. `frameDescription` is
  // the assembled vision caption (null for text-only); `count` is how many
  // outputs the entry carries. Used by runWriter() after a fresh generation and
  // by saveResultsEdit() to persist hand-edited result text as a new entry.
  // A still-image run stamps the image's EFFECTIVE role (card choice, else the
  // per-image record, else General) onto the saved frame image, so the entry's
  // caption — which was written under that role — is filed under it later
  // instead of being taken for a General description.
  const buildSnapshot = (frameDescription, hasImg, count) => buildWorkspaceSnapshot(
    t.type === 'image' && workspace.firstImg ? { ...workspace, firstImg: { ...workspace.firstImg, role: imageRoleOf(workspace.firstImg) } } : workspace, {
    model: effectiveWriter,
    vision: hasImg ? effectiveVision : null,
    outputCount: count,
    caption: frameDescription,
  })

  const runWriter = async (frameDescription, stylePart, lengthPart, hasImg, opts = null) => {
    const userText = buildWriterUserText({
      target, targetType: t.type, frameMode, scene, duration,
      frameDescription, hasImg,
      ratio: selectedRatio, soundscape, music,
      stylePart, lengthPart,
      refRole: t.type === 'image' && hasImg ? imageRoleOf(imgs.firstImg) : null,
    })

    const snapshot = buildSnapshot(frameDescription, hasImg, outputCount)
    // Captured now, from the exact frameMode/hasImg this message was built
    // for — not recomputed later from possibly-changed live state (see
    // H3SyntaxBadge / checkH3Prompt).
    const h3Mode = tcaps.structured ? h3ModeFor(frameMode, hasImg) : null

    // Admin mode intercepts here: hold the assembled message for review instead
    // of sending it. A queued run never pauses — nobody is watching it.
    if (admin.mode && !opts?.queue) {
      admin.pause(userText, snapshot, h3Mode)
      return { ok: false, error: 'paused for admin review' }
    }

    return runWriterCall({ user: userText, system: systemPromptFor(t, frameMode), snapshot, h3Mode })
  }

  // Assigns enhanceRef every render (like resultsRef.current = results above),
  // so a queue run reads the freshest enhance() closure after flushSync commits
  // applyQueueItemToWorkspace's setters — see runQueueItem.
  enhanceRef.current = enhance

  const copy = (idx) => { navigator.clipboard.writeText(results[idx].text); setCopied(idx); setTimeout(() => setCopied(null), 2000) }
  const editResult = (idx, value) => setResults(prev => prev.map((r, i) => i === idx ? { ...r, text: value } : r))

  const writing = results.some(r => r.loading)
  const isLoading = visionBusy || writing

  // Whether the workspace currently holds the input image(s) this target needs —
  // used to stamp the Vision model onto a manually-saved snapshot.
  const hasImgNow = hasRequiredImages(workspace)

  // The result text or the vision description has been hand-edited away from what
  // was generated/restored — offer to persist it as a new history entry.
  const resultsEdited = !writing && results.some(r => r.text && !r.error && r.text !== r.saved)
  const captionEdited = !writing && !!caption.trim() && caption !== savedCaption && results.some(r => r.text && !r.error)

  const saveResultsEdit = () => {
    const outs = results.filter(r => r.text && !r.error).map(r => ({ label: r.label, text: r.text, ...(r.h3Mode ? { h3Mode: r.h3Mode } : {}), ...(r.images?.length ? { images: r.images } : {}), ...(r.video ? { video: r.video } : {}) }))
    if (!outs.length) return
    saveHistory(buildSnapshot(caption || null, hasImgNow, outs.length), outs)
    setResults(prev => prev.map(r => ({ ...r, saved: r.text })))
    setSavedCaption(caption)
    setSavedEditFlash(true)
    setTimeout(() => setSavedEditFlash(false), 1800)
  }

  // Re-run only the writer from the current (possibly hand-edited) vision
  // description — skips a fresh vision pass so an edit to the description sticks.
  const rerunFromCaption = async () => {
    if (!caption.trim() || writing) return
    abortAllVideos()
    setGlobalError(''); setCopied(null); setAdaptSourceOverride(null)
    const stylePart = buildStylePart({
      style, creativity, targetType: t.type, showDialogue: show.dialogue, dialogue, delivery, negative,
      spokenLang: show.spokenLang ? spokenLangId : null,
      loras: activeLoras, targetId: target,
    })
    const lengthPart = PROMPT_LENGTH_INJECT[promptLength] || ''
    setSavedCaption(caption)
    await runWriter(caption, stylePart, lengthPart, hasImgNow)
  }
  const canGenerate = canGenerateFrom(workspace)
  // MiniMax H3 "Manual mode" (src/manualH3.js) — write the H3 prompt yourself,
  // zero AI calls. Gates every AI-pipeline-only affordance below it.
  const manualUI = manualMode && target === 'minimax_h3'
  // No typed scene but images loaded → the writer proposes the scene from them.
  // Never true in Manual mode — an empty box there means "not written yet", not
  // "let the AI invent one".
  const proposeMode = !manualUI && isProposeMode(workspace)
  const buttonLabel = manualUI ? '✍ Assemble prompt'
    : visionBusy ? '👁 Reading images…'
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

  const sceneHint = manualUI
    ? 'MiniMax H3 tag syntax — no AI rewriting, assembled exactly as typed'
    : t.type === 'image'
    ? (imgs.firstImg ? '(optional — leave blank to describe the reference image)' : '')
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
              : imgs.firstImg ? '(optional — leave blank to let the writer propose one from the frame)' : ''

  const sceneLabel = t.type === 'image' ? 'Image Description' : t.type === 'text' ? 'Scene / Story Idea' : 'Your Scene'
  // Manual mode drops the matching seed straight into the textarea itself (see
  // the toggle button below) the moment it's switched on with nothing typed
  // yet, so this placeholder is only the fallback for if it's cleared again.
  const scenePlaceholder = manualUI
    ? buildManualSeed(imgs.refImages, imgs.refAudios)
    : t.type === 'image'
    ? 'e.g. A weathered fisherman mending nets at dawn, harbor and boats behind him'
    : t.type === 'text'
      ? 'e.g. A queen betrayed by her advisor, cold fury building to a threat'
      : imgs.firstImg
        ? 'Leave blank to auto-propose, or describe what should happen…'
        : 'e.g. A woman walks through a rainy night market in Tokyo, stops at a noodle stall'

  const selectedRatio = tcaps.ratioPicker ? (presetById(h3RatioId, t.resolutions) || t.resolutions[0]) : null
  const ratioPicker = tcaps.ratioPicker ? (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Aspect Ratio <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>(no exact frame to derive it from — pick one explicitly)</span>
      </label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {t.resolutions.map(p => (
          <button key={p.id} onClick={() => setH3RatioId(p.id)} title={p.note} style={btn(h3RatioId === p.id)}>{p.label}</button>
        ))}
      </div>
      {frameMode === 'ref' && (
        <p style={{ fontSize: 13, color: 'var(--pe-ink-3)', margin: '6px 0 0', lineHeight: 1.5 }}>
          Ref2VA renders best at 9:16 portrait (the validated short-drama format).
        </p>
      )}
      {!h3RatioId && (
        <p style={{ fontSize: 13, color: 'var(--pe-warn)', margin: '4px 0 0', lineHeight: 1.5 }}>
          No ratio picked — defaulting to {selectedRatio.label}.
        </p>
      )}
    </div>
  ) : null

  const genBtnDisabled = isLoading || !canGenerate || admin.pending
  const genBtnStyle = {
    width: '100%', height: 54, padding: '0 24px', borderRadius: 10, border: 'none',
    background: genBtnDisabled ? 'var(--pe-line-soft)' : 'var(--pe-accent)',
    color: genBtnDisabled ? 'var(--pe-ink-3)' : '#fff',
    fontSize: 17, fontWeight: 600, cursor: genBtnDisabled ? 'not-allowed' : 'pointer',
    transition: 'all 0.15s', marginTop: 10,
  }

  const scriptwriterMode = t.type === 'scriptwriter'

  // Stable action handles for the memoized <HistoryPanel>.
  //
  // The handlers themselves (restore, startAdapt, …) close over most of App's
  // state, so they are new functions on every render — passing them straight down
  // would defeat React.memo and repaint every card on every keystroke. The ref is
  // re-pointed at the current render's functions each pass, while the object the
  // panel receives keeps one identity for the life of the component. Same trick
  // saveCtxRef already uses for saveScriptHistory.
  const historyActionsRef = useRef({})
  historyActionsRef.current = {
    restore, removeHistoryEntry, startAdapt, assignEntryProject, clearHistory, exportHistory,
    // Deliberately no .catch(() => {}) on either save — a failure must reach
    // the caller (the UI's own try/catch) so it can show that the save
    // actually failed instead of always flashing "✓ saved" regardless.
    saveCaption: (id, text) => updateHistoryEntry(id, { caption: text }).then(() => syncHistoryEntry(id)),
    // Writes ONE reference image's caption for ONE role directly onto that
    // entry's refImages[imageIndex].captions[roleId] (a plain array-index +
    // map-key update, never a regex match against the old shared
    // "Image N — role: …" text block) — see "Per-reference LoRA and voice
    // binding" / the caption-editing notes above for why: parsing that block
    // to isolate one image's line is what kept breaking across three rounds
    // of fixes, most recently as a guaranteed silent no-op whenever the
    // target line didn't parse. This can't no-op (a map-by-index always
    // writes) and can't touch a sibling index or a sibling role.
    // `roleId` defaults to the image's own assigned role (or ROLE_NONE) so
    // HistoryPanel.jsx's plain editor — which never passes a 4th arg — keeps
    // working unchanged. The legacy flat `refImages[i].caption` field is
    // never written here (see resolveRefCaption in adapt.js — it's read-only
    // from this point on, a fallback for an image not yet re-saved).
    saveRefImageCaption: (id, imageIndex, text, roleId) => {
      const h = history.find(x => x.id === id)
      if (!h || !Array.isArray(h.refImages)) return Promise.reject(new Error('entry or reference image not found'))
      const updated = h.refImages.map((im, i) => {
        if (i !== imageIndex) return im
        const key = roleId || im.role || ROLE_NONE
        return { ...im, captions: { ...(im.captions || {}), [key]: text } }
      })
      return updateHistoryEntry(id, { refImages: updated }).then(() => syncHistoryEntry(id))
    },
    // Runs the vision model on ONE stored reference image, focused on ONE
    // role (defaults to the image's own assigned role), and returns the
    // fresh caption text — does NOT save it itself; the caller (the "🤖
    // Describe with AI" role picker, gallery only — see galleryActions
    // below) drops it into the same edit/Save flow as a hand-typed
    // description, so the user reviews it before it persists via
    // saveRefImageCaption above, tagged with the same roleId. Fetches the
    // image's bytes on demand (history rows carry no bytes, only a blob url)
    // since this runs outside the normal captionImages() pipeline; goes
    // through the same content-addressed vision cache as a fresh generation
    // would — describing the same image under two different roles hits two
    // different cache entries, since the role's focus text is part of the key.
    describeRefImage: async (id, imageIndex, roleId) => {
      const h = history.find(x => x.id === id)
      const im = h?.refImages?.[imageIndex]
      if (!im || !im.url) throw new Error('reference image not found')
      if (!effectiveVision) throw new Error('no vision model selected')
      const base64 = await blobUrlToBase64(im.url)
      const role = MINIMAX_H3_REF_ROLES.find(r => r.id === (roleId || im.role)) || MINIMAX_H3_REF_ROLES[0]
      const stats = { fromCache: 0, fresh: 0 }
      return cachedVision([
        { type: 'image', source: { type: 'base64', media_type: im.mediaType || 'image/jpeg', data: base64 } },
        { type: 'text', text: `Describe this reference image as instructed. ${role.visionFocus || ''}`.trim() },
      ], role.visionSystem || VISION_PROMPT_MINIMAX_H3_REF, stats, effectiveVision)
    },
    // Library-image counterparts of saveRefImageCaption/describeRefImage
    // above — same role-keyed captions model, but the item's own id stands
    // in for the entryId+index pair (a library item isn't part of any
    // entry). Both PATCH the sidecar (server/libraryStore.mjs's patchLibrary
    // does a plain shallow merge) and then apply the identical merge to
    // local `library` state — safe since both sides merge the same way, and
    // it means the info panel reflects the save immediately with no refetch.
    saveLibraryCaption: (id, text, roleId) => {
      const item = library.find(x => x.id === id)
      if (!item) return Promise.reject(new Error('library image not found'))
      const key = roleId || item.role || ROLE_NONE
      const captions = { ...(item.captions || {}), [key]: text }
      return updateLibraryItem(id, { captions }).then(() => {
        setLibrary(prev => prev.map(x => (x.id === id ? { ...x, captions } : x)))
      })
    },
    // The "role selection" a library image otherwise has no home for — a ref
    // image gets this from its MinimaxRefPanel card at upload time; a
    // library image has no such card, so it lives on the info panel instead.
    setLibraryRole: (id, roleId) => {
      const role = roleId || null
      return updateLibraryItem(id, { role }).then(() => {
        setLibrary(prev => prev.map(x => (x.id === id ? { ...x, role } : x)))
      })
    },
    describeLibraryImage: async (id, roleId) => {
      const item = library.find(x => x.id === id)
      if (!item || !item.url) throw new Error('library image not found')
      if (!effectiveVision) throw new Error('no vision model selected')
      const base64 = await blobUrlToBase64(item.url)
      const role = MINIMAX_H3_REF_ROLES.find(r => r.id === (roleId || item.role)) || MINIMAX_H3_REF_ROLES[0]
      const stats = { fromCache: 0, fresh: 0 }
      return cachedVision([
        { type: 'image', source: { type: 'base64', media_type: item.mediaType || 'image/jpeg', data: base64 } },
        { type: 'text', text: `Describe this reference image as instructed. ${role.visionFocus || ''}`.trim() },
      ], role.visionSystem || VISION_PROMPT_MINIMAX_H3_REF, stats, effectiveVision)
    },
    importFiles: () => importInputRef.current?.click(),
  }
  const historyActions = useMemo(() => ({
    restore: (h) => historyActionsRef.current.restore(h),
    remove: (id) => historyActionsRef.current.removeHistoryEntry(id),
    adapt: (h) => historyActionsRef.current.startAdapt(h),
    // MiniMax H3 history cards with reference/frame images get a one-click
    // shortcut straight to a text-only T2VA rewrite — same pipeline as
    // "⇄ Adapt", just auto-run instead of requiring the extra click.
    text2video: (h) => historyActionsRef.current.startAdapt(h, { autoRun: true }),
    assignProject: (id, value) => historyActionsRef.current.assignEntryProject(id, value),
    saveCaption: (id, text) => historyActionsRef.current.saveCaption(id, text),
    saveRefImageCaption: (id, imageIndex, text, roleId) => historyActionsRef.current.saveRefImageCaption(id, imageIndex, text, roleId),
    // describeRefImage is deliberately NOT exposed here — the "🤖 Describe
    // with AI" trigger only lives in the "Reuse image from history" gallery
    // (galleryActions below), not on a finished history card: re-describing
    // a reference there wouldn't retroactively rewrite that entry's already-
    // generated prompt, which reads as broken rather than useful.
    clearAll: () => historyActionsRef.current.clearHistory(),
    exportAll: () => historyActionsRef.current.exportHistory(),
    importFiles: () => historyActionsRef.current.importFiles(),
  }), [])
  const toggleHistoryOpen = useCallback(() => setHistoryOpen(v => !v), [])

  // Same treatment for the image gallery, which renders up to 60 draggable tiles
  // and used to re-run all of them on every unrelated keystroke.
  const galleryActionsRef = useRef({})
  // Per-image record actions for the gallery (every tile has a role and per-role
  // descriptions). A tile without a stored content hash gets one computed from
  // its bytes at save time, so a save can never silently land nowhere.
  const hashOfTile = async (img) => img.hash || imageHash(await blobUrlToBase64(img.url))
  galleryActionsRef.current = {
    saveImageCaption: async (img, text, roleId) => patchImageMeta(await hashOfTile(img), { captions: { [roleId]: text } }),
    setImageRole: async (img, roleId) => patchImageMeta(await hashOfTile(img), { role: roleId }),
    // Runs the vision model for ONE role on a stored image and returns the text —
    // it does not save; the panel drops it into the same edit/Save flow as a
    // hand-typed description, so an AI text never overwrites a stored one unseen.
    describeImage: async (img, roleId) => {
      if (!effectiveVision) throw new Error('no vision model selected')
      const base64 = await blobUrlToBase64(img.url)
      return describeUnderRole(base64, img.mediaType, roleId, { fromCache: 0, fresh: 0 }, effectiveVision)
    },
    pickHistoryImage,
    saveCaption: historyActionsRef.current.saveCaption,
    saveRefImageCaption: historyActionsRef.current.saveRefImageCaption,
    describeRefImage: historyActionsRef.current.describeRefImage,
    saveLibraryCaption: historyActionsRef.current.saveLibraryCaption,
    setLibraryRole: historyActionsRef.current.setLibraryRole,
    describeLibraryImage: historyActionsRef.current.describeLibraryImage,
  }
  const galleryActions = useMemo(() => ({
    pick: (data) => galleryActionsRef.current.pickHistoryImage(data),
    saveImageCaption: (img, text, roleId) => galleryActionsRef.current.saveImageCaption(img, text, roleId),
    setImageRole: (img, roleId) => galleryActionsRef.current.setImageRole(img, roleId),
    describeImage: (img, roleId) => galleryActionsRef.current.describeImage(img, roleId),
    saveCaption: (id, text) => galleryActionsRef.current.saveCaption(id, text),
    saveRefImageCaption: (id, imageIndex, text, roleId) => galleryActionsRef.current.saveRefImageCaption(id, imageIndex, text, roleId),
    describeRefImage: (id, imageIndex, roleId) => galleryActionsRef.current.describeRefImage(id, imageIndex, roleId),
    saveLibraryCaption: (id, text, roleId) => galleryActionsRef.current.saveLibraryCaption(id, text, roleId),
    setLibraryRole: (id, roleId) => galleryActionsRef.current.setLibraryRole(id, roleId),
    describeLibraryImage: (id, roleId) => galleryActionsRef.current.describeLibraryImage(id, roleId),
  }), [])

  // …and for the queue. This bundle replaces two hand-assembled copies of the
  // same seven callbacks — one for the bottom QueuePanel, one as `queueProps` for
  // the Scriptwriter's embedded copy — so the queue's call surface is written once.
  const queueActionsRef = useRef({})
  queueActionsRef.current = { runAnyQueueItem }
  const queueActions = useMemo(() => ({
    onRun: (id) => queueActionsRef.current.runAnyQueueItem(id),
    onRemove: queue.remove,
    onProcessAll: () => queue.processAll(queueActionsRef.current.runAnyQueueItem),
    onStop: queue.stop,
    onClear: queue.clear,
    onToggleOpen: queue.toggleOpen,
  }), [queue.remove, queue.processAll, queue.stop, queue.clear, queue.toggleOpen])

  // ConfigBar's two non-setter props.
  const configActionsRef = useRef({})
  configActionsRef.current = {
    reloadModels,
    clearCaptionCache: () => { clearCaptions().catch(() => {}); captionMemRef.current.clear(); setVisionStats(null) },
  }
  const configActions = useMemo(() => ({
    reloadModels: () => configActionsRef.current.reloadModels(),
    clearCaptionCache: () => configActionsRef.current.clearCaptionCache(),
  }), [])

  // Frame Mode + the image/reference-input UI, computed once and rendered at
  // one of two positions below depending on target: for MiniMax H3 they move
  // to the very top of the compose column (image, its LoRA and its voice all
  // belong together, before the scene text — see MinimaxRefPanel.jsx); every
  // other target keeps them at their original position, byte-identical to
  // before this existed, since exactly one of the two render sites fires.
  const frameModePicker = show.frameMode ? (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Image Input</label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(t.frameModeOptions || DEFAULT_FRAME_MODE_OPTIONS).map(o => (
          <button key={o.id} onClick={() => switchMode(o.id)} style={btn(frameMode === o.id)}>{o.label}</button>
        ))}
      </div>
      {(() => {
        const hint = (t.frameModeOptions || DEFAULT_FRAME_MODE_OPTIONS).find(o => o.id === frameMode)?.hint
        return hint ? <p style={{ fontSize: 13, color: 'var(--pe-ink-3)', margin: '6px 0 0', lineHeight: 1.5 }}>{hint}</p> : null
      })()}
    </div>
  ) : null

  const imageInputBlock = showImage ? (
    <>
      <HistoryImageGallery history={history} onPick={galleryActions.pick} pickHint={galleryPickHint}
        onSaveCaption={galleryActions.saveCaption} onSaveRefImageCaption={galleryActions.saveRefImageCaption}
        onDescribeRefImage={galleryActions.describeRefImage}
        library={library} onAddLibraryImages={addLibraryImages} onRemoveLibraryImage={removeLibraryImage}
        onSaveLibraryCaption={galleryActions.saveLibraryCaption} onSetLibraryRole={galleryActions.setLibraryRole}
        onDescribeLibraryImage={galleryActions.describeLibraryImage}
        imageMeta={imageMeta} onSaveImageCaption={galleryActions.saveImageCaption}
        onSetImageRole={galleryActions.setImageRole} onDescribeImage={galleryActions.describeImage} />
      {t.type === 'image' || frameMode === 'single' ? (
        <>
          {!imgs.firstImg && ratioPicker}
          <ImagePanel key={`${target}-single`} label="Reference Image" hint="(optional)" onChange={imgs.setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} presetNote={t.presetNote} seed={imgs.seeds.first}
            roleValue={t.type === 'image' ? imageRoleOf(imgs.firstImg) : undefined} onRoleChange={t.type === 'image' ? onImageRoleChange : undefined} />
        </>
      ) : frameMode === 'last' ? (
        <ImagePanel key={`${target}-lastonly`} label="Last Frame" hint="(clip ends here)" onChange={imgs.setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={imgs.seeds.first} />
      ) : frameMode === 'ref' ? (
        <>
          {ratioPicker}
          <MinimaxRefPanel images={imgs.refImages} onChange={imgs.setRefImages} audios={imgs.refAudios} onAudiosChange={imgs.setRefAudios} loras={loras} manualMode={manualUI} duration={duration}
            voiceLibrary={voiceLibrary} onAddVoiceLibraryFiles={addVoiceLibraryFiles} onRemoveVoiceLibraryItem={removeVoiceLibraryItem}
            onRenameVoiceLibraryCharacter={renameVoiceLibraryCharacter} onSaveAudioToVoiceLibrary={saveAudioToVoiceLibrary} />
        </>
      ) : frameMode === 'firstmidlast' ? (
        <>
          <ImagePanel key={`${target}-first`} label="First Frame" hint="(clip starts here)" onChange={imgs.setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={imgs.seeds.first} />
          <ImagePanel key={`${target}-mid`} label="Mid Frame" hint="(clip passes through here)" onChange={imgs.setMidImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={imgs.seeds.mid} />
          <ImagePanel key={`${target}-last`} label="Last Frame" hint="(clip ends here)" onChange={imgs.setLastImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={imgs.seeds.last} />
        </>
      ) : (
        <>
          <ImagePanel key={`${target}-first`} label="First Frame" hint="(clip starts here)" onChange={imgs.setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={imgs.seeds.first} />
          <ImagePanel key={`${target}-last`} label="Last Frame" hint="(clip ends here)" onChange={imgs.setLastImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={imgs.seeds.last} />
        </>
      )}
    </>
  ) : null

  return (
    <div style={{ fontFamily: 'var(--pe-font)', minHeight: '100vh', color: 'var(--pe-ink)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '0 28px', height: 72, background: 'var(--pe-surface)', borderBottom: '1px solid var(--pe-line)', position: 'sticky', top: 0, zIndex: 20 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 27, fontWeight: 700, margin: 0, color: 'var(--pe-ink)', letterSpacing: '-0.02em' }}>Prompt Enhancer</h1>
          <p style={{ fontSize: 14, color: 'var(--pe-ink-3)', margin: 0 }}>{t.subtitle}{showImage ? ' · two-stage: vision → writer' : ' · single-stage writer'}</p>
        </div>
        <button
          onClick={() => { admin.setMode(v => !v); admin.setPending(false) }}
          style={{ flexShrink: 0, padding: '9px 15px', borderRadius: 8, border: '1px solid', borderColor: admin.mode ? 'var(--pe-accent-line)' : 'var(--pe-line)', background: admin.mode ? 'var(--pe-accent-bg)' : 'var(--pe-surface)', color: admin.mode ? 'var(--pe-accent-ink)' : 'var(--pe-ink-2)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
        >
          {admin.mode ? '⚙ Admin: ON' : '⚙ Admin'}
        </button>
      </div>

      {historyDown && (
        <div style={{ padding: '10px 28px', background: 'var(--pe-danger-bg)', borderBottom: '1px solid var(--pe-danger-line)', color: 'var(--pe-danger)', fontSize: 13.5, fontWeight: 600, position: 'sticky', top: 72, zIndex: 19 }}>
          History-Server nicht erreichbar — Generierungen werden NICHT gespeichert. Starte ihn mit <code style={{ fontFamily: 'var(--pe-mono)' }}>npm run server</code> (oder <code style={{ fontFamily: 'var(--pe-mono)' }}>npm run dev</code>, das startet beide).
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '360px minmax(0, 900px) minmax(420px, 760px)', gap: 28, padding: 24, alignItems: 'start', justifyContent: 'center', maxWidth: 2200, margin: '0 auto' }}>

      {/* ================= LEFT RAIL ================= */}
      <div style={{ gridColumn: '1', display: 'flex', flexDirection: 'column', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 12, padding: 20 }}>

      {/* Target */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Generate for</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {RAIL_GROUPS.map((grp, gi) => (
            <div key={grp.label} style={{
              display: 'flex', flexDirection: 'column', gap: 4,
              marginTop: gi === 0 ? 0 : 12, paddingTop: gi === 0 ? 0 : 12,
              borderTop: gi === 0 ? 'none' : '1px solid var(--pe-line-soft)',
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 2px 2px' }}>{grp.label}</div>
              {grp.ids.map(id => {
                const tg = TARGETS[id]
                if (!tg) return null
                const on = target === tg.id
                const [name, kind] = tg.label.split(' · ')
                return (
                  <button key={tg.id} onClick={() => switchTarget(tg.id)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                      width: '100%', textAlign: 'left', padding: '11px 13px', borderRadius: 8,
                      border: '1px solid', borderColor: on ? 'var(--pe-accent-line)' : 'transparent',
                      background: on ? 'var(--pe-accent-bg)' : 'transparent',
                      color: on ? 'var(--pe-accent-ink)' : 'var(--pe-ink-2)',
                      fontSize: 15, fontWeight: on ? 600 : 500, cursor: 'pointer', transition: 'all 0.12s',
                    }}>
                    <span>{name}</span>
                    {kind && <span style={{ fontSize: 12, fontWeight: 500, color: on ? 'var(--pe-accent-ink)' : 'var(--pe-ink-3)', opacity: on ? 0.7 : 1 }}>{kind}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Project — tags each new generation so History can group them */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Project <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>· new generations are saved here</span>
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={activeProject}
            onChange={e => { e.target.value === '__new__' ? createProject() : setActiveProject(e.target.value) }}
            style={{ ...selStyle, maxWidth: 260 }}>
            <option value="">(No project)</option>
            {allProjects.map(p => <option key={p} value={p}>{p}</option>)}
            <option value="__new__">+ New project…</option>
          </select>
          {activeProject && (
            <>
              <button onClick={() => renameProject(activeProject)} style={{ fontSize: 13, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>Rename</button>
              <button onClick={() => deleteProject(activeProject)} style={{ fontSize: 13, color: 'var(--pe-danger)', background: 'none', border: '1px solid var(--pe-danger-line)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>Delete</button>
            </>
          )}
        </div>
      </div>

      {/* Models */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div style={{ flex: '1 1 240px' }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Writer model <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>· builds the prompt</span>
          </label>
          {models.length > 0
            ? <ModelSelect models={models} value={writerModel} onChange={e => { setWriterModel(e.target.value); rememberModel('writer', e.target.value) }} />
            : <input style={selStyle} value={writerManual} onChange={e => { setWriterManual(e.target.value); rememberModel('writer', e.target.value.trim()) }} placeholder={isAnthropic(cfg.base) ? 'claude-sonnet-4-6' : isGrok(cfg.base) ? 'grok-4' : isOpenRouter(cfg.base) ? 'anthropic/claude-sonnet-4-6' : 'mistral-nemo'} spellCheck={false} />}
        </div>
        {showImage && (
          <div style={{ flex: '1 1 240px' }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Vision model <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>· reads image inputs</span>
            </label>
            {models.length > 0
              ? <ModelSelect models={models} value={visionModel} onChange={e => { setVisionModel(e.target.value); rememberModel('vision', e.target.value) }} />
              : <input style={selStyle} value={visionManual} onChange={e => { setVisionManual(e.target.value); rememberModel('vision', e.target.value.trim()) }} placeholder={isAnthropic(cfg.base) ? 'claude-sonnet-4-6' : isGrok(cfg.base) ? 'grok-4' : isOpenRouter(cfg.base) ? 'anthropic/claude-sonnet-4-6' : 'qwen2.5vl:7b'} spellCheck={false} />}
          </div>
        )}
      </div>

      <div style={{ marginTop: 4 }}>
        <ConfigBar cfg={cfg} setCfg={setCfg} models={models} modelStatus={modelStatus}
          reloadModels={configActions.reloadModels} onClearCaptionCache={configActions.clearCaptionCache} />
      </div>

      </div>{/* ================= END LEFT RAIL ================= */}

      {/* ================= CENTER · COMPOSE ================= */}
      {/* For the scriptwriter, ScriptwriterPanel itself is the grid child — it
          returns two top-level halves (its own input workspace tagged
          gridColumn:'2', its results screen tagged gridColumn:'3') so the
          results half lands in the same column as the History panel below,
          instead of both halves being nested inside one column-2 wrapper. */}
      {scriptwriterMode ? (
        <ScriptwriterPanel
          key={scriptwriterKey}
          cfg={cfg}
          writerModel={effectiveWriter}
          visionModel={effectiveVision}
          initialState={scriptwriterInitial}
          onSaveHistory={saveScriptHistory}
          history={history}
          library={library} onAddLibraryImages={addLibraryImages} onRemoveLibraryImage={removeLibraryImage}
          onSaveLibraryCaption={galleryActions.saveLibraryCaption} onSetLibraryRole={galleryActions.setLibraryRole}
          onDescribeLibraryImage={galleryActions.describeLibraryImage}
          imageMeta={imageMeta} onSaveImageCaption={galleryActions.saveImageCaption}
          onSetImageRole={galleryActions.setImageRole} onDescribeImage={galleryActions.describeImage}
          voiceLibrary={voiceLibrary} onAddVoiceLibraryFiles={addVoiceLibraryFiles} onRemoveVoiceLibraryItem={removeVoiceLibraryItem}
          onRenameVoiceLibraryCharacter={renameVoiceLibraryCharacter} onSaveAudioToVoiceLibrary={saveAudioToVoiceLibrary}
          comfyCfg={comfyCfg}
          setComfyCfg={setComfyCfg}
          loras={loras}
          onSaveLoras={saveLoraLibrary}
          autoJob={scriptwriterAutoJob}
          onAutoJobDone={(res) => scriptwriterAutoResolveRef.current?.(res)}
          onQueueAutoJob={addScriptwriterAutoJob}
          queueProps={{ queue: queue.items, busy: queue.busy, runningId: queue.runningId, ...queueActions }}
          adminMode={admin.mode}
        />
      ) : (
      <div style={{ gridColumn: '2', display: 'flex', flexDirection: 'column', minWidth: 0 }}>

      {/* Output count */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Output</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {OUTPUT_COUNT_OPTIONS.map(o => (
            <button key={o.value} onClick={() => setOutputCount(o.value)} style={btn(outputCount === o.value)}>{o.label}</button>
          ))}
        </div>
        {outputCount === 3 && <p style={{ fontSize: 13, color: 'var(--pe-ink-3)', margin: '6px 0 0' }}>Vision runs once; the writer then runs 3× at temperatures {VARIANT_TEMPS.join(' / ')}, each with a short literal → balanced → bold phrasing nudge so variants stay distinct even on models that ignore temperature.</p>}
      </div>

      {/* Duration */}
      {show.duration && (
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Duration</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(t.durations || DURATION_OPTIONS).map(o => (
              <button key={o.value} onClick={() => setDuration(o.value)} style={btn(duration === o.value)}>{o.label}</button>
            ))}
          </div>
          <p style={{ fontSize: 13, color: 'var(--pe-ink-3)', margin: '6px 0 0', lineHeight: 1.5 }}>
            {t.durationHint || (<>Sweet spot: <span style={{ color: 'var(--pe-accent-ink)' }}>≤10s renders cleanest</span>. 12–20s can show subject drift — consider the Extend workflow (e.g. 8s + 8s) for longer clips.</>)}
          </p>
        </div>
      )}

      {/* Frame Mode + image/reference input, moved to the top for MiniMax H3
          only — a reference image's role, LoRA and voice all belong together,
          before the scene text (see MinimaxRefPanel.jsx). Every other target
          keeps this at its original position further down, unchanged. */}
      {target === 'minimax_h3' && <>{frameModePicker}{imageInputBlock}</>}

      {/* Style — an instruction to the writer LLM, nothing left to instruct in Manual mode */}
      {!manualUI && (
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t.type === 'image' ? 'Style' : 'Scene Style'}</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {STYLE_OPTIONS.map(o => (
            <button key={o.id} onClick={() => setStyle(o.id)} title={o.hint} style={btn(style === o.id)}>{o.label}</button>
          ))}
        </div>
      </div>
      )}

      {/* Creativity — same reason as Style */}
      {!manualUI && (
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t.type === 'image' ? 'Image Fidelity' : 'Creativity'}</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {CREATIVITY_OPTIONS.map(o => (
            <button key={o.id} onClick={() => setCreativity(o.id)} title={o.hint} style={btn(creativity === o.id)}>{o.label}</button>
          ))}
        </div>
        <p style={{ fontSize: 13, color: 'var(--pe-ink-3)', margin: '6px 0 0', lineHeight: 1.5 }}>
          {t.type === 'image'
            ? 'How closely the prompt recreates your reference image vs. invents something new.'
            : t.type === 'text'
              ? 'How much the delivery pushes beyond a plain, literal reading of the idea.'
              : 'How inventive the proposed motion and atmosphere should be — the first frame itself always stays fixed.'}
        </p>
      </div>
      )}

      {/* Prompt length — same reason as Style */}
      {!manualUI && (
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Prompt Length</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PROMPT_LENGTH_OPTIONS.map(o => (
            <button key={o.id} onClick={() => setPromptLength(o.id)} title={o.hint} style={btn(promptLength === o.id)}>{o.label}</button>
          ))}
        </div>
      </div>
      )}

      {/* Scene — also where the Manual-mode toggle lives, since it decides what
          this field even means: a hint for the writer, or the literal output text. */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {sceneLabel}{' '}
          {sceneHint && <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>{sceneHint}</span>}
          {target === 'minimax_h3' && (
            <button
              onClick={() => {
                const next = !manualMode
                setManualMode(next)
                // Drop the seed straight into the field so there's real,
                // editable text to work from — but only ever onto a blank
                // field, never over something already typed.
                if (next && !scene.trim()) {
                  setScene(buildManualSeed(imgs.refImages, imgs.refAudios))
                }
                // Soundscape is required in Manual mode (nothing invents it —
                // see the assembler's validation) — seed a neutral starting
                // value the same way, only over a blank field, so the very
                // first "Assemble prompt" click doesn't fail on an empty
                // required field the user hasn't been asked to fill in yet.
                if (next && !soundscape.trim()) {
                  setSoundscape('Quiet room tone.')
                }
              }}
              title="Write the H3 prompt yourself, in H3's own tag syntax — no AI rewriting, no vision/writer calls"
              style={{ ...btn(manualMode), marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}
            >
              ✍ Write it yourself
            </button>
          )}
        </label>
        <textarea ref={sceneTextareaRef} value={scene} onChange={e => setScene(e.target.value)} placeholder={scenePlaceholder} rows={manualUI ? 10 : 4}
          style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '12px 14px', color: 'var(--pe-ink)', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.6, transition: 'border-color 0.15s', fontFamily: manualUI ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit' }}
          onFocus={e => e.target.style.borderColor = 'var(--pe-accent)'} onBlur={e => e.target.style.borderColor = 'var(--pe-line)'} />
        {manualUI && (
          <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', marginTop: 6, lineHeight: 1.5 }}>
            Tags: {frameMode === 'ref' ? MANUAL_H3_LEGEND_REF : MANUAL_H3_LEGEND_DEFAULT}
          </div>
        )}
        {manualUI && manualWarnings.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {manualWarnings.map((w, i) => (
              <div key={i} style={{ fontSize: 13, color: 'var(--pe-warn)', lineHeight: 1.5 }}>⚠ {w}</div>
            ))}
          </div>
        )}
      </div>

      {/* Avoid — an instruction to the writer LLM, nothing left to instruct in Manual mode */}
      {!manualUI && (
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Avoid <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>(optional — things to keep out of the result, e.g. "text, watermark", or a likely mistake to correct, e.g. "blue car", "horse in background")</span>
        </label>
        <textarea value={negative} onChange={e => setNegative(e.target.value)} placeholder="e.g. text, watermark, blue car, horse in background" rows={2}
          style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 14px', color: 'var(--pe-ink)', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
          onFocus={e => e.target.style.borderColor = 'var(--pe-accent)'} onBlur={e => e.target.style.borderColor = 'var(--pe-line)'} />
      </div>
      )}

      {/* Camera */}
      {show.camera && (
        <div style={{ marginBottom: 18 }}>
          <button
            onClick={() => setCameraOpen(v => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--pe-ink-3)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}
          >
            <span style={{ fontSize: 13, transition: 'transform 0.2s', display: 'inline-block', transform: cameraOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            Camera
          </button>
          {cameraOpen && (
            <div style={{ marginTop: 12, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '16px 18px' }}>
              <p style={{ fontSize: 13, color: 'var(--pe-ink-3)', margin: '0 0 14px', lineHeight: 1.5 }}>
                Click a move to insert it into your scene at the cursor, e.g. <code style={{ color: 'var(--pe-accent-ink)' }}>[camera: a slow dolly-in toward the subject]</code>.
                You can also type <code style={{ color: 'var(--pe-accent-ink)' }}>[camera: ...]</code> markers by hand, anywhere in the text, in your own words.
              </p>
              {CAMERA_GROUPS.map(g => (
                <div key={g.group} style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 8 }}>{g.group}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {g.moves.map(m => {
                      const flashed = flashId === m.id
                      return (
                        <button key={m.id} title={m.desc} onClick={() => insertCameraMarker(m)}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '5px 10px', borderRadius: 6, border: '1px solid', borderColor: flashed ? 'var(--pe-accent)' : 'var(--pe-line)', background: flashed ? 'var(--pe-accent-bg)' : 'var(--pe-surface)', color: flashed ? 'var(--pe-accent-ink)' : 'var(--pe-ink-3)', fontSize: 13.5, transition: 'all 0.15s' }}>
                          {flashed ? '✓ Inserted' : m.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--pe-line-soft)' }}>
                <a href="https://camerapromptsgenerator.vercel.app/" target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: 'var(--pe-accent)', textDecoration: 'none' }}>
                  camerapromptsgenerator.vercel.app ↗
                </a>
                <span style={{ fontSize: 13, color: 'var(--pe-line)', marginLeft: 8 }}>— browse more angle & shot references</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* LoRA triggers — character-kind chips hide here specifically in H3 ref
          mode, where a character LoRA is instead assigned directly on its
          reference image's own card (MinimaxRefPanel); every other frame mode
          and every other target still has no other place to set one. */}
      {targetTakesLoras(target) && (
        <LoraPanel
          loras={loras} activeIds={activeLoraIds} kinds={refMode ? ['style'] : null} editable={!isLoading}
          onToggle={toggleLora} onSaveLoras={saveLoraLibrary}
          subjects={loraSubjects} onSubjectChange={setLoraSubject} />
      )}

      {/* Spoken language — nothing left to drive it in Manual mode; the user
          tags [Language] "…" directly in their own typed prose. */}
      {show.spokenLang && !manualUI && (
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Spoken Language <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>(the language everyone in the video speaks — dialogue you type is translated into it)</span>
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {SPOKEN_LANGUAGES.map(l => (
              <button key={l.id} onClick={() => setSpokenLangId(l.id)} style={btn(spokenLangId === l.id)} title={l.label}>{l.short}</button>
            ))}
          </div>
        </div>
      )}

      {/* Dialogue — in Manual mode, dialogue goes straight into the typed prose
          as [Language] "…" (rule 6/6a), so this separate field is inert. */}
      {show.dialogue && !manualUI && (
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Dialogue <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>(optional — spoken aloud; needs 8s+ for more than a few words)</span>
          </label>
          <textarea value={dialogue} onChange={e => setDialogue(e.target.value)} placeholder="Exact words to be spoken, e.g.  We need to leave. Now." rows={2}
            style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 14px', color: 'var(--pe-ink)', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
            onFocus={e => e.target.style.borderColor = 'var(--pe-accent)'} onBlur={e => e.target.style.borderColor = 'var(--pe-line)'} />
          {dialogue.trim() && (() => {
            const b = syllableBudget(duration, dialogue, show.spokenLang ? spokenLangId : null)
            const over = b.max != null && b.count > b.max
            return (
              <div style={{ fontSize: 13, color: over ? 'var(--pe-warn)' : 'var(--pe-ink-3)', marginTop: 6, lineHeight: 1.5 }}>
                {b.count} syllable{b.count === 1 ? '' : 's'}
                {b.max != null && (
                  <> · budget ≈{b.min}–{b.max} for a {b.seconds}s clip ({b.langLabel} pacing, ~{b.spsLo}–{b.spsHi} syll/s)</>
                )}
                {over && ' — too many syllables for this duration; speech may rush or get cut. Trim the line or pick a longer duration.'}
              </div>
            )
          })()}
          <input value={delivery} onChange={e => setDelivery(e.target.value)}
            placeholder="Delivery / voice / accent (optional) — e.g. calm and slow, urgent whisper, British accent"
            style={{ width: '100%', boxSizing: 'border-box', marginTop: 8, background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '9px 14px', color: 'var(--pe-ink)', fontSize: 13, outline: 'none', transition: 'border-color 0.15s' }}
            onFocus={e => e.target.style.borderColor = 'var(--pe-accent)'} onBlur={e => e.target.style.borderColor = 'var(--pe-line)'} />
        </div>
      )}

      {/* Ambient sound + audience-only score, for a target that generates audio */}
      {tcaps.audioFields && (
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Ambient Sound <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>
              {manualUI ? '(required in Manual mode — nothing invents this; type "silence" for none)' : '(optional — overall_soundscape: ambience, physical sounds; leave blank to let the writer invent it)'}
            </span>
          </label>
          <textarea value={soundscape} onChange={e => setSoundscape(e.target.value)} placeholder="e.g. steady ventilation hum, quiet servo motors, a soft mechanical click" rows={2}
            style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 14px', color: 'var(--pe-ink)', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
            onFocus={e => e.target.style.borderColor = 'var(--pe-accent)'} onBlur={e => e.target.style.borderColor = 'var(--pe-line)'} />
          <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Music <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>(optional — non_diegetic_music, audience-only; leave blank to let the writer decide, or type "none" for silence)</span>
          </label>
          <textarea value={music} onChange={e => setMusic(e.target.value)} placeholder='e.g. sparse electronic pulse, moderate tempo, restrained low synth bass — or "none"' rows={2}
            style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 14px', color: 'var(--pe-ink)', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
            onFocus={e => e.target.style.borderColor = 'var(--pe-accent)'} onBlur={e => e.target.style.borderColor = 'var(--pe-line)'} />
        </div>
      )}

      {/* Frame Mode + image/reference input — every target except MiniMax H3;
          H3 renders the same two blocks near the top instead, see below. */}
      {target !== 'minimax_h3' && <>{frameModePicker}{imageInputBlock}</>}

      {/* ComfyUI handoff: input-folder copy, plus the slot the per-result send targets */}
      {((showImage && currentImages().length > 0) || results.some(r => r.text)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          <input
            value={comfyCfg.url} onChange={e => setComfyCfg({ ...comfyCfg, url: e.target.value })}
            placeholder="http://127.0.0.1:8188" spellCheck={false}
            style={{ flex: '0 1 220px', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 7, padding: '6px 10px', color: 'var(--pe-ink)', fontSize: 13.5, outline: 'none' }}
          />
          <input
            value={comfyCfg.slot} onChange={e => setComfyCfg({ ...comfyCfg, slot: e.target.value })}
            placeholder="slot" spellCheck={false}
            title="Named slot on the Prompt Enhancer Bridge nodes. Match this to the 'slot' widget on the node in your workflow."
            style={{ flex: '0 1 110px', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 7, padding: '6px 10px', color: 'var(--pe-ink)', fontSize: 13.5, outline: 'none' }}
          />
          {showImage && currentImages().length > 0 && <button
            onClick={copyImagesToComfy} disabled={comfyCopyStatus.state === 'sending'}
            title={comfyCopyStatus.state === 'error' ? comfyCopyStatus.error : "Uploads the loaded image(s) into ComfyUI's input/ folder via its own /upload/image API — needs ComfyUI running and started with --enable-cors-header."}
            style={{
              padding: '6px 12px', borderRadius: 6, border: '1px solid var(--pe-line)',
              background: comfyCopyStatus.state === 'done' ? 'var(--pe-ok-bg)' : comfyCopyStatus.state === 'error' ? 'var(--pe-danger-bg)' : 'var(--pe-surface)',
              color: comfyCopyStatus.state === 'done' ? 'var(--pe-ok)' : comfyCopyStatus.state === 'error' ? 'var(--pe-danger)' : 'var(--pe-accent-ink)',
              fontSize: 13, cursor: comfyCopyStatus.state === 'sending' ? 'wait' : 'pointer',
            }}
          >
            {comfyCopyStatus.state === 'sending' ? 'Copying…'
              : comfyCopyStatus.state === 'done' ? '✓ Copied to ComfyUI'
              : comfyCopyStatus.state === 'error' ? '✕ Failed — hover for details'
              : '⇪ Copy to ComfyUI input'}
          </button>}
        </div>
      )}

      {/* Admin system prompt */}
      {admin.mode && (
        <div style={{ marginBottom: 18, background: 'var(--pe-rail)', border: '1px solid var(--pe-accent-line)', borderRadius: 10, padding: '12px 16px' }}>
          <button
            onClick={() => admin.setSystemOpen(v => !v)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--pe-accent-ink)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: admin.systemOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
              System Prompt
            </span>
            <span style={{ fontSize: 13.5, color: 'var(--pe-ink-3)' }}>editable · sent on every generation</span>
          </button>
          {admin.systemOpen && (
            <div style={{ marginTop: 12 }}>
              <textarea value={admin.system} onChange={e => admin.setSystem(e.target.value)} rows={12}
                style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 12px', color: 'var(--pe-ink-2)', fontSize: 13.5, fontFamily: 'monospace', resize: 'vertical', outline: 'none', lineHeight: 1.5 }} />
              <button onClick={() => admin.setSystem(systemPromptFor(t, frameMode))} style={{ marginTop: 6, fontSize: 13, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '3px 10px', cursor: 'pointer' }}>Reset to default</button>
            </div>
          )}
        </div>
      )}

      {/* Admin user message review */}
      {admin.mode && admin.pending && (
        <div style={{ marginBottom: 18, background: 'var(--pe-rail)', border: '1px solid var(--pe-accent-line)', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>User Message · review & edit before sending</div>
          <textarea value={admin.userMsg} onChange={e => admin.setUserMsg(e.target.value)} rows={10}
            style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 12px', color: 'var(--pe-ink-2)', fontSize: 13.5, fontFamily: 'monospace', resize: 'vertical', outline: 'none', lineHeight: 1.5 }} />
          <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
            <button onClick={sendToWriter} disabled={writing}
              style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: writing ? 'var(--pe-line)' : 'var(--pe-accent)', color: writing ? 'var(--pe-ink-3)' : '#fff', fontSize: 14, fontWeight: 600, cursor: writing ? 'not-allowed' : 'pointer', transition: 'all 0.15s' }}>
              {writing ? '✦ Writing prompt…' : '→ Send to Writer'}
            </button>
            <button onClick={() => admin.setPending(false)} disabled={writing}
              style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid var(--pe-line)', background: 'none', color: 'var(--pe-ink-3)', fontSize: 13, cursor: writing ? 'not-allowed' : 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Generate button */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
        <button onClick={enhance} disabled={genBtnDisabled} style={{ ...genBtnStyle, flex: 1 }}>
          {buttonLabel}
        </button>
        {target === 'minimax_h3' && !manualUI && (
          <button onClick={buildTemplatePrompt} disabled={genBtnDisabled}
            title="Instantly build a full H3 template from your current settings, with the description left as a placeholder to write yourself — no AI call"
            style={{ flexShrink: 0, padding: '9px 18px', borderRadius: 8, border: '1px solid var(--pe-accent-line)', background: 'none', color: genBtnDisabled ? 'var(--pe-ink-3)' : 'var(--pe-accent-ink)', fontSize: 14, fontWeight: 600, cursor: genBtnDisabled ? 'not-allowed' : 'pointer' }}>
            ✍ Manual Prompt
          </button>
        )}
        <button onClick={addToQueue} disabled={!canGenerate || queue.busy}
          title="Save this generation for later instead of running it now"
          style={{ flexShrink: 0, padding: '9px 18px', borderRadius: 8, border: '1px solid var(--pe-accent-line)', background: 'none', color: (!canGenerate || queue.busy) ? 'var(--pe-ink-3)' : 'var(--pe-accent-ink)', fontSize: 14, fontWeight: 600, cursor: (!canGenerate || queue.busy) ? 'not-allowed' : 'pointer' }}>
          + Add to Queue
        </button>
      </div>

      {/* Global error */}
      {globalError && (
        <div style={{ marginTop: 16, padding: '12px 14px', background: 'var(--pe-danger-bg)', border: '1px solid var(--pe-danger-line)', borderRadius: 8, fontSize: 13, color: 'var(--pe-danger)' }}>{globalError}</div>
      )}

      </div>
      )}
      {/* ================= END CENTER · COMPOSE ================= */}

      {/* ================= RIGHT · OUTPUT ================= */}
      <div style={{ gridColumn: '3', display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>

      {!scriptwriterMode && results.length === 0 && !caption && !globalError && (
        <div style={{ background: 'var(--pe-surface)', border: '1px dashed var(--pe-line)', borderRadius: 12, padding: '28px 24px', color: 'var(--pe-ink-3)', fontSize: 15, lineHeight: 1.6 }}>
          Your enhanced {t.type === 'image' ? 'image prompt' : t.type === 'text' ? 'script' : 'prompt'} will appear here. Fill in the scene (or load a reference image) and hit <span style={{ color: 'var(--pe-accent-ink)', fontWeight: 600 }}>Enhance Prompt</span>.
        </div>
      )}

      {/* Vision caption — editable; stored on the history entry */}
      {caption && (
        <details style={{ marginTop: 16, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 14px' }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            👁 vision description{effectiveVision ? ` · ${effectiveVision}` : ''}
            {visionStats && (visionStats.fromCache + visionStats.fresh + (visionStats.reused || 0) > 0) && (
              <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}> · {visionStats.reused ? `reused from history` : `${visionStats.fromCache} cached, ${visionStats.fresh} described`}</span>
            )}
            {caption !== savedCaption && (
              <span style={{ color: 'var(--pe-accent-ink)', textTransform: 'none', letterSpacing: 0 }}> · edited</span>
            )}
          </summary>
          <textarea
            value={caption}
            onChange={e => setCaption(e.target.value)}
            spellCheck={false}
            rows={Math.min(16, Math.max(4, caption.split('\n').length + 1))}
            style={{ marginTop: 8, width: '100%', boxSizing: 'border-box', fontSize: 13.5, color: 'var(--pe-ink-2)', lineHeight: 1.6, background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '8px 10px', fontFamily: 'inherit', resize: 'vertical' }}
          />
          <div style={{ marginTop: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--pe-ink-3)', lineHeight: 1.5 }}>
              The writer built the prompt from this. Edit it and re-run the writer to steer the result; the text is saved with the history entry.
            </span>
            {caption.trim() && caption !== savedCaption && !writing && (
              <button onClick={rerunFromCaption}
                style={{ flexShrink: 0, fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>
                ↻ Re-run writer with this description
              </button>
            )}
          </div>
        </details>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {canRender && results.some(r => r.text) && (
           <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, fontSize: 13, color: 'var(--pe-ink-3)' }}>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>🎨 Render</span>
              {grokRenderOn && geminiRenderOn && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  via
                  <select value={render.provider} onChange={e => render.setProvider(e.target.value)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                    <option value="grok">Grok</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </label>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                aspect
                <select value={render.imageAspect} onChange={e => render.setImageAspect(e.target.value)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                  {GROK_IMAGE_RESOLUTIONS.map(r => <option key={r.id} value={r.ar}>{r.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                count
                <select value={render.imageCount} onChange={e => render.setImageCount(parseInt(e.target.value, 10) || 1)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              {imgProvider === 'grok' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  resolution
                  <select value={render.imageResolution} onChange={e => render.setImageResolution(e.target.value)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                    <option value="1k">1K</option>
                    <option value="2k">2K</option>
                  </select>
                </label>
              )}
              <span style={{ color: 'var(--pe-ink-3)' }}>
                model: {imgProvider === 'gemini'
                  ? (cfg.geminiImageModel || 'gemini-2.5-flash-image')
                  : (cfg.imageModel || 'grok-imagine-image-2.0')} · set in ⚙ Backend
              </span>
              {currentImages().length > 0 && (
                <span style={{ color: 'var(--pe-ok)' }}>· image-to-image: {currentImages().length} reference{currentImages().length > 1 ? 's' : ''} loaded</span>
              )}
            </div>
            {isGrok(cfg.base) && (
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, fontSize: 13, color: 'var(--pe-ink-3)' }}>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>🎬 Grok video</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                duration
                <select value={render.videoDuration} onChange={e => render.setVideoDuration(parseInt(e.target.value, 10) || 8)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                  {Array.from({ length: 15 }, (_, n) => n + 1).map(n => <option key={n} value={n}>{n}s</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                resolution
                <select value={render.videoResolution} onChange={e => render.setVideoResolution(e.target.value)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                  <option value="480p">480p</option>
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                aspect
                <select value={render.videoAspect} onChange={e => render.setVideoAspect(e.target.value)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                  {GROK_IMAGE_RESOLUTIONS.filter(r => r.id !== 'cine219').map(r => <option key={r.id} value={r.ar}>{r.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <input type="checkbox" checked={render.videoAudio} onChange={e => render.setVideoAudio(e.target.checked)} /> audio
              </label>
              <span style={{ color: 'var(--pe-ink-3)' }}>model: {cfg.videoModel || 'grok-imagine-video-1.5'} · set in ⚙ Backend</span>
              {currentImages().length > 0 && <span style={{ color: 'var(--pe-ok)' }}>· image-to-video: first frame used</span>}
              {render.videoResolution === '1080p' && currentImages().length > 0 && (
                <span style={{ color: 'var(--pe-warn)' }}>· 1080p may be rejected for image-to-video — retries automatically</span>
              )}
            </div>
            )}
           </div>
          )}
          {results.some(r => r.text) && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              {(resultsEdited || captionEdited || savedEditFlash) && (
                <button onClick={saveResultsEdit} disabled={savedEditFlash}
                  style={{ fontSize: 13, color: savedEditFlash ? 'var(--pe-ok)' : 'var(--pe-accent-ink)', background: 'none', border: `1px solid ${savedEditFlash ? 'var(--pe-ok-bg)' : 'var(--pe-accent-line)'}`, borderRadius: 6, padding: '5px 12px', cursor: savedEditFlash ? 'default' : 'pointer' }}>
                  {savedEditFlash ? '✓ Saved to history' : '💾 Save edited prompt to history'}
                </button>
              )}
              <button onClick={exportBundle} style={{ fontSize: 13, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer' }}>
                {results.filter(r => r.text).length > 1
                  ? `Export ${results.filter(r => r.text).length} ZIPs (one per variant) ↓`
                  : 'Export ZIP (images + prompt) ↓'}
              </button>
            </div>
          )}
          {results.map((r, i) => (
            <div key={i}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{r.label}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {r.usage && <span style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>in {r.usage.input_tokens} · out {r.usage.output_tokens} tokens</span>}
                  {r.text && <button onClick={() => copy(i)} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--pe-line)', background: copied === i ? 'var(--pe-ok-bg)' : 'var(--pe-surface)', color: copied === i ? 'var(--pe-ok)' : 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer' }}>{copied === i ? '✓ Copied' : 'Copy'}</button>}
                  {r.text && (() => {
                    const sent = comfySendStatus.idx === i ? comfySendStatus.state : 'idle'
                    return (
                      <button
                        onClick={() => sendShotToComfy(i)} disabled={comfySendStatus.state === 'sending'}
                        title={sent === 'error' ? comfySendStatus.error : `Uploads the current image(s), then pushes this prompt to ComfyUI slot "${comfyCfg.slot || 'default'}" for the Prompt Enhancer Bridge nodes to read.`}
                        style={{
                          padding: '5px 12px', borderRadius: 6, border: '1px solid var(--pe-line)',
                          background: sent === 'done' ? 'var(--pe-ok-bg)' : sent === 'error' ? 'var(--pe-danger-bg)' : 'var(--pe-surface)',
                          color: sent === 'done' ? 'var(--pe-ok)' : sent === 'error' ? 'var(--pe-danger)' : 'var(--pe-accent-ink)',
                          fontSize: 13, cursor: comfySendStatus.state === 'sending' ? 'wait' : 'pointer',
                        }}
                      >
                        {sent === 'sending' ? 'Sending…' : sent === 'done' ? '✓ Sent' : sent === 'error' ? '✕ Failed' : '→ ComfyUI'}
                      </button>
                    )
                  })()}
                  {r.text && canRender && (() => {
                    const edit = currentImages().length > 0
                    const verb = edit ? 'Render from image' : 'Render'
                    const pModel = imgProvider === 'gemini' ? (cfg.geminiImageModel || 'gemini-2.5-flash-image') : (cfg.imageModel || 'grok-imagine-image-2.0')
                    return (
                    <button
                      onClick={() => renderImage(i)} disabled={r.imgLoading}
                      title={r.imgError ? r.imgError : `${edit ? 'Image-to-image edit' : 'Render'} with ${pModel} (${render.imageCount}× · ${render.imageAspect}${imgProvider === 'grok' ? ` · ${render.imageResolution}` : ''})${edit ? ` · ${currentImages().length} reference image(s)` : ''}.`}
                      style={{
                        padding: '5px 12px', borderRadius: 6, border: '1px solid var(--pe-line)',
                        background: r.imgError ? 'var(--pe-danger-bg)' : r.images?.length ? 'var(--pe-ok-bg)' : 'var(--pe-surface)',
                        color: r.imgError ? 'var(--pe-danger)' : r.images?.length ? 'var(--pe-ok)' : 'var(--pe-accent-ink)',
                        fontSize: 13, cursor: r.imgLoading ? 'wait' : 'pointer',
                      }}
                    >
                      {r.imgLoading ? 'Rendering…' : r.imgError ? '✕ Retry render' : r.images?.length ? '🎨 Re-render' : `🎨 ${verb}`}
                    </button>
                    )
                  })()}
                  {r.text && isGrok(cfg.base) && (() => {
                    const fromImg = currentImages().length > 0
                    const label = r.vidLoading
                      ? `Rendering video… ${Math.round(r.vidProgress || 0)}%`
                      : r.vidError ? '✕ Retry video'
                      : r.video ? '🎬 Re-render video'
                      : fromImg ? '🎬 Render video from image' : '🎬 Render video'
                    return (
                      <button
                        onClick={() => renderVideo(i)} disabled={r.vidLoading}
                        title={r.vidError || `Submit + poll ${cfg.videoModel || 'grok-imagine-video-1.5'} (${render.videoDuration}s · ${render.videoResolution} · ${render.videoAspect} · audio ${render.videoAudio ? 'on' : 'off'})${fromImg ? ' · image-to-video' : ''}. Takes 1–5 min — keep the tab open.`}
                        style={{
                          padding: '5px 12px', borderRadius: 6, border: '1px solid var(--pe-line)',
                          background: r.vidError ? 'var(--pe-danger-bg)' : r.video ? 'var(--pe-ok-bg)' : 'var(--pe-surface)',
                          color: r.vidError ? 'var(--pe-danger)' : r.video ? 'var(--pe-ok)' : 'var(--pe-accent-ink)',
                          fontSize: 13, cursor: r.vidLoading ? 'wait' : 'pointer',
                        }}
                      >
                        {label}
                      </button>
                    )
                  })()}
                </div>
              </div>
              {r.loading && <div style={{ padding: '18px 20px', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, fontSize: 13, color: 'var(--pe-ink-3)' }}>Generating…</div>}
              {r.error && <div style={{ padding: '12px 14px', background: 'var(--pe-danger-bg)', border: '1px solid var(--pe-danger-line)', borderRadius: 8, fontSize: 13, color: 'var(--pe-danger)' }}>Error: {r.error}</div>}
              {r.text && (
                <textarea value={r.text} onChange={e => editResult(i, e.target.value)}
                  rows={Math.max(4, Math.ceil(r.text.length / 70))} spellCheck={false}
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '18px 20px', fontSize: 13.5, lineHeight: 1.8, color: 'var(--pe-ink)', whiteSpace: 'pre-wrap', fontFamily: 'var(--pe-mono)', resize: 'vertical', outline: 'none', transition: 'border-color 0.15s' }}
                  onFocus={e => e.target.style.borderColor = 'var(--pe-accent)'} onBlur={e => e.target.style.borderColor = 'var(--pe-line)'} />
              )}
              {target === 'minimax_h3' && r.text && !r.loading && !r.error && (
                <H3SyntaxBadge text={r.text} mode={r.h3Mode} refImages={imgs.refImages}
                  anchors={(imgs.refImages || []).map((im, i) => ({ pictureN: i + 1, atSeconds: im.atSeconds })).filter(a => a.atSeconds != null)} />
              )}
              {r.imgError && <div style={{ marginTop: 10, padding: '12px 14px', background: 'var(--pe-danger-bg)', border: '1px solid var(--pe-danger-line)', borderRadius: 8, fontSize: 13, color: 'var(--pe-danger)' }}>Render failed: {r.imgError}</div>}
              {r.images?.length > 0 && (
                <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  {r.images.map((img, k) => img.b64 && (
                    <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 340 }}>
                      <img src={`data:${img.mediaType || 'image/png'};base64,${img.b64}`} alt={`render ${k + 1}`}
                        style={{ width: '100%', borderRadius: 10, border: '1px solid var(--pe-line)', display: 'block' }} />
                      <a href={`data:${img.mediaType || 'image/jpeg'};base64,${img.b64}`}
                        download={`render-${i + 1}-${k + 1}.${imgExt(img.mediaType)}`}
                        style={{ fontSize: 13, color: 'var(--pe-accent-ink)', textDecoration: 'none' }}>⬇ Save image</a>
                      {isGrok(cfg.base) && (() => {
                        const st = render.upStatus[`${i}-${k}`]
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <button onClick={() => upscaleImage(i, k)} disabled={st === 'loading'}
                              title="Re-runs this image through Grok img2img at 2K. Being image-to-image, fine details shift slightly."
                              style={{ fontSize: 13, color: st && st.error ? 'var(--pe-danger)' : img.upscaled ? 'var(--pe-ok)' : 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '3px 10px', cursor: st === 'loading' ? 'wait' : 'pointer' }}>
                              {st === 'loading' ? 'Upscaling…' : st && st.error ? '✕ Retry 2K' : img.upscaled ? '✓ 2K' : '⬆ Upscale to 2K'}
                            </button>
                            <span style={{ fontSize: 13.5, color: 'var(--pe-ink-3)' }}>img2img — slightly alters the image</span>
                            {st && st.error && <span style={{ fontSize: 13.5, color: 'var(--pe-danger)' }}>{st.error}</span>}
                          </div>
                        )
                      })()}
                      {img.revisedPrompt && img.revisedPrompt.trim() && img.revisedPrompt.trim() !== r.text.trim() && (
                        <details style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>
                          <summary style={{ cursor: 'pointer' }}>Grok's revised prompt</summary>
                          <div style={{ marginTop: 4, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{img.revisedPrompt}</div>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {r.vidError && <div style={{ marginTop: 10, padding: '12px 14px', background: 'var(--pe-danger-bg)', border: '1px solid var(--pe-danger-line)', borderRadius: 8, fontSize: 13, color: 'var(--pe-danger)' }}>Video render failed: {r.vidError}</div>}
              {r.vidLoading && !r.vidError && (
                <div style={{ marginTop: 10, padding: '12px 14px', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 8, fontSize: 13.5, color: 'var(--pe-ink-3)' }}>
                  Rendering video… {r.vidStatus || 'pending'} {Math.round(r.vidProgress || 0)}% · takes a few minutes; keep this tab open.
                </div>
              )}
              {r.video && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 480 }}>
                  <video controls src={r.video.b64 ? `data:${r.video.mediaType || 'video/mp4'};base64,${r.video.b64}` : r.video.url}
                    style={{ width: '100%', borderRadius: 10, border: '1px solid var(--pe-line)', display: 'block' }} />
                  {r.video.b64
                    ? <a href={`data:${r.video.mediaType || 'video/mp4'};base64,${r.video.b64}`} download={`grok-video-${i + 1}.mp4`}
                        style={{ fontSize: 13, color: 'var(--pe-accent-ink)', textDecoration: 'none' }}>⬇ Save video</a>
                    : <>
                        <a href={r.video.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--pe-accent-ink)', textDecoration: 'none' }}>Open video ↗</a>
                        <span style={{ fontSize: 13.5, color: 'var(--pe-ink-3)' }}>The xAI link expires after a while — open and download it soon.</span>
                      </>}
                  {r.video.duration ? <span style={{ fontSize: 13.5, color: 'var(--pe-ink-3)' }}>{r.video.duration}s</span> : null}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(caption || adaptSourceOverride || results.some(r => r.text)) && (
        <AdaptPanel
          key={adaptSourceOverride?.ts || 'live'}
          caption={adaptSourceOverride ? (adaptSourceOverride.caption || '') : caption}
          captioning={!!adaptSourceOverride?.captioning}
          scene={adaptSourceOverride?.scene ?? scene}
          sourceFrameMode={adaptSourceOverride?.frameMode ?? frameMode}
          sourceTarget={adaptSourceOverride?.sourceTarget ?? target}
          originalPrompt={adaptSourceOverride?.originalPrompt ?? (results.find(r => r.text)?.text ?? '')}
          fromHistory={!!adaptSourceOverride}
          sourceTs={adaptSourceOverride?.ts}
          autoRun={!!adaptSourceOverride?.autoRun}
          models={models} defaultModel={effectiveWriter} cfg={cfg}
          workspace={workspace} activeLoras={activeLoras}
          onSaveAdapt={(snap, outs) => saveHistory(snap, outs, false)}
          onClose={() => setAdaptSourceOverride(null)}
        />
      )}

      {/* History — the list, its filters and its cards live in HistoryPanel,
          which is memoized: the hidden file input stays here because App owns
          the import flow. */}
      <input ref={importInputRef} type="file" accept=".json" style={{ display: 'none' }}
        onChange={e => { if (e.target.files[0]) importHistory(e.target.files[0]); e.target.value = '' }} />
      <HistoryPanel
        history={history}
        visible={visibleHistory}
        open={historyOpen}
        onToggleOpen={toggleHistoryOpen}
        projects={allProjects}
        restoringId={restoringId}
        actions={historyActions}
        filters={histFilters.filters}
        setFilter={histFilters.setFilter}
        resetFilters={histFilters.resetFilters}
        filtersActive={histFilters.active}
        targets={histFilters.targets}
        models={histFilters.models}
      />

      {/* Queue — one shared queue for main-pipeline items and Full Auto
          Scriptwriter jobs alike (QueueCard renders both). Hidden while the
          Scriptwriter tab is open — it has its own filtered, embedded copy of
          this same panel in its Full Auto view instead. */}
      {!scriptwriterMode && (
        <QueuePanel queue={queue.items} open={queue.open} busy={queue.busy} runningId={queue.runningId} {...queueActions} />
      )}

      </div>{/* ================= END RIGHT · OUTPUT ================= */}

      </div>{/* ================= END GRID ================= */}
    </div>
  )
}

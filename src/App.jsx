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
  MINIMAX_H3_REF_ROLES, MINIMAX_H3_PRESERVE_OPTIONS,
  systemPromptFor,
} from './constants'
import { loadCfg, saveCfg, callOllama, generateImages, generateImagesGemini, generateVideo, fetchModels, pickWriter, pickVision, isAnthropic, isGrok, isCloud } from './api'
import { loadComfyCfg, saveComfyCfg, uploadImage as uploadComfyImage, sendShot as sendComfyShot } from './comfy'
import {
  listHistory, getHistoryEntry, addHistoryEntry, deleteHistoryEntry, updateHistoryEntry,
  clearHistory as dbClearHistory, generateId, migrateFromLocalStorage, migrateFromIndexedDB,
  setHistoryEntryProject, loadProjects, saveProjects, importEntries,
  getCaption, putCaption, clearCaptions,
  listQueue, getQueueItem, addQueueItem, updateQueueItem, deleteQueueItem, clearQueue as dbClearQueue,
  checkHealth, setWriteErrorHandler, HISTORY_EXPORT_URL,
} from './db'
import { btn, selStyle, moveLabel, presetById, syllableBudget, imageHash, visionCacheKey, mapWithConcurrency } from './utils'
import ConfigBar from './components/ConfigBar'
import ImagePanel from './components/ImagePanel'
import HistoryImageGallery from './components/HistoryImageGallery'
import ScriptwriterPanel from './components/ScriptwriterPanel'
import MinimaxRefPanel from './components/MinimaxRefPanel'
import AdaptPanel from './components/AdaptPanel'
import QueuePanel from './components/QueuePanel'
import { buildStylePart } from './adapt'

const buildVariants = (writer) => VARIANT_TEMPS.map((temp, i) => ({
  label: `${writer} · T${temp}`,
  temp,
  nudge: VARIANT_NUDGES[i] || '',
}))

// The vision description stored on a history entry — read it, and (when `onSave`
// is given) edit it in place. `onSave(text)` should persist + refresh.
function HistoryCaptionEditor({ value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [flash, setFlash] = useState(false)
  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])

  const save = async () => {
    await onSave(draft)
    setEditing(false)
    setFlash(true)
    setTimeout(() => setFlash(false), 1800)
  }

  if (editing) {
    return (
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', marginBottom: 4 }}>👁 vision description</div>
        <textarea value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}
          rows={Math.min(14, Math.max(3, draft.split('\n').length + 1))}
          style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, lineHeight: 1.55, color: 'var(--pe-ink-2)', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '6px 8px', fontFamily: 'inherit', resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button onClick={save} style={{ fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 10px', cursor: 'pointer' }}>Save</button>
          <button onClick={() => { setDraft(value); setEditing(false) }} style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <details style={{ marginBottom: 6 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--pe-ink-3)' }}>
        👁 vision description{flash ? ' · ✓ saved' : ''}
      </summary>
      <div style={{ fontSize: 13, color: 'var(--pe-ink-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap', marginTop: 4 }}>{value}</div>
      {onSave && (
        <button onClick={() => { setDraft(value); setEditing(true) }}
          style={{ marginTop: 4, fontSize: 12.5, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>✎ Edit</button>
      )}
    </details>
  )
}

// History-filter helpers — pure, work on any saved entry shape (old or new).
const entryTargetId = (h) => (h.type === 'scriptwriter' ? 'scriptwriter' : h.target)
const entryTargetLabel = (id) => (id === 'scriptwriter' ? 'Scriptwriter' : TARGETS[id]?.label || id)
const entryHasImages = (h) => !!(
  h.firstImg || h.midImg || h.lastImg ||
  (Array.isArray(h.refImages) && h.refImages.length) ||
  h.vision
)
// Flattened, lowercased text of one history entry for the free-text search box.
// Skips image bytes; covers the scene, vision caption, generated output(s),
// project, model and target label (and the scriptwriter's idea / script / shots).
const entrySearchText = (h) => {
  const parts = [h.project, h.model, entryTargetLabel(entryTargetId(h))]
  if (h.type === 'scriptwriter') {
    parts.push(h.idea, h.script?.title, h.script?.logline, h.script?.look)
    for (const c of h.script?.characters || []) parts.push(c.name, c.appearance, c.wardrobe)
    for (const l of h.script?.locations || []) parts.push(l.name, l.description)
    parts.push(JSON.stringify(h.script?.scenes || ''), JSON.stringify(h.directorsCut?.shots || ''))
    for (const p of h.finalPrompts || []) parts.push(p.text, p.sceneTitle)
    for (const im of h.refImages || []) parts.push(im.note, im.caption)
  } else {
    parts.push(h.scene, h.caption, h.negative, h.dialogue, h.style)
    for (const o of h.outputs || []) parts.push(o.text, o.label)
  }
  return parts.filter(Boolean).join('  ').toLowerCase()
}
const modelProvider = (m) => {
  const s = (m || '').toLowerCase()
  if (!s) return '—'
  if (s.includes('claude') || s.includes('anthropic')) return 'Claude'
  if (s.includes('grok')) return 'Grok'
  return 'Ollama'
}
const modelFilterLabel = (m) => `${modelProvider(m)} · ${m}`

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
  // xAI (Grok) image-render options — a compact strip shown above the results when on an xAI backend.
  const [imageAspect, setImageAspect]         = useState('auto')   // GROK_IMAGE_RESOLUTIONS.ar
  const [imageCount, setImageCount]           = useState(1)        // n, 1–4
  const [imageResolution, setImageResolution] = useState('1k')     // '1k' | '2k'
  // xAI (Grok) video-render options — second row of the same strip.
  const [videoDuration, setVideoDuration]     = useState(8)        // seconds, 1–15
  const [videoResolution, setVideoResolution] = useState('720p')   // '480p' | '720p' | '1080p'
  const [videoAspect, setVideoAspect]         = useState('auto')
  const [videoAudio, setVideoAudio]           = useState(true)
  const [upStatus, setUpStatus]               = useState({})       // `${i}-${k}` -> 'loading' | { error }
  // 🎨 Render provider. Grok (needs an xAI backend) and Gemini (needs cfg.geminiKey, any
  // backend) are independent; `renderProvider` only matters when BOTH are available.
  const [renderProvider, setRenderProvider]   = useState('grok')   // 'grok' | 'gemini' — only consulted when both are available
  // Id of the history entry the current results were last saved as — so a 🎨 Render can
  // patch its `outputs` in place instead of spawning a new entry.
  const lastSavedEntryIdRef = useRef(null)
  const resultsRef = useRef([])            // freshest `results` for the long-running video poll
  const videoAbortRef = useRef(new Map())  // result idx -> AbortController for an in-flight video render

  // 🎨 Render availability. Grok render needs an xAI backend; Gemini render needs only a
  // key (works on any backend). `imgProvider` is what a click actually uses.
  const grokRenderOn = isGrok(cfg.base)
  const geminiRenderOn = !!(cfg.geminiKey && cfg.geminiKey.trim())
  const canRender = grokRenderOn || geminiRenderOn
  const imgProvider = grokRenderOn && geminiRenderOn ? renderProvider : (grokRenderOn ? 'grok' : 'gemini')

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
  // Bumped to push a history-gallery image into a first/mid/last ImagePanel.
  const [seeds, setSeeds]             = useState({ first: null, mid: null, last: null })
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
  const [historyOpen, setHistoryOpen] = useState(false)
  const [restoringId, setRestoringId] = useState(null)   // entry whose inline fetch is in flight
  const [projects, setProjects]       = useState([])
  const [historyDown, setHistoryDown] = useState(false)   // sidecar unreachable → banner
  const [activeProject, setActiveProject] = useState('')       // '' = save new generations unfiled
  const [historyFilter, setHistoryFilter] = useState('all')    // 'all' | 'unfiled' | <project name>
  const [histTargetFilter, setHistTargetFilter] = useState('all')  // 'all' | <target id> ('scriptwriter' for those)
  const [histModelFilter, setHistModelFilter]   = useState('all')  // 'all' | <exact model string>
  const [histImageFilter, setHistImageFilter]   = useState('all')  // 'all' | 'with' | 'without'
  const [histSearch, setHistSearch]             = useState('')     // free-text query (AND over whitespace-split terms)
  const [adminMode, setAdminMode]     = useState(false)
  const [adminSystem, setAdminSystem] = useState(() => systemPromptFor(TARGETS['minimax_h3'], 'single'))
  const [adminSystemOpen, setAdminSystemOpen] = useState(false)
  const [adminUserMsg, setAdminUserMsg] = useState('')
  const [pendingSend, setPendingSend] = useState(false)
  const pendingSnapshotRef = useRef(null)
  // Queue: pending "generate this later" items, persisted server-side (see db.js).
  const [queue, setQueue]             = useState([])
  const [queueOpen, setQueueOpen]     = useState(false)
  const [queueBusy, setQueueBusy]     = useState(false)       // "Process all" in flight
  const [queueRunningId, setQueueRunningId] = useState(null)  // item id currently mid-run
  const queueAbortRef = useRef(false)  // set true to stop "Process all" between items
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
      // Best-effort — a failed queue load just leaves the panel empty/stale,
      // it must not trip the "history server unreachable" banner on its own.
      listQueue().then(q => { if (alive) setQueue(q) }).catch(() => {})
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

  const histTargets = useMemo(() => {
    const s = new Set(history.map(entryTargetId).filter(Boolean))
    return [...s].sort((a, b) => entryTargetLabel(a).localeCompare(entryTargetLabel(b)))
  }, [history])
  const histModels = useMemo(() => {
    const s = new Set(history.map(h => h.model).filter(Boolean))
    return [...s].sort((a, b) => modelFilterLabel(a).localeCompare(modelFilterLabel(b)))
  }, [history])

  const histFiltersActive = historyFilter !== 'all' || histTargetFilter !== 'all'
    || histModelFilter !== 'all' || histImageFilter !== 'all' || histSearch.trim() !== ''
  const resetHistFilters = () => {
    setHistoryFilter('all'); setHistTargetFilter('all'); setHistModelFilter('all'); setHistImageFilter('all'); setHistSearch('')
  }

  // Per-entry flattened search text, rebuilt only when the history changes.
  const histSearchIndex = useMemo(() => {
    const m = new Map()
    for (const h of history) m.set(h, entrySearchText(h))
    return m
  }, [history])
  const histSearchTerms = histSearch.trim().toLowerCase().split(/\s+/).filter(Boolean)

  const visibleHistory = useMemo(() => history.filter(h => {
    if (historyFilter === 'unfiled' && h.project) return false
    if (historyFilter !== 'all' && historyFilter !== 'unfiled' && h.project !== historyFilter) return false
    if (histTargetFilter !== 'all' && entryTargetId(h) !== histTargetFilter) return false
    if (histModelFilter !== 'all' && h.model !== histModelFilter) return false
    if (histImageFilter === 'with' && !entryHasImages(h)) return false
    if (histImageFilter === 'without' && entryHasImages(h)) return false
    if (histSearchTerms.length) {
      const hay = histSearchIndex.get(h) || ''
      if (!histSearchTerms.every(t => hay.includes(t))) return false
    }
    return true
  }), [history, historyFilter, histTargetFilter, histModelFilter, histImageFilter, histSearch, histSearchIndex])

  const entryProjectSelect = (h) => (
    <select
      value={h.project || ''}
      onChange={e => assignEntryProject(h.id, e.target.value)}
      title="Assign this generation to a project"
      style={{ fontSize: 13.5, color: h.project ? 'var(--pe-accent-ink)' : 'var(--pe-ink-3)', background: 'var(--pe-surface)', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '2px 6px', cursor: 'pointer', maxWidth: 150 }}>
      <option value="">Unfiled</option>
      {allProjects.map(p => <option key={p} value={p}>{p}</option>)}
      <option value="__new__">+ New project…</option>
    </select>
  )

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
  useEffect(() => {
    if (adaptSourceOverride) document.getElementById('adapt-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [adaptSourceOverride])

  resultsRef.current = results
  const abortAllVideos = () => { videoAbortRef.current.forEach(c => c.abort()); videoAbortRef.current.clear() }
  useEffect(() => () => abortAllVideos(), [])
  // Keep the video-render duration in step with the target's chosen duration ("8 seconds" etc.).
  useEffect(() => {
    const m = String(duration).match(/(\d+)\s*second/)
    if (m) setVideoDuration(Math.min(15, Math.max(1, parseInt(m[1], 10))))
  }, [duration])

  const refreshHistory = useCallback(() => listHistory().then(h => { setHistory(h); setHistoryDown(false) }).catch(() => setHistoryDown(true)), [])
  const refreshQueue = useCallback(() => listQueue().then(setQueue).catch(() => {}), [])

  // Kept in a ref so saveScriptHistory (a stable useCallback passed to the
  // scriptwriter panel) always reads the current selection without churning.
  const saveCtxRef = useRef({ activeProject: '', history: [] })
  saveCtxRef.current = { activeProject, history }

  const saveHistory = (snap, outputs, trackForRender = true) => {
    const entry = { ...snap, outputs, type: 'standard', id: generateId(), project: activeProject || null }
    // Only the live workspace results should become the 🎨 Render patch target — an
    // Adapt-panel save produces a separate entry the main results don't correspond to.
    if (trackForRender) lastSavedEntryIdRef.current = entry.id
    addHistoryEntry(entry).then(refreshHistory).catch(() => {})
    return entry.id
  }
  const saveScriptHistory = useCallback((entry) => {
    const { activeProject: ap, history: hist } = saveCtxRef.current
    // The scriptwriter re-saves the same id across its three phases — keep a
    // project the user reassigned in the meantime rather than resetting it.
    const existing = hist.find(h => h.id === entry.id)
    const project = existing ? (existing.project ?? null) : (ap || null)
    addHistoryEntry({ ...entry, project }).then(refreshHistory).catch(() => {})
  }, [refreshHistory])

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
    refreshHistory()
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
    setHistoryFilter(f => (f === oldName ? n : f))
    refreshHistory()
  }
  const deleteProject = async (name) => {
    const n = history.filter(x => x.project === name).length
    if (!window.confirm(`Remove project "${name}"?${n ? ` Its ${n} generation${n > 1 ? 's' : ''} become Unfiled.` : ''}`)) return
    for (const h of history.filter(x => x.project === name)) {
      await setHistoryEntryProject(h.id, null).catch(() => {})
    }
    setProjects(prev => prev.filter(p => p !== name))
    setActiveProject(p => (p === name ? '' : p))
    setHistoryFilter(f => (f === name ? 'all' : f))
    refreshHistory()
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
  const bumpSeed = (slot, data) =>
    setSeeds(s => ({ ...s, [slot]: { data, nonce: (s[slot]?.nonce || 0) + 1 } }))
  const pickHistoryImage = (data) => {
    if (target === 'minimax_h3' && frameMode === 'ref') {
      if (refImages.length >= 6) return
      setRefImages(prev => [...prev, {
        id: generateId(), base64: data.base64, mediaType: data.mediaType || 'image/jpeg',
        previewUrl: `data:${data.mediaType || 'image/jpeg'};base64,${data.base64}`,
        fileName: data.fileName || 'from-history.jpg',
        role: MINIMAX_H3_REF_ROLES[0].id, preserve: 'strong', note: '',
        hash: data.hash || imageHash(data.base64),
      }])
      return
    }
    if (t.type === 'image' || frameMode === 'single' || frameMode === 'last') { bumpSeed('first', data); return }
    if (frameMode === 'firstlast') { bumpSeed(!firstImg ? 'first' : 'last', data); return }
    if (frameMode === 'firstmidlast') { bumpSeed(!firstImg ? 'first' : !midImg ? 'mid' : 'last', data) }
  }
  const galleryPickHint =
    target === 'minimax_h3' && frameMode === 'ref' ? 'to add it as a reference'
    : frameMode === 'firstlast' || frameMode === 'firstmidlast' ? 'to fill the next empty frame'
    : 'to load it as the reference image'

  const currentImages = () => {
    const mt = (im) => im.mediaType || 'image/jpeg'
    if (frameMode === 'ref') {
      return refImages.map((im, i) => ({ name: `reference-${i + 1}-${im.role}.jpg`, base64: im.base64, mediaType: mt(im), role: 'ref' }))
    }
    if (frameMode === 'firstlast') {
      return [
        firstImg && { name: 'first-frame.jpg', base64: firstImg.base64, mediaType: mt(firstImg), role: 'first' },
        lastImg && { name: 'last-frame.jpg', base64: lastImg.base64, mediaType: mt(lastImg), role: 'last' },
      ].filter(Boolean)
    }
    if (frameMode === 'firstmidlast') {
      return [
        firstImg && { name: 'first-frame.jpg', base64: firstImg.base64, mediaType: mt(firstImg), role: 'first' },
        midImg && { name: 'mid-frame.jpg', base64: midImg.base64, mediaType: mt(midImg), role: 'mid' },
        lastImg && { name: 'last-frame.jpg', base64: lastImg.base64, mediaType: mt(lastImg), role: 'last' },
      ].filter(Boolean)
    }
    if (frameMode === 'last') {
      return firstImg ? [{ name: 'last-frame.jpg', base64: firstImg.base64, mediaType: mt(firstImg), role: 'last' }] : []
    }
    return firstImg ? [{ name: t.type === 'image' ? 'reference-image.jpg' : 'first-frame.jpg', base64: firstImg.base64, mediaType: mt(firstImg), role: 'first' }] : []
  }

  // A short filename-safe slug from the scene text, standing in for a title
  // this pipeline has no dedicated field for (unlike the Scriptwriter's
  // script.title). Empty when there's no scene text to draw one from (e.g.
  // MiniMax H3 ref mode, or a pure vision-only run) — the filename then just
  // omits the title component rather than carrying a placeholder.
  const titleSlug = (text, maxWords = 8) => String(text || '').trim().toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, '').split(/\s+/).filter(Boolean).slice(0, maxWords).join('-').slice(0, 60)
  // `target` ids are already short and mostly clean; only minimax_h3's suffix
  // reads as an internal detail rather than the model name people know it by.
  const modelSlug = (id) => id === 'minimax_h3' ? 'minimax' : id.replace(/_/g, '-')

  const exportBundle = async () => {
    const zip = new JSZip()
    for (const img of currentImages()) zip.file(img.name, img.base64, { base64: true })
    results.forEach((r, i) => {
      if (r.text) zip.file(results.length === 1 ? 'prompt.txt' : `prompt-${i + 1}.txt`, r.text)
      ;(r.images || []).forEach((img, k) => {
        if (img.b64) zip.file(`render-${i + 1}-${k + 1}.${imgExt(img.mediaType)}`, img.b64, { base64: true })
      })
      if (r.video?.b64) zip.file(results.length === 1 ? 'render.mp4' : `render-${i + 1}.mp4`, r.video.b64, { base64: true })
    })
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const title = titleSlug(scene)
    a.download = `${title ? title + '-' : ''}${t.type}-${modelSlug(target)}-${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }

  // A previous copy's status shouldn't linger against a different set of loaded images.
  useEffect(() => { setComfyCopyStatus({ state: 'idle' }) }, [firstImg, midImg, lastImg, refImages])
  // Same for a send — the shot it reported on is no longer the one on screen.
  useEffect(() => { setComfySendStatus({ state: 'idle', idx: null }) }, [firstImg, midImg, lastImg, refImages, results])

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
    if (id) await updateHistoryEntry(id, { outputs: outs }).then(refreshHistory).catch(() => {})
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
          Array.from({ length: Math.max(1, imageCount) }, () => generateImagesGemini(prompt, {
            key: cfg.geminiKey, model: cfg.geminiImageModel, aspectRatio: imageAspect, images: refs.slice(0, 3),
          }))
        )
        const ok = settled.filter(s => s.status === 'fulfilled').flatMap(s => s.value)
        if (!ok.length) throw new Error(settled.find(s => s.status === 'rejected')?.reason?.message || 'Gemini render failed.')
        images = ok.map(im => ({ b64: im.b64, mediaType: im.mediaType || 'image/png', revisedPrompt: im.revisedPrompt }))
      } else {
        const imgs = await generateImages(prompt, cfg, {
          n: imageCount, aspectRatio: imageAspect, resolution: imageResolution,
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
        duration: videoDuration, resolution: videoResolution, aspectRatio: videoAspect,
        audio: videoAudio, image: imageDataUri, signal: ctrl.signal,
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
    setUpStatus(s => ({ ...s, [key]: 'loading' }))
    try {
      const out = await generateImages(r.text, cfg, {
        images: [{ base64: img.b64, mediaType: img.mediaType }],
        resolution: '2k', aspectRatio: imageAspect,
      })
      if (!out[0]?.b64) throw new Error('No image returned')
      const newImg = { b64: out[0].b64, mediaType: out[0].mediaType || img.mediaType, revisedPrompt: out[0].revisedPrompt || img.revisedPrompt, upscaled: true }
      const nextImages = r.images.map((im, ki) => ki === k ? newImg : im)
      setResults(prev => prev.map((rr, ri) => ri === i ? { ...rr, images: nextImages } : rr))
      setUpStatus(s => { const n = { ...s }; delete n[key]; return n })
      await persistOutputs(i, { images: nextImages })
    } catch (e) {
      setUpStatus(s => ({ ...s, [key]: { error: e.message } }))
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
    setTarget(h.target); setOutputCount(h.outputCount)
    if (h.model) { setWriterModel(h.model); setWriterManual(h.model) }
    if (h.vision) { setVisionModel(h.vision); setVisionManual(h.vision) }
    setDuration(h.duration); setStyle(h.style); setCreativity(h.creativity); setFrameMode(h.frameMode)
    setScene(h.scene || ''); setDialogue(h.dialogue || ''); setDelivery(h.delivery || '')
    setNegative(h.negative || '')
    // Older entries only ever stored a filename string (no image bytes) — those
    // fall through to null/[] here, exactly like the pre-restore-support behavior.
    const imgFromHistory = (v) => (v && typeof v === 'object' && v.base64)
      ? { base64: v.base64, mediaType: v.mediaType || 'image/jpeg', previewUrl: `data:${v.mediaType || 'image/jpeg'};base64,${v.base64}`, fileName: v.fileName, hash: v.hash || imageHash(v.base64) }
      : null
    setFirstImg(imgFromHistory(h.firstImg))
    setMidImg(imgFromHistory(h.midImg))
    setLastImg(imgFromHistory(h.lastImg))
    setRefImages(Array.isArray(h.refImages)
      ? h.refImages.filter(im => im && typeof im === 'object' && im.base64).map(im => ({
          id: generateId(), base64: im.base64, mediaType: im.mediaType || 'image/jpeg',
          previewUrl: `data:${im.mediaType || 'image/jpeg'};base64,${im.base64}`, fileName: im.fileName,
          role: im.role || MINIMAX_H3_REF_ROLES[0].id, preserve: im.preserve || 'strong', note: im.note || '',
          hash: im.hash || imageHash(im.base64),
        }))
      : [])
    setRefAudio(h.refAudio && typeof h.refAudio === 'object' && h.refAudio.base64
      ? { base64: h.refAudio.base64, mediaType: h.refAudio.mediaType || 'audio/mpeg', fileName: h.refAudio.fileName }
      : null)
    // `saved` = the text as restored, so a later hand-edit is detectable (resultsEdited).
    setResults(Array.isArray(h.outputs)
      ? h.outputs.filter(o => o && typeof o === 'object').map(o => ({ label: o.label || h.model || 'output', text: o.text || '', saved: o.text || '', usage: null, loading: false, error: '', images: Array.isArray(o.images) ? o.images : [], imgLoading: false, imgError: '', video: (o.video && typeof o.video === 'object' && (o.video.url || o.video.b64)) ? o.video : null, vidLoading: false, vidError: '', vidProgress: 0 }))
      : [])
    // A 🎨 Render right after a restore should patch this same entry.
    lastSavedEntryIdRef.current = h.id || null
    setCaption(h.caption || ''); setSavedCaption(h.caption || ''); setVisionStats(null); setAdaptSourceOverride(null)
    setSoundscape(h.soundscape || ''); setMusic(h.music || '')
    const ratioPreset = TARGETS[h.target]?.resolutions?.find(r => r.label === h.ratio)
    setH3RatioId(ratioPreset?.id || '')
    setHistoryOpen(false)
  }

  // Loads a queue item's snapshot into the live workspace — the "inputs" half
  // of restore() (target/scene/images/style/…), without restore()'s output,
  // caption, project or history-panel side effects, since a queued item hasn't
  // been run yet and hasn't chosen a project. Uses plain setters, never
  // switchTarget()/switchMode() (those clear image state as a side effect,
  // which would erase the very images just being loaded here).
  const applyQueueItemToWorkspace = (snap) => {
    setTarget(snap.target); setOutputCount(snap.outputCount)
    if (snap.model) { setWriterModel(snap.model); setWriterManual(snap.model) }
    if (snap.vision) { setVisionModel(snap.vision); setVisionManual(snap.vision) }
    setDuration(snap.duration); setStyle(snap.style); setCreativity(snap.creativity); setFrameMode(snap.frameMode)
    setScene(snap.scene || ''); setDialogue(snap.dialogue || ''); setDelivery(snap.delivery || '')
    setNegative(snap.negative || '')
    const imgFrom = (v) => (v && typeof v === 'object' && v.base64)
      ? { base64: v.base64, mediaType: v.mediaType || 'image/jpeg', previewUrl: `data:${v.mediaType || 'image/jpeg'};base64,${v.base64}`, fileName: v.fileName, hash: v.hash || imageHash(v.base64) }
      : null
    setFirstImg(imgFrom(snap.firstImg))
    setMidImg(imgFrom(snap.midImg))
    setLastImg(imgFrom(snap.lastImg))
    setRefImages(Array.isArray(snap.refImages)
      ? snap.refImages.filter(im => im && typeof im === 'object' && im.base64).map(im => ({
          id: generateId(), base64: im.base64, mediaType: im.mediaType || 'image/jpeg',
          previewUrl: `data:${im.mediaType || 'image/jpeg'};base64,${im.base64}`, fileName: im.fileName,
          role: im.role || MINIMAX_H3_REF_ROLES[0].id, preserve: im.preserve || 'strong', note: im.note || '',
          hash: im.hash || imageHash(im.base64),
        }))
      : [])
    setRefAudio(snap.refAudio && typeof snap.refAudio === 'object' && snap.refAudio.base64
      ? { base64: snap.refAudio.base64, mediaType: snap.refAudio.mediaType || 'audio/mpeg', fileName: snap.refAudio.fileName }
      : null)
    const ratioPreset = TARGETS[snap.target]?.resolutions?.find(r => r.label === snap.ratio)
    setH3RatioId(ratioPreset?.id || '')
    setSoundscape(snap.soundscape || ''); setMusic(snap.music || '')
  }

  // Captures the current compose panel exactly like a fresh generation would,
  // but as a pending queue item instead of running it now. Same validity gates
  // as enhance()'s early returns, reusing the same buildSnapshot() shape (no
  // caption yet — frameDescription is null, vision hasn't run).
  const addToQueue = () => {
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
    const snapshot = buildSnapshot(null, hasImg, outputCount)
    const item = { id: generateId(), createdAt: Date.now(), status: 'queued', error: null, attempts: 0, snapshot }
    addQueueItem(item).then(refreshQueue).catch(() => {})
  }

  // Runs one queue item: loads its snapshot into the workspace, runs the real
  // enhance() pipeline (bypassing admin-mode's pause), and on success removes
  // it from the queue — its result now lives in History like any other
  // generation. On failure it stays queued with an error, retryable via ▶ Run.
  const runQueueItem = async (id) => {
    setQueueRunningId(id)
    await updateQueueItem(id, { status: 'running' }).catch(() => {})
    refreshQueue()
    let outcome
    try {
      const full = await getQueueItem(id, { inline: true })
      if (!full) throw new Error('queue item not found')
      flushSync(() => applyQueueItemToWorkspace(full.snapshot))
      outcome = await enhanceRef.current({ queue: true })
    } catch (e) {
      outcome = { ok: false, error: e.message }
    }
    if (outcome?.ok) {
      await deleteQueueItem(id).catch(() => {})
    } else {
      const prevAttempts = queue.find(q => q.id === id)?.attempts || 0
      await updateQueueItem(id, { status: 'error', error: outcome?.error || 'unknown error', attempts: prevAttempts + 1 }).catch(() => {})
    }
    setQueueRunningId(null)
    refreshQueue()
  }

  // Queues a Full Auto Scriptwriter job — { refImages, genre, hint } — from the
  // Full Auto tab of ScriptwriterPanel. Reuses the same queue item shape as
  // addToQueue, just tagged with `kind` so runAnyQueueItem/QueueCard can tell
  // it apart from a main-pipeline item (whose snapshot has no `kind`).
  const addScriptwriterAutoJob = (spec) => {
    const item = { id: generateId(), createdAt: Date.now(), status: 'queued', error: null, attempts: 0, kind: 'scriptwriter-auto', snapshot: spec }
    addQueueItem(item).then(refreshQueue).catch(() => {})
  }

  // Runs one Full Auto Scriptwriter queue item. Unlike runQueueItem (which
  // replays a snapshot into the already-mounted main workspace), this forces a
  // fresh ScriptwriterPanel mount — via a bumped scriptwriterKey — carrying the
  // job as its `autoJob` prop; the panel seeds its own state and chains
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
  const runScriptwriterQueueItem = async (id) => {
    setQueueRunningId(id)
    await updateQueueItem(id, { status: 'running' }).catch(() => {})
    refreshQueue()
    let outcome
    try {
      const full = await getQueueItem(id, { inline: true })
      if (!full) throw new Error('queue item not found')
      outcome = await new Promise((resolve) => {
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
    } catch (e) {
      outcome = { ok: false, error: e.message }
    }
    scriptwriterAutoResolveRef.current = null
    setScriptwriterAutoJob(null)
    if (outcome?.ok) {
      await deleteQueueItem(id).catch(() => {})
    } else {
      const prevAttempts = queue.find(q => q.id === id)?.attempts || 0
      await updateQueueItem(id, { status: 'error', error: outcome?.error || 'unknown error', attempts: prevAttempts + 1 }).catch(() => {})
    }
    setQueueRunningId(null)
    refreshQueue()
  }

  // Dispatches a queue item to the right runner by kind — there is one shared
  // queue, but a Full Auto Scriptwriter job needs the ScriptwriterPanel-mount
  // path above instead of the main-workspace restore-then-enhance path.
  const runAnyQueueItem = (id) => {
    const item = queue.find(q => q.id === id)
    return item?.kind === 'scriptwriter-auto' ? runScriptwriterQueueItem(id) : runQueueItem(id)
  }

  // Re-reads the queue from the server on every iteration (rather than
  // iterating a captured array) so an item removed mid-run is simply skipped
  // on the next pass, instead of still being processed.
  const processAllQueue = async () => {
    if (queueBusy) return
    setQueueBusy(true)
    queueAbortRef.current = false
    while (!queueAbortRef.current) {
      const fresh = await listQueue().catch(() => [])
      const next = fresh.find(q => q.status !== 'running')
      if (!next) break
      await runAnyQueueItem(next.id)
    }
    setQueueBusy(false)
  }
  const stopProcessingQueue = () => { queueAbortRef.current = true }

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
        setResults([{ label: lbl, text, saved: text, usage, loading: false, error: '' }])
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
            setResults(prev => prev.map((r, idx) => idx === i ? { ...r, text, saved: text, usage, loading: false } : r))
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
    abortAllVideos()
    setFrameMode(m); setFirstImg(null); setMidImg(null); setLastImg(null); setRefImages([]); setRefAudio(null)
    setSeeds({ first: null, mid: null, last: null })
    if (target === 'minimax_h3' && m === 'ref') setH3RatioId(prev => prev || 'port916')
  }
  const switchTarget = (id) => {
    abortAllVideos()
    const opts = TARGETS[id].durations || DURATION_OPTIONS
    setDuration(d => opts.some(o => o.value === d) ? d : opts[0].value)
    setTarget(id); setFirstImg(null); setMidImg(null); setLastImg(null); setRefImages([]); setRefAudio(null)
    setSeeds({ first: null, mid: null, last: null })
    setSoundscape(''); setMusic('')
    const nextMode = TARGETS[id].defaultFrameMode || 'single'
    setH3RatioId(id === 'minimax_h3' && nextMode === 'ref' ? 'port916' : '')
    setFrameMode(nextMode); setResults([]); setCaption(''); setSavedCaption(''); setVisionStats(null); setAdaptSourceOverride(null)
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

  // src overrides the live workspace state — passed by captionForEntry(h) to
  // re-describe a stored history entry's images without touching the workspace.
  const captionImages = async (src = null) => {
    const s = src || {
      frameMode, refImages, firstImg, midImg, lastImg, refAudio, scene,
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
      ], VISION_PROMPT_MINIMAX_H3_REF, stats, model))
      const imageBlock = refs.map((im, i) => {
        let line = `Image ${i + 1} — role: ${roleLabel(im.role)}, preservation: ${preserveLabel(im.preserve)} (${preserveMarker(im.preserve)}): ${captions[i]}`
        if (im.note && im.note.trim()) line += `\n   Requested use of this reference: ${im.note.trim()}`
        return line
      }).join('\n\n')
      const text = s.refAudio
        ? `${imageBlock}\n\nAudio 1 — voice-timbre reference (marker: reference): file "${s.refAudio.fileName}". Reference ONLY the timbre, pitch and delivery for the speaking subject; never transcribe or guess at its original wording. If no spoken dialogue is supplied elsewhere in this message, write one short line for that subject yourself so the voice reference has speech to act on.`
        : imageBlock
      return { text, stats }
    }
    let system, content
    const sceneT = (s.scene || '').trim()
    if (s.targetType === 'image') {
      system = s.visionPromptSingle
      content = [
        { type: 'image', source: { type: 'base64', media_type: s.firstImg.mediaType, data: s.firstImg.base64 } },
        { type: 'text', text: sceneT ? `The user's intended subject/scene: ${sceneT}\nDescribe the reference image in precise, prompt-ready language.` : 'Describe this reference image in precise, prompt-ready language.' },
      ]
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
    firstImg: h.firstImg, midImg: h.midImg, lastImg: h.lastImg, refAudio: h.refAudio,
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

  const startAdapt = async (h) => {
    setHistoryOpen(false)
    const base = {
      scene: h.scene || '', frameMode: h.frameMode, sourceTarget: h.target,
      originalPrompt: h.outputs?.[0]?.text || '', ts: h.ts,
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
    if (!canGen) return { ok: false, error: 'nothing to generate' }
    if (!effectiveWriter) { setGlobalError('Pick a Writer model (open ⚙ Local backend → Reload models, or type one).'); return { ok: false, error: 'no writer model' } }
    if (hasImg && !effectiveVision) { setGlobalError('Image inputs need a Vision model — pick one or type one (e.g. qwen2.5vl:7b).'); return { ok: false, error: 'no vision model' } }
    abortAllVideos()
    setGlobalError(''); setCopied(null); setCaption(''); setSavedCaption(''); setVisionStats(null); setAdaptSourceOverride(null); setPendingSend(false)

    const stylePart = buildStylePart({
      style, creativity, targetType: t.type, showDialogue: show.dialogue, dialogue, delivery, negative,
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

  // The history snapshot for the current workspace state. `frameDescription` is
  // the assembled vision caption (null for text-only); `count` is how many
  // outputs the entry carries. Used by runWriter() after a fresh generation and
  // by saveResultsEdit() to persist hand-edited result text as a new entry.
  const buildSnapshot = (frameDescription, hasImg, count) => {
    const isH3 = target === 'minimax_h3'
    return {
      ts: Date.now(), target, outputCount: count, model: effectiveWriter, vision: hasImg ? effectiveVision : null,
      duration, style, creativity, frameMode, negative,
      scene, dialogue: show.dialogue ? dialogue : '', delivery: show.dialogue ? delivery : '',
      firstImg: firstImg ? { base64: firstImg.base64, mediaType: firstImg.mediaType, fileName: firstImg.fileName, hash: firstImg.hash || imageHash(firstImg.base64) } : null,
      midImg: midImg ? { base64: midImg.base64, mediaType: midImg.mediaType, fileName: midImg.fileName, hash: midImg.hash || imageHash(midImg.base64) } : null,
      lastImg: lastImg ? { base64: lastImg.base64, mediaType: lastImg.mediaType, fileName: lastImg.fileName, hash: lastImg.hash || imageHash(lastImg.base64) } : null,
      ratio: isH3 ? (presetById(h3RatioId, t.resolutions) || t.resolutions[0]).label : null,
      soundscape: isH3 ? soundscape : '', music: isH3 ? music : '',
      refImages: isH3 && frameMode === 'ref'
        ? refImages.map(im => ({ base64: im.base64, mediaType: im.mediaType, fileName: im.fileName, role: im.role, preserve: im.preserve, note: im.note || '', hash: im.hash || imageHash(im.base64) }))
        : null,
      refAudio: isH3 && frameMode === 'ref' && refAudio
        ? { base64: refAudio.base64, mediaType: refAudio.mediaType, fileName: refAudio.fileName }
        : null,
      caption: frameDescription || null,
    }
  }

  const runWriter = async (frameDescription, stylePart, lengthPart, hasImg, opts = null) => {
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

    const snapshot = buildSnapshot(frameDescription, hasImg, outputCount)

    if (adminMode && !opts?.queue) {
      setAdminUserMsg(userText)
      pendingSnapshotRef.current = snapshot
      setPendingSend(true)
      return { ok: false, error: 'paused for admin review' }
    }

    const activeSystem = systemPromptFor(t, frameMode)

    if (outputCount === 1) {
      const lbl = effectiveWriter
      setResults([{ label: lbl, text: '', usage: null, loading: true, error: '' }])
      try {
        const { text, usage } = await callOllama(effectiveWriter, userText, activeSystem, cfg, cfg.temperature)
        setResults([{ label: lbl, text, saved: text, usage, loading: false, error: '' }])
        saveHistory(snapshot, [{ label: lbl, text }])
        return { ok: true }
      } catch (e) {
        setResults([{ label: lbl, text: '', usage: null, loading: false, error: e.message }])
        return { ok: false, error: e.message }
      }
    } else {
      const variants = buildVariants(effectiveWriter)
      setResults(variants.map(v => ({ label: v.label, text: '', usage: null, loading: true, error: '' })))
      const proms = variants.map((v, i) =>
        callOllama(effectiveWriter, userText + v.nudge, activeSystem, cfg, v.temp)
          .then(({ text, usage }) => {
            setResults(prev => prev.map((r, idx) => idx === i ? { ...r, text, saved: text, usage, loading: false } : r))
            return { label: v.label, text }
          })
          .catch(e => {
            setResults(prev => prev.map((r, idx) => idx === i ? { ...r, loading: false, error: e.message } : r))
            return { label: v.label, text: `(error: ${e.message})` }
          })
      )
      const outs = await Promise.all(proms)
      saveHistory(snapshot, outs)
      return { ok: true }
    }
  }

  // Assigns enhanceRef every render (like resultsRef.current = results above),
  // so a queue run reads the freshest enhance() closure after flushSync commits
  // applyQueueItemToWorkspace's setters — see runQueueItem.
  enhanceRef.current = enhance

  const copy = (idx) => { navigator.clipboard.writeText(results[idx].text); setCopied(idx); setTimeout(() => setCopied(null), 2000) }
  const editResult = (idx, value) => setResults(prev => prev.map((r, i) => i === idx ? { ...r, text: value } : r))

  const writing = results.some(r => r.loading)
  const isLoading = visionBusy || writing

  // Whether the workspace currently holds any input image (mirrors enhance()'s
  // local `hasImg`) — used to stamp the Vision model onto a manually-saved snapshot.
  const hasImgNow = t.type === 'image' ? !!firstImg
    : frameMode === 'firstlast' ? !!(firstImg && lastImg)
    : frameMode === 'firstmidlast' ? !!(firstImg && midImg && lastImg)
    : frameMode === 'last' ? !!firstImg
    : frameMode === 'ref' ? refImages.length > 0
    : !!firstImg

  // The result text or the vision description has been hand-edited away from what
  // was generated/restored — offer to persist it as a new history entry.
  const resultsEdited = !writing && results.some(r => r.text && !r.error && r.text !== r.saved)
  const captionEdited = !writing && !!caption.trim() && caption !== savedCaption && results.some(r => r.text && !r.error)

  const saveResultsEdit = () => {
    const outs = results.filter(r => r.text && !r.error).map(r => ({ label: r.label, text: r.text, ...(r.images?.length ? { images: r.images } : {}), ...(r.video ? { video: r.video } : {}) }))
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
    })
    const lengthPart = PROMPT_LENGTH_INJECT[promptLength] || ''
    setSavedCaption(caption)
    await runWriter(caption, stylePart, lengthPart, hasImgNow)
  }
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

  const genBtnDisabled = isLoading || !canGenerate || pendingSend
  const genBtnStyle = {
    width: '100%', height: 54, padding: '0 24px', borderRadius: 10, border: 'none',
    background: genBtnDisabled ? 'var(--pe-line-soft)' : 'var(--pe-accent)',
    color: genBtnDisabled ? 'var(--pe-ink-3)' : '#fff',
    fontSize: 17, fontWeight: 600, cursor: genBtnDisabled ? 'not-allowed' : 'pointer',
    transition: 'all 0.15s', marginTop: 10,
  }

  const scriptwriterMode = target === 'scriptwriter'

  return (
    <div style={{ fontFamily: 'var(--pe-font)', minHeight: '100vh', color: 'var(--pe-ink)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '0 28px', height: 72, background: 'var(--pe-surface)', borderBottom: '1px solid var(--pe-line)', position: 'sticky', top: 0, zIndex: 20 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 27, fontWeight: 700, margin: 0, color: 'var(--pe-ink)', letterSpacing: '-0.02em' }}>Prompt Enhancer</h1>
          <p style={{ fontSize: 14, color: 'var(--pe-ink-3)', margin: 0 }}>{t.subtitle}{showImage ? ' · two-stage: vision → writer' : ' · single-stage writer'}</p>
        </div>
        <button
          onClick={() => { setAdminMode(v => !v); setPendingSend(false) }}
          style={{ flexShrink: 0, padding: '9px 15px', borderRadius: 8, border: '1px solid', borderColor: adminMode ? 'var(--pe-accent-line)' : 'var(--pe-line)', background: adminMode ? 'var(--pe-accent-bg)' : 'var(--pe-surface)', color: adminMode ? 'var(--pe-accent-ink)' : 'var(--pe-ink-2)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
        >
          {adminMode ? '⚙ Admin: ON' : '⚙ Admin'}
        </button>
      </div>

      {historyDown && (
        <div style={{ padding: '10px 28px', background: 'var(--pe-danger-bg)', borderBottom: '1px solid var(--pe-danger-line)', color: 'var(--pe-danger)', fontSize: 13.5, fontWeight: 600, position: 'sticky', top: 72, zIndex: 19 }}>
          History-Server nicht erreichbar — Generierungen werden NICHT gespeichert. Starte ihn mit <code style={{ fontFamily: 'var(--pe-mono)' }}>npm run server</code> (oder <code style={{ fontFamily: 'var(--pe-mono)' }}>npm run dev</code>, das startet beide).
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: scriptwriterMode ? 'minmax(0,1fr)' : '360px minmax(0, 900px) minmax(420px, 760px)', gap: 28, padding: 24, alignItems: 'start', justifyContent: 'center', maxWidth: scriptwriterMode ? 1080 : 2200, margin: '0 auto' }}>

      {/* ================= LEFT RAIL ================= */}
      <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 12, padding: 20 }}>

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
            ? <select style={selStyle} value={writerModel} onChange={e => setWriterModel(e.target.value)}>{models.map(m => <option key={m} value={m}>{m}</option>)}</select>
            : <input style={selStyle} value={writerManual} onChange={e => setWriterManual(e.target.value)} placeholder={isAnthropic(cfg.base) ? 'claude-sonnet-4-6' : isGrok(cfg.base) ? 'grok-4' : 'mistral-nemo'} spellCheck={false} />}
        </div>
        {showImage && (
          <div style={{ flex: '1 1 240px' }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Vision model <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>· reads image inputs</span>
            </label>
            {models.length > 0
              ? <select style={selStyle} value={visionModel} onChange={e => setVisionModel(e.target.value)}>{models.map(m => <option key={m} value={m}>{m}</option>)}</select>
              : <input style={selStyle} value={visionManual} onChange={e => setVisionManual(e.target.value)} placeholder={isAnthropic(cfg.base) ? 'claude-sonnet-4-6' : isGrok(cfg.base) ? 'grok-4' : 'qwen2.5vl:7b'} spellCheck={false} />}
          </div>
        )}
      </div>

      <div style={{ marginTop: 4 }}>
        <ConfigBar cfg={cfg} setCfg={setCfg} models={models} modelStatus={modelStatus} reloadModels={reloadModels}
          onClearCaptionCache={() => { clearCaptions().catch(() => {}); captionMemRef.current.clear(); setVisionStats(null) }} />
      </div>

      </div>{/* ================= END LEFT RAIL ================= */}

      {/* ================= CENTER · COMPOSE ================= */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>

      {target === 'scriptwriter' ? (
        <ScriptwriterPanel
          key={scriptwriterKey}
          cfg={cfg}
          writerModel={effectiveWriter}
          visionModel={effectiveVision}
          initialState={scriptwriterInitial}
          onSaveHistory={saveScriptHistory}
          history={history}
          comfyCfg={comfyCfg}
          setComfyCfg={setComfyCfg}
          autoJob={scriptwriterAutoJob}
          onAutoJobDone={(res) => scriptwriterAutoResolveRef.current?.(res)}
          onQueueAutoJob={addScriptwriterAutoJob}
          queueProps={{
            queue, busy: queueBusy, runningId: queueRunningId,
            onRun: runAnyQueueItem,
            onRemove: id => deleteQueueItem(id).then(refreshQueue),
            onProcessAll: processAllQueue, onStop: stopProcessingQueue,
            onClear: () => dbClearQueue().then(refreshQueue),
          }}
        />
      ) : (<>

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

      {/* Style */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t.type === 'image' ? 'Style' : 'Scene Style'}</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {STYLE_OPTIONS.map(o => (
            <button key={o.id} onClick={() => setStyle(o.id)} title={o.hint} style={btn(style === o.id)}>{o.label}</button>
          ))}
        </div>
      </div>

      {/* Creativity */}
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

      {/* Prompt length */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Prompt Length</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PROMPT_LENGTH_OPTIONS.map(o => (
            <button key={o.id} onClick={() => setPromptLength(o.id)} title={o.hint} style={btn(promptLength === o.id)}>{o.label}</button>
          ))}
        </div>
      </div>

      {/* Scene */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {sceneLabel}{' '}
          {sceneHint && <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>{sceneHint}</span>}
        </label>
        <textarea ref={sceneTextareaRef} value={scene} onChange={e => setScene(e.target.value)} placeholder={scenePlaceholder} rows={4}
          style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '12px 14px', color: 'var(--pe-ink)', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.6, transition: 'border-color 0.15s' }}
          onFocus={e => e.target.style.borderColor = 'var(--pe-accent)'} onBlur={e => e.target.style.borderColor = 'var(--pe-line)'} />
      </div>

      {/* Avoid */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Avoid <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>(optional — things to keep out of the result, e.g. "text, watermark", or a likely mistake to correct, e.g. "blue car", "horse in background")</span>
        </label>
        <textarea value={negative} onChange={e => setNegative(e.target.value)} placeholder="e.g. text, watermark, blue car, horse in background" rows={2}
          style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 14px', color: 'var(--pe-ink)', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
          onFocus={e => e.target.style.borderColor = 'var(--pe-accent)'} onBlur={e => e.target.style.borderColor = 'var(--pe-line)'} />
      </div>

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

      {/* Dialogue */}
      {show.dialogue && (
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Dialogue <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>(optional — spoken aloud; needs 8s+ for more than a few words)</span>
          </label>
          <textarea value={dialogue} onChange={e => setDialogue(e.target.value)} placeholder="Exact words to be spoken, e.g.  We need to leave. Now." rows={2}
            style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 14px', color: 'var(--pe-ink)', fontSize: 14, resize: 'vertical', outline: 'none', lineHeight: 1.5, transition: 'border-color 0.15s' }}
            onFocus={e => e.target.style.borderColor = 'var(--pe-accent)'} onBlur={e => e.target.style.borderColor = 'var(--pe-line)'} />
          {dialogue.trim() && (() => {
            const b = syllableBudget(duration, dialogue)
            const over = b.max != null && b.count > b.max
            return (
              <div style={{ fontSize: 13, color: over ? 'var(--pe-warn)' : 'var(--pe-ink-3)', marginTop: 6, lineHeight: 1.5 }}>
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
            style={{ width: '100%', boxSizing: 'border-box', marginTop: 8, background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '9px 14px', color: 'var(--pe-ink)', fontSize: 13, outline: 'none', transition: 'border-color 0.15s' }}
            onFocus={e => e.target.style.borderColor = 'var(--pe-accent)'} onBlur={e => e.target.style.borderColor = 'var(--pe-line)'} />
        </div>
      )}

      {/* Soundscape / music (MiniMax H3 only) */}
      {target === 'minimax_h3' && (
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-ink-2)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Ambient Sound <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}>(optional — overall_soundscape: ambience, physical sounds; leave blank to let the writer invent it)</span>
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

      {/* Frame mode */}
      {show.frameMode && (
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
      )}

      {/* Image panels */}
      {showImage && (
        <HistoryImageGallery history={history} onPick={pickHistoryImage} pickHint={galleryPickHint}
          onSaveCaption={(entryId, text) => updateHistoryEntry(entryId, { caption: text }).then(refreshHistory).catch(() => {})} />
      )}
      {showImage && (t.type === 'image' || frameMode === 'single' ? (
        <>
          {!firstImg && ratioPicker}
          <ImagePanel key={`${target}-single`} label="Reference Image" hint="(optional)" onChange={setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} presetNote={t.presetNote} seed={seeds.first} />
        </>
      ) : frameMode === 'last' ? (
        <ImagePanel key={`${target}-lastonly`} label="Last Frame" hint="(clip ends here)" onChange={setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={seeds.first} />
      ) : frameMode === 'ref' ? (
        <>
          {ratioPicker}
          <MinimaxRefPanel images={refImages} onChange={setRefImages} audio={refAudio} onAudioChange={setRefAudio} />
        </>
      ) : frameMode === 'firstmidlast' ? (
        <>
          <ImagePanel key={`${target}-first`} label="First Frame" hint="(clip starts here)" onChange={setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={seeds.first} />
          <ImagePanel key={`${target}-mid`} label="Mid Frame" hint="(clip passes through here)" onChange={setMidImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={seeds.mid} />
          <ImagePanel key={`${target}-last`} label="Last Frame" hint="(clip ends here)" onChange={setLastImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={seeds.last} />
        </>
      ) : (
        <>
          <ImagePanel key={`${target}-first`} label="First Frame" hint="(clip starts here)" onChange={setFirstImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={seeds.first} />
          <ImagePanel key={`${target}-last`} label="Last Frame" hint="(clip ends here)" onChange={setLastImg} presets={t.resolutions} showTwoStage={show.twoStage} seed={seeds.last} />
        </>
      ))}

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
      {adminMode && (
        <div style={{ marginBottom: 18, background: 'var(--pe-rail)', border: '1px solid var(--pe-accent-line)', borderRadius: 10, padding: '12px 16px' }}>
          <button
            onClick={() => setAdminSystemOpen(v => !v)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--pe-accent-ink)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: adminSystemOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
              System Prompt
            </span>
            <span style={{ fontSize: 13.5, color: 'var(--pe-ink-3)' }}>editable · sent on every generation</span>
          </button>
          {adminSystemOpen && (
            <div style={{ marginTop: 12 }}>
              <textarea value={adminSystem} onChange={e => setAdminSystem(e.target.value)} rows={12}
                style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 12px', color: 'var(--pe-ink-2)', fontSize: 13.5, fontFamily: 'monospace', resize: 'vertical', outline: 'none', lineHeight: 1.5 }} />
              <button onClick={() => setAdminSystem(systemPromptFor(t, frameMode))} style={{ marginTop: 6, fontSize: 13, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '3px 10px', cursor: 'pointer' }}>Reset to default</button>
            </div>
          )}
        </div>
      )}

      {/* Admin user message review */}
      {adminMode && pendingSend && (
        <div style={{ marginBottom: 18, background: 'var(--pe-rail)', border: '1px solid var(--pe-accent-line)', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--pe-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>User Message · review & edit before sending</div>
          <textarea value={adminUserMsg} onChange={e => setAdminUserMsg(e.target.value)} rows={10}
            style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '10px 12px', color: 'var(--pe-ink-2)', fontSize: 13.5, fontFamily: 'monospace', resize: 'vertical', outline: 'none', lineHeight: 1.5 }} />
          <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
            <button onClick={sendToWriter} disabled={writing}
              style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: writing ? 'var(--pe-line)' : 'var(--pe-accent)', color: writing ? 'var(--pe-ink-3)' : '#fff', fontSize: 14, fontWeight: 600, cursor: writing ? 'not-allowed' : 'pointer', transition: 'all 0.15s' }}>
              {writing ? '✦ Writing prompt…' : '→ Send to Writer'}
            </button>
            <button onClick={() => setPendingSend(false)} disabled={writing}
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
        <button onClick={addToQueue} disabled={!canGenerate || queueBusy}
          title="Save this generation for later instead of running it now"
          style={{ flexShrink: 0, padding: '9px 18px', borderRadius: 8, border: '1px solid var(--pe-accent-line)', background: 'none', color: (!canGenerate || queueBusy) ? 'var(--pe-ink-3)' : 'var(--pe-accent-ink)', fontSize: 14, fontWeight: 600, cursor: (!canGenerate || queueBusy) ? 'not-allowed' : 'pointer' }}>
          + Add to Queue
        </button>
      </div>

      {/* Global error */}
      {globalError && (
        <div style={{ marginTop: 16, padding: '12px 14px', background: 'var(--pe-danger-bg)', border: '1px solid var(--pe-danger-line)', borderRadius: 8, fontSize: 13, color: 'var(--pe-danger)' }}>{globalError}</div>
      )}

      </>)}
      </div>{/* ================= END CENTER · COMPOSE ================= */}

      {/* ================= RIGHT · OUTPUT ================= */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>

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
            {visionStats && (visionStats.fromCache + visionStats.fresh > 0) && (
              <span style={{ color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }}> · {visionStats.fromCache} cached, {visionStats.fresh} described</span>
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
                  <select value={renderProvider} onChange={e => setRenderProvider(e.target.value)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                    <option value="grok">Grok</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </label>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                aspect
                <select value={imageAspect} onChange={e => setImageAspect(e.target.value)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                  {GROK_IMAGE_RESOLUTIONS.map(r => <option key={r.id} value={r.ar}>{r.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                count
                <select value={imageCount} onChange={e => setImageCount(parseInt(e.target.value, 10) || 1)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              {imgProvider === 'grok' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  resolution
                  <select value={imageResolution} onChange={e => setImageResolution(e.target.value)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
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
                <select value={videoDuration} onChange={e => setVideoDuration(parseInt(e.target.value, 10) || 8)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                  {Array.from({ length: 15 }, (_, n) => n + 1).map(n => <option key={n} value={n}>{n}s</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                resolution
                <select value={videoResolution} onChange={e => setVideoResolution(e.target.value)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                  <option value="480p">480p</option>
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                aspect
                <select value={videoAspect} onChange={e => setVideoAspect(e.target.value)} style={{ ...selStyle, width: 'auto', padding: '3px 6px', fontSize: 13 }}>
                  {GROK_IMAGE_RESOLUTIONS.filter(r => r.id !== 'cine219').map(r => <option key={r.id} value={r.ar}>{r.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <input type="checkbox" checked={videoAudio} onChange={e => setVideoAudio(e.target.checked)} /> audio
              </label>
              <span style={{ color: 'var(--pe-ink-3)' }}>model: {cfg.videoModel || 'grok-imagine-video-1.5'} · set in ⚙ Backend</span>
              {currentImages().length > 0 && <span style={{ color: 'var(--pe-ok)' }}>· image-to-video: first frame used</span>}
              {videoResolution === '1080p' && currentImages().length > 0 && (
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
                Export ZIP (images + prompt{results.filter(r => r.text).length > 1 ? 's' : ''}) ↓
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
                      title={r.imgError ? r.imgError : `${edit ? 'Image-to-image edit' : 'Render'} with ${pModel} (${imageCount}× · ${imageAspect}${imgProvider === 'grok' ? ` · ${imageResolution}` : ''})${edit ? ` · ${currentImages().length} reference image(s)` : ''}.`}
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
                        title={r.vidError || `Submit + poll ${cfg.videoModel || 'grok-imagine-video-1.5'} (${videoDuration}s · ${videoResolution} · ${videoAspect} · audio ${videoAudio ? 'on' : 'off'})${fromImg ? ' · image-to-video' : ''}. Takes 1–5 min — keep the tab open.`}
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
                        const st = upStatus[`${i}-${k}`]
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
          models={models} defaultModel={effectiveWriter} cfg={cfg}
          style={style} creativity={creativity} negative={negative}
          dialogue={dialogue} delivery={delivery} promptLength={promptLength}
          soundscape={soundscape} music={music}
          duration={duration} h3RatioId={h3RatioId}
          onSaveAdapt={(snap, outs) => saveHistory(snap, outs, false)}
          onClose={() => setAdaptSourceOverride(null)}
        />
      )}

      {/* History */}
      <div style={{ marginTop: 28, borderTop: '1px solid var(--pe-line-soft)', paddingTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <button onClick={() => setHistoryOpen(v => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--pe-ink-3)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: historyOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            History {history.length > 0 ? `(${histFiltersActive ? `${visibleHistory.length}/${history.length}` : history.length})` : ''}
          </button>
          {historyOpen && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <input ref={importInputRef} type="file" accept=".json" style={{ display: 'none' }}
                onChange={e => { if (e.target.files[0]) importHistory(e.target.files[0]); e.target.value = '' }} />
              <button onClick={exportHistory} style={{ fontSize: 13, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>Export ↓</button>
              <button onClick={() => importInputRef.current?.click()} style={{ fontSize: 13, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>Import ↑</button>
              {history.length > 0 && <button onClick={clearHistory} style={{ fontSize: 13, color: 'var(--pe-danger)', background: 'none', border: '1px solid var(--pe-danger-line)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}>Clear</button>}
            </div>
          )}
        </div>
        {historyOpen && history.length > 1 && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            {(() => {
              const fsel = { fontSize: 13, color: 'var(--pe-accent-ink)', background: 'var(--pe-surface)', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', maxWidth: 200 }
              return <>
                <input
                  type="search" value={histSearch} onChange={e => setHistSearch(e.target.value)}
                  placeholder="Search history…" spellCheck={false}
                  style={{ ...fsel, cursor: 'text', minWidth: 160, maxWidth: 240, color: 'var(--pe-ink)' }}
                  title="Match scene, prompt text, vision caption, model or project (space = AND)"
                />
                {(allProjects.length > 0 || history.some(h => !h.project)) && (
                  <select value={historyFilter} onChange={e => setHistoryFilter(e.target.value)} style={fsel} title="Project">
                    <option value="all">All projects</option>
                    <option value="unfiled">Unfiled</option>
                    {allProjects.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                )}
                {histTargets.length > 1 && (
                  <select value={histTargetFilter} onChange={e => setHistTargetFilter(e.target.value)} style={fsel} title="Generated for">
                    <option value="all">All targets</option>
                    {histTargets.map(id => <option key={id} value={id}>{entryTargetLabel(id)}</option>)}
                  </select>
                )}
                {histModels.length > 1 && (
                  <select value={histModelFilter} onChange={e => setHistModelFilter(e.target.value)} style={fsel} title="Writer model">
                    <option value="all">All models</option>
                    {histModels.map(m => <option key={m} value={m}>{modelFilterLabel(m)}</option>)}
                  </select>
                )}
                {history.some(entryHasImages) && history.some(h => !entryHasImages(h)) && (
                  <select value={histImageFilter} onChange={e => setHistImageFilter(e.target.value)} style={fsel} title="Image inputs">
                    <option value="all">Any input</option>
                    <option value="with">With images</option>
                    <option value="without">Without images</option>
                  </select>
                )}
                {histFiltersActive && (
                  <button onClick={resetHistFilters} style={{ fontSize: 13, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>Reset</button>
                )}
              </>
            })()}
          </div>
        )}
        {historyOpen && history.length === 0 && (
          <div style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', padding: '8px 0' }}>No history yet.</div>
        )}
        {historyOpen && history.length > 0 && visibleHistory.length === 0 && (
          <div style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', padding: '8px 0' }}>
            No generations match these filters.
          </div>
        )}
        {historyOpen && visibleHistory.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {visibleHistory.map((h, i) => {
              if (h.type === 'scriptwriter') {
                // A Full Auto entry's `idea` is a fixed boilerplate instruction with the
                // user's hint appended after it — an 80-char cutoff of `idea` always shows
                // the boilerplate, never the hint, so prefer the separately-saved hint.
                const ideaShort = h.fullAuto
                  ? (h.fullAutoHint ? (h.fullAutoHint.length > 80 ? h.fullAutoHint.slice(0, 80) + '…' : h.fullAutoHint) : '(AI invented freely — no hint given)')
                  : (h.idea && h.idea.length > 80 ? h.idea.slice(0, 80) + '…' : (h.idea || ''))
                const phaseLabel = h.phase === 'done' ? 'Done' : h.phase === 'dircut' ? "Director's cut" : 'Script'
                return (
                  <div key={i} style={{ background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '12px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>{new Date(h.ts).toLocaleString()}</span>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {entryProjectSelect(h)}
                        <button onClick={() => restore(h)} disabled={!!restoringId} style={{ fontSize: 13, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '3px 10px', cursor: restoringId ? 'wait' : 'pointer', opacity: restoringId && restoringId !== h.id ? 0.5 : 1 }}>{restoringId === h.id ? 'Restoring…' : 'Restore'}</button>
                        <button onClick={() => removeHistoryEntry(h.id)} style={{ fontSize: 13, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>✕</button>
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--pe-accent-ink)', marginBottom: 4 }}>
                      Scriptwriter{h.fullAuto ? ' · 🎬 Full Auto' : ''} · {h.model} · {phaseLabel}
                      {h.script ? ` · ${h.script.scenes?.length ?? 0} scenes` : ''}
                      {h.script?.characters?.length ? ` · ${h.script.characters.length} cast` : ''}
                      {h.directorsCut ? ` · ${h.directorsCut.shots?.length ?? 0} ${h.promptTarget === 'minimax_h3' ? 'clips' : 'shots'}` : ''}
                      {h.finalPrompts ? ` · ${h.finalPrompts.filter(p => p.text).length} ${h.promptTarget === 'minimax_h3' ? 'H3' : 'LTX'} prompts` : ''}
                    </div>
                    {h.script?.title && <div style={{ fontSize: 13.5, color: 'var(--pe-accent-ink)', fontWeight: 600, marginBottom: 4 }}>{h.script.title}</div>}
                    {h.script?.characters?.length > 0 && (
                      <div style={{ fontSize: 12.5, color: 'var(--pe-ink-3)', marginBottom: 4 }}>
                        Cast: {h.script.characters.map(c => c.name).join(', ')}
                      </div>
                    )}
                    {ideaShort && <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 6, fontStyle: 'italic' }}>"{ideaShort}"</div>}
                    {h.refImages?.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
                        {h.refImages.map((im, ii) => im.url
                          ? <img key={ii} src={im.url} loading="lazy" decoding="async"
                              title={`${im.note ? im.note + ' — ' : ''}${im.caption || im.fileName}`}
                              style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--pe-line)' }} />
                          : <span key={ii} title={im.caption || ''}
                              style={{ fontSize: 12, color: 'var(--pe-ink-3)', border: '1px solid var(--pe-line)', borderRadius: 4, padding: '2px 6px' }}>
                              📄 {im.note || im.fileName}
                            </span>
                        )}
                      </div>
                    )}
                    {(() => {
                      const tiles = (h.framePrompts || []).flatMap((fp, si) =>
                        ['first', 'mid', 'last']
                          .filter(fk => fp?.frames?.[fk]?.image?.url)
                          .map(fk => ({ im: fp.frames[fk].image, si, fk })))
                      if (!tiles.length) return null
                      return (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
                          {tiles.map((t, ti) => (
                            <img key={ti} src={t.im.url} loading="lazy" decoding="async"
                              title={`Shot ${(h.directorsCut?.shots?.[t.si]?.shot_number) ?? t.si + 1} · ${t.fk} frame`}
                              style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--pe-line)' }} />
                          ))}
                        </div>
                      )
                    })()}
                    {h.finalPrompts && h.finalPrompts.filter(p => p.text).length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                        {h.finalPrompts.filter(p => p.text).map((p, pi) => (
                          <div key={pi} style={{ background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '8px 10px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                              <span style={{ fontSize: 13.5, color: 'var(--pe-accent)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Shot {p.shotNumber} · {p.sceneTitle}</span>
                              <button onClick={() => navigator.clipboard.writeText(p.text)} style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>Copy</button>
                            </div>
                            <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'var(--pe-mono)' }}>{p.text}</div>
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
                <div key={i} style={{ background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>{new Date(h.ts).toLocaleString()}</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {entryProjectSelect(h)}
                      {h.outputs?.length > 0 && (
                        <button
                          onClick={() => startAdapt(h)}
                          title="Rewrite this generation's prompt for another model"
                          style={{ fontSize: 13, color: 'var(--pe-accent-ink)', background: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }}
                        >⇄ Adapt</button>
                      )}
                      <button onClick={() => restore(h)} disabled={!!restoringId} style={{ fontSize: 13, color: 'var(--pe-accent-ink)', background: 'var(--pe-accent-bg)', border: '1px solid var(--pe-accent-line)', borderRadius: 6, padding: '3px 10px', cursor: restoringId ? 'wait' : 'pointer', opacity: restoringId && restoringId !== h.id ? 0.5 : 1 }}>{restoringId === h.id ? 'Restoring…' : 'Restore settings'}</button>
                      <button onClick={() => removeHistoryEntry(h.id)} style={{ fontSize: 13, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>✕</button>
                    </div>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--pe-accent-ink)', marginBottom: 6 }}>
                    {tg?.label} · {ml}{h.vision ? ` · 👁 ${h.vision}` : ''}{h.duration && tg?.type !== 'image' ? ` · ${h.duration}` : ''}{sl && sl !== 'Auto' ? ` · ${sl}` : ''}{cl && cl !== 'Balanced' ? ` · ${cl}` : ''}{h.frameMode === 'firstlast' ? ' · first→last' : h.frameMode === 'firstmidlast' ? ' · first→mid→last' : h.frameMode === 'last' ? ' · last frame' : h.frameMode === 'ref' ? ' · reference' : ''}{h.ratio ? ` · ${h.ratio}` : ''}{h.adaptedFrom ? ` · ⇄ from ${(TARGETS[h.adaptedFrom.target]?.label || h.adaptedFrom.target).split(' · ')[0]}` : ''}
                  </div>
                  {moves.length > 0 && <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', marginBottom: 6 }}>Camera: {moves.join(', ')}</div>}
                  <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 6 }}>{h.scene ? h.scene : <span style={{ color: 'var(--pe-ink-3)' }}>(proposed from image)</span>}</div>
                  {h.dialogue && <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 6 }}>Dialogue: "{h.dialogue}"{h.delivery ? ` (${h.delivery})` : ''}</div>}
                  {h.soundscape && <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 6 }}>Soundscape: {h.soundscape}</div>}
                  {h.music && <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 6 }}>Music: {h.music}</div>}
                  {h.negative && <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 6 }}>Avoid: {h.negative}</div>}
                  {(h.firstImg || h.midImg || h.lastImg) && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                      {[h.firstImg, h.midImg, h.lastImg].filter(Boolean).map((im, ii) =>
                        typeof im === 'object' && im.url
                          ? <img key={ii} src={im.url} loading="lazy" decoding="async" alt={im.fileName} title={im.fileName}
                              style={{ width: 40, height: 30, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--pe-line)' }} />
                          : <span key={ii} style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>{typeof im === 'string' ? im : im.fileName}</span>
                      )}
                    </div>
                  )}
                  {h.refImages && h.refImages.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                      {h.refImages.map((im, ii) =>
                        typeof im === 'object' && im.url
                          ? <img key={ii} src={im.url} loading="lazy" decoding="async" alt={im.fileName} title={`${im.fileName} (${im.role})`}
                              style={{ width: 40, height: 30, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--pe-line)' }} />
                          : <span key={ii} style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>{typeof im === 'string' ? im : im.fileName}</span>
                      )}
                    </div>
                  )}
                  {h.caption && (
                    <HistoryCaptionEditor
                      value={h.caption}
                      onSave={h.id ? (text => updateHistoryEntry(h.id, { caption: text }).then(refreshHistory).catch(() => {})) : null}
                    />
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
                    {(h.outputs || []).map((o, oi) => (
                      <div key={oi} style={{ background: 'var(--pe-surface)', border: '1px solid var(--pe-line)', borderRadius: 8, padding: '8px 10px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <span style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{o.label}</span>
                          <button onClick={() => navigator.clipboard.writeText(o.text)} style={{ fontSize: 13.5, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 5, padding: '2px 8px', cursor: 'pointer' }}>Copy</button>
                        </div>
                        <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'var(--pe-mono)' }}>{o.text}</div>
                        {Array.isArray(o.images) && o.images.length > 0 && (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                            {o.images.map((img, k) => img.url && (
                              <img key={k} src={img.url} loading="lazy" decoding="async" alt={`render ${k + 1}`} title="🎨 Grok render"
                                style={{ width: 54, height: 54, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--pe-line)' }} />
                            ))}
                          </div>
                        )}
                        {o.video && o.video.url && (
                          <div style={{ marginTop: 6 }}>
                            <a href={o.video.url}
                               target="_blank" rel="noreferrer" {...(o.video.blobRef ? { download: 'grok-video.mp4' } : {})}
                               style={{ fontSize: 13.5, color: 'var(--pe-accent-ink)', textDecoration: 'none', border: '1px solid var(--pe-accent-line)', borderRadius: 5, padding: '2px 8px' }}>
                              🎬 video{o.video.duration ? ` · ${o.video.duration}s` : ''}{o.video.blobRef ? '' : ' ↗ (link may be expired)'}
                            </a>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Queue — one shared queue for main-pipeline items and Full Auto
          Scriptwriter jobs alike (QueueCard renders both). Hidden while the
          Scriptwriter tab is open — it has its own filtered, embedded copy of
          this same panel in its Full Auto view instead. */}
      {!scriptwriterMode && (
        <QueuePanel
          queue={queue}
          open={queueOpen}
          onToggleOpen={() => setQueueOpen(v => !v)}
          busy={queueBusy}
          runningId={queueRunningId}
          onRun={runAnyQueueItem}
          onRemove={id => deleteQueueItem(id).then(refreshQueue)}
          onProcessAll={processAllQueue}
          onStop={stopProcessingQueue}
          onClear={() => dbClearQueue().then(refreshQueue)}
        />
      )}

      </div>{/* ================= END RIGHT · OUTPUT ================= */}

      </div>{/* ================= END GRID ================= */}
    </div>
  )
}

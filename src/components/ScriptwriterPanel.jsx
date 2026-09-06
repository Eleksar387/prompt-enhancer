import { useState, useRef } from 'react'
import { callOllama } from '../api'
import {
  SYSTEM_PROMPT_SCRIPTWRITER, SYSTEM_PROMPT_DIRECTOR, buildLtxGuideSystemPrompt,
  SYSTEM_PROMPT_FLUX, SYSTEM_PROMPT_FLUX2_KLEIN, SYSTEM_PROMPT_SDXL,
} from '../constants'
import { btn } from '../utils'
import { generateId } from '../db'

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
    first: { target: 'flux', text: '', loading: false, error: '' },
    mid:   { target: 'flux', text: '', loading: false, error: '' },
    last:  { target: 'flux', text: '', loading: false, error: '' },
  }
})

const STEPS = ['Script', "Director's Cut", 'LTX Prompts']

export default function ScriptwriterPanel({ cfg, writerModel, initialState = null, onSaveHistory = null }) {
  const sessionId = useRef(initialState?.id || generateId())

  const [phase, setPhase] = useState(initialState?.phase || 'input')
  const [idea, setIdea] = useState(initialState?.idea || '')
  const [genre, setGenre] = useState(initialState?.genre || 'auto')
  const [sceneCount, setSceneCount] = useState(initialState?.sceneCount || 3)
  const [script, setScript] = useState(initialState?.script || null)
  const [directorsCut, setDirectorsCut] = useState(initialState?.directorsCut || null)
  const [finalPrompts, setFinalPrompts] = useState(
    initialState?.finalPrompts?.map(p => ({ ...p, loading: false, error: '' })) || []
  )
  const [framePrompts, setFramePrompts] = useState(
    initialState?.framePrompts?.map(fp => ({
      frames: {
        first: { ...fp.frames.first, loading: false, error: '' },
        mid:   { ...fp.frames.mid,   loading: false, error: '' },
        last:  { ...fp.frames.last,  loading: false, error: '' },
      }
    })) || []
  )
  const [error, setError] = useState('')
  const [rawFallback, setRawFallback] = useState('')
  const [copied, setCopied] = useState(null)
  const [copiedAll, setCopiedAll] = useState(false)
  const [copiedFrame, setCopiedFrame] = useState(null)

  const reset = () => {
    sessionId.current = generateId()
    setPhase('input'); setIdea(''); setGenre('auto'); setSceneCount(3)
    setScript(null); setDirectorsCut(null); setFinalPrompts([]); setFramePrompts([])
    setError(''); setRawFallback(''); setCopied(null); setCopiedAll(false)
  }

  const parseJSON = (text) => {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    try { return JSON.parse(clean) }
    catch {
      setRawFallback(text)
      throw new Error('LLM returned invalid JSON. Try a stronger model or click Retry.')
    }
  }

  const runPhase1 = async () => {
    if (!idea.trim()) return
    setError(''); setRawFallback('')
    setPhase('scripting')
    const genreHint = genre === 'auto' ? 'Infer a suitable genre from the story idea.' : `Genre: ${genre}`
    const userMsg = `Story idea: ${idea.trim()}\n${genreHint}\nNumber of scenes: ${sceneCount}\n\nOutput only valid JSON.`
    try {
      const { text } = await callOllama(writerModel, userMsg, SYSTEM_PROMPT_SCRIPTWRITER, cfg, 0.7, { format: 'json' })
      const data = parseJSON(text)
      setScript(data)
      setPhase('script')
      onSaveHistory?.({
        id: sessionId.current, ts: Date.now(), type: 'scriptwriter',
        model: writerModel, idea: idea.trim(), genre, sceneCount,
        phase: 'script', script: data, directorsCut: null, finalPrompts: null,
      })
    } catch (e) {
      setError(e.message)
      setPhase('input')
    }
  }

  const runPhase2 = async () => {
    setError(''); setRawFallback('')
    setPhase('directing')
    const userMsg = `Script:\n${JSON.stringify(script, null, 2)}\n\nOutput only valid JSON.`
    try {
      const { text } = await callOllama(writerModel, userMsg, SYSTEM_PROMPT_DIRECTOR, cfg, 0.7, { format: 'json' })
      const data = parseJSON(text)
      data.shots = data.shots.map(s => ({ ...s, duration: s.duration || 4 }))
      setDirectorsCut(data)
      setFramePrompts(data.shots.map(() => emptyFrameEntry()))
      setPhase('dircut')
      onSaveHistory?.({
        id: sessionId.current, ts: Date.now(), type: 'scriptwriter',
        model: writerModel, idea: idea.trim(), genre, sceneCount,
        phase: 'dircut', script, directorsCut: data, finalPrompts: null,
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

    const results = new Array(shots.length)
    const proms = shots.map((shot, i) => {
      const userMsg = `Target duration: ${shot.duration || 4} seconds\n\nBasic scene description:\n${shot.visual_action}\n\nRequested camera moves (incorporate these):\n- ${shot.camera_movement}\n- ${shot.camera_framing}\n\nStyle / mood: ${shot.lighting_mood}`
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
    onSaveHistory?.({
      id: sessionId.current, ts: Date.now(), type: 'scriptwriter',
      model: writerModel, idea: idea.trim(), genre, sceneCount,
      phase: 'done', script, directorsCut, finalPrompts: results,
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
    const userMsg = `Generate a still image prompt for the ${framePos} frame of a ${shot.duration || 4}-second video clip.\n\nShot ${shot.shot_number} — ${shot.scene_title}\nCamera framing: ${shot.camera_framing}\nLighting/mood: ${shot.lighting_mood}\nVisual action: ${shot.visual_action}\n\nThis is the ${framePos} of the clip. Describe the exact visual state at this moment as a still image.`

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
          <button onClick={runPhase1} disabled={!idea.trim() || isLoading} style={genBtn(!idea.trim() || isLoading)}>
            {phase === 'scripting' ? '✦ Writing script…' : '✦ Write Script'}
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

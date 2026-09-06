import { useState, useEffect } from 'react'
import {
  TARGETS, DURATION_OPTIONS, PROMPT_LENGTH_INJECT, MINIMAX_H3_RESOLUTIONS, systemPromptFor,
} from '../constants'
import { btn, selStyle, presetById } from '../utils'
import { callOllama } from '../api'
import { ADAPT_TARGETS, foldCaption, buildStylePart, buildAdaptUserText } from '../adapt'

const lbl = { fontSize: 13, color: 'var(--pe-ink-3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }
const sub = { color: 'var(--pe-ink-3)', textTransform: 'none', letterSpacing: 0 }

const durationsFor = (id) => TARGETS[id].durations || DURATION_OPTIONS

export default function AdaptPanel({
  caption, captioning = false, scene, sourceFrameMode, sourceTarget, originalPrompt, fromHistory, sourceTs,
  models, defaultModel, cfg,
  style, creativity, negative, dialogue, delivery, promptLength, soundscape, music,
  duration, h3RatioId,
  onSaveAdapt, onClose,
}) {
  const [open, setOpen] = useState(fromHistory)
  const [destTarget, setDestTarget] = useState(
    ADAPT_TARGETS.some(t => t.id === sourceTarget) ? sourceTarget : 'ltx'
  )
  const [adaptModel, setAdaptModel] = useState(defaultModel || '')
  const [adaptModelManual, setAdaptModelManual] = useState(defaultModel || '')
  const [adaptDuration, setAdaptDuration] = useState(() => {
    const opts = durationsFor(destTarget)
    return opts.some(o => o.value === duration) ? duration : opts[0].value
  })
  const [adaptRatioId, setAdaptRatioId] = useState(h3RatioId || 'port916')
  const [includeOriginal, setIncludeOriginal] = useState(true)
  const [result, setResult] = useState(null)   // { text, usage, loading, error }
  const [copied, setCopied] = useState(false)

  const dest = TARGETS[destTarget]

  // Keep the duration valid for the chosen destination.
  useEffect(() => {
    const opts = durationsFor(destTarget)
    setAdaptDuration(prev => (opts.some(o => o.value === prev) ? prev : opts[0].value))
  }, [destTarget])

  const effectiveAdaptModel = models.length ? adaptModel : adaptModelManual.trim()
  const hasOriginal = !!(originalPrompt && originalPrompt.trim())
  const hasCaption = !!(caption && caption.trim())

  const notReady = captioning
  // With no image description, the original prompt is the source and is always included.
  const useOriginal = hasCaption ? includeOriginal : true

  const runAdapt = async () => {
    if (notReady) return
    if (!hasCaption && !hasOriginal && !(scene && scene.trim())) {
      setResult({ text: '', usage: null, loading: false, error: 'Nothing to adapt from — this entry has no prompt, scene, or image description.' }); return
    }
    if (!effectiveAdaptModel) { setResult({ text: '', usage: null, loading: false, error: 'Pick a model.' }); return }
    setResult({ text: '', usage: null, loading: true, error: '' })
    setCopied(false)
    try {
      const foldedCaption = hasCaption ? foldCaption(caption, sourceFrameMode, { hasDialogue: !!(dialogue && dialogue.trim()) }) : ''
      const stylePart = buildStylePart({
        style, creativity, targetType: dest.type, showDialogue: dest.show.dialogue,
        dialogue, delivery, negative, forceNonImageWording: true,
      })
      const lengthPart = PROMPT_LENGTH_INJECT[promptLength] || ''
      const aspectRatio = destTarget === 'minimax_h3'
        ? (presetById(adaptRatioId, MINIMAX_H3_RESOLUTIONS) || MINIMAX_H3_RESOLUTIONS[0])
        : null
      const userText = buildAdaptUserText({
        destTarget, scene, foldedCaption,
        sourceLabel: TARGETS[sourceTarget]?.label || sourceTarget,
        duration: adaptDuration, aspectRatio, stylePart, lengthPart,
        audio: destTarget === 'minimax_h3' ? { soundscape, music } : null,
        originalPrompt: useOriginal ? originalPrompt : '',
      })
      const system = systemPromptFor(dest, 'single')
      const { text, usage } = await callOllama(effectiveAdaptModel, userText, system, cfg, cfg.temperature ?? 0.7)
      setResult({ text, usage, loading: false, error: '' })

      const snap = {
        ts: Date.now(), target: destTarget, outputCount: 1, model: effectiveAdaptModel, vision: null,
        duration: dest.show.duration ? adaptDuration : '',
        style, creativity, frameMode: 'single', negative,
        scene: scene || '',
        dialogue: dest.show.dialogue ? (dialogue || '') : '', delivery: dest.show.dialogue ? (delivery || '') : '',
        firstImg: null, midImg: null, lastImg: null, refImages: null, refAudio: null,
        ratio: destTarget === 'minimax_h3' ? (aspectRatio?.label ?? null) : null,
        soundscape: destTarget === 'minimax_h3' ? (soundscape || '') : '',
        music: destTarget === 'minimax_h3' ? (music || '') : '',
        caption: null,
        adaptedFrom: { target: sourceTarget, frameMode: sourceFrameMode, ts: sourceTs ?? null },
      }
      onSaveAdapt?.(snap, [{ label: effectiveAdaptModel, text }])
    } catch (e) {
      setResult({ text: '', usage: null, loading: false, error: e.message })
    }
  }

  return (
    <div id="adapt-panel" style={{ marginTop: 24, borderTop: '1px solid var(--pe-line-soft)', paddingTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <button
          onClick={() => setOpen(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--pe-ink-3)', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.5px' }}
        >
          <span style={{ fontSize: 13, transition: 'transform 0.2s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
          ⇄ Adapt for another model
          {fromHistory && (
            <span style={sub}> · from {TARGETS[sourceTarget]?.label || sourceTarget}{sourceTs ? ` · ${new Date(sourceTs).toLocaleDateString()}` : ''}</span>
          )}
        </button>
        {fromHistory && (
          <button onClick={onClose} style={{ fontSize: 13, color: 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>✕</button>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 12, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '16px 18px' }}>
          <p style={{ fontSize: 13, color: 'var(--pe-ink-3)', margin: '0 0 14px', lineHeight: 1.5 }}>
            {hasCaption
              ? 'Rewrites this generation as a self-contained text prompt for another model — the reference/frame image descriptions get folded into the wording, so no image is needed.'
              : 'Re-expresses this prompt in another model’s format and conventions (e.g. a text-to-video prompt → a text-to-image prompt), keeping its content and intent.'}
          </p>

          <label style={lbl}>Destination model / target</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {ADAPT_TARGETS.map(t => (
              <button key={t.id} onClick={() => setDestTarget(t.id)} style={btn(destTarget === t.id)}>{t.label}</button>
            ))}
          </div>

          <label style={lbl}>AI model <span style={sub}>· writes the adapted prompt</span></label>
          <div style={{ marginBottom: 14 }}>
            {models.length > 0
              ? <select style={{ ...selStyle, maxWidth: 320 }} value={adaptModel} onChange={e => setAdaptModel(e.target.value)}>
                  {!models.includes(adaptModel) && adaptModel && <option value={adaptModel}>{adaptModel}</option>}
                  {models.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              : <input style={{ ...selStyle, maxWidth: 320 }} value={adaptModelManual} onChange={e => setAdaptModelManual(e.target.value)} spellCheck={false} />}
          </div>

          {dest.show.duration && (
            <>
              <label style={lbl}>Target duration</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
                {durationsFor(destTarget).map(o => (
                  <button key={o.value} onClick={() => setAdaptDuration(o.value)} style={btn(adaptDuration === o.value)}>{o.label}</button>
                ))}
              </div>
            </>
          )}

          {destTarget === 'minimax_h3' && (
            <>
              <label style={lbl}>Aspect ratio <span style={sub}>· T2VA needs a concrete ratio</span></label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
                {MINIMAX_H3_RESOLUTIONS.map(p => (
                  <button key={p.id} onClick={() => setAdaptRatioId(p.id)} title={p.note} style={btn(adaptRatioId === p.id)}>{p.label}</button>
                ))}
              </div>
            </>
          )}

          {hasOriginal && hasCaption && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={includeOriginal} onChange={e => setIncludeOriginal(e.target.checked)} />
              Give the AI the original prompt too, as a detail / intent reference
            </label>
          )}

          {captioning && (
            <div style={{ fontSize: 13.5, color: 'var(--pe-ink-2)', marginBottom: 10 }}>👁 Reading the images from the original generation…</div>
          )}

          <button
            onClick={runAdapt}
            disabled={result?.loading || notReady}
            style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: (result?.loading || notReady) ? 'var(--pe-line)' : 'var(--pe-accent)', color: (result?.loading || notReady) ? 'var(--pe-ink-3)' : '#fff', fontSize: 13, fontWeight: 600, cursor: (result?.loading || notReady) ? 'not-allowed' : 'pointer' }}
          >
            {result?.loading ? '✦ Adapting…' : result?.text ? '✦ Regenerate' : '✦ Adapt prompt'}
          </button>

          {result?.error && (
            <div style={{ marginTop: 12, padding: '12px 14px', background: 'var(--pe-danger-bg)', border: '1px solid var(--pe-danger-line)', borderRadius: 8, fontSize: 13, color: 'var(--pe-danger)' }}>Error: {result.error}</div>
          )}

          {result?.text && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ fontSize: 13, color: 'var(--pe-ink-3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {effectiveAdaptModel} → {dest.label} · saved to history
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {result.usage && <span style={{ fontSize: 13, color: 'var(--pe-ink-3)' }}>in {result.usage.input_tokens} · out {result.usage.output_tokens} tokens</span>}
                  <button
                    onClick={() => { navigator.clipboard.writeText(result.text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                    style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--pe-line)', background: copied ? 'var(--pe-ok-bg)' : 'var(--pe-surface)', color: copied ? 'var(--pe-ok)' : 'var(--pe-ink-3)', fontSize: 13, cursor: 'pointer' }}
                  >{copied ? '✓ Copied' : 'Copy'}</button>
                </div>
              </div>
              <textarea
                value={result.text}
                onChange={e => setResult(r => ({ ...r, text: e.target.value }))}
                rows={Math.max(4, Math.ceil(result.text.length / 70))} spellCheck={false}
                style={{ width: '100%', boxSizing: 'border-box', background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '18px 20px', fontSize: 13.5, lineHeight: 1.8, color: 'var(--pe-ink)', whiteSpace: 'pre-wrap', fontFamily: 'var(--pe-mono)', resize: 'vertical', outline: 'none' }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

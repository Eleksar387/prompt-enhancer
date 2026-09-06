import { useState } from 'react'
import { isAnthropic, isGrok } from '../api'

const OLLAMA_BASE = 'http://localhost:11434/v1'
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1'
const GROK_BASE = 'https://api.x.ai/v1'

export default function ConfigBar({ cfg, setCfg, models, modelStatus, reloadModels, onClearCaptionCache }) {
  const [open, setOpen] = useState(false)
  const [cacheCleared, setCacheCleared] = useState(false)

  const inputStyle = {
    width: '100%', boxSizing: 'border-box', background: 'var(--pe-surface)',
    border: '1px solid var(--pe-line)', borderRadius: 7, padding: '8px 11px',
    color: 'var(--pe-ink)', fontSize: 13, outline: 'none',
  }
  const lbl = {
    fontSize: 13.5, color: 'var(--pe-ink-3)', textTransform: 'uppercase',
    letterSpacing: '0.5px', display: 'block', marginBottom: 4,
  }
  const presetBtn = (active) => ({
    padding: '4px 12px', borderRadius: 5, border: '1px solid',
    borderColor: active ? 'var(--pe-accent)' : 'var(--pe-line)',
    background: active ? 'var(--pe-accent-bg)' : 'var(--pe-surface)',
    color: active ? 'var(--pe-accent-ink)' : 'var(--pe-ink-3)',
    fontSize: 13, cursor: 'pointer',
  })

  const statusColor = modelStatus.ok ? 'var(--pe-ok)' : modelStatus.loading ? 'var(--pe-accent-ink)' : 'var(--pe-danger)'
  const anthropic = isAnthropic(cfg.base)
  const grok = isGrok(cfg.base)
  const cloud = anthropic || grok
  const providerLabel = anthropic ? 'Anthropic API' : grok ? 'Grok API' : cfg.base

  const statusText = modelStatus.loading
    ? 'connecting…'
    : modelStatus.ok
      ? `${models.length} model${models.length === 1 ? '' : 's'} · ${providerLabel}`
      : `not connected · ${modelStatus.error || ''}`

  return (
    <div style={{ marginBottom: 20, background: 'var(--pe-rail)', border: '1px solid var(--pe-line)', borderRadius: 10, padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <button
          onClick={() => setOpen(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--pe-ink-3)', fontSize: 13.5 }}
        >
          <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
          ⚙ Backend
        </button>
        <span style={{ fontSize: 13, color: statusColor }}>{statusText}</span>
      </div>

      {open && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Provider presets */}
          <div>
            <label style={lbl}>Provider</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button style={presetBtn(!cloud)} onClick={() => setCfg({ ...cfg, base: OLLAMA_BASE })}>
                Ollama (local)
              </button>
              <button style={presetBtn(anthropic)} onClick={() => setCfg({ ...cfg, base: ANTHROPIC_BASE })}>
                Claude API
              </button>
              <button style={presetBtn(grok)} onClick={() => setCfg({ ...cfg, base: GROK_BASE })}>
                Grok API
              </button>
            </div>
          </div>

          {/* Base URL */}
          <div>
            <label style={lbl}>Base URL (OpenAI-compatible)</label>
            <input
              style={inputStyle} value={cfg.base}
              onChange={e => setCfg({ ...cfg, base: e.target.value })}
              placeholder={OLLAMA_BASE} spellCheck={false}
            />
            <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', marginTop: 5, lineHeight: 1.5 }}>
              {anthropic ? (
                <>
                  Anthropic's OpenAI-compatible endpoint — use your{' '}
                  <span style={{ color: 'var(--pe-accent-ink)' }}>Anthropic API key</span> below.
                  Works with <span style={{ color: 'var(--pe-accent-ink)' }}>claude-sonnet-4-6</span>,{' '}
                  <span style={{ color: 'var(--pe-accent-ink)' }}>claude-haiku-4-5-20251001</span>, etc.
                </>
              ) : grok ? (
                <>
                  xAI's OpenAI-compatible endpoint — use your{' '}
                  <span style={{ color: 'var(--pe-accent-ink)' }}>xAI API key</span> below.
                  Works with <span style={{ color: 'var(--pe-accent-ink)' }}>grok-4</span>,{' '}
                  <span style={{ color: 'var(--pe-accent-ink)' }}>grok-3</span>, etc.
                </>
              ) : (
                <>
                  Ollama direct: <span style={{ color: 'var(--pe-accent-ink)' }}>{OLLAMA_BASE}</span> (needs{' '}
                  <span style={{ color: 'var(--pe-accent-ink)' }}>OLLAMA_ORIGINS=*</span>).
                  Also works with Open WebUI or any OpenAI-compatible proxy.
                </>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px' }}>
              <label style={lbl}>{anthropic ? 'Anthropic API key' : grok ? 'xAI API key' : 'API key (Open WebUI / remote only)'}</label>
              <input
                style={inputStyle} value={cfg.apiKey}
                onChange={e => setCfg({ ...cfg, apiKey: e.target.value })}
                placeholder={anthropic ? 'sk-ant-…' : grok ? 'xai-…' : 'leave blank for local Ollama'}
                type="password" spellCheck={false}
              />
            </div>
            <div style={{ width: 130 }}>
              <label style={lbl}>Writer temp</label>
              <input
                style={inputStyle} type="number" min={0} max={2} step={0.05} value={cfg.temperature}
                onChange={e => setCfg({ ...cfg, temperature: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div style={{ width: 150 }}>
              <label style={lbl}>Max output tokens</label>
              <input
                style={inputStyle} type="number" min={256} step={256} value={cfg.maxTokens}
                onChange={e => setCfg({ ...cfg, maxTokens: parseInt(e.target.value, 10) || 4096 })}
              />
            </div>
          </div>
          {grok && (
            <>
              <div style={{ flex: '1 1 260px' }}>
                <label style={lbl}>Grok image model <span style={{ color: 'var(--pe-ink-3)', fontWeight: 400 }}>· used by the 🎨 Render button on each result</span></label>
                <input
                  style={inputStyle} value={cfg.imageModel || ''}
                  onChange={e => setCfg({ ...cfg, imageModel: e.target.value })}
                  placeholder="grok-imagine-image-2.0" spellCheck={false}
                />
              </div>
              <div style={{ flex: '1 1 260px' }}>
                <label style={lbl}>Grok video model <span style={{ color: 'var(--pe-ink-3)', fontWeight: 400 }}>· used by the 🎬 Render video button on each result</span></label>
                <input
                  style={inputStyle} value={cfg.videoModel || ''}
                  onChange={e => setCfg({ ...cfg, videoModel: e.target.value })}
                  placeholder="grok-imagine-video-1.5" spellCheck={false}
                />
              </div>
            </>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px' }}>
              <label style={lbl}>Gemini API key <span style={{ color: 'var(--pe-ink-3)', fontWeight: 400 }}>· optional · enables 🎨 Render via Google on any backend</span></label>
              <input
                style={inputStyle} value={cfg.geminiKey || ''}
                onChange={e => setCfg({ ...cfg, geminiKey: e.target.value })}
                placeholder="AIza…" type="password" spellCheck={false}
              />
            </div>
            <div style={{ width: 220 }}>
              <label style={lbl}>Gemini image model</label>
              <input
                style={inputStyle} value={cfg.geminiImageModel || ''}
                onChange={e => setCfg({ ...cfg, geminiImageModel: e.target.value })}
                placeholder="gemini-2.5-flash-image" spellCheck={false}
              />
            </div>
          </div>
          <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', lineHeight: 1.5, marginTop: -4 }}>
            With a key set, the <span style={{ color: 'var(--pe-accent-ink)' }}>🎨 Render</span> button on each result can generate or
            edit images with Google's Gemini (<span style={{ color: 'var(--pe-accent-ink)' }}>gemini-2.5-flash-image</span>) — independent
            of the backend above. The key is stored only in your browser and sent only to{' '}
            <span style={{ color: 'var(--pe-accent-ink)' }}>generativelanguage.googleapis.com</span>.
          </div>

          {!cloud && (
            <div style={{ fontSize: 13, color: 'var(--pe-ink-3)', lineHeight: 1.5, marginTop: -4 }}>
              Reasoning models (Qwen3, DeepSeek-R1, etc.) spend part of this budget on hidden "thinking" before
              writing the answer — raise this if you see a "ran out of output length while thinking" error.
              If raising it doesn't help, the model's own Ollama context window (num_ctx) is likely the real
              ceiling — that's set server-side, not here.
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={reloadModels}
              style={{ padding: '7px 16px', borderRadius: 7, border: '1px solid var(--pe-accent-line)', background: 'var(--pe-accent-bg)', color: 'var(--pe-accent-ink)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}
            >
              ↻ Reload models
            </button>
            {onClearCaptionCache && (
              <button
                onClick={() => { onClearCaptionCache(); setCacheCleared(true); setTimeout(() => setCacheCleared(false), 1800) }}
                title="Forget every saved vision-model image description. They're re-fetched on the next generation."
                style={{ fontSize: 13, color: cacheCleared ? 'var(--pe-ok)' : 'var(--pe-ink-3)', background: 'none', border: '1px solid var(--pe-line)', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}
              >
                {cacheCleared ? '✓ Cleared' : 'Clear caption cache'}
              </button>
            )}
          </div>

          {!modelStatus.ok && !modelStatus.loading && (
            <div style={{ fontSize: 13, color: 'var(--pe-warn)', background: 'var(--pe-warn-bg)', border: '1px solid var(--pe-warn-line)', borderRadius: 6, padding: '8px 11px', lineHeight: 1.5 }}>
              {cloud
                ? 'Could not connect. Check your API key and that the base URL is correct.'
                : 'Couldn\'t list models. Most common cause: CORS. Set OLLAMA_ORIGINS=* and restart Ollama. You can still type model names manually below.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

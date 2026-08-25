import { useState } from 'react'
import { isAnthropic } from '../api'

const OLLAMA_BASE = 'http://localhost:11434/v1'
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1'

export default function ConfigBar({ cfg, setCfg, models, modelStatus, reloadModels }) {
  const [open, setOpen] = useState(false)

  const inputStyle = {
    width: '100%', boxSizing: 'border-box', background: '#12121f',
    border: '1px solid #2e2e44', borderRadius: 7, padding: '8px 11px',
    color: '#e0e0f0', fontSize: 13, outline: 'none',
  }
  const lbl = {
    fontSize: 10, color: '#666', textTransform: 'uppercase',
    letterSpacing: '0.5px', display: 'block', marginBottom: 4,
  }
  const presetBtn = (active) => ({
    padding: '4px 12px', borderRadius: 5, border: '1px solid',
    borderColor: active ? '#7c6af7' : '#2a2a3f',
    background: active ? '#2d2060' : '#13131f',
    color: active ? '#c4b8ff' : '#666',
    fontSize: 11, cursor: 'pointer',
  })

  const statusColor = modelStatus.ok ? '#4ade80' : modelStatus.loading ? '#9a8fd8' : '#f87171'
  const anthropic = isAnthropic(cfg.base)

  const statusText = modelStatus.loading
    ? 'connecting…'
    : modelStatus.ok
      ? `${models.length} model${models.length === 1 ? '' : 's'} · ${anthropic ? 'Anthropic API' : cfg.base}`
      : `not connected · ${modelStatus.error || ''}`

  return (
    <div style={{ marginBottom: 20, background: '#0e0e1c', border: '1px solid #2a2a3f', borderRadius: 10, padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <button
          onClick={() => setOpen(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#888', fontSize: 12 }}
        >
          <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
          ⚙ Backend
        </button>
        <span style={{ fontSize: 11, color: statusColor }}>{statusText}</span>
      </div>

      {open && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Provider presets */}
          <div>
            <label style={lbl}>Provider</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button style={presetBtn(!anthropic)} onClick={() => setCfg({ ...cfg, base: OLLAMA_BASE })}>
                Ollama (local)
              </button>
              <button style={presetBtn(anthropic)} onClick={() => setCfg({ ...cfg, base: ANTHROPIC_BASE })}>
                Claude API
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
            <div style={{ fontSize: 11, color: '#555', marginTop: 5, lineHeight: 1.5 }}>
              {anthropic ? (
                <>
                  Anthropic's OpenAI-compatible endpoint — use your{' '}
                  <span style={{ color: '#9a8fd8' }}>Anthropic API key</span> below.
                  Works with <span style={{ color: '#9a8fd8' }}>claude-sonnet-4-6</span>,{' '}
                  <span style={{ color: '#9a8fd8' }}>claude-haiku-4-5-20251001</span>, etc.
                </>
              ) : (
                <>
                  Ollama direct: <span style={{ color: '#9a8fd8' }}>{OLLAMA_BASE}</span> (needs{' '}
                  <span style={{ color: '#9a8fd8' }}>OLLAMA_ORIGINS=*</span>).
                  Also works with Open WebUI or any OpenAI-compatible proxy.
                </>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px' }}>
              <label style={lbl}>{anthropic ? 'Anthropic API key' : 'API key (Open WebUI / remote only)'}</label>
              <input
                style={inputStyle} value={cfg.apiKey}
                onChange={e => setCfg({ ...cfg, apiKey: e.target.value })}
                placeholder={anthropic ? 'sk-ant-…' : 'leave blank for local Ollama'}
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
          {!anthropic && (
            <div style={{ fontSize: 11, color: '#555', lineHeight: 1.5, marginTop: -4 }}>
              Reasoning models (Qwen3, DeepSeek-R1, etc.) spend part of this budget on hidden "thinking" before
              writing the answer — raise this if you see a "ran out of output length while thinking" error.
              If raising it doesn't help, the model's own Ollama context window (num_ctx) is likely the real
              ceiling — that's set server-side, not here.
            </div>
          )}

          <button
            onClick={reloadModels}
            style={{ alignSelf: 'flex-start', padding: '7px 16px', borderRadius: 7, border: '1px solid #3a2f6e', background: '#1e1850', color: '#c4b8ff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
          >
            ↻ Reload models
          </button>

          {!modelStatus.ok && !modelStatus.loading && (
            <div style={{ fontSize: 11.5, color: '#f0b070', background: '#241a0e', border: '1px solid #4a3520', borderRadius: 6, padding: '8px 11px', lineHeight: 1.5 }}>
              {anthropic
                ? 'Could not connect. Check your API key and that the base URL is correct.'
                : 'Couldn\'t list models. Most common cause: CORS. Set OLLAMA_ORIGINS=* and restart Ollama. You can still type model names manually below.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

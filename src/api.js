export const CFG_KEY = 'ollama-enhancer-config'
export const DEFAULT_CFG = { base: 'http://localhost:11434/v1', apiKey: '', temperature: 0.7 }

export function loadCfg() {
  const envKey  = import.meta.env.VITE_API_KEY  || ''
  const envBase = import.meta.env.VITE_API_BASE || ''
  const derivedBase = envBase || (envKey.startsWith('sk-ant-') ? 'https://api.anthropic.com/v1' : '')
  let saved = {}
  try {
    const raw = localStorage.getItem(CFG_KEY)
    if (raw) saved = JSON.parse(raw)
  } catch {}
  return {
    ...DEFAULT_CFG,
    ...saved,
    ...(envKey      ? { apiKey: envKey }      : {}),
    ...(derivedBase ? { base:  derivedBase }  : {}),
  }
}

export function saveCfg(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)) } catch {}
}

function toOpenAIContent(userContent) {
  if (typeof userContent === 'string') return userContent
  return userContent.map(b => {
    if (b.type === 'text') return { type: 'text', text: b.text }
    if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
    return null
  }).filter(Boolean)
}

export const isAnthropic = (base) => (base || '').includes('anthropic.com')

function authHeaders(cfg) {
  if (!cfg.apiKey) return {}
  if (isAnthropic(cfg.base)) {
    return {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }
  }
  return { 'Authorization': `Bearer ${cfg.apiKey}` }
}

function stripThinking(text) {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const closeIdx = out.indexOf('</think>')
  if (closeIdx !== -1) out = out.slice(closeIdx + '</think>'.length)
  return out
}

export async function callOllama(model, userContent, system, cfg, temperature, opts = {}) {
  const base = (cfg.base || '').replace(/\/+$/, '')
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: toOpenAIContent(userContent) })
  const headers = { 'Content-Type': 'application/json', ...authHeaders(cfg) }
  const formatParam = opts.format && !isAnthropic(cfg.base) ? { format: opts.format } : {}
  const doFetch = (includeTemperature) => fetch(`${base}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model, messages, max_tokens: 4096, stream: false,
      ...(includeTemperature ? { temperature } : {}),
      ...formatParam,
    }),
  })
  let res
  try {
    res = await doFetch(true)
  } catch (e) {
    const label = isAnthropic(cfg.base) ? 'api.anthropic.com' : base
    throw new Error(`Network error reaching ${label}. ${isAnthropic(cfg.base) ? 'Check your internet connection.' : 'Is Ollama running and is OLLAMA_ORIGINS set?'} (${e.message})`)
  }
  // Some newer Claude models reject a custom temperature outright; retry once without it.
  if (!res.ok) {
    let msg = ''
    try { const j = await res.clone().json(); msg = (j.error && (j.error.message || j.error)) || '' } catch {}
    if (/temperature/i.test(msg) && /deprecated|not supported|unsupported/i.test(msg)) {
      try { res = await doFetch(false) } catch {}
    }
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || msg } catch {}
    throw new Error(msg)
  }
  const data = await res.json()
  const msg = data.choices?.[0]?.message || {}
  const rawText = msg.content || ''
  if (!rawText) {
    if (msg.reasoning) {
      throw new Error(`${model} ran out of output length while "thinking" and never produced a final answer (its reasoning got cut off mid-thought). Try a less reasoning-heavy model, or a build/config with a larger context/output limit.`)
    }
    throw new Error(`Unexpected response: ${JSON.stringify(data).slice(0, 300)}`)
  }
  const text = stripThinking(rawText)
  const usage = data.usage
    ? { input_tokens: data.usage.prompt_tokens ?? '?', output_tokens: data.usage.completion_tokens ?? '?' }
    : null
  return { text: text.trim(), usage }
}

export async function fetchModels(cfg) {
  const base = (cfg.base || '').replace(/\/+$/, '')
  const res = await fetch(`${base}/models`, { headers: authHeaders(cfg) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return (data.data || []).map(m => m.id).filter(Boolean)
}

export const pickWriter = (ids) =>
  ids.find(id => /claude-sonnet/i.test(id))
  || ids.find(id => /claude-opus/i.test(id))
  || ids.find(id => /claude-haiku/i.test(id))
  || ['mistral-nemo:latest', 'mistral-nemo'].find(p => ids.includes(p))
  || ids.find(id => !/embed|bge-m3|:vl|qwen.*vl|vision|llava|minicpm/i.test(id))
  || ids[0] || ''

export const pickVision = (ids) =>
  ids.find(id => /claude-sonnet/i.test(id))
  || ids.find(id => /claude-haiku/i.test(id))
  || ['qwen2.5vl:7b', 'qwen2.5vl'].find(p => ids.includes(p))
  || ids.find(id => /vl|vision|llava|minicpm|gemma3/i.test(id))
  || ids[0] || ''

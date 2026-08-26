export const CFG_KEY = 'ollama-enhancer-config'
export const DEFAULT_CFG = { base: 'https://api.x.ai/v1', apiKey: '', temperature: 0.7, maxTokens: 4096 }

export function loadCfg() {
  const envKey  = import.meta.env.VITE_API_KEY  || ''
  const envBase = import.meta.env.VITE_API_BASE || ''
  const derivedBase = envBase
    || (envKey.startsWith('sk-ant-') ? 'https://api.anthropic.com/v1' : '')
    || (envKey.startsWith('xai-')    ? 'https://api.x.ai/v1'          : '')
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
export const isGrok = (base) => (base || '').includes('api.x.ai')
// Any hosted provider — as opposed to a local/self-hosted Ollama-compatible server.
const isCloud = (base) => isAnthropic(base) || isGrok(base)

function authHeaders(cfg) {
  if (!cfg.apiKey) return {}
  if (isAnthropic(cfg.base)) {
    return {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }
  }
  // Grok (xAI) and Ollama both speak plain OpenAI-style bearer auth.
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
  // `format` is an Ollama-specific field name, not part of the OpenAI-compatible
  // surface — only send it to an actual Ollama-family server.
  const formatParam = opts.format && !isCloud(cfg.base) ? { format: opts.format } : {}
  const doFetch = (includeTemperature, maxTokens) => fetch(`${base}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model, messages, max_tokens: maxTokens, stream: false,
      ...(includeTemperature ? { temperature } : {}),
      ...formatParam,
    }),
  })
  const baseMaxTokens = cfg.maxTokens || DEFAULT_CFG.maxTokens
  let res
  try {
    res = await doFetch(true, baseMaxTokens)
  } catch (e) {
    const label = isAnthropic(cfg.base) ? 'api.anthropic.com' : isGrok(cfg.base) ? 'api.x.ai' : base
    throw new Error(`Network error reaching ${label}. ${isCloud(cfg.base) ? 'Check your internet connection.' : 'Is Ollama running and is OLLAMA_ORIGINS set?'} (${e.message})`)
  }
  // Some newer Claude models reject a custom temperature outright; retry once without it.
  if (!res.ok) {
    let msg = ''
    try { const j = await res.clone().json(); msg = (j.error && (j.error.message || j.error)) || '' } catch {}
    if (/temperature/i.test(msg) && /deprecated|not supported|unsupported/i.test(msg)) {
      try { res = await doFetch(false, baseMaxTokens) } catch {}
    }
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || msg } catch {}
    throw new Error(msg)
  }
  let data = await res.json()
  let msg = data.choices?.[0]?.message || {}
  let rawText = msg.content || ''
  let retried = false
  // Reasoning models put their chain-of-thought in `reasoning`, separate from `content`,
  // and both draw from the same token budget — a heavy thinker can exhaust max_tokens before
  // ever writing a final answer. Retry once with a much larger budget before giving up.
  if (!rawText && msg.reasoning) {
    retried = true
    const escalatedMaxTokens = Math.max(baseMaxTokens * 4, 16000)
    try {
      const retryRes = await doFetch(true, escalatedMaxTokens)
      if (retryRes.ok) {
        data = await retryRes.json()
        msg = data.choices?.[0]?.message || {}
        rawText = msg.content || ''
      }
    } catch {}
  }
  if (!rawText) {
    if (msg.reasoning) {
      throw new Error(`${model} ran out of output length while "thinking"${retried ? ' even after retrying with a much larger token budget' : ''} and never produced a final answer. Raise "Max output tokens" in ⚙ Backend, try a less reasoning-heavy model, or — if that doesn't help — its Ollama context window (num_ctx) itself is likely the real ceiling; increase that server-side (e.g. OLLAMA_CONTEXT_LENGTH or a Modelfile PARAMETER num_ctx).`)
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
  || ids.find(id => /^grok-4/i.test(id))
  || ids.find(id => /^grok-3/i.test(id))
  || ids.find(id => /^grok/i.test(id))
  || ['mistral-nemo:latest', 'mistral-nemo'].find(p => ids.includes(p))
  || ids.find(id => !/embed|bge-m3|:vl|qwen.*vl|vision|llava|minicpm/i.test(id))
  || ids[0] || ''

export const pickVision = (ids) =>
  ids.find(id => /claude-sonnet/i.test(id))
  || ids.find(id => /claude-haiku/i.test(id))
  || ids.find(id => /^grok-4/i.test(id))
  || ids.find(id => /grok.*vision/i.test(id))
  || ['qwen2.5vl:7b', 'qwen2.5vl'].find(p => ids.includes(p))
  || ids.find(id => /vl|vision|llava|minicpm|gemma3/i.test(id))
  || ids[0] || ''

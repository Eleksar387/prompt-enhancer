export const CFG_KEY = 'ollama-enhancer-config'
export const DEFAULT_CFG = { base: 'https://api.x.ai/v1', apiKey: '', temperature: 0.7, maxTokens: 4096, imageModel: 'grok-imagine-image-2.0', videoModel: 'grok-imagine-video-1.5', geminiKey: '', geminiImageModel: 'gemini-2.5-flash-image' }

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

export function authHeaders(cfg) {
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

// xAI image generation / editing — POST {base}/images/generations, or /images/edits when
// `opts.images` (reference images for image-to-image) is given. OpenAI-ish JSON, plain bearer
// auth, no special browser headers. `opts.images` = [{ base64, mediaType }]. Returns
// [{ b64, url, mediaType, revisedPrompt }] (one per output image).
export async function generateImages(prompt, cfg, opts = {}) {
  const { n = 1, model, aspectRatio, resolution, images } = opts
  const base = (cfg.base || '').replace(/\/+$/, '')
  const chosenModel = model || cfg.imageModel || DEFAULT_CFG.imageModel
  const refs = (images || []).filter(im => im && im.base64)
  const isEdit = refs.length > 0
  const endpoint = isEdit ? `${base}/images/edits` : `${base}/images/generations`
  const asDataUri = (im) => `data:${im.mediaType || 'image/jpeg'};base64,${im.base64}`
  // Single ref → `image`; multiple → `images` array (prompt can address them as <IMAGE_0>, …).
  const refParams = !isEdit ? {}
    : refs.length === 1 ? { image: { url: asDataUri(refs[0]), type: 'image_url' } }
    : { images: refs.map(im => ({ url: asDataUri(im), type: 'image_url' })) }
  const doFetch = (extras) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
    body: JSON.stringify({ model: chosenModel, prompt, n, response_format: 'b64_json', ...refParams, ...extras }),
  })
  const optionalParams = {
    ...(aspectRatio && aspectRatio !== 'auto' ? { aspect_ratio: aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
  }
  const label = isEdit ? 'image editing' : 'image generation'
  let res
  try {
    res = await doFetch(optionalParams)
  } catch (e) {
    throw new Error(`Network error reaching api.x.ai for ${label}. Check your internet connection. (${e.message})`)
  }
  // Older image models (e.g. grok-2-image) only accept prompt + n — retry once without the extras.
  if (!res.ok && Object.keys(optionalParams).length) {
    let msg = ''
    try { const j = await res.clone().json(); msg = (j.error && (j.error.message || j.error)) || '' } catch {}
    if (/aspect_ratio|resolution|unsupported|unknown|unexpected/i.test(msg)) {
      try { res = await doFetch({}) } catch {}
    }
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || msg } catch {}
    throw new Error(msg)
  }
  const data = await res.json()
  return (data.data || []).map(d => ({
    b64: d.b64_json || null,
    url: d.url || null,
    mediaType: d.mime_type || mediaTypeFromB64(d.b64_json),
    revisedPrompt: d.revised_prompt || '',
  }))
}

// Google Gemini image generation / editing — POST to the Generative Language API's
// generateContent endpoint (gemini-2.5-flash-image, "Nano Banana"). One code path for
// text-to-image and editing: any `opts.images` ([{ base64, mediaType }]) are attached as
// inline_data parts alongside the prompt. Auth is the `x-goog-api-key` header, which is
// CORS-allow-listed on generativelanguage.googleapis.com so this works from the browser.
// Independent of cfg.base — the key/model come from `opts`, not the backend config.
// Returns [{ b64, url: null, mediaType, revisedPrompt }] — one per returned image (usually 1).
export async function generateImagesGemini(prompt, opts = {}) {
  const { key, model, aspectRatio, images, signal } = opts
  if (!key) throw new Error('No Gemini API key set — add one in ⚙ Backend.')
  const chosenModel = model || DEFAULT_CFG.geminiImageModel
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosenModel)}:generateContent`
  const refs = (images || []).filter(im => im && im.base64)
  const parts = [
    { text: prompt },
    ...refs.map(im => ({ inline_data: { mime_type: im.mediaType || 'image/jpeg', data: im.base64 } })),
  ]
  const imageCfg = aspectRatio && aspectRatio !== 'auto' ? { imageConfig: { aspectRatio } } : {}
  const doFetch = (withImageCfg) => fetch(endpoint, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities: ['IMAGE'], ...(withImageCfg ? imageCfg : {}) },
    }),
  })
  let res
  try {
    res = await doFetch(true)
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new Error(`Network error reaching generativelanguage.googleapis.com for image generation — check your connection, and that the Gemini API permits browser requests. (${e.message})`)
  }
  // Older / preview image models may not accept imageConfig — retry once without it.
  if (!res.ok && Object.keys(imageCfg).length) {
    let msg = ''
    try { const j = await res.clone().json(); msg = j.error?.message || '' } catch {}
    if (/imageConfig|aspectRatio|responseModalities|Unknown name|Invalid JSON payload/i.test(msg)) {
      try { res = await doFetch(false) } catch (e) { if (e.name === 'AbortError') throw e }
    }
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = j.error?.message || msg } catch {}
    throw new Error(msg)
  }
  const data = await res.json()
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`)
  const cand = data.candidates?.[0]
  const outParts = cand?.content?.parts || []
  const text = outParts.filter(p => p.text).map(p => p.text).join('\n').trim()
  const out = outParts
    .map(p => p.inlineData || p.inline_data)
    .filter(d => d && d.data)
    .map(d => ({ b64: d.data, url: null, mediaType: d.mimeType || d.mime_type || mediaTypeFromB64(d.data), revisedPrompt: text }))
  if (!out.length) {
    const fr = cand?.finishReason && cand.finishReason !== 'STOP' ? ` (finishReason: ${cand.finishReason})` : ''
    throw new Error(`Gemini returned no image${fr}.${text ? ` Model said: "${text.slice(0, 200)}"` : ''}`)
  }
  return out
}

// Sniff the image type from the leading base64 bytes (xAI doesn't label it).
function mediaTypeFromB64(b64) {
  if (!b64) return 'image/jpeg'
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (b64.startsWith('R0lGOD')) return 'image/gif'
  if (b64.startsWith('UklGR')) return 'image/webp'
  return 'image/jpeg'
}

const clampInt = (n, lo, hi) => Math.min(Math.max(Math.round(Number(n) || lo), lo), hi)

// xAI video generation — POST {base}/videos/generations returns a { request_id }; poll
// GET {base}/videos/{request_id} until status is done/failed/expired. Async, so the whole
// submit-and-poll runs here; `opts.onProgress(status, pct)` is called between polls and
// `opts.signal` (an AbortController signal) cancels it. Resolves { url, duration, model }
// (video is a temporary URL on vidgen.x.ai — there is no base64 option for video).
export async function generateVideo(prompt, cfg, opts = {}) {
  const { model, duration, resolution, aspectRatio, audio, image, onProgress, signal } = opts
  const base = (cfg.base || '').replace(/\/+$/, '')
  const chosenModel = model || cfg.videoModel || DEFAULT_CFG.videoModel
  const pollMs = (import.meta.env.DEV && typeof window !== 'undefined' && window.__peVideoPollMs) || opts.pollMs || 4000
  const timeoutMs = opts.timeoutMs || 600000
  const progress = (s, p) => { try { onProgress && onProgress(s, p) } catch {} }
  const abortIfNeeded = () => { if (signal?.aborted) throw new DOMException('aborted', 'AbortError') }

  const extras = {
    ...(duration ? { duration: clampInt(duration, 1, 15) } : {}),
    ...(resolution ? { resolution } : {}),
    ...(aspectRatio && aspectRatio !== 'auto' ? { aspect_ratio: aspectRatio } : {}),
    ...(typeof audio === 'boolean' ? { generate_audio: audio } : {}),
  }
  const imagePart = image ? { image: { url: image } } : {}
  const submit = (withExtras) => fetch(`${base}/videos/generations`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
    body: JSON.stringify({ model: chosenModel, prompt, ...imagePart, ...(withExtras ? extras : {}) }),
  })

  let res
  try {
    res = await submit(true)
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new Error(`Network error reaching api.x.ai for video generation. Check your internet connection. (${e.message})`)
  }
  if (!res.ok && Object.keys(extras).length) {
    let msg = ''
    try { const j = await res.clone().json(); msg = (j.error && (j.error.message || j.error)) || '' } catch {}
    if (/aspect_ratio|resolution|duration|generate_audio|unsupported|unknown|unexpected/i.test(msg)) {
      try { res = await submit(false) } catch (e) { if (e.name === 'AbortError') throw e }
    }
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || msg } catch {}
    throw new Error(msg)
  }
  const started = Date.now()
  const submitData = await res.json()
  const requestId = submitData.request_id || submitData.id
  if (!requestId) throw new Error(`Unexpected video response: ${JSON.stringify(submitData).slice(0, 200)}`)
  progress('pending', 0)

  // Poll.
  for (;;) {
    abortIfNeeded()
    await new Promise(r => setTimeout(r, pollMs))
    abortIfNeeded()
    let pres
    try {
      pres = await fetch(`${base}/videos/${requestId}`, { headers: authHeaders(cfg), signal })
    } catch (e) {
      if (e.name === 'AbortError') throw e
      if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the video (10 min).')
      continue
    }
    if (!pres.ok) {
      if (pres.status === 404 && Date.now() - started < 30000) continue
      let msg = `HTTP ${pres.status}`
      try { const j = await pres.json(); msg = (j.error && (j.error.message || j.error)) || msg } catch {}
      throw new Error(msg)
    }
    const j = await pres.json()
    if (j.status === 'done') {
      progress('done', 100)
      if (!j.video || !j.video.url) throw new Error('Video generation finished but returned no URL.')
      return { url: j.video.url, duration: j.video.duration ?? (duration || null), model: j.model || chosenModel }
    }
    if (j.status === 'failed' || j.status === 'expired') {
      throw new Error((j.error && (j.error.message || j.error)) || `Video generation ${j.status}.`)
    }
    progress(j.status || 'pending', typeof j.progress === 'number' ? j.progress : 0)
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the video (10 min).')
  }
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
  || ids.find(id => !/embed|bge-m3|:vl|qwen.*vl|vision|llava|minicpm|image/i.test(id))
  || ids[0] || ''

export const pickVision = (ids) =>
  ids.find(id => /claude-sonnet/i.test(id))
  || ids.find(id => /claude-haiku/i.test(id))
  || ids.find(id => /^grok-4/i.test(id))
  || ids.find(id => /grok.*vision/i.test(id) && !/image/i.test(id))
  || ['qwen2.5vl:7b', 'qwen2.5vl'].find(p => ids.includes(p))
  || ids.find(id => /vl|vision|llava|minicpm|gemma3/i.test(id) && !/image/i.test(id))
  || ids[0] || ''

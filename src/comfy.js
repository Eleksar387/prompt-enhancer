// Copies the app's currently-loaded input image(s) into a locally-running
// ComfyUI instance's input/ folder via its own /upload/image endpoint, so
// they're already there ready to pick from a LoadImage node's dropdown when
// building a workflow in ComfyUI.

export const COMFY_CFG_KEY = 'prompt-enhancer-comfy-config'
export const DEFAULT_COMFY_CFG = { url: 'http://127.0.0.1:8188' }

export function loadComfyCfg() {
  let saved = {}
  try {
    const raw = localStorage.getItem(COMFY_CFG_KEY)
    if (raw) saved = JSON.parse(raw)
  } catch {}
  return { ...DEFAULT_COMFY_CFG, ...saved }
}

export function saveComfyCfg(cfg) {
  try { localStorage.setItem(COMFY_CFG_KEY, JSON.stringify(cfg)) } catch {}
}

export async function uploadImage(base64, fileName, mediaType, comfyUrl) {
  const base = (comfyUrl || '').replace(/\/+$/, '')
  const byteChars = atob(base64)
  const bytes = new Uint8Array(byteChars.length)
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i)
  const blob = new Blob([bytes], { type: mediaType || 'image/jpeg' })

  const form = new FormData()
  form.append('image', blob, fileName)
  form.append('overwrite', 'true')

  let res
  try {
    res = await fetch(`${base}/upload/image`, { method: 'POST', body: form })
  } catch (e) {
    throw new Error(`Network error reaching ComfyUI at ${base}. Is it running, and started with --enable-cors-header? (${e.message})`)
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = j.error?.message || j.error || msg } catch {}
    throw new Error(`ComfyUI upload failed: ${msg}`)
  }
  const data = await res.json()
  // `name` is the filename ComfyUI assigned in its input/ folder. ComfyUI may
  // also return a non-empty `subfolder` for some upload configurations — not
  // handled here (flat input/ uploads are the default and common case).
  return data.name
}

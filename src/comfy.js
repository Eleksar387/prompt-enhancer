// Hands work off to a locally-running ComfyUI instance:
//
//  - `uploadImage` copies the app's currently-loaded input image(s) into
//    ComfyUI's input/ folder via its own /upload/image endpoint, so they're
//    already there ready to pick from a LoadImage node's dropdown.
//  - `sendShot` pushes a generated prompt (plus the context it was generated
//    with, and the input/ filenames of those images) to the Prompt Enhancer
//    Bridge custom node pack, so a workflow can read it without copy-paste.

import { makeLocalStore } from './localStore'

export const COMFY_CFG_KEY = 'prompt-enhancer-comfy-config'
export const DEFAULT_COMFY_CFG = { url: 'http://127.0.0.1:8188', slot: 'default' }

const comfyStore = makeLocalStore(COMFY_CFG_KEY, { defaults: DEFAULT_COMFY_CFG })
export const loadComfyCfg = comfyStore.load
export const saveComfyCfg = comfyStore.save

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

// Pushes one shot into a named slot on the bridge node pack. `shot` carries
// { positive, negative, target, duration, images:{first,mid,last,ref[]} } —
// the image values are the filenames `uploadImage` returned, not the bytes.
export async function sendShot(shot, comfyUrl, slot) {
  const base = (comfyUrl || '').replace(/\/+$/, '')
  const body = { ...shot, slot: slot || 'default' }

  let res
  try {
    res = await fetch(`${base}/prompt_enhancer/shot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new Error(`Network error reaching ComfyUI at ${base}. Is it running, and started with --enable-cors-header? (${e.message})`)
  }
  if (res.status === 404) {
    throw new Error('ComfyUI has no /prompt_enhancer/shot route — is the comfyui-prompt-enhancer-bridge custom node pack installed, and has ComfyUI been restarted since?')
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = j.error || msg } catch {}
    throw new Error(`ComfyUI push failed: ${msg}`)
  }
  return res.json()
}

// --- reading generated images back out of ComfyUI ---------------------------
//
// ComfyUI has no notion of "the image for shot 3, first frame" — the app pushes
// a prompt into a slot, the user renders it, and these helpers let the user pick
// the result out of ComfyUI's own recent-output history and attach it by hand.

// Build a /view URL for one output-image descriptor from a /history entry.
export function comfyViewUrl(comfyUrl, { filename, subfolder = '', type = 'output' }) {
  const base = (comfyUrl || '').replace(/\/+$/, '')
  const qs = new URLSearchParams({ filename, subfolder: subfolder || '', type: type || 'output' })
  return `${base}/view?${qs.toString()}`
}

// GET /history → a newest-first flat list of the images each run produced:
//   [{ filename, subfolder, type, promptId, nodeId, ts, viewUrl }]
// `type` is 'output' (SaveImage) or 'temp' (PreviewImage — purged on restart).
// Runs that errored are skipped unless `onlySuccess` is false.
export async function fetchComfyOutputs(comfyUrl, { max = 24, onlySuccess = true } = {}) {
  const base = (comfyUrl || '').replace(/\/+$/, '')
  let res
  try {
    res = await fetch(`${base}/history?max_items=${max}`)
  } catch (e) {
    throw new Error(`Network error reaching ComfyUI at ${base}. Is it running, and started with --enable-cors-header? (${e.message})`)
  }
  if (!res.ok) throw new Error(`ComfyUI history fetch failed: HTTP ${res.status}`)
  const hist = await res.json()

  // /history returns runs in execution order (oldest first). Prefer the real
  // timestamp off status.messages when present, fall back to position.
  const rows = Object.entries(hist).map(([promptId, run], idx) => {
    let ts = idx
    for (const m of run?.status?.messages || []) {
      if (Array.isArray(m) && m[1] && typeof m[1].timestamp === 'number') ts = m[1].timestamp
    }
    return { promptId, run, ts }
  })
  rows.sort((a, b) => b.ts - a.ts)

  const out = []
  for (const { promptId, run, ts } of rows) {
    if (onlySuccess && run?.status?.status_str && run.status.status_str !== 'success') continue
    for (const [nodeId, node] of Object.entries(run?.outputs || {})) {
      for (const img of node?.images || []) {
        if (img.type !== 'output' && img.type !== 'temp') continue
        out.push({
          filename: img.filename, subfolder: img.subfolder || '', type: img.type,
          promptId, nodeId, ts, viewUrl: comfyViewUrl(base, img),
        })
      }
    }
  }
  return out.slice(0, max)
}

// Fetch one output image as a Blob so the caller can re-encode it. Needs
// --enable-cors-header (a bare <img src> for previews does not).
export async function fetchComfyImageBlob(viewUrl) {
  let res
  try {
    res = await fetch(viewUrl)
  } catch (e) {
    throw new Error(`Network error fetching the image from ComfyUI (${e.message}). Started with --enable-cors-header?`)
  }
  if (res.status === 404) throw new Error('ComfyUI returned 404 for that image — it may have been cleared. Refresh the list.')
  if (!res.ok) throw new Error(`ComfyUI image fetch failed: HTTP ${res.status}`)
  return res.blob()
}

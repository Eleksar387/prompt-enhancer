import { createServer } from 'node:http'
import { ensureTree } from './paths.mjs'
import { getBlob } from './blobs.mjs'
import {
  loadIndex, listHistory, getHistory, putHistory, patchHistory,
  deleteHistory, clearHistory, historyCount,
  loadProjects, saveProjects,
  getCaption, putCaption, clearCaptions,
} from './store.mjs'
import {
  loadQueueIndex, listQueue, getQueue, putQueue, patchQueue,
  deleteQueue, clearQueue,
} from './queueStore.mjs'
import { loadLibraryIndex, listLibrary, putLibrary, patchLibrary, deleteLibrary } from './libraryStore.mjs'
import { loadImageMeta, listImageMeta, patchImageMeta } from './imageMetaStore.mjs'
import {
  loadVoiceLibraryIndex, listVoiceLibrary, putVoiceLibrary, patchVoiceLibrary, deleteVoiceLibrary,
} from './voiceLibraryStore.mjs'

const PORT = Number(process.env.PE_API_PORT || process.env.PORT || 8787)
const MAX_BODY = 200 * 1024 * 1024 // one entry with a base64 video can be large

ensureTree()
loadIndex()
loadQueueIndex()
loadLibraryIndex()
loadVoiceLibraryIndex()
loadImageMeta()

const json = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}
const noContent = (res) => { res.writeHead(204); res.end() }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve(null)
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)) }
    })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const t0 = Date.now()
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const seg = path.split('/').filter(Boolean) // ['api', 'history', ':id']
  const method = req.method

  try {
    // ── blobs ──────────────────────────────────────────────────────────────
    if (seg[0] === 'api' && seg[1] === 'blob' && seg[2] && method === 'GET') {
      const blob = getBlob(decodeURIComponent(seg[2]))
      if (!blob) { json(res, 404, { error: 'no such blob' }); return }
      res.writeHead(200, {
        'content-type': blob.mediaType,
        'content-length': blob.buf.length,
        'cache-control': 'public, max-age=31536000, immutable',
        etag: `"${seg[2]}"`,
      })
      res.end(blob.buf)
      return
    }

    if (seg[0] === 'api' && seg[1] === 'health' && method === 'GET') {
      json(res, 200, { ok: true, entries: historyCount() }); return
    }

    // ── history ────────────────────────────────────────────────────────────
    if (seg[0] === 'api' && seg[1] === 'history') {
      // /api/history/clear
      if (seg[2] === 'clear' && method === 'POST') {
        json(res, 200, { ok: true, moved: clearHistory() }); return
      }
      // /api/history
      if (!seg[2]) {
        if (method === 'GET') { json(res, 200, listHistory()); return }
      } else {
        const id = decodeURIComponent(seg[2])
        if (method === 'GET') {
          const e = getHistory(id, { inline: url.searchParams.get('inline') === '1' })
          if (!e) { json(res, 404, { error: 'not found' }); return }
          json(res, 200, e); return
        }
        if (method === 'PUT') {
          const entry = await readBody(req)
          if (!entry || entry.id !== id) { json(res, 400, { error: 'body id must match path' }); return }
          json(res, 200, { id: putHistory(entry) }); return
        }
        if (method === 'PATCH') {
          const patch = await readBody(req)
          patchHistory(id, patch || {}) // no-op if gone — matches old contract
          json(res, 200, { id }); return
        }
        if (method === 'DELETE') { deleteHistory(id); json(res, 200, { ok: true }); return }
      }
    }

    // ── queue ──────────────────────────────────────────────────────────────
    if (seg[0] === 'api' && seg[1] === 'queue') {
      // /api/queue/clear
      if (seg[2] === 'clear' && method === 'POST') {
        json(res, 200, { ok: true, moved: clearQueue() }); return
      }
      // /api/queue
      if (!seg[2]) {
        if (method === 'GET') { json(res, 200, listQueue()); return }
      } else {
        const id = decodeURIComponent(seg[2])
        if (method === 'GET') {
          const e = getQueue(id, { inline: url.searchParams.get('inline') === '1' })
          if (!e) { json(res, 404, { error: 'not found' }); return }
          json(res, 200, e); return
        }
        if (method === 'PUT') {
          const item = await readBody(req)
          if (!item || item.id !== id) { json(res, 400, { error: 'body id must match path' }); return }
          json(res, 200, { id: putQueue(item) }); return
        }
        if (method === 'PATCH') {
          const patch = await readBody(req)
          patchQueue(id, patch || {}) // no-op if gone
          json(res, 200, { id }); return
        }
        if (method === 'DELETE') { deleteQueue(id); json(res, 200, { ok: true }); return }
      }
    }

    // ── library ────────────────────────────────────────────────────────────
    // Standalone reusable images, not tied to any generation — see
    // libraryStore.mjs. No /clear route for v1: nothing bulk-clears the
    // library today. PATCH is for role/captions only (see patchLibrary) —
    // items are otherwise only ever created whole (a dropped file) or
    // removed whole.
    if (seg[0] === 'api' && seg[1] === 'library') {
      if (!seg[2]) {
        if (method === 'GET') { json(res, 200, listLibrary()); return }
      } else {
        const id = decodeURIComponent(seg[2])
        if (method === 'PUT') {
          const item = await readBody(req)
          if (!item || item.id !== id) { json(res, 400, { error: 'body id must match path' }); return }
          json(res, 200, { id: putLibrary(item) }); return
        }
        if (method === 'PATCH') {
          const patch = await readBody(req)
          patchLibrary(id, patch || {}) // no-op if gone — matches history/queue's contract
          json(res, 200, { id }); return
        }
        if (method === 'DELETE') { deleteLibrary(id); json(res, 200, { ok: true }); return }
      }
    }

    // ── image meta ─────────────────────────────────────────────────────────
    // One role + per-role descriptions record per image, keyed by content hash
    // — see imageMetaStore.mjs. GET returns the whole map (small: text only).
    if (seg[0] === 'api' && seg[1] === 'image-meta') {
      if (!seg[2]) {
        if (method === 'GET') { json(res, 200, listImageMeta()); return }
      } else if (method === 'PATCH') {
        const hash = decodeURIComponent(seg[2])
        const patch = await readBody(req)
        json(res, 200, patchImageMeta(hash, patch || {})); return
      }
    }

    // ── voice library ──────────────────────────────────────────────────────
    // Standalone reusable voice-timbre samples — see voiceLibraryStore.mjs.
    // Same route shape as /api/library; no /clear route for v1.
    if (seg[0] === 'api' && seg[1] === 'voice-library') {
      if (!seg[2]) {
        if (method === 'GET') { json(res, 200, listVoiceLibrary()); return }
      } else {
        const id = decodeURIComponent(seg[2])
        if (method === 'PUT') {
          const item = await readBody(req)
          if (!item || item.id !== id) { json(res, 400, { error: 'body id must match path' }); return }
          json(res, 200, { id: putVoiceLibrary(item) }); return
        }
        if (method === 'PATCH') {
          const patch = await readBody(req)
          patchVoiceLibrary(id, patch || {})
          json(res, 200, { id }); return
        }
        if (method === 'DELETE') { deleteVoiceLibrary(id); json(res, 200, { ok: true }); return }
      }
    }

    // ── projects ───────────────────────────────────────────────────────────
    if (seg[0] === 'api' && seg[1] === 'projects' && !seg[2]) {
      if (method === 'GET') { json(res, 200, loadProjects()); return }
      if (method === 'PUT') { json(res, 200, saveProjects(await readBody(req))); return }
    }

    // ── captions ───────────────────────────────────────────────────────────
    if (seg[0] === 'api' && seg[1] === 'captions') {
      if (seg[2] === 'clear' && method === 'POST') { json(res, 200, { ok: true, moved: clearCaptions() }); return }
      if (seg[2]) {
        const key = decodeURIComponent(seg[2])
        if (method === 'GET') { json(res, 200, { caption: getCaption(key) }); return }
        if (method === 'PUT') {
          const b = await readBody(req)
          if (b && typeof b.caption === 'string') putCaption(key, b.caption)
          noContent(res); return
        }
      }
    }

    // ── import / export ────────────────────────────────────────────────────
    if (seg[0] === 'api' && seg[1] === 'import' && !seg[2] && method === 'POST') {
      const b = await readBody(req)
      const entries = Array.isArray(b) ? b : (b?.entries || [])
      let imported = 0, skipped = 0
      for (const e of entries) {
        if (!e || !e.id) { skipped++; continue }
        if (getHistory(e.id)) { skipped++; continue }
        try { putHistory(e); imported++ } catch (err) { console.error(`[import] ${e.id}: ${err.message}`); skipped++ }
      }
      if (b && b.captions && typeof b.captions === 'object') {
        for (const [k, v] of Object.entries(b.captions)) {
          const cap = typeof v === 'string' ? v : v?.caption
          if (typeof cap === 'string') putCaption(k, cap)
        }
      }
      json(res, 200, { imported, skipped }); return
    }

    if (seg[0] === 'api' && seg[1] === 'export' && !seg[2] && method === 'GET') {
      const inline = url.searchParams.get('inline') === '1'
      const list = listHistory().map((meta) => getHistory(meta.id, { inline }))
      json(res, 200, list); return
    }

    json(res, 404, { error: `no route for ${method} ${path}` })
  } catch (err) {
    console.error(`[api] ${method} ${path} → ${err.message}`)
    json(res, 500, { error: err.message })
  } finally {
    console.log(`[api] ${method} ${path} ${res.statusCode} ${Date.now() - t0}ms`)
  }
})

server.listen(PORT, () => console.log(`[api] prompt-enhancer history server on http://localhost:${PORT}`))

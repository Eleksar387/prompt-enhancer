// node server/smoke.mjs  — exercises the store layer against a throwaway data dir.
// Set PE_DATA_DIR to an empty/scratch path first, e.g.
//   PE_DATA_DIR=/tmp/pe-smoke node server/smoke.mjs
import assert from 'node:assert'
import { rmSync } from 'node:fs'
import { DATA_DIR, ensureTree } from './paths.mjs'
import {
  loadIndex, listHistory, getHistory, putHistory, patchHistory,
  deleteHistory, clearHistory, historyCount,
  saveProjects, loadProjects, putCaption, getCaption,
} from './store.mjs'

if (!process.env.PE_DATA_DIR || !DATA_DIR.includes('smoke')) {
  console.error('refusing to run: point PE_DATA_DIR at a scratch path containing "smoke"')
  process.exit(1)
}
rmSync(DATA_DIR, { recursive: true, force: true })
ensureTree(); loadIndex()

// projects
saveProjects(['Alpha', 'Beta', '', '  '])
assert.deepEqual(loadProjects(), ['Alpha', 'Beta'])

// captions — one file per key
putCaption('v2|model|s:abc|i:xyz', 'a described frame')
assert.equal(getCaption('v2|model|s:abc|i:xyz'), 'a described frame')

// entry with an inline blob → split, deduped
const img = { base64: Buffer.from('PNGDATA').toString('base64'), mediaType: 'image/png', fileName: 'f.png' }
putHistory({ id: 'e1', ts: 10, type: 'standard', scene: 'x', firstImg: img, lastImg: { ...img } })
putHistory({ id: 'e2', ts: 20, type: 'standard', scene: 'y', refImages: [{ ...img, role: 'character' }] })

const list = listHistory()
assert.equal(list.length, 2)
assert.equal(list[0].id, 'e2', 'newest first')
assert.ok(list[0].refImages[0].url.startsWith('/api/blob/'), 'blob node carries url')
assert.ok(!list[0].refImages[0].base64, 'no bytes in list')

const inline = getHistory('e1', { inline: true })
assert.equal(inline.firstImg.base64, img.base64, 'round-trips byte-identical')
assert.equal(inline.firstImg.bytesKey, undefined, 'bytesKey stripped on read')

// PATCH: shallow-merge, may carry new blobs; missing id = no-op
patchHistory('e1', { outputs: [{ label: 'o', text: 't', images: [{ b64: Buffer.from('RENDER').toString('base64'), mediaType: 'image/png' }] }] })
const patched = getHistory('e1', { inline: true })
assert.equal(patched.scene, 'x', 'existing field kept')
assert.equal(patched.outputs[0].images[0].b64, Buffer.from('RENDER').toString('base64'))
assert.equal(patchHistory('ghost', { x: 1 }), null, 'patch on missing id is a no-op')

// delete + clear are soft
deleteHistory('e2')
assert.equal(historyCount(), 1)
const moved = clearHistory()
assert.equal(moved, 1)
assert.equal(historyCount(), 0)
assert.deepEqual(listHistory(), [])

// re-load from disk: index is derived, trash is not re-indexed
loadIndex()
assert.equal(historyCount(), 0, 'trashed entries do not come back on reload')

console.log('OK — all store smoke checks passed')

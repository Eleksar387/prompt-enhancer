// CLI: node server/import.mjs <file.json> [<file2.json> ...]
//
// Bulk-load a JSON array of history entries straight into the on-disk store,
// bypassing the browser (a 34 MB recovered file would choke an HTTP request).
// Idempotent on `id` — re-running, or importing overlapping files, is safe.

import { readFileSync } from 'node:fs'
import { ensureTree } from './paths.mjs'
import { loadIndex, getHistory, putHistory, putCaption } from './store.mjs'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('usage: node server/import.mjs <file.json> [...]')
  process.exit(1)
}

ensureTree()
loadIndex()

let imported = 0, skipped = 0, failed = 0

for (const file of files) {
  let data
  try { data = JSON.parse(readFileSync(file, 'utf8')) }
  catch (e) { console.error(`✗ ${file}: ${e.message}`); failed++; continue }

  const entries = Array.isArray(data) ? data : (data.entries || [])
  const captions = (!Array.isArray(data) && data.captions) || null

  for (const e of entries) {
    if (!e || !e.id) { skipped++; continue }
    if (getHistory(e.id)) { skipped++; continue }
    try { putHistory(e); imported++ }
    catch (err) { console.error(`  ✗ entry ${e.id}: ${err.message}`); failed++ }
  }
  if (captions) {
    for (const [k, v] of Object.entries(captions)) {
      const cap = typeof v === 'string' ? v : v?.caption
      if (typeof cap === 'string') putCaption(k, cap)
    }
  }
  console.log(`✓ ${file}: ${entries.length} entries read`)
}

console.log(`\ndone — imported ${imported}, skipped ${skipped} (already present), failed ${failed}`)
process.exit(failed ? 1 : 0)

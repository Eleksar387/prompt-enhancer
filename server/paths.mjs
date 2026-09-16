import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs'
import { openSync, fsyncSync, closeSync } from 'node:fs'

// Data lives OUTSIDE the repo so `git clean -fdx` and project-folder tidying
// can't wipe it (that has happened twice). Override with PE_DATA_DIR.
export const DATA_DIR = resolve(process.env.PE_DATA_DIR || join(homedir(), '.prompt-enhancer-data'))

export const DIRS = {
  data: DATA_DIR,
  entries: join(DATA_DIR, 'entries'),
  blobs: join(DATA_DIR, 'blobs'),
  captions: join(DATA_DIR, 'captions'),
  queue: join(DATA_DIR, 'queue'),
  trash: join(DATA_DIR, 'trash'),
  tmp: join(DATA_DIR, 'tmp'),
}

export const PROJECTS_FILE = join(DATA_DIR, 'projects.json')

// Create the tree on boot; wipe leftover tmp scratch from a previous crash.
export function ensureTree() {
  for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true })
  try {
    for (const f of readdirSync(DIRS.tmp)) rmSync(join(DIRS.tmp, f), { recursive: true, force: true })
  } catch { /* fresh tree */ }
}

let tmpSeq = 0

// write → fsync → rename. rename is atomic within one filesystem, so a reader
// (or a crash) never sees a half-written file; DIRS.tmp is under DATA_DIR so the
// rename stays on-device.
export function atomicWrite(finalPath, data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const tmp = join(DIRS.tmp, `w-${process.pid}-${Date.now()}-${tmpSeq++}`)
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, buf)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, finalPath)
}

const DB_NAME = 'prompt-enhancer'
const DB_VERSION = 1
const STORE = 'history'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('ts', 'ts', { unique: false })
      }
    }
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function getAllHistory() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).index('ts').getAll()
    req.onsuccess = (e) => resolve([...e.target.result].reverse())
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function addHistoryEntry(entry) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).put(entry)
    req.onsuccess = () => resolve()
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function deleteHistoryEntry(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).delete(id)
    req.onsuccess = () => resolve()
    req.onerror = (e) => reject(e.target.error)
  })
}

export async function clearHistory() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).clear()
    req.onsuccess = () => resolve()
    req.onerror = (e) => reject(e.target.error)
  })
}

export function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Reassign a single history entry to a project (or null to unfile it).
// Read-modify-write so it works on entries that were saved before projects existed.
export async function setHistoryEntryProject(id, project) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const req = store.get(id)
    req.onsuccess = () => {
      const entry = req.result
      if (!entry) { resolve(); return }
      entry.project = project || null
      const put = store.put(entry)
      put.onsuccess = () => resolve()
      put.onerror = (e) => reject(e.target.error)
    }
    req.onerror = (e) => reject(e.target.error)
  })
}

// The project list is small metadata (names only) — localStorage is a better fit
// than IndexedDB and keeps empty projects (no generations yet) alive across reloads.
const PROJECTS_KEY = 'prompt-enhancer-projects'

export function loadProjects() {
  try {
    const arr = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]')
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim()) : []
  } catch { return [] }
}

export function saveProjects(list) {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(list)) } catch {}
}

export async function migrateFromLocalStorage() {
  try {
    const raw = localStorage.getItem('gen-history')
    if (!raw) return
    const items = JSON.parse(raw)
    if (!Array.isArray(items) || items.length === 0) {
      localStorage.removeItem('gen-history')
      return
    }
    for (const item of items) {
      await addHistoryEntry({
        ...item,
        id: item.id || generateId(),
        type: item.type || 'standard',
      })
    }
    localStorage.removeItem('gen-history')
  } catch {}
}

// The "generate this later" queue: its state, its CRUD, and the run bookkeeping
// every kind of queued job shares.
//
// There are two kinds of job — a main-pipeline generation (replay a snapshot into
// the workspace, then run the writer) and a Full Auto Scriptwriter film (mount a
// fresh panel and let it chain its three phases) — and they were two ~30-line
// functions in App that differed only in the middle. Everything around that middle
// is identical and easy to get subtly wrong: mark running, re-read, run, delete on
// success or record the error and bump the attempt count, clear running, re-read.
//
// So `runOne(id, execute)` owns the bookkeeping and takes the middle as a
// callback. The callbacks stay in App, because they are the ones that need App's
// whole pipeline; nothing in here knows what a job actually does.

import { useCallback, useRef, useState } from 'react'
import {
  listQueue, getQueueItem, addQueueItem, updateQueueItem, deleteQueueItem,
  clearQueue as dbClearQueue,
} from '../db'

export function useQueue() {
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)          // a processAll loop is running
  const [runningId, setRunningId] = useState(null)

  // Refs mirror the state for the async paths: a runner started several awaits ago
  // must read today's queue and today's busy flag, not the ones captured when its
  // closure was created.
  const itemsRef = useRef([])
  itemsRef.current = items
  const busyRef = useRef(false)
  const abortRef = useRef(false)                   // Stop pressed mid-loop

  // A failed queue load leaves the panel empty or stale on purpose: it must not
  // raise the "history server unreachable" banner, which is about writes.
  const refresh = useCallback(() => listQueue().then(q => { setItems(q); itemsRef.current = q }).catch(() => {}), [])

  const add = useCallback((item) => { addQueueItem(item).then(refresh).catch(() => {}) }, [refresh])
  const remove = useCallback((id) => deleteQueueItem(id).then(refresh), [refresh])
  const clear = useCallback(() => dbClearQueue().then(refresh), [refresh])
  const toggleOpen = useCallback(() => setOpen(v => !v), [])

  // Run one item. `execute(fullItem)` does the actual work and returns
  // { ok } / { ok: false, error }; anything it throws is caught and recorded the
  // same way. A successful item is deleted — its result now lives in history.
  const runOne = useCallback(async (id, execute) => {
    setRunningId(id)
    await updateQueueItem(id, { status: 'running' }).catch(() => {})
    refresh()

    let outcome
    try {
      const full = await getQueueItem(id, { inline: true })
      if (!full) throw new Error('queue item not found')
      outcome = await execute(full)
    } catch (e) {
      outcome = { ok: false, error: e.message }
    }

    if (outcome?.ok) {
      await deleteQueueItem(id).catch(() => {})
    } else {
      const prevAttempts = itemsRef.current.find(q => q.id === id)?.attempts || 0
      await updateQueueItem(id, {
        status: 'error',
        error: outcome?.error || 'unknown error',
        attempts: prevAttempts + 1,
      }).catch(() => {})
    }
    setRunningId(null)
    refresh()
    return outcome
  }, [refresh])

  // Drain the queue, re-reading it from the server on every iteration rather than
  // walking a captured array, so an item removed mid-run is skipped instead of
  // still being processed. `dispatch(id)` routes one item to its runner.
  const processAll = useCallback(async (dispatch) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    abortRef.current = false
    try {
      while (!abortRef.current) {
        const fresh = await listQueue().catch(() => [])
        const next = fresh.find(q => q.status !== 'running')
        if (!next) break
        await dispatch(next.id)
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  const stop = useCallback(() => { abortRef.current = true }, [])

  return {
    items, open, setOpen, toggleOpen, busy, runningId,
    refresh, add, remove, clear, runOne, processAll, stop,
    find: (id) => itemsRef.current.find(q => q.id === id),
  }
}

// The history list's five filters, plus the derived option lists and the
// filtered result — one hook instead of five useState slots and four useMemos
// sitting in App.
//
// Why it is a hook and not just state in App: the filter values are read by
// exactly one subtree (the history panel), and everything it returns is either a
// stable callback or a memoized value, so the panel can sit behind React.memo and
// stop repainting 70-odd cards every time someone types in the compose column.

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  HISTORY_FILTER_DEFAULTS, historyFiltersActive, entryMatchesFilters,
  entrySearchText, entryTargetId, entryTargetLabel, modelFilterLabel,
} from '../history'

export function useHistoryFilters(history) {
  const [filters, setFilters] = useState(HISTORY_FILTER_DEFAULTS)

  const setFilter = useCallback((name, value) => {
    setFilters(prev => (prev[name] === value ? prev : { ...prev, [name]: value }))
  }, [])
  const resetFilters = useCallback(() => setFilters(HISTORY_FILTER_DEFAULTS), [])

  // A project that gets renamed or deleted must not leave the list pinned to a
  // name that no longer exists. `to = null` (delete) falls back to "all".
  const retargetProjectFilter = useCallback((from, to) => {
    setFilters(prev => (prev.project === from ? { ...prev, project: to || 'all' } : prev))
  }, [])

  // Per-entry search haystack, cached by entry id and built on first use. Keyed by
  // id rather than by object so a single-entry history sync only invalidates that
  // entry; the cached text is reused for the other seventy.
  const cacheRef = useRef(new Map())
  const searchTextFor = useCallback((h) => {
    const cached = cacheRef.current.get(h.id)
    if (cached && cached.entry === h) return cached.text
    const text = entrySearchText(h)
    cacheRef.current.set(h.id, { entry: h, text })
    return text
  }, [])

  const targets = useMemo(() => {
    const s = new Set(history.map(entryTargetId).filter(Boolean))
    return [...s].sort((a, b) => entryTargetLabel(a).localeCompare(entryTargetLabel(b)))
  }, [history])

  const models = useMemo(() => {
    const s = new Set(history.map(h => h.model).filter(Boolean))
    return [...s].sort((a, b) => modelFilterLabel(a).localeCompare(modelFilterLabel(b)))
  }, [history])

  const visible = useMemo(
    () => history.filter(h => entryMatchesFilters(h, filters, searchTextFor)),
    [history, filters, searchTextFor],
  )

  return {
    filters, setFilter, resetFilters, retargetProjectFilter,
    visible, targets, models, active: historyFiltersActive(filters),
  }
}

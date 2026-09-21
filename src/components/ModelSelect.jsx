import { useState, useMemo, memo } from 'react'
import { selStyle } from '../utils'

const FILTER_THRESHOLD = 8

// A plain <select> is hard to scan once a provider lists dozens or hundreds of models
// (OpenRouter especially). Above FILTER_THRESHOLD options this adds a small text box
// that narrows the <select> to models whose name contains the typed substring —
// no fuzzy matching, no custom dropdown/keyboard handling, just <select> plus a filter.
function ModelSelect({ models, value, onChange, style }) {
  const [filter, setFilter] = useState('')

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return models
    return models.filter(m => m.toLowerCase().includes(q))
  }, [models, filter])

  // The current value must stay a real <option> even when it's filtered out —
  // otherwise typing a search term would silently blank/change the selection.
  const options = value && !filtered.includes(value) ? [value, ...filtered] : filtered

  return (
    <div>
      {models.length > FILTER_THRESHOLD && (
        <input
          style={{ ...selStyle, ...style, cursor: 'text', marginBottom: 6 }}
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter models…"
          spellCheck={false}
        />
      )}
      <select style={{ ...selStyle, ...style }} value={value} onChange={onChange}>
        {options.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
    </div>
  )
}

export default memo(ModelSelect)

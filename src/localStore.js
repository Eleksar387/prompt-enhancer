// One localStorage-backed store, made four times.
//
// `loadCfg`/`saveCfg` (api.js), `loadComfyCfg`/`saveComfyCfg` (comfy.js),
// `loadLoras`/`saveLoras` (loras.js) and the legacy project list (db.idb.js) were
// four copies of the same try/catch — the comment on the LoRA one literally said
// it "mirrors loadComfyCfg/saveComfyCfg". Adding another persisted setting meant
// copying it a fifth time.
//
// The rules every copy had, kept here once:
//   * a read must never throw. Private-mode browsers, blocked site data and
//     cleared storage all make localStorage raise rather than return null, and
//     this runs during a useState initializer — a throw here is a blank app.
//   * unparseable or wrong-shaped stored data degrades to the default rather than
//     reaching the UI, because the stored value predates any given app version.
//   * a write must never throw either (quota).
//
// Deliberately NOT a hook: these loaders are called from useState initializers
// and also from plain module code (ScriptwriterPanel falls back to its own
// comfy config when App doesn't pass one), where hooks are not available.

// `defaults` shallow-merges under the stored object — the common case, so a
// setting added later appears with its default on an old stored config.
// `parse` takes over completely when the shape needs validating (a list, say).
export function makeLocalStore(key, { defaults = null, parse = null } = {}) {
  const read = () => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }

  const load = () => {
    const saved = read()
    if (parse) return parse(saved)
    return defaults ? { ...defaults, ...(saved || {}) } : saved
  }

  const save = (value) => {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota / blocked */ }
  }

  return { key, load, save }
}

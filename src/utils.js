import { CAMERA_GROUPS } from './constants'

export const presetById = (id, presets) => presets.find(p => p.id === id)

export const snap32 = (n) => Math.round(n / 32) * 32

export const btn = (active) => ({
  padding: '6px 14px', borderRadius: 6, border: '1px solid',
  borderColor: active ? '#7c6af7' : '#333',
  background: active ? '#2d2060' : '#1a1a2e',
  color: active ? '#c4b8ff' : '#888',
  fontSize: 12, cursor: 'pointer', transition: 'all 0.15s',
})

export const selStyle = {
  width: '100%', boxSizing: 'border-box', background: '#12121f',
  border: '1px solid #2e2e44', borderRadius: 8, padding: '9px 12px',
  color: '#e0e0f0', fontSize: 13, outline: 'none', cursor: 'pointer',
}

export const moveLabel = (id) =>
  CAMERA_GROUPS.flatMap(g => g.moves).find(m => m.id === id)?.label || id

export function recommendRes(nw, nh, presets) {
  const r = nw / nh
  let best = null, bestScore = Infinity
  for (const p of presets) {
    const aspectDiff = Math.abs(Math.log(r / p.ratio))
    const cropW = r > p.ratio ? nh * p.ratio : nw
    const upscale = p.w > cropW + 1
    let score = aspectDiff * 100 + (upscale ? 10 : 0)
    score += upscale ? p.w * 1e-5 : -p.w * 1e-5
    if (score < bestScore) { bestScore = score; best = p }
  }
  return best.id
}

export function ratioLabel(r) {
  const known = [[16/9,'16:9'],[9/16,'9:16'],[3/2,'3:2'],[2/3,'2:3'],[4/3,'4:3'],[3/4,'3:4'],[1,'1:1'],[21/9,'21:9'],[5/4,'5:4']]
  let best = '', d = Infinity
  for (const [v, l] of known) { const diff = Math.abs(Math.log(r / v)); if (diff < d) { d = diff; best = l } }
  return best
}

import { useState, useRef, useEffect } from 'react'
import { presetById, snap32, btn, recommendRes, ratioLabel } from '../utils'
import { hasDragImage, takeDragImage } from '../imageDrag'

export default function ImagePanel({ label, hint, onChange, presets, showTwoStage, presetNote, seed }) {
  const [image, setImage]           = useState(null)
  const [targetRes, setTargetRes]   = useState(presets[1] ? presets[1].id : presets[0].id)
  const [cropOpen, setCropOpen]     = useState(false)
  const [cropPos, setCropPos]       = useState(0.5)
  const [croppedUrl, setCroppedUrl] = useState(null)
  const [croppedDims, setCroppedDims] = useState(null)
  const [dragOver, setDragOver]     = useState(false)
  const fileInputRef = useRef(null)

  const loadFile = (file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        const nativeW = img.naturalWidth, nativeH = img.naturalHeight
        const MAX = 1536
        let w = img.width, h = img.height
        if (w > MAX || h > MAX) {
          if (w >= h) { h = Math.round(h * MAX / w); w = MAX }
          else { w = Math.round(w * MAX / h); h = MAX }
        }
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        let dataUrl = canvas.toDataURL('image/jpeg', 0.85)
        if (dataUrl.length * 0.75 > 4 * 1024 * 1024) dataUrl = canvas.toDataURL('image/jpeg', 0.7)
        const obj = {
          base64: dataUrl.split(',')[1], mediaType: 'image/jpeg',
          previewUrl: dataUrl, originalUrl: e.target.result,
          nativeW, nativeH, fileName: file.name,
        }
        setImage(obj)
        setTargetRes(recommendRes(nativeW, nativeH, presets))
        setCropPos(0.5)
        onChange?.(obj)
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  }

  // Load an image we already have as base64 (dragged/picked from history) — no
  // resize/re-encode; it was already normalised when first loaded.
  const loadFromData = (d) => {
    if (!d?.base64) return
    const dataUrl = `data:${d.mediaType || 'image/jpeg'};base64,${d.base64}`
    const img = new Image()
    img.onload = () => {
      const obj = {
        base64: d.base64, mediaType: d.mediaType || 'image/jpeg',
        previewUrl: dataUrl, originalUrl: dataUrl,
        nativeW: img.naturalWidth, nativeH: img.naturalHeight,
        fileName: d.fileName || 'from-history.jpg',
      }
      setImage(obj)
      setTargetRes(recommendRes(img.naturalWidth, img.naturalHeight, presets))
      setCropPos(0.5)
      onChange?.(obj)
    }
    img.src = dataUrl
  }

  useEffect(() => {
    if (seed && seed.data) loadFromData(seed.data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce])

  const onFileChange = (e) => loadFile(e.target.files[0])
  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false)
    if (hasDragImage(e.dataTransfer)) { const d = takeDragImage(); if (d) loadFromData(d); return }
    const f = e.dataTransfer.files[0]
    if (f?.type.startsWith('image/')) loadFile(f)
  }
  const onDragOver = (e) => {
    if (hasDragImage(e.dataTransfer) || (e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault(); setDragOver(true)
    }
  }
  const onDragLeave = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }
  const removeImage = () => {
    setImage(null); setCroppedUrl(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    onChange?.(null)
  }

  const selPreset = presetById(targetRes, presets) || presets[0]
  const imgRatio = image ? image.nativeW / image.nativeH : null
  const resMismatch = image && Math.abs(Math.log(imgRatio / selPreset.ratio)) > 0.08
  const halfW = snap32(selPreset.w / 2), halfH = snap32(selPreset.h / 2)
  const cropAxis = !image ? 'none'
    : Math.abs(imgRatio - selPreset.ratio) < 1e-3 ? 'none'
    : imgRatio > selPreset.ratio ? 'x' : 'y'
  const keepWPct = image && cropAxis === 'x' ? (selPreset.ratio / imgRatio) * 100 : 100
  const keepHPct = image && cropAxis === 'y' ? (imgRatio / selPreset.ratio) * 100 : 100
  const offXPct = cropPos * (100 - keepWPct)
  const offYPct = cropPos * (100 - keepHPct)
  const cropAvailW = image ? (imgRatio > selPreset.ratio ? image.nativeH * selPreset.ratio : image.nativeW) : 0
  const wouldUpscale = image && selPreset.w > cropAvailW + 1
  const outW = wouldUpscale ? snap32(cropAvailW) : selPreset.w
  const outH = wouldUpscale ? snap32(cropAvailW / selPreset.ratio) : selPreset.h

  const exportCrop = () => {
    if (!image) return
    const im = new Image()
    im.onload = () => {
      const tR = selPreset.ratio
      const NW = image.nativeW, NH = image.nativeH, nR = NW / NH
      let sx = 0, sy = 0, sw = NW, sh = NH
      if (nR > tR) { sw = Math.round(NH * tR); sx = Math.round((NW - sw) * cropPos) }
      else if (nR < tR) { sh = Math.round(NW / tR); sy = Math.round((NH - sh) * cropPos) }
      const c = document.createElement('canvas')
      c.width = outW; c.height = outH
      c.getContext('2d').drawImage(im, sx, sy, sw, sh, 0, 0, outW, outH)
      c.toBlob(b => {
        if (b) { setCroppedDims({ w: outW, h: outH }); setCroppedUrl(URL.createObjectURL(b)) }
      }, 'image/png')
    }
    im.src = image.originalUrl
  }

  useEffect(() => {
    setCroppedUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    setCroppedDims(null)
  }, [cropPos, targetRes, image])

  const lbl = { fontSize: 11, color: '#777', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={lbl}>
        {label}{' '}
        {hint && <span style={{ color: '#555', textTransform: 'none', letterSpacing: 0 }}>{hint}</span>}
      </label>

      {image ? (
        <>
          <div
            onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
            style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', background: '#12121f', border: `1px solid ${dragOver ? '#7c6af7' : '#3a2f6e'}`, borderRadius: 8, transition: 'border-color 0.15s' }}>
            <img src={image.previewUrl} alt="ref" style={{ width: 72, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid #2e2e44' }} />
            <div style={{ flex: 1, fontSize: 12, color: '#888' }}>{label} loaded · <span style={{ color: '#666' }}>{image.fileName}</span>{dragOver ? ' · drop to replace' : ''}</div>
            <button onClick={removeImage} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #3a2040', background: '#1e1020', color: '#f87171', fontSize: 11, cursor: 'pointer' }}>Remove</button>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: '#6f7a92' }}>👁 Read by your Vision model at generate time, then handed to the Writer.</div>

          <div style={{ marginTop: 12, background: '#0e0e1c', border: '1px solid #2e2e44', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
              Detected <span style={{ color: '#c4b8ff', fontWeight: 600 }}>{image.nativeW}×{image.nativeH}</span> · {ratioLabel(imgRatio)}
            </div>
            <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>Target resolution</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {presets.map(p => {
                const active = targetRes === p.id
                const rec = recommendRes(image.nativeW, image.nativeH, presets) === p.id
                const pCropW = imgRatio > p.ratio ? image.nativeH * p.ratio : image.nativeW
                const pUp = p.w > pCropW + 1
                return (
                  <button key={p.id} onClick={() => setTargetRes(p.id)} title={pUp ? `${p.note} — larger than your source, would upscale` : p.note}
                    style={{ ...btn(active), display: 'flex', alignItems: 'center', gap: 6 }}>
                    {p.label}
                    {rec && <span style={{ fontSize: 9, color: active ? '#c4b8ff' : '#6a5acf', border: '1px solid', borderColor: active ? '#7c6af7' : '#3a3060', borderRadius: 8, padding: '0 5px' }}>best fit</span>}
                    {pUp && <span title="would upscale your source" style={{ fontSize: 11, color: active ? '#e0a0a0' : '#9a6a6a' }}>↑</span>}
                  </button>
                )
              })}
            </div>

            {resMismatch && (
              <div style={{ marginTop: 12, fontSize: 11.5, color: '#f0b070', background: '#241a0e', border: '1px solid #4a3520', borderRadius: 6, padding: '8px 11px', lineHeight: 1.5 }}>
                Your image is {ratioLabel(imgRatio)} but {selPreset.label} is {ratioLabel(selPreset.ratio)} — it will be cropped or letterboxed. Pick the matching aspect ratio to avoid this.
              </div>
            )}

            {presetNote ? (
              <div style={{ marginTop: 12, fontSize: 11.5, color: '#666', lineHeight: 1.6 }}>{presetNote}</div>
            ) : showTwoStage ? (
              <div style={{ marginTop: 12, fontSize: 11.5, color: '#666', lineHeight: 1.6 }}>
                <span style={{ color: '#888' }}>Two-stage render workflow:</span> Stage 1 at{' '}
                <span style={{ color: '#9a8fd8' }}>{halfW}×{halfH}</span> (half-res), then 2× upscale with LTXVUpscale to{' '}
                <span style={{ color: '#9a8fd8' }}>{selPreset.w}×{selPreset.h}</span>. Dimensions must be divisible by 32.
              </div>
            ) : (
              <div style={{ marginTop: 12, fontSize: 11.5, color: '#666', lineHeight: 1.6 }}>
                These presets are the model's recommended sizes — FLUX.1-dev is trained around ~1 megapixel, dimensions are multiples of 32.
              </div>
            )}

            <div style={{ marginTop: 14, borderTop: '1px solid #1e1e30', paddingTop: 12 }}>
              <button onClick={() => setCropOpen(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#888', fontSize: 12 }}>
                <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: cropOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                ✂ Crop to {selPreset.label}
              </button>

              {cropOpen && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid #2e2e44', maxWidth: 360 }}>
                    <img src={image.previewUrl} alt="crop preview" style={{ display: 'block', width: '100%' }} />
                    {cropAxis === 'x' && (
                      <>
                        <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${offXPct}%`, background: 'rgba(8,8,16,0.72)' }} />
                        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${offXPct + keepWPct}%`, right: 0, background: 'rgba(8,8,16,0.72)' }} />
                        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${offXPct}%`, width: `${keepWPct}%`, border: '2px solid #7c6af7', boxSizing: 'border-box', pointerEvents: 'none' }} />
                      </>
                    )}
                    {cropAxis === 'y' && (
                      <>
                        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: `${offYPct}%`, background: 'rgba(8,8,16,0.72)' }} />
                        <div style={{ position: 'absolute', left: 0, right: 0, top: `${offYPct + keepHPct}%`, bottom: 0, background: 'rgba(8,8,16,0.72)' }} />
                        <div style={{ position: 'absolute', left: 0, right: 0, top: `${offYPct}%`, height: `${keepHPct}%`, border: '2px solid #7c6af7', boxSizing: 'border-box', pointerEvents: 'none' }} />
                      </>
                    )}
                  </div>

                  {cropAxis !== 'none' ? (
                    <div style={{ marginTop: 10 }}>
                      <label style={{ fontSize: 11, color: '#777' }}>{cropAxis === 'x' ? 'Horizontal position' : 'Vertical position'}</label>
                      <input type="range" min={0} max={1} step={0.01} value={cropPos}
                        onChange={e => setCropPos(parseFloat(e.target.value))}
                        style={{ width: '100%', maxWidth: 360, display: 'block', marginTop: 4 }} />
                    </div>
                  ) : (
                    <div style={{ marginTop: 10, fontSize: 11.5, color: '#666' }}>
                      Aspect ratio already matches — export resizes to {selPreset.w}×{selPreset.h}.
                    </div>
                  )}

                  {wouldUpscale && (
                    <div style={{ marginTop: 10, fontSize: 11.5, color: '#f0b070', background: '#241a0e', border: '1px solid #4a3520', borderRadius: 6, padding: '8px 11px', lineHeight: 1.5 }}>
                      {selPreset.label} is larger than your {image.nativeW}×{image.nativeH} source, so export is capped to {outW}×{outH} to avoid upscaling.
                    </div>
                  )}

                  <button onClick={exportCrop} style={{ marginTop: 12, padding: '8px 16px', borderRadius: 7, border: '1px solid #3a2f6e', background: '#1e1850', color: '#c4b8ff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                    ✂ Generate cropped {outW}×{outH}
                  </button>

                  {croppedUrl && croppedDims && (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>Result — {croppedDims.w}×{croppedDims.h}</div>
                      <img src={croppedUrl} alt="cropped result" style={{ maxWidth: 360, width: '100%', display: 'block', borderRadius: 8, border: '1px solid #3a2f6e' }} />
                      <a
                        href={croppedUrl}
                        download={`${label.replace(/\s+/g, '-').toLowerCase()}-${croppedDims.w}x${croppedDims.h}.png`}
                        style={{ display: 'inline-block', marginTop: 10, padding: '8px 16px', borderRadius: 7, border: '1px solid #3a2f6e', background: '#1e1850', color: '#c4b8ff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', textDecoration: 'none' }}
                      >
                        ⬇ Save PNG
                      </a>
                      <div style={{ fontSize: 11, color: '#666', marginTop: 8, lineHeight: 1.5 }}>
                        If the Save button doesn't download, right-click the image (or long-press on mobile) and choose "Save image as…".
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
          style={{ padding: '20px', borderRadius: 8, border: `1px dashed ${dragOver ? '#7c6af7' : '#2e2e44'}`, background: dragOver ? '#141130' : '#0e0e1c', textAlign: 'center', cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s' }}
          onMouseEnter={e => { if (!dragOver) { e.currentTarget.style.borderColor = '#5a4fcf'; e.currentTarget.style.background = '#12122a' } }}
          onMouseLeave={e => { if (!dragOver) { e.currentTarget.style.borderColor = '#2e2e44'; e.currentTarget.style.background = '#0e0e1c' } }}
        >
          <div style={{ fontSize: 22, marginBottom: 6 }}>🖼️</div>
          <div style={{ fontSize: 13, color: '#666' }}>Click or drag &amp; drop an image{seed !== undefined ? ', or drag one from history' : ''}</div>
          <div style={{ fontSize: 11, color: '#444', marginTop: 3 }}>JPG, PNG, WebP</div>
        </div>
      )}

      <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileChange} style={{ display: 'none' }} />
    </div>
  )
}

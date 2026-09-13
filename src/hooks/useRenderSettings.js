// The 🎨 / 🎬 render strip's settings — the knobs above the generated prompts that
// control what the image/video model is asked for.
//
// Nine state slots that nothing outside the results column reads. They sat in App
// among the compose-panel state, which made it look as though a prompt's own
// settings and its render settings were the same kind of thing; they are not — a
// render setting is never saved in history and never reaches the writer.
//
// The three handlers (renderImage / renderVideo / upscaleImage) deliberately stay
// in App: they read the live results array, patch the saved history entry and
// share its abort bookkeeping, so moving them here would mean passing half of App
// back in. This hook owns the settings, not the requests.

import { useEffect, useState } from 'react'

export function useRenderSettings(promptDuration) {
  // image
  const [imageAspect, setImageAspect] = useState('auto')      // GROK_IMAGE_RESOLUTIONS.ar
  const [imageCount, setImageCount] = useState(1)             // n, 1–4
  const [imageResolution, setImageResolution] = useState('1k')  // '1k' | '2k'

  // video
  const [videoDuration, setVideoDuration] = useState(8)       // seconds, 1–15
  const [videoResolution, setVideoResolution] = useState('720p')  // '480p' | '720p' | '1080p'
  const [videoAspect, setVideoAspect] = useState('auto')
  const [videoAudio, setVideoAudio] = useState(true)

  // Which provider to render with, consulted only when both an xAI key and a
  // Gemini key are configured.
  const [provider, setProvider] = useState('grok')            // 'grok' | 'gemini'

  // Per-image upscale state, keyed `${resultIndex}-${imageIndex}`.
  const [upStatus, setUpStatus] = useState({})                // 'loading' | { error }

  // Follow the prompt's own target duration ("8 seconds" → 8) so rendering a clip
  // defaults to the length the prompt was written for. Clamped to the API's 1–15.
  useEffect(() => {
    const m = String(promptDuration).match(/(\d+)\s*second/)
    if (m) setVideoDuration(Math.min(15, Math.max(1, parseInt(m[1], 10))))
  }, [promptDuration])

  return {
    imageAspect, setImageAspect, imageCount, setImageCount, imageResolution, setImageResolution,
    videoDuration, setVideoDuration, videoResolution, setVideoResolution,
    videoAspect, setVideoAspect, videoAudio, setVideoAudio,
    provider, setProvider, upStatus, setUpStatus,
  }
}

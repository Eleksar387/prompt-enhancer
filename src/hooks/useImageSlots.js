// The workspace's input images: the three frame slots, the MiniMax H3 reference
// list, its voice-timbre audio reference(s), and the "seed" handoff that loads a
// picked history thumbnail into a panel.
//
// Grouped because they move as a set. Switching target or frame mode has to clear
// all six at once, and that line — `setFirstImg(null); setMidImg(null);
// setLastImg(null); setRefImages([]); setRefAudios([])` plus the seed reset — was
// written out twice, in switchMode and switchTarget. Adding a seventh slot meant
// remembering both. Now it is `clearAll()`.

import { useCallback, useState } from 'react'

export function useImageSlots() {
  const [firstImg, setFirstImg] = useState(null)
  const [midImg, setMidImg] = useState(null)
  const [lastImg, setLastImg] = useState(null)
  const [refImages, setRefImages] = useState([])    // MiniMax H3 ref mode, up to 6
  const [refAudios, setRefAudios] = useState([])    // H3 voice-timbre reference(s), up to 2 (ref_audio_0/1)

  // Clicking a thumbnail in the history gallery can't just call setFirstImg: the
  // panel owns the decoded preview and the resolution preset, so it has to do the
  // loading itself. The seed carries the bytes plus a nonce the panel's effect
  // watches, so picking the same image twice still triggers a load.
  const [seeds, setSeeds] = useState({ first: null, mid: null, last: null })

  const bumpSeed = useCallback((slot, data) => {
    setSeeds(s => ({ ...s, [slot]: { data, nonce: (s[slot]?.nonce || 0) + 1 } }))
  }, [])

  const clearAll = useCallback(() => {
    setFirstImg(null)
    setMidImg(null)
    setLastImg(null)
    setRefImages([])
    setRefAudios([])
    setSeeds({ first: null, mid: null, last: null })
  }, [])

  return {
    firstImg, setFirstImg, midImg, setMidImg, lastImg, setLastImg,
    refImages, setRefImages, refAudios, setRefAudios,
    seeds, bumpSeed, clearAll,
  }
}

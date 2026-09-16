// Admin mode: see and edit the exact system prompt and user message before they
// are sent, instead of the app sending them straight through.
//
// Five state slots and a ref that only this one feature reads, lifted out of App
// so the flow is visible in one place: arm it (`mode`), a generation calls
// `pause()` instead of sending, the user edits the message, then sendToWriter
// picks up `userMsg` + `system` + the snapshot that was held back.
//
// The system prompt resets whenever the target or frame mode changes, because it
// is seeded from that target's actual prompt — an edit is meant to be a one-off
// tweak, not a lasting override that silently follows you to another target.

import { useEffect, useRef, useState } from 'react'
import { systemPromptFor } from '../constants'

export function useAdminReview(target, frameMode) {
  const [mode, setMode] = useState(false)
  const [system, setSystem] = useState(() => systemPromptFor(target, frameMode))
  const [systemOpen, setSystemOpen] = useState(false)
  const [userMsg, setUserMsg] = useState('')
  const [pending, setPending] = useState(false)
  // The history snapshot of the generation that is waiting to be sent. A ref, not
  // state: nothing renders from it and it must not trigger a re-render.
  const snapshotRef = useRef(null)
  // The MiniMax H3 mode (T2VA/I2VA/…/Ref2VA) the paused message was built for,
  // or null for a non-H3 target — captured at the same moment as the snapshot
  // so a later frameMode change can't make sendToWriter validate the eventual
  // result against the wrong mode.
  const h3ModeRef = useRef(null)

  useEffect(() => {
    setSystem(systemPromptFor(target, frameMode))
    setPending(false)
    setUserMsg('')
  }, [target, frameMode])   // eslint-disable-line react-hooks/exhaustive-deps

  // Called by the writer instead of sending: hold the assembled message and its
  // snapshot, and surface them for review.
  const pause = (assembledUserMsg, snapshot, h3Mode = null) => {
    setUserMsg(assembledUserMsg)
    snapshotRef.current = snapshot
    h3ModeRef.current = h3Mode
    setPending(true)
  }

  return {
    mode, setMode, system, setSystem, systemOpen, setSystemOpen,
    userMsg, setUserMsg, pending, setPending, snapshotRef, h3ModeRef, pause,
  }
}

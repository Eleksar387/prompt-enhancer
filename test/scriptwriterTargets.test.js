// The Scriptwriter's two target lists, which used to be hand-written copies of
// part of the TARGETS table and are now derived from it (caps.frameTarget /
// caps.clipTarget).
//
// This file exists to pin what the pickers offer. Deriving a list is only safe if it
// produces exactly what was there before — a target silently gained or lost is a
// feature appearing or disappearing.
//
// Z-Image Turbo is the one to watch. It used to have a system prompt but no TARGETS
// row, while being the DEFAULT model for character portraits with its id persisted
// inside saved portrait drafts; it is now a registered target, and the id had to stay
// `zimage` for exactly that reason.

import { describe, it, expect } from 'vitest'
import {
  FRAME_TARGETS, FRAME_SYSTEM, PROMPT_TARGETS, PORTRAIT_DEFAULT_TARGET,
} from '../src/components/ScriptwriterPanel.jsx'
import {
  TARGETS, TARGET_GROUPS, SYSTEM_PROMPT_Z_IMAGE_TURBO,
  buildLtxGuideSystemPrompt, systemPromptFor,
} from '../src/constants.js'
import { ADAPT_TARGETS } from '../src/adapt.js'

describe('frame-still targets', () => {
  it('offers exactly the four it always has, in the same order', () => {
    expect(FRAME_TARGETS.map(t => t.id)).toEqual(['flux', 'flux2klein', 'zimage', 'sdxl'])
  })

  it('keeps the short labels the buttons have always shown', () => {
    expect(FRAME_TARGETS.map(t => t.label))
      .toEqual(['Flux.dev', 'Klein', 'Z-Image Turbo', 'SDXL'])
  })

  it('gives every one a system prompt', () => {
    for (const t of FRAME_TARGETS) {
      expect(typeof FRAME_SYSTEM[t.id]).toBe('string')
      expect(FRAME_SYSTEM[t.id].length).toBeGreaterThan(500)
    }
  })

  it('takes every prompt straight from the table', () => {
    for (const t of FRAME_TARGETS) expect(FRAME_SYSTEM[t.id]).toBe(TARGETS[t.id].system)
  })
})

describe('Z-Image Turbo, now a registered target', () => {
  it('has a table row under the id saved portrait drafts already use', () => {
    // Renaming this key would orphan every stored portrait draft.
    expect(TARGETS.zimage).toBeDefined()
    expect(TARGETS.zimage.id).toBe('zimage')
    expect(TARGETS.zimage.system).toBe(SYSTEM_PROMPT_Z_IMAGE_TURBO)
  })

  it('is an image target that accepts LoRAs and frame stills', () => {
    expect(TARGETS.zimage.type).toBe('image')
    expect(TARGETS.zimage.caps.loras).toBe(true)
    expect(TARGETS.zimage.caps.frameTarget).toBe(true)
    expect(TARGETS.zimage.caps.refBlockInFrames).toBe(true)
  })

  it('is still what a character portrait defaults to', () => {
    expect(PORTRAIT_DEFAULT_TARGET).toBe('zimage')
    expect(FRAME_TARGETS.map(t => t.id)).toContain(PORTRAIT_DEFAULT_TARGET)
    expect(FRAME_SYSTEM[PORTRAIT_DEFAULT_TARGET]).toBe(SYSTEM_PROMPT_Z_IMAGE_TURBO)
  })

  it('is now reachable from the main rail and from Adapt', () => {
    const grouped = TARGET_GROUPS.flatMap(g => g.ids)
    expect(grouped).toContain('zimage')       // a real group, not the "Other" sweep
    expect(ADAPT_TARGETS.map(t => t.id)).toContain('zimage')
  })
})

describe('clip-prompt targets', () => {
  it('offers H3 and LTX, default first', () => {
    expect(PROMPT_TARGETS).toEqual([
      { id: 'minimax_h3', label: 'MiniMax H3' },
      // Labelled "Guide" because that is the writer it actually uses — see below.
      { id: 'ltx', label: 'LTX-2.3 Guide' },
    ])
  })

  // The label used to say plain "LTX-2.3" while the guide-aligned writer was what
  // ran, so a Scriptwriter clip prompt and a main-panel "LTX-2.3" prompt came out
  // different with nothing on screen explaining why. The Guide writer is intended;
  // these assertions keep the label and the writer describing the same thing.
  it('uses the guide-aligned LTX writer, and says so', () => {
    expect(TARGETS.ltx.clipSystem).toBe(buildLtxGuideSystemPrompt('single'))
    expect(TARGETS.ltx.clipSystem).not.toBe(systemPromptFor(TARGETS.ltx, 'single'))
    expect(TARGETS.ltx.clipLabel).toContain('Guide')
  })

  it('uses H3’s own writer for H3 clips', () => {
    expect(TARGETS.minimax_h3.clipSystem).toBe(systemPromptFor(TARGETS.minimax_h3, 'single'))
  })

  it('gives every clip target a writer', () => {
    for (const t of PROMPT_TARGETS) {
      expect(typeof TARGETS[t.id].clipSystem).toBe('string')
      expect(TARGETS[t.id].clipSystem.length).toBeGreaterThan(500)
    }
  })
})

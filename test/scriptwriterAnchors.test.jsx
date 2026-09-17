// Server-render smoke test for a Scriptwriter history entry whose clip
// carries Timeline anchors (shot.anchors, Add Guide) — same technique as
// app.test.jsx / historyPanel.test.jsx: renderToStaticMarkup exercises the
// component's module load + top-level render path and catches the class of
// mistake a state-shape change like this invites (a bad prop, an import that
// doesn't resolve, normalizeDirectorsCut/normalizeScript choking on a shot
// carrying an unfamiliar field).
//
// NOTE ON COVERAGE: the Director's-Cut / Video-Prompts clip cards render
// their detail body (including the "Add Guide" anchor number input itself)
// behind fold state (`expandedShots`/`expandedPrompts`, plain useState,
// starting collapsed and reset to false/''/false on every mount regardless
// of what's passed in `initialState` — see ScriptwriterPanel.jsx's
// finalPrompts initializer, which always forces `loading: false, error: ''`).
// This repo's component tests are all renderToStaticMarkup-only (no
// @testing-library/react, no jsdom `environment` configured in
// vite.config.js) — there is no click to expand a folded card from outside.
// So this test cannot reach the anchor `<input>` itself; that markup was
// verified by direct code reading instead (src/components/ScriptwriterPanel.jsx,
// the "References attached to this clip" block) and by npm run build (catches
// any JSX/syntax error in that branch even though it's never executed here).
// The 🕐 N anchor-count BADGE on the clip header, and the Director's-Cut
// reference-status banner text, are both siblings of the fold gate (not
// behind it) — those ARE covered below directly.
// The anchor LOGIC that runs unconditionally of fold state — checkH3Prompt's
// Timeline-anchor cross-check — has its own direct unit tests in
// test/h3PromptCheck.test.js instead.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ScriptwriterPanel from '../src/components/ScriptwriterPanel.jsx'

const initialState = {
  id: 'test-anchor-entry',
  phase: 'dircut',
  promptTarget: 'minimax_h3',
  aspectRatio: 'land169',
  pacing: 'standard',
  script: {
    title: 'Static',
    look: 'Cinematic, low-key lighting',
    language: 'English',
    soundscape: 'quiet room tone',
    music: 'N/A',
    characters: [
      { id: 'c1', name: 'Mara', appearance: 'dark hair, pale skin', wardrobe: 'navy blazer' },
    ],
    locations: [
      { id: 'l1', name: 'Living Room', description: 'a dim, cluttered room with an old radio' },
    ],
    scenes: [
      { id: 's1', title: 'The Message', location_id: 'l1', characters: ['c1'], description: 'Mara listens to the radio.', dialogues: [] },
    ],
  },
  directorsCut: {
    shots: [
      {
        shot_number: 1, scene_id: 's1', scene_title: 'The Message',
        shot_type: 'performance', characters: ['c1'], location_id: 'l1',
        camera_framing: 'medium shot', camera_movement: 'static', eyeline: 'toward the radio',
        primary_beat: 'Mara leans toward the radio and listens closely.',
        dialogue: [], lighting_mood: 'low-key, warm practical light', duration: 7,
        refs: ['ref-hash-1'],
        anchors: [{ refKey: 'ref-hash-1', atSeconds: 1.5 }],
      },
    ],
  },
  finalPrompts: [],
  framePrompts: [],
  refImages: [
    {
      base64: null, mediaType: 'image/jpeg', fileName: 'mara.jpg', note: '',
      caption: 'A woman with shoulder-length dark hair, pale skin, wearing a navy blazer.',
      linkType: 'character', linkId: 'c1', role: 'subject_identity', preserve: 'exact',
      generated: false, hash: 'ref-hash-1',
    },
  ],
  voiceRefs: [],
}

describe('ScriptwriterPanel — mounts with a Timeline-anchored (Add Guide) clip', () => {
  it('renders the Director\'s-Cut screen without throwing, id normalization intact', () => {
    const html = renderToStaticMarkup(
      <ScriptwriterPanel cfg={{ base: '', key: '' }} writerModel="test-model" initialState={initialState} />
    )
    expect(html).toContain('Director')
    expect(html).toContain('Clip 1')
    expect(html).toContain('The Message')
    // normalizeDirectorsCut must not choke on / strip the new `anchors` field
    // or the pre-existing `refs` pin alongside it.
    expect(html).toContain('✓ All 1 clips generate as Ref2VA')
  })

  it('shows the 🕐 N Timeline-anchor badge on the clip header — unlike the chip row, this renders regardless of fold state', () => {
    const html = renderToStaticMarkup(
      <ScriptwriterPanel cfg={{ base: '', key: '' }} writerModel="test-model" initialState={initialState} />
    )
    expect(html).toMatch(/🕐\s*1/)
  })

  it('the 🕐 badge is absent for a clip with no anchors', () => {
    const noAnchors = {
      ...initialState,
      directorsCut: { shots: [{ ...initialState.directorsCut.shots[0], anchors: [] }] },
    }
    const html = renderToStaticMarkup(
      <ScriptwriterPanel cfg={{ base: '', key: '' }} writerModel="test-model" initialState={noAnchors} />
    )
    expect(html).not.toMatch(/🕐/)
  })

  it('the Director\'s-Cut "no images yet" banner names Reference Images and offers a jump button, not a nonexistent "Script screen"', () => {
    const noRefs = { ...initialState, refImages: [], directorsCut: { shots: [{ ...initialState.directorsCut.shots[0], refs: [], anchors: [] }] } }
    const html = renderToStaticMarkup(
      <ScriptwriterPanel cfg={{ base: '', key: '' }} writerModel="test-model" initialState={noRefs} />
    )
    expect(html).toContain('No reference images yet')
    expect(html).toContain('above the Story Idea box')
    expect(html).not.toContain('Script screen')
    expect(html).toContain('↑ Jump to Reference Images')
  })

  it('the Director\'s-Cut "uploaded but not described" banner is distinct from the "no images at all" one', () => {
    const uncaptioned = {
      ...initialState,
      refImages: [{ ...initialState.refImages[0], caption: '' }],
      directorsCut: { shots: [{ ...initialState.directorsCut.shots[0], refs: [], anchors: [] }] },
    }
    const html = renderToStaticMarkup(
      <ScriptwriterPanel cfg={{ base: '', key: '' }} writerModel="test-model" initialState={uncaptioned} />
    )
    expect(html).toContain('added but not yet described')
    expect(html).not.toContain('No reference images yet')
  })

  it('renders the Video-Prompts (done) screen with a generated Ref2VA clip prompt, without throwing', () => {
    const done = {
      ...initialState,
      phase: 'done',
      finalPrompts: [{
        shotNumber: 1, sceneTitle: 'The Message', h3Mode: 'Ref2VA',
        text: [
          'subject_definitions:',
          '<Subject 1> is the subject from <Picture 1>, preserving face shape, hairstyle, build.',
          '',
          'summary:',
          '[keyframe completion + reference generation] <Subject 1> leans toward the radio.',
          '',
          'retention_analysis:',
          '<Subject 1> (appears in [Shot 1]): fully_preserved - identity locked from the reference.',
          '',
          'detailed_description:',
          '[Shot 1] <Subject 1> leans toward the radio and listens closely.',
          '',
          'overall_soundscape: a quiet room tone.',
          '',
          'non_diegetic_music: N/A',
        ].join('\n'),
      }],
    }
    const html = renderToStaticMarkup(
      <ScriptwriterPanel cfg={{ base: '', key: '' }} writerModel="test-model" initialState={done} />
    )
    expect(html).toContain('Shot 1')
  })
})

# Prompt Enhancer Bridge — auto-run a Scriptwriter export in ComfyUI

Drop a Scriptwriter "⬇ Export ZIP" onto a running ComfyUI, review what it's
about to do, and queue every clip — prompt text and reference images patched
into your own workflow automatically instead of by hand, one clip at a time.

Built for the case where ComfyUI runs on a machine the Prompt Enhancer app
can't reach directly (no network path between them) — the zip is your only
carrier, and everything below happens entirely on the ComfyUI side once it
arrives there. No connection back to the Prompt Enhancer app is ever needed.

## Install

Copy this whole folder into `ComfyUI/custom_nodes/`, then restart ComfyUI.
Pure Python stdlib on the server side (`zipfile`/`shutil`/`json`/`os`) — no
`pip install` step, so this works even with no outbound package access.

## One-time setup: build a template workflow

This pack doesn't know anything about MiniMax/H3 specifically — it patches
**your** existing workflow, whatever generates a clip from a prompt +
reference images. Build it once in ComfyUI, using the node types this pack
adds:

- **PE Clip Prompt** — outputs a `STRING`. Wire it into whatever your
  clip-generating node uses as its prompt/text input. Its own `text` widget
  is just a placeholder; every real run overwrites it per clip.
- **PE Clip Reference Image** — outputs an `IMAGE`. Add one per reference
  image slot your graph needs (up to 6, matching the app's own reference
  cap), and set each one's `index` widget to 0, 1, 2, … — this is how a run
  knows "this node is the 1st/2nd/3rd reference for this clip," independent
  of when you created the node or what you titled it. Wire each into your
  generating node's reference-image inputs.
- **PE Clip Duration** *(optional)* — outputs a `FLOAT` (seconds). Wire it
  into whatever your template uses to control clip length (often a
  `PrimitiveFloat`/`PrimitiveInt` feeding a frame-count formula — replace
  that node's link with this one, same idea as the image slots above).
  Without it, every clip renders at whatever fixed length your template
  already had, instead of its own authored duration — the review panel
  flags this (as a notice, not a blocker) when it's missing.

Add a Save node as usual. If it has a `filename_prefix` widget (most
`SaveImage`/`SaveVideo`/video-combine nodes do) **and it's the only node in
the graph with one**, it gets stamped with each clip's output name
(`clip-01`, `clip-02`, …) automatically — a convenience, not something any
clip depends on. With more than one `filename_prefix` node (an intermediate
preview save, say) neither is touched — there's no reliable way to tell
which one is "the" output, so it's left to you rather than guessed.

Leave this workflow loaded in the ComfyUI editor — a run always patches
**whatever graph is currently open**, so build it once and reuse it.

**A T2VA clip, or a clip with fewer references than your template has
`PE Clip Reference Image` slots, leaves the unused slot(s) empty** — the
node returns a 1×1 black placeholder image rather than erroring, so the
graph still runs. What your generating node *does* with that placeholder
(ignore it, error, or quietly treat it as a real reference) depends on that
node, not on this pack. Check the very first T2VA/fewer-references clip's
result closely — a generation that looks like it "ignored the prompt" is
the symptom to watch for if that node doesn't tolerate an empty slot well.

## Running a film

1. **📦 Load Film** button (top-right by default — **drag it anywhere**;
   its position is remembered across reloads, in case the default spot
   collides with your ComfyUI theme's own Queue button), or drag a `.zip`
   straight onto the page.
2. A small panel docks to the top-right corner (also draggable, by its
   header — position remembered too) — it never covers the canvas (it's not
   a modal), so your graph and any preview node stay visible the whole time.
   It lists every clip — prompt (truncated), which staged reference file
   lands in which slot, duration, mode (Ref2VA/T2VA) — and flags, before
   anything runs: no `PE Clip Prompt` node found, or a clip needing more
   reference slots than your template has. Click the header to
   collapse/expand it.
3. **▶ Run all clips** submits each clip as its own ComfyUI queue entry
   (`POST /prompt`, the same public endpoint every other tool uses), then
   auto-collapses the panel so the canvas is fully visible, leaving just a
   one-line "clip N/M — rendering…" status in the header. Polls until each
   clip finishes, showing per-clip progress/done/error if you expand it
   again. ComfyUI's own queue serializes execution, so submitting all of
   them at once is safe.

Finished clips land wherever your Save node writes them, named by
`filename_prefix` if it's wired up as above. **v1 does not stitch the clips
into one file** — that's a deliberate scope cut, left for later.

## How it works

- The Scriptwriter's "⬇ Export ZIP" includes a `manifest.json` — one entry
  per clip with its raw prompt text and its reference images **in the exact
  order** their `Image 1 / Image 2 / …` numbering appears inside that clip's
  actual generated prompt (this matters: MiniMax reads Ref2VA reference
  images positionally, so the wrong order silently attaches the wrong
  identity to the wrong clip).
- Dropping the zip POSTs it to this pack's own route
  (`/prompt_enhancer/run_film`), which extracts it into
  `ComfyUI/input/prompt_enhancer_runs/<run-id>/` and hands the manifest back
  with every reference rewritten to its absolute staged path.
- The browser side reads your **currently loaded** workflow via ComfyUI's
  own `app.graphToPrompt()`, clones it once per clip, sets every `PE Clip
  Prompt`/`PE Clip Reference Image` node by `class_type` (not by node title —
  titles are rename-sensitive and live in a different JSON than the one
  `/prompt` actually consumes), and submits each clone.

## Tests (no ComfyUI required)

```bash
python3 tests/test_staging.py     # zip → manifest → staged files, stdlib only
node tests/test_patch.mjs         # graph-patching logic, pure JS
```

Both are offline unit tests against synthetic fixtures. Neither exercises a
real ComfyUI queue/execution — there's no way to do that without ComfyUI
actually running, which this pack was written without access to. The first
real run against a live template workflow is the thing to watch closely.

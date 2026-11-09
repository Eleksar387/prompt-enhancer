// Pure graph-patching logic, split out from pe_bridge.js so it has zero
// dependency on ComfyUI's `app`/`api` modules (which only exist in a real
// ComfyUI browser session) and can be unit-tested with plain Node — see
// ../tests/test_patch.mjs.

export const PROMPT_NODE = "PEClipPrompt";
export const IMAGE_NODE = "PEClipImage";
export const GUIDE_IMAGE_NODE = "PEClipGuideImage";
export const DURATION_NODE = "PEClipDuration";
export const AUDIO_NODE = "PEClipAudio";
export const VIDEO_NODE = "PEClipVideo";
export const LORA_NODE = "PEClipLora";
export const REFMOD_NODE = "PEClipRefMod";

export function hasDurationNode(promptOutput) {
  return Object.values(promptOutput).some((n) => n.class_type === DURATION_NODE);
}

// How many slots (highest `index` widget + 1) the loaded template graph
// offers for a given node class_type — shared by PEClipImage (`references`)
// and PEClipGuideImage (`guides`), which are separate slot pools.
function countSlots(promptOutput, classType) {
  let max = -1;
  for (const node of Object.values(promptOutput)) {
    if (node.class_type === classType) {
      const idx = Number(node.inputs?.index ?? 0);
      if (idx > max) max = idx;
    }
  }
  return max + 1;
}

export function countImageSlots(promptOutput) {
  return countSlots(promptOutput, IMAGE_NODE);
}

// How many PEClipGuideImage (Add-Guide timeline-anchor) slots the loaded
// template graph offers. 0 for a template that doesn't use the multiframe
// Add-Guide workflow at all — that's the normal, expected case for a plain
// Reference-to-Video template.
export function countGuideSlots(promptOutput) {
  return countSlots(promptOutput, GUIDE_IMAGE_NODE);
}

// How many PEClipLora nodes the template chains (= LoRAs one clip can load).
export function countLoraSlots(promptOutput) {
  return Object.values(promptOutput).filter((n) => n.class_type === LORA_NODE).length;
}

// How many PEClipRefMod nodes the template wires into MiniMaxH3RefModsLoader
// (= RefMods one clip can load). Same plain-count shape as countLoraSlots —
// each node is an independent slot, not a chain.
export function countRefModSlots(promptOutput) {
  return Object.values(promptOutput).filter((n) => n.class_type === REFMOD_NODE).length;
}

export function hasPromptNode(promptOutput) {
  return Object.values(promptOutput).some((n) => n.class_type === PROMPT_NODE);
}

// Nodes carrying a `filename_prefix` widget (SaveImage/SaveVideo/most
// video-combine nodes use this exact name). Only stamped when there's
// exactly one such node in the whole graph — with two or more we can't tell
// which one is "the" output without guessing, and guessing wrong means
// silently overwriting a value the user set deliberately on some other node
// (an intermediate preview save, say). Ambiguous → skip entirely, untouched.
function outputNameNodeIds(promptOutput) {
  return Object.keys(promptOutput).filter((id) =>
    Object.prototype.hasOwnProperty.call(promptOutput[id].inputs || {}, "filename_prefix")
  );
}

// Clone `promptOutput` (a ComfyUI API-format prompt: { [nodeId]: { class_type, inputs } })
// and set every PEClipPrompt's text, every PEClipImage's image_path, every
// PEClipGuideImage's image_path + frame_idx, for one clip.
export function patchForClip(promptOutput, clip) {
  const patched = JSON.parse(JSON.stringify(promptOutput));
  const outputIds = outputNameNodeIds(promptOutput);
  const soleOutputId = outputIds.length === 1 ? outputIds[0] : null;
  const guides = clip.guides || [];
  const voices = clip.voices || [];
  // PEClipAudio: voice N goes to the node whose `index` is N; nodes left at the default (-1)
  // take the remaining positions in ascending node-id order ("Stimme 1", "Stimme 2", ...).
  const audioIds = Object.keys(patched).filter((id) => patched[id].class_type === AUDIO_NODE)
    .sort((a, b) => Number(a) - Number(b));
  const pinned = new Set(audioIds.map((id) => Number(patched[id].inputs?.index ?? -1)).filter((i) => i >= 0));
  const free = [];
  for (let i = 0; free.length < audioIds.length; i++) if (!pinned.has(i)) free.push(i);
  const audioPos = {};
  let nextFree = 0;
  for (const id of audioIds) {
    const explicit = Number(patched[id].inputs?.index ?? -1);
    audioPos[id] = explicit >= 0 ? explicit : free[nextFree++];
  }

  // PEClipLora: same slot rule as audio — pinned `index` first, the rest in ascending node-id order.
  const loras = clip.loras || [];
  const loraIds = Object.keys(patched).filter((id) => patched[id].class_type === LORA_NODE)
    .sort((a, b) => Number(a) - Number(b));
  const loraPinned = new Set(loraIds.map((id) => Number(patched[id].inputs?.index ?? -1)).filter((i) => i >= 0));
  const loraFree = [];
  for (let i = 0; loraFree.length < loraIds.length; i++) if (!loraPinned.has(i)) loraFree.push(i);
  const loraPos = {};
  let nextLora = 0;
  for (const id of loraIds) {
    const explicit = Number(patched[id].inputs?.index ?? -1);
    loraPos[id] = explicit >= 0 ? explicit : loraFree[nextLora++];
  }

  // PEClipRefMod: same slot rule as LoRA/audio — pinned `index` first, the rest ascending.
  const refMods = clip.refMods || [];
  const refModIds = Object.keys(patched).filter((id) => patched[id].class_type === REFMOD_NODE)
    .sort((a, b) => Number(a) - Number(b));
  const refModPinned = new Set(refModIds.map((id) => Number(patched[id].inputs?.index ?? -1)).filter((i) => i >= 0));
  const refModFree = [];
  for (let i = 0; refModFree.length < refModIds.length; i++) if (!refModPinned.has(i)) refModFree.push(i);
  const refModPos = {};
  let nextRefMod = 0;
  for (const id of refModIds) {
    const explicit = Number(patched[id].inputs?.index ?? -1);
    refModPos[id] = explicit >= 0 ? explicit : refModFree[nextRefMod++];
  }

  for (const [id, node] of Object.entries(patched)) {
    if (node.class_type === PROMPT_NODE) {
      node.inputs.text = clip.promptText || "";
    } else if (node.class_type === IMAGE_NODE) {
      const idx = Number(node.inputs?.index ?? 0);
      const ref = clip.references[idx];
      node.inputs.image_path = ref ? ref.absPath : "";
    } else if (node.class_type === GUIDE_IMAGE_NODE) {
      const idx = Number(node.inputs?.index ?? 0);
      const guide = guides[idx];
      node.inputs.image_path = guide ? guide.absPath : "";
      node.inputs.frame_idx = guide ? guide.frameIdx : 0;
    } else if (node.class_type === AUDIO_NODE) {
      const v = voices[audioPos[id]];
      node.inputs.audio_path = v ? v.absPath : "";
    } else if (node.class_type === LORA_NODE) {
      const l = loras[loraPos[id]];
      node.inputs.lora_name = l ? l.file : "";
      node.inputs.strength = l ? l.strength : 0;
    } else if (node.class_type === REFMOD_NODE) {
      const m = refMods[refModPos[id]];
      node.inputs.mod_name = m ? m.file : "";
      node.inputs.strength = m ? m.strength : 0;
    } else if (node.class_type === VIDEO_NODE) {
      // the export carries no reference video; only overwrite when a clip names one
      if (clip.video && clip.video.absPath) node.inputs.video_path = clip.video.absPath;
    } else if (node.class_type === DURATION_NODE) {
      node.inputs.seconds = clip.durationSec;
    } else if (id === soleOutputId) {
      node.inputs.filename_prefix = clip.outputName;
    }
  }
  return patched;
}

// Declared widget order (INPUT_TYPES: required then optional) for each PEClip*
// class, per nodes.py — excludes any non-primitive (socket-only) input, i.e.
// PEClipLora's `model`. A field converted to an input socket in the live
// workflow is removed from `widgets_values` and appears in the node's own
// `inputs` list instead, so patchWorkflowForClip filters those out before
// mapping positionally.
const WIDGET_FIELDS = {
  [PROMPT_NODE]: ["text"],
  [IMAGE_NODE]: ["index", "image_path"],
  [GUIDE_IMAGE_NODE]: ["index", "image_path", "frame_idx"],
  [DURATION_NODE]: ["seconds"],
  [AUDIO_NODE]: ["audio_path", "index"],
  [VIDEO_NODE]: ["video_path"],
  [LORA_NODE]: ["lora_name", "strength", "index"],
  [REFMOD_NODE]: ["mod_name", "strength", "index"],
};

// Clone the UI-format `workflow` (the embedded graph `app.graphToPrompt()`
// also returns, kept for provenance / "drag the output back in") and patch
// every PEClip* node's `widgets_values` to the SAME literal values
// `patchForClip` just wrote into the API-format prompt for this clip — so the
// metadata embedded in the rendered output actually matches what ran, instead
// of showing the template's pre-patch placeholders (empty LoRA/RefMod/text
// fields) on every single clip regardless of success.
//
// `patchedPromptOutput` must be `patchForClip(promptOutput, clip)`'s result —
// this function reads the already-resolved literal values back off it by
// node id, rather than re-deriving slot assignments a second time, so the two
// patched representations can never drift apart from each other.
//
// Only PEClip* nodes are touched. A node whose `widgets_values` length
// doesn't match its filtered widget-field count (an unexpected graph edit, a
// nodes.py version mismatch) is left alone rather than guessed at, and a
// third-party node (e.g. the Save node `patchForClip` stamps via
// `filename_prefix`) is never touched here — its own widget order isn't ours
// to know.
export function patchWorkflowForClip(workflow, patchedPromptOutput) {
  const cloned = JSON.parse(JSON.stringify(workflow || {}));
  for (const node of cloned.nodes || []) {
    const apiNode = patchedPromptOutput[String(node.id)];
    if (!apiNode) continue;
    const fields = WIDGET_FIELDS[apiNode.class_type];
    if (!fields) continue;
    // A current ComfyUI frontend lists EVERY widget-capable field in
    // node.inputs (each carrying its own `widget: {name}` marker) whether or
    // not it's actually wired up — so "present in node.inputs" is not "is a
    // socket". Only a `link` that's actually set (non-null) means the field
    // is driven by a connection and has no slot in widgets_values; an
    // unlinked widget-capable entry still occupies one. An older frontend
    // that never lists an unconverted widget in `inputs` at all also reads
    // correctly here, since such a field is simply absent from `linkedNames`.
    const linkedNames = new Set((node.inputs || []).filter((i) => i.link != null).map((i) => i.name));
    const widgetFields = fields.filter((f) => !linkedNames.has(f));
    if (!Array.isArray(node.widgets_values) || node.widgets_values.length !== widgetFields.length) {
      console.warn(
        `Prompt Enhancer Bridge: skipping embedded-workflow patch for ${apiNode.class_type} node ${node.id} ` +
        `(expected ${widgetFields.length} widget value(s), found ${node.widgets_values?.length ?? "none"}).`
      );
      continue;
    }
    widgetFields.forEach((f, i) => { node.widgets_values[i] = apiNode.inputs[f]; });
  }
  return cloned;
}

// --- MiniMax H3 Director (Load Film's "fill it in, don't run it" path) ----------
//
// The Director keeps its whole state in one JSON widget (`timeline_data`) plus a few
// plain widgets mirroring the render window. This returns widget-name -> value for a
// manifest.director block (staged by staging.py, which attaches `timeline`); the UI shell
// applies them by NAME to the live node (never by position — the Director's widget order
// has already changed between its own releases).
export const DIRECTOR_NODE = "MiniMaxH3DirectorCS";

export function findDirectorNode(nodes) {
  return (nodes || []).find((n) => n && n.type === DIRECTOR_NODE) || null;
}

export function directorWidgetValues(director) {
  const fps = director.fps || 24;
  const frames = director.totalFrames || 0;
  const seconds = frames / fps;
  const values = {
    timeline_data: JSON.stringify(director.timeline),
    start_frame: 0, end_frame: frames, duration_frames: frames,
    start_second: 0, end_second: seconds, duration_seconds: seconds,
    frame_rate: fps,
  };
  if (director.width) values.custom_width = director.width;
  if (director.height) values.custom_height = director.height;
  return values;
}

// Pure graph-patching logic, split out from pe_bridge.js so it has zero
// dependency on ComfyUI's `app`/`api` modules (which only exist in a real
// ComfyUI browser session) and can be unit-tested with plain Node — see
// ../tests/test_patch.mjs.

export const PROMPT_NODE = "PEClipPrompt";
export const IMAGE_NODE = "PEClipImage";
export const DURATION_NODE = "PEClipDuration";

export function hasDurationNode(promptOutput) {
  return Object.values(promptOutput).some((n) => n.class_type === DURATION_NODE);
}

// How many PEClipImage slots (highest `index` widget + 1) the loaded
// template graph offers.
export function countImageSlots(promptOutput) {
  let max = -1;
  for (const node of Object.values(promptOutput)) {
    if (node.class_type === IMAGE_NODE) {
      const idx = Number(node.inputs?.index ?? 0);
      if (idx > max) max = idx;
    }
  }
  return max + 1;
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
// and set every PEClipPrompt's text + every PEClipImage's image_path for one clip.
export function patchForClip(promptOutput, clip) {
  const patched = JSON.parse(JSON.stringify(promptOutput));
  const outputIds = outputNameNodeIds(promptOutput);
  const soleOutputId = outputIds.length === 1 ? outputIds[0] : null;

  for (const [id, node] of Object.entries(patched)) {
    if (node.class_type === PROMPT_NODE) {
      node.inputs.text = clip.promptText || "";
    } else if (node.class_type === IMAGE_NODE) {
      const idx = Number(node.inputs?.index ?? 0);
      const ref = clip.references[idx];
      node.inputs.image_path = ref ? ref.absPath : "";
    } else if (node.class_type === DURATION_NODE) {
      node.inputs.seconds = clip.durationSec;
    } else if (id === soleOutputId) {
      node.inputs.filename_prefix = clip.outputName;
    }
  }
  return patched;
}

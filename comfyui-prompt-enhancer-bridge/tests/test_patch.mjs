// Offline test for web/patch.js — no ComfyUI, no browser. Run with:
//   node comfyui-prompt-enhancer-bridge/tests/test_patch.mjs
import assert from "node:assert/strict";
import { countImageSlots, hasPromptNode, hasDurationNode, patchForClip } from "../web/patch.js";

// A minimal stand-in for what app.graphToPrompt().output looks like for a
// template with one PEClipPrompt, three PEClipImage slots (0,1,2), one
// PEClipDuration, one unrelated node with a filename_prefix widget (stands
// in for a Save node), and one unrelated node with neither (a sampler).
const template = {
  "1": { class_type: "PEClipPrompt", inputs: { text: "" } },
  "2": { class_type: "PEClipImage", inputs: { index: 0, image_path: "" } },
  "3": { class_type: "PEClipImage", inputs: { index: 1, image_path: "" } },
  "4": { class_type: "PEClipImage", inputs: { index: 2, image_path: "" } },
  "5": { class_type: "SaveVideo", inputs: { filename_prefix: "old", images: ["4", 0] } },
  "6": { class_type: "SomeSampler", inputs: { seed: 1 } },
  "8": { class_type: "PEClipDuration", inputs: { seconds: 15 } },
};

let n = 0;
function test(name, fn) { fn(); n++; console.log(`ok - ${name}`); }

test("countImageSlots counts by highest index + 1", () => {
  assert.equal(countImageSlots(template), 3);
});

test("countImageSlots on a template with no PEClipImage nodes is 0", () => {
  assert.equal(countImageSlots({ "1": { class_type: "PEClipPrompt", inputs: {} } }), 0);
});

test("hasPromptNode detects PEClipPrompt presence", () => {
  assert.equal(hasPromptNode(template), true);
  assert.equal(hasPromptNode({ "1": { class_type: "PEClipImage", inputs: { index: 0 } } }), false);
});

test("hasDurationNode detects PEClipDuration presence", () => {
  assert.equal(hasDurationNode(template), true);
  assert.equal(hasDurationNode({ "1": { class_type: "PEClipPrompt", inputs: {} } }), false);
});

test("patchForClip sets prompt text, fills image slots in order, stamps output name, leaves unrelated nodes alone", () => {
  const clip = {
    clipNumber: 1, sceneTitle: "Opening", mode: "Ref2VA", durationSec: 7,
    outputName: "clip-01", promptText: "subject_definitions:\n<Subject 1> is ...",
    references: [
      { file: "references/c1-mara.jpg", absPath: "/staged/references/c1-mara.jpg", role: "subject_identity", preserve: "exact" },
      { file: "references/l1-dome.jpg", absPath: "/staged/references/l1-dome.jpg", role: "environment", preserve: "guide" },
    ],
  };
  const patched = patchForClip(template, clip);

  assert.equal(patched["1"].inputs.text, clip.promptText);
  assert.equal(patched["2"].inputs.image_path, "/staged/references/c1-mara.jpg"); // index 0
  assert.equal(patched["3"].inputs.image_path, "/staged/references/l1-dome.jpg"); // index 1
  assert.equal(patched["4"].inputs.image_path, ""); // index 2 — clip only has 2 refs, must stay empty, not reuse/shift
  assert.equal(patched["5"].inputs.filename_prefix, "clip-01");
  assert.equal(patched["6"].inputs.seed, 1); // untouched
  assert.equal(patched["8"].inputs.seconds, 7); // this clip's own durationSec, not the template's placeholder 15

  // original template must be unmodified (patchForClip must clone, not mutate)
  assert.equal(template["1"].inputs.text, "");
  assert.equal(template["2"].inputs.image_path, "");
});

test("patchForClip on a T2VA clip (no references) leaves every image slot empty", () => {
  const clip = { outputName: "clip-02", promptText: "integrated_multimodal_description:\n...", references: [] };
  const patched = patchForClip(template, clip);
  assert.equal(patched["2"].inputs.image_path, "");
  assert.equal(patched["3"].inputs.image_path, "");
  assert.equal(patched["4"].inputs.image_path, "");
});

test("patchForClip leaves EVERY filename_prefix node untouched when there's more than one — ambiguous, don't guess", () => {
  const twoOutputs = {
    "1": { class_type: "PEClipPrompt", inputs: { text: "" } },
    "5": { class_type: "SaveVideo", inputs: { filename_prefix: "keep-a" } },
    "7": { class_type: "PreviewSave", inputs: { filename_prefix: "keep-b" } },
  };
  const clip = { outputName: "clip-03", promptText: "x", references: [] };
  const patched = patchForClip(twoOutputs, clip);
  assert.equal(patched["5"].inputs.filename_prefix, "keep-a");
  assert.equal(patched["7"].inputs.filename_prefix, "keep-b");
});

console.log(`\n${n} passed`);

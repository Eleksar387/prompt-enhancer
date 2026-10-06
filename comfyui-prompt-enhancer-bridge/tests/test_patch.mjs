// Offline test for web/patch.js — no ComfyUI, no browser. Run with:
//   node comfyui-prompt-enhancer-bridge/tests/test_patch.mjs
import assert from "node:assert/strict";
import { countImageSlots, countGuideSlots, hasPromptNode, hasDurationNode, countLoraSlots, patchForClip, findDirectorNode, directorWidgetValues } from "../web/patch.js";

// A minimal stand-in for what app.graphToPrompt().output looks like for a
// template with one PEClipPrompt, three PEClipImage slots (0,1,2), two
// PEClipGuideImage slots (0,1), one PEClipDuration, one unrelated node with a
// filename_prefix widget (stands in for a Save node), and one unrelated node
// with neither (a sampler).
const template = {
  "1": { class_type: "PEClipPrompt", inputs: { text: "" } },
  "2": { class_type: "PEClipImage", inputs: { index: 0, image_path: "" } },
  "3": { class_type: "PEClipImage", inputs: { index: 1, image_path: "" } },
  "4": { class_type: "PEClipImage", inputs: { index: 2, image_path: "" } },
  "5": { class_type: "SaveVideo", inputs: { filename_prefix: "old", images: ["4", 0] } },
  "6": { class_type: "SomeSampler", inputs: { seed: 1 } },
  "8": { class_type: "PEClipDuration", inputs: { seconds: 15 } },
  "9": { class_type: "PEClipGuideImage", inputs: { index: 0, image_path: "", frame_idx: 0 } },
  "10": { class_type: "PEClipGuideImage", inputs: { index: 1, image_path: "", frame_idx: 0 } },
};

let n = 0;
function test(name, fn) { fn(); n++; console.log(`ok - ${name}`); }

test("countImageSlots counts by highest index + 1", () => {
  assert.equal(countImageSlots(template), 3);
});

test("countImageSlots on a template with no PEClipImage nodes is 0", () => {
  assert.equal(countImageSlots({ "1": { class_type: "PEClipPrompt", inputs: {} } }), 0);
});

test("countGuideSlots counts PEClipGuideImage by highest index + 1, independent of PEClipImage's own count", () => {
  assert.equal(countGuideSlots(template), 2);
});

test("countGuideSlots on a template with no PEClipGuideImage nodes is 0 (the normal, non-multiframe case)", () => {
  assert.equal(countGuideSlots({ "1": { class_type: "PEClipPrompt", inputs: {} } }), 0);
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
  // no `guides` on this clip at all — PEClipGuideImage slots stay empty/zero, same as an unused PEClipImage slot
  assert.equal(patched["9"].inputs.image_path, "");
  assert.equal(patched["9"].inputs.frame_idx, 0);
  assert.equal(patched["10"].inputs.image_path, "");

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

test("patchForClip fills PEClipGuideImage slots from clip.guides, in guides' own (chronological) order — a SEPARATE index space from clip.references", () => {
  const clip = {
    outputName: "clip-04", promptText: "subject_definitions:\n<Subject 1> is ...",
    references: [
      { file: "references/c1-mara.jpg", absPath: "/staged/references/c1-mara.jpg", role: "subject_identity", preserve: "exact",
        anchor: { atSeconds: 1.5, frameIdx: 36 } },
    ],
    guides: [
      { file: "references/c1-mara.jpg", absPath: "/staged/references/c1-mara.jpg", atSeconds: 1.5, frameIdx: 36 },
    ],
  };
  const patched = patchForClip(template, clip);
  assert.equal(patched["2"].inputs.image_path, "/staged/references/c1-mara.jpg"); // PEClipImage index 0, from references[0]
  assert.equal(patched["9"].inputs.image_path, "/staged/references/c1-mara.jpg"); // PEClipGuideImage index 0, from guides[0]
  assert.equal(patched["9"].inputs.frame_idx, 36);
  assert.equal(patched["10"].inputs.image_path, ""); // guide index 1 — clip only has 1 guide
  assert.equal(patched["10"].inputs.frame_idx, 0);
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

test("findDirectorNode matches by node type only", () => {
  assert.equal(findDirectorNode([{ type: "KSampler" }, { type: "MiniMaxH3DirectorCS", id: 5 }]).id, 5);
  assert.equal(findDirectorNode([{ type: "KSampler" }]), null);
});

test("directorWidgetValues mirrors the render window and serialises the timeline", () => {
  const v = directorWidgetValues({ fps: 24, totalFrames: 288, width: 1366, height: 768, timeline: { segments: [] } });
  assert.equal(v.timeline_data, '{"segments":[]}');
  assert.equal(v.duration_frames, 288);
  assert.equal(v.duration_seconds, 12);
  assert.equal(v.end_second, 12);
  assert.equal(v.custom_width, 1366);
});

test("PEClipAudio nodes take voices in node-id order (or pinned by index); empty when the clip has fewer", () => {
  const tpl = {
    "20": { class_type: "PEClipAudio", inputs: { audio_path: "", index: -1 } },
    "10": { class_type: "PEClipAudio", inputs: { audio_path: "", index: -1 } },
    "30": { class_type: "PEClipVideo", inputs: { video_path: "keep.mp4" } },
  };
  const clip = { promptText: "", references: [], voices: [{ absPath: "/v/a.mp3" }], durationSec: 5, outputName: "x" };
  const out = patchForClip(tpl, clip);
  assert.equal(out["10"].inputs.audio_path, "/v/a.mp3");   // lower id = voice 1
  assert.equal(out["20"].inputs.audio_path, "");           // no second voice
  assert.equal(out["30"].inputs.video_path, "keep.mp4");   // untouched
  const pinned = patchForClip({ "5": { class_type: "PEClipAudio", inputs: { audio_path: "", index: 1 } } },
    { ...clip, voices: [{ absPath: "/v/a.mp3" }, { absPath: "/v/b.mp3" }] });
  assert.equal(pinned["5"].inputs.audio_path, "/v/b.mp3");
});

test("PEClipLora nodes take clip.loras in node-id order (or pinned); unused slots are cleared", () => {
  const tpl = {
    "20": { class_type: "PEClipLora", inputs: { lora_name: "stale.safetensors", strength: 1, index: -1 } },
    "10": { class_type: "PEClipLora", inputs: { lora_name: "", strength: 1, index: -1 } },
  };
  const clip = { promptText: "", references: [], loras: [{ file: "MinimaxH3\\a.safetensors", strength: 0.5 }], durationSec: 5, outputName: "x" };
  const out = patchForClip(tpl, clip);
  assert.equal(out["10"].inputs.lora_name, "MinimaxH3\\a.safetensors");
  assert.equal(out["10"].inputs.strength, 0.5);
  assert.equal(out["20"].inputs.lora_name, "");
  assert.equal(out["20"].inputs.strength, 0);
  assert.equal(countLoraSlots(tpl), 2);
  const pinned = patchForClip({ "5": { class_type: "PEClipLora", inputs: { lora_name: "", strength: 1, index: 1 } } },
    { ...clip, loras: [{ file: "a", strength: 1 }, { file: "b", strength: 0.8 }] });
  assert.equal(pinned["5"].inputs.lora_name, "b");
  // a clip without a loras field (older export) clears every slot
  assert.equal(patchForClip(tpl, { promptText: "", references: [] })["10"].inputs.lora_name, "");
});

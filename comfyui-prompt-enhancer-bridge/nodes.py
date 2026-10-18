# Four small node classes that give the JS extension (web/pe_bridge.js) a
# stable, rename-proof way to find "where does this clip's prompt/reference/
# guide-image/duration go" in a user's own template workflow: it patches by
# class_type, which is what ComfyUI's own /prompt payload carries (not node
# titles, which live in a separate JSON and which a user is free to rename
# without warning).
#
# The user builds a template workflow ONCE — their MiniMax/H3-calling
# node(s), one PEClipPrompt feeding its positive-prompt input, up to 6
# PEClipImage nodes feeding its reference-image inputs, optionally one
# PEClipDuration feeding whatever drives clip length, a Save node — and the
# JS extension clones + patches that graph once per clip in the dropped
# export's manifest.json.
#
# A SEPARATE, optional template shape (MiniMax H3's "Reference-to-Video +
# chained Add Guide nodes" multiframe workflow) additionally wires one
# PEClipGuideImage per Add-Guide chain position, each feeding one Add Guide
# node's image input (and, where the Add Guide node accepts it, the same
# PEClipGuideImage's frame_idx output). This is a separate node type, not a
# PEClipImage mode switch, because the two slot kinds are indexed against two
# different manifest arrays (`references` vs. chronologically-sorted
# `guides`) — see PEClipGuideImage's own docstring.

import os

try:
    from .lora_resolve import resolve_lora_name
except ImportError:  # run outside a package (tests)
    from lora_resolve import resolve_lora_name

try:
    import numpy as np
    import torch
    from PIL import Image, ImageOps
    _HAVE_IMAGING = True
except Exception:
    # Importing nodes.py must never crash ComfyUI's startup just because
    # numpy/torch/Pillow aren't importable in some odd environment — they are
    # always present in a real ComfyUI install (torch is a hard dependency),
    # so this is only a defensive fallback for e.g. a lint/import smoke test.
    _HAVE_IMAGING = False


class PEClipPrompt:
    """Outputs a literal text value. The JS extension overwrites this node's
    `text` widget with one clip's full prompt (manifest.json's `promptText` —
    the raw generated text, no human-readable header) before submitting that
    clip's prompt to ComfyUI's own POST /prompt.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": ""}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "run"
    CATEGORY = "Prompt Enhancer Bridge"

    def run(self, text):
        return (text,)


class PEClipImage:
    """Loads one reference image from an absolute file path rather than
    ComfyUI's own LoadImage input/-folder dropdown (which is validated
    against a fixed choice list built at node-definition time, and would
    reject a file staged mid-run).

    `index` (0-based) is how the JS extension knows which manifest reference
    — 1st, 2nd, 3rd... — belongs in THIS particular PEClipImage node,
    independent of node id or graph-creation order: the user sets it once
    per node when wiring the template (0, 1, 2, ... up to 5 — the app's own
    reference-image cap), and the patcher sorts by it. `image_path` is what
    the patcher actually overwrites per clip; its on-disk default lets the
    node open standalone in the editor (before any run has staged files)
    without erroring.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "index": ("INT", {"default": 0, "min": 0, "max": 5, "step": 1}),
                "image_path": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "load"
    CATEGORY = "Prompt Enhancer Bridge"

    def load(self, index, image_path):
        if not _HAVE_IMAGING:
            raise RuntimeError("PEClipImage needs numpy/torch/Pillow, which a real ComfyUI install always provides.")
        if not image_path or not os.path.isfile(image_path):
            # No file staged yet (e.g. the workflow was just opened in the
            # editor, or this slot's clip has fewer references than others)
            # — a 1x1 black placeholder keeps the graph runnable rather than
            # throwing, since not every clip uses every PEClipImage slot.
            arr = np.zeros((1, 1, 1, 3), dtype=np.float32)
            return (torch.from_numpy(arr),)
        img = Image.open(image_path)
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        arr = arr[None, ...]
        return (torch.from_numpy(arr),)


class PEClipGuideImage:
    """Loads one Add-Guide timeline-anchor image, for a MiniMax H3
    "Reference-to-Video + chained Add Guide nodes" multiframe template —
    a separate, optional workflow shape from the plain flat reference set
    PEClipImage feeds (see PEClipImage's own docstring).

    Structurally identical to PEClipImage (0-based `index`, same absolute-path
    load, same 1x1-black-placeholder fallback when a clip has fewer guides
    than the template has slots) but reads from the manifest's `guides` list
    instead of `references`. That list is a SEPARATE, chronologically sorted
    view (index 0 = earliest time in the clip, not "1st reference image") —
    the app's own manifest.json comment explains why: `references[]`'s order
    is load-bearing for the prompt text's "Image N" numbering and must not be
    repurposed for this. Also outputs the guide's frame index (already
    computed by the app as round(atSeconds * 24) and stored in the manifest —
    no time math happens here), for wiring into the Add Guide node's own
    frame-position input.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "index": ("INT", {"default": 0, "min": 0, "max": 5, "step": 1}),
                "image_path": ("STRING", {"default": ""}),
                "frame_idx": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE", "INT")
    RETURN_NAMES = ("image", "frame_idx")
    FUNCTION = "load"
    CATEGORY = "Prompt Enhancer Bridge"

    def load(self, index, image_path, frame_idx):
        if not _HAVE_IMAGING:
            raise RuntimeError("PEClipGuideImage needs numpy/torch/Pillow, which a real ComfyUI install always provides.")
        if not image_path or not os.path.isfile(image_path):
            arr = np.zeros((1, 1, 1, 3), dtype=np.float32)
            return (torch.from_numpy(arr), 0)
        img = Image.open(image_path)
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        arr = arr[None, ...]
        return (torch.from_numpy(arr), frame_idx)


class PEClipDuration:
    """Outputs a literal float (seconds). Wire it into whatever your template
    uses to control clip length — a PrimitiveFloat/PrimitiveInt feeding a
    frame-count formula is the common case (that's exactly what the sample
    Ref2Video graph does: seconds -> a ComfyMathExpression -> the video node's
    `length`). Optional — a template with no PEClipDuration node just keeps
    using whatever fixed length it already had; every clip gets that same
    length instead of its own authored duration.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seconds": ("FLOAT", {"default": 7.0, "min": 0.1, "max": 3600.0, "step": 0.1}),
            }
        }

    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("seconds",)
    FUNCTION = "run"
    CATEGORY = "Prompt Enhancer Bridge"

    def run(self, seconds):
        return (seconds,)


def _load_audio_file(path):
    """Decode an audio file to ComfyUI's AUDIO dict. Uses ComfyUI's own loader
    (comfy_extras.nodes_audio.load — PyAV based) so the result is byte-for-byte
    what its stock LoadAudio node would produce."""
    from comfy_extras.nodes_audio import load as comfy_load_audio
    waveform, sample_rate = comfy_load_audio(path)
    return {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}


class PEClipAudio:
    """Outputs one voice-timbre sample (AUDIO) loaded from an absolute path —
    for a MiniMax H3 `ref_audios.ref_audio_N` input.

    `audio_path` is what the JS extension overwrites per clip with that clip's
    N-th manifest voice (`voices[N]`). Which node is "voice N": by default the
    PEClipAudio nodes in ascending node-id order (the first one placed is voice
    1, the next voice 2 — matches a workflow with "Stimme 1" / "Stimme 2"); set
    `index` (0 = first voice, 1 = second) to pin it explicitly instead.

    A clip with no voice at that position (or an unset/missing file) outputs
    None, which the H3 conditioning node skips — so a slot a clip doesn't use
    simply isn't sent.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio_path": ("STRING", {"default": ""}),
            },
            "optional": {
                "index": ("INT", {"default": -1, "min": -1, "max": 1, "step": 1}),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "load"
    CATEGORY = "Prompt Enhancer Bridge"

    def load(self, audio_path, index=-1):
        if not audio_path or not os.path.isfile(audio_path):
            return (None,)
        return (_load_audio_file(audio_path),)


class PEClipVideo:
    """Outputs a reference video as an IMAGE batch ("frames", 24 fps) from a
    path — for a MiniMax H3 `ref_videos.ref_video_N` input (2–15 s).

    The Scriptwriter / app ZIP does not carry a reference video, so by default
    `video_path` is whatever you set on the node (an absolute path, or a file
    name inside ComfyUI's input/ folder); the bridge only overwrites it if a
    manifest clip ever names a `video`. Empty or missing path outputs None,
    which the H3 node skips (no reference video sent).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_path": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("frames",)
    FUNCTION = "load"
    CATEGORY = "Prompt Enhancer Bridge"

    @staticmethod
    def _resolve(video_path):
        if not video_path:
            return None
        if os.path.isfile(video_path):
            return video_path
        try:
            import folder_paths
            candidate = os.path.join(folder_paths.get_input_directory(), video_path)
            return candidate if os.path.isfile(candidate) else None
        except Exception:
            return None

    def load(self, video_path):
        path = self._resolve(video_path)
        if not path:
            return (None,)
        if not _HAVE_IMAGING:
            raise RuntimeError("PEClipVideo needs numpy/torch, which a real ComfyUI install always provides.")
        import av
        MAX_SECONDS, TARGET_FPS = 15, 24
        frames = []
        with av.open(path) as container:
            stream = container.streams.video[0]
            src_fps = float(stream.average_rate or TARGET_FPS)
            for frame in container.decode(stream):
                frames.append(frame.to_ndarray(format="rgb24"))
        if not frames:
            raise ValueError(f"No video frames could be decoded from {path}")
        # resample to 24 fps by nearest source frame, and cap at 15 s (H3's range)
        n_out = min(int(len(frames) / src_fps * TARGET_FPS), MAX_SECONDS * TARGET_FPS)
        n_out = max(n_out, 1)
        idx = [min(len(frames) - 1, int(i * src_fps / TARGET_FPS)) for i in range(n_out)]
        arr = np.stack([frames[i] for i in idx]).astype(np.float32) / 255.0
        return (torch.from_numpy(arr),)


class PEClipLora:
    """Loads one LoRA onto a MODEL (model-only, like LoraLoaderModelOnly) from the clip's
    manifest `loras[k]` — or passes the model through untouched when the clip has none, so a
    chain of these needs no bypassing.

    `lora_name` / `strength` are overwritten per clip by the JS extension. Which node is LoRA
    k: by default the PEClipLora nodes in ascending node-id order; set `index` (0-based) to pin
    it. `lora_name` is a path relative to ComfyUI's models/loras folder, e.g.
    `MinimaxH3\\foo.safetensors`.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_name": ("STRING", {"default": ""}),
                "strength": ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.01}),
            },
            "optional": {
                "index": ("INT", {"default": -1, "min": -1, "max": 15, "step": 1}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "load"
    CATEGORY = "Prompt Enhancer Bridge"

    def __init__(self):
        self._cache = None  # (path, loaded lora state dict)

    def load(self, model, lora_name, strength, index=-1):
        if not lora_name or not lora_name.strip() or strength == 0:
            return (model,)
        import folder_paths
        import comfy.sd
        import comfy.utils
        name = lora_name.strip().replace("/", os.sep).replace("\\", os.sep)
        path = folder_paths.get_full_path("loras", name)
        if not path or not os.path.isfile(path):
            match, near = resolve_lora_name(lora_name, folder_paths.get_filename_list("loras"))
            if match:
                path = folder_paths.get_full_path("loras", match)
        if not path or not os.path.isfile(path):
            hint = f" Similar: {', '.join(near)}." if near else ""
            raise FileNotFoundError(
                f"PEClipLora: LoRA '{lora_name}' not found under ComfyUI's models/loras folder.{hint}"
            )
        if self._cache and self._cache[0] == path:
            lora = self._cache[1]
        else:
            lora = comfy.utils.load_torch_file(path, safe_load=True)
            self._cache = (path, lora)
        patched, _ = comfy.sd.load_lora_for_models(model, None, lora, strength, 0)
        return (patched,)


NODE_CLASS_MAPPINGS = {
    "PEClipLora": PEClipLora,
    "PEClipPrompt": PEClipPrompt,
    "PEClipImage": PEClipImage,
    "PEClipGuideImage": PEClipGuideImage,
    "PEClipDuration": PEClipDuration,
    "PEClipAudio": PEClipAudio,
    "PEClipVideo": PEClipVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PEClipPrompt": "PE Clip Prompt",
    "PEClipImage": "PE Clip Reference Image",
    "PEClipGuideImage": "PE Clip Guide Image (Add Guide)",
    "PEClipDuration": "PE Clip Duration",
    "PEClipAudio": "PE Clip Voice (Audio)",
    "PEClipVideo": "PE Clip Reference Video",
}

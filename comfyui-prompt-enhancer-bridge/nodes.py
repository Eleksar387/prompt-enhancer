# Three small node classes that give the JS extension (web/pe_bridge.js) a
# stable, rename-proof way to find "where does this clip's prompt/reference/
# duration go" in a user's own template workflow: it patches by class_type,
# which is what ComfyUI's own /prompt payload carries (not node titles, which
# live in a separate JSON and which a user is free to rename without warning).
#
# The user builds a template workflow ONCE — their MiniMax/H3-calling
# node(s), one PEClipPrompt feeding its positive-prompt input, up to 6
# PEClipImage nodes feeding its reference-image inputs, optionally one
# PEClipDuration feeding whatever drives clip length, a Save node — and the
# JS extension clones + patches that graph once per clip in the dropped
# export's manifest.json.

import os

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


NODE_CLASS_MAPPINGS = {
    "PEClipPrompt": PEClipPrompt,
    "PEClipImage": PEClipImage,
    "PEClipDuration": PEClipDuration,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PEClipPrompt": "PE Clip Prompt",
    "PEClipImage": "PE Clip Reference Image",
    "PEClipDuration": "PE Clip Duration",
}

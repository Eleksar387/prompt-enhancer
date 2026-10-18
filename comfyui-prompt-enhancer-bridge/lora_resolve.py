# Pure LoRA-name resolution for PEClipLora (stdlib only, no ComfyUI import).
# The export manifest carries whatever the user typed in the app's "ComfyUI file" field; this
# maps it onto a name ComfyUI actually lists under models/loras.

DEFAULT_SUBFOLDER = "MinimaxH3"


def _norm(s):
    return s.strip().replace("/", "\\")


def resolve_lora_name(name, available):
    """Return (match, suggestions). `available` = names as ComfyUI lists them.
    match is None when nothing unique was found."""
    want = _norm(name)
    if not want:
        return None, []
    by_norm = {}
    for a in available:
        by_norm.setdefault(_norm(a).lower(), []).append(a)

    candidates = [want]
    if not want.lower().endswith((".safetensors", ".pt", ".ckpt")):
        candidates.append(want + ".safetensors")
    if "\\" not in want:
        candidates += [f"{DEFAULT_SUBFOLDER}\\{c}" for c in list(candidates)]
    for c in candidates:
        hit = by_norm.get(c.lower())
        if hit and len(hit) == 1:
            return hit[0], []

    # basename-only match (unique)
    base_want = want.split("\\")[-1].lower()
    bases = {base_want, base_want + ".safetensors"}
    hits = [a for a in available if _norm(a).split("\\")[-1].lower() in bases]
    if len(hits) == 1:
        return hits[0], []

    stem = base_want.rsplit(".", 1)[0]
    near = [a for a in available if stem and stem in _norm(a).lower()]
    return None, (hits or near)[:5]

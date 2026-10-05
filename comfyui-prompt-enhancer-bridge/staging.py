# Pure stdlib (zipfile / shutil / json / os / uuid / time) — no pip install
# step, so a locked-down work PC never needs outbound package access to use
# this pack. Deliberately kept independent of ComfyUI's own modules so it can
# be unit-tested without a running ComfyUI (see tests/test_staging.py).

import io
import json
import os
import shutil
import time
import uuid
import zipfile


class ManifestError(Exception):
    """The zip didn't contain a usable manifest.json, or a clip in it points
    at a reference file the zip doesn't actually have."""


def stage_zip(zip_bytes, runs_root):
    """Extract an exported Scriptwriter zip into its own run folder under
    `runs_root`, and return the manifest with every clip's reference `file`
    path rewritten to the absolute on-disk path it was staged at.

    Returns: (run_id: str, run_dir: str, manifest: dict)
    Raises: ManifestError, zipfile.BadZipFile
    """
    run_id = f"{int(time.time())}-{uuid.uuid4().hex[:8]}"
    run_dir = os.path.join(runs_root, run_id)
    os.makedirs(run_dir, exist_ok=False)

    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            # Guard against a zip-slip path escaping run_dir before writing
            # anything — every member of an export produced by this repo's
            # exportBundle() is a plain relative path, so this should never
            # trigger for a real export; it's here for any zip, trusted or not.
            for member in zf.namelist():
                dest = os.path.realpath(os.path.join(run_dir, member))
                if not dest.startswith(os.path.realpath(run_dir) + os.sep) and dest != os.path.realpath(run_dir):
                    raise ManifestError(f"Refusing to extract unsafe path in zip: {member}")
            zf.extractall(run_dir)
    except zipfile.BadZipFile:
        shutil.rmtree(run_dir, ignore_errors=True)
        raise

    manifest_path = os.path.join(run_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        shutil.rmtree(run_dir, ignore_errors=True)
        raise ManifestError(
            "This zip has no manifest.json — it looks like it was exported "
            "before this feature existed, or isn't a Prompt Enhancer export. "
            "Re-export from the Scriptwriter's Video-Prompts screen."
        )

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    for clip in manifest.get("clips", []):
        # `guides` (Add-Guide timeline anchors, an optional, chronologically
        # sorted array distinct from `references` — see PEClipGuideImage's
        # docstring in nodes.py) is staged the same way: same file layout,
        # same missing-file error, just a second key to walk.
        # `voices` (voice-timbre samples, [{file, speaker}], in the clip's order) and an optional
        # `video` are staged the same way for PEClipAudio / PEClipVideo.
        for key in ("references", "guides", "voices"):
            for ref in clip.get(key, []):
                rel = ref.get("file", "")
                abs_path = os.path.join(run_dir, *rel.split("/"))
                if not os.path.isfile(abs_path):
                    raise ManifestError(
                        f"manifest.json for clip {clip.get('clipNumber')} points at "
                        f"'{rel}', which isn't in the zip. Re-export and try again."
                    )
                ref["absPath"] = abs_path
        video = clip.get("video")
        if isinstance(video, dict) and video.get("file"):
            vpath = os.path.join(run_dir, *video["file"].split("/"))
            if not os.path.isfile(vpath):
                raise ManifestError(
                    f"manifest.json for clip {clip.get('clipNumber')} points at "
                    f"'{video['file']}', which isn't in the zip. Re-export and try again."
                )
            video["absPath"] = vpath

    director = manifest.get("director")
    if director:
        _stage_director(director, run_id, run_dir, manifest)

    return run_id, run_dir, manifest


DIRECTOR_RUN_TOKEN = "__PE_RUN__"
RUN_FOLDER = "prompt_enhancer_runs"


def _stage_director(director, run_id, run_dir, manifest):
    """Load the MiniMax H3 Director timeline from the zip and attach it to
    manifest["director"]["timeline"].

    A voice sample's `audioFile` is written in the zip as
    `__PE_RUN__/voices/<file>`; the Director reads audio relative to ComfyUI's
    input/ folder, so the token becomes `prompt_enhancer_runs/<run-id>` (the
    folder this zip was just extracted into). A voice file the zip doesn't
    contain is dropped from its subject rather than failing the whole load.
    """
    rel = director.get("file", "")
    path = os.path.join(run_dir, *rel.split("/"))
    if not os.path.isfile(path):
        raise ManifestError(
            f"manifest.json names a Director timeline '{rel}', which isn't in the zip. "
            "Re-export and try again."
        )
    with open(path, "r", encoding="utf-8") as f:
        timeline = json.load(f)
    for subject in timeline.get("subjects", []):
        voice = subject.get("voice")
        if not voice:
            continue
        audio = str(voice.get("audioFile", ""))
        if audio.startswith(DIRECTOR_RUN_TOKEN + "/"):
            inner = audio[len(DIRECTOR_RUN_TOKEN) + 1:]
            if os.path.isfile(os.path.join(run_dir, *inner.split("/"))):
                voice["audioFile"] = f"{RUN_FOLDER}/{run_id}/{inner}"
                continue
        subject["voice"] = None
    director["timeline"] = timeline

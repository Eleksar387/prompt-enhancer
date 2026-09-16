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
        for ref in clip.get("references", []):
            rel = ref.get("file", "")
            abs_path = os.path.join(run_dir, *rel.split("/"))
            if not os.path.isfile(abs_path):
                raise ManifestError(
                    f"manifest.json for clip {clip.get('clipNumber')} points at "
                    f"'{rel}', which isn't in the zip. Re-export and try again."
                )
            ref["absPath"] = abs_path

    return run_id, run_dir, manifest

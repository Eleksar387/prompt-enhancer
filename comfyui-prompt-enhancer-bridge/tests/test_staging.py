# Offline test for staging.py — no ComfyUI needed. Run with:
#   python3 comfyui-prompt-enhancer-bridge/tests/test_staging.py

import io
import json
import os
import shutil
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import staging  # noqa: E402


def make_zip(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


def sample_manifest():
    return {
        "title": "The Last Reading",
        "target": "minimax_h3",
        "aspectRatio": "16:9",
        "clips": [
            {
                "clipNumber": 1, "sceneTitle": "Reading the Dome's Chest",
                "promptFile": "prompts/clip-01.txt", "promptText": "subject_definitions:\n<Subject 1> is ...",
                "mode": "Ref2VA", "durationSec": 7, "outputName": "clip-01",
                "references": [{"file": "references/c1-mara.jpg", "role": "subject_identity", "preserve": "exact"}],
            },
            {
                "clipNumber": 2, "sceneTitle": "Reading the Dome's Chest",
                "promptFile": "prompts/clip-02.txt", "promptText": "integrated_multimodal_description:\n...",
                "mode": "T2VA", "durationSec": 6, "outputName": "clip-02",
                "references": [],
            },
        ],
    }


n = 0


def test(name, fn):
    global n
    fn()
    n += 1
    print(f"ok - {name}")


def with_tmp_root(fn):
    root = tempfile.mkdtemp(prefix="pe_bridge_test_")
    try:
        fn(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_happy_path():
    def run(root):
        zb = make_zip({
            "manifest.json": json.dumps(sample_manifest()),
            "prompts/clip-01.txt": "header\n\ntext",
            "prompts/clip-02.txt": "header\n\ntext",
            "references/c1-mara.jpg": b"\xff\xd8\xff\xe0fakejpegbytes",
            "script.json": "{}",
        })
        run_id, run_dir, manifest = staging.stage_zip(zb, root)
        assert os.path.isdir(run_dir)
        assert manifest["clips"][0]["references"][0]["absPath"] == os.path.join(run_dir, "references", "c1-mara.jpg")
        assert os.path.isfile(manifest["clips"][0]["references"][0]["absPath"])
        assert manifest["clips"][1]["references"] == []
    with_tmp_root(run)


def test_missing_manifest_raises():
    def run(root):
        zb = make_zip({"prompts/clip-01.txt": "x"})
        try:
            staging.stage_zip(zb, root)
            assert False, "expected ManifestError"
        except staging.ManifestError:
            pass
        # run_dir must be cleaned up, not left behind half-staged
        assert os.listdir(root) == []
    with_tmp_root(run)


def test_missing_referenced_file_raises():
    def run(root):
        zb = make_zip({"manifest.json": json.dumps(sample_manifest())})  # no references/c1-mara.jpg
        try:
            staging.stage_zip(zb, root)
            assert False, "expected ManifestError"
        except staging.ManifestError as e:
            assert "c1-mara.jpg" in str(e)
    with_tmp_root(run)


def test_bad_zip_raises():
    def run(root):
        try:
            staging.stage_zip(b"not a zip file", root)
            assert False, "expected BadZipFile"
        except zipfile.BadZipFile:
            pass
        assert os.listdir(root) == []
    with_tmp_root(run)


def test_each_run_gets_its_own_folder():
    def run(root):
        zb = make_zip({
            "manifest.json": json.dumps({"title": "x", "clips": []}),
        })
        id1, dir1, _ = staging.stage_zip(zb, root)
        id2, dir2, _ = staging.stage_zip(zb, root)
        assert id1 != id2
        assert dir1 != dir2
    with_tmp_root(run)


if __name__ == "__main__":
    test("happy path stages files and rewrites absPath", test_happy_path)
    test("zip with no manifest.json raises ManifestError and cleans up", test_missing_manifest_raises)
    test("manifest pointing at a missing reference file raises ManifestError", test_missing_referenced_file_raises)
    test("a non-zip upload raises BadZipFile and cleans up", test_bad_zip_raises)
    test("two runs of the same zip get distinct run folders", test_each_run_gets_its_own_folder)
    print(f"\n{n} passed")

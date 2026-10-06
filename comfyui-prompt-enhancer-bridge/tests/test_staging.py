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
                "references": [
                    {"file": "references/c1-mara.jpg", "role": "subject_identity", "preserve": "exact",
                     "anchor": {"atSeconds": 1.5, "frameIdx": 36}},
                ],
                "guides": [{"file": "references/c1-mara.jpg", "atSeconds": 1.5, "frameIdx": 36}],
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
        # guides (Add-Guide timeline anchors) staged the same way, same file
        assert manifest["clips"][0]["guides"][0]["absPath"] == os.path.join(run_dir, "references", "c1-mara.jpg")
        assert manifest["clips"][0]["guides"][0]["frameIdx"] == 36
    with_tmp_root(run)


def test_missing_guide_file_raises():
    def run(root):
        m = sample_manifest()
        m["clips"][0]["guides"] = [{"file": "references/does-not-exist.jpg", "atSeconds": 1.5, "frameIdx": 36}]
        zb = make_zip({
            "manifest.json": json.dumps(m),
            "references/c1-mara.jpg": b"\xff\xd8\xff\xe0fakejpegbytes",
        })
        try:
            staging.stage_zip(zb, root)
            assert False, "expected ManifestError"
        except staging.ManifestError as e:
            assert "does-not-exist.jpg" in str(e)
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


def test_director_timeline_is_loaded_and_voice_paths_rewritten():
    def run(root):
        timeline = {"segments": [], "subjects": [
            {"voice": {"audioFile": "__PE_RUN__/voices/mara-1.mp3", "fileName": "mara.mp3"}},
            {"voice": {"audioFile": "__PE_RUN__/voices/gone.mp3", "fileName": "gone.mp3"}},
            {"voice": None},
        ]}
        zb = make_zip({
            "manifest.json": json.dumps({"title": "x", "clips": [], "director": {"file": "director/timeline.json"}}),
            "director/timeline.json": json.dumps(timeline),
            "voices/mara-1.mp3": b"abc",
        })
        run_id, _, manifest = staging.stage_zip(zb, root)
        subs = manifest["director"]["timeline"]["subjects"]
        assert subs[0]["voice"]["audioFile"] == f"prompt_enhancer_runs/{run_id}/voices/mara-1.mp3"
        assert subs[1]["voice"] is None  # file not in the zip -> dropped, load still succeeds
        assert subs[2]["voice"] is None
    with_tmp_root(run)


def test_director_file_missing_raises():
    def run(root):
        zb = make_zip({"manifest.json": json.dumps({"clips": [], "director": {"file": "director/timeline.json"}})})
        try:
            staging.stage_zip(zb, root)
            assert False, "expected ManifestError"
        except staging.ManifestError:
            pass
    with_tmp_root(run)


def test_voices_and_video_are_staged_with_abs_paths():
    def run(root):
        m = {"title": "x", "clips": [{"clipNumber": 1, "references": [],
             "voices": [{"file": "voices/a.mp3", "speaker": "Mara"}],
             "video": {"file": "video/ref.mp4"}}]}
        zb = make_zip({"manifest.json": json.dumps(m), "voices/a.mp3": b"1", "video/ref.mp4": b"2"})
        _, run_dir, manifest = staging.stage_zip(zb, root)
        clip = manifest["clips"][0]
        assert clip["voices"][0]["absPath"] == os.path.join(run_dir, "voices", "a.mp3")
        assert clip["video"]["absPath"] == os.path.join(run_dir, "video", "ref.mp4")
    with_tmp_root(run)


def test_missing_voice_file_raises():
    def run(root):
        m = {"clips": [{"clipNumber": 1, "references": [], "voices": [{"file": "voices/gone.mp3"}]}]}
        try:
            staging.stage_zip(make_zip({"manifest.json": json.dumps(m)}), root)
            assert False, "expected ManifestError"
        except staging.ManifestError:
            pass
    with_tmp_root(run)


def test_loras_are_normalised_not_staged():
    def run(root):
        m = {"clips": [{"clipNumber": 1, "references": [],
             "loras": [{"file": " MinimaxH3\\a.safetensors ", "strength": "0.5"}, {"file": ""}, {"strength": 1}, "x"]},
             {"clipNumber": 2, "references": []}]}
        _, _, manifest = staging.stage_zip(make_zip({"manifest.json": json.dumps(m)}), root)
        assert manifest["clips"][0]["loras"] == [{"file": "MinimaxH3\\a.safetensors", "strength": 0.5}]
        assert manifest["clips"][1]["loras"] == []
    with_tmp_root(run)


if __name__ == "__main__":
    test("happy path stages files and rewrites absPath", test_happy_path)
    test("zip with no manifest.json raises ManifestError and cleans up", test_missing_manifest_raises)
    test("manifest pointing at a missing reference file raises ManifestError", test_missing_referenced_file_raises)
    test("manifest pointing at a missing guide file raises ManifestError", test_missing_guide_file_raises)
    test("a non-zip upload raises BadZipFile and cleans up", test_bad_zip_raises)
    test("two runs of the same zip get distinct run folders", test_each_run_gets_its_own_folder)
    test("director timeline loaded, voice paths rewritten", test_director_timeline_is_loaded_and_voice_paths_rewritten)
    test("missing director timeline raises ManifestError", test_director_file_missing_raises)
    test("voices and video staged with absPath", test_voices_and_video_are_staged_with_abs_paths)
    test("missing voice file raises ManifestError", test_missing_voice_file_raises)
    test("loras normalised, not staged", test_loras_are_normalised_not_staged)
    print(f"\n{n} passed")

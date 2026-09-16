# Prompt Enhancer Bridge — drop a Scriptwriter export .zip onto ComfyUI and
# get every clip's prompt + reference images patched into your own template
# workflow and queued, one /prompt submission per clip.
#
# Install: copy this whole folder into ComfyUI/custom_nodes/, restart ComfyUI.
# No pip install needed — everything here is Python stdlib + whatever a real
# ComfyUI install already ships (torch/numpy/Pillow, used only by nodes.py).
#
# See README.md for the template-workflow convention (PEClipPrompt /
# PEClipImage) and what "drop the zip" actually does.

import os
import traceback

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import staging

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


def _register_routes():
    # Deferred/guarded: importing `server` and touching PromptServer.instance
    # only works once ComfyUI's own server module has initialized it, which
    # is true by the time custom_nodes are loaded in a real ComfyUI process
    # — but stays defensive so importing this package elsewhere (e.g. the
    # offline tests) never crashes just because there's no running server.
    try:
        from aiohttp import web
        from server import PromptServer
        import folder_paths
    except Exception:
        return

    if PromptServer.instance is None:
        return

    routes = PromptServer.instance.routes

    def _runs_root():
        root = os.path.join(folder_paths.get_input_directory(), "prompt_enhancer_runs")
        os.makedirs(root, exist_ok=True)
        return root

    @routes.post("/prompt_enhancer/run_film")
    async def run_film(request):
        try:
            zip_bytes = await request.read()
            if not zip_bytes:
                return web.json_response({"error": "Empty upload."}, status=400)
            run_id, run_dir, manifest = staging.stage_zip(zip_bytes, _runs_root())
            return web.json_response({"runId": run_id, "manifest": manifest})
        except staging.ManifestError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            traceback.print_exc()
            return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)


_register_routes()

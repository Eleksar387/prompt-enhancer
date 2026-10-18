# Offline test: python3 comfyui-prompt-enhancer-bridge/tests/test_lora_resolve.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lora_resolve import resolve_lora_name

A = ["MinimaxH3\\H3_Motion_BoosterV2.safetensors", "MinimaxH3\\H3_Combat_V2.safetensors", "other\\H3_Combat_V2.safetensors", "x.safetensors"]
assert resolve_lora_name("MinimaxH3\\H3_Motion_BoosterV2.safetensors", A)[0] == A[0]
assert resolve_lora_name("H3_Motion_BoosterV2", A)[0] == A[0]
assert resolve_lora_name("minimaxh3/h3_motion_boosterv2.safetensors", A)[0] == A[0]
assert resolve_lora_name("H3_Combat_V2", A)[0] == A[1]          # default subfolder wins
assert resolve_lora_name("Motion_Booster", A) == (None, [A[0]])  # suggestion only
assert resolve_lora_name("", A) == (None, [])
print("ok")

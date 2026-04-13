"""
TriageNet v2.0 — fusion_engine.py  (FIXED)
===========================================
Standalone CLI script that mirrors the EXACT same fusion algorithm as app.py.

Usage:
  python fusion_engine.py                          # uses defaults below
  python fusion_engine.py audio.mp3 image.jpg      # pass files as arguments

Fixes applied:
  - Algorithm now matches app.py exactly (was completely different before).
  - Test filenames taken from CLI args or sensible defaults — not hardcoded oddities.
  - detected_condition used to decide audio usefulness (matches app.py logic).
  - Score clamped to 1-5 before fusion.
"""

import os
import gc
import sys
import warnings

from listener import load_models as load_audio, analyze_audio_severity
from watcher  import load_vision_model as load_vision, analyze_injury_severity

warnings.filterwarnings("ignore")


def print_banner(text):
    print("\n" + "═" * 60)
    print(f" {text.center(58)} ")
    print("═" * 60)


def run_fusion(audio_file=None, image_file=None):
    print_banner("TRIAGENET v2.0: MULTIMODAL DISPATCH")

    # ── PHASE 1: AUDIO ─────────────────────────────────────────────────────────
    a_res = {
        "audio_triage_score": 5,
        "security":           "UNKNOWN",
        "transcript":         "N/A",
        "detected_condition": "None",
    }

    if audio_file and os.path.exists(audio_file):
        a_model = load_audio()
        a_res   = analyze_audio_severity(audio_file, a_model)
        del a_model
        gc.collect()
        print("✅ Audio resources released.")
    else:
        if audio_file:
            print(f"⚠️  Audio file not found: {audio_file}")
        print("   Skipping audio pipeline.")

    # ── PHASE 2: VISION ─────────────────────────────────────────────────────────
    v_res = {
        "image_triage_score": 5,
        "security":           "UNKNOWN",
        "top_category":       "N/A",
    }

    if image_file and os.path.exists(image_file):
        v_model = load_vision()
        v_res   = analyze_injury_severity(image_file, v_model)
        del v_model
        gc.collect()
        print("✅ Vision resources released.")
    else:
        if image_file:
            print(f"⚠️  Image file not found: {image_file}")
        print("   Skipping vision pipeline.")

    # ── PHASE 3: FUSION (mirrors app.py exactly) ────────────────────────────────
    sec_a         = str(a_res.get("security", "UNKNOWN"))
    sec_v         = str(v_res.get("security", "UNKNOWN"))
    detected_cond = str(a_res.get("detected_condition", "None")).strip().lower()

    audio_submitted   = a_res.get("transcript", "N/A") not in ("N/A", "")
    audio_score_useful = audio_submitted and detected_cond not in ("none", "")
    audio_suspicious  = audio_submitted and "VERIFICATION_WARNING" in sec_a

    vision_submitted  = sec_v != "FAILED_PIXEL_SCAN" and v_res.get("top_category") != "N/A"
    vision_suspicious = vision_submitted and "VERIFICATION_WARNING" in sec_v

    # Weights
    if not audio_score_useful:
        w_a = 0.0
    elif audio_suspicious:
        w_a = 0.5
    else:
        w_a = 1.0

    if not vision_submitted:
        w_v = 0.0
    elif vision_suspicious:
        w_v = 0.6
    else:
        w_v = 1.0

    # Clamp scores
    s_a = max(1.0, min(5.0, float(a_res.get("audio_triage_score", 5))))
    s_v = max(1.0, min(5.0, float(v_res.get("image_triage_score", 5))))

    total_weight = w_a + w_v
    if total_weight == 0:
        final_score = 5
    else:
        raw_score = (w_a * s_a + w_v * s_v) / total_weight

        submitted_count  = int(audio_submitted) + int(vision_submitted)
        suspicious_count = int(audio_suspicious) + int(vision_suspicious)

        if submitted_count > 0 and suspicious_count == submitted_count:
            raw_score = min(5.0, raw_score + 1.5)
        elif suspicious_count == 1:
            raw_score = min(5.0, raw_score + 0.5)

        final_score = round(raw_score)

    # ── FINAL REPORT ────────────────────────────────────────────────────────────
    print("\n" + "█" * 60)
    print(" 🏁  FINAL INTEGRATED DISPATCH REPORT".center(60))
    print("█" * 60)
    print(f" 🎙️  AUDIO STATUS  : {sec_a}")
    print(f" 👁️  VISION STATUS : {sec_v}")
    print(f" 📝  TRANSCRIPT    : \"{str(a_res.get('transcript', 'None'))[:50]}\"")
    print(f" 🏷️  VISUAL TYPE   : {v_res.get('top_category', 'None')}")
    print(f" ⚖️  WEIGHTS       : audio={w_a}  vision={w_v}")
    print("-" * 60)
    print(f" 🚨  INTEGRATED TRIAGE SCORE : {final_score} / 5")

    if final_score <= 2:
        print(" 📢  ACTION: **PRIORITY 1** - IMMEDIATE AMBULANCE DISPATCH")
    else:
        print(" 📢  ACTION: **STABLE** - ADVISE WALK-IN CLINIC")
    print("█" * 60 + "\n")

    return final_score


if __name__ == "__main__":
    # Accept optional CLI arguments:  python fusion_engine.py audio.mp3 image.jpg
    audio_arg = sys.argv[1] if len(sys.argv) > 1 else "test_audio.mp3"
    image_arg = sys.argv[2] if len(sys.argv) > 2 else "test_image.jpg"
    run_fusion(audio_file=audio_arg, image_file=image_arg)
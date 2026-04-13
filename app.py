"""
TriageNet v2.0 — app.py  (FIXED)
=================================
Setup (run once in terminal):
  pip install flask flask-cors openai-whisper transformers pillow librosa exifread torch

Also install ffmpeg (required by Whisper on Windows):
  https://ffmpeg.org/download.html  → add the /bin folder to PATH

Run:
  python app.py

Then open: http://localhost:5000

Fixes applied:
  - Temp files now use uuid4 instead of id() — safe under concurrent requests.
  - /api/analyze/fuse validates its JSON payload before processing.
  - audio_score_useful now checks detected_condition != "None" rather than
    score != 5, so a genuine "stable" audio signal still participates in fusion.
  - Score-0 from watcher (FAILED_PIXEL_SCAN) is already fixed in watcher.py,
    but an extra guard is added here as belt-and-suspenders.
  - fusion_engine.py and app.py now share the same algorithm (app.py is canonical).
"""

import os
import gc
import uuid
import tempfile
import warnings
import traceback

warnings.filterwarnings("ignore")

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from listener import load_models as load_audio_model, analyze_audio_severity
from watcher  import load_vision_model, analyze_injury_severity

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)

_audio_model  = None
_vision_model = None


def get_audio_model():
    global _audio_model
    if _audio_model is None:
        print("Loading Whisper tiny...")
        _audio_model = load_audio_model()
        print("Whisper ready.")
    return _audio_model


def get_vision_model():
    global _vision_model
    if _vision_model is None:
        print("Loading CLIP...")
        _vision_model = load_vision_model()
        print("CLIP ready.")
    return _vision_model


def save_upload_to_temp(file_storage, suffix):
    """
    Windows-safe temp file save.
    Uses uuid4 for the filename — safe under concurrent load.
    (id() can be reused across GC'd objects in the same process.)
    """
    tmp_dir = os.path.join(tempfile.gettempdir(), "triagenet_uploads")
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_path = os.path.join(tmp_dir, f"upload_{uuid.uuid4().hex}{suffix}")
    file_storage.save(tmp_path)
    return tmp_path


def cleanup(path):
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except Exception:
        pass  # Best-effort cleanup


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/api/analyze/audio", methods=["POST"])
def analyze_audio():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file uploaded"}), 400
    f        = request.files["audio"]
    suffix   = os.path.splitext(f.filename)[1] or ".mp3"
    tmp_path = None
    try:
        tmp_path = save_upload_to_temp(f, suffix)
        result   = analyze_audio_severity(tmp_path, get_audio_model())
        return jsonify(result)
    except Exception as e:
        traceback.print_exc()
        print(f"Audio error: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        cleanup(tmp_path)
        gc.collect()


@app.route("/api/analyze/image", methods=["POST"])
def analyze_image():
    if "image" not in request.files:
        return jsonify({"error": "No image file uploaded"}), 400
    f        = request.files["image"]
    suffix   = os.path.splitext(f.filename)[1] or ".jpg"
    tmp_path = None
    try:
        tmp_path = save_upload_to_temp(f, suffix)
        result   = analyze_injury_severity(tmp_path, get_vision_model())
        return jsonify(result)
    except Exception as e:
        traceback.print_exc()
        print(f"Image error: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        cleanup(tmp_path)
        gc.collect()


@app.route("/api/analyze/fuse", methods=["POST"])
def fuse():
    # ── Input validation ────────────────────────────────────────────────────────
    data = request.get_json(force=True, silent=True)
    if not data or not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON payload"}), 400

    a_res = data.get("audio_result", {})
    v_res = data.get("vision_result", {})

    if not isinstance(a_res, dict) or not isinstance(v_res, dict):
        return jsonify({"error": "audio_result and vision_result must be objects"}), 400

    # ── Audio status ────────────────────────────────────────────────────────────
    sec_a            = str(a_res.get("security", "UNKNOWN"))
    audio_skipped    = a_res.get("skipped", False)
    audio_transcript = str(a_res.get("transcript", "")).strip()
    audio_score_raw  = a_res.get("audio_triage_score", 5)
    detected_cond    = str(a_res.get("detected_condition", "None")).strip().lower()

    # Audio was SUBMITTED if not skipped and a transcript exists
    audio_submitted = (
        not audio_skipped
        and audio_transcript != ""
        and audio_transcript.lower() not in ("no audio",)
    )

    # ── FIX: audio is useful for scoring when a real medical condition was
    #         identified by the CSV lookup — NOT merely when score != 5.
    #         Previously score==5 was treated as "no signal", but a genuine
    #         "stable / non-emergency" call (e.g. "general checkup", no match)
    #         should still participate with neutral weight.
    audio_score_useful = audio_submitted and detected_cond not in ("none", "")

    # Audio is suspicious only when the fingerprint explicitly warned
    audio_suspicious = audio_submitted and "VERIFICATION_WARNING" in sec_a

    # ── Vision status ───────────────────────────────────────────────────────────
    sec_v             = str(v_res.get("security", "UNKNOWN"))
    vision_skipped    = v_res.get("skipped", False)
    vision_submitted  = (
        not vision_skipped
        and sec_v != "FAILED_PIXEL_SCAN"
        and v_res.get("top_category") != "INVALID_IMAGE"
    )
    vision_suspicious = vision_submitted and "VERIFICATION_WARNING" in sec_v

    # ── Assign weights ──────────────────────────────────────────────────────────
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

    # ── Safe-cast scores, guard against None / non-numeric values ─────────────
    try:
        s_a = max(1.0, min(5.0, float(audio_score_raw)))
    except (TypeError, ValueError):
        s_a = 5.0

    try:
        s_v = max(1.0, min(5.0, float(v_res.get("image_triage_score", 5))))
    except (TypeError, ValueError):
        s_v = 5.0

    # ── Weighted average ────────────────────────────────────────────────────────
    total_weight = w_a + w_v

    # Always compute these so the print() below never hits a NameError
    submitted_count  = int(audio_submitted) + int(vision_submitted)
    suspicious_count = int(audio_suspicious) + int(vision_suspicious)

    if total_weight == 0:
        # No usable signal from either modality.
        # If a file WAS uploaded but yielded nothing useful (empty transcript,
        # random noise, no image) → inconclusive → score 4 (MINOR).
        # If nothing was submitted at all → fully stable → score 5.
        audio_attempted  = not audio_skipped
        vision_attempted = not vision_skipped
        final_score = 4 if (audio_attempted or vision_attempted) else 5
    else:
        raw_score = (w_a * s_a + w_v * s_v) / total_weight

        # Trust penalty: suspicious signals push score up toward stable
        if submitted_count > 0 and suspicious_count == submitted_count:
            # ALL submitted modalities suspicious → strong penalty
            raw_score = min(5.0, raw_score + 1.5)
        elif suspicious_count == 1:
            # One suspicious signal → mild penalty
            raw_score = min(5.0, raw_score + 0.5)

        final_score = round(raw_score)

    is_critical = final_score <= 2

    severity_map = {1: "CRITICAL", 2: "URGENT", 3: "MODERATE", 4: "MINOR", 5: "STABLE"}

    print(f"[FUSION] audio_submitted={audio_submitted} score_useful={audio_score_useful} "
          f"suspicious={audio_suspicious} w_a={w_a} s_a={s_a}")
    print(f"[FUSION] vision_submitted={vision_submitted} suspicious={vision_suspicious} "
          f"w_v={w_v} s_v={s_v}")
    print(f"[FUSION] suspicious_count={suspicious_count}/{submitted_count} "
          f"final_score={final_score}")

    return jsonify({
        "final_score": final_score,
        "is_critical": is_critical,
        "severity":    severity_map.get(final_score, "STABLE"),
        "action":      (
            "PRIORITY 1 — IMMEDIATE AMBULANCE DISPATCH"
            if is_critical else
            "STABLE — ADVISE WALK-IN CLINIC"
        ),
        "weights": {"audio": w_a, "vision": w_v},
        "trust_flags": {
            "audio_suspicious":  audio_suspicious,
            "vision_suspicious": vision_suspicious,
            "penalty_applied":   suspicious_count > 0,
        },
    })


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "version": "2.0"})


if __name__ == "__main__":
    print("\n" + "=" * 52)
    print("  TriageNet v2.0 -- http://localhost:5000")
    print("=" * 52 + "\n")
    app.run(host="0.0.0.0", port=5000, debug=False)
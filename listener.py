"""
TriageNet v2.0 — listener.py  (FIXED)
Acoustic fingerprinting + Whisper transcription + medical CSV lookup.

Requires: pip install openai-whisper pandas librosa numpy
Also requires ffmpeg on PATH (Windows: https://ffmpeg.org/download.html)

Fixes applied:
  - Condition matching now sorts by string length DESC (longest/most specific first)
    so "cardiac arrest" matches before "arrest", "cant breathe" before "breathe", etc.
  - Synthetic-voice threshold documented and made more conservative so noisy
    phone calls are not wrongly flagged as suspicious.
  - detected_condition key is always present in the returned dict.
"""

import whisper
import pandas as pd
import librosa
import numpy as np
import warnings
import os

warnings.filterwarnings("ignore")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(BASE_DIR, "medical_data.csv")


# ── Windows ffmpeg auto-detection ──────────────────────────────────────────────
def _ensure_ffmpeg_on_path():
    import shutil, glob
    if shutil.which("ffmpeg"):
        return  # already on PATH

    common_locations = [
        r"C:\ffmpeg\bin",
        r"C:\Program Files\ffmpeg\bin",
        r"C:\Program Files (x86)\ffmpeg\bin",
        os.path.expanduser(r"~\ffmpeg\bin"),
        os.path.expanduser(r"~\Downloads\ffmpeg\bin"),
    ]
    common_locations += glob.glob(r"C:\ffmpeg*\bin")
    common_locations += glob.glob(r"C:\Users\*\ffmpeg*\bin")

    for loc in common_locations:
        if os.path.isfile(os.path.join(loc, "ffmpeg.exe")):
            os.environ["PATH"] = loc + os.pathsep + os.environ.get("PATH", "")
            print(f"  [ffmpeg] Auto-found at: {loc}")
            return

    print("  [ffmpeg] WARNING: ffmpeg not found on PATH or common locations.")
    print("  [ffmpeg] Download from https://ffmpeg.org/download.html")
    print("  [ffmpeg] Extract and add the /bin folder to your Windows PATH.")


_ensure_ffmpeg_on_path()


def load_models():
    """Loads the Tiny Whisper model (lowest RAM usage)."""
    print("🚀 Initialising Ultra-Light Audio AI (Tiny-Whisper)...")
    return whisper.load_model("tiny")


def check_voice_authenticity(audio_path):
    """
    Detects likely-synthetic voices using spectral variance analysis.

    Human speech captured on a real microphone (including compressed phone audio)
    typically has a spectral-centroid variance > 200_000.  Very low variance
    (< 200_000) indicates either a pure-tone / TTS signal or near-silence.

    NOTE: This is a heuristic signal — do NOT use as the sole trust indicator.
    """
    try:
        y, sr = librosa.load(audio_path, duration=5, sr=None)
        if len(y) < 100:
            return "VOICE_SCAN_UNAVAILABLE"
        spectral_centroids = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
        variance = float(np.var(spectral_centroids))
        # Threshold lowered to 200_000 (was 500_000) to avoid flagging
        # normal compressed phone calls as synthetic.
        if variance < 200_000:
            return "VERIFICATION_WARNING: Possible Synthetic Speech"
        return "VOICE_AUTHENTIC"
    except Exception as ex:
        print(f"  [Fingerprint] Could not analyse audio: {ex}")
        return "VOICE_SCAN_UNAVAILABLE"


def analyze_audio_severity(audio_path, speech_model):
    print(f"\n--- Processing Audio: {audio_path} ---")

    # 1. Security check
    print("Performing Acoustic Fingerprinting...")
    security_status = check_voice_authenticity(audio_path)

    # 2. Transcribe
    print("Transcribing with Whisper...")
    transcript = ""
    try:
        result = speech_model.transcribe(audio_path, fp16=False)
        transcript = result["text"].strip().lower()
        print(f"  [Whisper] Raw transcript: '{transcript[:80]}'")
    except Exception as ex:
        print(f"  [Whisper] Transcription failed: {ex}")
        print("  [Whisper] Hint: ensure ffmpeg is on PATH and the audio file is valid.")
        transcript = ""

    # 3. Load Medical Dataset and match conditions
    audio_triage_score = 5    # Default: non-urgent / no condition detected
    detected_condition = "None"

    if os.path.exists(CSV_PATH):
        try:
            df = pd.read_csv(CSV_PATH)
            df.columns = [c.strip().lower() for c in df.columns]
            medical_lookup = dict(
                zip(df["condition"].str.lower().str.strip(), df["score"].astype(int))
            )

            # ── FIX: sort by condition length DESCENDING so the longest (most
            #         specific) phrase is tested first.  This prevents short
            #         substrings like "breathe" matching before
            #         "difficulty breathing" or "cant breathe".
            sorted_conditions = sorted(
                medical_lookup.items(),
                key=lambda x: len(x[0]),
                reverse=True,
            )

            for condition, score in sorted_conditions:
                if condition and condition in transcript:
                    audio_triage_score = score
                    detected_condition = condition
                    break  # Stop at most specific (longest) match

        except Exception as e:
            print(f"⚠️  Dataset Error: {e}")
    else:
        print(f"❌ Critical Error: {CSV_PATH} not found!")

    print("-" * 30)
    print(f"🎙️  TRANSCRIPT:    \"{transcript[:100]}\"")
    print(f"🛡️  SECURITY:      {security_status}")
    print(f"🏥  CONDITION:     {detected_condition.upper()}")
    print(f"🔢  TRIAGE SCORE:  {audio_triage_score}/5")
    print("-" * 30)

    return {
        "transcript":         transcript,
        "audio_triage_score": audio_triage_score,
        "security":           security_status,
        "detected_condition": detected_condition,
    }


if __name__ == "__main__":
    test_file = "test_audio.mp3"
    if os.path.exists(test_file):
        model = load_models()
        analyze_audio_severity(test_file, model)
    else:
        print(f"❌ File {test_file} not found in {BASE_DIR}")
        print("   Rename your test audio file to 'test_audio.mp3' or edit this path.")
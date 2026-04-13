"""
TriageNet v2.0 — watcher.py  (FIXED)
EXIF metadata check + CLIP zero-shot injury classification.

Requires: pip install transformers pillow exifread

Fixes applied:
  - FAILED_PIXEL_SCAN now returns image_triage_score=5 (no-signal / neutral)
    instead of 0, which was poisoning the fusion weighted average.
  - 'skipped' key added so fusion can tell file-not-found from real 0-results.
"""

import exifread
import gc
import warnings
import os

from transformers import pipeline
from PIL import Image

warnings.filterwarnings("ignore")


def load_vision_model():
    print("Loading Vision AI... (CLIP Model)")
    return pipeline(
        "zero-shot-image-classification",
        model="openai/clip-vit-base-patch32",
    )


def check_watermarks_and_metadata(image_path):
    """Check EXIF camera metadata as a basic authenticity signal."""
    try:
        with open(image_path, "rb") as f:
            tags = exifread.process_file(f, stop_tag="Image Make", details=False)
        camera_make = tags.get("Image Make")
        if not camera_make:
            return "VERIFICATION_WARNING: No Camera Metadata (Possible Synthetic)"
        return "METADATA_CLEAN"
    except Exception:
        return "METADATA_UNREADABLE"


def analyze_injury_severity(image_path, vision_model):
    print(f"--- Processing Image: {image_path} ---")

    # 1. Security check
    security_status = check_watermarks_and_metadata(image_path)
    print(f"Security Check: {security_status}")

    # 2. Open image
    try:
        img = Image.open(image_path).convert("RGB")
        img.thumbnail((512, 512))
    except FileNotFoundError:
        print(f"Error: Could not find '{image_path}'.")
        return {
            "top_category":      "NOT_FOUND",
            "image_triage_score": 5,   # neutral — no signal
            "security":          "FILE_ERROR",
            "skipped":           True,
        }
    except Exception as ex:
        print(f"Error opening image: {ex}")
        return {
            "top_category":      "OPEN_ERROR",
            "image_triage_score": 5,
            "security":          "FILE_ERROR",
            "skipped":           True,
        }

    # 3. Vision categories — two rounds:
    #    Round A: Is this even a medical/skin image at all?
    #    Round B: If yes, classify injury severity.
    relevance_categories = [
        "a photo of human skin or a body part",
        "a photo of an injury, wound or medical condition",
        "a landscape, building, food, animal or other non-medical photo",
        "a screenshot, document or text image",
        "a digital watermark or logo",
        "an AI generated illustration",
    ]

    injury_categories = [
        "severe bleeding and trauma",
        "a deep cut or wound",
        "a minor scrape or bruise",
        "healthy skin",
    ]

    # Minimum confidence that the image is medically relevant
    RELEVANCE_THRESHOLD = 0.30

    print("Analysing pixels...")
    try:
        # --- Round A: relevance check ---
        rel_results    = vision_model(img, candidate_labels=relevance_categories)
        rel_top_label  = rel_results[0]["label"]
        rel_confidence = rel_results[0]["score"]

        # Build a quick lookup: label → score for all relevance results
        rel_scores = {r["label"]: r["score"] for r in rel_results}

        medical_score = (
            rel_scores.get("a photo of human skin or a body part", 0) +
            rel_scores.get("a photo of an injury, wound or medical condition", 0)
        )

        print(f"  [Relevance] top='{rel_top_label}' conf={rel_confidence:.2f} "
              f"medical_combined={medical_score:.2f}")

        # Reject clearly non-medical images
        non_medical_labels = {
            "a landscape, building, food, animal or other non-medical photo",
            "a screenshot, document or text image",
        }
        if rel_top_label in non_medical_labels or medical_score < RELEVANCE_THRESHOLD:
            print("🚫 INVALID IMAGE: Not a medical/injury image.")
            del img
            gc.collect()
            return {
                "top_category":       "INVALID_IMAGE",
                "image_triage_score":  5,
                "security":           security_status,
                "confidence":         round(float(rel_confidence), 3),
                "invalid_reason":     "Not a medical or injury image. Please upload a photo of the affected body part.",
            }

        # Watermark / AI check (from relevance round)
        if "watermark" in rel_top_label or "AI" in rel_top_label:
            print(f"🛑 SECURITY ALERT: Image failed authenticity test ({rel_top_label}).")
            del img
            gc.collect()
            return {
                "top_category":       "SECURITY_VOID",
                "image_triage_score":  5,
                "security":           "FAILED_PIXEL_SCAN",
                "confidence":         round(float(rel_confidence), 3),
            }

        # --- Round B: injury severity ---
        results    = vision_model(img, candidate_labels=injury_categories)
        top_label  = results[0]["label"]
        confidence = results[0]["score"]

    except Exception as ex:
        print(f"CLIP inference error: {ex}")
        return {
            "top_category":      "INFERENCE_ERROR",
            "image_triage_score": 5,
            "security":          security_status,
        }

    # 4. Triage score mapping
    score_mapping = {
        "severe bleeding and trauma": 1,
        "a deep cut or wound":        2,
        "a minor scrape or bruise":   3,
        "healthy skin":               5,
    }

    # 5. Legacy pixel-based security alert (belt-and-suspenders)
    if "watermark" in top_label or "AI" in top_label:
        print(f"🛑 SECURITY ALERT: Image failed authenticity test ({top_label}).")
        del img
        gc.collect()
        # ── FIX: return score=5 (neutral / no-signal) instead of 0.
        #         Score 0 was pulling the weighted fusion average below 1,
        #         which caused false CRITICAL dispatches for fake images.
        return {
            "top_category":      "SECURITY_VOID",
            "image_triage_score": 5,   # neutral — image rejected, treat as no signal
            "security":          "FAILED_PIXEL_SCAN",
        }

    image_triage_score = score_mapping.get(top_label, 5)

    print("✅ ANALYSIS COMPLETE")
    print(f"Visual Category:    {top_label}  (conf={confidence:.2f})")
    print(f"Image Triage Score: {image_triage_score}/5\n")

    del img
    gc.collect()

    return {
        "top_category":       top_label,
        "image_triage_score": image_triage_score,
        "security":           security_status,
        "confidence":         round(float(confidence), 3),
    }


if __name__ == "__main__":
    classifier = load_vision_model()
    test_image_file = "test_image.jpg"
    if os.path.exists(test_image_file):
        analyze_injury_severity(test_image_file, classifier)
    else:
        print(f"File {test_image_file} not found.")
        print("Rename your test image to 'test_image.jpg' or edit this path.")
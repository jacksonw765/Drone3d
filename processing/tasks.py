"""
Drone3D Celery Tasks.

Orchestrates the full processing pipeline:
  1. Preprocess (detect input type, extract video frames if needed)
  2. Submit to NodeODM via PyODM
  3. Poll for completion
  4. Download and extract results
  4.5. Repair mesh (fill holes via PyMeshLab)
  5. Convert point cloud for Potree viewer
"""

import logging
import json as _json
import os
import shutil
import subprocess
import time
import zipfile
from pathlib import Path

from celery import shared_task
from django.conf import settings
from django.utils import timezone
from pyodm import Node
from pyodm.exceptions import NodeConnectionError, NodeResponseError

from .models import DroneFile, DroneProject
from .preprocessor import InputDetector, SRTParser, VideoPreprocessor, VideoProbe

logger = logging.getLogger("processing")
nodeodm_logger = logging.getLogger("nodeodm.console")

# NodeODM status codes
ODM_QUEUED = 10
ODM_RUNNING = 20
ODM_FAILED = 30
ODM_COMPLETED = 40
ODM_CANCELED = 50

POLL_INTERVAL = 5  # seconds


def _get_project_log_path(project) -> str:
    """Return the path to a project-specific NodeODM console log file."""
    from django.conf import settings as s
    log_dir = s.BASE_DIR / "data" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    # Sanitize project name for filename
    safe_name = "".join(
        c if c.isalnum() or c in ('-', '_') else '_'
        for c in (project.name or "unnamed")
    ).strip('_')[:50]
    short_uuid = str(project.id)[:8]
    return str(log_dir / f"nodeodm_{safe_name}_{short_uuid}.log")


def _dump_full_console_output(project, task):
    """Dump the complete NodeODM console output to a per-project log file.

    This captures ALL output lines (not just the last N) so you can
    review the full processing log after a run completes or fails.
    """
    log_path = _get_project_log_path(project)
    try:
        # Fetch all output lines from the NodeODM task
        # task.output(0) returns all lines from the beginning
        all_lines = task.output()
        if not all_lines:
            all_lines = []
    except Exception as e:
        logger.warning(f"Could not fetch full console output for {project.name}: {e}")
        all_lines = [f"[ERROR] Could not fetch console output: {e}"]

    try:
        with open(log_path, "w", encoding="utf-8") as f:
            f.write(f"{'='*80}\n")
            f.write(f"NodeODM Console Output — {project.name}\n")
            f.write(f"Project ID: {project.id}\n")
            f.write(f"Task UUID:  {project.nodeodm_task_uuid}\n")
            f.write(f"Quality:    {project.quality_preset}\n")
            f.write(f"Status:     {project.status}\n")
            f.write(f"Dumped at:  {timezone.now().isoformat()}\n")
            f.write(f"{'='*80}\n\n")
            for line in all_lines:
                f.write(line + "\n")
            f.write(f"\n{'='*80}\n")
            f.write(f"END OF OUTPUT — {len(all_lines)} lines total\n")
            f.write(f"{'='*80}\n")

        logger.info(
            f"Full NodeODM console output saved to {log_path} "
            f"({len(all_lines)} lines)"
        )
    except Exception as e:
        logger.error(f"Failed to write NodeODM log file {log_path}: {e}")


@shared_task(bind=True, max_retries=1, acks_late=True)
def process_project(self, project_id: str):
    """
    Main processing pipeline for a drone reconstruction project.
    """
    from .resource_manager import get_resource_manager

    try:
        project = DroneProject.objects.get(id=project_id)
    except DroneProject.DoesNotExist:
        logger.error(f"Project {project_id} not found")
        return

    project.celery_task_id = self.request.id
    project.processing_started_at = timezone.now()
    project.save(update_fields=["celery_task_id", "processing_started_at"])

    rm = get_resource_manager()

    try:
        # ─── Step 0: Free memory for processing ──────────
        # Evict any Ollama models + stale NodeODM tasks so
        # NodeODM gets the full VM RAM pool for SfM/MVS.
        rm.prepare_for_processing()

        # ─── Step 1: Preprocess ──────────────────────────
        _step_preprocess(project)

        # ─── Step 1.5: AI Image Enhancement (optional) ──
        if project.ai_enhance_mode != 'off':
            _step_enhance_images(project)

        # ─── Step 2: Submit to NodeODM ───────────────────
        _step_submit_to_nodeodm(project)

        # ─── Step 3: Poll for completion ─────────────────
        _step_poll_completion(project)

        # ─── Step 4: Download results ────────────────────
        _step_download_results(project)

        # ─── Step 4.5: Repair mesh (fill holes) ─────────
        _step_repair_mesh(project)

        # ─── Step 5: Convert for Potree ──────────────────
        _step_convert_potree(project)

        # ─── Step 6: AI Scene Analysis (optional) ────────
        _step_ai_analysis(project)

        # ─── Done ────────────────────────────────────────
        # AI task marks project as COMPLETED when it finishes.
        # If AI was skipped, mark complete here.
        if project.status != DroneProject.Status.ANALYZING:
            project.status = DroneProject.Status.COMPLETED
            project.progress = 100.0
            project.completed_at = timezone.now()
            project.save()
        logger.info(f"Project {project.name} pipeline completed")

        # ─── Step 7: Full cleanup ────────────────────────
        rm.cleanup_after_pipeline()
        _cleanup_project_intermediates(project)

    except Exception as exc:
        logger.exception(f"Project {project.name} failed: {exc}")
        project.status = DroneProject.Status.FAILED
        project.error_message = str(exc)[:2000]
        project.save()
        # Still cleanup on failure — free RAM for next attempt
        rm.cleanup_after_pipeline()
        raise


def _step_preprocess(project: DroneProject):
    """Detect input type and preprocess video files if needed."""
    project.status = DroneProject.Status.PREPROCESSING
    project.progress = 1.0
    project.progress_message = "Preprocessing"
    project.save(update_fields=["status", "progress", "progress_message"])

    all_files = list(project.files.all())
    filenames = [f.original_filename for f in all_files]
    file_paths = [f.file.path for f in all_files]

    # Detect overall input type
    input_type = InputDetector.detect_input_type(filenames)
    project.input_type = input_type
    project.save(update_fields=["input_type"])

    logger.info(f"Project {project.name}: input type = {input_type}")

    # Check for video files that need preprocessing
    video_files = [f for f in all_files if f.file_type == DroneFile.FileType.VIDEO]

    if video_files:
        for vf in video_files:
            # Find matching SRT
            srt_path = VideoPreprocessor.find_matching_srt(
                vf.file.path, file_paths
            )

            # Smart frame extraction — adaptive FPS, sharpness filtering,
            # full resolution preserved (no double-downscaling)
            frames_dir = os.path.join(project.upload_dir, f"frames_{vf.id}")
            frames = VideoPreprocessor.extract_frames(
                vf.file.path,
                frames_dir,
                quality_preset=project.quality_preset,
                max_frames=settings.ODM_PRESETS.get(
                    project.quality_preset, {}
                ).get("video-limit", 100),
            )

            # Geotag frames if SRT is available
            if srt_path:
                srt_entries = SRTParser.parse(srt_path)
                if srt_entries:
                    VideoPreprocessor.geotag_frames(frames, srt_entries)

            # Register extracted frames as DroneFile entries
            for frame_path in frames:
                DroneFile.objects.create(
                    project=project,
                    file=frame_path.replace(str(settings.MEDIA_ROOT) + "/", ""),
                    file_type=DroneFile.FileType.IMAGE,
                    original_filename=os.path.basename(frame_path),
                    source=DroneFile.Source.EXTRACTED,
                )

    project.progress = 2.0
    project.progress_message = "Preprocessed"
    project.save(update_fields=["progress", "progress_message"])


def _step_enhance_images(project: DroneProject):
    """AI-enhance all images before sending to NodeODM.

    Runs the enhancement pipeline (standard or super-res) on every
    image file, preserving EXIF/GPS, and swaps the DroneFile paths
    to the enhanced versions.
    """
    from .image_enhancer import ImageEnhancer

    mode = project.ai_enhance_mode
    if mode == 'off':
        return

    project.progress = 2.1
    project.progress_message = f"Enhancing images ({mode})"
    project.save(update_fields=["progress", "progress_message"])

    image_files = list(project.files.filter(file_type=DroneFile.FileType.IMAGE))
    image_paths = []
    for img in image_files:
        full_path = img.file.path
        if os.path.exists(full_path):
            image_paths.append(full_path)

    if not image_paths:
        logger.info(f"No images to enhance for {project.name}")
        return

    total = len(image_paths)
    logger.info(
        f"Starting {mode} enhancement on {total} images for {project.name}"
    )

    enhancer = ImageEnhancer()

    def on_progress(current, total_count, filename):
        pct = 2.1 + (current / max(total_count, 1)) * 0.8  # 2.1 → 2.9
        project.update_progress(pct, f"Enhancing {current}/{total_count}: {filename}")

    enhanced_paths = enhancer.enhance_batch(
        image_paths, mode=mode, progress_callback=on_progress
    )

    # Swap file paths to enhanced versions in the DB
    swapped = 0
    for img_file, enhanced_path in zip(image_files, enhanced_paths):
        if enhanced_path != img_file.file.path and os.path.exists(enhanced_path):
            # Update the DroneFile to point to the enhanced image
            rel_path = enhanced_path.replace(
                str(settings.MEDIA_ROOT) + "/", ""
            )
            img_file.file.name = rel_path
            img_file.save(update_fields=["file"])
            swapped += 1

    project.progress = 2.9
    project.progress_message = f"Enhanced {swapped}/{total} images"
    project.save(update_fields=["progress", "progress_message"])

    logger.info(
        f"Enhancement complete: {swapped}/{total} images enhanced ({mode}) "
        f"for {project.name}"
    )


def _check_images_have_gps(image_paths: list[str], sample_size: int = 10) -> bool:
    """
    Check whether any of the uploaded images contain GPS EXIF data.
    Samples up to `sample_size` images for performance.
    Returns True if at least one image has GPS coordinates.
    """
    import random
    try:
        import piexif
    except ImportError:
        logger.warning("piexif not available for GPS detection, assuming no GPS")
        return False

    paths_to_check = image_paths
    if len(paths_to_check) > sample_size:
        paths_to_check = random.sample(paths_to_check, sample_size)

    for path in paths_to_check:
        try:
            exif_dict = piexif.load(path)
            gps_data = exif_dict.get("GPS", {})
            if gps_data and piexif.GPSIFD.GPSLatitude in gps_data:
                logger.info(f"GPS data found in {os.path.basename(path)}")
                return True
        except Exception:
            continue

    logger.info("No GPS data found in any sampled images")
    return False


def _generate_geo_txt(
    image_paths: list[str],
    lat: float,
    lon: float,
    output_dir: str,
    alt: float = 50.0,
) -> str:
    """
    Generate an ODM-compatible geo.txt file that assigns the same approximate
    GPS coordinates to all images.

    ODM will auto-detect geo.txt when uploaded alongside images and use it
    for georeferencing even if images lack EXIF GPS data.

    Format:
        EPSG:4326
        image_name longitude latitude altitude
    """
    geo_path = os.path.join(output_dir, "geo.txt")
    os.makedirs(output_dir, exist_ok=True)

    with open(geo_path, "w") as f:
        f.write("EPSG:4326\n")
        for img_path in image_paths:
            filename = os.path.basename(img_path)
            # geo.txt format: image_name geo_x(lon) geo_y(lat) geo_z(alt)
            f.write(f"{filename} {lon} {lat} {alt}\n")

    logger.info(f"Generated geo.txt at {geo_path} with {len(image_paths)} entries")
    return geo_path

def _step_submit_to_nodeodm(project: DroneProject):
    """Submit images to NodeODM via PyODM."""
    project.status = DroneProject.Status.PROCESSING
    project.progress = 3.0
    project.progress_message = "Submitting to processing engine"
    project.save(update_fields=["status", "progress", "progress_message"])

    # Collect all image paths (original uploads + extracted frames)
    image_files = project.files.filter(file_type=DroneFile.FileType.IMAGE)
    image_paths = []
    for img in image_files:
        full_path = img.file.path
        if os.path.exists(full_path):
            image_paths.append(full_path)

    if not image_paths:
        raise RuntimeError("No images available for processing")

    if len(image_paths) < 3:
        raise RuntimeError(
            f"Need at least 3 images for reconstruction, got {len(image_paths)}"
        )

    logger.info(
        f"Submitting {len(image_paths)} images to NodeODM for project {project.name}"
    )

    # Get ODM options from preset
    odm_options = settings.ODM_PRESETS.get(project.quality_preset, {}).copy()

    # Remove internal-only options that NodeODM task doesn't accept
    odm_options.pop("video-limit", None)
    odm_options.pop("video-resolution", None)

    # Apply video-specific ODM overrides (sequential matcher, more features)
    # when the input came from video extraction
    if project.input_type == "video":
        video_overrides = getattr(settings, "VIDEO_ODM_OVERRIDES", {})
        odm_options.update(video_overrides)
        logger.info(
            f"Applied video ODM overrides for project {project.name}: "
            f"{video_overrides}"
        )

    # Apply user-specified advanced ODM overrides (highest priority)
    # These are set during project creation via the Advanced Configuration panel
    user_overrides = project.odm_options or {}
    if user_overrides:
        odm_options.update(user_overrides)
        logger.info(
            f"Applied {len(user_overrides)} user ODM overrides for project "
            f"{project.name}: {user_overrides}"
        )

    # Always enforce max-concurrency from the current preset / system config.
    # The project's saved odm_options may contain a stale max-concurrency=1
    # from before the performance fix. This must not override the preset value.
    preset_max_conc = settings.ODM_PRESETS.get(
        project.quality_preset, {}
    ).get("max-concurrency")
    if preset_max_conc is not None:
        odm_options["max-concurrency"] = preset_max_conc
        logger.info(f"Enforced max-concurrency={preset_max_conc} from preset")

    # ── GPS detection: adapt options for non-geotagged imagery ──
    has_gps = _check_images_have_gps(image_paths)
    if not has_gps:
        # Check if user provided an approximate location
        has_approx = (
            project.approx_latitude is not None
            and project.approx_longitude is not None
        )

        if has_approx:
            # Generate a geo.txt file that assigns the approximate location
            # to all images — ODM uses this for georeferencing
            geo_txt_path = _generate_geo_txt(
                image_paths,
                project.approx_latitude,
                project.approx_longitude,
                project.upload_dir,
            )
            # Include geo.txt as the first "image" path — NodeODM will
            # detect it automatically when it's in the same upload batch
            image_paths = [geo_txt_path] + image_paths
            logger.info(
                f"No EXIF GPS for project {project.name}, but user provided "
                f"approx location ({project.approx_latitude}, {project.approx_longitude}). "
                f"Generated geo.txt for georeferencing."
            )
        else:
            logger.info(
                f"No GPS metadata detected for project {project.name}. "
                "Disabling geo-dependent outputs (orthophoto, DSM, DTM) and "
                "enabling non-georeferenced processing."
            )
            # Remove options that require georeferenced data
            for geo_opt in ("dsm", "dtm", "auto-boundary", "orthophoto-resolution"):
                odm_options.pop(geo_opt, None)
            # Tell ODM to skip the orthophoto (requires georeferencing)
            odm_options["skip-orthophoto"] = True

    project.odm_options = odm_options
    project.save(update_fields=["odm_options"])

    # Connect to NodeODM
    try:
        node = Node(settings.NODEODM_HOST, settings.NODEODM_PORT)
        node.info()  # Test connection
    except NodeConnectionError as e:
        raise RuntimeError(f"Cannot connect to NodeODM: {e}")

    # Create task — convert options dict to list-of-dicts format for NodeODM API
    # PyODM's options_to_json does this internally, but pass as dict per PyODM API
    try:
        task = node.create_task(
            image_paths,
            options=odm_options,
            name=project.name,
        )
        project.nodeodm_task_uuid = task.uuid
        project.save(update_fields=["nodeodm_task_uuid"])
        logger.info(f"NodeODM task created: {task.uuid}")
    except NodeResponseError as e:
        raise RuntimeError(f"NodeODM rejected task: {e}")
    except TypeError as e:
        # Fallback: if PyODM chokes on dict format, convert manually
        logger.warning(f"PyODM TypeError with dict options, retrying with list format: {e}")
        options_list = [{"name": k, "value": v} for k, v in odm_options.items()]
        try:
            task = node.create_task(
                image_paths,
                options=options_list,
                name=project.name,
            )
            project.nodeodm_task_uuid = task.uuid
            project.save(update_fields=["nodeodm_task_uuid"])
            logger.info(f"NodeODM task created (list format): {task.uuid}")
        except NodeResponseError as e:
            raise RuntimeError(f"NodeODM rejected task: {e}")


def _classify_odm_error(exit_code, last_error, output_text, image_count, quality_preset):
    """
    Classify a NodeODM failure into a user-friendly error with category,
    summary, suggestion, and the raw output tail for diagnostics.

    Returns a dict with keys: category, summary, suggestion, raw_output.
    """
    output_lower = (output_text or "").lower()
    error_lower = (last_error or "").lower()
    combined = output_lower + " " + error_lower

    # ── OOM / Segfault (exit code 137 = SIGKILL/OOM, 139 = SIGSEGV) ──
    if exit_code in (137, 139, -9, -11) or "killed" in combined or "cannot allocate memory" in combined:
        ram_suggestion = {
            "ultra": "Switch to 'High' or 'Medium' quality, or reduce the number of images.",
            "high": "Switch to 'Medium' or 'Low' quality, or reduce the number of images.",
            "medium": "Switch to 'Low' quality, or reduce the number of images. Medium quality needs ~16GB RAM.",
            "low": "Your dataset may be too large even for Low quality. Try uploading fewer images (under 100).",
        }
        return {
            "category": "out_of_memory",
            "summary": "Processing ran out of memory",
            "suggestion": ram_suggestion.get(quality_preset,
                "Try a lower quality preset or reduce the number of images."),
            "raw_output": output_text,
        }

    # ── Too few images ──
    if "not enough images" in combined or "need at least" in combined:
        return {
            "category": "insufficient_images",
            "summary": "Not enough images for 3D reconstruction",
            "suggestion": (
                f"You uploaded {image_count} image(s). ODM typically needs at least "
                "20-30 overlapping images for a reliable reconstruction. "
                "Upload more images with 70%+ overlap between consecutive shots."
            ),
            "raw_output": output_text,
        }

    # ── Bad reconstruction / SfM failure ──
    if ("strange values" in combined or "reconstruction" in combined
            or "not enough features" in combined or "no matches" in combined
            or "insufficient" in combined):
        suggestions = [
            f"Uploaded {image_count} images on '{quality_preset}' quality.",
        ]
        if image_count < 20:
            suggestions.append(
                f"Only {image_count} images — try uploading at least 20-30 with good overlap."
            )
        suggestions.extend([
            "Ensure images have 70%+ side overlap and 80%+ front overlap.",
            "Avoid blurry, overexposed, or low-contrast images.",
            "Flying at a consistent altitude produces better results.",
        ])
        return {
            "category": "reconstruction_failed",
            "summary": "3D reconstruction failed due to input data issues",
            "suggestion": " ".join(suggestions),
            "raw_output": output_text,
        }

    # ── GPS / Georeferencing issues ──
    if "georeference" in combined or "gps" in combined or "coordinate" in combined:
        return {
            "category": "georeferencing_failed",
            "summary": "Georeferencing step encountered an issue",
            "suggestion": (
                "GPS metadata is not required for 3D reconstruction — the system will "
                "automatically process without it. However, if you need georeferenced "
                "outputs (orthophotos, DSM/DTM), add GPS data to your images or provide "
                "an SRT subtitle file with per-frame coordinates alongside video files."
            ),
            "raw_output": output_text,
        }

    # ── OpenMVS densification crash (common pattern from the user's error) ──
    if "densify" in combined or "openmvs" in combined or "mvs" in combined:
        return {
            "category": "densification_failed",
            "summary": "Point cloud densification crashed",
            "suggestion": (
                f"The densification stage crashed while processing {image_count} images "
                f"at '{quality_preset}' quality. This is usually caused by memory pressure. "
                "Try switching to a lower quality preset (e.g. 'Low') or reducing the number of images."
            ),
            "raw_output": output_text,
        }

    # ── Mesh generation failure ──
    if "mesh" in combined or "texturing" in combined:
        return {
            "category": "mesh_failed",
            "summary": "Mesh generation or texturing failed",
            "suggestion": (
                "The 3D mesh stage failed. This can happen with sparse point clouds. "
                "Try uploading more overlapping images or lowering the quality preset."
            ),
            "raw_output": output_text,
        }

    # ── Generic / unclassified ──
    return {
        "category": "processing_error",
        "summary": "Processing failed with an unexpected error",
        "suggestion": (
            "An unexpected error occurred during processing. "
            "Try re-running with a lower quality preset or with fewer images. "
            "Ensure your images have good overlap (70%+) and are not blurry."
        ),
        "raw_output": output_text,
    }


# ── ODM Stage Markers for Progress Estimation ────────────
# Maps console output patterns to progress sub-ranges within 5-85%
# (preprocessing uses 0-3%, post-processing uses 85-100%)
_ODM_STAGE_MARKERS = [
    {"pattern": "running odm_report",       "range": (5, 8),    "label": "Generating report"},
    {"pattern": "running dataset",          "range": (8, 12),   "label": "Preparing dataset"},
    {"pattern": "running opensfm",          "range": (12, 30),  "label": "Structure from Motion"},
    {"pattern": "extracting features",      "range": (13, 22),  "label": "Extracting features"},
    {"pattern": "matching",                 "range": (22, 30),  "label": "Matching features"},
    {"pattern": "reconstructing",           "range": (30, 38),  "label": "Reconstructing scene"},
    {"pattern": "undistorting",             "range": (38, 45),  "label": "Undistorting images"},
    {"pattern": "running openmvs",          "range": (45, 48),  "label": "Preparing dense reconstruction"},
    {"pattern": "densifypointclo",          "range": (48, 62),  "label": "Dense point cloud generation"},
    {"pattern": "running odm_filterpoints", "range": (62, 65),  "label": "Filtering point cloud"},
    {"pattern": "running odm_meshing",      "range": (65, 70),  "label": "Generating mesh"},
    {"pattern": "reconstructmesh",          "range": (66, 70),  "label": "Reconstructing mesh"},
    {"pattern": "running mvs_texturing",    "range": (70, 76),  "label": "Texturing mesh"},
    {"pattern": "texturemesh",              "range": (70, 76),  "label": "Texturing mesh"},
    {"pattern": "running odm_georef",       "range": (76, 79),  "label": "Georeferencing"},
    {"pattern": "running odm_orthophoto",   "range": (79, 82),  "label": "Generating orthophoto"},
    {"pattern": "running odm_dem",          "range": (82, 84),  "label": "Generating elevation model"},
    {"pattern": "running odm_postprocess",  "range": (84, 85),  "label": "Post-processing"},
]


def _estimate_progress_from_output(task, image_count: int) -> tuple[float, str]:
    """Parse NodeODM console output to estimate fine-grained progress.

    Returns (estimated_progress, stage_label) where progress is in the 20-80 range.
    Falls back to (0, "") if no stage can be identified.
    """
    try:
        lines = task.output(-20)
        if not lines:
            return 0, ""
    except Exception:
        return 0, ""

    # Scan lines in reverse to find the most recent stage marker
    combined = "\n".join(lines).lower()
    best_progress = 0.0
    best_label = ""

    for marker in _ODM_STAGE_MARKERS:
        if marker["pattern"] in combined:
            lo, hi = marker["range"]
            best_progress = (lo + hi) / 2.0
            best_label = marker["label"]
            # Don't break — later markers in the list represent later stages,
            # so keep scanning for a more advanced match

    # For "undistorting" we can parse "Undistorting image N" to get sub-progress
    if "undistorting" in combined and image_count > 0:
        count = 0
        for line in lines:
            if "undistorting image" in line.lower():
                count += 1
        # Rough estimate: how far through undistortion
        # The last line's image is approximate since we only see 20 lines
        lo, hi = 38, 45
        sub_frac = min(count / min(image_count, 20), 1.0)
        best_progress = lo + sub_frac * (hi - lo)
        best_label = f"Undistorting images"

    return best_progress, best_label


def _step_poll_completion(project: DroneProject):
    """Poll NodeODM until the task completes or fails."""
    node = Node(settings.NODEODM_HOST, settings.NODEODM_PORT)
    task = node.get_task(project.nodeodm_task_uuid)

    image_count = project.files.filter(
        file_type=DroneFile.FileType.IMAGE
    ).count()

    # Track how many console output lines we've already logged
    # so we only stream new lines each poll cycle
    _last_line_count = 0

    while True:
        info = task.info()
        status_code = info.status.value if hasattr(info.status, "value") else info.status

        if status_code == ODM_COMPLETED:
            # Dump full console output before we lose access to the task
            _dump_full_console_output(project, task)

            project.progress = 85.0
            project.progress_message = "Processing complete"
            project.save(update_fields=["progress", "progress_message"])
            logger.info(f"NodeODM task {task.uuid} completed")
            return

        elif status_code == ODM_FAILED:
            # Dump full console output for diagnostics
            _dump_full_console_output(project, task)

            last_error = getattr(info, "last_error", "Unknown error") or "Unknown error"

            # Grab the last 80 lines of NodeODM console output for classification
            output_tail = ""
            try:
                output_lines = task.output(-80)
                output_tail = "\n".join(output_lines) if output_lines else ""
            except Exception:
                pass

            logger.error(
                f"NodeODM task {task.uuid} failed.\n"
                f"Last error: {last_error}\n"
                f"Output tail:\n{output_tail}"
            )

            # Extract exit code from output if available
            exit_code = None
            for line in (output_tail or "").split("\n"):
                if "child returned" in line.lower():
                    try:
                        exit_code = int(line.strip().split()[-1])
                    except (ValueError, IndexError):
                        pass

            # Classify the error
            error_detail = _classify_odm_error(
                exit_code=exit_code,
                last_error=last_error,
                output_text=output_tail,
                image_count=image_count,
                quality_preset=project.quality_preset,
            )

            # Build a user-facing error message with the structured detail
            user_message = (
                f"{error_detail['summary']}\n\n"
                f"💡 {error_detail['suggestion']}"
            )
            stored_message = _json.dumps({
                "category": error_detail["category"],
                "summary": error_detail["summary"],
                "suggestion": error_detail["suggestion"],
                "image_count": image_count,
                "quality_preset": project.quality_preset,
                "exit_code": exit_code,
                "raw_output": (error_detail.get("raw_output") or "")[:3000],
            })

            project.error_message = stored_message[:2000]
            project.save(update_fields=["error_message"])

            raise RuntimeError(user_message)

        elif status_code == ODM_CANCELED:
            # Try to dump what we can before raising
            try:
                _dump_full_console_output(project, task)
            except Exception:
                pass
            raise RuntimeError("NodeODM task was canceled")

        elif status_code == ODM_RUNNING:
            # ── Stream new console output lines to the nodeodm logger ──
            try:
                recent_lines = task.output(-50)
                if recent_lines and len(recent_lines) > _last_line_count:
                    new_lines = recent_lines[_last_line_count:]
                    for line in new_lines:
                        nodeodm_logger.info(
                            f"[{project.name}] {line}"
                        )
                    _last_line_count = len(recent_lines)
            except Exception:
                pass

            # Primary: use ODM's own progress if it's meaningful (> 0)
            odm_progress = getattr(info, "progress", 0) or 0
            # Map ODM's 0-100 into our 5-85 range
            mapped_progress = 5.0 + (odm_progress * 0.8)

            # Secondary: parse console output for finer-grained stage estimation
            stage_progress, stage_label = _estimate_progress_from_output(
                task, image_count
            )

            # Use whichever is higher — ODM progress or our stage estimate
            # This prevents the bar from going backwards
            final_progress = max(mapped_progress, stage_progress)

            # Never go backwards
            if final_progress > project.progress:
                project.progress = final_progress

            # Always update the stage label if we have one
            if stage_label:
                project.progress_message = stage_label

            project.save(update_fields=["progress", "progress_message"])

        time.sleep(POLL_INTERVAL)


def _step_download_results(project: DroneProject):
    """Download and extract results from NodeODM."""
    project.progress = 86.0
    project.progress_message = "Downloading results"
    project.save(update_fields=["progress", "progress_message"])

    node = Node(settings.NODEODM_HOST, settings.NODEODM_PORT)
    task = node.get_task(project.nodeodm_task_uuid)

    output_dir = project.output_dir

    # Clean up any stale output from a previous run
    if os.path.exists(output_dir):
        shutil.rmtree(output_dir)
    os.makedirs(output_dir, exist_ok=True)

    # Download results zip — PyODM's download_zip() expects a DIRECTORY,
    # it creates the zip file inside it with an auto-generated name
    logger.info(f"Downloading results to {output_dir}")
    zip_path = task.download_zip(output_dir)
    logger.info(f"Downloaded zip: {zip_path}")

    project.progress = 90.0
    project.progress_message = "Extracting results"
    project.save(update_fields=["progress", "progress_message"])

    # Extract zip
    logger.info(f"Extracting results to {output_dir}")
    with zipfile.ZipFile(zip_path, "r") as zf:
        # Log zip contents for debugging
        names = zf.namelist()
        logger.info(f"Zip contains {len(names)} entries. First 20: {names[:20]}")
        zf.extractall(output_dir)

    # Remove zip to save space
    try:
        os.remove(zip_path)
    except OSError:
        pass

    # Log what actually ended up on disk
    for dirpath, dirnames, filenames in os.walk(output_dir):
        rel = os.path.relpath(dirpath, output_dir)
        for f in filenames[:10]:  # limit log noise
            logger.info(f"  OUTPUT FILE: {rel}/{f}")

    # Map known output files
    _map_output_paths(project, output_dir)

    # ── Free NodeODM memory ──────────────────────────────
    # Results are now on disk. Remove the NodeODM task to release
    # all cached images/intermediates from RAM so Ollama can use it.
    try:
        task.remove()
        logger.info(
            f"Removed NodeODM task {project.nodeodm_task_uuid} to free memory "
            f"(results already extracted to {output_dir})"
        )
    except Exception as e:
        logger.warning(f"Could not remove NodeODM task for memory reclaim: {e}")

    project.progress = 92.0
    project.progress_message = "Results extracted"
    project.save(update_fields=["progress", "progress_message"])


def _map_output_paths(project: DroneProject, output_dir: str):
    """Locate ODM output files and store their paths on the project.

    Searches recursively so we find outputs even if they're nested
    inside a UUID subdirectory from the zip extraction.
    """
    output_base = Path(output_dir)

    # Filename patterns to search for (searched recursively)
    file_mapping = {
        "orthophoto_path": [
            "odm_orthophoto.tif",
        ],
        "pointcloud_path": [
            "odm_georeferenced_model.laz",
            "odm_georeferenced_model.las",
            "point_cloud.laz",
            "point_cloud.ply",
        ],
        "mesh_path": [
            "odm_textured_model_geo.obj",
            "odm_textured_model.obj",
        ],
        "dsm_path": [
            "dsm.tif",
        ],
        "dtm_path": [
            "dtm.tif",
        ],
        "tiles_3d_path": [
            "tileset.json",
        ],
    }

    for field, filenames in file_mapping.items():
        for filename in filenames:
            # Recursive glob search
            matches = list(output_base.rglob(filename))
            if matches:
                found = matches[0]
                try:
                    rel_path = str(found.relative_to(settings.MEDIA_ROOT))
                except ValueError:
                    rel_path = str(found)
                setattr(project, field, rel_path)
                logger.info(f"Found {field}: {rel_path}")
                break
        else:
            logger.info(f"Not found: {field} (searched for {filenames})")

    project.save()


def _step_repair_mesh(project: DroneProject):
    """Repair mesh: remove floating fragments, then fill small holes."""
    if not project.mesh_path:
        logger.warning("No mesh found, skipping mesh repair")
        return

    mesh_abs = os.path.join(str(settings.MEDIA_ROOT), project.mesh_path)
    if not os.path.exists(mesh_abs):
        logger.warning(f"Mesh file missing on disk: {mesh_abs}")
        return

    max_edges = settings.MESH_HOLE_FILL_MAX_EDGES
    min_ratio = settings.MESH_MIN_COMPONENT_RATIO

    if max_edges <= 0 and min_ratio <= 0:
        logger.info("Mesh repair disabled (hole fill and fragment removal both off)")
        return

    project.progress = 92.0
    project.progress_message = "Repairing mesh"
    project.save(update_fields=["progress", "progress_message"])

    try:
        import pymeshlab
    except ImportError:
        logger.warning("pymeshlab not installed — skipping mesh repair")
        return

    try:
        ms = pymeshlab.MeshSet()
        ms.load_new_mesh(mesh_abs)
        initial_faces = ms.current_mesh().face_number()
        modified = False

        # ── Phase 1: Remove disconnected floating fragments ──
        if min_ratio > 0 and initial_faces > 0:
            min_faces = int(initial_faces * min_ratio)
            # Keep only components with at least min_faces faces
            ms.meshing_remove_connected_component_by_face_number(
                mincomponentsize=max(min_faces, 50),
            )
            after_strip = ms.current_mesh().face_number()
            removed = initial_faces - after_strip
            if removed > 0:
                modified = True
                logger.info(
                    f"Fragment removal: {initial_faces} → {after_strip} faces "
                    f"({removed} removed, min_component={max(min_faces, 50)} faces)"
                )
            else:
                logger.info("No floating fragments found")

        # ── Phase 2: Fill small/medium holes ──
        if max_edges > 0:
            before_fill = ms.current_mesh().face_number()
            ms.meshing_close_holes(maxholesize=max_edges)
            after_fill = ms.current_mesh().face_number()
            filled = after_fill - before_fill
            if filled > 0:
                modified = True
                logger.info(
                    f"Hole fill: {before_fill} → {after_fill} faces "
                    f"({filled} added, max_edges={max_edges})"
                )
            else:
                logger.info("No holes filled")

        if modified:
            ms.save_current_mesh(mesh_abs)
            logger.info(f"Saved repaired mesh to {mesh_abs}")
        else:
            logger.info("Mesh unchanged — no repairs needed")
    except Exception as e:
        logger.warning(f"Mesh repair failed (non-fatal, keeping original): {e}")

    project.progress = 92.5
    project.progress_message = "Mesh repaired"
    project.save(update_fields=["progress", "progress_message"])


def _step_convert_potree(project: DroneProject):
    """Convert point cloud to Potree octree format for browser viewing."""
    project.progress = 93.0
    project.save(update_fields=["progress"])

    if not project.pointcloud_path:
        logger.warning("No point cloud found, skipping Potree conversion")
        return

    input_path = os.path.join(str(settings.MEDIA_ROOT), project.pointcloud_path)

    # Verify input exists
    if not os.path.exists(input_path):
        logger.error(f"Point cloud file does not exist: {input_path}")
        return

    input_size_mb = os.path.getsize(input_path) / (1024 * 1024)
    logger.info(f"Point cloud input: {input_path} ({input_size_mb:.1f} MB)")

    potree_dir = os.path.join(project.output_dir, "potree")
    os.makedirs(potree_dir, exist_ok=True)

    cmd = [
        "PotreeConverter",
        input_path,
        "-o", potree_dir,
    ]

    logger.info(f"Running PotreeConverter: {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=1800,  # 30 min timeout
        )
        logger.info(f"PotreeConverter exit code: {result.returncode}")
        if result.stdout:
            logger.info(f"PotreeConverter stdout: {result.stdout[:1000]}")
        if result.stderr:
            logger.warning(f"PotreeConverter stderr: {result.stderr[:1000]}")

        if result.returncode != 0:
            logger.error("PotreeConverter failed (non-zero exit). Skipping Potree output.")
            return
    except FileNotFoundError:
        logger.error("PotreeConverter binary not found! Is it installed in the Docker image?")
        return
    except subprocess.TimeoutExpired:
        logger.error("PotreeConverter timed out after 30 minutes")
        return

    # Log what PotreeConverter produced
    for dirpath, dirnames, filenames in os.walk(potree_dir):
        rel = os.path.relpath(dirpath, potree_dir)
        for f in filenames:
            logger.info(f"  POTREE FILE: {rel}/{f}")

    # Store potree output path
    potree_metadata = os.path.join(potree_dir, "metadata.json")
    if os.path.exists(potree_metadata):
        rel_path = str(
            Path(potree_dir).relative_to(settings.MEDIA_ROOT)
        )
        project.potree_output_path = rel_path
        project.save(update_fields=["potree_output_path"])
        logger.info(f"Potree output path set: {rel_path}")
    else:
        logger.error(
            f"PotreeConverter succeeded but metadata.json not found in {potree_dir}. "
            f"Directory contents: {os.listdir(potree_dir) if os.path.exists(potree_dir) else 'MISSING'}"
        )

    project.progress = 98.0
    project.save(update_fields=["progress"])


def _step_ai_analysis(project: DroneProject):
    """Conditionally launch AI scene analysis as a Celery task.

    Supports two modes:
      - Orthophoto tile analysis (georeferenced projects)
      - Video frame analysis (non-georeferenced projects)
    """
    from django.conf import settings as django_settings
    from .resource_manager import get_resource_manager

    ai_enabled = getattr(django_settings, "AI_ANALYSIS_ENABLED", True)

    if not ai_enabled:
        logger.info(f"AI analysis disabled globally, skipping for {project.name}")
        return

    if not project.ai_analysis_enabled:
        logger.info(f"AI analysis disabled for project {project.name}")
        return

    # ── Free NodeODM memory so Ollama can load the vision model ──
    # NodeODM processing is done, results are on disk. Release all
    # NodeODM task data to make room for the ~7GB vision model.
    rm = get_resource_manager()
    rm.prepare_for_ai_analysis()

    logger.info(f"Launching AI scene analysis for project {project.name}")
    project.status = DroneProject.Status.ANALYZING
    project.update_progress(90, "Queuing AI analysis...")

    from ai_analysis.tasks import ai_scene_analysis
    ai_scene_analysis.delay(str(project.id))


@shared_task
def delete_project_data(project_id: str):
    """Securely delete all project data (uploads, outputs, intermediates)."""
    try:
        project = DroneProject.objects.get(id=project_id)
    except DroneProject.DoesNotExist:
        return

    # Delete upload directory
    upload_dir = project.upload_dir
    if os.path.exists(upload_dir):
        shutil.rmtree(upload_dir)
        logger.info(f"Deleted upload dir: {upload_dir}")

    # Delete output directory
    output_dir = project.output_dir
    if os.path.exists(output_dir):
        shutil.rmtree(output_dir)
        logger.info(f"Deleted output dir: {output_dir}")

    # Delete database records
    project.delete()
    logger.info(f"Deleted project {project_id}")


# ═════════════════════════════════════════════════════════════
#  Automated Docker / NodeODM Cleanup
# ═════════════════════════════════════════════════════════════

def _cleanup_nodeodm_stale_tasks():
    """Legacy wrapper — delegates to ResourceManager."""
    from .resource_manager import get_resource_manager
    get_resource_manager().free_nodeodm_memory()


def _cleanup_project_intermediates(project: DroneProject):
    """Remove intermediate files that are no longer needed after processing.

    Cleans up:
      - Extracted video frames (already processed by ODM)
      - Temporary preprocessing artifacts

    NOTE: If the project has no orthophoto, we keep the frames because
    the AI analysis task will use them for frame-based detection.
    """
    upload_dir = project.upload_dir
    if not os.path.exists(upload_dir):
        return

    # Don't delete frames if we'll need them for AI analysis
    # (non-georeferenced projects have no orthophoto)
    keep_frames = (
        project.ai_analysis_enabled
        and not project.orthophoto_path
        and project.status in (
            DroneProject.Status.PROCESSING,
            DroneProject.Status.ANALYZING,
            DroneProject.Status.COMPLETED,
        )
    )

    if keep_frames:
        logger.info(
            f"Preserving video frames for {project.name} "
            f"(needed for frame-based AI analysis)"
        )
        return

    cleaned_bytes = 0
    # Remove extracted frame directories (frames_<uuid>/)
    for entry in os.listdir(upload_dir):
        entry_path = os.path.join(upload_dir, entry)
        if entry.startswith("frames_") and os.path.isdir(entry_path):
            dir_size = sum(
                os.path.getsize(os.path.join(dp, f))
                for dp, _, fnames in os.walk(entry_path)
                for f in fnames
            )
            shutil.rmtree(entry_path)
            cleaned_bytes += dir_size
            logger.info(
                f"Cleaned intermediate frames dir: {entry} "
                f"({dir_size / (1024*1024):.1f} MB)"
            )

    if cleaned_bytes:
        logger.info(
            f"Project {project.name}: cleaned "
            f"{cleaned_bytes / (1024*1024):.1f} MB of intermediates"
        )


@shared_task
def cleanup_docker_resources():
    """Periodic cleanup task — sweep orphaned resources.

    Intended to be called by Celery Beat every hour as a safety net.
    Catches any resources that slipped through the post-pipeline cleanup
    (e.g. worker crash, OOM kill, network timeout).

    Cleans:
      - Stale NodeODM tasks (completed/failed/cancelled)
      - Ollama models left loaded in memory
      - Intermediate video frame directories
    """
    from .resource_manager import get_resource_manager

    logger.info("Running periodic Docker resource cleanup...")
    rm = get_resource_manager()

    # Free both NodeODM + Ollama memory if nothing is actively processing
    active_processing = DroneProject.objects.filter(
        status__in=[
            DroneProject.Status.PROCESSING,
            DroneProject.Status.PREPROCESSING,
            DroneProject.Status.ANALYZING,
        ]
    ).exists()

    if not active_processing:
        # Nothing running — safe to free everything
        rm.cleanup_after_pipeline()
    else:
        # Something is active — only clean stale NodeODM tasks
        rm.free_nodeodm_memory()

    # Clean intermediates for completed projects
    completed = DroneProject.objects.filter(
        status=DroneProject.Status.COMPLETED
    )
    cleaned_projects = 0
    for project in completed:
        upload_dir = project.upload_dir
        if os.path.exists(upload_dir):
            has_frames = any(
                e.startswith("frames_")
                for e in os.listdir(upload_dir)
                if os.path.isdir(os.path.join(upload_dir, e))
            )
            if has_frames:
                _cleanup_project_intermediates(project)
                cleaned_projects += 1

    # Log memory status for diagnostics
    status = rm.get_memory_status()
    logger.info(
        f"Periodic cleanup done. "
        f"NodeODM tasks: {status['nodeodm_tasks']} "
        f"(running: {status['nodeodm_running']}), "
        f"Ollama models loaded: {status['ollama_models_loaded']}, "
        f"Cleaned intermediates for {cleaned_projects} project(s)."
    )


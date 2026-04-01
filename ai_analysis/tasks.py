"""
AI Analysis Celery Tasks.

Stage 6 of the Drone3D processing pipeline: automated scene analysis
using the Ollama vision model. Also includes change detection and
data import tasks.
"""

import logging

from celery import shared_task
from django.conf import settings

logger = logging.getLogger("ai_analysis")


@shared_task(bind=True, max_retries=1, acks_late=True)
def ai_scene_analysis(self, project_id: str):
    """
    Stage 6: AI-powered scene analysis.

    Supports two modes:
      A) Orthophoto mode — slices GeoTIFF into tiles for georeferenced detection
      B) Frame mode — samples extracted video frames for non-georeferenced projects

    Pipeline:
      1. Check Ollama availability
      2. Determine analysis mode (ortho or frame)
      3. Analyze images with vision model
      4. Deduplicate overlapping detections (ortho mode)
      5. Save annotations to database
      6. Generate tactical summary report
      7. Unload model from memory
    """
    import os
    import time
    from processing.models import DroneProject, GeoAnnotation
    from .ollama_client import OllamaClient
    from .tile_analyzer import TileAnalyzer

    try:
        project = DroneProject.objects.get(id=project_id)
    except DroneProject.DoesNotExist:
        logger.error(f"Project {project_id} not found")
        return

    # Guard: skip if project already completed with annotations
    existing_ai_count = project.annotations.filter(source="ai").count()
    if project.status == DroneProject.Status.COMPLETED and existing_ai_count > 0:
        logger.info(
            f"Skipping AI analysis for {project.name}: already completed "
            f"with {existing_ai_count} annotations"
        )
        return {"skipped": True, "reason": "already_analyzed"}

    # Clear any stale AI annotations from previous partial runs
    if existing_ai_count > 0:
        project.annotations.filter(source="ai").delete()
        logger.info(f"Cleared {existing_ai_count} stale AI annotations for {project.name}")

    project.status = DroneProject.Status.ANALYZING
    project.update_progress(90, "AI analysis: initializing...")
    t_start = time.time()

    with OllamaClient() as client:
        # ── Step 1: Check Ollama ──
        health = client.health_check()
        if not health["available"]:
            logger.warning(
                f"Ollama not available for project {project.name}: {health.get('error')}"
            )
            project.update_progress(100, "AI analysis skipped (Ollama unavailable)")
            project.status = DroneProject.Status.COMPLETED
            project.save(update_fields=["status"])
            return {"skipped": True, "reason": "ollama_unavailable"}

        if not client.ensure_model():
            logger.warning(f"Required model not available, skipping AI analysis")
            project.update_progress(100, "AI analysis skipped (model unavailable)")
            project.status = DroneProject.Status.COMPLETED
            project.save(update_fields=["status"])
            return {"skipped": True, "reason": "model_unavailable"}

        analyzer = TileAnalyzer(client)
        confidence_threshold = getattr(settings, "AI_CONFIDENCE_THRESHOLD", 0.4)
        tile_size = getattr(settings, "AI_TILE_SIZE", 512)

        # ── Step 2: Determine analysis mode ──
        orthophoto_path = project.get_output_path("orthophoto")
        use_frames = False
        frames_dir = None

        if orthophoto_path:
            logger.info(f"Orthophoto found, using tile-based analysis for {project.name}")
        else:
            # Look for extracted video frames in the upload directory
            upload_dir = project.upload_dir
            if os.path.exists(upload_dir):
                for entry in os.listdir(upload_dir):
                    candidate = os.path.join(upload_dir, entry)
                    if entry.startswith("frames_") and os.path.isdir(candidate):
                        frames_dir = candidate
                        break
                # Also check for frames directly in upload dir
                if not frames_dir:
                    image_exts = {'.jpg', '.jpeg', '.png'}
                    has_images = any(
                        os.path.splitext(f)[1].lower() in image_exts
                        for f in os.listdir(upload_dir)
                        if os.path.isfile(os.path.join(upload_dir, f))
                    )
                    if has_images:
                        frames_dir = upload_dir

            if frames_dir:
                use_frames = True
                logger.info(f"No orthophoto, using frame-based analysis from {frames_dir}")
            else:
                logger.info(f"No orthophoto or frames for {project.name}, skipping AI")
                project.update_progress(100, "AI analysis skipped (no imagery)")
                project.status = DroneProject.Status.COMPLETED
                project.save(update_fields=["status"])
                return {"skipped": True, "reason": "no_imagery"}

        # ── Step 3: Analyze ──
        raw_detections = []

        if use_frames:
            raw_detections = _analyze_video_frames(
                analyzer, project, frames_dir, confidence_threshold
            )
            analysis_mode = "frames"
        else:
            # Orthophoto tile analysis
            project.update_progress(91, "AI analysis: slicing orthophoto...")
            tiles = analyzer.slice_orthophoto(orthophoto_path, tile_size=tile_size)

            if not tiles:
                logger.warning(f"No tiles generated from orthophoto for {project.name}")
                project.update_progress(100, "AI analysis complete (no tiles)")
                project.status = DroneProject.Status.COMPLETED
                project.save(update_fields=["status"])
                return {"skipped": True, "reason": "no_tiles"}

            project.update_progress(92, f"AI analysis: analyzing {len(tiles)} tiles...")

            for i, tile in enumerate(tiles):
                try:
                    detections = analyzer.analyze_tile(tile)
                    raw_detections.extend(detections)
                except Exception as e:
                    logger.warning(f"Tile {i} analysis failed: {e}")
                progress = 92 + (i / len(tiles)) * 4
                project.update_progress(progress, f"AI analysis: tile {i + 1}/{len(tiles)}")

            analysis_mode = "ortho"
            logger.info(f"Raw detections from {len(tiles)} tiles: {len(raw_detections)}")

        # ── Step 4: Filter and deduplicate ──
        project.update_progress(96, "AI analysis: processing detections...")

        if analysis_mode == "ortho":
            filtered = [d for d in raw_detections if d["confidence"] >= confidence_threshold]
            merged = analyzer.deduplicate_detections(filtered, distance_threshold_m=5.0)

            # Enrich with elevation
            dsm_path = project.get_output_path("dsm")
            if dsm_path:
                project.update_progress(97, "AI analysis: enriching with elevation...")
                merged = analyzer.enrich_with_elevation(merged, dsm_path)
        else:
            # For frame mode, detections are already filtered and
            # deduplication is by label similarity (no geo coords)
            merged = _deduplicate_frame_detections(raw_detections)

        # ── Step 5: Save annotations ──
        project.update_progress(97.5, "AI analysis: saving annotations...")
        annotations = []
        for det in merged:
            ann = GeoAnnotation.objects.create(
                project=project,
                label=det["label"],
                category=det["category"],
                latitude=det.get("lat", 0.0),
                longitude=det.get("lon", 0.0),
                altitude=det.get("elevation"),
                confidence=det["confidence"],
                source="ai",
                metadata=det.get("metadata", {}),
            )
            annotations.append(ann)

        logger.info(f"Saved {len(annotations)} annotations for project {project.name}")

        # ── Step 6: Generate tactical summary ──
        if annotations:
            project.update_progress(98, "AI analysis: generating tactical report...")
            try:
                report = analyzer.generate_tactical_summary(project, annotations)
                project.ai_report = report
            except Exception as e:
                logger.error(f"Tactical summary generation failed: {e}")
                project.ai_report = f"Summary generation failed: {e}"

        # ── Step 7: Unload model ──
        logger.info("Unloading AI models from memory...")
        client.unload_all_models()

    # ── Done ──
    project.status = DroneProject.Status.COMPLETED
    project.progress = 100.0
    project.progress_message = "Complete"
    from django.utils import timezone
    project.completed_at = timezone.now()
    project.save()

    elapsed = time.time() - t_start
    logger.info(
        f"AI analysis complete for {project.name} in {elapsed:.1f}s: "
        f"{len(annotations)} annotations ({analysis_mode} mode), "
        f"report={bool(project.ai_report)}"
    )
    return {
        "annotations": len(annotations),
        "report_length": len(project.ai_report),
        "mode": analysis_mode,
        "elapsed_seconds": round(elapsed, 1),
    }


def _analyze_video_frames(analyzer, project, frames_dir, confidence_threshold):
    """Analyze a sample of extracted video frames for object detection.

    Samples up to 8 evenly-spaced frames from the directory,
    runs the vision model on each, and returns detections with
    frame-relative position metadata.
    """
    import os
    import base64

    image_exts = {'.jpg', '.jpeg', '.png'}
    all_frames = sorted([
        f for f in os.listdir(frames_dir)
        if os.path.isfile(os.path.join(frames_dir, f))
        and os.path.splitext(f)[1].lower() in image_exts
    ])

    if not all_frames:
        return []

    # Sample up to 8 evenly-spaced frames for analysis
    max_frames = min(8, len(all_frames))
    step = max(1, len(all_frames) // max_frames)
    sampled = [all_frames[i * step] for i in range(max_frames) if i * step < len(all_frames)]

    logger.info(
        f"Frame analysis: sampling {len(sampled)} of {len(all_frames)} frames "
        f"from {frames_dir}"
    )

    all_detections = []
    for i, frame_name in enumerate(sampled):
        frame_path = os.path.join(frames_dir, frame_name)
        progress = 92 + (i / len(sampled)) * 4
        project.update_progress(
            progress, f"AI analysis: frame {i + 1}/{len(sampled)} ({frame_name})"
        )

        try:
            with open(frame_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")

            result = analyzer.client.structured_output(
                prompt=analyzer.ANALYSIS_PROMPT,
                schema_hint='[{"label":"...","category":"...","relative_position":[x,y],"confidence":0.0,"color_context":"...","description":"..."}]',
                images=[b64],
            )

            if not isinstance(result, list):
                continue

            for det in result:
                pos = det.get("relative_position", [0.5, 0.5])
                if not isinstance(pos, (list, tuple)) or len(pos) < 2:
                    pos = [0.5, 0.5]

                rx = max(0.0, min(1.0, float(pos[0])))
                ry = max(0.0, min(1.0, float(pos[1])))

                confidence = float(det.get("confidence", 0.5))
                confidence = max(0.0, min(1.0, confidence))

                if confidence < confidence_threshold:
                    continue

                category = analyzer._normalize_category(
                    str(det.get("category", "poi"))
                )

                all_detections.append({
                    "label": str(det.get("label", "Unknown"))[:255],
                    "category": category,
                    "lat": 0.0,
                    "lon": 0.0,
                    "confidence": confidence,
                    "metadata": {
                        "description": str(det.get("description", "")),
                        "color_context": str(det.get("color_context", "")),
                        "size_estimate": str(det.get("size_estimate", "")),
                        "source_frame": frame_name,
                        "frame_index": i,
                        "total_frames": len(sampled),
                        "relative_x": rx,
                        "relative_y": ry,
                        "analysis_mode": "video_frame",
                    },
                })

        except Exception as e:
            logger.warning(f"Frame {frame_name} analysis failed: {e}")

    logger.info(f"Frame analysis produced {len(all_detections)} raw detections")
    return all_detections


def _deduplicate_frame_detections(detections):
    """Deduplicate frame-based detections by label similarity.

    Since frame detections don't have geo-coordinates, we merge
    detections with the same label+category, keeping the highest
    confidence one and tracking all source frames.
    """
    if not detections:
        return []

    # Group by normalized label + category
    groups = {}
    for det in detections:
        key = (det["label"].lower().strip(), det["category"])
        if key not in groups:
            groups[key] = []
        groups[key].append(det)

    merged = []
    for (label, category), group in groups.items():
        # Keep the highest confidence detection
        best = max(group, key=lambda d: d["confidence"])

        # Collect all source frames
        source_frames = []
        for d in group:
            frame = d.get("metadata", {}).get("source_frame", "")
            if frame and frame not in source_frames:
                source_frames.append(frame)

        best["metadata"]["source_frames"] = source_frames
        best["metadata"]["detection_count"] = len(group)
        merged.append(best)

    logger.info(
        f"Deduplicated {len(detections)} frame detections "
        f"to {len(merged)} unique objects"
    )
    return merged


@shared_task(bind=True)
def ai_change_detection(self, project_id_before: str, project_id_after: str):
    """Run change detection between two projects.

    Computes difference heatmap and uses AI to classify changes.
    """
    from processing.models import DroneProject
    from .ollama_client import OllamaClient
    from .change_detection import ChangeDetector

    before = DroneProject.objects.get(id=project_id_before)
    after = DroneProject.objects.get(id=project_id_after)

    ortho_before = before.get_output_path("orthophoto")
    ortho_after = after.get_output_path("orthophoto")

    if not ortho_before or not ortho_after:
        return {"error": "Both projects must have orthophotos"}

    with OllamaClient() as client:
        detector = ChangeDetector(client)

        # Compute difference
        diff_map, metadata = detector.compute_difference_map(ortho_before, ortho_after)

        # Find change regions
        regions = detector.identify_change_regions(diff_map)

        # Classify changes
        classified = []
        if regions:
            classified = detector.ai_classify_changes(ortho_before, ortho_after, regions)

        # Unload model after analysis
        client.unload_all_models()

    # Save heatmap image
    import os
    heatmap_bytes = detector.generate_heatmap_image(diff_map)
    heatmap_path = os.path.join(
        after.output_dir,
        "change_heatmap.png",
    )
    os.makedirs(os.path.dirname(heatmap_path), exist_ok=True)
    with open(heatmap_path, "wb") as f:
        f.write(heatmap_bytes)

    return {
        "regions_found": len(regions),
        "classified": classified,
        "heatmap_path": heatmap_path,
        "metadata": metadata,
    }

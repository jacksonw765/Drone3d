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

    Pipeline:
      1. Check Ollama availability
      2. Slice orthophoto into analysis tiles
      3. Run each tile through vision model for object detection
      4. Deduplicate overlapping detections
      5. Enrich with elevation data from DSM
      6. Save annotations to database
      7. Generate tactical summary report
    """
    from processing.models import DroneProject, GeoAnnotation
    from .ollama_client import OllamaClient
    from .tile_analyzer import TileAnalyzer

    try:
        project = DroneProject.objects.get(id=project_id)
    except DroneProject.DoesNotExist:
        logger.error(f"Project {project_id} not found")
        return

    project.status = DroneProject.Status.ANALYZING
    project.update_progress(90, "AI analysis: initializing...")

    # Step 1: Check Ollama
    client = OllamaClient()
    health = client.health_check()
    if not health["available"]:
        logger.warning(
            f"Ollama not available for project {project.name}: {health.get('error')}"
        )
        project.update_progress(100, "AI analysis skipped (Ollama unavailable)")
        project.status = DroneProject.Status.COMPLETED
        project.save(update_fields=["status"])
        return {"skipped": True, "reason": "ollama_unavailable"}

    # Ensure model is loaded
    if not client.ensure_model():
        logger.warning(f"Required model not available, skipping AI analysis")
        project.update_progress(100, "AI analysis skipped (model unavailable)")
        project.status = DroneProject.Status.COMPLETED
        project.save(update_fields=["status"])
        return {"skipped": True, "reason": "model_unavailable"}

    analyzer = TileAnalyzer(client)

    # Step 2: Get orthophoto path
    orthophoto_path = project.get_output_path("orthophoto")
    if not orthophoto_path:
        logger.info(f"No orthophoto for project {project.name}, skipping tile analysis")
        project.update_progress(100, "AI analysis skipped (no orthophoto)")
        project.status = DroneProject.Status.COMPLETED
        project.save(update_fields=["status"])
        return {"skipped": True, "reason": "no_orthophoto"}

    # Step 3: Slice and analyze
    tile_size = getattr(settings, "AI_TILE_SIZE", 512)
    confidence_threshold = getattr(settings, "AI_CONFIDENCE_THRESHOLD", 0.4)

    project.update_progress(91, "AI analysis: slicing orthophoto...")
    tiles = analyzer.slice_orthophoto(orthophoto_path, tile_size=tile_size)

    if not tiles:
        logger.warning(f"No tiles generated from orthophoto for {project.name}")
        project.update_progress(100, "AI analysis complete (no tiles)")
        project.status = DroneProject.Status.COMPLETED
        project.save(update_fields=["status"])
        return {"skipped": True, "reason": "no_tiles"}

    project.update_progress(92, f"AI analysis: analyzing {len(tiles)} tiles...")

    raw_detections = []
    for i, tile in enumerate(tiles):
        try:
            detections = analyzer.analyze_tile(tile)
            raw_detections.extend(detections)
        except Exception as e:
            logger.warning(f"Tile {i} analysis failed: {e}")

        # Update progress (92-96% for tile analysis)
        progress = 92 + (i / len(tiles)) * 4
        project.update_progress(progress, f"AI analysis: tile {i + 1}/{len(tiles)}")

    logger.info(f"Raw detections from {len(tiles)} tiles: {len(raw_detections)}")

    # Step 4: Filter by confidence
    filtered = [d for d in raw_detections if d["confidence"] >= confidence_threshold]
    logger.info(f"After confidence filter ({confidence_threshold}): {len(filtered)}")

    # Step 5: Deduplicate
    project.update_progress(96, "AI analysis: deduplicating detections...")
    merged = analyzer.deduplicate_detections(filtered, distance_threshold_m=5.0)

    # Step 6: Enrich with elevation
    dsm_path = project.get_output_path("dsm")
    if dsm_path:
        project.update_progress(97, "AI analysis: enriching with elevation...")
        merged = analyzer.enrich_with_elevation(merged, dsm_path)

    # Step 7: Save annotations
    project.update_progress(97.5, "AI analysis: saving annotations...")
    annotations = []
    for det in merged:
        ann = GeoAnnotation.objects.create(
            project=project,
            label=det["label"],
            category=det["category"],
            latitude=det["lat"],
            longitude=det["lon"],
            altitude=det.get("elevation"),
            confidence=det["confidence"],
            source="ai",
            metadata=det.get("metadata", {}),
        )
        annotations.append(ann)

    logger.info(f"Saved {len(annotations)} annotations for project {project.name}")

    # Step 8: Generate tactical summary
    if annotations:
        project.update_progress(98, "AI analysis: generating tactical report...")
        try:
            report = analyzer.generate_tactical_summary(project, annotations)
            project.ai_report = report
        except Exception as e:
            logger.error(f"Tactical summary generation failed: {e}")
            project.ai_report = f"Summary generation failed: {e}"

    # Done
    project.status = DroneProject.Status.COMPLETED
    project.progress = 100.0
    project.progress_message = "Complete"
    from django.utils import timezone
    project.completed_at = timezone.now()
    project.save()

    logger.info(
        f"AI analysis complete for {project.name}: "
        f"{len(annotations)} annotations, report={bool(project.ai_report)}"
    )
    return {
        "annotations": len(annotations),
        "report_length": len(project.ai_report),
        "tiles_analyzed": len(tiles),
    }


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

    client = OllamaClient()
    detector = ChangeDetector(client)

    # Compute difference
    diff_map, metadata = detector.compute_difference_map(ortho_before, ortho_after)

    # Find change regions
    regions = detector.identify_change_regions(diff_map)

    # Classify changes
    classified = []
    if regions:
        classified = detector.ai_classify_changes(ortho_before, ortho_after, regions)

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

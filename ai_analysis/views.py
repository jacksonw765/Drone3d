"""
AI Analysis Views.

Provides API endpoints for AI queries, annotation management,
data import, and system status.
"""

import json
import logging
import os
import tempfile

from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_GET, require_POST

from processing.models import DroneProject, GeoAnnotation

logger = logging.getLogger("ai_analysis")


@require_POST
@csrf_protect
def ai_query(request, project_id):
    """Natural language query about a project's scene data.

    POST /ai/query/<uuid>/
    Body: {"question": "How many buildings are in the area?"}
    """
    project = get_object_or_404(DroneProject, id=project_id)

    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    question = body.get("question", "").strip()
    if not question:
        return JsonResponse({"error": "question is required"}, status=400)

    from .ollama_client import OllamaClient
    from .query_engine import SceneQueryEngine

    with OllamaClient() as client:
        engine = SceneQueryEngine(client)
        result = engine.query(project, question)

    return JsonResponse(result)


@require_POST
@csrf_protect
def ai_inspect(request, project_id):
    """Inspect a specific selected object/region in the 3D scene.

    POST /ai/inspect/<uuid>/
    Body: {
        "screenshot_b64": "...",   (optional base64 JPEG screenshot)
        "bounding_box": {"width": ..., "height": ..., "depth": ...},
        "position": {"x": ..., "y": ..., "z": ...},
        "info": {"category": "...", "label": "...", ...},
        "question": "..."  (optional, defaults to general inspection)
    }
    """
    project = get_object_or_404(DroneProject, id=project_id)

    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    from .ollama_client import OllamaClient
    from .query_engine import SceneQueryEngine

    with OllamaClient() as client:
        engine = SceneQueryEngine(client)
        result = engine.inspect_object(
            project,
            screenshot_b64=body.get("screenshot_b64"),
            screenshots=body.get("screenshots", []),
            bounding_box=body.get("bounding_box", {}),
            position=body.get("position", {}),
            info=body.get("info"),
            question=body.get("question"),
            project_name=body.get("project_name"),
        )

    return JsonResponse(result)


@require_GET
def annotations_list(request, project_id):
    """List all annotations for a project with optional filtering.

    GET /ai/annotations/<uuid>/?category=structure&source=ai
    """
    project = get_object_or_404(DroneProject, id=project_id)
    qs = project.annotations.all()

    # Optional filters
    category = request.GET.get("category")
    if category:
        qs = qs.filter(category=category)

    source = request.GET.get("source")
    if source:
        qs = qs.filter(source=source)

    min_confidence = request.GET.get("min_confidence")
    if min_confidence:
        try:
            qs = qs.filter(confidence__gte=float(min_confidence))
        except ValueError:
            pass

    annotations = []
    for ann in qs:
        annotations.append({
            "id": str(ann.id),
            "label": ann.label,
            "category": ann.category,
            "category_display": ann.get_category_display(),
            "latitude": ann.latitude,
            "longitude": ann.longitude,
            "altitude": ann.altitude,
            "confidence": ann.confidence,
            "source": ann.source,
            "source_display": ann.get_source_display(),
            "metadata": ann.metadata,
            "created_at": ann.created_at.isoformat(),
        })

    return JsonResponse({
        "project_id": str(project.id),
        "count": len(annotations),
        "annotations": annotations,
    })


@require_POST
@csrf_protect
def annotation_create(request, project_id):
    """Manually create an annotation.

    POST /ai/annotations/<uuid>/create/
    Body: {"label": "...", "category": "structure", "latitude": ..., "longitude": ...}
    """
    project = get_object_or_404(DroneProject, id=project_id)

    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    required = ["label", "latitude", "longitude"]
    for field in required:
        if field not in body:
            return JsonResponse({"error": f"{field} is required"}, status=400)

    try:
        ann = GeoAnnotation.objects.create(
            project=project,
            label=body["label"][:255],
            category=body.get("category", "poi"),
            latitude=float(body["latitude"]),
            longitude=float(body["longitude"]),
            altitude=float(body["altitude"]) if body.get("altitude") else None,
            confidence=float(body["confidence"]) if body.get("confidence") else None,
            source="manual",
            metadata=body.get("metadata", {}),
        )
        return JsonResponse({
            "id": str(ann.id),
            "label": ann.label,
            "category": ann.category,
            "latitude": ann.latitude,
            "longitude": ann.longitude,
        }, status=201)
    except (ValueError, TypeError) as e:
        return JsonResponse({"error": str(e)}, status=400)


@require_POST
@csrf_protect
def annotation_delete(request, project_id, annotation_id):
    """Delete an annotation.

    POST /ai/annotations/<uuid>/<uuid>/delete/
    """
    project = get_object_or_404(DroneProject, id=project_id)
    ann = get_object_or_404(GeoAnnotation, id=annotation_id, project=project)
    ann.delete()
    return JsonResponse({"status": "deleted"})


@require_POST
@csrf_protect
def import_data(request, project_id):
    """Import external geospatial data (GeoJSON, KML, GPX, SHP).

    POST /ai/import/<uuid>/  (multipart form with 'file' field)
    """
    project = get_object_or_404(DroneProject, id=project_id)

    uploaded_file = request.FILES.get("file")
    if not uploaded_file:
        return JsonResponse({"error": "No file provided"}, status=400)

    from .fusion import DataFusionEngine

    # Save to temp and import
    suffix = os.path.splitext(uploaded_file.name)[1]
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        for chunk in uploaded_file.chunks():
            tmp.write(chunk)
        tmp_path = tmp.name

    try:
        engine = DataFusionEngine()
        count = engine.import_vector_layer(
            project,
            tmp_path,
            source_label=uploaded_file.name,
        )
        return JsonResponse({
            "status": "ok",
            "features_imported": count,
            "filename": uploaded_file.name,
        })
    except ValueError as e:
        return JsonResponse({"error": str(e)}, status=400)
    except Exception as e:
        logger.error(f"Import failed: {e}")
        return JsonResponse({"error": str(e)}, status=500)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@require_GET
def ai_status(request):
    """Check AI system status (Ollama availability, loaded models).

    GET /ai/status/
    """
    from .ollama_client import OllamaClient

    client = OllamaClient()
    health = client.health_check()

    return JsonResponse({
        "ai_enabled": getattr(settings, "AI_ANALYSIS_ENABLED", True),
        "ollama": health,
        "configured_models": {
            "primary": getattr(settings, "OLLAMA_PRIMARY_MODEL", ""),
            "text": getattr(settings, "OLLAMA_TEXT_MODEL", ""),
        },
    })


@require_POST
@csrf_protect
def change_detection(request):
    """Trigger change detection between two projects.

    POST /ai/change-detect/
    Body: {"project_before": "<uuid>", "project_after": "<uuid>"}
    """
    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    before_id = body.get("project_before")
    after_id = body.get("project_after")

    if not before_id or not after_id:
        return JsonResponse(
            {"error": "project_before and project_after are required"},
            status=400,
        )

    # Verify both projects exist and have orthophotos
    before = get_object_or_404(DroneProject, id=before_id)
    after = get_object_or_404(DroneProject, id=after_id)

    if not before.get_output_path("orthophoto"):
        return JsonResponse(
            {"error": f"Project '{before.name}' has no orthophoto"},
            status=400,
        )
    if not after.get_output_path("orthophoto"):
        return JsonResponse(
            {"error": f"Project '{after.name}' has no orthophoto"},
            status=400,
        )

    from .tasks import ai_change_detection
    task = ai_change_detection.delay(before_id, after_id)

    return JsonResponse({
        "status": "queued",
        "task_id": task.id,
        "project_before": str(before.id),
        "project_after": str(after.id),
    })

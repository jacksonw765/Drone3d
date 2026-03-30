"""
Drone3D Processing Views.

Handles project CRUD, file uploads, and processing status endpoints.
"""

import json
import logging
import os
import traceback

from celery.result import AsyncResult
from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from .models import DroneFile, DroneProject
from .preprocessor import InputDetector
from .tasks import delete_project_data, process_project

logger = logging.getLogger("processing")


@ensure_csrf_cookie
@require_GET
def index(request):
    """Landing page with project dashboard."""
    projects = DroneProject.objects.all()
    return render(request, "index.html", {"projects": projects})



@require_POST
@csrf_protect
def create_project(request):
    """Create a new drone project."""
    try:
        data = json.loads(request.body)
        name = data.get("name", "").strip()
        quality = data.get("quality_preset", "medium")
        approx_lat = data.get("approx_latitude")
        approx_lon = data.get("approx_longitude")
        odm_overrides = data.get("odm_overrides")
    except (json.JSONDecodeError, AttributeError):
        name = request.POST.get("name", "").strip()
        quality = request.POST.get("quality_preset", "medium")
        approx_lat = request.POST.get("approx_latitude")
        approx_lon = request.POST.get("approx_longitude")
        odm_overrides = None

    if not name:
        return JsonResponse({"error": "Project name is required"}, status=400)

    if quality not in dict(DroneProject.QualityPreset.choices):
        quality = "medium"

    # Parse optional approximate location
    parsed_lat = None
    parsed_lon = None
    if approx_lat is not None and approx_lon is not None:
        try:
            parsed_lat = float(approx_lat)
            parsed_lon = float(approx_lon)
            if not (-90 <= parsed_lat <= 90 and -180 <= parsed_lon <= 180):
                parsed_lat = None
                parsed_lon = None
        except (ValueError, TypeError):
            pass

    # Validate and sanitize ODM overrides
    validated_overrides = {}
    if odm_overrides and isinstance(odm_overrides, dict):
        # Whitelist of allowed ODM option keys
        ALLOWED_ODM_KEYS = {
            "feature-quality", "matcher-type", "min-num-features",
            "pc-quality", "depthmap-resolution", "resize-to",
            "mesh-octree-depth", "use-3dmesh",
            "orthophoto-resolution", "dsm", "dtm", "skip-orthophoto",
        }
        for key, value in odm_overrides.items():
            if key in ALLOWED_ODM_KEYS:
                validated_overrides[key] = value

    project = DroneProject.objects.create(
        name=name,
        quality_preset=quality,
        approx_latitude=parsed_lat,
        approx_longitude=parsed_lon,
        odm_options=validated_overrides if validated_overrides else {},
    )

    # Create upload directory
    os.makedirs(project.upload_dir, exist_ok=True)

    logger.info(
        f"Created project '{name}' ({project.id})"
        + (f" with {len(validated_overrides)} ODM overrides" if validated_overrides else "")
    )
    return JsonResponse({
        "id": str(project.id),
        "name": project.name,
        "status": project.status,
        "quality_preset": project.quality_preset,
    }, status=201)




@require_POST
@csrf_protect
def upload_file(request, project_id):
    """Handle file upload to a project. Auto-detects file type."""
    try:
        project = get_object_or_404(DroneProject, id=project_id)

        if project.status not in (DroneProject.Status.UPLOADING, DroneProject.Status.FAILED):
            return JsonResponse(
                {"error": "Cannot upload to a project that is already processing"},
                status=400,
            )

        uploaded_file = request.FILES.get("file")
        if not uploaded_file:
            return JsonResponse({"error": "No file provided"}, status=400)

        # Detect file type
        file_type = InputDetector.classify_file(uploaded_file.name)
        if file_type == "unknown":
            return JsonResponse(
                {"error": f"Unsupported file type: {uploaded_file.name}"},
                status=400,
            )

        # Map string type to FileType enum
        type_map = {
            "image": DroneFile.FileType.IMAGE,
            "video": DroneFile.FileType.VIDEO,
            "srt": DroneFile.FileType.SRT,
        }

        # Custom upload path: uploads/<project_id>/<filename>
        upload_subdir = f"uploads/{project.id}"
        full_upload_dir = os.path.join(str(settings.MEDIA_ROOT), upload_subdir)
        os.makedirs(full_upload_dir, exist_ok=True)

        # Save file directly to disk (bypass storage layer)
        dest_path = os.path.join(full_upload_dir, uploaded_file.name)
        with open(dest_path, "wb+") as dest:
            for chunk in uploaded_file.chunks():
                dest.write(chunk)

        # Create DroneFile record with relative path
        rel_path = f"{upload_subdir}/{uploaded_file.name}"
        drone_file = DroneFile(
            project=project,
            file_type=type_map.get(file_type, DroneFile.FileType.UNKNOWN),
            original_filename=uploaded_file.name,
            source=DroneFile.Source.UPLOAD,
        )
        drone_file.file.name = rel_path
        drone_file.save()

        logger.info(f"Uploaded {uploaded_file.name} ({file_type}) to project {project.name}")

        return JsonResponse({
            "id": str(drone_file.id),
            "filename": drone_file.original_filename,
            "file_type": drone_file.file_type,
            "size": uploaded_file.size,
        }, status=201)

    except Exception as exc:
        tb = traceback.format_exc()
        logger.error(f"Upload failed: {exc}\n{tb}")
        return JsonResponse({"error": str(exc), "traceback": tb}, status=500)



@require_POST
@csrf_protect
def start_processing(request, project_id):
    """Start processing a project via Celery."""
    project = get_object_or_404(DroneProject, id=project_id)

    if project.status not in (DroneProject.Status.UPLOADING, DroneProject.Status.FAILED):
        return JsonResponse(
            {"error": f"Cannot start processing: project status is {project.status}"},
            status=400,
        )

    file_count = project.files.filter(
        file_type__in=[DroneFile.FileType.IMAGE, DroneFile.FileType.VIDEO]
    ).count()

    if file_count == 0:
        return JsonResponse(
            {"error": "Upload at least one image or video file before processing"},
            status=400,
        )

    # Queue processing task
    project.status = DroneProject.Status.QUEUED
    project.progress = 0.0
    project.error_message = None
    project.save()

    task = process_project.delay(str(project.id))
    project.celery_task_id = task.id
    project.save(update_fields=["celery_task_id"])

    logger.info(f"Queued processing for project {project.name} (task: {task.id})")

    return JsonResponse({
        "id": str(project.id),
        "status": project.status,
        "celery_task_id": task.id,
    })



@require_GET
def project_status(request, project_id):
    """Return current project status as JSON for polling."""
    project = get_object_or_404(DroneProject, id=project_id)
    counts = project.file_counts

    # Parse structured error detail if available
    error_detail = None
    error_message = project.error_message
    if error_message:
        try:
            error_detail = json.loads(error_message)
            # Use the summary as the plain-text error_message
            error_message = error_detail.get("summary", error_message)
        except (json.JSONDecodeError, TypeError):
            # Legacy plain-text error — wrap it in a basic structure
            error_detail = {
                "category": "processing_error",
                "summary": error_message[:200] if error_message else "Unknown error",
                "suggestion": "Try re-running with a lower quality preset.",
            }

    data = {
        "id": str(project.id),
        "name": project.name,
        "status": project.status,
        "status_display": project.get_status_display(),
        "progress": round(project.progress, 1),
        "progress_message": project.progress_message,
        "input_type": project.input_type,
        "quality_preset": project.quality_preset,
        "error_message": error_message,
        "error_detail": error_detail,
        "file_counts": counts,
        "created_at": project.created_at.isoformat(),
        "updated_at": project.updated_at.isoformat(),
        "completed_at": project.completed_at.isoformat() if project.completed_at else None,
        "has_orthophoto": bool(project.orthophoto_path),
        "has_pointcloud": bool(project.pointcloud_path),
        "has_mesh": bool(project.mesh_path),
        "has_potree": bool(project.potree_output_path),
        "has_3d_tiles": bool(project.tiles_3d_path),
        # AI Analysis
        "ai_analysis_enabled": project.ai_analysis_enabled,
        "has_ai_report": bool(project.ai_report),
        "annotation_count": project.annotation_count,
    }

    return JsonResponse(data)



@require_GET
def project_list(request):
    """Return all projects as JSON."""
    projects = DroneProject.objects.all()
    data = []
    for p in projects:
        counts = p.file_counts
        data.append({
            "id": str(p.id),
            "name": p.name,
            "status": p.status,
            "status_display": p.get_status_display(),
            "progress": round(p.progress, 1),
            "input_type": p.input_type,
            "quality_preset": p.quality_preset,
            "file_counts": counts,
            "created_at": p.created_at.isoformat(),
            "completed_at": p.completed_at.isoformat() if p.completed_at else None,
        })

    return JsonResponse({"projects": data})



@require_POST
@csrf_protect
def project_delete(request, project_id):
    """Delete a project and all its data."""
    project = get_object_or_404(DroneProject, id=project_id)

    # Don't allow deleting a currently processing project without canceling first
    if project.status in (DroneProject.Status.PROCESSING, DroneProject.Status.PREPROCESSING):
        # Auto-cancel before deleting
        _cancel_nodeodm_task(project)

    project_name = project.name
    delete_project_data.delay(str(project.id))

    logger.info(f"Queued deletion of project {project_name}")
    return JsonResponse({"message": f"Project '{project_name}' scheduled for deletion"})


def _cancel_nodeodm_task(project):
    """Cancel a NodeODM task and revoke the Celery task."""
    # Cancel NodeODM task
    if project.nodeodm_task_uuid:
        try:
            from pyodm import Node
            node = Node(settings.NODEODM_HOST, settings.NODEODM_PORT)
            task = node.get_task(project.nodeodm_task_uuid)
            task.cancel()
            logger.info(f"Canceled NodeODM task {project.nodeodm_task_uuid}")
        except Exception as e:
            logger.warning(f"Could not cancel NodeODM task: {e}")

    # Revoke Celery task
    if project.celery_task_id:
        try:
            AsyncResult(project.celery_task_id).revoke(terminate=True, signal='SIGTERM')
            logger.info(f"Revoked Celery task {project.celery_task_id}")
        except Exception as e:
            logger.warning(f"Could not revoke Celery task: {e}")


@require_POST
@csrf_protect
def cancel_processing(request, project_id):
    """Cancel a running processing job.

    POST /api/projects/<uuid>/cancel/
    """
    project = get_object_or_404(DroneProject, id=project_id)

    if project.status not in (
        DroneProject.Status.QUEUED,
        DroneProject.Status.PREPROCESSING,
        DroneProject.Status.PROCESSING,
        DroneProject.Status.ANALYZING,
    ):
        return JsonResponse(
            {"error": f"Project is not currently processing (status: {project.status})"},
            status=400,
        )

    _cancel_nodeodm_task(project)

    project.status = DroneProject.Status.FAILED
    project.error_message = json.dumps({
        "category": "canceled",
        "summary": "Processing was canceled by user",
        "suggestion": "You can re-run processing at any time by clicking Retry.",
    })
    project.save(update_fields=["status", "error_message"])

    logger.info(f"User canceled processing for {project.name}")
    return JsonResponse({"message": "Processing canceled", "status": "failed"})


@require_GET
def processing_logs(request, project_id):
    """Fetch live NodeODM console output for a project.

    GET /api/projects/<uuid>/logs/?lines=50
    """
    project = get_object_or_404(DroneProject, id=project_id)

    lines_count = min(int(request.GET.get("lines", 50)), 200)

    logs = []
    odm_progress = 0
    odm_status = "unknown"

    if project.nodeodm_task_uuid:
        try:
            from pyodm import Node
            node = Node(settings.NODEODM_HOST, settings.NODEODM_PORT)
            task = node.get_task(project.nodeodm_task_uuid)
            info = task.info()

            # Get status
            status_code = info.status.value if hasattr(info.status, "value") else info.status
            status_map = {10: "queued", 20: "running", 30: "failed", 40: "completed", 50: "canceled"}
            odm_status = status_map.get(status_code, "unknown")
            odm_progress = getattr(info, "progress", 0) or 0

            # Get console output
            try:
                output_lines = task.output(-lines_count)
                if output_lines:
                    logs = output_lines
            except Exception:
                pass

        except Exception as e:
            logs = [f"Could not fetch logs: {str(e)}"]

    # Build pipeline step summary
    steps = _build_pipeline_steps(project, odm_progress, odm_status)

    return JsonResponse({
        "project_id": str(project.id),
        "status": project.status,
        "progress": round(project.progress, 1),
        "odm_status": odm_status,
        "odm_progress": round(odm_progress, 1),
        "steps": steps,
        "logs": logs[-lines_count:],
    })


def _build_pipeline_steps(project, odm_progress, odm_status):
    """Build a summary of pipeline steps for the UI."""
    progress = project.progress
    status = project.status
    msg = project.progress_message or ""

    # Build 3D Reconstruction detail with stage-aware messaging
    if progress >= 5 and progress <= 85:
        if msg:
            recon_detail = f"{msg} ({progress:.0f}%)"
        else:
            recon_detail = f"NodeODM: {odm_status} ({odm_progress:.0f}%)"
    elif progress > 85:
        recon_detail = "Complete"
    else:
        recon_detail = "Waiting"

    # Build download detail with stage-aware messaging
    if 85 < progress <= 93:
        download_detail = msg if msg else "Extracting output files"
    elif progress > 93:
        download_detail = "Complete"
    else:
        download_detail = "Waiting"

    steps = [
        {
            "name": "Upload & Preprocessing",
            "status": "done" if progress > 2 else ("active" if status in ("preprocessing", "queued") else "pending"),
            "detail": "Detecting input type, extracting frames" if progress <= 2 else "Complete",
        },
        {
            "name": "Submit to NodeODM",
            "status": "done" if progress > 5 else ("active" if progress >= 2 else "pending"),
            "detail": "Uploading images to processing engine" if progress <= 5 else "Complete",
        },
        {
            "name": "3D Reconstruction",
            "status": "done" if progress > 85 else ("active" if progress >= 5 else "pending"),
            "detail": recon_detail,
        },
        {
            "name": "Download Results",
            "status": "done" if progress > 93 else ("active" if progress > 85 else "pending"),
            "detail": download_detail,
        },
        {
            "name": "Potree Conversion",
            "status": "done" if progress > 98 else ("active" if progress > 93 else "pending"),
            "detail": "Converting point cloud for browser" if 93 < progress <= 98 else (
                "Complete" if progress > 98 else "Waiting"
            ),
        },
    ]

    if project.ai_analysis_enabled:
        steps.append({
            "name": "AI Analysis",
            "status": "active" if status == "analyzing" else ("done" if status == "completed" else "pending"),
            "detail": project.progress_message or "Scene analysis" if status == "analyzing" else (
                "Complete" if status == "completed" else "Waiting"
            ),
        })

    return steps

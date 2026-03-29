"""
Drone3D Processing Views.

Handles project CRUD, file uploads, and processing status endpoints.
"""

import json
import logging
import os
import traceback

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

    # Don't allow deleting a currently processing project
    if project.status == DroneProject.Status.PROCESSING:
        return JsonResponse(
            {"error": "Cannot delete a project that is currently processing"},
            status=400,
        )

    project_name = project.name
    delete_project_data.delay(str(project.id))

    logger.info(f"Queued deletion of project {project_name}")
    return JsonResponse({"message": f"Project '{project_name}' scheduled for deletion"})

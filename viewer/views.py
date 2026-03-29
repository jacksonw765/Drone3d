"""
Drone3D Viewer Views.

Serves the interactive 3D viewer page, Potree data files,
and downloadable output files.
"""

import logging
import mimetypes
import os

from django.conf import settings

from django.http import FileResponse, Http404, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.http import require_GET

from processing.models import DroneProject

logger = logging.getLogger("viewer")



@require_GET
def project_viewer(request, project_id):
    """Render the interactive 3D viewer for a completed project."""
    project = get_object_or_404(DroneProject, id=project_id)

    if project.status != DroneProject.Status.COMPLETED:
        return render(request, "viewer.html", {
            "project": project,
            "error": f"Project is not yet completed (status: {project.get_status_display()})",
        })

    has_potree = bool(project.potree_output_path)
    has_mesh = bool(project.mesh_path)

    # Build context with available outputs
    context = {
        "project": project,
        "has_potree": has_potree,
        "has_orthophoto": bool(project.orthophoto_path),
        "has_mesh": has_mesh,
        "has_pointcloud": bool(project.pointcloud_path),
        "has_dsm": bool(project.dsm_path),
        "has_dtm": bool(project.dtm_path),
        "has_3d_tiles": bool(project.tiles_3d_path),
        "potree_data_url": f"/viewer/{project.id}/potree/" if has_potree else "",
        "mesh_data_url": f"/viewer/{project.id}/mesh-data/" if has_mesh else "",
        "mesh_filename": os.path.basename(project.mesh_path) if has_mesh else "",
    }

    return render(request, "viewer.html", context)



@require_GET
def serve_potree_data(request, project_id, path):
    """
    Serve Potree point cloud data files from the project output directory.
    Potree viewer requests metadata.json, hierarchy.bin, and octree.bin.
    """
    project = get_object_or_404(DroneProject, id=project_id)

    if not project.potree_output_path:
        raise Http404("No Potree data available for this project")

    # Construct the full file path
    potree_dir = os.path.join(str(settings.MEDIA_ROOT), project.potree_output_path)
    file_path = os.path.join(potree_dir, path)

    # Security: prevent directory traversal
    real_file = os.path.realpath(file_path)
    real_base = os.path.realpath(potree_dir)
    if not real_file.startswith(real_base):
        raise Http404("Invalid path")

    if not os.path.isfile(file_path):
        raise Http404(f"File not found: {path}")

    # Determine content type
    content_type, _ = mimetypes.guess_type(file_path)
    if content_type is None:
        if path.endswith(".bin"):
            content_type = "application/octet-stream"
        elif path.endswith(".json"):
            content_type = "application/json"
        else:
            content_type = "application/octet-stream"

    return FileResponse(
        open(file_path, "rb"),
        content_type=content_type,
    )


@require_GET
def serve_mesh_data(request, project_id, path):
    """
    Serve textured mesh files (OBJ, MTL, textures) from the project output.
    Three.js viewer requests the .obj, .mtl, and texture image files.
    """
    project = get_object_or_404(DroneProject, id=project_id)

    if not project.mesh_path:
        raise Http404("No mesh data available for this project")

    # The mesh_path points to the OBJ file; serve from its directory
    mesh_abs = os.path.join(str(settings.MEDIA_ROOT), project.mesh_path)
    mesh_dir = os.path.dirname(mesh_abs)
    file_path = os.path.join(mesh_dir, path)

    # Security: prevent directory traversal
    real_file = os.path.realpath(file_path)
    real_base = os.path.realpath(mesh_dir)
    if not real_file.startswith(real_base):
        raise Http404("Invalid path")

    if not os.path.isfile(file_path):
        raise Http404(f"File not found: {path}")

    content_type, _ = mimetypes.guess_type(file_path)
    if content_type is None:
        content_type = "application/octet-stream"

    response = FileResponse(
        open(file_path, "rb"),
        content_type=content_type,
    )
    # Allow CORS for Three.js fetch
    response["Access-Control-Allow-Origin"] = "*"
    return response



@require_GET
def download_output(request, project_id, output_type):
    """
    Serve project output files for download.
    output_type: orthophoto, pointcloud, mesh, dsm, dtm, tiles
    """
    project = get_object_or_404(DroneProject, id=project_id)

    type_field_map = {
        "orthophoto": "orthophoto_path",
        "pointcloud": "pointcloud_path",
        "mesh": "mesh_path",
        "dsm": "dsm_path",
        "dtm": "dtm_path",
        "tiles": "tiles_3d_path",
    }

    field = type_field_map.get(output_type)
    if not field:
        raise Http404(f"Unknown output type: {output_type}")

    rel_path = getattr(project, field)
    if not rel_path:
        raise Http404(f"No {output_type} output available for this project")

    file_path = os.path.join(str(settings.MEDIA_ROOT), rel_path)
    if not os.path.isfile(file_path):
        raise Http404(f"Output file not found on disk")

    content_type, _ = mimetypes.guess_type(file_path)
    if content_type is None:
        content_type = "application/octet-stream"

    filename = f"{project.name}_{output_type}{os.path.splitext(file_path)[1]}"

    response = FileResponse(
        open(file_path, "rb"),
        content_type=content_type,
        as_attachment=True,
        filename=filename,
    )
    return response



@require_GET
def viewer_info(request, project_id):
    """Return viewer configuration data as JSON."""
    project = get_object_or_404(DroneProject, id=project_id)

    return JsonResponse({
        "project_id": str(project.id),
        "project_name": project.name,
        "status": project.status,
        "has_potree": bool(project.potree_output_path),
        "has_orthophoto": bool(project.orthophoto_path),
        "has_mesh": bool(project.mesh_path),
        "has_pointcloud": bool(project.pointcloud_path),
        "potree_data_url": f"/viewer/{project.id}/potree/" if project.potree_output_path else None,
        "downloads": {
            k: f"/viewer/{project.id}/download/{k}/"
            for k, field in {
                "orthophoto": "orthophoto_path",
                "pointcloud": "pointcloud_path",
                "mesh": "mesh_path",
                "dsm": "dsm_path",
                "dtm": "dtm_path",
            }.items()
            if getattr(project, field)
        },
    })

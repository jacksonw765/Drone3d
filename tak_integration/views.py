"""
TAK Integration Views.

Serves map tiles, CoT exports, and ATAK data packages.
"""

import logging
import os

from django.conf import settings
from django.http import FileResponse, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_GET, require_POST
from django.views.decorators.csrf import csrf_protect

from processing.models import DroneProject
from .tile_server import OrthophotoTileServer

logger = logging.getLogger("tak_integration")


@require_GET
def serve_tile(request, project_id, z, x, y):
    """Serve a single map tile as PNG."""
    tile_server = OrthophotoTileServer()
    tile_data = tile_server.get_tile(str(project_id), z, x, y)

    if tile_data is None:
        # Return a transparent 1x1 PNG for missing tiles
        return HttpResponse(
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
            b"\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
            b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01"
            b"\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82",
            content_type="image/png",
        )

    return HttpResponse(tile_data, content_type="image/png")


@require_GET
def map_source_xml(request, project_id):
    """Return ATAK-compatible map source XML for this project."""
    project = get_object_or_404(DroneProject, id=project_id)
    tile_server = OrthophotoTileServer()

    host = request.get_host()
    xml = tile_server.generate_map_source_xml(
        project_id=str(project.id),
        project_name=project.name,
        host=host,
    )
    return HttpResponse(xml, content_type="application/xml")


@require_POST
@csrf_protect
def generate_tiles(request, project_id):
    """Trigger tile generation for a project's orthophoto."""
    project = get_object_or_404(DroneProject, id=project_id)

    ortho_path = project.get_output_path("orthophoto")
    if not ortho_path:
        return JsonResponse(
            {"error": "No orthophoto available for this project"},
            status=400,
        )

    tile_server = OrthophotoTileServer()
    try:
        tile_server.generate_tiles(ortho_path, str(project.id))
        return JsonResponse({"status": "ok", "message": "Tiles generated"})
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


@require_POST
@csrf_protect
def export_data_package(request, project_id):
    """Build and serve an ATAK data package for this project."""
    project = get_object_or_404(DroneProject, id=project_id)

    if project.status != DroneProject.Status.COMPLETED:
        return JsonResponse(
            {"error": "Project must be completed before export"},
            status=400,
        )

    from .data_package import build_data_package

    output_path = os.path.join(
        str(settings.MEDIA_ROOT),
        "exports",
        f"drone3d-tak-{project.id}.zip",
    )
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    try:
        build_data_package(project, output_path)
        return FileResponse(
            open(output_path, "rb"),
            content_type="application/zip",
            as_attachment=True,
            filename=f"Drone3D-TAK-{project.name}.zip",
        )
    except Exception as e:
        logger.error(f"Data package export failed: {e}")
        return JsonResponse({"error": str(e)}, status=500)

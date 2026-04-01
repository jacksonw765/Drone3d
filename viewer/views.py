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

    # Allow ?mode=mesh or ?mode=pointcloud to override the default viewer
    requested_mode = request.GET.get("mode", "").lower()
    if requested_mode == "mesh" and has_mesh:
        active_potree = False
        active_mesh = True
    elif requested_mode == "pointcloud" and has_potree:
        active_potree = True
        active_mesh = False
    else:
        active_potree = has_potree
        active_mesh = has_mesh and not has_potree

    # Compute orthophoto center for overlay positioning
    ortho_center_lat = 0
    ortho_center_lon = 0
    if project.orthophoto_path:
        try:
            from .elevation_service import get_raster_bounds
            ortho_abs = os.path.join(str(settings.MEDIA_ROOT), project.orthophoto_path)
            bounds = get_raster_bounds(ortho_abs)
            if bounds:
                ortho_center_lat = (bounds["min_lat"] + bounds["max_lat"]) / 2
                ortho_center_lon = (bounds["min_lon"] + bounds["max_lon"]) / 2
        except Exception:
            pass

    # Build context with available outputs
    context = {
        "project": project,
        "has_potree": active_potree,
        "has_orthophoto": bool(project.orthophoto_path),
        "has_mesh": active_mesh,
        "has_pointcloud": bool(project.pointcloud_path),
        "has_dsm": bool(project.dsm_path),
        "has_dtm": bool(project.dtm_path),
        "has_3d_tiles": bool(project.tiles_3d_path),
        "can_switch_to_mesh": has_mesh and active_potree,
        "can_switch_to_pointcloud": has_potree and active_mesh,
        "potree_data_url": f"/viewer/{project.id}/potree/" if active_potree else "",
        "mesh_data_url": f"/viewer/{project.id}/mesh-data/" if has_mesh else "",
        "mesh_filename": os.path.basename(project.mesh_path) if has_mesh else "",
        "ortho_center_lat": ortho_center_lat,
        "ortho_center_lon": ortho_center_lon,
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
        # Handle file types not in Python's mimetypes database
        ext = os.path.splitext(file_path)[1].lower()
        content_type = {
            ".glb": "model/gltf-binary",
            ".gltf": "model/gltf+json",
            ".bin": "application/octet-stream",
        }.get(ext, "application/octet-stream")

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
        "has_dsm": bool(project.dsm_path),
        "has_dtm": bool(project.dtm_path),
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


@require_GET
def elevation_query(request, project_id):
    """
    Query elevation at a single geographic point from the DSM or DTM.
    Query params: lat, lon, source (dsm|dtm, default dsm)
    """
    import json

    project = get_object_or_404(DroneProject, id=project_id)

    lat = request.GET.get("lat")
    lon = request.GET.get("lon")
    source = request.GET.get("source", "dsm")

    if not lat or not lon:
        return JsonResponse({"error": "lat and lon are required"}, status=400)

    try:
        lat = float(lat)
        lon = float(lon)
    except (ValueError, TypeError):
        return JsonResponse({"error": "lat and lon must be numbers"}, status=400)

    # Select raster source
    if source == "dtm":
        raster_path = project.get_output_path("dtm")
    else:
        raster_path = project.get_output_path("dsm")
        source = "dsm"

    if not raster_path:
        return JsonResponse(
            {"error": f"No {source.upper()} available for this project"},
            status=404,
        )

    from .elevation_service import sample_elevation

    elevation = sample_elevation(raster_path, lat, lon)

    if elevation is None:
        return JsonResponse(
            {"error": "Point is outside the raster extent or on nodata"},
            status=404,
        )

    return JsonResponse({
        "elevation_m": elevation,
        "source": source,
        "lat": lat,
        "lon": lon,
    })


@require_GET
def elevation_profile(request, project_id):
    """
    Sample elevation along a polyline path from the DSM or DTM.
    Query params:
        points - JSON array of [lat, lon] pairs
        samples - number of interpolation samples (default 100, max 500)
        source - dsm|dtm (default dsm)
    """
    import json

    project = get_object_or_404(DroneProject, id=project_id)

    points_raw = request.GET.get("points")
    if not points_raw:
        return JsonResponse({"error": "points parameter is required"}, status=400)

    try:
        points = json.loads(points_raw)
        if not isinstance(points, list) or len(points) < 2:
            raise ValueError("Need at least 2 points")
        points = [(float(p[0]), float(p[1])) for p in points]
    except (json.JSONDecodeError, ValueError, TypeError, IndexError) as e:
        return JsonResponse(
            {"error": f"Invalid points: {e}"},
            status=400,
        )

    num_samples = min(int(request.GET.get("samples", 100)), 500)
    source = request.GET.get("source", "dsm")

    if source == "dtm":
        raster_path = project.get_output_path("dtm")
    else:
        raster_path = project.get_output_path("dsm")
        source = "dsm"

    if not raster_path:
        return JsonResponse(
            {"error": f"No {source.upper()} available for this project"},
            status=404,
        )

    from .elevation_service import sample_profile

    result = sample_profile(raster_path, points, num_samples)
    result["source"] = source

    return JsonResponse(result)


@require_GET
def elevation_stats(request, project_id):
    """
    Compute elevation statistics over a bounding box from the DSM or DTM.
    Query params:
        bbox - JSON array [min_lat, min_lon, max_lat, max_lon]
        source - dsm|dtm (default dsm)
    """
    import json

    project = get_object_or_404(DroneProject, id=project_id)

    bbox_raw = request.GET.get("bbox")
    if not bbox_raw:
        return JsonResponse({"error": "bbox parameter is required"}, status=400)

    try:
        bbox = json.loads(bbox_raw)
        if not isinstance(bbox, list) or len(bbox) != 4:
            raise ValueError("bbox must have 4 values")
        bbox = tuple(float(v) for v in bbox)
    except (json.JSONDecodeError, ValueError, TypeError) as e:
        return JsonResponse({"error": f"Invalid bbox: {e}"}, status=400)

    source = request.GET.get("source", "dsm")

    if source == "dtm":
        raster_path = project.get_output_path("dtm")
    else:
        raster_path = project.get_output_path("dsm")
        source = "dsm"

    if not raster_path:
        return JsonResponse(
            {"error": f"No {source.upper()} available for this project"},
            status=404,
        )

    from .elevation_service import compute_bbox_stats

    stats = compute_bbox_stats(raster_path, bbox)

    if not stats:
        return JsonResponse(
            {"error": "No valid elevation data in the specified region"},
            status=404,
        )

    stats["source"] = source
    return JsonResponse(stats)


@require_GET
def orthophoto_crop(request, project_id):
    """Crop a region from the orthophoto centered on a lat/lon point.

    Used by AI object inspection to get a high-resolution image of a
    selected object, instead of relying on fuzzy 3D renderer screenshots.

    Query params:
        lat    - center latitude
        lon    - center longitude
        size   - crop size in pixels (default 512, max 1024)

    Returns: JPEG image
    """
    project = get_object_or_404(DroneProject, id=project_id)

    if not project.orthophoto_path:
        return JsonResponse(
            {"error": "No orthophoto available"},
            status=404,
        )

    lat = request.GET.get("lat")
    lon = request.GET.get("lon")
    size = min(int(request.GET.get("size", 512)), 1024)

    if not lat or not lon:
        return JsonResponse({"error": "lat and lon are required"}, status=400)

    try:
        lat = float(lat)
        lon = float(lon)
    except (ValueError, TypeError):
        return JsonResponse({"error": "lat and lon must be numbers"}, status=400)

    ortho_path = os.path.join(str(settings.MEDIA_ROOT), project.orthophoto_path)
    if not os.path.isfile(ortho_path):
        return JsonResponse({"error": "Orthophoto file not found"}, status=404)

    from .elevation_service import crop_orthophoto

    img_bytes = crop_orthophoto(ortho_path, lat, lon, size)
    if img_bytes is None:
        return JsonResponse(
            {"error": "Point is outside orthophoto extent"},
            status=404,
        )

    from django.http import HttpResponse
    return HttpResponse(img_bytes, content_type="image/jpeg")

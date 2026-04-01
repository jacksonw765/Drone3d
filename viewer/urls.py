"""
Drone3D Viewer URL Configuration.
"""

from django.urls import path
from . import views

app_name = "viewer"

urlpatterns = [
    path("<uuid:project_id>/", views.project_viewer, name="project_viewer"),
    path("<uuid:project_id>/info/", views.viewer_info, name="viewer_info"),
    path("<uuid:project_id>/potree/<path:path>", views.serve_potree_data, name="serve_potree_data"),
    path("<uuid:project_id>/mesh-data/<path:path>", views.serve_mesh_data, name="serve_mesh_data"),
    path("<uuid:project_id>/download/<str:output_type>/", views.download_output, name="download_output"),
    # Elevation API
    path("<uuid:project_id>/elevation/", views.elevation_query, name="elevation_query"),
    path("<uuid:project_id>/elevation/profile/", views.elevation_profile, name="elevation_profile"),
    path("<uuid:project_id>/elevation/stats/", views.elevation_stats, name="elevation_stats"),
    # Orthophoto crop (for AI inspection)
    path("<uuid:project_id>/orthophoto-crop/", views.orthophoto_crop, name="orthophoto_crop"),
]


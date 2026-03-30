"""
TAK Integration URL Configuration.
"""

from django.urls import path
from . import views

app_name = "tak_integration"

urlpatterns = [
    # Tile serving for ATAK map sources
    path(
        "tiles/<uuid:project_id>/<int:z>/<int:x>/<int:y>.png",
        views.serve_tile,
        name="serve_tile",
    ),
    # ATAK map source XML download
    path(
        "map-source/<uuid:project_id>/",
        views.map_source_xml,
        name="map_source_xml",
    ),
    # Generate tile pyramid for a project
    path(
        "generate-tiles/<uuid:project_id>/",
        views.generate_tiles,
        name="generate_tiles",
    ),
    # ATAK data package export
    path(
        "export/<uuid:project_id>/",
        views.export_data_package,
        name="export_data_package",
    ),
]

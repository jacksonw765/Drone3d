"""
AI Analysis URL Configuration.
"""

from django.urls import path
from . import views

app_name = "ai_analysis"

urlpatterns = [
    # AI query endpoint
    path(
        "query/<uuid:project_id>/",
        views.ai_query,
        name="ai_query",
    ),
    # AI object inspection endpoint
    path(
        "inspect/<uuid:project_id>/",
        views.ai_inspect,
        name="ai_inspect",
    ),
    # Annotation CRUD
    path(
        "annotations/<uuid:project_id>/",
        views.annotations_list,
        name="annotations_list",
    ),
    path(
        "annotations/<uuid:project_id>/create/",
        views.annotation_create,
        name="annotation_create",
    ),
    path(
        "annotations/<uuid:project_id>/<uuid:annotation_id>/delete/",
        views.annotation_delete,
        name="annotation_delete",
    ),
    # Data import
    path(
        "import/<uuid:project_id>/",
        views.import_data,
        name="import_data",
    ),
    # AI status
    path(
        "status/",
        views.ai_status,
        name="ai_status",
    ),
    # Change detection
    path(
        "change-detect/",
        views.change_detection,
        name="change_detection",
    ),
]

"""
Drone3D Processing URL Configuration.
"""

from django.urls import path
from . import views
from .auth_views import login_view, logout_view

app_name = "processing"

urlpatterns = [
    # Auth
    path("login/", login_view, name="login"),
    path("logout/", logout_view, name="logout"),

    # Dashboard
    path("", views.index, name="index"),

    # Project API
    path("api/projects/", views.project_list, name="project_list"),
    path("api/projects/create/", views.create_project, name="create_project"),
    path("api/projects/<uuid:project_id>/upload/", views.upload_file, name="upload_file"),
    path("api/projects/<uuid:project_id>/process/", views.start_processing, name="start_processing"),
    path("api/projects/<uuid:project_id>/status/", views.project_status, name="project_status"),
    path("api/projects/<uuid:project_id>/cancel/", views.cancel_processing, name="cancel_processing"),
    path("api/projects/<uuid:project_id>/logs/", views.processing_logs, name="processing_logs"),
    path("api/projects/<uuid:project_id>/delete/", views.project_delete, name="project_delete"),
]

"""
Drone3D Admin Configuration.
"""

from django.contrib import admin
from .models import DroneProject, DroneFile


@admin.register(DroneProject)
class DroneProjectAdmin(admin.ModelAdmin):
    list_display = [
        "name", "status", "input_type", "quality_preset",
        "progress", "created_at", "completed_at",
    ]
    list_filter = ["status", "input_type", "quality_preset"]
    search_fields = ["name"]
    readonly_fields = [
        "id", "nodeodm_task_uuid", "celery_task_id",
        "created_at", "updated_at", "completed_at",
    ]


@admin.register(DroneFile)
class DroneFileAdmin(admin.ModelAdmin):
    list_display = [
        "original_filename", "file_type", "source",
        "project", "uploaded_at",
    ]
    list_filter = ["file_type", "source"]
    search_fields = ["original_filename"]
    raw_id_fields = ["project"]

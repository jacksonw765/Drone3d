"""
Drone3D Processing Models.

DroneProject — top-level entity tracking an entire reconstruction job.
DroneFile    — individual uploaded file (image, video, or SRT) linked to a project.
"""

import uuid
from django.db import models
from django.utils import timezone


class DroneProject(models.Model):
    """A single reconstruction project from drone footage."""

    class Status(models.TextChoices):
        UPLOADING = "uploading", "Uploading"
        QUEUED = "queued", "Queued"
        PREPROCESSING = "preprocessing", "Preprocessing"
        PROCESSING = "processing", "Processing"
        COMPLETED = "completed", "Completed"
        FAILED = "failed", "Failed"

    class InputType(models.TextChoices):
        IMAGES = "images", "Still Images"
        VIDEO = "video", "Video"
        MIXED = "mixed", "Mixed"
        UNKNOWN = "unknown", "Unknown"

    class QualityPreset(models.TextChoices):
        LOW = "low", "Low (Fast)"
        MEDIUM = "medium", "Medium"
        HIGH = "high", "High"
        ULTRA = "ultra", "Ultra (Slow)"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.UPLOADING,
        db_index=True,
    )
    progress = models.FloatField(default=0.0)
    input_type = models.CharField(
        max_length=10,
        choices=InputType.choices,
        default=InputType.UNKNOWN,
    )
    quality_preset = models.CharField(
        max_length=10,
        choices=QualityPreset.choices,
        default=QualityPreset.MEDIUM,
    )

    # NodeODM integration
    nodeodm_task_uuid = models.CharField(max_length=255, blank=True, null=True)
    celery_task_id = models.CharField(max_length=255, blank=True, null=True)
    error_message = models.TextField(blank=True, null=True)

    # ODM options (stored for audit / re-run)
    odm_options = models.JSONField(default=dict, blank=True)

    # Optional user-provided approximate location (for non-GPS imagery)
    approx_latitude = models.FloatField(blank=True, null=True)
    approx_longitude = models.FloatField(blank=True, null=True)

    # Output paths (relative to MEDIA_ROOT/outputs/<project_id>/)
    orthophoto_path = models.CharField(max_length=500, blank=True, null=True)
    pointcloud_path = models.CharField(max_length=500, blank=True, null=True)
    mesh_path = models.CharField(max_length=500, blank=True, null=True)
    dsm_path = models.CharField(max_length=500, blank=True, null=True)
    dtm_path = models.CharField(max_length=500, blank=True, null=True)
    tiles_3d_path = models.CharField(max_length=500, blank=True, null=True)
    potree_output_path = models.CharField(max_length=500, blank=True, null=True)

    # Timestamps
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)
    completed_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.name} ({self.get_status_display()})"

    @property
    def upload_dir(self):
        """Absolute path to this project's upload directory."""
        from django.conf import settings
        return str(settings.MEDIA_ROOT / "uploads" / str(self.id))

    @property
    def output_dir(self):
        """Absolute path to this project's output directory."""
        from django.conf import settings
        return str(settings.MEDIA_ROOT / "outputs" / str(self.id))

    @property
    def file_counts(self):
        """Return counts of each file type."""
        files = self.files.all()
        return {
            "images": files.filter(file_type=DroneFile.FileType.IMAGE).count(),
            "videos": files.filter(file_type=DroneFile.FileType.VIDEO).count(),
            "srts": files.filter(file_type=DroneFile.FileType.SRT).count(),
            "total": files.count(),
        }


class DroneFile(models.Model):
    """An individual file (image, video, or SRT) within a project."""

    class FileType(models.TextChoices):
        IMAGE = "image", "Image"
        VIDEO = "video", "Video"
        SRT = "srt", "SRT Subtitle"
        UNKNOWN = "unknown", "Unknown"

    class Source(models.TextChoices):
        UPLOAD = "upload", "User Upload"
        EXTRACTED = "extracted", "Extracted from Video"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        DroneProject,
        on_delete=models.CASCADE,
        related_name="files",
    )
    file = models.FileField(upload_to="uploads/")
    file_type = models.CharField(
        max_length=10,
        choices=FileType.choices,
        default=FileType.UNKNOWN,
    )
    original_filename = models.CharField(max_length=500)

    # GPS metadata (from EXIF or SRT)
    gps_lat = models.FloatField(blank=True, null=True)
    gps_lon = models.FloatField(blank=True, null=True)
    gps_alt = models.FloatField(blank=True, null=True)

    source = models.CharField(
        max_length=10,
        choices=Source.choices,
        default=Source.UPLOAD,
    )
    uploaded_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["uploaded_at"]

    def __str__(self):
        return f"{self.original_filename} ({self.get_file_type_display()})"

"""
Drone3D Processing Models.

DroneProject   — top-level entity tracking an entire reconstruction job.
DroneFile      — individual uploaded file (image, video, or SRT) linked to a project.
GeoAnnotation  — geospatial point of interest linked to a project (AI-detected, manual, or TAK-imported).
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
        ANALYZING = "analyzing", "AI Analysis"
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
    progress_message = models.CharField(max_length=500, blank=True, default="")
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

    # AI Analysis
    ai_analysis_enabled = models.BooleanField(default=True)
    ai_report = models.TextField(blank=True, default="")

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

    @property
    def annotation_count(self):
        """Return total number of annotations."""
        return self.annotations.count()

    def update_progress(self, progress: float, message: str = ""):
        """Update progress and optional status message atomically."""
        self.progress = min(progress, 100.0)
        if message:
            self.progress_message = message[:500]
        self.save(update_fields=["progress", "progress_message"])

    def get_output_path(self, output_type: str) -> str | None:
        """Return the absolute path for an output type, or None if unavailable."""
        from django.conf import settings
        import os

        field_map = {
            "orthophoto": "orthophoto_path",
            "pointcloud": "pointcloud_path",
            "mesh": "mesh_path",
            "dsm": "dsm_path",
            "dtm": "dtm_path",
            "tiles_3d": "tiles_3d_path",
            "potree": "potree_output_path",
        }
        field = field_map.get(output_type)
        if not field:
            return None
        rel_path = getattr(self, field)
        if not rel_path:
            return None
        abs_path = os.path.join(str(settings.MEDIA_ROOT), rel_path)
        return abs_path if os.path.exists(abs_path) else None


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


class GeoAnnotation(models.Model):
    """A geospatial point of interest linked to a Drone3D project.

    Annotations can originate from:
      - AI scene analysis (source='ai')
      - Manual user placement (source='manual')
      - TAK/CoT import (source='tak')
      - External data import (source='external')
    """

    class Category(models.TextChoices):
        STRUCTURE = "structure", "Structure"
        VEHICLE = "vehicle", "Vehicle"
        LZ = "lz", "Landing Zone"
        OBSTACLE = "obstacle", "Obstacle"
        POI = "poi", "Point of Interest"
        THREAT = "threat", "Threat"
        ROUTE_WP = "route_wp", "Route Waypoint"

    class Source(models.TextChoices):
        AI = "ai", "AI Detected"
        MANUAL = "manual", "Manual"
        TAK = "tak", "TAK Import"
        EXTERNAL = "external", "External Import"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        DroneProject,
        on_delete=models.CASCADE,
        related_name="annotations",
    )
    label = models.CharField(max_length=255)
    category = models.CharField(
        max_length=20,
        choices=Category.choices,
        default=Category.POI,
        db_index=True,
    )
    latitude = models.FloatField()
    longitude = models.FloatField()
    altitude = models.FloatField(null=True, blank=True)
    confidence = models.FloatField(null=True, blank=True)
    source = models.CharField(
        max_length=20,
        choices=Source.choices,
        default=Source.MANUAL,
        db_index=True,
    )
    cot_uid = models.CharField(max_length=255, blank=True, default="")
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.label} ({self.get_category_display()}) @ {self.latitude:.4f},{self.longitude:.4f}"

    def to_cot(self) -> str:
        """Serialize this annotation as a CoT XML event."""
        from tak_integration.cot import build_cot_event

        type_map = {
            "structure": "a-n-G",
            "vehicle": "a-n-G-E-V",
            "lz": "b-r-.-J",
            "obstacle": "a-n-G-E-O",
            "threat": "a-h-G",
            "poi": "a-n-G",
            "route_wp": "b-m-p-w",
        }
        return build_cot_event(
            event_type=type_map.get(self.category, "a-n-G"),
            lat=self.latitude,
            lon=self.longitude,
            hae=self.altitude or 0.0,
            callsign=f"D3D-{self.label[:12]}",
            uid=self.cot_uid or f"drone3d-{self.id}",
            details={"remarks": {"text": self.label}},
        )

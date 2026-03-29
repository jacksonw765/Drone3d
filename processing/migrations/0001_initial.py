# Generated migration for DroneProject and DroneFile models.

import django.db.models.deletion
import django.utils.timezone
import uuid
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="DroneProject",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("name", models.CharField(max_length=255)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("uploading", "Uploading"),
                            ("queued", "Queued"),
                            ("preprocessing", "Preprocessing"),
                            ("processing", "Processing"),
                            ("completed", "Completed"),
                            ("failed", "Failed"),
                        ],
                        db_index=True,
                        default="uploading",
                        max_length=20,
                    ),
                ),
                ("progress", models.FloatField(default=0.0)),
                (
                    "input_type",
                    models.CharField(
                        choices=[
                            ("images", "Still Images"),
                            ("video", "Video"),
                            ("mixed", "Mixed"),
                            ("unknown", "Unknown"),
                        ],
                        default="unknown",
                        max_length=10,
                    ),
                ),
                (
                    "quality_preset",
                    models.CharField(
                        choices=[
                            ("low", "Low (Fast)"),
                            ("medium", "Medium"),
                            ("high", "High"),
                            ("ultra", "Ultra (Slow)"),
                        ],
                        default="medium",
                        max_length=10,
                    ),
                ),
                (
                    "nodeodm_task_uuid",
                    models.CharField(blank=True, max_length=255, null=True),
                ),
                (
                    "celery_task_id",
                    models.CharField(blank=True, max_length=255, null=True),
                ),
                ("error_message", models.TextField(blank=True, null=True)),
                ("odm_options", models.JSONField(blank=True, default=dict)),
                (
                    "orthophoto_path",
                    models.CharField(blank=True, max_length=500, null=True),
                ),
                (
                    "pointcloud_path",
                    models.CharField(blank=True, max_length=500, null=True),
                ),
                (
                    "mesh_path",
                    models.CharField(blank=True, max_length=500, null=True),
                ),
                (
                    "dsm_path",
                    models.CharField(blank=True, max_length=500, null=True),
                ),
                (
                    "dtm_path",
                    models.CharField(blank=True, max_length=500, null=True),
                ),
                (
                    "tiles_3d_path",
                    models.CharField(blank=True, max_length=500, null=True),
                ),
                (
                    "potree_output_path",
                    models.CharField(blank=True, max_length=500, null=True),
                ),
                (
                    "created_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "completed_at",
                    models.DateTimeField(blank=True, null=True),
                ),
            ],
            options={
                "ordering": ["-created_at"],
            },
        ),
        migrations.CreateModel(
            name="DroneFile",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "file",
                    models.FileField(upload_to="uploads/"),
                ),
                (
                    "file_type",
                    models.CharField(
                        choices=[
                            ("image", "Image"),
                            ("video", "Video"),
                            ("srt", "SRT Subtitle"),
                            ("unknown", "Unknown"),
                        ],
                        default="unknown",
                        max_length=10,
                    ),
                ),
                ("original_filename", models.CharField(max_length=500)),
                ("gps_lat", models.FloatField(blank=True, null=True)),
                ("gps_lon", models.FloatField(blank=True, null=True)),
                ("gps_alt", models.FloatField(blank=True, null=True)),
                (
                    "source",
                    models.CharField(
                        choices=[
                            ("upload", "User Upload"),
                            ("extracted", "Extracted from Video"),
                        ],
                        default="upload",
                        max_length=10,
                    ),
                ),
                (
                    "uploaded_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="files",
                        to="processing.droneproject",
                    ),
                ),
            ],
            options={
                "ordering": ["uploaded_at"],
            },
        ),
    ]

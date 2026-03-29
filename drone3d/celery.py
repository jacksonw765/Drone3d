"""
Celery configuration for Drone3D.
"""

import os
from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "drone3d.settings")

app = Celery("drone3d")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()

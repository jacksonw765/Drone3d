"""
WSGI config for Drone3D project.
"""

import os
from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "drone3d.settings")
application = get_wsgi_application()

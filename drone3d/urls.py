"""
Drone3D root URL configuration.
"""

from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from django.http import JsonResponse


def health_check(request):
    """Simple health check endpoint for Docker."""
    return JsonResponse({"status": "ok"})


urlpatterns = [
    path("admin/", admin.site.urls),
    path("health/", health_check, name="health_check"),
    path("viewer/", include("viewer.urls")),
    path("tak/", include("tak_integration.urls")),
    path("ai/", include("ai_analysis.urls")),
    path("", include("processing.urls")),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

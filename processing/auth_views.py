"""
Drone3D Authentication Views and Middleware.
"""

import logging

from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.http import JsonResponse
from django.shortcuts import redirect, render
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_GET, require_POST

logger = logging.getLogger("processing")


@csrf_protect
def login_view(request):
    """Handle user login."""
    if request.user.is_authenticated:
        return redirect("/")

    if request.method == "POST":
        username = request.POST.get("username", "")
        password = request.POST.get("password", "")

        user = authenticate(request, username=username, password=password)
        if user is not None:
            login(request, user)
            logger.info(f"User '{username}' logged in")
            next_url = request.GET.get("next", "/")
            return redirect(next_url)
        else:
            logger.warning(f"Failed login attempt for '{username}'")
            return render(request, "login.html", {
                "error": "Invalid credentials. Please try again.",
            })

    return render(request, "login.html")


@require_GET
def logout_view(request):
    """Handle user logout."""
    username = request.user.username if request.user.is_authenticated else "unknown"
    logout(request)
    logger.info(f"User '{username}' logged out")
    return redirect("/login/")


class LoginRequiredMiddleware:
    """
    Middleware that redirects unauthenticated users to the login page.
    Excludes specific paths that don't require authentication.
    """

    EXEMPT_URLS = [
        "/login/",
        "/logout/",
        "/health/",
        "/admin/",
        "/static/",
    ]

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if not request.user.is_authenticated:
            path = request.path_info
            if not any(path.startswith(url) for url in self.EXEMPT_URLS):
                login_url = f"{settings.LOGIN_URL}?next={path}"
                return redirect(login_url)

        return self.get_response(request)

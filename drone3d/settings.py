"""
Drone3D Django settings.

Tactical geospatial reconstruction platform.
Offline-first, air-gap ready configuration.
"""

import os
from pathlib import Path
from decouple import config, Csv

# ── Paths ───────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent

# ── Security ────────────────────────────────────────────────
SECRET_KEY = config("DJANGO_SECRET_KEY", default="insecure-dev-key-change-me")
DEBUG = config("DEBUG", default=False, cast=bool)
ALLOWED_HOSTS = config("ALLOWED_HOSTS", default="localhost,127.0.0.1", cast=Csv())

# ── Application Definition ──────────────────────────────────
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Third-party
    "django_celery_results",
    # Local apps
    "processing",
    "viewer",
    "tak_integration",
    "ai_analysis",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    # "processing.middleware.LoginRequiredMiddleware",  # Disabled for POC
]

ROOT_URLCONF = "drone3d.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "drone3d.wsgi.application"

# ── Database ────────────────────────────────────────────────
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": config("DB_PATH", default=str(BASE_DIR / "data" / "db.sqlite3")),
    }
}

# ── Auth ────────────────────────────────────────────────────
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 10}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LOGIN_URL = "/login/"
LOGIN_REDIRECT_URL = "/"
LOGOUT_REDIRECT_URL = "/login/"

# ── Internationalization ────────────────────────────────────
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True

# ── Static & Media Files ────────────────────────────────────
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]
STORAGES = {
    "default": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
    },
    "staticfiles": {
        # Use Compressed (not Manifest) to avoid UTF-8 post-processing
        # errors on vendored Potree JS files that contain non-UTF-8 bytes.
        "BACKEND": "whitenoise.storage.CompressedStaticFilesStorage",
    },
}

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# ── Celery ──────────────────────────────────────────────────
CELERY_BROKER_URL = config("REDIS_URL", default="redis://localhost:6379/0")
CELERY_RESULT_BACKEND = "django-db"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_TASK_TRACK_STARTED = True
CELERY_TASK_TIME_LIMIT = 86400       # 24 hours hard limit
CELERY_TASK_SOFT_TIME_LIMIT = 82800  # 23 hours soft limit
CELERY_TASK_ACKS_LATE = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1

# Celery Beat — periodic tasks
CELERY_BEAT_SCHEDULE = {
    "cleanup-docker-resources": {
        "task": "processing.tasks.cleanup_docker_resources",
        "schedule": 3600,  # Every hour
    },
}

# ── NodeODM ─────────────────────────────────────────────────
NODEODM_HOST = config("NODEODM_HOST", default="localhost")
NODEODM_PORT = config("NODEODM_PORT", default=3000, cast=int)

# ── Security Hardening ──────────────────────────────────────
DATA_UPLOAD_MAX_MEMORY_SIZE = 104857600  # 100 MB (To support large AI base64 payloads)
SESSION_COOKIE_AGE = 3600  # 1 hour
SESSION_COOKIE_HTTPONLY = True
SESSION_EXPIRE_AT_BROWSER_CLOSE = True
CSRF_COOKIE_HTTPONLY = False  # Must be False for JS AJAX requests to read the token
X_FRAME_OPTIONS = "DENY"
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_BROWSER_XSS_FILTER = True

if not DEBUG:
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_SSL_REDIRECT = config("SECURE_SSL_REDIRECT", default=False, cast=bool)

# ── Default Auto Field ──────────────────────────────────────
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ── Logging ─────────────────────────────────────────────────
# Log files are stored in data/logs/ (persisted via db_data volume).
# - drone3d.log: All application logs (processing, viewer, AI, etc.)
# - nodeodm_*.log: Per-project full NodeODM console output
_LOG_DIR = BASE_DIR / "data" / "logs"
_LOG_DIR.mkdir(parents=True, exist_ok=True)

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {
            "format": "[{asctime}] {levelname} {name} {message}",
            "style": "{",
        },
        "timestamped": {
            "format": "[{asctime}] {message}",
            "style": "{",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "verbose",
        },
        "file": {
            "class": "logging.handlers.RotatingFileHandler",
            "filename": str(_LOG_DIR / "drone3d.log"),
            "maxBytes": 10 * 1024 * 1024,  # 10 MB
            "backupCount": 5,
            "formatter": "verbose",
            "encoding": "utf-8",
        },
        "nodeodm_file": {
            "class": "logging.handlers.RotatingFileHandler",
            "filename": str(_LOG_DIR / "nodeodm_console.log"),
            "maxBytes": 20 * 1024 * 1024,  # 20 MB
            "backupCount": 3,
            "formatter": "timestamped",
            "encoding": "utf-8",
        },
    },
    "loggers": {
        "django": {
            "handlers": ["console", "file"],
            "level": "INFO",
        },
        "processing": {
            "handlers": ["console", "file"],
            "level": "DEBUG",
        },
        "viewer": {
            "handlers": ["console", "file"],
            "level": "DEBUG",
        },
        "tak_integration": {
            "handlers": ["console", "file"],
            "level": "DEBUG",
        },
        "ai_analysis": {
            "handlers": ["console", "file"],
            "level": "DEBUG",
        },
        "nodeodm.console": {
            "handlers": ["nodeodm_file"],
            "level": "DEBUG",
            "propagate": False,
        },
    },
}

# ── ODM Processing Presets ──────────────────────────────────
# NOTE: NodeODM's API only accepts options from its /options endpoint.
# Options like opensfm-processes, depthmap-resolution, resize-to are
# ODM CLI-only and silently dropped by NodeODM.
#
# max-concurrency MUST be explicitly set. When omitted, ODM inside
# the NodeODM container defaults to 1 thread (not nproc), which
# forces single-threaded OpenMVS DensifyPointCloud — the #1 bottleneck.
# We set it to min(cpu_count, 12) to fully utilize available cores
# while respecting Docker's resource limits.
_ODM_MAX_CONCURRENCY = min(os.cpu_count() or 4, 12)

ODM_PRESETS = {
    "low": {
        "pc-quality": "low",
        "feature-quality": "low",
        "pc-filter": 2.0,              # Tighter than default 2.5 — removes floating outliers
        "mesh-octree-depth": 8,
        "orthophoto-resolution": 10,
        "use-3dmesh": True,
        "max-concurrency": _ODM_MAX_CONCURRENCY,
        "split": 500,
        "split-overlap": 50,
        "video-limit": 80,
    },
    "medium": {
        "pc-quality": "medium",
        "feature-quality": "medium",
        "pc-filter": 1.75,             # Aggressive outlier removal — eliminates ghost geometry
        "mesh-octree-depth": 10,
        "mesh-size": 250000,
        "orthophoto-resolution": 8,
        "use-3dmesh": True,
        "max-concurrency": _ODM_MAX_CONCURRENCY,
        "split": 500,
        "split-overlap": 75,
        "texturing-nadir-weight": 16,
        "dsm": True,
        "auto-boundary": True,
        "video-limit": 160,
    },
    "high": {
        "pc-quality": "medium",
        "feature-quality": "high",
        "pc-filter": 1.75,             # Aggressive outlier removal — eliminates ghost geometry
        "mesh-octree-depth": 11,
        "mesh-size": 300000,
        "orthophoto-resolution": 5,
        "use-3dmesh": True,
        "max-concurrency": _ODM_MAX_CONCURRENCY,
        "split": 500,
        "split-overlap": 100,
        "texturing-nadir-weight": 16,
        "dsm": True,
        "dtm": True,
        "3d-tiles": True,
        "auto-boundary": True,
        "video-limit": 200,
    },
    "ultra": {
        "pc-quality": "high",
        "feature-quality": "ultra",
        "pc-filter": 1.5,              # Most aggressive — ultra quality can afford stricter filter
        "mesh-octree-depth": 11,
        "orthophoto-resolution": 3,
        "use-3dmesh": True,
        "max-concurrency": _ODM_MAX_CONCURRENCY,
        "split": 600,
        "split-overlap": 150,
        "dsm": True,
        "dtm": True,
        "3d-tiles": True,
        "auto-boundary": True,
        "video-limit": 500,
    },
}

# ── Mesh Post-Processing ───────────────────────────────────
# After ODM produces the mesh, fill holes whose boundary has at most
# this many edges. Higher values fill larger gaps but risk closing
# intentional openings. Set to 0 to disable hole filling entirely.
MESH_HOLE_FILL_MAX_EDGES = int(config("MESH_HOLE_FILL_MAX_EDGES", default="150"))

# Minimum face-count ratio for a connected component to survive cleanup.
# Components with fewer than (largest_component_faces * ratio) faces are
# removed as floating debris. E.g. 0.01 = components under 1% of the main
# mesh are stripped. Set to 0 to disable fragment removal.
MESH_MIN_COMPONENT_RATIO = float(config("MESH_MIN_COMPONENT_RATIO", default="0.01"))

# ── Video-specific ODM Overrides ────────────────────────────
# Applied automatically when input is detected as video.
# Valid matcher-type values: flann (default), bow, bruteforce
# flann gives the best match quality for video frames where
# consecutive frames have high overlap but different viewpoints.
VIDEO_ODM_OVERRIDES = {
    "matcher-type": "flann",
    "min-num-features": 16000,         # More features for high-similarity video frames (default: 10000)
}

# ── Ollama (AI Analysis) ────────────────────────────────────
OLLAMA_HOST = config("OLLAMA_HOST", default="http://localhost:11434")
OLLAMA_PRIMARY_MODEL = config("OLLAMA_PRIMARY_MODEL", default="llama3.2-vision:11b")
OLLAMA_TEXT_MODEL = config("OLLAMA_TEXT_MODEL", default="llama3.2-vision:11b")
AI_ANALYSIS_ENABLED = config("AI_ANALYSIS_ENABLED", default=True, cast=bool)
AI_TILE_SIZE = config("AI_TILE_SIZE", default=768, cast=int)     # Larger tiles = fewer API calls = faster
AI_CONFIDENCE_THRESHOLD = config("AI_CONFIDENCE_THRESHOLD", default=0.4, cast=float)

# ── TAK Integration ─────────────────────────────────────────
TAK_ENABLED = config("TAK_ENABLED", default=False, cast=bool)
TAK_SERVER_HOST = config("TAK_SERVER_HOST", default="")
TAK_SERVER_PORT = config("TAK_SERVER_PORT", default=8087, cast=int)

# Drone3D

**Tactical Geospatial 3D Reconstruction Platform**

Drone3D is a self-hosted, air-gap-ready web platform that transforms drone imagery and video into interactive 3D point clouds, textured meshes, orthophotos, and elevation models. Upload drone footage, choose a quality preset, and get browser-viewable 3D reconstructions — no cloud services required.

---

## Features

- **Multi-Input Support** — Upload still images (JPG, TIFF, PNG, DNG), video files (MP4, MOV), and SRT telemetry files
- **Smart Video Preprocessing** — Adaptive frame extraction with sharpness filtering and SRT-based geotagging
- **Quality Presets** — Low / Medium / High / Ultra, each tuning ODM parameters for speed vs. fidelity
- **Interactive 3D Viewer** — Potree-based point cloud viewer and Three.js mesh viewer in the browser
- **GPS-Aware Processing** — Auto-detects EXIF GPS; supports SRT geotagging, manual coordinates via `geo.txt`, and fully non-georeferenced workflows
- **Download Outputs** — Orthophoto (GeoTIFF), point cloud (LAZ/LAS), textured OBJ mesh, DSM, DTM, and 3D Tiles
- **Air-Gap Deployable** — Fully offline via Docker with a bundling script for disconnected networks
- **Intelligent Error Reporting** — Classifies ODM failures (OOM, insufficient images, reconstruction issues) with actionable suggestions
- **Django Admin** — Full CRUD admin panel for project and file management

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Docker Compose Stack                     │
├──────────┬──────────────┬──────────────┬────────────────────┤
│  Redis   │   NodeODM    │  Django Web  │   Celery Worker    │
│  :6379   │   :3000      │   :8000      │   (background)     │
│          │              │              │                    │
│  Message │  Photogramm- │  Dashboard,  │  Preprocessing,    │
│  broker  │  etry engine │  API, Viewer │  ODM orchestration │
│  + cache │  (OpenDrone- │  (Gunicorn)  │  Potree conversion │
│          │  Map)        │              │                    │
└──────────┴──────────────┴──────────────┴────────────────────┘
```

| Service | Image | Purpose |
|---------|-------|---------|
| **redis** | `redis:7-alpine` | Celery message broker and result backend |
| **nodeodm** | `opendronemap/nodeodm` | Photogrammetry engine (OpenDroneMap) |
| **web** | Custom (Dockerfile) | Django app served by Gunicorn — dashboard, REST API, 3D viewer |
| **worker** | Custom (Dockerfile) | Celery worker — preprocessing, ODM orchestration, Potree conversion |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Django 5.1, Celery 5.4, Gunicorn 22 |
| Database | SQLite (file-based, zero-config) |
| Task Queue | Redis 7 + Celery |
| Photogrammetry | NodeODM / OpenDroneMap |
| Point Cloud Viewer | Potree (compiled from source) |
| Mesh Viewer | Three.js (OBJLoader) |
| Video Processing | FFmpeg, Pillow, NumPy |
| GPS/EXIF | piexif |
| Static Files | WhiteNoise (compressed) |
| Config | python-decouple |
| Containerization | Docker, Docker Compose |

---

## Quick Start

### Prerequisites

- **Docker** ≥ 20.10
- **Docker Compose** ≥ 2.0
- **RAM** — 8 GB minimum; 16 GB+ recommended for Medium quality; 32 GB+ for High/Ultra

### 1. Clone & Configure

```bash
git clone <repository-url> drone3d
cd drone3d
cp .env.example .env
```

Edit `.env` to set your own values (or keep defaults for local dev):

```env
# Django
DJANGO_SECRET_KEY=change-me-to-a-long-random-string
DEBUG=1
ALLOWED_HOSTS=localhost,127.0.0.1

# Redis
REDIS_URL=redis://redis:6379/0

# NodeODM
NODEODM_HOST=nodeodm
NODEODM_PORT=3000
NODEODM_MEMORY_LIMIT=20G

# Superuser (auto-created on first boot)
DJANGO_SUPERUSER_USERNAME=admin
DJANGO_SUPERUSER_PASSWORD=drone3d-admin
DJANGO_SUPERUSER_EMAIL=admin@drone3d.local
```

### 2. Build & Launch

```bash
docker compose up --build -d
```

First build compiles PotreeConverter, Potree viewer, and GDAL bindings — expect **10–20 minutes** on the initial run.

### 3. Access

| URL | Description |
|-----|-------------|
| `http://localhost:8000` | Dashboard & project management |
| `http://localhost:8000/admin/` | Django admin panel |
| `http://localhost:3000` | NodeODM API (direct) |

Default credentials: `admin` / `drone3d-admin`

---

## Usage Workflow

1. **Create a Project** — Name it, select a quality preset, optionally specify approximate GPS coordinates
2. **Upload Files** — Drag & drop drone images or video files (with optional `.srt` telemetry)
3. **Start Processing** — Kicks off the Celery pipeline (preprocessing → ODM → Potree conversion)
4. **Monitor Progress** — Real-time progress polling on the dashboard
5. **View Results** — Interactive 3D point cloud and mesh viewer in the browser
6. **Download Outputs** — Orthophoto, point cloud, mesh, DSM, DTM as individual files

---

## Processing Pipeline

The Celery worker executes a 5-stage pipeline for each project:

```
┌──────────────┐    ┌───────────────┐    ┌───────────────┐
│ 1. Preprocess│───▶│ 2. Submit to  │───▶│ 3. Poll for   │
│              │    │    NodeODM     │    │  Completion   │
│ • Detect     │    │               │    │               │
│   input type │    │ • Build ODM   │    │ • Map ODM     │
│ • Extract    │    │   options from│    │   progress    │
│   video      │    │   preset      │    │   (20%–80%)   │
│   frames     │    │ • GPS detect  │    │               │
│ • Filter     │    │ • Submit via  │    │               │
│   blurry     │    │   PyODM       │    │               │
│   frames     │    │               │    │               │
│ • Geotag     │    │               │    │               │
│   from SRT   │    │               │    │               │
└──────────────┘    └───────────────┘    └───────┬───────┘
                                                 │
                    ┌───────────────┐    ┌────────▼──────┐
                    │ 5. Convert to │◀───│ 4. Download   │
                    │    Potree     │    │    Results     │
                    │               │    │               │
                    │ • PotreeConv- │    │ • Download ZIP │
                    │   erter on    │    │ • Extract      │
                    │   LAZ/LAS     │    │ • Map output   │
                    │ • metadata.   │    │   paths        │
                    │   json output │    │               │
                    └───────────────┘    └───────────────┘
```

### Stage Details

| Stage | Progress | Description |
|-------|----------|-------------|
| **Preprocess** | 0% → 15% | Detect input type; extract video frames via FFmpeg with adaptive FPS; filter blurry frames; geotag from SRT |
| **Submit to NodeODM** | 15% → 20% | Build ODM option set from quality preset + video overrides + user overrides; detect GPS; create NodeODM task |
| **Poll Completion** | 20% → 80% | Poll NodeODM task status every 5s; map ODM progress to internal progress range |
| **Download Results** | 80% → 92% | Download ZIP via PyODM; extract orthophoto, point cloud, mesh, DSM, DTM, 3D tiles |
| **Potree Conversion** | 92% → 100% | Run PotreeConverter on LAZ/LAS point cloud; produce octree for browser viewing |

---

## Quality Presets

| Preset | Resize | Point Cloud | Feature | Mesh Depth | Video Frames | RAM Estimate |
|--------|--------|-------------|---------|------------|--------------|--------------|
| **Low** | 1024px | Lowest | Low | 8 | 50 | ~4 GB |
| **Medium** | 2048px | Low | Medium | 9 | 100 | ~16 GB |
| **High** | 3072px | Medium | High | 10 | 150 | ~24 GB |
| **Ultra** | 4096px | High | Ultra | 11 | 200 | ~32 GB+ |

Higher presets also enable additional outputs:
- **Medium+** — DSM, auto-boundary
- **High+** — DTM, 3D Tiles
- **Ultra** — Maximum fidelity, all outputs

---

## Video Processing

When video files are uploaded, Drone3D uses intelligent frame extraction:

1. **Probe** — FFprobe determines duration, FPS, and resolution
2. **Adaptive FPS** — Calculates extraction rate to hit target frame count (clamped 2–10 FPS)
3. **Full Resolution** — Extracts at native resolution (no downscaling; ODM handles `resize-to`)
4. **Sharpness Filter** — Laplacian variance scoring discards the blurriest 20% of frames
5. **Even Subsampling** — If over the frame limit, evenly subsamples to maintain coverage
6. **SRT Geotagging** — If a companion `.srt` file exists (e.g., `DJI_0123.srt` for `DJI_0123.mp4`), GPS coordinates are written into frame EXIF data

Supported SRT formats: DJI, Skydio, Autel, Parrot, and generic CSV-style GPS.

---

## API Reference

All endpoints return JSON. CSRF tokens are required for POST requests (read from cookie).

### Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects/` | List all projects |
| `POST` | `/api/projects/create/` | Create a new project |
| `POST` | `/api/projects/<uuid>/upload/` | Upload a file to a project |
| `POST` | `/api/projects/<uuid>/process/` | Start processing |
| `GET` | `/api/projects/<uuid>/status/` | Get project status (for polling) |
| `POST` | `/api/projects/<uuid>/delete/` | Delete project and all data |

### Create Project Body

```json
{
  "name": "My Mission",
  "quality_preset": "medium",
  "approx_latitude": 35.1234,
  "approx_longitude": -106.5678,
  "odm_overrides": {
    "feature-quality": "ultra",
    "mesh-octree-depth": 11
  }
}
```

**Allowed ODM override keys:** `feature-quality`, `matcher-type`, `min-num-features`, `pc-quality`, `depthmap-resolution`, `resize-to`, `mesh-octree-depth`, `use-3dmesh`, `orthophoto-resolution`, `dsm`, `dtm`, `skip-orthophoto`

### Viewer

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/viewer/<uuid>/` | Interactive 3D viewer page |
| `GET` | `/viewer/<uuid>/info/` | Viewer configuration JSON |
| `GET` | `/viewer/<uuid>/potree/<path>` | Potree octree data files |
| `GET` | `/viewer/<uuid>/mesh-data/<path>` | Mesh OBJ/MTL/texture files |
| `GET` | `/viewer/<uuid>/download/<type>/` | Download output (`orthophoto`, `pointcloud`, `mesh`, `dsm`, `dtm`, `tiles`) |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health/` | Health check (returns `{"status": "ok"}`) |
| `POST` | `/login/` | User login (form POST) |
| `GET` | `/logout/` | User logout |

---

## Project Structure

```
Drone3d/
├── drone3d/                  # Django project settings
│   ├── settings.py           # Configuration, ODM presets, Celery config
│   ├── urls.py               # Root URL routing
│   ├── celery.py             # Celery app initialization
│   └── wsgi.py               # WSGI entry point
│
├── processing/               # Core processing Django app
│   ├── models.py             # DroneProject, DroneFile models
│   ├── views.py              # Project CRUD & API endpoints
│   ├── tasks.py              # Celery pipeline (5-stage orchestration)
│   ├── preprocessor.py       # Video extraction, SRT parsing, sharpness filtering
│   ├── auth_views.py         # Login/logout views & LoginRequired middleware
│   ├── admin.py              # Django admin registration
│   └── urls.py               # Processing URL routes
│
├── viewer/                   # 3D viewer Django app
│   ├── views.py              # Potree/mesh serving, downloads
│   └── urls.py               # Viewer URL routes
│
├── templates/                # Django HTML templates
│   ├── base.html             # Base layout
│   ├── index.html            # Dashboard (project list, upload, status)
│   ├── viewer.html           # 3D viewer (Potree + Three.js)
│   └── login.html            # Login page
│
├── static/
│   ├── css/main.css          # Application styles
│   └── js/
│       ├── dashboard.js      # Dashboard interactivity
│       ├── upload.js         # File upload handler
│       ├── viewer.js         # Potree viewer initialization
│       └── mesh-viewer.js    # Three.js OBJ mesh viewer
│
├── scripts/
│   ├── airgap-bundle.sh      # Air-gap Docker image bundler
│   └── test-e2e.sh           # End-to-end API test script
│
├── Dockerfile                # Multi-stage build (PotreeConverter, Potree, Python)
├── docker-compose.yml        # Full stack: Redis, NodeODM, Web, Worker
├── entrypoint.sh             # Container entrypoint (migrations, Gunicorn, Celery)
├── requirements.txt          # Python dependencies
├── .env.example              # Environment variable template
└── .dockerignore             # Docker build exclusions
```

---

## Air-Gap Deployment

For disconnected / classified networks, use the bundling script to create a self-contained tarball:

```bash
# On a machine WITH internet access:
bash scripts/airgap-bundle.sh
```

This builds all images, pulls Redis and NodeODM, and saves them to a compressed tarball (`drone3d-airgap-bundle-<timestamp>.tar.gz`).

### Deploy on the Air-Gapped Machine

```bash
# 1. Transfer the tarball + docker-compose.yml + .env to the target
# 2. Load Docker images
docker load < drone3d-airgap-bundle-YYYYMMDD-HHMMSS.tar.gz

# 3. Start the platform
docker compose up -d
```

All services start with **zero internet connectivity**.

---

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DJANGO_SECRET_KEY` | `insecure-dev-key-change-me` | Django secret key (change in production!) |
| `DEBUG` | `0` | Enable Django debug mode (`1`/`0`) |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated allowed hostnames |
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection URL |
| `NODEODM_HOST` | `nodeodm` | NodeODM hostname |
| `NODEODM_PORT` | `3000` | NodeODM port |
| `NODEODM_MEMORY_LIMIT` | `20G` | Docker memory limit for NodeODM |
| `DJANGO_SUPERUSER_USERNAME` | — | Auto-create superuser on first boot |
| `DJANGO_SUPERUSER_PASSWORD` | — | Superuser password |
| `DJANGO_SUPERUSER_EMAIL` | `admin@drone3d.local` | Superuser email |
| `GUNICORN_WORKERS` | `3` | Number of Gunicorn worker processes |
| `CELERY_CONCURRENCY` | `1` | Number of Celery worker threads |
| `SECURE_SSL_REDIRECT` | `False` | Redirect HTTP → HTTPS in production |
| `DB_PATH` | `data/db.sqlite3` | SQLite database file path |

### Security Settings (Production)

When `DEBUG=0`:
- Session and CSRF cookies are set to `Secure` (HTTPS only)
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- Session expires in 1 hour and on browser close

---

## Docker Build Details

The Dockerfile uses a **multi-stage build**:

### Stage 1: Builder
- Compiles **PotreeConverter** from source (C++/CMake)
- Builds the **Potree** web viewer from source (Node.js/npm)
- Installs Python dependencies including **GDAL** bindings

### Stage 2: Runtime
- Slim Python 3.12 image with only runtime dependencies
- Copies compiled binaries, Python packages, and Potree assets
- Runs as non-root user (`drone3d`)
- Entrypoint handles migrations, static collection, superuser creation, and service startup

---

## End-to-End Testing

A basic API integration test is included:

```bash
# Start the stack first
docker compose up -d

# Run the E2E test (requires sample images in sample/sample1/*.JPG)
bash scripts/test-e2e.sh
```

The test creates a project, uploads images, starts processing, and validates the API responses.

---

## Troubleshooting

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| **"Out of memory"** during processing | NodeODM / ODM exceeded available RAM | Lower quality preset; reduce image count; increase `NODEODM_MEMORY_LIMIT` |
| **"Not enough images"** | < 3 images uploaded | Upload at least 3 images; 20–30+ recommended for good results |
| **"Reconstruction failed"** | Poor overlap or blurry images | Ensure 70%+ side overlap, 80%+ front overlap; avoid blurry shots |
| **Build fails at PotreeConverter** | Missing system dependencies | Ensure Docker has internet access during build for `apt-get` |
| **Potree viewer shows nothing** | PotreeConverter didn't produce output | Check worker logs; ensure point cloud was generated |
| **NodeODM health check fails** | NodeODM still starting (large image) | Wait — `start_period: 30s` gives it time; increase if needed |

### Viewing Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f web
docker compose logs -f worker
docker compose logs -f nodeodm
```

---

## Supported File Formats

### Input
| Type | Extensions |
|------|------------|
| Images | `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.png`, `.dng` |
| Video | `.mp4`, `.mov`, `.lrv`, `.ts` |
| Telemetry | `.srt` (DJI, Skydio, Autel, Parrot formats) |

### Output
| Type | Format | Description |
|------|--------|-------------|
| Orthophoto | GeoTIFF (`.tif`) | Georeferenced aerial mosaic |
| Point Cloud | LAZ/LAS (`.laz`, `.las`) | Dense 3D point cloud |
| Mesh | OBJ + MTL + textures | Textured 3D mesh |
| DSM | GeoTIFF (`.tif`) | Digital Surface Model |
| DTM | GeoTIFF (`.tif`) | Digital Terrain Model |
| 3D Tiles | `tileset.json` | Cesium 3D Tiles for web visualization |
| Potree | Octree (`.bin` + `metadata.json`) | Browser-optimized point cloud |

---

## License

See [LICENSE](LICENSE) for details.

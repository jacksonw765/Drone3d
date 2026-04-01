# Drone3D

**Tactical Geospatial 3D Reconstruction Platform**

Drone3D is a self-hosted, air-gap-ready web platform that transforms drone imagery and video into interactive 3D point clouds, textured meshes, orthophotos, and elevation models. Upload drone footage, choose a quality preset, and get browser-viewable 3D reconstructions — no cloud services required.

---

## Features

- **Multi-Input Support** — Upload still images (JPG, TIFF, PNG, DNG), video files (MP4, MOV), and SRT telemetry files
- **Smart Video Preprocessing** — Adaptive frame extraction with sharpness filtering and SRT-based geotagging
- **Quality Presets** — Low / Medium / High / Ultra, each tuning ODM parameters for speed vs. fidelity
- **Interactive 3D Viewer** — Potree point cloud viewer and advanced Three.js mesh viewer featuring:
  - Real-time Above Ground Level (AGL) cursor readouts and elevation color legends
  - Profile drawing tool for cross-section topology analysis
  - Distance measurement tools for precise structural mapping
  - Draggable info panels for selected objects
  - Intuitive 'H' hotkey to quick-toggle Pan (hand tool) navigation
- **AI Vision Analysis** — Integrated host-based Ollama support (e.g., Llama 3.2 Vision) for natural language querying, 3D object inspection via backend high-res orthophoto cropping, and temporal change detection
- **ATAK Integration** — One-click export of ATAK data packages (.zip) containing CoT markers, DTED elevation, slippy map tiles, and AI analysis reports
- **Dynamic Job Management** — Graceful cancellation of processing jobs from the UI with immediate resource deallocation and granular progress tracking
- **Hardware Acceleration** — Support for GPU-accelerated workloads via dedicated Docker Compose profiles
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
| **web** | Custom (Dockerfile) | Django app served by Gunicorn — dashboard, REST API, 3D viewer, TAK/AI integration |
| **worker** | Custom (Dockerfile) | Celery worker — preprocessing, ODM orchestration, Potree conversion, AI async tasks |
| **ollama** | Native Host | AI Vision model host (runs outside Docker for raw performance and memory access) |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Django 5.1, Celery 5.4, Gunicorn 22 |
| Database | SQLite (file-based, zero-config) |
| Task Queue | Redis 7 + Celery |
| Photogrammetry | NodeODM / OpenDroneMap |
| AI Vision | Ollama (host-based, native performance) + Llama Vision models |
| ATAK Integration | CoT XML, DTED generation, Slippy Map Tile Server |
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
# Standard CPU deployment
docker compose -f docker-compose.cpu.yml up --build -d

# GPU accelerated deployment (for systems with hardware support)
docker compose -f docker-compose.gpu.yml up --build -d
```

First build compiles PotreeConverter, Potree viewer, and GDAL bindings — expect **10–20 minutes** on the initial run.

*(Optional) To enable AI analysis, run `bash scripts/ollama-init.sh` on your host system to download and start the Ollama service natively without Docker limiters.*

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

## AI Vision & ATAK Capabilities

### Tactical Intelligence AI
Drone3D integrates with **Ollama** natively on the host machine (bypassing Docker memory constraints) to perform visual analysis on generated scenes:
- **Natural Language Queries**: Ask free-form questions like, "Are there any unauthorized vehicles in the main compound?" The AI queries the finalized orthophoto and responds rapidly with observational evidence.
- **3D Object Inspection**: Select arbitrary 3D geometry. The system seamlessly crops a high-resolution sub-image of the object from the backend orthophoto and forwards it, along with structural properties and relative location, to the AI for robust identification.
- **Change Detection**: Perform temporal comparisons highlighting architectural and layout changes over time between multiple drone flights over the same region.

### ATAK / Team Awareness Kit Integration
The platform offers out-of-the-box interoperability with TAK networks:
- **Slippy Map Tile Server**: Streams the orthophoto directly to TAK end-user devices and existing GIS systems.
- **ATAK Data Packages (.zip)**: One-click export bundling the map tiles, terrain elevation data (auto-converted to DTED format), intelligent 3D point-of-interest markers (CoT XML), map config, and the AI's intelligence report for offline operations.

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
| `GET` | `/viewer/<uuid>/elevation/` | Single-point elevation query (requires mapped DSM/DTM) |
| `GET` | `/viewer/<uuid>/elevation/profile/` | Line-path elevation profile cross-section extraction |
| `GET` | `/viewer/<uuid>/elevation/stats/` | Bounding box elevation stats (min, max, mean) |
| `GET` | `/viewer/<uuid>/orthophoto-crop/` | Download cropped JPEG orthophoto at specific coordinate |
| `GET` | `/viewer/<uuid>/download/<type>/` | Download output (`orthophoto`, `pointcloud`, `mesh`, `dsm`, `dtm`, `tiles`) |

### AI Analysis

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/ai/status/` | Check AI inference engine connectivity and status |
| `POST` | `/ai/query/<uuid>/` | Natural language QA agent query on a scene |
| `POST` | `/ai/inspect/<uuid>/` | Trigger object identification for a 3D bounding box |
| `GET/POST`| `/ai/annotations/<uuid>/` | List or create AI identified annotations |
| `POST` | `/ai/annotations/<uuid>/<id>/delete/` | Delete an AI annotation |
| `POST` | `/ai/change-detect/` | Trigger temporal multi-scan change detection |
| `POST` | `/ai/import/<uuid>/` | Rapidly import annotation data |

### TAK/ATAK Integration

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/tak/tiles/<uuid>/<z>/<x>/<y>.png` | Feed slippy map tiles directly to ATAK clients |
| `GET` | `/tak/map-source/<uuid>/` | Retrieve ATAK configuration Map Source XML |
| `POST` | `/tak/generate-tiles/<uuid>/` | Run batch cache pre-render for offline tiles |
| `GET` | `/tak/export/<uuid>/` | Download comprehensive ATAK Data Package Zip files |

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
├── ai_analysis/              # AI vision pipeline
│   ├── query_engine.py       # Ollama vision connector & QA agent
│   ├── tasks.py              # Background AI evaluation queues
│   └── views.py              # AI interface endpoints
│
├── tak_integration/          # ATAK/WinTAK export tooling
│   ├── data_package.py       # ZIP builder for deep offline sync
│   ├── tile_server.py        # Slippy map caching network
│   └── elevation.py          # Digital Surface Model → DTED converter
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

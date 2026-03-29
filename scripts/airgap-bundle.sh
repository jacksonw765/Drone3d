#!/bin/bash
set -e

# ══════════════════════════════════════════════════════════
# Drone3D Air-Gap Packaging Script
#
# Creates a self-contained tarball with all Docker images
# needed to deploy Drone3D on an air-gapped machine.
# ══════════════════════════════════════════════════════════

BUNDLE_NAME="drone3d-airgap-bundle"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_FILE="${BUNDLE_NAME}-${TIMESTAMP}.tar.gz"

echo "╔══════════════════════════════════════════════╗"
echo "║       DRONE3D — Air-Gap Bundle Creator       ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Step 1: Build images
echo "🔧 Building Docker images..."
docker compose build

# Step 2: Pull external images
echo "📥 Pulling external images..."
docker compose pull redis nodeodm

# Step 3: Get all image names
echo "📋 Collecting image list..."
IMAGES=$(docker compose config --images | sort -u)
echo "   Images to bundle:"
for img in $IMAGES; do
    echo "     - $img"
done

# Step 4: Export and compress
echo ""
echo "📦 Saving images to ${OUTPUT_FILE}..."
echo "   (This may take several minutes for large images)"
docker save $IMAGES | gzip > "${OUTPUT_FILE}"

# Step 5: Calculate size
SIZE=$(du -h "${OUTPUT_FILE}" | cut -f1)
echo ""
echo "✅ Bundle created: ${OUTPUT_FILE} (${SIZE})"
echo ""
echo "── Deployment Instructions ─────────────────────"
echo ""
echo "  1. Transfer ${OUTPUT_FILE} to the target machine"
echo "  2. Load the images:"
echo "     $ docker load < ${OUTPUT_FILE}"
echo "  3. Copy the docker-compose.yml and .env to the target"
echo "  4. Start the platform:"
echo "     $ docker compose up -d"
echo ""
echo "  All services will start with zero internet connectivity."
echo "══════════════════════════════════════════════════"

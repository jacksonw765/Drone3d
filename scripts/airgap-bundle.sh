#!/bin/bash
set -e

# ══════════════════════════════════════════════════════════
# Drone3D Air-Gap Packaging Script
#
# Creates a self-contained tarball with all Docker images
# and AI model weights needed to deploy Drone3D on an
# air-gapped machine.
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
docker compose pull redis nodeodm ollama

# Step 3: Get all image names
echo "📋 Collecting image list..."
IMAGES=$(docker compose config --images | sort -u)
echo "   Images to bundle:"
for img in $IMAGES; do
    echo "     - $img"
done

# Step 4: Export and compress Docker images
echo ""
echo "📦 Saving Docker images to ${OUTPUT_FILE}..."
echo "   (This may take several minutes for large images)"
docker save $IMAGES | gzip > "${OUTPUT_FILE}"

# Step 5: Export Ollama model weights
echo ""
echo "🧠 Exporting Ollama model weights..."
MODELS_FILE="${BUNDLE_NAME}-models-${TIMESTAMP}.tar.gz"
if docker volume inspect drone3d_ollama_data > /dev/null 2>&1; then
    docker run --rm \
        -v drone3d_ollama_data:/data:ro \
        -v "$(pwd):/backup" \
        alpine tar czf "/backup/${MODELS_FILE}" -C /data .
    MODELS_SIZE=$(du -h "${MODELS_FILE}" | cut -f1)
    echo "   Model weights: ${MODELS_FILE} (${MODELS_SIZE})"
else
    echo "   ⚠️  Ollama volume not found — models not exported."
    echo "   Run scripts/ollama-init.sh first to pull models."
    MODELS_FILE=""
fi

# Step 6: Calculate sizes
SIZE=$(du -h "${OUTPUT_FILE}" | cut -f1)
echo ""
echo "✅ Bundle created: ${OUTPUT_FILE} (${SIZE})"
echo ""
echo "── Deployment Instructions ─────────────────────"
echo ""
echo "  1. Transfer ${OUTPUT_FILE} to the target machine"
if [ -n "$MODELS_FILE" ]; then
    echo "  2. Transfer ${MODELS_FILE} (model weights)"
fi
echo "  3. Load the Docker images:"
echo "     $ docker load < ${OUTPUT_FILE}"
if [ -n "$MODELS_FILE" ]; then
    echo "  4. Restore Ollama model weights:"
    echo "     $ docker volume create drone3d_ollama_data"
    echo "     $ docker run --rm -v drone3d_ollama_data:/data -v \$(pwd):/backup alpine \\"
    echo "         tar xzf /backup/${MODELS_FILE} -C /data"
fi
echo "  5. Copy docker-compose.yml, .env to the target"
echo "  6. Start the platform:"
echo "     $ docker compose up -d"
echo ""
echo "  All services will start with zero internet connectivity."
echo "══════════════════════════════════════════════════"

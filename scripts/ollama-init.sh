#!/bin/bash
set -e

# ══════════════════════════════════════════════════════════
# Ollama Model Bootstrap Script
#
# Waits for the Ollama API to be ready, then pulls the
# configured models. Run once after first deployment.
#
# Usage:
#   docker exec drone3d-ollama /bin/bash -c "$(cat scripts/ollama-init.sh)"
#   — or —
#   OLLAMA_HOST=http://localhost:11434 bash scripts/ollama-init.sh
# ══════════════════════════════════════════════════════════

OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
PRIMARY_MODEL="${OLLAMA_PRIMARY_MODEL:-llama3.2-vision:11b}"

echo "╔══════════════════════════════════════════════╗"
echo "║       DRONE3D — Ollama Model Bootstrap       ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Ollama endpoint: ${OLLAMA_HOST}"
echo "Primary model:   ${PRIMARY_MODEL}"
echo ""

# Wait for Ollama API
echo "⏳ Waiting for Ollama API..."
MAX_RETRIES=60
for i in $(seq 1 $MAX_RETRIES); do
    if curl -sf "${OLLAMA_HOST}/api/tags" > /dev/null 2>&1; then
        echo "✅ Ollama is ready"
        break
    fi
    if [ $i -eq $MAX_RETRIES ]; then
        echo "❌ Ollama not reachable after ${MAX_RETRIES} attempts"
        exit 1
    fi
    sleep 2
done

# Pull primary model (vision + text capable)
echo ""
echo "📥 Pulling ${PRIMARY_MODEL}..."
echo "   (This may take 10-30 minutes on first run)"
curl -X POST "${OLLAMA_HOST}/api/pull" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"${PRIMARY_MODEL}\"}" \
    --no-buffer

echo ""
echo "✅ Model bootstrap complete."
echo ""
echo "── Verify ─────────────────────────────────────"
echo "Available models:"
curl -s "${OLLAMA_HOST}/api/tags" | python3 -m json.tool 2>/dev/null || \
    curl -s "${OLLAMA_HOST}/api/tags"
echo ""
echo "══════════════════════════════════════════════════"

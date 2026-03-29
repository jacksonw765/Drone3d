#!/bin/bash
set -e

CSRF=$(curl -s -c /tmp/cookies.txt http://localhost:8000/ > /dev/null 2>&1 && grep csrftoken /tmp/cookies.txt | awk '{print $NF}')
echo "CSRF: ${CSRF:0:10}..."

echo ""
echo "=== Deleting old project ==="
curl -s -X POST -H "X-CSRFToken: $CSRF" -H "Content-Type: application/json" -b /tmp/cookies.txt \
    "http://localhost:8000/api/projects/a0f505d5-8b9b-4e40-8278-92801bcf4a4a/delete/" || true

echo ""
echo "=== Creating project ==="
PROJECT=$(curl -s -X POST -H "X-CSRFToken: $CSRF" -H "Content-Type: application/json" -b /tmp/cookies.txt \
    -d '{"name": "Sample Mission 1", "quality_preset": "low"}' \
    "http://localhost:8000/api/projects/create/")
echo "$PROJECT" | python3 -m json.tool
PROJECT_ID=$(echo "$PROJECT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Project ID: $PROJECT_ID"

echo ""
echo "=== Uploading images ==="
for f in sample/sample1/*.JPG; do
    echo "  Uploading $(basename $f)..."
    curl -s -X POST -H "X-CSRFToken: $CSRF" -b /tmp/cookies.txt \
        -F "file=@$f" "http://localhost:8000/api/projects/${PROJECT_ID}/upload/" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'    OK: {d[\"file_type\"]} ({d[\"id\"][:8]}...')" || echo "    FAILED"
done

echo ""
echo "=== Starting processing ==="
curl -s -X POST -H "X-CSRFToken: $CSRF" -H "Content-Type: application/json" -b /tmp/cookies.txt \
    "http://localhost:8000/api/projects/${PROJECT_ID}/process/" | python3 -m json.tool

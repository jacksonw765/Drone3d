#!/bin/bash
set -e

# ── Drone3D Container Entrypoint ─────────────────────────
# Handles both web (Django/Gunicorn) and worker (Celery) services
# via the SERVICE_TYPE environment variable.

echo "╔══════════════════════════════════════════════╗"
echo "║          DRONE3D — Starting Service          ║"
echo "║    Tactical Geospatial Reconstruction        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Service Type: ${SERVICE_TYPE:-web}"
echo "Debug Mode:   ${DEBUG:-0}"
echo ""

# ── Wait for Redis ───────────────────────────────────
echo "⏳ Waiting for Redis..."
for i in $(seq 1 30); do
    if python -c "import redis; r = redis.Redis.from_url('${REDIS_URL:-redis://redis:6379/0}'); r.ping()" 2>/dev/null; then
        echo "✅ Redis is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ Redis connection failed after 30 attempts"
        exit 1
    fi
    sleep 1
done

# ── Service-specific startup ─────────────────────────
case "${SERVICE_TYPE}" in
    web)
        echo ""
        echo "🔧 Running database migrations..."
        python manage.py migrate --noinput

        echo "📦 Collecting static files..."
        python manage.py collectstatic --noinput

        # Auto-create superuser if env vars are set
        if [ -n "${DJANGO_SUPERUSER_USERNAME}" ] && [ -n "${DJANGO_SUPERUSER_PASSWORD}" ]; then
            echo "👤 Creating superuser (if not exists)..."
            python manage.py createsuperuser \
                --noinput \
                --username "${DJANGO_SUPERUSER_USERNAME}" \
                --email "${DJANGO_SUPERUSER_EMAIL:-admin@drone3d.local}" \
                2>/dev/null || true
        fi

        echo ""
        echo "🚀 Starting Gunicorn on :8000"
        exec gunicorn drone3d.wsgi:application \
            --bind 0.0.0.0:8000 \
            --workers ${GUNICORN_WORKERS:-3} \
            --timeout 300 \
            --access-logfile - \
            --error-logfile - \
            --log-level info
        ;;

    worker)
        echo ""
        echo "🔧 Starting Celery Worker..."
        exec celery -A drone3d worker \
            --loglevel=info \
            --concurrency=${CELERY_CONCURRENCY:-1} \
            --max-tasks-per-child=10
        ;;

    beat)
        echo ""
        echo "⏰ Starting Celery Beat..."
        exec celery -A drone3d beat \
            --loglevel=info
        ;;

    *)
        echo "❌ Unknown SERVICE_TYPE: ${SERVICE_TYPE}"
        echo "   Expected: web, worker, or beat"
        exit 1
        ;;
esac

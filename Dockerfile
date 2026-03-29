# ============================================================
# Stage 1: Builder — compile PotreeConverter, build Potree
#           viewer, install Python dependencies
# ============================================================
FROM python:3.12-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# System build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    libtbb-dev \
    libgdal-dev \
    gdal-bin \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 for building Potree
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ---------- Build PotreeConverter ----------
RUN git clone --depth 1 https://github.com/potree/PotreeConverter.git /tmp/PotreeConverter \
    && mkdir /tmp/PotreeConverter/build \
    && cd /tmp/PotreeConverter/build \
    && cmake -DCMAKE_BUILD_TYPE=Release .. \
    && make -j$(nproc) \
    && cp /tmp/PotreeConverter/build/PotreeConverter /usr/local/bin/PotreeConverter \
    && rm -rf /tmp/PotreeConverter

# ---------- Build Potree Viewer ----------
RUN git clone --depth 1 https://github.com/potree/potree.git /tmp/potree \
    && cd /tmp/potree \
    && npm install \
    && npm run build \
    && mkdir -p /opt/potree \
    && cp -r /tmp/potree/build/potree /opt/potree/build \
    && cp -r /tmp/potree/libs /opt/potree/libs \
    && rm -rf /tmp/potree

# ---------- Python dependencies ----------
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal \
    C_INCLUDE_PATH=/usr/include/gdal

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir GDAL==$(gdal-config --version).* \
    && pip install --no-cache-dir -r requirements.txt


# ============================================================
# Stage 2: Runtime — slim image with only runtime deps
# ============================================================
FROM python:3.12-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Runtime system dependencies only
# NOTE: gdal-bin pulls the correct libgdal version automatically.
# TBB runtime libs are copied from the builder stage to avoid
# hardcoding versioned package names across Debian releases.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    gdal-bin \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r drone3d && useradd -r -g drone3d -d /app -s /sbin/nologin drone3d

# Copy Python packages from builder
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy PotreeConverter binary + TBB runtime libs from builder
COPY --from=builder /usr/local/bin/PotreeConverter /usr/local/bin/PotreeConverter
COPY --from=builder /usr/lib/*/libtbb* /usr/lib/

# Copy built Potree static assets
COPY --from=builder /opt/potree /opt/potree

WORKDIR /app

# Copy application code
COPY . .

# Copy vendored Potree into static directory
RUN mkdir -p /app/static/potree \
    && cp -r /opt/potree/build /app/static/potree/build \
    && cp -r /opt/potree/libs /app/static/potree/libs

# Create required directories
RUN mkdir -p /app/media/uploads /app/media/outputs /app/data /app/staticfiles \
    && chown -R drone3d:drone3d /app

# Entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER drone3d

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]

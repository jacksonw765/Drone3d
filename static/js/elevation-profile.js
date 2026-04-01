/**
 * Drone3D — Elevation Profile Chart
 *
 * Self-contained canvas-based elevation cross-section chart.
 * Renders in a compact floating panel at the bottom of the viewer.
 * No external chart library dependencies — pure Canvas 2D API.
 */

(function () {
    'use strict';

    const COLORS = {
        bg: 'rgba(10, 14, 26, 0.92)',
        border: 'rgba(255, 255, 255, 0.08)',
        line: '#00e68a',
        lineGlow: 'rgba(0, 230, 138, 0.25)',
        fill: 'rgba(0, 230, 138, 0.08)',
        grid: 'rgba(255, 255, 255, 0.06)',
        text: 'rgba(255, 255, 255, 0.6)',
        textBright: 'rgba(255, 255, 255, 0.85)',
        accent: '#00e68a',
        cursor: 'rgba(255, 255, 255, 0.3)',
        statBg: 'rgba(255, 255, 255, 0.04)',
    };

    const PADDING = { top: 32, right: 20, bottom: 48, left: 56 };
    const CHART_HEIGHT = 160;
    const PANEL_MIN_WIDTH = 400;

    let panelEl = null;
    let canvasEl = null;
    let ctx = null;
    let currentData = null;
    let hoveredIndex = -1;
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };

    /**
     * Show the elevation profile chart with the given data.
     * @param {Object} data - { profile: [{distance_m, elevation_m, lat, lon}...], stats: {...} }
     * @param {Object} [options] - { title: string }
     */
    function show(data, options = {}) {
        if (!data || !data.profile || data.profile.length < 2) return;
        currentData = data;
        hoveredIndex = -1;

        ensurePanel();
        resizeCanvas();
        render();

        panelEl.classList.add('visible');
    }

    function hide() {
        if (panelEl) panelEl.classList.remove('visible');
        currentData = null;
    }

    function isVisible() {
        return panelEl && panelEl.classList.contains('visible');
    }

    // ── Panel Creation ─────────────────────────────────
    function ensurePanel() {
        if (panelEl) return;

        panelEl = document.createElement('div');
        panelEl.id = 'elevation-profile-panel';
        panelEl.className = 'elevation-profile-panel';
        panelEl.innerHTML = `
            <div class="ep-header" id="ep-header">
                <span class="ep-title"><i data-lucide="ruler-print" style="width:18px;height:18px;margin-right:8px;"></i> Elevation Profile</span>
                <button class="ep-close" id="ep-close" title="Close">✕</button>
            </div>
            <canvas id="ep-canvas"></canvas>
            <div class="ep-stats" id="ep-stats"></div>
        `;

        // Inject styles
        if (!document.getElementById('ep-styles')) {
            const style = document.createElement('style');
            style.id = 'ep-styles';
            style.textContent = `
                .elevation-profile-panel {
                    position: fixed;
                    bottom: 16px;
                    left: 50%;
                    transform: translateX(-50%);
                    min-width: ${PANEL_MIN_WIDTH}px;
                    max-width: 800px;
                    width: 60vw;
                    background: ${COLORS.bg};
                    border: 1px solid ${COLORS.border};
                    border-radius: 12px;
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                    z-index: 1000;
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 0.25s ease, transform 0.25s ease;
                    transform: translateX(-50%) translateY(10px);
                    overflow: hidden;
                }
                .elevation-profile-panel.visible {
                    opacity: 1;
                    pointer-events: auto;
                    transform: translateX(-50%) translateY(0);
                }
                .ep-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 8px 14px;
                    cursor: move;
                    user-select: none;
                    border-bottom: 1px solid ${COLORS.border};
                }
                .ep-title {
                    font-size: 0.78rem;
                    font-weight: 600;
                    color: ${COLORS.textBright};
                    letter-spacing: 0.02em;
                }
                .ep-close {
                    background: none;
                    border: none;
                    color: ${COLORS.text};
                    font-size: 0.85rem;
                    cursor: pointer;
                    padding: 2px 6px;
                    border-radius: 4px;
                    transition: all 0.15s;
                }
                .ep-close:hover {
                    background: rgba(255,255,255,0.1);
                    color: #fff;
                }
                #ep-canvas {
                    display: block;
                    width: 100%;
                    cursor: crosshair;
                }
                .ep-stats {
                    display: flex;
                    gap: 2px;
                    padding: 6px 10px 8px;
                    border-top: 1px solid ${COLORS.border};
                }
                .ep-stat {
                    flex: 1;
                    text-align: center;
                    padding: 4px 6px;
                    background: ${COLORS.statBg};
                    border-radius: 6px;
                }
                .ep-stat-label {
                    display: block;
                    font-size: 0.6rem;
                    color: ${COLORS.text};
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin-bottom: 1px;
                }
                .ep-stat-value {
                    display: block;
                    font-size: 0.82rem;
                    font-weight: 700;
                    color: ${COLORS.accent};
                    font-family: 'JetBrains Mono', monospace;
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(panelEl);

        // Wire events
        document.getElementById('ep-close').addEventListener('click', hide);

        // Canvas mouse tracking
        canvasEl = document.getElementById('ep-canvas');
        canvasEl.addEventListener('mousemove', onCanvasMouseMove);
        canvasEl.addEventListener('mouseleave', onCanvasMouseLeave);

        // Drag support
        const header = document.getElementById('ep-header');
        header.addEventListener('mousedown', onDragStart);
    }

    function resizeCanvas() {
        if (!canvasEl || !panelEl) return;

        const rect = panelEl.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = rect.width || PANEL_MIN_WIDTH;

        canvasEl.width = w * dpr;
        canvasEl.height = CHART_HEIGHT * dpr;
        canvasEl.style.height = CHART_HEIGHT + 'px';

        ctx = canvasEl.getContext('2d');
        ctx.scale(dpr, dpr);
    }

    // ── Rendering ──────────────────────────────────────
    function render() {
        if (!ctx || !currentData) return;

        const profile = currentData.profile;
        const stats = currentData.stats || {};
        const canvasW = canvasEl.width / (Math.min(window.devicePixelRatio || 1, 2));
        const canvasH = CHART_HEIGHT;

        // Clear
        ctx.clearRect(0, 0, canvasW, canvasH);

        // Chart area
        const chartX = PADDING.left;
        const chartY = PADDING.top;
        const chartW = canvasW - PADDING.left - PADDING.right;
        const chartH = canvasH - PADDING.top - PADDING.bottom;

        if (chartW <= 0 || chartH <= 0) return;

        // Data range
        const validPoints = profile.filter(p => p.elevation_m != null);
        if (validPoints.length < 2) return;

        const minElev = stats.min_m ?? Math.min(...validPoints.map(p => p.elevation_m));
        const maxElev = stats.max_m ?? Math.max(...validPoints.map(p => p.elevation_m));
        const elevRange = maxElev - minElev || 1;
        const elevPadding = elevRange * 0.1;
        const yMin = minElev - elevPadding;
        const yMax = maxElev + elevPadding;
        const yRange = yMax - yMin;

        const maxDist = profile[profile.length - 1].distance_m || 1;

        // Mapping functions
        const toX = (d) => chartX + (d / maxDist) * chartW;
        const toY = (e) => chartY + chartH - ((e - yMin) / yRange) * chartH;

        // ── Grid lines ────────────────────────────────
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 1;
        const numGridY = 4;
        for (let i = 0; i <= numGridY; i++) {
            const y = chartY + (i / numGridY) * chartH;
            ctx.beginPath();
            ctx.moveTo(chartX, y);
            ctx.lineTo(chartX + chartW, y);
            ctx.stroke();
        }

        // Y-axis labels
        ctx.fillStyle = COLORS.text;
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'right';
        for (let i = 0; i <= numGridY; i++) {
            const elev = yMax - (i / numGridY) * yRange;
            const y = chartY + (i / numGridY) * chartH;
            ctx.fillText(formatElev(elev), chartX - 6, y + 3);
        }

        // X-axis labels
        ctx.textAlign = 'center';
        const numGridX = 4;
        for (let i = 0; i <= numGridX; i++) {
            const dist = (i / numGridX) * maxDist;
            const x = toX(dist);
            ctx.fillText(formatDist(dist), x, chartY + chartH + 14);
        }

        // ── Gradient fill under the line ──────────────
        ctx.beginPath();
        let started = false;
        for (const p of profile) {
            if (p.elevation_m == null) continue;
            const x = toX(p.distance_m);
            const y = toY(p.elevation_m);
            if (!started) {
                ctx.moveTo(x, y);
                started = true;
            } else {
                ctx.lineTo(x, y);
            }
        }
        // Close the fill path
        const lastValid = [...profile].reverse().find(p => p.elevation_m != null);
        const firstValid = profile.find(p => p.elevation_m != null);
        if (lastValid && firstValid) {
            ctx.lineTo(toX(lastValid.distance_m), chartY + chartH);
            ctx.lineTo(toX(firstValid.distance_m), chartY + chartH);
            ctx.closePath();

            const gradient = ctx.createLinearGradient(0, chartY, 0, chartY + chartH);
            gradient.addColorStop(0, 'rgba(0, 230, 138, 0.15)');
            gradient.addColorStop(1, 'rgba(0, 230, 138, 0.01)');
            ctx.fillStyle = gradient;
            ctx.fill();
        }

        // ── Profile line ──────────────────────────────
        // Glow
        ctx.beginPath();
        started = false;
        for (const p of profile) {
            if (p.elevation_m == null) continue;
            const x = toX(p.distance_m);
            const y = toY(p.elevation_m);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = COLORS.lineGlow;
        ctx.lineWidth = 4;
        ctx.stroke();

        // Main line
        ctx.beginPath();
        started = false;
        for (const p of profile) {
            if (p.elevation_m == null) continue;
            const x = toX(p.distance_m);
            const y = toY(p.elevation_m);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = COLORS.line;
        ctx.lineWidth = 2;
        ctx.stroke();

        // ── Hover cursor ──────────────────────────────
        if (hoveredIndex >= 0 && hoveredIndex < profile.length) {
            const p = profile[hoveredIndex];
            if (p.elevation_m != null) {
                const hx = toX(p.distance_m);
                const hy = toY(p.elevation_m);

                // Vertical line
                ctx.strokeStyle = COLORS.cursor;
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(hx, chartY);
                ctx.lineTo(hx, chartY + chartH);
                ctx.stroke();
                ctx.setLineDash([]);

                // Point dot
                ctx.fillStyle = COLORS.line;
                ctx.beginPath();
                ctx.arc(hx, hy, 4, 0, Math.PI * 2);
                ctx.fill();

                // Dot glow
                ctx.fillStyle = COLORS.lineGlow;
                ctx.beginPath();
                ctx.arc(hx, hy, 7, 0, Math.PI * 2);
                ctx.fill();

                // Tooltip
                const tooltipText = `${formatElev(p.elevation_m)}  @  ${formatDist(p.distance_m)}`;
                ctx.font = 'bold 11px "JetBrains Mono", monospace';
                const tm = ctx.measureText(tooltipText);
                const tw = tm.width + 12;
                const th = 20;
                let tx = hx - tw / 2;
                let ty = hy - 24;

                // Keep tooltip in bounds
                tx = Math.max(chartX, Math.min(tx, chartX + chartW - tw));
                ty = Math.max(chartY, ty);

                ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
                ctx.beginPath();
                ctx.roundRect(tx, ty, tw, th, 4);
                ctx.fill();

                ctx.fillStyle = COLORS.accent;
                ctx.textAlign = 'center';
                ctx.fillText(tooltipText, tx + tw / 2, ty + 14);
            }
        }

        // ── Axis labels ───────────────────────────────
        ctx.fillStyle = COLORS.text;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Distance', chartX + chartW / 2, canvasH - 2);

        ctx.save();
        ctx.translate(10, chartY + chartH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('Elevation (m)', 0, 0);
        ctx.restore();

        // ── Stats bar ─────────────────────────────────
        updateStats(stats);
    }

    function updateStats(stats) {
        const el = document.getElementById('ep-stats');
        if (!el || !stats) return;

        const items = [
            { label: 'Min', value: stats.min_m != null ? formatElev(stats.min_m) : '—' },
            { label: 'Max', value: stats.max_m != null ? formatElev(stats.max_m) : '—' },
            { label: 'Range', value: stats.range_m != null ? formatElev(stats.range_m) : '—' },
            { label: 'Avg', value: stats.avg_m != null ? formatElev(stats.avg_m) : '—' },
            { label: 'Distance', value: stats.total_distance_m != null ? formatDist(stats.total_distance_m) : '—' },
        ];

        el.innerHTML = items.map(i => `
            <div class="ep-stat">
                <span class="ep-stat-label">${i.label}</span>
                <span class="ep-stat-value">${i.value}</span>
            </div>
        `).join('');
    }

    // ── Mouse Interaction ──────────────────────────────
    function onCanvasMouseMove(e) {
        if (!currentData || !canvasEl) return;

        const rect = canvasEl.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const canvasW = rect.width;

        const chartX = PADDING.left;
        const chartW = canvasW - PADDING.left - PADDING.right;

        if (mx < chartX || mx > chartX + chartW) {
            hoveredIndex = -1;
        } else {
            const frac = (mx - chartX) / chartW;
            hoveredIndex = Math.round(frac * (currentData.profile.length - 1));
            hoveredIndex = Math.max(0, Math.min(hoveredIndex, currentData.profile.length - 1));
        }
        render();
    }

    function onCanvasMouseLeave() {
        hoveredIndex = -1;
        render();
    }

    // ── Drag Support ───────────────────────────────────
    function onDragStart(e) {
        if (e.target.closest('.ep-close')) return;
        isDragging = true;
        const rect = panelEl.getBoundingClientRect();
        dragOffset.x = e.clientX - rect.left;
        dragOffset.y = e.clientY - rect.top;

        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
    }

    function onDragMove(e) {
        if (!isDragging || !panelEl) return;
        const x = e.clientX - dragOffset.x;
        const y = e.clientY - dragOffset.y;

        panelEl.style.left = x + 'px';
        panelEl.style.top = y + 'px';
        panelEl.style.bottom = 'auto';
        panelEl.style.transform = 'none';
    }

    function onDragEnd() {
        isDragging = false;
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
    }

    // ── Formatters ─────────────────────────────────────
    function formatElev(m) {
        if (m == null) return '—';
        return m.toFixed(1) + 'm';
    }

    function formatDist(d) {
        if (d == null) return '—';
        if (d < 1) return (d * 100).toFixed(0) + 'cm';
        if (d < 1000) return d.toFixed(1) + 'm';
        return (d / 1000).toFixed(2) + 'km';
    }

    // ── Window resize handler ──────────────────────────
    window.addEventListener('resize', () => {
        if (isVisible()) {
            resizeCanvas();
            render();
        }
    });

    // ── Public API ─────────────────────────────────────
    window.D3D_ElevationProfile = {
        show,
        hide,
        isVisible,
    };

})();

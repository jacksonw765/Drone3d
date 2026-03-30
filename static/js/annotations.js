/**
 * Drone3D — Annotation Overlay Renderer
 *
 * Renders GeoAnnotations as labeled markers in the viewer panel.
 * Provides category filtering, source color-coding, and click-to-inspect.
 */

(function() {
    'use strict';

    const PROJECT_ID = window.VIEWER_CONFIG?.projectId;
    if (!PROJECT_ID) return;

    // Category metadata
    const CATEGORIES = {
        structure:  { label: 'Structures',   icon: '🏛', color: '#818cf8' },
        vehicle:    { label: 'Vehicles',     icon: '🚗', color: '#f97316' },
        lz:         { label: 'Landing Zones',icon: '🛬', color: '#22c55e' },
        obstacle:   { label: 'Obstacles',    icon: '⚠',  color: '#ef4444' },
        poi:        { label: 'Points of Interest', icon: '📍', color: '#3b82f6' },
        threat:     { label: 'Threats',      icon: '🔴', color: '#dc2626' },
        route_wp:   { label: 'Route Points', icon: '🔶', color: '#eab308' },
    };

    // Source color coding
    const SOURCE_COLORS = {
        ai:       { label: 'AI Detected', color: '#818cf8', bg: 'rgba(129,140,248,0.12)' },
        manual:   { label: 'Manual',      color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
        tak:      { label: 'TAK Import',  color: '#f97316', bg: 'rgba(249,115,22,0.12)' },
        external: { label: 'External',    color: '#06b6d4', bg: 'rgba(6,182,212,0.12)' },
    };

    let allAnnotations = [];
    let activeFilters = { categories: new Set(), sources: new Set() };
    let panelEl = null;

    // ── Fetch annotations ──────────────────────────────
    async function loadAnnotations() {
        try {
            const resp = await fetch(`/ai/annotations/${PROJECT_ID}/`);
            if (!resp.ok) return;
            const data = await resp.json();
            allAnnotations = data.annotations || [];
            renderAnnotationPanel();
        } catch (e) {
            console.warn('Failed to load annotations:', e);
        }
    }

    // ── Build the panel ────────────────────────────────
    function renderAnnotationPanel() {
        if (!panelEl) return;

        const filtered = getFilteredAnnotations();
        const byCategory = {};
        filtered.forEach(a => {
            byCategory[a.category] = (byCategory[a.category] || 0) + 1;
        });

        let html = `
            <div class="panel-section">
                <div class="panel-section-title" style="display:flex;justify-content:space-between;align-items:center;">
                    Annotations
                    <span class="annotation-badge">${allAnnotations.length}</span>
                </div>

                <!-- Source Legend -->
                <div class="annotation-legend">
                    ${Object.entries(SOURCE_COLORS).map(([key, src]) => `
                        <label class="legend-item" style="border-color:${src.color}">
                            <input type="checkbox" data-source="${key}"
                                ${!activeFilters.sources.size || activeFilters.sources.has(key) ? 'checked' : ''}
                                onchange="window.D3D_Annotations.toggleSource('${key}', this.checked)">
                            <span class="legend-dot" style="background:${src.color}"></span>
                            <span class="legend-label">${src.label}</span>
                        </label>
                    `).join('')}
                </div>

                <!-- Category Filters -->
                <div class="annotation-filters">
                    ${Object.entries(CATEGORIES).map(([key, cat]) => {
                        const count = byCategory[key] || 0;
                        const allCount = allAnnotations.filter(a => a.category === key).length;
                        if (allCount === 0) return '';
                        return `
                            <button class="filter-chip ${!activeFilters.categories.size || activeFilters.categories.has(key) ? 'active' : ''}"
                                data-category="${key}"
                                onclick="window.D3D_Annotations.toggleCategory('${key}')">
                                <span>${cat.icon}</span>
                                <span>${cat.label}</span>
                                <span class="chip-count">${allCount}</span>
                            </button>
                        `;
                    }).join('')}
                </div>

                <!-- Annotation List -->
                <div class="annotation-list" id="annotation-list">
                    ${filtered.length === 0 ? `
                        <div class="annotation-empty">
                            <p>No annotations yet.</p>
                            <p style="font-size:0.75rem;color:var(--text-tertiary)">
                                AI analysis will create annotations automatically after reconstruction.
                            </p>
                        </div>
                    ` : filtered.map(a => renderAnnotationItem(a)).join('')}
                </div>
            </div>
        `;

        panelEl.innerHTML = html;
    }

    function renderAnnotationItem(ann) {
        const cat = CATEGORIES[ann.category] || CATEGORIES.poi;
        const src = SOURCE_COLORS[ann.source] || SOURCE_COLORS.manual;
        const confidence = ann.confidence != null ? `${Math.round(ann.confidence * 100)}%` : '—';

        return `
            <div class="annotation-item" data-id="${ann.id}"
                style="border-left: 3px solid ${cat.color}"
                onclick="window.D3D_Annotations.selectAnnotation('${ann.id}')">
                <div class="annotation-item-header">
                    <span class="annotation-item-icon">${cat.icon}</span>
                    <span class="annotation-item-label">${escapeHtml(ann.label)}</span>
                    <span class="annotation-item-confidence" title="Confidence">${confidence}</span>
                </div>
                <div class="annotation-item-meta">
                    <span class="annotation-source-badge" style="background:${src.bg};color:${src.color}">
                        ${src.label}
                    </span>
                    <span class="annotation-coords">
                        ${ann.latitude.toFixed(5)}, ${ann.longitude.toFixed(5)}
                    </span>
                </div>
                ${ann.metadata?.description ? `
                    <div class="annotation-item-desc">${escapeHtml(ann.metadata.description)}</div>
                ` : ''}
            </div>
        `;
    }

    function getFilteredAnnotations() {
        return allAnnotations.filter(a => {
            if (activeFilters.categories.size && !activeFilters.categories.has(a.category)) return false;
            if (activeFilters.sources.size && !activeFilters.sources.has(a.source)) return false;
            return true;
        });
    }

    // ── Filter controls ────────────────────────────────
    function toggleCategory(category) {
        if (activeFilters.categories.has(category)) {
            activeFilters.categories.delete(category);
        } else {
            activeFilters.categories.add(category);
        }
        // If all selected, clear to show all
        if (activeFilters.categories.size === Object.keys(CATEGORIES).length) {
            activeFilters.categories.clear();
        }
        renderAnnotationPanel();
    }

    function toggleSource(source, checked) {
        if (checked) {
            activeFilters.sources.add(source);
        } else {
            activeFilters.sources.delete(source);
        }
        if (activeFilters.sources.size === Object.keys(SOURCE_COLORS).length) {
            activeFilters.sources.clear();
        }
        renderAnnotationPanel();
    }

    function selectAnnotation(id) {
        const ann = allAnnotations.find(a => a.id === id);
        if (!ann) return;

        // Highlight selected
        document.querySelectorAll('.annotation-item').forEach(el => {
            el.classList.remove('selected');
        });
        const el = document.querySelector(`.annotation-item[data-id="${id}"]`);
        if (el) el.classList.add('selected');

        // Update coordinate display
        const latEl = document.getElementById('coord-lat');
        const lonEl = document.getElementById('coord-lon');
        const elevEl = document.getElementById('coord-elev');
        if (latEl) latEl.textContent = ann.latitude.toFixed(6);
        if (lonEl) lonEl.textContent = ann.longitude.toFixed(6);
        if (elevEl) elevEl.textContent = ann.altitude != null ? `${ann.altitude.toFixed(1)}m` : '—';
    }

    // ── Utility ────────────────────────────────────────
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ── Initialize ─────────────────────────────────────
    function init() {
        // Find or create the annotation panel container
        const sidePanel = document.getElementById('viewer-panel');
        if (!sidePanel) return;

        panelEl = document.createElement('div');
        panelEl.id = 'annotation-panel';

        // Insert after the Layers section
        const layersSection = sidePanel.querySelector('.panel-section');
        if (layersSection && layersSection.nextSibling) {
            sidePanel.insertBefore(panelEl, layersSection.nextSibling);
        } else {
            sidePanel.appendChild(panelEl);
        }

        loadAnnotations();
    }

    // Expose public API
    window.D3D_Annotations = {
        init,
        loadAnnotations,
        toggleCategory,
        toggleSource,
        selectAnnotation,
        getAnnotations: () => allAnnotations,
    };

    // Auto-init on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

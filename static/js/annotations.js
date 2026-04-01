/**
 * Drone3D — Annotation Overlay Renderer
 *
 * Renders AI detections and annotations in the viewer side panel.
 * Supports both Potree (georeferenced) and Three.js mesh (non-geo)
 * viewer modes with clean professional styling and click-to-highlight.
 */

(function () {
    'use strict';

    const PROJECT_ID = window.VIEWER_CONFIG?.projectId;
    if (!PROJECT_ID) return;

    // Category metadata — icons, colors
    const CATEGORIES = {
        structure: { label: 'Structures', icon: '⬨', color: '#818cf8', hex: 0x818cf8 },
        vehicle:   { label: 'Vehicles',   icon: '◈', color: '#f97316', hex: 0xf97316 },
        lz:        { label: 'Landing Zones', icon: '◎', color: '#22c55e', hex: 0x22c55e },
        obstacle:  { label: 'Obstacles',  icon: '◆', color: '#ef4444', hex: 0xef4444 },
        poi:       { label: 'Points of Interest', icon: '●', color: '#3b82f6', hex: 0x3b82f6 },
        threat:    { label: 'Threats',    icon: '⊗', color: '#dc2626', hex: 0xdc2626 },
        route_wp:  { label: 'Route Points', icon: '◇', color: '#eab308', hex: 0xeab308 },
    };

    // Source styling
    const SOURCE_STYLES = {
        ai:       { label: 'AI Detected', color: '#818cf8', bg: 'rgba(129,140,248,0.10)' },
        manual:   { label: 'Manual',      color: '#22c55e', bg: 'rgba(34,197,94,0.10)' },
        tak:      { label: 'TAK Import',  color: '#f97316', bg: 'rgba(249,115,22,0.10)' },
        external: { label: 'External',    color: '#06b6d4', bg: 'rgba(6,182,212,0.10)' },
    };

    let allAnnotations = [];
    let selectedId = null;
    let panelEl = null;
    let highlightOverlay = null;

    // ── Inject Panel Styles ───────────────────────────────
    function injectStyles() {
        if (document.getElementById('d3d-ann-styles')) return;
        const style = document.createElement('style');
        style.id = 'd3d-ann-styles';
        style.textContent = `
            .ann-section { margin-top: 8px; }
            .ann-section-title {
                font-size: 0.72rem;
                font-weight: 700;
                color: var(--text-tertiary, rgba(255,255,255,0.4));
                text-transform: uppercase;
                letter-spacing: 0.08em;
                padding: 10px 16px 6px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .ann-count-badge {
                font-size: 0.6rem;
                font-weight: 700;
                padding: 2px 7px;
                border-radius: 8px;
                background: rgba(129,140,248,0.15);
                color: #818cf8;
            }
            .ann-empty {
                padding: 20px 16px;
                text-align: center;
                color: var(--text-tertiary, rgba(255,255,255,0.4));
                font-size: 0.78rem;
                line-height: 1.5;
            }
            .ann-item {
                padding: 10px 16px 10px 13px;
                cursor: pointer;
                transition: all 0.15s ease;
                border-left: 3px solid transparent;
                position: relative;
            }
            .ann-item:hover {
                background: rgba(255,255,255,0.03);
            }
            .ann-item.selected {
                background: rgba(129,140,248,0.08);
                border-left-color: #818cf8;
            }
            .ann-item-header {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .ann-item-icon {
                width: 26px;
                height: 26px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 0.85rem;
                flex-shrink: 0;
            }
            .ann-item-label {
                font-size: 0.8rem;
                font-weight: 600;
                color: var(--text-primary, #e2e8f0);
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .ann-item-conf {
                font-size: 0.65rem;
                font-weight: 700;
                padding: 2px 5px;
                border-radius: 4px;
                flex-shrink: 0;
            }
            .ann-item-meta {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-top: 4px;
                padding-left: 34px;
            }
            .ann-source-tag {
                font-size: 0.6rem;
                font-weight: 600;
                padding: 1px 6px;
                border-radius: 3px;
                text-transform: uppercase;
                letter-spacing: 0.03em;
            }
            .ann-item-desc {
                font-size: 0.72rem;
                color: var(--text-secondary, rgba(255,255,255,0.6));
                margin-top: 3px;
                padding-left: 34px;
                line-height: 1.4;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
                overflow: hidden;
            }
            .ann-frame-tag {
                font-size: 0.6rem;
                color: var(--text-tertiary, rgba(255,255,255,0.35));
                padding-left: 34px;
                margin-top: 2px;
            }
            .ann-highlight-ring {
                position: fixed;
                pointer-events: none;
                z-index: 900;
                border: 2px solid #818cf8;
                border-radius: 50%;
                box-shadow: 0 0 20px rgba(129,140,248,0.4), 0 0 40px rgba(129,140,248,0.15);
                animation: ann-pulse 1.5s ease-in-out infinite;
            }
            @keyframes ann-pulse {
                0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.9; }
                50% { transform: translate(-50%, -50%) scale(1.15); opacity: 0.5; }
            }
            .ann-highlight-label {
                position: fixed;
                pointer-events: none;
                z-index: 901;
                font-family: 'Inter', sans-serif;
                font-size: 0.7rem;
                font-weight: 700;
                padding: 3px 8px;
                border-radius: 4px;
                background: rgba(10, 14, 26, 0.85);
                border: 1px solid rgba(129,140,248,0.3);
                color: #818cf8;
                white-space: nowrap;
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
            }
            .ann-divider {
                height: 1px;
                background: rgba(255,255,255,0.05);
                margin: 0 16px;
            }
        `;
        document.head.appendChild(style);
    }

    // ── Fetch annotations ─────────────────────────────────
    async function loadAnnotations() {
        try {
            const resp = await fetch(`/ai/annotations/${PROJECT_ID}/`);
            if (!resp.ok) return;
            const data = await resp.json();
            allAnnotations = data.annotations || [];
            renderPanel();
            updateLayerBadge();
        } catch (e) {
            console.warn('Failed to load annotations:', e);
        }
    }

    function updateLayerBadge() {
        const badge = document.getElementById('annotation-layer-count');
        if (badge) badge.textContent = allAnnotations.length;
    }

    // ── Render the annotation panel ───────────────────────
    function renderPanel() {
        if (!panelEl) return;

        if (allAnnotations.length === 0) {
            panelEl.innerHTML = `
                <div class="panel-section">
                    <div class="panel-section-title" style="display:flex;justify-content:space-between;align-items:center;">
                        AI Detections
                        <span class="ann-count-badge">0</span>
                    </div>
                    <div class="ann-empty">
                        No detections found.<br>
                        <span style="font-size:0.7rem;opacity:0.6;">
                            AI analysis runs automatically after reconstruction.
                        </span>
                    </div>
                </div>
            `;
            return;
        }

        // Group by category
        const byCategory = {};
        allAnnotations.forEach(a => {
            const cat = a.category || 'poi';
            if (!byCategory[cat]) byCategory[cat] = [];
            byCategory[cat].push(a);
        });

        let html = `
            <div class="panel-section">
                <div class="panel-section-title" style="display:flex;justify-content:space-between;align-items:center;">
                    AI Detections
                    <span class="ann-count-badge">${allAnnotations.length}</span>
                </div>
        `;

        // Render each category group
        for (const [catKey, items] of Object.entries(byCategory)) {
            const cat = CATEGORIES[catKey] || CATEGORIES.poi;
            html += `
                <div class="ann-section-title">
                    <span>${cat.icon} ${cat.label}</span>
                    <span class="ann-count-badge" style="background:${cat.color}20;color:${cat.color};">${items.length}</span>
                </div>
            `;
            items.forEach(ann => {
                html += renderItem(ann);
            });
            html += '<div class="ann-divider"></div>';
        }

        html += '</div>';
        panelEl.innerHTML = html;
    }

    function renderItem(ann) {
        const cat = CATEGORIES[ann.category] || CATEGORIES.poi;
        const src = SOURCE_STYLES[ann.source] || SOURCE_STYLES.manual;
        const conf = ann.confidence != null ? Math.round(ann.confidence * 100) : null;
        const isSelected = ann.id === selectedId;
        const isFrameBased = ann.metadata?.analysis_mode === 'video_frame';

        // Confidence color
        let confColor = '#ef4444';
        let confBg = 'rgba(239,68,68,0.1)';
        if (conf >= 70) { confColor = '#22c55e'; confBg = 'rgba(34,197,94,0.1)'; }
        else if (conf >= 40) { confColor = '#eab308'; confBg = 'rgba(234,179,8,0.1)'; }

        let html = `
            <div class="ann-item ${isSelected ? 'selected' : ''}"
                 data-id="${ann.id}"
                 onclick="window.D3D_Annotations.selectAnnotation('${ann.id}')"
                 style="border-left-color: ${isSelected ? cat.color : 'transparent'};">
                <div class="ann-item-header">
                    <div class="ann-item-icon" style="background:${cat.color}15;color:${cat.color};">
                        ${cat.icon}
                    </div>
                    <span class="ann-item-label">${escapeHtml(ann.label)}</span>
                    ${conf !== null ? `
                        <span class="ann-item-conf" style="background:${confBg};color:${confColor};">
                            ${conf}%
                        </span>
                    ` : ''}
                </div>
                <div class="ann-item-meta">
                    <span class="ann-source-tag" style="background:${src.bg};color:${src.color};">
                        ${src.label}
                    </span>
                </div>
        `;

        if (ann.metadata?.description) {
            html += `<div class="ann-item-desc">${escapeHtml(ann.metadata.description)}</div>`;
        }

        if (isFrameBased && ann.metadata?.source_frame) {
            const count = ann.metadata.detection_count || 1;
            html += `<div class="ann-frame-tag">Detected in ${count} frame${count > 1 ? 's' : ''}</div>`;
        }

        html += '</div>';
        return html;
    }

    // ── Select an annotation ──────────────────────────────
    function selectAnnotation(id) {
        const ann = allAnnotations.find(a => a.id === id);
        if (!ann) return;

        // Toggle selection
        if (selectedId === id) {
            selectedId = null;
            clearHighlight();
            renderPanel();
            return;
        }

        selectedId = id;
        renderPanel();

        // Scroll selection into view
        const el = panelEl?.querySelector(`.ann-item[data-id="${id}"]`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // Show highlight on screen
        showHighlight(ann);
    }

    // ── Screen-space highlight ────────────────────────────
    function showHighlight(ann) {
        clearHighlight();

        const isFrameBased = ann.metadata?.analysis_mode === 'video_frame';
        const cat = CATEGORIES[ann.category] || CATEGORIES.poi;

        if (isFrameBased) {
            // For frame-based detections, show a highlight at the relative
            // position within the viewer area
            const rx = ann.metadata?.relative_x ?? 0.5;
            const ry = ann.metadata?.relative_y ?? 0.5;

            const container = document.getElementById('threejs-render-area')
                || document.getElementById('potree_render_area');
            if (!container) return;

            const rect = container.getBoundingClientRect();
            const cx = rect.left + rx * rect.width;
            const cy = rect.top + ry * rect.height;

            // Create highlight ring
            const ring = document.createElement('div');
            ring.className = 'ann-highlight-ring';
            ring.style.cssText = `
                left: ${cx}px; top: ${cy}px;
                width: 50px; height: 50px;
                border-color: ${cat.color};
                box-shadow: 0 0 20px ${cat.color}66, 0 0 40px ${cat.color}22;
            `;
            document.body.appendChild(ring);

            // Create label
            const label = document.createElement('div');
            label.className = 'ann-highlight-label';
            label.style.cssText = `
                left: ${cx + 30}px; top: ${cy - 10}px;
                border-color: ${cat.color}44;
                color: ${cat.color};
            `;
            label.textContent = ann.label;
            document.body.appendChild(label);

            highlightOverlay = { ring, label };

            // Auto-clear after 4 seconds
            setTimeout(() => {
                if (highlightOverlay?.ring === ring) {
                    clearHighlight();
                }
            }, 4000);
        } else {
            // For georeferenced detections, try to fly to position in Potree
            flyToAnnotation(ann);
        }
    }

    function clearHighlight() {
        if (highlightOverlay) {
            highlightOverlay.ring?.remove();
            highlightOverlay.label?.remove();
            highlightOverlay = null;
        }
    }

    // ── Camera fly-to (Potree mode) ───────────────────────
    function flyToAnnotation(ann) {
        if (typeof Potree === 'undefined' || !window.viewer) return;

        const x = ann.longitude;
        const y = ann.latitude;
        const z = ann.altitude || 0;

        try {
            const targetPos = new THREE.Vector3(x, y, z);
            const cameraOffset = new THREE.Vector3(x + 5, y + 5, z + 10);

            if (window.viewer.scene && window.viewer.scene.view) {
                window.viewer.scene.view.position.set(
                    cameraOffset.x, cameraOffset.y, cameraOffset.z
                );
                window.viewer.scene.view.lookAt(targetPos);
            }
        } catch (e) {
            console.warn('Camera fly-to failed:', e);
        }
    }

    // ── Utility ───────────────────────────────────────────
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ── Initialize ────────────────────────────────────────
    function init() {
        injectStyles();

        const sidePanel = document.getElementById('viewer-panel');
        if (!sidePanel) return;

        panelEl = document.createElement('div');
        panelEl.id = 'annotation-panel';

        // Insert after the last .panel-section (before downloads or at end)
        const sections = sidePanel.querySelectorAll('.panel-section');
        const insertAfter = sections.length > 0 ? sections[0] : null;

        if (insertAfter && insertAfter.nextSibling) {
            sidePanel.insertBefore(panelEl, insertAfter.nextSibling);
        } else {
            sidePanel.appendChild(panelEl);
        }

        loadAnnotations();

        // Wire up the layer toggle checkbox
        const toggle = document.getElementById('toggle-annotations');
        if (toggle) {
            toggle.addEventListener('change', () => {
                if (!toggle.checked) {
                    panelEl.style.display = 'none';
                    clearHighlight();
                    _showAnnotationToast('AI detections hidden');
                } else {
                    panelEl.style.display = '';
                    _showAnnotationToast('AI detections visible');
                }
            });
        }
    }

    function _showAnnotationToast(message) {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        toast.className = 'toast toast-info';
        toast.innerHTML = `<span class="toast-icon">\u2139</span><span class="toast-message">${message}</span>`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    // ── Public API ────────────────────────────────────────
    window.D3D_Annotations = {
        init,
        loadAnnotations,
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

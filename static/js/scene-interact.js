/**
 * Drone3D — Scene Interaction Manager
 *
 * Unified click-to-select, measurement, and AI object inspection
 * for both Potree point cloud and Three.js mesh viewers.
 *
 * Architecture:
 *   scene-interact.js  ← this file (UI, state, context menu, measurement display)
 *       ↕ adapter interface
 *   mesh-viewer.js     ← raycasting + flood-fill on OBJ geometry
 *   viewer.js          ← Potree picking + point cluster selection
 */

import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// ── Interaction Modes ────────────────────────────────────
const MODE = {
    NAVIGATE: 'navigate',
    SELECT: 'select',
    MEASURE: 'measure',
    HAND: 'hand',
};

// ── State ────────────────────────────────────────────────
let currentMode = MODE.NAVIGATE;
let selections = [];          // array of { id, centroid, bbox, meshHighlight, adapter }
let measurePoints = [];        // array of THREE.Vector3
let measureLines = [];         // array of { line, label }
let contextMenuEl = null;
let infoPanelEl = null;
let labelRenderer = null;
let activeAdapter = null;      // 'potree' | 'mesh'

// Lasso state
let lassoCanvas = null;
let lassoCtx = null;
let lassoPoints = [];          // array of {x, y} in viewport pixels
let isLassoing = false;
let lassoStartTime = 0;
const LASSO_MIN_DISTANCE = 15; // min drag distance to count as lasso vs click

// Three.js scene refs (set by adapters)
let _scene = null;
let _camera = null;
let _renderer = null;
let _container = null;

// ── Adapter Registry ─────────────────────────────────────
// Each adapter must implement:
//   .pick(event)          → { position: Vector3, faceIndex, object } | null
//   .selectRegion(hit)    → { id, centroid, bbox: {min,max,size}, highlight, info }
//   .clearSelection(sel)  → void
//   .getScreenshot()      → base64 string
const adapters = {};

function registerAdapter(name, adapter) {
    adapters[name] = adapter;
}

function getActiveAdapter() {
    return adapters[activeAdapter] || null;
}

// ── Initialization ───────────────────────────────────────
function init(opts) {
    _scene = opts.scene;
    _camera = opts.camera;
    _renderer = opts.renderer;
    _container = opts.container;
    activeAdapter = opts.adapterName || 'mesh';

    createContextMenu();
    createInfoPanel();
    initLabelRenderer();
    initLassoCanvas();
    bindEvents();

    // Add toolbar buttons
    addToolbarButtons();
}

function initLabelRenderer() {
    if (!_container) return;
    labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(_container.clientWidth, _container.clientHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.left = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    labelRenderer.domElement.style.zIndex = '10';
    _container.appendChild(labelRenderer.domElement);

    window.addEventListener('resize', () => {
        if (labelRenderer && _container) {
            labelRenderer.setSize(_container.clientWidth, _container.clientHeight);
        }
    });
}

function renderLabels() {
    if (labelRenderer && _scene && _camera) {
        labelRenderer.render(_scene, _camera);
    }
}

// ── Lasso Canvas ─────────────────────────────────────────
function initLassoCanvas() {
    if (!_container) return;

    lassoCanvas = document.createElement('canvas');
    lassoCanvas.id = 'lasso-overlay';
    lassoCanvas.style.cssText = `
        position: absolute; top: 0; left: 0;
        width: 100%; height: 100%;
        pointer-events: none;
        z-index: 20;
    `;
    _container.appendChild(lassoCanvas);
    lassoCtx = lassoCanvas.getContext('2d');

    function resizeLasso() {
        if (lassoCanvas && _container) {
            lassoCanvas.width = _container.clientWidth;
            lassoCanvas.height = _container.clientHeight;
        }
    }
    resizeLasso();
    window.addEventListener('resize', resizeLasso);
}

function drawLasso() {
    if (!lassoCtx || lassoPoints.length < 2) return;
    const c = lassoCtx;
    c.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);

    c.fillStyle = 'rgba(0, 230, 138, 0.08)';
    c.beginPath();
    c.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) {
        c.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    }
    c.closePath();
    c.fill();

    c.strokeStyle = '#00e68a';
    c.lineWidth = 2;
    c.setLineDash([6, 4]);
    c.beginPath();
    c.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) {
        c.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    }
    c.closePath();
    c.stroke();
    c.setLineDash([]);

    c.fillStyle = '#00e68a';
    c.beginPath();
    c.arc(lassoPoints[0].x, lassoPoints[0].y, 4, 0, Math.PI * 2);
    c.fill();
}

function clearLasso() {
    lassoPoints = [];
    isLassoing = false;
    if (lassoCtx && lassoCanvas) {
        lassoCtx.clearRect(0, 0, lassoCanvas.width, lassoCanvas.height);
    }
}

function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        const intersect = ((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// ── Event Binding ────────────────────────────────────────
function bindEvents() {
    if (!_container) return;

    _container.addEventListener('mousedown', onMouseDown);
    _container.addEventListener('mousemove', onMouseMove);
    _container.addEventListener('mouseup', onMouseUp);
    _container.addEventListener('contextmenu', onContextMenu);

    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        if (e.key === 'Escape') {
            clearLasso();
            setMode(MODE.NAVIGATE);
            clearAllSelections();
            hideContextMenu();
            hideInfoPanel();
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            clearAllSelections();
        }
    });
}

function onMouseDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.scene-info-panel, .scene-context-menu, .viewer-toolbar, .viewer-panel, .ai-query-panel')) return;

    // In MEASURE mode, just record position for the click — don't interfere with orbit
    if (currentMode === MODE.MEASURE) {
        _measureClickStart = { x: e.clientX, y: e.clientY, time: performance.now() };
        return;
    }

    if (currentMode !== MODE.SELECT) return;

    const rect = _container.getBoundingClientRect();
    lassoPoints = [{ x: e.clientX - rect.left, y: e.clientY - rect.top }];
    lassoStartTime = performance.now();
    isLassoing = true;

    // Disable orbit controls so left-drag draws the lasso, not orbits
    const adapter = getActiveAdapter();
    if (adapter && adapter.controls) {
        adapter.controls.enabled = false;
    }
}

let _measureClickStart = null;

let _hoverThrottle = 0;
function onMouseMove(e) {
    if (isLassoing && currentMode === MODE.SELECT) {
        const rect = _container.getBoundingClientRect();
        const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };

        const last = lassoPoints[lassoPoints.length - 1];
        const dx = pt.x - last.x, dy = pt.y - last.y;
        if (dx * dx + dy * dy > 16) {
            lassoPoints.push(pt);
            drawLasso();
        }
        return;
    }

    if (currentMode === MODE.NAVIGATE) return;

    const now = performance.now();
    if (now - _hoverThrottle < 50) return;
    _hoverThrottle = now;

    const adapter = getActiveAdapter();
    if (!adapter) return;
    const hit = adapter.pick(e);
    _container.style.cursor = hit ? 'crosshair' : 'default';
}

function onMouseUp(e) {
    // Handle MEASURE mode clicks
    if (currentMode === MODE.MEASURE && _measureClickStart) {
        const dx = e.clientX - _measureClickStart.x;
        const dy = e.clientY - _measureClickStart.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const elapsed = performance.now() - _measureClickStart.time;
        _measureClickStart = null;

        // Only count as a click if the mouse didn't move much (not a drag/orbit)
        if (dist < 5 && elapsed < 500) {
            const adapter = getActiveAdapter();
            if (adapter) {
                const hit = adapter.pick(e);
                if (hit) handleMeasureClick(hit);
            }
        }
        return;
    }

    if (!isLassoing) return;

    // Re-enable orbit controls
    const adapter = getActiveAdapter();
    if (adapter && adapter.controls) {
        adapter.controls.enabled = true;
    }

    const rect = _container.getBoundingClientRect();
    lassoPoints.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });

    const first = lassoPoints[0];
    const last = lassoPoints[lassoPoints.length - 1];
    const totalDist = Math.sqrt((last.x - first.x) ** 2 + (last.y - first.y) ** 2);
    const elapsed = performance.now() - lassoStartTime;

    if (totalDist < LASSO_MIN_DISTANCE && elapsed < 400) {
        clearLasso();
        const adapter2 = getActiveAdapter();
        if (adapter2) {
            const hit = adapter2.pick(e);
            if (hit) handleSelect(hit, e.shiftKey);
        }
        return;
    }

    finalizeLasso(e.shiftKey);
}

function finalizeLasso(addToSelection) {
    if (lassoPoints.length < 5) {
        clearLasso();
        return;
    }

    drawLasso();

    const adapter = getActiveAdapter();
    if (!adapter || !adapter.selectByLasso) {
        clearLasso();
        return;
    }

    if (!addToSelection) {
        clearAllSelections();
    }

    const region = adapter.selectByLasso(lassoPoints, _camera, _container);
    if (region) {
        selections.push(region);
        showInfoPanel(region);
    }

    setTimeout(() => clearLasso(), 500);
}

function onContextMenu(e) {
    if (currentMode === MODE.NAVIGATE) return;
    e.preventDefault();

    const adapter = getActiveAdapter();
    if (!adapter) return;

    const hit = adapter.pick(e);
    if (!hit) return;

    showContextMenu(e.clientX, e.clientY, hit);
}

// ── Selection Logic ──────────────────────────────────────
function handleSelect(hit, addToSelection) {
    const adapter = getActiveAdapter();
    if (!adapter) return;

    if (!addToSelection) {
        clearAllSelections();
    }

    const region = adapter.selectRegion(hit);
    if (!region) return;

    selections.push(region);
    showInfoPanel(region);

    // If we have 2 selections, show distance
    if (selections.length === 2) {
        const dist = selections[0].centroid.distanceTo(selections[1].centroid);
        showMeasurementBetweenSelections(selections[0], selections[1], dist);
    }
}

function clearAllSelections() {
    const adapter = getActiveAdapter();
    selections.forEach(sel => {
        if (adapter) adapter.clearSelection(sel);
    });
    selections = [];
    clearMeasurements();
    hideInfoPanel();
}

// ── Measurement Logic ────────────────────────────────────
function handleMeasureClick(hit) {
    measurePoints.push(hit.position.clone());

    // Add a marker sphere at the clicked point
    addMeasureMarker(hit.position);

    if (measurePoints.length === 2) {
        const dist = measurePoints[0].distanceTo(measurePoints[1]);
        showMeasurementLine(measurePoints[0], measurePoints[1], dist);
        measurePoints = [];
    }
}

function addMeasureMarker(position) {
    const geo = new THREE.SphereGeometry(0.15, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00e68a, transparent: true, opacity: 0.9 });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.copy(position);
    sphere.userData.isMeasureMarker = true;
    _scene.add(sphere);

    // Glow ring
    const ringGeo = new THREE.RingGeometry(0.2, 0.35, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x00e68a, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(position);
    ring.lookAt(_camera.position);
    ring.userData.isMeasureMarker = true;
    _scene.add(ring);
}

function showMeasurementLine(p1, p2, distance) {
    // Line
    const points = [p1, p2];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineBasicMaterial({
        color: 0x00e68a,
        linewidth: 2,
        transparent: true,
        opacity: 0.9,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    line.userData.isMeasureLine = true;
    _scene.add(line);

    // Dashed parallel line for visibility
    const dashMat = new THREE.LineDashedMaterial({
        color: 0xffffff,
        linewidth: 1,
        dashSize: 0.3,
        gapSize: 0.15,
        transparent: true,
        opacity: 0.4,
    });
    const dashLine = new THREE.Line(lineGeo.clone(), dashMat);
    dashLine.computeLineDistances();
    dashLine.userData.isMeasureLine = true;
    _scene.add(dashLine);

    // Label at midpoint
    const midpoint = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    const distText = formatDistance(distance);

    const labelDiv = document.createElement('div');
    labelDiv.className = 'measure-label';
    labelDiv.innerHTML = `
        <span class="measure-label-value">${distText}</span>
    `;

    const label = new CSS2DObject(labelDiv);
    label.position.copy(midpoint);
    label.userData.isMeasureLabel = true;
    _scene.add(label);

    measureLines.push({ line, dashLine, label });
}

function showMeasurementBetweenSelections(sel1, sel2, distance) {
    showMeasurementLine(sel1.centroid, sel2.centroid, distance);
}

function clearMeasurements() {
    // Remove lines and labels
    measureLines.forEach(({ line, dashLine, label }) => {
        _scene.remove(line);
        _scene.remove(dashLine);
        _scene.remove(label);
        line.geometry.dispose();
        line.material.dispose();
        dashLine.geometry.dispose();
        dashLine.material.dispose();
    });
    measureLines = [];

    // Remove markers
    const markers = _scene.children.filter(c => c.userData.isMeasureMarker);
    markers.forEach(m => {
        _scene.remove(m);
        if (m.geometry) m.geometry.dispose();
        if (m.material) m.material.dispose();
    });

    measurePoints = [];
}

function formatDistance(d) {
    if (d < 1) return `${(d * 100).toFixed(1)} cm`;
    if (d < 1000) return `${d.toFixed(2)} m`;
    return `${(d / 1000).toFixed(3)} km`;
}

// ── Context Menu ─────────────────────────────────────────
function createContextMenu() {
    contextMenuEl = document.createElement('div');
    contextMenuEl.className = 'scene-context-menu';
    contextMenuEl.id = 'scene-context-menu';
    contextMenuEl.innerHTML = `
        <button class="ctx-item" data-action="inspect">
            <span class="ctx-icon"><i data-lucide="search" class="inline-icon" style="width:16px;height:16px;"></i></span>
            <span>Inspect Object</span>
        </button>
        <button class="ctx-item" data-action="measure">
            <span class="ctx-icon"><i data-lucide="ruler" style="width:18px;height:18px;margin-right:8px;"></i></span>
            <span>Measure from here</span>
        </button>
        <button class="ctx-item" data-action="annotate">
            <span class="ctx-icon"><i data-lucide="map-pin" style="width:18px;height:18px;margin-right:8px;"></i></span>
            <span>Add Annotation</span>
        </button>
        <div class="ctx-divider"></div>
        <button class="ctx-item" data-action="ask-ai">
            <span class="ctx-icon"><i data-lucide="bot" style="width:20px;height:20px;margin-right:8px;"></i></span>
            <span>Ask AI about this</span>
        </button>
        <button class="ctx-item" data-action="estimate-distance">
            <span class="ctx-icon">↔️</span>
            <span>Estimate dimensions</span>
        </button>
    `;
    document.body.appendChild(contextMenuEl);

    contextMenuEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.ctx-item');
        if (!btn) return;
        const action = btn.dataset.action;
        const hit = contextMenuEl._currentHit;
        hideContextMenu();

        switch (action) {
            case 'inspect':
                performInspect(hit);
                break;
            case 'measure':
                setMode(MODE.MEASURE);
                handleMeasureClick(hit);
                break;
            case 'annotate':
                performAnnotate(hit);
                break;
            case 'ask-ai':
                performAskAI(hit);
                break;
            case 'estimate-distance':
                performEstimateDimensions(hit);
                break;
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.scene-context-menu')) {
            hideContextMenu();
        }
    });
}

function showContextMenu(x, y, hit) {
    if (!contextMenuEl) return;
    contextMenuEl._currentHit = hit;
    contextMenuEl.style.left = `${x}px`;
    contextMenuEl.style.top = `${y}px`;
    contextMenuEl.classList.add('visible');

    // Ensure menu stays on screen
    requestAnimationFrame(() => {
        const rect = contextMenuEl.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            contextMenuEl.style.left = `${x - rect.width}px`;
        }
        if (rect.bottom > window.innerHeight) {
            contextMenuEl.style.top = `${y - rect.height}px`;
        }
    });
}

function hideContextMenu() {
    if (contextMenuEl) contextMenuEl.classList.remove('visible');
}

// ── Info Panel ───────────────────────────────────────────
function createInfoPanel() {
    infoPanelEl = document.createElement('div');
    infoPanelEl.className = 'scene-info-panel';
    infoPanelEl.id = 'scene-info-panel';
    document.body.appendChild(infoPanelEl);

    // Make info panel draggable by its header
    _makeDraggable(infoPanelEl);
}

// ── Draggable Panel Logic ────────────────────────────────
let _dragState = null;

function _makeDraggable(panel) {
    panel.addEventListener('mousedown', (e) => {
        // Only drag from header area
        const header = e.target.closest('.sip-header');
        if (!header) return;
        // Don't drag if clicking close button
        if (e.target.closest('.sip-close')) return;

        e.preventDefault();
        const rect = panel.getBoundingClientRect();
        _dragState = {
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
        };

        // Switch from fixed CSS positioning to absolute drag position
        panel.style.transition = 'none';
        panel.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
        if (!_dragState) return;
        e.preventDefault();

        const x = e.clientX - _dragState.offsetX;
        const y = e.clientY - _dragState.offsetY;

        // Clamp to viewport
        const maxX = window.innerWidth - 80;
        const maxY = window.innerHeight - 40;
        infoPanelEl.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
        infoPanelEl.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
        infoPanelEl.style.bottom = 'auto';
        infoPanelEl.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
        if (_dragState) {
            _dragState = null;
            if (infoPanelEl) {
                infoPanelEl.style.transition = '';
                infoPanelEl.style.cursor = '';
            }
        }
    });
}

function showInfoPanel(region) {
    if (!infoPanelEl) return;

    const size = region.bbox.size;
    const centroid = region.centroid;
    const info = region.info || {};

    infoPanelEl.innerHTML = `
        <div class="sip-header" style="cursor:grab;">
            <div class="sip-title">
                <span class="sip-icon">${getCategoryIcon(info.category)}</span>
                <span>${info.label || 'Selected Region'}</span>
            </div>
            <button class="sip-close" onclick="window.D3D_Interact.hideInfoPanel()">✕</button>
        </div>
        <div class="sip-body">
            <div class="sip-stats">
                <div class="sip-stat">
                    <span class="sip-stat-label">Width</span>
                    <span class="sip-stat-value">${formatDistance(size.x)}</span>
                </div>
                <div class="sip-stat">
                    <span class="sip-stat-label">Height</span>
                    <span class="sip-stat-value">${formatDistance(size.y)}</span>
                </div>
                <div class="sip-stat">
                    <span class="sip-stat-label">Depth</span>
                    <span class="sip-stat-value">${formatDistance(size.z)}</span>
                </div>
            </div>
            <div class="sip-position">
                <span class="sip-pos-label">Position</span>
                <span class="sip-pos-value">${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)}, ${centroid.z.toFixed(2)}</span>
            </div>
            ${info.category ? `
            <div class="sip-category">
                <span class="sip-cat-badge" style="background:${getCategoryColor(info.category)}">${info.category}</span>
                ${info.confidence ? `<span class="sip-confidence">${Math.round(info.confidence * 100)}% confidence</span>` : ''}
            </div>
            ` : ''}
            ${info.triangleCount ? `
            <div class="sip-detail">
                <span class="sip-detail-label">Triangles</span>
                <span class="sip-detail-value">${info.triangleCount.toLocaleString()}</span>
            </div>
            ` : ''}
            ${info.pointCount ? `
            <div class="sip-detail">
                <span class="sip-detail-label">Points</span>
                <span class="sip-detail-value">${info.pointCount.toLocaleString()}</span>
            </div>
            ` : ''}
        </div>
        <div class="sip-actions">
            <button class="sip-btn sip-btn-primary" onclick="window.D3D_Interact.inspectSelection()">
                <i data-lucide="bot" style="width:20px;height:20px;margin-right:8px;"></i> Ask AI
            </button>
            <button class="sip-btn sip-btn-secondary" onclick="window.D3D_Interact.measureFromSelection()">
                <i data-lucide="ruler" style="width:18px;height:18px;margin-right:8px;"></i> Measure
            </button>
            <button class="sip-btn sip-btn-secondary" onclick="window.D3D_Interact.annotateSelection()">
                <i data-lucide="map-pin" style="width:18px;height:18px;margin-right:8px;"></i> Annotate
            </button>
        </div>
        ${selections.length === 2 ? `
        <div class="sip-distance-result">
            <span class="sip-distance-icon">↔️</span>
            <span class="sip-distance-label">Distance between selections</span>
            <span class="sip-distance-value">${formatDistance(selections[0].centroid.distanceTo(selections[1].centroid))}</span>
        </div>
        ` : ''}
    `;

    // Reset position to default CSS location when showing new selection
    infoPanelEl.style.left = '';
    infoPanelEl.style.top = '';
    infoPanelEl.style.bottom = '';
    infoPanelEl.style.right = '';

    infoPanelEl.classList.add('visible');
}

function hideInfoPanel() {
    if (infoPanelEl) infoPanelEl.classList.remove('visible');
}

function getCategoryIcon(cat) {
    const icons = {
        structure: '<i data-lucide="building" style="width:18px;height:18px;margin-right:8px;"></i>',
        vegetation: '<i data-lucide="tree-pine" style="width:18px;height:18px;margin-right:8px;"></i>',
        vehicle: '<i data-lucide="car" style="width:18px;height:18px;margin-right:8px;"></i>',
        terrain: '⛰',
        water: '<i data-lucide="droplet" style="width:14px;height:14px;margin-right:6px;"></i>',
        road: '<i data-lucide="route" class="inline-icon" style="width:16px;height:16px;"></i>',
        unknown: '❓',
    };
    return icons[cat] || icons.unknown;
}

function getCategoryColor(cat) {
    const colors = {
        structure: 'rgba(129,140,248,0.25)',
        vegetation: 'rgba(34,197,94,0.25)',
        vehicle: 'rgba(249,115,22,0.25)',
        terrain: 'rgba(168,162,158,0.25)',
        water: 'rgba(59,130,246,0.25)',
        road: 'rgba(156,163,175,0.25)',
        unknown: 'rgba(107,114,128,0.25)',
    };
    return colors[cat] || colors.unknown;
}

// ── Action Handlers ──────────────────────────────────────
async function performInspect(hit) {
    const adapter = getActiveAdapter();
    if (!adapter) return;

    // First select the region
    clearAllSelections();
    const region = adapter.selectRegion(hit);
    if (!region) return;
    selections.push(region);
    showInfoPanel(region);

    // Then ask AI
    inspectSelection();
}

async function inspectSelection() {
    if (selections.length === 0) return;

    const sel = selections[selections.length - 1];
    const adapter = getActiveAdapter();

    const projectId = window.VIEWER_CONFIG?.projectId;
    if (!projectId) return;

    // Show loading in info panel
    const actionsEl = infoPanelEl?.querySelector('.sip-actions');
    if (actionsEl) {
        actionsEl.innerHTML = '<div class="sip-loading">Capturing views…</div>';
    }

    // ── Capture screenshots ──────────────────────────────
    let screenshots = [];  // array of { angle, image_b64 }
    let singleScreenshot = null;

    // Try multi-view if the adapter supports it
    if (adapter?.getMultiViewScreenshots && sel.centroid && sel.bbox?.size) {
        screenshots = adapter.getMultiViewScreenshots(sel.centroid, sel.bbox.size);
    }

    // Fallback to single screenshot
    if (screenshots.length === 0 && adapter?.getScreenshot) {
        singleScreenshot = adapter.getScreenshot();
    }

    if (actionsEl) {
        actionsEl.innerHTML = '<div class="sip-loading">Analyzing with AI…</div>';
    }

    try {
        const csrfToken = document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='))?.split('=')[1] || '';
        const resp = await fetch(`/ai/inspect/${projectId}/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': csrfToken,
            },
            body: JSON.stringify({
                screenshot_b64: singleScreenshot,
                screenshots: screenshots,
                bounding_box: {
                    width: sel.bbox.size.x,
                    height: sel.bbox.size.y,
                    depth: sel.bbox.size.z,
                },
                position: {
                    x: sel.centroid.x,
                    y: sel.centroid.y,
                    z: sel.centroid.z,
                },
                info: sel.info,
                project_name: window.VIEWER_CONFIG?.projectName || '',
            }),
        });

        const data = await resp.json();

        // Show AI response in panel
        if (infoPanelEl) {
            const responseEl = document.createElement('div');
            responseEl.className = 'sip-ai-response';
            responseEl.innerHTML = `
                <div class="sip-ai-header">
                    <span class="sip-ai-badge">AI Analysis</span>
                </div>
                <div class="sip-ai-text">${escapeHtml(data.answer || data.error || 'No response')}</div>
                <div class="sip-ai-actions">
                    <button class="sip-btn sip-btn-ghost" onclick="window.D3D_Interact.askFollowUp()">
                        Ask follow-up →
                    </button>
                </div>
            `;
            infoPanelEl.querySelector('.sip-body')?.appendChild(responseEl);

            // Restore action buttons
            if (actionsEl) {
                actionsEl.innerHTML = `
                    <button class="sip-btn sip-btn-primary" onclick="window.D3D_Interact.inspectSelection()">
                        <i data-lucide="bot" style="width:20px;height:20px;margin-right:8px;"></i> Ask Again
                    </button>
                    <button class="sip-btn sip-btn-secondary" onclick="window.D3D_Interact.measureFromSelection()">
                        <i data-lucide="ruler" style="width:18px;height:18px;margin-right:8px;"></i> Measure
                    </button>
                `;
            }
        }
    } catch (e) {
        if (actionsEl) {
            actionsEl.innerHTML = `
                <div class="sip-error">AI query failed: ${e.message}</div>
                <button class="sip-btn sip-btn-primary" onclick="window.D3D_Interact.inspectSelection()">
                    <i data-lucide="bot" style="width:20px;height:20px;margin-right:8px;"></i> Retry
                </button>
            `;
        }
    }
}

function performAnnotate(hit) {
    const adapter = getActiveAdapter();
    if (!adapter) return;

    const region = adapter.selectRegion(hit);
    if (!region) return;

    const label = prompt('Annotation label:', region.info?.label || 'New Annotation');
    if (!label) return;

    const projectId = window.VIEWER_CONFIG?.projectId;
    if (!projectId) return;

    const csrfToken = document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='))?.split('=')[1] || '';

    fetch(`/ai/annotations/${projectId}/create/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRFToken': csrfToken,
        },
        body: JSON.stringify({
            label,
            category: region.info?.category || 'poi',
            latitude: region.centroid.y,
            longitude: region.centroid.x,
            altitude: region.centroid.z,
            metadata: {
                description: `Selected from 3D viewer. Dimensions: ${formatDistance(region.bbox.size.x)} × ${formatDistance(region.bbox.size.y)} × ${formatDistance(region.bbox.size.z)}`,
                source_mode: activeAdapter,
            },
        }),
    }).then(r => r.json()).then(data => {
        if (data.id) {
            showToast('Annotation created', 'success');
            // Refresh annotation list
            if (window.D3D_Annotations) window.D3D_Annotations.loadAnnotations();
        }
    }).catch(e => {
        showToast('Failed to create annotation: ' + e.message, 'error');
    });
}

function performAskAI(hit) {
    const adapter = getActiveAdapter();
    if (!adapter) return;

    clearAllSelections();
    const region = adapter.selectRegion(hit);
    if (!region) return;
    selections.push(region);

    // Open AI panel with pre-filled context
    if (window.D3D_AI) {
        window.D3D_AI.togglePanel();
        const dims = `${formatDistance(region.bbox.size.x)} × ${formatDistance(region.bbox.size.y)} × ${formatDistance(region.bbox.size.z)}`;
        const question = `What can you tell me about the ${region.info?.category || 'object'} at position (${region.centroid.x.toFixed(1)}, ${region.centroid.y.toFixed(1)}, ${region.centroid.z.toFixed(1)}) with dimensions ${dims}?`;
        window.D3D_AI.query(question);
    }
}

function performEstimateDimensions(hit) {
    const adapter = getActiveAdapter();
    if (!adapter) return;

    clearAllSelections();
    const region = adapter.selectRegion(hit);
    if (!region) return;
    selections.push(region);
    showInfoPanel(region);
}

function measureFromSelection() {
    setMode(MODE.MEASURE);
    if (selections.length > 0) {
        measurePoints.push(selections[selections.length - 1].centroid.clone());
        addMeasureMarker(measurePoints[0]);
    }
    showToast('Click another point to measure distance', 'info');
}

function askFollowUp() {
    if (window.D3D_AI) {
        window.D3D_AI.togglePanel();
    }
}

function annotateSelection() {
    if (selections.length === 0) return;
    performAnnotate({ position: selections[selections.length - 1].centroid });
}

// ── Mode Management ──────────────────────────────────────
let _handModePrevControls = null;

function setMode(mode) {
    // Restore controls when leaving hand mode
    if (currentMode === MODE.HAND && mode !== MODE.HAND) {
        const adapter = getActiveAdapter();
        if (adapter && adapter.controls && _handModePrevControls) {
            adapter.controls.mouseButtons.LEFT = _handModePrevControls.left;
            adapter.controls.mouseButtons.MIDDLE = _handModePrevControls.middle;
            adapter.controls.mouseButtons.RIGHT = _handModePrevControls.right;
            _handModePrevControls = null;
        }
    }

    currentMode = mode;

    // Update toolbar button states
    document.getElementById('btn-interact-select')?.classList.toggle('active', mode === MODE.SELECT);
    document.getElementById('btn-interact-measure')?.classList.toggle('active', mode === MODE.MEASURE);
    document.getElementById('btn-interact-hand')?.classList.toggle('active', mode === MODE.HAND);

    // Update cursor
    if (_container) {
        if (mode === MODE.HAND) {
            _container.style.cursor = 'grab';
        } else if (mode === MODE.NAVIGATE) {
            _container.style.cursor = '';
        } else {
            _container.style.cursor = 'crosshair';
        }
    }

    // Reset measurement state when switching modes
    if (mode !== MODE.MEASURE) {
        measurePoints = [];
    }

    // Hand mode: remap left mouse to pan
    if (mode === MODE.HAND) {
        const adapter = getActiveAdapter();
        if (adapter && adapter.controls) {
            const ctrl = adapter.controls;
            _handModePrevControls = {
                left: ctrl.mouseButtons.LEFT,
                middle: ctrl.mouseButtons.MIDDLE,
                right: ctrl.mouseButtons.RIGHT,
            };
            // Import THREE namespace from the controls' constructor or fallback
            ctrl.mouseButtons.LEFT = 2;    // PAN (THREE.MOUSE.RIGHT = 2)
            ctrl.mouseButtons.MIDDLE = 1;  // DOLLY
            ctrl.mouseButtons.RIGHT = 0;   // ROTATE
        }
    }

    // Notify adapters
    const adapter = getActiveAdapter();
    if (adapter && adapter.onModeChange) {
        adapter.onModeChange(mode);
    }
}

function toggleSelect() {
    setMode(currentMode === MODE.SELECT ? MODE.NAVIGATE : MODE.SELECT);
    if (currentMode === MODE.NAVIGATE) {
        clearAllSelections();
    }
}

function toggleMeasure() {
    setMode(currentMode === MODE.MEASURE ? MODE.NAVIGATE : MODE.MEASURE);
    if (currentMode === MODE.NAVIGATE) {
        clearMeasurements();
    }
}

function toggleHand() {
    setMode(currentMode === MODE.HAND ? MODE.NAVIGATE : MODE.HAND);
}

// ── Toolbar ──────────────────────────────────────────────
function addToolbarButtons() {
    const toolbar = document.getElementById('viewer-toolbar');
    if (!toolbar) return;

    // Find the settings button to insert before
    const settingsBtn = document.getElementById('btn-toggle-panel');
    const insertBefore = settingsBtn || null;

    const divider = document.createElement('div');
    divider.className = 'viewer-toolbar-divider';

    const selectBtn = document.createElement('button');
    selectBtn.className = 'viewer-toolbar-btn';
    selectBtn.id = 'btn-interact-select';
    selectBtn.title = 'Select Object [Q]';
    selectBtn.innerHTML = '⊹';
    selectBtn.onclick = toggleSelect;

    const measureBtn = document.createElement('button');
    measureBtn.className = 'viewer-toolbar-btn';
    measureBtn.id = 'btn-interact-measure';
    measureBtn.title = 'Measure Distance [M]';
    measureBtn.innerHTML = '⌗';
    measureBtn.onclick = toggleMeasure;

    const handBtn = document.createElement('button');
    handBtn.className = 'viewer-toolbar-btn';
    handBtn.id = 'btn-interact-hand';
    handBtn.title = 'Hand Tool — Pan [H]';
    handBtn.innerHTML = '✋';
    handBtn.onclick = toggleHand;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'viewer-toolbar-btn';
    clearBtn.id = 'btn-interact-clear';
    clearBtn.title = 'Clear Selections [Esc]';
    clearBtn.innerHTML = '⌀';
    clearBtn.onclick = () => { clearAllSelections(); clearMeasurements(); setMode(MODE.NAVIGATE); };

    if (insertBefore) {
        toolbar.insertBefore(divider, insertBefore);
        toolbar.insertBefore(selectBtn, insertBefore);
        toolbar.insertBefore(measureBtn, insertBefore);
        toolbar.insertBefore(handBtn, insertBefore);
        toolbar.insertBefore(clearBtn, insertBefore);
    } else {
        toolbar.appendChild(divider);
        toolbar.appendChild(selectBtn);
        toolbar.appendChild(measureBtn);
        toolbar.appendChild(handBtn);
        toolbar.appendChild(clearBtn);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        if (e.key === 'q') toggleSelect();
        if (e.key === 'x') toggleMeasure();
        if (e.key === 'h') toggleHand();
    });
}

// ── Utilities ────────────────────────────────────────────
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showToast(message, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type]}</span>
        <span class="toast-message">${escapeHtml(message)}</span>
    `;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ── Public API ───────────────────────────────────────────
export {
    init,
    registerAdapter,
    setMode,
    toggleSelect,
    toggleMeasure,
    toggleHand,
    clearAllSelections,
    clearMeasurements,
    hideInfoPanel,
    hideContextMenu,
    inspectSelection,
    measureFromSelection,
    askFollowUp,
    annotateSelection,
    renderLabels,
    formatDistance,
    pointInPolygon,
    selections,
    MODE,
    currentMode,
};

// Also expose on window for non-module scripts
window.D3D_Interact = {
    init,
    registerAdapter,
    setMode,
    toggleSelect,
    toggleMeasure,
    toggleHand,
    clearAllSelections,
    clearMeasurements,
    hideInfoPanel,
    hideContextMenu,
    inspectSelection,
    measureFromSelection,
    askFollowUp,
    annotateSelection,
    renderLabels,
    formatDistance,
    getMode: () => currentMode,
    getSelections: () => selections,
    MODE,
};

/**
 * Drone3D — 3D Viewer Controller (Potree + Interactive Selection)
 *
 * Initializes Potree viewer, manages layer toggles, measurement tools,
 * point cloud styling, coordinate display, and provides a point cloud
 * selection adapter for scene-interact.js.
 */

(function () {
    'use strict';

    const CONFIG = window.VIEWER_CONFIG || {};
    let viewer = null;
    let pointCloudLayer = null;
    let panelOpen = false;

    // ── Selection State ──────────────────────────────────
    let selectionSpheres = [];
    let selectionIdCounter = 0;
    const PICK_RADIUS = 2.0;          // point cloud cluster radius in scene units
    const SELECTION_COLOR = 0x00e68a;

    // ── Initialize Potree ───────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        if (!CONFIG.hasPotree) {
            console.warn('No Potree data available');
            return;
        }

        initViewer();
    });

    function initViewer() {
        const renderArea = document.getElementById('potree_render_area');
        if (!renderArea) return;

        // Initialize Potree viewer
        viewer = new Potree.Viewer(renderArea);
        viewer.setEDLEnabled(true);
        viewer.setFOV(60);
        viewer.setPointBudget(1_000_000);
        viewer.loadSettingsFromURL();
        viewer.setBackground('gradient');

        // Set navigation mode
        viewer.setControls(viewer.orbitControls);

        // Load point cloud
        if (CONFIG.potreeDataUrl) {
            const metadataUrl = CONFIG.potreeDataUrl + 'metadata.json';

            Potree.loadPointCloud(metadataUrl, CONFIG.projectName, (e) => {
                pointCloudLayer = e.pointcloud;
                viewer.scene.addPointCloud(pointCloudLayer);

                // Fit view to point cloud bounds
                viewer.fitToScreen();

                // Set default material
                pointCloudLayer.material.size = 1.0;
                pointCloudLayer.material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
                pointCloudLayer.material.activeAttributeName = 'rgba';

                console.log('Point cloud loaded:', CONFIG.projectName);

                // Initialize interaction after point cloud loads
                initPotreeInteraction();
            });
        }

        // Set up coordinate tracking
        setupCoordinateDisplay();
    }

    // ── Potree Interaction System ────────────────────────
    function initPotreeInteraction() {
        // Use a script tag approach since Potree uses its own Three.js
        // We can't use ES module imports here — scene-interact needs
        // to be loaded as a classic script with Potree's Three.js
        addInteractionToolbarButtons();
    }

    let potreeInteractMode = 'navigate'; // 'navigate' | 'select' | 'measure'
    let potreeMeasurePoints = [];
    let potreeSelections = [];

    function addInteractionToolbarButtons() {
        const toolbar = document.getElementById('viewer-toolbar');
        if (!toolbar) return;

        const settingsBtn = document.getElementById('btn-toggle-panel');
        const insertBefore = settingsBtn || null;

        const divider = document.createElement('div');
        divider.className = 'viewer-toolbar-divider';

        const selectBtn = document.createElement('button');
        selectBtn.className = 'viewer-toolbar-btn';
        selectBtn.id = 'btn-interact-select';
        selectBtn.title = 'Select Region [Q]';
        selectBtn.innerHTML = '⊹';
        selectBtn.onclick = togglePotreeSelect;

        const measureBtn = document.createElement('button');
        measureBtn.className = 'viewer-toolbar-btn';
        measureBtn.id = 'btn-interact-measure';
        measureBtn.title = 'Point Measure [X]';
        measureBtn.innerHTML = '⌗';
        measureBtn.onclick = togglePotreeMeasure;

        const clearBtn = document.createElement('button');
        clearBtn.className = 'viewer-toolbar-btn';
        clearBtn.id = 'btn-interact-clear';
        clearBtn.title = 'Clear Selections [Esc]';
        clearBtn.innerHTML = '⌀';
        clearBtn.onclick = clearPotreeSelections;

        if (insertBefore) {
            toolbar.insertBefore(divider, insertBefore);
            toolbar.insertBefore(selectBtn, insertBefore);
            toolbar.insertBefore(measureBtn, insertBefore);
            toolbar.insertBefore(clearBtn, insertBefore);
        } else {
            toolbar.appendChild(divider);
            toolbar.appendChild(selectBtn);
            toolbar.appendChild(measureBtn);
            toolbar.appendChild(clearBtn);
        }

        // Bind click events on the render area
        const renderArea = document.getElementById('potree_render_area');
        if (renderArea) {
            renderArea.addEventListener('click', onPotreeClick);
            renderArea.addEventListener('contextmenu', onPotreeContextMenu);
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
            if (e.key === 'q') togglePotreeSelect();
            if (e.key === 'x') togglePotreeMeasure();
            if (e.key === 'Escape') {
                setPotreeMode('navigate');
                clearPotreeSelections();
                hidePotreeInfoPanel();
                hidePotreeContextMenu();
            }
        });
    }

    function setPotreeMode(mode) {
        potreeInteractMode = mode;
        document.getElementById('btn-interact-select')?.classList.toggle('active', mode === 'select');
        document.getElementById('btn-interact-measure')?.classList.toggle('active', mode === 'measure');

        const renderArea = document.getElementById('potree_render_area');
        if (renderArea) {
            renderArea.style.cursor = mode === 'navigate' ? '' : 'crosshair';
        }
        if (mode !== 'measure') {
            potreeMeasurePoints = [];
        }
    }

    function togglePotreeSelect() {
        setPotreeMode(potreeInteractMode === 'select' ? 'navigate' : 'select');
    }

    function togglePotreeMeasure() {
        setPotreeMode(potreeInteractMode === 'measure' ? 'navigate' : 'measure');
    }

    // ── Potree Picking ───────────────────────────────────
    function potreePick(event) {
        if (!viewer || !pointCloudLayer) return null;

        const renderArea = document.getElementById('potree_render_area');
        if (!renderArea) return null;

        // Use Potree's built-in pick mechanism
        const rect = renderArea.getBoundingClientRect();
        const mouse = {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        };

        // Use Potree's input handler for picking
        const pickPoint = viewer.inputHandler
            ? getPointUnderMouse(event)
            : null;

        return pickPoint;
    }

    function getPointUnderMouse(event) {
        if (!viewer) return null;

        try {
            const renderArea = document.getElementById('potree_render_area');
            const rect = renderArea.getBoundingClientRect();

            const mousePos = new THREE.Vector2(
                event.clientX - rect.left,
                event.clientY - rect.top
            );

            // Potree's pick method
            const pickResult = viewer.scene.pointclouds.length > 0
                ? Potree.Utils.pick(
                    viewer.renderer,
                    viewer.scene.camera,
                    mousePos,
                    viewer.scene.pointclouds,
                    { pickWindowSize: 17 }
                )
                : null;

            if (pickResult && pickResult.position) {
                return {
                    position: new THREE.Vector3(
                        pickResult.position.x,
                        pickResult.position.y,
                        pickResult.position.z
                    ),
                    pointIndex: pickResult.pointIndex || 0,
                    pointCloud: pickResult.pointcloud,
                    color: pickResult.color || null,
                };
            }
        } catch (e) {
            // Fallback: try using scene raycasting
            console.warn('Potree pick failed, using fallback:', e);
        }

        return null;
    }

    // ── Click Handlers ───────────────────────────────────
    function onPotreeClick(event) {
        if (event.target.closest('.scene-info-panel, .scene-context-menu, .viewer-toolbar, .viewer-panel, .ai-query-panel')) return;
        hidePotreeContextMenu();

        if (potreeInteractMode === 'navigate') return;

        const hit = potreePick(event);
        if (!hit) return;

        if (potreeInteractMode === 'select') {
            handlePotreeSelect(hit, event.shiftKey);
        } else if (potreeInteractMode === 'measure') {
            handlePotreeMeasure(hit);
        }
    }

    function onPotreeContextMenu(event) {
        if (potreeInteractMode === 'navigate') return;
        event.preventDefault();

        const hit = potreePick(event);
        if (!hit) return;

        showPotreeContextMenu(event.clientX, event.clientY, hit);
    }

    // ── Selection by Height-Connected Clustering ──────────
    function handlePotreeSelect(hit, addToSelection) {
        if (!addToSelection) {
            clearPotreeSelections();
        }

        const selId = `sel-potree-${++selectionIdCounter}`;
        const pos = hit.position;

        // ── Height-based object isolation ──────────────────
        // Instead of a uniform sphere, determine the object's vertical extent
        // by estimating the ground level and the object's height above ground.

        let horizontalRadius = PICK_RADIUS;
        let heightAboveGround = 0;
        let groundLevel = pos.z; // default: assume clicked point IS ground
        let objectTop = pos.z;
        let objectBottom = pos.z;

        if (pointCloudLayer && pointCloudLayer.boundingBox) {
            const pcBbox = pointCloudLayer.boundingBox;
            const pcSize = new THREE.Vector3();
            pcBbox.getSize(pcSize);
            const maxDim = Math.max(pcSize.x, pcSize.y, pcSize.z);

            // Estimate ground level as the bottom of the scene bounding box
            // (most drone scans have terrain at the bottom)
            groundLevel = pcBbox.min.z;

            // Height of clicked point above ground
            heightAboveGround = pos.z - groundLevel;
            const sceneHeight = pcSize.z || 1;
            const relativeHeight = heightAboveGround / sceneHeight;

            if (relativeHeight > 0.25) {
                // Elevated object (tree, building, pole)
                // Use height-aware radius: wider for big objects, tighter for thin ones
                horizontalRadius = Math.max(
                    maxDim * 0.015,
                    heightAboveGround * 0.4 // ~40% of height as radius
                );
                // Extend selection down to near-ground but not INTO the ground
                objectBottom = groundLevel + sceneHeight * 0.05;
                objectTop = pos.z + heightAboveGround * 0.3; // extend a bit above click point
            } else if (relativeHeight < 0.1) {
                // Ground-level feature (terrain, road)
                horizontalRadius = maxDim * 0.03;
                objectBottom = pos.z - sceneHeight * 0.02;
                objectTop = pos.z + sceneHeight * 0.05;
            } else {
                // Mid-level feature
                horizontalRadius = maxDim * 0.025;
                objectBottom = groundLevel + sceneHeight * 0.03;
                objectTop = pos.z + heightAboveGround * 0.5;
            }
        }

        // Keep sizeX/Y/Z for metadata, but visuals are ring-based
        const sizeX = horizontalRadius * 2;
        const sizeZ = horizontalRadius * 2;
        const sizeY = objectTop - objectBottom;

        // ── Visual: Selection ring (flat circle at click point) ──
        const ringInner = horizontalRadius * 0.90;
        const ringOuter = horizontalRadius * 1.0;
        const ringGeo = new THREE.RingGeometry(ringInner, ringOuter, 64);
        const ringMat = new THREE.MeshBasicMaterial({
            color: SELECTION_COLOR,
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
            depthTest: false,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(pos);
        // RingGeometry faces +Z by default; rotate to lie flat on XZ
        ring.rotation.x = -Math.PI / 2;

        // Outer glow ring
        const glowGeo = new THREE.RingGeometry(ringOuter * 0.97, ringOuter * 1.08, 64);
        const glowMat = new THREE.MeshBasicMaterial({
            color: SELECTION_COLOR,
            transparent: true,
            opacity: 0.25,
            side: THREE.DoubleSide,
            depthTest: false,
        });
        const glowRing = new THREE.Mesh(glowGeo, glowMat);
        glowRing.position.copy(pos);
        glowRing.rotation.x = -Math.PI / 2;

        // Center dot (red, at click point)
        const dotGeo = new THREE.SphereGeometry(horizontalRadius * 0.06, 16, 16);
        const dotMat = new THREE.MeshBasicMaterial({
            color: 0xff3333,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
        });
        const centerDot = new THREE.Mesh(dotGeo, dotMat);
        centerDot.position.copy(pos);

        // Add to Potree scene
        viewer.scene.scene.add(ring);
        viewer.scene.scene.add(glowRing);
        viewer.scene.scene.add(centerDot);

        // Estimate point count
        let pointCount = 0;
        try {
            if (pointCloudLayer && pointCloudLayer.numVisiblePoints) {
                const pcBbox = pointCloudLayer.boundingBox;
                if (pcBbox) {
                    const pcSize = new THREE.Vector3();
                    pcBbox.getSize(pcSize);
                    const pcVolume = pcSize.x * pcSize.y * pcSize.z;
                    const selVolume = Math.PI * horizontalRadius * horizontalRadius * sizeY;
                    pointCount = Math.round(pointCloudLayer.numVisiblePoints * (selVolume / pcVolume));
                }
            }
        } catch (e) { /* estimation failed */ }

        const size = new THREE.Vector3(sizeX, sizeY, sizeZ);
        const bboxMin = new THREE.Vector3(pos.x - horizontalRadius, objectBottom, pos.y - horizontalRadius);
        const bboxMax = new THREE.Vector3(pos.x + horizontalRadius, objectTop, pos.y + horizontalRadius);

        // Classify based on position and height
        const info = classifyPotreeRegion(pos, horizontalRadius, pointCount, heightAboveGround);

        const sel = {
            id: selId,
            centroid: pos.clone(),
            bbox: { min: bboxMin, max: bboxMax, size },
            highlight: { ring, glowRing, centerDot },
            adapter: 'potree',
            info: {
                ...info,
                pointCount,
                heightAboveGround: heightAboveGround.toFixed(2),
            },
        };

        potreeSelections.push(sel);
        showPotreeInfoPanel(sel);

        // If two selections, show distance
        if (potreeSelections.length === 2) {
            const dist = potreeSelections[0].centroid.distanceTo(potreeSelections[1].centroid);
            showPotreeMeasureLine(potreeSelections[0].centroid, potreeSelections[1].centroid, dist);
        }
    }

    function classifyPotreeRegion(position, radius, pointCount, heightAboveGround) {
        let category = 'unknown';
        let label = 'Selected Region';
        let confidence = 0.4;

        if (pointCloudLayer && pointCloudLayer.boundingBox) {
            const pcBbox = pointCloudLayer.boundingBox;
            const pcSize = new THREE.Vector3();
            pcBbox.getSize(pcSize);
            const sceneHeight = pcSize.z || 1;
            const relativeHeight = heightAboveGround / sceneHeight;

            if (relativeHeight > 0.5) {
                category = 'vegetation';
                label = 'Tall Feature (Tree / Tower)';
                confidence = 0.6;
            } else if (relativeHeight > 0.25) {
                category = 'structure';
                label = 'Elevated Feature (Structure / Tall Vegetation)';
                confidence = 0.55;
            } else if (relativeHeight < 0.08) {
                category = 'terrain';
                label = 'Ground / Terrain';
                confidence = 0.6;
            } else {
                category = 'structure';
                label = 'Low Structure / Feature';
                confidence = 0.45;
            }
        }

        return { category, label, confidence };
    }

    // ── Measurement in Potree ────────────────────────────
    function handlePotreeMeasure(hit) {
        potreeMeasurePoints.push(hit.position.clone());

        // Add marker at point
        const markerGeo = new THREE.SphereGeometry(0.15, 16, 16);
        const markerMat = new THREE.MeshBasicMaterial({
            color: SELECTION_COLOR,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
        });
        const marker = new THREE.Mesh(markerGeo, markerMat);
        marker.position.copy(hit.position);
        marker.userData.isMeasureMarker = true;
        viewer.scene.scene.add(marker);
        selectionSpheres.push(marker);

        if (potreeMeasurePoints.length === 2) {
            const dist = potreeMeasurePoints[0].distanceTo(potreeMeasurePoints[1]);
            showPotreeMeasureLine(potreeMeasurePoints[0], potreeMeasurePoints[1], dist);
            potreeMeasurePoints = [];
        }
    }

    function showPotreeMeasureLine(p1, p2, distance) {
        const points = [p1.clone(), p2.clone()];
        const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
        const lineMat = new THREE.LineBasicMaterial({
            color: SELECTION_COLOR,
            linewidth: 2,
        });
        const line = new THREE.Line(lineGeo, lineMat);
        line.userData.isMeasureLine = true;
        viewer.scene.scene.add(line);
        selectionSpheres.push(line);

        // Show distance label using Potree annotation
        const midpoint = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
        const distText = formatDistance(distance);

        // Create a floating label div
        const labelDiv = document.createElement('div');
        labelDiv.className = 'potree-measure-label';
        labelDiv.innerHTML = `<span class="measure-label-value">${distText}</span>`;
        labelDiv.style.cssText = `
            position: absolute; z-index: 200; pointer-events: none;
            background: rgba(0, 230, 138, 0.9); color: #0a0e17;
            padding: 4px 10px; border-radius: 6px; font-size: 0.8rem;
            font-weight: 700; font-family: 'JetBrains Mono', monospace;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        `;

        const renderArea = document.getElementById('potree_render_area');
        if (renderArea) {
            renderArea.appendChild(labelDiv);

            // Update label position each frame
            function updateLabelPos() {
                if (!labelDiv.parentNode) return;
                const projected = midpoint.clone().project(viewer.scene.camera);
                const rect = renderArea.getBoundingClientRect();
                const x = (projected.x * 0.5 + 0.5) * rect.width;
                const y = (-projected.y * 0.5 + 0.5) * rect.height;
                labelDiv.style.left = `${x - labelDiv.offsetWidth / 2}px`;
                labelDiv.style.top = `${y - labelDiv.offsetHeight - 10}px`;
                requestAnimationFrame(updateLabelPos);
            }
            updateLabelPos();

            selectionSpheres.push({ remove: () => labelDiv.remove() });
        }

        showToast(`Distance: ${distText}`, 'success');
    }

    function clearPotreeSelections() {
        // Clear selection highlights
        potreeSelections.forEach(sel => {
            if (sel.highlight) {
                Object.values(sel.highlight).forEach(obj => {
                    if (obj && viewer.scene.scene) {
                        viewer.scene.scene.remove(obj);
                        if (obj.geometry) obj.geometry.dispose();
                        if (obj.material) obj.material.dispose();
                    }
                });
            }
        });
        potreeSelections = [];

        // Clear measurement markers and lines
        selectionSpheres.forEach(obj => {
            if (obj && obj.remove) {
                obj.remove();
            } else if (obj && viewer.scene.scene) {
                viewer.scene.scene.remove(obj);
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) obj.material.dispose();
            }
        });
        selectionSpheres = [];
        potreeMeasurePoints = [];

        hidePotreeInfoPanel();
        setPotreeMode('navigate');
    }

    // ── Context Menu ─────────────────────────────────────
    let potreeContextMenuEl = null;

    function showPotreeContextMenu(x, y, hit) {
        if (!potreeContextMenuEl) {
            potreeContextMenuEl = document.createElement('div');
            potreeContextMenuEl.className = 'scene-context-menu';
            potreeContextMenuEl.id = 'potree-context-menu';
            potreeContextMenuEl.innerHTML = `
                <button class="ctx-item" data-action="inspect">
                    <span class="ctx-icon">🔍</span>
                    <span>Inspect Region</span>
                </button>
                <button class="ctx-item" data-action="measure">
                    <span class="ctx-icon">📏</span>
                    <span>Measure from here</span>
                </button>
                <button class="ctx-item" data-action="annotate">
                    <span class="ctx-icon">📌</span>
                    <span>Add Annotation</span>
                </button>
                <div class="ctx-divider"></div>
                <button class="ctx-item" data-action="ask-ai">
                    <span class="ctx-icon">🤖</span>
                    <span>Ask AI about this</span>
                </button>
            `;
            document.body.appendChild(potreeContextMenuEl);

            potreeContextMenuEl.addEventListener('click', (e) => {
                const btn = e.target.closest('.ctx-item');
                if (!btn) return;
                const action = btn.dataset.action;
                const storedHit = potreeContextMenuEl._currentHit;
                hidePotreeContextMenu();

                switch (action) {
                    case 'inspect':
                        handlePotreeSelect(storedHit, false);
                        inspectPotreeSelection();
                        break;
                    case 'measure':
                        setPotreeMode('measure');
                        handlePotreeMeasure(storedHit);
                        break;
                    case 'annotate':
                        annotatePotreePoint(storedHit);
                        break;
                    case 'ask-ai':
                        handlePotreeSelect(storedHit, false);
                        askAIPotree();
                        break;
                }
            });

            document.addEventListener('click', (e) => {
                if (!e.target.closest('.scene-context-menu')) {
                    hidePotreeContextMenu();
                }
            });
        }

        potreeContextMenuEl._currentHit = hit;
        potreeContextMenuEl.style.left = `${x}px`;
        potreeContextMenuEl.style.top = `${y}px`;
        potreeContextMenuEl.classList.add('visible');

        requestAnimationFrame(() => {
            const rect = potreeContextMenuEl.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                potreeContextMenuEl.style.left = `${x - rect.width}px`;
            }
            if (rect.bottom > window.innerHeight) {
                potreeContextMenuEl.style.top = `${y - rect.height}px`;
            }
        });
    }

    function hidePotreeContextMenu() {
        if (potreeContextMenuEl) potreeContextMenuEl.classList.remove('visible');
    }

    // ── Info Panel ────────────────────────────────────────
    let potreeInfoPanelEl = null;

    function showPotreeInfoPanel(sel) {
        if (!potreeInfoPanelEl) {
            potreeInfoPanelEl = document.createElement('div');
            potreeInfoPanelEl.className = 'scene-info-panel';
            potreeInfoPanelEl.id = 'potree-info-panel';
            document.body.appendChild(potreeInfoPanelEl);
        }

        const size = sel.bbox.size;
        const centroid = sel.centroid;
        const info = sel.info || {};
        const catIcons = {
            structure: '🏛', vegetation: '🌲', vehicle: '🚗',
            terrain: '⛰', water: '💧', unknown: '❓',
        };

        potreeInfoPanelEl.innerHTML = `
            <div class="sip-header">
                <div class="sip-title">
                    <span class="sip-icon">${catIcons[info.category] || '❓'}</span>
                    <span>${info.label || 'Selected Region'}</span>
                </div>
                <button class="sip-close" onclick="(function(){document.getElementById('potree-info-panel').classList.remove('visible')})()">✕</button>
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
                        <span class="sip-stat-label">Est. Points</span>
                        <span class="sip-stat-value">${(info.pointCount || 0).toLocaleString()}</span>
                    </div>
                </div>
                ${info.heightAboveGround ? `
                <div class="sip-detail">
                    <span class="sip-detail-label">Above Ground</span>
                    <span class="sip-detail-value">${formatDistance(parseFloat(info.heightAboveGround))}</span>
                </div>
                ` : ''}
                <div class="sip-position">
                    <span class="sip-pos-label">Position</span>
                    <span class="sip-pos-value">${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)}, ${centroid.z.toFixed(2)}</span>
                </div>
                ${info.category ? `
                <div class="sip-category">
                    <span class="sip-cat-badge" data-category="${info.category}">${info.category}</span>
                    ${info.confidence ? `<span class="sip-confidence">${Math.round(info.confidence * 100)}%</span>` : ''}
                </div>
                ` : ''}
            </div>
            <div class="sip-actions">
                <button class="sip-btn sip-btn-primary" onclick="window.D3D_PotreeInteract && window.D3D_PotreeInteract.inspectSelection()">
                    🤖 Ask AI
                </button>
                <button class="sip-btn sip-btn-secondary" onclick="window.D3D_PotreeInteract && window.D3D_PotreeInteract.measureFromSelection()">
                    📏 Measure
                </button>
                <button class="sip-btn sip-btn-secondary" onclick="window.D3D_PotreeInteract && window.D3D_PotreeInteract.annotateSelection()">
                    📌 Annotate
                </button>
            </div>
            ${potreeSelections.length === 2 ? `
            <div class="sip-distance-result">
                <span class="sip-distance-icon">↔️</span>
                <span class="sip-distance-label">Distance</span>
                <span class="sip-distance-value">${formatDistance(potreeSelections[0].centroid.distanceTo(potreeSelections[1].centroid))}</span>
            </div>
            ` : ''}
        `;

        potreeInfoPanelEl.classList.add('visible');
    }

    function hidePotreeInfoPanel() {
        if (potreeInfoPanelEl) potreeInfoPanelEl.classList.remove('visible');
    }

    // ── AI Actions ───────────────────────────────────────
    async function inspectPotreeSelection() {
        if (potreeSelections.length === 0) return;

        const sel = potreeSelections[potreeSelections.length - 1];
        const projectId = CONFIG.projectId;
        if (!projectId) return;

        // Get screenshot from Potree's renderer with crosshair marker
        let screenshot = null;
        try {
            if (viewer && viewer.renderer) {
                viewer.renderer.render(viewer.scene.scene, viewer.scene.camera);

                const srcCanvas = viewer.renderer.domElement;
                const w = srcCanvas.width;
                const h = srcCanvas.height;

                // Create compositing canvas for crosshair overlay
                const compCanvas = document.createElement('canvas');
                compCanvas.width = w;
                compCanvas.height = h;
                const ctx = compCanvas.getContext('2d');
                ctx.drawImage(srcCanvas, 0, 0);

                // Project selection centroid to 2D and draw crosshair
                if (sel.centroid) {
                    const projected = sel.centroid.clone().project(viewer.scene.camera);
                    const sx = (projected.x * 0.5 + 0.5) * w;
                    const sy = (-projected.y * 0.5 + 0.5) * h;
                    if (projected.z >= 0 && projected.z <= 1) {
                        drawPotreeCrosshair(ctx, sx, sy, w, h);
                    }
                }

                screenshot = compCanvas.toDataURL('image/jpeg', 0.85).split(',')[1];
            }
        } catch (e) {
            console.warn('Potree screenshot failed:', e);
        }

        const actionsEl = potreeInfoPanelEl?.querySelector('.sip-actions');
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
                    screenshot_b64: screenshot,
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
                    project_name: CONFIG.projectName || '',
                }),
            });
            const data = await resp.json();

            if (potreeInfoPanelEl) {
                const responseEl = document.createElement('div');
                responseEl.className = 'sip-ai-response';
                responseEl.innerHTML = `
                    <div class="sip-ai-header"><span class="sip-ai-badge">AI Analysis</span></div>
                    <div class="sip-ai-text">${escapeHtml(data.answer || data.error || 'No response')}</div>
                `;
                potreeInfoPanelEl.querySelector('.sip-body')?.appendChild(responseEl);
            }

            if (actionsEl) {
                actionsEl.innerHTML = `
                    <button class="sip-btn sip-btn-primary" onclick="window.D3D_PotreeInteract && window.D3D_PotreeInteract.inspectSelection()">🤖 Ask Again</button>
                    <button class="sip-btn sip-btn-secondary" onclick="window.D3D_PotreeInteract && window.D3D_PotreeInteract.measureFromSelection()">📏 Measure</button>
                `;
            }
        } catch (e) {
            if (actionsEl) {
                actionsEl.innerHTML = `<div class="sip-error">AI query failed: ${e.message}</div>`;
            }
        }
    }

    /** Draw a crosshair marker on the screenshot canvas at (x, y) */
    function drawPotreeCrosshair(ctx, x, y, canvasW, canvasH) {
        const r = Math.min(canvasW, canvasH) * 0.04;
        ctx.save();

        // Outer glow ring
        ctx.strokeStyle = 'rgba(0, 230, 138, 0.6)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.5, 0, Math.PI * 2);
        ctx.stroke();

        // Inner ring
        ctx.strokeStyle = '#00e68a';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();

        // Crosshair lines
        ctx.lineWidth = 2;
        const ext = r * 2.5;
        ctx.beginPath();
        ctx.moveTo(x - ext, y); ctx.lineTo(x - r * 0.6, y);
        ctx.moveTo(x + r * 0.6, y); ctx.lineTo(x + ext, y);
        ctx.moveTo(x, y - ext); ctx.lineTo(x, y - r * 0.6);
        ctx.moveTo(x, y + r * 0.6); ctx.lineTo(x, y + ext);
        ctx.stroke();

        // Center dot
        ctx.fillStyle = '#ff3333';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();

        // Label
        const labelX = x + r * 2;
        const labelY = y - r * 2;
        ctx.strokeStyle = '#00e68a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(labelX, labelY + 12);
        ctx.lineTo(x + r * 0.8, y - r * 0.8);
        ctx.stroke();

        const labelText = '← SELECTED OBJECT';
        ctx.font = `bold ${Math.max(14, canvasH * 0.02)}px sans-serif`;
        const tm = ctx.measureText(labelText);
        const pad = 6;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(labelX - pad, labelY - pad, tm.width + pad * 2, Math.max(14, canvasH * 0.02) + pad * 2);
        ctx.fillStyle = '#00e68a';
        ctx.fillText(labelText, labelX, labelY + Math.max(14, canvasH * 0.02) - 2);

        ctx.restore();
    }

    function measureFromSelection() {
        setPotreeMode('measure');
        if (potreeSelections.length > 0) {
            potreeMeasurePoints.push(potreeSelections[potreeSelections.length - 1].centroid.clone());
            // Add marker
            const pos = potreeMeasurePoints[0];
            const markerGeo = new THREE.SphereGeometry(0.15, 16, 16);
            const markerMat = new THREE.MeshBasicMaterial({ color: SELECTION_COLOR, depthTest: false });
            const marker = new THREE.Mesh(markerGeo, markerMat);
            marker.position.copy(pos);
            viewer.scene.scene.add(marker);
            selectionSpheres.push(marker);
        }
        showToast('Click another point to measure distance', 'info');
    }

    function annotatePotreePoint(hit) {
        const pos = hit ? hit.position : (potreeSelections.length > 0 ? potreeSelections[potreeSelections.length - 1].centroid : null);
        if (!pos) return;

        const label = prompt('Annotation label:', 'New Annotation');
        if (!label) return;

        const projectId = CONFIG.projectId;
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
                category: 'poi',
                latitude: pos.y,
                longitude: pos.x,
                altitude: pos.z,
                metadata: { description: 'Created from 3D point cloud viewer', source_mode: 'potree' },
            }),
        }).then(r => r.json()).then(data => {
            if (data.id) {
                showToast('Annotation created', 'success');
                if (window.D3D_Annotations) window.D3D_Annotations.loadAnnotations();
            }
        }).catch(e => {
            showToast('Failed to create annotation', 'error');
        });
    }

    function annotateSelection() {
        if (potreeSelections.length === 0) return;
        annotatePotreePoint({ position: potreeSelections[potreeSelections.length - 1].centroid });
    }

    function askAIPotree() {
        if (potreeSelections.length === 0) return;
        const sel = potreeSelections[potreeSelections.length - 1];

        if (window.D3D_AI) {
            window.D3D_AI.togglePanel();
            const question = `What can you tell me about the ${sel.info?.category || 'region'} at position (${sel.centroid.x.toFixed(1)}, ${sel.centroid.y.toFixed(1)}, ${sel.centroid.z.toFixed(1)})?`;
            window.D3D_AI.query(question);
        }
    }

    // ── Utility ──────────────────────────────────────────
    function formatDistance(d) {
        if (d < 1) return `${(d * 100).toFixed(1)} cm`;
        if (d < 1000) return `${d.toFixed(2)} m`;
        return `${(d / 1000).toFixed(3)} km`;
    }

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

    // ── Public API ───────────────────────────────────────
    window.D3D_PotreeInteract = {
        inspectSelection: inspectPotreeSelection,
        measureFromSelection,
        annotateSelection,
        clearSelections: clearPotreeSelections,
    };

    // ── Layer Toggles ───────────────────────────────────
    window.toggleLayer = function (layer) {
        switch (layer) {
            case 'pointcloud':
                if (pointCloudLayer) {
                    pointCloudLayer.visible = !pointCloudLayer.visible;
                    updateToggleBtn('btn-toggle-pointcloud', pointCloudLayer.visible);
                    const toggle = document.getElementById('toggle-pointcloud');
                    if (toggle) toggle.checked = pointCloudLayer.visible;
                }
                break;
            case 'mesh':
                updateToggleBtn('btn-toggle-mesh', false);
                break;
            case 'orthophoto':
                updateToggleBtn('btn-toggle-ortho', false);
                break;
        }
    };

    function updateToggleBtn(btnId, active) {
        const btn = document.getElementById(btnId);
        if (btn) {
            btn.classList.toggle('active', active);
        }
    }

    // ── Point Cloud Styling ─────────────────────────────
    window.updatePointSize = function (value) {
        if (pointCloudLayer) {
            pointCloudLayer.material.size = parseFloat(value);
        }
        const display = document.getElementById('val-point-size');
        if (display) display.textContent = parseFloat(value).toFixed(1);
    };

    window.updatePointBudget = function (value) {
        if (viewer) {
            viewer.setPointBudget(parseInt(value));
        }
        const display = document.getElementById('val-point-budget');
        if (display) {
            const millions = (parseInt(value) / 1_000_000).toFixed(1);
            display.textContent = millions >= 1 ? `${millions}M` : `${(parseInt(value) / 1000).toFixed(0)}K`;
        }
    };

    window.updateColorMode = function (mode) {
        if (!pointCloudLayer) return;

        switch (mode) {
            case 'rgb':
                pointCloudLayer.material.activeAttributeName = 'rgba';
                break;
            case 'elevation':
                pointCloudLayer.material.activeAttributeName = 'elevation';
                break;
            case 'intensity':
                pointCloudLayer.material.activeAttributeName = 'intensity';
                break;
            case 'classification':
                pointCloudLayer.material.activeAttributeName = 'classification';
                break;
        }
    };

    // ── Measurement Tools (Potree built-in) ──────────────
    window.activateMeasure = function (type) {
        if (!viewer) return;

        document.querySelectorAll('[id^="btn-measure-"]').forEach(btn => {
            btn.classList.remove('active');
        });

        switch (type) {
            case 'distance':
                viewer.measuringTool.startInsertion({
                    showDistances: true,
                    showArea: false,
                    closed: false,
                });
                document.getElementById('btn-measure-distance')?.classList.add('active');
                break;
            case 'area':
                viewer.measuringTool.startInsertion({
                    showDistances: true,
                    showArea: true,
                    closed: true,
                });
                document.getElementById('btn-measure-area')?.classList.add('active');
                break;
        }
    };

    // ── Coordinate Display ──────────────────────────────
    function setupCoordinateDisplay() {
        if (!viewer) return;

        const renderArea = document.getElementById('potree_render_area');
        if (!renderArea) return;

        renderArea.addEventListener('mousemove', (e) => {
            if (!viewer || !pointCloudLayer) return;

            const point = viewer.scene.pointclouds.length > 0
                ? viewer.inputHandler?.getMousePointCloudIntersection(e)
                : null;

            if (point) {
                updateCoordinates(point.x, point.y, point.z);
            }
        });
    }

    function updateCoordinates(x, y, z) {
        const latEl = document.getElementById('coord-lat');
        const lonEl = document.getElementById('coord-lon');
        const elevEl = document.getElementById('coord-elev');

        if (latEl) latEl.textContent = y.toFixed(6);
        if (lonEl) lonEl.textContent = x.toFixed(6);
        if (elevEl) elevEl.textContent = z.toFixed(1) + 'm';
    }

    // ── Panel Toggle ────────────────────────────────────
    window.togglePanel = function () {
        panelOpen = !panelOpen;
        const panel = document.getElementById('viewer-panel');
        const btn = document.getElementById('btn-toggle-panel');

        if (panel) panel.classList.toggle('open', panelOpen);
        if (btn) btn.classList.toggle('active', panelOpen);
    };

    // ── Fullscreen ──────────────────────────────────────
    window.toggleFullscreen = function () {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen().catch(() => {});
        }
    };

    // ── Keyboard shortcuts ──────────────────────────────
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key) {
            case 'p':
                toggleLayer('pointcloud');
                break;
            case 'm':
                toggleLayer('mesh');
                break;
            case 'o':
                toggleLayer('orthophoto');
                break;
            case 's':
                togglePanel();
                break;
            case 'f':
                toggleFullscreen();
                break;
            case 'Escape':
                document.querySelectorAll('[id^="btn-measure-"]').forEach(btn => {
                    btn.classList.remove('active');
                });
                break;
        }
    });

})();

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

                // Cache bounding box Z range for AGL calculations
                if (pointCloudLayer.boundingBox) {
                    pcBoundsMinZ = pointCloudLayer.boundingBox.min.z;
                    pcBoundsMaxZ = pointCloudLayer.boundingBox.max.z;
                }

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

    let potreeInteractMode = 'navigate'; // 'navigate' | 'select' | 'measure' | 'elevation'
    let potreeMeasurePoints = [];
    let potreeSelections = [];
    let elevationProfilePoints = [];    // [{position, ...}] for elevation profile path
    let elevationProfileMarkers = [];   // THREE objects for path visualization
    let elevationLegendEl = null;       // DOM element for the elevation color legend
    let pcBoundsMinZ = 0;               // point cloud bounding box min Z (ground proxy)
    let pcBoundsMaxZ = 0;               // point cloud bounding box max Z

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

        const elevBtn = document.createElement('button');
        elevBtn.className = 'viewer-toolbar-btn';
        elevBtn.id = 'btn-interact-elevation';
        elevBtn.title = 'Elevation Profile [E]';
        elevBtn.innerHTML = '<i data-lucide="ruler-print" style="width:18px;height:18px;margin-right:8px;"></i>';
        elevBtn.onclick = toggleElevationProfile;

        if (insertBefore) {
            toolbar.insertBefore(divider, insertBefore);
            toolbar.insertBefore(selectBtn, insertBefore);
            toolbar.insertBefore(measureBtn, insertBefore);
            toolbar.insertBefore(elevBtn, insertBefore);
            toolbar.insertBefore(clearBtn, insertBefore);
        } else {
            toolbar.appendChild(divider);
            toolbar.appendChild(selectBtn);
            toolbar.appendChild(measureBtn);
            toolbar.appendChild(elevBtn);
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
            if (e.key === 'e') toggleElevationProfile();
            if (e.key === 'Enter' && potreeInteractMode === 'elevation') finishElevationProfile();
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
        document.getElementById('btn-interact-elevation')?.classList.toggle('active', mode === 'elevation');

        const renderArea = document.getElementById('potree_render_area');
        if (renderArea) {
            renderArea.style.cursor = mode === 'navigate' ? '' : 'crosshair';
        }
        if (mode !== 'measure') {
            potreeMeasurePoints = [];
        }
        if (mode !== 'elevation') {
            // Don't clear profile points here — user might be viewing results
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
        } else if (potreeInteractMode === 'elevation') {
            handleElevationProfileClick(hit);
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
                    <span class="ctx-icon"><i data-lucide="search" class="inline-icon" style="width:16px;height:16px;"></i></span>
                    <span>Inspect Region</span>
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
            structure: '<i data-lucide="building" style="width:18px;height:18px;margin-right:8px;"></i>', vegetation: '<i data-lucide="tree-pine" style="width:18px;height:18px;margin-right:8px;"></i>', vehicle: '<i data-lucide="car" style="width:18px;height:18px;margin-right:8px;"></i>',
            terrain: '⛰', water: '<i data-lucide="droplet" style="width:14px;height:14px;margin-right:6px;"></i>', unknown: '❓',
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
                    <i data-lucide="bot" style="width:20px;height:20px;margin-right:8px;"></i> Ask AI
                </button>
                <button class="sip-btn sip-btn-secondary" onclick="window.D3D_PotreeInteract && window.D3D_PotreeInteract.measureFromSelection()">
                    <i data-lucide="ruler" style="width:18px;height:18px;margin-right:8px;"></i> Measure
                </button>
                <button class="sip-btn sip-btn-secondary" onclick="window.D3D_PotreeInteract && window.D3D_PotreeInteract.annotateSelection()">
                    <i data-lucide="map-pin" style="width:18px;height:18px;margin-right:8px;"></i> Annotate
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

        const actionsEl = potreeInfoPanelEl?.querySelector('.sip-actions');
        if (actionsEl) {
            actionsEl.innerHTML = '<div class="sip-loading">Capturing high-res image…</div>';
        }

        // ── 1. Try to get orthophoto crop (much higher quality) ──
        // Potree scene coords == geo coords for ODM, so centroid.x = lon, centroid.y = lat
        let orthoScreenshot = null;
        if (CONFIG.hasOrthophoto) {
            try {
                const cropUrl = `/viewer/${projectId}/orthophoto-crop/?lat=${sel.centroid.y}&lon=${sel.centroid.x}&size=512`;
                const cropResp = await fetch(cropUrl);
                if (cropResp.ok) {
                    const blob = await cropResp.blob();
                    orthoScreenshot = await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result.split(',')[1]);
                        reader.readAsDataURL(blob);
                    });
                }
            } catch (e) {
                console.warn('Orthophoto crop failed, falling back to renderer:', e);
            }
        }

        // ── 2. Fallback: renderer screenshot with crosshair ──
        let rendererScreenshot = null;
        if (!orthoScreenshot) {
            try {
                if (viewer && viewer.renderer) {
                    viewer.renderer.render(viewer.scene.scene, viewer.scene.camera);

                    const srcCanvas = viewer.renderer.domElement;
                    const w = srcCanvas.width;
                    const h = srcCanvas.height;

                    const compCanvas = document.createElement('canvas');
                    compCanvas.width = w;
                    compCanvas.height = h;
                    const ctx = compCanvas.getContext('2d');
                    ctx.drawImage(srcCanvas, 0, 0);

                    // Project centroid and crop around it
                    if (sel.centroid) {
                        const projected = sel.centroid.clone().project(viewer.scene.camera);
                        const sx = (projected.x * 0.5 + 0.5) * w;
                        const sy = (-projected.y * 0.5 + 0.5) * h;

                        if (projected.z >= 0 && projected.z <= 1) {
                            // Crop a 512×512 region around the object
                            const cropSize = Math.min(512, w, h);
                            const cropX = Math.max(0, Math.min(w - cropSize, sx - cropSize / 2));
                            const cropY = Math.max(0, Math.min(h - cropSize, sy - cropSize / 2));

                            const cropCanvas = document.createElement('canvas');
                            cropCanvas.width = cropSize;
                            cropCanvas.height = cropSize;
                            const cropCtx = cropCanvas.getContext('2d');
                            cropCtx.drawImage(compCanvas, cropX, cropY, cropSize, cropSize, 0, 0, cropSize, cropSize);

                            // Draw crosshair at center of crop
                            drawPotreeCrosshair(cropCtx, cropSize / 2, cropSize / 2, cropSize, cropSize);

                            rendererScreenshot = cropCanvas.toDataURL('image/jpeg', 0.90).split(',')[1];
                        }
                    }

                    // If cropping failed, use full scene
                    if (!rendererScreenshot) {
                        if (sel.centroid) {
                            const projected = sel.centroid.clone().project(viewer.scene.camera);
                            const sx = (projected.x * 0.5 + 0.5) * w;
                            const sy = (-projected.y * 0.5 + 0.5) * h;
                            const ctx2 = compCanvas.getContext('2d');
                            drawPotreeCrosshair(ctx2, sx, sy, w, h);
                        }
                        rendererScreenshot = compCanvas.toDataURL('image/jpeg', 0.85).split(',')[1];
                    }
                }
            } catch (e) {
                console.warn('Potree screenshot failed:', e);
            }
        }

        // Use orthophoto crop preferentially — it's much better for object ID
        const screenshotToSend = orthoScreenshot || rendererScreenshot;
        const imageSource = orthoScreenshot ? 'orthophoto_crop' : 'renderer_crop';

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
                    screenshot_b64: screenshotToSend,
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
                    info: { ...sel.info, image_source: imageSource },
                    project_name: CONFIG.projectName || '',
                }),
            });
            const data = await resp.json();

            if (potreeInfoPanelEl) {
                const responseEl = document.createElement('div');
                responseEl.className = 'sip-ai-response';
                responseEl.innerHTML = `
                    <div class="sip-ai-header">
                        <span class="sip-ai-badge">AI Analysis</span>
                        <span class="sip-ai-source" style="font-size:0.65rem;color:var(--text-tertiary);margin-left:8px;">
                            via ${imageSource === 'orthophoto_crop' ? '<i data-lucide="camera" class="inline-icon" style="width:16px;height:16px;"></i> orthophoto' : '<i data-lucide="monitor" style="width:14px;height:14px;margin-right:6px;"></i>️ 3D view'}
                        </span>
                    </div>
                    <div class="sip-ai-text">${escapeHtml(data.answer || data.error || 'No response')}</div>
                `;
                potreeInfoPanelEl.querySelector('.sip-body')?.appendChild(responseEl);
            }

            if (actionsEl) {
                actionsEl.innerHTML = `
                    <button class="sip-btn sip-btn-primary" onclick="window.D3D_PotreeInteract && window.D3D_PotreeInteract.inspectSelection()"><i data-lucide="bot" style="width:20px;height:20px;margin-right:8px;"></i> Ask Again</button>
                    <button class="sip-btn sip-btn-secondary" onclick="window.D3D_PotreeInteract && window.D3D_PotreeInteract.measureFromSelection()"><i data-lucide="ruler" style="width:18px;height:18px;margin-right:8px;"></i> Measure</button>
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

    // ── Elevation Profile Mode ────────────────────────────
    function toggleElevationProfile() {
        if (potreeInteractMode === 'elevation') {
            finishElevationProfile();
        } else {
            setPotreeMode('elevation');
            clearElevationProfilePath();
            showToast('Click points to draw elevation path. Double-click or Enter to finish.', 'info');
        }
    }

    function handleElevationProfileClick(hit) {
        const pos = hit.position.clone();
        elevationProfilePoints.push(pos);

        // Add marker sphere at the point
        const markerGeo = new THREE.SphereGeometry(0.2, 16, 16);
        const markerMat = new THREE.MeshBasicMaterial({
            color: 0x00e68a, transparent: true, opacity: 0.9, depthTest: false,
        });
        const marker = new THREE.Mesh(markerGeo, markerMat);
        marker.position.copy(pos);
        viewer.scene.scene.add(marker);
        elevationProfileMarkers.push(marker);

        // Draw line segment from previous point
        if (elevationProfilePoints.length > 1) {
            const prev = elevationProfilePoints[elevationProfilePoints.length - 2];
            const lineGeo = new THREE.BufferGeometry().setFromPoints([prev, pos]);
            const lineMat = new THREE.LineBasicMaterial({ color: 0x00e68a, linewidth: 2 });
            const line = new THREE.Line(lineGeo, lineMat);
            viewer.scene.scene.add(line);
            elevationProfileMarkers.push(line);
        }
    }

    function finishElevationProfile() {
        if (elevationProfilePoints.length < 2) {
            showToast('Need at least 2 points for an elevation profile', 'warning');
            setPotreeMode('navigate');
            return;
        }

        setPotreeMode('navigate');

        // Build client-side profile from Z-values of picked points
        const clientProfile = buildClientProfile(elevationProfilePoints);

        // If DSM is available, also fetch raster-based profile (more accurate)
        if (CONFIG.hasDsm) {
            fetchRasterProfile(elevationProfilePoints).then(rasterData => {
                if (rasterData && rasterData.profile && rasterData.profile.length > 0) {
                    window.D3D_ElevationProfile?.show(rasterData);
                } else {
                    window.D3D_ElevationProfile?.show(clientProfile);
                }
            }).catch(() => {
                window.D3D_ElevationProfile?.show(clientProfile);
            });
        } else {
            window.D3D_ElevationProfile?.show(clientProfile);
        }
    }

    function buildClientProfile(points) {
        // Simple client-side profile from picked point Z-values
        let cumDist = 0;
        const profile = [];

        for (let i = 0; i < points.length; i++) {
            if (i > 0) {
                cumDist += points[i].distanceTo(points[i - 1]);
            }
            profile.push({
                distance_m: Math.round(cumDist * 100) / 100,
                elevation_m: Math.round(points[i].z * 100) / 100,
                lat: points[i].y,
                lon: points[i].x,
            });
        }

        // Interpolate more points between waypoints for smoother chart
        const interpolated = interpolateProfile(profile, 80);

        const elevs = interpolated.map(p => p.elevation_m).filter(e => e != null);
        const stats = {
            min_m: Math.round(Math.min(...elevs) * 100) / 100,
            max_m: Math.round(Math.max(...elevs) * 100) / 100,
            range_m: Math.round((Math.max(...elevs) - Math.min(...elevs)) * 100) / 100,
            avg_m: Math.round((elevs.reduce((a, b) => a + b, 0) / elevs.length) * 100) / 100,
            total_distance_m: Math.round(cumDist * 100) / 100,
        };

        return { profile: interpolated, stats };
    }

    function interpolateProfile(waypoints, numSamples) {
        if (waypoints.length < 2) return waypoints;

        const totalDist = waypoints[waypoints.length - 1].distance_m;
        if (totalDist <= 0) return waypoints;

        const result = [];
        for (let i = 0; i < numSamples; i++) {
            const targetDist = (i / (numSamples - 1)) * totalDist;

            // Find surrounding waypoints
            let segIdx = 0;
            while (segIdx < waypoints.length - 2 && waypoints[segIdx + 1].distance_m < targetDist) {
                segIdx++;
            }

            const wp1 = waypoints[segIdx];
            const wp2 = waypoints[Math.min(segIdx + 1, waypoints.length - 1)];
            const segLen = wp2.distance_m - wp1.distance_m;
            const t = segLen > 0 ? (targetDist - wp1.distance_m) / segLen : 0;

            result.push({
                distance_m: Math.round(targetDist * 100) / 100,
                elevation_m: Math.round((wp1.elevation_m + t * (wp2.elevation_m - wp1.elevation_m)) * 100) / 100,
                lat: wp1.lat + t * (wp2.lat - wp1.lat),
                lon: wp1.lon + t * (wp2.lon - wp1.lon),
            });
        }
        return result;
    }

    async function fetchRasterProfile(points) {
        // Convert scene coordinates to lat/lon (scene coords = geo coords for ODM)
        const geoPoints = points.map(p => [p.y, p.x]); // [lat, lon]

        const csrfToken = document.cookie.split(';')
            .find(c => c.trim().startsWith('csrftoken='))?.split('=')[1] || '';

        const params = new URLSearchParams({
            points: JSON.stringify(geoPoints),
            samples: '100',
            source: 'dsm',
        });

        const resp = await fetch(`/viewer/${CONFIG.projectId}/elevation/profile/?${params}`);
        if (resp.ok) {
            return await resp.json();
        }
        return null;
    }

    function clearElevationProfilePath() {
        elevationProfileMarkers.forEach(obj => {
            if (viewer.scene.scene) {
                viewer.scene.scene.remove(obj);
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) obj.material.dispose();
            }
        });
        elevationProfileMarkers = [];
        elevationProfilePoints = [];
    }

    // ── Elevation Color Legend ────────────────────────────
    function showElevationLegend(minVal, maxVal, label) {
        if (!elevationLegendEl) {
            elevationLegendEl = document.createElement('div');
            elevationLegendEl.id = 'elevation-legend';
            elevationLegendEl.className = 'elevation-legend';
            document.body.appendChild(elevationLegendEl);

            // Inject styles if not present
            if (!document.getElementById('elev-legend-styles')) {
                const style = document.createElement('style');
                style.id = 'elev-legend-styles';
                style.textContent = `
                    .elevation-legend {
                        position: fixed;
                        bottom: 60px;
                        right: 16px;
                        width: 28px;
                        padding: 8px 8px 8px 10px;
                        background: rgba(10, 14, 26, 0.75);
                        border: 1px solid rgba(255,255,255,0.08);
                        border-radius: 8px;
                        backdrop-filter: blur(12px);
                        -webkit-backdrop-filter: blur(12px);
                        z-index: 500;
                        opacity: 0;
                        transition: opacity 0.3s ease;
                        pointer-events: none;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                    }
                    .elevation-legend.visible {
                        opacity: 1;
                        pointer-events: auto;
                    }
                    .elev-legend-label {
                        font-size: 8px;
                        color: rgba(255,255,255,0.5);
                        text-transform: uppercase;
                        letter-spacing: 0.06em;
                        margin-bottom: 4px;
                        writing-mode: vertical-rl;
                        text-orientation: mixed;
                        transform: rotate(180deg);
                    }
                    .elev-legend-max, .elev-legend-min {
                        font-size: 9px;
                        font-weight: 600;
                        color: rgba(255,255,255,0.7);
                        font-family: 'JetBrains Mono', monospace;
                    }
                    .elev-legend-bar {
                        width: 14px;
                        height: 120px;
                        border-radius: 3px;
                        margin: 4px 0;
                        border: 1px solid rgba(255,255,255,0.1);
                    }
                `;
                document.head.appendChild(style);
            }
        }

        const maxLabel = maxVal != null ? maxVal.toFixed(1) + 'm' : '—';
        const minLabel = minVal != null ? minVal.toFixed(1) + 'm' : '—';

        elevationLegendEl.innerHTML = `
            <span class="elev-legend-max">${maxLabel}</span>
            <div class="elev-legend-bar" style="background: linear-gradient(to bottom, #ff4444, #ffaa00, #ffff00, #44ff44, #00ddff, #4444ff);"></div>
            <span class="elev-legend-min">${minLabel}</span>
        `;

        elevationLegendEl.classList.add('visible');
    }

    function hideElevationLegend() {
        if (elevationLegendEl) elevationLegendEl.classList.remove('visible');
    }

    // ── Public API ───────────────────────────────────────
    window.D3D_PotreeInteract = {
        inspectSelection: inspectPotreeSelection,
        measureFromSelection,
        annotateSelection,
        clearSelections: clearPotreeSelections,
    };

    // ── Layer Toggles ───────────────────────────────────
    let meshLayer = null;     // THREE.Object3D — OBJ mesh loaded into Potree scene
    let meshLoading = false;
    let orthoLayer = null;    // THREE.Mesh — textured ground plane for orthophoto
    let orthoLoading = false;

    window.toggleLayer = function (layer) {
        switch (layer) {
            case 'pointcloud':
                if (pointCloudLayer) {
                    pointCloudLayer.visible = !pointCloudLayer.visible;
                    updateToggleBtn('btn-toggle-pointcloud', pointCloudLayer.visible);
                    syncPanelCheckbox('toggle-pointcloud', pointCloudLayer.visible);
                    showToast(pointCloudLayer.visible ? 'Point cloud visible' : 'Point cloud hidden', 'info');
                } else {
                    showToast('Point cloud not loaded yet', 'warning');
                    syncPanelCheckbox('toggle-pointcloud', false);
                }
                break;
            case 'mesh':
                if (meshLayer) {
                    meshLayer.visible = !meshLayer.visible;
                    updateToggleBtn('btn-toggle-mesh', meshLayer.visible);
                    syncPanelCheckbox('toggle-mesh', meshLayer.visible);
                    showToast(meshLayer.visible ? 'Mesh visible' : 'Mesh hidden', 'info');
                } else if (!meshLoading && CONFIG.meshDataUrl) {
                    loadMeshLayer();
                } else if (meshLoading) {
                    showToast('Mesh is still loading...', 'info');
                } else {
                    showToast('No mesh data available for this project', 'warning');
                    syncPanelCheckbox('toggle-mesh', false);
                }
                break;
            case 'orthophoto':
                if (orthoLayer) {
                    orthoLayer.visible = !orthoLayer.visible;
                    updateToggleBtn('btn-toggle-ortho', orthoLayer.visible);
                    syncPanelCheckbox('toggle-orthophoto', orthoLayer.visible);
                    showToast(orthoLayer.visible ? 'Orthophoto visible' : 'Orthophoto hidden', 'info');
                } else if (!orthoLoading && CONFIG.hasOrthophoto) {
                    loadOrthophotoLayer();
                } else if (orthoLoading) {
                    showToast('Orthophoto is still loading...', 'info');
                } else {
                    showToast('No orthophoto available for this project', 'warning');
                    syncPanelCheckbox('toggle-orthophoto', false);
                }
                break;
        }
    };

    function updateToggleBtn(btnId, active) {
        const btn = document.getElementById(btnId);
        if (btn) {
            btn.classList.toggle('active', active);
        }
    }

    function syncPanelCheckbox(checkboxId, checked) {
        const toggle = document.getElementById(checkboxId);
        if (toggle) toggle.checked = checked;
    }

    // ── Load OBJ Mesh into Potree Scene ──────────────────
    function loadMeshLayer() {
        if (!CONFIG.meshDataUrl || !viewer) {
            showToast('No mesh data available', 'warning');
            syncPanelCheckbox('toggle-mesh', false);
            return;
        }
        meshLoading = true;
        showToast('Loading 3D mesh…', 'info');

        const baseUrl = CONFIG.meshDataUrl;
        const objFilename = CONFIG.meshFilename || 'odm_textured_model_geo.obj';
        const mtlFilename = objFilename.replace('.obj', '.mtl');

        _ensureOBJLoader().then(() => {
            if (typeof THREE.MTLLoader === 'undefined' || typeof THREE.OBJLoader === 'undefined') {
                throw new Error('Three.js OBJ/MTL loaders could not be loaded');
            }
            const mtlLoader = new THREE.MTLLoader();
            mtlLoader.setPath(baseUrl);

            mtlLoader.load(
                mtlFilename,
                (materials) => {
                    materials.preload();
                    _loadOBJIntoScene(baseUrl, objFilename, materials);
                },
                undefined,
                () => {
                    console.warn('MTL not found, loading OBJ without textures');
                    _loadOBJIntoScene(baseUrl, objFilename, null);
                }
            );
        }).catch(err => {
            console.error('Failed to load OBJ/MTL loaders:', err);
            meshLoading = false;
            syncPanelCheckbox('toggle-mesh', false);
            showToast('Mesh loading failed — try the dedicated Mesh Viewer mode instead', 'error');
        });
    }

    function _loadOBJIntoScene(baseUrl, filename, materials) {
        const objLoader = new THREE.OBJLoader();
        if (materials) objLoader.setMaterials(materials);
        objLoader.setPath(baseUrl);

        objLoader.load(
            filename,
            (object) => {
                if (!materials) {
                    object.traverse((child) => {
                        if (child.isMesh) {
                            child.material = new THREE.MeshStandardMaterial({
                                color: 0x8899aa, roughness: 0.7, metalness: 0.1,
                            });
                        }
                    });
                }
                meshLayer = object;
                viewer.scene.scene.add(meshLayer);
                meshLoading = false;
                updateToggleBtn('btn-toggle-mesh', true);
                syncPanelCheckbox('toggle-mesh', true);
                showToast('3D mesh loaded', 'success');
                console.log('Mesh layer loaded into Potree scene');
            },
            (progress) => {
                if (progress.total > 0) {
                    const pct = (progress.loaded / progress.total * 100).toFixed(0);
                    showToast(`Loading mesh… ${pct}%`, 'info');
                }
            },
            (err) => {
                console.error('Error loading OBJ mesh:', err);
                meshLoading = false;
                syncPanelCheckbox('toggle-mesh', false);
                showToast('Failed to load mesh — try Mesh Viewer mode', 'error');
            }
        );
    }

    async function _ensureOBJLoader() {
        if (typeof THREE.OBJLoader !== 'undefined' && typeof THREE.MTLLoader !== 'undefined') {
            return;
        }

        // Try multiple CDN versions for compatibility with Potree's bundled Three.js
        const versions = ['0.148.0', '0.147.0', '0.149.0'];
        for (const ver of versions) {
            try {
                const promises = [];
                if (typeof THREE.MTLLoader === 'undefined') {
                    promises.push(_loadScript(`https://cdn.jsdelivr.net/npm/three@${ver}/examples/js/loaders/MTLLoader.js`));
                }
                if (typeof THREE.OBJLoader === 'undefined') {
                    promises.push(_loadScript(`https://cdn.jsdelivr.net/npm/three@${ver}/examples/js/loaders/OBJLoader.js`));
                }
                await Promise.all(promises);
                if (typeof THREE.OBJLoader !== 'undefined') {
                    console.log(`Loaded Three.js loaders from v${ver}`);
                    return;
                }
            } catch (e) {
                console.warn(`Failed to load loaders from Three.js v${ver}:`, e);
            }
        }
        throw new Error('Could not load OBJ/MTL loaders from any CDN version');
    }

    function _loadScript(url) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load: ${url}`));
            document.head.appendChild(script);
        });
    }

    // ── Load Orthophoto Overlay ──────────────────────────
    function loadOrthophotoLayer() {
        if (!CONFIG.hasOrthophoto || !viewer || !CONFIG.projectId) return;
        orthoLoading = true;
        showToast('Loading orthophoto overlay…', 'info');

        if (pointCloudLayer && pointCloudLayer.boundingBox) {
            const bbox = pointCloudLayer.boundingBox;
            const center = new THREE.Vector3();
            bbox.getCenter(center);
            const size = new THREE.Vector3();
            bbox.getSize(size);

            // Use the actual orthophoto center from GeoTIFF metadata (computed server-side)
            // Fall back to point cloud center (which are geo-coords in Potree/ODM scenes)
            const orthoLat = CONFIG.orthoCenterLat || center.y;
            const orthoLon = CONFIG.orthoCenterLon || center.x;
            const cropUrl = `/viewer/${CONFIG.projectId}/orthophoto-crop/?lat=${orthoLat}&lon=${orthoLon}&size=2048`;

            const textureLoader = new THREE.TextureLoader();
            textureLoader.load(
                cropUrl,
                (texture) => {
                    texture.minFilter = THREE.LinearFilter;
                    texture.magFilter = THREE.LinearFilter;

                    const planeGeo = new THREE.PlaneGeometry(size.x, size.y);
                    const planeMat = new THREE.MeshBasicMaterial({
                        map: texture,
                        transparent: true,
                        opacity: 0.85,
                        side: THREE.DoubleSide,
                        depthWrite: false,
                    });
                    orthoLayer = new THREE.Mesh(planeGeo, planeMat);

                    // Position at ground level, centered on point cloud
                    orthoLayer.position.set(center.x, center.y, bbox.min.z + 0.1);
                    // PlaneGeometry faces +Z by default — that's correct for our Z-up scene

                    viewer.scene.scene.add(orthoLayer);
                    orthoLoading = false;
                    updateToggleBtn('btn-toggle-ortho', true);
                    syncPanelCheckbox('toggle-orthophoto', true);
                    showToast('Orthophoto overlay loaded', 'success');
                },
                undefined,
                (err) => {
                    console.warn('Failed to load orthophoto texture:', err);
                    orthoLoading = false;
                    showToast('Failed to load orthophoto overlay', 'error');
                }
            );
        } else {
            orthoLoading = false;
            showToast('Point cloud bounds not available for orthophoto placement', 'warning');
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
                hideElevationLegend();
                break;
            case 'elevation':
                pointCloudLayer.material.activeAttributeName = 'elevation';
                // Show legend with absolute Z range
                showElevationLegend(pcBoundsMinZ, pcBoundsMaxZ);
                break;
            case 'height_above_ground':
                // Use Potree's elevation coloring but shift origin to ground level
                pointCloudLayer.material.activeAttributeName = 'elevation';
                if (pointCloudLayer.material.elevationRange) {
                    pointCloudLayer.material.elevationRange = new Potree.PointCloudMaterial.ElevationRange(
                        pcBoundsMinZ, pcBoundsMaxZ
                    );
                }
                // Use heightRange to map ground=0 to top
                try {
                    pointCloudLayer.material.heightMin = pcBoundsMinZ;
                    pointCloudLayer.material.heightMax = pcBoundsMaxZ;
                } catch (e) { /* older Potree version */ }
                showElevationLegend(0, Math.round((pcBoundsMaxZ - pcBoundsMinZ) * 10) / 10);
                break;
            case 'intensity':
                pointCloudLayer.material.activeAttributeName = 'intensity';
                hideElevationLegend();
                break;
            case 'classification':
                pointCloudLayer.material.activeAttributeName = 'classification';
                hideElevationLegend();
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
        const aglEl = document.getElementById('coord-agl');

        if (latEl) latEl.textContent = y.toFixed(6);
        if (lonEl) lonEl.textContent = x.toFixed(6);
        if (elevEl) elevEl.textContent = z.toFixed(1) + 'm';

        // AGL = height above the lowest point in the point cloud (ground proxy)
        if (aglEl) {
            const agl = z - pcBoundsMinZ;
            aglEl.textContent = agl.toFixed(1) + 'm';
        }
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

    // ── Topology View ──────────────────────────────────
    let topologyActive = false;
    let heightTooltipEl = null;
    let previousColorMode = 'rgb';

    window.toggleTopologyView = function () {
        topologyActive = !topologyActive;
        const btn = document.getElementById('btn-topology');
        if (btn) btn.classList.toggle('active', topologyActive);

        if (topologyActive) {
            // Save current color mode
            const selectEl = document.getElementById('select-color-mode');
            if (selectEl) {
                previousColorMode = selectEl.value;
                selectEl.value = 'elevation';
            }
            // Switch to elevation coloring
            window.updateColorMode('elevation');

            // Show floating height tooltip
            showHeightTooltip();
            showToast('Topology view active — hover to see height', 'info');
        } else {
            // Restore previous color mode
            const selectEl = document.getElementById('select-color-mode');
            if (selectEl) selectEl.value = previousColorMode;
            window.updateColorMode(previousColorMode);
            hideHeightTooltip();
        }
    };

    function showHeightTooltip() {
        if (heightTooltipEl) return;

        heightTooltipEl = document.createElement('div');
        heightTooltipEl.id = 'height-tooltip';
        heightTooltipEl.style.cssText = `
            position: fixed;
            display: none;
            pointer-events: none;
            z-index: 600;
            padding: 8px 14px;
            background: rgba(10, 14, 26, 0.85);
            border: 1px solid rgba(0, 230, 138, 0.3);
            border-radius: 8px;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 15px rgba(0,230,138,0.1);
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.78rem;
            color: #e2e8f0;
            min-width: 120px;
        `;
        document.body.appendChild(heightTooltipEl);

        const renderArea = document.getElementById('potree_render_area');
        if (renderArea) {
            renderArea.addEventListener('mousemove', onTopologyHover);
        }
    }

    function hideHeightTooltip() {
        const renderArea = document.getElementById('potree_render_area');
        if (renderArea) {
            renderArea.removeEventListener('mousemove', onTopologyHover);
        }
        if (heightTooltipEl) {
            heightTooltipEl.remove();
            heightTooltipEl = null;
        }
    }

    let _topoThrottle = 0;
    function onTopologyHover(e) {
        if (!topologyActive || !heightTooltipEl) return;

        const now = performance.now();
        if (now - _topoThrottle < 30) return; // ~33fps
        _topoThrottle = now;

        if (!viewer || !pointCloudLayer) {
            heightTooltipEl.style.display = 'none';
            return;
        }

        let point = null;
        try {
            point = viewer.inputHandler?.getMousePointCloudIntersection(e);
        } catch (_) {}

        if (!point) {
            heightTooltipEl.style.display = 'none';
            return;
        }

        const elevation = point.z;
        const agl = elevation - pcBoundsMinZ;
        const sceneHeight = pcBoundsMaxZ - pcBoundsMinZ;
        const heightPct = sceneHeight > 0 ? (agl / sceneHeight * 100).toFixed(0) : 0;

        // Color based on height
        const hue = Math.max(0, Math.min(240, (1 - agl / sceneHeight) * 240));
        const barColor = `hsl(${hue}, 80%, 55%)`;

        heightTooltipEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                <div style="width:4px;height:36px;border-radius:2px;background:linear-gradient(to top, #4444ff, #00ddff, #44ff44, #ffff00, #ffaa00, #ff4444);position:relative;">
                    <div style="position:absolute;left:-2px;width:8px;height:3px;border-radius:1px;background:${barColor};bottom:${heightPct}%;transform:translateY(50%);box-shadow:0 0 4px ${barColor};"></div>
                </div>
                <div>
                    <div style="color:rgba(255,255,255,0.5);font-size:0.6rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;">Height</div>
                    <div style="font-size:1rem;font-weight:700;color:#00e68a;">${agl.toFixed(1)}m <span style="font-size:0.7rem;color:rgba(255,255,255,0.4);">AGL</span></div>
                    <div style="font-size:0.7rem;color:rgba(255,255,255,0.5);margin-top:1px;">⬆ ${elevation.toFixed(1)}m elev</div>
                </div>
            </div>
        `;

        heightTooltipEl.style.display = 'block';
        heightTooltipEl.style.left = `${e.clientX + 20}px`;
        heightTooltipEl.style.top = `${e.clientY - 20}px`;

        // Keep on screen
        requestAnimationFrame(() => {
            if (!heightTooltipEl) return;
            const rect = heightTooltipEl.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                heightTooltipEl.style.left = `${e.clientX - rect.width - 10}px`;
            }
            if (rect.bottom > window.innerHeight) {
                heightTooltipEl.style.top = `${e.clientY - rect.height - 10}px`;
            }
        });
    }

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
            case 't':
                toggleTopologyView();
                break;
            case 'Escape':
                document.querySelectorAll('[id^="btn-measure-"]').forEach(btn => {
                    btn.classList.remove('active');
                });
                if (topologyActive) {
                    toggleTopologyView();
                }
                if (window.D3D_ElevationProfile?.isVisible()) {
                    window.D3D_ElevationProfile.hide();
                    clearElevationProfilePath();
                }
                break;
        }
    });

})();


/**
 * Drone3D — Three.js Mesh Viewer with Interactive Selection
 *
 * Loads OBJ + MTL textured meshes from ODM output, renders with orbit
 * controls and lighting, and provides an adapter for scene-interact.js
 * enabling click-to-select via raycasting + flood-fill segmentation.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

(function () {
    'use strict';

    const CONFIG = window.VIEWER_CONFIG || {};
    let scene, camera, renderer, controls;
    let meshObject = null;
    let panelOpen = false;

    // ── Selection / Interaction State ─────────────────────
    let raycaster = new THREE.Raycaster();
    let mouse = new THREE.Vector2();
    let adjacencyMap = null;       // Map<faceIdx, Set<faceIdx>>
    let adjacencyBuilt = false;
    let allMeshChildren = [];      // reference to meshes inside loaded OBJ
    let highlightGroup = null;     // THREE.Group holding highlight overlays
    let selectionIdCounter = 0;
    let _interactModule = null;    // scene-interact module ref (for pointInPolygon)

    // Segmentation params (tunable) — multi-criteria scoring
    const SEG_CONFIG = {
        // Scoring weights (must sum to 1.0 when all criteria active)
        normalWeight:   0.30,    // face normal angle similarity
        colorWeight:    0.30,    // vertex color similarity (0 if no vertex colors)
        proximityWeight: 0.20,   // distance from click origin
        heightWeight:    0.20,   // height‐continuity relative to ground

        // Thresholds
        scoreThreshold: 0.55,    // max weighted score to join region (lower = stricter)
        normalAngleMax: 75,      // degrees — relaxed since it's only one criterion now
        maxFloodFaces: 25000,    // raised for larger objects
        minFloodFaces: 4,        // minimum faces for a valid selection
        distanceThreshold: 0.0,  // auto-calculated from mesh scale on load
        maxAspectRatio: 10,      // stop if bbox gets too elongated (prevents terrain runaway)
        adaptiveGrowFactor: 2.0, // stop when no new faces within N× current region radius
    };

    // State derived after mesh load
    let _meshGroundY = 0;       // estimated ground level
    let _meshMaxDim = 1;        // max extent of the whole model
    let _hasVertexColors = false; // whether the mesh has color attributes

    // CSS2D label renderer
    let labelRenderer = null;

    document.addEventListener('DOMContentLoaded', () => {
        if (!CONFIG.meshDataUrl) {
            console.warn('No mesh data URL available');
            showStatus('No 3D data available', true);
            return;
        }
        initScene();
        loadMesh();
    });

    // ── Scene Setup ────────────────────────────────────
    function initScene() {
        const container = document.getElementById('threejs-render-area');
        if (!container) return;

        // Renderer
        renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
            preserveDrawingBuffer: true,  // needed for screenshots
        });
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        container.appendChild(renderer.domElement);

        // CSS2D Label Renderer
        labelRenderer = new CSS2DRenderer();
        labelRenderer.setSize(container.clientWidth, container.clientHeight);
        labelRenderer.domElement.style.position = 'absolute';
        labelRenderer.domElement.style.top = '0';
        labelRenderer.domElement.style.left = '0';
        labelRenderer.domElement.style.pointerEvents = 'none';
        labelRenderer.domElement.style.zIndex = '10';
        container.appendChild(labelRenderer.domElement);

        // Scene
        scene = new THREE.Scene();

        // Highlight group for selections
        highlightGroup = new THREE.Group();
        highlightGroup.name = 'selection-highlights';
        scene.add(highlightGroup);

        // Gradient background
        const bgCanvas = document.createElement('canvas');
        bgCanvas.width = 2;
        bgCanvas.height = 512;
        const ctx = bgCanvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 512);
        gradient.addColorStop(0, '#0a0e1a');
        gradient.addColorStop(0.5, '#111827');
        gradient.addColorStop(1, '#1a1f2e');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 2, 512);
        const bgTexture = new THREE.CanvasTexture(bgCanvas);
        scene.background = bgTexture;

        // Camera
        camera = new THREE.PerspectiveCamera(
            60,
            container.clientWidth / container.clientHeight,
            0.1,
            10000
        );
        camera.position.set(0, 50, 100);

        // Controls
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.rotateSpeed = 0.8;
        controls.zoomSpeed = 1.2;
        controls.panSpeed = 0.8;
        controls.minDistance = 1;
        controls.maxDistance = 5000;

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
        dirLight.position.set(50, 100, 50);
        dirLight.castShadow = true;
        scene.add(dirLight);

        const dirLight2 = new THREE.DirectionalLight(0xaaccff, 0.4);
        dirLight2.position.set(-50, 50, -50);
        scene.add(dirLight2);

        const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x362907, 0.3);
        scene.add(hemiLight);

        // Grid helper
        const grid = new THREE.GridHelper(200, 40, 0x1a3a4a, 0x0d1f2d);
        grid.material.opacity = 0.3;
        grid.material.transparent = true;
        scene.add(grid);

        // Handle resize
        window.addEventListener('resize', onResize);

        // Start render loop
        animate();
    }

    function animate() {
        requestAnimationFrame(animate);
        if (controls) controls.update();
        if (renderer && scene && camera) {
            renderer.render(scene, camera);
        }
        if (labelRenderer && scene && camera) {
            labelRenderer.render(scene, camera);
        }
        // Also render interaction labels if available
        if (window.D3D_Interact && window.D3D_Interact.renderLabels) {
            window.D3D_Interact.renderLabels();
        }
    }

    function onResize() {
        const container = document.getElementById('threejs-render-area');
        if (!container || !camera || !renderer) return;
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight);
        if (labelRenderer) {
            labelRenderer.setSize(container.clientWidth, container.clientHeight);
        }
    }

    // ── Mesh Loading ───────────────────────────────────
    function loadMesh() {
        showStatus('Loading 3D model…');

        const baseUrl = CONFIG.meshDataUrl;
        const objFilename = CONFIG.meshFilename || 'odm_textured_model_geo.obj';
        const mtlFilename = objFilename.replace('.obj', '.mtl');

        const mtlLoader = new MTLLoader();
        mtlLoader.setPath(baseUrl);

        mtlLoader.load(
            mtlFilename,
            (materials) => {
                materials.preload();
                loadOBJ(baseUrl, objFilename, materials);
            },
            undefined,
            () => {
                console.warn('MTL not found, loading OBJ without textures');
                loadOBJ(baseUrl, objFilename, null);
            }
        );
    }

    function loadOBJ(baseUrl, filename, materials) {
        const objLoader = new OBJLoader();
        if (materials) {
            objLoader.setMaterials(materials);
        }

        objLoader.setPath(baseUrl);

        objLoader.load(
            filename,
            (object) => {
                // Apply default material if no textures
                if (!materials) {
                    object.traverse((child) => {
                        if (child.isMesh) {
                            child.material = new THREE.MeshStandardMaterial({
                                color: 0x8899aa,
                                roughness: 0.7,
                                metalness: 0.1,
                                flatShading: false,
                            });
                        }
                    });
                }

                // Correct orientation from Z-up (photogrammetry) to Y-up (Three.js)
                const rotMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
                object.traverse((child) => {
                    if (child.isMesh && child.geometry) {
                        child.geometry.applyMatrix4(rotMatrix);
                    }
                });
                object.rotation.set(0, 0, 0);
                object.updateMatrixWorld(true);

                // Center the model at the origin
                const box = new THREE.Box3().setFromObject(object);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);

                object.position.set(-center.x, -center.y, -center.z);
                meshObject = object;
                scene.add(meshObject);

                // Store mesh dimensions for segmentation
                _meshMaxDim = maxDim;
                _meshGroundY = -size.y / 2; // ground is at the bottom of the bounding box

                // Detect vertex colors
                _hasVertexColors = false;
                meshObject.traverse((child) => {
                    if (child.isMesh && child.geometry?.attributes?.color) {
                        _hasVertexColors = true;
                    }
                });
                if (_hasVertexColors) {
                    console.log('Mesh has vertex colors — color criterion enabled');
                } else {
                    console.log('No vertex colors detected — color criterion disabled, weights redistributed');
                }

                // Collect mesh children for raycasting
                allMeshChildren = [];
                meshObject.traverse((child) => {
                    if (child.isMesh) {
                        allMeshChildren.push(child);
                    }
                });

                // Auto-calculate distance threshold based on mesh scale
                SEG_CONFIG.distanceThreshold = maxDim * 0.08;

                // Position camera to see the whole model
                const fitDistance = maxDim * 1.5;
                camera.position.set(
                    fitDistance * 0.7,
                    fitDistance * 0.5,
                    fitDistance * 0.7
                );
                camera.lookAt(0, 0, 0);
                controls.target.set(0, 0, 0);
                controls.update();

                // Adjust grid
                const gridScale = Math.ceil(maxDim / 50) * 50;
                scene.children.forEach(c => {
                    if (c instanceof THREE.GridHelper) {
                        c.scale.set(gridScale / 200, 1, gridScale / 200);
                        c.position.y = -size.y / 2;
                    }
                });

                // Update near/far planes
                camera.near = maxDim * 0.001;
                camera.far = maxDim * 20;
                camera.updateProjectionMatrix();
                controls.minDistance = maxDim * 0.05;
                controls.maxDistance = maxDim * 10;

                hideStatus();

                // Count triangles
                let triangles = 0;
                object.traverse((child) => {
                    if (child.isMesh && child.geometry) {
                        const geo = child.geometry;
                        triangles += geo.index
                            ? geo.index.count / 3
                            : geo.attributes.position.count / 3;
                    }
                });
                const infoEl = document.getElementById('mesh-info');
                if (infoEl) {
                    const triStr = triangles > 1000000
                        ? (triangles / 1000000).toFixed(1) + 'M'
                        : triangles > 1000
                        ? (triangles / 1000).toFixed(0) + 'K'
                        : triangles.toString();
                    infoEl.textContent = `${triStr} triangles`;
                    infoEl.style.display = 'block';
                }

                console.log(`Mesh loaded: ${triangles} triangles, bounding box: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)}`);

                // Build adjacency in background for flood-fill selection
                buildAdjacencyAsync();

                // Initialize scene interaction system
                initInteraction();
            },
            (xhr) => {
                if (xhr.lengthComputable) {
                    const pct = (xhr.loaded / xhr.total * 100).toFixed(0);
                    showStatus(`Loading 3D model… ${pct}%`);
                }
            },
            (error) => {
                console.error('Error loading mesh:', error);
                showStatus('Failed to load 3D model. The mesh file may be too large or in an unsupported format.', true);
            }
        );
    }

    // ── Initialize Scene Interaction ──────────────────
    function initInteraction() {
        // Dynamically import and init scene-interact
        import('/static/js/scene-interact.js').then((module) => {
            const container = document.getElementById('threejs-render-area');
            // Store module reference for pointInPolygon access
            _interactModule = module;

            module.init({
                scene,
                camera,
                renderer,
                container,
                adapterName: 'mesh',
            });

            // Register mesh adapter
            module.registerAdapter('mesh', {
                pick: meshPick,
                selectRegion: meshSelectRegion,
                selectByLasso: meshSelectByLasso,
                clearSelection: meshClearSelection,
                getScreenshot: meshGetScreenshot,
                getMultiViewScreenshots: meshGetMultiViewScreenshots,
                controls: controls,   // expose OrbitControls for lasso toggling
                onModeChange: (mode) => {},
            });

            console.log('Scene interaction system initialized (mesh adapter)');
        }).catch(err => {
            console.warn('Scene interaction module not available:', err);
        });
    }

    // ── Adjacency Graph for Flood-Fill ───────────────
    function buildAdjacencyAsync() {
        // Build on next idle to not block rendering
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => buildAdjacency(), { timeout: 5000 });
        } else {
            setTimeout(() => buildAdjacency(), 1000);
        }
    }

    function buildAdjacency() {
        if (adjacencyBuilt) return;
        console.time('buildAdjacency');

        adjacencyMap = new Map();

        allMeshChildren.forEach((mesh) => {
            const geo = mesh.geometry;
            if (!geo) return;

            const positions = geo.attributes.position;
            if (!positions) return;

            const index = geo.index;
            let faceCount;

            // ── Helper: get vertex index for a face corner ──
            // For indexed geometry, use the index buffer.
            // For non-indexed geometry, each 3 consecutive verts = 1 face.
            function getVertIdx(faceIndex, corner) {
                if (index) {
                    return index.getX(faceIndex * 3 + corner);
                }
                return faceIndex * 3 + corner;
            }

            if (index) {
                faceCount = index.count / 3;
            } else {
                faceCount = positions.count / 3;
            }

            if (faceCount === 0) return;

            // For non-indexed geometry, build a position hash to match
            // shared vertices by position (they have different indices but same coordinates)
            let posHashToVertices = null;
            if (!index) {
                posHashToVertices = new Map(); // hash -> [vertexIndex, ...]
                for (let vi = 0; vi < positions.count; vi++) {
                    const hash = positionHash(
                        positions.getX(vi),
                        positions.getY(vi),
                        positions.getZ(vi)
                    );
                    if (!posHashToVertices.has(hash)) posHashToVertices.set(hash, []);
                    posHashToVertices.get(hash).push(vi);
                }
            }

            // Build edge → face map
            const edgeToFaces = new Map();

            for (let fi = 0; fi < faceCount; fi++) {
                const a = getVertIdx(fi, 0);
                const b = getVertIdx(fi, 1);
                const c = getVertIdx(fi, 2);

                let edgeKeys;
                if (index) {
                    // Indexed: vertex indices are shared, use directly
                    edgeKeys = [
                        edgeKey(a, b),
                        edgeKey(b, c),
                        edgeKey(c, a),
                    ];
                } else {
                    // Non-indexed: use position hash as "canonical" vertex ID
                    const ha = positionHash(positions.getX(a), positions.getY(a), positions.getZ(a));
                    const hb = positionHash(positions.getX(b), positions.getY(b), positions.getZ(b));
                    const hc = positionHash(positions.getX(c), positions.getY(c), positions.getZ(c));
                    edgeKeys = [
                        ha < hb ? `${ha}|${hb}` : `${hb}|${ha}`,
                        hb < hc ? `${hb}|${hc}` : `${hc}|${hb}`,
                        hc < ha ? `${hc}|${ha}` : `${ha}|${hc}`,
                    ];
                }

                edgeKeys.forEach(ek => {
                    if (!edgeToFaces.has(ek)) edgeToFaces.set(ek, []);
                    edgeToFaces.get(ek).push(fi);
                });
            }

            // Build face adjacency from shared edges
            for (const [_, faces] of edgeToFaces) {
                for (let i = 0; i < faces.length; i++) {
                    for (let j = i + 1; j < faces.length; j++) {
                        if (!adjacencyMap.has(faces[i])) adjacencyMap.set(faces[i], new Set());
                        if (!adjacencyMap.has(faces[j])) adjacencyMap.set(faces[j], new Set());
                        adjacencyMap.get(faces[i]).add(faces[j]);
                        adjacencyMap.get(faces[j]).add(faces[i]);
                    }
                }
            }
        });

        adjacencyBuilt = true;
        console.timeEnd('buildAdjacency');
        console.log(`Adjacency map built: ${adjacencyMap.size} faces`);
    }

    function edgeKey(a, b) {
        return a < b ? `${a}-${b}` : `${b}-${a}`;
    }

    /** Hash a 3D position to a string for vertex deduplication. */
    function positionHash(x, y, z) {
        // Round to 5 decimal places to handle floating-point noise
        return `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    }

    // ── Mesh Adapter: Pick ───────────────────────────
    function meshPick(event) {
        const container = document.getElementById('threejs-render-area');
        if (!container || !camera) return null;

        const rect = container.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(allMeshChildren, false);

        if (intersects.length === 0) return null;

        const hit = intersects[0];
        return {
            position: hit.point.clone(),
            faceIndex: hit.faceIndex,
            object: hit.object,
            normal: hit.face?.normal?.clone() || new THREE.Vector3(0, 1, 0),
            distance: hit.distance,
        };
    }

    // ── Mesh Adapter: Select Region (Multi-Criteria Flood-Fill) ─────
    function meshSelectRegion(hit) {
        if (!hit || !adjacencyBuilt || !adjacencyMap) {
            return createPointSelection(hit);
        }

        const mesh = hit.object;
        const geo = mesh.geometry;
        if (!geo || !geo.attributes.position) {
            return createPointSelection(hit);
        }

        const index = geo.index; // may be null for non-indexed OBJ
        const positions = geo.attributes.position;
        const colors = geo.attributes.color; // may be null
        const faceCount = index ? (index.count / 3) : (positions.count / 3);

        if (!geo.attributes.normal) {
            geo.computeVertexNormals();
        }

        // The face we clicked on — our reference seed
        const hitNormal = getFaceNormal(geo, hit.faceIndex);
        const hitCentroid = getFaceCentroid(geo, hit.faceIndex);
        const hitColor = colors ? getFaceColor(geo, hit.faceIndex) : null;
        const hitHeight = hitCentroid.y;

        // Determine active weights (redistribute if no vertex colors)
        let wNormal = SEG_CONFIG.normalWeight;
        let wColor  = (colors && _hasVertexColors) ? SEG_CONFIG.colorWeight : 0;
        let wProx   = SEG_CONFIG.proximityWeight;
        let wHeight = SEG_CONFIG.heightWeight;

        // Redistribute color weight if unavailable
        if (wColor === 0) {
            const redistrib = SEG_CONFIG.colorWeight / 3;
            wNormal += redistrib;
            wProx   += redistrib;
            wHeight += redistrib;
        }

        const normalMaxRad = (SEG_CONFIG.normalAngleMax * Math.PI) / 180;
        const maxDist = SEG_CONFIG.distanceThreshold || (_meshMaxDim * 0.08);

        // BFS flood-fill with scoring
        const visited = new Set();
        const regionFaces = [];
        const queue = [hit.faceIndex];
        visited.add(hit.faceIndex);

        // Tracking for adaptive stopping
        let regionMinX = hitCentroid.x, regionMaxX = hitCentroid.x;
        let regionMinY = hitCentroid.y, regionMaxY = hitCentroid.y;
        let regionMinZ = hitCentroid.z, regionMaxZ = hitCentroid.z;
        let growingRadius = 0; // max distance from hit to any region face

        while (queue.length > 0 && regionFaces.length < SEG_CONFIG.maxFloodFaces) {
            const fi = queue.shift();
            regionFaces.push(fi);

            // Update region bounds
            const fc = getFaceCentroid(geo, fi);
            regionMinX = Math.min(regionMinX, fc.x);
            regionMaxX = Math.max(regionMaxX, fc.x);
            regionMinY = Math.min(regionMinY, fc.y);
            regionMaxY = Math.max(regionMaxY, fc.y);
            regionMinZ = Math.min(regionMinZ, fc.z);
            regionMaxZ = Math.max(regionMaxZ, fc.z);

            // Check aspect ratio stopping (prevent terrain runaway)
            if (regionFaces.length > 50 && regionFaces.length % 100 === 0) {
                const extX = regionMaxX - regionMinX || 0.01;
                const extY = regionMaxY - regionMinY || 0.01;
                const extZ = regionMaxZ - regionMinZ || 0.01;
                const dims = [extX, extY, extZ].sort((a, b) => b - a);
                const aspect = dims[0] / dims[2];
                if (aspect > SEG_CONFIG.maxAspectRatio) break;
            }

            const neighbors = adjacencyMap.get(fi);
            if (!neighbors) continue;

            for (const ni of neighbors) {
                if (visited.has(ni)) continue;
                visited.add(ni);

                const neighborCentroid = getFaceCentroid(geo, ni);
                const dist = hitCentroid.distanceTo(neighborCentroid);

                // Hard distance cutoff — adaptive based on growing region
                const effectiveMaxDist = Math.max(
                    maxDist,
                    growingRadius * SEG_CONFIG.adaptiveGrowFactor
                );
                if (dist > effectiveMaxDist) continue;

                // ── Score each criterion ──────────────────

                // 1. Normal angle similarity (0 = identical, 1 = opposite)
                const neighborNormal = getFaceNormal(geo, ni);
                const angle = hitNormal.angleTo(neighborNormal);
                const normalScore = angle / normalMaxRad; // 0..1+ (>1 = hard fail)
                if (angle > normalMaxRad) continue; // hard normal cutoff

                // 2. Color similarity (0 = identical, 1 = completely different)
                let colorScore = 0;
                if (colors && hitColor) {
                    const nc = getFaceColor(geo, ni);
                    colorScore = colorDistance(hitColor, nc);
                }

                // 3. Proximity (0 = at click point, 1 = at max distance)
                const proxScore = dist / effectiveMaxDist;

                // 4. Height continuity (0 = same height, 1 = very different height)
                const heightDiff = Math.abs(neighborCentroid.y - hitHeight);
                const heightRange = _meshMaxDim * 0.15; // 15% of scene height is "different"
                const heightScore = Math.min(1, heightDiff / heightRange);

                // Weighted composite score
                const score = (
                    wNormal * normalScore +
                    wColor  * colorScore +
                    wProx   * proxScore +
                    wHeight * heightScore
                );

                if (score <= SEG_CONFIG.scoreThreshold) {
                    queue.push(ni);
                    growingRadius = Math.max(growingRadius, dist);
                }
            }
        }

        if (regionFaces.length < SEG_CONFIG.minFloodFaces) {
            return createPointSelection(hit);
        }

        // ── Build highlight geometry from selected faces ──
        const selectedPositions = [];
        const selectedColors = [];
        for (const fi of regionFaces) {
            const a = index ? index.getX(fi * 3)     : fi * 3;
            const b = index ? index.getX(fi * 3 + 1) : fi * 3 + 1;
            const c = index ? index.getX(fi * 3 + 2) : fi * 3 + 2;
            for (const vi of [a, b, c]) {
                selectedPositions.push(
                    positions.getX(vi),
                    positions.getY(vi),
                    positions.getZ(vi)
                );
                if (colors) {
                    selectedColors.push(
                        colors.getX(vi),
                        colors.getY(vi),
                        colors.getZ(vi)
                    );
                }
            }
        }

        // ── Compute bounding info for metadata (NOT for display) ──
        const bbox = new THREE.Box3().setFromBufferAttribute(
            new THREE.Float32BufferAttribute(selectedPositions, 3)
        );
        bbox.min.add(meshObject.position);
        bbox.max.add(meshObject.position);
        const centroid = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());

        // Calculate actual selection radius from the click point
        const selectionRadius = Math.max(
            hitCentroid.distanceTo(new THREE.Vector3(
                (bbox.min.x + bbox.max.x) / 2 - meshObject.position.x,
                (bbox.min.y + bbox.max.y) / 2 - meshObject.position.y,
                (bbox.min.z + bbox.max.z) / 2 - meshObject.position.z,
            )),
            Math.max(size.x, size.y, size.z) * 0.4
        );

        // ── Visual: Subtle face overlay (shows which faces are selected) ──
        const selGeo = new THREE.BufferGeometry();
        selGeo.setAttribute('position', new THREE.Float32BufferAttribute(selectedPositions, 3));
        selGeo.computeVertexNormals();

        const selMat = new THREE.MeshBasicMaterial({
            color: 0x00e68a,
            transparent: true,
            opacity: 0.20,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: false,
        });
        const highlightMesh = new THREE.Mesh(selGeo, selMat);
        highlightMesh.position.copy(meshObject.position);
        highlightMesh.rotation.copy(meshObject.rotation);
        highlightMesh.scale.copy(meshObject.scale);

        // ── Visual: Selection ring (circle at click point, normal-aligned) ──
        const ringInner = selectionRadius * 0.92;
        const ringOuter = selectionRadius * 1.0;
        const ringGeo = new THREE.RingGeometry(ringInner, ringOuter, 64);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0x00e68a,
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
            depthTest: false,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);

        // Position ring at the click point (in world space)
        const ringWorldPos = hitCentroid.clone().add(meshObject.position);
        ring.position.copy(ringWorldPos);

        // Orient ring to face along the surface normal
        const up = new THREE.Vector3(0, 0, 1); // RingGeometry default facing
        const normalWorld = hitNormal.clone().normalize();
        const quat = new THREE.Quaternion().setFromUnitVectors(up, normalWorld);
        ring.quaternion.copy(quat);

        // ── Visual: Pulsing ring outline ──
        const ringOutlineGeo = new THREE.RingGeometry(ringOuter * 0.98, ringOuter * 1.05, 64);
        const ringOutlineMat = new THREE.MeshBasicMaterial({
            color: 0x00e68a,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide,
            depthTest: false,
        });
        const ringOutline = new THREE.Mesh(ringOutlineGeo, ringOutlineMat);
        ringOutline.position.copy(ring.position);
        ringOutline.quaternion.copy(ring.quaternion);

        // ── Visual: Center dot at click point ──
        const dotGeo = new THREE.SphereGeometry(selectionRadius * 0.04, 16, 16);
        const dotMat = new THREE.MeshBasicMaterial({
            color: 0xff3333,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
        });
        const centerDot = new THREE.Mesh(dotGeo, dotMat);
        centerDot.position.copy(ringWorldPos);

        const selId = `sel-mesh-${++selectionIdCounter}`;

        highlightGroup.add(highlightMesh);
        highlightGroup.add(ring);
        highlightGroup.add(ringOutline);
        highlightGroup.add(centerDot);

        // Classify the region based on geometry heuristics
        const info = classifyRegion(size, hitNormal, regionFaces.length);

        return {
            id: selId,
            centroid,
            bbox: { min: bbox.min, max: bbox.max, size },
            highlight: { mesh: highlightMesh, ring, ringOutline, centerDot },
            adapter: 'mesh',
            info: {
                ...info,
                triangleCount: regionFaces.length,
                selectionRadius: selectionRadius.toFixed(2),
            },
        };
    }

    function createPointSelection(hit) {
        if (!hit) return null;

        const pos = hit.position.clone();
        const selId = `sel-mesh-point-${++selectionIdCounter}`;
        const normal = hit.normal || new THREE.Vector3(0, 1, 0);
        const pointRadius = _meshMaxDim * 0.02; // small ring

        // Ring at click point
        const ringGeo = new THREE.RingGeometry(pointRadius * 0.85, pointRadius, 48);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0x00e68a,
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
            depthTest: false,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(pos);
        const up = new THREE.Vector3(0, 0, 1);
        ring.quaternion.setFromUnitVectors(up, normal.clone().normalize());

        // Center dot
        const dotGeo = new THREE.SphereGeometry(pointRadius * 0.1, 12, 12);
        const dotMat = new THREE.MeshBasicMaterial({
            color: 0xff3333,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
        });
        const centerDot = new THREE.Mesh(dotGeo, dotMat);
        centerDot.position.copy(pos);

        highlightGroup.add(ring);
        highlightGroup.add(centerDot);

        return {
            id: selId,
            centroid: pos,
            bbox: {
                min: pos.clone().subScalar(pointRadius),
                max: pos.clone().addScalar(pointRadius),
                size: new THREE.Vector3(pointRadius * 2, pointRadius * 2, pointRadius * 2),
            },
            highlight: { ring, centerDot },
            adapter: 'mesh',
            info: { label: 'Selected Point', category: 'unknown' },
        };
    }

    function meshClearSelection(sel) {
        if (!sel || !sel.highlight) return;
        Object.values(sel.highlight).forEach(obj => {
            if (obj) {
                highlightGroup.remove(obj);
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) obj.material.dispose();
            }
        });
    }

    // ── Lasso Selection ──────────────────────────────────
    function meshSelectByLasso(lassoPolygon, cam, container) {
        if (!cam || !container || !_interactModule) return null;
        if (allMeshChildren.length === 0) return null;

        const pipFn = _interactModule.pointInPolygon;
        if (!pipFn) return null;

        const rect = container.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;

        // View-projection matrix for projecting 3D → 2D
        const vpMatrix = new THREE.Matrix4();
        vpMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

        const selectedPositions = [];
        let totalSelected = 0;

        const tempVec = new THREE.Vector3();

        allMeshChildren.forEach((mesh) => {
            const geo = mesh.geometry;
            if (!geo || !geo.attributes.position) return;

            const positions = geo.attributes.position;
            const index = geo.index;
            const faceCount = index ? (index.count / 3) : (positions.count / 3);

            // World matrix to transform local positions to world space
            const worldMatrix = mesh.matrixWorld;

            for (let fi = 0; fi < faceCount; fi++) {
                // Get face vertex indices
                const a = index ? index.getX(fi * 3)     : fi * 3;
                const b = index ? index.getX(fi * 3 + 1) : fi * 3 + 1;
                const c = index ? index.getX(fi * 3 + 2) : fi * 3 + 2;

                // Compute face centroid in local space
                tempVec.set(
                    (positions.getX(a) + positions.getX(b) + positions.getX(c)) / 3,
                    (positions.getY(a) + positions.getY(b) + positions.getY(c)) / 3,
                    (positions.getZ(a) + positions.getZ(b) + positions.getZ(c)) / 3,
                );

                // Transform to world space
                tempVec.applyMatrix4(worldMatrix);

                // Project to NDC (-1..1)
                tempVec.applyMatrix4(vpMatrix);

                // NDC → screen pixels
                const sx = (tempVec.x * 0.5 + 0.5) * w;
                const sy = (-tempVec.y * 0.5 + 0.5) * h;

                // Skip faces behind camera
                if (tempVec.z < -1 || tempVec.z > 1) continue;

                // Test if projected point is inside lasso polygon
                if (pipFn(sx, sy, lassoPolygon)) {
                    // Collect face vertices for highlight
                    for (const vi of [a, b, c]) {
                        selectedPositions.push(
                            positions.getX(vi),
                            positions.getY(vi),
                            positions.getZ(vi),
                        );
                    }
                    totalSelected++;
                }
            }
        });

        if (totalSelected < 1) return null;

        console.log(`Lasso selected ${totalSelected} faces`);

        // Build highlight mesh from selected faces
        const selGeo = new THREE.BufferGeometry();
        selGeo.setAttribute('position', new THREE.Float32BufferAttribute(selectedPositions, 3));
        selGeo.computeVertexNormals();

        const selMat = new THREE.MeshBasicMaterial({
            color: 0x00e68a,
            transparent: true,
            opacity: 0.30,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: false,
        });
        const highlightMesh = new THREE.Mesh(selGeo, selMat);

        // Apply parent transform
        if (meshObject) {
            highlightMesh.position.copy(meshObject.position);
            highlightMesh.rotation.copy(meshObject.rotation);
            highlightMesh.scale.copy(meshObject.scale);
        }

        const selId = `sel-mesh-lasso-${++selectionIdCounter}`;
        highlightGroup.add(highlightMesh);

        // Compute bbox from selected geometry
        const bbox = new THREE.Box3().setFromBufferAttribute(
            new THREE.Float32BufferAttribute(selectedPositions, 3)
        );
        if (meshObject) {
            bbox.min.add(meshObject.position);
            bbox.max.add(meshObject.position);
        }
        const centroid = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());

        const info = classifyRegion(size, new THREE.Vector3(0, 1, 0), totalSelected);

        return {
            id: selId,
            centroid,
            bbox: { min: bbox.min, max: bbox.max, size },
            highlight: { mesh: highlightMesh },
            adapter: 'mesh',
            info: {
                ...info,
                triangleCount: totalSelected,
            },
        };
    }

    function meshGetScreenshot() {
        return captureViewWithCrosshair();
    }

    /**
     * Capture a single screenshot with crosshair overlay from the current camera.
     */
    function captureViewWithCrosshair(targetPos = null) {
        if (!renderer) return null;
        try {
            renderer.render(scene, camera);
            const srcCanvas = renderer.domElement;
            const w = srcCanvas.width;
            const h = srcCanvas.height;

            const compCanvas = document.createElement('canvas');
            compCanvas.width = w;
            compCanvas.height = h;
            const ctx = compCanvas.getContext('2d');
            ctx.drawImage(srcCanvas, 0, 0);

            // Find marker position
            let markerPos = targetPos;
            if (!markerPos && highlightGroup.children.length > 0) {
                for (let i = highlightGroup.children.length - 1; i >= 0; i--) {
                    const child = highlightGroup.children[i];
                    if (child.isMesh) {
                        markerPos = child.position.clone();
                        break;
                    }
                }
            }

            if (markerPos) {
                const projected = markerPos.clone().project(camera);
                const sx = (projected.x * 0.5 + 0.5) * w;
                const sy = (-projected.y * 0.5 + 0.5) * h;
                if (projected.z >= 0 && projected.z <= 1) {
                    drawSelectionMarker(ctx, sx, sy, w, h);
                }
            }

            return compCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];
        } catch (e) {
            console.warn('Screenshot failed:', e);
            return null;
        }
    }

    /**
     * Capture 4 views around the selected object for full 3D understanding.
     * Returns an array of { angle: string, image_b64: string }.
     * Camera returns to its original position afterward.
     */
    function meshGetMultiViewScreenshots(selectionCentroid, selectionSize) {
        if (!renderer || !camera || !controls || !selectionCentroid) return [];

        // Save original camera state
        const origPos = camera.position.clone();
        const origTarget = controls.target.clone();
        const origUp = camera.up.clone();

        const center = selectionCentroid.clone();
        const maxExtent = selectionSize
            ? Math.max(selectionSize.x, selectionSize.y, selectionSize.z)
            : 2;
        const viewDist = maxExtent * 2.5; // distance from center for each view

        const views = [
            { angle: 'front',      pos: new THREE.Vector3(center.x, center.y, center.z + viewDist) },
            { angle: 'right',      pos: new THREE.Vector3(center.x + viewDist, center.y, center.z) },
            { angle: 'top',        pos: new THREE.Vector3(center.x, center.y + viewDist, center.z) },
            { angle: 'isometric',  pos: new THREE.Vector3(
                center.x + viewDist * 0.6,
                center.y + viewDist * 0.5,
                center.z + viewDist * 0.6
            )},
        ];

        const screenshots = [];

        for (const view of views) {
            // Move camera to view position
            camera.position.copy(view.pos);
            camera.up.set(0, 1, 0);
            camera.lookAt(center);
            camera.updateMatrixWorld(true);

            const b64 = captureViewWithCrosshair(center);
            if (b64) {
                screenshots.push({ angle: view.angle, image_b64: b64 });
            }
        }

        // Restore original camera position
        camera.position.copy(origPos);
        camera.up.copy(origUp);
        controls.target.copy(origTarget);
        controls.update();
        camera.updateMatrixWorld(true);

        // Re-render from original position
        renderer.render(scene, camera);

        return screenshots;
    }

    /**
     * Draw a highly visible crosshair + label on the screenshot canvas
     * so the AI vision model knows exactly which area to analyze.
     */
    function drawSelectionMarker(ctx, x, y, canvasW, canvasH) {
        const r = Math.min(canvasW, canvasH) * 0.04; // marker radius

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

        // Crosshair lines extending beyond the circle
        ctx.strokeStyle = '#00e68a';
        ctx.lineWidth = 2;
        const ext = r * 2.5;

        // Horizontal
        ctx.beginPath();
        ctx.moveTo(x - ext, y);
        ctx.lineTo(x - r * 0.6, y);
        ctx.moveTo(x + r * 0.6, y);
        ctx.lineTo(x + ext, y);
        ctx.stroke();

        // Vertical
        ctx.beginPath();
        ctx.moveTo(x, y - ext);
        ctx.lineTo(x, y - r * 0.6);
        ctx.moveTo(x, y + r * 0.6);
        ctx.lineTo(x, y + ext);
        ctx.stroke();

        // Center dot
        ctx.fillStyle = '#ff3333';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();

        // Label arrow pointing to the marker
        const labelX = x + r * 2;
        const labelY = y - r * 2;

        // Arrow line from label to marker
        ctx.strokeStyle = '#00e68a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(labelX, labelY + 12);
        ctx.lineTo(x + r * 0.8, y - r * 0.8);
        ctx.stroke();

        // Label background
        const labelText = '← SELECTED OBJECT';
        ctx.font = `bold ${Math.max(14, canvasH * 0.02)}px sans-serif`;
        const textMetrics = ctx.measureText(labelText);
        const padding = 6;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(
            labelX - padding,
            labelY - padding,
            textMetrics.width + padding * 2,
            Math.max(14, canvasH * 0.02) + padding * 2
        );

        // Label text
        ctx.fillStyle = '#00e68a';
        ctx.fillText(labelText, labelX, labelY + Math.max(14, canvasH * 0.02) - 2);

        ctx.restore();
    }

    // ── Geometry Helpers ─────────────────────────────
    function getFaceNormal(geo, faceIndex) {
        const index = geo.index;
        const normals = geo.attributes.normal;
        if (!normals) return new THREE.Vector3(0, 1, 0);

        const a = index ? index.getX(faceIndex * 3)     : faceIndex * 3;
        const b = index ? index.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
        const c = index ? index.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;

        const na = new THREE.Vector3(normals.getX(a), normals.getY(a), normals.getZ(a));
        const nb = new THREE.Vector3(normals.getX(b), normals.getY(b), normals.getZ(b));
        const nc = new THREE.Vector3(normals.getX(c), normals.getY(c), normals.getZ(c));

        return na.add(nb).add(nc).normalize();
    }

    function getFaceCentroid(geo, faceIndex) {
        const index = geo.index;
        const positions = geo.attributes.position;
        if (!positions) return new THREE.Vector3();

        const a = index ? index.getX(faceIndex * 3)     : faceIndex * 3;
        const b = index ? index.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
        const c = index ? index.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;

        return new THREE.Vector3(
            (positions.getX(a) + positions.getX(b) + positions.getX(c)) / 3,
            (positions.getY(a) + positions.getY(b) + positions.getY(c)) / 3,
            (positions.getZ(a) + positions.getZ(b) + positions.getZ(c)) / 3,
        );
    }

    /**
     * Get average vertex color of a triangle face.
     * Returns {r, g, b} in 0..1 range, or null if no colors.
     */
    function getFaceColor(geo, faceIndex) {
        const index = geo.index;
        const colors = geo.attributes.color;
        if (!colors) return null;

        const a = index ? index.getX(faceIndex * 3)     : faceIndex * 3;
        const b = index ? index.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
        const c = index ? index.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;

        return {
            r: (colors.getX(a) + colors.getX(b) + colors.getX(c)) / 3,
            g: (colors.getY(a) + colors.getY(b) + colors.getY(c)) / 3,
            b: (colors.getZ(a) + colors.getZ(b) + colors.getZ(c)) / 3,
        };
    }

    /**
     * Compute normalized color distance (0 = identical, 1 = max difference).
     * Uses Euclidean distance in RGB space, normalized by sqrt(3).
     */
    function colorDistance(c1, c2) {
        if (!c1 || !c2) return 0;
        const dr = c1.r - c2.r;
        const dg = c1.g - c2.g;
        const db = c1.b - c2.b;
        return Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3);
    }

    // ── Geometry Classification Heuristics ───────────
    function classifyRegion(size, normal, faceCount) {
        const volume = size.x * size.y * size.z;
        const aspectRatioXZ = Math.max(size.x, size.z) / (Math.min(size.x, size.z) || 0.01);
        const heightRatio = size.y / (Math.max(size.x, size.z) || 0.01);

        let category = 'unknown';
        let label = 'Selected Region';
        let confidence = 0.4;

        // Tall and narrow → tree / vegetation
        if (heightRatio > 1.5 && aspectRatioXZ < 3) {
            category = 'vegetation';
            label = 'Tree / Vegetation';
            confidence = 0.6;
        }
        // Boxy, moderate height → structure
        else if (heightRatio > 0.3 && heightRatio < 3 && aspectRatioXZ < 4 && faceCount > 50) {
            category = 'structure';
            label = 'Structure';
            confidence = 0.55;
        }
        // Flat and wide → terrain / ground
        else if (heightRatio < 0.2) {
            category = 'terrain';
            label = 'Terrain / Ground';
            confidence = 0.5;
        }
        // Small and compact → vehicle or small object
        else if (faceCount < 200 && volume < 100) {
            category = 'vehicle';
            label = 'Small Object / Vehicle';
            confidence = 0.4;
        }
        // Elongated → road or path
        else if (aspectRatioXZ > 5) {
            category = 'road';
            label = 'Linear Feature';
            confidence = 0.45;
        }

        return { category, label, confidence };
    }

    // ── Status Overlay ─────────────────────────────────
    function showStatus(message, isError = false) {
        let overlay = document.getElementById('viewer-loading-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'viewer-loading-overlay';
            overlay.style.cssText = `
                position: absolute; inset: 0; display: flex; flex-direction: column;
                align-items: center; justify-content: center; z-index: 100;
                background: rgba(10, 14, 26, 0.85); backdrop-filter: blur(8px);
                color: #e2e8f0; font-size: 1rem; gap: 16px; transition: opacity 0.3s;
            `;
            const container = document.getElementById('threejs-render-area');
            if (container) container.appendChild(overlay);
        }
        overlay.style.opacity = '1';
        overlay.style.pointerEvents = 'auto';

        if (isError) {
            overlay.innerHTML = `
                <div style="font-size: 2.5rem;">⚠️</div>
                <div style="max-width: 400px; text-align: center;">${message}</div>
            `;
        } else {
            overlay.innerHTML = `
                <div class="loading-spinner" style="width:40px;height:40px;border:3px solid rgba(255,255,255,0.1);border-top-color:#00e68a;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
                <div>${message}</div>
            `;
        }
    }

    function hideStatus() {
        const overlay = document.getElementById('viewer-loading-overlay');
        if (overlay) {
            overlay.style.opacity = '0';
            overlay.style.pointerEvents = 'none';
            setTimeout(() => overlay.remove(), 300);
        }
    }

    // ── Controls ────────────────────────────────────────
    window.togglePanel = function () {
        panelOpen = !panelOpen;
        const panel = document.getElementById('viewer-panel');
        const btn = document.getElementById('btn-toggle-panel');
        if (panel) panel.classList.toggle('open', panelOpen);
        if (btn) btn.classList.toggle('active', panelOpen);
    };

    window.toggleFullscreen = function () {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen().catch(() => {});
        }
    };

    window.resetCamera = function () {
        if (!meshObject || !controls) return;
        const box = new THREE.Box3().setFromObject(meshObject);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const fitDistance = maxDim * 1.5;
        camera.position.set(fitDistance * 0.7, fitDistance * 0.5, fitDistance * 0.7);
        controls.target.set(0, 0, 0);
        controls.update();
    };

    window.toggleWireframe = function () {
        if (!meshObject) return;
        meshObject.traverse((child) => {
            if (child.isMesh) {
                child.material.wireframe = !child.material.wireframe;
            }
        });
        const btn = document.getElementById('btn-wireframe');
        if (btn) btn.classList.toggle('active');
    };

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.key) {
            case 'r': window.resetCamera(); break;
            case 'w': window.toggleWireframe(); break;
            case 's': window.togglePanel(); break;
            case 'f': window.toggleFullscreen(); break;
        }
    });

    // Expose scene objects for interaction system
    window.D3D_MeshViewer = {
        getScene: () => scene,
        getCamera: () => camera,
        getRenderer: () => renderer,
        getMeshObject: () => meshObject,
        getControls: () => controls,
    };

})();

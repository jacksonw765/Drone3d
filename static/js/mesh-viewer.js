/**
 * Drone3D — Three.js Mesh Viewer
 *
 * Fallback 3D viewer when Potree data is not available.
 * Loads OBJ + MTL textured meshes from ODM output and renders
 * them with orbit controls, lighting, and basic interaction.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

(function () {
    'use strict';

    const CONFIG = window.VIEWER_CONFIG || {};
    let scene, camera, renderer, controls;
    let meshObject = null;
    let panelOpen = false;

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
        });
        renderer.setSize(container.clientWidth, container.clientHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        container.appendChild(renderer.domElement);

        // Scene
        scene = new THREE.Scene();

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

        // Grid helper (will be positioned at mesh base)
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
    }

    function onResize() {
        const container = document.getElementById('threejs-render-area');
        if (!container || !camera || !renderer) return;
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight);
    }

    // ── Mesh Loading ───────────────────────────────────
    function loadMesh() {
        showStatus('Loading 3D model…');

        const baseUrl = CONFIG.meshDataUrl;
        const objFilename = CONFIG.meshFilename || 'odm_textured_model_geo.obj';
        const mtlFilename = objFilename.replace('.obj', '.mtl');

        // Try loading with MTL (textured), fall back to OBJ only
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
                // MTL not found — load OBJ without materials
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

                // Center and scale the model
                const box = new THREE.Box3().setFromObject(object);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);

                object.position.sub(center);
                meshObject = object;
                scene.add(meshObject);

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

                // Count triangles for info display
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
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        switch (e.key) {
            case 'r': resetCamera(); break;
            case 'w': toggleWireframe(); break;
            case 's': togglePanel(); break;
            case 'f': toggleFullscreen(); break;
        }
    });

})();

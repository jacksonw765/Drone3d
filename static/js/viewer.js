/**
 * Drone3D — 3D Viewer Controller
 *
 * Initializes Potree viewer, manages layer toggles, measurement tools,
 * point cloud styling, and coordinate display.
 */

(function () {
    'use strict';

    const CONFIG = window.VIEWER_CONFIG || {};
    let viewer = null;
    let pointCloudLayer = null;
    let panelOpen = false;

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
            });
        }

        // Set up coordinate tracking
        setupCoordinateDisplay();
    }

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
                // Mesh toggle placeholder — loaded when mesh support is added
                updateToggleBtn('btn-toggle-mesh', false);
                break;
            case 'orthophoto':
                // Orthophoto toggle placeholder
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

    // ── Measurement Tools ───────────────────────────────
    window.activateMeasure = function (type) {
        if (!viewer) return;

        // Deactivate all measurement buttons
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

            const rect = renderArea.getBoundingClientRect();
            const mouse = {
                x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
                y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
            };

            // Use Potree's picking to get 3D coordinates
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
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

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
                // Reset measurement tools
                document.querySelectorAll('[id^="btn-measure-"]').forEach(btn => {
                    btn.classList.remove('active');
                });
                break;
        }
    });

})();

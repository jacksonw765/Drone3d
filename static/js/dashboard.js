/**
 * Drone3D — Dashboard Controller
 *
 * Handles project creation, status polling, and project management.
 */

(function () {
    'use strict';

    // ── Status Polling ──────────────────────────────────
    const POLL_INTERVAL = 5000;
    const ACTIVE_STATUSES = new Set(['queued', 'preprocessing', 'processing', 'analyzing']);
    let pollTimers = {};

    // ── Timer Utilities ────────────────────────────────
    let cardTimers = {};  // projectId → intervalId for client-side timers

    function formatElapsed(seconds) {
        if (seconds == null || seconds < 0) return '';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    function startCardTimer(projectId, startedAtISO) {
        stopCardTimer(projectId);
        if (!startedAtISO) return;
        const startedAt = new Date(startedAtISO).getTime();
        const update = () => {
            const el = document.getElementById(`timer-${projectId}`);
            if (!el) { stopCardTimer(projectId); return; }
            const elapsed = Math.floor((Date.now() - startedAt) / 1000);
            el.textContent = `⏱ ${formatElapsed(elapsed)}`;
        };
        update();
        cardTimers[projectId] = setInterval(update, 1000);
    }

    function stopCardTimer(projectId) {
        if (cardTimers[projectId]) {
            clearInterval(cardTimers[projectId]);
            delete cardTimers[projectId];
        }
    }

    // Start polling for active projects on page load
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('.project-card').forEach(card => {
            const status = card.dataset.status;
            const id = card.dataset.id;
            if (ACTIVE_STATUSES.has(status)) {
                startPolling(id);
            }
        });

        // Toggle approximate location fields
        const locationToggle = document.getElementById('approx-location-toggle');
        const locationFields = document.getElementById('approx-location-fields');
        if (locationToggle && locationFields) {
            locationToggle.addEventListener('change', () => {
                locationFields.style.display = locationToggle.checked ? 'block' : 'none';
                if (!locationToggle.checked) {
                    const latInput = document.getElementById('approx-lat');
                    const lonInput = document.getElementById('approx-lon');
                    if (latInput) latInput.value = '';
                    if (lonInput) lonInput.value = '';
                }
            });
        }

        // Enhancement radio info text
        const enhanceInfoTexts = {
            off: '',
            standard: '⚡ Applies contrast, sharpening, and noise reduction. Adds ~30s for 100 images.',
            super_res: '<i data-lucide="brain" class="inline-icon" style="width:16px;height:16px;"></i> AI upscales images 2× then enhances. Best for video frames. Adds ~3-5 min for 100 images.',
        };
        document.querySelectorAll('input[name="enhance"]').forEach(radio => {
            radio.addEventListener('change', () => {
                const info = document.getElementById('enhance-info');
                if (info) {
                    const text = enhanceInfoTexts[radio.value] || '';
                    info.textContent = text;
                    info.style.display = text ? 'block' : 'none';
                }
            });
        });
    });

    function startPolling(projectId) {
        if (pollTimers[projectId]) return;

        pollTimers[projectId] = setInterval(async () => {
            try {
                const data = await apiFetch(`/api/projects/${projectId}/status/`);
                updateProjectCard(projectId, data);

                if (!ACTIVE_STATUSES.has(data.status)) {
                    stopPolling(projectId);

                    if (data.status === 'completed') {
                        showToast(`Project "${data.name}" completed!`, 'success');
                    } else if (data.status === 'failed') {
                        const summary = data.error_detail?.summary || data.error_message || 'Unknown error';
                        showToast(`Project "${data.name}" failed: ${summary}`, 'error', 8000);
                    }
                }
            } catch (err) {
                console.error('Poll error:', err);
            }
        }, POLL_INTERVAL);
    }

    function stopPolling(projectId) {
        if (pollTimers[projectId]) {
            clearInterval(pollTimers[projectId]);
            delete pollTimers[projectId];
        }
    }

    function updateProjectCard(projectId, data) {
        const card = document.getElementById(`project-${projectId}`);
        if (!card) return;

        // Update status attribute for CSS
        card.dataset.status = data.status;

        // Update badge
        const badge = card.querySelector('.badge');
        if (badge) {
            badge.className = `badge badge-${data.status}`;
            badge.innerHTML = `<span class="badge-dot"></span>${data.status_display}`;
        }

        // Update progress bar + timer
        let progressBar = card.querySelector('.progress-bar');
        if (ACTIVE_STATUSES.has(data.status)) {
            const progressLabel = data.progress_message
                ? `${data.progress}% — ${data.progress_message}`
                : `${data.progress}%`;

            if (!progressBar) {
                const body = card.querySelector('.card-body');
                const progressHtml = `
                    <div class="progress-bar" onclick="showProcessingLogs('${projectId}')" style="cursor:pointer;" title="Click for processing details">
                        <div class="progress-bar-fill" style="width: ${data.progress}%"></div>
                    </div>
                    <div class="progress-text" style="display:flex;justify-content:space-between;align-items:center;">
                        <span>${progressLabel}</span>
                        <span id="timer-${projectId}" style="font-size:0.72rem;color:var(--accent-primary);font-family:'JetBrains Mono',monospace;font-weight:600;"></span>
                        <span style="font-size:0.7rem;color:var(--text-tertiary);cursor:pointer;" onclick="showProcessingLogs('${projectId}')"><i data-lucide="file-text" class="inline-icon" style="width:14px;height:14px;margin-right:4px;"></i> View logs</span>
                    </div>
                `;
                body.insertAdjacentHTML('beforeend', progressHtml);
            } else {
                const fill = progressBar.querySelector('.progress-bar-fill');
                if (fill) fill.style.width = `${data.progress}%`;
                const text = card.querySelector('.progress-text span:first-child');
                if (text) text.textContent = progressLabel;
            }
            // Start/update client-side timer
            if (data.processing_started_at && !cardTimers[projectId]) {
                startCardTimer(projectId, data.processing_started_at);
            }
        } else {
            stopCardTimer(projectId);
            if (progressBar) progressBar.remove();
            const progressText = card.querySelector('.progress-text');
            if (progressText) progressText.remove();

            // Show total processing time for completed/failed projects
            if (data.processing_duration && (data.status === 'completed' || data.status === 'failed')) {
                let durationEl = card.querySelector('.processing-duration');
                if (!durationEl) {
                    durationEl = document.createElement('div');
                    durationEl.className = 'processing-duration';
                    durationEl.style.cssText = 'margin-top:6px;font-size:0.75rem;color:var(--text-tertiary);display:flex;align-items:center;gap:4px;';
                    const body = card.querySelector('.card-body');
                    if (body) body.appendChild(durationEl);
                }
                durationEl.innerHTML = `⏱ Processed in <strong style="color:var(--text-secondary);">${data.processing_duration}</strong>`;
            }
        }

        // Update AI status info
        let aiInfo = card.querySelector('.ai-status-info');
        if (data.status === 'analyzing' || data.annotation_count > 0 || data.has_ai_report) {
            if (!aiInfo) {
                aiInfo = document.createElement('div');
                aiInfo.className = 'ai-status-info';
                aiInfo.style.cssText = 'margin-top:8px;display:flex;align-items:center;gap:8px;font-size:0.78rem;';
                const body = card.querySelector('.card-body');
                if (body) body.appendChild(aiInfo);
            }
            const parts = [];
            if (data.status === 'analyzing') {
                parts.push(`<span style="color:#818cf8"><i data-lucide="bot" style="width:20px;height:20px;margin-right:8px;"></i> ${data.progress_message || 'AI analyzing...'}</span>`);
            }
            if (data.annotation_count > 0) {
                parts.push(`<span style="color:var(--text-tertiary)"><i data-lucide="map-pin" style="width:14px;height:14px;margin-right:6px;"></i> ${data.annotation_count} annotations</span>`);
            }
            if (data.has_ai_report) {
                parts.push(`<span style="color:#818cf8"><i data-lucide="file-edit" class="inline-icon" style="width:16px;height:16px;"></i> Report ready</span>`);
            }
            aiInfo.innerHTML = parts.join('<span style="color:var(--border-default)">|</span>');
        }

        // Update footer buttons
        const footer = card.querySelector('.card-footer');
        if (footer) {
            if (data.status === 'completed') {
                footer.innerHTML = `
                    <a href="/viewer/${projectId}/" class="btn btn-primary btn-sm">
                        <i data-lucide="globe" class="inline-icon" style="width:16px;height:16px;margin-right:6px;"></i> View 3D Model
                    </a>
                    <button class="btn btn-danger btn-sm" onclick="deleteProject('${projectId}', '${data.name}')">
                        <i data-lucide="trash-2" class="inline-icon" style="width:16px;height:16px;"></i>
                    </button>
                `;
            } else if (ACTIVE_STATUSES.has(data.status)) {
                footer.innerHTML = `
                    <button class="btn btn-secondary btn-sm" onclick="showProcessingLogs('${projectId}')">
                        <i data-lucide="activity" class="inline-icon" style="width:16px;height:16px;margin-right:6px;"></i> Pipeline Status
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="cancelProcessing('${projectId}', '${data.name}')">
                        <i data-lucide="x" class="inline-icon" style="width:16px;height:16px;margin-right:6px;"></i> Cancel
                    </button>
                `;
            } else if (data.status === 'failed') {
                footer.innerHTML = `
                    <button class="btn btn-secondary btn-sm" onclick="openUploadPanel('${projectId}')">
                        <i data-lucide="upload-cloud" class="inline-icon" style="width:16px;height:16px;margin-right:6px;"></i> Upload More
                    </button>
                    <button class="btn btn-primary btn-sm" onclick="startProcessing('${projectId}')" id="btn-process-${projectId}">
                        <i data-lucide="refresh-cw" class="inline-icon" style="width:16px;height:16px;margin-right:6px;"></i> Retry Process
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="deleteProject('${projectId}', '${data.name}')">
                        <i data-lucide="trash-2" class="inline-icon" style="width:16px;height:16px;"></i>
                    </button>
                `;
                // Show structured error panel
                if (data.error_detail || data.error_message) {
                    const body = card.querySelector('.card-body');
                    let errorEl = body.querySelector('.error-panel');
                    if (!errorEl) {
                        errorEl = document.createElement('div');
                        errorEl.className = 'error-panel';
                        body.appendChild(errorEl);
                    }
                    errorEl.innerHTML = buildErrorPanel(data.error_detail, data.error_message);
                }
            }
        }
    }

    // ── Error Panel Builder ─────────────────────────────
    const ERROR_ICONS = {
        out_of_memory: '<i data-lucide="save" style="width:14px;height:14px;margin-right:6px;"></i>',
        insufficient_images: '<i data-lucide="camera" style="width:14px;height:14px;margin-right:6px;"></i>',
        reconstruction_failed: '<i data-lucide="triangle" class="inline-icon" style="width:16px;height:16px;"></i>',
        georeferencing_failed: '<i data-lucide="globe" class="inline-icon" style="width:16px;height:16px;"></i>',
        densification_failed: '<i data-lucide="target" style="width:18px;height:18px;margin-right:8px;"></i>',
        mesh_failed: '<i data-lucide="network" style="width:18px;height:18px;margin-right:8px;"></i>️',
        processing_error: '⚠️',
    };

    function buildErrorPanel(detail, fallbackMessage) {
        if (!detail) {
            return `<p class="error-msg" style="color:#f87171;font-size:0.8rem;margin-top:8px;">${(fallbackMessage || 'Unknown error').substring(0, 200)}</p>`;
        }

        const icon = ERROR_ICONS[detail.category] || '⚠️';
        const category = (detail.category || 'error').replace(/_/g, ' ');
        const meta = [];
        if (detail.image_count != null) meta.push(`${detail.image_count} images`);
        if (detail.quality_preset) meta.push(`${detail.quality_preset} quality`);
        if (detail.exit_code != null) meta.push(`exit code ${detail.exit_code}`);

        let html = `
            <div class="error-detail" style="
                margin-top: 10px;
                padding: 10px 12px;
                background: rgba(248,113,113,0.08);
                border: 1px solid rgba(248,113,113,0.25);
                border-radius: 8px;
                font-size: 0.82rem;
            ">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                    <span style="font-size:1.1rem;">${icon}</span>
                    <strong style="color:#fca5a5;text-transform:capitalize;">${category}</strong>
                </div>
                <p style="color:#e5e7eb;margin:0 0 6px 0;">${detail.summary || fallbackMessage}</p>
                <p style="color:#9ca3af;margin:0;font-size:0.78rem;">
                    <i data-lucide="lightbulb" class="inline-icon" style="width:14px;height:14px;"></i> ${detail.suggestion || 'Try re-running with a lower quality preset.'}
                </p>`;

        if (meta.length > 0) {
            html += `
                <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
                    ${meta.map(m => `<span style="
                        background:rgba(255,255,255,0.06);
                        padding:2px 8px;
                        border-radius:4px;
                        font-size:0.72rem;
                        color:#9ca3af;
                    ">${m}</span>`).join('')}
                </div>`;
        }

        if (detail.raw_output) {
            const id = 'raw-' + Math.random().toString(36).slice(2, 8);
            html += `
                <details style="margin-top:8px;">
                    <summary style="
                        cursor:pointer;
                        color:#6b7280;
                        font-size:0.72rem;
                        user-select:none;
                    ">Show processing log</summary>
                    <pre id="${id}" style="
                        margin-top:6px;
                        padding:8px;
                        background:rgba(0,0,0,0.3);
                        border-radius:6px;
                        font-size:0.68rem;
                        color:#9ca3af;
                        max-height:200px;
                        overflow:auto;
                        white-space:pre-wrap;
                        word-break:break-all;
                    ">${detail.raw_output.substring(0, 2000)}</pre>
                </details>`;
        }

        html += `</div>`;
        return html;
    }
    // ── Advanced Configuration ───────────────────────────

    // Toggle advanced panel open/close
    window.toggleAdvancedConfig = function () {
        const body = document.getElementById('advanced-body');
        const icon = document.getElementById('advanced-toggle-icon');
        if (body && icon) {
            body.classList.toggle('open');
            icon.classList.toggle('open');
        }
    };

    // Collect non-empty advanced options into a dict
    function collectAdvancedOptions() {
        const opts = {};

        // Map of element IDs to ODM option names and value types
        const fields = [
            { id: 'adv-feature-quality', key: 'feature-quality', type: 'string' },
            { id: 'adv-matcher-type', key: 'matcher-type', type: 'string' },
            { id: 'adv-min-num-features', key: 'min-num-features', type: 'int' },
            { id: 'adv-pc-quality', key: 'pc-quality', type: 'string' },
            { id: 'adv-depthmap-resolution', key: 'depthmap-resolution', type: 'int' },
            { id: 'adv-resize-to', key: 'resize-to', type: 'int' },
            { id: 'adv-mesh-octree-depth', key: 'mesh-octree-depth', type: 'int' },
            { id: 'adv-use-3dmesh', key: 'use-3dmesh', type: 'bool' },
            { id: 'adv-orthophoto-resolution', key: 'orthophoto-resolution', type: 'int' },
            { id: 'adv-dsm', key: 'dsm', type: 'bool' },
            { id: 'adv-dtm', key: 'dtm', type: 'bool' },
            { id: 'adv-skip-orthophoto', key: 'skip-orthophoto', type: 'bool' },
        ];

        for (const field of fields) {
            const el = document.getElementById(field.id);
            if (!el) continue;
            const raw = el.value.trim();
            if (raw === '') continue;  // Skip empty = use preset default

            if (field.type === 'int') {
                const val = parseInt(raw, 10);
                if (!isNaN(val)) opts[field.key] = val;
            } else if (field.type === 'bool') {
                opts[field.key] = raw === 'true';
            } else {
                opts[field.key] = raw;
            }
        }

        return Object.keys(opts).length > 0 ? opts : null;
    }

    // Reset all advanced fields to defaults
    function resetAdvancedConfig() {
        const body = document.getElementById('advanced-body');
        const icon = document.getElementById('advanced-toggle-icon');
        if (body) body.classList.remove('open');
        if (icon) icon.classList.remove('open');

        // Reset all selects to first option (empty)
        const selects = document.querySelectorAll('.advanced-body select');
        selects.forEach(s => s.selectedIndex = 0);

        // Clear all number inputs
        const inputs = document.querySelectorAll('.advanced-body input[type="number"]');
        inputs.forEach(i => i.value = '');
    }

    window.openNewProjectModal = function () {
        const modal = document.getElementById('new-project-modal');
        if (modal) {
            modal.classList.add('active');
            const nameInput = document.getElementById('project-name');
            if (nameInput) {
                nameInput.value = '';
                setTimeout(() => nameInput.focus(), 200);
            }
            // Reset location fields
            const toggle = document.getElementById('approx-location-toggle');
            const fields = document.getElementById('approx-location-fields');
            if (toggle) toggle.checked = false;
            if (fields) fields.style.display = 'none';
            const latInput = document.getElementById('approx-lat');
            const lonInput = document.getElementById('approx-lon');
            if (latInput) latInput.value = '';
            if (lonInput) lonInput.value = '';
            // Reset enhancement toggles
            const enhanceOff = document.getElementById('enhance-off');
            if (enhanceOff) enhanceOff.checked = true;
            const enhanceInfo = document.getElementById('enhance-info');
            if (enhanceInfo) { enhanceInfo.textContent = ''; enhanceInfo.style.display = 'none'; }
            // Reset advanced config
            resetAdvancedConfig();
        }
    };

    window.closeNewProjectModal = function () {
        const modal = document.getElementById('new-project-modal');
        if (modal) modal.classList.remove('active');
    };

    window.createProject = async function () {
        const nameInput = document.getElementById('project-name');
        const name = nameInput ? nameInput.value.trim() : '';

        if (!name) {
            showToast('Please enter a project name', 'warning');
            if (nameInput) nameInput.focus();
            return;
        }

        const qualityRadio = document.querySelector('input[name="quality"]:checked');
        const quality = qualityRadio ? qualityRadio.value : 'medium';

        // Collect optional approximate location
        const locationToggle = document.getElementById('approx-location-toggle');
        const body = { name, quality_preset: quality };

        // AI Enhancement mode
        const enhanceRadio = document.querySelector('input[name="enhance"]:checked');
        const enhanceMode = enhanceRadio ? enhanceRadio.value : 'off';
        if (enhanceMode !== 'off') {
            body.ai_enhance_mode = enhanceMode;
        }

        if (locationToggle && locationToggle.checked) {
            const latInput = document.getElementById('approx-lat');
            const lonInput = document.getElementById('approx-lon');
            const lat = latInput ? parseFloat(latInput.value) : NaN;
            const lon = lonInput ? parseFloat(lonInput.value) : NaN;

            if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                body.approx_latitude = lat;
                body.approx_longitude = lon;
            } else {
                showToast('Invalid coordinates. Latitude must be -90 to 90, longitude -180 to 180.', 'warning');
                return;
            }
        }

        // Collect advanced ODM overrides (if any)
        const advancedOpts = collectAdvancedOptions();
        if (advancedOpts) {
            body.odm_overrides = advancedOpts;
        }

        const btn = document.getElementById('btn-create-project');
        if (btn) btn.disabled = true;

        try {
            const data = await apiFetch('/api/projects/create/', {
                method: 'POST',
                body: JSON.stringify(body),
            });

            showToast(`Project "${name}" created`, 'success');
            closeNewProjectModal();

            // Redirect to page (reload to see new project and open upload)
            setTimeout(() => {
                window.location.reload();
            }, 500);

        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    // ── Processing ──────────────────────────────────────
    window.startProcessing = async function (projectId) {
        const btn = document.getElementById(`btn-process-${projectId}`);
        if (btn) btn.disabled = true;

        try {
            const data = await apiFetch(`/api/projects/${projectId}/process/`, {
                method: 'POST',
            });

            showToast('Processing started', 'success');
            startPolling(projectId);

            // Update card state immediately
            const card = document.getElementById(`project-${projectId}`);
            if (card) {
                card.dataset.status = 'queued';
                const badge = card.querySelector('.badge');
                if (badge) {
                    badge.className = 'badge badge-queued';
                    badge.innerHTML = '<span class="badge-dot"></span>Queued';
                }
                const footer = card.querySelector('.card-footer');
                if (footer) {
                    footer.innerHTML = `
                        <button class="btn btn-secondary btn-sm" onclick="showProcessingLogs('${projectId}')">
                            <i data-lucide="activity" class="inline-icon" style="width:16px;height:16px;margin-right:6px;"></i> Pipeline Status
                        </button>
                        <button class="btn btn-danger btn-sm" onclick="cancelProcessing('${projectId}')">
                            <i data-lucide="x" class="inline-icon" style="width:16px;height:16px;margin-right:6px;"></i> Cancel
                        </button>
                    `;
                }
            }
        } catch (err) {
            showToast(err.message, 'error');
            if (btn) btn.disabled = false;
        }
    };

    // ── Cancel Processing ───────────────────────────────
    window.cancelProcessing = async function (projectId, projectName) {
        const name = projectName || 'this project';
        if (!confirm(`Cancel processing for "${name}"? You can retry later.`)) {
            return;
        }

        try {
            await apiFetch(`/api/projects/${projectId}/cancel/`, {
                method: 'POST',
            });

            showToast('Processing canceled', 'info');
            stopPolling(projectId);

            // Force a status update
            try {
                const data = await apiFetch(`/api/projects/${projectId}/status/`);
                updateProjectCard(projectId, data);
            } catch (e) {
                // Reload if status fetch fails
                setTimeout(() => window.location.reload(), 500);
            }
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    // ── Processing Logs Modal ───────────────────────────
    let logRefreshTimer = null;

    window.showProcessingLogs = async function (projectId) {
        // Create or reuse modal
        let modal = document.getElementById('processing-logs-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'processing-logs-modal';
            modal.innerHTML = `
                <div class="logs-modal-backdrop" onclick="closeProcessingLogs()"></div>
                <div class="logs-modal-content">
                    <div class="logs-modal-header">
                        <div style="display:flex;align-items:center;gap:12px;">
                            <h3 style="margin:0;">⚙️ Processing Pipeline</h3>
                            <span id="logs-timer" style="font-family:'JetBrains Mono',monospace;font-size:0.85rem;color:var(--accent-primary);font-weight:600;"></span>
                        </div>
                        <button class="logs-modal-close" onclick="closeProcessingLogs()">✕</button>
                    </div>
                    <div class="logs-modal-body">
                        <div id="pipeline-steps" class="pipeline-steps"></div>
                        <div class="logs-section">
                            <div class="logs-section-header">
                                <span><i data-lucide="clipboard" class="inline-icon" style="width:14px;height:14px;"></i> NodeODM Console Output</span>
                                <label class="logs-autoscroll">
                                    <input type="checkbox" id="logs-autoscroll-check" checked> Auto-scroll
                                </label>
                            </div>
                            <pre id="logs-output" class="logs-output">Loading...</pre>
                        </div>
                    </div>
                    <div class="logs-modal-footer">
                        <button class="btn btn-secondary btn-sm" onclick="refreshLogs('${projectId}')"><i data-lucide="refresh-cw" style="width:14px;height:14px;margin-right:6px;"></i> Refresh</button>
                        <button class="btn btn-danger btn-sm" onclick="cancelProcessing('${projectId}'); closeProcessingLogs();"><i data-lucide="x" class="inline-icon" style="width:16px;height:16px;margin-right:6px;"></i> Cancel Job</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }

        // Update the cancel button projectId reference
        const footer = modal.querySelector('.logs-modal-footer');
        if (footer) {
            const cancelBtn = footer.querySelector('.btn-danger');
            if (cancelBtn) {
                cancelBtn.onclick = () => { cancelProcessing(projectId); closeProcessingLogs(); };
            }
            const refreshBtn = footer.querySelector('.btn-secondary');
            if (refreshBtn) {
                refreshBtn.onclick = () => refreshLogs(projectId);
            }
        }

        modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        // Fetch status for elapsed timer
        try {
            const statusData = await apiFetch(`/api/projects/${projectId}/status/`);
            _updateLogsTimer(statusData);
        } catch (e) {}

        // Fetch and display logs
        await refreshLogs(projectId);

        // Start auto-refresh every 3 seconds
        if (logRefreshTimer) clearInterval(logRefreshTimer);
        logRefreshTimer = setInterval(() => refreshLogs(projectId), 3000);

        // Start client-side timer for logs modal
        _startLogsTimer(projectId);
    };

    let _logsTimerInterval = null;
    function _startLogsTimer(projectId) {
        if (_logsTimerInterval) clearInterval(_logsTimerInterval);
        // We'll use the status endpoint to get the start time once
        apiFetch(`/api/projects/${projectId}/status/`).then(data => {
            if (!data.processing_started_at) return;
            const startedAt = new Date(data.processing_started_at).getTime();
            const tick = () => {
                const el = document.getElementById('logs-timer');
                if (!el) { clearInterval(_logsTimerInterval); return; }
                if (data.completed_at) {
                    // Show final duration
                    el.textContent = `⏱ ${data.processing_duration || ''}`;
                    clearInterval(_logsTimerInterval);
                } else {
                    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
                    el.textContent = `⏱ ${formatElapsed(elapsed)}`;
                }
            };
            tick();
            _logsTimerInterval = setInterval(tick, 1000);
        }).catch(() => {});
    }

    function _updateLogsTimer(data) {
        const el = document.getElementById('logs-timer');
        if (el && data.processing_duration) {
            el.textContent = `⏱ ${data.processing_duration}`;
        }
    }

    window.refreshLogs = async function (projectId) {
        try {
            const data = await apiFetch(`/api/projects/${projectId}/logs/?lines=80`);

            // Update pipeline steps
            const stepsEl = document.getElementById('pipeline-steps');
            if (stepsEl && data.steps) {
                stepsEl.innerHTML = data.steps.map(step => {
                    const icons = { done: '<i data-lucide="check-circle" style="width:14px;height:14px;text-align:center;"></i>', active: '<i data-lucide="refresh-cw" style="width:14px;height:14px;margin-right:6px;"></i>', pending: '⏳' };
                    const icon = icons[step.status] || '⏳';
                    const activeClass = step.status === 'active' ? ' step-active' : '';
                    const doneClass = step.status === 'done' ? ' step-done' : '';
                    return `
                        <div class="pipeline-step${activeClass}${doneClass}">
                            <span class="step-icon">${icon}</span>
                            <div class="step-info">
                                <span class="step-name">${step.name}</span>
                                <span class="step-detail">${step.detail}</span>
                            </div>
                        </div>
                    `;
                }).join('');
            }

            // Update logs output
            const logsEl = document.getElementById('logs-output');
            if (logsEl && data.logs) {
                if (data.logs.length === 0) {
                    logsEl.textContent = 'No console output yet — task may still be queued.';
                } else {
                    logsEl.textContent = data.logs.join('\n');
                }
                // Auto-scroll to bottom
                const autoScroll = document.getElementById('logs-autoscroll-check');
                if (!autoScroll || autoScroll.checked) {
                    logsEl.scrollTop = logsEl.scrollHeight;
                }
            }

            // If the project is no longer processing, stop auto-refresh
            if (data.status && !ACTIVE_STATUSES.has(data.status)) {
                if (logRefreshTimer) {
                    clearInterval(logRefreshTimer);
                    logRefreshTimer = null;
                }
            }
        } catch (err) {
            console.error('Failed to fetch logs:', err);
        }
    };

    window.closeProcessingLogs = function () {
        const modal = document.getElementById('processing-logs-modal');
        if (modal) modal.classList.remove('active');
        document.body.style.overflow = '';

        if (logRefreshTimer) {
            clearInterval(logRefreshTimer);
            logRefreshTimer = null;
        }
        if (_logsTimerInterval) {
            clearInterval(_logsTimerInterval);
            _logsTimerInterval = null;
        }
    };

    // ── Deletion ────────────────────────────────────────
    window.deleteProject = async function (projectId, projectName) {
        if (!confirm(`Delete project "${projectName}"? This will permanently remove all data.`)) {
            return;
        }

        try {
            await apiFetch(`/api/projects/${projectId}/delete/`, {
                method: 'POST',
            });

            showToast(`Project "${projectName}" deleted`, 'info');

            // Remove card with animation
            const card = document.getElementById(`project-${projectId}`);
            if (card) {
                card.style.transition = 'opacity 0.3s, transform 0.3s';
                card.style.opacity = '0';
                card.style.transform = 'scale(0.95)';
                setTimeout(() => card.remove(), 300);
            }

            stopPolling(projectId);
        } catch (err) {
            showToast(err.message, 'error');
        }
    };

    // ── Keyboard shortcuts ──────────────────────────────
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeNewProjectModal();
            if (window.closeUploadPanel) window.closeUploadPanel();
            if (window.closeProcessingLogs) window.closeProcessingLogs();
        }
        if (e.key === 'n' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            openNewProjectModal();
        }
    });

})();

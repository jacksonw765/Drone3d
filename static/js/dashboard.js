/**
 * Drone3D — Dashboard Controller
 *
 * Handles project creation, status polling, and project management.
 */

(function () {
    'use strict';

    // ── Status Polling ──────────────────────────────────
    const POLL_INTERVAL = 5000;
    const ACTIVE_STATUSES = new Set(['queued', 'preprocessing', 'processing']);
    let pollTimers = {};

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

        // Update progress bar
        let progressBar = card.querySelector('.progress-bar');
        if (ACTIVE_STATUSES.has(data.status)) {
            if (!progressBar) {
                // Create progress bar
                const body = card.querySelector('.card-body');
                const progressHtml = `
                    <div class="progress-bar">
                        <div class="progress-bar-fill" style="width: ${data.progress}%"></div>
                    </div>
                    <div class="progress-text">${data.progress}%</div>
                `;
                body.insertAdjacentHTML('beforeend', progressHtml);
            } else {
                const fill = progressBar.querySelector('.progress-bar-fill');
                if (fill) fill.style.width = `${data.progress}%`;
                const text = card.querySelector('.progress-text');
                if (text) text.textContent = `${data.progress}%`;
            }
        } else {
            // Remove progress bar for completed/failed
            if (progressBar) progressBar.remove();
            const progressText = card.querySelector('.progress-text');
            if (progressText) progressText.remove();
        }

        // Update footer buttons
        const footer = card.querySelector('.card-footer');
        if (footer) {
            if (data.status === 'completed') {
                footer.innerHTML = `
                    <a href="/viewer/${projectId}/" class="btn btn-primary btn-sm">
                        🌐 View 3D Model
                    </a>
                    <button class="btn btn-danger btn-sm" onclick="deleteProject('${projectId}', '${data.name}')">
                        🗑
                    </button>
                `;
            } else if (data.status === 'failed') {
                footer.innerHTML = `
                    <button class="btn btn-secondary btn-sm" onclick="openUploadPanel('${projectId}')">
                        📤 Upload More
                    </button>
                    <button class="btn btn-primary btn-sm" onclick="startProcessing('${projectId}')" id="btn-process-${projectId}">
                        ▶ Retry Process
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="deleteProject('${projectId}', '${data.name}')">
                        🗑
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
        out_of_memory: '💾',
        insufficient_images: '📸',
        reconstruction_failed: '🔺',
        georeferencing_failed: '🌐',
        densification_failed: '💥',
        mesh_failed: '🕸️',
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
                    💡 ${detail.suggestion || 'Try re-running with a lower quality preset.'}
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
                        <span class="text-sm text-secondary">Processing...</span>
                        <span></span>
                    `;
                }
            }
        } catch (err) {
            showToast(err.message, 'error');
            if (btn) btn.disabled = false;
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
        }
        if (e.key === 'n' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            openNewProjectModal();
        }
    });

})();

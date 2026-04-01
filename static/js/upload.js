/**
 * Drone3D — Upload Handler
 *
 * Drag-and-drop file upload with type detection, progress tracking,
 * and multi-file support. No external dependencies.
 */

(function () {
    'use strict';

    // ── State ───────────────────────────────────────────
    let currentProjectId = null;
    let uploadQueue = [];
    let isUploading = false;

    const ACCEPTED_EXTENSIONS = new Set([
        '.jpg', '.jpeg', '.tif', '.tiff', '.png', '.dng',
        '.mp4', '.mov', '.lrv', '.ts',
        '.srt',
    ]);

    const FILE_TYPE_MAP = {
        '.jpg': 'image', '.jpeg': 'image', '.tif': 'image',
        '.tiff': 'image', '.png': 'image', '.dng': 'image',
        '.mp4': 'video', '.mov': 'video', '.lrv': 'video', '.ts': 'video',
        '.srt': 'srt',
    };

    const FILE_ICONS = {
        image: { class: 'file-icon-image', emoji: '<i data-lucide="image" style="width:14px;height:14px;margin-right:6px;"></i>' },
        video: { class: 'file-icon-video', emoji: '<i data-lucide="clapperboard" style="width:14px;height:14px;margin-right:6px;"></i>' },
        srt: { class: 'file-icon-srt', emoji: '<i data-lucide="map-pin" style="width:14px;height:14px;margin-right:6px;"></i>' },
    };

    // ── Initialization ──────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        const zone = document.getElementById('upload-zone');
        const fileInput = document.getElementById('file-input');

        if (!zone || !fileInput) return;

        // Click to browse
        zone.addEventListener('click', () => fileInput.click());

        // File input change
        fileInput.addEventListener('change', (e) => {
            handleFiles(Array.from(e.target.files));
            e.target.value = '';
        });

        // Drag events
        zone.addEventListener('dragenter', (e) => {
            e.preventDefault();
            zone.classList.add('drag-over');
        });

        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('drag-over');
        });

        zone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            if (!zone.contains(e.relatedTarget)) {
                zone.classList.remove('drag-over');
            }
        });

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            const files = Array.from(e.dataTransfer.files);
            handleFiles(files);
        });
    });

    // ── File handling ───────────────────────────────────
    function handleFiles(files) {
        const validFiles = files.filter(f => {
            const ext = getExtension(f.name);
            if (!ACCEPTED_EXTENSIONS.has(ext)) {
                showToast(`Skipped unsupported file: ${f.name}`, 'warning');
                return false;
            }
            return true;
        });

        if (validFiles.length === 0) return;

        validFiles.forEach(file => {
            const ext = getExtension(file.name);
            const type = FILE_TYPE_MAP[ext] || 'unknown';
            addFileToList(file, type);
            uploadQueue.push({ file, type });
        });

        processUploadQueue();
        updateUploadSummary();
    }

    function getExtension(filename) {
        const idx = filename.lastIndexOf('.');
        return idx >= 0 ? filename.substring(idx).toLowerCase() : '';
    }

    // ── UI: File list ───────────────────────────────────
    function addFileToList(file, type) {
        const list = document.getElementById('file-list');
        if (!list) return;

        const icon = FILE_ICONS[type] || { class: '', emoji: '<i data-lucide="file" style="width:14px;height:14px;margin-right:6px;"></i>' };
        const fileId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

        const item = document.createElement('div');
        item.className = 'file-item';
        item.id = fileId;
        item.dataset.filename = file.name;

        item.innerHTML = `
            <div class="file-icon ${icon.class}">${icon.emoji}</div>
            <div class="file-info">
                <div class="file-name" title="${file.name}">${file.name}</div>
                <div class="file-size">${formatBytes(file.size)}</div>
            </div>
            <div class="file-progress" id="${fileId}-progress">
                <div class="file-progress-fill" style="width: 0%"></div>
            </div>
        `;

        list.appendChild(item);
        return fileId;
    }

    function markFileComplete(filename) {
        const list = document.getElementById('file-list');
        if (!list) return;

        const items = list.querySelectorAll('.file-item');
        items.forEach(item => {
            if (item.dataset.filename === filename) {
                const progress = item.querySelector('.file-progress');
                if (progress) {
                    progress.outerHTML = '<span class="file-status-check">✓</span>';
                }
            }
        });
    }

    function markFileError(filename) {
        const list = document.getElementById('file-list');
        if (!list) return;

        const items = list.querySelectorAll('.file-item');
        items.forEach(item => {
            if (item.dataset.filename === filename) {
                const progress = item.querySelector('.file-progress');
                if (progress) {
                    progress.outerHTML = '<span style="color:#ef4444;">✕</span>';
                }
            }
        });
    }

    function updateUploadSummary() {
        const summary = document.getElementById('upload-summary');
        if (!summary) return;

        const list = document.getElementById('file-list');
        const items = list ? list.querySelectorAll('.file-item') : [];
        const completed = list ? list.querySelectorAll('.file-status-check') : [];

        summary.textContent = `${completed.length}/${items.length} files uploaded`;
    }

    // ── Upload queue processing ─────────────────────────
    async function processUploadQueue() {
        if (isUploading || uploadQueue.length === 0 || !currentProjectId) return;
        isUploading = true;

        while (uploadQueue.length > 0) {
            const { file, type } = uploadQueue.shift();
            try {
                await uploadSingleFile(file);
                markFileComplete(file.name);
            } catch (err) {
                markFileError(file.name);
                showToast(`Failed to upload ${file.name}: ${err.message}`, 'error');
            }
            updateUploadSummary();
        }

        isUploading = false;
    }

    async function uploadSingleFile(file) {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`/api/projects/${currentProjectId}/upload/`, {
            method: 'POST',
            headers: {
                'X-CSRFToken': getCsrfToken(),
            },
            body: formData,
        });

        const data = await response.json().catch(() => null);

        if (!response.ok) {
            const errorMsg = (data && data.error) ? data.error : `Upload failed (${response.status})`;
            if (data && data.traceback) {
                console.error('Server traceback:', data.traceback);
            }
            throw new Error(errorMsg);
        }

        return data;
    }

    // ── Public API ──────────────────────────────────────
    window.openUploadPanel = function (projectId) {
        currentProjectId = projectId;

        // Clear previous file list
        const fileList = document.getElementById('file-list');
        if (fileList) fileList.innerHTML = '';

        const summary = document.getElementById('upload-summary');
        if (summary) summary.textContent = '';

        uploadQueue = [];
        isUploading = false;

        const modal = document.getElementById('upload-modal');
        if (modal) modal.classList.add('active');
    };

    window.closeUploadPanel = function () {
        const modal = document.getElementById('upload-modal');
        if (modal) modal.classList.remove('active');

        // Refresh page to show updated file counts
        if (currentProjectId) {
            setTimeout(() => window.location.reload(), 300);
        }
    };
})();

/**
 * Drone3D — AI Query Interface
 *
 * Chat-style panel for natural language questions about the
 * reconstructed scene. Interfaces with the AI query API.
 */

(function() {
    'use strict';

    const PROJECT_ID = window.VIEWER_CONFIG?.projectId;
    if (!PROJECT_ID) return;

    let panelEl = null;
    let chatHistoryEl = null;
    let inputEl = null;
    let isQuerying = false;

    const SUGGESTED_QUERIES = [
        "How many buildings are in the area?",
        "Where is the best landing zone?",
        "What obstacles are present?",
        "Summarize the scene",
        "Are there any vehicles?",
    ];

    // ── Build the chat panel ───────────────────────────
    function createPanel() {
        const container = document.getElementById('viewer-container');
        if (!container) return;

        panelEl = document.createElement('div');
        panelEl.id = 'ai-query-panel';
        panelEl.className = 'ai-query-panel';
        panelEl.innerHTML = `
            <div class="ai-panel-header">
                <div class="ai-panel-title">
                    <span class="ai-icon"><i data-lucide="bot" style="width:20px;height:20px;margin-right:8px;"></i></span>
                    <span>Scene Intelligence</span>
                </div>
                <button class="ai-panel-close" onclick="window.D3D_AI.togglePanel()" title="Close">✕</button>
            </div>

            <div class="ai-chat-history" id="ai-chat-history">
                <div class="ai-welcome">
                    <div class="ai-welcome-icon"><i data-lucide="satellite" class="inline-icon" style="width:16px;height:16px;"></i>️</div>
                    <h3>Scene Intelligence</h3>
                    <p>Ask questions about the reconstructed area using natural language.</p>
                    <div class="ai-suggestions">
                        ${SUGGESTED_QUERIES.map(q => `
                            <button class="ai-suggestion" onclick="window.D3D_AI.query('${q.replace(/'/g, "\\'")}')">
                                ${q}
                            </button>
                        `).join('')}
                    </div>
                </div>
            </div>

            <div class="ai-input-area">
                <div class="ai-input-row">
                    <input type="text" class="ai-input" id="ai-query-input"
                        placeholder="Ask about the scene..."
                        onkeydown="if(event.key==='Enter')window.D3D_AI.submitQuery()">
                    <button class="ai-send-btn" id="ai-send-btn"
                        onclick="window.D3D_AI.submitQuery()">
                        <span class="ai-send-icon">→</span>
                    </button>
                </div>
                <div class="ai-status" id="ai-status"></div>
            </div>
        `;

        container.parentNode.appendChild(panelEl);
        chatHistoryEl = document.getElementById('ai-chat-history');
        inputEl = document.getElementById('ai-query-input');
    }

    // ── Toggle panel visibility ────────────────────────
    function togglePanel() {
        if (!panelEl) createPanel();
        if (!panelEl) return;
        panelEl.classList.toggle('open');
        if (panelEl.classList.contains('open') && inputEl) {
            inputEl.focus();
        }
    }

    // ── Submit a query ─────────────────────────────────
    async function submitQuery() {
        if (!inputEl) return;
        const question = inputEl.value.trim();
        if (!question || isQuerying) return;
        inputEl.value = '';
        await query(question);
    }

    async function query(question) {
        if (isQuerying) return;
        isQuerying = true;

        const sendBtn = document.getElementById('ai-send-btn');
        let loadingId = null;

        try {
            // Clear welcome if present
            const welcome = chatHistoryEl?.querySelector('.ai-welcome');
            if (welcome) welcome.remove();

            // Add user message
            appendMessage('user', question);

            // Show loading
            loadingId = appendMessage('ai', '<div class="ai-loading"><span></span><span></span><span></span></div>', true);

            updateStatus('Analyzing...');
            if (sendBtn) sendBtn.disabled = true;

            const csrfToken = getCsrfToken();
            const resp = await fetch(`/ai/query/${PROJECT_ID}/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken,
                },
                body: JSON.stringify({ question }),
            });

            if (!resp.ok) {
                throw new Error(`Server error (${resp.status})`);
            }

            const data = await resp.json();

            removeMessage(loadingId);
            loadingId = null;

            if (data.error) {
                appendMessage('ai', `<div class="ai-error">${escapeHtml(data.answer || data.error)}</div>`);
            } else {
                const answer = formatAnswer(data.answer);
                appendMessage('ai', answer);

                if (data.annotations_referenced) {
                    appendMeta(`Based on ${data.annotations_referenced} annotations`);
                }
            }
        } catch (e) {
            if (loadingId) removeMessage(loadingId);
            try {
                appendMessage('ai', `<div class="ai-error">Connection error: ${escapeHtml(e.message || 'Is Ollama running?')}</div>`);
            } catch (_) { /* DOM may be unavailable — swallow to let finally run */ }
        } finally {
            isQuerying = false;
            updateStatus('');
            if (sendBtn) sendBtn.disabled = false;
            if (inputEl) inputEl.focus();
        }
    }

    // ── Message rendering ──────────────────────────────
    let msgCounter = 0;

    function appendMessage(role, content, isRaw = false) {
        if (!chatHistoryEl) return null;

        const id = `msg-${++msgCounter}`;
        const div = document.createElement('div');
        div.className = `ai-message ai-message-${role}`;
        div.id = id;

        if (role === 'user') {
            div.innerHTML = `
                <div class="ai-msg-bubble ai-msg-user">
                    ${escapeHtml(content)}
                </div>
            `;
        } else {
            div.innerHTML = `
                <div class="ai-msg-bubble ai-msg-ai">
                    ${isRaw ? content : content}
                </div>
            `;
        }

        chatHistoryEl.appendChild(div);
        chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
        return id;
    }

    function appendMeta(text) {
        const div = document.createElement('div');
        div.className = 'ai-msg-meta';
        div.textContent = text;
        chatHistoryEl.appendChild(div);
    }

    function removeMessage(id) {
        const el = document.getElementById(id);
        if (el) el.remove();
    }

    function formatAnswer(text) {
        // Basic markdown-lite formatting
        let formatted = escapeHtml(text);

        // Bold
        formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        // Numbered lists
        formatted = formatted.replace(/^(\d+)\.\s+(.+)$/gm, '<div class="ai-list-item"><span class="list-num">$1.</span> $2</div>');

        // Bullet points
        formatted = formatted.replace(/^[-•]\s+(.+)$/gm, '<div class="ai-list-item"><span class="list-bullet">•</span> $1</div>');

        // Headers (lines in ALL CAPS followed by content)
        formatted = formatted.replace(/^([A-Z][A-Z /&-]{2,})$/gm, '<div class="ai-section-header">$1</div>');

        // Coordinates
        formatted = formatted.replace(
            /(-?\d{1,3}\.\d{3,8})\s*,\s*(-?\d{1,3}\.\d{3,8})/g,
            '<span class="ai-coord" title="Click to view">$1, $2</span>'
        );

        // Paragraphs
        formatted = formatted.replace(/\n\n/g, '</p><p>');
        formatted = '<p>' + formatted + '</p>';

        return formatted;
    }

    function updateStatus(text) {
        const el = document.getElementById('ai-status');
        if (el) el.textContent = text;
    }

    // ── Utilities ──────────────────────────────────────
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function getCsrfToken() {
        const cookie = document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='));
        return cookie ? cookie.split('=')[1] : '';
    }

    // ── Add toggle button to toolbar ───────────────────
    function addToolbarButton() {
        const toolbar = document.getElementById('viewer-toolbar');
        if (!toolbar) return;

        const divider = document.createElement('div');
        divider.className = 'viewer-toolbar-divider';

        const btn = document.createElement('button');
        btn.className = 'viewer-toolbar-btn';
        btn.id = 'btn-ai-query';
        btn.title = 'AI Intelligence Query';
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';
        btn.onclick = togglePanel;

        // Insert before the last buttons (settings, fullscreen)
        const settingsBtn = document.getElementById('btn-toggle-panel');
        if (settingsBtn) {
            toolbar.insertBefore(divider, settingsBtn);
            toolbar.insertBefore(btn, settingsBtn);
        } else {
            toolbar.appendChild(divider);
            toolbar.appendChild(btn);
        }
    }

    // ── Initialize ─────────────────────────────────────
    function init() {
        addToolbarButton();
        createPanel();
    }

    // Expose
    window.D3D_AI = {
        init,
        togglePanel,
        submitQuery,
        query,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

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
                    <span class="ai-icon">🤖</span>
                    <span>Scene Intelligence</span>
                </div>
                <button class="ai-panel-close" onclick="window.D3D_AI.togglePanel()" title="Close">✕</button>
            </div>

            <div class="ai-chat-history" id="ai-chat-history">
                <div class="ai-welcome">
                    <div class="ai-welcome-icon">🛰️</div>
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

        // Clear welcome if present
        const welcome = chatHistoryEl.querySelector('.ai-welcome');
        if (welcome) welcome.remove();

        // Add user message
        appendMessage('user', question);

        // Show loading
        const loadingId = appendMessage('ai', '<div class="ai-loading"><span></span><span></span><span></span></div>', true);

        updateStatus('Analyzing...');
        const sendBtn = document.getElementById('ai-send-btn');
        if (sendBtn) sendBtn.disabled = true;

        try {
            const csrfToken = getCsrfToken();
            const resp = await fetch(`/ai/query/${PROJECT_ID}/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken,
                },
                body: JSON.stringify({ question }),
            });

            const data = await resp.json();

            // Remove loading
            removeMessage(loadingId);

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
            removeMessage(loadingId);
            appendMessage('ai', `<div class="ai-error">Connection error. Is Ollama running?</div>`);
        }

        isQuerying = false;
        updateStatus('');
        if (sendBtn) sendBtn.disabled = false;
        if (inputEl) inputEl.focus();
    }

    // ── Message rendering ──────────────────────────────
    let msgCounter = 0;

    function appendMessage(role, content, isRaw = false) {
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
        btn.textContent = '🤖';
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

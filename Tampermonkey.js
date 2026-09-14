// ==UserScript==
// @name         ChatGPT Universal Exporter (Markdown Support)
// @version      2.0.0
// @description  User-centric ZIP exporter for personal/team/project spaces. Supports JSON & Markdown formats. Based on ChatGPT Universal Exporter.
// @author       huhu
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @license      MIT
// @source       https://greasyfork.org/scripts/538495-chatgpt-universal-exporter
// @namespace    https://github.com/huhusmang/ChatGPT-Exporter
// @homepageURL  https://greasyfork.org/zh-CN/scripts/556233-chatgpt-universal-exporter-markdown-support
// @downloadURL  https://update.greasyfork.org/scripts/556233/ChatGPT%20Universal%20Exporter%20(Markdown%20Support).user.js
// @updateURL    https://update.greasyfork.org/scripts/556233/ChatGPT%20Universal%20Exporter%20(Markdown%20Support).meta.js
// ==/UserScript==

/* ============================================================
 * v1.4.3 changes (single project export polish)
 * ------------------------------------------------------------
 *  - Hydrate selected project metadata from the project list API
 *  - Remove hardcoded project-name prompts
 *
 * v1.4.2 changes (single project export)
 * ------------------------------------------------------------
 *  - Add "导出当前项目" to export only the current g-p-* project/GPT
 *  - Keep project exports grouped under the project folder in ZIP
 *
 * v1.4.1 changes (project deep fetch)
 * ------------------------------------------------------------
 *  - Avoid 422s by keeping /gizmos/{id}/conversations requests minimal
 *  - Add global conversation-list fallback for project/gizmo filtering
 *  - Show project collection diagnostics in the preview dialog
 *
 * v1.4.0 changes (robustness + resume)
 * ------------------------------------------------------------
 *  - 429 backoff retry (up to 6 attempts, exponential, honors Retry-After)
 *  - Wider pacing window (1.5-2.5s) to reduce 429 hits
 *  - Cross-batch cooldown (30s every 30 conversations)
 *  - IndexedDB cache: skip already-cached conversations by default,
 *    so a crashed/aborted run can be resumed
 *  - Per-conversation error tolerance: single failures no longer
 *    abort the whole batch; failed IDs are reported in the ZIP
 *  - Picker UI gains "Use cache" / "Re-fetch all" + cache size + clear
 * ============================================================ */

/* ============================================================
    v1.3.2 变更 (项目空间分页修复)
    ------------------------------------------------------------
    • 项目空间列表显式使用 limit=50 拉取
    • 支持根据 cursor 分页获取全部项目
    • 复用分页逻辑，避免默认只显示 5 个项目
    ========================================================== */

(function () {
    'use strict';

    // --- 配置与全局变量 ---
    const BASE_DELAY = 1500;
    const JITTER = 1000;
    const PAGE_LIMIT = 100;
    const PROJECT_SIDEBAR_PREVIEW = 5;
    const PROJECT_SIDEBAR_LIMIT = 50;
    const MAX_429_ATTEMPTS = 6;
    const COOLDOWN_EVERY = 30;
    const COOLDOWN_MS = 30000;
    const CACHE_DB_NAME = 'gpt-exporter-cache';
    const CACHE_DB_VERSION = 1;
    const CACHE_STORE = 'conversations';
    const CACHE_VERSION_KEY = '__cache_version__';
    const CACHE_VERSION = 1;
    const EXPORTER_BUILD = '2.0.0';
    let accessToken = null;
    let capturedWorkspaceIds = new Set(); // 使用Set存储网络拦截到的ID，确保唯一性
    let exportDiagnostics = [];

    function recordDiagnostic(message) {
        const line = `[Exporter] ${message}`;
        exportDiagnostics.push(line);
        if (exportDiagnostics.length > 300) {
            exportDiagnostics = exportDiagnostics.slice(-300);
        }
        console.info(line);
    }

    // --- 核心：网络拦截与信息捕获 ---
    (function interceptNetwork() {
        const rawFetch = window.fetch;
        window.fetch = async function (resource, options) {
            tryCaptureToken(options?.headers);
            if (options?.headers?.['ChatGPT-Account-Id']) {
                const id = options.headers['ChatGPT-Account-Id'];
                if (id && !capturedWorkspaceIds.has(id)) {
                    console.log('🎯 [Fetch] 捕获到 Workspace ID:', id);
                    capturedWorkspaceIds.add(id);
                }
            }
            return rawFetch.apply(this, arguments);
        };

        const rawOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function () {
            this.addEventListener('readystatechange', () => {
                if (this.readyState === 4) {
                    try {
                        tryCaptureToken(this.getRequestHeader('Authorization'));
                        const id = this.getRequestHeader('ChatGPT-Account-Id');
                        if (id && !capturedWorkspaceIds.has(id)) {
                            console.log('🎯 [XHR] 捕获到 Workspace ID:', id);
                            capturedWorkspaceIds.add(id);
                        }
                    } catch (_) {}
                }
            });
            return rawOpen.apply(this, arguments);
        };
    })();

    function tryCaptureToken(header) {
        if (!header) return;
        const h = typeof header === 'string' ? header : header instanceof Headers ? header.get('Authorization') : header.Authorization || header.authorization;
        if (h?.startsWith('Bearer ')) {
        const token = h.slice(7);
        // [v8.2.0 修复] 在捕获源头增加验证，拒绝已知的无效占位符Token
        if (token && token.toLowerCase() !== 'dummy') {
            accessToken = token;
        }
        }
    }

    async function ensureAccessToken() {
        if (accessToken) return accessToken;
        try {
            const session = await (await fetch('/api/auth/session?unstable_client=true')).json();
            if (session.accessToken) {
                accessToken = session.accessToken;
                return accessToken;
            }
        } catch (_) {}
        alert('无法获取 Access Token。请刷新页面或打开任意一个对话后再试。');
        return null;
    }

    // --- 辅助函数 ---
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const jitter = () => BASE_DELAY + Math.random() * JITTER;
    const sanitizeFilename = (name) => name.replace(/[\/\\?%*:|"<>]/g, '-').trim();
    const decodeText = (value) => {
        try { return decodeURIComponent(value || ''); } catch (_) { return value || ''; }
    };

    function parseProjectFromText(value) {
        const text = String(value || '').trim();
        if (!text) return null;
        const pathPart = (() => {
            try { return new URL(text).pathname; } catch (_) { return text; }
        })();
        const segmentMatch = pathPart.match(/\/g\/([^/?#]+)/) || pathPart.match(/(^|\/)(g-p-[^/?#]+)/);
        const segment = decodeText(segmentMatch?.[1] || segmentMatch?.[2] || text);
        const idMatch = segment.match(/g-p-[0-9a-f]{32}/i) || text.match(/g-p-[0-9a-f]{32}/i);
        if (!idMatch) return null;
        const id = idMatch[0];
        const rawSlug = segment.startsWith(id) ? segment.slice(id.length).replace(/^-+/, '') : '';
        return {
            id,
            title: rawSlug ? decodeText(rawSlug).replace(/[-_]+/g, ' ') : id
        };
    }

    function getCurrentProjectFromLocation() {
        return parseProjectFromText(window.location.href);
    }

    // --- IndexedDB 会话级缓存（断点续传 / 跳过已导出对话）---
    const ExportCache = (() => {
        let dbPromise = null;
        let available = true;

        function openDb() {
            if (!dbPromise) {
                if (typeof indexedDB === 'undefined') {
                    available = false;
                    dbPromise = Promise.resolve(null);
                } else {
                    dbPromise = new Promise((resolve) => {
                        const req = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
                        req.onupgradeneeded = (e) => {
                            const db = e.target.result;
                            if (!db.objectStoreNames.contains(CACHE_STORE)) {
                                db.createObjectStore(CACHE_STORE, { keyPath: 'id' });
                            }
                        };
                        req.onsuccess = () => {
                            const db = req.result;
                            try {
                                const tx = db.transaction(CACHE_STORE, 'readwrite');
                                tx.objectStore(CACHE_STORE).put({ id: CACHE_VERSION_KEY, v: CACHE_VERSION });
                                tx.oncomplete = () => resolve(db);
                                tx.onerror = () => resolve(db);
                                tx.onabort = () => resolve(db);
                            } catch (_) {
                                resolve(db);
                            }
                        };
                        req.onerror = () => { available = false; resolve(null); };
                        req.onblocked = () => { available = false; resolve(null); };
                    }).then(async (db) => {
                        if (!db) return null;
                        try {
                            const tx = db.transaction(CACHE_STORE, 'readonly');
                            const v = await new Promise((resolve) => {
                                const r = tx.objectStore(CACHE_STORE).get(CACHE_VERSION_KEY);
                                r.onsuccess = () => resolve(r.result?.v);
                                r.onerror = () => resolve(null);
                            });
                            if (v !== CACHE_VERSION) {
                                await new Promise((resolve) => {
                                    const t = db.transaction(CACHE_STORE, 'readwrite');
                                    t.objectStore(CACHE_STORE).clear();
                                    t.objectStore(CACHE_STORE).put({ id: CACHE_VERSION_KEY, v: CACHE_VERSION });
                                    t.oncomplete = () => resolve();
                                    t.onerror = () => resolve();
                                    t.onabort = () => resolve();
                                });
                                console.warn(`[Exporter] Cache schema version bumped (was ${v}, now ${CACHE_VERSION}); cache cleared.`);
                            }
                        } catch (_) {}
                        return db;
                    });
                }
            }
            return dbPromise;
        }

        async function ready() {
            const db = await openDb();
            if (!db) return false;
            return true;
        }

        async function get(id) {
            if (!available) return null;
            const db = await openDb();
            if (!db) return null;
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction(CACHE_STORE, 'readonly');
                    const r = tx.objectStore(CACHE_STORE).get(id);
                    r.onsuccess = () => resolve(r.result?.data || null);
                    r.onerror = () => resolve(null);
                } catch (_) { resolve(null); }
            });
        }

        async function put(id, data) {
            if (!available) return false;
            const db = await openDb();
            if (!db) return false;
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction(CACHE_STORE, 'readwrite');
                    tx.objectStore(CACHE_STORE).put({ id, data, savedAt: Date.now() });
                    tx.oncomplete = () => resolve(true);
                    tx.onerror = () => resolve(false);
                    tx.onabort = () => resolve(false);
                } catch (_) { resolve(false); }
            });
        }

        async function clear() {
            if (!available) return false;
            const db = await openDb();
            if (!db) return false;
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction(CACHE_STORE, 'readwrite');
                    const store = tx.objectStore(CACHE_STORE);
                    store.clear();
                    store.put({ id: CACHE_VERSION_KEY, v: CACHE_VERSION });
                    tx.oncomplete = () => resolve(true);
                    tx.onerror = () => resolve(false);
                    tx.onabort = () => resolve(false);
                } catch (_) { resolve(false); }
            });
        }

        async function size() {
            if (!available) return 0;
            const db = await openDb();
            if (!db) return 0;
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction(CACHE_STORE, 'readonly');
                    const r = tx.objectStore(CACHE_STORE).count();
                    r.onsuccess = () => resolve(Math.max(0, (r.result || 0) - 1));
                    r.onerror = () => resolve(0);
                } catch (_) { resolve(0); }
            });
        }

        return { ready, get, put, clear, size, get available() { return available; } };
    })();
    // 提前打开 DB，避免首次导出时阻塞
    ExportCache.ready();
    const normalizeEpochSeconds = (value) => {
        if (!value) return 0;
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value > 1e12 ? Math.floor(value / 1000) : value;
        }
        if (typeof value === 'string') {
            if (/^\d+(\.\d+)?$/.test(value)) return normalizeEpochSeconds(Number(value));
            const parsed = Date.parse(value);
            if (!Number.isNaN(parsed)) {
                return Math.floor(parsed / 1000);
            }
        }
        return 0;
    };
    const formatTimestamp = (value) => {
        const seconds = normalizeEpochSeconds(value);
        if (!seconds) return '';
        const date = new Date(seconds * 1000);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    };
    const parseDateInputToEpoch = (value, isEnd = false) => {
        if (!value) return null;
        const parts = value.split('-').map(Number);
        if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
        const [year, month, day] = parts;
        const date = isEnd
            ? new Date(year, month - 1, day, 23, 59, 59, 999)
            : new Date(year, month - 1, day, 0, 0, 0, 0);
        const epochMs = date.getTime();
        return Number.isNaN(epochMs) ? null : Math.floor(epochMs / 1000);
    };

    /**
     * [新增] 从Cookie中获取 oai-device-id
     * @returns {string|null} - 返回设备ID或null
     */
    function getOaiDeviceId() {
        const cookieString = document.cookie;
        const match = cookieString.match(/oai-did=([^;]+)/);
        return match ? match[1] : null;
    }

    function generateUniqueFilename(convData) {
        const convId = convData.conversation_id || '';
        const shortId = convId.includes('-') ? convId.split('-').pop() : (convId || Date.now().toString(36));
        let baseName = convData.title;
        if (!baseName || baseName.trim().toLowerCase() === 'new chat') {
            baseName = 'Untitled Conversation';
        }
        return `${sanitizeFilename(baseName)}_${shortId}.json`;
    }

    function generateMarkdownFilename(convData) {
        const jsonName = generateUniqueFilename(convData);
        return jsonName.endsWith('.json')
            ? `${jsonName.slice(0, -5)}.md`
            : `${jsonName}.md`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function previewBaseFilename(entry) {
        const convId = entry?.id || '';
        const shortId = convId.includes('-') ? convId.split('-').pop() : (convId || 'unknown');
        let baseName = entry?.title || 'Untitled Conversation';
        if (baseName.trim().toLowerCase() === 'new chat') {
            baseName = 'Untitled Conversation';
        }
        return `${sanitizeFilename(baseName)}_${shortId}`;
    }

    function buildExportPreview(entries) {
        const groups = new Map();
        entries.forEach(entry => {
            const groupName = entry?.projectTitle || '项目外 / 根目录';
            if (!groups.has(groupName)) groups.set(groupName, []);
            groups.get(groupName).push(entry);
        });
        return Array.from(groups.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, items]) => ({
                name,
                items: items.slice().sort((a, b) => (b.update_time || 0) - (a.update_time || 0))
            }));
    }

    function showExportPreview(entries, options = {}) {
        const { mode = 'personal', workspaceId = null, exportType = 'full' } = options;
        return new Promise((resolve) => {
            const existing = document.getElementById('export-preview-overlay');
            if (existing) existing.remove();

            const groups = buildExportPreview(entries);
            const totalConversations = entries.length;
            const totalContentFiles = totalConversations * 2;
            const totalFiles = totalContentFiles + 1;
            const modeLabel = mode === 'team' ? '团队空间' : mode === 'project' ? '项目空间' : '个人空间';
            const typeLabel = exportType === 'selected' ? '选择导出' : '导出全部';
            const maxPreviewPerGroup = 80;
            const diagnosticHtml = exportDiagnostics.length > 0
                ? `<details style="margin-top:10px; font-size:12px; color:#555;">
                    <summary style="cursor:pointer;">采集诊断 · ${escapeHtml(EXPORTER_BUILD)}</summary>
                    <pre style="white-space:pre-wrap; max-height:120px; overflow:auto; background:#f8fafc; border:1px solid #e5e7eb; border-radius:6px; padding:8px;">${escapeHtml(exportDiagnostics.slice(-80).join('\n'))}</pre>
                  </details>`
                : `<div style="margin-top:8px; font-size:12px; color:#999;">采集版本：${escapeHtml(EXPORTER_BUILD)}</div>`;

            const overlay = document.createElement('div');
            overlay.id = 'export-preview-overlay';
            Object.assign(overlay.style, {
                position: 'fixed', inset: '0', backgroundColor: 'rgba(0,0,0,.5)', zIndex: '99999',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
            });

            const dialog = document.createElement('div');
            Object.assign(dialog.style, {
                background: '#fff', color: '#333', width: '820px', maxWidth: 'calc(100vw - 32px)',
                maxHeight: 'calc(100vh - 48px)', borderRadius: '12px', boxShadow: '0 10px 30px rgba(0,0,0,.25)',
                fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', overflow: 'hidden'
            });

            const groupHtml = groups.map(group => {
                const hiddenCount = Math.max(0, group.items.length - maxPreviewPerGroup);
                const filesHtml = group.items.slice(0, maxPreviewPerGroup).map(entry => {
                    const base = previewBaseFilename(entry);
                    const time = formatTimestamp(entry.update_time || entry.create_time) || '未知时间';
                    return `<li style="margin-bottom:6px;">
                        <div style="font-weight:600; word-break:break-all;">${escapeHtml(entry.title || 'Untitled Conversation')}</div>
                        <div style="font-size:12px; color:#666; word-break:break-all;">${escapeHtml(base)}.json / ${escapeHtml(base)}.md · ${escapeHtml(time)}</div>
                    </li>`;
                }).join('');
                return `<details open style="border:1px solid #e5e7eb; border-radius:8px; margin-bottom:10px; background:#fff;">
                    <summary style="padding:10px 12px; cursor:pointer; font-weight:700; background:#f9fafb; border-radius:8px;">
                        ${escapeHtml(group.name)} · ${group.items.length} 个对话 · ${group.items.length * 2} 个内容文件
                    </summary>
                    <ul style="list-style:none; padding:10px 12px 12px 12px; margin:0;">${filesHtml}</ul>
                    ${hiddenCount > 0 ? `<div style="padding:0 12px 12px 12px; color:#666; font-size:12px;">还有 ${hiddenCount} 个对话未在预览中展开，仍会导出。</div>` : ''}
                </details>`;
            }).join('');

            dialog.innerHTML = `
                <div style="padding:18px 20px; border-bottom:1px solid #e5e7eb;">
                    <h2 style="margin:0 0 8px 0; font-size:18px;">导出预览</h2>
                    <div style="font-size:13px; color:#555;">
                        ${escapeHtml(modeLabel)} · ${escapeHtml(typeLabel)}${workspaceId ? ` · ${escapeHtml(workspaceId)}` : ''}
                    </div>
                    <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap; font-size:13px;">
                        <span style="background:#eef2ff; color:#4338ca; padding:4px 8px; border-radius:999px;">${groups.length} 个分组/项目</span>
                        <span style="background:#ecfdf5; color:#047857; padding:4px 8px; border-radius:999px;">${totalConversations} 个对话</span>
                        <span style="background:#f5f3ff; color:#6d28d9; padding:4px 8px; border-radius:999px;">${totalFiles} 个 ZIP 内文件（含 EXPORT_REPORT.json）</span>
                    </div>
                    ${diagnosticHtml}
                </div>
                <div style="padding:14px 20px; overflow:auto; flex:1; background:#fafafa;">
                    ${groupHtml || '<div style="color:#999;">没有可导出的对话。</div>'}
                </div>
                <div style="padding:14px 20px; border-top:1px solid #e5e7eb; display:flex; justify-content:space-between; align-items:center; gap:12px;">
                    <div style="font-size:12px; color:#666;">确认后才会开始拉取详情并生成 ZIP。</div>
                    <div style="display:flex; gap:8px;">
                        <button id="cancel-export-preview" style="padding:9px 14px; border:1px solid #ccc; border-radius:8px; background:#fff; cursor:pointer;">取消</button>
                        <button id="confirm-export-preview" style="padding:9px 14px; border:none; border-radius:8px; background:#10a37f; color:#fff; cursor:pointer; font-weight:700;">继续导出</button>
                    </div>
                </div>
            `;

            const close = (value) => {
                overlay.remove();
                resolve(value);
            };
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            overlay.onclick = (e) => { if (e.target === overlay) close(false); };
            dialog.querySelector('#cancel-export-preview').onclick = () => close(false);
            dialog.querySelector('#confirm-export-preview').onclick = () => close(true);
        });
    }

    async function showProjectEndpointDebugger(workspaceId = null) {
        const existing = document.getElementById('export-debug-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'export-debug-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', backgroundColor: 'rgba(0,0,0,.5)', zIndex: '100000',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const dialog = document.createElement('div');
        Object.assign(dialog.style, {
            background: '#fff', color: '#333', width: '900px', maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100vh - 48px)', borderRadius: '12px', boxShadow: '0 10px 30px rgba(0,0,0,.25)',
            fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', overflow: 'hidden'
        });
        dialog.innerHTML = `
            <div style="padding:16px 18px; border-bottom:1px solid #e5e7eb;">
                <h2 style="margin:0 0 6px 0; font-size:18px;">项目接口探测器</h2>
                <div style="font-size:12px; color:#666;">${escapeHtml(EXPORTER_BUILD)} · 只探测接口，不导出数据</div>
            </div>
            <pre id="project-debug-output" style="margin:0; padding:14px 18px; overflow:auto; flex:1; background:#0f172a; color:#e2e8f0; font-size:12px; line-height:1.45; white-space:pre-wrap;">准备探测...</pre>
            <div style="padding:12px 18px; border-top:1px solid #e5e7eb; display:flex; justify-content:flex-end; gap:8px;">
                <button id="copy-project-debug" style="padding:8px 12px; border:1px solid #ccc; border-radius:8px; background:#fff; cursor:pointer;">复制结果</button>
                <button id="close-project-debug" style="padding:8px 12px; border:none; border-radius:8px; background:#10a37f; color:#fff; cursor:pointer;">关闭</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        const outputEl = dialog.querySelector('#project-debug-output');
        const setOutput = (text) => { outputEl.textContent = text; };
        const close = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) close(); };
        dialog.querySelector('#close-project-debug').onclick = close;
        dialog.querySelector('#copy-project-debug').onclick = async () => {
            await navigator.clipboard.writeText(outputEl.textContent);
            dialog.querySelector('#copy-project-debug').textContent = '已复制';
        };

        try {
            const text = await runProjectEndpointDebug(workspaceId, (partial) => setOutput(partial));
            setOutput(text);
        } catch (err) {
            setOutput(`探测失败: ${err?.message || err}`);
            console.error('[Exporter] 项目接口探测失败:', err);
        }
    }

    async function runProjectEndpointDebug(workspaceId = null, onProgress = null) {
        if (!await ensureAccessToken()) {
            throw new Error('无法获取 Access Token');
        }
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id');
        }
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (resolvedWorkspaceId) headers['ChatGPT-Account-Id'] = resolvedWorkspaceId;

        const lines = [
            `build: ${EXPORTER_BUILD}`,
            `workspaceId: ${resolvedWorkspaceId || '(none)'}`,
            ''
        ];
        const push = (line = '') => {
            lines.push(line);
            if (onProgress) onProgress(lines.join('\n'));
        };

        const projects = await getProjectSpaces(resolvedWorkspaceId, { conversationsPerGizmo: PROJECT_SIDEBAR_PREVIEW, ownedOnly: false });
        push(`projects: ${projects.length}`);
        push('');

        for (const project of projects) {
            push(`## ${project.title} (${project.id})`);
            push(`sidebar preview: ${Array.isArray(project.conversations) ? project.conversations.length : 0}`);
            const projectResults = await probeProjectEndpoints(project, headers);
            projectResults.forEach(line => push(line));
            push('');
        }

        return lines.join('\n');
    }

    async function probeProjectEndpoints(project, headers) {
        const lines = [];
        const probes = [
            ['gizmo cursor=0', `/backend-api/gizmos/${project.id}/conversations?cursor=0`],
            ['gizmo no-query', `/backend-api/gizmos/${project.id}/conversations`],
            ['gizmo limit+cursor=0', `/backend-api/gizmos/${project.id}/conversations?limit=${PAGE_LIMIT}&cursor=0`],
            ['gizmo limit', `/backend-api/gizmos/${project.id}/conversations?limit=${PAGE_LIMIT}`],
            ['global gizmo_id', `/backend-api/conversations?offset=0&limit=${PAGE_LIMIT}&order=updated&gizmo_id=${encodeURIComponent(project.id)}`],
            ['global gizmoId', `/backend-api/conversations?offset=0&limit=${PAGE_LIMIT}&order=updated&gizmoId=${encodeURIComponent(project.id)}`],
            ['global gizmo_ids', `/backend-api/conversations?offset=0&limit=${PAGE_LIMIT}&order=updated&gizmo_ids=${encodeURIComponent(project.id)}`]
        ];

        for (const [label, url] of probes) {
            try {
                const r = await fetch(url, { headers });
                let summary = `${label}: status=${r.status}`;
                if (r.ok) {
                    const data = await r.json();
                    const items = responseItems(data);
                    const cursor = responseCursor(data);
                    const keys = Object.keys(data || {}).slice(0, 12).join(',');
                    const first = normalizeConversationListItem(items[0]);
                    summary += ` items=${items.length} cursor=${cursor || '(none)'} keys=[${keys}] firstProject=${first?.projectId || '(none)'} firstTitle=${first?.title || '(none)'}`;
                } else {
                    const body = (await r.text()).slice(0, 160).replace(/\s+/g, ' ');
                    summary += body ? ` body=${body}` : '';
                }
                lines.push(summary);
            } catch (err) {
                lines.push(`${label}: error=${err?.message || err}`);
            }
            await sleep(250);
        }
        return lines;
    }

    function cleanMessageContent(text) {
        if (!text) return '';
        return text
            .replace(/\uE200cite(?:\uE202turn\d+(?:search|view)\d+)+\uE201/gi, '')
            .replace(/cite(?:turn\d+(?:search|view)\d+)+/gi, '')
            .trim();
    }

    function processContentReferences(text, contentReferences) {
        if (!text || !Array.isArray(contentReferences) || contentReferences.length === 0) {
            return { text, footnotes: [] };
        }

        const references = contentReferences.filter(ref => ref && typeof ref.matched_text === 'string' && ref.matched_text.length > 0);
        if (references.length === 0) {
            return { text, footnotes: [] };
        }

        const getReferenceInfo = (ref) => {
            const item = Array.isArray(ref.items) ? ref.items[0] : null;
            const url = item?.url || (Array.isArray(ref.safe_urls) ? ref.safe_urls[0] : '') || '';
            const title = item?.title || '';
            let label = item?.attribution || '';
            if (!label && typeof ref.alt === 'string') {
                const match = ref.alt.match(/\[([^\]]+)\]\([^)]+\)/);
                if (match) label = match[1];
            }
            if (!label) label = title || url;
            return { url, title, label };
        };

        const footnotes = [];
        const footnoteIndexByKey = new Map();
        const citationRefs = references
            .filter(ref => ref.type === 'grouped_webpages')
            .sort((a, b) => {
                const aIdx = Number.isFinite(a.start_idx) ? a.start_idx : Number.MAX_SAFE_INTEGER;
                const bIdx = Number.isFinite(b.start_idx) ? b.start_idx : Number.MAX_SAFE_INTEGER;
                return aIdx - bIdx;
            });

        citationRefs.forEach(ref => {
            const info = getReferenceInfo(ref);
            if (!info.url) return;
            const key = `${info.url}|${info.title}`;
            if (footnoteIndexByKey.has(key)) return;
            const index = footnotes.length + 1;
            footnoteIndexByKey.set(key, index);
            footnotes.push({ index, url: info.url, title: info.title, label: info.label });
        });

        const sortedByReplacement = references
            .slice()
            .sort((a, b) => {
                const aIdx = Number.isFinite(a.start_idx) ? a.start_idx : -1;
                const bIdx = Number.isFinite(b.start_idx) ? b.start_idx : -1;
                if (aIdx !== -1 || bIdx !== -1) {
                    return bIdx - aIdx;
                }
                return (b.matched_text?.length || 0) - (a.matched_text?.length || 0);
            });

        let output = text;
        sortedByReplacement.forEach(ref => {
            if (!ref?.matched_text || ref.type === 'sources_footnote') return;
            let replacement = '';
            if (ref.type === 'grouped_webpages') {
                const info = getReferenceInfo(ref);
                if (info.url) {
                    const key = `${info.url}|${info.title}`;
                    const index = footnoteIndexByKey.get(key);
                    replacement = index ? `([${info.label}][${index}])` : (ref.alt || '');
                } else {
                    replacement = ref.alt || '';
                }
            } else {
                replacement = ref.alt || '';
            }

            if (Number.isFinite(ref.start_idx) && Number.isFinite(ref.end_idx)) {
                if (output.slice(ref.start_idx, ref.end_idx) === ref.matched_text) {
                    output = output.slice(0, ref.start_idx) + replacement + output.slice(ref.end_idx);
                    return;
                }
            }
            output = output.split(ref.matched_text).join(replacement);
        });

        return { text: output, footnotes };
    }

    function extractConversationMessages(convData) {
        const mapping = convData?.mapping;
        if (!mapping) return [];

        const messages = [];
        const mappingKeys = Object.keys(mapping);
        const branch = [];
        const ancestors = new Set();
        let cursor = convData.current_node;
        if (!cursor || !mapping[cursor]) {
            throw new Error('缺少有效 current_node；为避免混入其他分支，停止 Markdown 导出。JSON 数据仍保留。');
        }
        while (cursor) {
            if (ancestors.has(cursor) || !mapping[cursor]) throw new Error('对话分支损坏：循环或缺失父节点');
            ancestors.add(cursor);
            branch.push(cursor);
            cursor = mapping[cursor].parent;
        }
        const visited = new Set();

        const traverse = (nodeId) => {
            if (!nodeId || visited.has(nodeId)) return;
            visited.add(nodeId);
            const node = mapping[nodeId];
            if (!node) return;

            const msg = node.message;
            if (msg) {
                const author = msg.author?.role;
                const isHidden = msg.metadata?.is_visually_hidden_from_conversation ||
                    msg.metadata?.is_contextual_answers_system_message;
                if (['user', 'assistant'].includes(author) && !isHidden) {
                    const content = msg.content;
                    if (content?.content_type === 'text' && Array.isArray(content.parts)) {
                        const rawText = content.parts
                            .map(part => typeof part === 'string' ? part : (part?.text ?? ''))
                            .filter(Boolean)
                            .join('\n');
                        const contentReferences = msg.metadata?.content_references || [];
                        let processedText = rawText;
                        let footnotes = [];
                        if (Array.isArray(contentReferences) && contentReferences.length > 0) {
                            const processed = processContentReferences(rawText, contentReferences);
                            processedText = processed.text;
                            footnotes = processed.footnotes;
                        }
                        const cleaned = cleanMessageContent(processedText);
                        if (cleaned) {
                            messages.push({
                                role: author,
                                content: cleaned,
                                create_time: msg.create_time || null,
                                footnotes
                            });
                        }
                    }
                }
            }

        };
        branch.reverse().forEach(traverse);

        return messages;
    }

    function convertConversationToMarkdown(convData) {
        const messages = extractConversationMessages(convData);
        if (messages.length === 0) {
            return '# Conversation\nNo visible user or assistant messages were exported.\n';
        }

        const mdLines = [];
        messages.forEach(msg => {
            const roleLabel = msg.role === 'user' ? '# User' : '# Assistant';
            mdLines.push(roleLabel);
            mdLines.push(msg.content);
            if (Array.isArray(msg.footnotes) && msg.footnotes.length > 0) {
                mdLines.push('');
                msg.footnotes
                    .slice()
                    .sort((a, b) => a.index - b.index)
                    .forEach(note => {
                        if (!note.url) return;
                        const title = note.title ? ` "${note.title}"` : '';
                        mdLines.push(`[${note.index}]: ${note.url}${title}`);
                    });
            }
            mdLines.push('');
        });

        return mdLines.join('\n').trim() + '\n';
    }

    function downloadFile(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    // --- 导出流程核心逻辑 ---
    function getExportButton() {
        let btn = document.getElementById('gpt-rescue-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'gpt-rescue-btn';
            btn.style.display = 'none';
            btn.textContent = 'Export Conversations';
            document.body.appendChild(btn);
        }
        return btn;
    }

    async function exportConversations(options = {}) {
        const { mode = 'personal', workspaceId = null, conversationEntries = null, exportType = null, useCache = true } = options;
        const btn = getExportButton();
        btn.disabled = true;

        if (!await ensureAccessToken()) {
            btn.disabled = false;
            btn.textContent = 'Export Conversations';
            return;
        }

        const failures = [];
        const stats = { hits: 0, fetched: 0, failed: 0 };
        const processedSinceCooldown = { value: 0 };
        const maybeCooldown = async () => {
            if (COOLDOWN_EVERY > 0 && processedSinceCooldown.value > 0 && processedSinceCooldown.value % COOLDOWN_EVERY === 0) {
                btn.textContent = `⏸️ 冷却中… (${COOLDOWN_MS / 1000}s)`;
                await sleep(COOLDOWN_MS);
            }
        };

        try {
            const zip = new JSZip();
            const manifest = { schema_version: 1, exporter_version: EXPORTER_BUILD,
                workspace_id: resolveWorkspaceId(workspaceId) || null, export_mode: mode,
                generated_at: new Date().toISOString(), projects: [], conversations: [] };
            const writeConversation = (data, entry = {}) => {
                const projectId = entry.projectId || null;
                const folder = projectId ? `projects/${encodeURIComponent(projectId)}/` : 'conversations/';
                const id = entry.id || data.conversation_id || data.id;
                if (!id) throw new Error('缺少 Conversation ID');
                const jsonPath = `${folder}${encodeURIComponent(id)}.json`;
                const mdPath = `${folder}${encodeURIComponent(id)}.md`;
                zip.file(jsonPath, JSON.stringify(data, null, 2));
                const record = { conversation_id: id, title: entry.title || data.title,
                    project_id: projectId, project_title: entry.projectTitle || null,
                    create_time: entry.create_time ?? data.create_time ?? null,
                    update_time: entry.update_time ?? data.update_time ?? null,
                    is_archived: entry.is_archived ?? data.is_archived ?? false,
                    json_path: jsonPath, md_path: null };
                manifest.conversations.push(record);
                if (projectId && !manifest.projects.some(p => p.project_id === projectId))
                    manifest.projects.push({ project_id: projectId, project_title: entry.projectTitle || projectId });
                zip.file(mdPath, convertConversationToMarkdown(data));
                record.md_path = mdPath;
            };
            if (Array.isArray(conversationEntries) && conversationEntries.length > 0) {
                for (let i = 0; i < conversationEntries.length; i++) {
                    const entry = conversationEntries[i];
                    const label = entry?.title ? entry.title.slice(0, 12) : '对话';
                    btn.textContent = `📥 ${label} (${i + 1}/${conversationEntries.length})`;
                    try {
                        const convData = await getConversation(entry.id, workspaceId, { useCache, serverUpdateTime: entry.update_time });
                        if (convData?.__cache_hit) stats.hits++; else stats.fetched++;
                        writeConversation(convData, entry);
                    } catch (e) {
                        stats.failed++;
                        failures.push({ id: entry.id, title: entry?.title || '', phase: 'detail', error: e?.message || String(e) });
                        console.error(`[Exporter] 跳过 conv ${entry.id}:`, e);
                    }
                    processedSinceCooldown.value++;
                    await maybeCooldown();
                    await sleep(jitter());
                }
            } else {
                btn.textContent = '📂 获取项目外对话…';
                const orphanIds = await collectIds(btn, workspaceId, null);
                for (let i = 0; i < orphanIds.length; i++) {
                    btn.textContent = `📥 根目录 (${i + 1}/${orphanIds.length})`;
                    try {
                        const convData = await getConversation(orphanIds[i], workspaceId, { useCache });
                        if (convData?.__cache_hit) stats.hits++; else stats.fetched++;
                        writeConversation(convData, { id: orphanIds[i] });
                    } catch (e) {
                        stats.failed++;
                        failures.push({ id: orphanIds[i], title: '', phase: 'detail', error: e?.message || String(e) });
                        console.error(`[Exporter] 跳过 conv ${orphanIds[i]}:`, e);
                    }
                    processedSinceCooldown.value++;
                    await maybeCooldown();
                    await sleep(jitter());
                }

                btn.textContent = '🔍 获取项目列表…';
                const projects = await getProjects(workspaceId);
                for (const project of projects) {
                    const projectFolder = zip.folder(sanitizeFilename(project.title));
                    btn.textContent = `📂 项目: ${project.title}`;
                    const projectConvIds = await collectIds(btn, workspaceId, project.id);
                    if (projectConvIds.length === 0) continue;

                    for (let i = 0; i < projectConvIds.length; i++) {
                        btn.textContent = `📥 ${project.title.substring(0,10)}... (${i + 1}/${projectConvIds.length})`;
                        try {
                            const convData = await getConversation(projectConvIds[i], workspaceId, { useCache });
                            if (convData?.__cache_hit) stats.hits++; else stats.fetched++;
                            writeConversation(convData, { id: projectConvIds[i], projectId: project.id, projectTitle: project.title });
                        } catch (e) {
                            stats.failed++;
                            failures.push({ id: projectConvIds[i], title: project.title, phase: 'detail', error: e?.message || String(e) });
                            console.error(`[Exporter] 跳过 conv ${projectConvIds[i]}:`, e);
                        }
                        processedSinceCooldown.value++;
                        await maybeCooldown();
                        await sleep(jitter());
                    }
                }
            }

            // 写一份失败报告，方便用户知道哪些没拿到
            if (failures.length > 0) {
                const report = {
                    generated_at: new Date().toISOString(),
                    use_cache: useCache,
                    stats,
                    failed_count: failures.length,
                    failed: failures
                };
                zip.file('EXPORT_REPORT.json', JSON.stringify(report, null, 2));
            } else {
                const okReport = {
                    generated_at: new Date().toISOString(),
                    use_cache: useCache,
                    stats
                };
                zip.file('EXPORT_REPORT.json', JSON.stringify(okReport, null, 2));
            }

            zip.file('EXPORT_MANIFEST.json', JSON.stringify(manifest, null, 2));
            btn.textContent = '📦 生成 ZIP 文件…';
            const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
            const date = new Date().toISOString().slice(0, 10);
            const selectionType = exportType || ((Array.isArray(conversationEntries) && conversationEntries.length > 0) ? 'selected' : 'full');
            let filename = '';
            if (selectionType === 'selected') {
                filename = mode === 'team'
                    ? `chatgpt_team_selected_${workspaceId}_${date}.zip`
                    : mode === 'project'
                        ? `chatgpt_project_selected_${date}.zip`
                        : `chatgpt_personal_selected_${date}.zip`;
            } else {
                filename = mode === 'team'
                    ? `chatgpt_team_backup_${workspaceId}_${date}.zip`
                    : mode === 'project'
                        ? `chatgpt_project_backup_${date}.zip`
                        : `chatgpt_personal_backup_${date}.zip`;
            }
            downloadFile(blob, filename);
            const summary = `${stats.failed ? '⚠️ 导出完成，部分失败' : '✅ 导出完成！'}\n缓存命中: ${stats.hits}\n新拉取: ${stats.fetched}\n失败: ${stats.failed}`;
            if (stats.failed > 0) {
                alert(`${summary}\n\n失败列表已写入 EXPORT_REPORT.json。`);
            } else {
                alert(summary);
            }
            btn.textContent = '✅ 完成';

        } catch (e) {
            console.error("导出过程中发生严重错误:", e);
            alert(`导出失败: ${e.message}。详情请查看控制台（F12 -> Console）。`);
            btn.textContent = '⚠️ Error';
        } finally {
            setTimeout(() => {
                btn.disabled = false;
                btn.textContent = 'Export Conversations';
            }, 3000);
        }
    }

    async function collectFullExportEntries(mode, workspaceId, btn = null) {
        const map = new Map();

        if (btn) btn.textContent = '🔎 获取根目录对话列表…';
        const rootEntries = await listConversations(workspaceId);
        rootEntries.forEach(entry => upsertConversationEntry(map, entry));

        if (mode !== 'project') {
            if (btn) btn.textContent = '🔎 获取项目空间对话列表…';
            try {
                const projectEntries = await listProjectSpaceConversations(workspaceId);
                projectEntries.forEach(entry => upsertConversationEntry(map, entry, {
                    projectId: entry.projectId,
                    projectTitle: entry.projectTitle
                }));
            } catch (err) {
                console.warn('[Exporter] 项目空间列表获取失败，导出预览可能缺少项目内对话:', err);
                const proceed = confirm(`项目空间列表获取失败，可能无法导出项目内对话。\n\n错误: ${err.message}\n\n是否只导出已获取到的根目录对话？`);
                if (!proceed) {
                    throw err;
                }
            }
        }

        return Array.from(map.values())
            .sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
    }

    async function startExportProcess(mode, workspaceId, useCache = true, options = {}) {
        const { preview = true } = options;
        const btn = getExportButton();
        try {
            btn.disabled = true;
            btn.textContent = '🔎 获取导出列表…';
            const entries = await collectFullExportEntries(mode, workspaceId, btn);
            if (entries.length === 0) {
                alert('未找到可导出的对话。');
                return;
            }
            if (preview) {
                const confirmed = await showExportPreview(entries, { mode, workspaceId, exportType: 'full' });
                if (!confirmed) return;
            }
            await exportConversations({ mode, workspaceId, conversationEntries: entries, exportType: 'full', useCache });
        } catch (err) {
            console.error('准备导出列表失败:', err);
            alert(`准备导出列表失败: ${err.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Export Conversations';
        }
    }

    async function startProjectSpaceExportProcess(workspaceId = null, useCache = true, options = {}) {
        const { preview = true } = options;
        const btn = getExportButton();
        try {
            btn.disabled = true;
            btn.textContent = '🔎 获取项目导出列表…';
            const projectEntries = await listProjectSpaceConversations(workspaceId);
            if (projectEntries.length === 0) {
                alert('未找到项目空间对话。');
                return;
            }
            if (preview) {
                const confirmed = await showExportPreview(projectEntries, { mode: 'project', workspaceId, exportType: 'full' });
                if (!confirmed) return;
            }
            await exportConversations({ mode: 'project', workspaceId, conversationEntries: projectEntries, exportType: 'full', useCache });
        } catch (err) {
            console.error('导出项目空间失败:', err);
            alert(`导出项目空间失败: ${err.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Export Conversations';
        }
    }

    async function startSingleProjectExportProcess(project, workspaceId = null, useCache = true, options = {}) {
        const { preview = true } = options;
        const btn = getExportButton();
        if (!project?.id) {
            alert('没有找到要导出的项目/GPT ID。请先打开目标项目页，或手动输入 g-p-... ID。');
            return;
        }
        try {
            btn.disabled = true;
            btn.textContent = `🔎 获取项目 ${project.title || project.id}…`;
            const projectEntries = await listProjectSpaceConversations(workspaceId, { projects: [project] });
            if (projectEntries.length === 0) {
                alert(`未找到项目 ${project.title || project.id} 下的对话。`);
                return;
            }
            if (preview) {
                const confirmed = await showExportPreview(projectEntries, { mode: 'project', workspaceId, exportType: 'full' });
                if (!confirmed) return;
            }
            await exportConversations({ mode: 'project', workspaceId, conversationEntries: projectEntries, exportType: 'full', useCache });
        } catch (err) {
            console.error('导出指定项目失败:', err);
            alert(`导出指定项目失败: ${err.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Export Conversations';
        }
    }

    async function startSelectiveExportProcess(mode, workspaceId, conversationEntries, useCache = true, options = {}) {
        const { preview = true } = options;
        if (preview) {
            const confirmed = await showExportPreview(conversationEntries, { mode, workspaceId, exportType: 'selected' });
            if (!confirmed) return;
        }
        await exportConversations({ mode, workspaceId, conversationEntries, useCache });
    }

    function startScheduledExport(options = {}) {
        const { mode = 'personal', workspaceId = null, autoConfirm = false, source = 'schedule', useCache = true } = options;
        const proceed = async () => {
            try {
                if (mode === 'project') {
                    await startProjectSpaceExportProcess(workspaceId, useCache, { preview: !autoConfirm });
                } else {
                    await startExportProcess(mode, workspaceId, useCache, { preview: !autoConfirm });
                }
            } catch (err) {
                console.error('[ChatGPT Exporter] 自动导出失败:', err);
            }
        };

        if (autoConfirm) {
            proceed();
            return;
        }

        const modeLabel = mode === 'team' ? '团队空间' : mode === 'project' ? '项目空间' : '个人空间';
        if (confirm(`Chrome 扩展请求导出 ${modeLabel} 对话（来源: ${source}）。是否开始？`)) {
            proceed();
        }
    }

    // --- API 调用函数 ---
    function firstNonEmpty(...values) {
        return values.find(value => value !== undefined && value !== null && value !== '');
    }

    function responseItems(data) {
        const candidates = [
            data?.items,
            data?.conversations?.items,
            data?.conversations,
            data?.results,
            data?.data?.items,
            data?.data
        ];
        return candidates.find(Array.isArray) || [];
    }

    function responseCursor(data) {
        return firstNonEmpty(
            data?.cursor,
            data?.next_cursor,
            data?.nextCursor,
            data?.continuation,
            data?.continuation_token,
            data?.next_continuation_token,
            data?.pagination?.cursor,
            data?.pagination?.next_cursor,
            data?.pagination?.continuation,
            data?.page_info?.next_cursor,
            data?.pageInfo?.endCursor
        ) || null;
    }

    function responseHasMore(data, fallback = false) {
        const value = firstNonEmpty(
            data?.has_more,
            data?.hasMore,
            data?.has_next_page,
            data?.hasNextPage,
            data?.pagination?.has_more,
            data?.pagination?.has_next_page,
            data?.page_info?.has_next_page,
            data?.pageInfo?.hasNextPage
        );
        if (value === undefined || value === null || value === '') return fallback;
        return value === true || value === 'true' || value === 1 || value === '1';
    }

    function responseTotal(data) {
        const value = firstNonEmpty(
            data?.total,
            data?.total_count,
            data?.count,
            data?.pagination?.total,
            data?.pagination?.total_count
        );
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }

    function offsetHasMore(data, items, nextOffset) {
        const total = responseTotal(data);
        if (total !== null) return nextOffset < total;
        return responseHasMore(data, items.length === PAGE_LIMIT);
    }

    function normalizeConversationListItem(item) {
        const raw = item?.conversation || item?.conversation_item || item;
        const id = firstNonEmpty(raw?.id, raw?.conversation_id, item?.id, item?.conversation_id);
        if (!id) return null;
        return {
            ...raw,
            id,
            title: firstNonEmpty(raw?.title, raw?.name, item?.title, item?.name, 'Untitled Conversation'),
            create_time: firstNonEmpty(raw?.create_time, raw?.created_at, item?.create_time, item?.created_at, 0),
            update_time: firstNonEmpty(raw?.update_time, raw?.updated_at, item?.update_time, item?.updated_at, 0),
            is_archived: raw?.is_archived ?? item?.is_archived,
            projectId: firstNonEmpty(
                raw?.gizmo_id,
                raw?.gizmoId,
                raw?.gizmo?.id,
                raw?.gizmo?.gizmo?.id,
                raw?.metadata?.gizmo_id,
                raw?.metadata?.gizmoId,
                item?.gizmo_id,
                item?.gizmoId,
                item?.gizmo?.id,
                item?.metadata?.gizmo_id
            ) || null,
            projectTitle: firstNonEmpty(
                raw?.gizmo?.display?.name,
                raw?.gizmo?.name,
                raw?.gizmo?.title,
                item?.gizmo?.display?.name,
                item?.gizmo?.name,
                item?.gizmo?.title
            ) || null
        };
    }

    function projectPreviewConversations(item) {
        const candidates = [
            item?.conversations?.items,
            item?.conversations,
            item?.conversation_items,
            item?.gizmo?.conversations?.items,
            item?.gizmo?.conversations
        ];
        return candidates.find(Array.isArray) || [];
    }

    function normalizeProjectSpaceItem(item) {
        const rawGizmo = item?.gizmo?.gizmo || item?.gizmo || item;
        const display = rawGizmo?.display || item?.gizmo?.display || item?.display;
        const id = firstNonEmpty(
            rawGizmo?.id,
            rawGizmo?.gizmo_id,
            rawGizmo?.resource_id,
            item?.gizmo?.id,
            item?.gizmo_id,
            item?.id
        );
        const title = firstNonEmpty(display?.name, display?.title, rawGizmo?.name, rawGizmo?.title, item?.name, item?.title, 'Untitled Project');
        if (!id) return null;
        return {
            id,
            title,
            conversations: projectPreviewConversations(item)
        };
    }

    function resolveWorkspaceId(workspaceId) {
        if (workspaceId) return workspaceId;
        const match = document.cookie.match(/(?:^|; )_account=([^;]+)/);
        if (match?.[1]) return match[1];
        const detectedIds = detectAllWorkspaceIds();
        return detectedIds.length > 0 ? detectedIds[0] : null;
    }

    async function getProjectSpaces(workspaceId, options = {}) {
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) { headers['ChatGPT-Account-Id'] = resolvedWorkspaceId; }

        const projects = new Map();
        let cursor = null;
        const seen = new Set();

        do {
            const query = new URLSearchParams();
            query.set('limit', String(PROJECT_SIDEBAR_LIMIT));
            if (options.conversationsPerGizmo !== undefined) {
                query.set('conversations_per_gizmo', String(options.conversationsPerGizmo));
            }
            if (options.ownedOnly !== undefined) {
                query.set('owned_only', options.ownedOnly ? 'true' : 'false');
            }
            if (cursor) {
                query.set('cursor', cursor);
            }

            const r = await fetch(`/backend-api/gizmos/snorlax/sidebar?${query.toString()}`, { headers });
            if (!r.ok) {
                throw new Error(`获取项目空间列表失败 (${r.status})`);
            }
            const data = await r.json();
            responseItems(data).forEach(item => {
                const project = normalizeProjectSpaceItem(item);
                if (project) {
                    projects.set(project.id, project);
                }
            });
            cursor = responseCursor(data);
            if (!cursor && responseHasMore(data, false)) throw new Error('项目列表缺少下一页游标');
            if (cursor) {
                if (seen.has(cursor)) throw new Error('项目列表游标重复');
                seen.add(cursor);
                await sleep(jitter());
            }
        } while (cursor);

        return Array.from(projects.values());
    }

    async function getProjects(workspaceId) {
        try {
            const projects = await getProjectSpaces(workspaceId);
            return projects.map(({ id, title }) => ({ id, title }));
        } catch (err) {
            console.warn(`获取项目(Gizmo)列表失败 (${err?.message || err})`);
            return [];
        }
    }

    async function hydrateSelectedProjects(projects, workspaceId) {
        const selected = (projects || []).filter(project => project?.id);
        if (selected.length === 0) return [];
        try {
            const knownProjects = await getProjectSpaces(workspaceId, {
                conversationsPerGizmo: PROJECT_SIDEBAR_PREVIEW,
                ownedOnly: false
            });
            const knownById = new Map(knownProjects.map(project => [project.id, project]));
            return selected.map(project => {
                const known = knownById.get(project.id);
                return known ? { ...project, ...known } : project;
            });
        } catch (err) {
            recordDiagnostic(`指定项目元数据补全失败: ${err?.message || err}`);
            return selected;
        }
    }

    async function collectIds(btn, workspaceId, gizmoId) {
        const all = new Set();
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (workspaceId) { headers['ChatGPT-Account-Id'] = workspaceId; }

        if (gizmoId) {
            const entries = await fetchProjectConversationEntries({ id: gizmoId, title: '' }, headers);
            entries.forEach(entry => all.add(entry.id));
        } else {
            for (const is_archived of [false, true]) {
                let offset = 0, has_more = true, page = 0;
                let cursor = null;
                do {
                    btn.textContent = `📂 项目外对话 (${is_archived ? 'Archived' : 'Active'} p${++page})`;
                    const query = new URLSearchParams();
                    query.set('offset', String(offset));
                    query.set('limit', String(PAGE_LIMIT));
                    query.set('order', 'updated');
                    if (is_archived) query.set('is_archived', 'true');
                    if (cursor) query.set('cursor', cursor);
                    const r = await fetch(`/backend-api/conversations?${query.toString()}`, { headers });
                    if (!r.ok) throw new Error(`列举项目外对话列表失败 (${r.status})`);
                    const j = await r.json();
                    const items = responseItems(j);
                    if (items.length > 0) {
                        items.forEach(it => {
                            const entry = normalizeConversationListItem(it);
                            if (entry) all.add(entry.id);
                        });
                        offset += items.length;
                        cursor = responseCursor(j);
                        has_more = !!cursor || offsetHasMore(j, items, offset);
                    } else {
                        has_more = false;
                    }
                    await sleep(jitter());
                } while (has_more);
            }
        }
        return Array.from(all);
    }

    async function fetchProjectConversationEntries(project, headers, knownRoot = null) {
        const map = new Map();
        const seenPageKeys = new Set();
        const addItems = (items) => {
            let added = 0;
            items.forEach(item => {
                const before = map.size;
                upsertConversationEntry(map, item, {
                    projectId: project.id,
                    projectTitle: project.title
                });
                if (map.size > before) added++;
            });
            return added;
        };

        if (Array.isArray(project.conversations) && project.conversations.length > 0) {
            const added = addItems(project.conversations);
            recordDiagnostic(`项目 ${project.title || project.id}: sidebar 预览 ${project.conversations.length} 条，新增 ${added} 条`);
        }

        let cursor = null;
        let page = 0;
        do {
            const pageResult = await fetchProjectGizmoConversationPage(project, headers, cursor);
            if (!pageResult.ok) {
                recordDiagnostic(`项目 ${project.title || project.id}: gizmo conversations 所有参数形态均失败，保留已获取 ${map.size} 条`);
                break;
            }

            const j = pageResult.data;
            const items = responseItems(j);
            const ids = items.map(item => normalizeConversationListItem(item)?.id).filter(Boolean);
            const pageKey = `gizmo|${ids.join(',')}`;
            if (seenPageKeys.has(pageKey)) {
                recordDiagnostic(`项目 ${project.title || project.id}: gizmo endpoint 重复分页，停止`);
                break;
            }
            seenPageKeys.add(pageKey);

            if (items.length === 0) break;
            const added = addItems(items);
            page++;
            recordDiagnostic(`项目 ${project.title || project.id}: gizmo p${page} (${pageResult.queryLabel}) 返回 ${items.length} 条，新增 ${added} 条，累计 ${map.size} 条`);

            const nextCursor = responseCursor(j);
            if (nextCursor === cursor && nextCursor) throw new Error('项目游标重复');
            if (!nextCursor && responseHasMore(j, false)) throw new Error('项目声明有下一页但未提供游标');
            if (!nextCursor) break;
            cursor = nextCursor;
            await sleep(jitter());
        } while (page < 1000);

        if (page >= 1000) throw new Error('项目分页超过安全上限，扫描未完成');
        let fallbackAdded = 0;
        if (Array.isArray(knownRoot)) {
            for (const entry of knownRoot) if (entry.projectId === project.id) {
                const before = map.size;
                upsertConversationEntry(map, entry, {projectId:project.id, projectTitle:project.title});
                fallbackAdded += map.size - before;
            }
        } else fallbackAdded = await fetchProjectConversationEntriesViaGlobal(project, headers, map);
        if (fallbackAdded > 0) {
            recordDiagnostic(`项目 ${project.title || project.id}: global fallback 新增 ${fallbackAdded} 条，累计 ${map.size} 条`);
        }

        return Array.from(map.values())
            .sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
    }

    async function fetchProjectGizmoConversationPage(project, headers, cursor) {
        const base = `/backend-api/gizmos/${project.id}/conversations`;
        const variants = [];
        if (cursor) {
            variants.push(['cursor', { cursor }]);
            variants.push(['limit+cursor', { limit: String(PAGE_LIMIT), cursor }]);
        } else {
            variants.push(['cursor=0', { cursor: '0' }]);
            variants.push(['no-query', {}]);
            variants.push(['limit+cursor=0', { limit: String(PAGE_LIMIT), cursor: '0' }]);
            variants.push(['limit', { limit: String(PAGE_LIMIT) }]);
        }

        for (const [label, params] of variants) {
            const query = new URLSearchParams(params);
            const url = query.toString() ? `${base}?${query.toString()}` : base;
            const r = await fetch(url, { headers });
            if (r.ok) {
                recordDiagnostic(`项目 ${project.title || project.id}: gizmo 参数 ${label} 可用`);
                return { ok: true, data: await r.json(), queryLabel: label };
            }
            let body = '';
            try {
                body = (await r.clone().text()).slice(0, 180);
            } catch (_) {}
            recordDiagnostic(`项目 ${project.title || project.id}: gizmo 参数 ${label} 失败 ${r.status}${body ? ` ${body}` : ''}`);
        }

        return { ok: false, data: null, queryLabel: '' };
    }

    async function fetchProjectConversationEntriesViaGlobal(project, headers, map) {
        let totalAdded = 0;
        // Never trust an undocumented server-side filter; inspect explicit membership on every row.
        for (const archived of [false, true]) {
            let offset = 0, cursor = null, more = true;
            const seen = new Set();
            while (more) {
                const query = new URLSearchParams({ offset: String(offset), limit: String(PAGE_LIMIT), order: 'updated' });
                if (archived) query.set('is_archived', 'true');
                if (cursor) query.set('cursor', cursor);
                const response = await fetch(`/backend-api/conversations?${query}`, { headers });
                if (!response.ok) throw new Error(`项目 fallback 列表失败 (${response.status})`);
                const data = await response.json(), items = responseItems(data);
                const fingerprint = JSON.stringify(items.map(item => normalizeConversationListItem(item)?.id));
                if (items.length && seen.has(fingerprint)) throw new Error('项目 fallback 重复分页');
                seen.add(fingerprint);
                for (const item of items) {
                    const entry = normalizeConversationListItem(item);
                    if (entry?.projectId !== project.id) continue;
                    const before = map.size;
                    upsertConversationEntry(map, item, { projectId: project.id, projectTitle: project.title, is_archived: archived });
                    totalAdded += map.size - before;
                }
                offset += items.length;
                cursor = responseCursor(data);
                more = !!cursor || offsetHasMore(data, items, offset);
                if (!items.length && more) throw new Error('项目 fallback 提前返回空页');
                if (more) await sleep(jitter());
            }
        }
        return totalAdded;
    }

    function upsertConversationEntry(map, item, extra = {}) {
        const normalized = normalizeConversationListItem(item);
        if (!normalized?.id) return;
        const create_time = normalizeEpochSeconds(normalized.create_time || 0);
        const update_time = normalizeEpochSeconds(normalized.update_time || 0);
        const entry = {
            id: normalized.id,
            title: normalized.title || 'Untitled Conversation',
            create_time,
            update_time,
            is_archived: normalized.is_archived ?? extra.is_archived ?? false,
            projectId: extra.projectId || normalized.projectId || null,
            projectTitle: extra.projectTitle || normalized.projectTitle || null
        };
        const existing = map.get(entry.id);
        if (!existing) {
            map.set(entry.id, entry);
            return;
        }
        if (!existing.projectId && entry.projectId) {
            existing.projectTitle = entry.projectTitle;
            existing.projectId = entry.projectId;
        }
        if (!existing.create_time && entry.create_time) {
            existing.create_time = entry.create_time;
        }
        existing.is_archived = existing.is_archived || entry.is_archived;
        if ((entry.update_time || 0) > (existing.update_time || 0)) {
            existing.update_time = entry.update_time;
        }
        if (existing.title === 'Untitled Conversation' && entry.title) {
            existing.title = entry.title;
        }
    }

    async function listConversations(workspaceId, options = {}) {
        if (!await ensureAccessToken()) {
            throw new Error('无法获取 Access Token，请刷新页面或打开任意一个对话后再试。');
        }

        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (workspaceId) { headers['ChatGPT-Account-Id'] = workspaceId; }

        const map = new Map();
        const addEntry = (item, extra = {}) => upsertConversationEntry(map, item, extra);

        for (const is_archived of [false, true]) {
            let offset = 0;
            let has_more = true;
            let cursor = null;
            const seenPages = new Set();
            do {
                const query = new URLSearchParams();
                query.set('offset', String(offset));
                query.set('limit', String(PAGE_LIMIT));
                query.set('order', 'updated');
                if (is_archived) query.set('is_archived', 'true');
                if (cursor) query.set('cursor', cursor);
                const r = await fetch(`/backend-api/conversations?${query.toString()}`, { headers });
                if (!r.ok) throw new Error(`列举对话列表失败 (${r.status})`);
                const j = await r.json();
                const items = responseItems(j);
                const fingerprint = JSON.stringify(items.map(it => normalizeConversationListItem(it)?.id));
                if (items.length && seenPages.has(fingerprint)) throw new Error('对话列表重复分页，扫描未完成');
                seenPages.add(fingerprint);
                if (items.length > 0) {
                    items.forEach(it => addEntry(it, { is_archived }));
                    offset += items.length;
                    cursor = responseCursor(j);
                    has_more = !!cursor || offsetHasMore(j, items, offset);
                } else {
                    if (responseHasMore(j, false) || (responseTotal(j) || 0) > offset) throw new Error('对话列表提前返回空页，扫描未完成');
                    has_more = false;
                }
                await sleep(jitter());
            } while (has_more);
        }

        if (workspaceId && !options.skipProjects) {
            const projects = await getProjects(workspaceId);
            for (const project of projects) {
                const entries = await fetchProjectConversationEntries(project, headers);
                entries.forEach(entry => addEntry(entry));
            }
        }

        return Array.from(map.values())
            .sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
    }

    async function listProjectSpaceConversations(workspaceId, options = {}) {
        if (!await ensureAccessToken()) {
            throw new Error('无法获取 Access Token，请刷新页面或打开任意一个对话后再试。');
        }

        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) { headers['ChatGPT-Account-Id'] = resolvedWorkspaceId; }

        const map = new Map();
        const projects = Array.isArray(options.projects) && options.projects.length > 0
            ? await hydrateSelectedProjects(options.projects, resolvedWorkspaceId)
            : await getProjectSpaces(resolvedWorkspaceId, { conversationsPerGizmo: PROJECT_SIDEBAR_PREVIEW, ownedOnly: false });

        for (const project of projects) {
            const entries = await fetchProjectConversationEntries(project, headers);
            entries.forEach(entry => upsertConversationEntry(map, entry));
        }

        return Array.from(map.values())
            .sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
    }

    async function getConversation(id, workspaceId, opts = {}) {
        const { useCache = true, serverUpdateTime = null } = opts;
        const cacheKey = `${resolveWorkspaceId(workspaceId) || 'personal'}:${id}`;
        const serverTime = normalizeEpochSeconds(serverUpdateTime);

        if (useCache) {
            const cached = await ExportCache.get(cacheKey);
            if (cached && serverTime > 0 && normalizeEpochSeconds(cached.__server_update_time) >= serverTime) {
                return { ...cached, __cache_hit: true };
            }
        }

        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) { headers['ChatGPT-Account-Id'] = resolvedWorkspaceId; }

        let lastError = null;
        for (let attempt = 0; attempt <= MAX_429_ATTEMPTS; attempt++) {
            const r = await fetch(`/backend-api/conversation/${id}`, { headers });
            if (r.status === 429 && attempt < MAX_429_ATTEMPTS) {
                const retryAfter = Number(r.headers.get('retry-after')) || 0;
                const waitMs = retryAfter > 0 ? retryAfter * 1000 : (2000 * Math.pow(2, attempt));
                console.warn(`[Exporter] 429 on conv ${id}, retry in ${waitMs}ms (attempt ${attempt + 1}/${MAX_429_ATTEMPTS})`);
                await sleep(waitMs);
                continue;
            }
            if (!r.ok) {
                const err = new Error(`获取对话详情失败 conv ${id} (${r.status})`);
                err.status = r.status;
                err.id = id;
                throw err;
            }
            const j = await r.json();
            j.__fetched_at = new Date().toISOString();
            j.__server_update_time = serverTime;
            if (useCache) {
                await ExportCache.put(cacheKey, j);
            }
            return j;
        }
        // 不可达
        throw lastError || new Error(`获取对话详情失败 conv ${id} (429)`);
    }

    // --- UI 相关函数 ---
    // (UI部分无变动，此处省略以保持简洁)
    /**
     * [新增] 全面检测函数，返回所有找到的ID
     * @returns {string[]} - 返回包含所有唯一Workspace ID的数组
     */
    function detectAllWorkspaceIds() {
        const foundIds = new Set(capturedWorkspaceIds); // 从网络拦截的结果开始

        // 扫描 __NEXT_DATA__
        try {
            const data = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
            // 遍历所有账户信息
            const accounts = data?.props?.pageProps?.user?.accounts;
            if (accounts) {
                Object.values(accounts).forEach(acc => {
                    if (acc?.account?.id) {
                        foundIds.add(acc.account.id);
                    }
                });
            }
        } catch (e) {}

        // 扫描 localStorage
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.includes('account') || key.includes('workspace'))) {
                    const value = localStorage.getItem(key);
                    if (value && /^[a-z0-9]{2,}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                         const extractedId = value.match(/ws-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
                         if(extractedId) foundIds.add(extractedId[0]);
                    } else if (value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                         foundIds.add(value.replace(/"/g, ''));
                    }
                }
            }
        } catch(e) {}

        console.log('🔍 检测到以下 Workspace IDs:', Array.from(foundIds));
        return Array.from(foundIds);
    }

    function showConversationPicker(options = {}) {
        const { mode = 'personal', workspaceId = null } = options;
        const existing = document.getElementById('export-dialog-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'export-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '99998',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const dialog = document.createElement('div');
        dialog.id = 'export-dialog';
        Object.assign(dialog.style, {
            background: '#fff', padding: '24px', borderRadius: '12px',
            boxShadow: '0 5px 15px rgba(0,0,0,.3)', width: '720px',
            fontFamily: 'sans-serif', color: '#333', boxSizing: 'border-box'
        });

        const closeDialog = () => document.body.removeChild(overlay);
        const state = {
            list: [],
            filtered: [],
            selected: new Set(),
            query: '',
            scope: mode === 'project' ? 'project' : 'all',
            scopeLocked: mode === 'project',
            archived: 'all',
            timeField: 'update',
            loading: true,
            pageSize: 100,
            visibleCount: 100,
            startDate: '',
            endDate: '',
            useCache: true,
            cacheSize: 0,
            advancedOpen: false
        };

        const refreshCacheSize = async () => {
            const sizeEl = dialog.querySelector('#cache-size');
            if (!sizeEl) return;
            const n = await ExportCache.size();
            state.cacheSize = n;
            sizeEl.textContent = `已缓存: ${n}`;
        };

        const renderBase = () => {
            const modeLabel = mode === 'team' ? '团队空间' : mode === 'project' ? '项目空间' : '个人空间';
            const workspaceLabel = workspaceId ? `（${workspaceId}）` : '';
            dialog.innerHTML = `
                <h2 style="margin-top:0; margin-bottom: 12px; font-size: 18px;">选择要导出的对话</h2>
                <div style="margin-bottom: 12px; color: #666; font-size: 12px;">空间：${modeLabel}${workspaceLabel}</div>
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <input id="conv-search" type="text" placeholder="搜索标题/项目名/ID"
                        style="flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #ccc; box-sizing: border-box;">
                    <select id="filter-scope" style="padding: 8px 28px 8px 8px; border-radius: 6px; border: 1px solid #ccc;">
                        <option value="all">全部范围</option>
                        <option value="project">仅项目</option>
                        <option value="root">仅项目外</option>
                    </select>
                    <select id="filter-archived" style="padding: 8px 28px 8px 8px; border-radius: 6px; border: 1px solid #ccc;">
                        <option value="all">全部状态</option>
                        <option value="active">仅未归档</option>
                        <option value="archived">仅已归档</option>
                    </select>
                </div>
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                    <button id="advanced-toggle-btn" type="button"
                        style="padding: 4px 10px; border: 1px solid #d4d4d8; border-radius: 6px; background: #fafafa; color: #52525b; cursor: pointer; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;">
                        <span id="advanced-toggle-icon">▸</span><span>高级筛选</span>
                        <span id="advanced-badge" style="display: none; background: #10a37f; color: #fff; border-radius: 999px; font-size: 10px; padding: 0 6px; line-height: 1.4;">已设</span>
                    </button>
                    <span id="cache-summary" style="font-size: 12px; color: #6b21a8;"></span>
                </div>
                <div id="advanced-section" style="display: none; padding: 10px 12px; margin-bottom: 12px; background: #fafafa; border: 1px solid #e5e7eb; border-radius: 6px;">
                    <div style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center; flex-wrap: wrap;">
                        <select id="filter-time-field" style="padding: 6px 22px 6px 8px; border-radius: 6px; border: 1px solid #ccc; font-size: 12px;">
                            <option value="update">按更新时间</option>
                            <option value="create">按创建时间</option>
                        </select>
                        <input id="filter-start-date" type="date" style="padding: 6px; border-radius: 6px; border: 1px solid #ccc; font-size: 12px;">
                        <span style="color: #666; font-size: 12px;">至</span>
                        <input id="filter-end-date" type="date" style="padding: 6px; border-radius: 6px; border: 1px solid #ccc; font-size: 12px;">
                        <button id="clear-date-btn" style="padding: 4px 10px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer; font-size: 12px;">清空日期</button>
                    </div>
                    <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                        <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #4338ca; cursor: pointer;">
                            <input id="use-cache-toggle" type="checkbox" checked>
                            使用缓存（已缓存的对话会跳过 API；中断后可续传）
                        </label>
                        <span style="font-size: 12px; color: #6b21a8;">已缓存: <span id="cache-size">…</span></span>
                        <button id="clear-cache-btn" style="padding: 4px 10px; border: 1px solid #c4b5fd; border-radius: 6px; background: #fff; color: #6d28d9; cursor: pointer; font-size: 12px;">清空缓存</button>
                    </div>
                </div>
                <div id="conv-status" style="margin-bottom: 8px; font-size: 12px; color: #666;">正在加载列表...</div>
                <div id="conv-list" style="max-height: 360px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; background: #fff;"></div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px;">
                    <div style="display: flex; gap: 8px;">
                        <button id="select-all-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">全选</button>
                        <button id="clear-all-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">清空</button>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button id="back-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">返回</button>
                        <button id="export-selected-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;" disabled>导出选中 (0)</button>
                    </div>
                </div>
            `;

            const searchInput = dialog.querySelector('#conv-search');
            const scopeSelect = dialog.querySelector('#filter-scope');
            const archivedSelect = dialog.querySelector('#filter-archived');
            const timeFieldSelect = dialog.querySelector('#filter-time-field');
            const startDateInput = dialog.querySelector('#filter-start-date');
            const endDateInput = dialog.querySelector('#filter-end-date');
            const clearDateBtn = dialog.querySelector('#clear-date-btn');
            const selectAllBtn = dialog.querySelector('#select-all-btn');
            const clearAllBtn = dialog.querySelector('#clear-all-btn');
            const backBtn = dialog.querySelector('#back-btn');
            const exportBtn = dialog.querySelector('#export-selected-btn');
            const useCacheToggle = dialog.querySelector('#use-cache-toggle');
            const clearCacheBtn = dialog.querySelector('#clear-cache-btn');
            const advancedToggleBtn = dialog.querySelector('#advanced-toggle-btn');
            const advancedSection = dialog.querySelector('#advanced-section');
            const advancedToggleIcon = dialog.querySelector('#advanced-toggle-icon');
            const advancedBadge = dialog.querySelector('#advanced-badge');
            const cacheSummary = dialog.querySelector('#cache-summary');

            const updateAdvancedUI = () => {
                if (advancedSection) advancedSection.style.display = state.advancedOpen ? 'block' : 'none';
                if (advancedToggleIcon) advancedToggleIcon.textContent = state.advancedOpen ? '▾' : '▸';
                const hasAdvanced = !!state.startDate || !!state.endDate || state.timeField !== 'update' || !state.useCache;
                if (advancedBadge) advancedBadge.style.display = hasAdvanced ? 'inline-block' : 'none';
            };
            if (advancedToggleBtn) {
                advancedToggleBtn.onclick = () => {
                    state.advancedOpen = !state.advancedOpen;
                    updateAdvancedUI();
                };
            }
            updateAdvancedUI();

            const updateCacheSummary = async () => {
                const n = await ExportCache.size();
                state.cacheSize = n;
                if (cacheSummary) cacheSummary.textContent = n > 0 ? `已缓存 ${n}` : '';
            };
            updateCacheSummary();

            if (useCacheToggle) {
                useCacheToggle.checked = state.useCache;
                useCacheToggle.onchange = (e) => { state.useCache = !!e.target.checked; updateAdvancedUI(); };
            }
            if (clearCacheBtn) {
                clearCacheBtn.onclick = async () => {
                    if (!confirm('确认清空本地 IndexedDB 缓存？此操作不可撤销。')) return;
                    clearCacheBtn.disabled = true;
                    await ExportCache.clear();
                    await refreshCacheSize();
                    await updateCacheSummary();
                    clearCacheBtn.disabled = false;
                };
            }

            if (state.scopeLocked && scopeSelect) {
                scopeSelect.value = 'project';
                scopeSelect.disabled = true;
                scopeSelect.style.opacity = '0.7';
                scopeSelect.style.cursor = 'not-allowed';
                scopeSelect.title = '项目空间仅包含项目对话';
            }

            searchInput.oninput = (e) => {
                state.query = e.target.value || '';
                applyFilters();
                renderList();
            };
            scopeSelect.onchange = (e) => {
                state.scope = e.target.value;
                applyFilters();
                renderList();
            };
            archivedSelect.onchange = (e) => {
                state.archived = e.target.value;
                applyFilters();
                renderList();
            };
            timeFieldSelect.onchange = (e) => {
                state.timeField = e.target.value;
                applyFilters();
                renderList();
                updateAdvancedUI();
            };
            startDateInput.onchange = (e) => {
                state.startDate = e.target.value || '';
                applyFilters();
                renderList();
                updateAdvancedUI();
            };
            endDateInput.onchange = (e) => {
                state.endDate = e.target.value || '';
                applyFilters();
                renderList();
                updateAdvancedUI();
            };
            clearDateBtn.onclick = () => {
                state.startDate = '';
                state.endDate = '';
                startDateInput.value = '';
                endDateInput.value = '';
                applyFilters();
                renderList();
                updateAdvancedUI();
            };
            selectAllBtn.onclick = () => {
                state.filtered.forEach(item => state.selected.add(item.id));
                renderList();
            };
            clearAllBtn.onclick = () => {
                state.selected.clear();
                renderList();
            };
            backBtn.onclick = () => {
                closeDialog();
                showExportDialog();
            };
            exportBtn.onclick = async () => {
                if (state.selected.size === 0) return;
                const selectedList = state.list.filter(item => state.selected.has(item.id));
                closeDialog();
                await startSelectiveExportProcess(mode, workspaceId, selectedList, state.useCache);
            };
        };

        const applyFilters = () => {
            const query = state.query.trim().toLowerCase();
            const startBound = parseDateInputToEpoch(state.startDate, false);
            const endBound = parseDateInputToEpoch(state.endDate, true);
            state.filtered = state.list.filter(item => {
                const text = `${item.title || ''} ${item.projectTitle || ''} ${item.id || ''}`.toLowerCase();
                if (query && !text.includes(query)) return false;
                if (state.scope === 'project' && !item.projectTitle) return false;
                if (state.scope === 'root' && item.projectTitle) return false;
                if (state.archived === 'active' && item.is_archived) return false;
                if (state.archived === 'archived' && !item.is_archived) return false;
                if (startBound || endBound) {
                    const sourceTime = state.timeField === 'create'
                        ? item.create_time
                        : item.update_time;
                    const ts = normalizeEpochSeconds(sourceTime || 0);
                    if (!ts) return false;
                    if (startBound && ts < startBound) return false;
                    if (endBound && ts > endBound) return false;
                }
                return true;
            });
            state.visibleCount = state.pageSize;
        };

        const renderList = () => {
            const statusEl = dialog.querySelector('#conv-status');
            const listEl = dialog.querySelector('#conv-list');
            const exportBtn = dialog.querySelector('#export-selected-btn');
            const selectAllBtn = dialog.querySelector('#select-all-btn');
            const clearAllBtn = dialog.querySelector('#clear-all-btn');
            const controlsDisabled = state.loading;

            if (selectAllBtn) selectAllBtn.disabled = controlsDisabled;
            if (clearAllBtn) clearAllBtn.disabled = controlsDisabled;
            if (exportBtn) exportBtn.disabled = controlsDisabled || state.selected.size === 0;

            listEl.innerHTML = '';
            if (state.loading) {
                statusEl.textContent = '正在加载列表...';
                return;
            }

            const visibleCount = Math.min(state.visibleCount, state.filtered.length);
            statusEl.textContent = `共 ${state.list.length} 条，当前筛选 ${state.filtered.length} 条，显示 ${visibleCount} 条，已选 ${state.selected.size} 条`;
            exportBtn.textContent = `导出选中 (${state.selected.size})`;

            if (state.filtered.length === 0) {
                const empty = document.createElement('div');
                empty.textContent = '没有匹配的对话。';
                empty.style.color = '#999';
                empty.style.padding = '8px 4px';
                listEl.appendChild(empty);
                return;
            }

            const visibleItems = state.filtered.slice(0, state.visibleCount);
            visibleItems.forEach(item => {
                const label = document.createElement('label');
                Object.assign(label.style, {
                    display: 'flex', gap: '8px', padding: '8px',
                    border: '1px solid #e5e7eb', borderRadius: '6px',
                    marginBottom: '8px', cursor: 'pointer', alignItems: 'flex-start'
                });

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = state.selected.has(item.id);
                checkbox.onchange = (e) => {
                    if (e.target.checked) {
                        state.selected.add(item.id);
                    } else {
                        state.selected.delete(item.id);
                    }
                    renderList();
                };

                const content = document.createElement('div');
                content.style.flex = '1';

                const title = document.createElement('div');
                title.textContent = item.title || 'Untitled Conversation';
                title.style.fontWeight = 'bold';
                title.style.fontSize = '14px';

                const meta = document.createElement('div');
                meta.style.fontSize = '12px';
                meta.style.color = '#666';
                const timeLabelPrefix = state.timeField === 'create' ? '创建' : '更新';
                const timeValue = state.timeField === 'create' ? item.create_time : item.update_time;
                const timeLabel = formatTimestamp(timeValue) || '未知';
                meta.textContent = `${timeLabelPrefix}: ${timeLabel}`;

                const tags = document.createElement('div');
                tags.style.marginTop = '6px';
                tags.style.display = 'flex';
                tags.style.gap = '6px';
                tags.style.flexWrap = 'wrap';

                if (item.projectTitle) {
                    const projectTag = document.createElement('span');
                    projectTag.textContent = `项目: ${item.projectTitle}`;
                    Object.assign(projectTag.style, {
                        background: '#eef2ff', color: '#4338ca',
                        padding: '2px 6px', borderRadius: '999px', fontSize: '11px'
                    });
                    tags.appendChild(projectTag);
                }

                if (item.is_archived) {
                    const archivedTag = document.createElement('span');
                    archivedTag.textContent = '已归档';
                    Object.assign(archivedTag.style, {
                        background: '#fef3c7', color: '#92400e',
                        padding: '2px 6px', borderRadius: '999px', fontSize: '11px'
                    });
                    tags.appendChild(archivedTag);
                }

                content.appendChild(title);
                content.appendChild(meta);
                if (tags.childNodes.length > 0) content.appendChild(tags);

                label.appendChild(checkbox);
                label.appendChild(content);
                listEl.appendChild(label);
            });

            if (state.filtered.length > state.visibleCount) {
                const loadMore = document.createElement('button');
                loadMore.textContent = `加载更多（剩余 ${state.filtered.length - state.visibleCount} 条）`;
                Object.assign(loadMore.style, {
                    width: '100%', padding: '8px 12px', border: '1px solid #ccc',
                    borderRadius: '6px', background: '#fff', cursor: 'pointer'
                });
                loadMore.onclick = () => {
                    state.visibleCount = Math.min(state.visibleCount + state.pageSize, state.filtered.length);
                    renderList();
                };
                listEl.appendChild(loadMore);
            }
        };

        renderBase();
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };
        refreshCacheSize();

        const listPromise = mode === 'project'
            ? listProjectSpaceConversations(workspaceId)
            : listConversations(workspaceId);
        listPromise
            .then(list => {
                state.list = list;
                state.loading = false;
                applyFilters();
                renderList();
            })
            .catch(err => {
                const statusEl = dialog.querySelector('#conv-status');
                state.loading = false;
                state.list = [];
                state.filtered = [];
                statusEl.textContent = `加载失败: ${err.message}`;
                renderList();
            });
    }

    /**
     * [重构] 多步骤、用户主导的导出对话框
     */
    function showExportDialog() {
        if (document.getElementById('export-dialog-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'export-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '99998',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const dialog = document.createElement('div');
        dialog.id = 'export-dialog';
        Object.assign(dialog.style, {
            background: '#fff', padding: '24px', borderRadius: '12px',
            boxShadow: '0 5px 15px rgba(0,0,0,.3)', width: '450px',
            fontFamily: 'sans-serif', color: '#333', boxSizing: 'border-box'
        });

        const closeDialog = () => document.body.removeChild(overlay);

        let pendingTeamAction = null;
        const renderStep = (step, action = null) => {
            pendingTeamAction = action;
            const currentProject = getCurrentProjectFromLocation();
            let html = '';
            switch (step) {
                case 'team': {
                    const detectedIds = detectAllWorkspaceIds();
                    html = `<h2 style="margin-top:0; margin-bottom: 20px; font-size: 18px;">导出团队空间</h2>`;

                    if (detectedIds.length > 1) {
                        html += `<div style="background: #eef2ff; border: 1px solid #818cf8; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0 0 12px 0; font-weight: bold; color: #4338ca;">🔎 检测到多个 Workspace，请选择一个:</p>
                                     <div id="workspace-id-list">`;
                        detectedIds.forEach((id, index) => {
                            html += `<label style="display: block; margin-bottom: 8px; padding: 8px; border-radius: 6px; cursor: pointer; border: 1px solid #ddd; background: #fff;">
                                         <input type="radio" name="workspace_id" value="${id}" ${index === 0 ? 'checked' : ''}>
                                         <code style="margin-left: 8px; font-family: monospace; color: #555;">${id}</code>
                                      </label>`;
                        });
                        html += `</div></div>`;
                    } else if (detectedIds.length === 1) {
                        html += `<div style="background: #f0fdf4; border: 1px solid #4ade80; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0 0 8px 0; font-weight: bold; color: #166534;">✅ 已自动检测到 Workspace ID:</p>
                                     <code id="workspace-id-code" style="background: #e0e7ff; padding: 4px 8px; border-radius: 4px; font-family: monospace; color: #4338ca; word-break: break-all;">${detectedIds[0]}</code>
                                   </div>`;
                    } else {
                        html += `<div style="background: #fffbeb; border: 1px solid #facc15; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0; color: #92400e;">⚠️ 未能自动检测到 Workspace ID。</p>
                                     <p style="margin: 8px 0 0 0; font-size: 12px; color: #92400e;">请尝试刷新页面或打开一个团队对话，或在下方手动输入。</p>
                                   </div>
                                   <label for="team-id-input" style="display: block; margin-bottom: 8px; font-weight: bold;">手动输入 Team Workspace ID:</label>
                                   <input type="text" id="team-id-input" placeholder="粘贴您的 Workspace ID (ws-...)" style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #ccc; box-sizing: border-box;">`;
                    }

                    let actionButtons = '';
                    if (pendingTeamAction === 'all') {
                        actionButtons = `<button id="start-team-export-btn" style="padding: 10px 16px; border: none; border-radius: 8px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部 (ZIP)</button>`;
                    } else if (pendingTeamAction === 'select') {
                        actionButtons = `<button id="start-team-picker-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">选择对话导出</button>`;
                    } else {
                        actionButtons = `<button id="start-team-export-btn" style="padding: 10px 16px; border: none; border-radius: 8px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部 (ZIP)</button>
                                     <button id="start-team-picker-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">选择对话导出</button>`;
                    }

                    html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 24px;">
                                 <button id="back-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">返回</button>
                                 <div style="display: flex; gap: 8px;">
                                     ${actionButtons}
                                 </div>
                               </div>`;
                    break;
                }

                case 'initial':
                default:
                    html = `<h2 style="margin-top:0; margin-bottom: 20px; font-size: 18px;">选择要导出的空间</h2>
                                <div style="display: flex; flex-direction: column; gap: 16px;">
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">个人空间</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出您个人账户下的对话。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-personal-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-personal-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话导出</button>
                                        </div>
                                    </div>
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">项目空间</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出项目空间下的对话，将按项目自动分组。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-current-project-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; font-weight: bold;">导出当前项目${currentProject?.title && currentProject.title !== currentProject.id ? ` (${currentProject.title})` : ''}</button>
                                            <button id="select-project-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-project-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话导出</button>
                                        </div>
                                    </div>
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">团队空间</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出团队空间下的对话，将自动检测ID。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-team-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-team-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话导出</button>
                                        </div>
                                    </div>
                                </div>
                                <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
                                    <button id="debug-project-api-btn" style="margin-right:auto; padding: 10px 16px; border: 1px solid #94a3b8; border-radius: 8px; background: #fff; cursor: pointer;">调试项目接口</button>
                                    <button id="cancel-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">取消</button>
                                </div>`;
                    break;
            }
            dialog.innerHTML = html;
            attachListeners(step);
        };

        const attachListeners = (step) => {
            if (step === 'initial') {
                document.getElementById('select-personal-btn').onclick = () => {
                    closeDialog();
                    startExportProcess('personal', null, true);
                };
                document.getElementById('select-personal-picker-btn').onclick = () => {
                    closeDialog();
                    showConversationPicker({ mode: 'personal', workspaceId: null });
                };
                document.getElementById('select-current-project-btn').onclick = () => {
                    let project = getCurrentProjectFromLocation();
                    if (!project) {
                        const input = prompt('请粘贴目标项目 URL 或 g-p-... ID：', window.location.href);
                        project = parseProjectFromText(input);
                    }
                    if (!project) {
                        alert('没有识别到有效的项目/GPT ID。请打开目标项目页，或粘贴包含 g-p-... 的 URL。');
                        return;
                    }
                    closeDialog();
                    startSingleProjectExportProcess(project, null, true);
                };
                document.getElementById('select-project-btn').onclick = () => {
                    closeDialog();
                    startProjectSpaceExportProcess(null, true);
                };
                document.getElementById('select-project-picker-btn').onclick = () => {
                    closeDialog();
                    showConversationPicker({ mode: 'project', workspaceId: null });
                };
                const startTeamFlow = (action) => {
                    const detectedIds = detectAllWorkspaceIds();
                    if (detectedIds.length === 1) {
                        const workspaceId = detectedIds[0];
                        closeDialog();
                        if (action === 'all') {
                            startExportProcess('team', workspaceId, true);
                        } else {
                            showConversationPicker({ mode: 'team', workspaceId });
                        }
                        return;
                    }
                    renderStep('team', action);
                };
                document.getElementById('select-team-btn').onclick = () => startTeamFlow('all');
                document.getElementById('select-team-picker-btn').onclick = () => startTeamFlow('select');
                document.getElementById('debug-project-api-btn').onclick = () => {
                    closeDialog();
                    showProjectEndpointDebugger(null);
                };
                document.getElementById('cancel-btn').onclick = closeDialog;
            } else if (step === 'team') {
                document.getElementById('back-btn').onclick = () => renderStep('initial');
                const resolveWorkspaceId = () => {
                    let workspaceId = '';
                    const radioChecked = document.querySelector('input[name="workspace_id"]:checked');
                    const codeEl = document.getElementById('workspace-id-code');
                    const inputEl = document.getElementById('team-id-input');

                    if (radioChecked) {
                        workspaceId = radioChecked.value;
                    } else if (codeEl) {
                        workspaceId = codeEl.textContent;
                    } else if (inputEl) {
                        workspaceId = inputEl.value.trim();
                    }

                    if (!workspaceId) {
                        alert('请选择或输入一个有效的 Team Workspace ID！');
                        return;
                    }
                    return workspaceId;
                };
                const exportAllBtn = document.getElementById('start-team-export-btn');
                const pickerBtn = document.getElementById('start-team-picker-btn');
                if (exportAllBtn) exportAllBtn.onclick = () => {
                    const workspaceId = resolveWorkspaceId();
                    if (!workspaceId) return;
                    closeDialog();
                    startExportProcess('team', workspaceId, true);
                };
                if (pickerBtn) pickerBtn.onclick = () => {
                    const workspaceId = resolveWorkspaceId();
                    if (!workspaceId) return;
                    closeDialog();
                    showConversationPicker({ mode: 'team', workspaceId });
                };
            }
        };

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };
        renderStep('initial');
    }

    function addBtn() {
        if (document.getElementById('gpt-rescue-btn')) return;
        const b = document.createElement('button');
        b.id = 'gpt-rescue-btn';
        b.textContent = 'Export Conversations';
        Object.assign(b.style, {
            position: 'fixed', bottom: '24px', right: '24px', zIndex: '99997',
            padding: '10px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer',
            fontWeight: 'bold', background: '#10a37f', color: '#fff', fontSize: '14px',
            boxShadow: '0 3px 12px rgba(0,0,0,.15)', userSelect: 'none'
        });
        b.onclick = showExportDialog;
        document.body.appendChild(b);
    }

    // --- 脚本启动 ---
    setTimeout(addBtn, 2000);

    async function scanForSync(workspaceId) {
        if (!workspaceId) throw new Error('请在设置中明确填写当前 ChatGPT Workspace ID，避免跨账户混用');
        exportDiagnostics = [];
        const root = await listConversations(workspaceId, { skipProjects: true });
        const projects = await getProjectSpaces(workspaceId, { conversationsPerGizmo: PROJECT_SIDEBAR_PREVIEW, ownedOnly: false });
        const map = new Map();
        root.forEach(e => upsertConversationEntry(map, e));
        const headers = { Authorization: `Bearer ${accessToken}`, 'oai-device-id': getOaiDeviceId(), 'ChatGPT-Account-Id': workspaceId };
        for (const project of projects) {
            const entries = await fetchProjectConversationEntries(project, headers, root);
            entries.forEach(e => upsertConversationEntry(map, e));
        }
        if (exportDiagnostics.some(line => /所有参数形态均失败|重复分页/.test(line)))
            throw new Error('项目分页不完整，已停止增量扫描；可使用原导出界面检查项目');
        const titles = new Map(projects.map(p => [p.id,p.title]));
        for (const entry of map.values()) if (titles.has(entry.projectId)) entry.projectTitle=titles.get(entry.projectId);
        return { entries: [...map.values()], projects: projects.map(p => ({ id: p.id, title: p.title })), cacheSize: await ExportCache.size() };
    }

    window.ChatGPTExporter = window.ChatGPTExporter || {};
    Object.assign(window.ChatGPTExporter, {
        scanForSync,
        detailForSync: async (entry, workspaceId) => {
            if (!await ensureAccessToken()) throw new Error('登录状态已过期，请重新登录后继续');
            const data = await getConversation(entry.id, workspaceId, { useCache: true, serverUpdateTime: entry.update_time });
            return { id: entry.id, markdown: convertConversationToMarkdown(data), cacheHit: !!data.__cache_hit };
        },
        showDialog: showExportDialog,
        startManualExport: (mode = 'personal', workspaceId = null, useCache = true) => {
            if (mode === 'project') {
                return startProjectSpaceExportProcess(workspaceId, useCache);
            }
            return startExportProcess(mode, workspaceId, useCache);
        },
        exportProject: (projectOrUrl, workspaceId = null, useCache = true) => {
            const project = typeof projectOrUrl === 'string'
                ? parseProjectFromText(projectOrUrl)
                : projectOrUrl;
            return startSingleProjectExportProcess(project, workspaceId, useCache);
        },
        exportCurrentProject: (workspaceId = null, useCache = true) => {
            return startSingleProjectExportProcess(getCurrentProjectFromLocation(), workspaceId, useCache);
        },
        startScheduledExport,
        debugProjectEndpoints: showProjectEndpointDebugger,
        runProjectEndpointDebug,
        clearCache: () => ExportCache.clear(),
        cacheSize: () => ExportCache.size(),
        cacheAvailable: () => ExportCache.available
    });

    document.documentElement.setAttribute('data-chatgpt-exporter-ready', '1');
    window.dispatchEvent(new CustomEvent('CHATGPT_EXPORTER_READY'));

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data?.type !== 'CHATGPT_EXPORTER_COMMAND') return;
        const api = window.ChatGPTExporter;
        if (!api) return;
        try {
            switch (data.action) {
                case 'START_SCHEDULED_EXPORT':
                    api.startScheduledExport(data.payload || {});
                    break;
                case 'OPEN_DIALOG':
                    api.showDialog();
                    break;
                case 'START_MANUAL_EXPORT':
                    api.startManualExport(data.payload?.mode, data.payload?.workspaceId, data.payload?.useCache !== false);
                    break;
                case 'CLEAR_CACHE':
                    api.clearCache().then(() => console.log('[ChatGPT Exporter] cache cleared'));
                    break;
                default:
                    console.warn('[ChatGPT Exporter] 未知命令:', data.action);
            }
        } catch (err) {
            console.error('[ChatGPT Exporter] 处理命令失败:', err);
        }
    });

})();

(() => {
    'use strict';

    const PROVIDERS = {
        QQ_MUSIC: { label: 'QQ 音乐', dot: 'qq', other: 'APPLE_MUSIC' },
        APPLE_MUSIC: { label: 'Apple Music', dot: 'apple', other: 'QQ_MUSIC' },
        NETEASE_MUSIC: { label: '网易云音乐', dot: 'netease' }
    };
    const LEVEL_CLASS = { SUCCESS: 'is-ok', WARN: 'is-warn', ERROR: 'is-error' };
    const DEMO_SOURCE_URL = 'demo://builtin';
    const MAX_PREVIEW_ROWS = 30;

    const state = {
        connections: {},
        providers: [],
        config: {}
    };

    let sourceProvider = 'QQ_MUSIC';
    let targetProvider = 'APPLE_MUSIC';
    let previewData = null;
    let jobRunning = false;
    let latestJob = null;
    let pollTimer = null;
    let currentJobId = null;
    let jobTarget = null;
    let selectionJobId = null;
    let selectedIndices = new Set();
    let confirmationState = 'idle';
    let jobStatusError = false;
    let connectProvider = null;
    let libraryProvider = 'QQ_MUSIC';
    let lastFocused = null;
    let stateLoaded = false;
    let previewSeq = 0;
    let musicKitInstance = null;
    let backupData = null;
    let backupSeq = 0;
    let auth = { authenticated: false, username: null, mode: 'public' };
    let authReady = false;
    let authGeneration = 0;
    let authRefreshPromise = null;
    let authBusy = false;
    let authMode = 'login';
    let sessionLoading = false;
    let currentLoaded = false;
    let historyOffset = 0;
    let historyHasMore = false;
    let historySeq = 0;
    let historyDetailId = null;

    const $ = (id) => document.getElementById(id);

    const els = {};

    function cacheElements() {
        [
            'headerDemoBtn', 'heroDemoBtn', 'sideDemoBtn', 'openLibraryBtn', 'sourceChip', 'targetChip',
            'swapBtn', 'sourceUrl', 'useSampleBtn', 'previewBtn', 'previewPanel', 'playlistName',
            'migrateBtn', 'migrateNote', 'linkHint', 'demoStatCount', 'status-QQ_MUSIC',
            'status-APPLE_MUSIC', 'status-NETEASE_MUSIC', 'connectModal', 'connectTitle', 'connectSubtitle', 'connectIcon',
            'connectDemoBtn', 'realQQ', 'qqCookie', 'connectQQReal', 'realApple', 'appleAuthBtn',
            'realNetease', 'neteasePairingCode', 'neteaseAuthNote', 'connectNeteaseReal',
            'appleAuthNote', 'appleTokenInput', 'connectAppleToken', 'disconnectBtn', 'progressModal',
            'progressView', 'resultView', 'progressTitle', 'progressStep', 'progressFill',
            'progressPercent', 'statMatched', 'statUnmatched', 'statTotal', 'liveLog', 'progressError',
            'libraryModal', 'libraryTitle', 'libraryTabs', 'libraryList', 'jobPill', 'jobPillText',
            'toastContainer', 'confettiCanvas', 'workspace', 'backupName', 'backupUrl', 'backupReadQq',
            'backupText', 'backupParse', 'backupFile', 'backupCount', 'backupStatus', 'backupTracks',
            'backupJson', 'backupCsv', 'reviewView', 'reviewTitle', 'reviewSummary', 'reviewWriteNote',
            'reviewList', 'reviewSelectedCount', 'clearSelectionBtn', 'selectHighBtn',
            'confirmMigrationBtn', 'abandonPreviewBtn', 'reviewError', 'jobStatusError', 'refreshJobBtn',
            'accountBtn', 'logoutBtn', 'authModal', 'authTitle', 'authStatus', 'authRefreshBtn',
            'accountSummary', 'authTabs', 'authLoginTab', 'authRegisterTab', 'authForm', 'authUsername',
            'authPassword', 'registrationCodeField', 'registrationCode', 'authSubmitBtn', 'restoreCurrentBtn',
            'openHistoryBtn', 'historyModal', 'historyListPanel', 'historyList', 'historyPrevBtn',
            'historyNextBtn', 'historyPageLabel', 'historyDetailPanel', 'historyBackBtn', 'historyDetail', 'historyRetryBtn'
        ].forEach((id) => { els[id] = $(id); });
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    function providerLabel(provider) {
        return PROVIDERS[provider] ? PROVIDERS[provider].label : provider;
    }

    function otherProvider(provider) {
        return PROVIDERS[provider].other;
    }

    function formatDuration(seconds) {
        const value = Number(seconds) || 0;
        const minutes = Math.floor(value / 60);
        const rest = value % 60;
        return `${minutes}:${String(rest).padStart(2, '0')}`;
    }

    function staleSession() {
        return Object.assign(new Error('会话已变更，已忽略旧请求结果'), { code: 'STALE_SESSION' });
    }

    function checkGeneration(generation) {
        if (generation !== authGeneration) throw staleSession();
    }

    async function api(path, options = {}) {
        const generation = authGeneration;
        const method = options.method || 'GET';
        const mutation = !['GET', 'HEAD'].includes(method);
        if (!path.startsWith('/api/auth') && (!authReady || !auth.authenticated || authBusy)) {
            throw Object.assign(new Error('请先登录音桥账号，再明确执行操作'), { code: 'LOGIN_NEEDED' });
        }
        if (mutation && (!authReady || !auth.csrfToken || !auth.csrfHeader)) {
            throw new Error('安全令牌尚未就绪，请先重新查询登录状态；本次操作未提交');
        }
        const init = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
        if (mutation) init.headers[auth.csrfHeader] = auth.csrfToken;
        if (options.form) {
            init.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
            init.body = new URLSearchParams(options.form).toString();
        } else if (options.body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(options.body);
        }
        let response;
        let text;
        try {
            response = await fetch(path, init);
            text = await response.text();
        } catch (error) {
            checkGeneration(generation);
            throw error;
        }
        checkGeneration(generation);
        let payload = null;
        if (text) {
            try { payload = JSON.parse(text); } catch (ignored) { /* Invalid responses are not retried. */ }
        }
        if (!response.ok) {
            const error = Object.assign(new Error(payload && payload.error ? payload.error : `请求失败（${response.status}）`), {
                code: payload && payload.code, status: response.status
            });
            if (response.status === 401 && error.code === 'AUTH_REQUIRED') {
                expireSession('音桥登录已失效。请重新登录；已开始的写入可能继续，请先查阅历史和目标平台，不要重复提交。');
                throw staleSession();
            }
            if (response.status === 403 && error.code === 'CSRF_INVALID') {
                authReady = false;
                auth.csrfToken = null;
                renderAuth();
                try { await refreshAuth(); } catch (ignored) { /* Explicit read-only recovery remains available. */ }
                checkGeneration(generation);
                error.message = '安全令牌已失效，已尝试刷新登录状态；本次操作没有自动重试。请核对状态后再明确操作。';
                toast(error.message, 'error', 7000);
            }
            throw error;
        }
        if (text && payload === null) throw new Error('服务返回了无效响应；不会自动重试操作');
        return payload;
    }

    /* ---------------- TuneBridge account (not music-platform credentials) ---------------- */

    function clearAuthSecrets() {
        els.authPassword.value = '';
        els.registrationCode.value = '';
    }

    function clearPrivateUi() {
        // Invalidate every pending API response before removing account-specific data.
        authGeneration++;
        authRefreshPromise = null;
        window.clearTimeout(pollTimer);
        previewSeq++;
        historySeq++;
        latestJob = null;
        currentJobId = null;
        jobTarget = null;
        selectionJobId = null;
        selectedIndices.clear();
        confirmationState = 'idle';
        jobRunning = false;
        jobStatusError = false;
        currentLoaded = false;
        sessionLoading = false;
        stateLoaded = false;
        state.connections = {};
        state.providers = [];
        state.config = {};
        connectProvider = null;
        libraryProvider = 'QQ_MUSIC';
        sourceProvider = 'QQ_MUSIC';
        targetProvider = 'APPLE_MUSIC';
        musicKitInstance = null;
        document.querySelectorAll('.modal:not(.is-hidden)').forEach((modal) => closeModal(modal, { silent: true, keepPill: true }));
        clearSensitiveInputs();
        clearAuthSecrets();
        els.authUsername.value = '';
        els.accountSummary.replaceChildren();
        els.authStatus.textContent = '';
        hidePreview();
        resetProgressUi();
        hideJobPill();
        clearBackup();
        ['sourceUrl', 'playlistName', 'backupName', 'backupUrl', 'backupText', 'backupFile'].forEach((id) => { els[id].value = ''; });
        els.libraryList.replaceChildren();
        els.libraryTitle.textContent = '演示音乐库';
        els.historyList.replaceChildren();
        els.historyDetail.replaceChildren();
        els.historyPageLabel.textContent = '';
        historyOffset = 0;
        historyHasMore = false;
        historyDetailId = null;
        els.toastContainer.replaceChildren();
        els.demoStatCount.textContent = '0';
        els.restoreCurrentBtn.classList.add('is-hidden');
        els.previewBtn.disabled = false;
        renderState();
        updateDemoAvailability();
        syncDirection();
    }

    function expireSession(message) {
        clearPrivateUi();
        auth = { authenticated: false, username: null, mode: 'public' };
        authReady = false;
        authBusy = false;
        authMode = 'login';
        renderAuth();
        openModal(els.authModal);
        els.authStatus.textContent = message;
        // Only reload the auth token, never the failed operation.
        refreshAuth().catch(() => {});
    }

    async function refreshAuth() {
        if (authRefreshPromise) return authRefreshPromise;
        const generation = authGeneration;
        const promise = (async () => {
            try {
                const snapshot = await api('/api/auth');
                checkGeneration(generation);
                if (!snapshot || typeof snapshot.authenticated !== 'boolean' || !snapshot.csrfToken || !snapshot.csrfHeader) {
                    throw new Error('登录状态响应无效，请重新查询');
                }
                if (auth.authenticated && (!snapshot.authenticated || snapshot.username !== auth.username)) clearPrivateUi();
                auth = snapshot;
                authReady = true;
                renderAuth();
                syncDirection();
                return snapshot;
            } catch (error) {
                if (generation !== authGeneration) throw staleSession();
                authReady = false;
                auth.csrfToken = null;
                renderAuth();
                els.authStatus.textContent = `无法确认音桥登录状态：${error.message}。本地备份仍可使用。`;
                throw error;
            }
        })();
        authRefreshPromise = promise;
        try { return await promise; } finally {
            if (authRefreshPromise === promise) authRefreshPromise = null;
        }
    }

    function renderAuth() {
        const signedIn = authReady && auth.authenticated;
        const registration = !signedIn && authReady && auth.registrationAllowed === true;
        if (!registration) authMode = 'login';
        const registering = authMode === 'register';
        els.accountBtn.textContent = signedIn ? `音桥账号：${auth.username}` : '音桥账号登录';
        els.logoutBtn.classList.toggle('is-hidden', !signedIn);
        els.logoutBtn.disabled = authBusy || confirmationState === 'submitting';
        els.authTitle.textContent = signedIn ? '当前音桥账号' : registering ? '注册音桥账号' : '登录音桥账号';
        els.accountSummary.classList.toggle('is-hidden', !signedIn);
        els.accountSummary.textContent = signedIn ? `已登录本站账号 ${auth.username}。音乐平台连接独立管理，退出音桥会清除当前页面的私有数据。` : '';
        els.authTabs.classList.toggle('is-hidden', signedIn || !authReady);
        els.authRegisterTab.classList.toggle('is-hidden', !registration);
        els.authLoginTab.classList.toggle('active', !registering);
        els.authRegisterTab.classList.toggle('active', registering);
        els.authLoginTab.setAttribute('aria-pressed', String(!registering));
        els.authRegisterTab.setAttribute('aria-pressed', String(registering));
        els.authForm.classList.toggle('is-hidden', signedIn || !authReady);
        els.authPassword.autocomplete = registering ? 'new-password' : 'current-password';
        const codeRequired = registering && (auth.registrationCodeRequired || auth.mode === 'public');
        els.registrationCodeField.classList.toggle('is-hidden', !codeRequired);
        els.registrationCode.required = Boolean(codeRequired);
        els.registrationCode.disabled = !codeRequired || authBusy;
        els.authSubmitBtn.textContent = authBusy ? '正在处理，请勿重复提交…' : registering ? '注册音桥账号' : '登录音桥';
        [els.authUsername, els.authPassword, els.authSubmitBtn, els.authLoginTab, els.authRegisterTab].forEach((node) => { node.disabled = authBusy; });
        els.authRefreshBtn.classList.toggle('is-hidden', authReady);
        els.authRefreshBtn.disabled = authBusy;
    }

    function openAuth(message = '') {
        renderAuth();
        openModal(els.authModal);
        if (message) els.authStatus.textContent = message;
        if (!authReady && !authBusy) refreshAuth().catch(() => {});
    }

    function setAuthMode(mode) {
        if (authBusy || auth.authenticated || (mode === 'register' && auth.registrationAllowed !== true)) return;
        authMode = mode;
        els.authStatus.textContent = '';
        renderAuth();
    }

    function requireLogin() {
        if (authBusy) {
            toast('正在处理音桥账号操作，请稍候', 'info');
            return false;
        }
        if (!authReady || !auth.authenticated) {
            openAuth('平台读取、连接、演示和历史需要音桥账号登录。登录后请重新点击操作，不会自动执行。');
            return false;
        }
        return true;
    }

    async function submitAuth(event) {
        event.preventDefault();
        if (authBusy || !authReady || auth.authenticated) return;
        const registering = authMode === 'register';
        if (registering && auth.registrationAllowed !== true) return;
        if (!els.authForm.reportValidity()) return;
        const generation = authGeneration;
        const username = els.authUsername.value;
        const password = els.authPassword.value;
        const registrationCode = els.registrationCode.value;
        clearAuthSecrets();
        authBusy = true;
        renderAuth();
        els.authStatus.textContent = registering ? '正在注册音桥账号…' : '正在登录音桥…';
        try {
            if (registering) {
                await api('/api/auth/register', { method: 'POST', body: { username, password, registrationCode } });
                checkGeneration(generation);
                authMode = 'login';
                els.authStatus.textContent = '注册成功，尚未登录。请填写密码并明确点击「登录音桥」。';
            } else {
                await api('/api/auth/login', { method: 'POST', form: { username, password } });
                // Login rotates the session and CSRF token. Discard pre-login responses.
                checkGeneration(generation);
                clearPrivateUi();
                authReady = false;
                authRefreshPromise = null;
                await refreshAuth();
                authBusy = false;
                renderAuth();
                if (!auth.authenticated) throw new Error('登录未完成，请重新查询登录状态');
                closeModal(els.authModal);
                await loadSession();
                return;
            }
        } catch (error) {
            if (error.code === 'STALE_SESSION') return;
            els.authStatus.textContent = `${error.message}。请求不会自动重试。`;
            if (!registering) {
                authReady = false;
                auth.csrfToken = null;
                // A lost login response can mean login succeeded; query first, never resubmit.
                openModal(els.authModal);
            }
        } finally {
            clearAuthSecrets();
            authBusy = false;
            renderAuth();
        }
    }

    async function logout() {
        if (!authReady || !auth.authenticated || authBusy || confirmationState === 'submitting') return;
        if (jobRunning && !window.confirm('当前任务尚未结束。退出音桥不会撤销已开始的写入，后台可能继续执行。之后请先检查历史与目标平台，不要重复提交。确定退出吗？')) return;
        authBusy = true;
        clearPrivateUi();
        renderAuth();
        try {
            await api('/api/auth/logout', { method: 'POST' });
            clearAuthSecrets();
            window.location.reload();
        } catch (error) {
            if (error.code === 'STALE_SESSION') return;
            authReady = false;
            auth.csrfToken = null;
            authBusy = false;
            renderAuth();
            openModal(els.authModal);
            els.authStatus.textContent = '退出结果尚未确认，不能认定服务器已退出。本页私有数据已清除，请重新查询登录状态；不会自动重试退出。';
        }
    }

    async function loadSession() {
        if (!authReady || !auth.authenticated || sessionLoading || currentLoaded || currentJobId) return;
        const generation = authGeneration;
        sessionLoading = true;
        els.restoreCurrentBtn.classList.add('is-hidden');
        syncDirection();
        try {
            if (!await refreshState()) throw new Error('无法读取平台连接状态');
            checkGeneration(generation);
            const job = await api('/api/migrations/current');
            checkGeneration(generation);
            currentLoaded = true;
            if (job) {
                currentJobId = job.id;
                jobTarget = job.target ? { ...job.target } : null;
                confirmationState = ['RUNNING', 'QUEUED'].includes(job.status) ? 'accepted' : 'idle';
                selectionJobId = null;
                selectedIndices.clear();
                resetProgressUi();
                acceptJob(job);
                showJobPill(job);
            }
        } catch (error) {
            if (generation !== authGeneration) return;
            currentLoaded = false;
            els.restoreCurrentBtn.classList.remove('is-hidden');
            toast(`无法恢复当前任务：${error.message}。请先只读查询，避免重复创建任务。`, 'error', 7000);
        } finally {
            if (generation === authGeneration) {
                sessionLoading = false;
                syncDirection();
            }
        }
    }

    function toast(message, type = 'info', duration = 4200) {
        const node = document.createElement('div');
        node.className = `toast is-${type}`;
        node.textContent = message;
        node.addEventListener('click', () => dismissToast(node));
        els.toastContainer.appendChild(node);
        while (els.toastContainer.children.length > 3) {
            els.toastContainer.removeChild(els.toastContainer.firstElementChild);
        }
        window.setTimeout(() => dismissToast(node), duration);
    }

    function dismissToast(node) {
        if (!node || !node.parentNode) {
            return;
        }
        node.classList.add('is-out');
        window.setTimeout(() => node.remove(), 260);
    }

    function setButtonBusy(button, busy, busyText) {
        if (!button) {
            return;
        }
        if (busy) {
            if (!button.dataset.originalText) {
                button.dataset.originalText = button.textContent;
            }
            button.disabled = true;
            button.classList.add('is-busy');
            if (busyText) {
                button.textContent = busyText;
            }
        } else {
            button.disabled = false;
            button.classList.remove('is-busy');
            if (button.dataset.originalText) {
                button.textContent = button.dataset.originalText;
                delete button.dataset.originalText;
            }
        }
    }

    /* ---------------- Modals ---------------- */

    function openModal(modal) {
        if (!modal) {
            return;
        }
        lastFocused = document.activeElement;
        document.querySelectorAll('.modal:not(.is-hidden)').forEach((open) => {
            if (open !== modal) {
                closeModal(open, { silent: true });
            }
        });
        modal.classList.remove('is-hidden');
        document.body.classList.add('modal-open');
        document.querySelectorAll('.app-main, .sidebar, .job-pill, .skip-link').forEach((node) => {
            node.inert = true;
        });
        window.setTimeout(() => {
            const close = modal.querySelector('.modal-close');
            if (close) {
                close.focus({ preventScroll: true });
            }
        }, 60);
    }

    function closeModal(modal, options = {}) {
        if (!modal) {
            return;
        }
        const wasOpen = !modal.classList.contains('is-hidden');
        modal.classList.add('is-hidden');
        if (!document.querySelector('.modal:not(.is-hidden)')) {
            document.body.classList.remove('modal-open');
            document.querySelectorAll('.app-main, .sidebar, .job-pill, .skip-link').forEach((node) => {
                node.inert = false;
            });
        }
        if (wasOpen && modal === els.connectModal) {
            clearSensitiveInputs();
        }
        if (wasOpen && modal === els.authModal) clearAuthSecrets();
        if (wasOpen && modal === els.historyModal) historySeq++;
        if (wasOpen && modal === els.progressModal && latestJob && !options.keepPill) {
            showJobPill(latestJob);
        }
        if (wasOpen && !options.silent) {
            if (lastFocused && typeof lastFocused.focus === 'function') {
                lastFocused.focus({ preventScroll: true });
            }
        }
    }

    function clearSensitiveInputs() {
        els.qqCookie.value = '';
        els.appleTokenInput.value = '';
        els.neteasePairingCode.value = '';
    }

    /* ---------------- State ---------------- */

    async function refreshState() {
        try {
            const snapshot = await api('/api/state');
            state.connections = snapshot.connections || {};
            state.providers = snapshot.providers || [];
            state.config = snapshot.config || {};
            stateLoaded = true;
            renderState();
            syncDirection();
            updateDemoAvailability();
            refreshDemoCount();
            return true;
        } catch (error) {
            stateLoaded = false;
            toast(`无法连接 TuneBridge 服务：${error.message}`, 'error', 7000);
            return false;
        }
    }

    function connection(provider) {
        return state.connections[provider] || { connected: false };
    }

    function isDemo(provider) {
        return connection(provider).connected && connection(provider).mode === 'DEMO';
    }

    function isReal(provider) {
        return connection(provider).connected && connection(provider).mode === 'REAL';
    }

    function renderState() {
        Object.keys(PROVIDERS).forEach((provider) => {
            const card = document.querySelector(`[data-provider-card="${provider}"]`);
            const status = els[`status-${provider}`];
            const button = card ? card.querySelector('[data-connect]') : null;
            const conn = connection(provider);
            if (!card || !status) {
                return;
            }
            card.classList.toggle('is-connected', Boolean(conn.connected));
            status.classList.remove('is-connected', 'is-demo', 'is-error');
            if (conn.connected) {
                const demo = conn.mode === 'DEMO';
                status.classList.add(demo ? 'is-demo' : 'is-connected');
                status.innerHTML = `<i></i>${escapeHtml(conn.accountName || (demo ? '演示账号' : '已连接'))}`;
                if (button) {
                    button.textContent = '管理';
                }
            } else {
                status.innerHTML = '<i></i>未连接';
                if (button) {
                    button.textContent = '连接';
                }
            }
        });
        Object.keys(PROVIDERS).forEach((provider) => {
            const card = document.querySelector(`[data-provider-card="${provider}"]`);
            const role = card ? card.querySelector('[data-role]') : null;
            if (!card || !role) {
                return;
            }
            const isSource = provider === sourceProvider;
            card.classList.toggle('is-source', isSource);
            card.classList.toggle('is-target', provider === targetProvider);
            role.textContent = isSource ? '来源 A' : provider === targetProvider ? '目标 B' : '未选用';
        });
    }

    function updateDemoAvailability() {
        const enabled = state.config.demoEnabled !== false;
        const demoButtons = [els.headerDemoBtn, els.heroDemoBtn, els.sideDemoBtn];
        demoButtons.forEach((button) => {
            if (!button) {
                return;
            }
            button.disabled = !enabled;
            button.title = enabled ? '' : '演示模式未开启';
        });
        const demoOption = els.connectModal.querySelector('.demo-option');
        const divider = els.connectModal.querySelector('.divider');
        if (demoOption) {
            demoOption.classList.toggle('is-hidden', !enabled);
        }
        if (divider) {
            divider.classList.toggle('is-hidden', !enabled);
        }
    }

    /* ---------------- Direction ---------------- */

    function syncDirection() {
        renderState();
        updateChip(els.sourceChip, sourceProvider, '来源 A', 'is-source');
        updateChip(els.targetChip, targetProvider, '目标 B', 'is-target');
        const direction = targetProvider === 'NETEASE_MUSIC' ? 'QQ_NETEASE'
                : sourceProvider === 'APPLE_MUSIC' ? 'APPLE_QQ' : 'QQ_APPLE';
        document.querySelectorAll('[name="directionChoice"]').forEach((input) => {
            input.checked = input.value === direction;
        });
        els.swapBtn.disabled = targetProvider === 'NETEASE_MUSIC';
        els.swapBtn.title = els.swapBtn.disabled ? '网易云音乐仅支持作为目标' : '交换迁移方向';
        els.swapBtn.setAttribute('aria-label', els.swapBtn.title);

        const targetConn = connection(targetProvider);
        els.sourceUrl.placeholder = sourceProvider === 'QQ_MUSIC'
                ? '粘贴 QQ 音乐歌单分享链接' : '粘贴 Apple Music 歌单分享链接';
        const sourceConn = connection(sourceProvider);
        const url = els.sourceUrl.value.trim();

        let ready = false;
        let note = '';
        if (jobRunning) {
            note = confirmationState === 'uncertain'
                    ? '确认结果尚不确定，请勿重复提交，打开任务查看状态'
                    : latestJob && latestJob.status === 'AWAITING_CONFIRMATION' && confirmationState === 'idle'
                        ? '匹配已完成，等待确认；可从浮动任务返回或选择「暂不迁移」'
                        : confirmationState === 'submitting' ? '正在提交确认，请勿重复点击…' : '任务进行中，请稍候…';
        } else if (!authReady || !auth.authenticated) {
            note = '请先登录本站音桥账号；本地备份导入与导出无需登录';
        } else if (!stateLoaded || !currentLoaded) {
            note = sessionLoading ? '正在同步连接与当前任务，请稍候…' : '需先只读查询当前任务，避免重复创建';
        } else if (!targetConn.connected) {
            note = `连接 ${providerLabel(targetProvider)} 后即可开始`;
        } else if (!url) {
            note = '粘贴来源歌单链接后即可开始';
        } else if (sourceProvider === 'APPLE_MUSIC' && !sourceConn.connected) {
            note = '请先连接 Apple Music 来源账号';
        } else if (url.startsWith('demo://') && sourceConn.mode !== 'DEMO') {
            note = '演示歌单需要先连接演示账号';
        } else {
            note = targetConn.mode === 'DEMO'
                    ? '演示匹配 · 先预览，确认后才写入演示音乐库，不触达真实账号'
                    : `仅在 ${providerLabel(targetProvider)} 搜索匹配；确认前不会创建或写入目标歌单`;
            ready = true;
        }
        els.migrateBtn.disabled = authBusy || (authReady && auth.authenticated && (!ready || jobRunning));
        els.logoutBtn.disabled = authBusy || confirmationState === 'submitting';
        els.migrateBtn.querySelector('.btn-label').textContent = jobRunning
                ? latestJob && latestJob.status === 'AWAITING_CONFIRMATION' && confirmationState === 'idle'
                    ? '等待确认' : '任务处理中'
                : '开始匹配';
        els.migrateNote.textContent = note;
        els.migrateNote.classList.toggle('is-ready', ready);

        updateHint();
        updateSampleButton();
    }

    function updateChip(chip, provider, roleText, accentClass) {
        if (!chip) {
            return;
        }
        const dot = chip.querySelector('.provider-dot');
        const name = chip.querySelector('span:not(.provider-dot)');
        const role = chip.querySelector('small');
        if (dot) {
            dot.classList.remove('qq', 'apple', 'netease');
            dot.classList.add(PROVIDERS[provider].dot);
        }
        if (name) {
            name.textContent = providerLabel(provider);
        }
        if (role) {
            role.textContent = roleText;
        }
        chip.classList.toggle('is-source', accentClass === 'is-source');
        chip.classList.toggle('is-target', accentClass === 'is-target');
    }

    function updateHint() {
        if (!els.linkHint) {
            return;
        }
        const conn = connection(sourceProvider);
        const url = els.sourceUrl.value.trim();
        let text = '';
        let tone = '';
        if (!authReady || !auth.authenticated) {
            text = '平台读取需登录音桥账号；QQ 公开歌单不需要 QQ 平台登录';
        } else if (sourceProvider === 'APPLE_MUSIC' && !conn.connected) {
            text = '请先连接 Apple Music 来源账号';
            tone = 'is-warn';
        } else if (url.startsWith('demo://') && conn.mode !== 'DEMO') {
            text = '演示歌单链接需要先连接来源平台的演示账号';
            tone = 'is-warn';
        } else if (url.startsWith('demo://')) {
            text = '演示歌单：使用内置曲库匹配，审阅并确认后才创建演示歌单';
            tone = 'is-ok';
        } else if (conn.mode === 'DEMO') {
            text = '当前为演示连接，可使用「用示例」或演示音乐库中的歌单';
            tone = 'is-warn';
        } else if (sourceProvider === 'QQ_MUSIC') {
            text = conn.mode === 'REAL'
                    ? '可读取公开歌单，也可读取你账号内的歌单'
                    : 'QQ 公开歌单可直接解析，无需登录';
        } else {
            text = '粘贴 Apple Music 歌单分享链接，例如 music.apple.com/…/pl.…';
        }
        if (previewData) {
            text = `已解析《${previewData.name}》，共 ${previewData.totalTracks} 首`;
            tone = 'is-ok';
        }
        els.linkHint.textContent = text;
        els.linkHint.classList.remove('is-warn', 'is-ok');
        if (tone) {
            els.linkHint.classList.add(tone);
        }
    }

    function updateSampleButton() {
        if (!els.useSampleBtn) {
            return;
        }
        let sample = '';
        if (isDemo(sourceProvider)) {
            sample = DEMO_SOURCE_URL;
        } else {
            const provider = state.providers.find((item) => item.id === sourceProvider);
            sample = provider && provider.sampleUrl ? provider.sampleUrl : '';
        }
        els.useSampleBtn.disabled = authReady && auth.authenticated && !sample;
        els.useSampleBtn.title = isDemo(sourceProvider) ? '使用内置演示歌单' : '使用平台公开示例歌单';
        els.useSampleBtn.dataset.sample = sample;
    }

    function hidePreview() {
        previewData = null;
        els.previewPanel.classList.add('is-hidden');
        els.previewPanel.innerHTML = '';
    }

    function resetSourceForDirection(clearUrl) {
        previewSeq++;
        els.previewBtn.disabled = false;
        hidePreview();
        if (clearUrl) {
            els.sourceUrl.value = '';
        }
        syncDirection();
    }

    /* ---------------- Preview ---------------- */

    async function previewPlaylist(options = {}) {
        if (!requireLogin()) return null;
        const url = els.sourceUrl.value.trim();
        const provider = sourceProvider;
        const seq = ++previewSeq;
        if (!url) {
            if (!options.silent) {
                toast('请先粘贴来源歌单链接', 'error');
                els.sourceUrl.focus();
            }
            return null;
        }
        hidePreview();
        els.previewBtn.disabled = true;
        els.previewPanel.classList.remove('is-hidden');
        els.previewPanel.innerHTML = '<div class="library-empty">正在读取歌单…</div>';
        try {
            const data = await api('/api/playlists/preview', {
                method: 'POST',
                body: { provider, url }
            });
            if (seq !== previewSeq) {
                return null;
            }
            previewData = data;
            renderPreview(data, provider);
            if (!options.silent) {
                toast(`已解析《${data.name}》，共 ${data.totalTracks} 首`, 'success', 2600);
            }
            syncDirection();
            return data;
        } catch (error) {
            if (seq !== previewSeq) {
                return null;
            }
            hidePreview();
            updateHint();
            if (!options.silent) {
                toast(error.message, 'error', 6500);
            }
            return null;
        } finally {
            if (seq === previewSeq) {
                els.previewBtn.disabled = false;
            }
        }
    }

    function renderPreview(data, provider) {
        const tracks = Array.isArray(data.tracks) ? data.tracks : [];
        const rows = tracks.slice(0, MAX_PREVIEW_ROWS).map((track, index) => `
            <div class="preview-track">
                <span>${String(index + 1).padStart(2, '0')}</span>
                <b>${escapeHtml(track.title)}</b>
                <em>${escapeHtml(track.artist || '未知歌手')}</em>
            </div>
        `).join('');
        const more = data.totalTracks > Math.min(tracks.length, MAX_PREVIEW_ROWS)
                ? `<div class="preview-more">还有 ${data.totalTracks - Math.min(tracks.length, MAX_PREVIEW_ROWS)} 首未展示${
                    data.truncated ? '，单次最多迁移 ' + tracks.length + ' 首' : ''}</div>`
                : '';
        const cover = data.coverUrl
                ? `<img src="${escapeHtml(data.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
                : '♪';
        els.previewPanel.innerHTML = `
            <div class="preview-head">
                <div class="preview-cover">${cover}</div>
                <div class="preview-meta">
                    <h4>${escapeHtml(data.name || '未命名歌单')}</h4>
                    <p>${escapeHtml(data.owner || providerLabel(provider))}${
                        data.description ? ' · ' + escapeHtml(data.description) : ''}</p>
                </div>
                <span class="preview-count">${data.totalTracks} 首</span>
            </div>
            <div class="preview-tracks">${rows}</div>
            ${more}
        `;
        els.previewPanel.classList.remove('is-hidden');
    }

    function clearBackup() {
        backupSeq++;
        backupData = null;
        els.backupCount.textContent = '0 首';
        els.backupStatus.textContent = '读取歌单或导入曲目后，就可以预览并下载。';
        els.backupTracks.replaceChildren();
        els.backupJson.disabled = true;
        els.backupCsv.disabled = true;
    }

    function showBackup(tracks, status) {
        backupData = tracks;
        els.backupCount.textContent = `${tracks.length} 首`;
        els.backupStatus.textContent = status;
        els.backupTracks.innerHTML = tracks.slice(0, 100).map((track, index) => `
            <div class="preview-track">
                <span>${String(index + 1).padStart(2, '0')}</span>
                <b>${escapeHtml(track.title)}</b>
                <em>${escapeHtml(track.artist || '未知歌手')}${track.album ? ' · ' + escapeHtml(track.album) : ''}</em>
            </div>
        `).join('');
        if (tracks.length > 100) {
            const more = document.createElement('div');
            more.className = 'preview-more';
            more.textContent = `仅展示前 100 首，导出包含全部 ${tracks.length} 首。`;
            els.backupTracks.appendChild(more);
        }
        els.backupJson.disabled = false;
        els.backupCsv.disabled = false;
    }

    function backupError(error) {
        els.backupStatus.textContent = error.message;
        toast(error.message, 'error', 6500);
    }

    function parseBackupText() {
        clearBackup();
        try {
            const tracks = TuneBridgeBackup.parseLines(els.backupText.value);
            showBackup(tracks, '已从粘贴的文本生成预览，顺序和重复曲目均会保留。');
        } catch (error) {
            backupError(error);
        }
    }

    async function importBackupFile() {
        const file = els.backupFile.files[0];
        if (!file) return;
        els.backupFile.value = '';
        clearBackup();
        const seq = backupSeq;
        try {
            if (file.size > 5 * 1024 * 1024) throw new Error('文件不能超过 5 MB');
            const text = await file.text();
            if (seq !== backupSeq) return;
            let tracks;
            if (/\.json$/i.test(file.name)) {
                const playlist = TuneBridgeBackup.parseJson(text);
                els.backupName.value = playlist.name;
                tracks = playlist.tracks;
            } else if (/\.csv$/i.test(file.name)) {
                tracks = TuneBridgeBackup.parseCsv(text);
            } else {
                throw new Error('请选择 CSV 或 JSON 文件');
            }
            els.backupText.value = '';
            showBackup(tracks, `已在本地导入 ${file.name}，顺序和重复曲目均会保留。`);
        } catch (error) {
            if (seq === backupSeq) backupError(error);
        }
    }

    async function readQqBackup() {
        if (!requireLogin()) return;
        clearBackup();
        const url = els.backupUrl.value.trim();
        if (!url) {
            backupError(new Error('请先粘贴 QQ 音乐歌单链接'));
            els.backupUrl.focus();
            return;
        }
        const seq = backupSeq;
        const previousName = els.backupName.value;
        setButtonBusy(els.backupReadQq, true, '正在读取…');
        els.backupStatus.textContent = '正在读取 QQ 音乐歌单…';
        try {
            const data = await api('/api/playlists/backup', {
                method: 'POST', body: { provider: 'QQ_MUSIC', url }
            });
            if (seq !== backupSeq) return;
            const playlist = TuneBridgeBackup.parseJson(JSON.stringify({ name: data.name || '', tracks: data.tracks }));
            if (els.backupName.value === previousName) els.backupName.value = playlist.name;
            els.backupText.value = '';
            showBackup(playlist.tracks, '已载入平台返回的曲目；实际完整性取决于 QQ 音乐的返回结果。');
        } catch (error) {
            if (seq === backupSeq) backupError(error);
        } finally {
            setButtonBusy(els.backupReadQq, false);
        }
    }

    function downloadBackup(format) {
        if (!backupData) return;
        const name = els.backupName.value.trim() || '我的歌单';
        const fileName = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || '歌单备份';
        const content = format === 'csv'
                ? '\uFEFF' + TuneBridgeBackup.serializeCsv(backupData)
                : TuneBridgeBackup.serializeJson({ name, tracks: backupData });
        const type = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
        const url = URL.createObjectURL(new Blob([content], { type }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${fileName}.${format}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /* ---------------- Connections ---------------- */

    function openConnect(provider) {
        if (!requireLogin()) return;
        connectProvider = provider;
        clearSensitiveInputs();
        els.connectTitle.textContent = `连接 ${providerLabel(provider)}`;
        els.connectSubtitle.textContent = provider === 'QQ_MUSIC'
                ? '公开歌单可直接读取；连接后可创建并写入歌单'
                : provider === 'APPLE_MUSIC'
                    ? '授权后，新歌单会写入你的 iCloud 音乐资料库'
                    : '仅作为 QQ 音乐的目标；真实模式使用服务器本机 CLI';
        const iconSource = document.querySelector(`[data-provider-card="${provider}"] .provider-icon`);
        els.connectIcon.className = `provider-icon large ${PROVIDERS[provider].dot}`;
        els.connectIcon.innerHTML = iconSource ? iconSource.innerHTML : '';
        els.realQQ.classList.toggle('is-hidden', provider !== 'QQ_MUSIC');
        els.realApple.classList.toggle('is-hidden', provider !== 'APPLE_MUSIC');
        els.realNetease.classList.toggle('is-hidden', provider !== 'NETEASE_MUSIC');
        if (provider === 'NETEASE_MUSIC') {
            const ready = auth.mode === 'local' && state.config.neteaseRealReady === true;
            els.connectNeteaseReal.disabled = !ready;
            els.neteasePairingCode.disabled = !ready;
            els.neteaseAuthNote.textContent = auth.mode === 'public'
                    ? '公开多用户服务不提供真实网易云本机 CLI，避免共享服务器上的平台账号；可使用演示授权。'
                    : ready ? '服务器已启用本机 CLI，请输入本机操作员设置的配对码。'
                        : '服务器尚未启用本机 CLI，无法连接真实网易云；可使用演示授权。';
        }
        els.disconnectBtn.classList.toggle('is-hidden', !connection(provider).connected);
        els.disconnectBtn.textContent = `断开 ${providerLabel(provider)} 连接`;
        if (provider === 'APPLE_MUSIC') {
            refreshAppleNote();
        }
        openModal(els.connectModal);
    }

    function refreshAppleNote() {
        const ready = state.config.appleRealReady === true;
        els.appleAuthBtn.disabled = !ready;
        els.appleAuthNote.textContent = ready
                ? '将打开 Apple 授权窗口，完成后自动返回音桥。'
                : '服务端尚未配置 Apple 开发者令牌，暂时无法完成真实授权；请先使用演示模式。';
    }

    async function connectDemo(provider) {
        if (!requireLogin()) return false;
        const generation = authGeneration;
        try {
            await api(`/api/connections/${provider}`, { method: 'POST', body: { mode: 'demo' } });
            const loaded = await refreshState();
            checkGeneration(generation);
            return loaded;
        } catch (error) {
            toast(error.message, 'error', 6000);
            return false;
        }
    }

    async function connectRealQq() {
        if (!requireLogin()) return;
        const generation = authGeneration;
        const cookie = els.qqCookie.value.trim();
        if (!cookie) {
            toast('请粘贴 y.qq.com 的 Cookie', 'error');
            els.qqCookie.focus();
            return;
        }
        setButtonBusy(els.connectQQReal, true, '正在验证…');
        try {
            await api('/api/connections/QQ_MUSIC', {
                method: 'POST',
                body: { mode: 'real', cookie }
            });
            clearSensitiveInputs();
            closeModal(els.connectModal);
            await refreshState();
            checkGeneration(generation);
            toast('QQ 音乐已连接', 'success');
        } catch (error) {
            toast(error.message, 'error', 7000);
        } finally {
            setButtonBusy(els.connectQQReal, false);
        }
    }

    async function connectRealNetease() {
        if (!requireLogin()) return;
        const generation = authGeneration;
        if (auth.mode !== 'local' || state.config.neteaseRealReady !== true) {
            clearSensitiveInputs();
            toast('服务器尚未启用本机 CLI，无法连接真实网易云', 'error');
            return;
        }
        const pairingCode = els.neteasePairingCode.value.trim();
        els.neteasePairingCode.value = '';
        if (!pairingCode) {
            toast('请输入本机操作员设置的配对码', 'error');
            els.neteasePairingCode.focus();
            return;
        }
        setButtonBusy(els.connectNeteaseReal, true, '正在验证…');
        try {
            await api('/api/connections/NETEASE_MUSIC', {
                method: 'POST', body: { mode: 'real', pairingCode }
            });
            if (connectProvider === 'NETEASE_MUSIC') closeModal(els.connectModal);
            await refreshState();
            checkGeneration(generation);
            toast('网易云本机 CLI 已连接', 'success');
        } catch (error) {
            toast('网易云连接失败，请检查配对码及服务器本机 CLI 状态', 'error', 7000);
        } finally {
            setButtonBusy(els.connectNeteaseReal, false);
            els.connectNeteaseReal.disabled = auth.mode !== 'local' || state.config.neteaseRealReady !== true;
        }
    }

    async function connectRealApple(token) {
        if (!requireLogin()) return;
        const generation = authGeneration;
        if (!token) {
            toast('请先输入 Music-User-Token', 'error');
            return;
        }
        try {
            await api('/api/connections/APPLE_MUSIC', {
                method: 'POST',
                body: { mode: 'real', musicUserToken: token }
            });
            clearSensitiveInputs();
            closeModal(els.connectModal);
            await refreshState();
            checkGeneration(generation);
            toast('Apple Music 已连接', 'success');
        } catch (error) {
            toast(error.message, 'error', 8000);
        }
    }

    function loadMusicKit() {
        if (window.MusicKit) {
            return Promise.resolve(window.MusicKit);
        }
        return new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-musickit]');
            if (existing) {
                existing.addEventListener('load', () => resolve(window.MusicKit));
                existing.addEventListener('error', () => reject(new Error('无法加载 MusicKit')));
                return;
            }
            const script = document.createElement('script');
            script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
            script.async = true;
            script.crossOrigin = 'anonymous';
            script.dataset.musickit = 'true';
            script.onload = () => {
                if (window.MusicKit) {
                    resolve(window.MusicKit);
                } else {
                    reject(new Error('MusicKit 加载失败'));
                }
            };
            script.onerror = () => reject(new Error('无法加载 MusicKit，请检查网络后重试'));
            document.head.appendChild(script);
        });
    }

    async function authorizeApple() {
        const generation = authGeneration;
        const developerToken = state.config.appleDeveloperToken;
        if (!developerToken) {
            throw new Error('服务端未配置 Apple 开发者令牌，无法发起真实授权');
        }
        const MusicKit = await loadMusicKit();
        checkGeneration(generation);
        if (!musicKitInstance) {
            try {
                musicKitInstance = MusicKit.getInstance();
            } catch (ignored) {
                musicKitInstance = null;
            }
        }
        if (!musicKitInstance) {
            musicKitInstance = MusicKit.configure({
                developerToken,
                app: { name: 'TuneBridge', build: '1.0.0' }
            });
        }
        const token = await musicKitInstance.authorize();
        checkGeneration(generation);
        if (!token) {
            throw new Error('Apple Music 授权未返回用户令牌');
        }
        return token;
    }

    async function disconnect(provider) {
        if (!requireLogin()) return;
        const generation = authGeneration;
        els.disconnectBtn.disabled = true;
        try {
            await api(`/api/connections/${provider}`, { method: 'DELETE' });
            closeModal(els.connectModal);
            await refreshState();
            checkGeneration(generation);
            toast(provider === 'NETEASE_MUSIC'
                    ? '已断开音桥连接；本机 CLI 未退出，账号状态可能仍保存在本机'
                    : `已断开 ${providerLabel(provider)}`, 'info', 7000);
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            els.disconnectBtn.disabled = false;
        }
    }

    /* ---------------- Migration ---------------- */

    async function startMigration() {
        if (!requireLogin()) return;
        if (!currentLoaded) {
            toast('请先完成当前任务的只读查询，再明确开始匹配', 'info');
            return;
        }
        if (jobRunning) {
            toast('已有任务进行中或等待确认，请先处理当前任务', 'info');
            hideJobPill();
            openModal(els.progressModal);
            return;
        }
        const url = els.sourceUrl.value.trim();
        if (!url) {
            toast('请先粘贴来源歌单链接', 'error');
            els.sourceUrl.focus();
            return;
        }
        if (!connection(targetProvider).connected) {
            toast(`请先连接目标平台 ${providerLabel(targetProvider)}`, 'error');
            openConnect(targetProvider);
            return;
        }
        if (sourceProvider === 'APPLE_MUSIC' && !connection(sourceProvider).connected) {
            toast('请先连接 Apple Music 来源账号', 'error');
            openConnect(sourceProvider);
            return;
        }
        if (url.startsWith('demo://') && !isDemo(sourceProvider)) {
            toast('演示歌单需要先连接来源平台的演示账号', 'error');
            openConnect(sourceProvider);
            return;
        }

        window.clearTimeout(pollTimer);
        jobRunning = true;
        latestJob = null;
        currentJobId = null;
        jobTarget = {
            provider: targetProvider,
            providerLabel: providerLabel(targetProvider),
            mode: connection(targetProvider).mode
        };
        selectionJobId = null;
        selectedIndices = new Set();
        confirmationState = 'idle';
        jobStatusError = false;
        resetProgressUi();
        syncDirection();
        hideJobPill();
        openModal(els.progressModal);

        try {
            const job = await api('/api/migrations', {
                method: 'POST',
                body: {
                    sourceProvider,
                    sourceUrl: url,
                    targetProvider,
                    playlistName: els.playlistName.value.trim()
                }
            });
            currentJobId = job.id;
            // Keep the job's original target, even if direction or connections change later.
            if (job.target) {
                jobTarget = { ...job.target };
            }
            acceptJob(job);
        } catch (error) {
            jobRunning = false;
            syncDirection();
            els.progressTitle.textContent = '无法开始匹配';
            els.progressStep.textContent = error.message;
            els.progressError.textContent = error.message;
            els.progressError.classList.remove('is-hidden');
            toast(error.message, 'error', 7000);
        }
    }

    function resetProgressUi() {
        els.progressView.classList.remove('is-hidden');
        els.reviewView.classList.add('is-hidden');
        els.reviewList.innerHTML = '';
        els.reviewError.classList.add('is-hidden');
        els.reviewError.textContent = '';
        els.jobStatusError.classList.add('is-hidden');
        els.jobStatusError.textContent = '';
        els.refreshJobBtn.classList.add('is-hidden');
        els.progressModal.setAttribute('aria-labelledby', 'progressTitle');
        els.resultView.classList.add('is-hidden');
        els.resultView.innerHTML = '';
        els.progressTitle.textContent = '正在读取与匹配歌单';
        els.progressStep.textContent = '准备中…';
        els.progressFill.style.width = '0%';
        els.progressFill.style.background = '';
        els.progressPercent.textContent = '0%';
        els.statMatched.textContent = '0';
        els.statUnmatched.textContent = '0';
        els.statTotal.textContent = '0';
        els.liveLog.innerHTML = '';
        els.progressError.classList.add('is-hidden');
        els.progressError.textContent = '';
    }

    function acceptJob(job) {
        if (!job || job.id !== currentJobId) return;
        window.clearTimeout(pollTimer);
        latestJob = job;
        if (confirmationState === 'uncertain' && (job.status === 'RUNNING' || job.status === 'COMPLETED')) {
            confirmationState = 'accepted';
        }
        jobStatusError = false;
        els.jobStatusError.classList.add('is-hidden');
        els.refreshJobBtn.classList.add('is-hidden');
        renderJob(job);
        if (job.status === 'AWAITING_CONFIRMATION') {
            jobRunning = true;
            if (confirmationState === 'accepted') confirmationState = 'uncertain';
            renderReview(job);
        } else if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'INTERRUPTED') {
            finishJob(job);
            return;
        } else {
            jobRunning = true;
            els.reviewView.classList.add('is-hidden');
            els.resultView.classList.add('is-hidden');
            els.progressView.classList.remove('is-hidden');
            els.progressModal.setAttribute('aria-labelledby', 'progressTitle');
            schedulePoll(job.id);
        }
        syncDirection();
        if (!els.jobPill.classList.contains('is-hidden')) showJobPill(job);
    }

    function showStatusError(message) {
        jobStatusError = true;
        els.jobStatusError.textContent = message;
        els.jobStatusError.classList.remove('is-hidden');
        els.refreshJobBtn.classList.remove('is-hidden');
        syncDirection();
        if (latestJob) showJobPill(latestJob);
    }

    function schedulePoll(jobId) {
        window.clearTimeout(pollTimer);
        if (latestJob && latestJob.status === 'AWAITING_CONFIRMATION') return;
        pollTimer = window.setTimeout(async () => {
            if (currentJobId !== jobId) return;
            try {
                const job = await api(`/api/migrations/${encodeURIComponent(jobId)}`);
                if (currentJobId !== jobId) return;
                acceptJob(job);
            } catch (error) {
                if (currentJobId !== jobId) return;
                // A lost status response does not mean the task stopped. Keep new tasks blocked.
                showStatusError(`获取任务状态失败：${error.message}。任务可能仍在运行，可只读查询状态；不会重新提交迁移。`);
            }
        }, 650);
    }

    async function refreshJobStatus() {
        const jobId = currentJobId;
        if (!jobId || confirmationState === 'submitting') return;
        setButtonBusy(els.refreshJobBtn, true, '正在查询…');
        try {
            const job = await api(`/api/migrations/${encodeURIComponent(jobId)}`);
            if (currentJobId !== jobId) return;
            acceptJob(job);
            if (confirmationState === 'uncertain' && job.status === 'AWAITING_CONFIRMATION') {
                showStatusError('确认结果仍不确定，当前服务端显示等待确认。为避免重复写入，确认按钮保持禁用；本次查询不会再次提交。');
            }
        } catch (error) {
            if (currentJobId === jobId) showStatusError(`获取任务状态失败：${error.message}。请勿重复提交确认。`);
        } finally {
            setButtonBusy(els.refreshJobBtn, false);
        }
    }

    function renderReview(job) {
        const matches = Array.isArray(job.matches) ? job.matches : [];
        if (selectionJobId !== job.id) {
            selectionJobId = job.id;
            selectedIndices = new Set(matches.filter((item) => item.matched && !item.lowConfidence
                    && Number.isInteger(item.index) && item.index >= 0).map((item) => item.index));
        }
        const matchedCount = matches.filter((item) => item.matched).length;
        const lowCount = matches.filter((item) => item.matched && item.lowConfidence).length;
        const targetName = jobTarget ? jobTarget.providerLabel || providerLabel(jobTarget.provider) : '目标平台';
        els.progressView.classList.add('is-hidden');
        els.resultView.classList.add('is-hidden');
        els.reviewView.classList.remove('is-hidden');
        els.progressModal.setAttribute('aria-labelledby', 'reviewTitle');
        els.reviewSummary.textContent = `《${job.source ? job.source.name : '来源歌单'}》 → ${targetName} · 共 ${matches.length} 首，已匹配 ${matchedCount} 首（低置信 ${lowCount} 首），未匹配 ${matches.length - matchedCount} 首`;
        els.reviewList.innerHTML = matches.map((item, row) => {
            const selectable = item.matched && Number.isInteger(item.index) && item.index >= 0;
            const warning = !item.matched ? '未匹配 · 不可选择'
                    : item.lowConfidence ? '低置信 · 请核对版本，默认不选' : '高置信匹配';
            return `
                <label class="review-track ${!item.matched ? 'is-unmatched' : item.lowConfidence ? 'is-low' : ''}">
                    <input type="checkbox" data-match-index="${selectable ? item.index : ''}"
                        ${selectable && selectedIndices.has(item.index) ? 'checked' : ''} ${selectable ? '' : 'disabled'}>
                    <span class="review-track-main">
                        <span class="review-source">
                            <span class="track-column-label">来源歌曲</span>
                            <b>${row + 1}. ${escapeHtml(item.title)}</b>
                            <small>${escapeHtml(item.artist || '未知歌手')}</small>
                            <small>来源专辑：${escapeHtml(item.album || '未知专辑')}</small>
                        </span>
                        <span class="review-destination">
                            <span class="track-column-label">目标匹配</span>
                            ${item.matched ? `<b class="review-target">${escapeHtml(item.targetTitle)}</b>
                            <small>${escapeHtml(item.targetArtist || '未知歌手')}</small>
                            <small>目标专辑：${escapeHtml(item.targetAlbum || '未知专辑')}</small>` : '<span class="review-target">未找到匹配歌曲</span>'}
                        </span>
                        <span class="review-track-detail"><em class="review-warning">${warning}</em>
                            <span class="result-score">匹配分 ${escapeHtml(item.score ?? 0)}%</span></span>
                        ${item.note ? `<small class="review-track-note">${escapeHtml(item.note)}</small>` : ''}
                    </span>
                </label>`;
        }).join('') || '<div class="library-empty">没有可供迁移的匹配结果</div>';
        updateReviewSelection();
    }

    function updateReviewSelection() {
        const waiting = latestJob && latestJob.id === selectionJobId && latestJob.id === currentJobId
                && latestJob.status === 'AWAITING_CONFIRMATION';
        const editable = waiting && !latestJob.readOnly && confirmationState === 'idle' && authReady && auth.authenticated && !authBusy;
        const targetName = jobTarget ? jobTarget.providerLabel || providerLabel(jobTarget.provider) : '目标平台';
        const cliNote = jobTarget && jobTarget.provider === 'NETEASE_MUSIC' && jobTarget.mode === 'REAL'
                ? ' 将使用服务器运行用户已登录的本机 CLI 账号，并非多用户授权。' : '';
        els.reviewTitle.textContent = confirmationState === 'uncertain' ? '确认结果不确定'
                : confirmationState === 'submitting' ? '正在提交迁移确认' : '匹配完成，等待确认';
        els.reviewWriteNote.classList.toggle('is-real', confirmationState === 'uncertain' || (jobTarget && jobTarget.mode === 'REAL'));
        els.reviewWriteNote.textContent = confirmationState === 'uncertain'
                ? `确认结果不确定：本任务目标 ${targetName} 的歌单可能已创建或开始写入。请勿再次提交，仅可查询状态。${cliNote}`
                : confirmationState !== 'idle'
                    ? `正在处理 ${targetName} 的迁移确认，所选歌曲可能开始写入，请勿重复点击。${cliNote}`
                    : jobTarget && jobTarget.mode === 'DEMO'
                        ? `尚未创建任何目标歌单。演示模式：确认后仅在 ${targetName} 的本次会话演示音乐库创建歌单，不写入真实账号。`
                        : `尚未创建任何目标歌单。真实模式：只有点击「确认迁移」并同意提示后，才会在本任务目标 ${targetName} 创建新歌单并写入所选歌曲。${cliNote}`;
        els.reviewList.querySelectorAll('input[data-match-index]').forEach((input) => {
            const index = Number(input.dataset.matchIndex);
            const selectable = input.dataset.matchIndex !== '' && Number.isInteger(index);
            input.checked = selectable && selectedIndices.has(index);
            input.disabled = !editable || !selectable;
        });
        els.clearSelectionBtn.disabled = !editable;
        els.selectHighBtn.disabled = !editable;
        els.abandonPreviewBtn.disabled = !editable;
        els.confirmMigrationBtn.disabled = !editable || selectedIndices.size === 0
                || !jobTarget || !['DEMO', 'REAL'].includes(jobTarget.mode);
        els.confirmMigrationBtn.textContent = confirmationState === 'submitting' ? '正在提交确认…'
                : confirmationState === 'uncertain' ? '确认结果不确定 · 请勿重试'
                    : `确认迁移 ${selectedIndices.size} 首`;
        els.reviewSelectedCount.textContent = `已选 ${selectedIndices.size} 首`;
        els.reviewView.setAttribute('aria-busy', String(confirmationState === 'submitting'));
    }

    function abandonPreview() {
        if (!latestJob || latestJob.id !== currentJobId || latestJob.status !== 'AWAITING_CONFIRMATION'
                || confirmationState !== 'idle') return;
        window.clearTimeout(pollTimer);
        currentJobId = null;
        latestJob = null;
        jobTarget = null;
        selectionJobId = null;
        selectedIndices.clear();
        jobRunning = false;
        jobStatusError = false;
        hideJobPill();
        closeModal(els.progressModal, { keepPill: true });
        syncDirection();
        toast('已放弃本地只读预览，未创建或写入目标歌单', 'info');
    }

    async function confirmMigration() {
        if (!requireLogin()) return;
        if (confirmationState !== 'idle' || !latestJob || latestJob.readOnly || latestJob.id !== currentJobId
                || selectionJobId !== currentJobId || latestJob.status !== 'AWAITING_CONFIRMATION'
                || !jobTarget || !['DEMO', 'REAL'].includes(jobTarget.mode)) return;
        const jobId = currentJobId;
        const target = { ...jobTarget };
        const eligible = new Set((latestJob.matches || []).filter((item) => item.matched).map((item) => item.index));
        const indices = [...selectedIndices].filter((index) => Number.isInteger(index) && index >= 0 && eligible.has(index))
                .sort((a, b) => a - b);
        if (!indices.length || indices.length !== selectedIndices.size) return;
        confirmationState = 'submitting';
        updateReviewSelection();
        syncDirection();
        if (target.mode === 'REAL') {
            const cliNote = target.provider === 'NETEASE_MUSIC'
                    ? '\n将使用服务器运行用户已登录的本机 CLI 账号，并非多用户授权。' : '';
            if (!window.confirm(`确认在本任务目标 ${target.providerLabel || providerLabel(target.provider)} 的真实账号创建新歌单，写入你选择的 ${indices.length} 首歌曲？${cliNote}\n未选歌曲将跳过。确定迁移吗？`)) {
                confirmationState = 'idle';
                updateReviewSelection();
                syncDirection();
                return;
            }
        }
        els.reviewError.classList.add('is-hidden');
        try {
            // Never retry this write request. Reconcile a failed response with one read instead.
            const job = await api(`/api/migrations/${encodeURIComponent(jobId)}/confirm`, {
                method: 'POST', body: { selectedIndices: indices }
            });
            if (currentJobId !== jobId) return;
            if (!job || job.id !== jobId || !['RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED'].includes(job.status)) {
                throw new Error('确认响应未包含明确的执行状态');
            }
            confirmationState = 'accepted';
            acceptJob(job);
        } catch (error) {
            if (currentJobId !== jobId) return;
            try {
                const job = await api(`/api/migrations/${encodeURIComponent(jobId)}`);
                if (currentJobId !== jobId) return;
                if (!job || job.id !== jobId) throw new Error('任务状态响应无效');
                if (job.status === 'AWAITING_CONFIRMATION') {
                    // Only a definite client rejection can unlock another explicit attempt.
                    // A network/5xx failure may race with a write even if this read still says waiting.
                    if (!error.status || error.status >= 500) {
                        confirmationState = 'uncertain';
                        acceptJob(job);
                        showStatusError('确认响应不确定。只读查询虽显示等待确认，仍不能排除写入已开始；选择与确认保持锁定，请勿重试。');
                        return;
                    }
                    confirmationState = 'idle';
                    acceptJob(job);
                    els.reviewError.textContent = error.code === 'TARGET_CHANGED'
                            ? `确认未被接受：${error.message}。请点击「暂不迁移」后重新匹配。`
                            : `确认未被接受：${error.message}。可调整选择后再次明确确认，或暂不迁移。`;
                    els.reviewError.classList.remove('is-hidden');
                } else if (['RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED'].includes(job.status)) {
                    confirmationState = 'accepted';
                    acceptJob(job);
                } else {
                    throw new Error('任务尚未返回明确的确认结果');
                }
            } catch (statusError) {
                if (currentJobId !== jobId) return;
                confirmationState = 'uncertain';
                window.clearTimeout(pollTimer);
                els.reviewError.textContent = `确认结果不确定：${error.message}。查询状态也失败：${statusError.message}。可能已经开始写入，请勿重复确认；选择与放弃按钮已锁定。`;
                els.reviewError.classList.remove('is-hidden');
                showStatusError('无法确定确认是否已接受。仅可查询任务状态，不会自动重试确认，也不会启动新迁移。');
            }
        } finally {
            if (currentJobId === jobId) {
                updateReviewSelection();
                syncDirection();
                if (!els.jobPill.classList.contains('is-hidden') && latestJob) showJobPill(latestJob);
            }
        }
    }

    function renderJob(job) {
        if (!job) {
            return;
        }
        const matches = Array.isArray(job.matches) ? job.matches : [];
        const logs = Array.isArray(job.logs) ? job.logs : [];
        const matched = matches.filter((item) => item.matched).length;
        const unmatched = matches.filter((item) => !item.matched).length;

        els.progressPercent.textContent = `${job.progress}%`;
        els.progressFill.style.width = `${Math.max(0, Math.min(100, job.progress))}%`;
        if (job.status !== 'FAILED') {
            els.progressTitle.textContent = job.status === 'COMPLETED' ? '迁移完成'
                    : job.status === 'AWAITING_CONFIRMATION' ? '匹配完成，等待确认'
                        : confirmationState === 'idle' ? '正在读取与匹配歌单' : '正在迁移所选歌曲';
        }
        els.progressStep.textContent = job.currentStep || '处理中…';
        els.statMatched.textContent = String(matched);
        els.statUnmatched.textContent = String(unmatched);
        els.statTotal.textContent = String(matches.length);

        const stickToBottom = els.liveLog.scrollHeight - els.liveLog.scrollTop - els.liveLog.clientHeight < 36;
        els.liveLog.innerHTML = logs.map((entry) => `
            <div class="log-line ${LEVEL_CLASS[entry.level] || ''}">
                <time>${escapeHtml(entry.at)}</time><span>${escapeHtml(entry.message)}</span>
            </div>
        `).join('');
        if (stickToBottom) {
            els.liveLog.scrollTop = els.liveLog.scrollHeight;
        }
    }

    function finishJob(job) {
        window.clearTimeout(pollTimer);
        jobRunning = false;
        syncDirection();
        refreshDemoCount();

        if (job.status === 'INTERRUPTED') {
            els.progressView.classList.add('is-hidden');
            els.reviewView.classList.add('is-hidden');
            els.resultView.classList.remove('is-hidden');
            els.progressTitle.textContent = '任务已中断';
            els.progressModal.setAttribute('aria-labelledby', 'progressTitle');
            els.resultView.innerHTML = reportMarkup(job);
            if (els.progressModal.classList.contains('is-hidden')) showJobPill(job);
            toast('任务已中断，请先核对历史报告和目标平台；不会自动重试写入', 'error', 7000);
        } else if (job.status === 'COMPLETED') {
            els.progressTitle.textContent = '迁移完成';
            renderResult(job);
            launchConfetti();
            if (!els.progressModal.classList.contains('is-hidden')) {
                hideJobPill();
            } else {
                showJobPill(job);
            }
            const demoResult = jobTarget && jobTarget.mode === 'DEMO';
            toast(`迁移完成，已写入${demoResult ? '演示音乐库' : ''} ${job.result ? job.result.addedCount : 0} 首`, 'success', 5000);
        } else {
            els.reviewView.classList.add('is-hidden');
            els.resultView.classList.add('is-hidden');
            els.progressView.classList.remove('is-hidden');
            els.progressModal.setAttribute('aria-labelledby', 'progressTitle');
            els.progressTitle.textContent = confirmationState === 'idle' ? '匹配失败' : '迁移失败';
            els.progressStep.textContent = job.currentStep || '已停止';
            els.progressFill.style.background = 'var(--danger)';
            els.progressError.textContent = job.error || '迁移失败，请稍后重试';
            els.progressError.classList.remove('is-hidden');
            if (!els.progressModal.classList.contains('is-hidden')) {
                hideJobPill();
            } else {
                showJobPill(job);
            }
            toast(job.error || '迁移失败，请稍后重试', 'error', 7000);
        }
    }

    function renderResult(job) {
        const result = job.result;
        if (!result) {
            return;
        }
        const matches = Array.isArray(job.matches) ? job.matches : [];
        const lowCount = matches.filter((item) => item.matched && item.selected === true && item.lowConfidence).length;
        const sourceName = job.source ? job.source.name : '来源歌单';
        const targetInfo = jobTarget || job.target || {};
        const demoResult = targetInfo.mode === 'DEMO';
        const resultTarget = targetInfo.provider;
        const skippedCount = result.skippedCount;
        const matchedCount = result.matchedCount;
        const perfect = Number(result.unmatchedCount) === 0 && Number(skippedCount) === 0 && lowCount === 0;
        const rows = matches.map((item, row) => {
            const selected = item.matched && item.selected === true;
            const statusClass = !item.matched ? 'missing' : !selected ? 'skipped' : item.lowConfidence ? 'low' : 'matched';
            const icon = !item.matched ? '×' : !selected ? '−' : item.lowConfidence ? '!' : '✓';
            const status = !item.matched ? '未匹配' : !selected ? `已跳过${item.lowConfidence ? ' · 低置信（未选择）' : '（未选择）'}`
                    : item.lowConfidence ? '已迁移 · 低置信（已选择）' : '已迁移';
            const target = item.matched
                    ? `目标：${escapeHtml(item.targetTitle)} · ${escapeHtml(item.targetArtist || '未知歌手')} · 专辑：${escapeHtml(item.targetAlbum || '未知专辑')}`
                    : '目标平台未找到匹配歌曲';
            return `
                <div class="result-track">
                    <span class="result-status ${statusClass}" aria-hidden="true">${icon}</span>
                    <div class="result-track-main">
                        <b>${Number.isInteger(item.index) ? item.index + 1 : row + 1}. ${escapeHtml(item.title)} · ${escapeHtml(item.artist || '未知歌手')}</b>
                        <small>来源专辑：${escapeHtml(item.album || '未知专辑')}</small>
                        <small>${target}</small>
                        <small class="result-track-label ${statusClass}">${status} · 匹配分 ${escapeHtml(item.score ?? 0)}%</small>
                        ${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}
                    </div>
                </div>
            `;
        }).join('');

        const resultUrl = safeHttpUrl(result.playlistUrl);
        const linkBlock = !demoResult && resultUrl
                ? `<div class="result-link"><span class="link-label">打开新歌单</span><a href="${escapeHtml(resultUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(resultUrl)}</a></div>`
                : demoResult
                    ? `<div class="result-link"><span class="link-label">演示歌单</span><span>${resultTarget === 'NETEASE_MUSIC' ? '已写入本次会话的演示音乐库，不支持作为迁移来源。' : '已写入本次会话的演示音乐库，可继续作为下一次迁移的来源。'}</span></div>`
                    : '';

        els.progressView.classList.add('is-hidden');
        els.reviewView.classList.add('is-hidden');
        els.resultView.classList.remove('is-hidden');
        els.progressModal.setAttribute('aria-labelledby', 'resultTitle');
        els.resultView.innerHTML = `
            <div class="result-hero">
                <div class="result-badge ${perfect ? '' : 'is-warn'}" aria-hidden="true">${perfect ? '✓' : '!'}</div>
                <h3 id="resultTitle">迁移完成${Number(result.unmatchedCount) > 0 ? '，部分歌曲未匹配' : Number(skippedCount) > 0 ? '，已跳过未选歌曲' : ''}</h3>
                <p>《${escapeHtml(sourceName)}》 → ${escapeHtml(targetInfo.providerLabel || providerLabel(resultTarget) || '目标平台')}</p>
            </div>
            <div class="result-stats">
                <div class="is-good"><strong>${escapeHtml(result.addedCount)}</strong><span>成功迁移</span></div>
                <div><strong>${escapeHtml(matchedCount)}</strong><span>已匹配</span></div>
                <div><strong>${escapeHtml(skippedCount)}</strong><span>已跳过（未选择）</span></div>
                <div class="${result.unmatchedCount ? 'is-bad' : ''}"><strong>${escapeHtml(result.unmatchedCount)}</strong><span>未匹配</span></div>
                <div class="${lowCount ? 'is-warn' : ''}"><strong>${lowCount}</strong><span>低置信已迁移</span></div>
                <div><strong>${escapeHtml(result.matchRate)}%</strong><span>匹配率（不受跳过影响）</span></div>
            </div>
            ${linkBlock}
            <div class="result-list">${rows || '<div class="library-empty">没有逐首报告</div>'}</div>
            <div class="result-actions">
                ${demoResult ? '<button type="button" class="btn btn-outline" data-result-action="library">查看演示音乐库</button>' : ''}
                <button type="button" class="btn btn-ghost" data-result-action="again">再迁一次</button>
                <button type="button" class="btn btn-primary" data-result-action="close">完成</button>
            </div>
        `;
    }

    /* ---------------- Job pill ---------------- */

    function showJobPill(job) {
        if (!job) {
            return;
        }
        els.jobPill.classList.remove('is-done', 'is-error', 'is-waiting');
        if (confirmationState === 'uncertain' && jobRunning) {
            els.jobPill.classList.add('is-error');
            els.jobPillText.textContent = '确认结果不确定 · 查看状态';
        } else if (jobStatusError && jobRunning) {
            els.jobPill.classList.add('is-error');
            els.jobPillText.textContent = '状态获取失败 · 查看任务';
        } else if (job.status === 'COMPLETED') {
            els.jobPill.classList.add('is-done');
            els.jobPillText.textContent = '迁移完成 · 查看报告';
        } else if (job.status === 'FAILED' || job.status === 'INTERRUPTED') {
            els.jobPill.classList.add('is-error');
            els.jobPillText.textContent = job.status === 'INTERRUPTED' ? '任务已中断 · 查看报告' : '迁移失败 · 查看原因';
        } else if (confirmationState === 'submitting') {
            els.jobPillText.textContent = '正在提交确认 · 请勿重复点击';
        } else if (job.status === 'AWAITING_CONFIRMATION') {
            els.jobPill.classList.add('is-waiting');
            els.jobPillText.textContent = `等待确认 · 已选 ${selectedIndices.size} 首`;
        } else {
            els.jobPillText.textContent = `${confirmationState === 'idle' ? '匹配' : '迁移'}进行中 · ${job.progress || 0}%`;
        }
        els.jobPill.classList.remove('is-hidden');
    }

    function hideJobPill() {
        els.jobPill.classList.add('is-hidden');
    }

    /* ---------------- Demo flow ---------------- */

    async function runDemoFlow() {
        if (state.config.demoEnabled === false) {
            toast('演示模式未开启，请连接真实账号', 'error');
            return;
        }
        if (jobRunning) {
            openModal(els.progressModal);
            hideJobPill();
            return;
        }
        const buttons = [els.headerDemoBtn, els.heroDemoBtn, els.sideDemoBtn].filter(Boolean);
        buttons.forEach((button) => { button.disabled = true; });
        const heroLabel = els.heroDemoBtn.querySelector('span');
        if (heroLabel) {
            heroLabel.textContent = '正在准备演示…';
        }
        try {
            const [qqOk, appleOk] = await Promise.all([
                connectDemo('QQ_MUSIC'),
                connectDemo('APPLE_MUSIC')
            ]);
            if (!qqOk || !appleOk) {
                return;
            }
            await refreshState();
            sourceProvider = 'QQ_MUSIC';
            targetProvider = 'APPLE_MUSIC';
            resetSourceForDirection(false);
            els.sourceUrl.value = DEMO_SOURCE_URL;
            els.playlistName.value = '';
            syncDirection();
            const preview = await previewPlaylist({ silent: true });
            if (!preview) {
                return;
            }
            toast('演示账号已就绪，开始匹配；请审阅后明确确认迁移', 'success', 4200);
            await startMigration();
        } finally {
            buttons.forEach((button) => { button.disabled = state.config.demoEnabled === false; });
            if (heroLabel) {
                heroLabel.textContent = '一键体验匹配';
            }
        }
    }

    /* ---------------- Demo library ---------------- */

    async function openLibrary(provider) {
        libraryProvider = provider || sourceProvider;
        switchLibraryTab(libraryProvider);
        openModal(els.libraryModal);
        await loadLibrary(libraryProvider);
    }

    function switchLibraryTab(provider) {
        libraryProvider = provider;
        els.libraryTabs.querySelectorAll('[data-library-provider]').forEach((tab) => {
            const active = tab.dataset.libraryProvider === provider;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-pressed', String(active));
        });
        els.libraryTitle.textContent = `${providerLabel(provider)} 演示音乐库`;
    }

    async function loadLibrary(provider) {
        els.libraryList.innerHTML = '<div class="library-empty">正在加载…</div>';
        if (!isDemo(provider)) {
            els.libraryList.innerHTML = `
                <div class="library-empty">
                    <strong>尚未连接演示账号</strong>
                    <span>连接 ${providerLabel(provider)} 演示账号后，这里会显示本次会话创建的演示歌单。</span>
                </div>`;
            return;
        }
        try {
            const playlists = await api(`/api/demo/library?provider=${encodeURIComponent(provider)}`);
            if (provider !== libraryProvider) return;
            if (!playlists || playlists.length === 0) {
                els.libraryList.innerHTML = `
                    <div class="library-empty">
                        <strong>还没有演示歌单</strong>
                        <span>${provider === 'NETEASE_MUSIC' ? '完成演示迁移后，新歌单会出现在这里；网易云不支持作为来源。' : '完成一次演示迁移后，新歌单会出现在这里，并可继续作为来源。'}</span>
                    </div>`;
                return;
            }
            els.libraryList.innerHTML = playlists.map((playlist) => `
                <div class="library-item">
                    <div class="library-item-icon">♫</div>
                    <div class="library-item-main">
                        <b>${escapeHtml(playlist.name)}</b>
                        <small>${playlist.totalTracks} 首 · ${escapeHtml(playlist.owner || '演示音乐库')}</small>
                    </div>
                    ${provider === 'NETEASE_MUSIC' ? '<span class="library-target-only">仅作为目标</span>' : `<button type="button" class="btn btn-soft btn-small"
                            data-use-url="${escapeHtml(playlist.webUrl)}"
                            data-use-provider="${escapeHtml(provider)}">作为来源</button>`}
                </div>
            `).join('');
        } catch (error) {
            if (provider === libraryProvider) {
                els.libraryList.innerHTML = `<div class="library-empty"><strong>加载失败</strong><span>${escapeHtml(error.message)}</span></div>`;
            }
        }
    }

    async function useLibraryPlaylist(url, provider) {
        if (!url || (provider !== 'QQ_MUSIC' && provider !== 'APPLE_MUSIC')) {
            return;
        }
        const other = provider === 'QQ_MUSIC' && targetProvider === 'NETEASE_MUSIC'
                ? 'NETEASE_MUSIC' : otherProvider(provider);
        closeModal(els.libraryModal, { silent: true });
        try {
            if (!isDemo(provider)) {
                const ok = await connectDemo(provider);
                if (!ok) {
                    return;
                }
            }
            if (!connection(other).connected) {
                const ok = await connectDemo(other);
                if (!ok) {
                    return;
                }
            }
        } catch (error) {
            toast(error.message, 'error');
            return;
        }
        sourceProvider = provider;
        targetProvider = other;
        resetSourceForDirection(false);
        els.sourceUrl.value = url;
        els.playlistName.value = '';
        syncDirection();
        await previewPlaylist({ silent: true });
        els.workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast(`已载入《${previewData ? previewData.name : '演示歌单'}》作为来源`, 'success');
    }

    async function refreshDemoCount() {
        if (!stateLoaded) {
            return;
        }
        let count = 0;
        for (const provider of Object.keys(PROVIDERS)) {
            if (!isDemo(provider)) {
                continue;
            }
            try {
                const playlists = await api(`/api/demo/library?provider=${encodeURIComponent(provider)}`);
                count += Array.isArray(playlists) ? playlists.length : 0;
            } catch (ignored) {
                // A transient failure should not block the rest of the UI.
            }
        }
        els.demoStatCount.textContent = String(count);
    }

    /* ---------------- History: independent, strictly read-only snapshots ---------------- */

    function historyStatus(status) {
        return { QUEUED: '排队中', RUNNING: '处理中', AWAITING_CONFIRMATION: '等待确认',
            COMPLETED: '已完成', FAILED: '失败', INTERRUPTED: '已中断' }[status] || status || '状态未知';
    }

    function historyDate(value) {
        const date = new Date(value);
        return value && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '日期未知';
    }

    function safeHttpUrl(value) {
        try {
            const url = new URL(value);
            return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
        } catch (ignored) { return ''; }
    }

    function reportStats(job) {
        const matches = Array.isArray(job.matches) ? job.matches : [];
        const matched = matches.filter((item) => item.matched).length;
        const selected = matches.filter((item) => item.matched && item.selected === true).length;
        return { total: job.source?.trackCount ?? matches.length, matched, selected,
            skipped: matched - selected, unmatched: matches.length - matched,
            added: job.result?.addedCount ?? null };
    }

    function reportDirection(job) {
        const source = job.source || {};
        const target = job.target || {};
        return `${source.providerLabel || providerLabel(source.provider) || '来源平台'} → ${target.providerLabel || providerLabel(target.provider) || '目标平台'}${target.mode === 'DEMO' ? ' · 演示' : target.mode === 'REAL' ? ' · 真实平台' : ''}`;
    }

    function reportMarkup(job) {
        const stats = reportStats(job);
        const target = job.createdTarget || job.result;
        const url = safeHttpUrl(target?.playlistUrl);
        const interrupted = job.status === 'INTERRUPTED';
        const caution = interrupted || job.recoveryNotice || (job.status === 'FAILED' && target);
        const rows = (Array.isArray(job.matches) ? job.matches : []).map((item, row) => {
            const selected = item.matched && item.selected === true;
            const statusClass = !item.matched ? 'missing' : selected ? 'matched' : 'skipped';
            const label = !item.matched ? '未匹配' : selected ? '已选择' : '已跳过（未选择）';
            return `<div class="result-track"><span class="result-status ${statusClass}" aria-hidden="true">${!item.matched ? '×' : selected ? '✓' : '−'}</span>
                <div class="result-track-main"><b>${Number.isInteger(item.index) ? item.index + 1 : row + 1}. ${escapeHtml(item.title)} · ${escapeHtml(item.artist || '未知歌手')}</b>
                <small>来源专辑：${escapeHtml(item.album || '未知专辑')}</small>
                <small>${item.matched ? `目标：${escapeHtml(item.targetTitle)} · ${escapeHtml(item.targetArtist || '未知歌手')} · 专辑：${escapeHtml(item.targetAlbum || '未知专辑')}` : '目标平台未找到匹配歌曲'}</small>
                <small class="result-track-label ${statusClass}">${label}${item.lowConfidence ? ' · 低置信' : ''} · 匹配分 ${escapeHtml(item.score ?? 0)}%</small>
                ${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}</div></div>`;
        }).join('');
        return `<article class="history-report">
            <span class="history-badge ${interrupted || job.status === 'FAILED' ? 'is-warning' : ''}">${escapeHtml(historyStatus(job.status))} · 只读</span>
            <h4>${escapeHtml(job.source?.name || '来源歌单尚未读取')}</h4>
            <p class="history-metadata">${escapeHtml(historyDate(job.createdAt))}<br>${escapeHtml(reportDirection(job))}</p>
            ${caution ? `<div class="history-notice">${job.recoveryNotice ? `<p>${escapeHtml(job.recoveryNotice)}</p>` : ''}<p>任务${interrupted ? '已中断' : '写入结果需核对'}。目标歌单可能已经创建或部分写入，请先到目标平台核对，不要直接重复迁移。此报告不会自动恢复或重试写入。</p></div>` : ''}
            ${job.error ? `<p class="progress-error">${escapeHtml(job.error)}</p>` : ''}
            ${target ? `<div class="result-link"><span class="link-label">已记录的目标歌单</span><span>${escapeHtml(target.playlistName || '未命名歌单')} · ID：${escapeHtml(target.playlistId || '未知')}</span>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">到目标平台核对歌单</a>` : '<span>没有可打开的 HTTP(S) 链接，请在目标平台自行核对。</span>'}</div>` : ''}
            <div class="result-stats">
                <div><strong>${escapeHtml(stats.total)}</strong><span>来源曲目</span></div>
                <div><strong>${stats.matched}</strong><span>已匹配</span></div>
                <div><strong>${stats.selected}</strong><span>已选择</span></div>
                <div><strong>${stats.skipped}</strong><span>已跳过 / 未选择</span></div>
                <div><strong>${stats.unmatched}</strong><span>未匹配</span></div>
                <div><strong>${stats.added === null ? '—' : escapeHtml(stats.added)}</strong><span>报告确认写入数</span></div>
            </div>
            <p class="review-help">选择状态是报告快照，不代表全部写入成功；写入数未知时请以目标平台为准。历史中的等待确认任务也不能在此提交。</p>
            <div class="result-list">${rows || '<div class="library-empty">暂无逐首匹配记录</div>'}</div>
        </article>`;
    }

    async function openHistory() {
        if (!requireLogin()) return;
        openModal(els.historyModal);
        await loadHistory(0);
    }

    async function loadHistory(offset = historyOffset) {
        if (!requireLogin()) return;
        const seq = ++historySeq;
        historyDetailId = null;
        historyOffset = offset;
        historyHasMore = false;
        els.historyListPanel.classList.remove('is-hidden');
        els.historyDetailPanel.classList.add('is-hidden');
        els.historyDetail.replaceChildren();
        els.historyRetryBtn.classList.add('is-hidden');
        els.historyPrevBtn.disabled = true;
        els.historyNextBtn.disabled = true;
        els.historyPageLabel.textContent = '正在加载…';
        els.historyList.innerHTML = '<div class="library-empty">正在读取迁移历史…</div>';
        els.historyList.setAttribute('aria-busy', 'true');
        try {
            const page = await api(`/api/migrations?offset=${offset}&limit=20`);
            if (seq !== historySeq) return;
            if (!page || !Array.isArray(page.items)) throw new Error('历史列表响应无效');
            historyHasMore = page.hasMore === true;
            els.historyList.innerHTML = page.items.map((job) => {
                const stats = reportStats(job);
                return `<article class="history-item"><div class="history-item-head"><h4>${escapeHtml(job.source?.name || '来源歌单尚未读取')}</h4>
                    <span class="history-badge ${['FAILED', 'INTERRUPTED'].includes(job.status) ? 'is-warning' : ''}">${escapeHtml(historyStatus(job.status))} · 只读</span></div>
                    <time>${escapeHtml(historyDate(job.createdAt))}</time><p>${escapeHtml(reportDirection(job))}</p>
                    <p>共 ${escapeHtml(stats.total)} 首 · 匹配 ${stats.matched} · 已选 ${stats.selected} · 跳过 ${stats.skipped} · 未匹配 ${stats.unmatched} · 确认写入 ${stats.added === null ? '未知' : escapeHtml(stats.added)}</p>
                    <button type="button" class="btn btn-outline btn-small" data-history-id="${escapeHtml(job.id)}">查看只读报告</button></article>`;
            }).join('') || `<div class="library-empty"><strong>${offset ? '本页没有记录' : '还没有迁移历史'}</strong><span>完成匹配后，任务报告会保存在你的音桥账号下。</span></div>`;
            els.historyPageLabel.textContent = `第 ${Math.floor(offset / 20) + 1} 页`;
        } catch (error) {
            if (seq !== historySeq) return;
            els.historyList.innerHTML = `<div class="library-empty"><strong>历史加载失败</strong><span>${escapeHtml(error.message)}</span></div>`;
            els.historyPageLabel.textContent = '加载失败';
            els.historyRetryBtn.classList.remove('is-hidden');
        } finally {
            if (seq === historySeq) {
                els.historyList.setAttribute('aria-busy', 'false');
                els.historyPrevBtn.disabled = offset === 0;
                els.historyNextBtn.disabled = !historyHasMore;
            }
        }
    }

    async function loadHistoryDetail(id) {
        if (!requireLogin()) return;
        const seq = ++historySeq;
        historyDetailId = id;
        els.historyListPanel.classList.add('is-hidden');
        els.historyDetailPanel.classList.remove('is-hidden');
        els.historyRetryBtn.classList.add('is-hidden');
        els.historyDetail.innerHTML = '<div class="library-empty">正在读取只读报告…</div>';
        els.historyBackBtn.focus({ preventScroll: true });
        try {
            const job = await api(`/api/migrations/${encodeURIComponent(id)}`);
            if (seq !== historySeq) return;
            if (!job || job.id !== id) throw new Error('报告响应无效');
            // Never call acceptJob here: history must not alter the live task or its selection.
            els.historyDetail.innerHTML = reportMarkup(job);
        } catch (error) {
            if (seq !== historySeq) return;
            els.historyDetail.innerHTML = `<div class="library-empty"><strong>报告加载失败</strong><span>${escapeHtml(error.message)}</span></div>`;
            els.historyRetryBtn.classList.remove('is-hidden');
        }
    }

    /* ---------------- Confetti ---------------- */

    function launchConfetti() {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return;
        }
        const canvas = els.confettiCanvas;
        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }
        const ratio = window.devicePixelRatio || 1;
        const width = window.innerWidth;
        const height = window.innerHeight;
        canvas.width = width * ratio;
        canvas.height = height * ratio;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);

        const colors = ['#2858ce', '#f0cf71', '#187451', '#aebff0'];
        const particles = Array.from({ length: 110 }, () => ({
            x: width * (0.2 + Math.random() * 0.6),
            y: height * (0.3 + Math.random() * 0.18),
            vx: (Math.random() - 0.5) * 7,
            vy: -Math.random() * 8 - 2,
            size: 4 + Math.random() * 7,
            rotation: Math.random() * Math.PI,
            spin: (Math.random() - 0.5) * 0.25,
            color: colors[Math.floor(Math.random() * colors.length)],
            life: 1
        }));
        const started = performance.now();
        const duration = 2600;

        function frame(now) {
            const elapsed = now - started;
            context.clearRect(0, 0, width, height);
            if (elapsed > duration) {
                canvas.width = 0;
                canvas.height = 0;
                return;
            }
            particles.forEach((particle) => {
                particle.vy += 0.22;
                particle.vx *= 0.995;
                particle.x += particle.vx;
                particle.y += particle.vy;
                particle.rotation += particle.spin;
                particle.life = Math.max(0, 1 - elapsed / duration);
                context.save();
                context.globalAlpha = particle.life;
                context.translate(particle.x, particle.y);
                context.rotate(particle.rotation);
                context.fillStyle = particle.color;
                context.fillRect(-particle.size / 2, -particle.size / 4, particle.size, particle.size / 2);
                context.restore();
            });
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    }

    /* ---------------- Events ---------------- */

    function wireEvents() {
        [els.headerDemoBtn, els.heroDemoBtn, els.sideDemoBtn].forEach((button) => {
            button.addEventListener('click', runDemoFlow);
        });
        els.openLibraryBtn.addEventListener('click', () => openLibrary(sourceProvider));
        els.backupText.addEventListener('input', clearBackup);
        els.backupUrl.addEventListener('input', clearBackup);
        els.backupParse.addEventListener('click', parseBackupText);
        els.backupFile.addEventListener('change', importBackupFile);
        els.backupReadQq.addEventListener('click', readQqBackup);
        els.backupJson.addEventListener('click', () => downloadBackup('json'));
        els.backupCsv.addEventListener('click', () => downloadBackup('csv'));

        document.querySelectorAll('[data-connect]').forEach((button) => {
            button.addEventListener('click', () => openConnect(button.dataset.connect));
        });

        document.querySelectorAll('[name="directionChoice"]').forEach((input) => {
            input.addEventListener('change', () => {
                const previousSource = sourceProvider;
                if (input.value === 'QQ_NETEASE') {
                    sourceProvider = 'QQ_MUSIC';
                    targetProvider = 'NETEASE_MUSIC';
                } else if (input.value === 'APPLE_QQ') {
                    sourceProvider = 'APPLE_MUSIC';
                    targetProvider = 'QQ_MUSIC';
                } else {
                    sourceProvider = 'QQ_MUSIC';
                    targetProvider = 'APPLE_MUSIC';
                }
                resetSourceForDirection(previousSource !== sourceProvider);
            });
        });

        els.swapBtn.addEventListener('click', () => {
            if (targetProvider === 'NETEASE_MUSIC') return;
            const previous = providerLabel(sourceProvider);
            [sourceProvider, targetProvider] = [targetProvider, sourceProvider];
            resetSourceForDirection(true);
            toast(`迁移方向已交换：${previous} → ${providerLabel(sourceProvider)}`, 'info', 2800);
        });

        els.sourceUrl.addEventListener('input', () => {
            previewSeq++;
            els.previewBtn.disabled = false;
            hidePreview();
            syncDirection();
        });
        els.sourceUrl.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                previewPlaylist();
            }
        });

        els.useSampleBtn.addEventListener('click', async () => {
            const sample = els.useSampleBtn.dataset.sample;
            if (!sample) {
                return;
            }
            els.sourceUrl.value = sample;
            syncDirection();
            await previewPlaylist();
        });

        els.previewBtn.addEventListener('click', () => previewPlaylist());
        els.migrateBtn.addEventListener('click', () => startMigration());
        els.confirmMigrationBtn.addEventListener('click', confirmMigration);
        els.abandonPreviewBtn.addEventListener('click', abandonPreview);
        els.refreshJobBtn.addEventListener('click', refreshJobStatus);
        els.reviewList.addEventListener('change', (event) => {
            const input = event.target.closest('input[data-match-index]');
            if (!input || input.disabled || confirmationState !== 'idle' || selectionJobId !== currentJobId
                    || !latestJob || latestJob.status !== 'AWAITING_CONFIRMATION') return;
            const index = Number(input.dataset.matchIndex);
            if (input.dataset.matchIndex === '' || !Number.isInteger(index)) return;
            if (input.checked) selectedIndices.add(index);
            else selectedIndices.delete(index);
            updateReviewSelection();
        });
        els.clearSelectionBtn.addEventListener('click', () => {
            if (els.clearSelectionBtn.disabled) return;
            selectedIndices.clear();
            updateReviewSelection();
        });
        els.selectHighBtn.addEventListener('click', () => {
            if (els.selectHighBtn.disabled || !latestJob || selectionJobId !== currentJobId) return;
            selectedIndices = new Set((latestJob.matches || []).filter((item) => item.matched && !item.lowConfidence
                    && Number.isInteger(item.index) && item.index >= 0).map((item) => item.index));
            updateReviewSelection();
        });

        els.connectDemoBtn.addEventListener('click', async () => {
            if (!connectProvider) {
                return;
            }
            setButtonBusy(els.connectDemoBtn, true, '连接中…');
            const ok = await connectDemo(connectProvider);
            setButtonBusy(els.connectDemoBtn, false);
            if (ok) {
                closeModal(els.connectModal);
                toast(`${providerLabel(connectProvider)} 演示账号已连接`, 'success');
            }
        });

        els.connectQQReal.addEventListener('click', connectRealQq);
        els.connectNeteaseReal.addEventListener('click', connectRealNetease);
        els.connectAppleToken.addEventListener('click', () => connectRealApple(els.appleTokenInput.value.trim()));

        els.appleAuthBtn.addEventListener('click', async () => {
            setButtonBusy(els.appleAuthBtn, true, '正在打开 Apple 授权…');
            try {
                const token = await authorizeApple();
                await connectRealApple(token);
            } catch (error) {
                toast(error.message || 'Apple Music 授权失败', 'error', 8000);
            } finally {
                setButtonBusy(els.appleAuthBtn, false);
            }
        });

        els.disconnectBtn.addEventListener('click', () => {
            if (connectProvider) {
                disconnect(connectProvider);
            }
        });

        els.jobPill.addEventListener('click', () => {
            hideJobPill();
            openModal(els.progressModal);
        });

        els.accountBtn.addEventListener('click', () => openAuth());
        els.authRefreshBtn.addEventListener('click', () => openAuth());
        els.authLoginTab.addEventListener('click', () => setAuthMode('login'));
        els.authRegisterTab.addEventListener('click', () => setAuthMode('register'));
        els.authForm.addEventListener('submit', submitAuth);
        els.logoutBtn.addEventListener('click', logout);
        els.restoreCurrentBtn.addEventListener('click', loadSession);
        els.openHistoryBtn.addEventListener('click', openHistory);
        els.historyList.addEventListener('click', (event) => {
            const button = event.target.closest('[data-history-id]');
            if (button) {
                loadHistoryDetail(button.dataset.historyId);
            }
        });
        els.historyPrevBtn.addEventListener('click', () => loadHistory(Math.max(0, historyOffset - 20)));
        els.historyNextBtn.addEventListener('click', () => loadHistory(historyOffset + 20));
        els.historyBackBtn.addEventListener('click', () => loadHistory());
        els.historyRetryBtn.addEventListener('click', () => {
            if (historyDetailId) loadHistoryDetail(historyDetailId); else loadHistory();
        });

        els.libraryTabs.addEventListener('click', (event) => {
            const tab = event.target.closest('[data-library-provider]');
            if (!tab) {
                return;
            }
            switchLibraryTab(tab.dataset.libraryProvider);
            loadLibrary(libraryProvider);
        });

        els.libraryList.addEventListener('click', (event) => {
            const button = event.target.closest('[data-use-url]');
            if (!button) {
                return;
            }
            useLibraryPlaylist(button.dataset.useUrl, button.dataset.useProvider);
        });

        els.resultView.addEventListener('click', (event) => {
            const button = event.target.closest('[data-result-action]');
            if (!button) {
                return;
            }
            const action = button.dataset.resultAction;
            if (action === 'close') {
                closeModal(els.progressModal, { keepPill: true });
            } else if (action === 'again') {
                startMigration();
            } else if (action === 'library') {
                closeModal(els.progressModal, { silent: true, keepPill: true });
                const provider = latestJob && latestJob.target ? latestJob.target.provider : targetProvider;
                openLibrary(provider);
            }
        });

        document.addEventListener('click', (event) => {
            const closer = event.target.closest('[data-close-modal]');
            if (closer) {
                const modal = closer.closest('.modal');
                closeModal(modal);
            }
        });

        document.addEventListener('keydown', (event) => {
            const open = document.querySelector('.modal:not(.is-hidden)');
            if (!open) return;
            if (event.key === 'Escape') {
                closeModal(open);
            } else if (event.key === 'Tab') {
                const focusable = [...open.querySelectorAll('button, a[href], input, textarea, summary, [tabindex="0"]')]
                        .filter((node) => !node.disabled && node.getClientRects().length > 0);
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        });

        const sectionLinks = [...document.querySelectorAll('[data-section-link]')];
        let navigationFrame;
        const updateNavigation = () => {
            const top = window.innerWidth <= 800 ? 135 : 40;
            let current = sectionLinks[0];
            for (const link of sectionLinks) {
                if (document.querySelector(link.getAttribute('href')).getBoundingClientRect().top <= top) {
                    current = link;
                }
            }
            if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) {
                current = sectionLinks[sectionLinks.length - 1];
            }
            sectionLinks.forEach((link) => {
                link.classList.toggle('active', link === current);
                if (link === current) link.setAttribute('aria-current', 'location');
                else link.removeAttribute('aria-current');
            });
        };
        window.addEventListener('scroll', () => {
            window.cancelAnimationFrame(navigationFrame);
            navigationFrame = window.requestAnimationFrame(updateNavigation);
        }, { passive: true });
        updateNavigation();
    }

    async function init() {
        cacheElements();
        wireEvents();
        await refreshAuth().catch(() => { });
        if (authReady && auth.authenticated) {
            await loadSession();
        } else {
            syncDirection();
        }
    }

    init();
})();

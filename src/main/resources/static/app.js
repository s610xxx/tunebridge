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
    let connectProvider = null;
    let libraryProvider = 'QQ_MUSIC';
    let lastFocused = null;
    let stateLoaded = false;
    let previewSeq = 0;
    let musicKitInstance = null;
    let backupData = null;
    let backupSeq = 0;

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
            'backupJson', 'backupCsv'
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

    async function api(path, options = {}) {
        const init = {
            method: options.method || 'GET',
            credentials: 'same-origin',
            headers: {}
        };
        if (options.body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(options.body);
        }
        const response = await fetch(path, init);
        const text = await response.text();
        let payload = null;
        if (text) {
            try {
                payload = JSON.parse(text);
            } catch (ignored) {
                payload = null;
            }
        }
        if (!response.ok) {
            const message = payload && payload.error ? payload.error : `请求失败（${response.status}）`;
            throw new Error(message);
        }
        return payload;
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
        }
        if (wasOpen && modal === els.connectModal) {
            clearSensitiveInputs();
        }
        if (wasOpen && !options.silent) {
            if (modal === $('progressModal') && latestJob && !options.keepPill) {
                showJobPill(latestJob);
            }
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
        if (!stateLoaded) {
            note = '正在连接本地服务…';
        } else if (!targetConn.connected) {
            note = `连接 ${providerLabel(targetProvider)} 后即可开始`;
        } else if (!url) {
            note = '粘贴来源歌单链接后即可开始';
        } else if (sourceProvider === 'APPLE_MUSIC' && !sourceConn.connected) {
            note = '请先连接 Apple Music 来源账号';
        } else if (url.startsWith('demo://') && sourceConn.mode !== 'DEMO') {
            note = '演示歌单需要先连接演示账号';
        } else if (jobRunning) {
            note = '迁移进行中，请稍候…';
        } else {
            note = targetConn.mode === 'DEMO'
                    ? `演示模式 · 不会写入真实 ${providerLabel(targetProvider)} 账号`
                    : `真实迁移将在 ${providerLabel(targetProvider)} 创建新歌单`;
            ready = true;
        }
        els.migrateBtn.disabled = !ready || jobRunning;
        els.migrateBtn.querySelector('.btn-label').textContent = jobRunning ? '迁移中' : '开始迁移';
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
        if (sourceProvider === 'APPLE_MUSIC' && !conn.connected) {
            text = '请先连接 Apple Music 来源账号';
            tone = 'is-warn';
        } else if (url.startsWith('demo://') && conn.mode !== 'DEMO') {
            text = '演示歌单链接需要先连接来源平台的演示账号';
            tone = 'is-warn';
        } else if (url.startsWith('demo://')) {
            text = '演示歌单：将使用内置曲库完成完整迁移';
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
        els.useSampleBtn.disabled = !sample;
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
            const ready = state.config.neteaseRealReady === true;
            els.connectNeteaseReal.disabled = !ready;
            els.neteasePairingCode.disabled = !ready;
            els.neteaseAuthNote.textContent = ready
                    ? '服务器已启用本机 CLI，请输入本机操作员设置的配对码。'
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
        try {
            await api(`/api/connections/${provider}`, { method: 'POST', body: { mode: 'demo' } });
            await refreshState();
            return true;
        } catch (error) {
            toast(error.message, 'error', 6000);
            return false;
        }
    }

    async function connectRealQq() {
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
            toast('QQ 音乐已连接', 'success');
        } catch (error) {
            toast(error.message, 'error', 7000);
        } finally {
            setButtonBusy(els.connectQQReal, false);
        }
    }

    async function connectRealNetease() {
        if (state.config.neteaseRealReady !== true) {
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
            toast('网易云本机 CLI 已连接', 'success');
        } catch (error) {
            toast('网易云连接失败，请检查配对码及服务器本机 CLI 状态', 'error', 7000);
        } finally {
            setButtonBusy(els.connectNeteaseReal, false);
            els.connectNeteaseReal.disabled = state.config.neteaseRealReady !== true;
        }
    }

    async function connectRealApple(token) {
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
        const developerToken = state.config.appleDeveloperToken;
        if (!developerToken) {
            throw new Error('服务端未配置 Apple 开发者令牌，无法发起真实授权');
        }
        const MusicKit = await loadMusicKit();
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
        if (!token) {
            throw new Error('Apple Music 授权未返回用户令牌');
        }
        return token;
    }

    async function disconnect(provider) {
        els.disconnectBtn.disabled = true;
        try {
            await api(`/api/connections/${provider}`, { method: 'DELETE' });
            closeModal(els.connectModal);
            await refreshState();
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

    async function startMigration(options = {}) {
        if (jobRunning) {
            toast('已有迁移任务正在进行', 'info');
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

        if (connection(targetProvider).mode !== 'DEMO') {
            const cliNote = targetProvider === 'NETEASE_MUSIC'
                    ? '\n将使用服务器运行用户已登录的本机 CLI 账号，并非多用户授权。'
                    : '';
            if (!window.confirm(`真实迁移将在 ${providerLabel(targetProvider)} 创建新歌单并写入匹配歌曲。${cliNote}\n确定继续吗？`)) {
                return;
            }
        }

        jobRunning = true;
        latestJob = null;
        currentJobId = null;
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
            latestJob = job;
            currentJobId = job.id;
            renderJob(job);
            schedulePoll(job.id);
        } catch (error) {
            jobRunning = false;
            syncDirection();
            els.progressTitle.textContent = '无法开始迁移';
            els.progressStep.textContent = error.message;
            els.progressError.textContent = error.message;
            els.progressError.classList.remove('is-hidden');
            toast(error.message, 'error', 7000);
        }
    }

    function resetProgressUi() {
        els.progressView.classList.remove('is-hidden');
        els.resultView.classList.add('is-hidden');
        els.resultView.innerHTML = '';
        els.progressTitle.textContent = '正在迁移歌单';
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

    function schedulePoll(jobId) {
        window.clearTimeout(pollTimer);
        pollTimer = window.setTimeout(async () => {
            if (currentJobId !== jobId) {
                return;
            }
            try {
                const job = await api(`/api/migrations/${encodeURIComponent(jobId)}`);
                if (currentJobId !== jobId) {
                    return;
                }
                latestJob = job;
                renderJob(job);
                if (job.status === 'COMPLETED' || job.status === 'FAILED') {
                    finishJob(job);
                    return;
                }
                if (!els.jobPill.classList.contains('is-hidden')) {
                    els.jobPillText.textContent = `迁移进行中 · ${job.progress}%`;
                }
                schedulePoll(jobId);
            } catch (error) {
                jobRunning = false;
                syncDirection();
                els.progressError.textContent = `获取任务状态失败：${error.message}`;
                els.progressError.classList.remove('is-hidden');
                showJobPill(latestJob || { status: 'FAILED', progress: 0 });
            }
        }, 650);
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
            els.progressTitle.textContent = job.status === 'COMPLETED' ? '迁移完成' : '正在迁移歌单';
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

        if (job.status === 'COMPLETED') {
            els.progressTitle.textContent = '迁移完成';
            renderResult(job);
            launchConfetti();
            if (!els.progressModal.classList.contains('is-hidden')) {
                hideJobPill();
            } else {
                showJobPill(job);
            }
            const demoResult = job.result && String(job.result.playlistUrl || '').startsWith('demo://');
            toast(`迁移完成，已写入${demoResult ? '演示音乐库' : ''} ${job.result ? job.result.addedCount : 0} 首`, 'success', 5000);
        } else {
            els.progressTitle.textContent = '迁移失败';
            els.progressStep.textContent = job.currentStep || '已停止';
            els.progressFill.style.background = 'linear-gradient(90deg, #ff9a86, #d4463a)';
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
        const lowCount = matches.filter((item) => item.matched && item.lowConfidence).length;
        const sourceName = job.source ? job.source.name : '来源歌单';
        const demoResult = String(result.playlistUrl || '').startsWith('demo://');
        const resultTarget = job.target && job.target.provider ? job.target.provider : targetProvider;
        const perfect = result.matchRate >= 100;
        const rows = matches.map((item) => {
            let statusClass = 'missing';
            let icon = '×';
            if (item.matched) {
                statusClass = item.lowConfidence ? 'low' : 'matched';
                icon = item.lowConfidence ? '!' : '✓';
            }
            const target = item.matched
                    ? `${escapeHtml(item.targetTitle)} · ${escapeHtml(item.targetArtist)}`
                    : escapeHtml(item.note || '目标平台未找到匹配歌曲');
            return `
                <div class="result-track">
                    <span class="result-status ${statusClass}">${icon}</span>
                    <div class="result-track-main">
                        <b>${escapeHtml(item.title)} · ${escapeHtml(item.artist)}</b>
                        <small>${target}</small>
                    </div>
                    ${item.score ? `<span class="result-score">${item.score}%</span>` : ''}
                    ${item.note && item.matched ? `<span class="result-note">${escapeHtml(item.note)}</span>` : ''}
                </div>
            `;
        }).join('');

        const linkBlock = !demoResult && /^https?:\/\//.test(result.playlistUrl || '')
                ? `<div class="result-link"><span class="link-label">打开新歌单</span><a href="${escapeHtml(result.playlistUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.playlistUrl)}</a></div>`
                : demoResult
                    ? `<div class="result-link"><span class="link-label">演示歌单</span><span>${resultTarget === 'NETEASE_MUSIC' ? '已写入本次会话的演示音乐库，不支持作为迁移来源。' : '已写入本次会话的演示音乐库，可继续作为下一次迁移的来源。'}</span></div>`
                    : '';

        els.progressView.classList.add('is-hidden');
        els.resultView.classList.remove('is-hidden');
        els.resultView.innerHTML = `
            <div class="result-hero">
                <div class="result-badge ${perfect ? '' : 'is-warn'}">${perfect ? '✓' : '!'}</div>
                <h3>${perfect ? '迁移完成' : '迁移完成，有少量缺口'}</h3>
                <p>《${escapeHtml(sourceName)}》 → ${escapeHtml(job.target ? job.target.providerLabel : '目标平台')}</p>
            </div>
            <div class="result-stats">
                <div class="is-good"><strong>${result.addedCount}</strong><span>成功迁移</span></div>
                <div class="${result.unmatchedCount ? 'is-bad' : ''}"><strong>${result.unmatchedCount}</strong><span>未匹配</span></div>
                <div class="${lowCount ? 'is-warn' : ''}"><strong>${lowCount}</strong><span>低置信</span></div>
                <div><strong>${result.matchRate}%</strong><span>匹配率</span></div>
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
        els.jobPill.classList.remove('is-done', 'is-error');
        if (job.status === 'COMPLETED') {
            els.jobPill.classList.add('is-done');
            els.jobPillText.textContent = '迁移完成 · 查看报告';
        } else if (job.status === 'FAILED') {
            els.jobPill.classList.add('is-error');
            els.jobPillText.textContent = '迁移失败 · 查看原因';
        } else {
            els.jobPillText.textContent = `迁移进行中 · ${job.progress || 0}%`;
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
            toast('演示账号已就绪，开始迁移', 'success', 2600);
            await startMigration();
        } finally {
            buttons.forEach((button) => { button.disabled = state.config.demoEnabled === false; });
            if (heroLabel) {
                heroLabel.textContent = '一键体验迁移';
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
            tab.classList.toggle('active', tab.dataset.libraryProvider === provider);
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

        const colors = ['#ff6b57', '#f4a63a', '#2e9e74', '#7a6bd6', '#ff9a86', '#ffd9a0'];
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
            if (event.key !== 'Escape') {
                return;
            }
            const open = document.querySelector('.modal:not(.is-hidden)');
            if (open) {
                closeModal(open);
            }
        });
    }

    async function init() {
        cacheElements();
        wireEvents();
        await refreshState();
        syncDirection();
    }

    init();
})();

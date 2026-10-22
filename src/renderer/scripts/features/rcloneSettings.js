import { t, onLanguageChange } from '../lib/i18n.js';

let containerEl = null;
let cachedStatus = null;
let statusError = null;
let isStatusLoading = false;
let newConfiguredRemoteThisVisit = null;
let configSessionActive = false;
let configGeneration = 0;
let lifecycleGeneration = 0;
let isSettingsOpen = false;
let openRemoteFolderCallback = null;

// Track in-flight backend cancel/read promises
let pendingCancelPromise = null;
let activeReadPromise = null;
let inFlightStatusPromise = null;

// Draft and auth persistence across re-renders
let draftRemoteName = 'gdrive';
let activeAuthState = null;
let activeFeedback = null;

// Remote connection states: remoteName -> { state: 'unchecked' | 'checking' | 'connected' | 'auth-required' | 'error', errorMsg?: string }
const remoteStates = new Map();

/**
 * Unwrap the { ok: true, data } / { ok: false, error } API envelope.
 * Throws an Error with .code set to error.code.
 */
export async function unwrapRcloneResponse(promise) {
    const res = await promise;
    if (res && typeof res === 'object' && res.ok === true) {
        return res.data;
    }
    const code = res?.error?.code || 'REMOTE_ERROR';
    const rawMessage = res?.error?.message || 'Remote operation failed';
    const cleanMessage = String(rawMessage)
        .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/, '')
        .replace(/^Error:\s*/, '');
    const error = new Error(cleanMessage);
    error.code = code;
    throw error;
}

/**
 * Translate error code to localized message, or fallback to cleaned message.
 */
export function getRcloneErrorMessage(error) {
    const code = error?.code;
    if (code) {
        const translated = t(`ui.rclone.errors.${code}`);
        if (translated && !translated.startsWith('ui.rclone.errors.')) {
            return translated;
        }
    }
    const msg = error?.message ? String(error.message) : '';
    const cleaned = msg.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/, '').replace(/^Error:\s*/, '');
    return cleaned || t('ui.rclone.errors.REMOTE_ERROR');
}

export function getNewConfiguredRemoteThisVisit() {
    return newConfiguredRemoteThisVisit;
}

export function resetConfiguredRemoteForVisit() {
    newConfiguredRemoteThisVisit = null;
}

/**
 * Cancel active configuration session, awaiting backend cancellation to avoid BUSY.
 * Deduplicates concurrent cancels, keeps auth busy until cleanup completes, then renders.
 */
export async function cancelConfigSession() {
    if (pendingCancelPromise) {
        return pendingCancelPromise;
    }
    if (!configSessionActive) {
        return;
    }

    // Invalidate generation immediately to reject late async results
    configGeneration++;

    pendingCancelPromise = (async () => {
        try {
            if (window.electronAPI?.rcloneConfigCancel) {
                await window.electronAPI.rcloneConfigCancel();
            }
        } catch (_) {
        } finally {
            configSessionActive = false;
            activeAuthState = null;
            pendingCancelPromise = null;
            render();
            enableFormControls(true);
        }
    })();

    return pendingCancelPromise;
}

/**
 * Invoked when settings modal closes. Invalidates in-flight status loads/auto-reconnects
 * and awaits both backend auth cancellation and in-flight read settlement (including state reset).
 */
export async function onCloseRcloneSettings() {
    isSettingsOpen = false;
    lifecycleGeneration++;

    const cancelAuth = cancelConfigSession();

    let cancelRead = null;
    if (activeReadPromise && window.electronAPI?.rcloneCancel) {
        try {
            cancelRead = window.electronAPI.rcloneCancel().catch(() => {});
        } catch (_) {}
    }

    await Promise.all([cancelAuth, cancelRead, activeReadPromise]);
}

/**
 * Initialize Cloud Storage settings
 */
export function initRcloneSettings(deps = {}) {
    openRemoteFolderCallback = deps.onOpenRemoteFolder || null;
    containerEl = document.getElementById('rcloneSettingsContainer');
    if (!containerEl) return;

    onLanguageChange(() => {
        if (containerEl && (cachedStatus || statusError || activeAuthState)) {
            render();
        }
    });
}

/**
 * Called when Settings modal is opened to storage section
 */
export async function onOpenRcloneSettings(selectedRemote = null, options = {}) {
    const isNewVisit = !isSettingsOpen;
    isSettingsOpen = true;

    if (isNewVisit) {
        resetConfiguredRemoteForVisit();
        ++lifecycleGeneration;
    }

    const currentGen = lifecycleGeneration;

    if (isNewVisit && activeReadPromise) {
        try {
            await activeReadPromise;
        } catch (_) {}
    }

    if (!isSettingsOpen || currentGen !== lifecycleGeneration) return;

    // Do not restart metadata request if auth session is active, or if a check is running
    if (!configSessionActive && !isAnyCheckRunning()) {
        await loadStatus();
    }

    if (!isSettingsOpen || currentGen !== lifecycleGeneration) return;

    if (selectedRemote) {
        focusRemoteRow(selectedRemote);
        if (options.reconnect && !configSessionActive) {
            const remoteObj = cachedStatus?.remotes?.find(r => r.name === selectedRemote);
            if (remoteObj?.canReconnect) {
                startConfigure({ mode: 'reconnect', name: selectedRemote });
            } else {
                showFeedback(t('ui.rclone.errors.UNSUPPORTED'), 'error');
            }
        }
    }
}

async function loadStatus() {
    if (inFlightStatusPromise) {
        return inFlightStatusPromise;
    }
    const api = window.electronAPI;
    if (!api?.rcloneStatus || !containerEl) return;

    const currentGen = lifecycleGeneration;
    isStatusLoading = true;
    render(); // Set busy and render BEFORE awaiting status

    let currentReadWrapper;
    currentReadWrapper = (async () => {
        try {
            const status = await unwrapRcloneResponse(api.rcloneStatus());
            if (isSettingsOpen && currentGen === lifecycleGeneration) {
                cachedStatus = status;
                statusError = null;
            }
        } catch (err) {
            if (isSettingsOpen && currentGen === lifecycleGeneration) {
                statusError = getRcloneErrorMessage(err);
            }
        } finally {
            if (activeReadPromise === currentReadWrapper) {
                activeReadPromise = null;
            }
            inFlightStatusPromise = null;
            isStatusLoading = false;
            if (isSettingsOpen && currentGen === lifecycleGeneration) {
                render();
            }
        }
    })();

    activeReadPromise = currentReadWrapper;
    inFlightStatusPromise = currentReadWrapper;
    return currentReadWrapper;
}

function focusRemoteRow(remoteName) {
    if (!containerEl) return;
    const card = containerEl.querySelector(`[data-remote-name="${CSS.escape(remoteName)}"]`);
    if (card) {
        card.classList.add('highlight');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => card.classList.remove('highlight'), 2500);
    }
}

function isAnyCheckRunning() {
    for (const info of remoteStates.values()) {
        if (info.state === 'checking') return true;
    }
    return false;
}

function isAnyActionBusy() {
    if (configSessionActive || pendingCancelPromise !== null || isStatusLoading) return true;
    return isAnyCheckRunning();
}

function render() {
    if (!containerEl) return;
    containerEl.replaceChildren();

    renderStatusCard();
    renderRemotesList();
    renderAddDriveCard();
}

function renderStatusCard() {
    const card = document.createElement('div');
    card.className = 'rclone-status-card';

    const header = document.createElement('div');
    header.className = 'rclone-card-header';

    const title = document.createElement('span');
    title.className = 'rclone-card-title';
    title.textContent = t('ui.rclone.statusTitle');

    const badge = document.createElement('span');
    const isInstalled = cachedStatus?.installed === true;
    const hasStatus = cachedStatus !== null;

    if (statusError && !hasStatus) {
        badge.className = 'rclone-status-badge error';
        badge.textContent = t('ui.rclone.statusError');
    } else if (isInstalled) {
        badge.className = 'rclone-status-badge installed';
        const v = cachedStatus.version || '';
        const versionLabel = v ? (v.startsWith('v') ? v : `v${v}`) : '';
        badge.textContent = `${t('ui.rclone.installed')} ${versionLabel}`.trim();
    } else {
        badge.className = 'rclone-status-badge not-installed';
        badge.textContent = t('ui.rclone.notInstalled');
    }

    header.append(title, badge);
    card.append(header);

    const meta = document.createElement('div');
    meta.className = 'rclone-status-meta';

    if (statusError) {
        const errSpan = document.createElement('span');
        errSpan.className = 'rclone-remote-error';
        errSpan.textContent = statusError;
        meta.append(errSpan);
    } else if (isInstalled) {
        const pathSpan = document.createElement('span');
        pathSpan.className = 'rclone-path-text';
        pathSpan.textContent = cachedStatus.executable ? t('ui.rclone.executablePath', { path: cachedStatus.executable }) : '';
        pathSpan.title = cachedStatus.executable || '';
        meta.append(pathSpan);
    } else {
        const hint = document.createElement('span');
        hint.textContent = t('ui.rclone.installHint');

        const link = document.createElement('a');
        link.className = 'rclone-install-link';
        link.href = 'https://rclone.org/install/';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = t('ui.rclone.installGuide');
        link.onclick = (e) => {
            e.preventDefault();
            if (window.electronAPI?.openExternal) {
                window.electronAPI.openExternal('https://rclone.org/install/');
            }
        };
        meta.append(hint, link);
    }

    const chooseBtn = document.createElement('button');
    chooseBtn.className = 'btn btn-secondary btn-small';
    chooseBtn.type = 'button';
    chooseBtn.textContent = isInstalled ? t('ui.rclone.changeExecutable') : t('ui.rclone.locateExecutable');
    chooseBtn.disabled = isAnyActionBusy();
    chooseBtn.onclick = async () => {
        if (isAnyActionBusy()) return;
        chooseBtn.disabled = true;
        try {
            const newStatus = await unwrapRcloneResponse(window.electronAPI.rcloneChooseExecutable());
            if (newStatus) {
                cachedStatus = newStatus;
                statusError = null;
                render();
            }
        } catch (err) {
            statusError = getRcloneErrorMessage(err);
            render();
        } finally {
            chooseBtn.disabled = false;
        }
    };

    meta.append(chooseBtn);
    card.append(meta);
    containerEl.append(card);
}

function renderRemotesList() {
    const remotes = cachedStatus?.remotes || [];
    const wrapper = document.createElement('div');
    wrapper.className = 'rclone-remotes-container';

    const header = document.createElement('div');
    header.className = 'rclone-card-header';
    header.style.marginBottom = '6px';

    const title = document.createElement('span');
    title.className = 'rclone-card-title';
    title.textContent = t('ui.rclone.remotesTitle');

    header.append(title);
    wrapper.append(header);

    const list = document.createElement('div');
    list.className = 'rclone-remotes-list';

    if (!remotes.length) {
        const empty = document.createElement('div');
        empty.className = 'rclone-empty-remotes';
        empty.textContent = t('ui.rclone.noRemotesConfigured');
        list.append(empty);
    } else {
        for (const remote of remotes) {
            list.append(createRemoteCard(remote));
        }
    }

    wrapper.append(list);
    containerEl.append(wrapper);
}

function createRemoteCard(remote) {
    const card = document.createElement('div');
    card.className = 'rclone-remote-card';
    card.dataset.remoteName = remote.name;

    const current = remoteStates.get(remote.name) || { state: 'unchecked' };

    const header = document.createElement('div');
    header.className = 'rclone-remote-header';

    const info = document.createElement('div');
    info.className = 'rclone-remote-info';

    const name = document.createElement('span');
    name.className = 'rclone-remote-name';
    name.textContent = remote.name;
    name.title = remote.name;

    const typeBadge = document.createElement('span');
    typeBadge.className = 'rclone-type-badge';
    typeBadge.textContent = remote.type || 'remote';

    info.append(name, typeBadge);

    // Only source === 'environment' gets environment badge/title
    if (remote.source === 'environment') {
        const sourceBadge = document.createElement('span');
        sourceBadge.className = 'rclone-source-badge';
        sourceBadge.textContent = remote.source;
        sourceBadge.title = t('ui.rclone.envSource');
        info.append(sourceBadge);
    }

    const statusBadge = document.createElement('span');
    statusBadge.className = `rclone-status-badge ${current.state}`;

    if (current.state === 'connected') {
        statusBadge.textContent = t('ui.rclone.statusConnected');
    } else if (current.state === 'checking') {
        statusBadge.textContent = t('ui.rclone.statusChecking');
    } else if (current.state === 'auth-required') {
        statusBadge.textContent = t('ui.rclone.statusAuthRequired');
    } else if (current.state === 'error') {
        statusBadge.textContent = t('ui.rclone.statusError');
    } else {
        statusBadge.textContent = t('ui.rclone.statusUnchecked');
    }

    header.append(info, statusBadge);
    card.append(header);

    if (current.errorMsg) {
        const errDiv = document.createElement('div');
        errDiv.className = 'rclone-remote-error';
        errDiv.textContent = current.errorMsg;
        card.append(errDiv);
    }

    const actions = document.createElement('div');
    actions.className = 'rclone-remote-actions';

    const isInstalled = cachedStatus?.installed === true;
    const actionsDisabled = isAnyActionBusy() || !isInstalled;

    const checkBtn = document.createElement('button');
    checkBtn.className = 'btn btn-secondary btn-small rclone-check-btn';
    checkBtn.dataset.action = 'check';
    checkBtn.type = 'button';
    checkBtn.textContent = t('ui.rclone.checkConnection');
    checkBtn.disabled = actionsDisabled || current.state === 'checking';
    checkBtn.onclick = async () => {
        if (isAnyActionBusy()) return;
        await checkRemote(remote.name);
    };
    actions.append(checkBtn);

    if (remote.canReconnect) {
        const reconnectBtn = document.createElement('button');
        reconnectBtn.className = 'btn btn-secondary btn-small rclone-reconnect-btn';
        reconnectBtn.dataset.action = 'reconnect';
        reconnectBtn.type = 'button';
        reconnectBtn.textContent = t('ui.rclone.reconnect');
        reconnectBtn.disabled = actionsDisabled;
        reconnectBtn.onclick = () => {
            if (isAnyActionBusy()) return;
            startConfigure({ mode: 'reconnect', name: remote.name });
        };
        actions.append(reconnectBtn);
    }

    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-primary btn-small rclone-open-btn';
    openBtn.dataset.action = 'open';
    openBtn.type = 'button';
    openBtn.textContent = t('ui.rclone.openFolder');
    openBtn.disabled = actionsDisabled;
    openBtn.onclick = () => {
        if (isAnyActionBusy()) return;
        openRemoteFolder(remote.name);
    };
    actions.append(openBtn);

    card.append(actions);
    return card;
}

async function checkRemote(name) {
    if (isAnyActionBusy()) return;

    const currentGen = lifecycleGeneration;
    remoteStates.set(name, { state: 'checking' });
    render(); // Set busy and render BEFORE awaiting check

    let currentReadWrapper;
    currentReadWrapper = (async () => {
        try {
            const res = await unwrapRcloneResponse(window.electronAPI.rcloneCheck(name));
            if (isSettingsOpen && currentGen === lifecycleGeneration) {
                if (res && res.connected) {
                    remoteStates.set(name, { state: 'connected' });
                } else {
                    remoteStates.set(name, { state: 'error', errorMsg: t('ui.rclone.errors.REMOTE_ERROR') });
                }
            } else {
                // If closed or generation changed, reset checking state so next visit is not stuck in busy
                remoteStates.set(name, { state: 'unchecked' });
            }
        } catch (err) {
            if (isSettingsOpen && currentGen === lifecycleGeneration) {
                if (err.code === 'AUTH_REQUIRED') {
                    remoteStates.set(name, { state: 'auth-required', errorMsg: getRcloneErrorMessage(err) });
                } else {
                    remoteStates.set(name, { state: 'error', errorMsg: getRcloneErrorMessage(err) });
                }
            } else {
                // If closed or generation changed, reset checking state
                remoteStates.set(name, { state: 'unchecked' });
            }
        } finally {
            if (activeReadPromise === currentReadWrapper) {
                activeReadPromise = null;
            }
            if (isSettingsOpen && currentGen === lifecycleGeneration) {
                render();
            }
        }
    })();

    activeReadPromise = currentReadWrapper;
    return currentReadWrapper;
}

function openRemoteFolder(remoteName) {
    if (openRemoteFolderCallback) {
        openRemoteFolderCallback(remoteName);
    }
}

function renderAddDriveCard() {
    const card = document.createElement('div');
    card.className = 'rclone-add-drive-card';
    card.id = 'rcloneAddDriveCard';

    const title = document.createElement('span');
    title.className = 'rclone-card-title';
    title.textContent = t('ui.rclone.addGoogleDriveTitle');

    const desc = document.createElement('span');
    desc.className = 'rclone-card-desc';
    desc.textContent = t('ui.rclone.addGoogleDriveDesc');

    const form = document.createElement('div');
    form.className = 'rclone-add-form';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.id = 'rcloneDriveNameInput';
    input.placeholder = t('ui.rclone.remoteNamePlaceholder');
    input.setAttribute('aria-label', t('ui.rclone.remoteNamePlaceholder'));
    input.value = draftRemoteName;
    input.disabled = isAnyActionBusy();
    input.oninput = () => {
        draftRemoteName = input.value;
    };

    const isInstalled = cachedStatus?.installed === true;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-small';
    btn.id = 'rcloneDriveSubmitBtn';
    btn.type = 'button';
    btn.textContent = t('ui.rclone.signInWithBrowser');
    btn.disabled = isAnyActionBusy() || !isInstalled;

    form.append(input, btn);

    const feedback = document.createElement('div');
    feedback.className = 'rclone-form-feedback hidden';
    feedback.id = 'rcloneFormFeedback';

    const authPanel = document.createElement('div');
    authPanel.className = 'rclone-auth-panel hidden';
    authPanel.id = 'rcloneAuthPanel';

    btn.onclick = () => {
        if (isAnyActionBusy() || !isInstalled) return;
        const nameVal = input.value.trim();
        if (!nameVal) {
            showFeedback(t('ui.rclone.nameRequired'), 'error');
            return;
        }
        if (/[:/\\]/.test(nameVal)) {
            showFeedback(t('ui.rclone.invalidRemoteName'), 'error');
            return;
        }
        showFeedback(null);
        startConfigure({ mode: 'create', name: nameVal });
    };

    card.append(title, desc, form, feedback, authPanel);
    containerEl.append(card);

    // Restore active feedback if any
    if (activeFeedback?.text) {
        showFeedback(activeFeedback.text, activeFeedback.type);
    }

    // Restore active auth panel if any
    if (activeAuthState) {
        renderAuthPanel(activeAuthState);
    }
}

function showFeedback(text, type = 'error') {
    activeFeedback = text ? { text, type } : null;
    const feedback = document.getElementById('rcloneFormFeedback');
    if (!feedback) return;
    if (!text) {
        feedback.textContent = '';
        feedback.className = 'rclone-form-feedback hidden';
        return;
    }
    feedback.textContent = text;
    feedback.className = `rclone-form-feedback ${type}`;
}

function enableFormControls(enabled) {
    const input = document.getElementById('rcloneDriveNameInput');
    const btn = document.getElementById('rcloneDriveSubmitBtn');
    if (input) input.disabled = !enabled;
    if (btn) btn.disabled = !enabled;
}

function getPromptLabel(question) {
    if (!question) return '';
    if (question.name) {
        const translatedPrompt = t(`ui.rclone.prompts.${question.name}`);
        if (translatedPrompt && !translatedPrompt.startsWith('ui.rclone.prompts.')) {
            return translatedPrompt;
        }
    }
    return question.label || question.name || '';
}

async function startConfigure({ mode, name }) {
    if (isAnyActionBusy()) return;
    const isInstalled = cachedStatus?.installed === true;
    if (!isInstalled) return;

    configSessionActive = true;
    const currentGen = ++configGeneration;

    render(); // Update UI to disable buttons while auth session starts
    enableFormControls(false);
    showFeedback(null);

    const authState = {
        title: t('ui.rclone.awaitingSignIn'),
        desc: t('ui.rclone.awaitingSignInDesc'),
        showSpinner: true,
        question: null
    };
    activeAuthState = authState;
    renderAuthPanel(authState);

    const authPanelEl = document.getElementById('rcloneAuthPanel');
    if (authPanelEl) {
        authPanelEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    try {
        const res = await unwrapRcloneResponse(
            window.electronAPI.rcloneConfigure({ mode, name })
        );

        if (currentGen !== configGeneration || !isSettingsOpen) return;
        await handleConfigResult(res, currentGen);
    } catch (err) {
        if (currentGen !== configGeneration || !isSettingsOpen) return;
        configSessionActive = false;
        activeAuthState = null;
        renderAuthPanel(null);
        enableFormControls(true);
        showFeedback(getRcloneErrorMessage(err), 'error');
        render(); // Re-enable controls
    }
}

async function handleConfigResult(result, currentGen) {
    if (currentGen !== configGeneration || !isSettingsOpen) return;

    if (!result) {
        configSessionActive = false;
        activeAuthState = null;
        renderAuthPanel(null);
        enableFormControls(true);
        render();
        return;
    }

    if (result.done) {
        configSessionActive = false;
        activeAuthState = null;
        newConfiguredRemoteThisVisit = result.remote;
        remoteStates.set(result.remote, { state: 'connected' });
        renderAuthPanel(null);
        enableFormControls(true);
        showFeedback(t('ui.rclone.configSuccess', { remote: result.remote }), 'success');
        await loadStatus();
        return;
    }

    if (result.question) {
        const promptLabel = getPromptLabel(result.question);
        const nextState = {
            title: promptLabel || result.remote,
            desc: '',
            showSpinner: false,
            question: result.question,
            onSubmit: async (value) => {
                if (currentGen !== configGeneration || !isSettingsOpen) return;
                const checkingState = {
                    title: t('ui.rclone.statusChecking'),
                    desc: '',
                    showSpinner: true,
                    question: null
                };
                activeAuthState = checkingState;
                renderAuthPanel(checkingState);

                try {
                    const nextRes = await unwrapRcloneResponse(
                        window.electronAPI.rcloneConfigContinue({
                            sessionId: result.sessionId,
                            value: String(value)
                        })
                    );
                    if (currentGen !== configGeneration || !isSettingsOpen) return;
                    await handleConfigResult(nextRes, currentGen);
                } catch (err) {
                    if (currentGen !== configGeneration || !isSettingsOpen) return;
                    configSessionActive = false;
                    activeAuthState = null;
                    renderAuthPanel(null);
                    enableFormControls(true);
                    showFeedback(getRcloneErrorMessage(err), 'error');
                    render();
                }
            }
        };
        activeAuthState = nextState;
        renderAuthPanel(nextState);
    } else {
        const waitingState = {
            title: t('ui.rclone.awaitingSignIn'),
            desc: t('ui.rclone.awaitingSignInDesc'),
            showSpinner: true,
            question: null
        };
        activeAuthState = waitingState;
        renderAuthPanel(waitingState);
    }
}

function renderAuthPanel(config) {
    const panel = document.getElementById('rcloneAuthPanel');
    if (!panel) return;

    if (!config) {
        panel.replaceChildren();
        panel.classList.add('hidden');
        return;
    }

    panel.replaceChildren();
    panel.classList.remove('hidden');

    const header = document.createElement('div');
    header.className = 'rclone-auth-header';

    if (config.showSpinner) {
        const spinner = document.createElement('div');
        spinner.className = 'rclone-spinner';
        header.append(spinner);
    }

    const title = document.createElement('span');
    title.className = 'rclone-auth-title';
    title.textContent = config.title;
    header.append(title);
    panel.append(header);

    if (config.desc) {
        const desc = document.createElement('div');
        desc.className = 'rclone-card-desc';
        desc.textContent = config.desc;
        panel.append(desc);
    }

    let getQuestionValue = null;

    if (config.question) {
        const qContainer = document.createElement('div');
        qContainer.className = 'rclone-question-container';

        const q = config.question;
        const inputId = `rcloneQuestion_${q.name || 'field'}`;
        const qLabel = document.createElement('label');
        qLabel.className = 'rclone-question-label';
        qLabel.htmlFor = inputId;
        qLabel.textContent = getPromptLabel(q);
        qContainer.append(qLabel);

        if (q.type === 'bool') {
            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.id = inputId;
            toggle.setAttribute('aria-label', qLabel.textContent);
            toggle.checked = q.defaultValue === 'true' || q.defaultValue === true;
            qContainer.append(toggle);
            getQuestionValue = () => String(toggle.checked);
        } else if (q.type === 'select') {
            const select = document.createElement('select');
            select.id = inputId;
            select.setAttribute('aria-label', qLabel.textContent);
            select.className = 'settings-select';
            const choices = q.choices || [];
            for (const c of choices) {
                const opt = document.createElement('option');
                opt.value = c.value;
                opt.textContent = c.label || c.value;
                if (c.value === q.defaultValue) opt.selected = true;
                select.append(opt);
            }
            qContainer.append(select);
            getQuestionValue = () => select.value;
        } else {
            const textInput = document.createElement('input');
            textInput.type = 'text';
            textInput.id = inputId;
            textInput.setAttribute('aria-label', qLabel.textContent);
            textInput.className = 'text-input';
            textInput.value = q.defaultValue || '';
            qContainer.append(textInput);
            getQuestionValue = () => textInput.value;
        }

        panel.append(qContainer);
    }

    const actions = document.createElement('div');
    actions.className = 'rclone-auth-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary btn-small';
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('ui.rclone.cancel');
    cancelBtn.setAttribute('aria-label', t('ui.rclone.cancel'));
    cancelBtn.onclick = async () => {
        await cancelConfigSession();
    };
    actions.append(cancelBtn);

    if (config.question && config.onSubmit) {
        const submitBtn = document.createElement('button');
        submitBtn.className = 'btn btn-primary btn-small';
        submitBtn.type = 'button';
        submitBtn.textContent = t('ui.rclone.continuePrompt');
        submitBtn.setAttribute('aria-label', t('ui.rclone.continuePrompt'));
        submitBtn.onclick = () => {
            const val = getQuestionValue ? getQuestionValue() : '';
            config.onSubmit(val);
        };
        actions.append(submitBtn);
    }

    panel.append(actions);
}

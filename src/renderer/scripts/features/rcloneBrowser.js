import { t, onLanguageChange } from '../lib/i18n.js';
import { openSettingsModal, registerRcloneBrowserOpener } from '../ui/settingsModal.js';
import { unwrapRcloneResponse as unwrap, getRcloneErrorMessage } from './rcloneSettings.js';

const snapshotRoots = new Set();
export function isReadOnlyRclonePath(value) {
    if (typeof value !== 'string') return false;
    const normalized = value.replace(/\\/g, '/');
    return [...snapshotRoots].some(root => normalized === root || normalized.startsWith(`${root}/`));
}

export function initRcloneBrowser(onOpen) {
    const api = window.electronAPI;
    const button = document.getElementById('rcloneOpenButton');
    if (!button || !api?.rcloneRemotes || button.dataset.initialized) return;
    button.dataset.initialized = 'true';
    button.hidden = false;
    const make = (tag, className, id) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (id) element.id = id;
        return element;
    };
    const icon = kind => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', kind === 'folder' ? 'M3 7h7l2 2h9v11H3V7Zm0 0V4h7l2 3' : 'M6 3h8l4 4v14H6V3Zm8 0v5h4');
        svg.append(path);
        return svg;
    };
    const dialog = make('dialog', 'rclone-dialog', 'rcloneDialog');
    dialog.setAttribute('aria-labelledby', 'rcloneTitle');
    dialog.setAttribute('aria-describedby', 'rcloneDescription');
    const header = make('div', 'modal-header');
    const title = make('h2', '', 'rcloneTitle');
    const headerClose = make('button', 'icon-btn', 'rcloneHeaderClose');
    headerClose.textContent = '×';
    header.append(title, headerClose);
    const body = make('div', 'modal-body rclone-body');
    const help = make('p', 'rclone-description', 'rcloneDescription');
    const storage = make('div', 'rclone-storage');
    const label = make('label'); label.setAttribute('for', 'rcloneRemote');
    const select = make('select', '', 'rcloneRemote');
    const refresh = make('button', 'btn btn-secondary', 'rcloneRefresh');
    const manage = make('button', 'btn btn-secondary', 'rcloneManage');
    storage.append(label, select, refresh, manage);
    const navigation = make('div', 'rclone-navigation');
    const up = make('button', 'btn btn-secondary', 'rcloneUp');
    const location = make('p', 'rclone-location', 'rcloneLocation');
    navigation.append(up, location);
    const status = make('p', 'rclone-status', 'rcloneStatus');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const authAction = make('button', 'btn btn-primary btn-small rclone-auth-action', 'rcloneAuthAction');
    authAction.hidden = true;
    const details = make('details', 'rclone-error-details'); details.hidden = true;
    const summary = make('summary');
    const errorText = make('p'); details.append(summary, errorText);
    const list = make('div', 'rclone-list', 'rcloneList');
    body.append(help, storage, navigation, status, authAction, details, list);
    const footer = make('div', 'modal-footer rclone-footer');
    const safety = make('p', 'rclone-safety');
    const close = make('button', 'btn btn-secondary', 'rcloneClose');
    const open = make('button', 'btn btn-primary', 'rcloneDownload');
    footer.append(safety, close, open);
    dialog.append(header, body, footer);
    document.body.append(dialog);
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('mousedown', event => event.stopPropagation());
    let folder = '', busy = false, generation = 0, hasClips = false, opening = false;
    let statusKey = 'chooseFolder', statusParams = {}, returnFocus = button;
    function setStatus(key, state = '', params = {}) {
        statusKey = key; statusParams = params;
        status.textContent = t(`ui.rclone.${key}`, params);
        status.dataset.state = state;
    }
    function localize() {
        button.title = t('ui.rclone.entry'); button.setAttribute('aria-label', button.title);
        title.textContent = t('ui.rclone.title'); help.textContent = t('ui.rclone.description');
        label.textContent = t('ui.rclone.remoteLabel'); refresh.textContent = t('ui.rclone.refresh');
        manage.textContent = t('ui.rclone.manageConnections') || 'Manage Connections';
        up.textContent = t('ui.rclone.up'); open.textContent = t('ui.rclone.open');
        close.textContent = t(`ui.rclone.${busy ? 'cancel' : 'close'}`);
        headerClose.setAttribute('aria-label', t('ui.rclone.close'));
        safety.textContent = t('ui.rclone.safety'); summary.textContent = t('ui.rclone.errorDetails');
        authAction.textContent = t('ui.rclone.reconnect') || 'Reconnect';
        status.textContent = t(`ui.rclone.${statusKey}`, statusParams);
        for (const row of list.querySelectorAll('[data-folder-name]')) row.setAttribute('aria-label', `${t('ui.rclone.folder')}: ${row.dataset.folderName}`);
    }
    function controls() {
        select.disabled = busy || !select.value; refresh.disabled = busy; manage.disabled = busy;
        up.disabled = busy || !folder; open.disabled = busy || !hasClips;
        for (const item of list.querySelectorAll('button')) item.disabled = busy;
        button.disabled = busy; close.disabled = headerClose.disabled = opening;
        dialog.setAttribute('aria-busy', String(busy));
        close.textContent = t(`ui.rclone.${busy ? 'cancel' : 'close'}`);
    }
    async function run(fn, message) {
        if (busy) return;
        const current = ++generation;
        busy = true; details.hidden = true; details.open = false; authAction.hidden = true;
        controls(); setStatus(message, 'loading');
        try { await fn(() => current === generation && dialog.open); }
        catch (error) {
            if (current === generation && dialog.open) {
                setStatus('errorTitle', 'error');
                errorText.textContent = getRcloneErrorMessage(error);
                details.hidden = !errorText.textContent;

                if (error?.code === 'AUTH_REQUIRED') {
                    authAction.hidden = false;
                }
            }
        } finally {
            if (current === generation) { busy = false; controls(); }
        }
    }
    async function browse(active) {
        hasClips = false; list.replaceChildren();
        location.textContent = `${select.value}:${folder || '/'}`; location.title = location.textContent;
        const entries = await unwrap(api.rcloneList(select.value, folder));
        if (!active()) return;
        let count = 0;
        for (const entry of entries) {
            if (!entry.isDirectory && !entry.playable) continue;
            const row = make(entry.isDirectory ? 'button' : 'div', 'rclone-row');
            const name = make('span', 'rclone-row-name'); name.textContent = entry.name;
            row.title = entry.name; row.append(icon(entry.isDirectory ? 'folder' : 'file'), name);
            if (entry.isDirectory) {
                row.dataset.folderName = entry.name;
                row.setAttribute('aria-label', `${t('ui.rclone.folder')}: ${entry.name}`);
                row.onclick = () => { if (busy) return; folder = folder ? `${folder}/${entry.name}` : entry.name; run(browse, 'readingFolder'); };
            } else {
                count++;
                const size = make('span', 'rclone-row-size'); size.textContent = `${(entry.size / 1024 ** 2).toFixed(1)} MiB`; row.append(size);
            }
            list.append(row);
        }
        hasClips = count > 0;
        setStatus(hasClips ? 'ready' : list.children.length ? 'chooseFolder' : 'emptyFolder', hasClips ? 'ready' : '', { count });
    }
    async function load(active) {
        hasClips = false; list.replaceChildren(); select.replaceChildren(); location.textContent = '';
        const remotes = await unwrap(api.rcloneRemotes());
        if (!active()) return;
        for (const remote of remotes) { const option = make('option'); option.value = option.textContent = remote; select.append(option); }
        folder = '';
        if (!remotes.length) { setStatus('noRemotes'); return; }
        await browse(active);
    }
    function onReturnFromSettings(targetRemote, targetFolder) {
        returnFocus = button;
        dialog.showModal();
        run(async active => {
            hasClips = false; list.replaceChildren(); select.replaceChildren(); location.textContent = '';
            const remotes = await unwrap(api.rcloneRemotes());
            if (!active()) return;
            for (const remote of remotes) { const option = make('option'); option.value = option.textContent = remote; select.append(option); }
            if (targetRemote && remotes.includes(targetRemote)) {
                select.value = targetRemote;
                folder = targetFolder || '';
            } else {
                folder = '';
            }
            if (!remotes.length) { setStatus('noRemotes'); return; }
            await browse(active);
        }, 'findingRemotes');
    }
    function openSettings(isReconnect = false) {
        if (opening) return;
        const preservedRemote = select.value;
        const preservedFolder = folder;
        dialog.close();
        openSettingsModal('storage', preservedRemote, {
            reconnect: isReconnect,
            onReturn: (newRemote) => {
                const finalRemote = newRemote || preservedRemote;
                const finalFolder = (finalRemote === preservedRemote) ? preservedFolder : '';
                onReturnFromSettings(finalRemote, finalFolder);
            }
        });
    }
    manage.onclick = () => openSettings(false);
    authAction.onclick = () => openSettings(true);
    button.onclick = () => {
        if (dialog.open || busy) return;
        returnFocus = document.activeElement || button;
        dialog.showModal(); run(load, 'findingRemotes');
    };
    refresh.onclick = () => run(load, 'findingRemotes');
    select.onchange = () => { if (busy) return; folder = ''; run(browse, 'readingFolder'); };
    up.onclick = () => { if (busy) return; folder = folder.split('/').slice(0, -1).join('/'); run(browse, 'readingFolder'); };
    open.onclick = () => {
        if (!hasClips || opening) return;
        run(async active => {
            const result = await unwrap(api.rcloneOpen(select.value, folder));
            if (!active()) return;
            snapshotRoots.add(result.directory.replace(/\\/g, '/'));
            opening = true; controls(); setStatus('preparing', 'loading');
            try { await onOpen(result); if (active()) dialog.close(); }
            finally { opening = false; controls(); }
        }, 'downloading');
    };
    async function cancel() {
        if (opening) return;
        ++generation; busy = false; dialog.close(); controls();
        try {
            if (api.rcloneCancel) await api.rcloneCancel();
        } catch (_) {}
    }
    close.onclick = headerClose.onclick = cancel;
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    dialog.addEventListener('close', () => { returnFocus?.focus(); });

    registerRcloneBrowserOpener((remoteName) => {
        if (dialog.open || busy) return;
        returnFocus = button;
        dialog.showModal();
        run(async active => {
            hasClips = false; list.replaceChildren(); select.replaceChildren(); location.textContent = '';
            const remotes = await unwrap(api.rcloneRemotes());
            if (!active()) return;
            for (const remote of remotes) { const option = make('option'); option.value = option.textContent = remote; select.append(option); }
            if (remoteName && remotes.includes(remoteName)) select.value = remoteName;
            folder = '';
            if (!remotes.length) { setStatus('noRemotes'); return; }
            await browse(active);
        }, 'findingRemotes');
    });

    onLanguageChange(localize);
    localize(); controls();
}

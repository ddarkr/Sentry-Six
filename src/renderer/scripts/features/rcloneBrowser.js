import { isRcloneStreamUrl } from '../lib/utils.js';
import { t, onLanguageChange } from '../lib/i18n.js';
import { openSettingsModal, registerRcloneBrowserOpener } from '../ui/settingsModal.js';
import { unwrapRcloneResponse as unwrap, getRcloneErrorMessage } from './rcloneSettings.js';

export function isReadOnlyRclonePath(value) {
    return isRcloneStreamUrl(value) || isRcloneStreamUrl(`${value}/thumb.png`);
}
let openDriveDataPicker = null;
export function openRcloneDriveDataBrowser() { openDriveDataPicker?.(); }

export function initRcloneBrowser(onOpen) {
    const api = window.electronAPI;
    const button = document.getElementById('rcloneOpenButton');
    const panel = document.getElementById('rcloneTreePanel');
    if (!button || !panel || !api?.rcloneRemotes || button.dataset.initialized) return;
    button.dataset.initialized = 'true'; button.hidden = false;
    button.setAttribute('aria-controls', panel.id);
    const make = (tag, className = '', id = '') => {
        const el = document.createElement(tag); el.className = className;
        if (id) el.id = id;
        return el;
    };
    const header = make('div', 'rclone-tree-header');
    const title = make('strong', '', 'rcloneTitle');
    const refresh = make('button', 'btn btn-secondary btn-small', 'rcloneRefresh');
    const manage = make('button', 'btn btn-secondary btn-small', 'rcloneManage');
    const close = make('button', 'btn btn-secondary btn-small', 'rcloneClose');
    header.append(title, refresh, manage, close);
    const status = make('p', 'rclone-status', 'rcloneStatus');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const reconnect = make('button', 'btn btn-secondary btn-small', 'rcloneAuthAction'); reconnect.hidden = true;
    const list = make('ul', 'rclone-tree', 'rcloneList');
    panel.append(header, status, reconnect, list);
    let generation = 0, busy = false, cancelling = false, integrating = false;
    let roots = [], selected = null, error = null, statusKey = 'chooseFolder';
    const labels = [];
    function label(el, key) { labels.push([el, key]); el.textContent = t(`ui.rclone.${key}`); }
    label(title, 'treeTitle'); label(refresh, 'refresh'); label(manage, 'manageConnections'); label(reconnect, 'reconnect');
    function controls() {
        button.disabled = cancelling;
        button.setAttribute('aria-expanded', String(!panel.hidden));
        panel.setAttribute('aria-busy', String(busy));
        refresh.disabled = manage.disabled = busy || cancelling;
        close.disabled = integrating || cancelling;
        close.textContent = t(`ui.rclone.${busy ? 'cancel' : 'close'}`);
        for (const el of list.querySelectorAll('button')) el.disabled = busy || cancelling;
    }
    function showStatus(key, failure = null) {
        statusKey = key; error = failure;
        status.textContent = failure ? getRcloneErrorMessage(failure) : t(`ui.rclone.${key}`);
        status.dataset.state = failure ? 'error' : busy ? 'loading' : '';
        reconnect.hidden = failure?.code !== 'AUTH_REQUIRED';
    }
    async function run(work, key) {
        if (busy || cancelling) return;
        const token = ++generation;
        const active = () => token === generation && !panel.hidden;
        busy = true; showStatus(key); controls();
        try { await work(active); }
        catch (failure) { if (active()) showStatus('errorTitle', failure); }
        finally {
            if (token === generation) {
                busy = false;
                if (!error) status.dataset.state = '';
                controls();
            }
        }
    }
    async function activate(node, filename, driveData = false) {
        selected = node;
        return run(async active => {
            const result = await unwrap(driveData ? api.rcloneOpenDriveData(node.remote, node.folder) : api.rcloneOpen(node.remote, node.folder));
            if (!active()) return;
            integrating = !driveData; controls();
            try {
                if (driveData) {
                    const loaded = await window._loadSentryUsbData(result.path);
                    if (!active()) return;
                    if (!loaded?.success) throw new Error(loaded?.error || t('ui.rclone.driveLoadError'));
                    document.getElementById('drivesTabBtn')?.click();
                } else {
                    await onOpen(filename ? { ...result, selectedFile: filename } : result);
                }
                if (active()) showStatus(driveData ? 'driveReady' : 'chooseFolder');
            } catch (failure) {
                if (active()) await api.rcloneCancel?.(!driveData);
                throw failure;
            } finally { integrating = false; controls(); }
        }, 'openingStream');
    }
    async function expand(node, active) {
        selected = node;
        if (node.loaded) {
            node.expanded = !node.expanded;
            node.children.hidden = !node.expanded;
            node.toggle.setAttribute('aria-expanded', String(node.expanded));
            showStatus('chooseFolder');
            return;
        }
        const entries = await unwrap(api.rcloneList(node.remote, node.folder));
        if (!active()) return;
        const counts = new Map();
        for (const entry of entries) if (entry.isDirectory) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
        for (const entry of entries) {
            if (entry.isDirectory) {
                const suffix = counts.get(entry.name) > 1 && entry.id ? ` (${entry.id.slice(-6)})` : '';
                addDirectory(node.children, { remote: node.remote, folder: entry.folder, name: entry.name + suffix });
            } else if (entry.playable || entry.name.toLowerCase() === 'drive-data.json') {
                const item = make('li'); const file = make('button', 'rclone-tree-file');
                file.textContent = entry.name; file.title = entry.name;
                file.onclick = () => activate(node, entry.name, entry.name.toLowerCase() === 'drive-data.json');
                item.append(file); node.children.append(item);
            }
        }
        if (entries.some(entry => !entry.isDirectory && entry.playable)) {
            const play = make('button', 'rclone-tree-play'); label(play, 'playFolder');
            play.onclick = () => activate(node); node.row.append(play);
        }
        node.loaded = node.expanded = true; node.children.hidden = false;
        node.toggle.setAttribute('aria-expanded', 'true');
        showStatus(node.children.children.length ? 'chooseFolder' : 'emptyFolder');
    }
    function addDirectory(parent, node) {
        const item = make('li', 'rclone-tree-directory');
        node.row = make('div', 'rclone-tree-row');
        node.toggle = make('button', 'rclone-tree-toggle');
        node.toggle.textContent = node.name; node.toggle.title = node.name;
        node.toggle.setAttribute('aria-expanded', 'false');
        node.children = make('ul'); node.children.hidden = true;
        node.toggle.onclick = () => run(active => expand(node, active), 'readingFolder');
        node.row.append(node.toggle); item.append(node.row, node.children); parent.append(item);
        return node;
    }
    async function load(active, targetRemote) {
        const remotes = await unwrap(api.rcloneRemotes());
        if (!active()) return;
        list.replaceChildren(); roots = []; labels.splice(4);
        selected = null;
        for (const remote of remotes) roots.push(addDirectory(list, { remote, folder: '', name: remote }));
        showStatus(remotes.length ? 'chooseFolder' : 'noRemotes');
        const target = roots.find(root => root.remote === targetRemote);
        if (target) await expand(target, active);
    }
    function show(targetRemote, reload = false) {
        if (cancelling || busy) return;
        panel.hidden = false; controls();
        if (!roots.length || reload) run(active => load(active, targetRemote), 'findingRemotes');
        else if (targetRemote) {
            const node = roots.find(root => root.remote === targetRemote);
            if (node && !node.expanded) run(active => expand(node, active), 'readingFolder');
        }
    }
    async function cancel() {
        if (panel.hidden || cancelling || integrating) return;
        const pending = busy;
        ++generation; panel.hidden = true; busy = false; cancelling = pending; controls();
        try { if (pending) await api.rcloneCancel?.(); }
        catch (_) { /* Closing must remain possible when cancellation fails. */ }
        finally { cancelling = false; controls(); button.focus(); }
    }
    function settings(reconnectAccount) {
        if (busy || cancelling) return;
        const remote = selected?.remote || roots[0]?.remote;
        panel.hidden = true; controls();
        openSettingsModal('storage', remote, { reconnect: reconnectAccount, onReturn: next => show(next || remote, true) });
    }
    button.onclick = () => panel.hidden ? show() : cancel();
    close.onclick = cancel;
    refresh.onclick = () => run(active => load(active), 'findingRemotes');
    manage.onclick = () => settings(false); reconnect.onclick = () => settings(true);
    panel.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    });
    panel.addEventListener('mousedown', event => event.stopPropagation());
    openDriveDataPicker = () => show();
    registerRcloneBrowserOpener(remote => show(remote));
    onLanguageChange(() => {
        for (const [el, key] of labels) el.textContent = t(`ui.rclone.${key}`);
        button.title = t('ui.rclone.entry'); button.setAttribute('aria-label', button.title);
        showStatus(statusKey, error); controls();
    });
    button.title = t('ui.rclone.entry'); button.setAttribute('aria-label', button.title);
    showStatus(statusKey); controls();
}

const snapshotRoots = new Set();
export function isReadOnlyRclonePath(value) {
    if (typeof value !== 'string') return false;
    const normalized = value.replace(/\\/g, '/');
    return [...snapshotRoots].some(root => normalized === root || normalized.startsWith(`${root}/`));
}
// Uses textContent for all remote-controlled names. No credentials or arbitrary commands.
export function initRcloneBrowser(onOpen) {
    const api = window.electronAPI;
    if (!api?.rcloneRemotes) return;
    const button = document.createElement('button');
    button.className = 'mini-btn'; button.textContent = 'Open rclone';
    // Keep the entry point available after the initial drop overlay is dismissed.
    button.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:1000';
    document.body.append(button);
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'width:min(620px,85vw);max-height:80vh;padding:24px;background:#20242b;color:white;border:1px solid #586272;border-radius:12px';
    const title = document.createElement('h2'); title.textContent = 'Read-only rclone recordings';
    const help = document.createElement('p');
    help.textContent = 'Uses rclone installed and configured on this computer. Browse to one folder containing TeslaCam MP4s. Opening downloads that folder only for seekable playback and export (2 GiB per session). Remote files are never changed.';
    const select = document.createElement('select'); select.setAttribute('aria-label', 'Configured rclone remote');
    const refresh = document.createElement('button'); refresh.textContent = 'Reload remotes';
    const up = document.createElement('button'); up.textContent = 'Parent folder';
    const location = document.createElement('p');
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const list = document.createElement('div'); list.style.cssText = 'max-height:35vh;overflow:auto;display:grid;gap:6px';
    const open = document.createElement('button'); open.textContent = 'Download and open this folder';
    const close = document.createElement('button'); close.textContent = 'Close / cancel';
    dialog.append(title, help, select, refresh, up, location, status, list, open, close);
    document.body.append(dialog);
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('mousedown', event => event.stopPropagation());
    let folder = '', busy = false, generation = 0, hasClips = false, opening = false;
    function controls() {
        select.disabled = refresh.disabled = busy;
        up.disabled = busy || !folder;
        open.disabled = busy || !hasClips;
        for (const item of list.querySelectorAll('button')) item.disabled = busy;
        button.disabled = busy;
    }
    async function run(fn, message) {
        if (busy) return;
        const current = ++generation;
        busy = true; controls(); status.textContent = message;
        try { await fn(() => current === generation && dialog.open); }
        catch (error) { if (current === generation) status.textContent = error.message; }
        finally { busy = false; controls(); }
    }
    async function browse(active) {
        hasClips = false; list.replaceChildren();
        location.textContent = `${select.value}:${folder}`;
        const entries = await api.rcloneList(select.value, folder);
        if (!active()) return;
        for (const entry of entries) {
            if (entry.isDirectory) {
                const item = document.createElement('button'); item.textContent = `Folder: ${entry.name}`;
                item.onclick = () => { folder = folder ? `${folder}/${entry.name}` : entry.name; run(browse, 'Reading folder…'); };
                list.append(item);
            } else if (entry.playable) {
                hasClips = true;
                const item = document.createElement('div');
                item.textContent = `${entry.name} (${(entry.size / 1024 ** 2).toFixed(1)} MiB)`; list.append(item);
            }
        }
        status.textContent = hasClips ? 'Ready to download the recordings in this folder.' : 'Choose a subfolder containing TeslaCam recordings.';
    }
    async function load(active) {
        hasClips = false; list.replaceChildren(); select.replaceChildren(); location.textContent = '';
        const remotes = await api.rcloneRemotes();
        if (!active()) return;
        for (const remote of remotes) { const option = document.createElement('option'); option.value = option.textContent = remote; select.append(option); }
        folder = '';
        if (!remotes.length) { status.textContent = 'No supported remotes found. Configure rclone on this computer first, then reload.'; return; }
        await browse(active);
    }
    button.onclick = () => { dialog.showModal(); run(load, 'Finding configured remotes…'); };
    refresh.onclick = () => run(load, 'Finding configured remotes…');
    select.onchange = () => { folder = ''; run(browse, 'Reading folder…'); };
    up.onclick = () => { folder = folder.split('/').slice(0, -1).join('/'); run(browse, 'Reading folder…'); };
    open.onclick = () => run(async active => {
        const result = await api.rcloneOpen(select.value, folder);
        if (!active()) return;
        snapshotRoots.add(result.directory.replace(/\\/g, '/'));
        opening = true; close.disabled = true;
        status.textContent = 'Preparing local playback…';
        try { await onOpen(result); if (active()) dialog.close(); }
        finally { opening = false; close.disabled = false; }
    }, 'Downloading recordings… Playback/export starts after download. You can cancel.');
    function cancel() { if (opening) return; ++generation; dialog.close(); api.rcloneCancel().catch(() => {}); }
    close.onclick = cancel;
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    controls();
}

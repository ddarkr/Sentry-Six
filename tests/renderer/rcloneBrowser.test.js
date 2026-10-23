const fs = require('fs');
const vm = require('vm');
const path = require('path');
class Element {
  constructor(tag, document) {
    this.tag = tag; this.ownerDocument = document; this.children = []; this.style = {}; this.listeners = {};
    this.value = ''; this.textContent = ''; this.attributes = {}; this.dataset = {}; this.hidden = false;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  append(...items) {
    this.children.push(...items);
    if (this.tag === 'select' && !this.value) this.value = items[0]?.value || '';
  }
  appendChild(item) { this.append(item); return item; }
  replaceChildren(...items) { this.children = []; if (this.tag === 'select') this.value = ''; this.append(...items); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.tag === selector || (selector[0] === '#' && child.id === selector.slice(1)) ||
        (selector === '[data-folder-name]' && child.dataset.folderName !== undefined) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; this.previousFocus = this.ownerDocument.activeElement; this.focus(); }
  close() {
    this.open = false; this.previousFocus?.focus();
    this.listeners.close?.({});
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const document = { activeElement: null };
  document.createElement = tag => new Element(tag, document);
  document.createElementNS = (namespace, tag) => document.createElement(tag);
  document.body = document.createElement('body');
  document.getElementById = id => document.body.querySelector(`#${id}`);
  const button = document.createElement('button'); button.id = 'rcloneOpenButton'; button.hidden = true;
  document.body.append(button);
  const api = {
    rcloneRemotes: jest.fn(async () => ({ ok: true, data: ['fixture'] })),
    rcloneList: jest.fn(async () => ({ ok: true, data: [{ name: '2026-10-09_12-30-00-front.mp4', size: 4, playable: true }] })),
    rcloneOpen: jest.fn(),
    rcloneOpenDriveData: jest.fn(async () => ({ ok: true, data: { path: 'managed-drive-url', size: 100 } })),
    rcloneCancel: jest.fn(async () => ({ ok: true, data: null }))
  };
  const translationsContext = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/data/translations.js'), 'utf8').replace('export const translations =', 'globalThis.translations ='), translationsContext);
  const t = (key, params = {}) => {
    const value = key.split('.').reduce((node, part) => node?.[part], translationsContext.translations.en) ?? key;
    return typeof value === 'string' ? value.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) : key;
  };
  const openSettingsModal = jest.fn();
  const registerRcloneBrowserOpener = jest.fn();
  const loadDriveData = jest.fn(async () => ({ success: true }));
  const context = vm.createContext({
    document,
    window: { electronAPI: api, _loadSentryUsbData: loadDriveData },
    Set,
    URL,
    Map,
    t,
    onLanguageChange: jest.fn(),
    openSettingsModal,
    registerRcloneBrowserOpener,
    CSS: { escape: s => s },
    console
  });

  const settingsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/features/rcloneSettings.js'), 'utf8')
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replaceAll('export function ', 'function ')
    .replaceAll('export async function ', 'async function ');
  vm.runInContext(settingsSource, context);
  context.unwrap = context.unwrapRcloneResponse;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/lib/utils.js'), 'utf8')
    .replaceAll('export function ', 'function '), context);

  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/features/rcloneBrowser.js'), 'utf8')
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replaceAll('export function ', 'function ');
  vm.runInContext(source, context);
  const onOpen = jest.fn(async () => {}); context.initRcloneBrowser(onOpen);
  const ids = {
    dialog: 'rcloneDialog', select: 'rcloneRemote', refresh: 'rcloneRefresh', manage: 'rcloneManage',
    up: 'rcloneUp', location: 'rcloneLocation', status: 'rcloneStatus', authAction: 'rcloneAuthAction',
    list: 'rcloneList', open: 'rcloneDownload', close: 'rcloneClose', details: 'rcloneErrorDetails'
  };
  return { context, document, api, button, loadDriveData, openSettingsModal, registerRcloneBrowserOpener, ...Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, document.getElementById(id)])), onOpen };
}
test('browses and hands the stream manifest to playback exactly once', async () => {
  const ui = setup();
  const directory = `http://127.0.0.1:12345/sentry-rclone/${'a'.repeat(64)}`;
  const manifest = { directory, source: { remote: 'fixture', folder: 'RecentClips' },
    files: [{ name: '2026-10-09_12-30-00-front.mp4', path: `${directory}/2026-10-09_12-30-00-front.mp4`, size: 4 }] };
  ui.api.rcloneOpen.mockResolvedValue({ ok: true, data: manifest });
  ui.button.onclick(); await flush(); expect(ui.open.disabled).toBe(false);
  ui.open.onclick(); ui.open.onclick(); await flush();
  expect(ui.api.rcloneOpen).toHaveBeenCalledTimes(1); expect(ui.onOpen).toHaveBeenCalledTimes(1); expect(ui.dialog.open).toBe(false);
  expect(ui.onOpen).toHaveBeenCalledWith(manifest);
  expect(ui.context.isReadOnlyRclonePath(directory)).toBe(true);
  expect(ui.context.isReadOnlyRclonePath(manifest.files[0].path)).toBe(true);
  expect(ui.context.filePathToUrl(manifest.files[0].path)).toBe(manifest.files[0].path);
  expect(ui.context.isReadOnlyRclonePath(null)).toBe(false);
  expect(ui.context.isReadOnlyRclonePath('/tmp/local')).toBe(false);
});
test('accepts only exact managed loopback URLs and preserves local escaping', () => {
  const { context } = setup();
  const root = `http://127.0.0.1:12345/sentry-rclone/${'a'.repeat(64)}`;
  for (const path of [`${root}/clip.mp4?x=1`, `${root}/%2Fsecret`, `${root}/..`, `${root}/.`, `${root}/%2e%2e`, `${root}/bad%zz`,
    `${root}/clip.mp4#fragment`, `${root}/%5Csecret`, `${root}/%00secret`,
    root.replace('127.0.0.1', 'localhost') + '/clip.mp4', root.replace(':12345', ':99999') + '/clip.mp4']) {
    expect(context.isRcloneStreamUrl(path)).toBe(false);
  }
  expect(context.filePathToUrl('/tmp/a #?.mp4')).toBe('file:///tmp/a%20%23%3F.mp4');
});
test('failed playback handoff cancels its stream and leaves retry available', async () => {
  const ui = setup();
  ui.api.rcloneOpen.mockResolvedValue({ ok: true, data: { directory: 'unused' } });
  ui.onOpen.mockRejectedValueOnce(new Error('Unable to open recording'));
  ui.button.onclick(); await flush(); ui.open.onclick(); await flush();
  expect(ui.api.rcloneCancel).toHaveBeenCalledTimes(1);
  expect(ui.api.rcloneCancel).toHaveBeenCalledWith(true);
  expect(ui.dialog.open).toBe(true);
  expect(ui.open.disabled).toBe(false);
});
test('dismissing an idle picker does not revoke the playing library stream', async () => {
  const ui = setup();
  ui.button.onclick(); await flush(); ui.close.onclick(); await flush();
  expect(ui.dialog.open).toBe(false);
  expect(ui.api.rcloneCancel).not.toHaveBeenCalled();
});
test('cancel prevents a late download from replacing current library', async () => {
  const ui = setup(); let resolve; ui.api.rcloneOpen.mockReturnValue(new Promise(r => { resolve = r; }));
  ui.button.onclick(); await flush(); ui.open.onclick(); ui.close.onclick();
  resolve({ ok: true, data: { directory: '/tmp/cache/snapshot' } }); await flush();
  expect(ui.onOpen).not.toHaveBeenCalled(); expect(ui.dialog.open).toBe(false); expect(ui.api.rcloneCancel).toHaveBeenCalledTimes(1);
  expect(ui.api.rcloneCancel).toHaveBeenCalledWith();
  expect(ui.button.disabled).toBe(false);
});
test('picker cancellation preserves playback but failed source integration releases it', async () => {
  const ui = setup();
  let playingStream = 'current';
  ui.api.rcloneCancel.mockImplementation(async (release = false) => {
    if (release) playingStream = null;
    return { ok: true, data: null };
  });
  ui.button.onclick(); await flush(); ui.close.onclick(); await flush();
  expect(playingStream).toBe('current');

  let resolveOpen;
  ui.api.rcloneOpen.mockReturnValueOnce(new Promise(resolve => { resolveOpen = resolve; }));
  ui.button.onclick(); await flush(); ui.open.onclick(); ui.close.onclick();
  resolveOpen({ ok: false, error: { code: 'CANCELLED', message: 'Cancelled' } });
  await flush();
  expect(ui.api.rcloneCancel).toHaveBeenLastCalledWith();
  expect(playingStream).toBe('current');
  expect(ui.onOpen).not.toHaveBeenCalled();

  ui.api.rcloneOpen.mockImplementationOnce(async () => {
    playingStream = 'replacement';
    return { ok: true, data: { directory: 'unused' } };
  });
  ui.onOpen.mockRejectedValueOnce(new Error('Unable to open recording'));
  ui.button.onclick(); await flush(); ui.open.onclick(); await flush();
  expect(ui.api.rcloneCancel).toHaveBeenLastCalledWith(true);
  expect(playingStream).toBeNull();
});
test('late directory listing after Escape stays dismissed and retry works', async () => {
  const ui = setup(); let resolve; ui.api.rcloneList.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  ui.button.onclick(); await flush(); ui.dialog.listeners.cancel({ preventDefault() {} });
  resolve({ ok: true, data: [{ name: '<img src=x onerror=bad>', folder: 'ref-escape', isDirectory: true }] }); await flush();
  expect(ui.list.children).toHaveLength(0); expect(ui.dialog.open).toBe(false);
  ui.button.onclick(); await flush(); expect(ui.dialog.open).toBe(true); expect(ui.open.disabled).toBe(false);
});

test.each(['rcloneRemotes', 'rcloneList'])('cancelling %s blocks reopen until cancellation finishes', async method => {
  const ui = setup();
  let finishListing, finishCancel;
  ui.api[method].mockReturnValueOnce(new Promise(resolve => { finishListing = resolve; }));
  ui.api.rcloneCancel.mockReturnValueOnce(new Promise(resolve => { finishCancel = resolve; }));
  ui.button.onclick(); await flush();
  const cancelled = ui.close.onclick();
  expect(ui.dialog.open).toBe(false);
  expect(ui.button.disabled).toBe(true);
  expect(ui.api.rcloneCancel).toHaveBeenCalledWith();
  ui.button.onclick();
  expect(ui.dialog.open).toBe(false);
  await ui.close.onclick(); // A second dismissal must not unlock the pending cancellation.
  expect(ui.button.disabled).toBe(true);
  finishListing({ ok: false, error: { code: 'CANCELLED', message: 'Cancelled' } });
  await flush();
  expect(ui.button.disabled).toBe(true);
  finishCancel({ ok: true, data: null });
  await cancelled;
  expect(ui.button.disabled).toBe(false);
  expect(ui.document.activeElement).toBe(ui.button);
  ui.button.onclick(); await flush();
  expect(ui.dialog.open).toBe(true);
  expect(ui.open.disabled).toBe(false);
  expect(ui.details.hidden).toBe(true);
});
test('failure is shown and leaves retry available; dialog isolates global shortcuts', async () => {
  const ui = setup(); ui.api.rcloneRemotes.mockResolvedValueOnce({ ok: false, error: { code: 'NOT_INSTALLED', message: 'rclone not found' } });
  ui.button.onclick(); await flush(); expect(ui.status.textContent).not.toBe(''); expect(ui.refresh.disabled).toBe(false); expect(ui.open.disabled).toBe(true);
  const event = { stopPropagation: jest.fn() }; ui.dialog.listeners.keydown(event); ui.dialog.listeners.mousedown(event); expect(event.stopPropagation).toHaveBeenCalledTimes(2);
});
test('remote and folder names remain literal text and retain their navigation value', async () => {
  const ui = setup();
  const remote = '<img src=x onerror=bad>';
  const folder = '<script>bad()</script>';
  const folderRef = 'ref-opaque-folder';
  ui.api.rcloneRemotes.mockResolvedValue({ ok: true, data: [remote] });
  ui.api.rcloneList.mockResolvedValueOnce({ ok: true, data: [{ name: folder, folder: folderRef, isDirectory: true }] });
  ui.button.onclick(); await flush();
  expect(ui.select.children[0].textContent).toBe(remote);
  expect(ui.select.children[0].value).toBe(remote);
  const folderButton = ui.list.querySelectorAll('button')[0];
  const text = element => element.textContent + element.children.map(text).join('');
  expect(text(folderButton)).toContain(folder);
  folderButton.onclick(); await flush();
  expect(ui.api.rcloneList).toHaveBeenLastCalledWith(remote, folderRef);
});
test('connection management button closes native dialog before opening settings', async () => {
  const ui = setup();
  ui.button.onclick(); await flush();
  expect(ui.dialog.open).toBe(true);
  expect(ui.manage).not.toBeNull();
  ui.manage.onclick(); await flush();
  expect(ui.dialog.open).toBe(false);
  expect(ui.openSettingsModal).toHaveBeenCalledWith('storage', 'fixture', expect.objectContaining({ reconnect: false }));
});
test('auth required failure shows reconnect button which closes dialog and opens settings to reconnect', async () => {
  const ui = setup();
  ui.api.rcloneList.mockResolvedValueOnce({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Token expired' } });
  ui.button.onclick(); await flush();
  expect(ui.authAction.hidden).toBe(false);
  ui.authAction.onclick(); await flush();
  expect(ui.dialog.open).toBe(false);
  expect(ui.openSettingsModal).toHaveBeenCalledWith('storage', 'fixture', expect.objectContaining({ reconnect: true }));
});
test('returning from settings selects freshly configured remote and retains navigation', async () => {
  const ui = setup();
  ui.button.onclick(); await flush();
  ui.manage.onclick(); await flush();
  const options = ui.openSettingsModal.mock.calls[0][2];
  expect(options?.onReturn).toBeDefined();

  ui.api.rcloneRemotes.mockResolvedValueOnce({ ok: true, data: ['fixture', 'gdrive-fresh'] });
  ui.api.rcloneList.mockResolvedValueOnce({ ok: true, data: [{ name: 'clip.mp4', size: 10, playable: true }] });

  options.onReturn('gdrive-fresh');
  await flush();
  expect(ui.dialog.open).toBe(true);
  expect(ui.select.value).toBe('gdrive-fresh');
  expect(ui.api.rcloneList).toHaveBeenCalledWith('gdrive-fresh', '');
});

test('navigates folder hierarchy using opaque references and pops on parent', async () => {
  const ui = setup();
  ui.api.rcloneRemotes.mockResolvedValue({ ok: true, data: ['drive'] });
  ui.api.rcloneList.mockResolvedValueOnce({
    ok: true,
    data: [{ name: 'TeslaCam', folder: 'ref-fld-123', isDirectory: true }]
  });
  ui.button.onclick(); await flush();

  expect(ui.up.disabled).toBe(true);
  expect(ui.location.textContent).toBe('drive:/');

  const folderBtn = ui.list.querySelectorAll('button')[0];
  ui.api.rcloneList.mockResolvedValueOnce({
    ok: true,
    data: [{ name: '2026-10-10_front.mp4', size: 1024 * 1024 * 2, playable: true }]
  });

  folderBtn.onclick(); await flush();

  expect(ui.api.rcloneList).toHaveBeenLastCalledWith('drive', 'ref-fld-123');
  expect(ui.up.disabled).toBe(false);
  expect(ui.location.textContent).toBe('drive:/TeslaCam');

  ui.api.rcloneList.mockResolvedValueOnce({
    ok: true,
    data: [{ name: 'TeslaCam', folder: 'ref-fld-123', isDirectory: true }]
  });
  ui.up.onclick(); await flush();

  expect(ui.api.rcloneList).toHaveBeenLastCalledWith('drive', '');
  expect(ui.up.disabled).toBe(true);
  expect(ui.location.textContent).toBe('drive:/');
});

test('distinguishes same-name directory rows using entry.id suffix in label and navigates with opaque ref', async () => {
  const ui = setup();
  ui.api.rcloneRemotes.mockResolvedValue({ ok: true, data: ['fixture'] });
  ui.api.rcloneList.mockResolvedValueOnce({
    ok: true,
    data: [
      { name: 'TeslaCam', folder: 'ref-fld-1', id: '111111222222', isDirectory: true },
      { name: 'TeslaCam', folder: 'ref-fld-2', id: '333333444444', isDirectory: true }
    ]
  });
  ui.button.onclick(); await flush();

  const buttons = ui.list.querySelectorAll('button');
  expect(buttons.length).toBe(2);

  const text = el => el.textContent + el.children.map(text).join('');
  expect(text(buttons[0])).toContain('222222');
  expect(text(buttons[1])).toContain('444444');
  expect(buttons[0].attributes['aria-label']).toContain('222222');
  expect(buttons[1].attributes['aria-label']).toContain('444444');

  ui.api.rcloneList.mockResolvedValueOnce({
    ok: true,
    data: [{ name: 'clip.mp4', size: 1000, playable: true }]
  });
  buttons[1].onclick(); await flush();

  expect(ui.api.rcloneList).toHaveBeenLastCalledWith('fixture', 'ref-fld-2');
  expect(ui.location.textContent).toBe('fixture:/TeslaCam');
  expect(ui.location.textContent).not.toContain('ref-fld-2');
});

test('rate limit error shows directly in picker status without reconnect CTA or details', async () => {
  const ui = setup();
  ui.api.rcloneRemotes.mockResolvedValue({ ok: true, data: ['fixture'] });
  ui.api.rcloneList.mockResolvedValueOnce({
    ok: false,
    error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded' }
  });

  ui.button.onclick(); await flush();

  expect(ui.status.dataset.state).toBe('error');
  expect(ui.status.textContent).not.toBe('');
  expect(ui.authAction.hidden).toBe(true);
  expect(ui.details.hidden).toBe(true);
});

test('remote change resets root navigation', async () => {
  const ui = setup();
  ui.api.rcloneRemotes.mockResolvedValue({ ok: true, data: ['drive-a', 'drive-b'] });
  ui.api.rcloneList.mockResolvedValueOnce({
    ok: true,
    data: [{ name: 'Sub', folder: 'ref-sub', isDirectory: true }]
  });
  ui.button.onclick(); await flush();

  ui.api.rcloneList.mockResolvedValueOnce({
    ok: true,
    data: [{ name: 'clip.mp4', size: 1000, playable: true }]
  });
  const subBtn = ui.list.querySelectorAll('button')[0];
  subBtn.onclick(); await flush();
  expect(ui.up.disabled).toBe(false);

  ui.select.value = 'drive-b';
  ui.api.rcloneList.mockResolvedValueOnce({
    ok: true,
    data: []
  });
  ui.select.onchange();
  await flush();

  expect(ui.api.rcloneList).toHaveBeenLastCalledWith('drive-b', '');
  expect(ui.up.disabled).toBe(true);
});

test('drive picker lists only drive-data.json and loads it without replacing playback', async () => {
  const ui = setup();
  ui.api.rcloneList.mockResolvedValue({ ok: true, data: [
    { name: 'clip.mp4', playable: true }, { name: 'other.json' },
    { name: 'DRIVE-DATA.JSON', size: 100 }, { name: 'Trips', isDirectory: true, folder: 'trips-ref' }
  ] });
  ui.context.openRcloneDriveDataBrowser(); await flush();
  expect(ui.list.children).toHaveLength(2);
  expect(ui.open.disabled).toBe(false);
  ui.open.onclick(); await flush();
  expect(ui.api.rcloneOpenDriveData).toHaveBeenCalledWith('fixture', '');
  expect(ui.loadDriveData).toHaveBeenCalledWith('managed-drive-url');
  expect(ui.api.rcloneOpen).not.toHaveBeenCalled();
  expect(ui.onOpen).not.toHaveBeenCalled();
  expect(ui.dialog.open).toBe(false);
});

test('drive picker requires drive-data.json, including when recordings exist', async () => {
  const ui = setup();
  ui.context.openRcloneDriveDataBrowser(); await flush();
  expect(ui.list.children).toHaveLength(0);
  expect(ui.open.disabled).toBe(true);
});

test('failed drive parse reports error and allows retry without revoking video', async () => {
  const ui = setup();
  ui.api.rcloneList.mockResolvedValue({ ok: true, data: [{ name: 'drive-data.json', size: 100 }] });
  ui.loadDriveData.mockResolvedValueOnce({ success: false, error: 'Invalid JSON' });
  ui.context.openRcloneDriveDataBrowser(); await flush(); ui.open.onclick(); await flush();
  expect(ui.dialog.open).toBe(true);
  expect(ui.details.hidden).toBe(false);
  expect(ui.open.disabled).toBe(false);
  expect(ui.api.rcloneCancel).toHaveBeenCalledWith();
  expect(ui.api.rcloneCancel).not.toHaveBeenCalledWith(true);
  ui.open.onclick(); await flush();
  expect(ui.dialog.open).toBe(false);
  expect(ui.loadDriveData).toHaveBeenCalledTimes(2);
});

test('cancelling drive parse closes its stream and stale completion leaves retry untouched', async () => {
  const ui = setup(); let finish;
  ui.api.rcloneList.mockResolvedValue({ ok: true, data: [{ name: 'drive-data.json', size: 100 }] });
  ui.loadDriveData.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  ui.context.openRcloneDriveDataBrowser(); await flush(); ui.open.onclick(); await flush();
  expect(ui.close.disabled).toBe(false);
  ui.close.onclick(); await flush();
  expect(ui.dialog.open).toBe(false);
  expect(ui.api.rcloneCancel).toHaveBeenCalledWith();
  ui.context.openRcloneDriveDataBrowser(); await flush();
  finish({ success: false, error: 'Cancelled' }); await flush();
  expect(ui.dialog.open).toBe(true);
  expect(ui.details.hidden).toBe(true);
  expect(ui.open.disabled).toBe(false);
  expect(ui.api.rcloneCancel).toHaveBeenCalledTimes(1);
  ui.open.onclick(); await flush();
  expect(ui.dialog.open).toBe(false);
  expect(ui.onOpen).not.toHaveBeenCalled();
});

test('drive mode survives connection settings and resets for recordings entry', async () => {
  const ui = setup();
  ui.api.rcloneList.mockResolvedValue({ ok: true, data: [{ name: 'drive-data.json', size: 100 }] });
  ui.registerRcloneBrowserOpener.mock.calls[0][0](null, true); await flush();
  ui.manage.onclick(); await flush();
  ui.openSettingsModal.mock.calls[0][2].onReturn('fixture'); await flush();
  expect(ui.open.disabled).toBe(false);
  ui.open.onclick(); await flush();
  expect(ui.loadDriveData).toHaveBeenCalledTimes(1);
  ui.button.onclick(); await flush();
  expect(ui.open.disabled).toBe(true);
});

test('cancelling drive source open never starts its late parse or releases video', async () => {
  const ui = setup(); let finish;
  ui.api.rcloneList.mockResolvedValue({ ok: true, data: [{ name: 'drive-data.json', size: 100 }] });
  ui.api.rcloneOpenDriveData.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  ui.context.openRcloneDriveDataBrowser(); await flush(); ui.open.onclick();
  ui.dialog.listeners.cancel({ preventDefault() {} });
  finish({ ok: true, data: { path: 'expired-drive-url' } }); await flush();
  expect(ui.loadDriveData).not.toHaveBeenCalled();
  expect(ui.api.rcloneCancel).toHaveBeenCalledWith();
  expect(ui.dialog.open).toBe(false);
  ui.context.openRcloneDriveDataBrowser(); await flush(); ui.open.onclick(); await flush();
  expect(ui.loadDriveData).toHaveBeenCalledWith('managed-drive-url');
  expect(ui.onOpen).not.toHaveBeenCalled();
});

test('a directory named drive-data.json remains navigable and cannot be loaded as a file', async () => {
  const ui = setup();
  ui.api.rcloneList.mockResolvedValueOnce({ ok: true, data: [
    { name: 'drive-data.json', isDirectory: true, folder: 'drive-directory-ref' }
  ] }).mockResolvedValueOnce({ ok: true, data: [{ name: 'drive-data.json', size: 100 }] });
  ui.context.openRcloneDriveDataBrowser(); await flush();
  expect(ui.open.disabled).toBe(true);
  const folder = ui.list.querySelectorAll('button')[0];
  expect(folder).toBeDefined();
  folder.onclick(); await flush();
  expect(ui.api.rcloneList).toHaveBeenLastCalledWith('fixture', 'drive-directory-ref');
  expect(ui.open.disabled).toBe(false);
  ui.open.onclick(); await flush();
  expect(ui.api.rcloneOpenDriveData).toHaveBeenCalledWith('fixture', 'drive-directory-ref');
});

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
  const context = vm.createContext({
    document,
    window: { electronAPI: api },
    Set,
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
  return { context, document, api, button, openSettingsModal, registerRcloneBrowserOpener, ...Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, document.getElementById(id)])), onOpen };
}
test('browses and hands complete snapshot to local playback exactly once', async () => {
  const ui = setup(); ui.api.rcloneOpen.mockResolvedValue({ ok: true, data: { directory: '/tmp/cache/snapshot', source: { remote: 'fixture', folder: '' } } });
  ui.button.onclick(); await flush(); expect(ui.open.disabled).toBe(false);
  ui.open.onclick(); ui.open.onclick(); await flush();
  expect(ui.api.rcloneOpen).toHaveBeenCalledTimes(1); expect(ui.onOpen).toHaveBeenCalledTimes(1); expect(ui.dialog.open).toBe(false);
  expect(ui.context.isReadOnlyRclonePath('/tmp/cache/snapshot/SentryClips/event')).toBe(true);
  expect(ui.context.isReadOnlyRclonePath('/tmp/cache/snapshot')).toBe(true);
  expect(ui.context.isReadOnlyRclonePath('\\tmp\\cache\\snapshot\\event')).toBe(true);
  expect(ui.context.isReadOnlyRclonePath(null)).toBe(false);
  expect(ui.context.isReadOnlyRclonePath('/tmp/cache/snapshot-other')).toBe(false);
});
test('cancel prevents a late download from replacing current library', async () => {
  const ui = setup(); let resolve; ui.api.rcloneOpen.mockReturnValue(new Promise(r => { resolve = r; }));
  ui.button.onclick(); await flush(); ui.open.onclick(); ui.close.onclick();
  resolve({ ok: true, data: { directory: '/tmp/cache/snapshot' } }); await flush();
  expect(ui.onOpen).not.toHaveBeenCalled(); expect(ui.dialog.open).toBe(false); expect(ui.api.rcloneCancel).toHaveBeenCalledTimes(1);
  expect(ui.button.disabled).toBe(false);
});
test('late directory listing after Escape stays dismissed and retry works', async () => {
  const ui = setup(); let resolve; ui.api.rcloneList.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  ui.button.onclick(); await flush(); ui.dialog.listeners.cancel({ preventDefault() {} });
  resolve({ ok: true, data: [{ name: '<img src=x onerror=bad>', folder: 'ref-escape', isDirectory: true }] }); await flush();
  expect(ui.list.children).toHaveLength(0); expect(ui.dialog.open).toBe(false);
  ui.button.onclick(); await flush(); expect(ui.dialog.open).toBe(true); expect(ui.open.disabled).toBe(false);
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

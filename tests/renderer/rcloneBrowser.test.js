const fs = require('fs');
const vm = require('vm');
const path = require('path');
class Element {
  constructor(tag, document) {
    this.tag = tag; this.ownerDocument = document; this.children = []; this.listeners = {};
    this.dataset = {}; this.attributes = {}; this.hidden = false; this.textContent = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, handler) { this.listeners[key] = handler; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.tag === selector || selector === `#${child.id}` ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) return this.onclick?.(); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const ok = data => ({ ok: true, data });
function setup() {
  const document = { activeElement: null };
  document.createElement = tag => new Element(tag, document);
  document.body = document.createElement('body');
  document.getElementById = id => document.body.querySelector(`#${id}`);
  for (const [tag, id] of [['button', 'rcloneOpenButton'], ['section', 'rcloneTreePanel'], ['button', 'drivesTabBtn']]) {
    const element = document.createElement(tag); element.id = id; element.hidden = id !== 'drivesTabBtn'; document.body.append(element);
  }
  const api = {
    rcloneRemotes: jest.fn(async () => ok(['fixture'])),
    rcloneList: jest.fn(async () => ok([{ name: 'clip.mp4', playable: true }])),
    rcloneOpen: jest.fn(async () => ok({ directory: 'managed-stream' })),
    rcloneOpenDriveData: jest.fn(async () => ok({ path: 'managed-drive-url' })),
    rcloneCancel: jest.fn(async () => ok(null))
  };
  const onOpen = jest.fn(async () => {});
  const loadDriveData = jest.fn(async () => ({ success: true }));
  const openSettingsModal = jest.fn(), registerRcloneBrowserOpener = jest.fn();
  const drives = document.getElementById('drivesTabBtn'); drives.onclick = jest.fn();
  const context = vm.createContext({
    document, window: { electronAPI: api, _loadSentryUsbData: loadDriveData },
    t: key => key, onLanguageChange: jest.fn(), openSettingsModal, registerRcloneBrowserOpener,
    isRcloneStreamUrl: value => typeof value === 'string' && value.startsWith('http://127.0.0.1:'),
    unwrap: async promise => { const result = await promise; if (!result.ok) throw result.error; return result.data; },
    getRcloneErrorMessage: error => error.message || error.code
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/features/rcloneBrowser.js'), 'utf8')
    .replace(/^import .*;$/gm, '').replaceAll('export function ', 'function '), context);
  context.initRcloneBrowser(onOpen);
  const get = id => document.getElementById(id);
  return { api, onOpen, loadDriveData, openSettingsModal, registerRcloneBrowserOpener, drives,
    button: get('rcloneOpenButton'), panel: get('rcloneTreePanel'), list: get('rcloneList'),
    close: get('rcloneClose'), refresh: get('rcloneRefresh'), manage: get('rcloneManage'),
    reconnect: get('rcloneAuthAction'), status: get('rcloneStatus') };
}
async function openRoot(ui) {
  ui.button.click(); await flush();
  const root = ui.list.children[0]; root.children[0].children[0].click(); await flush();
  return root;
}
test('configured roots load lazily and preserve ancestors and cached branches', async () => {
  const ui = setup();
  ui.api.rcloneList.mockResolvedValueOnce(ok([{ name: 'TeslaCam', folder: 'opaque-folder', isDirectory: true }]));
  ui.button.click(); await flush(); expect(ui.api.rcloneList).not.toHaveBeenCalled();
  const root = ui.list.children[0], rootToggle = root.children[0].children[0];
  rootToggle.click(); await flush();
  const folder = root.children[1].children[0]; folder.children[0].children[0].click(); await flush();
  expect(ui.api.rcloneList).toHaveBeenLastCalledWith('fixture', 'opaque-folder');
  expect(ui.list.children[0]).toBe(root); expect(root.children[1].children[0]).toBe(folder);
  rootToggle.click(); await flush(); expect(root.children[1].hidden).toBe(true);
  rootToggle.click(); await flush(); expect(root.children[1].hidden).toBe(false);
  expect(ui.api.rcloneList).toHaveBeenCalledTimes(2);
});
test('file activation passes selected filename and folder play passes the whole manifest once', async () => {
  const ui = setup(); const root = await openRoot(ui);
  root.children[1].children[0].children[0].click(); await flush();
  expect(ui.onOpen).toHaveBeenCalledWith({ directory: 'managed-stream', selectedFile: 'clip.mp4' });
  expect(ui.panel.hidden).toBe(false);
  const play = root.children[0].children[1]; play.click(); play.click(); await flush();
  expect(ui.api.rcloneOpen).toHaveBeenCalledTimes(2);
  expect(ui.onOpen).toHaveBeenLastCalledWith({ directory: 'managed-stream' });
});
test('duplicate names retain distinct opaque references and literal names', async () => {
  const ui = setup();
  ui.api.rcloneList.mockResolvedValueOnce(ok([
    { name: '<TeslaCam>', id: 'id-111111', folder: 'ref-one', isDirectory: true },
    { name: '<TeslaCam>', id: 'id-222222', folder: 'ref-two', isDirectory: true }
  ]));
  const root = await openRoot(ui); const children = root.children[1].children;
  const first = children[0].children[0].children[0], second = children[1].children[0].children[0];
  expect(first.textContent).toContain('<TeslaCam>'); expect(first.textContent).not.toBe(second.textContent);
  first.click(); await flush(); second.click(); await flush();
  expect(ui.api.rcloneList).toHaveBeenCalledWith('fixture', 'ref-one');
  expect(ui.api.rcloneList).toHaveBeenCalledWith('fixture', 'ref-two');
});
test('drive-data.json directories expand; JSON files load and activate Drives', async () => {
  const ui = setup();
  ui.api.rcloneList.mockResolvedValueOnce(ok([{ name: 'drive-data.json', folder: 'json-directory', isDirectory: true }]));
  ui.api.rcloneList.mockResolvedValueOnce(ok([{ name: 'drive-data.json', isDirectory: false }]));
  const root = await openRoot(ui); const directory = root.children[1].children[0];
  directory.children[0].children[0].click(); await flush();
  expect(ui.api.rcloneOpenDriveData).not.toHaveBeenCalled();
  directory.children[1].children[0].children[0].click(); await flush();
  expect(ui.api.rcloneOpenDriveData).toHaveBeenCalledWith('fixture', 'json-directory');
  expect(ui.loadDriveData).toHaveBeenCalledWith('managed-drive-url'); expect(ui.drives.onclick).toHaveBeenCalledTimes(1);
});
test('idle cloud toggle preserves playback and reuses the same tree', async () => {
  const ui = setup(); const root = await openRoot(ui);
  ui.button.click(); await flush(); expect(ui.panel.hidden).toBe(true);
  expect(ui.api.rcloneCancel).not.toHaveBeenCalled();
  ui.button.click(); await flush(); expect(ui.list.children[0]).toBe(root);
});
test('cancel ignores late activation and blocks reopen until cancellation settles', async () => {
  const ui = setup(); const root = await openRoot(ui); let finishOpen, finishCancel;
  ui.api.rcloneOpen.mockReturnValueOnce(new Promise(resolve => { finishOpen = resolve; }));
  ui.api.rcloneCancel.mockReturnValueOnce(new Promise(resolve => { finishCancel = resolve; }));
  root.children[0].children[1].click(); const cancellation = ui.close.click();
  expect(ui.panel.hidden).toBe(true); expect(ui.button.disabled).toBe(true);
  finishOpen(ok({ directory: 'late' })); await flush(); expect(ui.onOpen).not.toHaveBeenCalled();
  ui.button.click(); expect(ui.panel.hidden).toBe(true);
  finishCancel(ok(null)); await cancellation; expect(ui.button.disabled).toBe(false);
  expect(ui.api.rcloneCancel).toHaveBeenCalledWith();
});
test('cancel ignores late lazy listing and the branch can retry', async () => {
  const ui = setup(); let finish;
  ui.api.rcloneList.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  ui.button.click(); await flush(); const root = ui.list.children[0];
  root.children[0].children[0].click(); await ui.close.click();
  finish(ok([{ name: 'late', folder: 'late', isDirectory: true }])); await flush();
  expect(root.children[1].children).toHaveLength(0);
  ui.button.click(); root.children[0].children[0].click(); await flush();
  expect(root.children[1].children).toHaveLength(1);
});
test('failed playback handoff releases failed stream but keeps retry available', async () => {
  const ui = setup(); const root = await openRoot(ui);
  ui.onOpen.mockRejectedValueOnce(new Error('Cannot integrate'));
  root.children[0].children[1].click(); await flush();
  expect(ui.api.rcloneCancel).toHaveBeenCalledWith(true);
  expect(ui.status.dataset.state).toBe('error'); expect(ui.refresh.disabled).toBe(false);
});
test('auth errors expose reconnect and settings return refreshes configured roots', async () => {
  const ui = setup();
  ui.api.rcloneList.mockResolvedValueOnce({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Expired' } });
  await openRoot(ui); expect(ui.reconnect.hidden).toBe(false);
  ui.reconnect.click(); expect(ui.panel.hidden).toBe(true);
  expect(ui.openSettingsModal).toHaveBeenCalledWith('storage', 'fixture', expect.objectContaining({ reconnect: true }));
  ui.api.rcloneRemotes.mockResolvedValueOnce(ok(['new-remote']));
  ui.openSettingsModal.mock.calls[0][2].onReturn('new-remote'); await flush();
  expect(ui.api.rcloneList).toHaveBeenLastCalledWith('new-remote', ''); expect(ui.panel.hidden).toBe(false);
});
test('empty remotes and errors retain connection management and refresh', async () => {
  const ui = setup(); ui.api.rcloneRemotes.mockResolvedValueOnce(ok([]));
  ui.button.click(); await flush(); expect(ui.list.children).toHaveLength(0); expect(ui.manage.disabled).toBe(false);
  ui.api.rcloneRemotes.mockRejectedValueOnce(new Error('Unavailable'));
  ui.refresh.click(); await flush(); expect(ui.status.dataset.state).toBe('error'); expect(ui.refresh.disabled).toBe(false);
  ui.refresh.click(); await flush(); expect(ui.list.children).toHaveLength(1);
});
test('settings and drive-data entrypoints reveal the same tree and isolate shortcuts', async () => {
  const ui = setup(); ui.registerRcloneBrowserOpener.mock.calls[0][0]('fixture', true); await flush();
  expect(ui.panel.hidden).toBe(false); expect(ui.api.rcloneList).toHaveBeenCalledWith('fixture', '');
  const event = { key: 'Escape', preventDefault: jest.fn(), stopPropagation: jest.fn() };
  ui.panel.listeners.keydown(event); await flush();
  expect(ui.panel.hidden).toBe(true); expect(event.stopPropagation).toHaveBeenCalled();
});

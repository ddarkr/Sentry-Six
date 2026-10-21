const fs = require('fs');
const vm = require('vm');
const path = require('path');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.listeners = {}; this.value = ''; }
  append(...items) { this.children.push(...items); if (this.tag === 'select' && !this.value) this.value = items[0]?.value || ''; }
  replaceChildren() { this.children = []; if (this.tag === 'select') this.value = ''; }
  setAttribute() {}
  addEventListener(type, callback) { this.listeners[type] = callback; }
  querySelectorAll(tag) { return this.children.filter(child => child.tag === tag); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const document = { body: new Element('body'), createElement: tag => new Element(tag) };
  const api = { rcloneRemotes: jest.fn(async () => ['fixture']), rcloneList: jest.fn(async () => [{ name: '2026-10-09_12-30-00-front.mp4', size: 4, playable: true }]), rcloneOpen: jest.fn(), rcloneCancel: jest.fn(async () => {}) };
  const context = vm.createContext({ document, window: { electronAPI: api }, Set });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/features/rcloneBrowser.js'), 'utf8').replaceAll('export function ', 'function '), context);
  const onOpen = jest.fn(async () => {}); context.initRcloneBrowser(onOpen);
  const [button, dialog] = document.body.children;
  const [title, help, select, refresh, up, location, status, list, open, close] = dialog.children;
  return { context, api, button, dialog, select, refresh, up, status, list, open, close, onOpen };
}
test('browses and hands complete snapshot to local playback exactly once', async () => {
  const ui = setup(); ui.api.rcloneOpen.mockResolvedValue({ directory: '/tmp/cache/snapshot', source: { remote: 'fixture', folder: '' } });
  ui.button.onclick(); await flush(); expect(ui.open.disabled).toBe(false);
  ui.open.onclick(); ui.open.onclick(); await flush();
  expect(ui.api.rcloneOpen).toHaveBeenCalledTimes(1); expect(ui.onOpen).toHaveBeenCalledTimes(1); expect(ui.dialog.open).toBe(false);
  expect(ui.context.isReadOnlyRclonePath('/tmp/cache/snapshot/SentryClips/event')).toBe(true);
  expect(ui.context.isReadOnlyRclonePath('/tmp/cache/snapshot-other')).toBe(false);
});
test('cancel prevents a late download from replacing current library', async () => {
  const ui = setup(); let resolve; ui.api.rcloneOpen.mockReturnValue(new Promise(r => { resolve = r; }));
  ui.button.onclick(); await flush(); ui.open.onclick(); ui.close.onclick();
  resolve({ directory: '/tmp/cache/snapshot' }); await flush();
  expect(ui.onOpen).not.toHaveBeenCalled(); expect(ui.dialog.open).toBe(false); expect(ui.api.rcloneCancel).toHaveBeenCalledTimes(1);
  expect(ui.button.disabled).toBe(false);
});
test('late directory listing after Escape stays dismissed and retry works', async () => {
  const ui = setup(); let resolve; ui.api.rcloneList.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  ui.button.onclick(); await flush(); ui.dialog.listeners.cancel({ preventDefault() {} });
  resolve([{ name: '<img src=x onerror=bad>', isDirectory: true }]); await flush();
  expect(ui.list.children).toHaveLength(0); expect(ui.dialog.open).toBe(false);
  ui.button.onclick(); await flush(); expect(ui.dialog.open).toBe(true); expect(ui.open.disabled).toBe(false);
});
test('failure is shown and leaves retry available; dialog isolates global shortcuts', async () => {
  const ui = setup(); ui.api.rcloneRemotes.mockRejectedValueOnce(new Error('rclone not found'));
  ui.button.onclick(); await flush(); expect(ui.status.textContent).toBe('rclone not found'); expect(ui.refresh.disabled).toBe(false);
  const event = { stopPropagation: jest.fn() }; ui.dialog.listeners.keydown(event); ui.dialog.listeners.mousedown(event); expect(event.stopPropagation).toHaveBeenCalledTimes(2);
});

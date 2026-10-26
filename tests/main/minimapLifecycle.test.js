const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

function setup(options = {}) {
  const ipcMain = new EventEmitter();
  const windows = [];
  const active = {};
  const cancelled = new Set();
  const unlinked = [];
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin.write = jest.fn(() => options.backpressure ? false : true);
  child.stdin.end = jest.fn(() => {
    if (!options.holdClose) setTimeout(() => child.emit('close', 0), 0);
  });
  child.stdin.destroy = jest.fn();
  child.kill = jest.fn(() => {
    if (!options.holdKill) setTimeout(() => child.emit('close', null), 0);
  });
  const spawn = jest.fn(() => child);
  class Window extends EventEmitter {
    constructor() {
      super();
      windows.push(this);
      this.dead = false;
      this.webContents = new EventEmitter();
      this.webContents.id = windows.length;
      this.webContents.session = { webRequest: { onBeforeSendHeaders() {} } };
      this.webContents.capturePage = jest.fn(() => {
        if (options.captureError) return Promise.reject(new Error('capture failed'));
        if (options.captureHang) return new Promise(() => {});
        return Promise.resolve({ toPNG: () => Buffer.from('png') });
      });
      this.webContents.send = (channel) => {
        if (options.initError && channel === 'minimap:init') throw new Error('init failed');
        if (channel === 'minimap:updateByTime') {
          if (options.onFrame) options.onFrame({ child, cancelled, active });
          if (!options.noReady) ipcMain.emit('minimap:ready', { sender: this.webContents });
        }
      };
    }
    loadFile() {
      if (options.loadReject) return Promise.reject(new Error('load rejected'));
      if (!options.loadHang) setTimeout(() => this.webContents.emit('did-finish-load'), 0);
      return Promise.resolve();
    }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const module = { exports: {} };
  const filename = path.resolve(__dirname, '../../src/main/minimap.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename), console: { log() {}, error() {} },
    setTimeout, clearTimeout, Buffer,
    require(name) {
      if (name === 'electron') return { BrowserWindow: Window, ipcMain };
      if (name === 'child_process') return { spawn };
      if (name === 'fs') return {
        existsSync: () => !options.missingFile,
        unlinkSync: file => {
          expect(child.listenerCount('close')).toBe(0);
          unlinked.push(file);
        }
      };
      if (name === '../shared/mapProviders') return { DEFAULT_PROVIDER_ID: 'osm' };
      return require(name);
    }
  }, { filename });
  const promise = module.exports.preRenderMinimap('id', [], [], 0, 80, 32, 32,
    'ffmpeg', options.progress || (() => {}), cancelled, false, 'osm', active);
  const result = promise.then(value => ({ value }), error => ({ error }));
  return { result, windows, child, spawn, active, cancelled, unlinked };
}

async function startEncoder() {
  await jest.advanceTimersByTimeAsync(2500);
}
function expectClean(h) {
  expect(h.windows[0].isDestroyed()).toBe(true);
  expect(h.windows[0].listenerCount('closed')).toBe(0);
  expect(h.windows[0].webContents.listenerCount('did-fail-load')).toBe(0);
  expect(h.windows[0].webContents.listenerCount('did-finish-load')).toBe(0);
  expect(h.child.listenerCount('error')).toBe(0);
  expect(h.child.stdin.listenerCount('error')).toBe(0);
  expect(h.child.stdin.listenerCount('drain')).toBe(0);
  expect(h.active.id).toBeUndefined();
  expect(jest.getTimerCount()).toBe(0);
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('success keeps ownership until exit, ends stdin and preserves output', async () => {
  const h = setup({ holdClose: true });
  await startEncoder();
  expect(h.active.id).toBe(h.child);
  expect(h.child.stdin.write).toHaveBeenCalledWith(Buffer.from('png'));
  expect(h.child.stdin.end).toHaveBeenCalledTimes(1);
  expect(h.windows[0].isDestroyed()).toBe(false);
  h.child.emit('close', 0);
  expect((await h.result).value).toMatch(/minimap_id_.*\.mov$/);
  expect(h.unlinked).toEqual([]);
  expect(h.child.kill).not.toHaveBeenCalled();
  expectClean(h);
});

test.each([
  ['missingFile', 'not found'], ['loadReject', 'load rejected'],
  ['loadHang', 'load timeout'], ['initError', 'init failed']
])('%s destroys the window before an encoder exists', async (option, message) => {
  const h = setup({ [option]: true });
  await jest.runAllTimersAsync();
  expect((await h.result).error.message).toContain(message);
  expect(h.spawn).not.toHaveBeenCalled();
  expectClean(h);
});

test.each([
  ['captureError', 'capture failed'], ['captureHang', 'render timeout'],
  ['noReady', 'render timeout']
])('%s kills and awaits the encoder before removing partial output', async (option, message) => {
  const h = setup({ [option]: true, holdKill: true });
  await jest.advanceTimersByTimeAsync(6000);
  expect(h.child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(h.unlinked).toEqual([]);
  expect(h.active.id).toBe(h.child);
  h.child.emit('close', null);
  expect((await h.result).error.message).toContain(message);
  expect(h.unlinked).toHaveLength(1);
  expectClean(h);
});

test.each(['error', 'close', 'pipe', 'cancel'])('%s during capture settles and releases resources', async kind => {
  const h = setup({ captureHang: true });
  await startEncoder();
  if (kind === 'error') h.child.emit('error', new Error('spawn failed'));
  if (kind === 'close') h.child.emit('close', 1);
  if (kind === 'pipe') h.child.stdin.emit('error', new Error('broken pipe'));
  if (kind === 'cancel') {
    h.cancelled.add('id');
    h.active.id.kill();
  }
  await jest.runAllTimersAsync();
  expect((await h.result).error).toBeDefined();
  expect(h.unlinked).toHaveLength(1);
  expectClean(h);
});

test('backpressure waits for drain and removes its listener', async () => {
  const h = setup({ backpressure: true });
  await startEncoder();
  expect(h.child.stdin.end).not.toHaveBeenCalled();
  expect(h.child.stdin.listenerCount('drain')).toBe(1);
  h.child.stdin.emit('drain');
  await jest.runAllTimersAsync();
  expect((await h.result).value).toBeDefined();
  expectClean(h);
});

test('pipe failure while backpressured and replacement ownership are preserved', async () => {
  const h = setup({ backpressure: true });
  await startEncoder();
  const replacement = {};
  h.active.id = replacement;
  h.child.stdin.emit('error', new Error('broken pipe'));
  await jest.runAllTimersAsync();
  expect((await h.result).error.message).toContain('broken pipe');
  expect(h.active.id).toBe(replacement);
  expect(h.child.stdin.listenerCount('drain')).toBe(0);
  expect(h.windows[0].isDestroyed()).toBe(true);
});

test('failure after the frame loop still kills and awaits the child', async () => {
  const h = setup({ progress: () => { throw new Error('progress failed'); } });
  await jest.runAllTimersAsync();
  expect((await h.result).error.message).toBe('progress failed');
  expect(h.child.kill).toHaveBeenCalled();
  expectClean(h);
});

test('an early zero exit cannot masquerade as a completed capture', async () => {
  const h = setup({ captureHang: true });
  await startEncoder();
  h.child.emit('close', 0);
  expect((await h.result).error.message).toContain('ended with code 0');
  expect(h.unlinked).toHaveLength(1);
  expectClean(h);
});

test('a pipe error after stdin.end still interrupts the exit wait', async () => {
  const h = setup({ holdClose: true });
  await startEncoder();
  expect(h.child.stdin.end).toHaveBeenCalled();
  h.child.stdin.emit('error', new Error('flush failed'));
  await jest.runAllTimersAsync();
  expect((await h.result).error.message).toBe('flush failed');
  expect(h.child.kill).toHaveBeenCalledWith('SIGKILL');
  expectClean(h);
});

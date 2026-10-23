const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');

function loadExportBoundary(browser) {
  const context = {
    console: { log() {}, error() {} }, AbortController, Set, Map,
    exportAbortControllers: new Map(), cancelledExports: new Set(),
    rcloneBrowser: browser, fs: { existsSync: jest.fn(() => { throw new Error('filesystem checkpoint'); }), unlinkSync() {} },
  };
  vm.createContext(context);
  const start = source.indexOf('async function performVideoExport(');
  vm.runInContext(source.slice(start, source.indexOf('\napp.whenReady()', start)), context);
  return { context, run: (segments, cameras = ['front']) => context.performVideoExport(
    { sender: { send() {} } }, 'test', { segments, cameras, startTimeMs: 0, endTimeMs: 1000, outputPath: '/output.mp4' }, '/ffmpeg'
  ) };
}

test('stages only overlapping selected camera originals before filesystem access and cleans on failure', async () => {
  const selected = 'http://127.0.0.1:1234/sentry-rclone/token/front.mp4';
  const cleanup = jest.fn();
  const browser = {
    isStreamPath: value => value.startsWith('http://127.0.0.1:'),
    stageForExport: jest.fn(async paths => ({ paths: new Map(paths.map(value => [value, '/staged/front.mp4'])), cleanup })),
  };
  const boundary = loadExportBoundary(browser);
  await expect(boundary.run([
    { durationSec: 60, files: { front: selected, back: selected + '-back' } },
    { durationSec: 60, files: { front: selected + '-later' } },
  ])).rejects.toThrow('filesystem checkpoint');
  expect(browser.stageForExport).toHaveBeenCalledWith([selected], { signal: expect.any(AbortSignal) });
  expect(cleanup).toHaveBeenCalled();
  expect(boundary.context.exportAbortControllers.size).toBe(0);
});

test('rejects unknown remote export references instead of substituting a black camera', async () => {
  const browser = { isStreamPath: () => false, stageForExport: jest.fn() };
  const boundary = loadExportBoundary(browser);
  await expect(boundary.run([{ durationSec: 60, files: { front: 'http://example.com/video.mp4' } }]))
    .rejects.toThrow('Unrecognized remote export source');
  expect(browser.stageForExport).not.toHaveBeenCalled();
  expect(boundary.context.fs.existsSync).not.toHaveBeenCalled();
});

test('keeps local export inputs on the existing filesystem path without staging', async () => {
  const browser = { isStreamPath: () => false, stageForExport: jest.fn() };
  const boundary = loadExportBoundary(browser);
  await expect(boundary.run([{ durationSec: 60, files: { front: '/recordings/front.mp4' } }]))
    .rejects.toThrow('filesystem checkpoint');
  expect(browser.stageForExport).not.toHaveBeenCalled();
  expect(boundary.context.fs.existsSync).toHaveBeenCalledWith('/recordings/front.mp4');
});

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PNG } = require('pngjs');

// Evaluate the existing shared export boundary without starting Electron.
const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
const composite = source.slice(source.indexOf('function compositeBlurMasks('), source.indexOf('\nconst {', source.indexOf('function compositeBlurMasks(')));
const apply = source.slice(source.indexOf('async function applyBlurZonesToStreams('), source.indexOf('// Video Export Implementation'));
function loadBoundary() {
  const files = [];
  const context = { PNG, Buffer, path, os: { tmpdir: () => '/tmp' }, fs: { writeFileSync: jest.fn((name, data) => files.push(data)) }, console: { log() {}, error() {} } };
  vm.createContext(context);
  vm.runInContext(`${composite}\n${apply}`, context);
  return { apply: context.applyBlurZonesToStreams, files, fs: context.fs };
}
function zone(overrides = {}) {
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(255);
  return { camera: 'front', maskImageBase64: PNG.sync.write(png).toString('base64'), maskWidth: 2, maskHeight: 2, ...overrides };
}
function options(blurZones) {
  return { blurZones, streams: [{ camera: 'front', tag: '[front]' }], streamTags: ['[front]'], cameraW: 2, cameraH: 2, filters: [], cmd: [], tempFiles: [], inputCount: 1, extraOffset: 0, exportId: 'test', FPS: 36 };
}

test.each([
  null,
  zone({ camera: undefined }),
  zone({ maskImageBase64: undefined }),
  zone({ maskImageBase64: 'not a PNG' }),
  zone({ maskWidth: 0 }),
  zone({ maskHeight: NaN }),
  zone({ maskWidth: 3 }),
  zone({ maskWidth: 1000000 }),
])('rejects malformed requested mask %# instead of continuing without blur', async invalid => {
  const boundary = loadBoundary();
  const opts = options([invalid]);
  await expect(boundary.apply(opts)).rejects.toThrow();
  expect(opts.streams[0].tag).toBe('[front]');
});

test('valid masks produce a decoded mask and replace both stream references', async () => {
  const boundary = loadBoundary();
  const opts = options([zone()]);
  await boundary.apply(opts);
  expect(opts.streams[0].tag).toBe('[blurred_front]');
  expect(opts.streamTags).toEqual(['[blurred_front]']);
  expect(opts.filters.join(';')).toContain('alphamerge');
  const png = PNG.sync.read(boundary.files[0]);
  expect([...png.data]).toEqual(new Array(16).fill(255));
});

test('preserves camera selection and rejects mask write errors', async () => {
  const boundary = loadBoundary();
  const selected = options([zone({ camera: 'back' })]);
  await boundary.apply(selected);
  expect(selected.cmd).toEqual([]);
  boundary.fs.writeFileSync.mockImplementation(() => { throw new Error('disk full'); });
  await expect(boundary.apply(options([zone()]))).rejects.toThrow('disk full');
});

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

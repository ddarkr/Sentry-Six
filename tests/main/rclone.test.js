const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { RcloneBrowser, safeName, validatePath, registerRcloneIpc } = require('../../src/main/rclone');
const filename = '2026-10-09_12-30-00-front.mp4';
const entry = (Name, Size = 4, IsDir = false) => ({ Name, Path: Name, Size, IsDir });
function fakeCli(replies) {
  return jest.fn((exe, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    const finish = code => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code)); };
    child.kill = jest.fn(() => finish(1));
    process.nextTick(() => {
      const reply = replies.shift();
      if (reply?.hold) return;
      if (reply?.error) { child.emit('error', Object.assign(new Error('private secret'), { code: reply.error })); finish(1); return; }
      child.stdout.write(Buffer.from(typeof reply === 'string' ? reply : reply?.data || ''));
      child.stderr.write('secret signed URL'); finish(reply?.code || 0);
    });
    return child;
  });
}
describe('read-only remote browser', () => {
  let temp, browsers;
  beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rclone-test-')); browsers = []; });
  afterEach(() => { for (const b of browsers) b.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  function browser(replies, options = {}) {
    const spawnProcess = fakeCli(replies);
    const b = new RcloneBrowser({ cacheParent: temp, spawnProcess, ...options }); browsers.push(b);
    return [b, spawnProcess];
  }
  test('discovers configured remotes only, not inline backend configs', async () => {
    const [b] = browser(['cloud:\n:local:\n--config evil:\nx:\n']);
    expect(await b.listRemotes()).toEqual(['cloud']);
    await expect(b.list(':local', '')).rejects.toThrow('configured');
  });
  test.each(['../escape', '/absolute', 'a//b', 'a/../b', 'a\\b', 'a:b', 'a\0b', 'CON', 'a.'])('rejects unsafe path %s', value => {
    expect(() => validatePath(value)).toThrow();
  });
  test('accepts supported names and shell punctuation as literal arguments', () => {
    expect(safeName('My folder $(echo hi);')).toBe(true);
    expect(validatePath('TeslaCam/SavedClips')).toBe('TeslaCam/SavedClips');
  });
  test('downloads snapshot with original basename for local seek/export and no remote writes', async () => {
    const [b, spawn] = browser(['cloud:\n', JSON.stringify([entry(filename), entry('ignored.txt')]), 'mp4!']);
    await b.listRemotes(); const result = await b.materialize('cloud', 'TeslaCam/event');
    expect(fs.readFileSync(path.join(result.directory, filename), 'utf8')).toBe('mp4!');
    expect(result.source).toEqual({ kind: 'rclone', remote: 'cloud', folder: 'TeslaCam/event' });
    expect(spawn.mock.calls.map(c => c[1][0])).toEqual(['listremotes', 'lsjson', 'cat']);
    for (const call of spawn.mock.calls) expect(call[2].shell).toBe(false);
    expect(spawn.mock.calls[2][1]).toEqual(['cat', '--max-depth', '1', '--', `cloud:TeslaCam/event/${filename}`]);
    const root = b.root; b.dispose(); expect(fs.existsSync(root)).toBe(false);
  });
  test('quota checks before downloading, preserves earlier playable cache', async () => {
    const [b, spawn] = browser(['cloud:\n', JSON.stringify([entry(filename)]), 'mp4!', JSON.stringify([entry(filename)])], { maxBytes: 6 });
    await b.listRemotes(); const first = await b.materialize('cloud', 'one');
    await expect(b.materialize('cloud', 'two')).rejects.toThrow('limit');
    expect(spawn.mock.calls.filter(c => c[1][0] === 'cat')).toHaveLength(1);
    expect(fs.existsSync(path.join(first.directory, filename))).toBe(true);
  });
  test.each(['too much data', 'x'])('cleans incomplete or oversized transfers', async data => {
    const [b] = browser(['cloud:\n', JSON.stringify([entry(filename)]), data]);
    await b.listRemotes(); await expect(b.materialize('cloud', '')).rejects.toThrow('changed size');
    expect(fs.readdirSync(b.root)).toEqual([]); expect(b.bytes).toBe(0);
  });
  test('rejects unsafe and case-colliding remote names', async () => {
    const [b] = browser(['cloud:\n', JSON.stringify([entry('../oops')]), JSON.stringify([entry('a'), entry('A')])]);
    await b.listRemotes(); await expect(b.list('cloud', '')).rejects.toThrow('unsupported');
    await expect(b.list('cloud', '')).rejects.toThrow('duplicate');
  });
  test('missing CLI errors are useful without leaking stderr', async () => {
    const [b] = browser([{ error: 'ENOENT' }]);
    await expect(b.listRemotes()).rejects.toThrow('rclone was not found');
  });
  test('remote errors hide backend details', async () => {
    const [b] = browser([{ code: 1 }]);
    await expect(b.listRemotes()).rejects.toThrow('Check connectivity');
  });
  test('cancel kills active CLI and rejects concurrent operations', async () => {
    const [b] = browser([{ hold: true }]);
    const operation = b.listRemotes();
    await expect(b.listRemotes()).rejects.toThrow('already running');
    b.cancel(); await expect(operation).rejects.toThrow('cancelled');
    expect(b.children.size).toBe(0);
  });
  test('timeouts stop stalled CLI', async () => {
    const [b] = browser([{ hold: true }], { timeoutMs: 10 });
    await expect(b.listRemotes()).rejects.toThrow('timed out');
  });
  test('IPC rejects unknown senders and subframes before touching the CLI', async () => {
    const handlers = {};
    const app = { getPath: () => temp, on: jest.fn() };
    const webContents = { mainFrame: {} };
    const b = registerRcloneIpc({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, app, getMainWindow: () => ({ webContents }) });
    browsers.push(b);
    await expect(handlers['rclone:remotes']({ sender: {}, senderFrame: {} })).rejects.toThrow('Untrusted');
    await expect(handlers['rclone:remotes']({ sender: webContents, senderFrame: {} })).rejects.toThrow('Untrusted');
  });
});

describe('installed rclone local fixture (no user cloud credentials)', () => {
  const { spawn, spawnSync } = require('child_process');
  const hasRclone = !spawnSync('rclone', ['version'], { stdio: 'ignore' }).error;
  (hasRclone ? test : test.skip)('lists, downloads and preserves TeslaCam event layout using real CLI', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rclone-local-fixture-'));
    const config = path.join(temp, 'fixture.conf');
    fs.writeFileSync(config, '[fixture]\ntype = local\n');
    const source = path.join(temp, 'source', 'SentryClips', '2026-10-09_12-30-00');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, filename), 'fake-video');
    fs.writeFileSync(path.join(source, 'event.json'), '{"reason":"sentry_aware_object_detection"}');
    const b = new RcloneBrowser({ cacheParent: temp, spawnProcess: (exe, args, options) => spawn(exe, ['--config', config, ...args], {
      ...options, env: { PATH: process.env.PATH, HOME: temp, SYSTEMROOT: process.env.SYSTEMROOT }
    }) });
    // A local backend uses an absolute fixture path. This test maps a safe relative path
    // through cwd rather than weakening production's remote path validation.
    b.spawn = (exe, args, options) => spawn(exe, ['--config', config, ...args], {
      ...options, cwd: path.join(temp, 'source'), env: { PATH: process.env.PATH, HOME: temp, SYSTEMROOT: process.env.SYSTEMROOT }
    });
    try {
      expect(await b.listRemotes()).toEqual(['fixture']);
      const listing = await b.list('fixture', 'SentryClips');
      expect(listing[0].isDirectory).toBe(true);
      const result = await b.materialize('fixture', 'SentryClips/2026-10-09_12-30-00');
      const cacheEvent = path.join(result.directory, 'SentryClips', '2026-10-09_12-30-00');
      expect(fs.readFileSync(path.join(cacheEvent, filename), 'utf8')).toBe('fake-video');
      expect(fs.existsSync(path.join(cacheEvent, 'event.json'))).toBe(true);
      expect(fs.readdirSync(source).sort()).toEqual([filename, 'event.json'].sort());
    } finally { b.dispose(); fs.rmSync(temp, { recursive: true, force: true }); }
  });
});

const { spawn: spawnReal, spawnSync } = require('child_process');
const mediaToolsAvailable = ['rclone', 'ffmpeg', 'ffprobe'].every(tool => !spawnSync(tool, tool === 'rclone' ? ['version'] : ['-version'], { stdio: 'ignore' }).error);
(mediaToolsAvailable ? test : test.skip)('real local-backend MP4 snapshot supports seeking and FFmpeg export', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rclone-media-fixture-'));
  const source = path.join(temp, 'source'); fs.mkdirSync(source);
  const config = path.join(temp, 'fixture.conf'); fs.writeFileSync(config, '[fixture]\ntype = local\n');
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(source, filename)]);
  expect(generated.status).toBe(0);
  const browser = new RcloneBrowser({ cacheParent: temp, spawnProcess: (exe, args, options) => spawnReal(exe, ['--config', config, ...args], {
    ...options, cwd: source, env: { PATH: process.env.PATH, HOME: temp, SYSTEMROOT: process.env.SYSTEMROOT }
  }) });
  try {
    await browser.listRemotes(); const result = await browser.materialize('fixture', '');
    const cached = path.join(result.directory, filename);
    const exported = path.join(temp, 'export.mp4');
    const encoded = spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', cached, '-t', '0.75', '-c:v', 'libx264', exported]);
    expect(encoded.status).toBe(0);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', exported], { encoding: 'utf8' });
    expect(probe.status).toBe(0); expect(Number(probe.stdout)).toBeGreaterThan(0);
    expect(fs.readFileSync(cached).equals(fs.readFileSync(path.join(source, filename)))).toBe(true);
  } finally { browser.dispose(); fs.rmSync(temp, { recursive: true, force: true }); }
}, 20000);

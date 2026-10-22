const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { RcloneBrowser, safeName, validatePath, registerRcloneIpc } = require('../../src/main/rclone');
const filename = '2026-10-09_12-30-00-front.mp4';
const entry = (Name, Size = 4, IsDir = false) => ({ Name, Path: Name, Size, IsDir });
const localRemote = JSON.stringify([{ name: 'cloud', type: 'local' }]);
function fakeCli(replies) {
  return jest.fn((exe, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    const finish = code => { if (closed) return; closed = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code)); };
    child.kill = jest.fn(() => finish(1));
    process.nextTick(() => {
      const next = replies.shift();
      const reply = typeof next === 'function' ? next(args) : next;
      for (const chunk of reply?.stderr || []) child.stderr.write(chunk);
      if (reply?.hold) return;
      if (reply?.error) { child.emit('error', Object.assign(new Error('private secret'), { code: reply.error })); finish(1); return; }
      child.stdout.write(Buffer.from(typeof reply === 'string' ? reply : reply?.data || ''));
      finish(reply?.code || 0);
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
    const [b] = browser([JSON.stringify(['cloud', ':local', '--config evil', 'x'].map(name => ({ name, type: 'local' })))]);
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
    const [b, spawn] = browser([localRemote, JSON.stringify([entry(filename), entry('ignored.txt'), entry('ignored.txt'), entry('../ignored')]), 'mp4!']);
    await b.listRemotes(); const result = await b.materialize('cloud', '');
    expect(fs.readFileSync(path.join(result.directory, filename), 'utf8')).toBe('mp4!');
    expect(result.source).toEqual({ kind: 'rclone', remote: 'cloud', folder: '' });
    for (const call of spawn.mock.calls) expect(call[2].shell).toBe(false);
    const root = b.root; b.dispose(); expect(fs.existsSync(root)).toBe(false);
  });
  test('quota checks before downloading, preserves earlier playable cache', async () => {
    const [b, spawn] = browser([localRemote, JSON.stringify([entry(filename)]), 'mp4!', JSON.stringify([entry(filename)])], { maxBytes: 6 });
    await b.listRemotes(); const first = await b.materialize('cloud', '');
    await expect(b.materialize('cloud', '')).rejects.toThrow('limit');
    expect(spawn.mock.calls.filter(c => c[1][0] === 'cat')).toHaveLength(1);
    expect(fs.existsSync(path.join(first.directory, filename))).toBe(true);
  });
  test.each(['too much data', 'x'])('cleans incomplete or oversized transfers', async data => {
    const [b] = browser([localRemote, JSON.stringify([entry(filename)]), data]);
    await b.listRemotes(); await expect(b.materialize('cloud', '')).rejects.toThrow('changed size');
    expect(fs.readdirSync(b.root)).toEqual([]); expect(b.bytes).toBe(0);
  });
  test.each([filename, filename.toUpperCase()])('rejects conflicting recording %s only at download', async duplicate => {
    const listing = JSON.stringify([entry(filename), entry(duplicate)]);
    const [b, spawn] = browser([localRemote, listing, listing]);
    await b.listRemotes();
    expect((await b.list('cloud', '')).map(row => row.name)).toEqual([filename, duplicate]);
    await expect(b.materialize('cloud', '')).rejects.toMatchObject({ code: 'DUPLICATE_FILES' });
    expect(spawn.mock.calls.some(call => call[1][0] === 'cat')).toBe(false);
    expect(b.root).toBeUndefined();
  });
  test('same-name Drive directories select and download from their own IDs', async () => {
    const directories = [
      { ...entry('Same / folder:', 0, true), ID: 'folder-a' },
      { ...entry('Same / folder:', 0, true), ID: 'folder-b' }
    ];
    const [b] = browser([
      JSON.stringify([{ name: 'cloud', type: 'drive' }]),
      JSON.stringify(directories),
      args => JSON.stringify([entry(args.includes('folder-a') ? 'first.txt' : 'wrong.txt')]),
      args => JSON.stringify([entry(args.includes('folder-b') ? filename : 'wrong.txt')]),
      args => args.includes('folder-b') ? 'mp4!' : 'oops'
    ]);
    await b.listRemotes();
    const folders = await b.list('cloud', '');
    expect(folders[0].folder).not.toBe(folders[1].folder);
    expect((await b.list('cloud', folders[0].folder))[0].name).toBe('first.txt');
    const opened = await b.materialize('cloud', folders[1].folder);
    expect(fs.readFileSync(path.join(opened.directory, filename), 'utf8')).toBe('mp4!');
    expect(opened.source.folder).toBe('Same / folder:');
  });
  test('Drive directory shortcuts use target IDs, not ambiguous names', async () => {
    const [b] = browser([
      JSON.stringify([{ name: 'cloud', type: 'drive' }]),
      JSON.stringify([{ ...entry('Shortcut', 0, true), ID: 'target-id\tshortcut-id' }]),
      args => JSON.stringify([entry(args.includes('target-id') ? filename : 'wrong.txt')])
    ]);
    await b.listRemotes();
    const [folder] = await b.list('cloud', '');
    expect((await b.list('cloud', folder.folder))[0].playable).toBe(true);
  });
  test('rejects forged, cross-remote and refreshed folder references before reading them', async () => {
    const remotes = JSON.stringify([{ name: 'cloud', type: 'drive' }, { name: 'other', type: 'drive' }]);
    const [b, spawn] = browser([remotes, JSON.stringify([{ ...entry('Folder', 0, true), ID: 'folder-id' }]), remotes]);
    await b.listRemotes();
    const [folder] = await b.list('cloud', '');
    await expect(b.list('cloud', 'folder-id')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(b.list('other', folder.folder)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(b.materialize('other', folder.folder)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await b.listRemotes();
    await expect(b.list('cloud', folder.folder)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(spawn).toHaveBeenCalledTimes(3);
  });
  test('does not fall back to a folder name when a Drive directory ID is missing', async () => {
    const [b] = browser([JSON.stringify([{ name: 'cloud', type: 'drive' }]), JSON.stringify([entry('Folder', 0, true)])]);
    await b.listRemotes();
    await expect(b.list('cloud', '')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
  test('never guesses between duplicate directories on a path-only provider', async () => {
    const [b] = browser([localRemote, JSON.stringify([entry('Folder', 0, true), entry('Folder', 0, true)])]);
    await b.listRemotes();
    await expect(b.list('cloud', '')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(b.folders.size).toBe(0);
  });
  test('missing CLI errors are useful without leaking stderr', async () => {
    const [b] = browser([{ error: 'ENOENT' }]);
    await expect(b.listRemotes()).rejects.toMatchObject({ code: 'NOT_INSTALLED' });
  });
  test('remote errors hide backend details', async () => {
    const [b] = browser([{ code: 1, stderr: ['secret signed URL'] }]);
    const error = await b.listRemotes().catch(error => error);
    expect(error.code).toBe('REMOTE_ERROR');
    expect(error.message).not.toContain('secret signed URL');
  });
  test.each([
    ['AUTH_REQUIRED', ['invalid_', 'grant: private-secret']],
    ['AUTH_REQUIRED', ['googleapi: Error 401: private-secret']],
    ['INVALID_CLIENT', ['invalid_', 'client: private-secret']],
    ['INVALID_CLIENT', ['redirect_uri_mismatch: private-secret']],
    ['RATE_LIMIT', ['googleapi: Error 403: private-secret, rateLimit', 'Exceeded']],
    ['RATE_LIMIT', ['googleapi: Error 429: private-secret']],
    ['NETWORK', ['dial tcp: private-secret']],
    ['PERMISSION', ['insufficient permissions: private-secret']],
    ['CONFIG_LOCKED', ['configuration file is encrypted: private-secret']]
  ])('classifies %s without leaking private diagnostics', async (code, stderr) => {
    const [b] = browser([{ code: 1, stderr }]);
    const error = await b.listRemotes().catch(error => error);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain('private-secret');
  });
  test('cancel kills active CLI and rejects concurrent operations', async () => {
    const [b] = browser([{ hold: true }]);
    const operation = b.listRemotes();
    await expect(b.listRemotes()).rejects.toMatchObject({ code: 'BUSY' });
    b.cancel(); await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(b.children.size).toBe(0);
  });
  test('timeouts stop stalled CLI', async () => {
    const [b] = browser([{ hold: true }], { timeoutMs: 10 });
    await expect(b.listRemotes()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  test('keeps a known rate-limit cause when the command deadline expires', async () => {
    const [b] = browser([{ hold: true, stderr: ['googleapi: Error 403: private-secret, rateLimitExceeded'] }], { timeoutMs: 10 });
    const error = await b.listRemotes().catch(error => error);
    expect(error.code).toBe('RATE_LIMIT');
    expect(error.message).not.toContain('private-secret');
    expect(b.children.size).toBe(0);
  });
  test('IPC rejects unknown senders and subframes before touching the CLI', async () => {
    const handlers = {};
    const app = { getPath: () => temp, on: jest.fn() };
    const webContents = { mainFrame: {} };
    const b = registerRcloneIpc({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, app, getMainWindow: () => ({ webContents }) });
    browsers.push(b);
    for (const handler of Object.values(handlers)) {
      await expect(handler({ sender: {}, senderFrame: {} })).rejects.toThrow('Untrusted');
      await expect(handler({ sender: webContents, senderFrame: {} })).rejects.toThrow('Untrusted');
    }
  });
  test('trusted IPC returns actionable error codes without backend diagnostics', async () => {
    const handlers = {};
    const frame = { url: require('url').pathToFileURL(path.resolve(__dirname, '../../src/renderer/index.html')).href };
    const webContents = { mainFrame: frame };
    const b = registerRcloneIpc({ ipcMain: { handle: (name, handler) => { handlers[name] = handler; } }, app: { getPath: () => temp, on: jest.fn() }, getMainWindow: () => ({ webContents }) });
    browsers.push(b);
    b.spawn = fakeCli([{ code: 1, stderr: ['invalid_grant private-token'] }]);
    const result = await handlers['rclone:remotes']({ sender: webContents, senderFrame: frame });
    expect(result).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } });
    expect(JSON.stringify(result)).not.toContain('private-token');
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
      const [category] = await b.list('fixture', '');
      const [event] = await b.list('fixture', category.folder);
      const result = await b.materialize('fixture', event.folder);
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

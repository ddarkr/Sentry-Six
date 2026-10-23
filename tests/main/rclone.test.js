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
      if (args[0] === 'serve') { child.stderr.write('Serving on http://127.0.0.1:49123/\n'); return; }
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
  test('opens a manifest larger than 2 GiB without transferring recordings', async () => {
    const [b, spawn] = browser([localRemote, JSON.stringify([entry(filename, 3 * 1024 ** 3), entry('ignored.txt')])]);
    await b.listRemotes();
    const result = await b.open('cloud', '');
    expect(result.files).toEqual([{ name: filename, path: `${result.directory}/${filename}`, size: 3 * 1024 ** 3, isFile: true, isDirectory: false }]);
    expect(result.source).toEqual({ kind: 'rclone', remote: 'cloud', folder: '' });
    expect(b.isStreamPath(result.files[0].path)).toBe(true);
    expect(b.containsCachePath(result.directory)).toBe(true);
    expect(spawn.mock.calls.map(call => call[1][0])).toEqual(['listremotes', 'lsjson', 'serve']);
    await expect(b.stageForExport([result.files[0].path])).rejects.toMatchObject({ code: 'EXPORT_LIMIT' });
    const old = b.stream; b.cancel(true); expect(old.closed).toBe(true);
    await expect(b.stageForExport([result.files[0].path])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  test('drive data uses a separate allowlisted session and cancel preserves video', async () => {
    const [b, spawn] = browser([localRemote, JSON.stringify([entry(filename)]),
      JSON.stringify([entry('DRIVE-DATA.JSON', 123), entry('ignored.json')]),
      JSON.stringify([entry('drive-data.json', 456)])]);
    await b.listRemotes();
    const video = await b.open('cloud', '');
    const videoSession = b.stream;
    const first = await b.openDriveData('cloud', '');
    expect(first).toEqual({ path: expect.stringContaining('/DRIVE-DATA.JSON'), size: 123,
      source: { kind: 'rclone', remote: 'cloud', folder: '' } });
    expect(b.getDriveDataSource(first.path)).toMatchObject({ name: 'DRIVE-DATA.JSON', size: 123 });
    expect(b.getDriveDataSource(video.files[0].path)).toBeNull();
    expect(b.getDriveDataSource(first.path + '?forged')).toBeNull();
    const old = b.driveStream;
    const second = await b.openDriveData('cloud', '');
    expect(old.closed).toBe(true);
    expect(b.getDriveDataSource(first.path)).toBeNull();
    expect(videoSession.closed).toBe(false);
    expect(spawn.mock.calls.some(call => call[1][0] === 'cat')).toBe(false);
    b.cancel();
    expect(b.getDriveDataSource(second.path)).toBeNull();
    expect(videoSession.closed).toBe(false);
    b.dispose();
    expect(videoSession.closed).toBe(true);
  });
  test('drive data deduplicates only checksum and size verified copies', async () => {
    const hashed = { ...entry('drive-data.json', 123), Hashes: { md5: 'ab'.repeat(16) } };
    const [b, spawn] = browser([JSON.stringify([{ name: 'cloud', type: 'drive' }]),
      JSON.stringify([hashed, { ...hashed, Name: 'DRIVE-DATA.JSON', Path: 'DRIVE-DATA.JSON' }])]);
    await b.listRemotes();
    await b.openDriveData('cloud', '');
    expect(b.driveStream.files.size).toBe(1);
    expect(spawn.mock.calls.find(call => call[1][0] === 'lsjson')[1]).toContain('--hash-type');
  });
  test.each([
    [entry('drive-data.json'), entry('DRIVE-DATA.JSON')],
    [entry('drive-data.json', -1)],
    [entry('drive-data.json', 0)],
    [entry('drive-data.json', 1.5)],
    [entry('other.json')],
    [entry('drive-data.json', 4, true)]
  ])('rejects unsupported or unsafe drive data selections %j', async (...rows) => {
    const [b] = browser([localRemote, JSON.stringify(rows)]);
    await b.listRemotes();
    await expect(b.openDriveData('cloud', '')).rejects.toThrow();
    expect(b.driveStream).toBeUndefined();
  });
  test.each([
    ['cd'.repeat(16), 123],
    ['ab'.repeat(16), 124],
    [undefined, 123]
  ])('rejects conflicting drive-data checksums or sizes', async (md5, size) => {
    const original = { ...entry('drive-data.json', 123), Hashes: { md5: 'ab'.repeat(16) } };
    const duplicate = { ...entry('drive-data.json', size), Hashes: { md5 } };
    const [b] = browser([JSON.stringify([{ name: 'cloud', type: 'drive' }]),
      JSON.stringify([original, duplicate])]);
    await b.listRemotes();
    await expect(b.openDriveData('cloud', '')).rejects.toMatchObject({ code: 'DUPLICATE_FILES' });
  });
  test('cancelling drive selection kills listing and revokes old drive source, not video', async () => {
    const [b] = browser([localRemote, JSON.stringify([entry(filename)]),
      JSON.stringify([entry('drive-data.json')]), { hold: true }]);
    await b.listRemotes();
    await b.open('cloud', '');
    const data = await b.openDriveData('cloud', '');
    const pending = b.openDriveData('cloud', '');
    expect(b.getDriveDataSource(data.path)).toBeNull();
    await expect(b.openDriveData('cloud', '')).rejects.toMatchObject({ code: 'BUSY' });
    b.cancel();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(b.stream.closed).toBe(false);
  });
  test.each([filename, filename.toUpperCase()])('rejects conflicting recording %s only at open', async duplicate => {
    const listing = JSON.stringify([entry(filename), entry(duplicate)]);
    const [b, spawn] = browser([localRemote, listing, listing]);
    await b.listRemotes();
    expect((await b.list('cloud', '')).map(row => row.name)).toEqual([filename, duplicate]);
    await expect(b.open('cloud', '')).rejects.toMatchObject({ code: 'DUPLICATE_FILES' });
    expect(spawn.mock.calls.some(call => call[1][0] === 'cat')).toBe(false);
    expect(b.root).toBeUndefined();
  });
  test('streams one copy of identical Drive recordings and event assets', async () => {
    const hashed = name => ({ ...entry(name), Hashes: { md5: 'ab'.repeat(16) } });
    const listing = [hashed(filename), hashed(filename), hashed(filename.toUpperCase()),
      hashed('event.json'), hashed('event.json'), hashed('thumb.png'), hashed('thumb.png')];
    listing[1].Hashes.md5 = listing[1].Hashes.md5.toUpperCase();
    const [b] = browser([JSON.stringify([{ name: 'cloud', type: 'drive' }]), JSON.stringify(listing)]);
    await b.listRemotes();
    const result = await b.open('cloud', '');
    expect(result.fileCount).toBe(1);
    expect(result.files.map(file => file.name)).toEqual([filename, 'event.json', 'thumb.png']);
    expect(b.stream.files.size).toBe(3);
  });
  test.each([
    ['different content', 'cd'.repeat(16), 4],
    ['different size', 'ab'.repeat(16), 5],
    ['missing hash', undefined, 4],
    ['empty hash', '', 4],
    ['invalid hash', 'not-a-checksum', 4]
  ])('rejects unverified Drive duplicates: %s', async (_reason, md5, size) => {
    const original = { ...entry(filename), Hashes: { md5: 'ab'.repeat(16) } };
    const duplicate = { ...entry(filename, size), Hashes: { md5 } };
    const [b] = browser([JSON.stringify([{ name: 'cloud', type: 'drive' }]),
      JSON.stringify([original, original, duplicate])]);
    await b.listRemotes();
    await expect(b.open('cloud', '')).rejects.toMatchObject({ code: 'DUPLICATE_FILES' });
    expect(b.stream).toBeUndefined();
  });
  test('same-name Drive directories select and serve from their own IDs', async () => {
    const directories = [
      { ...entry('Same / folder:', 0, true), ID: 'folder-a' },
      { ...entry('Same / folder:', 0, true), ID: 'folder-b' }
    ];
    const [b] = browser([
      JSON.stringify([{ name: 'cloud', type: 'drive' }]),
      JSON.stringify(directories),
      args => JSON.stringify([entry(args.includes('folder-a') ? 'first.txt' : 'wrong.txt')]),
      args => JSON.stringify([entry(args.includes('folder-b') ? filename : 'wrong.txt')])
    ]);
    await b.listRemotes();
    const folders = await b.list('cloud', '');
    expect(folders[0].folder).not.toBe(folders[1].folder);
    expect((await b.list('cloud', folders[0].folder))[0].name).toBe('first.txt');
    const opened = await b.open('cloud', folders[1].folder);
    expect(opened.files[0].name).toBe(filename);
    expect(b.sourceArgs('cloud', folders[1].folder)).toEqual(['--drive-root-folder-id', 'folder-b', '--', 'cloud:']);
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
    await expect(b.open('other', folder.folder)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
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
  test.each([false, true])('cancelling a pending listing releases the active source only when requested: %s', async release => {
    const [b, spawn] = browser([localRemote, JSON.stringify([entry(filename)]), { hold: true }]);
    await b.listRemotes();
    const source = await b.open('cloud', '');
    const old = b.stream;
    const servingChild = spawn.mock.results.at(-1).value;
    const operation = b.list('cloud', '');
    b.cancel(release);
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(old.closed).toBe(release);
    expect(servingChild.kill).toHaveBeenCalledTimes(release ? 1 : 0);
    expect(b.children.size).toBe(0);
    if (release) await expect(fetch(source.files[0].path)).rejects.toThrow();
    else {
      b.cancel();
      expect(old.closed).toBe(false);
      b.dispose();
      expect(old.closed).toBe(true);
    }
  });
  test('cancelling a pending source open preserves the previous source', async () => {
    const [b] = browser([localRemote, JSON.stringify([entry(filename)]), { hold: true }]);
    await b.listRemotes();
    await b.open('cloud', '');
    const old = b.stream;
    const operation = b.open('cloud', '');
    b.cancel();
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(b.stream).toBe(old);
    expect(old.closed).toBe(false);
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
    const cancel = jest.spyOn(b, 'cancel');
    const event = { sender: webContents, senderFrame: frame };
    for (const value of [null, 1, 'true', {}]) {
      expect(await handlers['rclone:cancel'](event, value)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(cancel).not.toHaveBeenCalled();
    for (const value of [undefined, false, true]) {
      expect(await handlers['rclone:cancel'](event, value)).toMatchObject({ ok: true });
      expect(cancel).toHaveBeenLastCalledWith(value ?? false);
    }
  });
});

describe('installed rclone local fixture (no user cloud credentials)', () => {
  const { spawn, spawnSync } = require('child_process');
  const hasRclone = !spawnSync('rclone', ['version'], { stdio: 'ignore' }).error;
  (hasRclone ? test : test.skip)('streams and stages selected TeslaCam files using real CLI', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rclone-local-fixture-'));
    const config = path.join(temp, 'fixture.conf');
    fs.writeFileSync(config, '[fixture]\ntype = local\n');
    const source = path.join(temp, 'source', 'SentryClips', '2026-10-09_12-30-00');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, filename), 'fake-video');
    fs.writeFileSync(path.join(source, 'event.json'), '{"reason":"sentry_aware_object_detection"}');
    const b = new RcloneBrowser({ cacheParent: temp, spawnProcess: (exe, args, options) => spawn(exe, ['--config', config, ...args], {
      ...options, env: { ...options.env, PATH: process.env.PATH, HOME: temp, SYSTEMROOT: process.env.SYSTEMROOT }
    }) });
    // A local backend uses an absolute fixture path. This test maps a safe relative path
    // through cwd rather than weakening production's remote path validation.
    b.spawn = (exe, args, options) => spawn(exe, ['--config', config, ...args], {
      ...options, cwd: path.join(temp, 'source'), env: { ...options.env, PATH: process.env.PATH, HOME: temp, SYSTEMROOT: process.env.SYSTEMROOT }
    });
    try {
      expect(await b.listRemotes()).toEqual(['fixture']);
      const [category] = await b.list('fixture', '');
      const [event] = await b.list('fixture', category.folder);
      const result = await b.open('fixture', event.folder);
      expect(result.source.folder).toBe('SentryClips/2026-10-09_12-30-00');
      const url = result.files.find(file => file.name === filename).path;
      const response = await fetch(url, { headers: { Range: 'bytes=2-5' } });
      expect(response.status).toBe(206); expect(await response.text()).toBe('ke-v');
      expect((await fetch(result.directory)).status).toBe(404);
      expect((await fetch(url, { method: 'PUT' })).status).toBe(405);
      expect((await fetch(url.replace(/sentry-rclone\/[a-f0-9]+/, `sentry-rclone/${'0'.repeat(64)}`))).status).toBe(404);
      const staged = await b.stageForExport([url]);
      expect(staged.paths.size).toBe(1);
      expect(fs.readFileSync(staged.paths.get(url), 'utf8')).toBe('fake-video');
      const stagedPath = staged.paths.get(url);
      staged.cleanup(); staged.cleanup(); expect(fs.existsSync(stagedPath)).toBe(false);
      expect(fs.readdirSync(source).sort()).toEqual([filename, 'event.json'].sort());
    } finally { b.dispose(); fs.rmSync(temp, { recursive: true, force: true }); }
  });
});

const { spawn: spawnReal, spawnSync } = require('child_process');
const mediaToolsAvailable = ['rclone', 'ffmpeg', 'ffprobe'].every(tool => !spawnSync(tool, tool === 'rclone' ? ['version'] : ['-version'], { stdio: 'ignore' }).error);
(mediaToolsAvailable ? test : test.skip)('real local-backend MP4 staging supports seeking and FFmpeg export', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rclone-media-fixture-'));
  const source = path.join(temp, 'source'); fs.mkdirSync(source);
  const config = path.join(temp, 'fixture.conf'); fs.writeFileSync(config, '[fixture]\ntype = local\n');
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(source, filename)]);
  expect(generated.status).toBe(0);
  const browser = new RcloneBrowser({ cacheParent: temp, spawnProcess: (exe, args, options) => spawnReal(exe, ['--config', config, ...args], {
    ...options, cwd: source, env: { ...options.env, PATH: process.env.PATH, HOME: temp, SYSTEMROOT: process.env.SYSTEMROOT }
  }) });
  try {
    await browser.listRemotes(); const result = await browser.open('fixture', '');
    const staged = await browser.stageForExport([result.files[0].path]);
    const cached = staged.paths.get(result.files[0].path);
    const exported = path.join(temp, 'export.mp4');
    const encoded = spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', cached, '-t', '0.75', '-c:v', 'libx264', exported]);
    expect(encoded.status).toBe(0);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', exported], { encoding: 'utf8' });
    expect(probe.status).toBe(0); expect(Number(probe.stdout)).toBeGreaterThan(0);
    expect(fs.readFileSync(cached).equals(fs.readFileSync(path.join(source, filename)))).toBe(true);
  } finally { browser.dispose(); fs.rmSync(temp, { recursive: true, force: true }); }
}, 20000);

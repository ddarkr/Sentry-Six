const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const transport = require('../../src/main/rcloneStream');
const filename = '2026-10-09_12-30-00-front.mp4';

describe('capability media gateway', () => {
  let temp, upstream, browser, session, credentials, seen, mode;
  beforeEach(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-gateway-test-'));
    seen = [];
    mode = null;
    upstream = http.createServer((req, res) => {
      seen.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
      if (req.headers.authorization !== credentials) { res.writeHead(401).end(); return; }
      if (req.url !== `/${filename}`) { res.writeHead(404).end(); return; }
      const body = Buffer.from('0123456789');
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (mode === 'short') { res.writeHead(200, { 'Content-Length': 10 }); res.write('x'); res.destroy(); return; }
      if (mode === 'hang') { res.writeHead(200, { 'Content-Length': 10 }); res.write('x'); return; }
      if (match) {
        const start = Number(match[1]), end = Math.min(Number(match[2]), 9);
        if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */10', 'Content-Length': '0' }).end(); return; }
        res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/10`, 'Content-Type': 'video/mp4' });
        res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'Content-Length': 10, 'Content-Type': 'video/mp4' });
        res.end(req.method === 'HEAD' ? undefined : body);
      }
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    browser = {
      cacheParent: temp, maxBytes: 100, timeoutMs: 1000, executable: 'rclone', children: new Set(), stages: new Set(), stageDirectories: new Set(),
      sourceArgs: () => ['--drive-root-folder-id', 'actual-folder-id', '--', 'cloud:'],
      spawn: jest.fn((exe, args, options) => {
        credentials = `Basic ${Buffer.from(`${options.env.RCLONE_USER}:${options.env.RCLONE_PASS}`).toString('base64')}`;
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = jest.fn(() => { process.nextTick(() => child.emit('close', 1)); });
        // Installed rclone v1.74.3 startup diagnostic captured by the integration probe.
        process.nextTick(() => child.stderr.write(`NOTICE: HTTP Server started on [http://127.0.0.1:${upstream.address().port}/]\n`));
        return child;
      })
    };
    session = await transport.start(browser, 'cloud', '', [{ name: filename, size: 10 }]);
    browser.stream = session;
  });
  afterEach(async () => {
    session?.close();
    for (const cleanup of browser.stages) cleanup();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  test('forwards authenticated partial GET and HEAD, never forbidden requests', async () => {
    const url = `${session.directory}/${filename}`;
    const part = await fetch(url, { headers: { Range: 'bytes=3-6' } });
    expect(part.status).toBe(206); expect(part.headers.get('content-range')).toBe('bytes 3-6/10');
    expect(await part.text()).toBe('3456');
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('10'); expect(await head.text()).toBe('');
    const count = seen.length;
    for (const target of [session.directory, `${session.directory}/event.json`, `${session.directory}/%2e%2e`, `${session.directory}/${filename}?x=1`]) expect((await fetch(target)).status).toBe(404);
    expect((await fetch(url, { method: 'POST' })).status).toBe(405);
    expect(seen).toHaveLength(count);
    expect(seen.every(request => request.authorization === credentials)).toBe(true);
    const unauthenticated = await fetch(`http://127.0.0.1:${upstream.address().port}/${filename}`);
    expect(unauthenticated.status).toBe(401);
  });
  test('allows file-origin CORS and rejects foreign origins before contacting upstream', async () => {
    const url = `${session.directory}/${filename}`;
    const app = await fetch(url, { headers: { Origin: 'null' } });
    expect(app.status).toBe(200);
    expect(app.headers.get('access-control-allow-origin')).toBe('null');
    expect(await app.text()).toBe('0123456789');
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Range' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Range');
    const count = seen.length;
    for (const origin of ['https://example.com', 'http://127.0.0.1:12345']) {
      const foreign = await fetch(url, { headers: { Origin: origin } });
      expect(foreign.status).toBe(403);
      expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(seen).toHaveLength(count);
  });
  test('stages only selected registered sources and cleans idempotently', async () => {
    const url = `${session.directory}/${filename}`;
    await expect(transport.stage(browser, ['http://example.com/private'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(seen).toHaveLength(0);
    const staged = await transport.stage(browser, [url, url]);
    expect(staged.paths.size).toBe(1);
    expect(fs.readFileSync(staged.paths.get(url), 'utf8')).toBe('0123456789');
    staged.cleanup(); staged.cleanup();
    expect(fs.existsSync(staged.paths.get(url))).toBe(false);
    const controller = new AbortController(); controller.abort();
    await expect(transport.stage(browser, [url], { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(browser.stageDirectories.size).toBe(0);
  });
  test('transfer failure and mid-body cancellation never return partial paths', async () => {
    const url = `${session.directory}/${filename}`;
    mode = 'short';
    await expect(transport.stage(browser, [url])).rejects.toMatchObject({ code: 'REMOTE_ERROR' });
    expect(browser.stageDirectories.size).toBe(0);
    mode = 'hang';
    const controller = new AbortController();
    const operation = transport.stage(browser, [url], { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 30);
    try { await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' }); } finally { clearTimeout(timer); }
    expect(browser.stageDirectories.size).toBe(0);
  });
  test('pins startup logging to stderr NOTICE while preserving remote configuration', async () => {
    session.close();
    const overrides = {
      RCLONE_LOG_LEVEL: 'ERROR', RCLONE_LOG_FILE: path.join(temp, 'private.log'),
      RCLONE_USE_JSON_LOG: 'true', RCLONE_SYSLOG: 'true', RCLONE_LOG_SYSTEMD: 'true',
      RCLONE_LOG_FORMAT: 'json', RCLONE_CONFIG: path.join(temp, 'custom.conf'),
      RCLONE_CONFIG_CLOUD_TOKEN: 'private-remote-token'
    };
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    const spawn = browser.spawn.getMockImplementation();
    browser.spawn.mockImplementation((exe, args, options) => {
      expect(options.env).toMatchObject({
        RCLONE_LOG_LEVEL: 'NOTICE', RCLONE_LOG_FILE: '', RCLONE_USE_JSON_LOG: 'false',
        RCLONE_SYSLOG: 'false', RCLONE_LOG_SYSTEMD: 'false', RCLONE_LOG_FORMAT: '',
        RCLONE_CONFIG: overrides.RCLONE_CONFIG, RCLONE_CONFIG_CLOUD_TOKEN: overrides.RCLONE_CONFIG_CLOUD_TOKEN
      });
      return spawn(exe, args, options);
    });
    Object.assign(process.env, overrides);
    try {
      session = await transport.start(browser, 'cloud', '', [{ name: filename, size: 10 }]);
      expect(await (await fetch(`${session.directory}/${filename}`)).text()).toBe('0123456789');
      const child = browser.spawn.mock.results.at(-1).value;
      session.close();
      await new Promise(resolve => setImmediate(resolve));
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(browser.children.size).toBe(0);
      await expect(fetch(`${session.directory}/${filename}`)).rejects.toThrow();
      expect(process.env.RCLONE_LOG_LEVEL).toBe('ERROR');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  test('recognizes expired URL syntax but rejects arbitrary destinations without throwing', () => {
    expect(transport.isStreamPath(`${session.directory}/${filename}`)).toBe(true);
    expect(transport.isStreamPath(session.directory.replace(/:\d+\//, ':99999/'))).toBe(false);
    expect(transport.isStreamPath(session.directory.replace('127.0.0.1', 'localhost'))).toBe(false);
    session.close(); expect(transport.isStreamPath(session.directory)).toBe(true);
  });
});

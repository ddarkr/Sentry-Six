const fs = require('fs');
const path = require('path');
const http = require('http');
const { randomBytes } = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const fail = code => Object.assign(new Error(code === 'CANCELLED' ? 'Remote operation cancelled.' : code === 'EXPORT_LIMIT' ? 'Selected export exceeds the 2 GiB staging limit.' : 'Remote media could not be read safely.'), { code });
function isStreamPath(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/sentry-rclone\/[a-f0-9]{64}(?:\/(?:[A-Za-z0-9_.!~*'()-]|%[a-fA-F0-9]{2})+)?$/);
  return !!match && Number(match[1]) <= 65535;
}
async function start(browser, remote, folder, files) {
  const directory = await fs.promises.mkdtemp(path.join(browser.cacheParent, 'sentry-rclone-stream-'));
  let child, server, timer, settled = false, upstreamPort;
  const requests = new Set();
  const token = randomBytes(32).toString('hex');
  const user = randomBytes(24).toString('hex'), password = randomBytes(32).toString('hex');
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const session = {
    files: new Map(), closed: false,
    close() {
      if (session.closed) return;
      session.closed = true;
      clearTimeout(timer);
      for (const request of requests) request.destroy();
      server?.close(); server?.closeAllConnections();
      if (child) { browser.children.delete(child); child.kill('SIGKILL'); }
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* Retried by OS temporary directory cleanup. */ }
    }
  };
  browser.pendingStream = session;
  try {
    await fs.promises.chmod(directory, 0o700);
    const filter = path.join(directory, 'files');
    await fs.promises.writeFile(filter, files.map(file => file.name).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    if (browser.cancelled || browser.closed || session.closed) throw fail('CANCELLED');
    await new Promise((resolve, reject) => {
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      child = browser.spawn(browser.executable, ['serve', 'http', '--addr', '127.0.0.1:0', '--read-only', '--disable-zip', '--vfs-cache-mode', 'off', '--buffer-size', '0', '--vfs-read-chunk-size', '1Mi', '--vfs-read-chunk-size-limit', '1Mi', '--poll-interval', '0', '--files-from-raw', filter, ...browser.sourceArgs(remote, folder)], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env, RCLONE_ASK_PASSWORD: 'false', RCLONE_USER: user, RCLONE_PASS: password,
          // Readiness is a private stderr NOTICE, independent of the user's logging preferences.
          RCLONE_LOG_LEVEL: 'NOTICE', RCLONE_LOG_FILE: '', RCLONE_USE_JSON_LOG: 'false',
          RCLONE_SYSLOG: 'false', RCLONE_LOG_SYSTEMD: 'false', RCLONE_LOG_FORMAT: ''
        }
      });
      browser.children.add(child);
      child.stdout.resume();
      let tail = '';
      child.stderr.on('data', chunk => {
        tail = (tail + chunk.toString('utf8')).slice(-2048);
        const match = tail.match(/(?:HTTP Server started on|Serving on) \[?http:\/\/127\.0\.0\.1:(\d+)/i);
        if (match) { upstreamPort = Number(match[1]); finish(); tail = ''; }
      });
      child.once('error', error => finish(fail(error.code === 'ENOENT' ? 'NOT_INSTALLED' : 'REMOTE_ERROR')));
      child.once('close', () => { browser.children.delete(child); finish(fail(browser.cancelled || browser.closed ? 'CANCELLED' : 'REMOTE_ERROR')); session.close(); });
      timer = setTimeout(() => { finish(fail('TIMEOUT')); session.close(); }, Math.min(browser.timeoutMs, 30000));
    });
    if (session.closed || browser.cancelled || browser.closed) throw fail('CANCELLED');
    server = http.createServer((req, res) => {
      res.setHeader('Vary', 'Origin');
      if (req.headers.origin !== undefined && req.headers.origin !== 'null') { res.writeHead(403).end(); return; }
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
      const file = session.files.get(`http://127.0.0.1:${server.address()?.port}${req.url}`);
      if (session.closed || !file) { res.writeHead(404).end(); return; }
      if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD'); res.setHeader('Access-Control-Allow-Headers', 'Range'); res.writeHead(204).end(); return; }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range)) { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }).end(); return; }
      const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: `/${encodeURIComponent(file.name)}`, method: req.method, headers: { Authorization: authorization, ...(req.headers.range ? { Range: req.headers.range } : {}) } }, response => {
        if (![200, 206, 416].includes(response.statusCode)) { response.destroy(); res.writeHead(502).end(); return; }
        if (response.statusCode === 416) { response.destroy(); res.writeHead(416, { 'Content-Range': `bytes */${file.size}`, 'Content-Length': '0' }).end(); return; }
        const length = Number(response.headers['content-length']);
        const range = response.headers['content-range'];
        const parsed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range || '');
        const validRange = parsed && Number(parsed[3]) === file.size && Number(parsed[1]) <= Number(parsed[2]) && Number(parsed[2]) < file.size && Number(parsed[2]) - Number(parsed[1]) + 1 === length;
        if (response.statusCode !== 416 && (!Number.isSafeInteger(length) || length < 0 || length > file.size || (response.statusCode === 200 && length !== file.size) || (response.statusCode === 206 && !validRange))) { response.destroy(); res.writeHead(502).end(); return; }
        const headers = {};
        for (const key of ['content-length', 'content-range', 'content-type', 'accept-ranges']) if (response.headers[key] !== undefined) headers[key] = response.headers[key];
        res.writeHead(response.statusCode, headers);
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      requests.add(upstream);
      upstream.setTimeout(browser.timeoutMs, () => upstream.destroy());
      upstream.once('close', () => requests.delete(upstream));
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      upstream.end();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (session.closed || browser.cancelled || browser.closed) throw fail('CANCELLED');
    session.directory = `http://127.0.0.1:${server.address().port}/sentry-rclone/${token}`;
    for (const file of files) session.files.set(`${session.directory}/${encodeURIComponent(file.name)}`, file);
    browser.children.delete(child);
    browser.pendingStream = null;
    return session;
  } catch (error) { session.close(); if (browser.pendingStream === session) browser.pendingStream = null; throw fail(error.code || 'REMOTE_ERROR'); }
}
async function stage(browser, urls, { signal } = {}) {
  if (!Array.isArray(urls)) throw fail('INVALID_INPUT');
  const session = browser.stream;
  const selected = [...new Set(urls)];
  if (signal?.aborted || browser.closed) throw fail('CANCELLED');
  let total = 0;
  for (const url of selected) {
    const file = session?.files.get(url);
    if (!file || session.closed) throw fail('INVALID_INPUT');
    total += file.size;
    if (!Number.isSafeInteger(total) || total > browser.maxBytes) throw fail('EXPORT_LIMIT');
  }
  const directory = await fs.promises.mkdtemp(path.join(browser.cacheParent, 'sentry-rclone-export-')).catch(() => { throw fail('PERMISSION'); });
  browser.stageDirectories.add(directory);
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; fs.rmSync(directory, { recursive: true, force: true }); cleaned = true; browser.stages.delete(cleanup); browser.stageDirectories.delete(directory); };
  browser.stages.add(cleanup);
  try {
    await fs.promises.chmod(directory, 0o700);
    const disk = await fs.promises.statfs(directory);
    if (disk.bavail * disk.bsize < total + 128 * 1024 ** 2) throw fail('PERMISSION');
    const paths = new Map();
    for (let index = 0; index < selected.length; index++) {
      if (signal?.aborted || browser.closed || session.closed || cleaned) throw fail('CANCELLED');
      const url = selected[index], file = session.files.get(url);
      const local = path.join(directory, `${index}-${file.name}`);
      await new Promise((resolve, reject) => {
        const request = http.get(url, { signal }, async response => {
          try {
            if (response.statusCode !== 200 || Number(response.headers['content-length']) !== file.size) throw fail('REMOTE_ERROR');
            let received = 0;
            const limiter = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; callback(received > file.size ? fail('REMOTE_ERROR') : null, chunk); } });
            await pipeline(response, limiter, fs.createWriteStream(local, { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode: 0o600 }), ...(signal ? [{ signal }] : []));
            if (received !== file.size) throw fail('REMOTE_ERROR');
            resolve();
          } catch (error) { response.destroy(); reject(error); }
        });
        request.once('error', reject);
        request.setTimeout(browser.timeoutMs, () => request.destroy(fail('TIMEOUT')));
      });
      paths.set(url, local);
    }
    if (signal?.aborted || session?.closed || browser.closed || cleaned) throw fail('CANCELLED');
    return { paths, cleanup };
  } catch (error) { cleanup(); throw fail(signal?.aborted || error.name === 'AbortError' ? 'CANCELLED' : error.code === 'TIMEOUT' ? 'TIMEOUT' : error.code === 'PERMISSION' ? 'PERMISSION' : 'REMOTE_ERROR'); }
}
module.exports = { start, stage, isStreamPath };

// Read-only CLI adapter. No RC server, renderer credentials, or shell commands.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { pathToFileURL } = require('url');
const CLIP = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/i;
function safeName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    !/[\\/:\x00-\x1f<>"|?*]/.test(value) && value !== '.' && value !== '..' && !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function validatePath(value) {
  if (typeof value !== 'string' || value.length > 4096 || (value && !value.split('/').every(safeName))) throw new Error('Unsupported remote folder path.');
  return value;
}
class RcloneBrowser {
  constructor({ cacheParent, spawnProcess = spawn, maxBytes = 2 * 1024 ** 3, timeoutMs = 600000 }) {
    Object.assign(this, { cacheParent, spawn: spawnProcess, maxBytes, timeoutMs });
    this.remotes = new Set(); this.children = new Set(); this.bytes = 0;
  }
  async exclusive(fn) {
    if (this.closed) throw new Error('Remote browser is closed.');
    if (this.busy) throw new Error('A remote operation is already running. Cancel it or wait.');
    this.busy = true; this.cancelled = false;
    let finish;
    this.idle = new Promise(resolve => { finish = resolve; });
    try { return await fn(); } finally {
      this.busy = false;
      if (this.closed) this.cleanup();
      finish();
    }
  }
  target(remote, folder) {
    if (!this.remotes.has(remote)) throw new Error('Choose a configured remote first.');
    return `${remote}:${validatePath(folder)}`;
  }
  command(args, onData) {
    if (this.cancelled || this.closed) return Promise.reject(new Error('Remote operation cancelled.'));
    return new Promise((resolve, reject) => {
      const child = this.spawn('rclone', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.add(child);
      let failure;
      const timer = setTimeout(() => { failure = new Error('Remote operation timed out.'); child.kill('SIGKILL'); }, this.timeoutMs);
      child.stderr.resume(); // Backend stderr can contain credentials or signed URLs; do not log/return it.
      const output = Promise.resolve().then(() => onData(child.stdout)).catch(error => { failure = error; child.kill('SIGKILL'); });
      child.once('error', error => {
        failure = new Error(error.code === 'ENOENT'
          ? 'rclone was not found. Install rclone yourself and configure a remote on this computer, then restart Sentry Studio. GUI apps need rclone on their PATH.'
          : 'Could not start rclone. Check its installation and permissions.');
      });
      child.once('close', async code => {
        clearTimeout(timer); this.children.delete(child); await output;
        if (this.cancelled || this.closed) reject(new Error('Remote operation cancelled.'));
        else if (failure) reject(failure);
        else if (code !== 0) reject(new Error('rclone could not read this remote. Check connectivity, credentials, and folder access in rclone.'));
        else resolve();
      });
    });
  }
  async text(args) {
    const chunks = []; let bytes = 0;
    await this.command(args, async stream => {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 ** 2) throw new Error('Folder listing is too large. Choose a smaller folder.');
        chunks.push(chunk);
      }
    });
    return Buffer.concat(chunks).toString('utf8');
  }
  listRemotes() {
    return this.exclusive(async () => {
      const text = await this.text(['listremotes']);
      this.remotes = new Set(text.split(/\r?\n/).filter(Boolean).map(line => line.replace(/:$/, '')).filter(name => /^[A-Za-z0-9_][A-Za-z0-9 _.-]{1,127}$/.test(name)));
      return [...this.remotes].sort();
    });
  }
  async entries(remote, folder) {
    const text = await this.text(['lsjson', '--max-depth', '1', '--', this.target(remote, folder)]);
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('rclone returned an invalid folder listing.'); }
    if (!Array.isArray(result) || result.length > 10000) throw new Error('Unsupported remote listing.');
    const names = new Set();
    return result.map(entry => {
      if (!entry || !safeName(entry.Name) || entry.Path !== entry.Name || typeof entry.IsDir !== 'boolean') throw new Error('Remote contains unsupported file or folder names.');
      const key = entry.Name.toLowerCase();
      if (names.has(key)) throw new Error('Remote has duplicate filenames that cannot be safely cached.');
      names.add(key);
      return { name: entry.Name, isDirectory: entry.IsDir, size: entry.Size, playable: !entry.IsDir && CLIP.test(entry.Name) };
    });
  }
  list(remote, folder) { return this.exclusive(() => this.entries(remote, folder)); }
  materialize(remote, folder) {
    return this.exclusive(async () => {
      const entries = await this.entries(remote, folder);
      const files = entries.filter(e => e.playable || (!e.isDirectory && /^(event\.json|event\.png|thumb\.png)$/i.test(e.name)));
      if (!files.some(e => e.playable)) throw new Error('Open a folder containing TeslaCam MP4 recordings first. Subfolders are not downloaded.');
      let total = 0;
      for (const file of files) {
        if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Remote did not provide a valid file size.');
        if (!file.playable && file.size > (/\.json$/i.test(file.name) ? 1024 ** 2 : 16 * 1024 ** 2)) throw new Error('Remote event metadata is too large to open safely.');
        total += file.size;
      }
      if (total > this.maxBytes - this.bytes) throw new Error('The 2 GiB session cache limit would be exceeded. Choose a smaller recording folder or restart the app.');
      if (!this.root) {
        this.root = await fs.promises.mkdtemp(path.join(this.cacheParent, 'sentry-rclone-'));
        await fs.promises.chmod(this.root, 0o700);
      }
      const disk = await fs.promises.statfs(this.root);
      if (disk.bavail * disk.bsize < total + 128 * 1024 ** 2) throw new Error('Not enough free disk space for this recording folder.');
      if (this.cancelled || this.closed) throw new Error('Remote operation cancelled.');
      const directory = await fs.promises.mkdtemp(path.join(this.root, 'recording-'));
      try {
        // Keep TeslaCam event structure so existing metadata/markers still attach.
        const parts = folder.split('/');
        const eventId = parts.at(-1);
        const category = /^(sentryclips|savedclips)$/i.test(parts.at(-2) || '')
          ? (/^sentry/i.test(parts.at(-2)) ? 'SentryClips' : 'SavedClips') : null;
        const downloadDirectory = category && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(eventId)
          ? path.join(directory, category, eventId) : directory;
        await fs.promises.mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
        for (const file of files) {
          let received = 0;
          const limiter = new Transform({ transform(chunk, encoding, callback) {
            received += chunk.length;
            callback(received > file.size ? new Error('Remote file changed size during download. Try again.') : null, chunk);
          } });
          const output = fs.createWriteStream(path.join(downloadDirectory, file.name), { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode: 0o600 });
          const transfer = pipeline(limiter, output); transfer.catch(() => {});
          try {
            await this.command(['cat', '--max-depth', '1', '--', this.target(remote, folder ? `${folder}/${file.name}` : file.name)], async input => {
              await pipeline(input, limiter); await transfer;
            });
            await transfer;
          } catch (error) { limiter.destroy(); await transfer.catch(() => {}); throw error; }
          if (received !== file.size) throw new Error('Remote file changed size during download. Try again.');
        }
        if (this.cancelled || this.closed) throw new Error('Remote operation cancelled.');
        this.bytes += total;
        return { directory, source: { kind: 'rclone', remote, folder }, fileCount: files.filter(e => e.playable).length };
      } catch (error) { await fs.promises.rm(directory, { recursive: true, force: true }); throw error; }
    });
  }
  cancel() { this.cancelled = true; for (const child of this.children) child.kill('SIGKILL'); }
  containsCachePath(value) {
    if (!this.root || typeof value !== 'string') return false;
    try {
      const relative = path.relative(fs.realpathSync(this.root), fs.realpathSync(value));
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    } catch { return false; }
  }
  cleanup() {
    if (this.root) {
      try { fs.rmSync(this.root, { recursive: true, force: true }); } catch { /* OS temp cleanup is a fallback if removal is denied. */ }
    }
  }
  dispose() {
    this.closed = true; this.cancel();
    if (!this.busy) this.cleanup();
  }
}
function registerRcloneIpc({ ipcMain, app, getMainWindow }) {
  const browser = new RcloneBrowser({ cacheParent: app.getPath('temp') });
  const invoke = fn => async (event, ...args) => {
    const window = getMainWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== pathToFileURL(path.join(__dirname, '../renderer/index.html')).href) throw new Error('Untrusted remote browser request.');
    return fn(...args);
  };
  ipcMain.handle('rclone:remotes', invoke(() => browser.listRemotes()));
  ipcMain.handle('rclone:list', invoke((remote, folder) => browser.list(remote, folder)));
  ipcMain.handle('rclone:open', invoke((remote, folder) => browser.materialize(remote, folder)));
  ipcMain.handle('rclone:cancel', invoke(() => browser.cancel()));
  app.on('before-quit', () => browser.cancel());
  app.on('will-quit', event => {
    browser.dispose();
    if (browser.busy) {
      event.preventDefault();
      browser.idle.then(() => app.quit());
    }
  });
  return browser;
}
module.exports = { RcloneBrowser, registerRcloneIpc, safeName, validatePath };

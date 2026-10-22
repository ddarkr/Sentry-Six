// Read-only recordings plus explicit local connection configuration. No RC server or shell.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { pathToFileURL } = require('url');
const { RcloneConfig } = require('./rcloneConfig');
const ERROR_MESSAGES = {
  NOT_INSTALLED: 'rclone was not found. Select its executable or install rclone.',
  AUTH_REQUIRED: 'This connection needs browser authentication again.',
  INVALID_CLIENT: 'Check the Client ID and Client secret for your Google Cloud Desktop app.',
  NETWORK: 'The storage service could not be reached. Check the network connection.',
  RATE_LIMIT: 'The storage service is limiting requests. Wait a moment and try again; signing in again is not required.',
  DUPLICATE_FILES: 'This folder contains recording or event files with conflicting names and cannot be downloaded safely.',
  PERMISSION: 'Access was denied. Check folder access and local configuration permissions.',
  CONFIG_LOCKED: 'The rclone configuration is locked or cannot be edited by this app.',
  CONFIG_CONFLICT: 'The rclone configuration changed during sign-in. Please try again.',
  UNSUPPORTED: 'This configuration step or rclone version is not supported.',
  INVALID_INPUT: 'The requested connection or configuration value is invalid.',
  BUSY: 'A remote operation is already running. Cancel it or wait.',
  CANCELLED: 'Remote operation cancelled.',
  TIMEOUT: 'Remote operation timed out.',
  REMOTE_ERROR: 'rclone could not read this remote. Check connectivity, credentials, and folder access in rclone.'
};
function commandError(code) {
  return Object.assign(new Error(ERROR_MESSAGES[code]), { code });
}
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
  constructor({ cacheParent, spawnProcess = spawn, maxBytes = 2 * 1024 ** 3, timeoutMs = 600000, executable = 'rclone' }) {
    Object.assign(this, { cacheParent, spawn: spawnProcess, maxBytes, timeoutMs, executable });
    this.remotes = new Set(); this.remoteTypes = new Map(); this.folders = new Map();
    this.children = new Set(); this.bytes = 0;
  }
  async exclusive(fn) {
    if (this.closed) throw commandError('CANCELLED');
    if (this.busy) throw commandError('BUSY');
    this.busy = true; this.cancelled = false;
    let finish;
    this.idle = new Promise(resolve => { finish = resolve; });
    try { return await fn(); } finally {
      this.busy = false;
      if (this.closed) this.cleanup();
      finish();
    }
  }
  folderContext(remote, folder) {
    if (!this.remotes.has(remote)) throw new Error('Choose a configured remote first.');
    if (folder === '') return { remote, parts: [], id: null };
    const context = typeof folder === 'string' && this.folders.get(folder);
    if (!context || context.remote !== remote) throw commandError('INVALID_INPUT');
    return context;
  }
  sourceArgs(remote, folder, filename = '') {
    const context = this.folderContext(remote, folder);
    if (filename && !safeName(filename)) throw commandError('INVALID_INPUT');
    const relative = context.id ? filename : validatePath([...context.parts, ...(filename ? [filename] : [])].join('/'));
    return [...(context.id ? ['--drive-root-folder-id', context.id] : []), '--', `${remote}:${relative}`];
  }
  command(args, onData, options = {}) {
    if (this.cancelled || this.closed) return Promise.reject(commandError('CANCELLED'));
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.executable, args, {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...(options.env ?? process.env), RCLONE_ASK_PASSWORD: 'false' }
      });
      this.children.add(child);
      let failure, diagnosticTail = '';
      const diagnostics = new Set();
      const timer = setTimeout(() => { failure = commandError(diagnostics.has('RATE_LIMIT') ? 'RATE_LIMIT' : 'TIMEOUT'); child.kill('SIGKILL'); }, options.timeoutMs ?? this.timeoutMs);
      // Classify a bounded rolling window only. Never return or log backend stderr.
      child.stderr.on('data', chunk => {
        const text = diagnosticTail + chunk.toString('utf8');
        if (/invalid_grant|invalid_token|empty token found|token.{0,40}(expired|revoked)|unauthenticated|401 unauthorized|googleapi: Error 401\b/i.test(text)) diagnostics.add('AUTH_REQUIRED');
        if (/invalid_client|unauthorized_client|deleted_client|redirect_uri_mismatch/i.test(text)) diagnostics.add('INVALID_CLIENT');
        if (/config.{0,50}(encrypted|password)|failed to decrypt|unable to decrypt/i.test(text)) diagnostics.add('CONFIG_LOCKED');
        if (/rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|downloadQuotaExceeded|quotaExceeded|429 Too Many Requests|googleapi: Error 429\b/i.test(text)) diagnostics.add('RATE_LIMIT');
        if (/permission denied|access denied|insufficient.{0,20}permission|403 forbidden|googleapi: Error 403\b/i.test(text)) diagnostics.add('PERMISSION');
        if (/no such host|network is unreachable|connection refused|dial tcp|TLS handshake timeout|i\/o timeout/i.test(text)) diagnostics.add('NETWORK');
        if (/unknown flag|unknown command/i.test(text)) diagnostics.add('UNSUPPORTED');
        diagnosticTail = text.slice(-1024);
      });
      const output = Promise.resolve().then(() => onData(child.stdout)).catch(error => { failure = error; child.kill('SIGKILL'); });
      child.once('error', error => {
        failure = commandError(error.code === 'ENOENT' ? 'NOT_INSTALLED' : error.code === 'EACCES' ? 'PERMISSION' : 'REMOTE_ERROR');
      });
      child.once('close', async code => {
        clearTimeout(timer); this.children.delete(child); await output;
        diagnosticTail = '';
        if (this.cancelled || this.closed) reject(commandError('CANCELLED'));
        else if (failure) reject(failure);
        else if (code !== 0) reject(commandError(['CONFIG_LOCKED', 'INVALID_CLIENT', 'AUTH_REQUIRED', 'RATE_LIMIT', 'PERMISSION', 'NETWORK', 'UNSUPPORTED'].find(value => diagnostics.has(value)) || 'REMOTE_ERROR'));
        else resolve();
      });
    });
  }
  async text(args, options) {
    const chunks = []; let bytes = 0;
    await this.command(args, async stream => {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 ** 2) throw new Error('Folder listing is too large. Choose a smaller folder.');
        chunks.push(chunk);
      }
    }, options);
    return Buffer.concat(chunks).toString('utf8');
  }
  listRemotes() {
    return this.exclusive(async () => {
      let rows;
      try { rows = JSON.parse(await this.text(['listremotes', '--json'])); } catch (error) {
        if (error instanceof SyntaxError) throw commandError('UNSUPPORTED');
        throw error;
      }
      if (!Array.isArray(rows)) throw commandError('UNSUPPORTED');
      this.remoteTypes = new Map(rows.filter(row => row && typeof row.name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9 _.-]{1,127}$/.test(row.name) && typeof row.type === 'string').map(row => [row.name, row.type]));
      this.remotes = new Set(this.remoteTypes.keys()); this.folders.clear();
      return [...this.remotes].sort();
    });
  }
  async entries(remote, folder) {
    const context = this.folderContext(remote, folder);
    const drive = this.remoteTypes.get(remote) === 'drive';
    const text = await this.text(['lsjson', '--low-level-retries', '5', '--max-depth', '1', ...this.sourceArgs(remote, folder)], { timeoutMs: 120000 });
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('rclone returned an invalid folder listing.'); }
    if (!Array.isArray(result) || result.length > 10000) throw new Error('Unsupported remote listing.');
    if (!drive) {
      const directories = new Set();
      for (const entry of result) {
        if (!entry?.IsDir) continue;
        if (directories.has(entry.Name)) throw commandError('UNSUPPORTED');
        directories.add(entry.Name);
      }
    }
    return result.map(entry => {
      if (!entry || typeof entry.Name !== 'string' || !entry.Name || entry.Path !== entry.Name || typeof entry.IsDir !== 'boolean') throw commandError('REMOTE_ERROR');
      const result = { name: entry.Name, isDirectory: entry.IsDir, size: entry.Size, playable: !entry.IsDir && CLIP.test(entry.Name) };
      if (entry.IsDir) {
        if (drive ? typeof entry.ID !== 'string' || !/^[A-Za-z0-9_-]{1,256}(?:\t[A-Za-z0-9_-]{1,256})?$/.test(entry.ID) : !safeName(entry.Name)) throw commandError('UNSUPPORTED');
        // rclone represents shortcuts as target ID + tab + shortcut ID.
        const id = drive ? entry.ID.split('\t')[0] : null;
        result.folder = createHash('sha256').update(JSON.stringify([remote, folder, drive ? entry.ID : entry.Name])).digest('hex');
        if (drive) result.id = entry.ID.split('\t').at(-1);
        this.folders.set(result.folder, { remote, parts: [...context.parts, entry.Name], id });
      }
      return result;
    });
  }
  list(remote, folder) { return this.exclusive(() => this.entries(remote, folder)); }
  materialize(remote, folder) {
    return this.exclusive(async () => {
      const entries = await this.entries(remote, folder);
      const files = entries.filter(e => e.playable || (!e.isDirectory && /^(event\.json|event\.png|thumb\.png)$/i.test(e.name)));
      if (!files.some(e => e.playable)) throw new Error('Open a folder containing TeslaCam MP4 recordings first. Subfolders are not downloaded.');
      const names = new Set();
      for (const file of files) {
        if (!safeName(file.name)) throw commandError('INVALID_INPUT');
        const key = file.name.toLowerCase();
        if (names.has(key)) throw commandError('DUPLICATE_FILES');
        names.add(key);
      }
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
        const parts = this.folderContext(remote, folder).parts;
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
            await this.command(['cat', '--max-depth', '1', ...this.sourceArgs(remote, folder, file.name)], async input => {
              await pipeline(input, limiter); await transfer;
            });
            await transfer;
          } catch (error) { limiter.destroy(); await transfer.catch(() => {}); throw error; }
          if (received !== file.size) throw new Error('Remote file changed size during download. Try again.');
        }
        if (this.cancelled || this.closed) throw new Error('Remote operation cancelled.');
        this.bytes += total;
        return { directory, source: { kind: 'rclone', remote, folder: parts.join('/') }, fileCount: files.filter(e => e.playable).length };
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
    this.folders.clear();
    if (!this.busy) this.cleanup();
  }
}
function registerRcloneIpc({ ipcMain, app, getMainWindow, executable = 'rclone' }) {
  const browser = new RcloneBrowser({ cacheParent: app.getPath('temp'), executable });
  const config = new RcloneConfig(browser, { cacheParent: app.getPath('temp') });
  let choosingExecutable = false;
  const invoke = (fn, browsing = false) => async (event, ...args) => {
    const window = getMainWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== pathToFileURL(path.join(__dirname, '../renderer/index.html')).href) throw new Error('Untrusted remote browser request.');
    try {
      if (browsing && (config.active || choosingExecutable)) throw commandError('BUSY');
      const pending = fn(...args);
      args.length = 0;
      return { ok: true, data: (await pending) ?? null };
    } catch (error) {
      const code = Object.hasOwn(ERROR_MESSAGES, error.code) ? error.code : 'REMOTE_ERROR';
      return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
    }
  };
  ipcMain.handle('rclone:remotes', invoke(() => browser.listRemotes(), true));
  ipcMain.handle('rclone:list', invoke((remote, folder) => browser.list(remote, folder), true));
  ipcMain.handle('rclone:open', invoke((remote, folder) => browser.materialize(remote, folder), true));
  ipcMain.handle('rclone:cancel', invoke(() => { if (!config.active) browser.cancel(); }));
  ipcMain.handle('rclone:status', invoke(() => config.status(), true));
  ipcMain.handle('rclone:check', invoke(remote => config.check(remote), true));
  ipcMain.handle('rclone:configure', invoke(request => config.configure(request), true));
  ipcMain.handle('rclone:configContinue', invoke(request => config.continue(request)));
  ipcMain.handle('rclone:configCancel', invoke(() => config.cancel()));
  ipcMain.handle('rclone:chooseExecutable', invoke(async () => {
    if (browser.busy) throw commandError('BUSY');
    choosingExecutable = true;
    const previous = browser.executable;
    try {
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog(getMainWindow(), { title: 'Choose rclone executable', properties: ['openFile'] });
      if (result.canceled || !result.filePaths[0]) return null;
      const selected = result.filePaths[0];
      if (!(await fs.promises.stat(selected)).isFile()) throw commandError('INVALID_INPUT');
      await fs.promises.access(selected, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      browser.executable = selected;
      const status = await config.status();
      if (!status.installed) throw commandError('NOT_INSTALLED');
      const { loadSettings, saveSettings } = require('./settings');
      if (!saveSettings({ ...loadSettings(), rcloneExecutable: selected })) throw commandError('PERMISSION');
      browser.remotes.clear();
      return status;
    } catch (error) {
      browser.executable = previous;
      throw error;
    } finally { choosingExecutable = false; }
  }, true));
  let stopping = false, stopped = false;
  app.on('before-quit', event => {
    if (stopped) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    browser.cancel();
    Promise.resolve(config.dispose()).catch(() => {
      console.warn('[RCLONE] Could not remove configuration staging files.');
    }).then(async () => {
      browser.dispose();
      await browser.idle;
      stopped = true;
      app.quit();
    });
  });
  return browser;
}
module.exports = { RcloneBrowser, registerRcloneIpc, safeName, validatePath };

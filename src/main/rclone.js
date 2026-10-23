// Read-only recordings plus explicit local connection configuration. No RC server or shell.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');
const streamTransport = require('./rcloneStream');
const { pathToFileURL } = require('url');
const { RcloneConfig } = require('./rcloneConfig');
const ERROR_MESSAGES = {
  NOT_INSTALLED: 'rclone was not found. Select its executable or install rclone.',
  AUTH_REQUIRED: 'This connection needs browser authentication again.',
  INVALID_CLIENT: 'Check the Client ID and Client secret for your Google Cloud Desktop app.',
  NETWORK: 'The storage service could not be reached. Check the network connection.',
  RATE_LIMIT: 'The storage service is limiting requests. Wait a moment and try again; signing in again is not required.',
  DUPLICATE_FILES: 'Same-name recording or event files could not be verified as identical and cannot be streamed safely.',
  PERMISSION: 'Access was denied. Check folder access and local configuration permissions.',
  CONFIG_LOCKED: 'The rclone configuration is locked or cannot be edited by this app.',
  CONFIG_CONFLICT: 'The rclone configuration changed during sign-in. Please try again.',
  UNSUPPORTED: 'This configuration step or rclone version is not supported.',
  INVALID_INPUT: 'The requested connection or configuration value is invalid.',
  BUSY: 'A remote operation is already running. Cancel it or wait.',
  CANCELLED: 'Remote operation cancelled.',
  TIMEOUT: 'Remote operation timed out.',
  EXPORT_LIMIT: 'Selected export exceeds the 2 GiB staging limit.',
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
    this.children = new Set(); this.stages = new Set(); this.stageDirectories = new Set();
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
  async entries(remote, folder, includeHashes = false) {
    const context = this.folderContext(remote, folder);
    const drive = this.remoteTypes.get(remote) === 'drive';
    // Drive supplies stored checksums; do not hash/download files on other backends.
    const text = await this.text(['lsjson', '--low-level-retries', '5', '--max-depth', '1', ...(drive && includeHashes ? ['--hash-type', 'MD5'] : []), ...this.sourceArgs(remote, folder)], { timeoutMs: 120000 });
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
      if (drive && includeHashes && typeof entry.Hashes?.md5 === 'string' && /^[a-f0-9]{32}$/i.test(entry.Hashes.md5)) {
        result.md5 = entry.Hashes.md5.toLowerCase();
      }
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
  open(remote, folder) {
    return this.exclusive(async () => {
      const entries = await this.entries(remote, folder, true);
      const candidates = entries.filter(e => e.playable || (!e.isDirectory && /^(event\.json|event\.png|thumb\.png)$/i.test(e.name)));
      if (!candidates.some(e => e.playable)) throw commandError('INVALID_INPUT');
      const names = new Map(), files = [];
      for (const file of candidates) {
        if (!safeName(file.name)) throw commandError('INVALID_INPUT');
        if (!Number.isSafeInteger(file.size) || file.size < 0) throw commandError('REMOTE_ERROR');
        if (!file.playable && file.size > (/\.json$/i.test(file.name) ? 1024 ** 2 : 16 * 1024 ** 2)) throw commandError('INVALID_INPUT');
        const key = file.name.toLowerCase();
        const previous = names.get(key);
        if (previous) {
          if (!file.md5 || file.md5 !== previous.md5 || file.size !== previous.size) throw commandError('DUPLICATE_FILES');
          continue;
        }
        names.set(key, file);
        files.push(file);
      }
      const session = await streamTransport.start(this, remote, folder, files);
      this.stream?.close();
      this.stream = session;
      return {
        directory: session.directory,
        source: { kind: 'rclone', remote, folder: this.folderContext(remote, folder).parts.join('/') },
        files: [...session.files].map(([url, file]) => ({ name: file.name, path: url, size: file.size, isFile: true, isDirectory: false })),
        fileCount: files.filter(file => file.playable).length
      };
    });
  }
  openDriveData(remote, folder) {
    return this.exclusive(async () => {
      this.driveStream?.close();
      const candidates = (await this.entries(remote, folder, true))
        .filter(file => !file.isDirectory && /^drive-data\.json$/i.test(file.name));
      if (!candidates.length) throw commandError('INVALID_INPUT');
      const file = candidates[0];
      for (const candidate of candidates) {
        if (!Number.isSafeInteger(candidate.size) || candidate.size <= 0) throw commandError('REMOTE_ERROR');
        if (candidate !== file && (!file.md5 || candidate.md5 !== file.md5 || candidate.size !== file.size)) {
          throw commandError('DUPLICATE_FILES');
        }
      }
      const session = await streamTransport.start(this, remote, folder, [file]);
      this.driveStream = session;
      return { path: session.files.keys().next().value, size: file.size,
        source: { kind: 'rclone', remote, folder: this.folderContext(remote, folder).parts.join('/') } };
    });
  }
  getDriveDataSource(value) {
    return !this.driveStream?.closed && this.driveStream?.files.get(value) || null;
  }
  isStreamPath(value) { return streamTransport.isStreamPath(value); }
  stageForExport(paths, options) { return streamTransport.stage(this, paths, options); }
  cancel(release = false) {
    this.cancelled = true;
    this.pendingStream?.close();
    this.driveStream?.close();
    if (release || this.closed) this.stream?.close();
    for (const child of this.children) child.kill('SIGKILL');
  }
  containsCachePath(value) {
    if (this.isStreamPath(value)) return true;
    if (typeof value !== 'string') return false;
    try {
      const target = fs.realpathSync(value);
      return [...this.stageDirectories].some(directory => {
        const relative = path.relative(fs.realpathSync(directory), target);
        return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
      });
    } catch { return false; }
  }
  cleanup() {
    this.stream?.close();
    this.driveStream?.close();
    for (const cleanup of [...this.stages]) cleanup();
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
  ipcMain.handle('rclone:open', invoke((remote, folder) => browser.open(remote, folder), true));
  ipcMain.handle('rclone:openDriveData', invoke((remote, folder) => browser.openDriveData(remote, folder), true));
  ipcMain.handle('rclone:cancel', invoke((release = false) => {
    if (typeof release !== 'boolean') throw commandError('INVALID_INPUT');
    if (!config.active) browser.cancel(release);
    else if (release) browser.stream?.close();
  }));
  ipcMain.handle('rclone:status', invoke(() => config.status(), true));
  ipcMain.handle('rclone:check', invoke(remote => config.check(remote), true));
  ipcMain.handle('rclone:configure', invoke(request => { browser.stream?.close(); browser.driveStream?.close(); return config.configure(request); }, true));
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
      browser.stream?.close();
      browser.driveStream?.close();
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

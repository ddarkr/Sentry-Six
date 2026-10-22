const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const MESSAGES = {
  INVALID_INPUT: 'Invalid cloud connection request.', BUSY: 'A cloud operation is already running.',
  CANCELLED: 'Cloud configuration cancelled.', TIMEOUT: 'Cloud configuration timed out.',
  CONFIG_LOCKED: 'This configuration cannot be safely edited. Use rclone to manage it.',
  CONFIG_CONFLICT: 'The configuration changed. Start again.', UNSUPPORTED: 'This configuration step is not supported.',
  PERMISSION: 'Configuration access was denied.', REMOTE_ERROR: 'The cloud operation failed.',
  NOT_INSTALLED: 'rclone is not installed.', AUTH_REQUIRED: 'Cloud authentication is required.', NETWORK: 'The cloud connection failed.'
};
const failure = code => Object.assign(new Error(MESSAGES[code] || MESSAGES.REMOTE_ERROR), { code: MESSAGES[code] ? code : 'REMOTE_ERROR' });
const validName = name => typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9 _.-]{1,127}$/.test(name) && !/[. ]$/.test(name);
const safeLabel = value => typeof value === 'string' && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);
function json(text) { try { return JSON.parse(text); } catch { throw failure('UNSUPPORTED'); } }
function snapshot(filename) {
  try {
    const stat = fs.lstatSync(filename, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !(Number(stat.mode) & 0o222) || stat.size > BigInt(4 * 1024 ** 2)) throw failure('CONFIG_LOCKED');
    const bytes = fs.readFileSync(filename);
    if (bytes.length > 4 * 1024 ** 2 || bytes.includes(Buffer.from('RCLONE_ENCRYPT_V'))) throw failure('CONFIG_LOCKED');
    return { bytes, revision: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') };
  } catch (error) { if (error.code === 'ENOENT') return { bytes: Buffer.alloc(0), revision: null }; throw error; }
}
class RcloneConfig {
  constructor(browser, { cacheParent }) { this.browser = browser; this.cacheParent = cacheParent; this.idle = Promise.resolve(); }
  run(fn) {
    if (this.closed) return Promise.reject(failure('CANCELLED'));
    if (this.browser.busy) return Promise.reject(failure('BUSY'));
    const operation = this.browser.exclusive(async () => {
      try { return await fn(); } catch (error) {
        if (this.active?.cancelled) error = failure(this.active.timedOut ? 'TIMEOUT' : 'CANCELLED');
        if (this.active) await this.cleanup(this.active);
        throw failure(['EACCES', 'EPERM', 'EROFS'].includes(error.code) ? 'PERMISSION' : error.code);
      }
    });
    this.idle = operation.catch(() => {});
    return operation;
  }
  async text(args, options) {
    const configArgs = options?.env?.RCLONE_CONFIG ? ['--config', options.env.RCLONE_CONFIG] : [];
    try { return await this.browser.text(['--ask-password=false', ...configArgs, ...args], options); }
    catch (error) { throw failure(error.code); }
  }
  async metadata(options) {
    const rows = json(await this.text(['listremotes', '--json'], options));
    if (!Array.isArray(rows)) throw failure('UNSUPPORTED');
    return rows.filter(row => validName(row.name) && typeof row.type === 'string' && ['file', 'environment'].includes(row.source))
      .map(row => ({ name: row.name, type: /^[a-z0-9_ -]{1,64}$/i.test(row.type) ? row.type : '', source: row.source, canReconnect: row.type === 'drive' && row.source === 'file' }));
  }
  status() {
    if (this.active) return Promise.reject(failure('BUSY'));
    return this.run(async () => {
      let version;
      try { version = json(await this.text(['rc', '--loopback', 'core/version'])).version; }
      catch (error) { if (error.code === 'NOT_INSTALLED') return { installed: false, version: '', executable: this.browser.executable || 'rclone', remotes: [] }; throw error; }
      return { installed: true, version: /^v[0-9][0-9A-Za-z.+-]{0,63}$/.test(version) ? version : '', executable: this.browser.executable || 'rclone', remotes: await this.metadata() };
    });
  }
  async probe(name, options) {
    const result = json(await this.text(['lsjson', '--max-depth', '1', '--dirs-only', '--', `${name}:`], { ...options, timeoutMs: 30000 }));
    if (!Array.isArray(result)) throw failure('REMOTE_ERROR');
  }
  check(name) {
    if (this.active) return Promise.reject(failure('BUSY'));
    return this.run(async () => {
      if (!validName(name) || !(await this.metadata()).some(row => row.name === name)) throw failure('INVALID_INPUT');
      await this.probe(name); return { remote: name, connected: true };
    });
  }
  assertActive(session) {
    if (session.cancelled || this.closed || this.active !== session) throw failure(session.timedOut ? 'TIMEOUT' : 'CANCELLED');
  }
  configure(request) {
    if (this.closed) return Promise.reject(failure('CANCELLED'));
    if (this.active || this.browser.busy) return Promise.reject(failure('BUSY'));
    if (!request || !['create', 'reconnect'].includes(request.mode) || !validName(request.name)) return Promise.reject(failure('INVALID_INPUT'));
    // Reserve before any asynchronous work, so cancellation also covers filesystem preparation.
    const session = { id: randomBytes(24).toString('hex'), name: request.name, mode: request.mode, cancelled: false };
    this.active = session;
    session.timer = setTimeout(() => { session.timedOut = true; this.cancel().catch(() => {}); }, 600000);
    session.timer.unref?.();
    return this.run(async () => {
      const paths = json(await this.text(['rc', '--loopback', 'config/paths'])); this.assertActive(session);
      if (typeof paths.config !== 'string' || !path.isAbsolute(paths.config) || paths.config === '/dev/null') throw failure('CONFIG_LOCKED');
      session.filename = paths.config;
      session.original = snapshot(session.filename);
      const remotes = await this.metadata(); this.assertActive(session);
      const matches = remotes.filter(row => row.name.toLowerCase() === session.name.toLowerCase());
      if (session.mode === 'create' ? matches.length > 0 : matches.length !== 1 || matches[0].name !== session.name) throw failure('INVALID_INPUT');
      if (session.mode === 'reconnect' && !matches[0].canReconnect) throw failure('CONFIG_LOCKED');
      let ancestor = path.dirname(session.filename);
      while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
      fs.accessSync(ancestor, fs.constants.W_OK);
      session.directory = fs.mkdtempSync(path.join(this.cacheParent, 'sentry-rclone-config-'));
      fs.chmodSync(session.directory, 0o700);
      session.staged = path.join(session.directory, 'rclone.conf');
      fs.writeFileSync(session.staged, session.original.bytes, { mode: 0o600, flag: 'wx' });
      session.options = { env: { ...process.env, RCLONE_CONFIG: session.staged }, timeoutMs: 600000 };
      // Reject environment overrides of a file remote: otherwise verification could target a different account.
      // rclone ConfigToEnv uppercases the section verbatim; only option names normalize hyphens.
      const prefix = `RCLONE_CONFIG_${session.name.toUpperCase()}_`;
      if (Object.keys(process.env).some(key => key.toUpperCase().startsWith(prefix) || key.toUpperCase().startsWith('RCLONE_DRIVE_'))) throw failure('CONFIG_LOCKED');
      this.assertActive(session);
      const args = session.mode === 'create'
        ? ['config', 'create', session.name, 'drive', 'scope', 'drive.readonly', '--non-interactive']
        : ['config', 'update', session.name, '--non-interactive'];
      return this.advance(session, args);
    });
  }
  continue(request) {
    const session = this.active;
    if (!session || !request || request.sessionId !== session.id || typeof request.value !== 'string' || !session.question || !session.question.choices.some(choice => choice.value === request.value)) return Promise.reject(failure('INVALID_INPUT'));
    return this.run(() => { this.assertActive(session); session.question = null; return this.advance(session, this.answerArgs(session, request.value)); });
  }
  answerArgs(session, value) { return ['config', 'update', session.name, '--non-interactive', '--continue', '--state', session.state, '--result', value]; }
  async advance(session, args) {
    for (let count = 0; count < 20; count++) {
      this.assertActive(session);
      const output = json(await this.text(args, session.options)); this.assertActive(session);
      if (output.Error || typeof output.State !== 'string') throw failure('AUTH_REQUIRED');
      if (!output.State) {
        const remotes = await this.metadata(session.options); this.assertActive(session);
        if (!remotes.some(remote => remote.name === session.name && remote.type === 'drive' && remote.source === 'file')) throw failure('UNSUPPORTED');
        await this.probe(session.name, session.options); this.assertActive(session);
        this.commit(session);
        const result = { sessionId: session.id, remote: session.name, done: true };
        await this.cleanup(session); return result;
      }
      session.state = output.State;
      const option = output.Option;
      if (!option || option.IsPassword) throw failure('UNSUPPORTED');
      if (['config_is_local', 'config_refresh_token'].includes(option.Name)) { args = this.answerArgs(session, 'true'); continue; }
      if (session.mode === 'reconnect' && option.Name === 'config_change_team_drive') { args = this.answerArgs(session, 'false'); continue; }
      let question;
      if (session.mode === 'create' && option.Name === 'config_change_team_drive') {
        question = { name: option.Name, label: 'Use a Shared Drive?', type: 'bool', defaultValue: 'false', choices: [{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes' }] };
      } else if (session.mode === 'create' && option.Name === 'config_team_drive' && Array.isArray(option.Examples) && option.Examples.length <= 10000) {
        const choices = option.Examples.map(example => {
          if (!/^[A-Za-z0-9_-]{1,256}$/.test(example.Value) || !safeLabel(example.Help)) throw failure('UNSUPPORTED');
          return { value: example.Value, label: example.Help };
        });
        if (!choices.length) throw failure('UNSUPPORTED');
        question = { name: option.Name, label: 'Shared Drive', type: 'select', defaultValue: choices.some(choice => choice.value === option.Default) ? option.Default : choices[0].value, choices };
      } else throw failure('UNSUPPORTED');
      session.question = question;
      return { sessionId: session.id, remote: session.name, done: false, question };
    }
    throw failure('UNSUPPORTED');
  }
  commit(session) {
    // Synchronous final compare + rename prevents cancellation interleaving after verification.
    this.assertActive(session);
    const current = snapshot(session.filename);
    if (current.revision !== session.original.revision || !current.bytes.equals(session.original.bytes)) throw failure('CONFIG_CONFLICT');
    const bytes = snapshot(session.staged).bytes;
    let directory;
    try {
      fs.mkdirSync(path.dirname(session.filename), { recursive: true, mode: 0o700 });
      directory = fs.mkdtempSync(path.join(path.dirname(session.filename), '.sentry-rclone-'));
      fs.chmodSync(directory, 0o700);
      const candidate = path.join(directory, 'rclone.conf');
      fs.writeFileSync(candidate, bytes, { mode: 0o600, flag: 'wx' });
      const latest = snapshot(session.filename);
      if (latest.revision !== current.revision || !latest.bytes.equals(current.bytes)) throw failure('CONFIG_CONFLICT');
      this.assertActive(session);
      fs.renameSync(candidate, session.filename);
    } finally { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
  }
  async cleanup(session) {
    clearTimeout(session.timer);
    try {
      if (session.directory) await fs.promises.rm(session.directory, { recursive: true, force: true });
    } catch { throw failure('PERMISSION'); }
    finally {
      session.state = null; session.original = null; session.options = null;
      if (this.active === session) this.active = null;
    }
  }
  cancel() {
    const session = this.active;
    if (!session) return Promise.resolve(null);
    session.cancelled = true; this.browser.cancel();
    const previous = this.idle;
    const operation = (async () => {
      await previous;
      if (this.active === session) await this.cleanup(session);
      return null;
    })();
    this.idle = operation.catch(() => {});
    return operation;
  }
  dispose() { this.closed = true; return this.cancel(); }
}
module.exports = { RcloneConfig };

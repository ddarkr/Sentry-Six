const fs = require('fs');
const os = require('os');
const path = require('path');
const { RcloneConfig } = require('../../src/main/rcloneConfig');

const done = { State: '', Option: null, Error: '' };
const question = (Name, extra = {}) => ({ State: 'opaque-secret-state', Option: { Name, IsPassword: false, ...extra }, Error: '' });
describe('transactional cloud configuration', () => {
  let temp, filename, original, browser, config, calls, replies, remotes, probe;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-config-test-'));
    filename = path.join(temp, 'rclone.conf');
    original = '[old]\ntype = drive\nscope = drive.readonly\nclient_id = private-id\nclient_secret = private-secret\nroot_folder_id = root\nteam_drive = team\ntoken = old-token\n\n[other]\ntype = local\n';
    fs.writeFileSync(filename, original, { mode: 0o600 });
    calls = []; replies = []; remotes = [{ name: 'old', type: 'drive', source: 'file' }];
    probe = async () => [];
    browser = {
      executable: '/isolated/rclone', busy: false,
      async exclusive(fn) { if (this.busy) throw Object.assign(new Error('busy'), { code: 'BUSY' }); this.busy = true; try { return await fn(); } finally { this.busy = false; } },
      cancel: jest.fn(),
      async text(args, options) {
        calls.push({ args, options });
        if (args.includes('listremotes')) {
          if (!options?.env?.RCLONE_CONFIG) return JSON.stringify(remotes);
          const content = fs.readFileSync(options.env.RCLONE_CONFIG, 'utf8');
          const sections = [...content.matchAll(/^\[([^\]]+)\]\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)];
          return JSON.stringify(sections.map(section => ({ name: section[1], type: /^type\s*=\s*(\w+)/m.exec(section[2])?.[1] || '', source: 'file' })));
        }
        if (args.includes('config/paths')) return JSON.stringify({ config: filename });
        if (args.includes('core/version')) return JSON.stringify({ version: 'v1.74.3' });
        if (args.includes('lsjson')) return JSON.stringify(await probe(options));
        if (args.includes('config')) {
          if (args.includes('create')) {
            const name = args[args.indexOf('create') + 1];
            fs.appendFileSync(options.env.RCLONE_CONFIG, `\n[${name}]\ntype = drive\nscope = drive.readonly\n`);
          }
          const next = replies.shift();
          if (typeof next === 'function') return JSON.stringify(await next(args, options));
          return JSON.stringify(next || done);
        }
        throw new Error('unexpected fixture command');
      }
    };
    config = new RcloneConfig(browser, { cacheParent: temp });
  });
  afterEach(async () => { await config.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  test('cancellation preserves original and removes private staging', async () => {
    replies.push(question('config_change_team_drive'));
    const result = await config.configure({ mode: 'create', name: 'new' });
    const directory = config.active.directory;
    expect(fs.statSync(config.active.staged).mode & 0o777).toBe(0o600);
    await config.cancel();
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
    expect(fs.existsSync(directory)).toBe(false);
    await expect(config.continue({ sessionId: result.sessionId, value: 'false' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  test.each(['OLD', 'old'])('rejects duplicate create %s including case conflicts', async name => {
    await expect(config.configure({ mode: 'create', name })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls.some(call => call.args.includes('config'))).toBe(false);
  });
  test('rejects environment remotes without writing config', async () => {
    remotes = [{ name: 'ENV', type: 'drive', source: 'environment' }];
    await expect(config.configure({ mode: 'create', name: 'env' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(config.configure({ mode: 'reconnect', name: 'ENV' })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
  });
  test('rejects forged session without destroying the real pending question', async () => {
    replies.push(question('config_change_team_drive'));
    const result = await config.configure({ mode: 'create', name: 'new' });
    await expect(config.continue({ sessionId: 'forged', value: 'true' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(config.active.id).toBe(result.sessionId);
  });
  test('external config edits are never overwritten', async () => {
    replies.push(async (args, options) => { fs.appendFileSync(options.env.RCLONE_CONFIG, '\n[new]\ntype = drive\ntoken = new-secret\n'); return done; });
    probe = async () => { fs.appendFileSync(filename, '\n[external]\ntype = local\n'); return []; };
    await expect(config.configure({ mode: 'create', name: 'new' })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
    expect(fs.readFileSync(filename, 'utf8')).toBe(original + '\n[external]\ntype = local\n');
  });
  test('reconnect preserves all existing settings and verifies before commit', async () => {
    replies.push(question('config_refresh_token'), question('config_is_local'), question('config_change_team_drive'), async (args, options) => {
      expect(args[args.indexOf('--result') + 1]).toBe('false');
      const content = fs.readFileSync(options.env.RCLONE_CONFIG, 'utf8');
      expect(content).toBe(original);
      fs.writeFileSync(options.env.RCLONE_CONFIG, content.replace('old-token', 'new-token'));
      return done;
    });
    probe = async options => { expect(fs.readFileSync(filename, 'utf8')).toBe(original); expect(fs.readFileSync(options.env.RCLONE_CONFIG, 'utf8')).toContain('new-token'); return []; };
    const result = await config.configure({ mode: 'reconnect', name: 'old' });
    expect(result.done).toBe(true);
    expect(fs.readFileSync(filename, 'utf8')).toBe(original.replace('old-token', 'new-token'));
  });
  test('failed verification does not commit and hides raw error secrets', async () => {
    probe = async () => { throw new Error('private-secret token=very-secret'); };
    const error = await config.configure({ mode: 'create', name: 'new' }).catch(error => error);
    expect(error.code).toBe('REMOTE_ERROR');
    expect(error.message).not.toMatch(/private-secret|very-secret/);
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
  });
  test('only safe question fields escape and manual token questions fail closed', async () => {
    replies.push(question('config_team_drive', { Help: 'private-secret', Default: 'team', Examples: [{ Value: 'team', Help: 'Shared recordings' }], Token: 'secret' }));
    const result = await config.configure({ mode: 'create', name: 'new' });
    expect(JSON.stringify(result)).not.toMatch(/opaque-secret|private-secret|Token/);
    expect(result.question.choices).toEqual([{ value: 'team', label: 'Shared recordings' }]);
    await config.cancel();
    replies.push(question('config_token'));
    await expect(config.configure({ mode: 'create', name: 'new' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
  test('cancel after a process returns still prevents commit', async () => {
    let returned;
    const reached = new Promise(resolve => { returned = resolve; });
    let release;
    probe = async () => { returned(); await new Promise(resolve => { release = resolve; }); return []; };
    const operation = config.configure({ mode: 'create', name: 'new' });
    await reached;
    const cancelled = config.cancel(); release();
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' }); await cancelled;
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
  });
  test.each(['RCLONE_DRIVE_SCOPE', 'RCLONE_CONFIG_NEW_TOKEN'])('rejects ambient override %s', async key => {
    const previous = process.env[key];
    process.env[key] = 'private-secret';
    try {
      await expect(config.configure({ mode: 'create', name: 'new' })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
      expect(fs.readFileSync(filename, 'utf8')).toBe(original);
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  });
  test('rejects one-character names and omits them from status', async () => {
    await expect(config.configure({ mode: 'create', name: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    remotes.push({ name: 'x', type: 'drive', source: 'file' });
    expect((await config.status()).remotes.map(remote => remote.name)).toEqual(['old']);
  });
  test('creates missing config parent only after successful verification', async () => {
    filename = path.join(temp, 'fresh', 'nested', 'rclone.conf');
    remotes = [];
    probe = async () => { expect(fs.existsSync(path.dirname(filename))).toBe(false); return []; };
    await config.configure({ mode: 'create', name: 'new' });
    expect(fs.readFileSync(filename, 'utf8')).toContain('[new]');
  });
  test('malformed successful auth cannot commit a missing remote', async () => {
    replies.push(async (args, options) => { fs.writeFileSync(options.env.RCLONE_CONFIG, original); return done; });
    await expect(config.configure({ mode: 'create', name: 'new' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(calls.some(call => call.args.includes('lsjson'))).toBe(false);
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
  });
  test('rejects oversized config before reading its contents', async () => {
    fs.truncateSync(filename, 4 * 1024 ** 2 + 1);
    const read = jest.spyOn(fs, 'readFileSync');
    try {
      await expect(config.configure({ mode: 'create', name: 'new' })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
  test.each(['google drive', 'google-drive', 'google.drive'])('uses upstream verbatim section env mapping for %s', async name => {
    const key = `RCLONE_CONFIG_${name.toUpperCase()}_TOKEN`;
    const previous = process.env[key];
    process.env[key] = 'private-secret';
    try {
      await expect(config.configure({ mode: 'create', name })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  });
  test.each(['symlink', 'encrypted', 'readonly'])('rejects %s configs', async kind => {
    if (kind === 'symlink') { const target = path.join(temp, 'target'); fs.renameSync(filename, target); fs.symlinkSync(target, filename); }
    if (kind === 'encrypted') fs.writeFileSync(filename, 'RCLONE_ENCRYPT_V0:\nprivate-secret');
    if (kind === 'readonly') fs.chmodSync(filename, 0o400);
    await expect(config.configure({ mode: 'create', name: 'new' })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
  });
  test('status exposes safe metadata and selected executable only', async () => {
    remotes[0].description = 'private-secret'; remotes[0].token = 'private-token';
    const status = await config.status();
    expect(status.executable).toBe('/isolated/rclone');
    expect(JSON.stringify(status)).not.toContain('private');
    expect(status.remotes[0].canReconnect).toBe(true);
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { RcloneConfig } = require('../../src/main/rcloneConfig');

const done = { State: '', Option: null, Error: '' };
const question = (Name, extra = {}) => ({ State: 'opaque-secret-state', Option: { Name, IsPassword: false, ...extra }, Error: '' });
const oauth = { clientId: '123-sentryfixture.apps.googleusercontent.com', clientSecret: 'GOCSPX-private-fixture-secret' };
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
      executable: '/isolated/rclone', busy: false, remotes: new Set(['old', 'other']),
      folders: new Map(),
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
          const next = replies.shift();
          if (typeof next === 'function') return JSON.stringify(await next(args, options));
          if (args.includes('delete')) {
            const name = args[args.indexOf('delete') + 1];
            const content = fs.readFileSync(options.env.RCLONE_CONFIG, 'utf8');
            fs.writeFileSync(options.env.RCLONE_CONFIG, content.split(/(?=^\[)/m).filter(section => !section.startsWith(`[${name}]\n`)).join(''));
            return '';
          }
          return JSON.stringify(next || done);
        }
        throw new Error('unexpected fixture command');
      }
    };
    config = new RcloneConfig(browser, { cacheParent: temp });
  });
  afterEach(async () => { await config.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  test.each([
    undefined, null, { clientId: oauth.clientId }, { ...oauth, clientId: 123 },
    { ...oauth, clientId: 'not-a-google-client' },
    { ...oauth, clientSecret: 'secret\n[other]\ntype = drive' },
    { ...oauth, clientSecret: 'x'.repeat(513) }
  ])('rejects missing or unsafe OAuth credentials before starting configuration', async value => {
    await expect(config.configure({ mode: 'create', name: 'new', oauth: value })).rejects.toMatchObject({ code: 'INVALID_CLIENT' });
    expect(calls).toEqual([]);
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
  });
  test('new personal credentials stay out of argv, environment and public results', async () => {
    probe = async options => {
      expect(fs.readFileSync(filename, 'utf8')).toBe(original);
      expect(fs.readFileSync(options.env.RCLONE_CONFIG, 'utf8')).toContain(`client_secret = ${oauth.clientSecret}`);
      return [];
    };
    const result = await config.configure({ mode: 'create', name: 'new', oauth });
    expect(result).toMatchObject({ done: true, remote: 'new' });
    expect(JSON.stringify(result)).not.toContain(oauth.clientSecret);
    expect(calls.some(call => call.args.some(arg => arg.includes(oauth.clientSecret) || arg.includes(oauth.clientId)))).toBe(false);
    expect(calls.some(call => Object.values(call.options?.env || {}).includes(oauth.clientSecret))).toBe(false);
    expect(fs.readFileSync(filename, 'utf8')).toContain(`client_id = ${oauth.clientId}`);
    expect(fs.readdirSync(temp)).toEqual(['rclone.conf']);
  });
  test('failed personal-client switching preserves the existing connection byte-for-byte', async () => {
    probe = async () => { throw Object.assign(new Error('private-fixture-secret'), { code: 'INVALID_CLIENT' }); };
    const error = await config.configure({ mode: 'reconnect', name: 'old', oauth }).catch(error => error);
    expect(error.code).toBe('INVALID_CLIENT');
    expect(error.message).not.toContain('private-fixture-secret');
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
    expect(fs.readdirSync(temp)).toEqual(['rclone.conf']);
  });
  test('provider client errors remain actionable without exposing the submitted credentials', async () => {
    replies.push({ ...done, Error: `invalid_client ${oauth.clientSecret}` });
    const error = await config.configure({ mode: 'reconnect', name: 'old', oauth }).catch(error => error);
    expect(error.code).toBe('INVALID_CLIENT');
    expect(error.message).not.toContain(oauth.clientSecret);
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
  });
  test('cancellation preserves original and removes private staging', async () => {
    replies.push(question('config_change_team_drive'));
    const result = await config.configure({ mode: 'create', oauth, name: 'new' });
    const directory = config.active.directory;
    expect(fs.statSync(config.active.staged).mode & 0o777).toBe(0o600);
    await config.cancel();
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
    expect(fs.existsSync(directory)).toBe(false);
    await expect(config.continue({ sessionId: result.sessionId, value: 'false' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  test.each(['OLD', 'old'])('rejects duplicate create %s including case conflicts', async name => {
    await expect(config.configure({ mode: 'create', oauth, name })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls.some(call => call.args.includes('config'))).toBe(false);
  });
  test('rejects environment remotes without writing config', async () => {
    remotes = [{ name: 'ENV', type: 'drive', source: 'environment' }];
    await expect(config.configure({ mode: 'create', oauth, name: 'env' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(config.configure({ mode: 'reconnect', name: 'ENV' })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
  });
  test('rejects forged session without destroying the real pending question', async () => {
    replies.push(question('config_change_team_drive'));
    const result = await config.configure({ mode: 'create', oauth, name: 'new' });
    await expect(config.continue({ sessionId: 'forged', value: 'true' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(config.active.id).toBe(result.sessionId);
  });
  test('external config edits are never overwritten', async () => {
    replies.push(async (args, options) => { fs.appendFileSync(options.env.RCLONE_CONFIG, '\n[new]\ntype = drive\ntoken = new-secret\n'); return done; });
    probe = async () => { fs.appendFileSync(filename, '\n[external]\ntype = local\n'); return []; };
    await expect(config.configure({ mode: 'create', oauth, name: 'new' })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
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
    const error = await config.configure({ mode: 'create', oauth, name: 'new' }).catch(error => error);
    expect(error.code).toBe('REMOTE_ERROR');
    expect(error.message).not.toMatch(/private-secret|very-secret/);
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
  });
  test('rate-limited verification reports the cause without publishing the draft', async () => {
    probe = async () => { throw Object.assign(new Error('private-token'), { code: 'RATE_LIMIT' }); };
    const error = await config.configure({ mode: 'create', oauth, name: 'new' }).catch(error => error);
    expect(error.code).toBe('RATE_LIMIT');
    expect(error.message).not.toContain('private-token');
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
    expect(config.active).toBeNull();
  });
  test('only safe question fields escape and manual token questions fail closed', async () => {
    replies.push(question('config_team_drive', { Help: 'private-secret', Default: 'team', Examples: [{ Value: 'team', Help: 'Shared recordings' }], Token: 'secret' }));
    const result = await config.configure({ mode: 'create', oauth, name: 'new' });
    expect(JSON.stringify(result)).not.toMatch(/opaque-secret|private-secret|Token/);
    expect(result.question.choices).toEqual([{ value: 'team', label: 'Shared recordings' }]);
    await config.cancel();
    replies.push(question('config_token'));
    await expect(config.configure({ mode: 'create', oauth, name: 'new' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
  test('cancel after a process returns still prevents commit', async () => {
    let returned;
    const reached = new Promise(resolve => { returned = resolve; });
    let release;
    probe = async () => { returned(); await new Promise(resolve => { release = resolve; }); return []; };
    const operation = config.configure({ mode: 'create', oauth, name: 'new' });
    await reached;
    const cancelled = config.cancel(); release();
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' }); await cancelled;
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
  });
  test.each(['RCLONE_DRIVE_SCOPE', 'RCLONE_CONFIG_NEW_TOKEN'])('rejects ambient override %s', async key => {
    const previous = process.env[key];
    process.env[key] = 'private-secret';
    try {
      await expect(config.configure({ mode: 'create', oauth, name: 'new' })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
      expect(fs.readFileSync(filename, 'utf8')).toBe(original);
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  });
  test('rejects one-character names and omits them from status', async () => {
    await expect(config.configure({ mode: 'create', oauth, name: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    remotes.push({ name: 'x', type: 'drive', source: 'file' });
    expect((await config.status()).remotes.map(remote => remote.name)).toEqual(['old']);
  });
  test('creates missing config parent only after successful verification', async () => {
    filename = path.join(temp, 'fresh', 'nested', 'rclone.conf');
    remotes = [];
    probe = async () => { expect(fs.existsSync(path.dirname(filename))).toBe(false); return []; };
    await config.configure({ mode: 'create', oauth, name: 'new' });
    expect(fs.readFileSync(filename, 'utf8')).toContain('[new]');
  });
  test('malformed successful auth cannot commit a missing remote', async () => {
    replies.push(async (args, options) => { fs.writeFileSync(options.env.RCLONE_CONFIG, original); return done; });
    await expect(config.configure({ mode: 'create', oauth, name: 'new' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(calls.some(call => call.args.includes('lsjson'))).toBe(false);
    expect(fs.readFileSync(filename, 'utf8')).toBe(original);
  });
  test('rejects oversized config before reading its contents', async () => {
    fs.truncateSync(filename, 4 * 1024 ** 2 + 1);
    const read = jest.spyOn(fs, 'readFileSync');
    try {
      await expect(config.configure({ mode: 'create', oauth, name: 'new' })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
  test.each(['google drive', 'google-drive', 'google.drive'])('uses upstream verbatim section env mapping for %s', async name => {
    const key = `RCLONE_CONFIG_${name.toUpperCase()}_TOKEN`;
    const previous = process.env[key];
    process.env[key] = 'private-secret';
    try {
      await expect(config.configure({ mode: 'create', oauth, name })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  });
  test.each(['symlink', 'encrypted', 'readonly'])('rejects %s configs', async kind => {
    if (kind === 'symlink') { const target = path.join(temp, 'target'); fs.renameSync(filename, target); fs.symlinkSync(target, filename); }
    if (kind === 'encrypted') fs.writeFileSync(filename, 'RCLONE_ENCRYPT_V0:\nprivate-secret');
    if (kind === 'readonly') fs.chmodSync(filename, 0o400);
    await expect(config.configure({ mode: 'create', oauth, name: 'new' })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
  });
  test('status exposes safe metadata and selected executable only', async () => {
    remotes[0].description = 'private-secret'; remotes[0].token = 'private-token';
    const status = await config.status();
    expect(status.executable).toBe('/isolated/rclone');
    expect(JSON.stringify(status)).not.toContain('private');
    expect(status.remotes[0].canReconnect).toBe(true);
  });
  describe('connection removal', () => {
    beforeEach(() => { remotes.push({ name: 'other', type: 'local', source: 'file' }); });
    test.each(['old', 'other'])('removes only %s without contacting cloud storage', async name => {
      probe = async () => { throw new Error('Cloud access must not be needed to remove a connection'); };
      const expected = original.split(/(?=^\[)/m).filter(section => !section.startsWith(`[${name}]\n`)).join('');
      const result = await config.configure({ mode: 'remove', name });
      expect(result).toMatchObject({ done: true, remote: name });
      expect(fs.readFileSync(filename, 'utf8')).toBe(expected);
      expect(browser.remotes.has(name)).toBe(false);
      expect(calls.some(call => call.args.includes('lsjson'))).toBe(false);
      expect(fs.readdirSync(temp)).toEqual(['rclone.conf']);
    });
    test.each(['missing', 'OLD', '../old'])('rejects unconfigured or invalid target %s', async name => {
      await expect(config.configure({ mode: 'remove', name })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(fs.readFileSync(filename, 'utf8')).toBe(original);
    });
    test('does not remove environment-managed connections', async () => {
      remotes[0].source = 'environment';
      await expect(config.configure({ mode: 'remove', name: 'old' })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
      expect(fs.readFileSync(filename, 'utf8')).toBe(original);
    });
    test('does not remove a file connection overridden by environment credentials', async () => {
      const key = 'RCLONE_CONFIG_OLD_TOKEN';
      const previous = process.env[key];
      process.env[key] = 'private-secret';
      try {
        await expect(config.configure({ mode: 'remove', name: 'old' })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
        expect(fs.readFileSync(filename, 'utf8')).toBe(original);
      } finally {
        if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
      }
    });
    test.each(['unchanged', 'lost-other', 'failed'])('preserves config when delete is %s', async outcome => {
      replies.push(async (args, options) => {
        if (outcome === 'failed') throw Object.assign(new Error('private-secret'), { code: 'PERMISSION' });
        if (outcome === 'lost-other') fs.writeFileSync(options.env.RCLONE_CONFIG, '');
        return done;
      });
      await expect(config.configure({ mode: 'remove', name: 'old' })).rejects.toMatchObject({ code: outcome === 'failed' ? 'PERMISSION' : 'REMOTE_ERROR' });
      expect(fs.readFileSync(filename, 'utf8')).toBe(original);
      expect(browser.remotes.has('old')).toBe(true);
    });
    test('preserves concurrent external changes instead of publishing deletion', async () => {
      replies.push(async (args, options) => {
        fs.writeFileSync(options.env.RCLONE_CONFIG, '[other]\ntype = local\n');
        fs.appendFileSync(filename, '\n[external]\ntype = local\n');
        return done;
      });
      await expect(config.configure({ mode: 'remove', name: 'old' })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
      expect(fs.readFileSync(filename, 'utf8')).toBe(original + '\n[external]\ntype = local\n');
    });
    test('cancellation before publication preserves original and clears staging', async () => {
      let release, reached;
      const started = new Promise(resolve => { reached = resolve; });
      replies.push(async (args, options) => {
        fs.writeFileSync(options.env.RCLONE_CONFIG, '[other]\ntype = local\n');
        reached();
        await new Promise(resolve => { release = resolve; });
        return done;
      });
      const removal = config.configure({ mode: 'remove', name: 'old' });
      await started;
      const cancelled = config.cancel();
      release();
      await expect(removal).rejects.toMatchObject({ code: 'CANCELLED' });
      await cancelled;
      expect(fs.readFileSync(filename, 'utf8')).toBe(original);
      expect(fs.readdirSync(temp)).toEqual(['rclone.conf']);
    });
    test.each(['symlink', 'encrypted', 'readonly'])('does not edit %s configuration', async kind => {
      if (kind === 'symlink') { const target = path.join(temp, 'target'); fs.renameSync(filename, target); fs.symlinkSync(target, filename); }
      if (kind === 'encrypted') fs.writeFileSync(filename, 'RCLONE_ENCRYPT_V0:\nprivate-secret');
      if (kind === 'readonly') fs.chmodSync(filename, 0o400);
      const before = fs.readFileSync(filename);
      await expect(config.configure({ mode: 'remove', name: 'old' })).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
      expect(fs.readFileSync(filename)).toEqual(before);
    });
  });
});

describe('installed rclone personal OAuth staging', () => {
  const { spawn, spawnSync } = require('child_process');
  const { RcloneBrowser } = require('../../src/main/rclone');
  const installed = !spawnSync('rclone', ['version'], { stdio: 'ignore' }).error;
  (installed ? test.each : test.skip.each)(['create', 'reconnect'])('%s uses new client credentials without retaining the old token', async mode => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-oauth-native-'));
    const filename = path.join(temp, 'rclone.conf');
    const original = '[old]\ntype = drive\nscope = drive\nroot_folder_id = keep-root\nteam_drive = keep-team\ntoken = old-fixture-token\nclient_id = old-client\nclient_secret = old-secret\n\n[other]\ntype = local\n';
    fs.writeFileSync(filename, original, { mode: 0o600 });
    const name = mode === 'create' ? 'new' : 'old';
    const env = { PATH: process.env.PATH, HOME: temp, SYSTEMROOT: process.env.SYSTEMROOT };
    let observed;
    const browser = new RcloneBrowser({ cacheParent: temp, spawnProcess(executable, args, options) {
      expect(args.some(arg => arg.includes(oauth.clientSecret) || arg.includes(oauth.clientId))).toBe(false);
      if (args.includes('--continue')) {
        const staged = args[args.indexOf('--config') + 1];
        expect(staged.startsWith(temp + path.sep)).toBe(true);
        const dumped = spawnSync('rclone', ['--ask-password=false', '--config', staged, 'config', 'dump'], { env, encoding: 'utf8' });
        expect(dumped.status).toBe(0);
        observed = JSON.parse(dumped.stdout);
        // Stop before browser authentication; no Google request or user profile is used.
        throw Object.assign(new Error('fixture cancellation'), { code: 'CANCELLED' });
      }
      return spawn(executable, ['--config', filename, ...args], { ...options, env });
    } });
    const config = new RcloneConfig(browser, { cacheParent: temp });
    try {
      await expect(config.configure({ mode, name, oauth })).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(observed[name]).toMatchObject({
        type: 'drive', client_id: oauth.clientId, client_secret: oauth.clientSecret,
        token: '', env_auth: 'false', service_account_file: '', service_account_credentials: '',
        scope: mode === 'create' ? 'drive.readonly' : 'drive'
      });
      if (mode === 'reconnect') expect(observed[name]).toMatchObject({ root_folder_id: 'keep-root', team_drive: 'keep-team' });
      else expect(observed.old).toMatchObject({ token: 'old-fixture-token', client_id: 'old-client', root_folder_id: 'keep-root' });
      expect(observed.other).toEqual({ type: 'local' });
      expect(fs.readFileSync(filename, 'utf8')).toBe(original);
      expect(fs.readdirSync(temp)).toEqual(['rclone.conf']);
    } finally {
      await config.dispose(); browser.dispose();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

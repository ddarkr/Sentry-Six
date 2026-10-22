const fs = require('fs');
const vm = require('vm');
const path = require('path');

function matchesSelector(el, sel) {
  if (!sel || !el) return false;
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const inner = sel.slice(1, -1);
    const eqIdx = inner.indexOf('=');
    if (eqIdx !== -1) {
      const attr = inner.slice(0, eqIdx).trim();
      const rawVal = inner.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (attr.startsWith('data-')) {
        const dataKey = attr.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
        return el.dataset[dataKey] === rawVal;
      }
      return el.attributes[attr] === rawVal;
    }
    if (inner.startsWith('data-')) {
      const dataKey = inner.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
      return el.dataset[dataKey] !== undefined;
    }
    return el.attributes[inner] !== undefined;
  }
  return el.tag === sel;
}

function findDescendants(node, parts) {
  if (parts.length === 0) return [];
  const [head, ...tail] = parts;
  const matchingNodes = [];
  function collect(current) {
    for (const child of current.children) {
      if (matchesSelector(child, head)) {
        matchingNodes.push(child);
      }
      collect(child);
    }
  }
  collect(node);
  if (tail.length === 0) return matchingNodes;
  return matchingNodes.flatMap(matched => findDescendants(matched, tail));
}

class Element {
  constructor(tag, document) {
    this.tag = tag;
    this.ownerDocument = document;
    this.children = [];
    this.style = {};
    this.listeners = {};
    this.value = '';
    this.textContent = '';
    this.attributes = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.type = 'text';
    this.checked = false;
    const classes = new Set();
    this.classList = {
      _classes: classes,
      add: (...cls) => { cls.forEach(c => classes.add(c)); },
      remove: (...cls) => { cls.forEach(c => classes.delete(c)); },
      toggle: (cls, force) => {
        if (force === true) classes.add(cls);
        else if (force === false) classes.delete(cls);
        else if (classes.has(cls)) classes.delete(cls);
        else classes.add(cls);
      },
      contains: cls => classes.has(cls)
    };
  }
  get className() {
    return Array.from(this.classList._classes).join(' ');
  }
  set className(val) {
    this.classList._classes.clear();
    if (val) {
      val.trim().split(/\s+/).forEach(c => {
        if (c) this.classList._classes.add(c);
      });
    }
  }
  append(...items) {
    this.children.push(...items);
    if (this.tag === 'select' && !this.value) this.value = items[0]?.value || '';
  }
  appendChild(item) { this.append(item); return item; }
  replaceChildren(...items) {
    this.children = [];
    if (this.tag === 'select') this.value = '';
    this.textContent = '';
    this.append(...items);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    return findDescendants(this, parts);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  scrollIntoView() {}
  focus() { this.ownerDocument.activeElement = this; }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(initialStatus = null) {
  const document = { activeElement: null };
  document.createElement = tag => new Element(tag, document);
  document.createElementNS = (namespace, tag) => document.createElement(tag);
  document.body = document.createElement('body');
  document.getElementById = id => document.body.querySelector(`#${id}`);

  const container = document.createElement('div');
  container.id = 'rcloneSettingsContainer';
  document.body.append(container);

  const defaultStatus = initialStatus || {
    installed: true,
    version: 'v1.74.3',
    executable: '/usr/local/bin/rclone',
    remotes: [
      { name: 'gdrive-test', type: 'drive', source: 'file', canReconnect: true },
      { name: 'env-s3', type: 's3', source: 'environment', canReconnect: false }
    ]
  };

  const api = {
    rcloneStatus: jest.fn(async () => ({ ok: true, data: defaultStatus })),
    rcloneChooseExecutable: jest.fn(async () => ({ ok: true, data: defaultStatus })),
    rcloneCheck: jest.fn(async (name) => ({ ok: true, data: { remote: name, connected: true } })),
    rcloneConfigure: jest.fn(),
    rcloneConfigContinue: jest.fn(),
    rcloneConfigCancel: jest.fn(async () => ({ ok: true, data: null })),
    rcloneCancel: jest.fn(async () => ({ ok: true, data: null })),
    openExternal: jest.fn()
  };

  const translationsContext = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/data/translations.js'), 'utf8')
      .replace('export const translations =', 'globalThis.translations ='),
    translationsContext
  );

  const t = (key, params = {}) => {
    const value = key.split('.').reduce((node, part) => node?.[part], translationsContext.translations.en) ?? key;
    return typeof value === 'string' ? value.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) : key;
  };

  const onOpenRemoteFolder = jest.fn();
  const context = vm.createContext({
    document,
    window: { electronAPI: api },
    Set,
    Map,
    t,
    onLanguageChange: jest.fn(),
    CSS: { escape: s => s },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    console
  });

  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/scripts/features/rcloneSettings.js'), 'utf8')
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replaceAll('export function ', 'function ')
    .replaceAll('export async function ', 'async function ');

  vm.runInContext(source, context);
  context.initRcloneSettings({ onOpenRemoteFolder });
  context.onOpenRcloneSettings();

  return { context, document, api, container, onOpenRemoteFolder };
}

test('loads and displays rclone status and remotes on opening storage', async () => {
  const { api, container } = setup();
  await flush();

  expect(api.rcloneStatus).toHaveBeenCalled();
  const statusBadge = container.querySelector('.rclone-status-badge');
  expect(statusBadge.classList.contains('installed')).toBe(true);

  const remoteCards = container.querySelectorAll('.rclone-remote-card');
  expect(remoteCards.length).toBe(2);

  const gdriveCard = container.querySelector('[data-remote-name="gdrive-test"]');
  expect(gdriveCard).not.toBeNull();
  expect(gdriveCard.querySelector('.rclone-type-badge').textContent).toBe('drive');
  expect(gdriveCard.querySelector('.rclone-reconnect-btn')).not.toBeNull();

  const envCard = container.querySelector('[data-remote-name="env-s3"]');
  expect(envCard.querySelector('.rclone-source-badge').textContent).toBe('environment');
  expect(envCard.querySelector('.rclone-reconnect-btn')).toBeNull();
});

test('handles not installed state with install link and executable chooser', async () => {
  const notInstalledStatus = { installed: false, version: '', executable: '', remotes: [] };
  const { api, container } = setup(notInstalledStatus);
  await flush();

  const statusBadge = container.querySelector('.rclone-status-badge');
  expect(statusBadge.classList.contains('not-installed')).toBe(true);

  const installLink = container.querySelector('.rclone-install-link');
  expect(installLink).not.toBeNull();
  installLink.onclick({ preventDefault() {} });
  expect(api.openExternal).toHaveBeenCalledWith('https://rclone.org/install/');

  const chooseBtn = container.querySelector('.rclone-status-card .btn');
  expect(chooseBtn).not.toBeNull();
  chooseBtn.onclick();
  await flush();
  expect(api.rcloneChooseExecutable).toHaveBeenCalled();
});

test('checks connection for a remote and updates status indicator', async () => {
  const { api, container } = setup();
  await flush();

  const gdriveCard = container.querySelector('[data-remote-name="gdrive-test"]');
  const checkBtn = gdriveCard.querySelector('.rclone-check-btn');

  checkBtn.onclick();
  await flush();

  expect(api.rcloneCheck).toHaveBeenCalledWith('gdrive-test');
  const updatedBadge = container.querySelector('[data-remote-name="gdrive-test"] .rclone-status-badge');
  expect(updatedBadge.classList.contains('connected')).toBe(true);
});

test('Google Drive add form validates input and prevents invalid names', async () => {
  const { api, container } = setup();
  await flush();

  const input = container.querySelector('#rcloneDriveNameInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');
  const feedback = container.querySelector('#rcloneFormFeedback');

  input.value = '';
  submitBtn.onclick();
  await flush();
  expect(api.rcloneConfigure).not.toHaveBeenCalled();
  expect(feedback.textContent).not.toBe('');

  input.value = 'invalid/name:test';
  submitBtn.onclick();
  await flush();
  expect(api.rcloneConfigure).not.toHaveBeenCalled();
});

test('Google Drive create flow handles awaiting sign-in, questions, and done completion', async () => {
  const { api, container, context } = setup();
  await flush();

  const input = container.querySelector('#rcloneDriveNameInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');

  input.value = 'my-drive';
  api.rcloneConfigure.mockResolvedValueOnce({
    ok: true,
    data: {
      sessionId: 'sess-123',
      remote: 'my-drive',
      done: false,
      question: {
        name: 'config_team_drive',
        label: 'Team Drive?',
        type: 'bool',
        defaultValue: 'true'
      }
    }
  });

  api.rcloneConfigContinue.mockResolvedValueOnce({
    ok: true,
    data: {
      sessionId: 'sess-123',
      remote: 'my-drive',
      done: true
    }
  });

  submitBtn.onclick();
  await flush();

  expect(api.rcloneConfigure).toHaveBeenCalledWith({ mode: 'create', name: 'my-drive' });

  const authPanel = container.querySelector('#rcloneAuthPanel');
  expect(authPanel.classList.contains('hidden')).toBe(false);

  const continueBtn = authPanel.querySelectorAll('.btn-primary')[0];
  expect(continueBtn).toBeDefined();

  continueBtn.onclick();
  await flush();

  expect(api.rcloneConfigContinue).toHaveBeenCalledWith({
    sessionId: 'sess-123',
    value: 'true'
  });

  expect(context.getNewConfiguredRemoteThisVisit()).toBe('my-drive');
  const currentAuthPanel = container.querySelector('#rcloneAuthPanel');
  expect(currentAuthPanel.classList.contains('hidden')).toBe(true);
});

test('cancellation sends rcloneConfigCancel and resets auth panel without faking success', async () => {
  const { api, container, context } = setup();
  await flush();

  let resolveConfig;
  api.rcloneConfigure.mockReturnValueOnce(new Promise(r => { resolveConfig = r; }));

  const input = container.querySelector('#rcloneDriveNameInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');
  input.value = 'pending-drive';

  submitBtn.onclick();
  await flush();

  const authPanel = container.querySelector('#rcloneAuthPanel');
  expect(authPanel.classList.contains('hidden')).toBe(false);

  const cancelBtn = authPanel.querySelectorAll('.btn-secondary')[0];
  cancelBtn.onclick();
  await flush();

  expect(api.rcloneConfigCancel).toHaveBeenCalled();
  const currentAuthPanel = container.querySelector('#rcloneAuthPanel');
  expect(currentAuthPanel.classList.contains('hidden')).toBe(true);

  // Late resolution must be ignored
  resolveConfig({ ok: true, data: { sessionId: 'late', remote: 'pending-drive', done: true } });
  await flush();

  expect(context.getNewConfiguredRemoteThisVisit()).toBeNull();
});

test('cancel re-enables row actions after cleanup completes', async () => {
  const { api, container } = setup();
  await flush();

  let resolveCancel;
  api.rcloneConfigCancel.mockReturnValueOnce(new Promise(r => { resolveCancel = r; }));

  const input = container.querySelector('#rcloneDriveNameInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');
  input.value = 're-enable-test';

  api.rcloneConfigure.mockReturnValueOnce(new Promise(() => {}));
  submitBtn.onclick();
  await flush();

  const initialCheckBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-check-btn');
  expect(initialCheckBtn.disabled).toBe(true);

  const authPanel = container.querySelector('#rcloneAuthPanel');
  const cancelBtn = authPanel.querySelectorAll('.btn-secondary')[0];
  cancelBtn.onclick();
  await flush();

  // Still disabled while cancel is awaiting backend
  const midCheckBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-check-btn');
  expect(midCheckBtn.disabled).toBe(true);

  // Backend cancel resolves
  resolveCancel({ ok: true, data: null });
  await flush();

  // Row actions must now be re-enabled after render
  const finalCheckBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-check-btn');
  expect(finalCheckBtn.disabled).toBe(false);
});

test('closing settings modal cancels pending configure session', async () => {
  const { api, container, context } = setup();
  await flush();

  api.rcloneConfigure.mockReturnValueOnce(new Promise(() => {}));

  const input = container.querySelector('#rcloneDriveNameInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');
  input.value = 'cancel-on-close';

  submitBtn.onclick();
  await flush();

  await context.cancelConfigSession();
  await flush();

  expect(api.rcloneConfigCancel).toHaveBeenCalled();
  const authPanel = container.querySelector('#rcloneAuthPanel');
  expect(authPanel.classList.contains('hidden')).toBe(true);
});

test('open folder button triggers onOpenRemoteFolder callback', async () => {
  const { container, onOpenRemoteFolder } = setup();
  await flush();

  const gdriveCard = container.querySelector('[data-remote-name="gdrive-test"]');
  const openBtn = gdriveCard.querySelector('.rclone-open-btn');

  openBtn.onclick();
  await flush();

  expect(onOpenRemoteFolder).toHaveBeenCalledWith('gdrive-test');
});

test('close during pending read awaits cleanup and late read cannot mark connected', async () => {
  let resolveCheck;
  const pendingCheck = new Promise(r => { resolveCheck = r; });
  const { context, api, container } = setup();
  await flush();

  api.rcloneCheck.mockReturnValueOnce(pendingCheck);
  const checkBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-check-btn');
  checkBtn.onclick();
  await flush();

  // Close settings while check is pending
  const closePromise = context.onCloseRcloneSettings();
  expect(api.rcloneCancel).toHaveBeenCalled();

  resolveCheck({ ok: true, data: { remote: 'gdrive-test', connected: true } });
  await closePromise;
  await flush();

  // Re-open in a fresh visit
  context.onOpenRcloneSettings();
  await flush();

  // Stale check must not have corrupted state
  const badge = container.querySelector('[data-remote-name="gdrive-test"] .rclone-status-badge');
  expect(badge.classList.contains('connected')).toBe(false);
});

test('close while delayed check then reopen leaves check/open controls usable and no stale connected state', async () => {
  let resolveCheck;
  const pendingCheck = new Promise(r => { resolveCheck = r; });
  const { context, api, container } = setup();
  await flush();

  api.rcloneCheck.mockReturnValueOnce(pendingCheck);
  const checkBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-check-btn');
  checkBtn.onclick();
  await flush();

  // Close while check is in flight
  const closePromise = context.onCloseRcloneSettings();
  expect(api.rcloneCancel).toHaveBeenCalled();

  resolveCheck({ ok: true, data: { remote: 'gdrive-test', connected: true } });
  await closePromise;
  await flush();

  // Reopen settings
  await context.onOpenRcloneSettings();
  await flush();

  // Controls must be usable and not stuck in checking or connected
  const gdriveCard = container.querySelector('[data-remote-name="gdrive-test"]');
  const reopenedCheckBtn = gdriveCard.querySelector('.rclone-check-btn');
  const reopenedOpenBtn = gdriveCard.querySelector('.rclone-open-btn');
  const statusBadge = gdriveCard.querySelector('.rclone-status-badge');

  expect(reopenedCheckBtn.disabled).toBe(false);
  expect(reopenedOpenBtn.disabled).toBe(false);
  expect(statusBadge.classList.contains('connected')).toBe(false);
  expect(statusBadge.classList.contains('checking')).toBe(false);
});

test('Storage revisit while auth pending neither reloads status nor loses auth panel/draft/this-visit remote', async () => {
  const { api, container, context } = setup();
  await flush();

  const input = container.querySelector('#rcloneDriveNameInput');
  input.value = 'persistent-draft';
  input.oninput();

  let resolveConfig;
  api.rcloneConfigure.mockReturnValueOnce(new Promise(r => { resolveConfig = r; }));
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');
  submitBtn.onclick();
  await flush();

  const initialStatusCalls = api.rcloneStatus.mock.calls.length;

  // Revisit Storage while auth is active
  await context.onOpenRcloneSettings('gdrive-test');
  await flush();

  // Must not reload status
  expect(api.rcloneStatus.mock.calls.length).toBe(initialStatusCalls);

  // Auth panel and draft name must be preserved
  expect(container.querySelector('#rcloneAuthPanel').classList.contains('hidden')).toBe(false);
  expect(container.querySelector('#rcloneDriveNameInput').value).toBe('persistent-draft');
});

test('repeated Storage open while metadata pending keeps one shared read and displays remote with usable actions', async () => {
  let resolveStatus;
  const pendingStatus = new Promise(r => { resolveStatus = r; });
  const { context, api, container } = setup();
  await flush();

  api.rcloneStatus.mockReturnValueOnce(pendingStatus);

  // Trigger first open which starts metadata read
  const firstOpen = context.onOpenRcloneSettings();
  // Repeated Storage activation in same visit while metadata read is pending
  const secondOpen = context.onOpenRcloneSettings();

  expect(api.rcloneStatus).toHaveBeenCalledTimes(2); // 1 from setup + 1 shared in-flight

  resolveStatus({
    ok: true,
    data: {
      installed: true,
      version: 'v1.74.3',
      executable: '/usr/local/bin/rclone',
      remotes: [{ name: 'shared-gdrive', type: 'drive', source: 'file', canReconnect: true }]
    }
  });

  await Promise.all([firstOpen, secondOpen]);
  await flush();

  const card = container.querySelector('[data-remote-name="shared-gdrive"]');
  expect(card).not.toBeNull();
  const checkBtn = card.querySelector('.rclone-check-btn');
  const openBtn = card.querySelector('.rclone-open-btn');
  expect(checkBtn.disabled).toBe(false);
  expect(openBtn.disabled).toBe(false);

  const statusBadge = container.querySelector('.rclone-status-badge');
  expect(statusBadge.classList.contains('installed')).toBe(true);
});

test('explicit row Open folder overrides and triggers only explicit opener', async () => {
  const { container, onOpenRemoteFolder } = setup();
  await flush();

  const openBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-open-btn');
  openBtn.onclick();
  await flush();

  expect(onOpenRemoteFolder).toHaveBeenCalledWith('gdrive-test');
  expect(onOpenRemoteFolder).toHaveBeenCalledTimes(1);
});

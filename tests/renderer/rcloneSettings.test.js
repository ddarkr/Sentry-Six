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
  const clientIdInput = container.querySelector('#rcloneDriveClientIdInput');
  const clientSecretInput = container.querySelector('#rcloneDriveClientSecretInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');
  const feedback = container.querySelector('#rcloneFormFeedback');

  input.value = '';
  clientIdInput.value = 'valid.id-123.apps.googleusercontent.com';
  clientSecretInput.value = 'valid_secret-123';
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
  const clientIdInput = container.querySelector('#rcloneDriveClientIdInput');
  const clientSecretInput = container.querySelector('#rcloneDriveClientSecretInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');

  input.value = 'my-drive';
  clientIdInput.value = 'my-client.apps.googleusercontent.com';
  clientSecretInput.value = 'my-secret-123';

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

  expect(api.rcloneConfigure).toHaveBeenCalledWith({
    mode: 'create',
    name: 'my-drive',
    oauth: {
      clientId: 'my-client.apps.googleusercontent.com',
      clientSecret: 'my-secret-123'
    }
  });

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
  const clientIdInput = container.querySelector('#rcloneDriveClientIdInput');
  const clientSecretInput = container.querySelector('#rcloneDriveClientSecretInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');
  input.value = 'pending-drive';
  clientIdInput.value = 'pending-client.apps.googleusercontent.com';
  clientSecretInput.value = 'pending-secret';

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
  const clientIdInput = container.querySelector('#rcloneDriveClientIdInput');
  const clientSecretInput = container.querySelector('#rcloneDriveClientSecretInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');
  input.value = 're-enable-test';
  clientIdInput.value = 're-enable-client.apps.googleusercontent.com';
  clientSecretInput.value = 're-enable-secret';

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
  const clientIdInput = container.querySelector('#rcloneDriveClientIdInput');
  const clientSecretInput = container.querySelector('#rcloneDriveClientSecretInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');
  input.value = 'cancel-on-close';
  clientIdInput.value = 'cancel-client.apps.googleusercontent.com';
  clientSecretInput.value = 'cancel-secret';

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
  const clientIdInput = container.querySelector('#rcloneDriveClientIdInput');
  const clientSecretInput = container.querySelector('#rcloneDriveClientSecretInput');
  input.value = 'persistent-draft';
  clientIdInput.value = 'persistent-client.apps.googleusercontent.com';
  clientSecretInput.value = 'persistent-secret';
  input.oninput();
  clientIdInput.oninput();

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

test('remove connection flow: confirm/cancel and environment remote restriction', async () => {
  const { container, api, document } = setup();
  await flush();

  const envCard = container.querySelector('[data-remote-name="env-s3"]');
  const envRemoveBtn = envCard.querySelector('.rclone-remove-btn');
  expect(envRemoveBtn.disabled).toBe(true);

  const gdriveCard = container.querySelector('[data-remote-name="gdrive-test"]');
  const removeBtn = gdriveCard.querySelector('.rclone-remove-btn');
  expect(removeBtn.disabled).toBe(false);

  // Click remove connection button to open inline confirmation
  removeBtn.onclick();
  await flush();

  // No backend call before confirm
  expect(api.rcloneConfigure).not.toHaveBeenCalled();

  let confirmBox = container.querySelector('[data-remote-name="gdrive-test"] .rclone-remove-confirm');
  expect(confirmBox).not.toBeNull();
  expect(confirmBox.querySelector('.rclone-remove-confirm-title').textContent).toContain('gdrive-test');

  // Cancel button receives focus for accessibility
  const cancelBtn = confirmBox.querySelector('.rclone-remove-cancel-btn');
  expect(document.activeElement).toBe(cancelBtn);

  // Click cancel: leaves state unchanged and hides confirmation
  cancelBtn.onclick();
  await flush();

  expect(api.rcloneConfigure).not.toHaveBeenCalled();
  confirmBox = container.querySelector('[data-remote-name="gdrive-test"] .rclone-remove-confirm');
  expect(confirmBox).toBeNull();

  // Focus returns to remove button after cancel
  const restoredRemoveBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-remove-btn');
  expect(document.activeElement).toBe(restoredRemoveBtn);
});

test('remove connection success: unwrap, clear remoteStates, reload status and feedback', async () => {
  const { container, api } = setup();
  await flush();

  const gdriveCard = container.querySelector('[data-remote-name="gdrive-test"]');
  gdriveCard.querySelector('.rclone-remove-btn').onclick();
  await flush();

  api.rcloneConfigure.mockResolvedValueOnce({
    ok: true,
    data: { sessionId: 'rem-1', remote: 'gdrive-test', done: true }
  });

  // When status reloads after remove, gdrive-test is gone
  api.rcloneStatus.mockResolvedValueOnce({
    ok: true,
    data: {
      installed: true,
      version: 'v1.74.3',
      executable: '/usr/local/bin/rclone',
      remotes: [{ name: 'env-s3', type: 's3', source: 'environment', canReconnect: false }]
    }
  });

  const executeBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-remove-execute-btn');
  executeBtn.onclick();
  await flush();

  expect(api.rcloneConfigure).toHaveBeenCalledWith({ mode: 'remove', name: 'gdrive-test' });
  expect(api.rcloneStatus).toHaveBeenCalled();

  // Row should no longer exist after reload
  expect(container.querySelector('[data-remote-name="gdrive-test"]')).toBeNull();
  // Feedback should indicate success
  const feedback = container.querySelector('#rcloneFormFeedback');
  expect(feedback.classList.contains('success')).toBe(true);
  expect(feedback.textContent).toContain('gdrive-test');
});

test('remove connection failure: does not optimistically remove row and keeps remote', async () => {
  const { container, api } = setup();
  await flush();

  container.querySelector('[data-remote-name="gdrive-test"] .rclone-remove-btn').onclick();
  await flush();

  api.rcloneConfigure.mockResolvedValueOnce({
    ok: false,
    error: { code: 'PERMISSION', message: 'Permission denied' }
  });

  const executeBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-remove-execute-btn');
  executeBtn.onclick();
  await flush();

  // Row must still exist
  const card = container.querySelector('[data-remote-name="gdrive-test"]');
  expect(card).not.toBeNull();
});

test('pending remove cancelled on modal close, late result after close does not resurrect row or mark connected', async () => {
  let resolveConfigure;
  const pendingConfig = new Promise(r => { resolveConfigure = r; });
  const { container, api, context } = setup();
  await flush();

  container.querySelector('[data-remote-name="gdrive-test"] .rclone-remove-btn').onclick();
  await flush();

  api.rcloneConfigure.mockReturnValueOnce(pendingConfig);
  const executeBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-remove-execute-btn');
  executeBtn.onclick();
  await flush();

  // Competing actions disabled while pending
  const checkBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-check-btn');
  expect(checkBtn.disabled).toBe(true);

  // Close modal while remove is pending
  const closePromise = context.onCloseRcloneSettings();
  expect(api.rcloneConfigCancel).toHaveBeenCalled();

  resolveConfigure({ ok: true, data: { sessionId: 'rem-2', remote: 'gdrive-test', done: true } });
  await closePromise;
  await flush();

  // Reopen settings
  await context.onOpenRcloneSettings();
  await flush();

  // Confirmation is cleared on reopen
  expect(container.querySelector('.rclone-remove-confirm')).toBeNull();
  const card = container.querySelector('[data-remote-name="gdrive-test"]');
  expect(card).not.toBeNull();
  const statusBadge = card.querySelector('.rclone-status-badge');
  // Late removal result should NOT mark remote connected
  expect(statusBadge.classList.contains('connected')).toBe(false);
});

test('missing or partial OAuth credentials prevent backend configure call', async () => {
  const { api, container } = setup();
  await flush();

  const input = container.querySelector('#rcloneDriveNameInput');
  const clientIdInput = container.querySelector('#rcloneDriveClientIdInput');
  const clientSecretInput = container.querySelector('#rcloneDriveClientSecretInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');

  // Missing Client ID
  input.value = 'valid-name';
  clientIdInput.value = '';
  clientSecretInput.value = 'secret123';
  submitBtn.onclick();
  await flush();
  expect(api.rcloneConfigure).not.toHaveBeenCalled();

  // Invalid Client ID format
  clientIdInput.value = 'invalid-client-id';
  submitBtn.onclick();
  await flush();
  expect(api.rcloneConfigure).not.toHaveBeenCalled();

  // Missing Client Secret
  clientIdInput.value = 'valid-client.apps.googleusercontent.com';
  clientSecretInput.value = '';
  submitBtn.onclick();
  await flush();
  expect(api.rcloneConfigure).not.toHaveBeenCalled();

  // Invalid Client Secret (whitespace)
  clientSecretInput.value = 'invalid secret with spaces';
  submitBtn.onclick();
  await flush();
  expect(api.rcloneConfigure).not.toHaveBeenCalled();
});

test('Drive file remote opens personal OAuth inline editor and submits switch payload', async () => {
  const { api, container } = setup();
  await flush();

  const gdriveCard = container.querySelector('[data-remote-name="gdrive-test"]');
  const oauthBtn = gdriveCard.querySelector('.rclone-oauth-btn');
  expect(oauthBtn).not.toBeNull();

  // Click opens editor with blank fields
  oauthBtn.onclick();
  await flush();

  const editor = container.querySelector('[data-remote-name="gdrive-test"] .rclone-oauth-editor');
  expect(editor).not.toBeNull();

  const clientIdInput = editor.querySelector('.rclone-oauth-client-id-input');
  const clientSecretInput = editor.querySelector('.rclone-oauth-client-secret-input');
  expect(clientIdInput.value).toBe('');
  expect(clientSecretInput.value).toBe('');

  api.rcloneConfigure.mockResolvedValueOnce({
    ok: true,
    data: { sessionId: 'switch-1', remote: 'gdrive-test', done: true }
  });

  clientIdInput.value = 'personal.apps.googleusercontent.com';
  clientSecretInput.value = 'personal-secret-123';

  const applyBtn = editor.querySelector('.rclone-oauth-apply-btn');
  applyBtn.onclick();
  await flush();

  expect(api.rcloneConfigure).toHaveBeenCalledWith({
    mode: 'reconnect',
    name: 'gdrive-test',
    oauth: {
      clientId: 'personal.apps.googleusercontent.com',
      clientSecret: 'personal-secret-123'
    }
  });
});

test('ordinary reconnect omits oauth and retains configured client', async () => {
  const { api, container } = setup();
  await flush();

  const reconnectBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-reconnect-btn');
  expect(reconnectBtn).not.toBeNull();

  api.rcloneConfigure.mockResolvedValueOnce({
    ok: true,
    data: { sessionId: 'recon-1', remote: 'gdrive-test', done: true }
  });

  reconnectBtn.onclick();
  await flush();

  expect(api.rcloneConfigure).toHaveBeenCalledWith({
    mode: 'reconnect',
    name: 'gdrive-test'
  });
  expect(api.rcloneConfigure.mock.calls[0][0].oauth).toBeUndefined();
});

test('environment and non-Drive remotes do not offer personal OAuth action', async () => {
  const { container } = setup({
    installed: true,
    version: 'v1.74.3',
    executable: '/usr/local/bin/rclone',
    remotes: [
      { name: 'env-drive', type: 'drive', source: 'environment', canReconnect: true },
      { name: 'file-s3', type: 's3', source: 'file', canReconnect: true }
    ]
  });
  await flush();

  const envCard = container.querySelector('[data-remote-name="env-drive"]');
  expect(envCard.querySelector('.rclone-oauth-btn')).toBeNull();

  const s3Card = container.querySelector('[data-remote-name="file-s3"]');
  expect(s3Card.querySelector('.rclone-oauth-btn')).toBeNull();
});

test('inline cancel clears draft without IPC or config mutation', async () => {
  const { api, container } = setup();
  await flush();

  const oauthBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-oauth-btn');
  oauthBtn.onclick();
  await flush();

  let editor = container.querySelector('[data-remote-name="gdrive-test"] .rclone-oauth-editor');
  const clientIdInput = editor.querySelector('.rclone-oauth-client-id-input');
  const clientSecretInput = editor.querySelector('.rclone-oauth-client-secret-input');
  clientIdInput.value = 'draft.apps.googleusercontent.com';
  clientSecretInput.value = 'draft-secret';

  const cancelBtn = editor.querySelector('.rclone-oauth-cancel-btn');
  cancelBtn.onclick();
  await flush();

  expect(api.rcloneConfigure).not.toHaveBeenCalled();
  editor = container.querySelector('[data-remote-name="gdrive-test"] .rclone-oauth-editor');
  expect(editor).toBeNull();
});

test('secrets and client ID cleared on submit, cancel, close and never restored on reopen', async () => {
  const { api, container, context } = setup();
  await flush();

  // Create card submit clears both clientId and secret DOM values
  const nameInput = container.querySelector('#rcloneDriveNameInput');
  const clientIdInput = container.querySelector('#rcloneDriveClientIdInput');
  const clientSecretInput = container.querySelector('#rcloneDriveClientSecretInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');

  nameInput.value = 'secret-test-drive';
  clientIdInput.value = 'sec.apps.googleusercontent.com';
  clientSecretInput.value = 'my-secret-to-clear';

  api.rcloneConfigure.mockResolvedValueOnce({
    ok: true,
    data: { sessionId: 'sec-1', remote: 'secret-test-drive', done: true }
  });

  submitBtn.onclick();
  // Immediately cleared upon submission
  expect(clientIdInput.value).toBe('');
  expect(clientSecretInput.value).toBe('');
  await flush();

  // Close and reopen ensures both client ID and secrets remain empty
  await context.onCloseRcloneSettings();
  await flush();
  await context.onOpenRcloneSettings();
  await flush();

  const reopenedId = container.querySelector('#rcloneDriveClientIdInput');
  const reopenedSecret = container.querySelector('#rcloneDriveClientSecretInput');
  expect(reopenedId.value).toBe('');
  expect(reopenedSecret.value).toBe('');
});

test('startConfigure recovers when rcloneConfigure throws synchronously', async () => {
  const { api, container } = setup();
  await flush();

  api.rcloneConfigure.mockImplementationOnce(() => {
    throw new Error('Bridge synchronous error');
  });

  const nameInput = container.querySelector('#rcloneDriveNameInput');
  const clientIdInput = container.querySelector('#rcloneDriveClientIdInput');
  const clientSecretInput = container.querySelector('#rcloneDriveClientSecretInput');
  const submitBtn = container.querySelector('#rcloneDriveSubmitBtn');

  nameInput.value = 'sync-throw-drive';
  clientIdInput.value = 'sync.apps.googleusercontent.com';
  clientSecretInput.value = 'sync-secret';

  submitBtn.onclick();
  await flush();

  // Verify that busy gate is released and inputs/buttons are re-enabled
  const checkBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-check-btn');
  expect(checkBtn.disabled).toBe(false);
  expect(submitBtn.disabled).toBe(false);
});

test('switch error displays visibly on the remote card and not in add-drive card', async () => {
  const { api, container } = setup();
  await flush();

  const oauthBtn = container.querySelector('[data-remote-name="gdrive-test"] .rclone-oauth-btn');
  oauthBtn.onclick();
  await flush();

  const editor = container.querySelector('[data-remote-name="gdrive-test"] .rclone-oauth-editor');
  editor.querySelector('.rclone-oauth-client-id-input').value = 'fail.apps.googleusercontent.com';
  editor.querySelector('.rclone-oauth-client-secret-input').value = 'fail-secret';

  api.rcloneConfigure.mockRejectedValueOnce({
    code: 'INVALID_CLIENT',
    message: 'Invalid OAuth Client'
  });

  editor.querySelector('.rclone-oauth-apply-btn').onclick();
  await flush();

  // Remote card displays the error
  const cardError = container.querySelector('[data-remote-name="gdrive-test"] .rclone-remote-error');
  expect(cardError).not.toBeNull();
  expect(cardError.textContent).not.toBe('');

  // Add drive card feedback must not contain this error
  const addCardFeedback = container.querySelector('#rcloneFormFeedback');
  expect(addCardFeedback.classList.contains('error')).toBe(false);
});

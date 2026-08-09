'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  UpdaterService,
  describeUpdateError,
  UPDATE_STATES
} = require('../src/services/updater.service');

const { AppLifecycle, STATE_UPDATING } = require('../src/core/app-lifecycle');

// ---- mock electron-updater ----

class MockAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = true;
    this.autoInstallOnAppQuit = false;
    this.logger = undefined;
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.quitAndInstallCalls = 0;
    this.checkImpl = async () => {};
  }
  async checkForUpdates() { this.checkCalls += 1; return this.checkImpl(); }
  async downloadUpdate() { this.downloadCalls += 1; }
  quitAndInstall() { this.quitAndInstallCalls += 1; }
}

function makeUpdater(overrides = {}) {
  const autoUpdater = overrides.autoUpdater || new MockAutoUpdater();
  const dialogCalls = [];
  const broadcasts = [];
  const timers = [];

  const dialog = {
    showMessageBox: (options) => {
      dialogCalls.push(options);
      const answer = overrides.dialogAnswer;
      return Promise.resolve(typeof answer === 'number' ? answer : 1);
    }
  };

  const service = new UpdaterService({
    app: {
      isPackaged: overrides.isPackaged !== false,
      getVersion: () => overrides.version || '1.0.0'
    },
    autoUpdater,
    dialog,
    lifecycle: overrides.lifecycle || null,
    platform: overrides.platform || 'darwin',
    onStateChange: (s) => broadcasts.push(s),
    startupCheckDelayMs: 10000,
    setTimeoutFn: (fn, ms) => {
      const handle = { fn, ms, unref() { return this; } };
      timers.push(handle);
      return handle;
    }
  });

  return { service, autoUpdater, dialog, dialogCalls, broadcasts, timers };
}

// ---- enablement ----

test('updates are disabled in a development (unpackaged) run', () => {
  const { service, autoUpdater } = makeUpdater({ isPackaged: false });

  assert.equal(service.isEnabled, false);
  assert.equal(service.initialize(), false);
  assert.equal(service.scheduleStartupCheck(), false);
  assert.equal(autoUpdater.checkCalls, 0, 'a source run must never contact the update server');
});

test('updates are disabled off macOS', () => {
  for (const platform of ['win32', 'linux']) {
    const { service, autoUpdater } = makeUpdater({ platform });

    assert.equal(service.isEnabled, false);
    assert.equal(service.initialize(), false);
    assert.equal(autoUpdater.checkCalls, 0);
  }
});

test('a manual check in a disabled build reports why, without contacting anything', async () => {
  const { service, autoUpdater, dialogCalls } = makeUpdater({ isPackaged: false });

  const result = await service.checkForUpdates({ manual: true });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /installed application/);
  assert.equal(autoUpdater.checkCalls, 0);
  assert.equal(dialogCalls.length, 1);
});

test('updates are enabled for a packaged macOS build', () => {
  const { service } = makeUpdater();
  assert.equal(service.isEnabled, true);
  assert.equal(service.initialize(), true);
});

test('initialize configures electron-updater for manual download control', () => {
  const { service, autoUpdater } = makeUpdater();
  service.initialize();

  assert.equal(autoUpdater.autoDownload, false, 'we drive the download to keep state accurate');
  assert.equal(autoUpdater.autoInstallOnAppQuit, true, '"Later" must install on next quit');
});

// ---- state machine ----

test('the initial state is idle and reports the current version', () => {
  const { service } = makeUpdater({ version: '1.2.3' });
  const state = service.getState();

  assert.equal(state.state, 'idle');
  assert.equal(state.currentVersion, '1.2.3');
  assert.equal(state.availableVersion, null);
  assert.equal(state.percent, 0);
  assert.equal(state.canInstall, false);
});

test('a full check → download → downloaded cycle reports normalized states', async () => {
  const { service, autoUpdater, broadcasts } = makeUpdater();
  service.initialize();

  autoUpdater.emit('checking-for-update');
  assert.equal(service.getState().state, 'checking');

  autoUpdater.emit('update-available', { version: '1.1.0' });
  assert.equal(service.getState().state, 'downloading');
  assert.equal(service.getState().availableVersion, '1.1.0');
  assert.equal(autoUpdater.downloadCalls, 1, 'download should start automatically');

  autoUpdater.emit('download-progress', { percent: 42.7 });
  assert.equal(service.getState().percent, 43);

  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  const final = service.getState();
  assert.equal(final.state, 'downloaded');
  assert.equal(final.percent, 100);
  assert.equal(final.canInstall, true);

  for (const b of broadcasts) assert.ok(UPDATE_STATES.includes(b.state));
});

test('update-not-available yields the not-available state', () => {
  const { service, autoUpdater } = makeUpdater();
  service.initialize();

  autoUpdater.emit('update-not-available', {});

  assert.equal(service.getState().state, 'not-available');
  assert.equal(service.getState().availableVersion, null);
});

test('download progress is clamped into 0..100', () => {
  const { service, autoUpdater } = makeUpdater();
  service.initialize();
  autoUpdater.emit('update-available', { version: '2.0.0' });

  autoUpdater.emit('download-progress', { percent: -5 });
  assert.equal(service.getState().percent, 0);

  autoUpdater.emit('download-progress', { percent: 250 });
  assert.equal(service.getState().percent, 100);
});

test('a check records the last-check timestamp', async () => {
  const { service } = makeUpdater();
  service.initialize();

  assert.equal(service.getState().lastCheckAt, null);
  await service.checkForUpdates({ manual: true });
  assert.ok(!Number.isNaN(Date.parse(service.getState().lastCheckAt)));
});

// ---- coalescing ----

test('concurrent checks are coalesced into one network call', async () => {
  const { service, autoUpdater } = makeUpdater();
  service.initialize();

  let release;
  autoUpdater.checkImpl = () => new Promise((resolve) => { release = resolve; });

  const a = service.checkForUpdates();
  const b = service.checkForUpdates();
  const c = service.checkForUpdates({ manual: true });

  release();
  await Promise.all([a, b, c]);

  assert.equal(autoUpdater.checkCalls, 1);
});

test('a new check is allowed once the previous one settles', async () => {
  const { service, autoUpdater } = makeUpdater();
  service.initialize();

  await service.checkForUpdates();
  await service.checkForUpdates();

  assert.equal(autoUpdater.checkCalls, 2);
});

test('checking again after download does not re-check, it re-offers the install', async () => {
  const { service, autoUpdater, dialogCalls } = makeUpdater();
  service.initialize();
  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  const callsAfterDownload = autoUpdater.checkCalls;
  dialogCalls.length = 0;

  await service.checkForUpdates({ manual: true });

  assert.equal(autoUpdater.checkCalls, callsAfterDownload);
});

// ---- startup check ----

test('the automatic startup check is scheduled once, ~10s after launch', () => {
  const { service, timers, autoUpdater } = makeUpdater();
  service.initialize();

  assert.equal(service.scheduleStartupCheck(), true);
  assert.equal(service.scheduleStartupCheck(), false, 'must not schedule twice');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 10000);
  assert.equal(autoUpdater.checkCalls, 0, 'nothing before the delay elapses');

  timers[0].fn();
  assert.equal(autoUpdater.checkCalls, 1);
});

// ---- errors ----

test('automatic errors are recorded but never shown as a dialog', () => {
  const { service, autoUpdater, dialogCalls } = makeUpdater();
  service.initialize();

  autoUpdater.emit('error', new Error('getaddrinfo ENOTFOUND github.com'));

  assert.equal(service.getState().state, 'error');
  assert.match(service.getState().error, /internet connection/);
  assert.equal(dialogCalls.length, 0, 'automatic failures must be non-blocking');
});

test('manual errors surface an actionable dialog', async () => {
  const { service, autoUpdater, dialogCalls } = makeUpdater();
  service.initialize();
  autoUpdater.checkImpl = async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); };

  await service.checkForUpdates({ manual: true });

  assert.equal(dialogCalls.length, 1);
  assert.equal(dialogCalls[0].type, 'error');
  assert.match(dialogCalls[0].message, /internet connection/);
});

test('describeUpdateError turns raw failures into actionable text', () => {
  assert.match(describeUpdateError(new Error('ENOTFOUND')), /internet connection/);
  assert.match(describeUpdateError(new Error('HTTP 404 not found')), /No published release/);
  assert.match(describeUpdateError(new Error('403 rate limit exceeded')), /rate-limited/);
  assert.match(describeUpdateError(new Error('code signature check failed')), /signature validation/);
  assert.match(describeUpdateError(new Error('ENOSPC')), /disk space/);
  assert.match(describeUpdateError(new Error('weird')), /Update failed: weird/);
});

// ---- install guardrails ----

test('installing before an update is downloaded is refused', () => {
  const { service, autoUpdater } = makeUpdater();
  service.initialize();

  for (const stage of ['idle', 'checking', 'downloading', 'not-available', 'error']) {
    if (stage === 'checking') autoUpdater.emit('checking-for-update');
    if (stage === 'downloading') autoUpdater.emit('update-available', { version: '9.9.9' });
    if (stage === 'not-available') autoUpdater.emit('update-not-available', {});
    if (stage === 'error') autoUpdater.emit('error', new Error('boom'));

    const result = service.installUpdate();
    assert.equal(result.success, false, `install must be refused while ${stage}`);
    assert.match(result.error, /No downloaded update/);
  }

  assert.equal(autoUpdater.quitAndInstallCalls, 0);
});

test('installing after download enters the updating state before quitAndInstall()', () => {
  const lifecycle = new AppLifecycle({
    app: { quit() {}, exit() {} },
    platform: 'darwin',
    emergencyExitMs: 0
  });
  const { service, autoUpdater } = makeUpdater({ lifecycle });
  service.initialize();

  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  const result = service.installUpdate();

  assert.equal(result.success, true);
  assert.equal(autoUpdater.quitAndInstallCalls, 1);
  assert.equal(lifecycle.state, STATE_UPDATING);
  assert.equal(lifecycle.cleanupRan, true, 'cleanup must run before the bundle is swapped');
});

test('installing while already quitting is refused', () => {
  const lifecycle = new AppLifecycle({
    app: { quit() {}, exit() {} },
    platform: 'darwin',
    emergencyExitMs: 0
  });
  const { service, autoUpdater } = makeUpdater({ lifecycle });
  service.initialize();
  autoUpdater.emit('update-downloaded', { version: '1.1.0' });

  lifecycle.requestQuit('cmd-q');
  const result = service.installUpdate();

  assert.equal(result.success, false);
  assert.match(result.error, /quitting/);
  assert.equal(autoUpdater.quitAndInstallCalls, 0);
});

// ---- install prompt ----

test('the download prompt offers Restart and Install or Later', () => {
  const { service, autoUpdater, dialogCalls } = makeUpdater();
  service.initialize();

  autoUpdater.emit('update-downloaded', { version: '1.1.0' });

  assert.equal(dialogCalls.length, 1);
  assert.deepEqual(dialogCalls[0].buttons, ['Restart and Install', 'Later']);
  assert.match(dialogCalls[0].message, /1\.1\.0/);
});

test('choosing Restart and Install triggers the install', async () => {
  const lifecycle = new AppLifecycle({
    app: { quit() {}, exit() {} },
    platform: 'darwin',
    emergencyExitMs: 0
  });
  const { service, autoUpdater } = makeUpdater({ lifecycle, dialogAnswer: 0 });
  service.initialize();

  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  await new Promise((r) => setImmediate(r));

  assert.equal(autoUpdater.quitAndInstallCalls, 1);
});

test('choosing Later leaves the update staged for the next quit', async () => {
  const { service, autoUpdater } = makeUpdater({ dialogAnswer: 1 });
  service.initialize();

  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  await new Promise((r) => setImmediate(r));

  assert.equal(autoUpdater.quitAndInstallCalls, 0);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(service.getState().canInstall, true, 'the user can still install from Settings');
});

test('one version never produces two dialogs', async () => {
  const { service, autoUpdater, dialogCalls } = makeUpdater();
  service.initialize();

  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  await service.checkForUpdates({ manual: true });
  await service.checkForUpdates({ manual: true });

  assert.equal(dialogCalls.length, 1);
});

test('a genuinely newer version does get its own prompt', () => {
  const { service, autoUpdater, dialogCalls } = makeUpdater();
  service.initialize();

  autoUpdater.emit('update-downloaded', { version: '1.1.0' });
  autoUpdater.emit('update-downloaded', { version: '1.2.0' });

  assert.equal(dialogCalls.length, 2);
});

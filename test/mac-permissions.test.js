'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MacPermissionsService,
  normalizeStatus,
  requiresRestart,
  sendToRenderer,
  SETTINGS_PANES,
  VALID_STATUSES
} = require('../src/services/mac-permissions.service');

function makeService(overrides = {}) {
  return new MacPermissionsService({
    platform: 'darwin',
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => true,
      ...(overrides.systemPreferences || {})
    },
    shell: { openExternal: async () => {}, ...(overrides.shell || {}) },
    ...overrides.rest
  });
}

// ---- normalizeStatus ----

test('normalizeStatus passes through the documented Electron statuses', () => {
  for (const status of ['granted', 'denied', 'restricted', 'not-determined', 'unknown']) {
    assert.equal(normalizeStatus(status), status);
  }
});

test('normalizeStatus maps known aliases onto the canonical set', () => {
  assert.equal(normalizeStatus('authorized'), 'granted');
  assert.equal(normalizeStatus('allowed'), 'granted');
  assert.equal(normalizeStatus('notDetermined'), 'not-determined');
  assert.equal(normalizeStatus('not_determined'), 'not-determined');
  assert.equal(normalizeStatus('NOT DETERMINED'), 'not-determined');
  assert.equal(normalizeStatus('  Granted  '), 'granted');
});

test('normalizeStatus falls back to unknown for anything unrecognised', () => {
  for (const input of [undefined, null, '', 42, {}, [], 'banana', 'partially-granted']) {
    assert.equal(normalizeStatus(input), 'unknown');
  }
});

test('normalizeStatus only ever returns a member of the closed set', () => {
  const samples = ['granted', 'nonsense', '', 'restricted', null, 'authorized'];
  for (const sample of samples) {
    assert.ok(VALID_STATUSES.includes(normalizeStatus(sample)));
  }
});

test('only Screen Recording requires a restart', () => {
  assert.equal(requiresRestart('screen'), true);
  assert.equal(requiresRestart('microphone'), false);
});

// ---- getStatus ----

test('getStatus reads and normalizes the underlying Electron status', () => {
  const service = makeService({
    systemPreferences: { getMediaAccessStatus: (type) => (type === 'screen' ? 'authorized' : 'denied') }
  });

  assert.equal(service.getStatus('screen').status, 'granted');
  assert.equal(service.getStatus('microphone').status, 'denied');
});

test('getStatus reports an unknown permission as an error rather than guessing', () => {
  const result = makeService().getStatus('camera-roll');
  assert.equal(result.status, 'unknown');
  assert.match(result.error, /Unknown permission/);
});

test('getStatus survives systemPreferences throwing', () => {
  const service = makeService({
    systemPreferences: {
      getMediaAccessStatus: () => { throw new Error('TCC database locked'); }
    }
  });

  const result = service.getStatus('microphone');
  assert.equal(result.status, 'unknown');
  assert.match(result.error, /TCC database locked/);
});

test('getStatus reports an error when the Electron API is missing entirely', () => {
  const service = new MacPermissionsService({ platform: 'darwin', systemPreferences: null });
  const result = service.getStatus('screen');
  assert.equal(result.status, 'unknown');
  assert.match(result.error, /unavailable/);
});

// ---- unsupported platforms ----

test('Windows and Linux report unsupported and never call into Electron', () => {
  for (const platform of ['win32', 'linux']) {
    let called = 0;
    const service = new MacPermissionsService({
      platform,
      systemPreferences: { getMediaAccessStatus: () => { called += 1; return 'granted'; } }
    });

    const result = service.getStatus('screen');
    assert.equal(result.supported, false);
    assert.equal(result.status, 'unknown');
    assert.equal(called, 0, `${platform} must not touch macOS permission APIs`);
  }
});

test('getAllStatuses reports unsupported off macOS', () => {
  const service = new MacPermissionsService({ platform: 'linux' });
  const all = service.getAllStatuses();

  assert.equal(all.supported, false);
  assert.equal(all.platform, 'linux');
  assert.ok(all.checkedAt);
});

test('getAllStatuses returns both permissions with a timestamp on macOS', () => {
  const all = makeService().getAllStatuses();

  assert.equal(all.supported, true);
  assert.equal(all.screen.permission, 'screen');
  assert.equal(all.microphone.permission, 'microphone');
  assert.equal(all.screen.requiresRestart, true);
  assert.ok(!Number.isNaN(Date.parse(all.checkedAt)));
});

// ---- microphone requests ----

test('requesting the microphone prompts only when the status is not-determined', async () => {
  let asked = 0;
  const service = makeService({
    systemPreferences: {
      getMediaAccessStatus: () => 'not-determined',
      askForMediaAccess: async () => { asked += 1; return true; }
    }
  });

  const result = await service.requestMicrophoneAccess();

  assert.equal(asked, 1);
  assert.equal(result.granted, true);
  assert.equal(result.status, 'granted');
  assert.equal(result.prompted, true);
});

test('an already-granted microphone is not re-prompted', async () => {
  let asked = 0;
  const service = makeService({
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => { asked += 1; return true; }
    }
  });

  const result = await service.requestMicrophoneAccess();

  assert.equal(asked, 0, 'macOS cannot show a prompt for a settled permission');
  assert.equal(result.granted, true);
  assert.equal(result.prompted, false);
});

test('a denied microphone directs the user to System Settings instead of prompting', async () => {
  let asked = 0;
  const service = makeService({
    systemPreferences: {
      getMediaAccessStatus: () => 'denied',
      askForMediaAccess: async () => { asked += 1; return true; }
    }
  });

  const result = await service.requestMicrophoneAccess();

  assert.equal(asked, 0);
  assert.equal(result.granted, false);
  assert.equal(result.needsSystemSettings, true);
});

test('a rejected microphone request is reported as denied, not as a crash', async () => {
  const service = makeService({
    systemPreferences: {
      getMediaAccessStatus: () => 'not-determined',
      askForMediaAccess: async () => false
    }
  });

  const result = await service.requestMicrophoneAccess();
  assert.equal(result.granted, false);
  assert.equal(result.status, 'denied');
});

test('a throwing microphone request is surfaced as an error', async () => {
  const service = makeService({
    systemPreferences: {
      getMediaAccessStatus: () => 'not-determined',
      askForMediaAccess: async () => { throw new Error('media daemon unavailable'); }
    }
  });

  const result = await service.requestMicrophoneAccess();
  assert.equal(result.granted, false);
  assert.match(result.error, /media daemon unavailable/);
});

test('requesting the microphone off macOS is inert', async () => {
  const service = new MacPermissionsService({ platform: 'win32' });
  const result = await service.requestMicrophoneAccess();

  assert.equal(result.supported, false);
  assert.equal(result.prompted, false);
});

test('there is no API for requesting Screen Recording', () => {
  // macOS provides none; the prompt is raised by the first real capture.
  // Asserting the absence keeps anyone from adding a fake one later.
  const service = makeService();
  assert.equal(typeof service.requestScreenAccess, 'undefined');
});

// ---- opening System Settings ----

test('opening System Settings uses the correct privacy pane per permission', async () => {
  const opened = [];
  const service = makeService({ shell: { openExternal: async (url) => opened.push(url) } });

  assert.equal((await service.openSystemSettings('screen')).success, true);
  assert.equal((await service.openSystemSettings('microphone')).success, true);

  assert.deepEqual(opened, [SETTINGS_PANES.screen, SETTINGS_PANES.microphone]);
  assert.match(opened[0], /Privacy_ScreenCapture/);
  assert.match(opened[1], /Privacy_Microphone/);
});

test('opening System Settings rejects an unknown permission', async () => {
  const result = await makeService().openSystemSettings('bluetooth');
  assert.equal(result.success, false);
  assert.match(result.error, /Unknown permission/);
});

test('opening System Settings fails cleanly when the shell call throws', async () => {
  const service = makeService({
    shell: { openExternal: async () => { throw new Error('LSOpenURLs failed'); } }
  });

  const result = await service.openSystemSettings('screen');
  assert.equal(result.success, false);
  assert.match(result.error, /LSOpenURLs failed/);
});

test('opening System Settings is refused off macOS', async () => {
  const service = new MacPermissionsService({
    platform: 'win32',
    shell: { openExternal: async () => { throw new Error('should not be called'); } }
  });

  const result = await service.openSystemSettings('microphone');
  assert.equal(result.success, false);
  assert.match(result.error, /macOS-only/);
});

// ---- destroyed renderer windows ----

test('sending to a live renderer succeeds', () => {
  const sent = [];
  const win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (ch, p) => sent.push([ch, p]) }
  };

  assert.equal(sendToRenderer(win, 'permissions:changed', { ok: true }), true);
  assert.deepEqual(sent, [['permissions:changed', { ok: true }]]);
});

test('sending to a destroyed window is a no-op, not a crash', () => {
  const win = {
    isDestroyed: () => true,
    get webContents() { throw new Error('window is destroyed'); }
  };

  assert.equal(sendToRenderer(win, 'permissions:changed', {}), false);
});

test('sending to a window whose webContents was destroyed is a no-op', () => {
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => true,
      send: () => { throw new Error('render frame was disposed'); }
    }
  };

  assert.equal(sendToRenderer(win, 'permissions:changed', {}), false);
});

test('sending to a missing window or missing webContents is a no-op', () => {
  assert.equal(sendToRenderer(null, 'c', {}), false);
  assert.equal(sendToRenderer(undefined, 'c', {}), false);
  assert.equal(sendToRenderer({ isDestroyed: () => false }, 'c', {}), false);
});

test('a renderer destroyed mid-send does not propagate the error', () => {
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: () => { throw new Error('Object has been destroyed'); }
    }
  };

  assert.equal(sendToRenderer(win, 'permissions:changed', {}), false);
});

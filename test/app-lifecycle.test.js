'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AppLifecycle,
  STATE_RUNNING,
  STATE_QUITTING,
  STATE_UPDATING
} = require('../src/core/app-lifecycle');

const { buildMacMenuTemplate, installMacMenu } = require('../src/core/mac-menu');

// ---- helpers ----

function makeWindow(overrides = {}) {
  const calls = { hide: 0, show: 0, focus: 0, restore: 0 };
  return {
    calls,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    isVisible() { return true; },
    isMinimized() { return false; },
    hide() { calls.hide += 1; },
    show() { calls.show += 1; },
    focus() { calls.focus += 1; },
    restore() { calls.restore += 1; },
    ...overrides
  };
}

function makeHarness(overrides = {}) {
  const counts = {
    quit: 0,
    exit: 0,
    unregisterAll: 0,
    speechShutdown: 0,
    destroyAllWindows: 0
  };
  const timers = [];

  const windows = new Map();
  if (overrides.mainWindow !== null) {
    windows.set('main', overrides.mainWindow || makeWindow());
  }

  const lifecycle = new AppLifecycle({
    app: {
      quit() { counts.quit += 1; },
      exit() { counts.exit += 1; }
    },
    globalShortcut: {
      unregisterAll() { counts.unregisterAll += 1; }
    },
    speechService: {
      shutdown() { counts.speechShutdown += 1; }
    },
    sessionManager: {
      getMemoryUsage: () => ({ eventCount: 3, approximateSize: 128 })
    },
    windowManager: {
      windows,
      getWindow: (type) => windows.get(type) || null,
      destroyAllWindows() { counts.destroyAllWindows += 1; }
    },
    platform: overrides.platform || 'darwin',
    emergencyExitMs: overrides.emergencyExitMs ?? 8000,
    setTimeoutFn: (fn, ms) => {
      const handle = { fn, ms, cleared: false, unref() { return this; } };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => {
      if (handle) handle.cleared = true;
    }
  });

  return { lifecycle, counts, timers, windows };
}

// ---- duplicate quit requests ----

test('a second quit request is ignored while a shutdown is already running', () => {
  const { lifecycle, counts } = makeHarness();

  const first = lifecycle.requestQuit('settings-button');
  const second = lifecycle.requestQuit('settings-button');
  const third = lifecycle.requestQuit('cmd-q');

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(third.accepted, false);
  assert.equal(counts.quit, 1, 'app.quit() must be called exactly once');
  assert.equal(lifecycle.state, STATE_QUITTING);
});

test('Settings Quit, the application menu and Cmd+Q share one code path', () => {
  // All three entry points are just requestQuit() with a different reason,
  // so whichever arrives first wins and the rest are no-ops.
  const sources = ['settings-quit-button', 'menu-quit', 'cmd-q'];

  for (const winner of sources) {
    const { lifecycle, counts } = makeHarness();
    const results = sources.map((source) =>
      lifecycle.requestQuit(source === winner ? winner : source)
    );

    assert.equal(results.filter((r) => r.accepted).length, 1);
    assert.equal(counts.quit, 1);
  }
});

// ---- cleanup runs exactly once ----

test('cleanup runs exactly once no matter how many times it is triggered', () => {
  const { lifecycle, counts } = makeHarness();

  assert.equal(lifecycle.runCleanup('will-quit'), true);
  assert.equal(lifecycle.runCleanup('will-quit'), false);
  assert.equal(lifecycle.runCleanup('ipc'), false);

  assert.equal(counts.unregisterAll, 1);
  assert.equal(counts.speechShutdown, 1);
  assert.equal(counts.destroyAllWindows, 1);
});

test('cleanup shuts down shortcuts, speech, registered workers and windows', () => {
  const { lifecycle, counts } = makeHarness();
  let workerStopped = 0;
  let timerCleared = 0;

  lifecycle.registerDisposer('whisper-worker', () => { workerStopped += 1; });
  lifecycle.registerDisposer('poll-timer', () => { timerCleared += 1; });

  lifecycle.runCleanup('will-quit');

  assert.equal(counts.unregisterAll, 1);
  assert.equal(counts.speechShutdown, 1);
  assert.equal(workerStopped, 1);
  assert.equal(timerCleared, 1);
  assert.equal(counts.destroyAllWindows, 1);
});

test('one failing cleanup step does not strand the remaining steps', () => {
  const { lifecycle, counts } = makeHarness();
  lifecycle.speechService = {
    shutdown() { throw new Error('whisper worker hung'); }
  };

  assert.equal(lifecycle.runCleanup('will-quit'), true);

  // Shortcuts run before speech, windows after — both must still happen.
  assert.equal(counts.unregisterAll, 1);
  assert.equal(counts.destroyAllWindows, 1);
});

// ---- non-closable windows must not wedge the shutdown ----

test('cleanup destroys windows rather than closing them', () => {
  // main/chat/llmResponse are created with `closable: false`, so a close()
  // is silently ignored and Electron's quit sequence stalls before
  // 'will-quit' ever fires. Teardown must go through destroy().
  const { lifecycle, counts } = makeHarness();

  lifecycle.runCleanup('before-quit');

  assert.equal(counts.destroyAllWindows, 1);
});

test('cleanup at before-quit makes the later will-quit a no-op', () => {
  const { lifecycle, counts } = makeHarness();

  // This is the real sequence: before-quit runs cleanup so the
  // non-closable windows are gone and Electron can finish quitting.
  assert.equal(lifecycle.noteExternalQuit('before-quit'), true);
  assert.equal(lifecycle.runCleanup('before-quit'), true);
  assert.equal(lifecycle.runCleanup('will-quit'), false);

  assert.equal(counts.destroyAllWindows, 1, 'windows destroyed exactly once');
  assert.equal(counts.unregisterAll, 1);
  assert.equal(counts.speechShutdown, 1);
});

test('noteExternalQuit moves to quitting without re-entering app.quit()', () => {
  const { lifecycle, counts } = makeHarness();

  assert.equal(lifecycle.noteExternalQuit('before-quit'), true);
  assert.equal(lifecycle.state, STATE_QUITTING);
  assert.equal(counts.quit, 0, 'we are already inside app.quit()');

  assert.equal(lifecycle.noteExternalQuit('before-quit'), false, 'idempotent');
});

test('requestQuit followed by before-quit still cleans up exactly once', () => {
  const { lifecycle, counts } = makeHarness();

  lifecycle.requestQuit('cmd-q');       // -> app.quit()
  lifecycle.noteExternalQuit('before-quit'); // Electron raises before-quit
  lifecycle.runCleanup('before-quit');
  lifecycle.runCleanup('will-quit');

  assert.equal(counts.quit, 1);
  assert.equal(counts.destroyAllWindows, 1);
  assert.equal(counts.unregisterAll, 1);
});

// ---- emergency exit is bounded, and not used normally ----

test('a normal quit disarms the emergency exit once cleanup completes', () => {
  const { lifecycle, counts, timers } = makeHarness();

  lifecycle.requestQuit('cmd-q');
  assert.equal(timers.length, 1, 'emergency fallback should be armed');

  lifecycle.runCleanup('will-quit');

  assert.equal(timers[0].cleared, true, 'fallback must be cancelled');
  assert.equal(counts.exit, 0, 'process must not be force-exited normally');
});

test('the emergency exit fires only when teardown never completes', () => {
  const { lifecycle, counts, timers } = makeHarness();

  lifecycle.requestQuit('cmd-q');
  timers[0].fn(); // simulate the grace period elapsing with no exit

  assert.equal(counts.exit, 1);
});

// ---- red close button hides instead of quitting ----

test('the red close button hides the window on macOS instead of destroying it', () => {
  const { lifecycle } = makeHarness({ platform: 'darwin' });
  const win = makeWindow();

  const intercepted = lifecycle.handleWindowCloseRequest(win, 'settings');

  assert.equal(intercepted, true, 'caller should preventDefault()');
  assert.equal(win.calls.hide, 1);
  assert.equal(lifecycle.state, STATE_RUNNING, 'hiding must not start a quit');
});

test('close is NOT intercepted during shutdown (that close is the teardown)', () => {
  const { lifecycle } = makeHarness({ platform: 'darwin' });
  const win = makeWindow();

  lifecycle.requestQuit('cmd-q');
  const intercepted = lifecycle.handleWindowCloseRequest(win, 'settings');

  assert.equal(intercepted, false);
  assert.equal(win.calls.hide, 0);
});

test('close interception is macOS-only', () => {
  const { lifecycle } = makeHarness({ platform: 'win32' });
  const win = makeWindow();

  assert.equal(lifecycle.handleWindowCloseRequest(win, 'settings'), false);
  assert.equal(win.calls.hide, 0);
});

test('a destroyed window is never hidden', () => {
  const { lifecycle } = makeHarness({ platform: 'darwin' });
  const win = makeWindow();
  win.destroyed = true;

  assert.equal(lifecycle.handleWindowCloseRequest(win, 'settings'), false);
  assert.equal(win.calls.hide, 0);
});

// ---- window-all-closed ----

test('window-all-closed keeps the app resident on macOS', () => {
  const { lifecycle, counts } = makeHarness({ platform: 'darwin' });

  assert.equal(lifecycle.handleWindowAllClosed(), false);
  assert.equal(counts.quit, 0);
  assert.equal(lifecycle.state, STATE_RUNNING);
});

test('window-all-closed still quits on Windows and Linux', () => {
  for (const platform of ['win32', 'linux']) {
    const { lifecycle, counts } = makeHarness({ platform });

    assert.equal(lifecycle.handleWindowAllClosed(), true);
    assert.equal(counts.quit, 1, `${platform} should quit`);
  }
});

// ---- dock activation ----

test('activation restores the existing main window', () => {
  const { lifecycle } = makeHarness();
  let restoredWith = null;

  const result = lifecycle.handleActivate({
    restore: (win) => { restoredWith = win; },
    recreate: () => { throw new Error('should not recreate a live window'); }
  });

  assert.equal(result, 'restored');
  assert.ok(restoredWith);
});

test('activation with a destroyed main window recreates instead of touching it', () => {
  const destroyed = makeWindow();
  destroyed.destroyed = true;
  const { lifecycle, windows } = makeHarness({ mainWindow: destroyed });
  let recreated = 0;

  const result = lifecycle.handleActivate({
    recreate: () => { recreated += 1; },
    restore: () => { throw new Error('must not call methods on a destroyed window'); }
  });

  assert.equal(result, 'recreated');
  assert.equal(recreated, 1);
  assert.equal(destroyed.calls.show, 0);
  assert.equal(windows.has('main'), false, 'destroyed window must be evicted');
});

test('activation with no window at all recreates', () => {
  const { lifecycle } = makeHarness({ mainWindow: null });
  let recreated = 0;

  const result = lifecycle.handleActivate({ recreate: () => { recreated += 1; } });

  assert.equal(result, 'recreated');
  assert.equal(recreated, 1);
});

test('activation is ignored while quitting or updating', () => {
  for (const enter of ['quit', 'update']) {
    const { lifecycle } = makeHarness();
    if (enter === 'quit') lifecycle.requestQuit('cmd-q');
    else lifecycle.beginUpdate(() => {});

    const result = lifecycle.handleActivate({
      restore: () => { throw new Error('must not restore during shutdown'); },
      recreate: () => { throw new Error('must not recreate during shutdown'); }
    });

    assert.equal(result, 'ignored');
  }
});

// ---- updater-driven shutdown ----

test('installing an update enters the updating state before quitAndInstall()', () => {
  const { lifecycle } = makeHarness();
  const order = [];

  lifecycle.beginUpdate(() => order.push(`install:${lifecycle.state}`));

  assert.deepEqual(order, [`install:${STATE_UPDATING}`]);
  assert.equal(lifecycle.state, STATE_UPDATING);
});

test('updater shutdown cleans up once and does not also call app.quit()', () => {
  const { lifecycle, counts } = makeHarness();

  lifecycle.beginUpdate(() => {});

  assert.equal(counts.unregisterAll, 1);
  assert.equal(counts.speechShutdown, 1);
  assert.equal(counts.destroyAllWindows, 1);
  assert.equal(counts.quit, 0, 'quitAndInstall drives its own shutdown');

  // The subsequent will-quit must not repeat the work.
  assert.equal(lifecycle.runCleanup('will-quit'), false);
  assert.equal(counts.unregisterAll, 1);
});

test('a quit request during an update install is ignored', () => {
  const { lifecycle, counts } = makeHarness();

  lifecycle.beginUpdate(() => {});
  const result = lifecycle.requestQuit('cmd-q');

  assert.equal(result.accepted, false);
  assert.equal(result.state, STATE_UPDATING);
  assert.equal(counts.quit, 0);
});

test('an update install during a quit is refused', () => {
  const { lifecycle } = makeHarness();
  let installed = 0;

  lifecycle.requestQuit('cmd-q');
  const result = lifecycle.beginUpdate(() => { installed += 1; });

  assert.equal(result.accepted, false);
  assert.equal(installed, 0);
  assert.equal(lifecycle.state, STATE_QUITTING);
});

test('a failing quitAndInstall falls back to a normal quit', () => {
  const { lifecycle, counts } = makeHarness();

  lifecycle.beginUpdate(() => { throw new Error('installer missing'); });

  assert.equal(counts.quit, 1, 'must not leave the app wedged in updating');
});

// ---- macOS application menu ----

test('the macOS menu exposes the standard application items', () => {
  const template = buildMacMenuTemplate({
    appName: 'OpenCluely',
    onQuit: () => {},
    onCheckForUpdates: () => {}
  });

  const appMenu = template[0];
  assert.equal(appMenu.label, 'OpenCluely');

  const labels = appMenu.submenu.map((i) => i.label || `<${i.type}>`);
  assert.ok(labels.includes('About OpenCluely'));
  assert.ok(labels.includes('Check for Updates…'));
  assert.ok(labels.includes('Hide OpenCluely'));
  assert.ok(labels.includes('Hide Others'));
  assert.ok(labels.includes('Show All'));
  assert.ok(labels.includes('Quit OpenCluely'));
});

test('Cmd+Q is bound to the lifecycle controller, not the built-in quit role', () => {
  let quitCalls = 0;
  const template = buildMacMenuTemplate({
    onQuit: () => { quitCalls += 1; },
    onCheckForUpdates: () => {}
  });

  const quitItem = template[0].submenu.find((i) => i.label === 'Quit OpenCluely');
  assert.equal(quitItem.accelerator, 'Command+Q');
  assert.equal(quitItem.role, undefined, 'role:quit would bypass AppLifecycle');

  quitItem.click();
  assert.equal(quitCalls, 1);
});

test('Cmd+Q through the menu is idempotent because it routes through requestQuit', () => {
  const { lifecycle, counts } = makeHarness();
  const template = buildMacMenuTemplate({
    onQuit: () => lifecycle.requestQuit('cmd-q'),
    onCheckForUpdates: () => {}
  });
  const quitItem = template[0].submenu.find((i) => i.label === 'Quit OpenCluely');

  quitItem.click();
  quitItem.click();
  quitItem.click();

  assert.equal(counts.quit, 1);
});

test('Check for Updates is wired to the updater', () => {
  let checks = 0;
  const template = buildMacMenuTemplate({
    onQuit: () => {},
    onCheckForUpdates: () => { checks += 1; }
  });

  template[0].submenu.find((i) => i.label === 'Check for Updates…').click();
  assert.equal(checks, 1);
});

test('the Edit menu keeps clipboard shortcuts working in Settings fields', () => {
  const template = buildMacMenuTemplate({ onQuit: () => {}, onCheckForUpdates: () => {} });
  const editMenu = template.find((m) => m.label === 'Edit');

  const roles = editMenu.submenu.map((i) => i.role);
  for (const role of ['cut', 'copy', 'paste', 'selectAll']) {
    assert.ok(roles.includes(role), `Edit menu should provide ${role}`);
  }
});

test('installMacMenu is a no-op off macOS', () => {
  let built = 0;
  const Menu = {
    buildFromTemplate: () => { built += 1; return {}; },
    setApplicationMenu: () => {}
  };

  assert.equal(installMacMenu({ Menu, platform: 'win32', options: {} }), false);
  assert.equal(built, 0);

  assert.equal(installMacMenu({ Menu, platform: 'darwin', options: {} }), true);
  assert.equal(built, 1);
});

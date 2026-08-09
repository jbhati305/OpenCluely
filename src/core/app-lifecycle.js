'use strict';

/**
 * Centralised application lifecycle controller.
 *
 * Before this existed the app had three independent shutdown paths that all
 * did the same work:
 *
 *   1. ipcMain.handle("quit-app")  — cleanup + app.quit() + process.exit(0) @2s
 *   2. ipcMain.on("quit-app")      — cleanup + app.quit() + process.exit(0) @1s
 *   3. app.on("will-quit")         — cleanup again
 *
 * The Settings window fired BOTH renderer quit APIs on one click, so (2) ran
 * twice, then (3) ran once more. Cleanup executed three-to-four times and two
 * racing process.exit() timers tore the process down mid-shutdown — which is
 * what left orphaned helper processes behind and made "Quit" feel broken.
 *
 * This controller collapses all of that into one state machine:
 *
 *   running ──requestQuit()──▶ quitting ──▶ (cleanup once) ──▶ app exits
 *      │
 *      └────beginUpdate()───▶ updating ──▶ (cleanup once) ──▶ quitAndInstall()
 *
 * Everything it touches is injected, so the whole thing is unit-testable
 * without an Electron runtime — matching the existing scripts/lib/* pattern.
 */

const STATE_RUNNING = 'running';
const STATE_QUITTING = 'quitting';
const STATE_UPDATING = 'updating';

/** Upper bound on how long we wait for Electron to tear itself down. */
const DEFAULT_EMERGENCY_EXIT_MS = 8000;

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

class AppLifecycle {
  /**
   * @param {object} deps
   * @param {object} deps.app                Electron `app`.
   * @param {object} [deps.globalShortcut]   Electron `globalShortcut`.
   * @param {object} [deps.windowManager]    WindowManager singleton.
   * @param {object} [deps.speechService]    Speech service with shutdown().
   * @param {object} [deps.sessionManager]   Session manager (stats only).
   * @param {object} [deps.logger]
   * @param {string} [deps.platform]         Defaults to process.platform.
   * @param {number} [deps.emergencyExitMs]  Bounded fallback window.
   * @param {Function} [deps.setTimeoutFn]   Injectable for tests.
   * @param {Function} [deps.clearTimeoutFn] Injectable for tests.
   */
  constructor(deps = {}) {
    this.app = deps.app;
    this.globalShortcut = deps.globalShortcut || null;
    this.windowManager = deps.windowManager || null;
    this.speechService = deps.speechService || null;
    this.sessionManager = deps.sessionManager || null;
    this.logger = deps.logger || noopLogger;
    this.platform = deps.platform || process.platform;
    this.emergencyExitMs =
      typeof deps.emergencyExitMs === 'number'
        ? deps.emergencyExitMs
        : DEFAULT_EMERGENCY_EXIT_MS;
    this._setTimeout = deps.setTimeoutFn || setTimeout;
    this._clearTimeout = deps.clearTimeoutFn || clearTimeout;

    this._state = STATE_RUNNING;
    this._cleanupRan = false;
    this._emergencyTimer = null;
    /** Extra teardown callbacks registered by services (workers, timers). */
    this._disposers = [];
  }

  get state() {
    return this._state;
  }

  get isShuttingDown() {
    return this._state !== STATE_RUNNING;
  }

  /** True once cleanup has executed. Exposed for tests and diagnostics. */
  get cleanupRan() {
    return this._cleanupRan;
  }

  /**
   * Register an additional teardown callback (worker pool, interval, etc).
   * Disposers run exactly once, inside the single cleanup pass.
   * @param {string} name
   * @param {Function} fn
   */
  registerDisposer(name, fn) {
    if (typeof fn !== 'function') return;
    this._disposers.push({ name, fn });
  }

  /**
   * Idempotent quit request. Every quit entry point — Settings button,
   * application menu, Cmd+Q, dock "Quit" — funnels through here.
   *
   * @param {string} reason Free-text source, for logs only.
   * @returns {{accepted: boolean, state: string}} `accepted` is false when a
   *   shutdown was already in progress, so callers can tell a duplicate
   *   request from the one that actually started the shutdown.
   */
  requestQuit(reason = 'unspecified') {
    if (this._state !== STATE_RUNNING) {
      this.logger.debug('Quit request ignored; shutdown already in progress', {
        reason,
        state: this._state
      });
      return { accepted: false, state: this._state };
    }

    this._state = STATE_QUITTING;
    this.logger.info('Quit requested', { reason });

    this._armEmergencyExit(reason);

    try {
      this.app.quit();
    } catch (error) {
      this.logger.error('app.quit() threw; falling back to emergency exit', {
        reason,
        error: error && error.message
      });
      this._emergencyExit('app.quit-threw');
    }

    return { accepted: true, state: this._state };
  }

  /**
   * Record a shutdown that Electron started without going through
   * requestQuit() — the dock's right-click Quit, a macOS logout, or a
   * `before-quit` raised by the OS.
   *
   * Unlike requestQuit() this never calls app.quit() (we are already inside
   * it) and never arms the emergency exit, but it does move the state machine
   * so `activate` and close-to-hide stop interfering with the teardown.
   *
   * @param {string} reason
   * @returns {boolean} true if this call changed the state.
   */
  noteExternalQuit(reason = 'before-quit') {
    if (this._state !== STATE_RUNNING) return false;
    this._state = STATE_QUITTING;
    this.logger.info('Shutdown started outside requestQuit()', { reason });
    return true;
  }

  /**
   * Enter the `updating` state and hand off to electron-updater.
   *
   * This is deliberately separate from requestQuit(): quitAndInstall() drives
   * its own shutdown, so arming the emergency exit or calling app.quit() here
   * would race the installer. Cleanup still runs exactly once, via will-quit.
   *
   * @param {Function} installFn Typically `() => autoUpdater.quitAndInstall()`.
   * @returns {{accepted: boolean, state: string}}
   */
  beginUpdate(installFn) {
    if (this._state !== STATE_RUNNING) {
      this.logger.warn('Update install ignored; shutdown already in progress', {
        state: this._state
      });
      return { accepted: false, state: this._state };
    }

    this._state = STATE_UPDATING;
    this.logger.info('Entering updating state before quitAndInstall()');

    // Shortcuts and capture devices must be released before the installer
    // swaps the bundle, otherwise the relaunched app can start with a dead
    // global-shortcut registration.
    this.runCleanup('update-install');

    try {
      if (typeof installFn === 'function') installFn();
    } catch (error) {
      this.logger.error('quitAndInstall() failed', {
        error: error && error.message
      });
      // The bundle may be half-swapped; a normal quit is the safest exit.
      this._armEmergencyExit('update-install-failed');
      try {
        this.app.quit();
      } catch (_) {
        this._emergencyExit('update-install-failed');
      }
    }

    return { accepted: true, state: this._state };
  }

  /**
   * Run every teardown step exactly once, regardless of how many times this
   * is called or from which path (IPC, will-quit, updater).
   *
   * Each step is isolated: one throwing service must not strand the rest.
   * @param {string} trigger
   * @returns {boolean} true if this call performed the cleanup.
   */
  runCleanup(trigger = 'will-quit') {
    if (this._cleanupRan) {
      this.logger.debug('Cleanup already completed; skipping', { trigger });
      return false;
    }
    this._cleanupRan = true;

    this.logger.info('Running application cleanup', {
      trigger,
      state: this._state
    });

    for (const step of this._cleanupSteps()) {
      try {
        step.fn();
      } catch (error) {
        this.logger.error('Cleanup step failed', {
          step: step.name,
          error: error && error.message
        });
      }
    }

    this._logSessionStats();
    this._disarmEmergencyExit();
    return true;
  }

  /** Ordered teardown: inputs first, then producers, then windows. */
  _cleanupSteps() {
    const steps = [];

    if (this.globalShortcut) {
      steps.push({
        name: 'globalShortcut.unregisterAll',
        fn: () => this.globalShortcut.unregisterAll()
      });
    }

    if (this.speechService && typeof this.speechService.shutdown === 'function') {
      steps.push({
        name: 'speechService.shutdown',
        fn: () => this.speechService.shutdown()
      });
    }

    for (const disposer of this._disposers) {
      steps.push({ name: `disposer:${disposer.name}`, fn: disposer.fn });
    }

    if (
      this.windowManager &&
      typeof this.windowManager.destroyAllWindows === 'function'
    ) {
      steps.push({
        name: 'windowManager.destroyAllWindows',
        fn: () => this.windowManager.destroyAllWindows()
      });
    }

    return steps;
  }

  _logSessionStats() {
    if (!this.sessionManager || typeof this.sessionManager.getMemoryUsage !== 'function') {
      return;
    }
    try {
      const stats = this.sessionManager.getMemoryUsage();
      this.logger.info('Application shutting down', {
        sessionEvents: stats && stats.eventCount,
        sessionSize: stats && stats.approximateSize
      });
    } catch (error) {
      this.logger.warn('Could not read session stats during shutdown', {
        error: error && error.message
      });
    }
  }

  /**
   * `window-all-closed`.
   *
   * macOS convention: closing the last window does NOT quit — the app stays
   * alive in the dock and is restored on activate. Windows/Linux keep the
   * historical behaviour of quitting, now routed through requestQuit() so
   * cleanup still happens exactly once.
   */
  handleWindowAllClosed() {
    if (this.platform === 'darwin') {
      this.logger.debug('All windows closed; staying resident (macOS)');
      return false;
    }
    this.requestQuit('window-all-closed');
    return true;
  }

  /**
   * `activate` (dock click / Cmd+Tab).
   *
   * @param {object} [handlers]
   * @param {Function} [handlers.recreate] Called when no usable window exists.
   * @param {Function} [handlers.restore]  Called with the live main window.
   * @returns {'ignored'|'recreated'|'restored'|'noop'}
   */
  handleActivate(handlers = {}) {
    if (this.isShuttingDown) {
      this.logger.debug('Activate ignored during shutdown', {
        state: this._state
      });
      return 'ignored';
    }

    const mainWindow = this._liveWindow('main');

    if (!mainWindow) {
      this.logger.info('Activate with no live main window; recreating');
      try {
        if (typeof handlers.recreate === 'function') {
          handlers.recreate();
          return 'recreated';
        }
      } catch (error) {
        this.logger.error('Failed to recreate windows on activate', {
          error: error && error.message
        });
      }
      return 'noop';
    }

    try {
      if (typeof handlers.restore === 'function') {
        handlers.restore(mainWindow);
        return 'restored';
      }
    } catch (error) {
      this.logger.error('Failed to restore windows on activate', {
        error: error && error.message
      });
    }
    return 'noop';
  }

  /**
   * Fetch a window only if it is safe to call BrowserWindow methods on it.
   * Destroyed windows are evicted from the manager so stale handles can never
   * be handed out twice.
   * @param {string} type
   * @returns {object|null}
   */
  _liveWindow(type) {
    if (!this.windowManager || typeof this.windowManager.getWindow !== 'function') {
      return null;
    }

    let win = null;
    try {
      win = this.windowManager.getWindow(type);
    } catch (error) {
      this.logger.warn('getWindow threw', { type, error: error && error.message });
      return null;
    }

    if (!win) return null;

    let destroyed = false;
    try {
      destroyed = typeof win.isDestroyed === 'function' ? win.isDestroyed() : false;
    } catch (_) {
      destroyed = true;
    }

    if (destroyed) {
      this._evictWindow(type);
      return null;
    }

    return win;
  }

  /** Drop a destroyed window from the manager's registry. */
  _evictWindow(type) {
    try {
      if (this.windowManager && this.windowManager.windows &&
          typeof this.windowManager.windows.delete === 'function') {
        this.windowManager.windows.delete(type);
        this.logger.debug('Evicted destroyed window from manager', { type });
      }
    } catch (error) {
      this.logger.warn('Could not evict destroyed window', {
        type,
        error: error && error.message
      });
    }
  }

  /**
   * Red traffic-light / Cmd+W. On macOS the app stays resident, so a close
   * request hides the window instead of destroying it. Returns true when the
   * caller should preventDefault().
   *
   * During shutdown we let the close proceed — that IS the teardown.
   *
   * @param {object} win  BrowserWindow-like.
   * @param {string} type
   * @returns {boolean} true if the close was intercepted (window hidden).
   */
  handleWindowCloseRequest(win, type) {
    if (this.isShuttingDown) return false;
    if (this.platform !== 'darwin') return false;
    if (!win) return false;

    try {
      if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false;
      win.hide();
      this.logger.debug('Window close intercepted; hidden instead', { type });
      return true;
    } catch (error) {
      this.logger.warn('Could not hide window on close', {
        type,
        error: error && error.message
      });
      return false;
    }
  }

  /** Bounded last resort. Only ever fires if Electron fails to exit. */
  _armEmergencyExit(reason) {
    if (this._emergencyTimer || this.emergencyExitMs <= 0) return;

    this._emergencyTimer = this._setTimeout(() => {
      this._emergencyExit(reason);
    }, this.emergencyExitMs);

    // Never let the fallback timer itself keep the process alive.
    if (this._emergencyTimer && typeof this._emergencyTimer.unref === 'function') {
      this._emergencyTimer.unref();
    }
  }

  _disarmEmergencyExit() {
    if (!this._emergencyTimer) return;
    this._clearTimeout(this._emergencyTimer);
    this._emergencyTimer = null;
  }

  _emergencyExit(reason) {
    this._emergencyTimer = null;
    this.logger.error(
      'EMERGENCY EXIT: Electron did not shut down within the grace period. ' +
      'Forcing process termination — this indicates a stuck teardown step.',
      { reason, graceMs: this.emergencyExitMs, state: this._state }
    );

    try {
      if (this.app && typeof this.app.exit === 'function') {
        this.app.exit(0);
        return;
      }
    } catch (error) {
      this.logger.error('app.exit() failed during emergency exit', {
        error: error && error.message
      });
    }
    process.exit(0);
  }
}

module.exports = {
  AppLifecycle,
  STATE_RUNNING,
  STATE_QUITTING,
  STATE_UPDATING,
  DEFAULT_EMERGENCY_EXIT_MS
};

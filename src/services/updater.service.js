'use strict';

/**
 * One-click updates for packaged macOS builds, backed by public GitHub
 * Releases via electron-updater.
 *
 * Design constraints this file exists to enforce:
 *
 *   - **Never phones home from source runs.** The service is inert unless
 *     `app.isPackaged` is true AND the platform is darwin. A developer running
 *     `npm start` must never contact the update server.
 *   - **No embedded credentials and no hard-coded fork.** The repository is
 *     baked into `app-update.yml` at build time (see scripts/lib/update-repo.js),
 *     so nothing here names a GitHub owner. Public releases need no token.
 *   - **Install only after download.** `quitAndInstall()` is unreachable
 *     unless the state machine has reached `downloaded`.
 *   - **One dialog per version.** A repeated check that re-reports the same
 *     downloaded version must not stack dialogs.
 *
 * electron-updater is injected rather than required at module scope, so the
 * whole state machine is testable without the real dependency.
 */

const STATE_IDLE = 'idle';
const STATE_CHECKING = 'checking';
const STATE_DOWNLOADING = 'downloading';
const STATE_DOWNLOADED = 'downloaded';
const STATE_NOT_AVAILABLE = 'not-available';
const STATE_ERROR = 'error';

const UPDATE_STATES = [
  STATE_IDLE,
  STATE_CHECKING,
  STATE_DOWNLOADING,
  STATE_DOWNLOADED,
  STATE_NOT_AVAILABLE,
  STATE_ERROR
];

/** Delay before the single automatic startup check. */
const STARTUP_CHECK_DELAY_MS = 10000;

/**
 * Turn an electron-updater error into something a user can act on.
 * @param {Error|*} error
 * @returns {string}
 */
function describeUpdateError(error) {
  const message = (error && error.message) || String(error || 'Unknown error');

  if (/ENOTFOUND|EAI_AGAIN|ENETDOWN|ENETUNREACH|ETIMEDOUT/i.test(message)) {
    return 'Could not reach the update server. Check your internet connection and try again.';
  }
  if (/404/.test(message)) {
    return 'No published release was found for this application. If you built this copy locally, updates are not available.';
  }
  if (/403|rate limit/i.test(message)) {
    return 'GitHub temporarily rate-limited the update check. Please try again in a few minutes.';
  }
  if (/signature|code signature|not signed/i.test(message)) {
    return 'The downloaded update failed signature validation and was discarded. Re-download the app from the releases page.';
  }
  if (/ENOSPC/i.test(message)) {
    return 'Not enough disk space to download the update.';
  }
  return `Update failed: ${message}`;
}

class UpdaterService {
  /**
   * @param {object} deps
   * @param {object} deps.app                   Electron `app`.
   * @param {object} [deps.autoUpdater]         electron-updater's autoUpdater.
   * @param {object} [deps.dialog]              Electron `dialog`.
   * @param {object} [deps.lifecycle]           AppLifecycle instance.
   * @param {object} [deps.logger]
   * @param {string} [deps.platform]
   * @param {Function} [deps.setTimeoutFn]
   * @param {Function} [deps.onStateChange]     Broadcast hook for renderers.
   * @param {number} [deps.startupCheckDelayMs]
   */
  constructor(deps = {}) {
    this.app = deps.app || null;
    this.autoUpdater = deps.autoUpdater || null;
    this.dialog = deps.dialog || null;
    this.lifecycle = deps.lifecycle || null;
    this.logger = deps.logger || {
      debug() {}, info() {}, warn() {}, error() {}
    };
    this.platform = deps.platform || process.platform;
    this._setTimeout = deps.setTimeoutFn || setTimeout;
    this.onStateChange = deps.onStateChange || null;
    this.startupCheckDelayMs =
      typeof deps.startupCheckDelayMs === 'number'
        ? deps.startupCheckDelayMs
        : STARTUP_CHECK_DELAY_MS;

    this._state = STATE_IDLE;
    this._availableVersion = null;
    this._percent = 0;
    this._lastCheckAt = null;
    this._errorMessage = null;

    /** In-flight check, reused so concurrent callers coalesce. */
    this._checkPromise = null;
    /** Versions we have already shown the install prompt for. */
    this._promptedVersions = new Set();
    this._wired = false;
    this._startupCheckScheduled = false;
  }

  /**
   * Updates are only ever active for a packaged macOS build.
   * @returns {boolean}
   */
  get isEnabled() {
    if (this.platform !== 'darwin') return false;
    if (!this.app || typeof this.app.isPackaged === 'undefined') return false;
    if (!this.app.isPackaged) return false;
    return Boolean(this.autoUpdater);
  }

  get currentVersion() {
    try {
      if (this.app && typeof this.app.getVersion === 'function') {
        return this.app.getVersion();
      }
    } catch (_) { /* fall through */ }
    return null;
  }

  /**
   * Snapshot for `updates:get-state` and the Settings UI.
   * @returns {object}
   */
  getState() {
    return {
      state: this._state,
      enabled: this.isEnabled,
      currentVersion: this.currentVersion,
      availableVersion: this._availableVersion,
      percent: this._percent,
      lastCheckAt: this._lastCheckAt,
      error: this._errorMessage,
      canInstall: this._state === STATE_DOWNLOADED
    };
  }

  _setState(state, patch = {}) {
    if (!UPDATE_STATES.includes(state)) return;
    this._state = state;
    if ('availableVersion' in patch) this._availableVersion = patch.availableVersion;
    if ('percent' in patch) this._percent = patch.percent;
    if ('error' in patch) this._errorMessage = patch.error;

    const snapshot = this.getState();
    this.logger.debug('Updater state changed', { state, percent: this._percent });

    if (typeof this.onStateChange === 'function') {
      try {
        this.onStateChange(snapshot);
      } catch (error) {
        this.logger.warn('Updater state broadcast failed', {
          error: error && error.message
        });
      }
    }
  }

  /**
   * Attach electron-updater listeners. Safe to call more than once.
   * @returns {boolean} true if listeners were attached.
   */
  initialize() {
    if (!this.isEnabled) {
      this.logger.info('Updater disabled', {
        platform: this.platform,
        isPackaged: Boolean(this.app && this.app.isPackaged)
      });
      return false;
    }
    if (this._wired) return true;

    const au = this.autoUpdater;

    // We drive the download ourselves so the state machine stays accurate,
    // and let electron-updater install a staged update on the next quit if
    // the user chose "Later".
    au.autoDownload = false;
    au.autoInstallOnAppQuit = true;
    if (au.logger !== undefined) au.logger = null; // keep its noise out of stdout

    au.on('checking-for-update', () => {
      this._setState(STATE_CHECKING, { error: null });
    });

    au.on('update-available', (info) => {
      const version = info && info.version;
      this.logger.info('Update available', { version });
      this._setState(STATE_DOWNLOADING, {
        availableVersion: version,
        percent: 0,
        error: null
      });
      this._startDownload();
    });

    au.on('update-not-available', () => {
      this._setState(STATE_NOT_AVAILABLE, { availableVersion: null, error: null });
    });

    au.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round((progress && progress.percent) || 0)));
      this._setState(STATE_DOWNLOADING, { percent });
    });

    au.on('update-downloaded', (info) => {
      const version = info && info.version;
      this.logger.info('Update downloaded', { version });
      this._setState(STATE_DOWNLOADED, { availableVersion: version, percent: 100 });
      this._promptToInstall(version);
    });

    au.on('error', (error) => {
      this._handleError(error);
    });

    this._wired = true;
    return true;
  }

  /**
   * Schedule the single automatic check shortly after startup.
   * @returns {boolean} true if a check was scheduled.
   */
  scheduleStartupCheck() {
    if (!this.isEnabled) return false;
    if (this._startupCheckScheduled) return false;
    this._startupCheckScheduled = true;

    const timer = this._setTimeout(() => {
      this.checkForUpdates({ manual: false }).catch(() => { /* non-blocking */ });
    }, this.startupCheckDelayMs);

    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }

  /**
   * Check for updates. Concurrent calls share one in-flight check.
   *
   * @param {object} [options]
   * @param {boolean} [options.manual] Manual checks surface errors to the user.
   * @returns {Promise<object>} the resulting state snapshot.
   */
  async checkForUpdates(options = {}) {
    const manual = Boolean(options.manual);

    if (!this.isEnabled) {
      const reason = this.platform !== 'darwin'
        ? 'Automatic updates are only available in the macOS build.'
        : 'Automatic updates are only available in the installed application.';
      if (manual) this._showMessage('Updates unavailable', reason);
      return { ...this.getState(), skipped: true, reason };
    }

    // Nothing to gain from re-checking once an update is staged.
    if (this._state === STATE_DOWNLOADED) {
      if (manual) this._promptToInstall(this._availableVersion);
      return this.getState();
    }

    if (this._checkPromise) {
      this.logger.debug('Coalescing concurrent update check');
      return this._checkPromise;
    }

    this._lastCheckAt = new Date().toISOString();
    this._checkPromise = this._runCheck(manual).finally(() => {
      this._checkPromise = null;
    });

    return this._checkPromise;
  }

  async _runCheck(manual) {
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (error) {
      this._handleError(error, manual);
    }
    return this.getState();
  }

  _startDownload() {
    if (!this.autoUpdater || typeof this.autoUpdater.downloadUpdate !== 'function') return;
    try {
      const result = this.autoUpdater.downloadUpdate();
      if (result && typeof result.catch === 'function') {
        result.catch((error) => this._handleError(error));
      }
    } catch (error) {
      this._handleError(error);
    }
  }

  /**
   * Automatic failures are logged and shown only in the Settings panel;
   * manual failures get a dialog with an actionable message.
   */
  _handleError(error, manual = false) {
    const message = describeUpdateError(error);
    this.logger.warn('Update error', {
      manual,
      error: (error && error.message) || String(error)
    });
    this._setState(STATE_ERROR, { error: message });
    if (manual) this._showMessage('Update failed', message);
  }

  /**
   * Ask the user to restart now or later. Shown at most once per version.
   * @param {string} version
   */
  _promptToInstall(version) {
    if (this._state !== STATE_DOWNLOADED) return;

    const key = version || 'unknown';
    if (this._promptedVersions.has(key)) {
      this.logger.debug('Install prompt already shown for version', { version });
      return;
    }
    this._promptedVersions.add(key);

    if (!this.dialog || typeof this.dialog.showMessageBox !== 'function') return;

    const result = this.dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: `OpenCluely ${version} is ready to install.`,
      detail: 'Restart now to finish updating, or choose Later and it will be installed the next time you quit OpenCluely.'
    });

    Promise.resolve(result)
      .then((response) => {
        const index = typeof response === 'number' ? response : (response && response.response);
        if (index === 0) this.installUpdate();
      })
      .catch((error) => {
        this.logger.warn('Install prompt failed', { error: error && error.message });
      });
  }

  /**
   * Restart and install. Guarded so an install can never begin before the
   * update is fully downloaded.
   *
   * @returns {{success: boolean, error?: string}}
   */
  installUpdate() {
    if (!this.isEnabled) {
      return { success: false, error: 'Updates are not available in this build.' };
    }
    if (this._state !== STATE_DOWNLOADED) {
      const error = 'No downloaded update is ready to install.';
      this.logger.warn('Install refused', { state: this._state });
      return { success: false, error };
    }

    const install = () => this.autoUpdater.quitAndInstall();

    // The lifecycle controller must enter `updating` (and run its single
    // cleanup pass) before the installer swaps the bundle.
    if (this.lifecycle && typeof this.lifecycle.beginUpdate === 'function') {
      const outcome = this.lifecycle.beginUpdate(install);
      if (!outcome.accepted) {
        return { success: false, error: `Cannot install while ${outcome.state}.` };
      }
      return { success: true };
    }

    try {
      install();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error && error.message) || 'Install failed' };
    }
  }

  _showMessage(title, message) {
    if (!this.dialog || typeof this.dialog.showMessageBox !== 'function') return;
    try {
      this.dialog.showMessageBox({
        type: title === 'Update failed' ? 'error' : 'info',
        buttons: ['OK'],
        title,
        message,
        detail: undefined
      });
    } catch (error) {
      this.logger.warn('Could not show updater dialog', {
        error: error && error.message
      });
    }
  }
}

module.exports = {
  UpdaterService,
  describeUpdateError,
  UPDATE_STATES,
  STARTUP_CHECK_DELAY_MS,
  STATE_IDLE,
  STATE_CHECKING,
  STATE_DOWNLOADING,
  STATE_DOWNLOADED,
  STATE_NOT_AVAILABLE,
  STATE_ERROR
};

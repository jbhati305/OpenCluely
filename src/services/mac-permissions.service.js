'use strict';

/**
 * macOS privacy (TCC) permission inspection for Screen Recording and the
 * microphone.
 *
 * Scope is deliberately narrow:
 *   - We only ever *read* status, *open* the relevant System Settings pane,
 *     and *request* microphone access in response to a direct user click.
 *   - We never reset TCC (`tccutil reset` would revoke the user's grants and
 *     needs privileges we should not ask for).
 *   - We never prompt on a timer or at startup. Screen Recording has no
 *     request API at all: macOS shows its prompt the first time the app
 *     actually attempts a capture, so that flow is left exactly as it was.
 *
 * Everything is injected so the logic is testable without Electron.
 */

const STATUS_GRANTED = 'granted';
const STATUS_DENIED = 'denied';
const STATUS_RESTRICTED = 'restricted';
const STATUS_NOT_DETERMINED = 'not-determined';
const STATUS_UNKNOWN = 'unknown';

const VALID_STATUSES = [
  STATUS_GRANTED,
  STATUS_DENIED,
  STATUS_RESTRICTED,
  STATUS_NOT_DETERMINED,
  STATUS_UNKNOWN
];

/** Electron media types backing each permission we surface. */
const MEDIA_TYPES = {
  screen: 'screen',
  microphone: 'microphone'
};

/** Deep links into the Privacy & Security pane. */
const SETTINGS_PANES = {
  screen:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
};

/**
 * Coerce whatever Electron (or a stub) hands back into our closed set.
 *
 * Electron documents 'not-determined' | 'granted' | 'denied' | 'restricted' |
 * 'unknown', but older/newer versions and non-macOS platforms have returned
 * other spellings, so normalise defensively rather than trusting the string.
 *
 * @param {*} raw
 * @returns {string} one of VALID_STATUSES
 */
function normalizeStatus(raw) {
  if (typeof raw !== 'string') return STATUS_UNKNOWN;

  const value = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!value) return STATUS_UNKNOWN;

  if (VALID_STATUSES.includes(value)) return value;

  // Tolerated aliases seen across Electron versions and platforms.
  switch (value) {
    case 'authorized':
    case 'allowed':
    case 'true':
      return STATUS_GRANTED;
    case 'notdetermined':
    case 'undetermined':
      return STATUS_NOT_DETERMINED;
    case 'restricted-by-policy':
      return STATUS_RESTRICTED;
    case 'denied-by-user':
    case 'false':
      return STATUS_DENIED;
    default:
      return STATUS_UNKNOWN;
  }
}

/**
 * Does changing this permission require an application restart to take
 * effect? Screen Recording grants are only picked up by a process that
 * starts after the grant, so the UI must say so.
 * @param {string} permission
 * @returns {boolean}
 */
function requiresRestart(permission) {
  return permission === 'screen';
}

class MacPermissionsService {
  /**
   * @param {object} deps
   * @param {object} [deps.systemPreferences] Electron `systemPreferences`.
   * @param {object} [deps.shell]             Electron `shell`.
   * @param {string} [deps.platform]
   * @param {object} [deps.logger]
   */
  constructor(deps = {}) {
    this.systemPreferences = deps.systemPreferences || null;
    this.shell = deps.shell || null;
    this.platform = deps.platform || process.platform;
    this.logger = deps.logger || {
      debug() {}, info() {}, warn() {}, error() {}
    };
  }

  get isSupported() {
    return this.platform === 'darwin';
  }

  /**
   * Read one permission's current status. Never prompts.
   * @param {'screen'|'microphone'} permission
   * @returns {{permission: string, status: string, supported: boolean,
   *            requiresRestart: boolean, error?: string}}
   */
  getStatus(permission) {
    const base = {
      permission,
      status: STATUS_UNKNOWN,
      supported: this.isSupported,
      requiresRestart: requiresRestart(permission)
    };

    if (!MEDIA_TYPES[permission]) {
      return { ...base, error: `Unknown permission: ${permission}` };
    }

    // Windows and Linux have no TCC equivalent; report unsupported rather
    // than inventing a status, and change nothing about their behaviour.
    if (!this.isSupported) return base;

    const sp = this.systemPreferences;
    if (!sp || typeof sp.getMediaAccessStatus !== 'function') {
      return { ...base, error: 'systemPreferences.getMediaAccessStatus unavailable' };
    }

    try {
      const raw = sp.getMediaAccessStatus(MEDIA_TYPES[permission]);
      return { ...base, status: normalizeStatus(raw) };
    } catch (error) {
      this.logger.warn('Failed to read permission status', {
        permission,
        error: error && error.message
      });
      return { ...base, status: STATUS_UNKNOWN, error: error && error.message };
    }
  }

  /**
   * Snapshot of everything the Settings UI renders.
   * @returns {{supported: boolean, platform: string, screen: object, microphone: object, checkedAt: string}}
   */
  getAllStatuses() {
    return {
      supported: this.isSupported,
      platform: this.platform,
      screen: this.getStatus('screen'),
      microphone: this.getStatus('microphone'),
      checkedAt: new Date().toISOString()
    };
  }

  /**
   * Ask macOS for microphone access.
   *
   * MUST only be called from a direct user action (the Settings "Allow"
   * button). macOS shows the system prompt exactly once per install; after a
   * denial the only route is System Settings, which we surface instead.
   *
   * @returns {Promise<{permission: string, status: string, granted: boolean,
   *                    prompted: boolean, supported: boolean, error?: string,
   *                    needsSystemSettings?: boolean}>}
   */
  async requestMicrophoneAccess() {
    const permission = 'microphone';

    if (!this.isSupported) {
      return {
        permission,
        status: STATUS_UNKNOWN,
        granted: false,
        prompted: false,
        supported: false
      };
    }

    const current = this.getStatus(permission);

    // Already settled — re-asking cannot show a prompt, so don't pretend.
    if (current.status === STATUS_GRANTED) {
      return {
        permission,
        status: STATUS_GRANTED,
        granted: true,
        prompted: false,
        supported: true
      };
    }

    if (current.status === STATUS_DENIED || current.status === STATUS_RESTRICTED) {
      return {
        permission,
        status: current.status,
        granted: false,
        prompted: false,
        supported: true,
        needsSystemSettings: true
      };
    }

    const sp = this.systemPreferences;
    if (!sp || typeof sp.askForMediaAccess !== 'function') {
      return {
        permission,
        status: current.status,
        granted: false,
        prompted: false,
        supported: true,
        error: 'systemPreferences.askForMediaAccess unavailable'
      };
    }

    try {
      const granted = await sp.askForMediaAccess(MEDIA_TYPES[permission]);
      return {
        permission,
        status: granted ? STATUS_GRANTED : STATUS_DENIED,
        granted: Boolean(granted),
        prompted: true,
        supported: true
      };
    } catch (error) {
      this.logger.warn('Microphone access request failed', {
        error: error && error.message
      });
      return {
        permission,
        status: STATUS_UNKNOWN,
        granted: false,
        prompted: true,
        supported: true,
        error: error && error.message
      };
    }
  }

  /**
   * Open the relevant Privacy & Security pane. This is the only remediation
   * path for an already-denied permission.
   *
   * @param {'screen'|'microphone'} permission
   * @returns {Promise<{success: boolean, permission: string, url?: string, error?: string}>}
   */
  async openSystemSettings(permission) {
    const url = SETTINGS_PANES[permission];

    if (!url) {
      return { success: false, permission, error: `Unknown permission: ${permission}` };
    }
    if (!this.isSupported) {
      return { success: false, permission, error: 'System Settings is macOS-only' };
    }
    if (!this.shell || typeof this.shell.openExternal !== 'function') {
      return { success: false, permission, error: 'shell.openExternal unavailable' };
    }

    try {
      await this.shell.openExternal(url);
      this.logger.info('Opened System Settings pane', { permission });
      return { success: true, permission, url };
    } catch (error) {
      this.logger.warn('Could not open System Settings', {
        permission,
        error: error && error.message
      });
      return { success: false, permission, error: error && error.message };
    }
  }
}

/**
 * Push a permission snapshot to a renderer, tolerating a window that has been
 * destroyed between the request and the reply.
 *
 * @param {object} win  BrowserWindow-like.
 * @param {string} channel
 * @param {*} payload
 * @returns {boolean} true if the message was actually sent.
 */
function sendToRenderer(win, channel, payload) {
  try {
    if (!win) return false;
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false;

    const wc = win.webContents;
    if (!wc) return false;
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false;
    if (typeof wc.send !== 'function') return false;

    wc.send(channel, payload);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  MacPermissionsService,
  normalizeStatus,
  requiresRestart,
  sendToRenderer,
  SETTINGS_PANES,
  STATUS_GRANTED,
  STATUS_DENIED,
  STATUS_RESTRICTED,
  STATUS_NOT_DETERMINED,
  STATUS_UNKNOWN,
  VALID_STATUSES
};

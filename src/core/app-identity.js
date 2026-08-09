'use strict';

/**
 * Packaged application identity.
 *
 * The app used to call `app.setName("Terminal ")` unconditionally — at module
 * construction, again on `whenReady`, and once more from every icon change.
 * On a packaged macOS build that is actively harmful:
 *
 *   - `app.getPath('userData')` is derived from the app name, so renaming the
 *     app relocates the entire config directory (.env, first-run sentinel,
 *     logs). Renaming at a different point in startup silently splits the
 *     user's data across two directories.
 *   - electron-updater identifies the installed application by name/bundle;
 *     a mismatched name breaks update staging.
 *   - The signed bundle's CFBundleName no longer matches the running name,
 *     which trips Gatekeeper assessment on a signed build.
 *
 * Stealth is a *presentation* concern, so it is now limited to things that
 * cannot affect identity: the OS process title (Activity Monitor), window
 * titles, and the dock icon. The bundle id, product name, signing identity,
 * updater identity, and userData path are always the real OpenCluely values.
 */

/** Never varies. Must match build.productName / build.appId in package.json. */
const PRODUCT_NAME = 'OpenCluely';
const APP_ID = 'com.opencluely.app';

/**
 * Cosmetic disguises. The trailing space in the historical values was load
 * bearing for the old `app.setName` hack; it is preserved so process titles
 * look identical to before for users who opt in.
 */
const STEALTH_PRESETS = {
  terminal: { processTitle: 'Terminal ', windowTitle: 'Terminal' },
  activity: { processTitle: 'Activity Monitor ', windowTitle: 'Activity Monitor' },
  settings: { processTitle: 'System Settings ', windowTitle: 'System Settings' }
};

const DEFAULT_STEALTH_PRESET = 'terminal';

/**
 * Is stealth presentation switched on?
 *
 * Opt-in only, and never implicitly enabled for a packaged macOS build.
 * Sources, highest precedence first:
 *   1. explicit `settings.stealthMode` (Settings UI toggle)
 *   2. OPENCLUELY_STEALTH env var ("1"/"true")
 *
 * @param {object} opts
 * @param {object} [opts.settings]
 * @param {object} [opts.env]
 * @returns {boolean}
 */
function isStealthEnabled(opts = {}) {
  const settings = opts.settings || {};
  if (typeof settings.stealthMode === 'boolean') return settings.stealthMode;

  const env = opts.env || {};
  const raw = env.OPENCLUELY_STEALTH;
  if (typeof raw === 'string') {
    return raw === '1' || raw.toLowerCase() === 'true';
  }
  return false;
}

/**
 * Resolve every name the app should present.
 *
 * @param {object} opts
 * @param {string} [opts.platform]
 * @param {boolean} [opts.isPackaged]
 * @param {boolean} [opts.stealthEnabled]
 * @param {string} [opts.preset]  One of STEALTH_PRESETS.
 * @returns {{
 *   appName: string,
 *   appId: string,
 *   processTitle: string,
 *   windowTitle: string,
 *   stealth: boolean,
 *   applyAppName: boolean
 * }}
 *   `appName` is the identity-bearing name and is ALWAYS the product name.
 *   `applyAppName` says whether it is safe to call `app.setName()` at all.
 */
function resolveIdentity(opts = {}) {
  const platform = opts.platform || process.platform;
  const isPackaged = Boolean(opts.isPackaged);
  const stealth = Boolean(opts.stealthEnabled);
  const preset = STEALTH_PRESETS[opts.preset] || STEALTH_PRESETS[DEFAULT_STEALTH_PRESET];

  // A packaged build must never rename itself: userData, the updater and the
  // code signature all key off the bundle name.
  const applyAppName = !isPackaged && platform !== 'darwin';

  if (!stealth) {
    return {
      appName: PRODUCT_NAME,
      appId: APP_ID,
      processTitle: PRODUCT_NAME,
      windowTitle: PRODUCT_NAME,
      stealth: false,
      applyAppName
    };
  }

  return {
    appName: PRODUCT_NAME, // identity is never disguised
    appId: APP_ID,
    processTitle: preset.processTitle,
    windowTitle: preset.windowTitle,
    stealth: true,
    applyAppName
  };
}

/**
 * Apply the resolved identity to the running process.
 *
 * Only touches presentation surfaces. Deliberately never calls
 * `app.setName()` on macOS, and never at all in a packaged build.
 *
 * @param {object} deps
 * @param {object} deps.identity        From resolveIdentity().
 * @param {object} [deps.app]           Electron `app`.
 * @param {object} [deps.processRef]    Defaults to global `process`.
 * @param {Iterable} [deps.windows]     Iterable of BrowserWindow-likes.
 * @param {object} [deps.logger]
 * @returns {{processTitle: string, renamedApp: boolean, titledWindows: number}}
 */
function applyIdentity(deps = {}) {
  const identity = deps.identity;
  const proc = deps.processRef || process;
  const logger = deps.logger || { debug() {}, warn() {} };
  const result = { processTitle: null, renamedApp: false, titledWindows: 0 };

  if (!identity) return result;

  // Process title is purely cosmetic — safe everywhere.
  try {
    proc.title = identity.processTitle;
    result.processTitle = identity.processTitle;
  } catch (error) {
    logger.warn('Could not set process title', { error: error && error.message });
  }

  // Windows/Linux keep their historical app.setName behaviour in development.
  if (identity.applyAppName && deps.app && typeof deps.app.setName === 'function') {
    try {
      deps.app.setName(identity.appName);
      result.renamedApp = true;
    } catch (error) {
      logger.warn('Could not set app name', { error: error && error.message });
    }
  }

  if (deps.windows) {
    for (const win of deps.windows) {
      try {
        if (!win) continue;
        if (typeof win.isDestroyed === 'function' && win.isDestroyed()) continue;
        if (typeof win.setTitle !== 'function') continue;
        win.setTitle(identity.windowTitle);
        result.titledWindows += 1;
      } catch (error) {
        logger.warn('Could not set window title', { error: error && error.message });
      }
    }
  }

  return result;
}

module.exports = {
  PRODUCT_NAME,
  APP_ID,
  STEALTH_PRESETS,
  DEFAULT_STEALTH_PRESET,
  isStealthEnabled,
  resolveIdentity,
  applyIdentity
};

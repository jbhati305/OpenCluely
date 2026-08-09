'use strict';

/**
 * Standard macOS application menu.
 *
 * The app previously shipped with no application menu at all. On macOS that
 * has two consequences beyond cosmetics:
 *
 *   - Cmd+Q is handled by Electron's default menu, bypassing our lifecycle
 *     controller, so quitting skipped the single-cleanup path.
 *   - Without an Edit menu the standard clipboard roles are unbound, so
 *     Cmd+C/Cmd+V silently do nothing in the Settings text fields.
 *
 * The template is built by a pure function so it can be asserted in tests
 * without an Electron runtime.
 */

/**
 * @param {object} options
 * @param {string} options.appName            Visible product name.
 * @param {Function} options.onQuit           Routed through AppLifecycle.
 * @param {Function} options.onCheckForUpdates
 * @param {Function} [options.onAbout]        Omit to use Electron's default panel.
 * @returns {Array} Electron menu template.
 */
function buildMacMenuTemplate(options = {}) {
  const appName = options.appName || 'OpenCluely';
  const { onQuit, onCheckForUpdates, onAbout } = options;

  const aboutItem = typeof onAbout === 'function'
    ? { label: `About ${appName}`, click: () => onAbout() }
    : { label: `About ${appName}`, role: 'about' };

  return [
    {
      label: appName,
      submenu: [
        aboutItem,
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => {
            if (typeof onCheckForUpdates === 'function') onCheckForUpdates();
          }
        },
        { type: 'separator' },
        { label: `Hide ${appName}`, role: 'hide' },
        { label: 'Hide Others', role: 'hideOthers' },
        { label: 'Show All', role: 'unhide' },
        { type: 'separator' },
        {
          label: `Quit ${appName}`,
          accelerator: 'Command+Q',
          // Deliberately NOT role:'quit'. The role calls app.quit() directly,
          // which skips the lifecycle controller's idempotency guard.
          click: () => {
            if (typeof onQuit === 'function') onQuit();
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ];
}

/**
 * Build and install the menu. No-op off macOS so Windows/Linux keep their
 * existing (menu-less) presentation.
 *
 * @param {object} deps
 * @param {object} deps.Menu       Electron `Menu`.
 * @param {string} [deps.platform]
 * @param {object} deps.options    Passed to buildMacMenuTemplate.
 * @returns {boolean} true if a menu was installed.
 */
function installMacMenu(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'darwin') return false;

  const { Menu, options } = deps;
  if (!Menu || typeof Menu.buildFromTemplate !== 'function') return false;

  const template = buildMacMenuTemplate(options || {});
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  return true;
}

module.exports = { buildMacMenuTemplate, installMacMenu };

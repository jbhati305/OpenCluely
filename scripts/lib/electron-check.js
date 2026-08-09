'use strict';

/**
 * Pure decision logic for verifying the repository-local Electron binary and,
 * on failure, deciding how to recover. Everything here is dependency-injected
 * or takes plain data (a spawn result), so it can be unit-tested without
 * spawning real processes (see test/electron-check.test.js). The thin CLI in
 * scripts/verify-electron.js wires these functions to the real filesystem and
 * child_process.
 *
 * Background: Electron 42+ (this app uses 43) no longer downloads its binary in
 * a postinstall step — it fetches on demand the first time `require('electron')`
 * runs. Either way, a failed/partial download leaves node_modules/electron
 * without a usable binary, and the app only crashes at launch. This logic lets
 * setup detect that immediately and attempt one bounded recovery.
 */

const SEMVER_RE = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

/**
 * Extract a semver from `electron --version` output (e.g. "v43.3.0\n").
 * Returns the normalized version string, or null when the output does not
 * contain a version (e.g. an error was printed instead).
 */
function parseElectronVersion(output) {
  if (typeof output !== 'string') return null;
  const match = output.trim().match(SEMVER_RE);
  return match ? match[1] : null;
}

/**
 * Interpret the result of spawning `electron --version` into a pass/fail
 * verdict. A pass requires ALL of:
 *   - the process actually ran (no spawn error, not a timeout),
 *   - it was not terminated by a signal (catches SIGTRAP/SIGBUS crashes),
 *   - it exited with status 0,
 *   - it printed a parseable version, and
 *   - that version exactly matches electron/package.json.
 *
 * @param {{ error?: Error, status?: number|null, signal?: string|null,
 *           stdout?: string, stderr?: string, expectedVersion?: string }} result
 */
function interpretVerifyResult(result = {}) {
  const { error, status, signal, stdout, stderr, expectedVersion } = result;

  if (error) {
    if (error.code === 'ETIMEDOUT') {
      return { ok: false, error: 'Electron version check timed out.' };
    }
    return { ok: false, error: `Could not execute Electron binary: ${error.message}` };
  }
  if (signal) {
    return { ok: false, error: `Electron binary terminated by signal ${signal}.` };
  }
  if (status !== 0) {
    return { ok: false, error: `Electron version check exited with code ${status}.` };
  }

  const version = parseElectronVersion(stdout);
  if (!version) {
    const raw = `${stdout || ''}${stderr || ''}`.trim().slice(0, 160);
    return { ok: false, error: `Electron did not report a version. Output: ${raw || '(empty)'}` };
  }
  if (expectedVersion && version !== expectedVersion) {
    return {
      ok: false,
      error: `Electron reported ${version} but electron/package.json expects ${expectedVersion}.`
    };
  }
  return { ok: true, version };
}

/**
 * Interpret the result of running the Electron installer. Recovery only
 * counts as successful when the installer process ran to a clean exit:
 * no spawn error, no terminating signal, and status 0. A non-zero exit is
 * treated as failed recovery.
 */
function interpretInstallerResult(result = {}) {
  const { error, status, signal } = result;
  if (error) return false;
  if (signal) return false;
  return status === 0;
}

/**
 * Decide whether a local Electron installer is available. In modern Electron
 * the `install-electron` bin is simply an alias for `install.js`, so the CLI
 * intentionally invokes `install.js` directly with Node; this returns whether
 * that script exists.
 */
function chooseInstaller({ hasInstallJs }) {
  return hasInstallJs ? { kind: 'install-js' } : { kind: 'none' };
}

/**
 * Verify the Electron binary and, if that fails, attempt recovery exactly
 * once before re-verifying. Bounded to a single recovery attempt so setup can
 * never enter an unbounded download loop. The first failure verdict is passed
 * to `recover` so it can report diagnostics WITHOUT executing the failed
 * binary a second time.
 *
 * @param {() => Promise<{ok: boolean, version?: string, error?: string}>} verify
 * @param {(firstFailure: object) => Promise<boolean>} recover  Resolves true
 *   only when a recovery installer ran to a clean exit; false when none was
 *   available or the installer failed.
 * @returns {Promise<{ok: boolean, version?: string, error?: string, recovered: boolean}>}
 */
async function verifyWithRecovery({ verify, recover }) {
  const first = await verify();
  if (first.ok) {
    return { ...first, recovered: false };
  }

  const didRecover = await recover(first);
  if (!didRecover) {
    return { ...first, recovered: false };
  }

  const second = await verify();
  return { ...second, recovered: true };
}

module.exports = {
  parseElectronVersion,
  interpretVerifyResult,
  interpretInstallerResult,
  chooseInstaller,
  verifyWithRecovery
};

#!/usr/bin/env node
'use strict';

/*
 * Verify that the repository-local Electron binary is installed and can report
 * its version, and recover once if it cannot. Run automatically by setup.sh
 * right after dependency installation (before the expensive Whisper bootstrap)
 * and available as `npm run verify:electron` / in CI.
 *
 * Why this exists: Electron 42+ (this app uses 43) downloads its platform
 * binary on demand the first time `require('electron')` runs, rather than in a
 * postinstall step. When that download fails or half-completes (network/proxy/
 * mirror, or an interrupted extract), node_modules/electron is left without a
 * usable binary and the app only crashes later at launch with "Electron failed
 * to install correctly". This script surfaces the problem immediately with
 * actionable diagnostics and attempts a single, bounded reinstall.
 *
 * The verdict/recovery decisions live in ./lib/electron-check.js and are
 * unit-tested; this file is the thin I/O wiring (filesystem + child_process).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  interpretVerifyResult,
  interpretInstallerResult,
  chooseInstaller,
  verifyWithRecovery
} = require('./lib/electron-check');

const CLEAN_ENV = (() => {
  const env = { ...process.env };
  // Electron treats ELECTRON_RUN_AS_NODE as "behave like plain node", which
  // would make `--version` print Node's version instead of Electron's.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
})();

function electronDir() {
  // Resolve the installed electron package without triggering its index.js
  // (which would itself try to download on a missing binary).
  return path.dirname(require.resolve('electron/package.json'));
}

function requestedElectronVersion() {
  try {
    return require('electron/package.json').version;
  } catch (_) {
    return undefined;
  }
}

function resolveBinaryPath() {
  const dir = electronDir();
  const pathTxt = path.join(dir, 'path.txt');
  if (!fs.existsSync(pathTxt)) return null;
  const rel = fs.readFileSync(pathTxt, 'utf8').trim();
  if (!rel) return null;
  const full = path.join(dir, 'dist', rel);
  return fs.existsSync(full) ? full : null;
}

async function verify() {
  const expectedVersion = requestedElectronVersion();
  const bin = resolveBinaryPath();
  if (!bin) {
    return { ok: false, error: 'Electron binary not found (missing path.txt or the dist executable).' };
  }
  const res = spawnSync(bin, ['--version'], {
    env: CLEAN_ENV,
    encoding: 'utf8',
    timeout: 30000
  });
  return interpretVerifyResult({
    error: res.error,
    status: res.status,
    signal: res.signal,
    stdout: res.stdout,
    stderr: res.stderr,
    expectedVersion
  });
}

function printDiagnostics(error) {
  console.error('');
  console.error('Electron verification failed.');
  console.error(`  Reason:            ${error}`);
  console.error(`  OS:                ${os.platform()} ${os.release()}`);
  console.error(`  CPU architecture:  ${os.arch()}`);
  console.error(`  Node version:      ${process.version}`);
  const npm = spawnSync('npm', ['-v'], { encoding: 'utf8' });
  console.error(`  npm version:       ${npm.status === 0 ? npm.stdout.trim() : 'unknown'}`);
  console.error(`  Electron package:  ${requestedElectronVersion() || 'unknown'}`);
  console.error('');
  console.error('  If this persists, review these npm/Electron settings (names only —');
  console.error('  do not paste their values here): ignore-scripts, proxy, https-proxy,');
  console.error('  ELECTRON_MIRROR, ELECTRON_CUSTOM_DIR, electron_config_cache.');
  console.error('');
}

async function recover(firstFailure) {
  // Report full context using the verdict from the single verification that
  // already ran — do not execute the failed binary again just to diagnose.
  printDiagnostics(firstFailure.error || 'unknown');

  const dir = electronDir();
  const installJs = path.join(dir, 'install.js');
  const choice = chooseInstaller({ hasInstallJs: fs.existsSync(installJs) });

  if (choice.kind === 'none') {
    console.error('No local Electron installer (install.js) found.');
    console.error('Reinstall dependencies (e.g. `npm ci`) and re-run verification.');
    return false;
  }

  // `install-electron` is a bin alias for install.js in modern Electron, so we
  // invoke install.js directly with Node — cross-platform and independent of
  // the .bin shim. Bounded to this one attempt by design.
  console.error('Attempting a single Electron reinstall via install.js ...');
  const res = spawnSync(process.execPath, [installJs], {
    env: CLEAN_ENV,
    stdio: 'inherit',
    timeout: 300000
  });
  if (res.error) {
    console.error(`Electron reinstall could not be started: ${res.error.message}`);
  }
  return interpretInstallerResult({ error: res.error, status: res.status, signal: res.signal });
}

async function main() {
  const result = await verifyWithRecovery({ verify, recover });

  if (result.ok) {
    console.log(`Electron ${result.version} verified${result.recovered ? ' (after one reinstall)' : ''}.`);
    process.exit(0);
  }

  console.error('');
  // Whether recovery was unavailable or was attempted and failed is already
  // explained by the diagnostics above, so keep this line neutral.
  console.error('Electron is not usable.');
  console.error('Manual remediation:');
  console.error('  1. Delete node_modules/electron only, then reinstall:');
  console.error('       rm -rf node_modules/electron && npm install');
  console.error('  2. Or force a clean binary download:');
  console.error('       node node_modules/electron/install.js');
  console.error('  3. Verify again:');
  console.error('       npm run verify:electron');
  console.error('');
  process.exit(1);
}

main().catch((err) => {
  console.error(`Unexpected error during Electron verification: ${err && err.message ? err.message : err}`);
  process.exit(1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseElectronVersion,
  interpretVerifyResult,
  interpretInstallerResult,
  chooseInstaller,
  verifyWithRecovery
} = require('../scripts/lib/electron-check');

// ---- parseElectronVersion ----

test('parseElectronVersion extracts a semver from `electron --version` output', () => {
  assert.equal(parseElectronVersion('v43.3.0\n'), '43.3.0');
  assert.equal(parseElectronVersion('43.3.0'), '43.3.0');
  assert.equal(parseElectronVersion('  v29.1.0  '), '29.1.0');
});

test('parseElectronVersion returns null for non-version output', () => {
  assert.equal(parseElectronVersion(''), null);
  assert.equal(parseElectronVersion('Electron failed to install correctly'), null);
  assert.equal(parseElectronVersion(undefined), null);
});

// ---- interpretVerifyResult ----

test('interpretVerifyResult passes when exit 0, no signal, version matches package.json', () => {
  const v = interpretVerifyResult({ status: 0, signal: null, stdout: 'v43.3.0\n', expectedVersion: '43.3.0' });
  assert.deepEqual(v, { ok: true, version: '43.3.0' });
});

test('interpretVerifyResult fails on a non-zero verification exit', () => {
  const v = interpretVerifyResult({ status: 1, signal: null, stdout: '', expectedVersion: '43.3.0' });
  assert.equal(v.ok, false);
  assert.match(v.error, /exited with code 1/);
});

test('interpretVerifyResult fails on signal termination (e.g. SIGTRAP crash)', () => {
  const v = interpretVerifyResult({ status: null, signal: 'SIGTRAP', stdout: '', expectedVersion: '43.3.0' });
  assert.equal(v.ok, false);
  assert.match(v.error, /signal SIGTRAP/);
});

test('interpretVerifyResult fails on timeout (ETIMEDOUT)', () => {
  const err = new Error('spawnSync ETIMEDOUT'); err.code = 'ETIMEDOUT';
  const v = interpretVerifyResult({ error: err, signal: 'SIGTERM', expectedVersion: '43.3.0' });
  assert.equal(v.ok, false);
  assert.match(v.error, /timed out/i);
});

test('interpretVerifyResult fails on a spawn error', () => {
  const err = new Error('spawn ENOENT'); err.code = 'ENOENT';
  const v = interpretVerifyResult({ error: err, expectedVersion: '43.3.0' });
  assert.equal(v.ok, false);
  assert.match(v.error, /Could not execute Electron binary/);
});

test('interpretVerifyResult fails when the binary version disagrees with package.json', () => {
  const v = interpretVerifyResult({ status: 0, signal: null, stdout: 'v29.1.0\n', expectedVersion: '43.3.0' });
  assert.equal(v.ok, false);
  assert.match(v.error, /reported 29\.1\.0 but electron\/package\.json expects 43\.3\.0/);
});

test('interpretVerifyResult fails on unparseable output', () => {
  const v = interpretVerifyResult({ status: 0, signal: null, stdout: 'Electron failed to install correctly', expectedVersion: '43.3.0' });
  assert.equal(v.ok, false);
  assert.match(v.error, /did not report a version/);
});

// ---- interpretInstallerResult ----

test('interpretInstallerResult treats a clean exit 0 as successful recovery', () => {
  assert.equal(interpretInstallerResult({ status: 0, signal: null }), true);
});

test('interpretInstallerResult treats a non-zero installer exit as failed recovery', () => {
  assert.equal(interpretInstallerResult({ status: 1, signal: null }), false);
});

test('interpretInstallerResult treats a signal-terminated installer as failed recovery', () => {
  assert.equal(interpretInstallerResult({ status: null, signal: 'SIGKILL' }), false);
});

test('interpretInstallerResult treats a spawn error as failed recovery', () => {
  assert.equal(interpretInstallerResult({ error: new Error('spawn failed') }), false);
});

// ---- chooseInstaller ----

test('chooseInstaller selects install.js when present', () => {
  assert.deepEqual(chooseInstaller({ hasInstallJs: true }), { kind: 'install-js' });
});

test('chooseInstaller reports none when install.js is absent', () => {
  assert.deepEqual(chooseInstaller({ hasInstallJs: false }), { kind: 'none' });
});

// ---- verifyWithRecovery ----

test('verifyWithRecovery succeeds without recovering when the first verify passes', async () => {
  let recoverCalls = 0;
  const result = await verifyWithRecovery({
    verify: async () => ({ ok: true, version: '43.3.0' }),
    recover: async () => { recoverCalls++; return true; }
  });
  assert.deepEqual(result, { ok: true, version: '43.3.0', recovered: false });
  assert.equal(recoverCalls, 0);
});

test('verifyWithRecovery recovers once, then succeeds', async () => {
  let verifyCalls = 0;
  let recoverCalls = 0;
  const result = await verifyWithRecovery({
    verify: async () => {
      verifyCalls++;
      return verifyCalls === 1
        ? { ok: false, error: 'missing binary' }
        : { ok: true, version: '43.3.0' };
    },
    recover: async () => { recoverCalls++; return true; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(recoverCalls, 1);
  assert.equal(verifyCalls, 2);
});

test('verifyWithRecovery runs exactly one failed verification before recovery and passes it in', async () => {
  const seen = [];
  let verifyCalls = 0;
  await verifyWithRecovery({
    verify: async () => { verifyCalls++; return { ok: false, error: 'boom-' + verifyCalls }; },
    recover: async (firstFailure) => {
      // recovery is invoked after exactly one verification, and receives it
      assert.equal(verifyCalls, 1);
      seen.push(firstFailure);
      return false; // no installer / recovery not performed
    }
  });
  assert.equal(verifyCalls, 1); // no second execution of the failed binary
  assert.deepEqual(seen, [{ ok: false, error: 'boom-1' }]);
});

test('verifyWithRecovery attempts recovery at most once (no unbounded loop)', async () => {
  let verifyCalls = 0;
  let recoverCalls = 0;
  const result = await verifyWithRecovery({
    verify: async () => { verifyCalls++; return { ok: false, error: 'still missing' }; },
    recover: async () => { recoverCalls++; return true; }
  });
  assert.equal(result.ok, false);
  assert.equal(recoverCalls, 1);
  assert.equal(verifyCalls, 2); // initial verify + one re-verify after recovery
});

test('verifyWithRecovery does not re-verify when recovery was not performed', async () => {
  let verifyCalls = 0;
  const result = await verifyWithRecovery({
    verify: async () => { verifyCalls++; return { ok: false, error: 'no binary' }; },
    recover: async () => false
  });
  assert.equal(result.ok, false);
  assert.equal(result.recovered, false);
  assert.equal(verifyCalls, 1);
});

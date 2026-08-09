#!/usr/bin/env node
'use strict';

/**
 * `npm run verify:mac-signature`
 *
 * Post-build validation of the macOS arm64 output. Read-only.
 *
 * Verifies:
 *   - the app bundle exists and is named OpenCluely.app
 *   - the executable is arm64-only
 *   - CFBundleIdentifier is com.opencluely.app
 *   - CFBundleShortVersionString matches package.json
 *   - codesign --verify --deep --strict --verbose=2 passes
 *   - the expected artifact set was produced
 *   - latest-mac.yml references files that actually exist
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  expectedArtifacts,
  validateArtifactSet,
  validateLatestMacYml,
  interpretCodesignVerify
} = require('./lib/mac-artifacts');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const EXPECTED_BUNDLE_ID = 'com.opencluely.app';
const APP_NAME = 'OpenCluely.app';

const failures = [];
const notes = [];

function fail(message) { failures.push(message); }
function ok(message) { console.log(`  ✓ ${message}`); }

/** electron-builder writes to dist/mac-arm64/ (or dist/mac/ for one arch). */
function findAppBundle() {
  const candidates = ['mac-arm64', 'mac', 'mac-universal']
    .map((dir) => path.join(DIST, dir, APP_NAME))
    .filter((p) => fs.existsSync(p));
  return candidates[0] || null;
}

function plistValue(plistPath, key) {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
    encoding: 'utf8'
  });
  if (!result || result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('verify:mac-signature only runs on macOS.');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;

  console.log(`Verifying macOS arm64 build of OpenCluely ${version}\n`);

  if (!fs.existsSync(DIST)) {
    console.error('✗ dist/ does not exist. Run `npm run build:mac:arm64` first.');
    process.exit(1);
  }

  // ── App bundle ──
  console.log('App bundle');
  const appPath = findAppBundle();
  if (!appPath) {
    fail(`Could not find ${APP_NAME} under dist/. Was the build run?`);
  } else {
    ok(`found ${path.relative(ROOT, appPath)}`);

    const plist = path.join(appPath, 'Contents', 'Info.plist');
    const bundleId = plistValue(plist, 'CFBundleIdentifier');
    const shortVersion = plistValue(plist, 'CFBundleShortVersionString');
    const executable = plistValue(plist, 'CFBundleExecutable');

    if (bundleId !== EXPECTED_BUNDLE_ID) {
      fail(`CFBundleIdentifier is "${bundleId}", expected "${EXPECTED_BUNDLE_ID}".`);
    } else {
      ok(`bundle id ${bundleId}`);
    }

    if (shortVersion !== version) {
      fail(`CFBundleShortVersionString is "${shortVersion}", expected "${version}".`);
    } else {
      ok(`version ${shortVersion}`);
    }

    if (executable !== 'OpenCluely') {
      fail(`CFBundleExecutable is "${executable}", expected "OpenCluely".`);
    } else {
      ok(`executable ${executable}`);
    }

    // ── Architecture ──
    if (executable) {
      const binary = path.join(appPath, 'Contents', 'MacOS', executable);
      const lipo = spawnSync('lipo', ['-archs', binary], { encoding: 'utf8' });
      const archs = String((lipo && lipo.stdout) || '').trim();
      if (lipo && lipo.status === 0) {
        if (archs !== 'arm64') {
          fail(`Executable architecture is "${archs}", expected exactly "arm64".`);
        } else {
          ok('architecture arm64');
        }
      } else {
        fail('Could not read the executable architecture with `lipo`.');
      }
    }

    // ── Signature ──
    console.log('\nSignature');
    const cs = spawnSync(
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', appPath],
      { encoding: 'utf8' }
    );
    const verdict = interpretCodesignVerify({
      status: cs ? cs.status : null,
      stderr: (cs && cs.stderr) || ''
    });

    if (verdict.ok) {
      ok(`codesign: ${verdict.message}`);
      const info = spawnSync('codesign', ['-dv', '--verbose=2', appPath], { encoding: 'utf8' });
      const authority = String((info && info.stderr) || '')
        .split(/\r?\n/)
        .find((l) => l.startsWith('Authority='));
      if (authority) {
        ok(authority.trim());
        if (/Developer ID Application/.test(authority)) {
          notes.push('Signed with a Developer ID certificate — suitable for distribution once notarized.');
        } else {
          notes.push(
            'Signed with a self-signed certificate. This is valid on THIS Mac only. ' +
            'It does not grant Gatekeeper trust for other users and is not notarized.'
          );
        }
      }
    } else {
      fail(`codesign verification failed: ${verdict.message}`);
    }
  }

  // ── Artifacts ──
  console.log('\nArtifacts');
  const present = fs.readdirSync(DIST).filter((f) => fs.statSync(path.join(DIST, f)).isFile());
  const expected = expectedArtifacts(version);

  const artifactCheck = validateArtifactSet({ version, presentFiles: present });
  if (artifactCheck.ok) {
    ok(`user-facing installer: ${expected.userFacing}`);
    ok(`updater assets: ${expected.updaterAssets.join(', ')}`);
  } else {
    artifactCheck.errors.forEach(fail);
  }

  // ── Updater metadata ──
  console.log('\nUpdater metadata');
  const ymlPath = path.join(DIST, expected.latestYml);
  if (!fs.existsSync(ymlPath)) {
    fail(`${expected.latestYml} was not produced.`);
  } else {
    const ymlCheck = validateLatestMacYml({
      yml: fs.readFileSync(ymlPath, 'utf8'),
      version,
      presentFiles: present
    });
    if (ymlCheck.ok) {
      ok(`${expected.latestYml} references ${ymlCheck.referenced.join(', ')}`);
    } else {
      ymlCheck.errors.forEach(fail);
    }
  }

  // ── Result ──
  console.log('');
  if (notes.length) {
    notes.forEach((n) => console.log(`ℹ ${n}`));
    console.log('');
  }

  if (failures.length) {
    console.error(`✗ ${failures.length} problem(s) found:\n`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log('✓ macOS arm64 build verified.');
  process.exit(0);
}

main();

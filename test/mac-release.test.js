'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  expectedArtifacts,
  parseLatestMacYml,
  validateLatestMacYml,
  validateArtifactSet,
  interpretCodesignVerify,
  validateReleaseVersion
} = require('../scripts/lib/mac-artifacts');

const {
  checkNodeVersion,
  checkPlatform,
  checkGitState,
  checkGhAuth,
  checkRepoVisibility,
  checkArtifactVersions,
  summarize
} = require('../scripts/lib/release-preflight');

const VERSION = '1.2.3';

function distFor(version = VERSION, extra = []) {
  const a = expectedArtifacts(version);
  return [a.dmg, a.zip, a.zipBlockmap, a.dmgBlockmap, a.latestYml, ...extra];
}

function ymlFor(version = VERSION) {
  const a = expectedArtifacts(version);
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${a.zip}`,
    '    sha512: abc==',
    '    size: 123456',
    `  - url: ${a.dmg}`,
    '    sha512: def==',
    '    size: 234567',
    `path: ${a.zip}`,
    'sha512: abc==',
    "releaseDate: '2026-01-01T00:00:00.000Z'"
  ].join('\n');
}

// ---- artifact naming ----

test('artifact names follow OpenCluely-<version>-mac-arm64.<ext>', () => {
  const a = expectedArtifacts('1.0.1');

  assert.equal(a.dmg, 'OpenCluely-1.0.1-mac-arm64.dmg');
  assert.equal(a.zip, 'OpenCluely-1.0.1-mac-arm64.zip');
  assert.equal(a.zipBlockmap, 'OpenCluely-1.0.1-mac-arm64.zip.blockmap');
  assert.equal(a.latestYml, 'latest-mac.yml');
});

test('the DMG is the only user-facing installer; the rest are updater assets', () => {
  const a = expectedArtifacts(VERSION);

  assert.equal(a.userFacing, a.dmg);
  assert.ok(a.updaterAssets.includes(a.zip));
  assert.ok(a.updaterAssets.includes(a.latestYml));
  assert.ok(!a.updaterAssets.includes(a.dmg), 'the DMG is not an updater asset');
});

test('the ZIP, blockmap and latest-mac.yml are all required for a release', () => {
  const a = expectedArtifacts(VERSION);
  for (const required of [a.dmg, a.zip, a.zipBlockmap, a.latestYml]) {
    assert.ok(a.required.includes(required), `${required} must be required`);
  }
});

// ---- artifact set validation ----

test('a complete arm64 artifact set validates', () => {
  const result = validateArtifactSet({ version: VERSION, presentFiles: distFor() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('a missing updater asset fails the artifact check', () => {
  const files = distFor().filter((f) => !f.endsWith('latest-mac.yml'));
  const result = validateArtifactSet({ version: VERSION, presentFiles: files });

  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('latest-mac.yml'));
});

test('a stray x64 artifact is rejected because this build is arm64-only', () => {
  const result = validateArtifactSet({
    version: VERSION,
    presentFiles: distFor(VERSION, [`OpenCluely-${VERSION}-mac-x64.dmg`])
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Unexpected non-arm64 artifact/);
});

test('a universal artifact is likewise rejected', () => {
  const result = validateArtifactSet({
    version: VERSION,
    presentFiles: distFor(VERSION, [`OpenCluely-${VERSION}-mac-universal.zip`])
  });

  assert.equal(result.ok, false);
});

// ---- latest-mac.yml ----

test('latest-mac.yml is parsed into version, files and path', () => {
  const parsed = parseLatestMacYml(ymlFor());

  assert.equal(parsed.version, VERSION);
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[0].url, `OpenCluely-${VERSION}-mac-arm64.zip`);
  assert.equal(parsed.files[0].size, 123456);
  assert.equal(parsed.path, `OpenCluely-${VERSION}-mac-arm64.zip`);
});

test('latest-mac.yml validates when every referenced asset exists', () => {
  const result = validateLatestMacYml({
    yml: ymlFor(),
    version: VERSION,
    presentFiles: distFor()
  });

  assert.equal(result.ok, true);
  assert.ok(result.referenced.includes(`OpenCluely-${VERSION}-mac-arm64.zip`));
});

test('latest-mac.yml referencing a missing asset fails', () => {
  const result = validateLatestMacYml({
    yml: ymlFor(),
    version: VERSION,
    presentFiles: [`OpenCluely-${VERSION}-mac-arm64.dmg`, 'latest-mac.yml']
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /not present in dist/);
});

test('a latest-mac.yml version mismatch fails', () => {
  const result = validateLatestMacYml({
    yml: ymlFor('9.9.9'),
    version: VERSION,
    presentFiles: distFor('9.9.9')
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /does not match the build version/);
});

test('an empty or malformed latest-mac.yml fails rather than passing silently', () => {
  const result = validateLatestMacYml({ yml: '', version: VERSION, presentFiles: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 1);
});

// ---- codesign interpretation ----

test('codesign exit 0 is a pass', () => {
  const verdict = interpretCodesignVerify({ status: 0, stderr: 'valid on disk' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.signed, true);
});

test('an unsigned bundle is reported as unsigned with a fix', () => {
  const verdict = interpretCodesignVerify({
    status: 1,
    stderr: 'code object is not signed at all'
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.signed, false);
  assert.match(verdict.message, /CSC_NAME/);
});

test('an unsigned electron-builder output is reported as unsigned, not as corruption', () => {
  // The exact stderr an unsigned arm64 build produces.
  const verdict = interpretCodesignVerify({
    status: 1,
    stderr: 'OpenCluely.app: code has no resources but signature indicates they must be present'
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.signed, false);
  assert.match(verdict.message, /without code signing/);
  assert.match(verdict.message, /CSC_NAME/);
});

test('a broken seal is distinguished from being unsigned', () => {
  const verdict = interpretCodesignVerify({
    status: 1,
    stderr: 'a sealed resource is missing or invalid'
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.signed, true);
  assert.match(verdict.message, /sealed resource/);
});

// ---- release version ----

test('only a plain X.Y.Z version is releasable', () => {
  assert.equal(validateReleaseVersion('1.2.3', 'v1.2.3').ok, true);
  assert.equal(validateReleaseVersion('1.2.3-beta.1', 'v1.2.3-beta.1').ok, false);
  assert.equal(validateReleaseVersion('1.2', 'v1.2').ok, false);
  assert.equal(validateReleaseVersion('', '').ok, false);
});

test('the tag must match package.json exactly', () => {
  const result = validateReleaseVersion('1.2.3', 'v1.2.4');
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match/);
});

// ---- preflight: environment ----

test('Node 22.12 or newer passes; older fails', () => {
  assert.equal(checkNodeVersion('v22.12.0').ok, true);
  assert.equal(checkNodeVersion('v22.23.2').ok, true);
  assert.equal(checkNodeVersion('v24.0.0').ok, true);

  assert.equal(checkNodeVersion('v22.11.0').ok, false);
  assert.equal(checkNodeVersion('v20.19.4').ok, false);
  assert.equal(checkNodeVersion('nonsense').ok, false);
});

test('releases require macOS on Apple Silicon', () => {
  assert.equal(checkPlatform({ platform: 'darwin', arch: 'arm64' }).ok, true);
  assert.equal(checkPlatform({ platform: 'darwin', arch: 'x64' }).ok, false);
  assert.equal(checkPlatform({ platform: 'linux', arch: 'arm64' }).ok, false);
  assert.equal(checkPlatform({ platform: 'win32', arch: 'x64' }).ok, false);
});

// ---- preflight: repository ----

test('a clean main branch passes', () => {
  assert.equal(checkGitState({ branch: 'main', status: '' }).ok, true);
});

test('releasing from a non-main branch is blocked', () => {
  const result = checkGitState({ branch: 'feat/mac-app-distribution', status: '' });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be cut from "main"/);
});

test('a dirty working tree is blocked and the offending files are listed', () => {
  const result = checkGitState({ branch: 'main', status: ' M main.js\n?? scratch.txt' });

  assert.equal(result.ok, false);
  assert.match(result.error, /must be clean/);
  assert.match(result.error, /main\.js/);
  assert.match(result.error, /scratch\.txt/);
});

test('an unauthenticated gh CLI is blocked', () => {
  assert.equal(checkGhAuth({ status: 0 }).ok, true);
  assert.equal(checkGhAuth({ status: 1 }).ok, false);
  assert.match(checkGhAuth({ status: 1 }).error, /gh auth login/);
});

test('a private repository is blocked because updates are fetched anonymously', () => {
  assert.equal(checkRepoVisibility('{"visibility":"PUBLIC"}').ok, true);

  const priv = checkRepoVisibility('{"visibility":"PRIVATE"}');
  assert.equal(priv.ok, false);
  assert.match(priv.error, /public repository/);

  assert.equal(checkRepoVisibility('not json').ok, false);
});

// ---- preflight: artifact versions ----

test('DMG and ZIP must both carry the release version and arm64', () => {
  const result = checkArtifactVersions({ version: VERSION, presentFiles: distFor() });
  assert.equal(result.ok, true);
});

test('a version-mismatched artifact is caught', () => {
  const result = checkArtifactVersions({
    version: VERSION,
    presentFiles: ['OpenCluely-9.9.9-mac-arm64.dmg', 'OpenCluely-9.9.9-mac-arm64.zip']
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /has version "9\.9\.9", expected "1\.2\.3"/);
});

test('an arch-mismatched artifact is caught', () => {
  const result = checkArtifactVersions({
    version: VERSION,
    presentFiles: [`OpenCluely-${VERSION}-mac-x64.dmg`]
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /architecture "x64"/);
});

test('no artifacts at all fails', () => {
  const result = checkArtifactVersions({ version: VERSION, presentFiles: [] });
  assert.equal(result.ok, false);
});

// ---- preflight: gate ----

test('the gate passes only when every check passes', () => {
  const summary = summarize([
    { name: 'a', result: { ok: true } },
    { name: 'b', result: { ok: true } }
  ]);

  assert.equal(summary.ok, true);
  assert.deepEqual(summary.failures, []);
});

test('the gate fails closed and collects every failure message', () => {
  const summary = summarize([
    { name: 'Platform', result: { ok: false, error: 'wrong arch' } },
    { name: 'Artifacts', result: { ok: false, errors: ['missing dmg', 'missing zip'] } },
    { name: 'Tests', result: { ok: true } }
  ]);

  assert.equal(summary.ok, false);
  assert.equal(summary.failures.length, 2);
  assert.deepEqual(summary.failures[0], { name: 'Platform', messages: ['wrong arch'] });
  assert.deepEqual(summary.failures[1].messages, ['missing dmg', 'missing zip']);
});

test('a result with no message still fails rather than silently passing', () => {
  const summary = summarize([{ name: 'Mystery', result: { ok: false } }]);

  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failures[0].messages, ['Check failed.']);
});

test('an undefined result is treated as a failure', () => {
  assert.equal(summarize([{ name: 'x', result: undefined }]).ok, false);
});

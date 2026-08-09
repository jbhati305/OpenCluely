'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PRODUCT_NAME,
  APP_ID,
  isStealthEnabled,
  resolveIdentity,
  applyIdentity
} = require('../src/core/app-identity');

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

// ---- stealth is opt-in ----

test('stealth is off by default', () => {
  assert.equal(isStealthEnabled({ env: {} }), false);
  assert.equal(isStealthEnabled({}), false);
});

test('stealth can be enabled by env var or explicit setting', () => {
  assert.equal(isStealthEnabled({ env: { OPENCLUELY_STEALTH: '1' } }), true);
  assert.equal(isStealthEnabled({ env: { OPENCLUELY_STEALTH: 'true' } }), true);
  assert.equal(isStealthEnabled({ env: { OPENCLUELY_STEALTH: '0' } }), false);
  assert.equal(isStealthEnabled({ settings: { stealthMode: true }, env: {} }), true);
});

test('an explicit setting overrides the environment', () => {
  assert.equal(
    isStealthEnabled({ settings: { stealthMode: false }, env: { OPENCLUELY_STEALTH: '1' } }),
    false
  );
});

// ---- packaged identity is stable ----

test('a packaged macOS build presents the real OpenCluely identity by default', () => {
  const identity = resolveIdentity({
    platform: 'darwin',
    isPackaged: true,
    stealthEnabled: false
  });

  assert.equal(identity.appName, 'OpenCluely');
  assert.equal(identity.processTitle, 'OpenCluely');
  assert.equal(identity.windowTitle, 'OpenCluely');
  assert.equal(identity.stealth, false);
});

test('a packaged build never renames itself, even with stealth on', () => {
  // app.setName() feeds userData, the updater identity and the signed bundle
  // name. Renaming a packaged app splits the config dir and breaks updates.
  for (const stealthEnabled of [false, true]) {
    const identity = resolveIdentity({
      platform: 'darwin',
      isPackaged: true,
      stealthEnabled
    });

    assert.equal(identity.applyAppName, false);
    assert.equal(identity.appName, PRODUCT_NAME, 'identity must never be disguised');
    assert.equal(identity.appId, APP_ID);
  }
});

test('macOS never renames the app even in development', () => {
  const identity = resolveIdentity({
    platform: 'darwin',
    isPackaged: false,
    stealthEnabled: true
  });
  assert.equal(identity.applyAppName, false);
});

test('stealth disguises only the cosmetic surfaces', () => {
  const identity = resolveIdentity({
    platform: 'darwin',
    isPackaged: true,
    stealthEnabled: true,
    preset: 'terminal'
  });

  assert.equal(identity.stealth, true);
  assert.equal(identity.processTitle, 'Terminal ');
  assert.equal(identity.windowTitle, 'Terminal');
  // ...but never the identity-bearing values.
  assert.equal(identity.appName, 'OpenCluely');
  assert.equal(identity.appId, 'com.opencluely.app');
});

test('every stealth preset keeps the real bundle identity', () => {
  for (const preset of ['terminal', 'activity', 'settings']) {
    const identity = resolveIdentity({
      platform: 'darwin',
      isPackaged: true,
      stealthEnabled: true,
      preset
    });

    assert.equal(identity.appName, PRODUCT_NAME);
    assert.equal(identity.appId, APP_ID);
    assert.notEqual(identity.processTitle, PRODUCT_NAME, `${preset} should disguise the title`);
  }
});

test('an unknown preset falls back to the default rather than throwing', () => {
  const identity = resolveIdentity({
    platform: 'darwin',
    isPackaged: true,
    stealthEnabled: true,
    preset: 'nonexistent'
  });
  assert.equal(identity.processTitle, 'Terminal ');
});

test('Windows and Linux keep their historical development rename behaviour', () => {
  for (const platform of ['win32', 'linux']) {
    const identity = resolveIdentity({ platform, isPackaged: false, stealthEnabled: true });
    assert.equal(identity.applyAppName, true, `${platform} dev behaviour is unchanged`);
  }
});

// ---- applyIdentity ----

test('applyIdentity sets the process title but not the app name on macOS', () => {
  const proc = { title: 'original' };
  let setNameCalls = 0;

  const result = applyIdentity({
    identity: resolveIdentity({ platform: 'darwin', isPackaged: true, stealthEnabled: true }),
    app: { setName: () => { setNameCalls += 1; } },
    processRef: proc
  });

  assert.equal(proc.title, 'Terminal ');
  assert.equal(setNameCalls, 0, 'app.setName must never be called on a packaged macOS build');
  assert.equal(result.renamedApp, false);
});

test('applyIdentity retitles live windows and skips destroyed ones', () => {
  const titles = [];
  const live = { isDestroyed: () => false, setTitle: (t) => titles.push(t) };
  const dead = {
    isDestroyed: () => true,
    setTitle: () => { throw new Error('Object has been destroyed'); }
  };

  const result = applyIdentity({
    identity: resolveIdentity({ platform: 'darwin', isPackaged: true, stealthEnabled: false }),
    processRef: { title: '' },
    windows: [live, dead, null]
  });

  assert.deepEqual(titles, ['OpenCluely']);
  assert.equal(result.titledWindows, 1);
});

test('applyIdentity survives a window that throws on setTitle', () => {
  const result = applyIdentity({
    identity: resolveIdentity({ platform: 'darwin', isPackaged: true }),
    processRef: { title: '' },
    windows: [{ isDestroyed: () => false, setTitle: () => { throw new Error('boom'); } }]
  });

  assert.equal(result.titledWindows, 0);
});

// ---- packaged build metadata ----

test('the packaged app identity is pinned in package.json', () => {
  assert.equal(pkg.build.appId, 'com.opencluely.app');
  assert.equal(pkg.build.productName, 'OpenCluely');
  assert.equal(pkg.build.mac.executableName, 'OpenCluely');
});

test('the macOS build targets arm64 only', () => {
  for (const target of pkg.build.mac.target) {
    assert.deepEqual(target.arch, ['arm64'], `${target.target} must be arm64-only`);
  }

  const targets = pkg.build.mac.target.map((t) => t.target).sort();
  assert.deepEqual(targets, ['dmg', 'zip']);
});

test('artifact naming produces OpenCluely-<version>-mac-arm64.<ext>', () => {
  assert.equal(pkg.build.mac.artifactName, '${productName}-${version}-mac-${arch}.${ext}');
});

test('hardened runtime is enabled with entitlements that exist', () => {
  assert.equal(pkg.build.mac.hardenedRuntime, true);

  const root = path.join(__dirname, '..');
  for (const key of ['entitlements', 'entitlementsInherit']) {
    const rel = pkg.build.mac[key];
    assert.ok(rel, `${key} must be configured`);
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} must exist`);
  }
});

test('entitlements include Electron JIT and microphone, and exclude get-task-allow', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, pkg.build.mac.entitlements), 'utf8');

  assert.match(main, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(main, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.match(main, /com\.apple\.security\.device\.audio-input/);
  assert.ok(!/get-task-allow/.test(main), 'get-task-allow must never be shipped');

  const inherit = fs.readFileSync(path.join(root, pkg.build.mac.entitlementsInherit), 'utf8');
  assert.match(inherit, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(inherit, /com\.apple\.security\.inherit/);
  assert.ok(!/get-task-allow/.test(inherit));
});

test('electron-updater is a runtime dependency, not a dev dependency', () => {
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater must ship with the app');
  assert.ok(!(pkg.devDependencies || {})['electron-updater']);
});

test('the macOS distribution scripts are wired up', () => {
  for (const script of [
    'build:mac:arm64',
    'mac:signing:check',
    'verify:mac-signature',
    'release:mac'
  ]) {
    assert.ok(pkg.scripts[script], `npm run ${script} must exist`);
  }
});

test('no personal signing identity or certificate is committed to package.json', () => {
  const raw = JSON.stringify(pkg);

  assert.ok(!/Developer ID Application:/.test(raw), 'no hard-coded Developer ID');
  assert.ok(!/CSC_LINK/.test(raw));
  assert.ok(!pkg.build.mac.identity, 'signing identity must come from CSC_NAME at build time');
});

test('the Windows and Linux targets are unchanged', () => {
  assert.deepEqual(pkg.build.win.target.map((t) => t.target).sort(), ['nsis', 'portable']);
  assert.deepEqual(pkg.build.linux.target.map((t) => t.target).sort(), ['AppImage', 'deb']);
});

test('dist output stays out of git', () => {
  const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(gitignore, /^dist\/$/m);
});

test('runtime source contains no hard-coded GitHub repository for updates', () => {
  // The repo is stamped into app-update.yml at build time so forks publish to
  // their own releases. A literal owner/repo in runtime source would break that.
  const runtimeFiles = [
    'src/services/updater.service.js',
    'src/core/app-lifecycle.js',
    'src/core/app-identity.js',
    'main.js',
    'preload.js'
  ];

  for (const rel of runtimeFiles) {
    const source = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(
      !/github\.com\/[\w.-]+\/[\w.-]+/.test(source),
      `${rel} must not hard-code a GitHub repository`
    );
    assert.ok(!/gh[pousr]_[A-Za-z0-9]{16,}/.test(source), `${rel} must not contain a token`);
  }
});

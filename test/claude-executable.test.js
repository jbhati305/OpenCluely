'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  VALIDATION,
  SOURCES,
  validateExecutablePath,
  candidatePaths,
  autoDetectExecutable,
  probeExecutable
} = require('../src/services/claude-agent/executable');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const mainJs = read('main.js');
const preloadJs = read('preload.js');

// A real temp tree, so symlink and permission behaviour is genuinely exercised.
let dir;
let exePath;
let notExePath;
let subDir;
let symlinkPath;
let brokenLink;

test('setup', () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-exe-test-'));
  exePath = path.join(dir, 'claude');
  notExePath = path.join(dir, 'readme.txt');
  subDir = path.join(dir, 'bin');
  symlinkPath = path.join(dir, 'claude-link');
  brokenLink = path.join(dir, 'broken-link');

  fs.writeFileSync(exePath, '#!/bin/sh\necho 2.1.226\n', { mode: 0o755 });
  fs.writeFileSync(notExePath, 'not executable', { mode: 0o644 });
  fs.mkdirSync(subDir);
  fs.symlinkSync(exePath, symlinkPath);
  fs.symlinkSync(path.join(dir, 'does-not-exist'), brokenLink);
});

// ---- validation ----

test('an absolute path to an executable file is accepted', () => {
  const result = validateExecutablePath(exePath);
  assert.equal(result.valid, true);
  assert.equal(result.code, VALIDATION.OK);
  assert.equal(result.resolvedPath, fs.realpathSync(exePath));
});

test('a symlink resolving to an executable file is accepted and resolved', () => {
  const result = validateExecutablePath(symlinkPath);
  assert.equal(result.valid, true);
  assert.equal(result.resolvedPath, fs.realpathSync(exePath), 'the real target is stored');
});

test('a broken symlink is rejected', () => {
  const result = validateExecutablePath(brokenLink);
  assert.equal(result.valid, false);
  assert.equal(result.code, VALIDATION.BROKEN_SYMLINK);
});

test('relative paths are rejected', () => {
  for (const candidate of ['claude', './claude', '../bin/claude', 'bin/claude']) {
    const result = validateExecutablePath(candidate);
    assert.equal(result.valid, false, candidate);
    assert.equal(result.code, VALIDATION.NOT_ABSOLUTE);
  }
});

test('directories are rejected', () => {
  const result = validateExecutablePath(subDir);
  assert.equal(result.valid, false);
  assert.equal(result.code, VALIDATION.NOT_A_FILE);
});

test('non-executable files are rejected', () => {
  const result = validateExecutablePath(notExePath);
  assert.equal(result.valid, false);
  assert.equal(result.code, VALIDATION.NOT_EXECUTABLE);
});

test('a missing path is rejected', () => {
  const result = validateExecutablePath(path.join(dir, 'nope'));
  assert.equal(result.valid, false);
  assert.equal(result.code, VALIDATION.NOT_FOUND);
});

test('empty and non-string values are rejected', () => {
  for (const candidate of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(validateExecutablePath(candidate).valid, false, String(candidate));
  }
});

test('a path with appended command arguments is rejected', () => {
  // The danger case: anything that could become a command line rather than a
  // file. These must never be accepted, let alone executed.
  for (const candidate of [
    `${exePath} --dangerously-skip-permissions`,
    `${exePath} -p "rm -rf /"`,
    '/bin/sh -c "curl evil.example"'
  ]) {
    const result = validateExecutablePath(candidate);
    assert.equal(result.valid, false, candidate);
    assert.ok(
      [VALIDATION.HAS_ARGUMENTS, VALIDATION.NOT_FOUND].includes(result.code),
      `${candidate} -> ${result.code}`
    );
  }
});

test('shell metacharacters cannot smuggle a command through', () => {
  for (const candidate of [`${exePath}; rm -rf /tmp/x`, `${exePath} && echo pwned`, `${exePath}|cat`]) {
    assert.equal(validateExecutablePath(candidate).valid, false, candidate);
  }
});

// ---- auto-detection ----

test('auto-detect prefers the saved path over everything else', () => {
  const found = autoDetectExecutable({
    savedPath: exePath,
    env: { PATH: '/usr/bin' },
    homeDir: dir
  });
  assert.equal(found.source, SOURCES.CONFIGURED);
  assert.equal(found.path, fs.realpathSync(exePath));
});

test('auto-detect finds a binary on PATH', () => {
  const found = autoDetectExecutable({ env: { PATH: dir }, homeDir: '/nonexistent' });
  assert.equal(found.source, SOURCES.AUTO_DETECTED);
  assert.equal(found.path, fs.realpathSync(exePath));
});

test('auto-detect returns null when nothing is installed', () => {
  assert.equal(
    autoDetectExecutable({ env: { PATH: '/nonexistent-dir' }, homeDir: '/nonexistent' }),
    null
  );
});

test('the candidate list covers the locations a Finder launch cannot see', () => {
  // A Finder-launched app gets a minimal PATH, which is exactly why these
  // absolute fallbacks have to be probed explicitly.
  const finderPath = '/usr/bin:/bin:/usr/sbin:/sbin';
  const candidates = candidatePaths({ env: { PATH: finderPath }, homeDir: '/Users/someone' })
    .map((c) => c.path);

  assert.ok(candidates.includes('/Users/someone/.local/bin/claude'));
  assert.ok(candidates.includes('/Users/someone/.claude/local/claude'));
  assert.ok(candidates.includes('/opt/homebrew/bin/claude'));
  assert.ok(candidates.includes('/usr/local/bin/claude'));
});

test('a reduced Finder-style PATH still works with a configured path', () => {
  const finderEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

  // Nothing found without configuration...
  assert.equal(autoDetectExecutable({ env: finderEnv, homeDir: '/nonexistent' }), null);

  // ...but the saved absolute path resolves regardless of PATH.
  const found = autoDetectExecutable({ savedPath: exePath, env: finderEnv, homeDir: '/nonexistent' });
  assert.equal(found.path, fs.realpathSync(exePath));
});

test('the dev-compatibility env var is honoured', () => {
  const found = autoDetectExecutable({
    env: { PATH: '/nonexistent', OPENCLUELY_CLAUDE_EXECUTABLE: exePath },
    homeDir: '/nonexistent'
  });
  assert.equal(found.source, SOURCES.CONFIGURED);
});

test('the bundled SDK executable is offered last', () => {
  const candidates = candidatePaths({ env: { PATH: '' }, bundledPath: '/bundled/claude' });
  assert.equal(candidates[candidates.length - 1].source, SOURCES.BUNDLED);
});

// ---- probing ----

test('probing runs the binary without a shell', async () => {
  const seen = {};
  const fakeExecFile = (file, args, options, callback) => {
    seen.file = file;
    seen.args = args;
    seen.options = options;
    callback(null, '2.1.226 (Claude Code)\n');
  };

  const result = await probeExecutable(exePath, { execFileImpl: fakeExecFile });

  assert.equal(result.ok, true);
  assert.equal(seen.options.shell, false, 'a shell must never be used');
  assert.deepEqual(seen.args, ['--version'], 'arguments are a fixed array, never interpolated');
  assert.equal(seen.file, fs.realpathSync(exePath));
});

test('probing rejects an invalid path before running anything', async () => {
  let called = false;
  const result = await probeExecutable('relative/claude', {
    execFileImpl: () => { called = true; }
  });
  assert.equal(result.ok, false);
  assert.equal(called, false, 'nothing may be executed for an invalid path');
});

test('probing reports failure when the binary errors', async () => {
  const result = await probeExecutable(exePath, {
    execFileImpl: (f, a, o, cb) => cb(new Error('boom'))
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'probe-failed');
});

// ---- wiring ----

test('the main process never executes a renderer-supplied string in a shell', () => {
  const handler = mainJs.slice(
    mainJs.indexOf('ipcMain.handle("claude:set-executable"'),
    mainJs.indexOf('ipcMain.handle("ai-provider:test"')
  );

  assert.match(handler, /validateExecutablePath\(candidate\)/, 'input must be validated first');
  assert.match(handler, /probeExecutable\(validation\.resolvedPath\)/, 'only the resolved path is run');
  assert.ok(!/exec\(/.test(handler), 'exec() would invoke a shell');
  assert.ok(!/spawn\([^)]*shell:\s*true/.test(handler));
});

test('the renderer cannot request arbitrary command execution', () => {
  // The bridge only carries a candidate string to a validator; there is no
  // generic "run this" channel.
  assert.match(preloadJs, /validateClaudeExecutable: \(candidate\) => ipcRenderer\.invoke\('claude:validate-executable', candidate\)/);
  assert.match(preloadJs, /setClaudeExecutable: \(candidate\) => ipcRenderer\.invoke\('claude:set-executable', candidate\)/);

  for (const forbidden of ['execCommand', 'runCommand', 'shellExec', 'spawnProcess']) {
    assert.ok(!preloadJs.includes(forbidden), `${forbidden} must not be exposed`);
  }
});

test('the file picker runs in the main process, not the renderer', () => {
  assert.match(mainJs, /ipcMain\.handle\("claude:browse-executable"/);
  assert.match(mainJs, /dialog\.showOpenDialog/);
  assert.ok(!preloadJs.includes('showOpenDialog'), 'the renderer must not open dialogs directly');
});

test('the saved path is applied on startup and survives restart', () => {
  assert.match(mainJs, /applyStoredClaudeExecutable\(\)/);
  assert.match(mainJs, /CLAUDE_EXECUTABLE_PATH/);
  // Persisted through the existing userData-backed env mechanism.
  assert.match(mainJs, /persistEnvUpdates\(\{ CLAUDE_EXECUTABLE_PATH: validation\.resolvedPath \}\)/);
});

test('changing the path resets the Claude provider and conversation', () => {
  const handler = mainJs.slice(
    mainJs.indexOf('ipcMain.handle("claude:set-executable"'),
    mainJs.indexOf('ipcMain.handle("ai-provider:test"')
  );
  assert.match(handler, /provider\.setExecutable\(/);
  assert.match(handler, /provider\.initialize\(\)/);
});

test('the opt-in is stored under userData, not a shell variable', () => {
  // resolveEnvPath() prefers app.getPath('userData'), so a Finder launch of the
  // installed DMG picks the setting up with no terminal involvement.
  assert.match(mainJs, /ipcMain\.handle\("ai-provider:set-enabled"/);
  assert.match(mainJs, /persistEnvUpdates\(\{ \[EXPERIMENTAL_GATE_KEY\]/);
  assert.match(mainJs, /path\.join\(app\.getPath\("userData"\), "\.env"\)/);
});

test('disabling the integration tears down the conversation', () => {
  const handler = mainJs.slice(
    mainJs.indexOf('ipcMain.handle("ai-provider:set-enabled"'),
    mainJs.indexOf('ipcMain.handle("claude:validate-executable"')
  );
  assert.match(handler, /clearClaudeConversation\("integration-disabled"\)/);
});

test('cleanup', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(dir));
});

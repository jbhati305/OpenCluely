'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

/**
 * Locating and validating the Claude CLI for a packaged, Finder-launched app.
 *
 * A Finder-launched app does NOT inherit the shell's PATH — it gets a minimal
 * one (typically /usr/bin:/bin:/usr/sbin:/sbin). That is why `claude` resolves
 * under `npm start` but not in the installed DMG, and why the path has to be
 * configurable in Settings.
 *
 * Every path here is executed with execFile and `shell: false`. A user-supplied
 * string is never interpolated into a command line, so a value like
 * `/bin/sh -c "curl evil"` cannot become an argument list — it simply fails
 * validation as a non-existent file.
 */

const VALIDATION = Object.freeze({
  OK: 'ok',
  EMPTY: 'empty',
  NOT_ABSOLUTE: 'not-absolute',
  HAS_ARGUMENTS: 'has-arguments',
  NOT_FOUND: 'not-found',
  NOT_A_FILE: 'not-a-file',
  NOT_EXECUTABLE: 'not-executable',
  BROKEN_SYMLINK: 'broken-symlink'
});

const VALIDATION_MESSAGES = Object.freeze({
  [VALIDATION.OK]: 'Looks good.',
  [VALIDATION.EMPTY]: 'Enter a path to the Claude CLI.',
  [VALIDATION.NOT_ABSOLUTE]: 'Enter an absolute path, starting with /.',
  [VALIDATION.HAS_ARGUMENTS]: 'Enter only the executable path, with no arguments.',
  [VALIDATION.NOT_FOUND]: 'No file exists at that path.',
  [VALIDATION.NOT_A_FILE]: 'That path is a directory, not an executable.',
  [VALIDATION.NOT_EXECUTABLE]: 'That file is not executable.',
  [VALIDATION.BROKEN_SYMLINK]: 'That symlink does not resolve to a real file.'
});

/** Where the path came from. Sanitized enum, safe for the renderer. */
const SOURCES = Object.freeze({
  CONFIGURED: 'configured',
  AUTO_DETECTED: 'auto-detected',
  BUNDLED: 'bundled',
  NONE: 'none'
});

/** A path with a space followed by a flag is a command line, not a file. */
function looksLikeCommandLine(value) {
  return /\s+-{1,2}\w/.test(value) || /\s+\S+\s*$/.test(value) && /["']/.test(value);
}

/**
 * @param {string} candidate
 * @param {{fsImpl?: typeof fs}} [deps]
 * @returns {{valid: boolean, code: string, message: string, resolvedPath: string|null}}
 */
function validateExecutablePath(candidate, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const fail = (code) => ({ valid: false, code, message: VALIDATION_MESSAGES[code], resolvedPath: null });

  if (typeof candidate !== 'string' || !candidate.trim()) return fail(VALIDATION.EMPTY);

  const value = candidate.trim();
  if (looksLikeCommandLine(value)) return fail(VALIDATION.HAS_ARGUMENTS);
  if (!path.isAbsolute(value)) return fail(VALIDATION.NOT_ABSOLUTE);

  let stat;
  try {
    // statSync follows symlinks, so a symlink to a real executable passes.
    stat = fsImpl.statSync(value);
  } catch (error) {
    if (error && error.code === 'ELOOP') return fail(VALIDATION.BROKEN_SYMLINK);
    try {
      // Exists as a link but the target does not.
      fsImpl.lstatSync(value);
      return fail(VALIDATION.BROKEN_SYMLINK);
    } catch {
      return fail(VALIDATION.NOT_FOUND);
    }
  }

  if (!stat.isFile()) return fail(VALIDATION.NOT_A_FILE);

  try {
    fsImpl.accessSync(value, fsImpl.constants.X_OK);
  } catch {
    return fail(VALIDATION.NOT_EXECUTABLE);
  }

  let resolvedPath = value;
  try {
    resolvedPath = fsImpl.realpathSync(value);
  } catch {
    // Keep the original if the link cannot be resolved; it already stat'd fine.
  }

  return { valid: true, code: VALIDATION.OK, message: VALIDATION_MESSAGES[VALIDATION.OK], resolvedPath };
}

/**
 * Ordered candidates. The saved path wins, then the dev-compatibility env var,
 * then PATH, then the well-known install locations a Finder launch cannot see.
 */
function candidatePaths({ savedPath = null, env = process.env, homeDir = os.homedir(), bundledPath = null } = {}) {
  const fromPath = String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, 'claude'));

  return [
    ...(savedPath ? [{ path: savedPath, source: SOURCES.CONFIGURED }] : []),
    ...(env.OPENCLUELY_CLAUDE_EXECUTABLE
      ? [{ path: env.OPENCLUELY_CLAUDE_EXECUTABLE, source: SOURCES.CONFIGURED }]
      : []),
    ...fromPath.map((p) => ({ path: p, source: SOURCES.AUTO_DETECTED })),
    { path: path.join(homeDir, '.local', 'bin', 'claude'), source: SOURCES.AUTO_DETECTED },
    { path: path.join(homeDir, '.claude', 'local', 'claude'), source: SOURCES.AUTO_DETECTED },
    { path: '/opt/homebrew/bin/claude', source: SOURCES.AUTO_DETECTED },
    { path: '/usr/local/bin/claude', source: SOURCES.AUTO_DETECTED },
    ...(bundledPath ? [{ path: bundledPath, source: SOURCES.BUNDLED }] : [])
  ];
}

/**
 * The `claude` executable shipped inside the pinned Agent SDK.
 *
 * In a packaged app this must resolve to the asarUnpack'd copy: a binary
 * cannot be executed from inside app.asar.
 */
function bundledExecutablePath({ resolveFn = require.resolve, fsImpl = fs } = {}) {
  try {
    const pkg = resolveFn('@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json');
    let candidate = path.join(path.dirname(pkg), 'claude');
    if (candidate.includes(`app.asar${path.sep}`)) {
      candidate = candidate.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    }
    return fsImpl.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * First candidate that validates.
 * @returns {{path: string, source: string}|null}
 */
function autoDetectExecutable(options = {}) {
  const deps = { fsImpl: options.fsImpl || fs };
  for (const candidate of candidatePaths(options)) {
    const result = validateExecutablePath(candidate.path, deps);
    if (result.valid) return { path: result.resolvedPath, source: candidate.source };
  }
  return null;
}

/**
 * Confirm the binary actually runs. Never uses a shell.
 * @returns {Promise<{ok: boolean, code?: string}>}
 */
function probeExecutable(executablePath, { execFileImpl = execFile, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const check = validateExecutablePath(executablePath);
    if (!check.valid) return resolve({ ok: false, code: check.code });

    execFileImpl(
      check.resolvedPath,
      ['--version'],
      { timeout: timeoutMs, shell: false, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) return resolve({ ok: false, code: 'probe-failed' });
        // The version string is product metadata, not account data.
        const version = String(stdout || '').trim().split('\n')[0].slice(0, 40);
        resolve({ ok: true, version });
      }
    );
  });
}

module.exports = {
  VALIDATION,
  VALIDATION_MESSAGES,
  SOURCES,
  validateExecutablePath,
  candidatePaths,
  bundledExecutablePath,
  autoDetectExecutable,
  probeExecutable
};

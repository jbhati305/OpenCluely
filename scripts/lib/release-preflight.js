'use strict';

/**
 * Pure preflight predicates for `npm run release:mac`.
 *
 * The release script is fail-closed: every one of these must pass before a
 * tag is pushed or a GitHub release leaves draft state. Keeping the decision
 * logic pure means the gate itself is unit-tested rather than only exercised
 * during a real release.
 */

const MIN_NODE = { major: 22, minor: 12, patch: 0 };

/**
 * @param {string} raw e.g. "v22.23.2"
 * @returns {{ok: boolean, version?: string, error?: string}}
 */
function checkNodeVersion(raw) {
  const match = String(raw || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return { ok: false, error: `Could not parse Node version from "${raw}".` };
  }

  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const required = `${MIN_NODE.major}.${MIN_NODE.minor}.${MIN_NODE.patch}`;
  const version = `${major}.${minor}.${patch}`;

  if (
    major > MIN_NODE.major ||
    (major === MIN_NODE.major && minor > MIN_NODE.minor) ||
    (major === MIN_NODE.major && minor === MIN_NODE.minor && patch >= MIN_NODE.patch)
  ) {
    return { ok: true, version };
  }

  return { ok: false, version, error: `Node ${version} is older than the required ${required}.` };
}

/**
 * Releases are cut only from an Apple Silicon Mac, because that is the only
 * host that can produce and verify a signed arm64 build.
 * @param {object} args
 * @returns {{ok: boolean, error?: string}}
 */
function checkPlatform(args = {}) {
  if (args.platform !== 'darwin') {
    return { ok: false, error: `Releases must be built on macOS (found "${args.platform}").` };
  }
  if (args.arch !== 'arm64') {
    return { ok: false, error: `Releases must be built on Apple Silicon (found "${args.arch}").` };
  }
  return { ok: true };
}

/**
 * @param {object} args
 * @param {string} args.branch
 * @param {string} args.status  Porcelain `git status --porcelain` output.
 * @param {string} [args.expectedBranch]
 * @returns {{ok: boolean, error?: string}}
 */
function checkGitState(args = {}) {
  const expected = args.expectedBranch || 'main';

  if (args.branch !== expected) {
    return { ok: false, error: `Releases must be cut from "${expected}" (currently on "${args.branch}").` };
  }

  const dirty = String(args.status || '').trim();
  if (dirty) {
    const files = dirty.split(/\r?\n/).map((l) => `    ${l}`).join('\n');
    return { ok: false, error: `The working tree must be clean:\n${files}` };
  }

  return { ok: true };
}

/**
 * @param {object} args
 * @param {number|null} args.status  Exit code of `gh auth status`.
 * @returns {{ok: boolean, error?: string}}
 */
function checkGhAuth(args = {}) {
  if (args.status === 0) return { ok: true };
  return {
    ok: false,
    error: 'The GitHub CLI is not authenticated. Run `gh auth login`.'
  };
}

/**
 * Updates are fetched anonymously, so the repository must be public or
 * electron-updater will 404 for every user.
 * @param {string} json  Output of `gh repo view --json visibility`.
 * @returns {{ok: boolean, visibility?: string, error?: string}}
 */
function checkRepoVisibility(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_) {
    return { ok: false, error: 'Could not read repository visibility from the GitHub CLI.' };
  }

  const visibility = String(parsed.visibility || '').toLowerCase();
  if (visibility === 'public') return { ok: true, visibility };

  return {
    ok: false,
    visibility,
    error:
      `The repository is ${visibility || 'not public'}. electron-updater downloads releases ` +
      'anonymously, so updates only work from a public repository.'
  };
}

/**
 * Confirm the DMG and ZIP both carry the release version and arm64.
 * @param {object} args
 * @param {string} args.version
 * @param {string[]} args.presentFiles
 * @returns {{ok: boolean, errors: string[]}}
 */
function checkArtifactVersions(args = {}) {
  const errors = [];
  const version = args.version;
  const files = (args.presentFiles || []).filter((f) => /\.(dmg|zip)$/.test(f));

  if (files.length === 0) {
    return { ok: false, errors: ['No DMG or ZIP artifacts were produced.'] };
  }

  for (const file of files) {
    const match = file.match(/^OpenCluely-(.+)-mac-(\w+)\.(dmg|zip)$/);
    if (!match) {
      errors.push(`Artifact "${file}" does not follow OpenCluely-<version>-mac-<arch>.<ext>.`);
      continue;
    }
    if (match[1] !== version) {
      errors.push(`Artifact "${file}" has version "${match[1]}", expected "${version}".`);
    }
    if (match[2] !== 'arm64') {
      errors.push(`Artifact "${file}" has architecture "${match[2]}", expected "arm64".`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Fold individual results into one gate decision.
 * @param {Array<{name: string, result: {ok: boolean, error?: string, errors?: string[]}}>} checks
 * @returns {{ok: boolean, failures: Array<{name: string, messages: string[]}>}}
 */
function summarize(checks) {
  const failures = [];

  for (const { name, result } of checks || []) {
    if (result && result.ok) continue;
    const messages = [];
    if (result && result.error) messages.push(result.error);
    if (result && Array.isArray(result.errors)) messages.push(...result.errors);
    if (messages.length === 0) messages.push('Check failed.');
    failures.push({ name, messages });
  }

  return { ok: failures.length === 0, failures };
}

module.exports = {
  MIN_NODE,
  checkNodeVersion,
  checkPlatform,
  checkGitState,
  checkGhAuth,
  checkRepoVisibility,
  checkArtifactVersions,
  summarize
};

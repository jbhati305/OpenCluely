'use strict';

/**
 * Build-time derivation of the GitHub repository that publishes updates.
 *
 * The repository must NOT be hard-coded in runtime source: this project is
 * commonly used as a fork, and a baked-in upstream owner would point every
 * fork's users at someone else's releases. Instead the owner/repo is resolved
 * when the package is built and written into `app-update.yml` by
 * electron-builder, which is the only place electron-updater reads it from.
 *
 * Precedence:
 *   1. UPDATE_GITHUB_REPOSITORY  — explicit override ("owner/repo")
 *   2. GITHUB_REPOSITORY         — set automatically by GitHub Actions
 *   3. `git remote get-url origin` — for the local release command
 */

/**
 * Parse "owner/repo" or any common git remote URL into its parts.
 *
 * Handles:
 *   owner/repo
 *   https://github.com/owner/repo(.git)
 *   git@github.com:owner/repo(.git)
 *   ssh://git@github.com/owner/repo.git
 *
 * @param {string} value
 * @returns {{owner: string, repo: string}|null}
 */
function parseRepository(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let candidate = trimmed;

  // Strip scheme + host for URL forms.
  const sshMatch = candidate.match(/^(?:ssh:\/\/)?git@[^:/]+[:/](.+)$/i);
  if (sshMatch) {
    candidate = sshMatch[1];
  } else {
    const urlMatch = candidate.match(/^https?:\/\/[^/]+\/(.+)$/i);
    if (urlMatch) candidate = urlMatch[1];
  }

  candidate = candidate.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');

  const parts = candidate.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  // Take the last two segments so nested URL prefixes are tolerated.
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];

  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/**
 * Resolve the publishing repository.
 *
 * @param {object} [deps]
 * @param {object} [deps.env]            Defaults to process.env.
 * @param {Function} [deps.gitRemoteFn]  Returns the origin URL, or null.
 * @returns {{owner: string, repo: string, source: string}|null}
 */
function resolveUpdateRepository(deps = {}) {
  const env = deps.env || process.env;

  const explicit = parseRepository(env.UPDATE_GITHUB_REPOSITORY);
  if (explicit) return { ...explicit, source: 'UPDATE_GITHUB_REPOSITORY' };

  const actions = parseRepository(env.GITHUB_REPOSITORY);
  if (actions) return { ...actions, source: 'GITHUB_REPOSITORY' };

  if (typeof deps.gitRemoteFn === 'function') {
    let remote = null;
    try {
      remote = deps.gitRemoteFn();
    } catch (_) {
      remote = null;
    }
    const fromGit = parseRepository(remote);
    if (fromGit) return { ...fromGit, source: 'git-remote-origin' };
  }

  return null;
}

/**
 * Read `git remote get-url origin` using an injected spawn function.
 * @param {Function} spawnSyncFn
 * @param {string} [cwd]
 * @returns {string|null}
 */
function readGitOrigin(spawnSyncFn, cwd) {
  if (typeof spawnSyncFn !== 'function') return null;
  const result = spawnSyncFn('git', ['remote', 'get-url', 'origin'], {
    cwd: cwd || process.cwd(),
    encoding: 'utf8'
  });
  if (!result || result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

module.exports = { parseRepository, resolveUpdateRepository, readGitOrigin };

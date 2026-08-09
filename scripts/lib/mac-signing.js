'use strict';

/**
 * macOS code-signing identity discovery.
 *
 * This module is strictly read-only. It shells out to `security find-identity`
 * and parses the result. It never creates, imports, exports, deletes or
 * modifies a certificate, never touches the keychain's unlock state, and never
 * prints key material — only the identity's common name and a truncated
 * (public) SHA-1 fingerprint.
 *
 * The identity name is supplied by the developer through the environment so no
 * personal certificate is ever committed:
 *   CSC_NAME                       (electron-builder's own variable)
 *   OPENCLUELY_MAC_SIGN_IDENTITY   (project-specific alias)
 */

const IDENTITY_ENV_VARS = ['CSC_NAME', 'OPENCLUELY_MAC_SIGN_IDENTITY'];

/** Documented name for the local self-signed certificate. */
const DEFAULT_LOCAL_IDENTITY = 'OpenCluely Local Code Signing';

/**
 * Parse `security find-identity -v -p codesigning` output.
 *
 * Example line:
 *   1) 0123456789ABCDEF0123456789ABCDEF01234567 "OpenCluely Local Code Signing"
 *
 * @param {string} stdout
 * @returns {Array<{index: number, fingerprint: string, name: string}>}
 */
function parseIdentities(stdout) {
  if (typeof stdout !== 'string' || !stdout) return [];

  const identities = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\)\s+([0-9A-Fa-f]{40})\s+"(.*)"\s*$/);
    if (!match) continue;
    identities.push({
      index: Number(match[1]),
      fingerprint: match[2].toUpperCase(),
      name: match[3]
    });
  }
  return identities;
}

/**
 * Redact a fingerprint for display. The full SHA-1 is public, but there is no
 * reason to splash it across CI logs.
 * @param {string} fingerprint
 * @returns {string}
 */
function redactFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || fingerprint.length < 8) return '<unknown>';
  return `${fingerprint.slice(0, 8)}…`;
}

/**
 * Which identity name did the developer ask for?
 * @param {object} [env]
 * @returns {{name: string, source: string}|null}
 */
function resolveRequestedIdentity(env) {
  const source = env || process.env;
  for (const key of IDENTITY_ENV_VARS) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return { name: value.trim(), source: key };
    }
  }
  return null;
}

/**
 * Require exactly one identity whose common name matches exactly.
 *
 * Fails closed on:
 *   - no identities in the keychain at all
 *   - no exact name match (a substring match is NOT accepted — signing the
 *     wrong certificate silently is worse than failing)
 *   - more than one identity sharing that exact name (ambiguous; `codesign`
 *     would pick one arbitrarily)
 *
 * @param {Array} identities  From parseIdentities().
 * @param {string} requestedName
 * @returns {{ok: true, identity: object} | {ok: false, reason: string, message: string, candidates?: Array}}
 */
function selectIdentity(identities, requestedName) {
  const list = Array.isArray(identities) ? identities : [];

  if (!requestedName) {
    return {
      ok: false,
      reason: 'no-identity-requested',
      message:
        'No signing identity requested. Set CSC_NAME (or OPENCLUELY_MAC_SIGN_IDENTITY) ' +
        `to the certificate's exact common name, e.g. "${DEFAULT_LOCAL_IDENTITY}".`
    };
  }

  if (list.length === 0) {
    return {
      ok: false,
      reason: 'no-identities-found',
      message:
        'No code-signing identities with an available private key were found in your keychain. ' +
        'See docs/macos-code-signing.md to create one in Keychain Access.'
    };
  }

  const exact = list.filter((i) => i.name === requestedName);

  if (exact.length === 0) {
    const available = list.map((i) => `  - ${i.name}`).join('\n');
    return {
      ok: false,
      reason: 'no-exact-match',
      message:
        `No signing identity exactly named "${requestedName}" was found.\n` +
        `Identities available in your keychain:\n${available}\n` +
        'The name must match exactly, including capitalisation.',
      candidates: list
    };
  }

  if (exact.length > 1) {
    const dupes = exact.map((i) => `  - ${redactFingerprint(i.fingerprint)}`).join('\n');
    return {
      ok: false,
      reason: 'ambiguous-match',
      message:
        `${exact.length} identities share the name "${requestedName}":\n${dupes}\n` +
        'codesign cannot choose between them. Delete the duplicates in Keychain Access, ' +
        'or set CSC_NAME to a uniquely-named certificate.',
      candidates: exact
    };
  }

  return { ok: true, identity: exact[0] };
}

/**
 * Full read-only check.
 *
 * @param {object} deps
 * @param {Function} deps.spawnSyncFn  child_process.spawnSync-compatible.
 * @param {object} [deps.env]
 * @returns {{ok: boolean, identity?: object, source?: string, reason?: string, message?: string}}
 */
function checkSigningIdentity(deps = {}) {
  const spawnSyncFn = deps.spawnSyncFn;
  const requested = resolveRequestedIdentity(deps.env);

  if (!requested) {
    return selectIdentity([], null);
  }

  if (typeof spawnSyncFn !== 'function') {
    return { ok: false, reason: 'no-spawn', message: 'No process spawner available.' };
  }

  // -v  : only valid identities (i.e. those with a usable private key)
  // -p codesigning : only identities usable for code signing
  const result = spawnSyncFn('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8'
  });

  if (!result || result.error) {
    return {
      ok: false,
      reason: 'security-failed',
      message: `Could not run \`security find-identity\`: ${
        (result && result.error && result.error.message) || 'unknown error'
      }`
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      reason: 'security-failed',
      message: `\`security find-identity\` exited with code ${result.status}.`
    };
  }

  const identities = parseIdentities(result.stdout);
  const selection = selectIdentity(identities, requested.name);

  if (!selection.ok) return { ...selection, source: requested.source };
  return { ok: true, identity: selection.identity, source: requested.source };
}

module.exports = {
  IDENTITY_ENV_VARS,
  DEFAULT_LOCAL_IDENTITY,
  parseIdentities,
  redactFingerprint,
  resolveRequestedIdentity,
  selectIdentity,
  checkSigningIdentity
};

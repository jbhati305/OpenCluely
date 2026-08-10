'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { CLAUDE_ERRORS, ClaudeProviderError } = require('./errors');

/**
 * Reads the Claude CLI's authentication state and reduces it to the smallest
 * sanitized shape OpenCluely needs.
 *
 * `claude auth status --json` reports the signed-in account, including the
 * user's email, organisation id and organisation name. None of those fields
 * are returned, logged, cached or persisted here — only whether the active
 * credential is a Claude subscription, and which plan it is.
 *
 * The parser fails closed: anything it does not positively recognise as a
 * first-party subscription login is rejected rather than assumed.
 */

/** Fields we are willing to surface anywhere outside this module. */
const SANITIZED_FIELDS = Object.freeze(['authenticated', 'credentialSource', 'plan']);

/** `apiProvider` values that mean "billed to the Anthropic API, not a plan". */
const API_PROVIDERS = Object.freeze(['bedrock', 'vertex', 'foundry', 'console', 'firstPartyApi']);

const CREDENTIAL_SOURCE = Object.freeze({
  SUBSCRIPTION: 'subscription',
  API: 'api',
  UNKNOWN: 'unknown',
  NONE: 'none'
});

/**
 * Reduce raw `claude auth status --json` output to a sanitized result.
 *
 * @param {unknown} raw parsed JSON from the CLI
 * @returns {{authenticated: boolean, credentialSource: string, plan: string|null}}
 */
function parseAuthStatus(raw) {
  // Unknown schema -> fail closed. We must never guess that an unrecognised
  // payload means "subscription", because that would be a billing decision.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { authenticated: false, credentialSource: CREDENTIAL_SOURCE.UNKNOWN, plan: null };
  }

  const { loggedIn, authMethod, apiProvider, subscriptionType } = raw;

  if (typeof loggedIn !== 'boolean' || typeof authMethod !== 'string') {
    return { authenticated: false, credentialSource: CREDENTIAL_SOURCE.UNKNOWN, plan: null };
  }

  if (loggedIn === false) {
    return { authenticated: false, credentialSource: CREDENTIAL_SOURCE.NONE, plan: null };
  }

  const method = authMethod.toLowerCase();
  const provider = typeof apiProvider === 'string' ? apiProvider.toLowerCase() : '';

  const looksLikeApi =
    method.includes('apikey') ||
    method.includes('api_key') ||
    method.includes('token') ||
    method.includes('bedrock') ||
    method.includes('vertex') ||
    method.includes('foundry') ||
    API_PROVIDERS.includes(provider);

  if (looksLikeApi) {
    return { authenticated: true, credentialSource: CREDENTIAL_SOURCE.API, plan: null };
  }

  // The one positive case: a claude.ai login against Anthropic first-party.
  const isSubscription = method === 'claude.ai' && provider === 'firstparty';

  if (!isSubscription) {
    return { authenticated: true, credentialSource: CREDENTIAL_SOURCE.UNKNOWN, plan: null };
  }

  const plan = typeof subscriptionType === 'string' && subscriptionType ? subscriptionType : null;

  // A first-party login with no plan at all is not proof of a subscription.
  if (!plan) {
    return { authenticated: true, credentialSource: CREDENTIAL_SOURCE.UNKNOWN, plan: null };
  }

  return { authenticated: true, credentialSource: CREDENTIAL_SOURCE.SUBSCRIPTION, plan };
}

/** True only for a positively identified subscription login. */
function isSubscriptionAuth(status) {
  return Boolean(
    status && status.authenticated === true && status.credentialSource === CREDENTIAL_SOURCE.SUBSCRIPTION
  );
}

/**
 * Map a sanitized status onto the error a caller should surface.
 * @returns {string|null} an error code, or null when the status is usable
 */
function authErrorCode(status) {
  if (!status || status.authenticated !== true) return CLAUDE_ERRORS.NOT_AUTHENTICATED;
  if (status.credentialSource === CREDENTIAL_SOURCE.API) return CLAUDE_ERRORS.SUBSCRIPTION_REQUIRED;
  if (status.credentialSource !== CREDENTIAL_SOURCE.SUBSCRIPTION) return CLAUDE_ERRORS.AUTH_SOURCE_UNKNOWN;
  return null;
}

/** Strip anything that is not on the allowlist. Defence in depth. */
function sanitize(status) {
  const out = {};
  for (const field of SANITIZED_FIELDS) out[field] = status ? status[field] : null;
  return out;
}

/**
 * Resolve an absolute, executable path to the Claude CLI without a shell.
 * Never interpolates user input into a command.
 *
 * @param {{ env?: NodeJS.ProcessEnv, candidates?: string[], fsImpl?: typeof fs }} [deps]
 * @returns {string|null}
 */
function resolveClaudeExecutable(deps = {}) {
  const env = deps.env || process.env;
  const fsImpl = deps.fsImpl || fs;

  const explicit = env.OPENCLUELY_CLAUDE_EXECUTABLE;
  const searchDirs = (env.PATH || '').split(path.delimiter).filter(Boolean);

  const candidates = deps.candidates || [
    ...(explicit ? [explicit] : []),
    ...searchDirs.map((dir) => path.join(dir, 'claude'))
  ];

  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    try {
      const stat = fsImpl.statSync(candidate);
      if (!stat.isFile()) continue;
      fsImpl.accessSync(candidate, fsImpl.constants.X_OK);
      return candidate;
    } catch {
      // Not present or not executable; keep looking.
    }
  }

  return null;
}

/**
 * Run `claude auth status --json` and return the sanitized result.
 *
 * @param {{ executable?: string, timeoutMs?: number, execFileImpl?: Function, env?: NodeJS.ProcessEnv }} [options]
 */
async function readAuthStatus(options = {}) {
  const run = options.execFileImpl || execFile;
  const executable = options.executable || resolveClaudeExecutable({ env: options.env });

  if (!executable) {
    throw new ClaudeProviderError(CLAUDE_ERRORS.SDK_UNAVAILABLE, 'claude executable not found on PATH');
  }

  const stdout = await new Promise((resolve, reject) => {
    run(
      executable,
      ['auth', 'status', '--json'],
      { timeout: options.timeoutMs || 15000, maxBuffer: 1024 * 1024, shell: false },
      (error, out) => {
        // A non-zero exit is normal when signed out, and the payload is still
        // the interesting part. Only reject when there is nothing to parse.
        if (error && !out) return reject(new ClaudeProviderError(CLAUDE_ERRORS.NOT_AUTHENTICATED, 'auth status failed'));
        resolve(out || '');
      }
    );
  });

  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Deliberately does not include stdout in the error: it contains the
    // account email and organisation identifiers.
    return sanitize({ authenticated: false, credentialSource: CREDENTIAL_SOURCE.UNKNOWN, plan: null });
  }

  return sanitize(parseAuthStatus(parsed));
}

module.exports = {
  SANITIZED_FIELDS,
  CREDENTIAL_SOURCE,
  parseAuthStatus,
  isSubscriptionAuth,
  authErrorCode,
  sanitize,
  resolveClaudeExecutable,
  readAuthStatus
};

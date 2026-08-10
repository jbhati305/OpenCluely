'use strict';

/**
 * Environment construction for the Claude Agent SDK subprocess.
 *
 * The SDK's `env` option REPLACES the subprocess environment rather than
 * merging with it, so we build the child environment from the parent and then
 * strip the provider overrides. This is what guarantees the request is billed
 * to the user's Claude subscription and not to an Anthropic API key, Bedrock,
 * Vertex or Foundry.
 *
 * The parent `process.env` is never mutated.
 */

/** Removed from the child so the SDK falls back to the CLI's stored login. */
const PROVIDER_OVERRIDE_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY'
]);

const CLIENT_APP_KEY = 'CLAUDE_AGENT_SDK_CLIENT_APP';
const DISABLE_AUTO_MEMORY_KEY = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';

const DEFAULT_CLIENT_APP = 'opencluely-local-spike';

/**
 * @param {NodeJS.ProcessEnv} parentEnv
 * @param {{ clientApp?: string }} [options]
 * @returns {Record<string, string|undefined>} a fresh object; parentEnv is untouched
 */
function buildChildEnv(parentEnv = process.env, options = {}) {
  const child = { ...parentEnv };

  for (const key of PROVIDER_OVERRIDE_KEYS) {
    delete child[key];
  }

  child[CLIENT_APP_KEY] = options.clientApp || DEFAULT_CLIENT_APP;
  child[DISABLE_AUTO_MEMORY_KEY] = '1';

  // CLAUDE_CONFIG_DIR is deliberately left alone: the default config directory
  // is where the user's existing terminal login lives.
  return child;
}

/**
 * Names only — never values. Safe to log.
 * @returns {string[]}
 */
function removedOverrideNames(parentEnv = process.env) {
  return PROVIDER_OVERRIDE_KEYS.filter((key) => parentEnv[key] !== undefined);
}

module.exports = {
  PROVIDER_OVERRIDE_KEYS,
  CLIENT_APP_KEY,
  DISABLE_AUTO_MEMORY_KEY,
  DEFAULT_CLIENT_APP,
  buildChildEnv,
  removedOverrideNames
};

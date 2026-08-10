'use strict';

/**
 * Provider selection and the experimental feature gate.
 *
 * Gemini is and remains the default. The Claude Agent provider is a local
 * experiment: it is only selectable when the gate is explicitly enabled, even
 * if `AI_PROVIDER=claude-agent` is written into `.env` by hand.
 *
 * There is deliberately no automatic fallback from Claude to Gemini. Silently
 * switching providers could bill a request to an API key the user did not
 * choose, or send screen contents to a provider they did not select.
 */

const AI_PROVIDERS = Object.freeze({
  GEMINI: 'gemini',
  CLAUDE_AGENT: 'claude-agent'
});

const DEFAULT_PROVIDER = AI_PROVIDERS.GEMINI;

const PROVIDER_ENV_KEY = 'AI_PROVIDER';
const EXPERIMENTAL_GATE_KEY = 'OPENCLUELY_ENABLE_CLAUDE_SUBSCRIPTION_EXPERIMENTAL';

/** Only the exact string `true` opens the gate. */
function isClaudeExperimentEnabled(env = process.env) {
  return String(env[EXPERIMENTAL_GATE_KEY] || '').trim().toLowerCase() === 'true';
}

/**
 * @param {{ requested?: string, env?: NodeJS.ProcessEnv }} [params]
 * @returns {{ provider: string, requested: string, gated: boolean, reason: string|null }}
 */
function resolveProvider(params = {}) {
  const env = params.env || process.env;
  const raw = params.requested !== undefined ? params.requested : env[PROVIDER_ENV_KEY];
  const requested = String(raw || '').trim().toLowerCase() || DEFAULT_PROVIDER;

  if (requested === AI_PROVIDERS.CLAUDE_AGENT) {
    if (!isClaudeExperimentEnabled(env)) {
      return {
        provider: DEFAULT_PROVIDER,
        requested,
        gated: true,
        reason: `${AI_PROVIDERS.CLAUDE_AGENT} requires ${EXPERIMENTAL_GATE_KEY}=true`
      };
    }
    return { provider: AI_PROVIDERS.CLAUDE_AGENT, requested, gated: false, reason: null };
  }

  if (requested !== AI_PROVIDERS.GEMINI) {
    return { provider: DEFAULT_PROVIDER, requested, gated: false, reason: 'unknown provider' };
  }

  return { provider: AI_PROVIDERS.GEMINI, requested, gated: false, reason: null };
}

/** Providers the Settings UI may offer, given the current gate state. */
function selectableProviders(env = process.env) {
  const list = [{ id: AI_PROVIDERS.GEMINI, label: 'Gemini API', experimental: false }];
  if (isClaudeExperimentEnabled(env)) {
    list.push({ id: AI_PROVIDERS.CLAUDE_AGENT, label: 'Claude Agent (local)', experimental: true });
  }
  return list;
}

function isValidProviderValue(value) {
  return value === AI_PROVIDERS.GEMINI || value === AI_PROVIDERS.CLAUDE_AGENT;
}

module.exports = {
  AI_PROVIDERS,
  DEFAULT_PROVIDER,
  PROVIDER_ENV_KEY,
  EXPERIMENTAL_GATE_KEY,
  isClaudeExperimentEnabled,
  resolveProvider,
  selectableProviders,
  isValidProviderValue
};

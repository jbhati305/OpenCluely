'use strict';

/**
 * Stable error codes for the Claude Agent provider.
 *
 * These are part of the contract between the provider, the IPC layer and the
 * renderer. The renderer only ever sees the code plus a short human message —
 * never the underlying exception, which may contain paths or account details.
 */
const CLAUDE_ERRORS = Object.freeze({
  SDK_UNAVAILABLE: 'CLAUDE_SDK_UNAVAILABLE',
  NOT_AUTHENTICATED: 'CLAUDE_NOT_AUTHENTICATED',
  SUBSCRIPTION_REQUIRED: 'CLAUDE_SUBSCRIPTION_REQUIRED',
  AUTH_SOURCE_UNKNOWN: 'CLAUDE_AUTH_SOURCE_UNKNOWN',
  RATE_LIMITED: 'CLAUDE_RATE_LIMITED',
  BUSY: 'CLAUDE_BUSY',
  TIMEOUT: 'CLAUDE_TIMEOUT',
  CANCELLED: 'CLAUDE_CANCELLED',
  RESPONSE_EMPTY: 'CLAUDE_RESPONSE_EMPTY',
  TOOL_USE_BLOCKED: 'CLAUDE_TOOL_USE_BLOCKED',
  INVALID_IMAGE: 'CLAUDE_INVALID_IMAGE',
  PROVIDER_FAILED: 'CLAUDE_PROVIDER_FAILED'
});

const MESSAGES = Object.freeze({
  [CLAUDE_ERRORS.SDK_UNAVAILABLE]: 'The Claude Agent SDK could not be loaded on this machine.',
  [CLAUDE_ERRORS.NOT_AUTHENTICATED]: 'Claude is not signed in. Run "claude auth login" in Terminal.',
  [CLAUDE_ERRORS.SUBSCRIPTION_REQUIRED]: 'This provider requires a Claude subscription login, not API-key billing.',
  [CLAUDE_ERRORS.AUTH_SOURCE_UNKNOWN]: 'Could not determine how Claude is authenticated, so the request was stopped.',
  [CLAUDE_ERRORS.RATE_LIMITED]: 'Your Claude subscription usage limit was reached. Try again later.',
  [CLAUDE_ERRORS.BUSY]: 'Another Claude request is already running.',
  [CLAUDE_ERRORS.TIMEOUT]: 'Claude did not respond in time.',
  [CLAUDE_ERRORS.CANCELLED]: 'The Claude request was cancelled.',
  [CLAUDE_ERRORS.RESPONSE_EMPTY]: 'Claude returned an empty response.',
  [CLAUDE_ERRORS.TOOL_USE_BLOCKED]: 'Claude attempted to use a tool, which this integration does not allow.',
  [CLAUDE_ERRORS.INVALID_IMAGE]: 'The screenshot could not be prepared for Claude.',
  [CLAUDE_ERRORS.PROVIDER_FAILED]: 'The Claude provider failed to complete the request.'
});

class ClaudeProviderError extends Error {
  constructor(code, detail) {
    super(MESSAGES[code] || MESSAGES[CLAUDE_ERRORS.PROVIDER_FAILED]);
    this.name = 'ClaudeProviderError';
    this.code = CLAUDE_ERRORS[code] ? CLAUDE_ERRORS[code] : code;
    // `detail` is for local logs only. It must never be built from prompt text,
    // image bytes, credentials or account identifiers.
    if (detail) this.detail = detail;
  }

  /** The only shape that may cross the IPC boundary to the renderer. */
  toSafeObject() {
    return { code: this.code, message: this.message };
  }
}

/** Anthropic's own usage-limit copy, used to classify a rate limit. */
const USAGE_LIMIT_PREFIXES = Object.freeze([
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "You're out of extra usage",
  'Your usage allocation has been disabled by your admin',
  "Your seat type doesn't include usage"
]);

function isRateLimitText(text) {
  if (typeof text !== 'string' || !text) return false;
  return USAGE_LIMIT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

module.exports = {
  CLAUDE_ERRORS,
  ClaudeProviderError,
  USAGE_LIMIT_PREFIXES,
  isRateLimitText
};

'use strict';

const { CLAUDE_ERRORS, ClaudeProviderError, isRateLimitText } = require('./errors');

/**
 * Consumes the Agent SDK message stream and reduces it to plain text.
 *
 * Two things matter here beyond extraction:
 *
 *  1. Duplicate suppression. Text arrives twice — as incremental
 *     `stream_event` deltas and again in the final `result`. The deltas are
 *     what the UI renders; the result is authoritative for the return value.
 *     When deltas were emitted we must not replay the finished text through
 *     `onDelta`, or the answer appears twice.
 *
 *  2. Tool refusal. A tool call or permission prompt means the lockdown in
 *     query-options.js failed. That is a hard error, never something to
 *     recover from silently.
 *
 * Nothing in this module logs prompt text, image data, thinking blocks or
 * model messages.
 */

function createStreamCollector({ onDelta } = {}) {
  let streamedText = '';
  let finalText = null;
  let streamed = false;
  let sawResult = false;
  let rateLimited = false;
  let model = null;
  let violation = null;

  function noteViolation(code) {
    if (!violation) violation = code;
  }

  function handle(message) {
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'stream_event': {
        const event = message.event;
        if (
          event &&
          event.type === 'content_block_delta' &&
          event.delta &&
          event.delta.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          streamedText += event.delta.text;
          streamed = true;
          if (typeof onDelta === 'function' && event.delta.text) onDelta(event.delta.text);
        }
        break;
      }

      case 'assistant': {
        const content = message.message && message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && block.type === 'tool_use') noteViolation(CLAUDE_ERRORS.TOOL_USE_BLOCKED);
          }
        }
        if (message.message && typeof message.message.model === 'string') {
          model = message.message.model;
        }
        break;
      }

      case 'system': {
        if (message.subtype === 'permission_denied') noteViolation(CLAUDE_ERRORS.TOOL_USE_BLOCKED);
        break;
      }

      case 'result': {
        sawResult = true;
        if (typeof message.result === 'string') finalText = message.result;
        if (typeof message.model === 'string') model = message.model;
        if (message.subtype && message.subtype !== 'success') {
          if (isRateLimitText(message.result)) rateLimited = true;
        }
        if (isRateLimitText(finalText)) rateLimited = true;
        if (Array.isArray(message.permission_denials) && message.permission_denials.length > 0) {
          noteViolation(CLAUDE_ERRORS.TOOL_USE_BLOCKED);
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * @returns {{text: string, streamed: boolean, sawResult: boolean, model: string|null,
   *            rateLimited: boolean, characters: number}}
   */
  function finish() {
    if (violation) throw new ClaudeProviderError(violation);
    if (rateLimited) throw new ClaudeProviderError(CLAUDE_ERRORS.RATE_LIMITED);

    // The result is authoritative when present; the accumulated deltas are the
    // fallback for a stream that ended without one.
    const text = finalText !== null && finalText !== '' ? finalText : streamedText;

    // Nothing streamed, so the UI has seen nothing yet — emit once.
    if (!streamed && text && typeof onDelta === 'function') onDelta(text);

    if (!text) throw new ClaudeProviderError(CLAUDE_ERRORS.RESPONSE_EMPTY);

    return {
      text,
      streamed,
      sawResult,
      model,
      rateLimited,
      characters: text.length
    };
  }

  return { handle, finish };
}

module.exports = { createStreamCollector };

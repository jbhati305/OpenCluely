'use strict';

const { CLAUDE_ERRORS, ClaudeProviderError } = require('./errors');

/**
 * Builders for the SDK's streaming-input messages.
 *
 * The single-string prompt form cannot carry an image, so every request goes
 * through `AsyncIterable<SDKUserMessage>`. The wire shape is
 * `{ type, message: { role, content }, parent_tool_use_id }`.
 */

const SUPPORTED_IMAGE_MEDIA_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
]);

/** Anthropic rejects very large images; cap before we spend a request on it. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function buildTextUserMessage(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ClaudeProviderError(CLAUDE_ERRORS.PROVIDER_FAILED, 'empty text prompt');
  }

  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null
  };
}

/**
 * @param {{ text: string, image: { buffer: Buffer, mediaType: string } }} params
 */
function buildImageUserMessage({ text, image }) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ClaudeProviderError(CLAUDE_ERRORS.PROVIDER_FAILED, 'empty text prompt');
  }
  if (!image || !Buffer.isBuffer(image.buffer)) {
    throw new ClaudeProviderError(CLAUDE_ERRORS.INVALID_IMAGE, 'image buffer missing');
  }
  if (image.buffer.length === 0) {
    throw new ClaudeProviderError(CLAUDE_ERRORS.INVALID_IMAGE, 'image buffer empty');
  }
  if (image.buffer.length > MAX_IMAGE_BYTES) {
    throw new ClaudeProviderError(CLAUDE_ERRORS.INVALID_IMAGE, 'image exceeds size limit');
  }
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.includes(image.mediaType)) {
    // The media type is a fixed enum from our own capture pipeline, so naming
    // it in the detail leaks nothing about screen contents.
    throw new ClaudeProviderError(CLAUDE_ERRORS.INVALID_IMAGE, 'unsupported media type');
  }

  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType,
            data: image.buffer.toString('base64')
          }
        }
      ]
    },
    parent_tool_use_id: null
  };
}

/** Wrap one message as the AsyncIterable the SDK expects. */
async function* singleMessageStream(message) {
  yield message;
}

module.exports = {
  SUPPORTED_IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  buildTextUserMessage,
  buildImageUserMessage,
  singleMessageStream
};

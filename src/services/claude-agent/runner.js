'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { CLAUDE_ERRORS, ClaudeProviderError } = require('./errors');
const { buildQueryOptions, DEFAULT_TIMEOUT_MS } = require('./query-options');
const { createStreamCollector } = require('./stream');
const { singleMessageStream } = require('./messages');

/**
 * Runs one locked-down Agent SDK query and returns plain text.
 *
 * The Agent SDK is ESM-only and this project is CommonJS, so the import is
 * confined to the single dynamic `import()` below rather than converting the
 * repository. The promise is cached so repeated calls do not re-import.
 */

let sdkPromise = null;

async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/claude-agent-sdk').catch((error) => {
      sdkPromise = null;
      throw new ClaudeProviderError(CLAUDE_ERRORS.SDK_UNAVAILABLE, error && error.code);
    });
  }
  return sdkPromise;
}

/**
 * An isolated working directory. Never the repository: `settingSources: []`
 * already blocks project settings, but a neutral cwd means there is nothing
 * for the subprocess to discover even if that changed.
 */
async function makeTempCwd() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'opencluely-claude-'));
}

async function removeTempCwd(dir) {
  if (!dir) return;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort; a leftover empty temp dir is not worth failing on.
  }
}

/**
 * @param {object} params
 * @param {object} params.message an SDKUserMessage from ./messages
 * @param {string} params.systemPrompt
 * @param {(text: string) => void} [params.onDelta]
 * @param {AbortSignal} [params.signal] external cancellation
 * @param {number} [params.timeoutMs]
 * @param {string|null} [params.pathToClaudeCodeExecutable]
 * @param {string} [params.clientApp]
 * @param {Function} [params.queryImpl] injected for tests
 * @param {object} [params.deps] injected fs helpers for tests
 */
async function runQuery(params) {
  const {
    message,
    systemPrompt,
    onDelta,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pathToClaudeCodeExecutable = null,
    clientApp,
    parentEnv = process.env,
    queryImpl,
    deps = {}
  } = params;

  const makeCwd = deps.makeTempCwd || makeTempCwd;
  const removeCwd = deps.removeTempCwd || removeTempCwd;

  const query = queryImpl || (await loadSdk()).query;

  const abortController = new AbortController();
  let timedOut = false;
  let cancelled = false;

  const onExternalAbort = () => {
    cancelled = true;
    abortController.abort();
  };
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // Not unref'd: the caller is awaiting this request, so the timer has to keep
  // the loop alive or an idle loop can drain before the timeout fires.
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

  const cwd = await makeCwd();
  const startedAt = Date.now();
  const collector = createStreamCollector({ onDelta });

  let iterator = null;

  try {
    const options = buildQueryOptions({
      systemPrompt,
      cwd,
      abortController,
      parentEnv,
      clientApp,
      pathToClaudeCodeExecutable
    });

    iterator = query({ prompt: singleMessageStream(message), options });

    for await (const sdkMessage of iterator) {
      collector.handle(sdkMessage);
      // Stop pulling as soon as we have given up on this request, rather than
      // trusting the stream to end on its own after an abort.
      if (timedOut || cancelled) break;
    }

    // The stream can still run to completion after an abort. A late result is
    // not a valid answer — the caller has already been told to give up.
    if (timedOut) throw new ClaudeProviderError(CLAUDE_ERRORS.TIMEOUT);
    if (cancelled) throw new ClaudeProviderError(CLAUDE_ERRORS.CANCELLED);

    const result = collector.finish();
    return { ...result, durationMs: Date.now() - startedAt };
  } catch (error) {
    // Order matters: an abort surfaces as a generic error, so classify by the
    // reason we aborted rather than by the error text.
    if (timedOut) throw new ClaudeProviderError(CLAUDE_ERRORS.TIMEOUT);
    if (cancelled) throw new ClaudeProviderError(CLAUDE_ERRORS.CANCELLED);
    if (error instanceof ClaudeProviderError) throw error;
    throw new ClaudeProviderError(CLAUDE_ERRORS.PROVIDER_FAILED, error && error.name);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);

    // Stop consuming and let the SDK tear the subprocess down. `return()` is
    // what signals the async generator to run its own cleanup.
    if (iterator && typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch {
        // Already finished or already aborted.
      }
    }

    await removeCwd(cwd);
  }
}

module.exports = {
  loadSdk,
  makeTempCwd,
  removeTempCwd,
  runQuery,
  // exported for the packaging check
  _internal: { fs }
};

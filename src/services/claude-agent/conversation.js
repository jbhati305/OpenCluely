'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { CLAUDE_ERRORS, ClaudeProviderError, isRateLimitText } = require('./errors');
const { buildQueryOptions } = require('./query-options');

/**
 * One long-lived Claude conversation.
 *
 * A single `query()` invocation is kept alive and fed sequential user messages
 * through an async input queue, so Claude keeps its own context across text,
 * screenshots and speech. This replaces re-sending the last N history entries
 * on every request, which was both slower and not a real conversation.
 *
 * Verified against the pinned SDK by scripts/claude-multiturn-probe.mjs:
 * context survives text -> image -> text, every user turn produces its own
 * result boundary, all turns share one session id, and nothing is written to
 * ~/.claude/projects.
 *
 * The system prompt is fixed for the life of the conversation, so a skill
 * change requires a new conversation. Per-turn pacing (guided stage, deep
 * dive, full answer) is carried in the user message instead, which is what
 * lets the interview advance without tearing the session down.
 *
 * Never logs prompt text, image bytes, model output, credentials or account
 * details — only sanitized counters and durations.
 */

const DEFAULT_TURN_TIMEOUT_MS = 120000;

/** Feeds the SDK query. Async-iterable, push-driven, closable. */
function createInputQueue() {
  const pending = [];
  const waiters = [];
  let closed = false;

  return {
    push(message) {
      if (closed) return false;
      if (waiters.length) waiters.shift()({ value: message, done: false });
      else pending.push(message);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    get closed() {
      return closed;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (pending.length) {
          yield pending.shift();
          continue;
        }
        if (closed) return;
        const next = await new Promise((resolve) => waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  };
}

class ClaudeConversation {
  /**
   * @param {object} params
   * @param {string} params.systemPrompt fixed for the conversation's lifetime
   * @param {string} [params.skill] recorded for diagnostics only
   */
  constructor({
    systemPrompt,
    skill = null,
    parentEnv = process.env,
    clientApp = 'opencluely/1.0.0',
    pathToClaudeCodeExecutable = null,
    logger = null,
    queryImpl = null,
    deps = {}
  } = {}) {
    this.systemPrompt = systemPrompt;
    this.skill = skill;
    this.parentEnv = parentEnv;
    this.clientApp = clientApp;
    this.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };

    this._queryImpl = queryImpl;
    this._deps = deps;

    this._queue = null;
    this._iterator = null;
    this._abortController = null;
    this._cwd = null;
    this._pump = null;

    this._activeTurn = null;
    /** Claimed synchronously in send() to close the concurrent-start race. */
    this._claiming = false;
    this._turnCounter = 0;
    /** Bumped on every destroy so late output from a dead session is dropped. */
    this._generation = 0;

    this._started = false;
    this._destroyed = false;
    this._turnsSent = 0;
    this._failureReason = null;
  }

  get isAlive() {
    return this._started && !this._destroyed;
  }

  get turnsSent() {
    return this._turnsSent;
  }

  get busy() {
    return this._activeTurn !== null;
  }

  async _makeCwd() {
    const make = this._deps.makeTempCwd;
    if (make) return make();
    return fsp.mkdtemp(path.join(os.tmpdir(), 'opencluely-claude-'));
  }

  async _removeCwd(dir) {
    if (!dir) return;
    const remove = this._deps.removeTempCwd;
    if (remove) return remove(dir);
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      // Best effort; an empty temp dir is not worth failing a request over.
    }
  }

  async _resolveQuery() {
    if (this._queryImpl) return this._queryImpl;
    const { loadSdk } = require('./runner');
    return (await loadSdk()).query;
  }

  /** Lazily start the underlying SDK query. Idempotent. */
  async _ensureStarted() {
    if (this._destroyed) throw new ClaudeProviderError(CLAUDE_ERRORS.PROVIDER_FAILED, 'conversation destroyed');
    if (this._started) return;

    const query = await this._resolveQuery();

    this._cwd = await this._makeCwd();
    this._abortController = new AbortController();
    this._queue = createInputQueue();

    const options = buildQueryOptions({
      systemPrompt: this.systemPrompt,
      cwd: this._cwd,
      abortController: this._abortController,
      parentEnv: this.parentEnv,
      clientApp: this.clientApp,
      pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable
    });

    this._iterator = query({ prompt: this._queue, options });
    this._started = true;
    this._pump = this._consume(this._generation);
    // The pump owns its own errors; nothing awaits it directly.
    this._pump.catch(() => {});
  }

  /**
   * The single reader of the SDK stream. Routes events to whichever turn is
   * currently active, and only to turns from this generation.
   */
  async _consume(generation) {
    try {
      for await (const message of this._iterator) {
        if (generation !== this._generation) return;
        this._route(message, generation);
      }
      // The stream ended on its own — Claude exited or was aborted.
      this._failTurn(new ClaudeProviderError(CLAUDE_ERRORS.PROVIDER_FAILED, 'stream ended'), generation);
      if (generation === this._generation && !this._destroyed) {
        this._failureReason = 'stream-ended';
      }
    } catch (error) {
      if (generation !== this._generation) return;
      this._failureReason = 'stream-error';
      this._failTurn(
        error instanceof ClaudeProviderError
          ? error
          : new ClaudeProviderError(CLAUDE_ERRORS.PROVIDER_FAILED, error && error.name),
        generation
      );
    }
  }

  _route(message, generation) {
    const turn = this._activeTurn;
    // Late output after cancellation, timeout, clear or replacement.
    if (!turn || turn.generation !== generation || turn.settled) return;

    switch (message.type) {
      case 'stream_event': {
        const event = message.event;
        if (
          event &&
          event.type === 'content_block_delta' &&
          event.delta &&
          event.delta.type === 'text_delta' &&
          typeof event.delta.text === 'string' &&
          event.delta.text
        ) {
          if (turn.ttftMs === null) turn.ttftMs = Date.now() - turn.startedAt;
          turn.streamedText += event.delta.text;
          turn.streamed = true;
          if (typeof turn.onDelta === 'function') turn.onDelta(event.delta.text);
        }
        break;
      }

      case 'assistant': {
        const content = message.message && message.message.content;
        if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_use')) {
          turn.violation = CLAUDE_ERRORS.TOOL_USE_BLOCKED;
        }
        if (message.message && typeof message.message.model === 'string') {
          turn.model = message.message.model;
        }
        break;
      }

      case 'system': {
        if (message.subtype === 'permission_denied') turn.violation = CLAUDE_ERRORS.TOOL_USE_BLOCKED;
        break;
      }

      case 'result': {
        const finalText = typeof message.result === 'string' ? message.result : '';
        if (typeof message.model === 'string') turn.model = message.model;
        if (Array.isArray(message.permission_denials) && message.permission_denials.length > 0) {
          turn.violation = CLAUDE_ERRORS.TOOL_USE_BLOCKED;
        }

        if (turn.violation) {
          this._settle(turn, { error: new ClaudeProviderError(turn.violation) });
          return;
        }
        if (isRateLimitText(finalText)) {
          this._settle(turn, { error: new ClaudeProviderError(CLAUDE_ERRORS.RATE_LIMITED) });
          return;
        }

        // The result is authoritative; deltas are the fallback.
        const text = finalText || turn.streamedText;

        // Nothing streamed, so the UI has seen nothing yet.
        if (!turn.streamed && text && typeof turn.onDelta === 'function') turn.onDelta(text);

        if (!text) {
          this._settle(turn, { error: new ClaudeProviderError(CLAUDE_ERRORS.RESPONSE_EMPTY) });
          return;
        }

        this._settle(turn, {
          value: {
            text,
            streamed: turn.streamed,
            model: turn.model,
            characters: text.length,
            ttftMs: turn.ttftMs,
            durationMs: Date.now() - turn.startedAt,
            reusedProcess: turn.reusedProcess,
            turnIndex: turn.index
          }
        });
        break;
      }

      default:
        break;
    }
  }

  _settle(turn, { value, error }) {
    if (turn.settled) return;
    turn.settled = true;
    if (turn.timer) clearTimeout(turn.timer);
    if (turn.detachSignal) turn.detachSignal();
    if (this._activeTurn === turn) this._activeTurn = null;
    if (error) turn.reject(error);
    else turn.resolve(value);
  }

  _failTurn(error, generation) {
    const turn = this._activeTurn;
    if (turn && turn.generation === generation) this._settle(turn, { error });
  }

  /**
   * Send one user message and wait for that turn's result.
   *
   * @param {object} params
   * @param {object} params.message an SDKUserMessage
   * @param {(text: string) => void} [params.onDelta]
   * @param {AbortSignal} [params.signal]
   * @param {number} [params.timeoutMs]
   */
  async send({ message, onDelta, signal, timeoutMs = DEFAULT_TURN_TIMEOUT_MS }) {
    // The slot is claimed synchronously, before any await. Checking only
    // `_activeTurn` here would let two concurrent callers both pass the guard
    // during `_ensureStarted()`, and the first turn would be orphaned.
    if (this._activeTurn || this._claiming) throw new ClaudeProviderError(CLAUDE_ERRORS.BUSY);
    this._claiming = true;

    const reusedProcess = this._started;
    try {
      await this._ensureStarted();
    } catch (error) {
      this._claiming = false;
      throw error;
    }

    const generation = this._generation;
    this._turnCounter += 1;

    const turn = {
      index: this._turnCounter,
      generation,
      onDelta,
      startedAt: Date.now(),
      ttftMs: null,
      streamedText: '',
      streamed: false,
      model: null,
      violation: null,
      settled: false,
      reusedProcess,
      timer: null,
      detachSignal: null,
      resolve: null,
      reject: null
    };

    const promise = new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });

    // Deliberately NOT unref'd: a caller is awaiting this turn, so the timer
    // must keep the loop alive. Unref'ing it means an idle loop can drain
    // before the timeout fires, leaving the caller hanging forever.
    turn.timer = setTimeout(() => {
      // A timed-out turn must never deliver a late answer.
      this._settle(turn, { error: new ClaudeProviderError(CLAUDE_ERRORS.TIMEOUT) });
    }, timeoutMs);

    if (signal) {
      const onAbort = () => this._settle(turn, { error: new ClaudeProviderError(CLAUDE_ERRORS.CANCELLED) });
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        turn.detachSignal = () => signal.removeEventListener('abort', onAbort);
      }
    }

    this._claiming = false;
    if (turn.settled) return promise;

    this._activeTurn = turn;
    this._turnsSent += 1;
    this._queue.push(message);

    return promise;
  }

  /**
   * End the conversation. Idempotent, and safe to call while a turn is in
   * flight — the active turn is rejected as cancelled and any output that
   * arrives afterwards is dropped by the generation check.
   */
  async destroy(reason = 'unspecified') {
    if (this._destroyed) return;
    this._destroyed = true;

    const generation = this._generation;
    this._generation += 1;

    this._failTurn(new ClaudeProviderError(CLAUDE_ERRORS.CANCELLED), generation);

    if (this._queue) this._queue.close();
    if (this._abortController) this._abortController.abort();

    // `return()` asks the SDK generator to unwind, but it cannot settle while
    // that generator is suspended on an await that the abort does not
    // interrupt. Never block quit on it — the abort above is what actually
    // stops the subprocess.
    if (this._iterator && typeof this._iterator.return === 'function') {
      const unwound = Promise.resolve()
        .then(() => this._iterator.return())
        .catch(() => {});
      // Not unref'd: destroy() is awaited, so this timer must keep the loop
      // alive or the race can never settle on an otherwise idle loop.
      await Promise.race([unwound, new Promise((resolve) => setTimeout(resolve, 250))]);
    }

    await this._removeCwd(this._cwd);
    this._cwd = null;
    this._started = false;

    this.logger.debug('Claude conversation destroyed', {
      reason,
      turnsSent: this._turnsSent,
      skill: this.skill
    });
  }

  /** Sanitized. No prompt text, no output, no account data. */
  getDiagnostics() {
    return {
      alive: this.isAlive,
      skill: this.skill,
      turnsSent: this._turnsSent,
      busy: this.busy,
      failureReason: this._failureReason
    };
  }
}

module.exports = { ClaudeConversation, createInputQueue, DEFAULT_TURN_TIMEOUT_MS };

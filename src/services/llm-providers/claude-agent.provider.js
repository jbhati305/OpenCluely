'use strict';

const { promptLoader } = require('../../../prompt-loader');
const {
  readAuthStatus,
  isSubscriptionAuth,
  authErrorCode,
  resolveClaudeExecutable
} = require('../claude-agent/auth');
const { buildTextUserMessage, buildImageUserMessage } = require('../claude-agent/messages');
const { ClaudeConversation } = require('../claude-agent/conversation');
const { CLAUDE_ERRORS, ClaudeProviderError } = require('../claude-agent/errors');

/**
 * Local, experimental provider backed by the Claude subscription already
 * authenticated through the Claude CLI on this machine.
 *
 * OpenCluely stores no Claude credentials. Reconnecting means the user running
 * `claude auth login` in Terminal themselves — there is no embedded login here
 * by design.
 *
 * One conversation is kept alive across text, screenshots and speech until the
 * user clears the chat. Because Claude holds the context itself, OpenCluely's
 * history is NOT re-sent on every request; SessionManager remains the source of
 * truth for the UI transcript, not for the model context.
 *
 * Only one turn runs at a time. Concurrency against a subscription-metered
 * subprocess has not been proven safe, so a second request is refused with
 * CLAUDE_BUSY rather than queued.
 */

/** Only used to seed a brand-new conversation, never on later turns. */
const SEED_HISTORY_LIMIT = 15;
const DEFAULT_TIMEOUT_MS = 120000;

class ClaudeAgentProvider {
  constructor({ logger, deps = {} } = {}) {
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.id = 'claude-agent';

    this._readAuthStatus = deps.readAuthStatus || readAuthStatus;
    this._resolveExecutable = deps.resolveClaudeExecutable || resolveClaudeExecutable;
    this._promptLoader = deps.promptLoader || promptLoader;
    this._createConversation = deps.createConversation || ((opts) => new ClaudeConversation(opts));

    this._status = { authenticated: false, credentialSource: 'unknown', plan: null };
    this._initialized = false;
    this._conversation = null;
    this._conversationSkill = null;
    this._executablePath = null;
    this._executableSource = 'bundled';
    this._lastResetReason = null;
    this._lastMetrics = null;
  }

  async initialize() {
    this._status = await this._readAuthStatus({ executable: this._executablePath || undefined });
    this._initialized = true;

    if (!isSubscriptionAuth(this._status)) {
      this.logger.warn('Claude provider not usable', { code: authErrorCode(this._status) });
    }
    return this.getStatus();
  }

  /**
   * Point both the auth check and the SDK at a specific Claude executable.
   * Changing it tears down the conversation: a different binary may be a
   * different account state entirely.
   */
  async setExecutable({ path: executablePath, source = 'configured' }) {
    const changed = executablePath !== this._executablePath;
    this._executablePath = executablePath || null;
    this._executableSource = executablePath ? source : 'bundled';
    if (changed) {
      await this.clearConversation('executable-changed');
      this._initialized = false;
    }
    return this.getStatus();
  }

  /** Sanitized. Safe to hand to IPC. Never contains email, org or tokens. */
  getStatus() {
    const conversation = this._conversation ? this._conversation.getDiagnostics() : null;
    return {
      provider: this.id,
      initialized: this._initialized,
      available: isSubscriptionAuth(this._status),
      authenticated: Boolean(this._status && this._status.authenticated),
      credentialSource: this._status ? this._status.credentialSource : 'unknown',
      plan: this._status ? this._status.plan : null,
      busy: Boolean(conversation && conversation.busy),
      conversationActive: Boolean(conversation && conversation.alive),
      turnsSent: conversation ? conversation.turnsSent : 0,
      executableSource: this._executableSource,
      lastResetReason: this._lastResetReason,
      errorCode: isSubscriptionAuth(this._status) ? null : authErrorCode(this._status)
    };
  }

  getLastMetrics() {
    return this._lastMetrics;
  }

  async testConnection() {
    await this.initialize();
    if (!isSubscriptionAuth(this._status)) {
      return { success: false, ...this.getStatus() };
    }

    // Deliberately its own throwaway conversation so a connection test never
    // pollutes the user's interview context.
    const probe = this._createConversation({
      systemPrompt: 'You are a terse assistant. Answer in one word.',
      skill: null,
      clientApp: 'opencluely/1.0.0',
      pathToClaudeCodeExecutable: this._executablePath,
      logger: this.logger
    });

    try {
      const result = await probe.send({
        message: buildTextUserMessage('Reply with the single word: ready'),
        timeoutMs: 60000
      });
      return { success: true, ...this.getStatus(), sample: result.text.slice(0, 40) };
    } catch (error) {
      return { success: false, ...this.getStatus(), errorCode: error.code || CLAUDE_ERRORS.PROVIDER_FAILED };
    } finally {
      await probe.destroy('test-connection-complete');
    }
  }

  _systemPrompt(activeSkill, programmingLanguage) {
    const prompt = this._promptLoader.getSkillPrompt(activeSkill, programmingLanguage);
    return prompt && prompt.trim() ? prompt : 'You are a helpful assistant.';
  }

  /**
   * Seed text for a brand-new conversation only. Once Claude holds the
   * context itself, re-sending history would duplicate it in the model's view.
   */
  _seedHistory(sessionMemory) {
    if (!Array.isArray(sessionMemory) || sessionMemory.length === 0) return '';

    const lines = [];
    for (const entry of sessionMemory.slice(-SEED_HISTORY_LIMIT)) {
      if (!entry) continue;
      const role = entry.role === 'assistant' || entry.role === 'model' ? 'Assistant' : 'User';
      const content = typeof entry.content === 'string' ? entry.content : entry.text;
      if (typeof content === 'string' && content.trim()) lines.push(`${role}: ${content.trim()}`);
    }
    if (!lines.length) return '';
    return `Earlier in this conversation:\n${lines.join('\n')}\n\n`;
  }

  /**
   * The conversation for this skill, created lazily.
   *
   * The system prompt is fixed for a conversation's lifetime, so a skill
   * change starts a new one. Per-turn pacing rides in the user message
   * instead, which is what lets a guided interview advance stage by stage
   * without tearing the session down.
   */
  async _ensureConversation(activeSkill, programmingLanguage) {
    const skillChanged = this._conversation && this._conversationSkill !== activeSkill;
    if (skillChanged) await this.clearConversation('skill-changed');

    if (this._conversation && !this._conversation.isAlive) {
      // The Claude process exited on its own.
      await this.clearConversation('session-ended-unexpectedly');
    }

    if (!this._conversation) {
      this._conversation = this._createConversation({
        systemPrompt: this._systemPrompt(activeSkill, programmingLanguage),
        skill: activeSkill,
        clientApp: 'opencluely/1.0.0',
        pathToClaudeCodeExecutable: this._executablePath,
        logger: this.logger
      });
      this._conversationSkill = activeSkill;
      return { conversation: this._conversation, isNew: true };
    }

    return { conversation: this._conversation, isNew: false };
  }

  _assertUsable() {
    if (!isSubscriptionAuth(this._status)) {
      throw new ClaudeProviderError(authErrorCode(this._status) || CLAUDE_ERRORS.NOT_AUTHENTICATED);
    }
  }

  /** Sanitized metrics only: durations and counts, never content. */
  _recordMetrics(result, { skill, strategy, stage, isNew }) {
    this._lastMetrics = {
      ttftMs: result.ttftMs,
      durationMs: result.durationMs,
      characters: result.characters,
      reusedProcess: !isNew,
      turnIndex: result.turnIndex,
      strategy: strategy || null,
      stage: stage || null,
      skill: skill || null
    };
    this.logger.debug('Claude turn complete', this._lastMetrics);
    return this._lastMetrics;
  }

  _envelope(result, { skill, programmingLanguage, startedAt, strategy, stage, isNew }) {
    return {
      response: result.text,
      metadata: {
        skill,
        programmingLanguage,
        processingTime: Date.now() - startedAt,
        provider: this.id,
        model: result.model || null,
        usedFallback: false,
        streamed: result.streamed,
        strategy: strategy || null,
        stage: stage || null,
        reusedConversation: !isNew,
        turnIndex: result.turnIndex,
        ttftMs: result.ttftMs
      }
    };
  }

  async _turn({ buildMessage, activeSkill, programmingLanguage, sessionMemory, directive, strategy, stage, onDelta, signal }) {
    this._assertUsable();

    const startedAt = Date.now();
    const { conversation, isNew } = await this._ensureConversation(activeSkill, programmingLanguage);

    // History is only replayed when seeding a fresh conversation. On a reused
    // one Claude already holds it, and re-sending would duplicate context.
    const seed = isNew ? this._seedHistory(sessionMemory) : '';
    const prefix = [seed, directive ? `${directive}\n\n` : ''].join('');

    try {
      const result = await conversation.send({
        message: buildMessage(prefix),
        onDelta,
        signal,
        timeoutMs: DEFAULT_TIMEOUT_MS
      });

      this._recordMetrics(result, { skill: activeSkill, strategy, stage, isNew });
      return this._envelope(result, { skill: activeSkill, programmingLanguage, startedAt, strategy, stage, isNew });
    } catch (error) {
      // A dead conversation must not be reused; the next request starts fresh.
      if (error.code === CLAUDE_ERRORS.PROVIDER_FAILED || error.code === CLAUDE_ERRORS.NOT_AUTHENTICATED) {
        await this.clearConversation('turn-failed');
      }
      throw error;
    }
  }

  async processTextStream({
    text, activeSkill, sessionMemory, programmingLanguage,
    directive = '', strategy = null, stage = null, onDelta, signal
  }) {
    return this._turn({
      buildMessage: (prefix) => buildTextUserMessage(`${prefix}${text}`),
      activeSkill, programmingLanguage, sessionMemory, directive, strategy, stage, onDelta, signal
    });
  }

  async processImageStream({
    imageBuffer, mimeType, instruction, activeSkill, sessionMemory, programmingLanguage,
    directive = '', strategy = null, stage = null, onDelta, signal
  }) {
    return this._turn({
      buildMessage: (prefix) => buildImageUserMessage({
        text: `${prefix}${instruction}`,
        image: { buffer: imageBuffer, mediaType: mimeType }
      }),
      activeSkill, programmingLanguage, sessionMemory, directive, strategy, stage, onDelta, signal
    });
  }

  /**
   * End the Claude conversation. Idempotent, and safe during streaming — the
   * in-flight turn is rejected and late output is dropped.
   */
  async clearConversation(reason = 'cleared') {
    const conversation = this._conversation;
    this._conversation = null;
    this._conversationSkill = null;
    this._lastResetReason = reason;

    if (conversation) {
      await conversation.destroy(reason);
      this.logger.info('Claude conversation reset', { reason });
    }
    return { reset: Boolean(conversation), reason };
  }

  /** Called on app quit; must leave no subprocess behind. */
  shutdown() {
    if (this._conversation) {
      const conversation = this._conversation;
      this._conversation = null;
      this._conversationSkill = null;
      // Fire and forget: quit cannot wait on IO, but abort is synchronous.
      conversation.destroy('app-quit').catch(() => {});
    }
  }
}

module.exports = { ClaudeAgentProvider, SEED_HISTORY_LIMIT };

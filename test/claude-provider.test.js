'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  AI_PROVIDERS,
  DEFAULT_PROVIDER,
  PROVIDER_ENV_KEY,
  EXPERIMENTAL_GATE_KEY,
  isClaudeExperimentEnabled,
  resolveProvider,
  selectableProviders,
  isValidProviderValue
} = require('../src/services/llm-providers/selection');
const { ClaudeAgentProvider, SEED_HISTORY_LIMIT } = require('../src/services/llm-providers/claude-agent.provider');
const { CLAUDE_ERRORS } = require('../src/services/claude-agent/errors');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mainJs = read('main.js');
const preloadJs = read('preload.js');
const settingsHtml = read('settings.html');
const settingsWindowJs = read('src/ui/settings-window.js');
const llmService = read('src/services/llm.service.js');

const SUBSCRIBED = { authenticated: true, credentialSource: 'subscription', plan: 'pro' };
const API_AUTH = { authenticated: true, credentialSource: 'api', plan: null };

/**
 * A stand-in for ClaudeConversation. Records the options it was constructed
 * with and every turn sent, so tests can assert that one conversation is
 * reused rather than recreated per request.
 */
function makeProvider(overrides = {}) {
  const calls = [];       // every send({...})
  const conversations = []; // every conversation constructed

  const makeConversation = (opts) => {
    const conversation = {
      options: opts,
      sends: [],
      destroyed: false,
      destroyReason: null,
      isAlive: true,
      _turns: 0,
      getDiagnostics() {
        return {
          alive: this.isAlive && !this.destroyed,
          skill: opts.skill,
          turnsSent: this._turns,
          busy: Boolean(this.busy),
          failureReason: null
        };
      },
      async send(params) {
        // Mirrors the real ClaudeConversation: one turn at a time, refused
        // rather than queued.
        if (this.busy) {
          const { ClaudeProviderError } = require('../src/services/claude-agent/errors');
          throw new ClaudeProviderError(CLAUDE_ERRORS.BUSY);
        }
        this._turns += 1;
        this.sends.push(params);
        calls.push({ ...params, conversation: this, systemPrompt: opts.systemPrompt });
        if (overrides.send) {
          this.busy = true;
          try {
            return await overrides.send(params, this);
          } finally {
            this.busy = false;
          }
        }
        if (typeof params.onDelta === 'function') params.onDelta('hi');
        return {
          text: 'hi', streamed: true, model: 'claude-sonnet-5',
          characters: 2, durationMs: 5, ttftMs: 1, turnIndex: this._turns
        };
      },
      async destroy(reason) {
        this.destroyed = true;
        this.isAlive = false;
        this.destroyReason = reason;
      }
    };
    conversations.push(conversation);
    return conversation;
  };

  const provider = new ClaudeAgentProvider({
    deps: {
      readAuthStatus: async () => overrides.status || SUBSCRIBED,
      createConversation: overrides.createConversation || makeConversation,
      promptLoader: overrides.promptLoader || {
        getSkillPrompt: (skill, lang) => `PROMPT:${skill}${lang ? `:${lang}` : ''}`
      }
    }
  });
  return { provider, calls, conversations };
}

// ------------------------------------------------- selection + gate

test('provider selection defaults to Gemini', () => {
  assert.equal(DEFAULT_PROVIDER, AI_PROVIDERS.GEMINI);
  assert.equal(resolveProvider({ env: {} }).provider, 'gemini');
  assert.equal(resolveProvider({ env: { [PROVIDER_ENV_KEY]: '' } }).provider, 'gemini');
  assert.equal(resolveProvider({ env: { [PROVIDER_ENV_KEY]: 'gemini' } }).provider, 'gemini');
});

test('claude-agent is refused unless the experimental gate is set', () => {
  const env = { [PROVIDER_ENV_KEY]: 'claude-agent' };
  const gatedOff = resolveProvider({ env });

  assert.equal(gatedOff.provider, 'gemini', 'a hand-edited .env must not activate the experiment');
  assert.equal(gatedOff.gated, true);
  assert.match(gatedOff.reason, /OPENCLUELY_ENABLE_CLAUDE_SUBSCRIPTION_EXPERIMENTAL/);

  const gatedOn = resolveProvider({ env: { ...env, [EXPERIMENTAL_GATE_KEY]: 'true' } });
  assert.equal(gatedOn.provider, 'claude-agent');
  assert.equal(gatedOn.gated, false);
});

test('only the exact string true opens the gate', () => {
  for (const value of ['1', 'yes', 'on', 'TRUE ', '', undefined, 'false']) {
    const enabled = isClaudeExperimentEnabled({ [EXPERIMENTAL_GATE_KEY]: value });
    assert.equal(enabled, String(value).trim().toLowerCase() === 'true', `value ${value}`);
  }
  assert.equal(isClaudeExperimentEnabled({ [EXPERIMENTAL_GATE_KEY]: 'true' }), true);
  assert.equal(isClaudeExperimentEnabled({}), false);
});

test('an unknown provider value falls back to Gemini rather than erroring', () => {
  const resolved = resolveProvider({ env: { [PROVIDER_ENV_KEY]: 'openai' } });
  assert.equal(resolved.provider, 'gemini');
  assert.equal(resolved.reason, 'unknown provider');

  assert.equal(isValidProviderValue('gemini'), true);
  assert.equal(isValidProviderValue('claude-agent'), true);
  assert.equal(isValidProviderValue('openai'), false);
});

test('the settings list only offers Claude when the gate is on', () => {
  assert.deepEqual(selectableProviders({}).map((p) => p.id), ['gemini']);
  assert.deepEqual(
    selectableProviders({ [EXPERIMENTAL_GATE_KEY]: 'true' }).map((p) => p.id),
    ['gemini', 'claude-agent']
  );
  const claude = selectableProviders({ [EXPERIMENTAL_GATE_KEY]: 'true' })[1];
  assert.equal(claude.label, 'Claude Agent (local)', 'must not be branded "Claude Code"');
  assert.equal(claude.experimental, true);
});

// ------------------------------------------------- auth requirements

test('the provider requires subscription auth and rejects API auth', async () => {
  const ok = makeProvider();
  await ok.provider.initialize();
  assert.equal(ok.provider.getStatus().available, true);
  assert.equal(ok.provider.getStatus().plan, 'pro');

  const api = makeProvider({ status: API_AUTH });
  await api.provider.initialize();
  const status = api.provider.getStatus();
  assert.equal(status.available, false);
  assert.equal(status.errorCode, CLAUDE_ERRORS.SUBSCRIPTION_REQUIRED);

  await assert.rejects(
    api.provider.processTextStream({ text: 'hi', activeSkill: 'dsa' }),
    (e) => e.code === CLAUDE_ERRORS.SUBSCRIPTION_REQUIRED
  );
});

test('the status object never carries credentials or account identifiers', async () => {
  const { provider } = makeProvider();
  await provider.initialize();
  const serialized = JSON.stringify(provider.getStatus());

  for (const key of ['email', 'orgId', 'orgName', 'token', 'Token', 'apiKey', 'path']) {
    assert.ok(!serialized.includes(key), `status must not expose ${key}`);
  }
  assert.deepEqual(
    Object.keys(provider.getStatus()).sort(),
    [
      'authenticated', 'available', 'busy', 'conversationActive', 'credentialSource',
      'errorCode', 'executableSource', 'initialized', 'lastResetReason', 'plan',
      'provider', 'turnsSent'
    ]
  );
});

// ------------------------------------------------- request mapping

test('text requests carry the skill prompt as the system prompt', async () => {
  const { provider, calls } = makeProvider();
  await provider.initialize();

  await provider.processTextStream({ text: 'explain quicksort', activeSkill: 'dsa', programmingLanguage: 'cpp' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].systemPrompt, 'PROMPT:dsa:cpp', 'skill and language must both survive');
  assert.match(calls[0].message.message.content[0].text, /explain quicksort$/);
});

test('image requests send the in-memory buffer as a base64 content block', async () => {
  const { provider, calls } = makeProvider();
  await provider.initialize();

  const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
  await provider.processImageStream({
    imageBuffer,
    mimeType: 'image/png',
    instruction: 'solve this',
    activeSkill: 'lld',
    programmingLanguage: 'java'
  });

  const content = calls[0].message.message.content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].source.media_type, 'image/png');
  assert.equal(content[1].source.data, imageBuffer.toString('base64'));
  assert.equal(calls[0].systemPrompt, 'PROMPT:lld:java');
  assert.match(content[0].text, /solve this$/);

  // The screenshot must never become a file path or a CLI argument.
  const serialized = JSON.stringify(calls[0]);
  assert.ok(!serialized.includes('.png"'), 'no file path may appear in the request');
});

test('an invalid screenshot is rejected before a request is spent', async () => {
  const { provider, calls } = makeProvider();
  await provider.initialize();

  await assert.rejects(
    provider.processImageStream({ imageBuffer: Buffer.alloc(0), mimeType: 'image/png', instruction: 'x', activeSkill: 'dsa' }),
    (e) => e.code === CLAUDE_ERRORS.INVALID_IMAGE
  );
  await assert.rejects(
    provider.processImageStream({ imageBuffer: Buffer.from([1]), mimeType: 'image/tiff', instruction: 'x', activeSkill: 'dsa' }),
    (e) => e.code === CLAUDE_ERRORS.INVALID_IMAGE
  );
  assert.equal(calls.length, 0, 'no request may be sent for an invalid image');
});

test('history seeds a NEW conversation but is never re-sent on later turns', async () => {
  const { provider, calls, conversations } = makeProvider();
  await provider.initialize();

  const sessionMemory = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn-${i}`
  }));

  // First turn: the conversation is new, so history is replayed to seed it.
  await provider.processTextStream({ text: 'first question', activeSkill: 'dsa', sessionMemory });
  const seeded = calls[0].message.message.content[0].text;
  assert.ok(seeded.includes('first question'));
  assert.ok(seeded.includes(`turn-${40 - SEED_HISTORY_LIMIT}`), 'newest history must seed the session');
  assert.ok(!seeded.includes('turn-0'), 'seed history must be bounded');
  assert.equal((seeded.match(/turn-/g) || []).length, SEED_HISTORY_LIMIT);

  // Second turn: Claude already holds the context. Re-sending it would
  // duplicate the conversation inside the model's view.
  await provider.processTextStream({ text: 'second question', activeSkill: 'dsa', sessionMemory });
  const reused = calls[1].message.message.content[0].text;
  assert.ok(reused.includes('second question'));
  assert.ok(!reused.includes('turn-'), 'history must NOT be prefixed onto a reused conversation');
  assert.ok(!reused.includes('Earlier in this conversation'));

  assert.equal(conversations.length, 1, 'both turns must use ONE conversation');

  // Claude's own disk-backed resume must not be used.
  assert.ok(!('resume' in calls[0]));
  assert.ok(!('forkSession' in calls[0]));
});

test('an empty history leaves the prompt untouched', async () => {
  const { provider, calls } = makeProvider();
  await provider.initialize();
  await provider.processTextStream({ text: 'plain question', activeSkill: 'general', sessionMemory: [] });
  assert.equal(calls[0].message.message.content[0].text, 'plain question');
});

test('text then image then text all share one conversation with context intact', async () => {
  const { provider, calls, conversations } = makeProvider();
  await provider.initialize();

  await provider.processTextStream({ text: 'remember 42', activeSkill: 'dsa' });
  await provider.processImageStream({
    imageBuffer: Buffer.from([0x89, 0x50]), mimeType: 'image/png',
    instruction: 'what is this', activeSkill: 'dsa'
  });
  await provider.processTextStream({ text: 'what number?', activeSkill: 'dsa' });

  assert.equal(conversations.length, 1, 'one conversation across all three modalities');
  assert.equal(calls.length, 3);
  assert.equal(conversations[0].getDiagnostics().turnsSent, 3);
  // Only the first turn may carry a seed prefix.
  assert.ok(!calls[1].message.message.content[0].text.includes('Earlier in this conversation'));
  assert.ok(!calls[2].message.message.content[0].text.includes('Earlier in this conversation'));
});

test('clearing destroys the conversation and the next request creates a new one', async () => {
  const { provider, conversations } = makeProvider();
  await provider.initialize();

  await provider.processTextStream({ text: 'first', activeSkill: 'dsa' });
  assert.equal(conversations.length, 1);
  assert.equal(provider.getStatus().conversationActive, true);

  const result = await provider.clearConversation('chat-bin');
  assert.equal(result.reset, true);
  assert.equal(conversations[0].destroyed, true, 'the SDK conversation must be destroyed');
  assert.equal(conversations[0].destroyReason, 'chat-bin');
  assert.equal(provider.getStatus().conversationActive, false);

  await provider.processTextStream({ text: 'second', activeSkill: 'dsa' });
  assert.equal(conversations.length, 2, 'the next request must start a fresh conversation');
});

test('clearing is idempotent and safe when nothing was ever started', async () => {
  const { provider } = makeProvider();
  await provider.initialize();

  assert.deepEqual(await provider.clearConversation('noop'), { reset: false, reason: 'noop' });
  await provider.processTextStream({ text: 'x', activeSkill: 'dsa' });
  await provider.clearConversation('once');
  assert.deepEqual(await provider.clearConversation('twice'), { reset: false, reason: 'twice' });
});

test('changing skill starts a new conversation, since the system prompt is fixed', async () => {
  const { provider, conversations } = makeProvider();
  await provider.initialize();

  await provider.processTextStream({ text: 'a', activeSkill: 'dsa' });
  await provider.processTextStream({ text: 'b', activeSkill: 'dsa' });
  assert.equal(conversations.length, 1);

  await provider.processTextStream({ text: 'c', activeSkill: 'system-design' });
  assert.equal(conversations.length, 2, 'a skill change must not reuse the old system prompt');
  assert.equal(conversations[0].destroyed, true);
  assert.equal(conversations[1].options.systemPrompt, 'PROMPT:system-design');
});

test('changing the executable path resets the conversation', async () => {
  const { provider, conversations } = makeProvider();
  await provider.initialize();
  await provider.processTextStream({ text: 'a', activeSkill: 'dsa' });

  await provider.setExecutable({ path: '/opt/homebrew/bin/claude', source: 'configured' });

  assert.equal(conversations[0].destroyed, true, 'a different binary may be a different account');
  assert.equal(provider.getStatus().executableSource, 'configured');

  await provider.processTextStream({ text: 'b', activeSkill: 'dsa' });
  assert.equal(conversations[1].options.pathToClaudeCodeExecutable, '/opt/homebrew/bin/claude');
});

test('the per-turn directive rides in the user message, not the system prompt', async () => {
  const { provider, calls, conversations } = makeProvider();
  await provider.initialize();

  await provider.processTextStream({
    text: 'design a URL shortener',
    activeSkill: 'system-design',
    directive: 'RESPONSE MODE: GUIDED INTERVIEW.\nStage 1',
    strategy: 'guided',
    stage: 'clarification'
  });
  await provider.processTextStream({
    text: 'continue',
    activeSkill: 'system-design',
    directive: 'RESPONSE MODE: GUIDED INTERVIEW.\nStage 2',
    strategy: 'guided',
    stage: 'requirements'
  });

  // Advancing the interview must NOT tear down the session.
  assert.equal(conversations.length, 1, 'a stage change must not restart the conversation');
  assert.match(calls[0].message.message.content[0].text, /Stage 1/);
  assert.match(calls[1].message.message.content[0].text, /Stage 2/);
  assert.equal(conversations[0].options.systemPrompt, 'PROMPT:system-design');
});

test('sanitized metrics are recorded without any content', async () => {
  const { provider } = makeProvider();
  await provider.initialize();
  await provider.processTextStream({
    text: 'secret question text', activeSkill: 'os', strategy: 'concise'
  });

  const metrics = provider.getLastMetrics();
  assert.equal(typeof metrics.durationMs, 'number');
  assert.equal(typeof metrics.characters, 'number');
  assert.equal(metrics.ttftMs, 1);
  assert.equal(metrics.reusedProcess, false, 'the first turn creates the process');
  assert.equal(metrics.strategy, 'concise');

  const serialized = JSON.stringify(metrics);
  assert.ok(!serialized.includes('secret question text'), 'metrics must not contain prompt text');
  assert.ok(!serialized.includes('hi'), 'metrics must not contain the answer');
});

test('a reused process is reported as reused', async () => {
  const { provider } = makeProvider();
  await provider.initialize();
  await provider.processTextStream({ text: 'a', activeSkill: 'dsa' });
  await provider.processTextStream({ text: 'b', activeSkill: 'dsa' });
  assert.equal(provider.getLastMetrics().reusedProcess, true);
});

// ------------------------------------------------- streaming + lifecycle

test('deltas stream through and the final response is not duplicated', async () => {
  const deltas = [];
  const { provider } = makeProvider({
    send: async (params) => {
      params.onDelta('Hel');
      params.onDelta('lo');
      return { text: 'Hello', streamed: true, model: 'm', characters: 5, durationMs: 1, ttftMs: 1, turnIndex: 1 };
    }
  });
  await provider.initialize();

  const result = await provider.processTextStream({
    text: 'hi',
    activeSkill: 'dsa',
    onDelta: (d) => deltas.push(d)
  });

  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(result.response, 'Hello');
  assert.equal(deltas.join(''), result.response, 'streamed text must equal the final answer exactly once');
  assert.equal(result.metadata.provider, 'claude-agent');
  assert.equal(result.metadata.streamed, true);
});

test('the return envelope matches what LLMService callers already expect', async () => {
  const { provider } = makeProvider();
  await provider.initialize();
  const result = await provider.processTextStream({ text: 'hi', activeSkill: 'dsa', programmingLanguage: 'cpp' });

  assert.equal(typeof result.response, 'string');
  assert.equal(result.metadata.skill, 'dsa');
  assert.equal(result.metadata.programmingLanguage, 'cpp');
  assert.equal(result.metadata.usedFallback, false);
  assert.equal(typeof result.metadata.processingTime, 'number');
});

test('errors propagate with their stable codes', async () => {
  for (const code of [CLAUDE_ERRORS.RATE_LIMITED, CLAUDE_ERRORS.TIMEOUT, CLAUDE_ERRORS.RESPONSE_EMPTY]) {
    const { provider } = makeProvider({
      send: async () => {
        const { ClaudeProviderError } = require('../src/services/claude-agent/errors');
        throw new ClaudeProviderError(code);
      }
    });
    await provider.initialize();
    await assert.rejects(provider.processTextStream({ text: 'x', activeSkill: 'dsa' }), (e) => e.code === code);
  }
});

test('a second concurrent request is refused rather than queued', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const { provider } = makeProvider({
    send: async () => {
      await gate;
      return { text: 'ok', streamed: false, model: null, characters: 2, durationMs: 1, ttftMs: 1, turnIndex: 1 };
    }
  });
  await provider.initialize();

  const first = provider.processTextStream({ text: 'a', activeSkill: 'dsa' });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(
    provider.processTextStream({ text: 'b', activeSkill: 'dsa' }),
    (e) => e.code === CLAUDE_ERRORS.BUSY
  );
  assert.equal(provider.getStatus().busy, true);

  release();
  await first;
  assert.equal(provider.getStatus().busy, false, 'the slot must free up after completion');
});

test('shutdown aborts an in-flight request so quit leaves no subprocess', async () => {
  let seenConversation = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const { provider } = makeProvider({
    send: async (params, conversation) => {
      seenConversation = conversation;
      await gate;
      return { text: 'ok', streamed: false, model: null, characters: 2, durationMs: 1, ttftMs: 1, turnIndex: 1 };
    }
  });
  await provider.initialize();

  const pending = provider.processTextStream({ text: 'a', activeSkill: 'dsa' });
  await new Promise((r) => setImmediate(r));

  assert.ok(seenConversation, 'a conversation must have been created');
  assert.equal(seenConversation.destroyed, false);

  provider.shutdown();
  // Destruction is what tears down the SDK subprocess.
  await new Promise((r) => setImmediate(r));
  assert.equal(seenConversation.destroyed, true, 'quit must destroy the conversation');
  assert.equal(seenConversation.destroyReason, 'app-quit');
  assert.equal(provider.getStatus().conversationActive, false);

  release();
  await pending;
});

// ------------------------------------------------- wiring

test('LLMService routes to Claude only when it is the active provider', () => {
  assert.match(llmService, /isClaudeActive\(\)/);
  assert.match(llmService, /resolveProvider\(\)\.provider/);

  for (const method of [
    'processImageWithSkillStream',
    'processTextWithSkillStream',
    'processTranscriptionWithIntelligentResponseStream',
    'testConnection'
  ]) {
    const start = llmService.indexOf(`${method}(`);
    assert.ok(start > -1, `${method} must still exist`);
    assert.match(llmService.slice(start, start + 400), /isClaudeActive\(\)/, `${method} must check the provider`);
  }
});

test('Gemini remains the default and its path is unchanged', () => {
  // The Gemini guard still runs for every entry point when Claude is inactive.
  const occurrences = llmService.match(/LLM service not initialized\. Check Gemini API key configuration\./g) || [];
  assert.ok(occurrences.length >= 3, 'the Gemini initialization guard must be intact');
  assert.match(llmService, /new GoogleGenAI\(\{ apiKey \}\)/);
});

test('there is no automatic fallback from Claude to a billable provider', () => {
  const selection = read('src/services/llm-providers/selection.js');
  assert.match(selection, /no automatic fallback/i);

  // Delegation returns directly; it must not be wrapped in a catch that
  // retries through Gemini.
  const start = llmService.indexOf('async processTextWithSkillStream(');
  const block = llmService.slice(start, start + 500);
  assert.match(block, /return provider\.processTextStream/);
  assert.ok(!/catch[\s\S]{0,120}Gemini/.test(block));
});

test('the IPC surface is narrow and gate-enforced in the main process', () => {
  assert.match(mainJs, /ipcMain\.handle\("ai-provider:get-state"/);
  assert.match(mainJs, /ipcMain\.handle\("ai-provider:set"/);
  assert.match(mainJs, /ipcMain\.handle\("ai-provider:test"/);

  const setStart = mainJs.indexOf('ipcMain.handle("ai-provider:set"');
  const setBlock = mainJs.slice(setStart, setStart + 900);
  assert.match(setBlock, /isValidProviderValue\(providerId\)/, 'input must be validated');
  assert.match(setBlock, /isClaudeExperimentEnabled\(\)/, 'the gate must be re-checked in main');
  assert.match(setBlock, /previous/, 'a failed save must restore the previous provider');
});

test('the preload bridge exposes only the three provider methods', () => {
  assert.match(preloadJs, /getAiProviderState: \(\) => ipcRenderer\.invoke\('ai-provider:get-state'\)/);
  assert.match(preloadJs, /setAiProvider: \(providerId\) => ipcRenderer\.invoke\('ai-provider:set', providerId\)/);
  assert.match(preloadJs, /testAiProvider: \(\) => ipcRenderer\.invoke\('ai-provider:test'\)/);

  // No credential-shaped bridge may exist.
  for (const name of ['claudeLogin', 'claudeLogout', 'getClaudeToken', 'setClaudeToken']) {
    assert.ok(!preloadJs.includes(name), `${name} must not be exposed`);
  }
});

test('only AI_PROVIDER is persisted, through the existing env mechanism', () => {
  assert.match(mainJs, /this\.persistEnvUpdates\(\{ \[PROVIDER_ENV_KEY\]: providerId \}\)/);
  assert.ok(!mainJs.includes('ANTHROPIC_API_KEY'), 'no Claude credential may be written to .env');
});

test('the settings UI offers no login, logout or credential fields', () => {
  assert.match(settingsHtml, /id="aiProviderSection"/);
  assert.match(settingsHtml, /Claude Agent \(local\)|id="aiProviderSelect"/);

  assert.ok(!/type="password"/.test(settingsHtml.slice(
    settingsHtml.indexOf('id="aiProviderSection"'),
    settingsHtml.indexOf('id="updatesSection"')
  )), 'no password field in the provider section');

  for (const forbidden of ['claudeLoginBtn', 'claudeLogoutBtn', 'claudeToken', 'Sign in to Claude']) {
    assert.ok(!settingsHtml.includes(forbidden), `${forbidden} must not exist`);
  }

  // It must tell the user to authenticate in Terminal instead.
  assert.match(settingsHtml, /claude auth login/);
  assert.match(settingsHtml, /does not store your Claude credentials/);
  assert.match(settingsHtml, /Experimental, local only/);
});

test('the settings UI is not branded as Claude Code', () => {
  const section = settingsHtml.slice(
    settingsHtml.indexOf('id="aiProviderSection"'),
    settingsHtml.indexOf('id="updatesSection"')
  );
  assert.ok(!/Claude Code/.test(section), 'Anthropic branding rules forbid "Claude Code"');
});

test('the renderer gates the Claude rows on the opt-in, not the whole section', () => {
  // The section is always visible now: the opt-in toggle lives inside it so a
  // packaged app can enable the experiment without exporting a shell variable.
  assert.match(settingsWindowJs, /if \(!state\.experimentEnabled\)/);
  assert.match(settingsWindowJs, /claudeExecutableRow\.style\.display = state\.experimentEnabled/);
  assert.match(settingsWindowJs, /aiProviderSelect\.value = previous/, 'a failed save must roll the selection back');
  assert.match(settingsWindowJs, /claudeEnabledToggle\.checked = !desired/, 'a failed toggle must roll back');
});

test('the native Claude binary is unpacked from the asar, and nothing more', () => {
  const pkg = require('../package.json');
  const unpacked = pkg.build.asarUnpack;

  assert.ok(
    unpacked.includes('node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'),
    'the executable must be unpacked or it cannot run from inside app.asar'
  );
  assert.ok(!unpacked.includes('node_modules/**/*'), 'the whole of node_modules must not be unpacked');

  // The pre-existing entries must survive.
  for (const entry of ['assests/icons/**/*', 'prompts/**/*', 'scripts/whisper_worker.py']) {
    assert.ok(unpacked.includes(entry), `${entry} must remain unpacked`);
  }
});

test('the SDK is pinned to an exact version', () => {
  const pkg = require('../package.json');
  const version = pkg.dependencies['@anthropic-ai/claude-agent-sdk'];
  assert.match(version, /^\d+\.\d+\.\d+$/, 'must be exact, not a range');
});

test('the spike is documented, including the policy conflict', () => {
  const doc = read('docs/claude-agent-sdk-spike.md');
  assert.match(doc, /Unless previously approved/, 'the restrictive SDK notice must be quoted');
  assert.match(doc, /still draw from your subscription's usage limits/, 'the help-centre position must be quoted');
  assert.match(doc, /Anthropic approval/);
  assert.match(doc, /Claude Agent \(local\)/);
});

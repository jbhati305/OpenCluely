'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildChildEnv, removedOverrideNames, PROVIDER_OVERRIDE_KEYS, CLIENT_APP_KEY, DISABLE_AUTO_MEMORY_KEY } =
  require('../src/services/claude-agent/child-env');
const { parseAuthStatus, isSubscriptionAuth, authErrorCode, sanitize, resolveClaudeExecutable, SANITIZED_FIELDS } =
  require('../src/services/claude-agent/auth');
const { buildQueryOptions, DISALLOWED_TOOLS } = require('../src/services/claude-agent/query-options');
const { buildTextUserMessage, buildImageUserMessage, SUPPORTED_IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES } =
  require('../src/services/claude-agent/messages');
const { createStreamCollector } = require('../src/services/claude-agent/stream');
const { runQuery } = require('../src/services/claude-agent/runner');
const { CLAUDE_ERRORS, ClaudeProviderError, isRateLimitText } = require('../src/services/claude-agent/errors');

const ROOT = path.join(__dirname, '..');

// Nothing in this file may reach Anthropic. Every SDK interaction is a fake.
const textDelta = (text) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
});
const resultMessage = (result, extra = {}) => ({ type: 'result', subtype: 'success', result, ...extra });

function fakeQuery(messages, spy = {}) {
  return function query(params) {
    spy.params = params;
    return (async function* () {
      for (const message of messages) yield message;
    })();
  };
}

const baseRun = {
  message: buildTextUserMessage('hello'),
  systemPrompt: 'you are a test',
  deps: { makeTempCwd: async () => '/tmp/fake-cwd', removeTempCwd: async () => {} }
};

// ---------------------------------------------------------------- 1-4: env

test('1. API-related environment variables are removed from the child environment', () => {
  const parent = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-should-not-survive',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1'
  };

  const child = buildChildEnv(parent);

  for (const key of PROVIDER_OVERRIDE_KEYS) {
    assert.ok(!(key in child), `${key} must not exist in the child environment`);
  }
  assert.equal(child.PATH, '/usr/bin', 'inherited variables must survive');
});

test('2. the parent process environment is not mutated', () => {
  const parent = { ANTHROPIC_API_KEY: 'sk-keep-me', PATH: '/usr/bin' };
  buildChildEnv(parent);
  assert.equal(parent.ANTHROPIC_API_KEY, 'sk-keep-me');

  const before = process.env.ANTHROPIC_API_KEY;
  buildChildEnv(process.env);
  assert.equal(process.env.ANTHROPIC_API_KEY, before);
});

test('3. the client application identifier is set', () => {
  assert.equal(buildChildEnv({})[CLIENT_APP_KEY], 'opencluely-local-spike');
  assert.equal(buildChildEnv({}, { clientApp: 'custom/1.0' })[CLIENT_APP_KEY], 'custom/1.0');
});

test('4. auto-memory is disabled', () => {
  assert.equal(buildChildEnv({})[DISABLE_AUTO_MEMORY_KEY], '1');
});

test('4b. only override NAMES are reported, never values', () => {
  const names = removedOverrideNames({ ANTHROPIC_API_KEY: 'sk-secret', PATH: '/usr/bin' });
  assert.deepEqual(names, ['ANTHROPIC_API_KEY']);
  assert.ok(!JSON.stringify(names).includes('sk-secret'));
});

// ------------------------------------------------------------- 5-8: auth

test('5. the auth parser recognizes a confirmed subscription login', () => {
  const status = parseAuthStatus({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    subscriptionType: 'pro'
  });

  assert.deepEqual(status, { authenticated: true, credentialSource: 'subscription', plan: 'pro' });
  assert.equal(isSubscriptionAuth(status), true);
  assert.equal(authErrorCode(status), null);
});

test('6. API-key and Console authentication is rejected', () => {
  for (const raw of [
    { loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' },
    { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'vertex' },
    { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'console' }
  ]) {
    const status = parseAuthStatus(raw);
    assert.equal(isSubscriptionAuth(status), false, `${JSON.stringify(raw)} must not count as a subscription`);
    assert.equal(status.credentialSource, 'api');
    assert.equal(authErrorCode(status), CLAUDE_ERRORS.SUBSCRIPTION_REQUIRED);
  }
});

test('7. an unknown auth schema fails closed', () => {
  for (const raw of [null, undefined, 'yes', 42, [], {}, { loggedIn: 'true' }, { authMethod: 'claude.ai' }]) {
    const status = parseAuthStatus(raw);
    assert.equal(isSubscriptionAuth(status), false, `${JSON.stringify(raw)} must fail closed`);
  }

  // Signed in first-party but with no plan reported is still not proof.
  const noPlan = parseAuthStatus({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
  assert.equal(noPlan.credentialSource, 'unknown');
  assert.equal(authErrorCode(noPlan), CLAUDE_ERRORS.AUTH_SOURCE_UNKNOWN);

  const loggedOut = parseAuthStatus({ loggedIn: false, authMethod: 'claude.ai' });
  assert.equal(authErrorCode(loggedOut), CLAUDE_ERRORS.NOT_AUTHENTICATED);
});

test('8. tokens, email and account identifiers are never returned', () => {
  const raw = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    subscriptionType: 'pro',
    email: 'someone@example.com',
    orgId: 'org-uuid-1234',
    orgName: "Someone's Organization",
    accessToken: 'sk-ant-oat-secret',
    refreshToken: 'refresh-secret'
  };

  const serialized = JSON.stringify(sanitize(parseAuthStatus(raw)));

  for (const secret of ['someone@example.com', 'org-uuid-1234', 'Organization', 'sk-ant-oat-secret', 'refresh-secret']) {
    assert.ok(!serialized.includes(secret), `sanitized output must not contain ${secret}`);
  }
  assert.deepEqual(Object.keys(sanitize(parseAuthStatus(raw))).sort(), [...SANITIZED_FIELDS].sort());
});

test('8b. the executable resolver only accepts absolute, executable files', () => {
  const fsImpl = {
    constants: fs.constants,
    statSync: (p) => ({ isFile: () => p === '/opt/bin/claude' }),
    accessSync: (p) => {
      if (p !== '/opt/bin/claude') throw new Error('not executable');
    }
  };

  assert.equal(resolveClaudeExecutable({ candidates: ['relative/claude', '/opt/bin/claude'], fsImpl }), '/opt/bin/claude');
  assert.equal(resolveClaudeExecutable({ candidates: ['/nope/claude'], fsImpl }), null);
});

// -------------------------------------------------------- 9-12: extraction

test('9. text result extraction works', () => {
  const collector = createStreamCollector();
  collector.handle(resultMessage('the answer'));
  assert.equal(collector.finish().text, 'the answer');
});

test('10. partial text streaming works', () => {
  const deltas = [];
  const collector = createStreamCollector({ onDelta: (t) => deltas.push(t) });
  collector.handle(textDelta('Hel'));
  collector.handle(textDelta('lo'));
  collector.handle(resultMessage('Hello'));

  const out = collector.finish();
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(out.streamed, true);
  assert.equal(out.text, 'Hello');
});

test('11. the final output is not duplicated after streaming', () => {
  const deltas = [];
  const collector = createStreamCollector({ onDelta: (t) => deltas.push(t) });
  collector.handle(textDelta('Hello'));
  collector.handle(resultMessage('Hello'));
  collector.finish();

  assert.deepEqual(deltas, ['Hello'], 'the completed text must not be replayed through onDelta');
  assert.equal(deltas.join(''), 'Hello');
});

test('12. a result with no partial messages still returns and emits final text', () => {
  const deltas = [];
  const collector = createStreamCollector({ onDelta: (t) => deltas.push(t) });
  collector.handle(resultMessage('only final'));

  const out = collector.finish();
  assert.equal(out.text, 'only final');
  assert.equal(out.streamed, false);
  assert.deepEqual(deltas, ['only final'], 'with nothing streamed the UI must still receive the text once');
});

test('12b. an empty response is an error', () => {
  const collector = createStreamCollector();
  collector.handle(resultMessage(''));
  assert.throws(() => collector.finish(), (e) => e.code === CLAUDE_ERRORS.RESPONSE_EMPTY);
});

test('12c. a rate limit is classified, not returned as an answer', () => {
  assert.equal(isRateLimitText("You've hit your usage limit"), true);
  assert.equal(isRateLimitText('a normal answer'), false);

  const collector = createStreamCollector();
  collector.handle(resultMessage("You've reached your limit for now", { subtype: 'error_during_execution' }));
  assert.throws(() => collector.finish(), (e) => e.code === CLAUDE_ERRORS.RATE_LIMITED);
});

// ------------------------------------------------------- 13-14: tool refusal

test('13. tool-use events cause the probe to fail', () => {
  const collector = createStreamCollector();
  collector.handle({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'let me look' }, { type: 'tool_use', name: 'Bash', input: {} }] }
  });
  collector.handle(resultMessage('done'));

  assert.throws(() => collector.finish(), (e) => e.code === CLAUDE_ERRORS.TOOL_USE_BLOCKED);
});

test('14. permission requests cause the probe to fail', () => {
  const denied = createStreamCollector();
  denied.handle({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash' });
  denied.handle(resultMessage('done'));
  assert.throws(() => denied.finish(), (e) => e.code === CLAUDE_ERRORS.TOOL_USE_BLOCKED);

  const viaResult = createStreamCollector();
  viaResult.handle(resultMessage('done', { permission_denials: [{ tool_name: 'Read' }] }));
  assert.throws(() => viaResult.finish(), (e) => e.code === CLAUDE_ERRORS.TOOL_USE_BLOCKED);
});

// ---------------------------------------------------------- 15-17: images

test('15. image input has the correct SDKUserMessage structure', () => {
  const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const message = buildImageUserMessage({ text: 'describe', image: { buffer, mediaType: 'image/png' } });

  assert.equal(message.type, 'user');
  assert.equal(message.parent_tool_use_id, null);
  assert.equal(message.message.role, 'user');
  assert.deepEqual(message.message.content[0], { type: 'text', text: 'describe' });
  assert.deepEqual(message.message.content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') }
  });
});

test('16. invalid MIME types are rejected', () => {
  const buffer = Buffer.from([1, 2, 3]);
  for (const mediaType of ['image/bmp', 'application/pdf', 'text/plain', '', null, undefined]) {
    assert.throws(
      () => buildImageUserMessage({ text: 'x', image: { buffer, mediaType } }),
      (e) => e.code === CLAUDE_ERRORS.INVALID_IMAGE,
      `${mediaType} must be rejected`
    );
  }
  for (const mediaType of SUPPORTED_IMAGE_MEDIA_TYPES) {
    assert.ok(buildImageUserMessage({ text: 'x', image: { buffer, mediaType } }));
  }
});

test('17. empty and oversized image buffers are rejected', () => {
  assert.throws(
    () => buildImageUserMessage({ text: 'x', image: { buffer: Buffer.alloc(0), mediaType: 'image/png' } }),
    (e) => e.code === CLAUDE_ERRORS.INVALID_IMAGE
  );
  assert.throws(
    () => buildImageUserMessage({ text: 'x', image: { buffer: 'not a buffer', mediaType: 'image/png' } }),
    (e) => e.code === CLAUDE_ERRORS.INVALID_IMAGE
  );
  assert.throws(
    () => buildImageUserMessage({ text: 'x', image: { buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1), mediaType: 'image/png' } }),
    (e) => e.code === CLAUDE_ERRORS.INVALID_IMAGE
  );
});

// ------------------------------------------------- 18-20: lifecycle

test('18. a timeout aborts the query', async () => {
  const queryImpl = () => (async function* () {
    yield textDelta('start');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    yield resultMessage('never arrives');
  })();

  await assert.rejects(
    runQuery({ ...baseRun, queryImpl, timeoutMs: 20 }),
    (e) => e.code === CLAUDE_ERRORS.TIMEOUT
  );
});

test('19. cancellation is distinguishable from provider failure', async () => {
  const controller = new AbortController();
  const queryImpl = () => (async function* () {
    yield textDelta('start');
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    throw new Error('aborted');
  })();

  await assert.rejects(
    runQuery({ ...baseRun, queryImpl, signal: controller.signal, timeoutMs: 10000 }),
    (e) => e.code === CLAUDE_ERRORS.CANCELLED
  );

  const failing = () => (async function* () {
    throw new Error('network exploded');
    // eslint-disable-next-line no-unreachable
    yield resultMessage('x');
  })();

  await assert.rejects(
    runQuery({ ...baseRun, queryImpl: failing, timeoutMs: 10000 }),
    (e) => e.code === CLAUDE_ERRORS.PROVIDER_FAILED
  );
});

test('20. temporary-directory cleanup runs on success and on failure', async () => {
  const made = [];
  const removed = [];
  const deps = {
    makeTempCwd: async () => {
      const dir = `/tmp/fake-${made.length}`;
      made.push(dir);
      return dir;
    },
    removeTempCwd: async (dir) => { removed.push(dir); }
  };

  await runQuery({ ...baseRun, deps, queryImpl: fakeQuery([resultMessage('ok')]) });
  assert.deepEqual(removed, made, 'cleanup must run after success');

  const failing = () => (async function* () {
    throw new Error('boom');
    // eslint-disable-next-line no-unreachable
    yield resultMessage('x');
  })();
  await assert.rejects(runQuery({ ...baseRun, deps, queryImpl: failing }));
  assert.deepEqual(removed, made, 'cleanup must also run after failure');
  assert.equal(made.length, 2);
});

test('20b. a real temp directory is created and removed', async () => {
  const { makeTempCwd, removeTempCwd } = require('../src/services/claude-agent/runner');
  const dir = await makeTempCwd();
  assert.ok(fs.existsSync(dir));
  assert.ok(!dir.startsWith(ROOT), 'the SDK cwd must never be the repository');
  await removeTempCwd(dir);
  assert.ok(!fs.existsSync(dir));
});

// ------------------------------------------- 21-25: the lockdown itself

test('21-25. every query runs under the locked-down configuration', async () => {
  const spy = {};
  await runQuery({ ...baseRun, queryImpl: fakeQuery([resultMessage('ok')], spy) });
  const o = spy.params.options;

  assert.equal(o.persistSession, false, '21. no transcript may be written to disk');
  assert.deepEqual(o.tools, [], '22. no built-in tools');
  assert.deepEqual(o.allowedTools, [], '22. nothing auto-approved');
  assert.deepEqual(o.settingSources, [], '22. no ambient settings');
  assert.equal(o.permissionMode, 'dontAsk', '23. unlisted tools are denied without prompting');
  assert.deepEqual(o.mcpServers, {}, '24. no MCP servers');
  assert.equal(o.strictMcpConfig, true, '24. .mcp.json is ignored');
  assert.equal(o.maxTurns, 1, '25. one turn only');

  assert.equal(o.includePartialMessages, true);
  assert.equal(typeof o.systemPrompt, 'string');
  assert.notEqual(o.systemPrompt, undefined, 'never the claude_code preset');
  assert.ok(o.abortController instanceof AbortController);
  assert.ok(!('pathToClaudeCodeExecutable' in o), 'the bundled executable is used unless overridden');
});

test('21b. the deny list covers every dangerous built-in tool', () => {
  const options = buildQueryOptions({
    systemPrompt: 'x',
    cwd: '/tmp/x',
    abortController: new AbortController(),
    parentEnv: {}
  });

  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'AskUserQuestion', 'NotebookEdit', 'Skill']) {
    assert.ok(options.disallowedTools.includes(tool), `${tool} must be explicitly denied`);
  }
  assert.equal(new Set(DISALLOWED_TOOLS).size, DISALLOWED_TOOLS.length, 'no duplicate entries');
});

test('21c. an explicit executable path is passed through when provided', () => {
  const options = buildQueryOptions({
    systemPrompt: 'x',
    cwd: '/tmp/x',
    abortController: new AbortController(),
    parentEnv: {},
    pathToClaudeCodeExecutable: '/usr/local/bin/claude'
  });
  assert.equal(options.pathToClaudeCodeExecutable, '/usr/local/bin/claude');
});

test('21d. the query environment carries no API key', () => {
  const options = buildQueryOptions({
    systemPrompt: 'x',
    cwd: '/tmp/x',
    abortController: new AbortController(),
    parentEnv: { ANTHROPIC_API_KEY: 'sk-nope', PATH: '/usr/bin', HOME: '/Users/x' }
  });

  assert.ok(!('ANTHROPIC_API_KEY' in options.env));
  assert.equal(options.env.PATH, '/usr/bin', 'PATH must survive so the subprocess can run');
  assert.equal(options.env.HOME, '/Users/x', 'HOME must survive so the CLI finds its login');
  assert.ok(!('CLAUDE_CONFIG_DIR' in options.env), 'the default config dir holds the existing login');
});

// ------------------------------------------------ 26-27: the live script

test('26. the live script refuses to run without --confirm-subscription-use', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'claude-agent-sdk-smoke.mjs'), 'utf8');
  assert.match(source, /--confirm-subscription-use/);
  assert.match(source, /process\.argv\.includes\(CONFIRM_FLAG\)/);
  assert.match(source, /NOT RUN/);
});

test('27. the live script is not discovered by npm test', () => {
  const pkg = require('../package.json');

  assert.equal(pkg.scripts.test, 'node --test "test/**/*.test.js"');
  assert.ok(!pkg.scripts.test.includes('claude-agent-sdk-smoke'));
  assert.ok(!pkg.scripts.postinstall.includes('claude'));
  assert.equal(pkg.scripts['spike:claude-subscription'], 'node scripts/claude-agent-sdk-smoke.mjs');

  // The glob only matches test/**/*.test.js, and the script is an .mjs in scripts/.
  assert.ok(!fs.existsSync(path.join(ROOT, 'test', 'claude-agent-sdk-smoke.mjs')));
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'claude-agent-sdk-smoke.mjs')));
});

test('27b. no automated test in this file reaches Anthropic', async () => {
  // Structural, not a source scan: the SDK is ESM and is only ever pulled in
  // by runner.loadSdk(). If any test above had reached the network, the module
  // would have been imported and would appear here.
  const loaded = Object.keys(require.cache).filter((id) => id.includes('claude-agent-sdk'));
  assert.deepEqual(loaded, [], 'no test may load the real Agent SDK');

  // And every runQuery call above injected a fake, so no subprocess was spawned.
  const spy = {};
  const out = await runQuery({ ...baseRun, queryImpl: fakeQuery([resultMessage('fake')], spy) });
  assert.equal(out.text, 'fake');
  assert.ok(spy.params, 'the injected fake received the call, not the SDK');
});

// ---------------------------------------------------------------- errors

test('errors expose only a code and a safe message to the renderer', () => {
  const error = new ClaudeProviderError(CLAUDE_ERRORS.NOT_AUTHENTICATED, '/Users/someone/.claude/creds.json');
  const safe = error.toSafeObject();

  assert.deepEqual(Object.keys(safe).sort(), ['code', 'message']);
  assert.ok(!JSON.stringify(safe).includes('/Users/someone'));
  assert.match(safe.message, /claude auth login/);
});

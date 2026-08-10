'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { ClaudeConversation, createInputQueue } = require('../src/services/claude-agent/conversation');
const { CLAUDE_ERRORS } = require('../src/services/claude-agent/errors');
const { buildTextUserMessage, buildImageUserMessage } = require('../src/services/claude-agent/messages');

const textDelta = (text) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
});
const resultMessage = (result, extra = {}) => ({ type: 'result', subtype: 'success', result, ...extra });

/**
 * A scripted SDK stand-in. It reads the input queue and, for each user
 * message, emits the scripted reply for that turn — mirroring the real SDK's
 * one-result-per-user-turn boundary proven by the multi-turn probe.
 */
function scriptedQuery(scripts, spy = {}) {
  return function query({ prompt, options }) {
    spy.options = options;
    spy.received = [];
    return (async function* () {
      let index = 0;
      for await (const message of prompt) {
        spy.received.push(message);
        const script = scripts[Math.min(index, scripts.length - 1)];
        index += 1;
        for (const event of script) yield event;
      }
    })();
  };
}

const tmpDeps = () => {
  const made = [];
  const removed = [];
  return {
    made,
    removed,
    deps: {
      makeTempCwd: async () => {
        const dir = `/tmp/fake-conv-${made.length}`;
        made.push(dir);
        return dir;
      },
      removeTempCwd: async (dir) => { removed.push(dir); }
    }
  };
};

function makeConversation(scripts, overrides = {}) {
  const spy = {};
  const t = tmpDeps();
  const conversation = new ClaudeConversation({
    systemPrompt: overrides.systemPrompt || 'SYSTEM',
    skill: overrides.skill || 'dsa',
    parentEnv: { PATH: '/usr/bin' },
    queryImpl: scriptedQuery(scripts, spy),
    deps: t.deps
  });
  return { conversation, spy, tmp: t };
}

// ---- the input queue ----

test('the input queue delivers pushed messages in order and closes cleanly', async () => {
  const queue = createInputQueue();
  const seen = [];

  const consumer = (async () => {
    for await (const message of queue) seen.push(message);
  })();

  queue.push('a');
  queue.push('b');
  await new Promise((r) => setImmediate(r));
  queue.push('c');
  queue.close();

  await consumer;
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('pushing after close is ignored rather than throwing', async () => {
  const queue = createInputQueue();
  queue.close();
  assert.equal(queue.push('late'), false);
  assert.equal(queue.closed, true);
});

// ---- one conversation, many turns ----

test('multiple messages reuse ONE SDK conversation', async () => {
  const { conversation, spy } = makeConversation([
    [textDelta('one'), resultMessage('one')],
    [textDelta('two'), resultMessage('two')],
    [textDelta('three'), resultMessage('three')]
  ]);

  const a = await conversation.send({ message: buildTextUserMessage('first') });
  const b = await conversation.send({ message: buildTextUserMessage('second') });
  const c = await conversation.send({ message: buildTextUserMessage('third') });

  assert.equal(a.text, 'one');
  assert.equal(b.text, 'two');
  assert.equal(c.text, 'three');
  assert.equal(conversation.turnsSent, 3);

  // One query() call means one process and one shared context.
  assert.equal(spy.received.length, 3, 'all three turns went to the same query');
  assert.equal(a.reusedProcess, false, 'the first turn starts the process');
  assert.equal(b.reusedProcess, true);
  assert.equal(c.reusedProcess, true);
});

test('text followed by image, and image followed by text, stay in one conversation', async () => {
  const { conversation, spy } = makeConversation([
    [resultMessage('text-ok')],
    [resultMessage('image-ok')],
    [resultMessage('text-again')]
  ]);

  await conversation.send({ message: buildTextUserMessage('hello') });
  await conversation.send({
    message: buildImageUserMessage({ text: 'look', image: { buffer: Buffer.from([1, 2]), mediaType: 'image/png' } })
  });
  await conversation.send({ message: buildTextUserMessage('and again') });

  assert.equal(spy.received.length, 3);
  assert.equal(spy.received[1].message.content[1].type, 'image');
  assert.equal(conversation.turnsSent, 3);
});

test('each turn resolves on its own result boundary', async () => {
  const { conversation } = makeConversation([
    [textDelta('a1'), textDelta('a2'), resultMessage('first answer')],
    [textDelta('b1'), resultMessage('second answer')]
  ]);

  const first = await conversation.send({ message: buildTextUserMessage('q1') });
  assert.equal(first.text, 'first answer');
  assert.equal(first.turnIndex, 1);

  const second = await conversation.send({ message: buildTextUserMessage('q2') });
  assert.equal(second.text, 'second answer');
  assert.equal(second.turnIndex, 2);
});

// ---- streaming ----

test('deltas stream and the final answer is not duplicated', async () => {
  const { conversation } = makeConversation([[textDelta('Hel'), textDelta('lo'), resultMessage('Hello')]]);
  const deltas = [];

  const result = await conversation.send({
    message: buildTextUserMessage('hi'),
    onDelta: (d) => deltas.push(d)
  });

  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(result.text, 'Hello');
  assert.equal(deltas.join(''), result.text, 'the answer must arrive exactly once');
  assert.equal(typeof result.ttftMs, 'number');
});

test('a result with no deltas still emits the text once', async () => {
  const { conversation } = makeConversation([[resultMessage('only final')]]);
  const deltas = [];

  const result = await conversation.send({
    message: buildTextUserMessage('hi'),
    onDelta: (d) => deltas.push(d)
  });

  assert.equal(result.streamed, false);
  assert.deepEqual(deltas, ['only final']);
});

// ---- safety ----

test('tools remain completely disabled for the whole conversation', async () => {
  const { conversation, spy } = makeConversation([[resultMessage('ok')]]);
  await conversation.send({ message: buildTextUserMessage('hi') });

  assert.deepEqual(spy.options.tools, []);
  assert.deepEqual(spy.options.allowedTools, []);
  assert.equal(spy.options.permissionMode, 'dontAsk');
  assert.deepEqual(spy.options.settingSources, []);
  assert.equal(spy.options.strictMcpConfig, true);
  assert.deepEqual(spy.options.mcpServers, {});
  assert.equal(spy.options.maxTurns, 1);
  assert.ok(spy.options.disallowedTools.includes('Bash'));
});

test('no session transcript is persisted', async () => {
  const { conversation, spy } = makeConversation([[resultMessage('ok')]]);
  await conversation.send({ message: buildTextUserMessage('hi') });

  assert.equal(spy.options.persistSession, false);
  assert.ok(!('resume' in spy.options));
  assert.ok(!('forkSession' in spy.options));
  assert.ok(!('CLAUDE_CONFIG_DIR' in spy.options.env), 'the default config dir holds the login');
});

test('a tool_use attempt fails the turn', async () => {
  const { conversation } = makeConversation([[
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
    resultMessage('done')
  ]]);

  await assert.rejects(
    conversation.send({ message: buildTextUserMessage('hi') }),
    (e) => e.code === CLAUDE_ERRORS.TOOL_USE_BLOCKED
  );
});

test('a rate limit is classified rather than returned as an answer', async () => {
  const { conversation } = makeConversation([[resultMessage("You've hit your usage limit")]]);
  await assert.rejects(
    conversation.send({ message: buildTextUserMessage('hi') }),
    (e) => e.code === CLAUDE_ERRORS.RATE_LIMITED
  );
});

// ---- concurrency, timeout, cancellation ----

test('a second concurrent turn is refused, not queued', async () => {
  const { conversation } = makeConversation([[resultMessage('slow')]]);

  // Never emits until we let it; the first turn stays open.
  const stalled = new ClaudeConversation({
    systemPrompt: 'S',
    parentEnv: {},
    queryImpl: () => (async function* () { await new Promise(() => {}); })(),
    deps: { makeTempCwd: async () => '/tmp/x', removeTempCwd: async () => {} }
  });

  const first = stalled.send({ message: buildTextUserMessage('a'), timeoutMs: 50 });
  await assert.rejects(
    stalled.send({ message: buildTextUserMessage('b') }),
    (e) => e.code === CLAUDE_ERRORS.BUSY
  );
  await assert.rejects(first, (e) => e.code === CLAUDE_ERRORS.TIMEOUT);
  await stalled.destroy('test');

  assert.ok(conversation);
});

test('a timeout never delivers a late answer', async () => {
  let emit;
  const gate = new Promise((resolve) => { emit = resolve; });

  const conversation = new ClaudeConversation({
    systemPrompt: 'S',
    parentEnv: {},
    queryImpl: ({ prompt }) => (async function* () {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of prompt) {
        await gate;
        yield resultMessage('too late');
      }
    })(),
    deps: { makeTempCwd: async () => '/tmp/x', removeTempCwd: async () => {} }
  });

  const deltas = [];
  await assert.rejects(
    conversation.send({ message: buildTextUserMessage('a'), timeoutMs: 20, onDelta: (d) => deltas.push(d) }),
    (e) => e.code === CLAUDE_ERRORS.TIMEOUT
  );

  emit();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(deltas, [], 'no output may arrive after the timeout');
  await conversation.destroy('test');
});

test('destroying during streaming stops late output reaching the UI', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deltas = [];

  const conversation = new ClaudeConversation({
    systemPrompt: 'S',
    parentEnv: {},
    queryImpl: ({ prompt }) => (async function* () {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of prompt) {
        yield textDelta('early');
        await gate;
        yield textDelta('LATE');
        yield resultMessage('LATE ANSWER');
      }
    })(),
    deps: { makeTempCwd: async () => '/tmp/x', removeTempCwd: async () => {} }
  });

  // The handler is attached up front, exactly as the provider does when it
  // awaits the turn — otherwise destroy() rejects into a bare promise.
  const settled = conversation
    .send({ message: buildTextUserMessage('a'), onDelta: (d) => deltas.push(d) })
    .then(() => ({ ok: true }), (error) => ({ ok: false, code: error.code }));

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(deltas, ['early']);

  await conversation.destroy('chat-bin');
  assert.deepEqual(await settled, { ok: false, code: CLAUDE_ERRORS.CANCELLED });

  release();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(deltas, ['early'], 'nothing may stream in after the clear');
});

test('an external abort signal cancels the turn', async () => {
  const controller = new AbortController();
  const conversation = new ClaudeConversation({
    systemPrompt: 'S',
    parentEnv: {},
    queryImpl: () => (async function* () { await new Promise(() => {}); })(),
    deps: { makeTempCwd: async () => '/tmp/x', removeTempCwd: async () => {} }
  });

  const pending = conversation.send({ message: buildTextUserMessage('a'), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.code === CLAUDE_ERRORS.CANCELLED);
  await conversation.destroy('test');
});

// ---- lifecycle ----

test('destroy removes the temporary directory and is idempotent', async () => {
  const { conversation, tmp } = makeConversation([[resultMessage('ok')]]);
  await conversation.send({ message: buildTextUserMessage('hi') });

  assert.equal(tmp.removed.length, 0, 'the cwd lives for the whole conversation');
  await conversation.destroy('done');
  assert.equal(tmp.removed.length, 1, 'and is removed when it ends');

  await conversation.destroy('again');
  assert.equal(tmp.removed.length, 1, 'destroy must be idempotent');
  assert.equal(conversation.isAlive, false);
});

test('a real temp directory is created outside the repository and cleaned up', async () => {
  const conversation = new ClaudeConversation({
    systemPrompt: 'S',
    parentEnv: {},
    queryImpl: scriptedQuery([[resultMessage('ok')]])
  });

  await conversation.send({ message: buildTextUserMessage('hi') });
  const cwd = conversation._cwd;

  assert.ok(fs.existsSync(cwd));
  assert.ok(!cwd.startsWith(process.cwd()), 'the SDK cwd must never be the repository');

  await conversation.destroy('test');
  assert.ok(!fs.existsSync(cwd));
});

test('diagnostics stay sanitized', async () => {
  const { conversation } = makeConversation([[resultMessage('a secret answer')]]);
  await conversation.send({ message: buildTextUserMessage('a secret question') });

  const diagnostics = conversation.getDiagnostics();
  const serialized = JSON.stringify(diagnostics);

  assert.equal(diagnostics.turnsSent, 1);
  assert.ok(!serialized.includes('secret'), 'diagnostics must contain no content');
  await conversation.destroy('test');
});

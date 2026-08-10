#!/usr/bin/env node
/**
 * Feasibility probe: can ONE Agent SDK query() invocation hold a real
 * multi-turn conversation?
 *
 * This decides the Phase 2 design. If the SDK cannot keep a single query alive
 * across several user messages while preserving context, then a "persistent
 * Claude session" is not achievable and prepended history stays the only
 * honest option.
 *
 * Consumes real subscription usage. Opt-in only:
 *   node scripts/claude-multiturn-probe.mjs --confirm-subscription-use
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { buildQueryOptions } = require('../src/services/claude-agent/query-options.js');
const { readAuthStatus, isSubscriptionAuth } = require('../src/services/claude-agent/auth.js');

const CONFIRM = '--confirm-subscription-use';
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** A queue that feeds one long-lived SDK query. */
function createInputQueue() {
  const pending = [];
  const waiters = [];
  let closed = false;

  return {
    push(message) {
      if (closed) return;
      if (waiters.length) waiters.shift()({ value: message, done: false });
      else pending.push(message);
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (pending.length) { yield pending.shift(); continue; }
        if (closed) return;
        const next = await new Promise((resolve) => waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  };
}

const userText = (text) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  parent_tool_use_id: null
});

const userImage = (text, buffer) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') } }
    ]
  },
  parent_tool_use_id: null
});

async function main() {
  if (!process.argv.includes(CONFIRM)) {
    console.log(`\nMulti-turn probe NOT RUN. Re-run with ${CONFIRM}.\n`);
    return;
  }

  const auth = await readAuthStatus();
  if (!isSubscriptionAuth(auth)) {
    console.log(`\nFAILED: not a subscription login — ${JSON.stringify(auth)}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nAuth: ${JSON.stringify(auth)}\n`);

  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const cwd = await mkdtemp(path.join(tmpdir(), 'opencluely-probe-'));
  const abortController = new AbortController();
  const queue = createInputQueue();

  const options = buildQueryOptions({
    systemPrompt: 'You are a terse assistant. Answer in as few words as possible.',
    cwd,
    abortController,
    parentEnv: process.env,
    clientApp: 'opencluely-multiturn-probe'
  });

  const projectsBefore = existsSync(path.join(homedir(), '.claude', 'projects'))
    ? readdirSync(path.join(homedir(), '.claude', 'projects')).length
    : 0;

  console.log('Streaming-input multi-turn test:');

  const iterator = query({ prompt: queue, options });

  // Collect turns: each user message should produce its own `result`.
  const turns = [];
  let current = null;
  let sawToolUse = false;
  let resultCount = 0;

  const pump = (async () => {
    for await (const message of iterator) {
      if (message.type === 'assistant') {
        const content = message.message && message.message.content;
        if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_use')) sawToolUse = true;
      }
      if (message.type === 'stream_event') {
        const e = message.event;
        if (e && e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
          if (current) current.deltas += 1;
        }
      }
      if (message.type === 'result') {
        resultCount += 1;
        if (current) {
          current.text = typeof message.result === 'string' ? message.result : '';
          current.sessionId = message.session_id || null;
          current.resolve();
          current = null;
        }
      }
    }
  })();

  const ask = (message, label) => new Promise((resolve) => {
    current = { label, deltas: 0, text: '', sessionId: null, resolve: () => resolve(current) };
    turns.push(current);
    queue.push(message);
  });

  // Turn 1: establish a fact.
  const t1 = await ask(userText('Remember this number: 8675309. Reply with just: ok'), 'text-1');
  record('one query() accepts a first message', Boolean(t1.text), `"${t1.text.trim().slice(0, 30)}"`);

  // Turn 2: text -> does context survive?
  const t2 = await ask(userText('What number did I ask you to remember? Reply with only the digits.'), 'text-2');
  const remembered = t2.text.includes('8675309');
  record('context preserved across sequential text turns', remembered, `"${t2.text.trim().slice(0, 30)}"`);

  // Turn 3: image in the SAME conversation.
  const icon = readFileSync(path.join(ROOT, 'assests', 'icons', 'terminal.png'));
  const t3 = await ask(userImage('In 5 words or fewer, what is in this image?', icon), 'image-3');
  record('same conversation accepts a base64 image turn', t3.text.length > 0, `${t3.text.trim().slice(0, 40)}`);

  // Turn 4: text after image -> context spans both modalities.
  const t4 = await ask(
    userText('Still remembering? Reply with only the number I gave you earlier.'),
    'text-4'
  );
  const stillRemembered = t4.text.includes('8675309');
  record('context survives text -> image -> text', stillRemembered, `"${t4.text.trim().slice(0, 30)}"`);

  record('each user turn produced its own result boundary', resultCount === 4, `${resultCount} results for 4 turns`);
  record('every turn streamed partial deltas', turns.every((t) => t.deltas > 0),
    turns.map((t) => `${t.label}:${t.deltas}`).join(' '));

  const sessionIds = new Set(turns.map((t) => t.sessionId).filter(Boolean));
  record('all turns share one session id', sessionIds.size === 1, [...sessionIds].length ? 'single id' : 'none reported');
  record('no tool use occurred', !sawToolUse);

  // Shut down.
  queue.close();
  await pump;
  await rm(cwd, { recursive: true, force: true });

  record('temporary cwd removed', !existsSync(cwd));

  const projectsAfter = existsSync(path.join(homedir(), '.claude', 'projects'))
    ? readdirSync(path.join(homedir(), '.claude', 'projects')).length
    : 0;
  record('no session transcript directory created', projectsAfter === projectsBefore,
    `${projectsBefore} -> ${projectsAfter}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'MULTI-TURN FEASIBLE' : 'MULTI-TURN NOT FEASIBLE'} (${results.length - failed.length}/${results.length})\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`\nProbe crashed: ${error && (error.code || error.message)}\n`);
  process.exitCode = 1;
});

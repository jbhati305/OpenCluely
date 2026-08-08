'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createScreenshotOcrRunner } = require('../src/controllers/screenshot-ocr');

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function build(overrides = {}) {
  const events = [];
  const rec = (name) => (...args) => events.push({ name, args });

  const capture = { imageBuffer: Buffer.from('img'), mimeType: 'image/png', metadata: {} };

  const deps = {
    logger: noopLogger,
    captureService: {
      captureAndProcess: overrides.captureAndProcess || (async () => capture)
    },
    windowManager: {
      showLLMLoading: rec('showLLMLoading'),
      hideLLMResponse: rec('hideLLMResponse')
    },
    broadcastOCRError: rec('broadcastOCRError'),
    recordFailure: rec('recordFailure'),
    onCaptureReady: overrides.onCaptureReady || (async (c) => { events.push({ name: 'onCaptureReady', args: [c] }); })
  };
  const runner = createScreenshotOcrRunner(deps);
  return { runner, events, capture };
}

const names = (events) => events.map((e) => e.name);

test('successful capture shows loading only after capture and runs the LLM stream path', async () => {
  const { runner, events, capture } = build();
  const r = await runner.run();
  assert.equal(r.status, 'ok');
  // loading appears only after capture, then the existing stream path runs
  assert.deepEqual(names(events), ['showLLMLoading', 'onCaptureReady']);
  assert.equal(events[1].args[0], capture);
  assert.equal(runner.isBusy, false);
});

test('permission (capture) failure is broadcast and loading is cleared; stream path not run', async () => {
  const err = Object.assign(new Error('Screen Recording permission is denied. Enable it in System Settings…'), { code: 'SCREEN_PERMISSION_DENIED' });
  const { runner, events } = build({ captureAndProcess: async () => { throw err; } });
  const r = await runner.run();
  assert.equal(r.status, 'error');
  assert.ok(!names(events).includes('showLLMLoading'), 'loading must not be shown when capture fails');
  assert.ok(!names(events).includes('onCaptureReady'), 'LLM path must not run when capture fails');
  assert.ok(names(events).includes('hideLLMResponse'));
  const be = events.find((e) => e.name === 'broadcastOCRError');
  assert.match(be.args[0], /System Settings/i);
  assert.equal(runner.isBusy, false);
});

test('LLM failure clears the loading UI and broadcasts an error', async () => {
  const { runner, events } = build({ onCaptureReady: async () => { throw new Error('gemini 503'); } });
  const r = await runner.run();
  assert.equal(r.status, 'error');
  assert.deepEqual(names(events), ['showLLMLoading', 'hideLLMResponse', 'broadcastOCRError', 'recordFailure']);
  assert.match(events.find((e) => e.name === 'broadcastOCRError').args[0], /gemini 503/);
  assert.equal(runner.isBusy, false);
});

test('empty image buffer is reported without showing the AI loading state', async () => {
  const { runner, events } = build({ captureAndProcess: async () => ({ imageBuffer: Buffer.alloc(0), mimeType: 'image/png' }) });
  const r = await runner.run();
  assert.equal(r.status, 'empty');
  assert.ok(!names(events).includes('showLLMLoading'));
  assert.ok(!names(events).includes('onCaptureReady'));
  assert.equal(events.find((e) => e.name === 'broadcastOCRError').args[0], 'Failed to capture screenshot image');
});

test('a second request while one is in flight is ignored (one native capture, one LLM path)', async () => {
  let releases;
  const gate = new Promise((res) => { releases = res; });
  let captureCalls = 0;
  const { runner, events } = build({
    captureAndProcess: async () => { captureCalls++; await gate; return { imageBuffer: Buffer.from('x'), mimeType: 'image/png', metadata: {} }; }
  });
  const p1 = runner.run();
  const r2 = await runner.run(); // fired while p1 in flight
  assert.equal(r2.status, 'busy');
  releases();
  const r1 = await p1;
  assert.equal(r1.status, 'ok');
  assert.equal(captureCalls, 1);
  assert.equal(names(events).filter((n) => n === 'onCaptureReady').length, 1);
  assert.equal(runner.isBusy, false);
});

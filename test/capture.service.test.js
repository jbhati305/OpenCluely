'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CaptureService } = require('../src/services/capture.service');

const noopLogger = { debug() {}, info() {}, warn() {}, error() {}, logPerformance() {} };

const tick = () => new Promise((r) => setImmediate(r));
async function waitFor(predicate, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('waitFor timed out');
}

function makeThumb(w, h, { empty = false } = {}) {
  return {
    isEmpty: () => empty,
    getSize: () => ({ width: w, height: h }),
    toPNG: () => Buffer.from('png-bytes'),
    crop: (area) => makeThumb(area.width, area.height)
  };
}

const display = (id, width = 2560, height = 1440, scaleFactor = 1) => ({
  id, size: { width, height }, scaleFactor, bounds: { x: 0, y: 0, width, height }, rotation: 0
});

/** getSources mock that records calls and lets each call be settled manually. */
function deferredGetSources() {
  const calls = [];
  const fn = (opts) => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ opts, resolve, reject, promise });
    return promise;
  };
  fn.calls = calls;
  return fn;
}

function build(opts = {}) {
  const {
    status = 'granted',
    platform = 'darwin',
    sources = [{ name: 'Screen 1', display_id: '3', thumbnail: makeThumb(320, 180) }],
    primary = display(3),
    displays,
    getSources,
    getSourcesTimeoutMs = 50
  } = opts;

  const calls = { getMediaAccessStatus: [], getSources: 0, lastOpts: null };
  const systemPreferences = {
    getMediaAccessStatus: (t) => { calls.getMediaAccessStatus.push(t); return status; }
  };
  const desktopCapturer = {
    getSources: getSources || (async (o) => { calls.getSources++; calls.lastOpts = o; return sources; })
  };
  const screen = {
    getAllDisplays: () => displays || [primary],
    getPrimaryDisplay: () => primary
  };
  const svc = new CaptureService({
    desktopCapturer, systemPreferences, screen, platform, logger: noopLogger, getSourcesTimeoutMs
  });
  return { svc, calls };
}

// ---- permission gating ----

test('granted permission calls getSources with the screen permission checked', async () => {
  const { svc, calls } = build({ status: 'granted' });
  const { image } = await svc.captureScreenshot();
  assert.ok(image);
  assert.deepEqual(calls.getMediaAccessStatus, ['screen']);
  assert.equal(calls.getSources, 1);
});

test('denied permission never calls getSources and throws an actionable error', async () => {
  const { svc, calls } = build({ status: 'denied' });
  await assert.rejects(() => svc.captureScreenshot(), (e) => {
    assert.equal(e.code, 'SCREEN_PERMISSION_DENIED');
    assert.match(e.message, /System Settings/i);
    return true;
  });
  assert.equal(calls.getSources, 0);
});

test('restricted permission never calls getSources', async () => {
  const { svc, calls } = build({ status: 'restricted' });
  await assert.rejects(() => svc.captureScreenshot(), (e) => e.code === 'SCREEN_PERMISSION_RESTRICTED');
  assert.equal(calls.getSources, 0);
});

test('not-determined permission allows the capture attempt (macOS prompt path)', async () => {
  const { svc, calls } = build({ status: 'not-determined' });
  await svc.captureScreenshot();
  assert.equal(calls.getSources, 1);
});

test('unknown permission status preserves existing capture behavior (still captures)', async () => {
  const { svc, calls } = build({ status: 'something-new' });
  await svc.captureScreenshot();
  assert.equal(calls.getSources, 1);
});

test('non-macOS does not query media access status and still captures', async () => {
  const { svc, calls } = build({ platform: 'win32' });
  await svc.captureScreenshot();
  assert.equal(calls.getMediaAccessStatus.length, 0);
  assert.equal(calls.getSources, 1);
});

// ---- capture correctness ----

test('empty source list rejects', async () => {
  const { svc } = build({ sources: [] });
  await assert.rejects(() => svc.captureScreenshot(), /No screen sources/i);
});

test('getSources rejection is wrapped with useful context (not opaque)', async () => {
  const { svc } = build({ getSources: async () => { throw new Error('EPIPE weird native'); } });
  await assert.rejects(() => svc.captureScreenshot(), (e) => {
    assert.equal(e.code, 'CAPTURE_ENUMERATION_FAILED');
    assert.match(e.message, /screen capture/i);
    assert.match(e.message, /EPIPE weird native/);
    return true;
  });
});

test('missing thumbnail rejects', async () => {
  const { svc } = build({ sources: [{ name: 'Screen 1', display_id: '3', thumbnail: null }] });
  await assert.rejects(() => svc.captureScreenshot(), /thumbnail/i);
});

test('empty NativeImage thumbnail rejects', async () => {
  const { svc } = build({ sources: [{ name: 'Screen 1', display_id: '3', thumbnail: makeThumb(10, 10, { empty: true }) }] });
  await assert.rejects(() => svc.captureScreenshot(), /empty/i);
});

test('selects the source whose display_id matches the target (numeric vs string)', async () => {
  const sources = [
    { name: 'Screen 1', display_id: '3', thumbnail: makeThumb(320, 180) },
    { name: 'Screen 2', display_id: '1', thumbnail: makeThumb(300, 200) }
  ];
  const displays = [display(3), display(1)];
  const { svc } = build({ sources, displays, primary: display(3) });
  const { metadata } = await svc.captureScreenshot({ displayId: 1 });
  assert.equal(metadata.sourceName, 'Screen 2');
  assert.equal(metadata.matchedBy, 'display_id');
  assert.equal(metadata.displayId, 1);
  assert.equal(typeof metadata.displayId, 'number');
});

test('falls back to first source only when ALL display_ids are unavailable', async () => {
  const sources = [
    { name: 'Screen 1', display_id: '', thumbnail: makeThumb(320, 180) },
    { name: 'Screen 2', display_id: '', thumbnail: makeThumb(300, 200) }
  ];
  const { svc } = build({ sources, primary: display(3) });
  const { metadata } = await svc.captureScreenshot({ displayId: 3 });
  assert.equal(metadata.sourceName, 'Screen 1');
  assert.equal(metadata.matchedBy, 'fallback-no-display-ids');
});

test('populated but mismatched display ids fail with DISPLAY_SOURCE_NOT_FOUND (no wrong monitor)', async () => {
  const sources = [
    { name: 'Screen 1', display_id: '3', thumbnail: makeThumb(320, 180) },
    { name: 'Screen 2', display_id: '1', thumbnail: makeThumb(300, 200) }
  ];
  const { svc } = build({ sources, displays: [display(3), display(1)], primary: display(3) });
  await assert.rejects(() => svc.captureScreenshot({ displayId: 99 }), (e) => {
    assert.equal(e.code, 'DISPLAY_SOURCE_NOT_FOUND');
    assert.match(e.message, /display is no longer available/i);
    return true;
  });
});

test('display removed between listDisplays and capture fails safely (not another monitor)', async () => {
  // Caller asked for display 7, which is gone; remaining sources have valid ids.
  const sources = [{ name: 'Screen 1', display_id: '3', thumbnail: makeThumb(320, 180) }];
  const { svc } = build({ sources, displays: [display(3)], primary: display(3) });
  await assert.rejects(() => svc.captureScreenshot({ displayId: 7 }), (e) => e.code === 'DISPLAY_SOURCE_NOT_FOUND');
});

test('requests a thumbnail capped to the max edge on high-DPI displays', async () => {
  const { svc, calls } = build({ primary: display(3, 2560, 1440, 2) });
  await svc.captureScreenshot();
  const ts = calls.lastOpts.thumbnailSize;
  assert.ok(Math.max(ts.width, ts.height) <= 3840);
  assert.equal(ts.width, 3840);
  assert.equal(ts.height, 2160);
});

// ---- captureAndProcess: crop + processing state ----

test('invalid crop area is ignored and the full image is returned', async () => {
  const { svc } = build();
  const out = await svc.captureAndProcess({ area: { x: -5, y: 0, width: 10, height: 10 } });
  assert.ok(out.imageBuffer.length > 0);
  assert.equal(out.mimeType, 'image/png');
});

test('isProcessing resets to false after a successful capture', async () => {
  const { svc } = build();
  await svc.captureAndProcess();
  assert.equal(svc.isProcessing, false);
});

test('isProcessing resets to false after a failed capture', async () => {
  const { svc } = build({ status: 'denied' });
  await assert.rejects(() => svc.captureAndProcess());
  assert.equal(svc.isProcessing, false);
});

// ---- concurrency: coalesce identical, refuse incompatible ----

function gatedGetSources() {
  let release;
  const gate = new Promise((r) => { release = r; });
  let count = 0;
  const fn = async () => {
    count++;
    await gate;
    return [{ name: 'Screen 1', display_id: '3', thumbnail: makeThumb(320, 180) }];
  };
  return { fn, release: () => release(), get count() { return count; } };
}

test('two identical full-screen requests coalesce into ONE native capture and share the result', async () => {
  const g = gatedGetSources();
  const { svc } = build({ getSources: g.fn });
  const p1 = svc.captureAndProcess();
  const p2 = svc.captureAndProcess();
  g.release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(g.count, 1);
  assert.equal(r1, r2);
  assert.equal(svc.isProcessing, false);
});

test('identical area requests may coalesce', async () => {
  const g = gatedGetSources();
  const { svc } = build({ getSources: g.fn });
  const area = { x: 0, y: 0, width: 100, height: 80 };
  const p1 = svc.captureAndProcess({ area });
  const p2 = svc.captureAndProcess({ area: { ...area } });
  g.release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(g.count, 1);
  assert.equal(r1, r2);
});

test('a full-screen and an overlapping area request never share a result (CAPTURE_BUSY)', async () => {
  const g = gatedGetSources();
  const { svc } = build({ getSources: g.fn });
  const p1 = svc.captureAndProcess(); // full screen, in flight
  await assert.rejects(
    () => svc.captureAndProcess({ area: { x: 0, y: 0, width: 10, height: 10 } }),
    (e) => e.code === 'CAPTURE_BUSY'
  );
  g.release();
  await p1;
});

test('different crop areas never share a result (CAPTURE_BUSY)', async () => {
  const g = gatedGetSources();
  const { svc } = build({ getSources: g.fn });
  const p1 = svc.captureAndProcess({ area: { x: 0, y: 0, width: 10, height: 10 } });
  await assert.rejects(
    () => svc.captureAndProcess({ area: { x: 50, y: 50, width: 10, height: 10 } }),
    (e) => e.code === 'CAPTURE_BUSY'
  );
  g.release();
  await p1;
});

test('different display ids never share a result (CAPTURE_BUSY)', async () => {
  const g = gatedGetSources();
  const { svc } = build({ getSources: g.fn, displays: [display(3), display(1)] });
  const p1 = svc.captureAndProcess({ displayId: 3 });
  await assert.rejects(
    () => svc.captureAndProcess({ displayId: 1 }),
    (e) => e.code === 'CAPTURE_BUSY'
  );
  g.release();
  await p1;
});

test('a later request works after the first completes', async () => {
  const { svc, calls } = build();
  await svc.captureAndProcess();
  await svc.captureAndProcess();
  assert.equal(calls.getSources, 2);
  assert.equal(svc.isProcessing, false);
});

test('state resets after a rejection so the next request works', async () => {
  let fail = true;
  const { svc } = build({
    getSources: async () => {
      if (fail) { fail = false; throw new Error('first fails'); }
      return [{ name: 'Screen 1', display_id: '3', thumbnail: makeThumb(320, 180) }];
    }
  });
  await assert.rejects(() => svc.captureAndProcess());
  assert.equal(svc.isProcessing, false);
  const ok = await svc.captureAndProcess();
  assert.ok(ok.imageBuffer.length > 0);
});

// ---- native enumeration lock across a timeout (finding 3) ----

test('a hung getSources rejects the caller via the bounded timeout', async () => {
  const gs = deferredGetSources();
  const { svc } = build({ getSources: gs, getSourcesTimeoutMs: 20 });
  await assert.rejects(() => svc.captureScreenshot(), (e) => e.code === 'CAPTURE_TIMEOUT');
  gs.calls[0].reject(new Error('cleanup'));
  await gs.calls[0].promise.catch(() => {});
});

test('after a timeout, an immediate retry does not start a second native enumeration', async () => {
  const gs = deferredGetSources();
  const { svc } = build({ getSources: gs, getSourcesTimeoutMs: 20 });

  await assert.rejects(() => svc.captureScreenshot(), (e) => e.code === 'CAPTURE_TIMEOUT');
  assert.equal(gs.calls.length, 1);

  await assert.rejects(() => svc.captureScreenshot(), (e) => e.code === 'CAPTURE_ENUMERATION_PENDING');
  assert.equal(gs.calls.length, 1, 'must not call getSources again while the native op is unresolved');

  // The original native op resolves late: clears the lock, no capture continuation.
  gs.calls[0].resolve([{ name: 'Screen 1', display_id: '3', thumbnail: makeThumb(100, 100) }]);
  await gs.calls[0].promise.catch(() => {});
  await tick();

  // A later request now starts exactly one new enumeration and succeeds.
  const p = svc.captureScreenshot();
  await waitFor(() => gs.calls.length === 2);
  gs.calls[1].resolve([{ name: 'Screen 1', display_id: '3', thumbnail: makeThumb(100, 100) }]);
  const r = await p;
  assert.ok(r.image);
  assert.equal(gs.calls.length, 2);
});

test('the native lock also clears after a LATE rejection, with no unhandled rejection', async () => {
  const gs = deferredGetSources();
  const { svc } = build({ getSources: gs, getSourcesTimeoutMs: 20 });

  await assert.rejects(() => svc.captureScreenshot(), (e) => e.code === 'CAPTURE_TIMEOUT');
  await assert.rejects(() => svc.captureScreenshot(), (e) => e.code === 'CAPTURE_ENUMERATION_PENDING');
  assert.equal(gs.calls.length, 1);

  // Original native op rejects late; must not surface as an unhandled rejection.
  gs.calls[0].reject(new Error('late native failure'));
  await gs.calls[0].promise.catch(() => {});
  await tick();

  const p = svc.captureScreenshot();
  await waitFor(() => gs.calls.length === 2);
  gs.calls[1].resolve([{ name: 'Screen 1', display_id: '3', thumbnail: makeThumb(100, 100) }]);
  const r = await p;
  assert.ok(r.image);
  assert.equal(gs.calls.length, 2);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CursorPolicy,
  CURSOR_LOCK_CSS,
  parseLockCursorShape,
  serializeLockCursorShape
} = require('../src/core/cursor-policy');

// ---- fake webContents ----

let nextKey = 0;

function makeWebContents(options = {}) {
  const listeners = new Map();
  const wc = {
    inserted: [],          // keys currently live in the document
    insertCalls: 0,
    removeCalls: 0,
    destroyed: false,
    insertBehavior: options.insertBehavior || null,
    removeBehavior: options.removeBehavior || null,

    isDestroyed() { return this.destroyed; },

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) || []) fn(...args);
    },

    async insertCSS(css) {
      this.insertCalls += 1;
      if (this.insertBehavior === 'reject') throw new Error('insert failed');
      if (typeof this.insertBehavior === 'function') await this.insertBehavior();
      const key = `key-${++nextKey}`;
      this.inserted.push({ key, css });
      return key;
    },

    async removeInsertedCSS(key) {
      this.removeCalls += 1;
      if (this.removeBehavior === 'reject') throw new Error('remove failed');
      this.inserted = this.inserted.filter((i) => i.key !== key);
    }
  };
  return wc;
}

function makePolicy(deps = {}) {
  return new CursorPolicy({ logger: undefined, ...deps });
}

// ---- 1. disabled by default ----

test('the policy is disabled by default and inserts no CSS', async () => {
  const policy = makePolicy();
  const wc = makeWebContents();

  await policy.register(wc);

  assert.equal(policy.enabled, false);
  assert.equal(wc.insertCalls, 0);
  assert.equal(wc.inserted.length, 0);
});

// ---- 2. enabling injects the exact override everywhere ----

test('enabling inserts the exact global override into every live webContents', async () => {
  const policy = makePolicy();
  const a = makeWebContents();
  const b = makeWebContents();
  await policy.register(a);
  await policy.register(b);

  await policy.setEnabled(true);

  for (const wc of [a, b]) {
    assert.equal(wc.inserted.length, 1);
    assert.equal(wc.inserted[0].css, CURSOR_LOCK_CSS);
  }
});

test('the override forces default and covers pseudo-elements', () => {
  assert.match(CURSOR_LOCK_CSS, /cursor:\s*default\s*!important/);
  assert.match(CURSOR_LOCK_CSS, /\*::before/);
  assert.match(CURSOR_LOCK_CSS, /\*::after/);
  assert.match(CURSOR_LOCK_CSS, /html/);
  assert.match(CURSOR_LOCK_CSS, /body/);

  // Explicitly NOT any of the excluded behaviours.
  assert.ok(!/cursor:\s*none/.test(CURSOR_LOCK_CSS), 'must never hide the pointer');
  assert.ok(!/pointer-events/.test(CURSOR_LOCK_CSS), 'must not disable pointer events');
  assert.ok(!/user-select/.test(CURSOR_LOCK_CSS), 'must not change selection');
  assert.ok(!/outline/.test(CURSOR_LOCK_CSS), 'must not remove focus outlines');
  assert.ok(!/-webkit-app-region/.test(CURSOR_LOCK_CSS), 'must not touch drag regions');
});

// ---- 3. idempotent enable ----

test('repeated enable does not insert duplicate CSS', async () => {
  const policy = makePolicy();
  const wc = makeWebContents();
  await policy.register(wc);

  await policy.setEnabled(true);
  await policy.setEnabled(true);
  await policy.setEnabled(true);
  await policy.register(wc); // re-registering an already-tracked window

  assert.equal(wc.insertCalls, 1);
  assert.equal(wc.inserted.length, 1);
});

// ---- 4. disabling removes every key ----

test('disabling removes every stored CSS key', async () => {
  const policy = makePolicy();
  const a = makeWebContents();
  const b = makeWebContents();
  await policy.register(a);
  await policy.register(b);
  await policy.setEnabled(true);

  await policy.setEnabled(false);

  assert.equal(a.inserted.length, 0);
  assert.equal(b.inserted.length, 0);
  assert.equal(policy.activeKeyCount, 0);
});

// ---- 5. idempotent disable ----

test('repeated disable is harmless', async () => {
  const policy = makePolicy();
  const wc = makeWebContents();
  await policy.register(wc);
  await policy.setEnabled(true);

  await policy.setEnabled(false);
  const removesAfterFirst = wc.removeCalls;
  await policy.setEnabled(false);
  await policy.setEnabled(false);

  assert.equal(wc.removeCalls, removesAfterFirst, 'no repeated removal attempts');
  assert.equal(policy.activeKeyCount, 0);
});

// ---- 6. destroyed webContents are skipped ----

test('destroyed webContents are skipped on register and on enable', async () => {
  const policy = makePolicy();
  const dead = makeWebContents();
  dead.destroyed = true;
  const live = makeWebContents();

  await policy.register(dead);
  await policy.register(live);
  await policy.setEnabled(true);

  assert.equal(dead.insertCalls, 0);
  assert.equal(live.insertCalls, 1);
});

test('a window destroyed after registration is dropped rather than touched', async () => {
  const policy = makePolicy();
  const wc = makeWebContents();
  await policy.register(wc);

  wc.destroyed = true;
  await policy.setEnabled(true);

  assert.equal(wc.insertCalls, 0);
  assert.equal(policy.trackedCount, 0, 'stale entry evicted');
});

// ---- 7. new windows inherit the current setting ----

test('a newly created window receives the already-enabled policy', async () => {
  const policy = makePolicy();
  const first = makeWebContents();
  await policy.register(first);
  await policy.setEnabled(true);

  const late = makeWebContents();
  await policy.register(late);

  assert.equal(late.inserted.length, 1);
  assert.equal(late.inserted[0].css, CURSOR_LOCK_CSS);
});

test('a newly created window gets nothing while the policy is off', async () => {
  const policy = makePolicy();
  await policy.setEnabled(false);

  const wc = makeWebContents();
  await policy.register(wc);

  assert.equal(wc.insertCalls, 0);
});

// ---- 8. reload reapplies ----

test('did-finish-load reapplies the policy after a reload', async () => {
  const policy = makePolicy();
  const wc = makeWebContents();
  await policy.register(wc);
  await policy.setEnabled(true);
  assert.equal(wc.insertCalls, 1);

  // A reload voids the previous document's inserted CSS.
  wc.inserted = [];
  wc.emit('did-finish-load');
  await new Promise((r) => setImmediate(r));

  assert.equal(wc.insertCalls, 2, 'policy re-injected into the new document');
  assert.equal(wc.inserted.length, 1);
  assert.equal(wc.inserted[0].css, CURSOR_LOCK_CSS);
});

test('did-finish-load does not inject while the policy is disabled', async () => {
  const policy = makePolicy();
  const wc = makeWebContents();
  await policy.register(wc);

  wc.emit('did-finish-load');
  await new Promise((r) => setImmediate(r));

  assert.equal(wc.insertCalls, 0);
});

test('reload does not attempt to remove the dead document\'s key', async () => {
  const policy = makePolicy();
  const wc = makeWebContents();
  await policy.register(wc);
  await policy.setEnabled(true);
  const removesBefore = wc.removeCalls;

  wc.emit('did-finish-load');
  await new Promise((r) => setImmediate(r));

  assert.equal(wc.removeCalls, removesBefore, 'old key is dropped, not removed');
});

// ---- 9 & 10. async race safety ----

test('rapid enable then disable cannot leave late-inserted CSS active', async () => {
  const policy = makePolicy();
  let releaseInsert;
  const wc = makeWebContents({
    insertBehavior: () => new Promise((resolve) => { releaseInsert = resolve; })
  });
  await policy.register(wc);

  const enabling = policy.setEnabled(true);   // stalls inside insertCSS
  const disabling = policy.setEnabled(false); // decision reversed mid-flight

  releaseInsert();
  await Promise.all([enabling, disabling]);

  assert.equal(policy.enabled, false);
  assert.equal(wc.inserted.length, 0, 'late CSS must be removed immediately');
  assert.equal(policy.activeKeyCount, 0);
});

test('rapid disable then enable ends in the enabled state', async () => {
  const policy = makePolicy();
  const wc = makeWebContents();
  await policy.register(wc);
  await policy.setEnabled(true);

  const disabling = policy.setEnabled(false);
  const enabling = policy.setEnabled(true);
  await Promise.all([disabling, enabling]);

  assert.equal(policy.enabled, true);
  assert.equal(wc.inserted.length, 1, 'exactly one live override');
  assert.equal(policy.activeKeyCount, 1);
});

test('a stale in-flight insert never resurrects the lock after disabling', async () => {
  const policy = makePolicy();
  let release;
  const wc = makeWebContents({
    insertBehavior: () => new Promise((resolve) => { release = resolve; })
  });
  await policy.register(wc);

  const enabling = policy.setEnabled(true);
  await policy.setEnabled(false);
  release();
  await enabling;

  // Settle any trailing microtasks the cleanup scheduled.
  await new Promise((r) => setImmediate(r));

  assert.equal(policy.enabled, false);
  assert.equal(wc.inserted.length, 0);
});

// ---- 11 & 12. failure isolation ----

test('an insertCSS rejection in one window does not prevent the others', async () => {
  const policy = makePolicy();
  const bad = makeWebContents({ insertBehavior: 'reject' });
  const good = makeWebContents();
  await policy.register(bad);
  await policy.register(good);

  await policy.setEnabled(true);

  assert.equal(good.inserted.length, 1, 'healthy window still gets the policy');
  assert.equal(bad.inserted.length, 0);
  assert.equal(policy.enabled, true, 'one failure does not abort the transition');
});

test('registering a failing window does not throw', async () => {
  const policy = makePolicy();
  await policy.setEnabled(true);
  const bad = makeWebContents({ insertBehavior: 'reject' });

  await policy.register(bad); // must not reject
  assert.equal(bad.inserted.length, 0);
});

test('a removeInsertedCSS rejection does not crash the transition', async () => {
  const policy = makePolicy();
  const bad = makeWebContents({ removeBehavior: 'reject' });
  const good = makeWebContents();
  await policy.register(bad);
  await policy.register(good);
  await policy.setEnabled(true);

  await policy.setEnabled(false); // must not reject

  assert.equal(policy.enabled, false);
  assert.equal(good.inserted.length, 0, 'healthy window still cleaned up');
  assert.equal(policy.activeKeyCount, 0, 'keys cleared even when removal failed');
});

// ---- 13. cleanup on destruction ----

test('state and keys are cleaned up when the webContents is destroyed', async () => {
  const policy = makePolicy();
  const wc = makeWebContents();
  await policy.register(wc);
  await policy.setEnabled(true);
  assert.equal(policy.trackedCount, 1);

  wc.destroyed = true;
  wc.emit('destroyed');

  assert.equal(policy.trackedCount, 0);
  assert.equal(policy.activeKeyCount, 0);
});

test('unregister stops tracking without touching the dead contents', async () => {
  const policy = makePolicy();
  const wc = makeWebContents();
  await policy.register(wc);
  await policy.setEnabled(true);
  const removesBefore = wc.removeCalls;

  policy.unregister(wc);

  assert.equal(policy.trackedCount, 0);
  assert.equal(wc.removeCalls, removesBefore);
});

test('a destroyed window does not block disabling for the rest', async () => {
  const policy = makePolicy();
  const dead = makeWebContents();
  const live = makeWebContents();
  await policy.register(dead);
  await policy.register(live);
  await policy.setEnabled(true);

  dead.destroyed = true;
  await policy.setEnabled(false);

  assert.equal(live.inserted.length, 0);
  assert.equal(policy.enabled, false);
});

// ---- environment parsing ----

test('a missing LOCK_CURSOR_SHAPE defaults to false', () => {
  assert.equal(parseLockCursorShape(undefined), false);
  assert.equal(parseLockCursorShape(null), false);
  assert.equal(parseLockCursorShape(''), false);
});

test('canonical true and false parse correctly', () => {
  assert.equal(parseLockCursorShape('true'), true);
  assert.equal(parseLockCursorShape('false'), false);
});

test('hand-edited true aliases are tolerated', () => {
  for (const raw of ['1', 'yes', 'on', 'TRUE', ' True ', 'YES', 'On']) {
    assert.equal(parseLockCursorShape(raw), true, `${JSON.stringify(raw)} should be true`);
  }
});

test('unrecognised or malformed values fall back to false', () => {
  for (const raw of ['0', 'no', 'off', 'maybe', 'enabled', '{}', [], {}, 42, NaN]) {
    assert.equal(parseLockCursorShape(raw), false, `${JSON.stringify(raw)} should be false`);
  }
});

test('booleans pass through unchanged', () => {
  assert.equal(parseLockCursorShape(true), true);
  assert.equal(parseLockCursorShape(false), false);
});

test('only canonical strings are persisted', () => {
  assert.equal(serializeLockCursorShape(true), 'true');
  assert.equal(serializeLockCursorShape(false), 'false');
});

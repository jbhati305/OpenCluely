'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decidePermission,
  normalizeDisplayId,
  selectSource,
  computeThumbnailSize,
  validateCropArea,
  buildCaptureRequestKey
} = require('../src/services/capture-helpers');

// ---- decidePermission ----

test('decidePermission: non-macOS always proceeds (behavior unchanged)', () => {
  for (const platform of ['win32', 'linux']) {
    const d = decidePermission({ platform, status: 'anything' });
    assert.equal(d.proceed, true);
    assert.equal(d.reason, 'non-darwin');
  }
});

test('decidePermission: granted proceeds', () => {
  const d = decidePermission({ platform: 'darwin', status: 'granted' });
  assert.equal(d.proceed, true);
  assert.equal(d.reason, 'granted');
});

test('decidePermission: not-determined proceeds so macOS can present its prompt (no attempt lock)', () => {
  const d = decidePermission({ platform: 'darwin', status: 'not-determined' });
  assert.equal(d.proceed, true);
  assert.equal(d.reason, 'not-determined');
  assert.equal('firstAttempt' in d, false); // we do not claim/enforce a single attempt
});

test('decidePermission: denied does NOT proceed and returns an actionable message', () => {
  const d = decidePermission({ platform: 'darwin', status: 'denied' });
  assert.equal(d.proceed, false);
  assert.equal(d.code, 'SCREEN_PERMISSION_DENIED');
  assert.match(d.message, /System Settings/i);
  assert.match(d.message, /Screen Recording/i);
});

test('decidePermission: restricted does NOT proceed and is distinct from denied', () => {
  const d = decidePermission({ platform: 'darwin', status: 'restricted' });
  assert.equal(d.proceed, false);
  assert.equal(d.code, 'SCREEN_PERMISSION_RESTRICTED');
  assert.match(d.message, /restricted/i);
});

test('decidePermission: unknown status preserves existing capture behavior without claiming denied', () => {
  const d = decidePermission({ platform: 'darwin', status: 'weird-value' });
  assert.equal(d.proceed, true);
  assert.equal(d.reason, 'unknown');
  assert.equal(d.unknownStatus, 'weird-value');
  assert.notEqual(d.code, 'SCREEN_PERMISSION_DENIED');
});

// ---- normalizeDisplayId ----

test('normalizeDisplayId coerces numbers and strings to a comparable string', () => {
  assert.equal(normalizeDisplayId(3), '3');
  assert.equal(normalizeDisplayId('3'), '3');
});

test('normalizeDisplayId treats null/undefined/empty as absent (null)', () => {
  assert.equal(normalizeDisplayId(null), null);
  assert.equal(normalizeDisplayId(undefined), null);
  assert.equal(normalizeDisplayId(''), null);
});

// ---- selectSource ----

const S = (name, display_id) => ({ name, display_id });

test('selectSource matches by display_id across number/string representations', () => {
  const sources = [S('Screen 1', '3'), S('Screen 2', '1')];
  const r = selectSource(sources, 1); // numeric target, string source id
  assert.equal(r.source.name, 'Screen 2');
  assert.equal(r.matchedBy, 'display_id');
});

test('selectSource falls back to the first source only when ALL display_ids are unavailable', () => {
  const sources = [S('Screen 1', ''), S('Screen 2', '')];
  const r = selectSource(sources, 3);
  assert.equal(r.source.name, 'Screen 1');
  assert.equal(r.matchedBy, 'fallback-no-display-ids');
});

test('selectSource falls back to the first source when no target display id was requested', () => {
  const sources = [S('Screen 1', '3'), S('Screen 2', '1')];
  const r = selectSource(sources, null);
  assert.equal(r.source.name, 'Screen 1');
  assert.equal(r.matchedBy, 'fallback-no-target');
});

test('selectSource does NOT capture the first source when ids are populated but none match', () => {
  const sources = [S('Screen 1', '3'), S('Screen 2', '1')];
  const r = selectSource(sources, 99);
  assert.equal(r.source, null);
  assert.equal(r.matchedBy, 'mismatch');
});

test('selectSource returns null source for an empty array', () => {
  const r = selectSource([], 3);
  assert.equal(r.source, null);
  assert.equal(r.matchedBy, 'none');
});

// ---- computeThumbnailSize ----

test('computeThumbnailSize scales logical size by scaleFactor for crisp Retina text', () => {
  const s = computeThumbnailSize({ size: { width: 1512, height: 982 }, scaleFactor: 2, maxEdge: 3840 });
  assert.deepEqual(s, { width: 3024, height: 1964 });
});

test('computeThumbnailSize caps the longest edge while preserving aspect ratio', () => {
  const s = computeThumbnailSize({ size: { width: 2560, height: 1440 }, scaleFactor: 2, maxEdge: 3840 });
  assert.equal(s.width, 3840);
  assert.equal(s.height, 2160);
});

test('computeThumbnailSize falls back to a sane default for invalid input', () => {
  const s = computeThumbnailSize({ size: { width: 0, height: 0 }, scaleFactor: 2 });
  assert.equal(s.width, 1920);
  assert.equal(s.height, 1080);
});

// ---- validateCropArea ----

test('validateCropArea accepts an area fully inside the image', () => {
  assert.equal(validateCropArea({ x: 10, y: 10, width: 100, height: 50 }, { width: 200, height: 200 }), true);
});

test('validateCropArea rejects areas out of bounds or non-finite or non-positive', () => {
  const img = { width: 200, height: 200 };
  assert.equal(validateCropArea({ x: 150, y: 0, width: 100, height: 10 }, img), false);
  assert.equal(validateCropArea({ x: -5, y: 0, width: 10, height: 10 }, img), false);
  assert.equal(validateCropArea({ x: 0, y: 0, width: 0, height: 10 }, img), false);
  assert.equal(validateCropArea({ x: 0, y: 0, width: NaN, height: 10 }, img), false);
  assert.equal(validateCropArea(null, img), false);
});

// ---- buildCaptureRequestKey ----

test('buildCaptureRequestKey: identical options produce the same key', () => {
  assert.equal(buildCaptureRequestKey({}), buildCaptureRequestKey({}));
  assert.equal(
    buildCaptureRequestKey({ displayId: 3, area: { x: 1, y: 2, width: 3, height: 4 } }),
    buildCaptureRequestKey({ displayId: '3', area: { x: 1, y: 2, width: 3, height: 4 } })
  );
});

test('buildCaptureRequestKey: full-screen and area requests differ', () => {
  assert.notEqual(
    buildCaptureRequestKey({}),
    buildCaptureRequestKey({ area: { x: 0, y: 0, width: 10, height: 10 } })
  );
});

test('buildCaptureRequestKey: different area coordinates differ', () => {
  assert.notEqual(
    buildCaptureRequestKey({ area: { x: 0, y: 0, width: 10, height: 10 } }),
    buildCaptureRequestKey({ area: { x: 5, y: 0, width: 10, height: 10 } })
  );
});

test('buildCaptureRequestKey: different display ids differ', () => {
  assert.notEqual(buildCaptureRequestKey({ displayId: 1 }), buildCaptureRequestKey({ displayId: 2 }));
});

test('buildCaptureRequestKey: invalid/absent area normalizes to no-area (equals full-screen)', () => {
  assert.equal(
    buildCaptureRequestKey({ area: { x: NaN, y: 0, width: 10, height: 10 } }),
    buildCaptureRequestKey({})
  );
});

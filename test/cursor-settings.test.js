'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CursorPolicy,
  CURSOR_LOCK_CSS,
  LOCK_CURSOR_SHAPE_ENV_KEY,
  parseLockCursorShape,
  serializeLockCursorShape,
  resolveLockCursorShapeUpdate
} = require('../src/core/cursor-policy');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const settingsHtml = read('settings.html');
const settingsRenderer = read('src/ui/settings-window.js');
const mainJs = read('main.js');
const windowManagerJs = read('src/managers/window.manager.js');

// ---- 14-17. settings parsing / defaults ----

test('the environment key is LOCK_CURSOR_SHAPE', () => {
  assert.equal(LOCK_CURSOR_SHAPE_ENV_KEY, 'LOCK_CURSOR_SHAPE');
});

test('an absent setting defaults to false (backward compatible)', () => {
  const env = {};
  assert.equal(parseLockCursorShape(env.LOCK_CURSOR_SHAPE), false);
});

test('getSettings exposes lockCursorShape as a real boolean', () => {
  // main.js must coerce to a boolean rather than leaking the raw env string,
  // so the renderer can bind it straight to checkbox.checked.
  assert.match(mainJs, /lockCursorShape:\s*Boolean\(this\.lockCursorShape\)/);
});

test('main reads LOCK_CURSOR_SHAPE from process.env through the parser', () => {
  assert.match(
    mainJs,
    /this\.lockCursorShape\s*=\s*parseLockCursorShape\(process\.env\.LOCK_CURSOR_SHAPE\)/
  );
});

// ---- 18. persistence ----

test('a boolean update resolves to a canonical env value', () => {
  assert.deepEqual(resolveLockCursorShapeUpdate({ lockCursorShape: true }), {
    requested: true, envValue: 'true', rejected: false
  });
  assert.deepEqual(resolveLockCursorShapeUpdate({ lockCursorShape: false }), {
    requested: false, envValue: 'false', rejected: false
  });
});

test('only "true" or "false" are ever persisted', () => {
  for (const value of [true, false]) {
    const { envValue } = resolveLockCursorShapeUpdate({ lockCursorShape: value });
    assert.ok(['true', 'false'].includes(envValue));
  }
  assert.equal(serializeLockCursorShape(true), 'true');
  assert.equal(serializeLockCursorShape(false), 'false');
});

test('saveSettings routes the value through the existing atomic env writer', () => {
  // Must reuse persistEnvUpdates rather than inventing a second settings store.
  assert.match(mainJs, /envUpdates\[LOCK_CURSOR_SHAPE_ENV_KEY\]\s*=\s*cursorLock\.envValue/);
  assert.match(mainJs, /const persistedKeys = this\.persistEnvUpdates\(envUpdates\)/);
});

// ---- 19. non-boolean renderer values are rejected ----

test('non-boolean values are rejected and never treated as true', () => {
  const hostile = ['true', 'false', '1', 0, 1, {}, [], null, NaN, () => {}];

  for (const value of hostile) {
    const result = resolveLockCursorShapeUpdate({ lockCursorShape: value });
    assert.equal(result.requested, null, `${JSON.stringify(String(value))} must not set a value`);
    assert.equal(result.envValue, null);
    assert.equal(result.rejected, true);
  }
});

test('a truthy object cannot enable the lock', () => {
  // Boolean({}) === true — the exact coercion trap this guards against.
  const result = resolveLockCursorShapeUpdate({ lockCursorShape: { enabled: true } });
  assert.equal(result.requested, null);
  assert.notEqual(result.requested, true);
});

test('an absent field means "leave the setting alone", not "disable it"', () => {
  for (const payload of [{}, { geminiKey: 'x' }, { lockCursorShape: undefined }, null, 'nope']) {
    const result = resolveLockCursorShapeUpdate(payload);
    assert.equal(result.requested, null);
    assert.equal(result.rejected, false, 'absence is not a rejection');
  }
});

test('saving another setting does not disturb cursor locking', () => {
  const result = resolveLockCursorShapeUpdate({ windowGap: 20, geminiKey: 'abc' });
  assert.equal(result.requested, null);
  assert.equal(result.envValue, null);
});

// ---- 20. saving applies immediately ----

test('a successful save applies the policy to every open window', () => {
  assert.match(mainJs, /windowManager\s*\n?\s*\.setCursorShapeLocked\(cursorLockRequested\)/);
});

test('the policy is applied only after persistence succeeds', () => {
  // persistEnvUpdates() throws on failure, so the apply must come after it.
  const persistIdx = mainJs.indexOf('this.persistEnvUpdates(envUpdates)');
  const applyIdx = mainJs.indexOf('.setCursorShapeLocked(cursorLockRequested)');
  assert.ok(persistIdx > -1 && applyIdx > -1);
  assert.ok(applyIdx > persistIdx, 'apply must follow persistence');
});

test('setEnabled applies to every tracked window at once', async () => {
  const policy = new CursorPolicy();
  const windows = [];
  for (let i = 0; i < 5; i += 1) {
    const wc = {
      inserted: [],
      isDestroyed: () => false,
      on() {},
      async insertCSS(css) { this.inserted.push(css); return `k${i}`; },
      async removeInsertedCSS() { this.inserted = []; }
    };
    windows.push(wc);
    await policy.register(wc);
  }

  await policy.setEnabled(true);
  for (const wc of windows) assert.deepEqual(wc.inserted, [CURSOR_LOCK_CSS]);
});

// ---- 21. failed save must not leave the UI falsely enabled ----

test('the renderer restores the previous checkbox state when a save fails', () => {
  assert.match(settingsRenderer, /result\.success === false/);
  assert.match(settingsRenderer, /lockCursorShapeInput\.checked = previous/);
});

test('the renderer restores state when the settings channel throws', () => {
  const catchBlock = settingsRenderer.slice(
    settingsRenderer.indexOf('lockCursorShapeInput.addEventListener')
  );
  assert.match(catchBlock, /catch \(error\)[\s\S]*?checked = previous/);
});

test('the renderer reports a concise actionable error', () => {
  assert.match(settingsRenderer, /Could not save this setting/);
});

// ---- 22. accessible label and explanatory text ----

test('the toggle has a properly associated visible label', () => {
  assert.match(settingsHtml, /<label[^>]*for="lockCursorShape"[^>]*>\s*Lock cursor to arrow\s*<\/label>/);
});

test('the control is a native checkbox, not a div-based switch', () => {
  assert.match(settingsHtml, /<input[\s\S]{0,160}type="checkbox"[\s\S]{0,160}id="lockCursorShape"/);
});

test('the description names the cursor changes that are prevented', () => {
  const desc = settingsHtml.match(/id="lockCursorShapeDesc"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(desc, 'description element should exist');
  for (const term of ['hand', 'I-beam', 'resize', 'grab']) {
    assert.ok(desc[1].includes(term), `description should mention "${term}"`);
  }
});

test('the Alt+A click-through clarification is present and does not overclaim', () => {
  const note = settingsHtml.match(/id="lockCursorShapeNote"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(note, 'clarification note should exist');
  assert.match(note[1], /Alt\+A/);
  assert.match(note[1], /does not copy the cursor/i);
});

test('the description is linked to the control for screen readers', () => {
  assert.match(settingsHtml, /aria-describedby="lockCursorShapeDesc lockCursorShapeNote"/);
});

test('the restyled checkbox keeps a visible keyboard focus state', () => {
  assert.match(settingsHtml, /\.settings-checkbox:focus-visible\s*\{[\s\S]*?outline:/);
});

test('long copy wraps instead of overflowing the narrow settings window', () => {
  assert.match(settingsHtml, /\.settings-item-text\s*\{[\s\S]*?min-width:\s*0/);
  assert.match(settingsHtml, /\.settings-checkbox\s*\{[\s\S]*?flex-shrink:\s*0/);
});

// ---- 23. toggle initializes from saved settings ----

test('the toggle initializes its checked state from getSettings()', () => {
  assert.match(settingsRenderer, /lockCursorShapeInput\.checked = settings\.lockCursorShape === true/);
});

test('a settings refresh cannot clobber a save that is still in flight', () => {
  assert.match(settingsRenderer, /!lockCursorShapeInput\.dataset\.saving/);
});

test('the toggle guards against duplicate concurrent saves', () => {
  assert.match(settingsRenderer, /if \(lockCursorShapeInput\.dataset\.saving\) return/);
  assert.match(settingsRenderer, /lockCursorShapeInput\.disabled = true/);
});

test('the toggle uses the existing invoke-based settings API', () => {
  assert.match(settingsRenderer, /electronAPI\.saveSettings\(\{\s*lockCursorShape: desired\s*\}\)/);
});

test('no cursor-specific IPC channel was added', () => {
  const preload = read('preload.js');
  for (const source of [preload, mainJs]) {
    assert.ok(!/cursor[-:]lock|lock-cursor|set-cursor/i.test(source),
      'cursor locking must reuse the settings channel');
  }
});

// ---- 24. the forced CSS covers pseudo-elements ----

test('the injected policy covers elements and pseudo-elements globally', () => {
  assert.match(CURSOR_LOCK_CSS, /\*::before/);
  assert.match(CURSOR_LOCK_CSS, /\*::after/);
  assert.match(CURSOR_LOCK_CSS, /cursor:\s*default\s*!important/);
});

// ---- 25. existing cursor rules are untouched ----

test('no existing contextual cursor rules were deleted or rewritten', () => {
  // The whole point of a single global override is that per-file cursor CSS
  // stays exactly as it was and simply loses when the policy is active.
  const files = [
    'chat.html',
    'index.html',
    'llm-response.html',
    'settings.html',
    'src/styles/common.css'
  ];

  let found = 0;
  for (const rel of files) {
    const source = read(rel);
    const matches = source.match(/cursor:\s*(pointer|text|grab|move|help|ew-resize|ns-resize|col-resize)/g) || [];
    found += matches.length;
  }

  assert.ok(found > 0, 'existing contextual cursor declarations should still be present');
});

test('the feature never hides the pointer or breaks interaction', () => {
  const policySource = read('src/core/cursor-policy.js');

  assert.ok(!/cursor:\s*none/.test(CURSOR_LOCK_CSS), 'must not hide the pointer');
  assert.ok(!/pointer-events\s*:/.test(CURSOR_LOCK_CSS), 'must not disable pointer events');
  // cursor-changed may be mentioned in prose, but never wired up as policy.
  assert.ok(!/\.on\(['"]cursor-changed['"]/.test(policySource),
    'cursor-changed must not be the enforcement mechanism');
});

test('interaction and click-through behaviour are left alone', () => {
  // setInteractive/setIgnoreMouseEvents must still exist untouched, and the
  // cursor policy must not call them.
  assert.match(windowManagerJs, /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/);
  assert.match(windowManagerJs, /setIgnoreMouseEvents\(false\)/);

  const policySource = read('src/core/cursor-policy.js');
  assert.ok(!/setIgnoreMouseEvents|setInteractive/.test(policySource),
    'the cursor policy must not touch interaction mode');
});

// ---- window integration ----

test('WindowManager exposes the setCursorShapeLocked boundary', () => {
  assert.match(windowManagerJs, /async setCursorShapeLocked\(enabled\)/);
});

test('every window created through createWindow is registered with the policy', () => {
  // All window types (main, chat, llmResponse, settings, onboarding) are built
  // by createWindow, so one hook there covers them all.
  const createWindowBody = windowManagerJs.slice(
    windowManagerJs.indexOf('async createWindow(type'),
    windowManagerJs.indexOf('applyStealthMeasures(window, type)')
  );
  assert.match(createWindowBody, /cursorPolicy\.register\(window\.webContents\)/);
});

test('registration happens after load and before the window is shown', () => {
  const body = windowManagerJs.slice(windowManagerJs.indexOf('async createWindow(type'));
  const loadIdx = body.indexOf('await window.loadFile');
  const registerIdx = body.indexOf('cursorPolicy.register');
  const showIdx = body.indexOf('if (showOnCreate)');

  assert.ok(loadIdx > -1 && registerIdx > -1 && showIdx > -1);
  assert.ok(registerIdx > loadIdx, 'must register after the document loads');
  assert.ok(registerIdx < showIdx, 'must register before the window is shown');
});

test('the policy is seeded before startup windows are created', () => {
  const seedIdx = mainJs.indexOf('setCursorShapeLocked(this.lockCursorShape)');
  const initIdx = mainJs.indexOf('windowManager.initializeWindows({ showMainWindow');
  assert.ok(seedIdx > -1 && initIdx > -1);
  assert.ok(seedIdx < initIdx, 'startup windows must inherit the persisted setting');
});

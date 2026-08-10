'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { REASONS, ACTIONS, buildDiagnostics } = require('../src/services/speech-diagnostics');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const chatHtml = read('chat.html');
const mainWindowJs = read('src/ui/main-window.js');
const indexHtml = read('index.html');
const mainJs = read('main.js');
const preloadJs = read('preload.js');

const READY = {
  provider: 'whisper',
  available: true,
  microphonePermission: 'granted',
  whisperInstalled: true,
  modelAvailable: true
};

// ---- state machine ----

test('a fully configured setup reports ready', () => {
  const state = buildDiagnostics(READY);
  assert.equal(state.reasonCode, REASONS.READY);
  assert.equal(state.available, true);
  assert.equal(state.suggestedAction, ACTIONS.NONE);
  assert.equal(state.transcriptionEngineStatus, 'ready');
});

test('recording and processing are distinct visible states', () => {
  assert.equal(buildDiagnostics({ ...READY, recording: true }).reasonCode, REASONS.RECORDING);
  assert.equal(buildDiagnostics({ ...READY, processing: true }).reasonCode, REASONS.PROCESSING);
  // Both remain usable states, not errors.
  assert.equal(buildDiagnostics({ ...READY, recording: true }).available, true);
});

test('a denied microphone is actionable and takes precedence', () => {
  const state = buildDiagnostics({ ...READY, microphonePermission: 'denied' });
  assert.equal(state.reasonCode, REASONS.MIC_PERMISSION_REQUIRED);
  assert.equal(state.available, false);
  assert.equal(state.suggestedAction, ACTIONS.OPEN_PERMISSIONS);
  assert.match(state.message, /System Settings/);
});

test('permission outranks a missing Whisper install', () => {
  // Granting permission is required either way, so it is reported first.
  const state = buildDiagnostics({
    provider: 'whisper', available: false,
    microphonePermission: 'denied', whisperInstalled: false
  });
  assert.equal(state.reasonCode, REASONS.MIC_PERMISSION_REQUIRED);
});

test('not-determined is not treated as a failure', () => {
  // macOS prompts on first use, so this must not block the button.
  const state = buildDiagnostics({ ...READY, microphonePermission: 'not-determined' });
  assert.equal(state.reasonCode, REASONS.READY);
  assert.equal(state.available, true);
});

test('a missing Whisper install is actionable', () => {
  const state = buildDiagnostics({
    provider: 'whisper', available: false, microphonePermission: 'granted', whisperInstalled: false
  });
  assert.equal(state.reasonCode, REASONS.WHISPER_NOT_CONFIGURED);
  assert.equal(state.suggestedAction, ACTIONS.INSTALL_WHISPER);
  assert.equal(state.transcriptionEngineStatus, 'not-installed');
  assert.match(state.message, /Settings/);
});

test('a missing model is actionable and distinct from a missing install', () => {
  const state = buildDiagnostics({
    provider: 'whisper', available: true, microphonePermission: 'granted',
    whisperInstalled: true, modelAvailable: false
  });
  assert.equal(state.reasonCode, REASONS.WHISPER_MODEL_MISSING);
  assert.equal(state.suggestedAction, ACTIONS.DOWNLOAD_MODEL);
  assert.equal(state.transcriptionEngineStatus, 'model-missing');
  assert.equal(state.available, false);
});

test('a disabled provider is reported as such', () => {
  const state = buildDiagnostics({ provider: 'disabled', available: false });
  assert.equal(state.reasonCode, REASONS.PROVIDER_DISABLED);
  assert.equal(state.suggestedAction, ACTIONS.OPEN_SPEECH_SETTINGS);
});

test('an unconfigured Azure provider is reported as unavailable', () => {
  const state = buildDiagnostics({ provider: 'azure', available: false, microphonePermission: 'granted' });
  assert.equal(state.reasonCode, REASONS.PROVIDER_UNAVAILABLE);
  assert.equal(state.transcriptionEngineStatus, 'unconfigured');
});

test('an initialization error is surfaced', () => {
  const state = buildDiagnostics({ ...READY, initError: true });
  assert.equal(state.reasonCode, REASONS.INIT_ERROR);
  assert.equal(state.available, false);
});

test('every reason has a message and an action', () => {
  for (const reason of Object.values(REASONS)) {
    const message = require('../src/services/speech-diagnostics').MESSAGES[reason];
    const action = require('../src/services/speech-diagnostics').SUGGESTED_ACTIONS[reason];
    assert.ok(message && message.length > 10, `${reason} needs a message`);
    assert.ok(action, `${reason} needs an action`);
  }
});

test('diagnostics never leak secrets, audio or transcriptions', () => {
  const state = buildDiagnostics({
    ...READY,
    azureKey: 'super-secret-key',
    transcript: 'the user said something private',
    audio: Buffer.from([1, 2, 3]),
    commandOutput: '/Users/someone/.venv-whisper/bin/whisper'
  });

  const serialized = JSON.stringify(state);
  for (const secret of ['super-secret-key', 'something private', '/Users/someone']) {
    assert.ok(!serialized.includes(secret), `must not leak ${secret}`);
  }

  assert.deepEqual(Object.keys(state).sort(), [
    'available', 'message', 'microphonePermission', 'processing', 'provider',
    'reasonCode', 'recording', 'suggestedAction', 'transcriptionEngineStatus'
  ]);
});

// ---- the microphone stays visible ----

test('the chat mic is never removed from the layout', () => {
  // The old behaviour — display:none whenever speech was unavailable — is the
  // reason the button appeared to be missing entirely.
  assert.ok(
    !/micButton\.style\.display = speechAvailable \? '' : 'none'/.test(chatHtml),
    'the mic must not be hidden based on availability'
  );
  assert.match(chatHtml, /micButton\.style\.display = ''/);
  assert.match(chatHtml, /classList\.toggle\('is-unavailable'/);
});

test('the overlay mic is never removed from the layout', () => {
  assert.ok(
    !/this\.micButton\.style\.display = 'none'/.test(mainWindowJs),
    'the overlay mic must not be hidden'
  );
  assert.match(mainWindowJs, /this\.micButton\.style\.display = ''/);
  assert.match(mainWindowJs, /classList\.toggle\('is-unavailable'/);
});

test('the unavailable mic carries an accessible label and tooltip', () => {
  for (const [name, source] of [['chat', chatHtml], ['overlay', mainWindowJs]]) {
    assert.match(source, /setAttribute\('title', message\)/, name);
    assert.match(source, /setAttribute\('aria-label', message\)/, name);
    assert.match(source, /setAttribute\('aria-disabled'/, name);
  }
});

test('both windows style the unavailable state rather than hiding it', () => {
  assert.match(chatHtml, /\.mic-button\.is-unavailable/);
  assert.match(indexHtml, /#micButton\.is-unavailable/);
});

test('clicking an unavailable mic explains and remediates, never silently nothing', () => {
  for (const [name, source] of [['chat', chatHtml], ['overlay', mainWindowJs]]) {
    assert.match(source, /handleUnavailableSpeech/, name);
    assert.match(source, /resolveSpeechAction\(action\)/, name);
  }
  // The old chat guard just printed a dead-end message and returned.
  assert.ok(!/addMessage\('Speech recognition is not configured\.', 'system'\)/.test(chatHtml));
});

test('the keyboard shortcut surfaces the same explanation', () => {
  // Previously: `if (!isInteractive || !speechAvailable) return;` — a silent
  // no-op that gave the user nothing.
  assert.ok(!/!isInteractive \|\| !speechAvailable\) return;/.test(chatHtml));
  assert.match(mainWindowJs, /this\.handleUnavailableSpeech\(\);\s*\n\s*return;/);
});

test('both windows share one availability model', () => {
  assert.match(mainJs, /broadcastSpeechDiagnostics\(\)/);
  assert.match(mainJs, /windowManager\.broadcastToAllWindows\("speech-diagnostics"/);
  assert.match(chatHtml, /onSpeechDiagnostics/);
  assert.match(mainWindowJs, /onSpeechDiagnostics/);
});

test('availability is rebroadcast when speech is reinitialized after a settings change', () => {
  // Without this the mic stays stale until restart, which is the bug where
  // installing Whisper appeared to do nothing.
  const saveBlock = mainJs.slice(mainJs.indexOf('Speech service reinitialized after settings change') - 2000,
    mainJs.indexOf('Speech service reinitialized after settings change'));
  assert.match(saveBlock, /broadcastSpeechDiagnostics\(\)/);
});

test('the diagnostics IPC surface is narrow', () => {
  assert.match(preloadJs, /getSpeechDiagnostics: \(\) => ipcRenderer\.invoke\('speech:get-diagnostics'\)/);
  assert.match(preloadJs, /resolveSpeechAction: \(action\) => ipcRenderer\.invoke\('speech:resolve-action', action\)/);
  assert.match(mainJs, /ipcMain\.handle\("speech:get-diagnostics"/);
  assert.match(mainJs, /ipcMain\.handle\("speech:resolve-action"/);
});

test('remediation actions are matched against the known enum', () => {
  const handler = mainJs.slice(
    mainJs.indexOf('ipcMain.handle("speech:resolve-action"'),
    mainJs.indexOf('ipcMain.handle("speech:resolve-action"') + 900
  );
  assert.match(handler, /ACTIONS\.OPEN_PERMISSIONS/);
  assert.match(handler, /ACTIONS\.INSTALL_WHISPER/);
  assert.match(handler, /default:/, 'an unknown action must fall through safely');
});

test('managed Whisper and models live in userData, not the app bundle', () => {
  const installer = read('src/core/whisper-installer.js');
  assert.match(installer, /path\.join\(this\.dataDir, '\.venv-whisper'\)/);
  assert.match(installer, /path\.join\(this\.dataDir, '\.whisper-models'\)/);
  assert.match(mainJs, /dataDir: app\.getPath\("userData"\)/);
});

test('the Whisper venv and models are excluded from the packaged app', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('!.venv-whisper/**/*'));
  assert.ok(pkg.build.files.includes('!.whisper-models/**/*'));
});

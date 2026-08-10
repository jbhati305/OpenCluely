'use strict';

/**
 * Why speech is (or is not) usable, in a shape both windows can render.
 *
 * The microphone button used to be hidden whenever availability was false,
 * which meant a user with, say, a missing Whisper model saw no microphone at
 * all and no way to find out why. The control now stays visible and this
 * module supplies the reason and the fix.
 *
 * Nothing here may contain Azure keys, command output, raw audio,
 * transcriptions or model content — only enumerated states.
 */

const REASONS = Object.freeze({
  READY: 'ready',
  RECORDING: 'recording',
  PROCESSING: 'processing',
  MIC_PERMISSION_REQUIRED: 'mic-permission-required',
  WHISPER_NOT_CONFIGURED: 'whisper-not-configured',
  WHISPER_MODEL_MISSING: 'whisper-model-missing',
  PROVIDER_UNAVAILABLE: 'provider-unavailable',
  PROVIDER_DISABLED: 'provider-disabled',
  INIT_ERROR: 'init-error'
});

const ACTIONS = Object.freeze({
  NONE: 'none',
  OPEN_PERMISSIONS: 'open-permissions',
  OPEN_SPEECH_SETTINGS: 'open-speech-settings',
  INSTALL_WHISPER: 'install-whisper',
  DOWNLOAD_MODEL: 'download-model'
});

/** Short, speakable, and actionable. Rendered as tooltip and inline message. */
const MESSAGES = Object.freeze({
  [REASONS.READY]: 'Ready — click or press Cmd+R to start recording.',
  [REASONS.RECORDING]: 'Recording — click or press Cmd+R to stop.',
  [REASONS.PROCESSING]: 'Transcribing…',
  [REASONS.MIC_PERMISSION_REQUIRED]:
    'Microphone access is required. Grant it in System Settings › Privacy & Security › Microphone.',
  [REASONS.WHISPER_NOT_CONFIGURED]:
    'Local Whisper is not installed yet. Open Settings › Speech to install it.',
  [REASONS.WHISPER_MODEL_MISSING]:
    'The selected Whisper model has not been downloaded. Open Settings › Speech to download it.',
  [REASONS.PROVIDER_UNAVAILABLE]:
    'The speech provider is not configured. Open Settings › Speech to finish setup.',
  [REASONS.PROVIDER_DISABLED]:
    'Speech is turned off. Open Settings › Speech to choose Whisper or Azure.',
  [REASONS.INIT_ERROR]:
    'Speech failed to start. Open Settings › Speech to check the configuration.'
});

const SUGGESTED_ACTIONS = Object.freeze({
  [REASONS.READY]: ACTIONS.NONE,
  [REASONS.RECORDING]: ACTIONS.NONE,
  [REASONS.PROCESSING]: ACTIONS.NONE,
  [REASONS.MIC_PERMISSION_REQUIRED]: ACTIONS.OPEN_PERMISSIONS,
  [REASONS.WHISPER_NOT_CONFIGURED]: ACTIONS.INSTALL_WHISPER,
  [REASONS.WHISPER_MODEL_MISSING]: ACTIONS.DOWNLOAD_MODEL,
  [REASONS.PROVIDER_UNAVAILABLE]: ACTIONS.OPEN_SPEECH_SETTINGS,
  [REASONS.PROVIDER_DISABLED]: ACTIONS.OPEN_SPEECH_SETTINGS,
  [REASONS.INIT_ERROR]: ACTIONS.OPEN_SPEECH_SETTINGS
});

/**
 * Reduce raw service/permission state to one diagnostic object.
 *
 * Precedence is deliberate: a denied microphone is reported even when Whisper
 * is also unconfigured, because granting permission is the first thing the
 * user has to do either way.
 *
 * @param {object} input
 * @param {string} [input.provider] 'whisper' | 'azure' | 'disabled'
 * @param {boolean} [input.available] the service's own availability flag
 * @param {boolean} [input.recording]
 * @param {boolean} [input.processing]
 * @param {string} [input.microphonePermission] 'granted'|'denied'|'restricted'|'not-determined'|'unknown'
 * @param {boolean} [input.whisperInstalled]
 * @param {boolean} [input.modelAvailable]
 * @param {boolean} [input.initError]
 */
function buildDiagnostics(input = {}) {
  const provider = input.provider || 'disabled';
  const permission = input.microphonePermission || 'unknown';
  const available = Boolean(input.available);

  let reasonCode;

  if (permission === 'denied' || permission === 'restricted') {
    reasonCode = REASONS.MIC_PERMISSION_REQUIRED;
  } else if (provider === 'disabled') {
    reasonCode = REASONS.PROVIDER_DISABLED;
  } else if (input.initError) {
    reasonCode = REASONS.INIT_ERROR;
  } else if (provider === 'whisper' && input.whisperInstalled === false) {
    reasonCode = REASONS.WHISPER_NOT_CONFIGURED;
  } else if (provider === 'whisper' && input.modelAvailable === false) {
    reasonCode = REASONS.WHISPER_MODEL_MISSING;
  } else if (!available) {
    reasonCode = REASONS.PROVIDER_UNAVAILABLE;
  } else if (input.processing) {
    reasonCode = REASONS.PROCESSING;
  } else if (input.recording) {
    reasonCode = REASONS.RECORDING;
  } else {
    reasonCode = REASONS.READY;
  }

  // 'not-determined' is not a failure: the OS prompts on first use.
  const usable =
    available &&
    permission !== 'denied' &&
    permission !== 'restricted' &&
    reasonCode !== REASONS.INIT_ERROR &&
    reasonCode !== REASONS.WHISPER_NOT_CONFIGURED &&
    reasonCode !== REASONS.WHISPER_MODEL_MISSING;

  return {
    provider,
    available: usable,
    recording: Boolean(input.recording),
    processing: Boolean(input.processing),
    microphonePermission: permission,
    transcriptionEngineStatus: describeEngine(provider, input),
    reasonCode,
    message: MESSAGES[reasonCode],
    suggestedAction: SUGGESTED_ACTIONS[reasonCode]
  };
}

function describeEngine(provider, input) {
  if (provider === 'whisper') {
    if (input.whisperInstalled === false) return 'not-installed';
    if (input.modelAvailable === false) return 'model-missing';
    return input.available ? 'ready' : 'unavailable';
  }
  if (provider === 'azure') return input.available ? 'ready' : 'unconfigured';
  return 'disabled';
}

module.exports = {
  REASONS,
  ACTIONS,
  MESSAGES,
  SUGGESTED_ACTIONS,
  buildDiagnostics
};

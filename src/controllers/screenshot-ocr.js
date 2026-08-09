'use strict';

/**
 * Screenshot-OCR orchestration, extracted from the main controller so its
 * lifecycle (concurrency guard, capture-first, loading/error cleanup) is
 * unit-testable with injected dependencies. The actual image->LLM streaming
 * and response display remain in main.js and are passed in as `onCaptureReady`
 * so this module does not change the successful LLM behavior.
 *
 * @param {object} deps
 * @param {object} deps.captureService     - has captureAndProcess()
 * @param {object} deps.windowManager       - has showLLMLoading(), hideLLMResponse()
 * @param {(msg: string) => void} deps.broadcastOCRError
 * @param {(capture: object) => Promise<void>} deps.onCaptureReady - existing LLM stream path
 * @param {(error: Error) => void} [deps.recordFailure] - optional session logging
 * @param {object} [deps.logger]
 */
function createScreenshotOcrRunner(deps) {
  const {
    captureService,
    windowManager,
    broadcastOCRError,
    onCaptureReady,
    recordFailure,
    logger = { debug() {}, info() {}, warn() {}, error() {} }
  } = deps;

  const state = { busy: false };

  async function run() {
    // Same concurrency policy for the global shortcut and the IPC path: while a
    // capture+OCR is in flight, ignore additional requests and return a stable
    // busy result rather than throwing or launching a second native capture.
    if (state.busy) {
      logger.info('Screenshot capture already in progress; ignoring repeat request');
      return { status: 'busy' };
    }
    state.busy = true;
    const startTime = Date.now();

    try {
      // Capture BEFORE showing the long-running AI loading state, so a failed
      // capture never leaves a misleading "thinking" spinner on screen.
      const capture = await captureService.captureAndProcess();

      if (!capture || !capture.imageBuffer || !capture.imageBuffer.length) {
        broadcastOCRError('Failed to capture screenshot image');
        return { status: 'empty' };
      }

      windowManager.showLLMLoading();
      await onCaptureReady(capture);
      return { status: 'ok' };
    } catch (error) {
      logger.error('Screenshot OCR process failed', {
        error: error.message,
        duration: Date.now() - startTime
      });
      // Guarantee the transient loading UI is cleared on any failure path.
      windowManager.hideLLMResponse();
      broadcastOCRError(error.message);
      if (typeof recordFailure === 'function') {
        try { recordFailure(error); } catch (_) { /* never mask the original error */ }
      }
      return { status: 'error', error: error.message };
    } finally {
      state.busy = false;
    }
  }

  return {
    run,
    get isBusy() { return state.busy; }
  };
}

module.exports = { createScreenshotOcrRunner };

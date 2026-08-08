const electron = require('electron');
const defaultLogger = require('../core/logger').createServiceLogger('CAPTURE');
const {
  decidePermission,
  selectSource,
  computeThumbnailSize,
  validateCropArea,
  normalizeDisplayId,
  buildCaptureRequestKey
} = require('./capture-helpers');

/**
 * CaptureService owns three independent pieces of state, kept explicit rather
 * than nested Promise.race chains:
 *
 *   1. Request state   (_inFlight / _inFlightKey)
 *      One capture request runs at a time. A concurrent request with the SAME
 *      normalized key (display + area) shares the in-flight promise; a request
 *      with a DIFFERENT key is rejected with CAPTURE_BUSY so it can never
 *      receive another request's image.
 *
 *   2. Native-enumeration state  (_nativeEnumeration)
 *      The underlying desktopCapturer.getSources() promise. getSources cannot
 *      be cancelled, so we track it separately: while it is unresolved we never
 *      start a second native enumeration (callers get CAPTURE_ENUMERATION_PENDING).
 *      When it finally settles we clear the lock WITHOUT resuming any timed-out
 *      capture or touching the UI.
 *
 *   3. Caller-timeout state
 *      A bounded deadline so the UI never waits forever on a hung enumeration.
 *      NOTE: a JavaScript timeout cannot catch or stop a native process crash —
 *      it is a UI-liveness guard only, not a crash fix.
 */
class CaptureService {
  constructor(deps = {}) {
    this.desktopCapturer = deps.desktopCapturer || electron.desktopCapturer;
    this.screen = deps.screen || electron.screen;
    this.systemPreferences = deps.systemPreferences || electron.systemPreferences;
    this.platform = deps.platform || process.platform;
    this.logger = deps.logger || defaultLogger;
    this.getSourcesTimeoutMs = deps.getSourcesTimeoutMs != null ? deps.getSourcesTimeoutMs : 15000;

    this.isProcessing = false;
    this._inFlight = null;
    this._inFlightKey = null;
    this._nativeEnumeration = null; // { promise } while a native getSources is unresolved
  }

  listDisplays() {
    try {
      const displays = this.screen.getAllDisplays().map(d => ({
        id: d.id,
        bounds: d.bounds,
        size: d.size,
        scaleFactor: d.scaleFactor,
        rotation: d.rotation,
        touchSupport: d.touchSupport || 'unknown'
      }));
      return { success: true, displays };
    } catch (error) {
      this.logger.error('Failed to list displays', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Capture a screenshot and return an image buffer.
   * options: { displayId?: number|string, area?: { x, y, width, height } }
   *
   * Identical concurrent requests coalesce onto one in-flight capture; a
   * concurrent request for a different display or area is rejected with
   * CAPTURE_BUSY rather than being handed the wrong image.
   */
  async captureAndProcess(options = {}) {
    const key = buildCaptureRequestKey(options);

    if (this._inFlight) {
      if (this._inFlightKey === key) return this._inFlight;
      const err = new Error('Another screen capture is already in progress.');
      err.code = 'CAPTURE_BUSY';
      throw err;
    }

    this.isProcessing = true;
    this._inFlightKey = key;
    this._inFlight = this._captureAndProcess(options).finally(() => {
      this.isProcessing = false;
      this._inFlight = null;
      this._inFlightKey = null;
    });
    return this._inFlight;
  }

  async _captureAndProcess(options = {}) {
    const startTime = Date.now();
    const { image, metadata } = await this.captureScreenshot(options);

    let finalImage = image;
    if (options.area) {
      if (validateCropArea(options.area, image.getSize())) {
        try {
          finalImage = image.crop(options.area);
        } catch (e) {
          this.logger.warn('Crop failed, returning full image', { error: e.message });
        }
      } else {
        this.logger.warn('Ignoring invalid crop area, returning full image');
      }
    }

    const buffer = finalImage.toPNG();
    this.logger.logPerformance('Screenshot capture', startTime, {
      bytes: buffer.length,
      dimensions: finalImage.getSize()
    });

    return {
      imageBuffer: buffer,
      mimeType: 'image/png',
      metadata: {
        timestamp: new Date().toISOString(),
        source: metadata,
        processingTime: Date.now() - startTime
      }
    };
  }

  async captureScreenshot(options = {}) {
    // macOS Screen Recording preflight. Avoid entering native source
    // enumeration when macOS explicitly denies or restricts access. The
    // original native crash root cause remains unconfirmed. Non-macOS
    // platforms skip this permission preflight.
    if (this.platform === 'darwin') {
      let status;
      try {
        status = this.systemPreferences.getMediaAccessStatus('screen');
      } catch (e) {
        status = undefined;
        this.logger.warn('Could not read screen recording permission status', { error: e.message });
      }
      const decision = decidePermission({ platform: this.platform, status });
      if (decision.reason === 'unknown') {
        this.logger.warn('Unknown screen recording permission status; preserving existing capture behavior', {
          status: decision.unknownStatus
        });
      }
      if (!decision.proceed) {
        const err = new Error(decision.message);
        err.code = decision.code;
        throw err;
      }
    }

    // Resolve a display for sizing the thumbnail (falls back to primary), but
    // select the source against the display the CALLER asked for so a removed
    // display is detected as a mismatch instead of silently capturing primary.
    const sizingDisplay = this._getTargetDisplay(options.displayId);
    const requestedId = normalizeDisplayId(options.displayId);
    const selectionTarget = requestedId != null ? requestedId : normalizeDisplayId(sizingDisplay.id);

    const thumbnailSize = computeThumbnailSize({
      size: sizingDisplay.size,
      scaleFactor: sizingDisplay.scaleFactor
    });

    let sources;
    try {
      sources = await this._enumerateSources(thumbnailSize);
    } catch (error) {
      if (error.code === 'CAPTURE_TIMEOUT' || error.code === 'CAPTURE_ENUMERATION_PENDING') {
        throw error;
      }
      // Wrap opaque native errors with actionable context instead of leaking
      // them straight to the UI.
      const wrapped = new Error(`Screen capture failed while enumerating sources: ${error.message}`);
      wrapped.code = 'CAPTURE_ENUMERATION_FAILED';
      throw wrapped;
    }

    if (!sources || sources.length === 0) {
      throw new Error('No screen sources available for capture');
    }

    const { source, matchedBy } = selectSource(sources, selectionTarget);
    if (!source) {
      if (matchedBy === 'mismatch') {
        const err = new Error('The requested display is no longer available. Refresh the display list and try again.');
        err.code = 'DISPLAY_SOURCE_NOT_FOUND';
        throw err;
      }
      throw new Error('No screen sources available for capture');
    }

    const image = source.thumbnail;
    if (!image) {
      throw new Error('Failed to capture screen thumbnail (source has no thumbnail)');
    }
    if (typeof image.isEmpty === 'function' && image.isEmpty()) {
      throw new Error('Captured screen thumbnail is empty');
    }

    this.logger.debug('Screenshot captured successfully', {
      sourceName: source.name,
      matchedBy,
      imageSize: image.getSize()
    });

    return {
      image,
      metadata: {
        displayId: sizingDisplay.id,
        sourceName: source.name,
        matchedBy,
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  /**
   * Run (or refuse to re-run) the native source enumeration. Holds a lock on
   * the underlying getSources promise so a caller timeout can never cause a
   * second overlapping native enumeration. Resolves to the sources, or rejects
   * with CAPTURE_TIMEOUT (caller deadline) / CAPTURE_ENUMERATION_PENDING (a
   * previous native op is still unresolved).
   */
  _enumerateSources(thumbnailSize) {
    if (this._nativeEnumeration) {
      const err = new Error('A previous screen enumeration is still in progress.');
      err.code = 'CAPTURE_ENUMERATION_PENDING';
      return Promise.reject(err);
    }

    // Promise.resolve().then(...) normalizes a synchronous throw from getSources
    // into a rejected promise so the lock bookkeeping is uniform.
    const native = Promise.resolve().then(() =>
      this.desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
    );
    this._nativeEnumeration = native;

    // Clear the lock once the native op settles — regardless of whether any
    // caller is still waiting. Never resumes a timed-out capture or updates UI.
    // Attaching handlers here also marks the eventual rejection as handled, so a
    // late failure after a timeout does not become an unhandledRejection.
    const clear = () => { if (this._nativeEnumeration === native) this._nativeEnumeration = null; };
    native.then(clear, clear);

    const ms = this.getSourcesTimeoutMs;
    if (!ms || ms <= 0) return native;

    let timer;
    let settleTimeout;
    const timeout = new Promise((resolve, reject) => {
      settleTimeout = resolve;
      timer = setTimeout(() => {
        const err = new Error('Screen source enumeration timed out.');
        err.code = 'CAPTURE_TIMEOUT';
        reject(err);
      }, ms);
    });

    return Promise.race([native, timeout]).finally(() => {
      clearTimeout(timer);
      settleTimeout(); // settle the losing timeout promise so it is never left pending
    });
  }

  _getTargetDisplay(displayId) {
    const all = this.screen.getAllDisplays();
    if (!all || all.length === 0) return this.screen.getPrimaryDisplay();
    if (displayId == null) return this.screen.getPrimaryDisplay();
    const target = normalizeDisplayId(displayId);
    const found = all.find(d => normalizeDisplayId(d.id) === target);
    return found || this.screen.getPrimaryDisplay();
  }
}

// Default singleton wired to the real Electron APIs, plus the class for tests.
const instance = new CaptureService();
module.exports = instance;
module.exports.CaptureService = CaptureService;

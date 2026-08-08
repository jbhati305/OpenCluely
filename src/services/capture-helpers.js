'use strict';

/**
 * Pure helpers for screen capture. No Electron imports, so this is fully
 * unit-testable under node:test (see test/capture-helpers.test.js). The
 * CaptureService wires these to the real Electron APIs.
 */

// Cap the longest thumbnail edge. Screens on Retina Macs can be 5K/6K in
// physical pixels (logical size x scaleFactor); requesting the full physical
// resolution produces very large NativeImages. 3840 (4K on the long edge)
// keeps on-screen text sharp for OCR while bounding memory/allocation.
const DEFAULT_MAX_THUMBNAIL_EDGE = 3840;

/**
 * Decide whether to proceed with macOS screen enumeration based on the
 * Screen Recording authorization status. Non-macOS callers always proceed so
 * existing Windows/Linux behavior is unchanged.
 *
 * @param {{ platform: string, status: string }} args
 * @returns {{ proceed: boolean, reason: string, firstAttempt?: boolean,
 *             code?: string, message?: string, unknownStatus?: string }}
 */
function decidePermission({ platform, status }) {
  if (platform !== 'darwin') {
    return { proceed: true, reason: 'non-darwin' };
  }
  switch (status) {
    case 'granted':
      return { proceed: true, reason: 'granted' };
    case 'not-determined':
      // Allow the user-triggered capture attempt so macOS can present its
      // normal Screen Recording prompt. We do not enforce a lifetime attempt
      // lock — macOS transitions the status to granted/denied itself.
      return { proceed: true, reason: 'not-determined' };
    case 'denied':
      return {
        proceed: false,
        reason: 'denied',
        code: 'SCREEN_PERMISSION_DENIED',
        message:
          'Screen Recording permission is denied. Enable it in System Settings → ' +
          'Privacy & Security → Screen Recording, then relaunch OpenCluely.'
      };
    case 'restricted':
      return {
        proceed: false,
        reason: 'restricted',
        code: 'SCREEN_PERMISSION_RESTRICTED',
        message:
          'Screen Recording is restricted on this Mac (for example by a profile or ' +
          'parental controls), so OpenCluely cannot capture the screen.'
      };
    default:
      // Unexpected value: preserve existing capture behavior. Do NOT claim denial.
      return { proceed: true, reason: 'unknown', unknownStatus: String(status) };
  }
}

/** Coerce a display id to a comparable string; null/undefined/empty -> null. */
function normalizeDisplayId(id) {
  if (id === null || id === undefined) return null;
  const s = String(id);
  return s.length ? s : null;
}

/**
 * Choose the desktopCapturer source for a target display, matching on
 * `source.display_id` (normalized so a numeric Electron display id compares
 * equal to the string id the source reports).
 *
 * Selection policy (never silently captures the wrong monitor):
 *   - empty source list                                  -> null, 'none'
 *   - a source's display_id matches the target           -> source, 'display_id'
 *   - no target requested                                -> first, 'fallback-no-target'
 *   - target requested but ALL display_ids are empty     -> first, 'fallback-no-display-ids'
 *   - target requested, ids are populated, none match    -> null, 'mismatch'
 *
 * @returns {{ source: object|null,
 *             matchedBy: 'display_id'|'fallback-no-target'|'fallback-no-display-ids'|'mismatch'|'none' }}
 */
function selectSource(sources, targetDisplayId) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return { source: null, matchedBy: 'none' };
  }
  const target = normalizeDisplayId(targetDisplayId);
  if (target === null) {
    return { source: sources[0], matchedBy: 'fallback-no-target' };
  }
  const match = sources.find((s) => normalizeDisplayId(s.display_id) === target);
  if (match) {
    return { source: match, matchedBy: 'display_id' };
  }
  const anyValidId = sources.some((s) => normalizeDisplayId(s.display_id) !== null);
  if (!anyValidId) {
    return { source: sources[0], matchedBy: 'fallback-no-display-ids' };
  }
  // Ids are available but none match — the requested display is gone/changed.
  // Refuse to capture an arbitrary other monitor.
  return { source: null, matchedBy: 'mismatch' };
}

/**
 * Build a stable key describing what a capture request will produce, so the
 * service can safely coalesce identical concurrent requests while refusing to
 * share results between requests for different displays or crop areas. Only
 * coordinates and display ids are encoded — never any captured content.
 */
function buildCaptureRequestKey(options = {}) {
  const displayId = normalizeDisplayId(options.displayId);
  const a = options.area;
  const area = a && [a.x, a.y, a.width, a.height].every(Number.isFinite)
    ? { x: a.x, y: a.y, width: a.width, height: a.height }
    : null;
  return JSON.stringify({ displayId, area });
}

/**
 * Compute the thumbnailSize to request from desktopCapturer. Multiplies the
 * display's logical size by its scaleFactor (so Retina text stays legible),
 * then caps the longest edge at maxEdge while preserving aspect ratio.
 */
function computeThumbnailSize({ size, scaleFactor = 1, maxEdge = DEFAULT_MAX_THUMBNAIL_EDGE }) {
  const logicalW = size && Number.isFinite(size.width) ? size.width : 0;
  const logicalH = size && Number.isFinite(size.height) ? size.height : 0;
  const factor = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;

  let width = Math.round(logicalW * factor);
  let height = Math.round(logicalH * factor);

  if (width <= 0 || height <= 0) {
    return { width: 1920, height: 1080 };
  }

  const longest = Math.max(width, height);
  if (longest > maxEdge) {
    const ratio = maxEdge / longest;
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }
  return { width, height };
}

/** Validate that a crop area is finite, positive, and fully inside the image. */
function validateCropArea(area, imageSize) {
  if (!area || !imageSize) return false;
  const { x, y, width, height } = area;
  if (![x, y, width, height].every(Number.isFinite)) return false;
  if (width <= 0 || height <= 0) return false;
  if (x < 0 || y < 0) return false;
  if (x + width > imageSize.width || y + height > imageSize.height) return false;
  return true;
}

module.exports = {
  DEFAULT_MAX_THUMBNAIL_EDGE,
  decidePermission,
  normalizeDisplayId,
  selectSource,
  computeThumbnailSize,
  validateCropArea,
  buildCaptureRequestKey
};

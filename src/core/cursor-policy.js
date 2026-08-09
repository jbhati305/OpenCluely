'use strict';

/**
 * Cursor-shape privacy policy.
 *
 * OpenCluely's windows are frequently transparent or fully invisible while
 * still being interactive. Chromium keeps hit-testing that invisible UI, so
 * the macOS cursor still turns into a pointing hand over a button, an I-beam
 * over text, a grab cursor over a draggable header, and so on. Those cursor
 * changes are drawn by the window server and therefore show up in a screen
 * share even when the overlay itself does not — which is enough to reveal
 * that an invisible overlay exists.
 *
 * Rather than editing every `cursor:` declaration across chat.html,
 * index.html, llm-response.html, settings.html and common.css — which would
 * still miss Chromium's own defaults, pseudo-elements, dynamically inserted
 * DOM and any future component — this injects one global override into every
 * live webContents.
 *
 * Scope and non-goals:
 *   - This forces ONE neutral arrow. It does NOT and cannot reproduce the
 *     cursor the application underneath would have chosen: while an OpenCluely
 *     window is interactive, that window owns the cursor. Click-through mode
 *     (Alt+A) is what hands mouse input, and cursor selection, back to the app
 *     underneath.
 *   - It never hides the pointer (`cursor: none`), never touches pointer
 *     events, focus outlines, user-select or draggable regions, and never
 *     synthesizes input.
 *   - The webContents `cursor-changed` event is deliberately NOT the
 *     enforcement mechanism. It is observational only, and is useful as a
 *     development probe.
 *
 * Everything here is injected, so the whole lifecycle is unit-testable with
 * plain fakes and no Electron runtime.
 */

/**
 * The global override. Exported as a single constant so the exact contract is
 * asserted by tests rather than duplicated in them.
 *
 * `*::before, *::after` matter: pseudo-elements are a common source of cursor
 * changes (icon overlays, custom switches) and are not covered by `*` alone.
 */
const CURSOR_LOCK_CSS = [
  'html,',
  'body,',
  '*,',
  '*::before,',
  '*::after {',
  '  cursor: default !important;',
  '}'
].join('\n');

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Is a webContents-like object usable right now?
 * @param {object} wc
 * @returns {boolean}
 */
function isLive(wc) {
  if (!wc) return false;
  try {
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false;
  } catch (_) {
    return false;
  }
  return typeof wc.insertCSS === 'function';
}

class CursorPolicy {
  /**
   * @param {object} [deps]
   * @param {object} [deps.logger]
   * @param {boolean} [deps.enabled] Initial state (default false).
   */
  constructor(deps = {}) {
    this.logger = deps.logger || noopLogger;
    this._enabled = Boolean(deps.enabled);

    /**
     * webContents -> { wc, key, applying, listenersBound }
     * `key` is the handle returned by insertCSS for the CURRENT document.
     * @type {Map<object, object>}
     */
    this._entries = new Map();

    /**
     * Bumped on every state transition. Any async insert that resolves with a
     * stale generation had its decision reversed while in flight, so its CSS
     * is removed immediately. This is what stops a rapid enable → disable from
     * leaving cursor locking silently active.
     */
    this._generation = 0;
  }

  get enabled() {
    return this._enabled;
  }

  /** Number of webContents currently holding injected CSS. Test/diagnostic. */
  get activeKeyCount() {
    let n = 0;
    for (const entry of this._entries.values()) if (entry.key) n += 1;
    return n;
  }

  get trackedCount() {
    return this._entries.size;
  }

  /**
   * Track a webContents and bring it in line with the current setting.
   *
   * Safe to call repeatedly for the same webContents (new windows, re-shown
   * windows). Returns once the initial application has settled so callers can
   * apply the policy before showing the window and avoid a cursor flash.
   *
   * @param {object} wc webContents-like.
   * @returns {Promise<void>}
   */
  async register(wc) {
    if (!isLive(wc)) return;

    let entry = this._entries.get(wc);
    if (!entry) {
      entry = { wc, key: null, applying: null, listenersBound: false };
      this._entries.set(wc, entry);
      this._bindLifecycle(entry);
    }

    if (this._enabled) await this._applyTo(entry);
  }

  /**
   * Stop tracking a webContents. Does not attempt to remove CSS — this is
   * called when the contents is gone, where removal would throw.
   * @param {object} wc
   */
  unregister(wc) {
    this._entries.delete(wc);
  }

  /**
   * Turn cursor locking on or off across every tracked webContents.
   *
   * @param {boolean} enabled
   * @returns {Promise<{enabled: boolean, applied: number, failed: number}>}
   */
  async setEnabled(enabled) {
    const next = Boolean(enabled);

    // Always bump: a disable→enable pair that returns to the same value must
    // still invalidate anything in flight from the intermediate state.
    this._generation += 1;
    this._enabled = next;

    const entries = Array.from(this._entries.values());
    const results = await Promise.allSettled(
      entries.map((entry) => (next ? this._applyTo(entry) : this._removeFrom(entry)))
    );

    const failed = results.filter((r) => r.status === 'rejected').length;
    this.logger.info('Cursor lock policy updated', {
      enabled: next,
      windows: entries.length,
      failed
    });

    return { enabled: next, applied: entries.length - failed, failed };
  }

  /**
   * Re-assert the current state everywhere. Used after windows change.
   * @returns {Promise<void>}
   */
  async reapplyAll() {
    await this.setEnabled(this._enabled);
  }

  /**
   * Watch for reloads and destruction.
   *
   * Inserted CSS does not survive a navigation or reload, so the tracked key
   * for the previous document is dropped (never removed — that document is
   * gone) and the policy is re-injected into the new one.
   */
  _bindLifecycle(entry) {
    const { wc } = entry;
    if (entry.listenersBound) return;
    if (typeof wc.on !== 'function') return;

    try {
      wc.on('did-finish-load', () => {
        // The old key belonged to the previous document; it is already void.
        entry.key = null;
        if (this._enabled) {
          this._applyTo(entry).catch(() => { /* isolated below */ });
        }
      });

      wc.on('destroyed', () => {
        this._entries.delete(wc);
      });

      entry.listenersBound = true;
    } catch (error) {
      this.logger.warn('Could not bind cursor policy lifecycle listeners', {
        error: error && error.message
      });
    }
  }

  /**
   * Insert the override into one webContents, at most once per document.
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _applyTo(entry) {
    if (!isLive(entry.wc)) {
      this._entries.delete(entry.wc);
      return;
    }
    // Already applied for this document — idempotent.
    if (entry.key) return;
    // An insert is already in flight; joining it prevents a duplicate.
    if (entry.applying) {
      await entry.applying;
      return;
    }

    const generation = this._generation;

    const run = (async () => {
      let key = null;
      try {
        key = await entry.wc.insertCSS(CURSOR_LOCK_CSS);
      } catch (error) {
        // One faulty or destroyed window must not stop the others.
        this.logger.warn('Cursor lock CSS insert failed for one window', {
          error: error && error.message
        });
        return;
      }

      // The decision changed while we were awaiting. Undo immediately rather
      // than storing a key that would outlive the setting.
      if (generation !== this._generation || !this._enabled) {
        await this._removeKey(entry.wc, key);
        return;
      }

      // The window went away while we were awaiting.
      if (!isLive(entry.wc)) {
        this._entries.delete(entry.wc);
        return;
      }

      entry.key = key;
    })();

    entry.applying = run;
    try {
      await run;
    } finally {
      if (entry.applying === run) entry.applying = null;
    }
  }

  /**
   * Remove the override from one webContents.
   * @param {object} entry
   * @returns {Promise<void>}
   */
  async _removeFrom(entry) {
    // Deliberately does NOT await an in-flight insert.
    //
    // Awaiting would make disabling block behind a slow insertCSS — and if the
    // caller is what would eventually let that insert resolve, it deadlocks.
    // It is also unnecessary: bumping the generation already guarantees the
    // in-flight insert removes its own key the moment it resolves, so there is
    // no key here to miss.
    const key = entry.key;
    entry.key = null;
    if (!key) return;

    await this._removeKey(entry.wc, key);
  }

  /**
   * Best-effort removal of a single inserted-CSS key.
   * Never throws: a destroyed window is an expected outcome here.
   */
  async _removeKey(wc, key) {
    if (!key) return;
    try {
      if (!wc || typeof wc.removeInsertedCSS !== 'function') return;
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return;
      await wc.removeInsertedCSS(key);
    } catch (error) {
      // Concise and non-sensitive: never pointer coordinates, page content,
      // or anything about the application underneath.
      this.logger.warn('Cursor lock CSS removal failed for one window', {
        error: error && error.message
      });
    }
  }
}

/**
 * Parse LOCK_CURSOR_SHAPE from the environment.
 *
 * Canonical persisted values are "true"/"false", but a hand-edited .env may
 * reasonably contain 1/yes/on, so those are tolerated on read. Anything
 * unrecognised, missing or malformed is false — the backward-compatible
 * default.
 *
 * @param {*} raw
 * @returns {boolean}
 */
function parseLockCursorShape(raw) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return false;

  const value = raw.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

/**
 * Canonical string form for persistence. Only ever "true" or "false".
 * @param {boolean} enabled
 * @returns {string}
 */
function serializeLockCursorShape(enabled) {
  return enabled ? 'true' : 'false';
}

/** Environment key this setting persists under. */
const LOCK_CURSOR_SHAPE_ENV_KEY = 'LOCK_CURSOR_SHAPE';

/**
 * Decide what a settings payload from the renderer means for cursor locking.
 *
 * Only a real boolean is honoured. Coercing arbitrary values would let a
 * stray string, number or object silently enable the lock — `Boolean({})` is
 * true — so anything else is rejected outright rather than guessed at.
 *
 * @param {*} settings The object passed to saveSettings().
 * @returns {{requested: boolean|null, envValue: string|null, rejected: boolean, receivedType?: string}}
 *   `requested` is null when the field is absent or invalid, meaning "leave
 *   the current setting alone".
 */
function resolveLockCursorShapeUpdate(settings) {
  const none = { requested: null, envValue: null, rejected: false };

  if (!settings || typeof settings !== 'object') return none;
  if (!Object.prototype.hasOwnProperty.call(settings, 'lockCursorShape')) return none;

  const raw = settings.lockCursorShape;
  if (raw === undefined) return none;

  if (typeof raw !== 'boolean') {
    return { requested: null, envValue: null, rejected: true, receivedType: typeof raw };
  }

  return { requested: raw, envValue: serializeLockCursorShape(raw), rejected: false };
}

module.exports = {
  CursorPolicy,
  CURSOR_LOCK_CSS,
  LOCK_CURSOR_SHAPE_ENV_KEY,
  parseLockCursorShape,
  serializeLockCursorShape,
  resolveLockCursorShapeUpdate,
  isLive
};

'use strict';

/**
 * Validation helpers for the macOS arm64 release artifacts.
 *
 * Shared by `verify:mac-signature` and `release:mac` so the release gate and
 * the standalone verifier can never drift apart. All functions are pure and
 * unit-tested; the scripts supply the I/O.
 *
 * Artifact contract:
 *   OpenCluely-${version}-mac-arm64.dmg           user-facing installer
 *   OpenCluely-${version}-mac-arm64.zip           updater payload
 *   OpenCluely-${version}-mac-arm64.zip.blockmap  updater delta metadata
 *   OpenCluely-${version}-mac-arm64.dmg.blockmap  updater delta metadata
 *   latest-mac.yml                                updater channel metadata
 */

const PRODUCT_NAME = 'OpenCluely';
const ARCH = 'arm64';

/** Semver as accepted for a release tag (vX.Y.Z, no pre-release suffix). */
const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * @param {string} version e.g. "1.0.1"
 * @returns {{dmg: string, zip: string, dmgBlockmap: string, zipBlockmap: string,
 *            latestYml: string, required: string[], userFacing: string,
 *            updaterAssets: string[]}}
 */
function expectedArtifacts(version) {
  const base = `${PRODUCT_NAME}-${version}-mac-${ARCH}`;
  const dmg = `${base}.dmg`;
  const zip = `${base}.zip`;
  const dmgBlockmap = `${dmg}.blockmap`;
  const zipBlockmap = `${zip}.blockmap`;
  const latestYml = 'latest-mac.yml';

  return {
    dmg,
    zip,
    dmgBlockmap,
    zipBlockmap,
    latestYml,
    // The DMG is the only installer a user should ever download; the rest
    // must still be attached because electron-updater fetches them.
    userFacing: dmg,
    updaterAssets: [zip, zipBlockmap, dmgBlockmap, latestYml],
    required: [dmg, zip, zipBlockmap, latestYml]
  };
}

/**
 * Minimal parser for electron-builder's `latest-mac.yml`.
 *
 * Deliberately dependency-free: the file is machine-generated with a fixed,
 * flat shape, and adding a YAML parser to validate our own build output would
 * be a needless dependency in the release path.
 *
 * @param {string} text
 * @returns {{version: string|null, path: string|null, files: Array<{url: string, size: number|null}>}}
 */
function parseLatestMacYml(text) {
  const out = { version: null, path: null, files: [] };
  if (typeof text !== 'string') return out;

  let inFiles = false;
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const topLevel = line.match(/^([A-Za-z][\w]*):\s*(.*)$/);
    if (topLevel) {
      const key = topLevel[1];
      const value = stripQuotes(topLevel[2]);
      if (key === 'files') {
        inFiles = true;
        current = null;
        continue;
      }
      inFiles = false;
      current = null;
      if (key === 'version') out.version = value || null;
      if (key === 'path') out.path = value || null;
      continue;
    }

    if (!inFiles) continue;

    const itemStart = line.match(/^\s+-\s+(\w+):\s*(.*)$/);
    if (itemStart) {
      current = { url: null, size: null };
      out.files.push(current);
      assignFileField(current, itemStart[1], stripQuotes(itemStart[2]));
      continue;
    }

    const itemField = line.match(/^\s+(\w+):\s*(.*)$/);
    if (itemField && current) {
      assignFileField(current, itemField[1], stripQuotes(itemField[2]));
    }
  }

  return out;
}

function assignFileField(target, key, value) {
  if (key === 'url') target.url = value || null;
  if (key === 'size') {
    const n = Number(value);
    target.size = Number.isFinite(n) ? n : null;
  }
}

function stripQuotes(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Check that latest-mac.yml is internally consistent and that every asset it
 * references was actually produced.
 *
 * @param {object} args
 * @param {string} args.yml            Raw latest-mac.yml contents.
 * @param {string} args.version        Expected version.
 * @param {string[]} args.presentFiles Filenames present in dist/.
 * @returns {{ok: boolean, errors: string[], referenced: string[]}}
 */
function validateLatestMacYml(args = {}) {
  const errors = [];
  const parsed = parseLatestMacYml(args.yml);
  const present = new Set(args.presentFiles || []);

  if (!parsed.version) {
    errors.push('latest-mac.yml has no `version` field.');
  } else if (args.version && parsed.version !== args.version) {
    errors.push(
      `latest-mac.yml version "${parsed.version}" does not match the build version "${args.version}".`
    );
  }

  const referenced = parsed.files.map((f) => f.url).filter(Boolean);
  if (parsed.path && !referenced.includes(parsed.path)) referenced.push(parsed.path);

  if (referenced.length === 0) {
    errors.push('latest-mac.yml references no files.');
  }

  for (const url of referenced) {
    if (!present.has(url)) {
      errors.push(`latest-mac.yml references "${url}", which is not present in dist/.`);
    }
  }

  return { ok: errors.length === 0, errors, referenced };
}

/**
 * Confirm the produced artifacts match the expected version and architecture.
 *
 * @param {object} args
 * @param {string} args.version
 * @param {string[]} args.presentFiles
 * @returns {{ok: boolean, errors: string[], missing: string[]}}
 */
function validateArtifactSet(args = {}) {
  const errors = [];
  const expected = expectedArtifacts(args.version);
  const present = new Set(args.presentFiles || []);

  const missing = expected.required.filter((name) => !present.has(name));
  for (const name of missing) {
    errors.push(`Missing required artifact: ${name}`);
  }

  // A stray x64 or universal artifact means the arm64-only target regressed.
  for (const name of args.presentFiles || []) {
    if (/\.(dmg|zip)$/.test(name) && /-(x64|universal)\./.test(name)) {
      errors.push(`Unexpected non-arm64 artifact: ${name} (this build is arm64-only).`);
    }
  }

  return { ok: errors.length === 0, errors, missing };
}

/**
 * Interpret `codesign --verify --deep --strict --verbose=2` output.
 *
 * codesign writes its diagnostics to stderr and exits 0 on success.
 *
 * @param {object} args
 * @param {number|null} args.status
 * @param {string} [args.stderr]
 * @returns {{ok: boolean, signed: boolean, message: string}}
 */
function interpretCodesignVerify(args = {}) {
  const stderr = String(args.stderr || '');

  if (args.status === 0) {
    return { ok: true, signed: true, message: 'valid on disk; satisfies its Designated Requirement' };
  }

  if (/code object is not signed at all/i.test(stderr)) {
    return {
      ok: false,
      signed: false,
      message: 'The app bundle is not signed at all. Set CSC_NAME and rebuild.'
    };
  }
  // What an unsigned/ad-hoc electron-builder output reports: the bundle has a
  // signature stub but no sealed resources, because signing was skipped.
  if (/code has no resources but signature indicates they must be present/i.test(stderr)) {
    return {
      ok: false,
      signed: false,
      message:
        'The app bundle was built without code signing (no sealed resources). ' +
        'Set CSC_NAME to a valid signing identity and rebuild — see docs/macos-code-signing.md.'
    };
  }
  if (/a sealed resource is missing or invalid/i.test(stderr)) {
    return {
      ok: false,
      signed: true,
      message: 'Signature is broken: a sealed resource is missing or was modified after signing.'
    };
  }
  if (/invalid Info\.plist/i.test(stderr)) {
    return { ok: false, signed: true, message: 'Signature invalid: malformed Info.plist.' };
  }

  return {
    ok: false,
    signed: /signed/i.test(stderr),
    message: stderr.trim() || `codesign exited with status ${args.status}.`
  };
}

/**
 * Is this version string releasable, and does it match the tag?
 * @param {string} version
 * @param {string} [tag] e.g. "v1.0.1"
 * @returns {{ok: boolean, error?: string}}
 */
function validateReleaseVersion(version, tag) {
  if (!RELEASE_VERSION_RE.test(String(version || ''))) {
    return {
      ok: false,
      error: `package.json version "${version}" must be a plain X.Y.Z release version.`
    };
  }
  if (tag && tag !== `v${version}`) {
    return { ok: false, error: `Tag "${tag}" does not match package.json version "${version}".` };
  }
  return { ok: true };
}

module.exports = {
  PRODUCT_NAME,
  ARCH,
  RELEASE_VERSION_RE,
  expectedArtifacts,
  parseLatestMacYml,
  validateLatestMacYml,
  validateArtifactSet,
  interpretCodesignVerify,
  validateReleaseVersion
};

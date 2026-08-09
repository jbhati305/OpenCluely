#!/usr/bin/env node
'use strict';

/**
 * `npm run mac:signing:check`
 *
 * Read-only verification that exactly one usable macOS code-signing identity
 * is available under the name given by CSC_NAME (or
 * OPENCLUELY_MAC_SIGN_IDENTITY). Exits non-zero with an actionable message
 * otherwise.
 *
 * This script never creates, installs, exports or deletes a certificate.
 */

const { spawnSync } = require('child_process');
const {
  checkSigningIdentity,
  redactFingerprint,
  DEFAULT_LOCAL_IDENTITY
} = require('./lib/mac-signing');

function main() {
  if (process.platform !== 'darwin') {
    console.error('mac:signing:check only runs on macOS.');
    process.exit(1);
  }

  const result = checkSigningIdentity({ spawnSyncFn: spawnSync, env: process.env });

  if (!result.ok) {
    console.error('✗ macOS signing identity check failed\n');
    console.error(result.message);

    if (result.reason === 'no-identities-found' || result.reason === 'no-identity-requested') {
      console.error(
        '\nTo create a local self-signed certificate:\n' +
        '  1. Open Keychain Access\n' +
        '  2. Menu: Keychain Access ▸ Certificate Assistant ▸ Create a Certificate…\n' +
        `  3. Name:            ${DEFAULT_LOCAL_IDENTITY}\n` +
        '  4. Identity Type:   Self Signed Root\n' +
        '  5. Certificate Type: Code Signing\n' +
        `  6. Then run: export CSC_NAME="${DEFAULT_LOCAL_IDENTITY}"\n` +
        '\nFull instructions: docs/macos-code-signing.md'
      );
    }
    process.exit(1);
  }

  console.log('✓ macOS signing identity available');
  console.log(`  name:        ${result.identity.name}`);
  console.log(`  fingerprint: ${redactFingerprint(result.identity.fingerprint)}`);
  console.log(`  source:      ${result.source}`);
  process.exit(0);
}

main();

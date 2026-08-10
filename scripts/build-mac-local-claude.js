#!/usr/bin/env node
'use strict';

/**
 * `npm run build:mac:local-claude`
 *
 * Builds a PERSONAL, LOCAL-ONLY macOS artifact for testing the experimental
 * Claude subscription integration.
 *
 * This is deliberately a separate command from the normal release flow
 * (`npm run build:mac` / `npm run release:mac`) and it can never publish:
 * `--publish` is rejected outright rather than forwarded.
 *
 * The resulting DMG must not be uploaded as an official release without
 * explicit Anthropic approval — Anthropic's developer documentation does not
 * permit third-party products to offer Claude subscription login without prior
 * approval. See docs/claude-agent-sdk-spike.md.
 *
 * Note: the integration still ships OFF. This command does not enable it; the
 * user opts in from Settings inside the installed app.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function main() {
  const argv = process.argv.slice(2);

  if (process.platform !== 'darwin') {
    console.error('build:mac:local-claude must run on macOS.');
    process.exit(1);
  }

  // Publishing a personal experiment build would be exactly the mistake this
  // command exists to prevent.
  if (argv.some((a) => a.startsWith('--publish'))) {
    console.error(
      '\nRefusing to publish.\n\n' +
      'build:mac:local-claude produces a PERSONAL, LOCAL-ONLY artifact. It must not\n' +
      'be uploaded as an official release without Anthropic approval.\n' +
      'Use `npm run release:mac` for the normal, reviewed release flow.\n'
    );
    process.exit(1);
  }

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(' LOCAL-ONLY BUILD — personal testing artifact');
  console.log('');
  console.log(' Includes the experimental Claude subscription integration,');
  console.log(' which ships DISABLED and is opted into from Settings.');
  console.log('');
  console.log(' Do NOT distribute or upload this artifact as a release.');
  console.log('──────────────────────────────────────────────────────────────\n');

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'build-mac.js'), ...argv],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, OPENCLUELY_LOCAL_CLAUDE_BUILD: '1' } }
  );

  if (result.error) {
    console.error(`Build failed to start: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status === 0) {
    console.log('\nLocal-only build complete. This artifact is for personal testing.\n');
  }
  process.exit(result.status === null ? 1 : result.status);
}

main();

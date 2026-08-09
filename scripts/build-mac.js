#!/usr/bin/env node
'use strict';

/**
 * `npm run build:mac:arm64`
 *
 * Builds the Apple Silicon DMG + ZIP and stamps the update repository into
 * `app-update.yml` at build time.
 *
 * The repository is injected here (rather than committed to package.json) so
 * that runtime source contains no hard-coded fork: a fork builds its own
 * artifacts pointing at its own releases, with no code change.
 *
 * Signing is driven entirely by CSC_NAME / OPENCLUELY_MAC_SIGN_IDENTITY.
 * Nothing personal is baked into the repository.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const { resolveUpdateRepository, readGitOrigin } = require('./lib/update-repo');
const { resolveRequestedIdentity } = require('./lib/mac-signing');

const ROOT = path.resolve(__dirname, '..');

function main() {
  const argv = process.argv.slice(2);

  if (process.platform !== 'darwin') {
    console.error('build:mac:arm64 must run on macOS.');
    process.exit(1);
  }

  const wantsPublish = argv.some(
    (a) => a === '--publish' || (a.startsWith('--publish') && !/--publish[= ]never/.test(a))
  );

  // ── Update repository ──
  const repo = resolveUpdateRepository({
    env: process.env,
    gitRemoteFn: () => readGitOrigin(spawnSync, ROOT)
  });

  if (!repo) {
    const message =
      'Could not determine the GitHub repository for updates.\n' +
      'Set UPDATE_GITHUB_REPOSITORY="owner/repo", or ensure `git remote get-url origin` works.';
    if (wantsPublish) {
      console.error(`✗ ${message}`);
      process.exit(1);
    }
    console.warn(`⚠ ${message}\n  Building anyway; the app will have no update feed.`);
  } else {
    console.log(`Update feed: ${repo.owner}/${repo.repo} (from ${repo.source})`);
  }

  // ── Signing identity (informational; electron-builder enforces it) ──
  const identity = resolveRequestedIdentity(process.env);
  if (identity) {
    console.log(`Signing identity: "${identity.name}" (from ${identity.source})`);
  } else {
    console.warn(
      '⚠ No CSC_NAME / OPENCLUELY_MAC_SIGN_IDENTITY set — producing an UNSIGNED build.\n' +
      '  Run `npm run mac:signing:check` and see docs/macos-code-signing.md.'
    );
  }

  const args = ['--mac', '--arm64'];

  if (repo) {
    args.push(
      '-c.publish.provider=github',
      `-c.publish.owner=${repo.owner}`,
      `-c.publish.repo=${repo.repo}`
    );
  }

  // Default to never publishing; the release script opts in explicitly.
  if (!argv.includes('--publish') && !argv.some((a) => a.startsWith('--publish='))) {
    args.push('--publish', 'never');
  }
  args.push(...argv);

  console.log(`\n$ electron-builder ${args.join(' ')}\n`);

  const result = spawnSync(
    path.join(ROOT, 'node_modules', '.bin', 'electron-builder'),
    args,
    { cwd: ROOT, stdio: 'inherit', env: process.env }
  );

  if (result.error) {
    console.error(`✗ electron-builder failed to start: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

main();

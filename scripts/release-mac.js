#!/usr/bin/env node
'use strict';

/**
 * `npm run release:mac`            — validate only (default, safe)
 * `npm run release:mac -- --publish` — validate, then tag and publish
 *
 * Fail-closed local release tooling for the macOS arm64 build.
 *
 * Without `--publish` this performs every check and builds the artifacts, but
 * touches nothing outside dist/: no tag, no push, no GitHub release. Publishing
 * is opt-in and still aborts, leaving the release as a DRAFT, if any required
 * artifact is missing.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  checkNodeVersion,
  checkPlatform,
  checkGitState,
  checkGhAuth,
  checkRepoVisibility,
  checkArtifactVersions,
  summarize
} = require('./lib/release-preflight');

const {
  expectedArtifacts,
  validateArtifactSet,
  validateLatestMacYml,
  validateReleaseVersion
} = require('./lib/mac-artifacts');

const { checkSigningIdentity } = require('./lib/mac-signing');
const { resolveUpdateRepository, readGitOrigin } = require('./lib/update-repo');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const argv = process.argv.slice(2);
const PUBLISH = argv.includes('--publish');
const SKIP_BUILD = argv.includes('--skip-build');

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

function runInherit(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function heading(text) {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

function pass(text) { console.log(`  ✓ ${text}`); }

function abort(failures) {
  console.error('\n\x1b[31m✗ Release blocked.\x1b[0m\n');
  for (const failure of failures) {
    console.error(`  ${failure.name}`);
    for (const message of failure.messages) {
      console.error(`    - ${message.replace(/\n/g, '\n      ')}`);
    }
  }
  console.error('');
  process.exit(1);
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const tag = `v${version}`;

  console.log(
    `OpenCluely macOS release — version ${version} — ` +
    (PUBLISH ? '\x1b[33mPUBLISH MODE\x1b[0m' : 'validation only')
  );

  // ── 1. Environment ──
  heading('Environment');
  const envChecks = [
    { name: 'Platform', result: checkPlatform({ platform: process.platform, arch: process.arch }) },
    { name: 'Node version', result: checkNodeVersion(process.version) },
    { name: 'Release version', result: validateReleaseVersion(version, tag) }
  ];
  let summary = summarize(envChecks);
  if (!summary.ok) abort(summary.failures);
  pass(`macOS ${process.arch}`);
  pass(`Node ${process.version}`);
  pass(`version ${version} → tag ${tag}`);

  // ── 2. Repository state ──
  heading('Repository');
  const branch = String(run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim();
  const status = String(run('git', ['status', '--porcelain']).stdout || '');
  const ghAuth = run('gh', ['auth', 'status']);
  const ghRepo = run('gh', ['repo', 'view', '--json', 'visibility']);

  const repoChecks = [
    { name: 'Git state', result: checkGitState({ branch, status }) },
    { name: 'GitHub CLI', result: checkGhAuth({ status: ghAuth ? ghAuth.status : null }) },
    { name: 'Repository visibility', result: checkRepoVisibility(ghRepo ? ghRepo.stdout : '') }
  ];
  summary = summarize(repoChecks);
  if (!summary.ok) abort(summary.failures);
  pass(`on ${branch}, working tree clean`);
  pass('gh authenticated');
  pass('repository is public');

  const updateRepo = resolveUpdateRepository({
    env: process.env,
    gitRemoteFn: () => readGitOrigin(spawnSync, ROOT)
  });
  if (!updateRepo) {
    abort([{ name: 'Update feed', messages: ['Could not determine the GitHub repository for updates.'] }]);
  }
  pass(`update feed ${updateRepo.owner}/${updateRepo.repo} (${updateRepo.source})`);

  // ── 3. Signing identity ──
  heading('Signing');
  const signing = checkSigningIdentity({ spawnSyncFn: spawnSync, env: process.env });
  if (!signing.ok) {
    abort([{ name: 'Signing identity', messages: [signing.message] }]);
  }
  pass(`identity "${signing.identity.name}" (${signing.source})`);

  // ── 4. Tests ──
  heading('Tests');
  if (runInherit('npm', ['test']).status !== 0) {
    abort([{ name: 'npm test', messages: ['Test suite failed.'] }]);
  }
  pass('npm test');

  if (runInherit('npm', ['run', 'verify:electron']).status !== 0) {
    abort([{ name: 'verify:electron', messages: ['Electron verification failed.'] }]);
  }
  pass('verify:electron');

  // ── 5. Build ──
  heading('Build');
  if (SKIP_BUILD) {
    pass('skipped (--skip-build)');
  } else {
    runInherit('npm', ['run', 'clean']);
    if (runInherit('npm', ['run', 'build:mac:arm64']).status !== 0) {
      abort([{ name: 'build:mac:arm64', messages: ['The signed arm64 build failed.'] }]);
    }
    pass('signed arm64 build');
  }

  // ── 6. Artifacts ──
  heading('Artifacts');
  if (!fs.existsSync(DIST)) {
    abort([{ name: 'dist/', messages: ['No dist/ directory was produced.'] }]);
  }
  const present = fs.readdirSync(DIST).filter((f) => fs.statSync(path.join(DIST, f)).isFile());
  const expected = expectedArtifacts(version);

  const ymlPath = path.join(DIST, expected.latestYml);
  const artifactChecks = [
    { name: 'Artifact set', result: validateArtifactSet({ version, presentFiles: present }) },
    { name: 'Artifact versions', result: checkArtifactVersions({ version, presentFiles: present }) },
    {
      name: 'Updater metadata',
      result: fs.existsSync(ymlPath)
        ? validateLatestMacYml({
            yml: fs.readFileSync(ymlPath, 'utf8'),
            version,
            presentFiles: present
          })
        : { ok: false, error: `${expected.latestYml} is missing.` }
    }
  ];
  summary = summarize(artifactChecks);
  if (!summary.ok) abort(summary.failures);
  pass(`installer ${expected.userFacing}`);
  pass(`updater assets ${expected.updaterAssets.join(', ')}`);

  // ── 7. Signature ──
  heading('Signature');
  if (runInherit('npm', ['run', 'verify:mac-signature']).status !== 0) {
    abort([{ name: 'verify:mac-signature', messages: ['Signature verification failed.'] }]);
  }
  pass('codesign --verify --deep --strict');

  // ── 8. Publish (opt-in) ──
  if (!PUBLISH) {
    console.log('\n\x1b[32m✓ All release checks passed.\x1b[0m');
    console.log('\nNothing was published. To publish this release, re-run with:');
    console.log('  npm run release:mac -- --publish --skip-build\n');
    process.exit(0);
  }

  publish({ version, tag, expected, updateRepo });
}

function publish({ version, tag, expected, updateRepo }) {
  heading('Publishing');

  const uploads = [expected.dmg, ...expected.updaterAssets]
    .map((name) => path.join(DIST, name))
    .filter((p) => fs.existsSync(p));

  // Fail closed: never publish a partial asset set.
  const missing = expected.required.filter((name) => !fs.existsSync(path.join(DIST, name)));
  if (missing.length) {
    abort([{ name: 'Required artifacts', messages: missing.map((m) => `Missing ${m}`) }]);
  }

  // Tag
  const existingTag = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
  if (existingTag.status === 0) {
    pass(`tag ${tag} already exists locally`);
  } else {
    if (run('git', ['tag', '-a', tag, '-m', `OpenCluely ${version}`]).status !== 0) {
      abort([{ name: 'git tag', messages: [`Could not create tag ${tag}.`] }]);
    }
    pass(`created tag ${tag}`);
  }

  if (runInherit('git', ['push', 'origin', tag]).status !== 0) {
    abort([{ name: 'git push', messages: [`Could not push tag ${tag}.`] }]);
  }
  pass(`pushed tag ${tag}`);

  // Draft release
  const repoSlug = `${updateRepo.owner}/${updateRepo.repo}`;
  const exists = run('gh', ['release', 'view', tag, '--repo', repoSlug]);

  if (exists.status !== 0) {
    const created = runInherit('gh', [
      'release', 'create', tag,
      '--repo', repoSlug,
      '--draft',
      '--title', `OpenCluely ${tag}`,
      '--notes', releaseNotes(version, expected)
    ]);
    if (created.status !== 0) {
      abort([{ name: 'gh release create', messages: ['Could not create the draft release.'] }]);
    }
    pass(`created draft release ${tag}`);
  } else {
    pass(`draft release ${tag} already exists`);
  }

  // Upload assets
  const uploaded = runInherit('gh', [
    'release', 'upload', tag, ...uploads,
    '--repo', repoSlug,
    '--clobber'
  ]);
  if (uploaded.status !== 0) {
    abort([{
      name: 'gh release upload',
      messages: ['Asset upload failed. The release has been left as a DRAFT.']
    }]);
  }
  pass(`uploaded ${uploads.length} assets`);

  // Only now leave draft state.
  const assetList = run('gh', ['release', 'view', tag, '--repo', repoSlug, '--json', 'assets']);
  let assetNames = [];
  try {
    assetNames = (JSON.parse(assetList.stdout).assets || []).map((a) => a.name);
  } catch (_) { /* handled below */ }

  const stillMissing = expected.required.filter((name) => !assetNames.includes(name));
  if (stillMissing.length) {
    abort([{
      name: 'Release completeness',
      messages: [
        ...stillMissing.map((m) => `Asset "${m}" is not attached to the release.`),
        'The release has been left as a DRAFT.'
      ]
    }]);
  }

  if (runInherit('gh', ['release', 'edit', tag, '--repo', repoSlug, '--draft=false']).status !== 0) {
    abort([{ name: 'gh release edit', messages: ['Could not publish the release; it remains a DRAFT.'] }]);
  }

  console.log(`\n\x1b[32m✓ Published OpenCluely ${tag}.\x1b[0m`);
  console.log(`  https://github.com/${repoSlug}/releases/tag/${tag}\n`);
}

function releaseNotes(version, expected) {
  return [
    '## macOS (Apple Silicon)',
    '',
    `Download **\`${expected.userFacing}\`** — this is the only file you need.`,
    '',
    `The \`.zip\`, \`.blockmap\` and \`latest-mac.yml\` files are used by the in-app updater ` +
    'and should not be downloaded manually.',
    '',
    '### Requirements',
    '',
    '- Apple Silicon Mac (M1 or later)',
    '- macOS grants Screen Recording and Microphone access on first use; ' +
    'you can review both under Settings ▸ Permissions.',
    '',
    `Version ${version}.`
  ].join('\n');
}

main();

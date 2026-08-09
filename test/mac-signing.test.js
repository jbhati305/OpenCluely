'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseIdentities,
  redactFingerprint,
  resolveRequestedIdentity,
  selectIdentity,
  checkSigningIdentity,
  DEFAULT_LOCAL_IDENTITY
} = require('../scripts/lib/mac-signing');

const {
  parseRepository,
  resolveUpdateRepository,
  readGitOrigin
} = require('../scripts/lib/update-repo');

const FP_A = '0123456789ABCDEF0123456789ABCDEF01234567';
const FP_B = 'FEDCBA9876543210FEDCBA9876543210FEDCBA98';

const SAMPLE_OUTPUT = [
  '  1) ' + FP_A + ' "OpenCluely Local Code Signing"',
  '  2) ' + FP_B + ' "Developer ID Application: Jane Doe (ABCDE12345)"',
  '     2 valid identities found'
].join('\n');

// ---- parseIdentities ----

test('parseIdentities extracts fingerprints and names from security output', () => {
  const identities = parseIdentities(SAMPLE_OUTPUT);

  assert.equal(identities.length, 2);
  assert.deepEqual(identities[0], {
    index: 1,
    fingerprint: FP_A,
    name: 'OpenCluely Local Code Signing'
  });
  assert.equal(identities[1].name, 'Developer ID Application: Jane Doe (ABCDE12345)');
});

test('parseIdentities returns nothing for the empty keychain output', () => {
  assert.deepEqual(parseIdentities('     0 valid identities found'), []);
  assert.deepEqual(parseIdentities(''), []);
  assert.deepEqual(parseIdentities(undefined), []);
});

test('parseIdentities ignores the trailing summary line', () => {
  const identities = parseIdentities(SAMPLE_OUTPUT);
  assert.ok(identities.every((i) => !/valid identities/.test(i.name)));
});

// ---- redaction ----

test('redactFingerprint never reveals the full fingerprint', () => {
  const redacted = redactFingerprint(FP_A);
  assert.equal(redacted, '01234567…');
  assert.ok(!redacted.includes(FP_A));
});

test('redactFingerprint handles junk input', () => {
  assert.equal(redactFingerprint(''), '<unknown>');
  assert.equal(redactFingerprint(null), '<unknown>');
});

// ---- requested identity ----

test('the identity is read from CSC_NAME', () => {
  const found = resolveRequestedIdentity({ CSC_NAME: 'My Cert' });
  assert.deepEqual(found, { name: 'My Cert', source: 'CSC_NAME' });
});

test('OPENCLUELY_MAC_SIGN_IDENTITY is accepted as an alias', () => {
  const found = resolveRequestedIdentity({ OPENCLUELY_MAC_SIGN_IDENTITY: 'Other Cert' });
  assert.deepEqual(found, { name: 'Other Cert', source: 'OPENCLUELY_MAC_SIGN_IDENTITY' });
});

test('CSC_NAME wins over the project alias', () => {
  const found = resolveRequestedIdentity({
    CSC_NAME: 'Primary',
    OPENCLUELY_MAC_SIGN_IDENTITY: 'Secondary'
  });
  assert.equal(found.name, 'Primary');
});

test('blank and missing identity variables are treated as unset', () => {
  assert.equal(resolveRequestedIdentity({}), null);
  assert.equal(resolveRequestedIdentity({ CSC_NAME: '   ' }), null);
});

// ---- selection: fails closed ----

test('exactly one exact match succeeds', () => {
  const result = selectIdentity(parseIdentities(SAMPLE_OUTPUT), 'OpenCluely Local Code Signing');
  assert.equal(result.ok, true);
  assert.equal(result.identity.fingerprint, FP_A);
});

test('an empty keychain fails with setup guidance', () => {
  const result = selectIdentity([], 'OpenCluely Local Code Signing');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-identities-found');
  assert.match(result.message, /Keychain Access/);
});

test('no requested identity fails with an explanation of which vars to set', () => {
  const result = selectIdentity(parseIdentities(SAMPLE_OUTPUT), null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-identity-requested');
  assert.match(result.message, /CSC_NAME/);
  assert.match(result.message, /OPENCLUELY_MAC_SIGN_IDENTITY/);
});

test('a non-matching name fails and lists what is available', () => {
  const result = selectIdentity(parseIdentities(SAMPLE_OUTPUT), 'Nonexistent Cert');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-exact-match');
  assert.match(result.message, /OpenCluely Local Code Signing/);
});

test('a substring match is NOT accepted', () => {
  // Signing with the wrong certificate silently is worse than failing.
  const result = selectIdentity(parseIdentities(SAMPLE_OUTPUT), 'OpenCluely');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-exact-match');
});

test('matching is case sensitive', () => {
  const result = selectIdentity(parseIdentities(SAMPLE_OUTPUT), 'opencluely local code signing');
  assert.equal(result.ok, false);
  assert.match(result.message, /exactly, including capitalisation/);
});

test('duplicate identities with the same name are rejected as ambiguous', () => {
  const dupes = [
    { index: 1, fingerprint: FP_A, name: 'OpenCluely Local Code Signing' },
    { index: 2, fingerprint: FP_B, name: 'OpenCluely Local Code Signing' }
  ];

  const result = selectIdentity(dupes, 'OpenCluely Local Code Signing');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous-match');
  assert.match(result.message, /2 identities share/);
});

test('the ambiguity message redacts fingerprints', () => {
  const dupes = [
    { index: 1, fingerprint: FP_A, name: 'Dup' },
    { index: 2, fingerprint: FP_B, name: 'Dup' }
  ];
  const result = selectIdentity(dupes, 'Dup');

  assert.ok(!result.message.includes(FP_A));
  assert.ok(!result.message.includes(FP_B));
});

// ---- end-to-end check: read-only ----

test('checkSigningIdentity only ever runs a read-only security query', () => {
  const commands = [];
  const result = checkSigningIdentity({
    env: { CSC_NAME: 'OpenCluely Local Code Signing' },
    spawnSyncFn: (cmd, args) => {
      commands.push([cmd, args]);
      return { status: 0, stdout: SAMPLE_OUTPUT };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], ['security', ['find-identity', '-v', '-p', 'codesigning']]);

  // Nothing that could create, export, delete or modify a certificate.
  const flat = JSON.stringify(commands);
  for (const forbidden of ['import', 'export', 'delete-identity', 'add-certificates', 'create-keychain']) {
    assert.ok(!flat.includes(forbidden), `must never call security ${forbidden}`);
  }
});

test('checkSigningIdentity reports a failing security invocation', () => {
  const result = checkSigningIdentity({
    env: { CSC_NAME: 'X' },
    spawnSyncFn: () => ({ status: 1, stdout: '' })
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'security-failed');
});

test('checkSigningIdentity reports a spawn error', () => {
  const result = checkSigningIdentity({
    env: { CSC_NAME: 'X' },
    spawnSyncFn: () => ({ error: new Error('spawn ENOENT') })
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /spawn ENOENT/);
});

test('the documented local certificate name is the one the docs tell you to create', () => {
  assert.equal(DEFAULT_LOCAL_IDENTITY, 'OpenCluely Local Code Signing');
});

// ---- update repository derivation ----

test('parseRepository accepts owner/repo and every common remote URL form', () => {
  const expected = { owner: 'someowner', repo: 'OpenCluely' };

  assert.deepEqual(parseRepository('someowner/OpenCluely'), expected);
  assert.deepEqual(parseRepository('https://github.com/someowner/OpenCluely'), expected);
  assert.deepEqual(parseRepository('https://github.com/someowner/OpenCluely.git'), expected);
  assert.deepEqual(parseRepository('git@github.com:someowner/OpenCluely.git'), expected);
  assert.deepEqual(parseRepository('ssh://git@github.com/someowner/OpenCluely.git'), expected);
  assert.deepEqual(parseRepository('  someowner/OpenCluely  '), expected);
});

test('parseRepository rejects malformed values', () => {
  for (const bad of ['', null, undefined, 'justonesegment', 'https://github.com/', '/', 42]) {
    assert.equal(parseRepository(bad), null);
  }
});

test('UPDATE_GITHUB_REPOSITORY takes precedence over everything', () => {
  const result = resolveUpdateRepository({
    env: {
      UPDATE_GITHUB_REPOSITORY: 'explicit/repo',
      GITHUB_REPOSITORY: 'actions/repo'
    },
    gitRemoteFn: () => 'git@github.com:origin/repo.git'
  });

  assert.deepEqual(result, { owner: 'explicit', repo: 'repo', source: 'UPDATE_GITHUB_REPOSITORY' });
});

test('GITHUB_REPOSITORY is used next (the GitHub Actions case)', () => {
  const result = resolveUpdateRepository({
    env: { GITHUB_REPOSITORY: 'actions/repo' },
    gitRemoteFn: () => 'git@github.com:origin/repo.git'
  });

  assert.equal(result.source, 'GITHUB_REPOSITORY');
  assert.equal(result.owner, 'actions');
});

test('the git origin is the last resort, for the local release command', () => {
  const result = resolveUpdateRepository({
    env: {},
    gitRemoteFn: () => 'git@github.com:localowner/OpenCluely.git'
  });

  assert.equal(result.source, 'git-remote-origin');
  assert.equal(result.owner, 'localowner');
});

test('resolveUpdateRepository returns null rather than guessing a fork', () => {
  assert.equal(resolveUpdateRepository({ env: {} }), null);
  assert.equal(resolveUpdateRepository({ env: {}, gitRemoteFn: () => null }), null);
  assert.equal(
    resolveUpdateRepository({ env: {}, gitRemoteFn: () => { throw new Error('no git'); } }),
    null
  );
});

test('readGitOrigin returns null when git fails', () => {
  assert.equal(readGitOrigin(() => ({ status: 1, stdout: '' })), null);
  assert.equal(readGitOrigin(() => ({ status: 0, stdout: '  ' })), null);
  assert.equal(readGitOrigin(null), null);
});

test('readGitOrigin trims the remote URL', () => {
  const url = readGitOrigin(() => ({ status: 0, stdout: 'git@github.com:a/b.git\n' }));
  assert.equal(url, 'git@github.com:a/b.git');
});

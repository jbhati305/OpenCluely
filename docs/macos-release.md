# macOS Release Process

OpenCluely ships an **Apple Silicon (arm64)** build for macOS. Releases are cut
locally, because signing requires a certificate that only exists in a
developer's keychain.

## Artifacts

A release produces exactly these files:

| File | Audience | Purpose |
|---|---|---|
| `OpenCluely-${version}-mac-arm64.dmg` | **Users** | The only file a user should download |
| `OpenCluely-${version}-mac-arm64.zip` | Updater | electron-updater downloads this |
| `OpenCluely-${version}-mac-arm64.zip.blockmap` | Updater | Differential download metadata |
| `OpenCluely-${version}-mac-arm64.dmg.blockmap` | Updater | Differential download metadata |
| `latest-mac.yml` | Updater | Channel metadata (version + checksums) |

**The ZIP, blockmaps and `latest-mac.yml` must stay attached to every release.**
Deleting them silently breaks in-app updates for everyone. They are not intended
for manual download; the release notes say so.

Intel (x64) and universal builds are not produced.

## Prerequisites

- An Apple Silicon Mac
- Node ≥ 22.12
- A signing identity — see [macos-code-signing.md](./macos-code-signing.md)
- `gh` CLI, authenticated (`gh auth login`)
- A **public** repository (electron-updater downloads anonymously)

## Cutting a release

### 1. Validate (default, safe)

```bash
npm run release:mac
```

This performs **every** check and builds signed artifacts, but touches nothing
outside `dist/`: no tag, no push, no GitHub release.

Checks, in order:

1. macOS on arm64
2. Node ≥ 22.12
3. `package.json` version is a plain `X.Y.Z` matching the tag `vX.Y.Z`
4. On `main`, working tree clean
5. `gh` authenticated
6. Repository is public
7. Signing identity available (exactly one exact match)
8. `npm test`
9. `npm run verify:electron`
10. Signed arm64 build
11. Full artifact set present, versions and architectures match
12. `latest-mac.yml` references files that actually exist
13. `codesign --verify --deep --strict --verbose=2`

Any failure aborts before anything is published.

### 2. Publish (explicit opt-in)

```bash
npm run release:mac -- --publish --skip-build
```

`--skip-build` reuses the artifacts you just validated. Publishing then:

1. Creates and pushes the `vX.Y.Z` tag
2. Creates (or reuses) a **draft** GitHub release
3. Uploads the DMG, ZIP, blockmaps and `latest-mac.yml`
4. Re-reads the release and confirms every required asset is attached
5. **Only then** flips the release out of draft

If anything fails at steps 3–5, the release is **left as a draft** so a partial
release is never visible to users or to the updater.

## Update feed

The GitHub repository baked into `app-update.yml` is resolved at build time:

1. `UPDATE_GITHUB_REPOSITORY` (explicit override, `owner/repo`)
2. `GITHUB_REPOSITORY` (set automatically in GitHub Actions)
3. `git remote get-url origin` (the local release command)

Nothing in runtime source names a repository, so a fork builds artifacts that
point at the fork's own releases with no code change. This is asserted by
`test/app-identity.test.js`.

## How updates behave

- Enabled **only** when the app is packaged **and** running on macOS. A `npm start`
  source run never contacts the update server.
- One automatic check ~10 seconds after startup.
- Manual check from **Settings ▸ Updates** and from the **OpenCluely** menu.
- Concurrent checks are coalesced into a single request.
- Available updates download in the background with progress reporting.
- Once downloaded, a single prompt offers **Restart and Install** or **Later**.
  "Later" installs on the next quit. One version never produces two prompts.
- Installing is impossible before the download completes.

## Windows and Linux

Unchanged. They are still built and released by
`.github/workflows/release.yml` on tag push, and are unaffected by anything in
this document.

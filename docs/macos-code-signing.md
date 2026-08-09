# macOS Code Signing

OpenCluely's macOS build uses the hardened runtime, so the app **must** be
signed to run reliably. This document covers the local, self-signed setup used
for development and personal builds, and how it differs from a real
distribution certificate.

> **Nothing in this repository contains a certificate.** The signing identity is
> read from your environment at build time. No key material is ever committed,
> printed, or uploaded.

---

## 1. Create a local signing certificate

There is no automated step for this, and there deliberately isn't one: creating
a certificate mutates your login keychain, so it is something you should do
yourself, knowingly.

1. Open **Keychain Access** (`/System/Applications/Utilities/Keychain Access.app`).
2. Menu bar: **Keychain Access ▸ Certificate Assistant ▸ Create a Certificate…**
3. Fill in exactly:

   | Field | Value |
   |---|---|
   | **Name** | `OpenCluely Local Code Signing` |
   | **Identity Type** | `Self Signed Root` |
   | **Certificate Type** | `Code Signing` |

4. Leave *"Let me override defaults"* unchecked.
5. Click **Create**, then **Done**.

The certificate is created in your **login** keychain with its private key.

## 2. Tell the build which identity to use

```bash
export CSC_NAME="OpenCluely Local Code Signing"
```

`OPENCLUELY_MAC_SIGN_IDENTITY` is accepted as an alias if you'd rather not use
electron-builder's variable name. `CSC_NAME` wins if both are set.

Add it to your shell profile to make it persistent.

## 3. Verify it

```bash
npm run mac:signing:check
```

This is **read-only**. It runs `security find-identity -v -p codesigning`,
requires exactly one identity whose common name matches `CSC_NAME` *exactly*,
and prints only the name and a truncated fingerprint. It never creates,
exports, deletes or modifies a certificate.

It fails clearly when:

- no identity is requested (`CSC_NAME` unset)
- no code-signing identities exist in your keychain
- no identity matches the name exactly (substring matches are **not** accepted —
  silently signing with the wrong certificate is worse than failing)
- two or more identities share that exact name (`codesign` would pick one
  arbitrarily)

## 4. Build and verify

```bash
npm run build:mac:arm64
npm run verify:mac-signature
```

`verify:mac-signature` checks the bundle identifier, version, architecture, the
full artifact set, `latest-mac.yml` consistency, and runs:

```bash
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/OpenCluely.app
```

---

## What self-signing does and does not give you

| | Self-signed (this doc) | Developer ID Application |
|---|---|---|
| Hardened runtime satisfied | ✅ | ✅ |
| Runs on **your** Mac | ✅ | ✅ |
| Runs on **other** Macs without warnings | ❌ | ✅ (once notarized) |
| Gatekeeper trust | ❌ | ✅ |
| Apple notarization possible | ❌ | ✅ |
| Cost | Free | Apple Developer Program membership |

**A self-signed build is for this Mac only.** Other users who download it will
still be blocked by Gatekeeper — the certificate is not rooted in a trusted
authority and the app is not notarized. Distributing self-signed builds publicly
will produce "damaged and can't be opened" errors for your users.

### Moving to a Developer ID certificate later

The configuration is already compatible. Once you have a **Developer ID
Application** certificate in your keychain:

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
npm run mac:signing:check
npm run build:mac:arm64
```

No file in this repository needs to change. To then notarize, add electron-builder's
`notarize` configuration together with `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
and `APPLE_TEAM_ID` in the environment — again, never committed.

---

## Entitlements

Two minimal entitlement files are used, both under `build/`:

- **`entitlements.mac.plist`** — the main bundle. Grants the JIT entitlements
  V8 requires under the hardened runtime, the dyld-environment entitlement
  Electron needs for its helpers, library-validation relaxation so the Electron
  framework loads, and `device.audio-input` for microphone capture.
- **`entitlements.mac.inherit.plist`** — Electron's helper processes. Same JIT
  entitlements plus `inherit`; deliberately **no** microphone entitlement, since
  capture is brokered by the main process.

The debugger-attach entitlement is deliberately absent and is asserted absent by
`test/app-identity.test.js`.

## Troubleshooting

**`code object is not signed at all`** — `CSC_NAME` was not set when you built.
Export it and rebuild.

**`a sealed resource is missing or invalid`** — something modified the bundle
after signing. Run `npm run clean` and rebuild. Note that `ELECTRON_NO_ASAR` is
never set for packaged builds precisely because it breaks this check.

**The app crashes immediately on launch** — usually a missing JIT entitlement.
Confirm `build/entitlements.mac.plist` is intact and that
`hardenedRuntime: true` is paired with an `entitlements` path in `package.json`.

**`mac:signing:check` finds nothing right after creating the certificate** —
confirm the certificate landed in the **login** keychain and that its *Certificate
Type* was **Code Signing**. A certificate created without a private key will not
appear in `security find-identity -v`.

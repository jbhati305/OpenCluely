# macOS system-audio capture — feasibility result

**Date:** 9 August 2026
**Environment:** macOS 26.5.2 (Darwin 25.5.0), Electron 43.3.0, Chromium 150.0.7871.212
**Probe:** `scripts/system-audio-probe/` — run with `npx electron scripts/system-audio-probe`

**Result: NOT CONFIRMED. The setting is deliberately not shipped.**

Microphone capture is a separate source and is fully supported. Nothing in this
document affects it.

---

## What was tested

The documented, public path only — no private macOS APIs, no virtual audio
driver, no security bypass, no silent driver installation:

```js
session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  callback({ video: sources[0], audio: 'loopback' });
});
// renderer:
await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
```

The probe then attaches an `AnalyserNode` and measures peak amplitude for 8
seconds while audio plays. It deliberately does **not** connect the graph to
`AudioContext.destination`, which would create a capture feedback loop.

## What happened

| Check | Result |
| --- | --- |
| Screen Recording permission | **granted** |
| `getDisplayMedia` returns an audio track | **yes** — labelled `System audio` |
| Track starts live | **no** — `readyState` is `ended` at the moment of acquisition |
| `ended` event timing | never fires; the track is *born* ended |
| Non-silent samples | **none** — peak amplitude `0.0000` across 80 buffers |
| Video track alongside it | 1 (video capture itself works) |
| Tracks stop cleanly | yes |

Repeated with `audio: 'loopbackWithMute'` — identical result.

The decisive detail is that the track is **born `ended`**. The CoreAudio tap
never starts, so this is not a signal-detection or volume problem.

## Why this is not simply a missing entitlement

Two plausible explanations were checked:

1. **`NSAudioCaptureUsageDescription`** (required from macOS 14.2) — *present*
   in the development Electron's `Info.plist`. Not the cause.
2. **`com.apple.security.device.audio-input` entitlement** — absent from the
   unsigned development Electron, present in OpenCluely's
   `build/entitlements.mac.plist`.

Hypothesis 2 was tested by ad-hoc re-signing a copy of `Electron.app` with the
project entitlements. **That test was inconclusive**, and knowably so:
re-signing changes the code signature, which is the identity macOS TCC binds
Screen Recording permission to, so the copy no longer holds the grant the probe
depends on. It cannot distinguish "entitlement fixed it" from "permission was
lost".

So the honest position is: **system audio does not work in a development run,
and whether a properly signed build fixes it is untested.**

## Decision

Per the plan's instruction not to fake support and not to silently fall back to
the microphone:

- No "Speech input source" setting is added.
- No microphone/system-audio mixing code was written.
- Microphone remains the only input source, and is unaffected.

## What would settle it

1. Add `NSAudioCaptureUsageDescription` to `build.mac.extendInfo`.
2. Build and sign normally (`npm run build:mac:local-claude`) so the signature
   is stable and TCC grants attach to the real app.
3. Install, grant Screen Recording to the installed app, and run the same probe
   logic from inside it.
4. Only if the track is live **and** carries non-silent samples should the
   setting be introduced — with Microphone remaining the default.

Step 1 alone is harmless but was not made, since adding a usage-description
string for a feature that does not exist would be misleading.

'use strict';

/**
 * Isolated feasibility probe: can Electron 43 capture macOS SYSTEM AUDIO
 * (not the microphone) using supported public APIs?
 *
 * Run with:  npx electron scripts/system-audio-probe
 *
 * Deliberately isolated from the OpenCluely app so a failure here cannot
 * affect microphone support, which must work regardless of the outcome.
 *
 * Uses only documented Electron/Chromium APIs — no private macOS APIs, no
 * virtual audio driver, no security bypass.
 */

const { app, BrowserWindow, desktopCapturer, systemPreferences, session } = require('electron');
const path = require('node:path');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

app.whenReady().then(async () => {
  console.log('\nmacOS system-audio feasibility probe');
  console.log(`  electron ${process.versions.electron}  chrome ${process.versions.chrome}`);
  console.log(`  darwin ${require('node:os').release()}\n`);

  // Screen Recording is the permission that gates system audio on macOS.
  const screenStatus = systemPreferences.getMediaAccessStatus('screen');
  record('screen-recording permission granted', screenStatus === 'granted', screenStatus);

  const window = new BrowserWindow({
    width: 520,
    height: 360,
    show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });

  // The documented path for loopback audio: the app decides what the page gets.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (!sources.length) return callback({});
        // 'loopback' = system audio without the local echo the user would hear.
        callback({ video: sources[0], audio: process.env.PROBE_AUDIO_MODE === 'withMute' ? 'loopbackWithMute' : 'loopback' });
      } catch (error) {
        console.log(`  handler error: ${error.message}`);
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  await window.loadFile(path.join(__dirname, 'index.html'));

  const report = await new Promise((resolve) => {
    require('electron').ipcMain.once('probe-result', (event, payload) => resolve(payload));
    setTimeout(() => resolve({ error: 'probe timed out' }), 30000);
  });

  if (report.error) {
    record('getDisplayMedia returned an audio track', false, report.error);
  } else {
    record('getDisplayMedia returned an audio track', report.hasAudioTrack, report.trackLabel || '');
    record('audio track starts live', report.initialReadyState === 'live',
      `initial=${report.initialReadyState}, ended after ${report.endedAtMs === null ? 'never' : report.endedAtMs + 'ms'}, videoTracks=${report.videoTracks}`);
    record('non-silent samples were received', report.sawSignal,
      `peak amplitude ${report.peak.toFixed(4)} over ${report.samples} buffers`);
    record('tracks stopped cleanly', report.stoppedCleanly, report.finalReadyState || '');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'SYSTEM AUDIO FEASIBLE' : 'SYSTEM AUDIO NOT CONFIRMED'} (${results.length - failed.length}/${results.length})`);
  if (failed.length) {
    console.log('Unmet:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  }
  console.log('');

  window.destroy();
  app.exit(failed.length === 0 ? 0 : 1);
});

app.on('window-all-closed', () => app.quit());

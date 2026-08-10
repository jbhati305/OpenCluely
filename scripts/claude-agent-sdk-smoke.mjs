#!/usr/bin/env node
/**
 * Manual, opt-in feasibility probe for the Claude Agent SDK.
 *
 * This script sends real requests that consume the signed-in user's Claude
 * subscription usage. It is deliberately NOT wired into `npm test`,
 * `postinstall`, CI, packaging or application startup, and it refuses to run
 * without an explicit acknowledgement flag.
 *
 *   node scripts/claude-agent-sdk-smoke.mjs --confirm-subscription-use
 *
 * It never prints prompt text, image bytes, model messages, credentials or
 * account identifiers.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { readAuthStatus, isSubscriptionAuth, authErrorCode, resolveClaudeExecutable } =
  require('../src/services/claude-agent/auth.js');
const { buildTextUserMessage, buildImageUserMessage } =
  require('../src/services/claude-agent/messages.js');
const { runQuery } = require('../src/services/claude-agent/runner.js');
const { removedOverrideNames } = require('../src/services/claude-agent/child-env.js');
const { DISALLOWED_TOOLS } = require('../src/services/claude-agent/query-options.js');

const CONFIRM_FLAG = '--confirm-subscription-use';
const TEXT_SENTINEL = 'OPENCLUELY_CLAUDE_TEXT_OK';

const SYSTEM_PROMPT =
  'You are a concise assistant embedded in a desktop application. ' +
  'Answer directly. Do not use tools.';

function line(label, value) {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

async function main() {
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.log('\nClaude Agent SDK smoke test — NOT RUN.\n');
    console.log('This sends real requests that draw from your Claude subscription usage.');
    console.log(`Re-run with ${CONFIRM_FLAG} to proceed.\n`);
    process.exitCode = 0;
    return;
  }

  let failed = false;

  // ---- 1. authentication -------------------------------------------------
  console.log('\n[1/4] Authentication');
  const executable = resolveClaudeExecutable();
  const status = await readAuthStatus();

  line('claude executable', executable ? 'resolved' : 'NOT FOUND');
  line('sanitized status', JSON.stringify(status));
  line('stripped env vars', JSON.stringify(removedOverrideNames()));

  if (!isSubscriptionAuth(status)) {
    console.log(`\n  FAILED: ${authErrorCode(status)}`);
    console.log('  Run this in Terminal, then retry:\n\n    claude auth login\n');
    process.exitCode = 1;
    return;
  }
  line('result', 'PASS — subscription authentication confirmed');

  // ---- 2. text -----------------------------------------------------------
  console.log('\n[2/4] Text request');
  try {
    let deltaCount = 0;
    const text = await runQuery({
      message: buildTextUserMessage(`Reply with exactly ${TEXT_SENTINEL} and nothing else.`),
      systemPrompt: SYSTEM_PROMPT,
      onDelta: () => { deltaCount += 1; },
      timeoutMs: 120000
    });

    const matched = text.text.trim() === TEXT_SENTINEL;
    line('duration', `${text.durationMs} ms`);
    line('streamed', String(text.streamed));
    line('delta events', String(deltaCount));
    line('response chars', String(text.characters));
    line('model', text.model || 'unreported');
    line('exact sentinel', String(matched));
    line('result', matched ? 'PASS' : 'FAIL — unexpected response text');
    if (!matched) failed = true;
  } catch (error) {
    line('result', `FAIL — ${error.code || error.name}`);
    failed = true;
  }

  // ---- 3. image ----------------------------------------------------------
  console.log('\n[3/4] Image request');
  try {
    // A shipped UI icon: no screen capture, no user data.
    const buffer = readFileSync(path.join(ROOT, 'assests', 'icons', 'terminal.png'));
    let deltaCount = 0;

    const result = await runQuery({
      message: buildImageUserMessage({
        text: 'Briefly describe this application icon in one sentence.',
        image: { buffer, mediaType: 'image/png' }
      }),
      systemPrompt: SYSTEM_PROMPT,
      onDelta: () => { deltaCount += 1; },
      timeoutMs: 120000
    });

    const ok = result.characters > 0;
    line('image bytes sent', String(buffer.length));
    line('duration', `${result.durationMs} ms`);
    line('streamed', String(result.streamed));
    line('delta events', String(deltaCount));
    line('response chars', String(result.characters));
    line('result', ok ? 'PASS' : 'FAIL — empty response');
    if (!ok) failed = true;
  } catch (error) {
    line('result', `FAIL — ${error.code || error.name}`);
    failed = true;
  }

  // ---- 4. timeout + cleanup ---------------------------------------------
  console.log('\n[4/4] Timeout and cancellation');
  try {
    await runQuery({
      message: buildTextUserMessage('Count slowly from 1 to 500, one number per line.'),
      systemPrompt: SYSTEM_PROMPT,
      timeoutMs: 1
    });
    line('result', 'FAIL — expected a timeout');
    failed = true;
  } catch (error) {
    const ok = error.code === 'CLAUDE_TIMEOUT';
    line('error code', error.code || 'none');
    line('result', ok ? 'PASS' : `FAIL — expected CLAUDE_TIMEOUT`);
    if (!ok) failed = true;
  }

  console.log('\nLockdown in effect for every request above:');
  line('tools', '[] (none)');
  line('permissionMode', 'dontAsk');
  line('settingSources', '[] (none)');
  line('persistSession', 'false');
  line('maxTurns', '1');
  line('disallowedTools', `${DISALLOWED_TOOLS.length} names`);

  console.log(`\n${failed ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED'}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`\nUnexpected failure: ${error && (error.code || error.name)}\n`);
  process.exitCode = 1;
});

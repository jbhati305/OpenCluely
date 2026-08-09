const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const onboardingHtml = fs.readFileSync(
  path.join(__dirname, '..', 'onboarding.html'),
  'utf8'
);

test('finish screen avoids the macOS color-emoji crash path', () => {
  const finishScreen = onboardingHtml.match(
    /<section class="screen" data-screen="finish">([\s\S]*?)<\/section>/
  );

  assert.ok(finishScreen, 'expected the onboarding finish screen to exist');
  assert.doesNotMatch(finishScreen[1], /\u2B50|\uFE0F/);
  assert.match(finishScreen[1], /class="fas fa-star"/);
});

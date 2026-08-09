const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatHtml = fs.readFileSync(path.join(__dirname, '..', 'chat.html'), 'utf8');

test('chat messages contain long prose and unbroken tokens', () => {
  assert.match(chatHtml, /\.message\s*\{[\s\S]*?max-width:\s*100%/);
  assert.match(chatHtml, /\.message-text\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(
    chatHtml,
    /\.message\.assistant\s+\*[\s\S]*?overflow:\s*visible\s*!important/
  );
});

test('wide code and tables scroll inside the assistant message', () => {
  assert.match(
    chatHtml,
    /\.message\.assistant\s+pre\s*\{[\s\S]*?max-width:\s*100%[\s\S]*?overflow-x:\s*auto/
  );
  assert.match(
    chatHtml,
    /\.message\.assistant\s+table\s*\{[\s\S]*?max-width:\s*100%[\s\S]*?overflow-x:\s*auto/
  );
});

test('rendered math can wrap instead of forcing the chat wider', () => {
  assert.match(
    chatHtml,
    /\.message-text\s+\.math\s*\{[\s\S]*?white-space:\s*normal[\s\S]*?overflow-wrap:\s*anywhere/
  );
});

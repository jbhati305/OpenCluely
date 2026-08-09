'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { promptLoader } = require('../prompt-loader');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const settingsHtml = read('settings.html');
const mainJs = read('main.js');
const mainWindowJs = read('src/ui/main-window.js');
const chatWindowJs = read('src/ui/chat-window.js');
const llmService = read('src/services/llm.service.js');

// ---- the prompt file ----

test('a general prompt file ships with the app', () => {
  const file = path.join(ROOT, 'prompts', 'general.md');
  assert.ok(fs.existsSync(file), 'prompts/general.md should exist');
  assert.ok(fs.statSync(file).size > 500, 'the prompt should be substantive');
});

test('the general prompt is a discussion track, not a coding one', () => {
  const prompt = read('prompts/general.md');

  // This is the whole point of the skill: interview conversation, no code.
  assert.match(prompt, /never write code/i);
  assert.match(prompt, /no code blocks/i);
  assert.match(prompt, /pseudocode/i);
  assert.ok(!/```/.test(prompt), 'the prompt must not demonstrate code fences');
});

test('the general prompt redirects genuinely technical asks to the right track', () => {
  const prompt = read('prompts/general.md');
  for (const track of ['DSA', 'LLD', 'System Design']) {
    assert.ok(prompt.includes(track), `should name ${track} as the place for code`);
  }
});

test('the general prompt covers the usual interview-discussion territory', () => {
  const prompt = read('prompts/general.md').toLowerCase();
  for (const topic of ['tell me about yourself', 'behavioural', 'strengths', 'weakness', 'culture fit', 'compensation']) {
    assert.ok(prompt.includes(topic), `should cover "${topic}"`);
  }
});

test('the general prompt answers in the candidate voice and stays speakable', () => {
  const prompt = read('prompts/general.md');
  assert.match(prompt, /first person/i);
  assert.match(prompt, /star/i);
  assert.match(prompt, /speakable|out loud|spoken/i);
});

test('the general prompt forbids inventing the user\'s history', () => {
  const prompt = read('prompts/general.md');
  assert.match(prompt, /never invent facts/i);
  assert.match(prompt, /placeholder/i);
});

// ---- prompt loader wiring ----

test('general is a supported skill', () => {
  assert.ok(promptLoader.supportedSkills.includes('general'));
});

test('the general prompt loads and is non-empty', () => {
  const prompt = promptLoader.getSkillPrompt('general');
  assert.ok(prompt, 'getSkillPrompt("general") should return content');
  assert.ok(prompt.length > 500);
});

test('every supported skill resolves to a loadable prompt', () => {
  for (const skill of promptLoader.getAvailableSkills()) {
    const prompt = promptLoader.getSkillPrompt(skill);
    assert.ok(prompt, `${skill} should have a prompt`);
  }
});

test('general does not get a programming language forced into it', () => {
  assert.ok(!promptLoader.skillsRequiringProgrammingLanguage.includes('general'));

  const plain = promptLoader.getSkillPrompt('general');
  const withLanguage = promptLoader.getSkillPrompt('general', 'cpp');

  assert.equal(withLanguage, plain, 'a general answer must not be locked to one language');
  assert.ok(!/IMPLEMENTATION LANGUAGE/.test(withLanguage));
});

test('the coding tracks still get their language injection', () => {
  // Guard against the change above accidentally disabling injection elsewhere.
  for (const skill of ['dsa', 'lld']) {
    const withLanguage = promptLoader.getSkillPrompt(skill, 'python');
    assert.match(withLanguage, /IMPLEMENTATION LANGUAGE: PYTHON/);
  }
});

test('common aliases normalize to general', () => {
  for (const alias of ['general', 'General', 'GENERAL', 'general-questions', 'generic', 'misc', 'other', 'qa']) {
    assert.equal(promptLoader.normalizeSkillName(alias), 'general', `${alias} should map to general`);
  }
});

test('an unset skill now resolves to a real general prompt', () => {
  // normalizeSkillName already returned 'general' for empty input, but with no
  // general.md that path produced no prompt at all. It now resolves properly.
  assert.equal(promptLoader.normalizeSkillName(''), 'general');
  assert.equal(promptLoader.normalizeSkillName(null), 'general');
  assert.ok(promptLoader.getSkillPrompt(''), 'an unset skill should still get a prompt');
  assert.ok(promptLoader.getSkillPrompt(null));
});

test('adding general did not disturb the existing skills', () => {
  for (const skill of ['dsa', 'os', 'networking', 'system-design', 'lld']) {
    assert.ok(promptLoader.supportedSkills.includes(skill), `${skill} must remain supported`);
    assert.equal(promptLoader.normalizeSkillName(skill), skill);
  }
  assert.deepEqual(promptLoader.skillsRequiringProgrammingLanguage, ['dsa', 'lld']);
});

// ---- main process ----

test('general is reachable through skill navigation', () => {
  const navBlock = mainJs.slice(
    mainJs.indexOf('navigateSkill(direction)'),
    mainJs.indexOf('navigateSkill(direction)') + 400
  );
  assert.match(navBlock, /"general"/);
});

test('general is not added to the language-requiring skills in main', () => {
  const matches = mainJs.match(/skillsRequiringProgrammingLanguage = \[[^\]]*\]/g) || [];
  assert.ok(matches.length > 0);
  for (const m of matches) {
    assert.ok(!m.includes('general'), 'general must not force a programming language');
  }
});

// ---- UI surfaces ----

test('the settings dropdown offers the general track', () => {
  assert.match(settingsHtml, /<option value="general">General \/ Interview Discussion<\/option>/);
});

test('the overlay can navigate to general', () => {
  const block = mainWindowJs.slice(
    mainWindowJs.indexOf('this.availableSkills'),
    mainWindowJs.indexOf('this.availableSkills') + 240
  );
  assert.match(block, /'general'/);
});

test('every skill-label map in the overlay knows about general', () => {
  const maps = mainWindowJs.match(/const skillNames = \{[\s\S]*?\};/g) || [];
  assert.ok(maps.length >= 3, 'expected the three skill-label maps');
  for (const map of maps) {
    assert.match(map, /'general': 'General'/);
  }
});

test('the chat window has an icon for general', () => {
  assert.match(chatWindowJs, /'general': '.+'/);
});

// ---- LLM fallbacks ----

test('the offline fallback has a general-specific message', () => {
  const block = llmService.slice(
    llmService.indexOf('const fallbackResponses = {'),
    llmService.indexOf('const fallbackResponses = {') + 1400
  );
  assert.match(block, /'general':/);
});

test('the transcription fallback does not tell the user to stay "relevant to general"', () => {
  // Every topic is in scope for the catch-all, so that phrasing would be
  // a nonsense constraint.
  assert.match(llmService, /activeSkill === 'general'/);
  assert.match(llmService, /Go ahead and ask your question/);
});

test('the transcription fallback wording is unchanged for other skills', () => {
  assert.match(llmService, /Ask your question relevant to \$\{activeSkill\}/);
  assert.match(llmService, /it sounds like a \$\{activeSkill\} question/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = require('../src/core/response-policy');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---- per-skill defaults ----

test('DSA defaults to complete', () => {
  assert.equal(policy.getStrategy('dsa'), policy.STRATEGIES.COMPLETE);
  assert.equal(policy.isGuided('dsa'), false);
});

test('System Design and LLD default to guided', () => {
  assert.equal(policy.getStrategy('system-design'), policy.STRATEGIES.GUIDED);
  assert.equal(policy.getStrategy('lld'), policy.STRATEGIES.GUIDED);
  assert.equal(policy.isGuided('system-design'), true);
  assert.equal(policy.isGuided('lld'), true);
});

test('OS, Networking and General default to concise', () => {
  for (const skill of ['os', 'networking', 'general']) {
    assert.equal(policy.getStrategy(skill), policy.STRATEGIES.CONCISE, skill);
    assert.equal(policy.isGuided(skill), false);
  }
});

test('an unknown skill falls back to concise rather than dumping everything', () => {
  assert.equal(policy.getStrategy('unknown'), policy.STRATEGIES.CONCISE);
  assert.equal(policy.getStrategy(''), policy.STRATEGIES.CONCISE);
  assert.equal(policy.getStrategy(null), policy.STRATEGIES.CONCISE);
});

test('skill names are matched case-insensitively', () => {
  assert.equal(policy.getStrategy('DSA'), policy.STRATEGIES.COMPLETE);
  assert.equal(policy.getStrategy('  System-Design '), policy.STRATEGIES.GUIDED);
});

// ---- stage ladder ----

test('the first system-design turn is clarification only', () => {
  assert.equal(policy.firstStage('system-design'), 'clarification');

  const directive = policy.buildDirective({ skill: 'system-design', stage: null });

  assert.match(directive, /GUIDED INTERVIEW/);
  assert.match(directive, /4-6 prioritized clarifying questions/);
  assert.match(directive, /STOP and wait/);
  assert.match(directive, /Do NOT invent answers/);
  // The whole point: no architecture in the opening turn.
  assert.match(directive, /Do NOT produce architecture, APIs, a data model, capacity estimates or diagrams/);
});

test('Next step advances exactly one stage and never skips', () => {
  const stages = policy.getStages('system-design');
  let current = policy.firstStage('system-design');

  for (let i = 1; i < stages.length; i += 1) {
    current = policy.nextStage('system-design', current);
    assert.equal(current, stages[i], `step ${i}`);
  }

  // Clamped at the end rather than wrapping back to clarification.
  assert.equal(policy.nextStage('system-design', stages[stages.length - 1]), stages[stages.length - 1]);
});

test('LLD walks its own ladder', () => {
  assert.deepEqual(policy.getStages('lld'), [
    'clarification',
    'use-cases-and-constraints',
    'core-objects',
    'interfaces-and-relationships',
    'key-flow',
    'patterns-and-trade-offs',
    'refinement'
  ]);
  assert.equal(policy.nextStage('lld', 'clarification'), 'use-cases-and-constraints');
});

test('an unrecognized stage restarts at the beginning instead of erroring', () => {
  assert.equal(policy.nextStage('system-design', 'nonsense'), 'clarification');
});

test('non-guided skills have no stages', () => {
  for (const skill of ['dsa', 'os', 'networking', 'general']) {
    assert.deepEqual(policy.getStages(skill), []);
    assert.equal(policy.firstStage(skill), null);
    assert.equal(policy.nextStage(skill, 'anything'), null);
  }
});

// ---- directives ----

test('Full answer overrides guided pacing', () => {
  const directive = policy.buildDirective({
    skill: 'system-design',
    stage: 'clarification',
    action: policy.ACTIONS.FULL_ANSWER
  });

  assert.match(directive, /FULL ANSWER/);
  assert.match(directive, /ignore any instruction to answer one stage at a time/);
  assert.ok(!/STOP and wait/.test(directive));
});

test('Full answer also overrides concise pacing', () => {
  const directive = policy.buildDirective({ skill: 'os', action: policy.ACTIONS.FULL_ANSWER });
  assert.match(directive, /FULL ANSWER/);
  assert.ok(!/100-250 words/.test(directive));
});

test('Deep dive stays on the current topic', () => {
  const directive = policy.buildDirective({
    skill: 'system-design', stage: 'high-level-architecture', action: policy.ACTIONS.DEEP_DIVE
  });
  assert.match(directive, /DEEP DIVE/);
  assert.match(directive, /Do not move on to a new topic/);
});

test('Answer with assumptions lets a stalled interview progress', () => {
  const directive = policy.buildDirective({
    skill: 'system-design', stage: 'clarification', action: policy.ACTIONS.ASSUMPTIONS
  });
  assert.match(directive, /has not answered/);
  assert.match(directive, /labeled as assumptions/);
});

test('complete mode asks for the whole solution in one response', () => {
  const directive = policy.buildDirective({ skill: 'dsa' });
  assert.match(directive, /COMPLETE/);
  assert.match(directive, /time and space complexity/);
  assert.match(directive, /Do not split this across turns/);
});

test('concise mode bounds the length and leads with the answer', () => {
  const directive = policy.buildDirective({ skill: 'general' });
  assert.match(directive, /CONCISE/);
  assert.match(directive, /100-250 words/);
  assert.match(directive, /speakable out loud/);
  assert.match(directive, /not a tutorial/);
});

test('the guided directive names the exact stage and position', () => {
  const directive = policy.buildDirective({ skill: 'system-design', stage: 'apis-and-data-model' });
  assert.match(directive, /stage 5 of 9/);
  assert.match(directive, /APIs & data model/);
  assert.match(directive, /Answer ONLY this stage/);
});

// ---- chat actions ----

test('DSA gets no actions and never needs Next step', () => {
  assert.deepEqual(policy.availableActions({ skill: 'dsa' }), []);
});

test('guided skills offer Next step, and assumptions only while clarifying', () => {
  const atClarification = policy.availableActions({ skill: 'system-design', stage: 'clarification' })
    .map((a) => a.id);
  assert.deepEqual(atClarification, ['next-step', 'answer-with-assumptions', 'deep-dive', 'full-answer']);

  const later = policy.availableActions({ skill: 'system-design', stage: 'trade-offs' }).map((a) => a.id);
  assert.deepEqual(later, ['next-step', 'deep-dive', 'full-answer']);
  assert.ok(!later.includes('answer-with-assumptions'), 'assumptions only make sense while clarifying');
});

test('the last stage stops offering Next step', () => {
  const last = policy.availableActions({ skill: 'system-design', stage: 'wrap-up' }).map((a) => a.id);
  assert.ok(!last.includes('next-step'));
  assert.deepEqual(last, ['deep-dive', 'full-answer']);
});

test('concise skills can still opt into more', () => {
  const actions = policy.availableActions({ skill: 'os' }).map((a) => a.id);
  assert.deepEqual(actions, ['deep-dive', 'full-answer']);
});

test('every action carries a human label', () => {
  for (const action of policy.availableActions({ skill: 'system-design', stage: 'clarification' })) {
    assert.ok(action.label && action.label.length > 2, action.id);
  }
});

// ---- prompts match their strategy ----

test('the system-design prompt no longer claims there is no back-and-forth', () => {
  const prompt = read('prompts/system-design.md');

  // This single line was the root cause of the slow, monolithic answer.
  assert.ok(!/no back-and-forth/i.test(prompt), 'the no-back-and-forth instruction must be gone');
  assert.match(prompt, /interactive interview/i);
  assert.match(prompt, /answer ONLY that stage/i);
  assert.match(prompt, /Never dump the entire design in one response/i);
});

test('the system-design prompt defers diagrams past clarification', () => {
  const prompt = read('prompts/system-design.md');
  assert.match(prompt, /Never draw a diagram during clarification/i);
  // The old prompt demanded a diagram in EVERY design.
  assert.ok(!/every design must include at least one architecture diagram/i.test(prompt));
});

test('the LLD prompt paces its code output', () => {
  const prompt = read('prompts/lld.md');
  assert.match(prompt, /interactive interview/i);
  assert.match(prompt, /Do not write a full implementation during clarification/i);
});

test('the DSA prompt was not degraded into a staged one', () => {
  const prompt = read('prompts/dsa.md');
  assert.ok(!/answer ONLY that stage/i.test(prompt), 'DSA must stay complete');
  assert.ok(!/Next step/i.test(prompt));
});

test('the concise prompts state their length budget', () => {
  for (const file of ['prompts/os.md', 'prompts/networking.md']) {
    assert.match(read(file), /100-250 words/, file);
  }
});

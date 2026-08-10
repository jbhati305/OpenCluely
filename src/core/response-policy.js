'use strict';

/**
 * How much of an answer a skill should produce in one response.
 *
 * This is the single source of truth. UI code, providers and prompt assembly
 * all read from here rather than each carrying its own `if (skill === ...)`
 * checks, which is how the old behaviour ended up inconsistent between the
 * overlay, the chat window and the LLM service.
 */

const STRATEGIES = Object.freeze({
  COMPLETE: 'complete',
  GUIDED: 'guided',
  CONCISE: 'concise'
});

/** Every supported skill maps to exactly one strategy. */
const SKILL_STRATEGY = Object.freeze({
  'dsa': STRATEGIES.COMPLETE,
  'system-design': STRATEGIES.GUIDED,
  'lld': STRATEGIES.GUIDED,
  'os': STRATEGIES.CONCISE,
  'networking': STRATEGIES.CONCISE,
  'general': STRATEGIES.CONCISE
});

const DEFAULT_STRATEGY = STRATEGIES.CONCISE;

/**
 * Guided interviews walk a fixed ladder of stages. Keeping the ladder here —
 * rather than asking the model to infer "where are we?" — is what makes
 * `Next step` advance exactly one stage instead of skipping ahead.
 */
const SYSTEM_DESIGN_STAGES = Object.freeze([
  'clarification',
  'requirements',
  'estimation',
  'high-level-architecture',
  'apis-and-data-model',
  'deep-dive',
  'scaling-and-reliability',
  'trade-offs',
  'wrap-up'
]);

const LLD_STAGES = Object.freeze([
  'clarification',
  'use-cases-and-constraints',
  'core-objects',
  'interfaces-and-relationships',
  'key-flow',
  'patterns-and-trade-offs',
  'refinement'
]);

const STAGE_LABELS = Object.freeze({
  'clarification': 'Clarifying questions',
  'requirements': 'Requirements',
  'estimation': 'Capacity estimation',
  'high-level-architecture': 'High-level architecture',
  'apis-and-data-model': 'APIs & data model',
  'deep-dive': 'Deep dive',
  'scaling-and-reliability': 'Scaling & reliability',
  'trade-offs': 'Trade-offs',
  'wrap-up': 'Wrap-up',
  'use-cases-and-constraints': 'Use cases & constraints',
  'core-objects': 'Core objects',
  'interfaces-and-relationships': 'Interfaces & relationships',
  'key-flow': 'Key flow',
  'patterns-and-trade-offs': 'Patterns & trade-offs',
  'refinement': 'Refinement'
});

/** Stages that are only worth doing sometimes. */
const OPTIONAL_STAGES = Object.freeze(['estimation']);

const ACTIONS = Object.freeze({
  NEXT_STEP: 'next-step',
  ASSUMPTIONS: 'answer-with-assumptions',
  DEEP_DIVE: 'deep-dive',
  FULL_ANSWER: 'full-answer'
});

const ACTION_LABELS = Object.freeze({
  [ACTIONS.NEXT_STEP]: 'Next step',
  [ACTIONS.ASSUMPTIONS]: 'Answer with assumptions',
  [ACTIONS.DEEP_DIVE]: 'Deep dive',
  [ACTIONS.FULL_ANSWER]: 'Full answer'
});

function normalizeSkill(skill) {
  return typeof skill === 'string' ? skill.trim().toLowerCase() : '';
}

function getStrategy(skill) {
  return SKILL_STRATEGY[normalizeSkill(skill)] || DEFAULT_STRATEGY;
}

function isGuided(skill) {
  return getStrategy(skill) === STRATEGIES.GUIDED;
}

function getStages(skill) {
  const key = normalizeSkill(skill);
  if (key === 'system-design') return SYSTEM_DESIGN_STAGES;
  if (key === 'lld') return LLD_STAGES;
  return [];
}

function firstStage(skill) {
  const stages = getStages(skill);
  return stages.length ? stages[0] : null;
}

/** Advance exactly one stage. Never skips, never wraps past the end. */
function nextStage(skill, currentStage) {
  const stages = getStages(skill);
  if (!stages.length) return null;

  const index = stages.indexOf(currentStage);
  if (index === -1) return stages[0];
  if (index >= stages.length - 1) return stages[stages.length - 1];
  return stages[index + 1];
}

function isLastStage(skill, stage) {
  const stages = getStages(skill);
  return stages.length > 0 && stages[stages.length - 1] === stage;
}

function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage || '';
}

/**
 * Which compact chat actions to offer. DSA is complete by default and must
 * never require `Next step` to get an answer.
 */
function availableActions({ skill, stage } = {}) {
  const strategy = getStrategy(skill);

  if (strategy === STRATEGIES.COMPLETE) return [];

  if (strategy === STRATEGIES.CONCISE) {
    return [
      { id: ACTIONS.DEEP_DIVE, label: ACTION_LABELS[ACTIONS.DEEP_DIVE] },
      { id: ACTIONS.FULL_ANSWER, label: ACTION_LABELS[ACTIONS.FULL_ANSWER] }
    ];
  }

  // Guided.
  const actions = [];
  if (!isLastStage(skill, stage)) {
    actions.push({ id: ACTIONS.NEXT_STEP, label: ACTION_LABELS[ACTIONS.NEXT_STEP] });
  }
  if (stage === 'clarification') {
    actions.push({ id: ACTIONS.ASSUMPTIONS, label: ACTION_LABELS[ACTIONS.ASSUMPTIONS] });
  }
  actions.push({ id: ACTIONS.DEEP_DIVE, label: ACTION_LABELS[ACTIONS.DEEP_DIVE] });
  actions.push({ id: ACTIONS.FULL_ANSWER, label: ACTION_LABELS[ACTIONS.FULL_ANSWER] });
  return actions;
}

const STRATEGY_DIRECTIVES = Object.freeze({
  [STRATEGIES.COMPLETE]:
    'RESPONSE MODE: COMPLETE.\n' +
    'Give the whole solution in this one response: restate the problem, the approach, ' +
    'why it is correct, the code, time and space complexity, and the edge cases that matter. ' +
    'Do not split this across turns and do not ask the user to request the next part.',

  [STRATEGIES.CONCISE]:
    'RESPONSE MODE: CONCISE.\n' +
    'Lead with the direct answer in the first sentence — it should be speakable out loud as-is. ' +
    'Keep the whole reply roughly 100-250 words. This is an interview answer, not a tutorial: ' +
    'do not write a structured guide, do not add headings for a short answer, and do not pad. ' +
    'Expand only if the user explicitly asks. You may end with one short offer to go deeper, ' +
    'but only when there is genuinely more worth saying.'
});

/** Per-stage instructions for guided mode. */
const STAGE_DIRECTIVES = Object.freeze({
  'clarification':
    'Restate the problem in one or two sentences, then ask 4-6 prioritized clarifying questions. ' +
    'Then STOP and wait for the answers. Do NOT invent answers and continue. ' +
    'Do NOT produce architecture, APIs, a data model, capacity estimates or diagrams in this response.',
  'requirements':
    'State the functional and non-functional requirements only, as short bullets. No architecture yet.',
  'estimation':
    'Do a brief capacity estimate only: traffic, storage, bandwidth. Show the arithmetic compactly. Nothing else.',
  'high-level-architecture':
    'Describe the high-level architecture only: the main components and how requests flow between them. ' +
    'A small text diagram is fine. Do not write API signatures or schemas yet.',
  'apis-and-data-model':
    'Give the core API endpoints and the data model only. Do not re-explain the architecture.',
  'deep-dive':
    'Go deep on the single most interesting component only. Do not summarize the whole design again.',
  'scaling-and-reliability':
    'Cover scaling, bottlenecks, caching, replication and failure handling only.',
  'trade-offs':
    'Discuss the key trade-offs and the alternatives you rejected, and why. Nothing else.',
  'wrap-up':
    'Give a short summary of the design and what you would do next with more time.',
  'use-cases-and-constraints':
    'List the use cases and constraints only. No classes yet.',
  'core-objects':
    'Identify the core objects and each one\'s single responsibility. No full code yet.',
  'interfaces-and-relationships':
    'Define the interfaces and the relationships between objects. Signatures only, not full implementations.',
  'key-flow':
    'Walk through the single most important flow end to end across the objects.',
  'patterns-and-trade-offs':
    'Name the design patterns in play and the trade-offs they carry.',
  'refinement':
    'Refine the design: extensibility, edge cases, and what you would change.'
});

/**
 * Build the directive appended to the skill prompt for this specific turn.
 *
 * @param {{skill: string, stage?: string|null, action?: string|null}} params
 * @returns {string} '' when the skill prompt alone is enough
 */
function buildDirective({ skill, stage = null, action = null } = {}) {
  const strategy = getStrategy(skill);

  // An explicit Full answer always overrides guided/concise pacing.
  if (action === ACTIONS.FULL_ANSWER) {
    return (
      'RESPONSE MODE: FULL ANSWER (explicitly requested).\n' +
      'The user has explicitly asked for the comprehensive answer, so ignore any ' +
      'instruction to answer one stage at a time and give the complete response now.'
    );
  }

  if (action === ACTIONS.DEEP_DIVE) {
    return (
      'RESPONSE MODE: DEEP DIVE.\n' +
      'Go deeper on the current topic only. Do not move on to a new topic, ' +
      'and do not summarize everything discussed so far.'
    );
  }

  if (strategy !== STRATEGIES.GUIDED) {
    return STRATEGY_DIRECTIVES[strategy] || '';
  }

  const effectiveStage = stage || firstStage(skill);
  const stageList = getStages(skill);
  const position = stageList.indexOf(effectiveStage) + 1;

  const lines = [
    'RESPONSE MODE: GUIDED INTERVIEW.',
    `You are at stage ${position} of ${stageList.length}: ${stageLabel(effectiveStage)}.`,
    'Answer ONLY this stage. Do not produce the entire design in one response. ' +
      'Keep it tight and conversational, the way you would actually speak in an interview.',
    STAGE_DIRECTIVES[effectiveStage] || ''
  ];

  if (action === ACTIONS.ASSUMPTIONS) {
    lines.push(
      'The interviewer has not answered your questions. State the reasonable assumptions ' +
      'you are proceeding with, clearly labeled as assumptions, then continue to this stage.'
    );
  }

  return lines.filter(Boolean).join('\n');
}

module.exports = {
  STRATEGIES,
  SKILL_STRATEGY,
  DEFAULT_STRATEGY,
  SYSTEM_DESIGN_STAGES,
  LLD_STAGES,
  STAGE_LABELS,
  OPTIONAL_STAGES,
  ACTIONS,
  ACTION_LABELS,
  getStrategy,
  isGuided,
  getStages,
  firstStage,
  nextStage,
  isLastStage,
  stageLabel,
  availableActions,
  buildDirective
};

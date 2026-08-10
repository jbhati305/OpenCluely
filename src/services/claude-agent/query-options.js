'use strict';

const { buildChildEnv } = require('./child-env');

/**
 * The locked-down Agent SDK configuration.
 *
 * OpenCluely wants model inference, not an autonomous coding agent. Nothing
 * here should ever be relaxed to "make something work" — if a feature needs a
 * tool, that is a design change, not a config tweak.
 *
 * `allowedTools: []` on its own is not a restriction: unlisted tools fall
 * through to the permission mode. The guarantee comes from the combination of
 * `tools: []`, `permissionMode: 'dontAsk'`, `settingSources: []`,
 * `strictMcpConfig: true` and an explicit deny list.
 */

/**
 * Every built-in tool surface exposed by the installed SDK, including the
 * internal FileRead/FileWrite/FileEdit names behind Read/Write/Edit.
 */
const DISALLOWED_TOOLS = Object.freeze([
  'Agent',
  'Task',
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'FileRead',
  'Write',
  'FileWrite',
  'Edit',
  'FileEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'Skill',
  'SlashCommand',
  'TodoWrite',
  'ExitPlanMode',
  'EnterPlanMode',
  'ListMcpResources',
  'ReadMcpResource',
  'ReadMcpResourceDir',
  'RefreshMcpTools',
  'Mcp',
  'ReportFindings',
  'Artifact',
  'ClaudeDesign',
  'Projects',
  'REPL',
  'Workflow',
  'Monitor',
  'ProposeSkills',
  'SendFeedback',
  'PushNotification',
  'ScheduleWakeup',
  'RemoteTrigger',
  'CronCreate',
  'CronDelete',
  'CronList',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskStop',
  'TaskOutput',
  'EnterWorktree',
  'ExitWorktree',
  'ShowOnboardingRolePicker'
]);

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * @param {object} params
 * @param {string} params.systemPrompt OpenCluely's own prompt — never the claude_code preset
 * @param {string} params.cwd an isolated temp directory, never the repository
 * @param {AbortController} params.abortController
 * @param {NodeJS.ProcessEnv} [params.parentEnv]
 * @param {string} [params.clientApp]
 * @param {string|null} [params.pathToClaudeCodeExecutable]
 * @param {boolean} [params.includePartialMessages]
 */
function buildQueryOptions(params) {
  const {
    systemPrompt,
    cwd,
    abortController,
    parentEnv = process.env,
    clientApp,
    pathToClaudeCodeExecutable = null,
    includePartialMessages = true
  } = params;

  const options = {
    // --- no agent behaviour ---
    tools: [],
    allowedTools: [],
    disallowedTools: [...DISALLOWED_TOOLS],
    permissionMode: 'dontAsk',

    // --- no ambient configuration ---
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,

    // --- single-shot inference only ---
    maxTurns: 1,
    persistSession: false,
    includePartialMessages,

    // --- our prompt, not Claude Code's ---
    systemPrompt,

    // --- isolation and lifecycle ---
    cwd,
    abortController,
    env: buildChildEnv(parentEnv, { clientApp })
  };

  if (pathToClaudeCodeExecutable) {
    options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
  }

  return options;
}

module.exports = {
  DISALLOWED_TOOLS,
  DEFAULT_TIMEOUT_MS,
  buildQueryOptions
};

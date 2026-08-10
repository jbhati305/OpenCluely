# Claude Agent SDK — subscription-backed provider spike

**Branch:** `spike/claude-agent-sdk-subscription` (base `main` @ `2e49cfb`)
**Documentation accessed:** 9 August 2026
**SDK version:** `@anthropic-ai/claude-agent-sdk@0.3.226` (pinned exact; bundles Claude Code 2.1.226)
**Status:** Phase 1 green → Phase 2 implemented, experimental and off by default.

---

## 1. What this is, and what it is not

This branch adds a **local, experimental** AI provider that reuses the Claude
subscription already authenticated through the Claude CLI on this Mac.

It is **not** an approved public subscription integration, and it must not be
presented as one. The distinction below is deliberate and load-bearing.

| Question | Answer |
| --- | --- |
| Is it technically feasible? | **Yes.** Verified end to end (§3). |
| Is the account eligible? | **Yes.** Anthropic's help centre currently states Agent SDK and third-party app usage draw from subscription limits. |
| May it be publicly distributed? | **No — not without Anthropic approval.** See §2. |
| Does it use an API key? | **No.** Provider overrides are stripped from the subprocess environment. |
| Is personal local testing OK? | **Yes**, as the repository owner's own machine and own subscription. |
| What needs approval? | Any public release, upstream PR, or shipping this enabled by default. |

## 2. The policy conflict, stated honestly

Two current Anthropic sources point in different directions.

**Agent SDK overview** ([code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview)), verbatim:

> Unless previously approved, Anthropic does not allow third party developers to
> offer claude.ai login or rate limits for their products, including agents built
> on the Claude Agent SDK. Use the API key authentication methods described in the
> Quickstart instead.

**Help centre** ([support.claude.com article 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)), verbatim header:

> We're pausing the changes to Claude Agent SDK usage described below. For now,
> nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage
> still draw from your subscription's usage limits.

**Reading.** The help centre describes how usage is *metered* today. The SDK
overview describes what third-party developers are *permitted to offer*. They are
not actually about the same thing, and the restrictive one governs distribution.

**Consequence for this repository.** A successful local run proves feasibility
and nothing else. It is **not** evidence that OpenCluely may ship a "Connect your
Claude subscription" feature. Before any public distribution or upstream PR,
one of the following must be true:

1. Anthropic has explicitly approved subscription authentication for this product, or
2. official documentation has changed to clearly permit it.

Until then the provider stays behind a feature gate, defaults to off, and Gemini
remains the default provider.

**Branding.** Anthropic permits "Claude Agent"; it prohibits "Claude Code",
"Claude Code Agent", and visuals that mimic Claude Code. The UI label used here
is **"Claude Agent (local)"**.

**Licensing.** The SDK is governed by Anthropic's Commercial Terms of Service.
The package declares `SEE LICENSE IN README.md` — not an OSI licence — which is a
further reason not to redistribute it in a public build without review.

## 3. Phase 1 evidence

Run with `npm run spike:claude-subscription -- --confirm-subscription-use`.
The script refuses to send anything without that flag.

| Check | Result |
| --- | --- |
| Subscription auth confirmed | `{"authenticated":true,"credentialSource":"subscription","plan":"pro"}` |
| API key in use | None — `stripped env vars: []` (none were set to begin with) |
| Text request | **PASS** — exact sentinel returned, 3777 ms, 25 chars, `claude-sonnet-5` |
| Image request (base64 PNG, 40047 B) | **PASS** — 4429 ms, 167 chars |
| Partial streaming | **PASS** — 2 deltas (text), 3 deltas (image) |
| Timeout → abort | **PASS** — `CLAUDE_TIMEOUT` |
| Orphan Claude processes | **None** |
| Temp directories left behind | **None** |
| Transcripts written to `~/.claude/projects` | **None** |
| Tool executions / permission prompts | **None** |
| Unit tests reaching Anthropic | **Zero** — all inject a fake `query` |

The SDK's **bundled** native executable saw the terminal login directly. The
`pathToClaudeCodeExecutable` fallback was implemented but **not needed**.

## 4. Security model

Every request is built by `src/services/claude-agent/query-options.js`:

```
tools: []                 allowedTools: []          disallowedTools: [51 names]
permissionMode: 'dontAsk' settingSources: []        strictMcpConfig: true
mcpServers: {}            maxTurns: 1               persistSession: false
cwd: <fresh mkdtemp>      systemPrompt: OpenCluely's own (never the claude_code preset)
```

`allowedTools: []` alone is **not** a restriction — unlisted tools fall through to
the permission mode. The guarantee comes from the whole combination above, plus
an explicit deny list covering every built-in tool surface in the installed SDK.

Other boundaries:

- **Billing isolation.** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `..._VERTEX` and `..._FOUNDRY`
  are deleted from the child environment. `process.env` is never mutated. The SDK's
  `env` option *replaces* the subprocess environment rather than merging, so the
  child is built from a copy of the parent.
- **`CLAUDE_CONFIG_DIR` is deliberately left alone** — the default config directory
  is where the existing terminal login lives.
- **No credentials are read, copied, logged or persisted.** `claude auth status`
  returns the account email, org id and org name; the parser discards all three and
  returns only `{authenticated, credentialSource, plan}`.
- **Fail closed.** Anything not positively recognised as a first-party `claude.ai`
  login with a plan is rejected rather than assumed.
- **No embedded login.** OpenCluely never shows a Claude login page, never scrapes
  cookies or browser storage, and never calls `claude auth logout`. Reconnecting is
  the user running `claude auth login` in Terminal themselves.
- **Never logged:** prompt text, image bytes, thinking blocks, model messages,
  account identifiers, raw auth output.

## 5. Phase 2 — the local provider

Enabled only when **both** are set:

```
OPENCLUELY_ENABLE_CLAUDE_SUBSCRIPTION_EXPERIMENTAL=true
AI_PROVIDER=claude-agent
```

The gate is enforced in `resolveProvider()` *and* re-checked in the main-process
IPC handler, so hand-editing `.env` alone cannot activate it. Gemini remains the
default and its code path is untouched.

**Live source-run integration** (`processTextWithSkillStream`, skill `dsa`,
language `python`, no Gemini key configured):

| | |
| --- | --- |
| Active provider | `claude-agent` |
| Response | 159 chars, `claude-sonnet-5`, 4675 ms |
| Streaming | 6 delta events, `deltas.join('') === response` (no duplication) |
| Skill + language | preserved through to the system prompt |
| Flip back to Gemini | works |
| Gate removed while `AI_PROVIDER=claude-agent` | falls back to `gemini` |
| Orphan processes / temp dirs / transcripts after the run | none |

**No automatic fallback.** If Claude fails, the error surfaces with a stable
code. It never silently retries through Gemini — that would send screen contents
to a provider the user did not choose, or bill a request they did not authorise.

**Concurrency.** One query at a time; a second is refused with `CLAUDE_BUSY`
rather than queued. `shutdown()` is registered as a lifecycle disposer, so app
quit aborts anything in flight.

**Settings UI.** Section is hidden unless the gate is on. It offers Refresh, Test
Connection, the sanitized plan, and instructions to run `claude auth login` in
Terminal. It has **no** password field, token field, embedded login or logout
button, and is labelled "Claude Agent (local)" — never "Claude Code".

**Packaging.** The native binary cannot execute from inside `app.asar`, so
`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` is added to
`asarUnpack` — that single path, not all of `node_modules`.

> ⚠️ **Size.** That binary is **272 MB**. It will increase the DMG substantially.
> Worth deciding whether the experiment should ship in packaged builds at all,
> or stay a source-run-only capability.

## 5a. Persistent conversation (verified)

`scripts/claude-multiturn-probe.mjs` proved that ONE `query()` invocation can
hold a real multi-turn conversation — **10/10 checks**:

- one query accepts sequential user messages through an async input queue
- context survives text → image → text (the same number was recalled after an
  image turn)
- each user turn produces its own `result` boundary (4 results for 4 turns)
- every turn streams partial deltas
- all turns share one session id
- no tool use, `persistSession: false`, nothing written to `~/.claude/projects`
- temp cwd removed, no orphan process

`ClaudeConversation` (`src/services/claude-agent/conversation.js`) implements
this: one input queue, one long-lived iterator, one temp cwd for the
conversation's lifetime, one active turn at a time, and a generation counter so
output from a cancelled/cleared/replaced session can never reach the UI.

Because Claude now holds the context, OpenCluely's history is **no longer
prefixed onto every request** — only onto the first turn that seeds a new
conversation. SessionManager remains the source of truth for the UI transcript.

The conversation is reset on: the chat bin, the clear-session shortcut, a skill
change (the system prompt is fixed per conversation), an executable change, the
integration being disabled, a turn failure, and app quit.

## 5b. Local build command

`npm run build:mac:local-claude` produces a **personal, local-only** artifact.
It refuses `--publish` outright rather than forwarding it, and prints a banner
saying the artifact must not be distributed. The normal release flow
(`npm run release:mac`) is untouched.

The integration still ships **disabled**; the user opts in from Settings, which
persists to the userData-backed `.env` — so an installed DMG launched from
Finder needs no shell variables.

## 6. What is left unproven

- **Packaged-app behaviour.** Phase 2 unpacks the native binary from the ASAR, but
  a signed `.dmg` has not been built or installed on this branch.
- **Long-run subprocess behaviour** under repeated real use.
- Whether Anthropic would approve this for distribution — unknown, and not
  something a code change can settle.

## 7. Files

| File | Role |
| --- | --- |
| `src/services/claude-agent/errors.js` | Stable error codes; only `{code, message}` crosses IPC |
| `src/services/claude-agent/child-env.js` | Billing-source isolation |
| `src/services/claude-agent/auth.js` | Sanitized auth status; fails closed |
| `src/services/claude-agent/query-options.js` | The lockdown |
| `src/services/claude-agent/messages.js` | Text and base64-image `SDKUserMessage` builders |
| `src/services/claude-agent/stream.js` | Delta extraction, duplicate suppression, tool refusal |
| `src/services/claude-agent/runner.js` | One query: temp cwd, timeout, abort, cleanup, CJS→ESM boundary |
| `scripts/claude-agent-sdk-smoke.mjs` | Opt-in live probe (not in `npm test`) |
| `test/claude-agent.test.js` | 33 tests, zero network calls |

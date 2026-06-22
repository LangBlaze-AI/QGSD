# Skill Authoring Rules

Conventions for `commands/nf/*.md` skills and `core/workflows/*.md` workflows.
Enforced by `scripts/lint-isolation.js` (the required "Lint" CI check).

## Inline `node` evals: env and args go BEFORE the command

When a skill embeds an inline eval, **nothing may trail `node -e "<js>"`** except a
redirect/operator/closer (`2>`, `>`, `<`, `|`, `&&`, `||`, `;`, `)`, …).

```bash
# WRONG — shell assignments AFTER a command are positional argv, not env, so
# process.env.AGENT is undefined (the recurring F1 bug):
RESULT=$(node -e "const a = process.env.AGENT; …" AGENT="$AGENT")

# WRONG — args after the eval break when the eval-guard rewrites `node -e` to a
# quoted heredoc; the terminator line is no longer alone (the F21 bug):
node -e "const x = process.argv[1]; …" -- "$REQ_ID"

# RIGHT — assign env BEFORE node and read it with process.env:
RESULT=$(AGENT="$AGENT" node -e "const a = process.env.AGENT; …")
NF_REQ_ID="$REQ_ID" node -e "const x = process.env.NF_REQ_ID; …"
```

**Why:** in the shell, `VAR=value` *after* a command is an argument to that command,
not a temporary environment assignment — only assignments *before* the command name
set the environment. Separately, the `nf-node-eval-guard` PreToolUse hook rewrites
`node -e "…"` to a `node << 'NF_EVAL' … NF_EVAL` heredoc at runtime; any token after
the original eval ends up after the heredoc terminator and breaks it. Putting env
before `node` and reading `process.env.*` is correct under both the raw and the
rewritten form.

The detector lives in `bin/skill-eval-lint.cjs` (`findEvalTrailingViolations`) and is
unit-tested in `bin/skill-eval-lint.test.cjs`. To check locally: `npm run lint:isolation`.

## Portable paths (see also Rules 1–4 in `scripts/lint-isolation.js`)

- Require installed scripts via `$HOME/.claude/nf-bin/<name>` with a `./bin/<name>` CWD fallback.
- Never hardcode `/Users/<name>/.claude` or `/home/<name>/.config`; use `~/` or `$HOME`.
- Don't reference `get-shit-done/` segments; use `~/.claude/nf/`.

## MCP tool names (enforced — lint-isolation Rule 6)

For the four CLI quorum families (`codex`, `gemini`, `copilot`, `opencode`):

- Use the real `<family>-<N>` slot name — `mcp__codex-1__codex`, `mcp__gemini-1__gemini`,
  `mcp__copilot-1__copilot`, `mcp__opencode-1__opencode`. **Never** the CLI-style aliases
  `mcp__gemini-cli__…`, `mcp__codex-cli__…`, `mcp__copilot-cli__…`, or a bare
  `mcp__opencode__…` — those slots don't exist, so every worker silently fails to find its
  tool and the quorum/debug table renders all-UNAVAIL.
- Use a tool the server actually exposes — e.g. copilot has `copilot`/`suggest`/`explain`,
  there is **no `ask` tool**. (`bin/skill-mcp-lint.cjs` holds the per-family tool surface.)
- This applies in prose/examples too (so a "don't use the Skill tool" note still names the
  real tools). Template placeholders — `mcp__<slot>__identity`, `mcp__<$AGENT>__identity` —
  are exempt (the skill substitutes them at runtime).

Install-specific (`claude-*`, `ccr-*`) and external (`context7`, `sentry`, `plugin_*`) slots
are NOT validated — their names/tools aren't fixed. When a skill calls `mcp__<slot>__identity`
**directly** (not via a Task sub-agent), the slot must also be in the skill's `allowed-tools`
frontmatter or the call is blocked.

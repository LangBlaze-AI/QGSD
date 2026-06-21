---
name: nf:tokens
description: Display token usage dashboard with cost breakdown per slot and session.
argument-hint: "[--last N] [--json] [--jsonl PATH]"
allowed-tools: []
---

# /nf:tokens

Display token usage dashboard with cost breakdown per slot and session.

## Usage

Run the token dashboard:
```bash
node bin/token-dashboard.cjs
```

### Options
- `--last N` -- Show last N sessions (default: 5)
- `--json` -- Output as JSON instead of formatted table
- `--jsonl PATH` -- Path to token-usage.jsonl (default: .planning/telemetry/token-usage.jsonl, falling back to the legacy `.planning/token-usage.jsonl`)

## Examples

Show default dashboard:
```bash
node bin/token-dashboard.cjs
```

Show last 10 sessions as JSON:
```bash
node bin/token-dashboard.cjs --last 10 --json
```

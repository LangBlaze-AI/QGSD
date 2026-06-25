---
name: nf:coderlm
description: Manage the coderlm symbol server lifecycle and query its symbol index — callers, implementation location, associated tests, and source peek.
argument-hint: "<start|stop|status|update|callers|implementation|tests|peek>"
allowed-tools:
  - Bash
  - Read
---

<objective>
Manage the coderlm symbol server lifecycle. The coderlm server indexes source code symbols and call graphs for graph-driven wave scheduling in nf:solve. It auto-starts during nf:solve runs, but this skill provides manual control for starting, stopping, checking status, and updating the binary. It also exposes query subcommands for looking up callers, implementation locations, associated tests, and source line ranges.
</objective>

<process>

**Step 1: Parse subcommand**

Parse the first argument as the subcommand. Valid subcommands: `start`, `stop`, `status`, `update`, `callers`, `implementation`, `tests`, `peek`.

If no argument is provided or the argument is not recognized, display:

```
/nf:coderlm -- Manage the coderlm symbol server

Usage:
  /nf:coderlm start    Start the server (downloads binary if needed)
  /nf:coderlm stop     Stop the running server
  /nf:coderlm status   Show server status (binary, process, health, idle)
  /nf:coderlm update   Update to the latest release (stop + re-download + start)

  /nf:coderlm callers <symbol> [file]           List all callers of a symbol
  /nf:coderlm implementation <symbol>           Show where a symbol is defined (file + line)
  /nf:coderlm tests <file>                      Show test files associated with a source file
  /nf:coderlm peek <file> <startLine> <endLine> Show source lines from a file

The server auto-starts during nf:solve runs. Manual control is optional.
```

**Step 2: Execute subcommand**

**start:**

```bash
node bin/coderlm-lifecycle.cjs --start
```

Parse JSON output. Report:
- Binary path (downloaded or cached)
- PID and whether it was already running or freshly started
- If failed, suggest checking `gh auth status` (for download issues) or disk space

**stop:**

```bash
node bin/coderlm-lifecycle.cjs --stop
```

Parse JSON output. Report: stopped, already-dead, or not-running.

**status:**

```bash
node bin/coderlm-lifecycle.cjs --status
```

Parse JSON output. Render a formatted status report:

```
coderlm Status
  Binary:  installed at ~/.claude/nf-bin/coderlm (or: not installed)
  Process: running (PID 12345) (or: not running)
  Health:  healthy, 12ms latency (or: unhealthy -- ECONNREFUSED)
  Idle:    2m 30s since last query (auto-stop at 5m)
```

**update:**

```bash
node bin/coderlm-lifecycle.cjs --update
```

This stops the running server (if any), deletes the cached binary, and re-downloads the latest release. Parse JSON output and report the result.

**Query subcommands (callers, implementation, tests, peek):**

Before executing any query subcommand, ensure coderlm is running:

```bash
node bin/coderlm-lifecycle.cjs --start
```

Parse JSON output. If `ok: false` or the lifecycle start failed, report the error (include the `error` field from JSON output) and suggest running `/nf:coderlm status` for diagnostics. Do NOT proceed with the query if the server could not start.

If `ok: true` and `already_running: true`, skip the start message (server was already up).
If `ok: true` and `already_running: false`, note: "coderlm started (PID <pid>)".

**callers:**

Usage: `/nf:coderlm callers <symbol> [file]`

- `symbol` — required. The function or symbol name to look up.
- `file` — optional. Source file path to narrow the lookup (e.g., `bin/nf-solve.cjs`).

Set the symbol and file as environment variables, then run:

```bash
NF_CODERLM_SYMBOL="<symbol>"
NF_CODERLM_FILE="<file>"
node << 'NF_EVAL'
const adapterPath = (require('fs').existsSync(process.env.HOME + '/.claude/nf-bin/coderlm-adapter.cjs') ? process.env.HOME + '/.claude/nf-bin/coderlm-adapter.cjs' : './bin/coderlm-adapter.cjs');
let adapter;
try { adapter = require(adapterPath).createAdapter(); }
catch (e) { require('fs').writeSync(1, JSON.stringify({error: String(e)})); process.exit(0); }
const symbol = process.env.NF_CODERLM_SYMBOL;
const file = process.env.NF_CODERLM_FILE || undefined;
adapter.getCallers(symbol, file).then(r => {
  process.stdout.write(JSON.stringify(r));
}).catch(e => process.stdout.write(JSON.stringify({error: String(e)})));
NF_EVAL
```

Parse JSON output. Display results:

```
Callers of <symbol>:
  - path/to/caller1.js
  - path/to/caller2.js
  (N callers found)
```

If `result.error` is set, display:
```
Query failed: <error>
  Hint: Check server health with /nf:coderlm status
```

If `result.callers` is an empty array, display: "No callers found for <symbol>."

**implementation:**

Usage: `/nf:coderlm implementation <symbol>`

- `symbol` — required. The function or type name to locate.

Set the symbol as an environment variable, then run:

```bash
NF_CODERLM_SYMBOL="<symbol>"
node << 'NF_EVAL'
const adapterPath = (require('fs').existsSync(process.env.HOME + '/.claude/nf-bin/coderlm-adapter.cjs') ? process.env.HOME + '/.claude/nf-bin/coderlm-adapter.cjs' : './bin/coderlm-adapter.cjs');
let adapter;
try { adapter = require(adapterPath).createAdapter(); }
catch (e) { require('fs').writeSync(1, JSON.stringify({error: String(e)})); process.exit(0); }
const symbol = process.env.NF_CODERLM_SYMBOL;
adapter.getImplementation(symbol).then(r => {
  process.stdout.write(JSON.stringify(r));
}).catch(e => process.stdout.write(JSON.stringify({error: String(e)})));
NF_EVAL
```

Parse JSON output. Display result:

```
Implementation of <symbol>:
  File: <result.file>
  Line: <result.line>
```

If `result.error` is set, display the error with the same hint as callers.
If `result.file` is absent, display: "Implementation location not found for <symbol>."

**tests:**

Usage: `/nf:coderlm tests <file>`

- `file` — required. The source file path (e.g., `bin/coderlm-adapter.cjs`).

Set the file as an environment variable, then run:

```bash
NF_CODERLM_FILE="<file>"
node << 'NF_EVAL'
const adapterPath = (require('fs').existsSync(process.env.HOME + '/.claude/nf-bin/coderlm-adapter.cjs') ? process.env.HOME + '/.claude/nf-bin/coderlm-adapter.cjs' : './bin/coderlm-adapter.cjs');
let adapter;
try { adapter = require(adapterPath).createAdapter(); }
catch (e) { require('fs').writeSync(1, JSON.stringify({error: String(e)})); process.exit(0); }
const file = process.env.NF_CODERLM_FILE;
adapter.findTests(file).then(r => {
  process.stdout.write(JSON.stringify(r));
}).catch(e => process.stdout.write(JSON.stringify({error: String(e)})));
NF_EVAL
```

Parse JSON output. Display results:

```
Tests associated with <file>:
  - path/to/test1.cjs
  - path/to/test2.cjs
  (N test file(s) found)
```

If `result.error` is set, display error with hint.
If `result.tests` is an empty array, display: "No associated test files found for <file>."

**peek:**

Usage: `/nf:coderlm peek <file> <startLine> <endLine>`

- `file` — required. File path to read from.
- `startLine` — required. First line number (1-indexed).
- `endLine` — required. Last line number (inclusive).

Validate that `startLine` and `endLine` are integers and `startLine <= endLine`. If not, display usage error.

Set arguments as environment variables, then run:

```bash
NF_CODERLM_FILE="<file>"
NF_CODERLM_START="<startLine>"
NF_CODERLM_END="<endLine>"
node << 'NF_EVAL'
const adapterPath = (require('fs').existsSync(process.env.HOME + '/.claude/nf-bin/coderlm-adapter.cjs') ? process.env.HOME + '/.claude/nf-bin/coderlm-adapter.cjs' : './bin/coderlm-adapter.cjs');
let adapter;
try { adapter = require(adapterPath).createAdapter(); }
catch (e) { require('fs').writeSync(1, JSON.stringify({error: String(e)})); process.exit(0); }
const file = process.env.NF_CODERLM_FILE;
const startLine = parseInt(process.env.NF_CODERLM_START, 10);
const endLine = parseInt(process.env.NF_CODERLM_END, 10);
adapter.peek(file, startLine, endLine).then(r => {
  process.stdout.write(JSON.stringify(r));
}).catch(e => process.stdout.write(JSON.stringify({error: String(e)})));
NF_EVAL
```

Parse JSON output. Display source lines in a fenced block:

```
<file> lines <startLine>–<endLine>:

  <startLine> | <line content>
  <startLine+1> | <line content>
  ...
  <endLine> | <line content>
```

If `result.error` is set, display error with hint.
If `result.lines` is empty, display: "No lines returned for <file>:<startLine>-<endLine>."

**Step 3: Report result**

Display the outcome to the user in a clear format. If any step failed, include diagnostic information and suggested next steps.

</process>

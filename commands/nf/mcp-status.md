---
name: nf:mcp-status
description: Show status of all connected quorum agents — provider, model, health, and latency
allowed-tools:
  - Read
  - Bash
  - Task
  - mcp__codex-1__identity
  - mcp__gemini-1__identity
  - mcp__opencode-1__identity
  - mcp__copilot-1__identity
  - mcp__claude-1__identity
  - mcp__ccr-1__identity
  - mcp__ccr-2__identity
  - mcp__ccr-3__identity
  - mcp__ccr-4__identity
  - mcp__ccr-5__identity
  - mcp__ccr-6__identity
  - mcp__codex-1__health_check
  - mcp__gemini-1__health_check
  - mcp__opencode-1__health_check
  - mcp__copilot-1__health_check
  - mcp__claude-1__health_check
  - mcp__ccr-1__health_check
  - mcp__ccr-2__health_check
  - mcp__ccr-3__health_check
  - mcp__ccr-4__health_check
  - mcp__ccr-5__health_check
  - mcp__ccr-6__health_check
---

<objective>
Display a clean status table of all configured MCP quorum agents plus the Claude orchestrator. Slot names and types are read dynamically from ~/.claude.json at runtime — no slot names are hardcoded in this skill. For each non-skip slot: call its identity tool and health_check for real model names and latency. Read provider URLs from ~/.claude.json. Show a claude orchestrator row at the top of the table.

This command is read-only (observation only). It does NOT invoke quorum and is NOT in quorum_commands.
</objective>

<process>

> **IMPORTANT: Run every Bash call in this workflow sequentially (one at a time). Never issue two Bash calls in parallel. A failure in one parallel sibling cancels all other parallel siblings — sequential execution isolates failures. For each numbered step below: run this Bash command alone, wait for its full output, store the result, then proceed to the next step.**

## Step 1: Read scoreboard + provider URLs (run this Bash command first, wait for output before proceeding to Step 2)

Run the following Bash command and store the output as INIT_INFO:

```bash
node << 'EOF'
const fs=require('fs'), path=require('path'), os=require('os');

// Scoreboard
const sbPath=path.join(process.cwd(),'.planning','quorum','scoreboard.json');
let totalRounds=0, lastUpdate=null;
if(fs.existsSync(sbPath)){
  const d=JSON.parse(fs.readFileSync(sbPath,'utf8'));
  totalRounds=(d.rounds||[]).length;
  lastUpdate=d.team?.captured_at||null;
}

// Provider URLs from ~/.claude.json
const URL_MAP={
  'https://api.akashml.com/v1':           'AkashML',
  'https://api.together.xyz/v1':          'Together.xyz',
  'https://api.fireworks.ai/inference/v1':'Fireworks',
};
const cfgPath=path.join(os.homedir(),'.claude.json');
const providers={};
if(fs.existsSync(cfgPath)){
  const cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
  for(const [key,val] of Object.entries(cfg.mcpServers||{})){
    const url=(val.env||{}).ANTHROPIC_BASE_URL||null;
    providers[key]=url?URL_MAP[url]||url:null;
  }
}

// Claude orchestrator model from ~/.claude/settings.json
const claudeSettingsPath=path.join(os.homedir(),'.claude','settings.json');
let claudeModel='claude-sonnet-4-6'; // default
if(fs.existsSync(claudeSettingsPath)){
  try {
    const cs=JSON.parse(fs.readFileSync(claudeSettingsPath,'utf8'));
    const raw=(cs.model||'sonnet').toLowerCase();
    if(raw.includes('opus')) claudeModel='claude-opus-4-6';
    else if(raw.includes('haiku')) claudeModel='claude-haiku-4-5-20251001';
    else claudeModel='claude-sonnet-4-6';
  } catch(_){}
}

// Claude orchestrator auth type — oauthAccount present = subscription (sub), absent = API key (api)
let claudeAuth='api'; // default: API key
if(fs.existsSync(cfgPath)){
  try {
    const cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
    if(cfg.oauthAccount && typeof cfg.oauthAccount==='object') claudeAuth='sub';
  } catch(_){}
}

// Classify slots dynamically
const SKIP_SLOTS = ['canopy', 'sentry'];
const CLI_COMMANDS = ['codex', 'gemini', 'opencode', 'gh', 'copilot'];
let slots = { cli: [], http: [], mcp: [], skip: [] };
try {
  if(fs.existsSync(cfgPath)){
    const cfg2=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
    for(const [name,val] of Object.entries(cfg2.mcpServers||{})){
      if(SKIP_SLOTS.includes(name)){ slots.skip.push(name); continue; }
      const env=val.env||{};
      if(env.ANTHROPIC_BASE_URL){ slots.http.push(name); }
      else if(CLI_COMMANDS.some(c=>(val.command||'').includes(c))){ slots.cli.push(name); }
      else if(val.command==='node'&&(val.args||[]).some(a=>/\.(mjs|cjs|js)$/.test(a))){ slots.mcp.push(name); }
      else{ slots.skip.push(name); }
    }
  }
} catch(_){ slots = { cli: [], http: [], mcp: [], skip: [] }; }

console.log(JSON.stringify({totalRounds,lastUpdate,providers,claudeModel,claudeAuth,slots}));
EOF
```

Parse `totalRounds`, `lastUpdate`, `providers` (map of slot → provider name or null), `claudeModel`, `claudeAuth`, and `slots` (cli/http/mcp/skip arrays).

**Provider for CLI agents** — prefer `identity.display_provider` when present. If absent, infer from model name:
- `gpt-*` or `o[0-9]*` → OpenAI
- `gemini-*` → Google
- `claude-*` → Anthropic
- `opencode*` or `grok*` → OpenCode
- default → —

**Auth type** — read from identity response `auth_type` field if present. If absent, infer:
- CLI slots → `sub` (subscription — flat fee, no per-token cost)
- HTTP/MCP slots → `api` (API token — pay per request)

Display as `sub` or `api` in the Auth column.

## Step 2: Display banner

From INIT_INFO.slots, compute a count description and print the banner:

```bash
node -e "
const s=JSON.parse(process.argv[1]);
const cli=s.cli.length, http=s.http.length, mcp=s.mcp.length;
const parts=[];
if(cli>0) parts.push(cli+' CLI agent'+(cli>1?'s':''));
if(http>0) parts.push(http+' HTTP provider'+(http>1?'s':''));
if(mcp>0) parts.push(mcp+' local MCP slot'+(mcp>1?'s':''));
const countStr=parts.join(' + ')||'no quorum slots';
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' nForma ► MCP STATUS');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('Querying '+countStr+'...');
" '${JSON.stringify(INIT_INFO.slots)}'
```

## Step 3: Collect identity + health_check results via sub-agent (run after Step 2 output is stored)

Build the slot list from INIT_INFO.slots (all non-skip slots across cli, http, and mcp arrays):

```
const allSlots = [...INIT_INFO.slots.cli, ...INIT_INFO.slots.http, ...INIT_INFO.slots.mcp];
```

If allSlots is empty (no non-skip slots configured), skip this sub-agent call entirely and proceed to Step 5 with an empty AGENT_RESULTS object ({}).

Otherwise, invoke a Task() sub-agent with the following dynamically-constructed prompt (substitute allSlots at runtime):

```
Task(
  subagent_type: "general-purpose",
  model: "claude-haiku-4-5",
  prompt: `
You are a data-collection sub-agent. Your only job is to call the MCP tools listed below and return their results as a single JSON object. Do not explain or summarize — return only the JSON object.

The configured quorum slots are: ${JSON.stringify(allSlots)}

Call identity and health_check for each slot listed above. Use tool names in the format mcp__<slot>__identity and mcp__<slot>__health_check. Tool names preserve hyphens: for slot 'ccr-1' call mcp__ccr-1__identity and mcp__ccr-1__health_check (NOT mcp__ccr_1__identity).

Call each tool with {} as input. Wrap every call in try/catch — if a tool throws or is unavailable, record null for that field.

Call all tools one at a time, sequentially — never parallel.

Return ONLY this JSON structure (no markdown, no explanation):
{
  "<slot>": { "identity": <identity result or null>, "hc": <health_check result or null> },
  ...one entry per slot in the list above...
}

Where each identity value is the raw object returned by the tool (with at minimum version and model fields), and each hc value is the raw object returned by health_check (with healthy, latencyMs, and optionally model, via fields).
`
)
```

Store the sub-agent's returned JSON object as AGENT_RESULTS (parse from the sub-agent's text output). Keys are slot names as provided in allSlots.

## Step 4: Derive health state per agent

For each slot in AGENT_RESULTS, look up its type from INIT_INFO.slots to branch on health logic:

**For slots in INIT_INFO.slots.cli — identity + health_check based:**
- If identity call threw an exception → health = `error`, latency = `—`
- Else if `hc` is null (health_check threw or timed out) → health = `available`, latency = `—`
- Else if `!hc.healthy` → health = `unhealthy`, latency = `${hc.latencyMs}ms`
- Else → health = `available`, latency = `${hc.latencyMs}ms`

Model for CLI slots: use `identity.model` if present, else `identity.display_provider ?? identity.provider`.

**For slots in INIT_INFO.slots.http or INIT_INFO.slots.mcp — live health_check result:**
- If identity call threw an exception → health = `error`, latency = `—`
- Else if `hc` is null (health_check threw or timed out) → health = `unreachable`, latency = `—`
- Else if `hc.healthy === false` → health = `unhealthy`, latency = `${hc.latencyMs}ms`
- Else if `hc.via === 'fallback'` → health = `fallback`, latency = `${hc.latencyMs}ms`
- Else → health = `available`, latency = `${hc.latencyMs}ms`

When `hc.via === 'fallback'`, the displayed Model should be `hc.model` (the fallback model).

## Step 5: Render formatted table

Collect all results then render **one table** via a single Bash call (do not print rows one at a time). Pass the collected data as a JSON string into the script.

Columns: **Agent | Auth | Provider | Model | Health | Latency**

Auto-size each column to the widest value (including header). Use box-drawing characters for borders.

Before rendering, prepend a claude orchestrator row at the TOP of the table. This row does NOT come from AGENT_RESULTS — it comes from INIT_INFO:
- Agent: `claude`
- Auth: `claudeAuth` (from INIT_INFO — derived from `oauthAccount.billingType` in `~/.claude.json`; `sub` for stripe_subscription/pro, `api` if `ANTHROPIC_API_KEY` is set or billingType indicates API billing)
- Provider: `Anthropic`
- Model: `claudeModel` (from INIT_INFO, e.g. `claude-sonnet-4-6`)
- Health: `orchestrator`
- Latency: `—`

Rows come from all non-skip slots: iterate over [...INIT_INFO.slots.cli, ...INIT_INFO.slots.http, ...INIT_INFO.slots.mcp] in that order. Auth column: cli slots → `sub`, http/mcp slots → `api`.

Example output format:

```
┌─────────────┬──────┬──────────────┬───────────────────────────────────────────────────┬──────────────┬─────────┐
│ Agent       │ Auth │ Provider     │ Model                                             │ Health       │ Latency │
├─────────────┼──────┼──────────────┼───────────────────────────────────────────────────┼──────────────┼─────────┤
│ claude      │ sub  │ Anthropic    │ claude-sonnet-4-6                                 │ orchestrator │ —       │
│ codex-1     │ sub  │ OpenAI       │ gpt-5.4                                           │ available    │ 245ms   │
│ gemini-1    │ sub  │ Google       │ gemini-3-flash-preview                            │ available    │ 312ms   │
│ opencode-1  │ sub  │ OpenCode     │ grok-code-fast-1                                  │ available    │ 891ms   │
│ copilot-1   │ sub  │ GitHub       │ gpt-4.1                                           │ available    │ 1204ms  │
│ claude-1    │ sub  │ Anthropic    │ claude-opus-4-6                                   │ available    │ 524ms   │
│ ccr-1       │ api  │ Together.xyz │ MiniMaxAI/MiniMax-M2.5                            │ available    │ 735ms   │
│ ccr-2       │ api  │ Together.xyz │ Qwen/Qwen3.5-397B-A17B                            │ available    │ 761ms   │
│ ccr-3       │ api  │ Together.xyz │ Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8           │ available    │ 680ms   │
│ ccr-4       │ api  │ Together.xyz │ moonshotai/Kimi-K2.5                              │ available    │ 1828ms  │
│ ccr-5       │ api  │ Together.xyz │ openai/gpt-oss-120b                               │ available    │ 920ms   │
│ ccr-6       │ api  │ Together.xyz │ zai-org/GLM-5.1                                   │ available    │ 312ms   │
└─────────────┴──────┴──────────────┴───────────────────────────────────────────────────┴──────────────┴─────────┘

Scoreboard: 156 rounds recorded | Last update: 2026-02-23T14:23:52.301Z
```

If scoreboard file was absent, show instead:
```
Scoreboard: no data yet (run /nf:quorum first to populate)
```

Health legend:
- `available`   — agent responded (identity succeeded; for HTTP: health_check passed)
- `fallback`    — primary endpoint failed; fallback provider (ANTHROPIC_FALLBACK_BASE_URL) responded successfully
- `unhealthy`   — HTTP endpoint returned healthy=false
- `unreachable` — HTTP health_check call failed (timeout, connection error)
- `error`       — identity call failed (agent not running or crashed)

</process>

<success_criteria>
- All non-skip configured slots shown in one clean table (1 orchestrator row + all cli/http/mcp slots discovered from ~/.claude.json)
- Columns: Agent | Auth | Provider | Model | Health | Latency (no UNAVAIL column)
- `claude` orchestrator row shown at top of table with model read from `~/.claude/settings.json`
- CLI agents show real model names (gpt-5.3-codex, gemini-2.5-pro, xai/grok-3, gpt-4.1) not binary names
- CLI agents show real latency in ms from `health_check` --version call
- CLI agent Provider column uses `identity.display_provider` (OpenAI, Google, OpenCode, GitHub)
- Provider derived from ~/.claude.json ANTHROPIC_BASE_URL for HTTP agents; identity.display_provider for CLI agents
- Health for CLI agents reflects identity + health_check result (available/unhealthy/error)
- Health for claude-1..6 is live from health_check result; `fallback` shown when primary failed but fallback responded
- Model column shows fallback model name (hc.model) when via=fallback, so it always reflects what actually served the check
- Latency shows ms for all agents with health_check, — for claude orchestrator row
- Command handles missing scoreboard gracefully (no crash)
- Command handles individual agent failures gracefully (no crash)
- Table rendered in a single Bash call at the end, not printed row-by-row
</success_criteria>

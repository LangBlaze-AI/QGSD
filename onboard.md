# nForma — Agent Onboarding Instructions

> **You are a coding agent.** The user gave you this file so you can help them install and set up nForma. Follow the steps below. Be conversational, concise, and always ask before running commands.

---

## What is nForma?

nForma is a project management layer for coding agents. It adds structured workflows, multi-model quorum review, and milestone-based planning. The installer is in this repo at `bin/install.js`.

**Quorum** is the key feature: multiple AI models (via their native CLIs) independently review your plans and code, then nForma synthesizes consensus. More diverse models = fewer blind spots.

---

## Step 1: Detect everything

Run this single diagnostic. It checks the nForma install state, every supported CLI, their auth status, and existing MCP configuration:

```bash
node << 'NF_DETECT'
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const result = { nforma: {}, clis: {}, mcp: {}, project: {} };

// ── nForma install state ──
const claudeDir = path.join(os.homedir(), '.claude');
result.nforma.commands_synced = fs.existsSync(path.join(claudeDir, 'commands', 'nf'));
result.nforma.hooks_synced = fs.existsSync(path.join(claudeDir, 'hooks'));
result.nforma.nf_bin = fs.existsSync(path.join(claudeDir, 'nf-bin'));
try {
  const nfJson = JSON.parse(fs.readFileSync(path.join(claudeDir, 'nf.json'), 'utf8'));
  result.nforma.quorum_active = nfJson.quorum_active || [];
  result.nforma.hook_profile = nfJson.hook_profile || 'standard';
} catch (e) {
  result.nforma.quorum_active = [];
  result.nforma.hook_profile = null;
}

// ── CLI detection helper ──
function detectCli(name, versionArgs, authCheck) {
  const info = { installed: false, version: null, path: null, authenticated: null };
  try {
    const w = spawnSync('which', [name], { encoding: 'utf8', timeout: 3000 });
    if (w.status === 0 && w.stdout.trim()) {
      info.installed = true;
      info.path = w.stdout.trim();
    }
  } catch (e) {}
  if (!info.installed) return info;
  // Version
  try {
    const v = spawnSync(name, versionArgs, { encoding: 'utf8', timeout: 5000 });
    const out = (v.stdout || '') + (v.stderr || '');
    const m = out.match(/(\\d+\\.\\d+[\\w.\\-]*)/);
    info.version = m ? m[1] : 'unknown';
  } catch (e) {}
  // Auth
  if (authCheck) {
    try {
      const a = spawnSync(authCheck.cmd, authCheck.args, { encoding: 'utf8', timeout: 5000 });
      const out = (a.stdout || '') + (a.stderr || '');
      info.authenticated = new RegExp(authCheck.pattern).test(out);
    } catch (e) { info.authenticated = false; }
  }
  return info;
}

// ── Detect each supported CLI ──

// Codex (OpenAI)
result.clis.codex = detectCli('codex', ['--version'], {
  cmd: 'codex', args: ['login', 'status'], pattern: 'Logged in'
});

// Gemini (Google)
result.clis.gemini = detectCli('gemini', ['--version'], {
  cmd: 'gemini', args: ['auth', 'print-access-token'], pattern: 'Loaded cached credentials|ya29\\\\.'
});

// OpenCode (xAI)
result.clis.opencode = detectCli('opencode', ['--version'], {
  cmd: 'opencode', args: ['auth', 'list'], pattern: 'api|oauth'
});

// GitHub Copilot (via gh)
const ghInfo = detectCli('gh', ['--version'], null);
if (ghInfo.installed) {
  // Check if copilot extension is installed
  try {
    const ext = spawnSync('gh', ['copilot', '--version'], { encoding: 'utf8', timeout: 5000 });
    let authed = null;
    try {
      const auth = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 5000 });
      const authOut = (auth.stdout || '') + (auth.stderr || '');
      authed = auth.status === 0 && /logged in|active account/i.test(authOut);
    } catch (e) { authed = false; }
    result.clis.copilot = {
      installed: ext.status === 0,
      version: ghInfo.version,
      path: ghInfo.path,
      authenticated: ext.status === 0 ? authed : null,
      note: ext.status === 0 ? 'gh copilot extension installed' : 'gh installed but copilot extension missing'
    };
  } catch (e) {
    result.clis.copilot = { installed: false, version: null, path: null, authenticated: null, note: 'gh installed but copilot check failed' };
  }
} else {
  result.clis.copilot = { installed: false, version: null, path: null, authenticated: null };
}

// Claude CLI (Anthropic)
result.clis.claude = detectCli('claude', ['--version'], null);

// Claude Code Router (CCR) — wraps Claude CLI with open-weight model presets
result.clis.ccr = detectCli('ccr', ['-v'], null);

// ── MCP servers already configured ──
const claudeJsonPath = path.join(os.homedir(), '.claude.json');
try {
  const cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  const servers = cj.mcpServers || {};
  result.mcp.configured = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || !cfg.command) continue;
    const cmd = cfg.command || '';
    const args = (cfg.args || []).join(' ');
    const combined = (cmd + ' ' + args).toLowerCase();

    let type = 'unknown';
    if (combined.includes('unified-mcp-server')) type = 'nforma-unified';
    else if (combined.includes('claude-code-router') || combined.includes('/ccr')) type = 'ccr';
    else if (combined.includes('codex')) type = 'codex';
    else if (combined.includes('gemini')) type = 'gemini';
    else if (combined.includes('opencode')) type = 'opencode';
    else if (combined.includes('copilot')) type = 'copilot';
    else if (combined.includes('claude-mcp-server')) type = 'claude-mcp-server';
    else if (combined.includes('claude')) type = 'claude';

    // Extract model if present in env
    const model = (cfg.env && (cfg.env.CLAUDE_DEFAULT_MODEL || cfg.env.MODEL)) || null;

    result.mcp.configured.push({ name, type, model });
  }
  result.mcp.count = result.mcp.configured.length;
} catch (e) {
  result.mcp.configured = [];
  result.mcp.count = 0;
}

// ── Daintree (formerly Canopy) IDE detection ──
function daintreeConfigPath(productName) {
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', productName, 'config.json');
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), productName, 'config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), productName, 'config.json');
}
const dPath = daintreeConfigPath('Daintree');
const cPath = daintreeConfigPath('canopy-app');
let detectedPath = null, detectedProduct = null, customPresetCount = 0;
if (fs.existsSync(dPath)) { detectedPath = dPath; detectedProduct = 'Daintree'; }
else if (fs.existsSync(cPath)) { detectedPath = cPath; detectedProduct = 'canopy-app (legacy)'; }
if (detectedPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(detectedPath, 'utf8'));
    customPresetCount = cfg.agentSettings && cfg.agentSettings.customPresets
      ? Object.keys(cfg.agentSettings.customPresets).length : 0;
  } catch (e) {}
}
result.daintree = {
  installed: !!detectedPath,
  product: detectedProduct,
  config_path: detectedPath,
  custom_preset_count: customPresetCount
};

// ── Project state ──
const planDir = path.join(process.cwd(), '.planning');
result.project.has_planning = fs.existsSync(path.join(planDir, 'PROJECT.md'));
result.project.has_roadmap = fs.existsSync(path.join(planDir, 'ROADMAP.md'));
try {
  const state = fs.readFileSync(path.join(planDir, 'STATE.md'), 'utf8');
  const pm = state.match(/Current Phase:\\s*(\\d+)/i);
  const sm = state.match(/Status:\\s*(\\w+)/i);
  result.project.current_phase = pm ? pm[1] : null;
  result.project.phase_status = sm ? sm[1] : null;
} catch (e) {
  result.project.current_phase = null;
  result.project.phase_status = null;
}

process.stdout.write(JSON.stringify(result, null, 2));
NF_DETECT
```

Parse the full JSON output as `DETECT`.

---

## Step 2: Show status dashboard

Display the results clearly to the user. Use this format:

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 nForma ► ONBOARDING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

nForma Install
  Commands & hooks ........ {synced / not installed}
  Config (nf.json) ........ {found / missing}

Coding Agent CLIs
  codex (OpenAI) .......... {vX.Y.Z, authenticated / installed, not authenticated / not installed}
  gemini (Google) ......... {vX.Y.Z, authenticated / installed, not authenticated / not installed}
  opencode (xAI) .......... {vX.Y.Z, authenticated / installed, not authenticated / not installed}
  copilot (GitHub) ........ {vX.Y.Z / gh installed, extension missing / not installed}
  claude (Anthropic) ...... {vX.Y.Z / not installed}
  ccr (Code Router) ....... {vX.Y.Z / not installed}

MCP Servers ({N} configured)
  {name} .................. {type} {model if known}
  {name} .................. {type} {model if known}
  ...

Daintree IDE
  Detected ................ {Daintree at {path} / canopy-app (legacy) at {path} / not installed}
  Custom Presets .......... {N defined / 0}
  Linked .................. {use /nf:link-canopy to sync}

Project
  Initialized ............. {yes — phase N (status) / no}
```

Only show CLIs that are either installed or relevant. If nothing is installed, show all as "not installed" so the user sees what's available.

---

## Step 3: Route based on state

Evaluate the detection results and route to the appropriate section:

### A. nForma not installed (`nforma.commands_synced` is false)

Tell the user:

> nForma isn't set up yet. The installer is right here in this repo. It copies commands, hooks, and workflows into your `~/.claude/` directory — takes about 30 seconds.

**Also report what CLIs were found**, because this affects what quorum agents they can use:

- If CLIs were found: "I can see you have {list} installed. nForma will automatically wrap these as quorum agents during install."
- If no CLIs found: "I don't see any coding agent CLIs installed (codex, gemini, opencode, copilot). nForma can still work — it uses Claude Code Router (CCR) to access open-weight models via API. Or you can install CLIs later."

Ask the user if they want to proceed with installation. If yes, run:

```bash
npm ci --ignore-scripts && node bin/install.js --claude --global
```

After install, tell them: **Restart your agent session** so hooks and commands load. Then paste this prompt again to continue.

**Stop here.** Do not continue in the same session.

---

### B. nForma installed but CLIs missing or not authenticated

If `nforma.commands_synced` is true but important CLIs are not installed or not authenticated, help the user improve their quorum coverage.

**For each CLI that is installed but NOT authenticated**, tell the user how to authenticate:

- **codex**: "Run `codex login` — opens browser for OpenAI authentication"
- **gemini**: "Run `gemini auth login` — opens browser for Google authentication"
- **opencode**: "Run `opencode auth login` — configure provider credentials"
- **copilot**: "Run `gh auth login` then `gh extension install github/gh-copilot` if the extension is missing"

**For CLIs that are not installed**, briefly mention what they provide:

| CLI | What it adds to quorum | Install |
|-----|----------------------|---------|
| codex | OpenAI GPT models | `npm install -g @openai/codex` |
| gemini | Google Gemini models | `npm install -g @google/gemini-cli` |
| opencode | xAI Grok models | `npm install -g opencode` |
| copilot | GitHub Copilot models | `gh extension install github/gh-copilot` |
| ccr | Open-weight models (Qwen, Llama, DeepSeek, etc.) via Together.xyz — no separate CLI subscription needed, just an API key | `npm install -g @musistudio/claude-code-router` |

Don't push the user to install everything. Say:

> Each CLI you add is another independent voice in quorum review. Even one or two gives you meaningful coverage. You can add more any time.

Ask if they want to install or authenticate any, or skip to the next step.

---

### C. Unused CLIs detected (run this check EVERY time, regardless of route)

**This is the most important check.** After showing the dashboard, cross-reference the `clis` and `mcp.configured` results. For each CLI:

1. Is it installed? (`clis.{name}.installed` is true)
2. Is it already wired as an MCP server? (any entry in `mcp.configured` has a matching `type`)
3. Is it authenticated? (`clis.{name}.authenticated`)

Build a list of **unused CLIs** — installed but NOT in the MCP config. If any exist, tell the user directly:

> I found CLIs on your machine that nForma isn't using yet:
>
> - **codex** (OpenAI, v1.2.3) — installed and authenticated, but not connected as a quorum agent
> - **gemini** (Google, v0.5.1) — installed but not authenticated yet
> - **opencode** (xAI, v0.8.0) — installed and authenticated, but not connected
>
> Each one adds an independent AI model to your quorum — more voices = fewer blind spots.
> Want me to wire any of these up?

For each one the user wants to add:
- If **not authenticated**, tell them the auth command first:
  - codex: `codex login`
  - gemini: `gemini auth login`
  - opencode: `opencode auth login`
  - copilot: `gh auth login` + `gh extension install github/gh-copilot`
- If **authenticated**, tell them to run `/nf:mcp-setup` to add it as a quorum agent.

Also check the reverse — **MCP servers with dead CLIs**:
- If an MCP server entry references a CLI that's NOT installed or NOT authenticated, warn:
  > Your agent "{name}" is configured but the underlying CLI isn't {installed/authenticated}. It will fail at runtime. Want to fix it?

If everything is aligned (all installed CLIs are wired up, all MCP servers have working CLIs), say:

> All your installed CLIs are connected as quorum agents. Looking good.

**Also mention CLIs they DON'T have**, briefly, in case they want more coverage:

> You could also add these for broader quorum coverage:
> - `ccr` (Claude Code Router) — open-weight models via API, no subscription needed → `npm install -g @musistudio/claude-code-router`
> - `codex` (OpenAI) → `npm install -g @openai/codex`
> (etc. — only list ones they don't have)

**Daintree IDE bridge (issue 138):** if `result.daintree.installed` is true AND `result.nforma.commands_synced` is true, mention to the user:

> I see Daintree (or legacy Canopy) is installed at `{result.daintree.config_path}` with {result.daintree.custom_preset_count} custom preset(s). Run `/nf:link-canopy` to import preset env overrides into nForma's providers and export nForma's quorum agents back as Daintree customPresets.

This bridge is bidirectional — Daintree presets flow into `providers.json` and nForma quorum slots flow into Daintree's `agentSettings.customPresets`. Re-running `/nf:link-canopy` is idempotent (existing entries are never overwritten).

Then continue to the next step.

---

### E. No project initialized (`project.has_planning` is false)

> Your environment is ready with {N} quorum agent(s). You can now start using nForma:
>
> - `/nf:new-project` — Initialize structured planning for this repo
> - `/nf:quick` — Run a one-off task with atomic commits
> - `/nf:help` — See all commands

Let the user choose. Don't auto-invoke.

---

### F. Project initialized — fully set up

> nForma is fully set up{phase_info}. Here are your options:
>
> - `/nf:progress` — Continue where you left off
> - `/nf:quick` — Ad-hoc task
> - `/nf:settings` — Project settings
> - `/nf:help` — Command reference

---

## Rules

1. **Detect before acting.** Always run the diagnostic first — never assume.
2. **Never install without asking.** Confirm before running any command.
3. **Report what you find.** Show the dashboard so the user understands their current state.
4. **One step at a time.** Don't dump everything — show status, explain the next step, let them decide.
5. **Restart after install.** Slash commands won't work until the session restarts.
6. **Don't gatekeep on CLIs.** nForma works with zero external CLIs (CCR + API agents cover it). More CLIs = better quorum, but none are required.

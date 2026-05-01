---
name: nf:mcp-update
description: Update a quorum agent to its latest version — detects install method from ~/.claude.json and runs the correct update command
argument-hint: "<agent|all>"
allowed-tools:
  - Bash
---

<objective>
Update a named quorum agent (or all agents) to their latest version. The install method is detected from `~/.claude.json` mcpServers config: `npx`-based agents update via `npm install -g <package>`; `node`-based local repo agents update via `git pull && npm run build` in their repo directory. The running process is NOT killed — run `/nf:mcp-restart <agent>` after updating to load the new binary.
</objective>

<process>

## Step 1 — Parse arguments

Parse `$ARGUMENTS` as one token: `$TARGET`.

If `$TARGET` is missing, print usage and stop:
```
Usage: /nf:mcp-update <agent|all>

Valid agents: read dynamically from ~/.claude.json (run without arguments to list)

Use "all" to update all configured agents sequentially.
```

## Step 2 — Validate agent name (single agent mode)

If `$TARGET` is not `"all"`:

Run this Bash command to get valid slots from `~/.claude.json`:

```bash
node << 'NF_EVAL'
const fs=require('fs'),os=require('os'),path=require('path');
const SKIP=['canopy','sentry'];
try {
  const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude.json'),'utf8'));
  const slots=Object.keys(cfg.mcpServers||{}).filter(s=>!SKIP.includes(s));
  console.log(JSON.stringify(slots));
} catch(e) {
  console.log('[]');
}
NF_EVAL
```

Parse the output as `$VALID_SLOTS` (JSON array of strings).

If `$TARGET` is not in `$VALID_SLOTS`, print an error and stop:
```
Error: Unknown agent "$TARGET"

Valid agents: <$VALID_SLOTS joined with spaces>

Use "all" to update all configured agents.
```

## Step 3 — Read install config from ~/.claude.json

Run this inline node script via Bash to read the install configuration:

**For single agent:**
```bash
AGENT="$TARGET" node << 'NF_EVAL'
const fs=require('fs'),path=require('path'),os=require('os');
const claudeJsonPath=path.join(os.homedir(),'.claude.json');
let claudeJson;
try { claudeJson=JSON.parse(fs.readFileSync(claudeJsonPath,'utf8')); }
catch(e) { process.stderr.write('Error: Cannot read ~/.claude.json: '+e.message+'\n'); process.exit(1); }
const servers=claudeJson.mcpServers||{};
const agent=process.env.AGENT;
const serverConfig=servers[agent];
if(!serverConfig){ process.stderr.write('Error: Agent "'+agent+'" is not configured in ~/.claude.json mcpServers\n'); process.exit(2); }
const command=serverConfig.command;
const args=serverConfig.args||[];
let result;
if(command==='npx'||command==='npm'){
  const packageName=args[args.length-1];
  result={type:'npm',package:packageName};
} else if(command==='node'&&args.length>0){
  const repoDir=path.dirname(path.dirname(args[0]));
  result={type:'local',repoDir};
} else {
  result={type:'unknown',command,args};
}
process.stdout.write(JSON.stringify(result)+'\n');
NF_EVAL
```

Store output as `$INSTALL_INFO`.

If exit code 1 or 2: print the error message and stop.
If exit code 0: parse `$INSTALL_INFO` JSON.

## Step 4 — Execute update (single agent)

Based on the `type` field from `$INSTALL_INFO`:

**type = "npm":**
```bash
npm install -g "$PACKAGE"
```
where `$PACKAGE` is `install_info.package`.

Capture exit code and output. If exit code ≠ 0: print error output and stop.

**type = "local":**
```bash
cd "$REPO_DIR" && git pull && npm run build
```
where `$REPO_DIR` is `install_info.repoDir`.

Capture exit code and output. If exit code ≠ 0: print error output and stop.
**Important:** Do NOT kill the running process if build fails.

**type = "unknown":**
Print:
```
Warning: Cannot determine update method for $TARGET (command: <command>).
Manual update required. Check ~/.claude.json mcpServers.$TARGET for configuration.
```
Stop.

## Step 5 — Print confirmation (single agent)

Display:
```
Updated $TARGET

  Install method: <npm: npm install -g <pkg>> OR <local repo: git pull + npm run build in <repo_dir>>
  Result: <last line of npm/git output>

Note: The running agent process is still using the old version.
Run: /nf:mcp-restart $TARGET   to load the new binary.
```

## Step 6 — All-agent mode (if $TARGET = "all")

If `$TARGET` is `"all"`, skip Steps 2–5 and run this instead:

**6a. Build update task list via inline node script:**

```bash
node << 'NF_EVAL'
const fs=require('fs'),path=require('path'),os=require('os');
const SKIP=['canopy','sentry'];
const claudeJsonPath=path.join(os.homedir(),'.claude.json');
const claudeJson=JSON.parse(fs.readFileSync(claudeJsonPath,'utf8'));
const servers=claudeJson.mcpServers||{};
const KNOWN_AGENTS=Object.keys(servers).filter(s=>!SKIP.includes(s));
const tasks=[];
const seenKeys=new Set();
for(const agent of KNOWN_AGENTS){
  const cfg=servers[agent];
  const cmd=cfg.command;
  const args=cfg.args||[];
  if(cmd==='npx'||cmd==='npm'){
    const pkg=args[args.length-1];
    const key='npm:'+pkg;
    if(seenKeys.has(key)){ tasks.push({agent,type:'npm',package:pkg,deduplicated:true}); }
    else { seenKeys.add(key); tasks.push({agent,type:'npm',package:pkg,deduplicated:false}); }
  } else if(cmd==='node'&&args.length>0){
    const repoDir=path.dirname(path.dirname(args[0]));
    const key='local:'+repoDir;
    if(seenKeys.has(key)){ tasks.push({agent,type:'local',repoDir,deduplicated:true}); }
    else { seenKeys.add(key); tasks.push({agent,type:'local',repoDir,deduplicated:false}); }
  } else {
    tasks.push({agent,type:'unknown',command:cmd});
  }
}
process.stdout.write(JSON.stringify(tasks)+'\n');
NF_EVAL
```

**6b. For each task in the list, sequentially:**
- If `deduplicated: true`: mark as `SKIPPED (shared repo already updated)` — do not run again
- If `type: "npm"` and `deduplicated: false`: run `npm install -g <package>`
- If `type: "local"` and `deduplicated: false`: run `cd <repoDir> && git pull && npm run build`
- If `type: "not_configured"`: mark as `NOT CONFIGURED`
- If `type: "unknown"`: mark as `UNKNOWN (manual update required)`

**6c. Print per-agent status table:**
```
Update results:

  codex-1     npm install -g codex-mcp-server      ✓ UPDATED
  gemini-1    npm install -g @tuannvm/gemini-...   ✓ UPDATED
  opencode-1  git pull + build in /code/opencode   ✓ UPDATED
  copilot-1   git pull + build in /code/copilot    ✓ UPDATED
  claude-1    npm install -g @anthropic-ai/claude  ✓ UPDATED
  (any user-added ccr-* / fleet-extension slots) git pull + build in /code/QGSD ✓ UPDATED
  ...

To load new binaries, restart updated agents:
  /nf:mcp-restart codex-1
  /nf:mcp-restart gemini-1
  /nf:mcp-restart opencode-1
  (etc. — list only agents that were UPDATED, not SKIPPED)
```

</process>

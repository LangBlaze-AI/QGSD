#!/usr/bin/env node
// Claude Code Statusline - GSD Edition
// Shows: model | current task | directory | context usage

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { loadConfig, shouldRunHook, validateHookInput } = require('./config-loader');

// Detect context window size from data
// Tier 1: explicit context_window_size from API
// Tier 2: parse display_name for context tier hint
// Tier 3: unknown (return null)
function detectContextSize(data) {
  // Tier 1: explicit context_window_size from API
  const explicit = data.context_window?.context_window_size;
  if (explicit && explicit > 0) return explicit;

  // Tier 2: parse display_name for context tier hint
  const displayName = data.model?.display_name || '';
  const match = displayName.match(/\((?:with\s+)?(\d+)([KM])\s*context/i);
  if (match) {
    const num = parseInt(match[1], 10);
    const unit = match[2].toUpperCase();
    return unit === 'M' ? num * 1_000_000 : num * 1_000;
  }

  // Tier 3: unknown — return null (fail-open)
  return null;
}

function buildToolsLine(homeDir, dir) {
  const parts = [];

  // Visual language:
  //   · tool  (dim)    = not installed — tool exists, user doesn't have it
  //   ○ tool  (normal) = installed, idle / not running
  //   ● tool  (green)  = active / running / ready

  // 1. coderlm indicator — always shown
  try {
    const coderlmBin = path.join(homeDir, '.claude', 'nf-bin', 'coderlm');
    if (!fs.existsSync(coderlmBin)) {
      parts.push('\x1b[2m· coderlm\x1b[0m'); // not installed
    } else {
      let alive = false;
      try {
        const pidFile = path.join(homeDir, '.claude', 'nf-bin', 'coderlm.pid');
        const pidStr = fs.readFileSync(pidFile, 'utf8').trim();
        const pid = parseInt(pidStr, 10);
        if (!isNaN(pid)) { process.kill(pid, 0); alive = true; }
      } catch (_e) {}
      parts.push(alive
        ? '\x1b[32m● coderlm\x1b[0m'   // active
        : '○ coderlm');                  // installed, idle
    }
  } catch (_e) { parts.push('\x1b[2m· coderlm\x1b[0m'); }

  // 2. River indicator — always shown
  try {
    const nfPython = path.join(homeDir, '.claude', 'nf-python-env', 'bin', 'python');
    let riverImportable = false;
    try {
      const riverCheck = spawnSync(nfPython, ['-c', 'import river'], { timeout: 3000 });
      riverImportable = riverCheck.status === 0;
    } catch (_e) {}

    if (!riverImportable) {
      parts.push('\x1b[2m· River\x1b[0m'); // not installed
    } else {
      let toolsRiver = '○ River'; // installed, idle
      try {
        const riverPath = path.join(dir, '.nf-river-state.json');
        if (fs.existsSync(riverPath)) {
          const riverState = JSON.parse(fs.readFileSync(riverPath, 'utf8'));
          const qTable = riverState && riverState.qTable;
          if (qTable && typeof qTable === 'object') {
            // Check if ANY arm has been visited — means "ready to start learning"
            const RIVER_MIN_EXPLORE = 20;
            let hasArms = false;
            let hasVisits = false;
            let allAbove = true;
            for (const taskType of Object.keys(qTable)) {
              const arms = qTable[taskType];
              if (arms && typeof arms === 'object') {
                for (const armName of Object.keys(arms)) {
                  hasArms = true;
                  const visits = arms[armName].visits || 0;
                  if (visits > 0) hasVisits = true;
                  if (visits < RIVER_MIN_EXPLORE) allAbove = false;
                }
              }
            }
            if (hasArms && hasVisits) {
              toolsRiver = allAbove
                ? '\x1b[32m● River\x1b[0m'   // trained
                : '\x1b[36m● River\x1b[0m';   // exploring (has learning data, not all trained)
            }
            if (riverState.lastShadow && typeof riverState.lastShadow.recommendation === 'string' && riverState.lastShadow.recommendation) {
              toolsRiver = `\x1b[33m● River: ${riverState.lastShadow.recommendation}\x1b[0m`;
            }
          }
        }
      } catch (_e) {}
      parts.push(toolsRiver);
    }
  } catch (_e) { parts.push('\x1b[2m· River\x1b[0m'); }

  // 3. embed indicator — always shown
  try {
    const transformersPath = path.join(homeDir, '.claude', 'nf-bin', 'node_modules', '@huggingface', 'transformers');
    if (!fs.existsSync(transformersPath)) {
      parts.push('\x1b[2m· embed\x1b[0m'); // not installed
    } else {
      const cachePath = path.join(dir, '.planning', 'formal', 'embedding-cache.json');
      parts.push(fs.existsSync(cachePath)
        ? '\x1b[32m● embed\x1b[0m'  // active (cache warm)
        : '○ embed');                 // installed, idle
    }
  } catch (_e) { parts.push('\x1b[2m· embed\x1b[0m'); }

  return parts.join(' \x1b[2m│\x1b[0m ');
}

const SLOT_FRESH_MS = 5 * 60 * 1000;

// Read the slot-health context ONCE per render: providers.json (configured slot
// inventory), ~/.claude.json mcpServers (which slots are MCP-registered), and the
// slot-health cache written by nf-slot-health-probe.js. Returns null when there is
// no usable provider inventory. Null/invalid provider entries are dropped here so
// every consumer can assume `{ name }`. Statusline rendering must stay fast, so
// this is a pure cache-read — the probe runs out-of-band (SessionStart / the
// background refresh below).
function readSlotHealth(homeDir) {
  const providersPath = path.join(homeDir, '.claude', 'nf-bin', 'providers.json');
  const claudeJsonPath = path.join(homeDir, '.claude.json');
  const cachePath = path.join(homeDir, '.claude', 'nf', 'slot-health.json');

  let providers, mcpServers, cache;
  try { providers = JSON.parse(fs.readFileSync(providersPath, 'utf8')).providers; } catch (_) { providers = null; }
  if (!Array.isArray(providers)) return null;
  providers = providers.filter(p => p && typeof p.name === 'string' && p.name);
  if (providers.length === 0) return null;
  try { mcpServers = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')).mcpServers || {}; } catch (_) { mcpServers = {}; }
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (_) { cache = null; }

  const checkedAt = cache && cache.checked_at ? Date.parse(cache.checked_at) : 0;
  const fresh = !!(checkedAt && (Date.now() - checkedAt) < SLOT_FRESH_MS);
  return { providers, mcpServers, cache, fresh };
}

// Build the detailed per-slot row (line 2). `ctx` is the shared readSlotHealth()
// result so a render doesn't re-read the same files three times.
function buildSlotsLine(homeDir, ctx) {
  const h = ctx || readSlotHealth(homeDir);
  if (!h) return null;
  const { providers, mcpServers, cache, fresh } = h;

  const parts = [];
  for (const p of providers) {
    const inMcp = !!mcpServers[p.name];
    const entry = cache && cache.slots && cache.slots[p.name];
    let glyph, color;
    if (!inMcp) {
      glyph = '·'; color = '\x1b[2m'; // dim — listed but not MCP-registered
    } else if (fresh && entry && entry.ok) {
      glyph = '●'; color = '\x1b[32m'; // green — recent OK
    } else if (fresh && entry && !entry.ok) {
      glyph = '⊘'; color = '\x1b[31m'; // red — recent failure
    } else {
      glyph = '○'; color = ''; // configured, no fresh data
    }
    parts.push(`${color}${glyph} ${p.name}\x1b[0m`);
  }
  return parts.join(' \x1b[2m│\x1b[0m ');
}

// Compact one-line quorum indicator for line 1, so quorum health is visible even
// when the terminal only paints the first status row (multi-line status lines
// depend on vertical space). `ctx` is the shared readSlotHealth() result.
//   N● quorum   (green)  — all N MCP-registered slots healthy & fresh
//   H/N⊘ quorum (red)    — H of N healthy (some down)
//   N○ quorum   (dim)    — no fresh probe data yet (cache stale/missing)
function buildQuorumSummary(homeDir, ctx) {
  const h = ctx || readSlotHealth(homeDir);
  if (!h) return null;
  const { providers, mcpServers, cache, fresh } = h;

  const mcpSlots = providers.filter(p => mcpServers[p.name]);
  const total = mcpSlots.length;
  if (total === 0) return null;

  if (!fresh) return `\x1b[2m${total}○ quorum\x1b[0m`;
  const healthy = mcpSlots.filter(p => { const e = cache && cache.slots && cache.slots[p.name]; return e && e.ok; }).length;
  if (healthy === total) return `\x1b[32m${total}● quorum\x1b[0m`;
  return `\x1b[31m${healthy}/${total}⊘ quorum\x1b[0m`;
}

// Fire-and-forget: when the slot-health cache is NOT fresh, kick off the probe in
// a DETACHED background process so the NEXT render reads fresh. The statusline
// itself must stay instant — this never blocks. Throttled (1/min) so a slow probe
// can't cause spawn storms across frequent renders. `fresh` comes from the shared
// readSlotHealth() result so we don't re-read the cache here.
function maybeRefreshSlotCache(homeDir, fresh) {
  try {
    if (fresh) return; // already fresh — nothing to do
    const nfDir = path.join(homeDir, '.claude', 'nf');
    const markerPath = path.join(nfDir, '.slot-probe-spawned');
    const THROTTLE_MS = 60 * 1000;

    // Don't spawn again if we spawned a probe recently.
    try {
      const m = fs.statSync(markerPath);
      if (Date.now() - m.mtimeMs < THROTTLE_MS) return;
    } catch (_) { /* no marker yet → ok to spawn */ }

    const probe = path.join(homeDir, '.claude', 'hooks', 'nf-slot-health-probe.js');
    if (!fs.existsSync(probe)) return;
    try { fs.mkdirSync(nfDir, { recursive: true }); } catch (_) {}
    try { fs.writeFileSync(markerPath, String(Date.now())); } catch (_) {}
    const child = spawn(process.execPath, [probe], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (_) { /* never block the statusline */ }
}

// Read JSON from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const _eventType = data.hook_event_name || data.hookEventName || 'Notification';
    const _validation = validateHookInput(_eventType, data);
    if (!_validation.valid) {
      process.stderr.write('[nf] WARNING: nf-statusline: invalid input: ' + JSON.stringify(_validation.errors) + '\n');
      process.exit(0); // Fail-open
    }

    // Profile guard — exit early if this hook is not active for the current profile
    const config = loadConfig(data.workspace?.current_dir || process.cwd());
    const profile = config.hook_profile || 'standard';
    if (!shouldRunHook('nf-statusline', profile)) {
      process.exit(0);
    }

    const model = data.model?.display_name || 'Claude';
    const dir = data.workspace?.current_dir || process.cwd();
    const session = data.session_id || '';
    const remaining = data.context_window?.remaining_percentage;

    // Context window display
    let ctx = '';
    if (remaining != null) {
      const rem = Math.round(remaining);
      const used = Math.max(0, Math.min(100, 100 - rem));

      // Build progress bar (10 segments)
      const filled = Math.floor(used / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

      // Token-based color thresholds (quality degrades well before context limit)
      // Total context usage = input + cache_read + cache_creation (all contribute to context window)
      const usage = data.context_window?.current_usage || {};
      const totalTokens = (usage.input_tokens || 0)
        + (usage.cache_read_input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0);

      // Use total if non-zero, otherwise estimate from percentage and context_window_size
      const ctxSize = detectContextSize(data);

      let inputTokens, tokensK, tokenLabel;
      if (totalTokens > 0) {
        inputTokens = totalTokens;
        tokensK = Math.round(inputTokens / 1000);
        tokenLabel = tokensK >= 1000 ? `${(tokensK / 1000).toFixed(1)}M` : `${tokensK}K`;
      } else if (ctxSize) {
        inputTokens = Math.round((used / 100) * ctxSize);
        tokensK = Math.round(inputTokens / 1000);
        tokenLabel = tokensK >= 1000 ? `${(tokensK / 1000).toFixed(1)}M` : `${tokensK}K`;
      } else {
        inputTokens = null;
        tokenLabel = null;
      }

      // Named threshold constants for maintainability
      const TIER1_PCT = 0.10;  // green ceiling
      const TIER2_PCT = 0.20;  // yellow ceiling
      const TIER3_PCT = 0.35;  // orange ceiling (>= this → red)

      let color;
      if (inputTokens != null && ctxSize) {
        // Scale thresholds proportionally: green < 10%, yellow < 20%, orange < 35%, red >= 35%
        const t1 = ctxSize * TIER1_PCT;  // 1M: 100K, 200K: 20K
        const t2 = ctxSize * TIER2_PCT;  // 1M: 200K, 200K: 40K
        const t3 = ctxSize * TIER3_PCT;  // 1M: 350K, 200K: 70K
        if (inputTokens < t1) {
          color = '\x1b[32m';           // green
        } else if (inputTokens < t2) {
          color = '\x1b[33m';           // yellow
        } else if (inputTokens < t3) {
          color = '\x1b[38;5;208m';     // orange
        } else {
          color = '\x1b[5;31m';         // blinking red
        }
      } else if (inputTokens != null) {
        // Have tokens but no ctxSize — use original fixed thresholds as fallback
        if (inputTokens < 100_000) {
          color = '\x1b[32m';
        } else if (inputTokens < 200_000) {
          color = '\x1b[33m';
        } else if (inputTokens < 350_000) {
          color = '\x1b[38;5;208m';
        } else {
          color = '\x1b[5;31m';
        }
      } else {
        // No token info at all — use percentage-based color
        if (used < 30) {
          color = '\x1b[32m';           // green
        } else if (used < 50) {
          color = '\x1b[33m';           // yellow
        } else if (used < 70) {
          color = '\x1b[38;5;208m';     // orange
        } else {
          color = '\x1b[5;31m';         // blinking red
        }
      }

      ctx = tokenLabel
        ? ` ${color}${bar} ${used}% (${tokenLabel})\x1b[0m`
        : ` ${color}${bar} ${used}%\x1b[0m`;
    }

    // Current task from todos
    let task = '';
    const homeDir = os.homedir();
    const todosDir = path.join(homeDir, '.claude', 'todos');
    if (session && fs.existsSync(todosDir)) {
      try {
        const files = fs.readdirSync(todosDir)
          .filter(f => f.startsWith(session) && f.includes('-agent-') && f.endsWith('.json'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0) {
          try {
            const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].name), 'utf8'));
            const inProgress = todos.find(t => t.status === 'in_progress');
            if (inProgress) task = inProgress.activeForm || '';
          } catch (e) {}
        }
      } catch (e) {
        // Silently fail on file system errors - don't break statusline
      }
    }

    // nForma update available?
    let nfUpdate = '';
    const cacheFile = path.join(homeDir, '.claude', 'cache', 'nf-update-check.json');
    if (fs.existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cache.update_available) {
          nfUpdate = '\x1b[33m⬆ /nf:update\x1b[0m │ ';
        }
      } catch (e) {}
    }

    // Read the slot-health context ONCE and share it across the quorum tag,
    // the slots row, and the background-refresh decision (avoids re-reading the
    // same HOME-scoped JSON files three times per render).
    let slotHealth = null;
    try { slotHealth = readSlotHealth(homeDir); } catch (_e) {}

    // Kick off a background slot-health refresh if the cache is stale (non-blocking).
    try { maybeRefreshSlotCache(homeDir, slotHealth ? slotHealth.fresh : false); } catch (_e) {}

    // Compact quorum indicator for line 1 — always visible even when the terminal
    // only paints the first status row.
    let quorumTag = '';
    try {
      const q = buildQuorumSummary(homeDir, slotHealth);
      if (q) quorumTag = ` \x1b[2m│\x1b[0m ${q}`;
    } catch (_e) {}

    // Output (tools line is assembled and written after the main line)
    const dirname = path.basename(dir);
    if (task) {
      process.stdout.write(`${nfUpdate}\x1b[2m${model}\x1b[0m │ \x1b[1m${task}\x1b[0m │ \x1b[2m${dirname}\x1b[0m${ctx}${quorumTag}`);
    } else {
      process.stdout.write(`${nfUpdate}\x1b[2m${model}\x1b[0m │ \x1b[2m${dirname}\x1b[0m${ctx}${quorumTag}`);
    }

    // Quorum slots line (above the tools line)
    try {
      const slotsLine = buildSlotsLine(homeDir, slotHealth);
      if (slotsLine) {
        process.stdout.write('\n' + slotsLine);
      }
    } catch (_e) {}

    // Tools status second line
    try {
      const toolsLine = buildToolsLine(homeDir, dir);
      if (toolsLine) {
        process.stdout.write('\n' + toolsLine);
      }
    } catch (_e) {}
  } catch (e) {
    if (e instanceof SyntaxError) {
      process.stderr.write('[nf] WARNING: nf-statusline: malformed JSON on stdin: ' + e.message + '\n');
    }
    // Silent fail - don't break statusline on parse errors
  }
});

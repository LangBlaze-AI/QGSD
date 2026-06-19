#!/usr/bin/env node
// hooks/nf-prompt.js
// UserPromptSubmit hook — three responsibilities:
//
// 1. CIRCUIT BREAKER RECOVERY: If the circuit breaker is active, inject the
//    oscillation-resolution-mode workflow into Claude's context so resolution
//    starts automatically on the next user message.
//
// 2. PENDING TASK INJECTION: If a pending-task file exists, atomically claim it
//    and inject it as a queued command (survives /clear). Session-scoped files
//    take priority over the generic file to prevent cross-session delivery.
//
// 3. QUORUM INJECTION: If the prompt is a GSD planning command, inject quorum
//    instructions so Claude runs multi-model review before presenting output.
//
// Output mechanism: hookSpecificOutput.additionalContext (NOT systemMessage)
// systemMessage only shows a UI warning; additionalContext goes into Claude's context.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');
const { loadConfig, slotToToolCall, shouldRunHook, validateHookInput } = require('./config-loader');
const { schema_version } = require('./conformance-schema.cjs');
const resolveBin = require('./nf-resolve-bin');
const taskClassifier = (() => { try { return require(resolveBin('task-classifier.cjs')); } catch { return null; } })();
const contextStack = (() => { try { return require(resolveBin('context-stack.cjs')); } catch { return null; } })();

const DEFAULT_QUORUM_INSTRUCTIONS_FALLBACK = `QUORUM REQUIRED (structural enforcement — Stop hook will verify)

Run the full R3 quorum protocol inline (dispatch_pattern from commands/nf/quorum.md):

1. State Claude's own position (vote) first — APPROVE or BLOCK with 1-2 sentence rationale
2. Run provider pre-flight: node ~/.claude/nf-bin/check-provider-health.cjs --json
3. Build $DISPATCH_LIST first (quorum.md Adaptive Fan-Out: read risk_level → compute FAN_OUT_COUNT → first FAN_OUT_COUNT-1 slots). Then dispatch $DISPATCH_LIST as sibling nf-quorum-slot-worker Tasks in one message turn — do NOT dispatch slots outside $DISPATCH_LIST:
   Task(subagent_type="nf-quorum-slot-worker", prompt="slot: <slot>\\nround: 1\\n...")
4. Synthesize results inline. Deliberate up to 10 rounds per R3.3 if no consensus.
5. Update scoreboard: node ~/.claude/nf-bin/update-scoreboard.cjs merge-wave ...
6. [HEAL-01] After each deliberation round's merge-wave, check early escalation:
   node ~/.claude/nf-bin/quorum-consensus-gate.cjs --min-quorum=2 --remaining-rounds=R
   (R = maxDeliberation - currentRound). Exit code 1 = stop deliberating, proceed to decision (early escalation — P(consensus|remaining) below threshold).
7. Include the token <!-- GSD_DECISION --> in your FINAL output (only when delivering
   the completed plan, research, verification report, or filtered question list)

Fail-open: if a model is UNAVAILABLE (quota/error), note it and proceed with available models.
Failover rule: if a slot returns an error or quota exceeded, skip it and continue with remaining active slots.
The Stop hook reads the transcript — skipping quorum will block your response.`;

// Appends a structured conformance event to .planning/conformance-events.jsonl.
// Uses appendFileSync (atomic for writes < POSIX PIPE_BUF = 4096 bytes).
// Always wrapped in try/catch — hooks are fail-open; never crashes on logging failure.
// NEVER writes to stdout — stdout is the Claude Code hook decision channel.
function appendConformanceEvent(event) {
  try {
    const pp = require(resolveBin('planning-paths.cjs'));
    const logPath = pp.resolve(process.cwd(), 'conformance-events');
    fs.appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write('[nf] conformance log write failed: ' + err.message + '\n');
  }
}

// Locate the oscillation-resolution-mode workflow.
// Tries global install path first (~/.claude/nf/), then local (.claude/nf/).
function findResolutionWorkflow(cwd) {
  const candidates = [
    path.join(os.homedir(), '.claude', 'nf', 'workflows', 'oscillation-resolution-mode.md'),
    path.join(cwd, '.claude', 'nf', 'workflows', 'oscillation-resolution-mode.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return null;
}

// Atomically claim and read a pending-task file, if one exists.
// Checks session-scoped file first (.claude/pending-task-<sessionId>.txt) to prevent
// cross-session delivery, then falls back to the generic .claude/pending-task.txt.
// Uses fs.renameSync for atomic claiming — POSIX guarantees only one process wins.
// Returns the task string, or null if no pending task exists.
function consumePendingTask(cwd, sessionId) {
  const claudeDir = path.join(cwd, '.claude');
  if (!fs.existsSync(claudeDir)) return null;

  const candidates = [];
  if (sessionId) candidates.push(path.join(claudeDir, `pending-task-${sessionId}.txt`));
  candidates.push(path.join(claudeDir, 'pending-task.txt'));

  for (const pendingFile of candidates) {
    if (!fs.existsSync(pendingFile)) continue;

    const claimedFile = pendingFile + '.claimed';
    try {
      fs.renameSync(pendingFile, claimedFile); // atomic claim — only one session wins
    } catch {
      continue; // another session claimed it first, or file vanished — skip
    }

    try {
      const task = fs.readFileSync(claimedFile, 'utf8').trim();
      fs.unlinkSync(claimedFile);
      if (task) return task;
    } catch {
      try { fs.unlinkSync(claimedFile); } catch {} // best-effort cleanup
    }
  }
  return null;
}

// Checks if this is the first message of a session.
// Uses a sentinel flag file to ensure injection fires exactly once per session.
// Returns true on first call with a valid sessionId (flag created), false on subsequent calls.
// Fail-open: missing .claude directory or file write errors return false.
function isFirstMessageOfSession(cwd, sessionId) {
  if (!sessionId) return false;
  try {
    const claudeDir = path.join(cwd, '.claude');
    const flagPath = path.join(claudeDir, `nf-session-seen-${sessionId}.flag`);
    if (fs.existsSync(flagPath)) {
      return false; // Flag already exists — not the first message
    }
    // Ensure .claude directory exists
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    // Create the flag file with current timestamp
    fs.writeFileSync(flagPath, new Date().toISOString(), 'utf8');
    return true; // Flag created — this is the first message
  } catch (_) {
    return false; // Fail-open on any error
  }
}

// Extracts the "## Current Position" and "### Decisions" sections from STATE.md content.
// Caps extraction at 20 lines total. Returns trimmed text or empty string on failure.
function extractStateContext(stateContent) {
  if (!stateContent) return '';
  try {
    const lines = stateContent.split('\n');
    const result = [];
    let inTargetSection = false;
    let lineCount = 0;

    for (const line of lines) {
      // Check for "## Current Position" or "### Decisions" section headers
      if (line.startsWith('## Current Position') || line.startsWith('### Decisions')) {
        inTargetSection = true;
        result.push(line);
        lineCount++;
        continue;
      }

      if (inTargetSection) {
        // Stop when we hit another section header (##) or reach 20 lines
        if (line.startsWith('##') && !line.startsWith('### ')) {
          break;
        }
        if (lineCount >= 20) {
          break;
        }
        result.push(line);
        lineCount++;
      }
    }

    return result.join('\n').trim();
  } catch (_) {
    return '';
  }
}

// Parses --n N flag from a prompt string.
// Returns N (integer >= 1) if found, or null if absent/invalid.
function parseQuorumSizeFlag(prompt) {
  const m = prompt.match(/--n\s+(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (Number.isInteger(n) && n >= 1) ? n : null;
}

// Maps task envelope risk_level to a fan-out count (total participants including Claude).
// Proportional to maxSize (n) using ceil(tier/3 * n):
//   low/routine (tier 1) → ceil(n/3)   — e.g. n=3→1, n=6→2
//   medium      (tier 2) → ceil(2n/3)  — e.g. n=3→2, n=6→4
//   high        (tier 3) → n           — full pool
//   absent/invalid       → n           — fail-open: conservative
// Result is always in [1..maxSize].
function mapRiskLevelToCount(riskLevel, maxSize) {
  const n = maxSize;
  if (riskLevel === 'low' || riskLevel === 'routine') return Math.max(1, Math.ceil(n / 3));
  if (riskLevel === 'medium') return Math.max(1, Math.ceil(2 * n / 3));
  // 'high', undefined, null, invalid string → fail-open to maxSize
  return n;
}

// Returns slot names that have failed within the last ttlMinutes.
// Reads quorum-failures.json written by call-quorum-slot.cjs on every failure.
// Covers ALL error types (TIMEOUT, AUTH, QUOTA, SPAWN_ERROR, CLI_SYNTAX, UNKNOWN).
// The 5-minute TTL ensures transient failures self-heal quickly without operator intervention.
function getRecentlyFailedSlots(cwd, ttlMinutes = 5) {
  try {
    const pp = require(resolveBin('planning-paths.cjs'));
    const logPath = pp.resolveWithFallback(cwd, 'quorum-failures');
    if (!fs.existsSync(logPath)) return [];
    const records = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    if (!Array.isArray(records)) return [];
    const cutoff = Date.now() - ttlMinutes * 60 * 1000;
    return records
      .filter(r => new Date(r.last_seen).getTime() > cutoff)
      .map(r => ({ slot: r.slot, error_type: r.error_type, pattern: r.pattern }));
  } catch (_) { return []; }
}

// Locate providers.json from multiple search paths (borrowed from call-quorum-slot.cjs).
function findProviders() {
  try {
    const p = resolveBin('providers.json');
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8')).providers;
    }
  } catch (_) { /* fail-open */ }
  return null;
}

// Runs quorum-preflight.cjs --all to probe CLI-backed slots (Layer 1 + Layer 2).
// Returns { filteredSlots, allDown, unavailableSlots } based on probe results.
// Fail-open on any error: returns { filteredSlots: slots, allDown: false, unavailableSlots: [] }.
// CLI-backed slots (e.g., codex-1, gemini-1, opencode-1, copilot-1) are filtered by
// the probe results. Unprobed slots (e.g., claude-*) pass through unconditionally.
// Set NF_SKIP_PREFLIGHT=1 to bypass probes (used in tests to avoid real CLI invocations).
function runPreflightFilter(slots) {
  const failOpen = { filteredSlots: slots, allDown: false, unavailableSlots: [] };
  // NF_SKIP_PREFLIGHT=1 disables probing entirely (test isolation, fast-path CI)
  if (process.env.NF_SKIP_PREFLIGHT === '1') return failOpen;
  try {
    const preflightPath = resolveBin('quorum-preflight.cjs');
    if (!preflightPath || !fs.existsSync(preflightPath)) return failOpen;
    // Thread an explicit time budget into preflight so it degrades gracefully
    // (skips service auto-start / Layer 2 upstream probes when the budget is tight)
    // rather than being SIGTERM'd mid-probe — which would fail open and dispatch
    // dead slots, defeating the purpose of preflight. The spawnSync timeout is set
    // comfortably above preflight's bounded worst case so the budget, not the
    // SIGTERM, governs degradation. Override via NF_PREFLIGHT_BUDGET_MS.
    // Validate the override is a positive finite number — `Number(...) || 6000`
    // alone would let a negative ("-1") or NaN through, yielding a nonsensical
    // budget and a too-small spawn timeout.
    const rawBudgetMs = Number(process.env.NF_PREFLIGHT_BUDGET_MS);
    const budgetMs = Number.isFinite(rawBudgetMs) && rawBudgetMs > 0 ? rawBudgetMs : 6000;
    const spawnTimeoutMs = budgetMs + 4000; // headroom over preflight's worst case
    const result = spawnSync('node', [preflightPath, '--all', '--budget-ms', String(budgetMs)], {
      timeout: spawnTimeoutMs,
      encoding: 'utf8',
    });
    if (result.status !== 0 || !result.stdout) return failOpen;
    let preflight;
    try { preflight = JSON.parse(result.stdout); } catch (_) { return failOpen; }
    if (!preflight || !Array.isArray(preflight.available_slots) || !Array.isArray(preflight.unavailable_slots)) {
      return failOpen;
    }

    const availableSet = new Set(preflight.available_slots);
    const unavailableSet = new Set(preflight.unavailable_slots.map(u => u.name));

    // Keep a slot if it is in available_slots, OR if preflight did not probe it at all.
    const filteredSlots = slots.filter(s => {
      if (availableSet.has(s.slot)) return true;    // explicitly probed and UP
      if (unavailableSet.has(s.slot)) return false; // explicitly probed and DOWN
      return true;  // unknown to preflight (e.g., claude-* slots) — pass through
    });

    // allDown only if at least one slot was in the input AND none survived filtering.
    const allDown = slots.length > 0 && filteredSlots.length === 0;

    process.stderr.write(
      `[nf-dispatch] PREFLIGHT: available=[${preflight.available_slots.join(', ')}], ` +
      `unavailable=[${preflight.unavailable_slots.map(u => u.name).join(', ')}]\n`
    );

    return { filteredSlots, allDown, unavailableSlots: preflight.unavailable_slots };
  } catch (_) { return failOpen; }
}

// Filters slots by availability window from scoreboard.
// Reads .planning/quorum-scoreboard.json availability section.
// Slots whose available_at_iso is in the future are excluded (cooling down).
// Fail-open: if scoreboard missing, malformed, or any error, returns all slots unchanged.
function getAvailableSlots(slots, cwd) {
  try {
    const pp = require(resolveBin('planning-paths.cjs'));
    const sbPath = pp.resolveWithFallback(cwd, 'quorum-scoreboard');
    if (!fs.existsSync(sbPath)) return slots;
    const scoreboard = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
    if (!scoreboard || !scoreboard.availability) return slots;
    const now = Date.now();
    return slots.filter(s => {
      const avail = scoreboard.availability[s.slot];
      if (!avail || !avail.available_at_iso) return true;
      try {
        const ts = new Date(avail.available_at_iso).getTime();
        if (isNaN(ts)) return true; // malformed date: fail-open
        if (ts > now) {
          process.stderr.write(`[nf-dispatch] AVAILABILITY EXCLUDE: ${s.slot} -- available_at_iso=${avail.available_at_iso} is in the future (now=${new Date().toISOString()})\n`);
          return false;
        }
        return true;
      } catch (_) { return true; }
    });
  } catch (_) { return slots; } // fail-open: any error → return all slots
}

// Sorts slots by flakiness (primary) then success rate (secondary) from scoreboard slot stats.
// Reads .planning/quorum-scoreboard.json slots section.
// Scoreboard keys are composite: "slotName:modelId" (e.g., "claude-1:deepseek-ai/DeepSeek-V3.2").
// Extract slot name: const slotName = key.split(':')[0];
// Example: const allModelsForSlot = Object.entries(scoreboard.slots)
//   .filter(([k]) => k.startsWith(slotName + ':'))
//   .map(([_, v]) => v);
// Then sum their tp/fn values.
// Fail-open: if scoreboard missing or any error, returns slots in original order.
function sortBySuccessRate(slots, cwd) {
  try {
    const pp = require(resolveBin('planning-paths.cjs'));
    const sbPath = pp.resolveWithFallback(cwd, 'quorum-scoreboard');
    if (!fs.existsSync(sbPath)) return [...slots];
    const scoreboard = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
    if (!scoreboard || !scoreboard.slots) return [...slots];

    // Read flakiness score for a slot — primary sort key
    const getFlakiness = (slotName) => {
      // Look up flakiness_score from scoreboard slots entries for this slot name
      const entries = Object.entries(scoreboard.slots)
        .filter(([k]) => k === slotName || k.startsWith(slotName + ':'));
      if (entries.length === 0) return 0; // fail-open: unknown = reliable
      // Use the max flakiness across any model for this slot
      return Math.max(...entries.map(([_, v]) => v.flakiness_score ?? 0));
    };

    // Aggregate tp/fn across all model entries for a given slot name — secondary sort key
    const getRate = (slotName) => {
      const entries = Object.entries(scoreboard.slots)
        .filter(([k]) => k.split(':')[0] === slotName)
        .map(([_, v]) => v);
      if (entries.length === 0) return 0.5; // default for unknown
      const totalTp = entries.reduce((sum, e) => sum + (e.tp || 0), 0);
      const totalFn = entries.reduce((sum, e) => sum + (e.fn || 0), 0);
      const rate = (totalTp + totalFn) === 0 ? 0.5 : totalTp / (totalTp + totalFn);
      return rate;
    };

    // Sort by flakiness ascending (lower = more reliable = first), then success rate descending
    const sorted = [...slots].sort((a, b) => {
      const flakDiff = getFlakiness(a.slot) - getFlakiness(b.slot);
      if (flakDiff !== 0) return flakDiff;
      return getRate(b.slot) - getRate(a.slot);
    });

    process.stderr.write('[nf-dispatch] DISPATCH ORDER (flakiness,rate): [' +
      sorted.map(s => `${s.slot}(f=${getFlakiness(s.slot).toFixed(2)},r=${getRate(s.slot).toFixed(3)})`).join(', ') + ']\n');
    return sorted;
  } catch (_) { return [...slots]; } // fail-open: any error → return original order
}

// Deduplicates slots that share the same underlying model.
// Returns { unique: [...], duplicates: [...] }, where unique are kept in orderedSlots
// and duplicates are candidates for the MODEL-DEDUP fallback tier.
// Respects auth_type sort order: first unique model per auth_type wins (sub agents preferred).
// Falls back to providersList when agentCfg lacks a slot's model info.
function deduplicateByModel(orderedSlots, agentCfg, providersList) {
  const seenModels = new Map(); // model string -> first slot name that claimed it
  const unique = [];
  const duplicates = [];

  // Build providers lookup map at the top
  const providersMap = new Map();
  if (Array.isArray(providersList)) {
    for (const p of providersList) {
      if (p.name && p.model) providersMap.set(p.name, p.model);
    }
  }

  for (const slot of orderedSlots) {
    const model = (agentCfg[slot.slot]?.model || providersMap.get(slot.slot) || 'unknown');
    // Never deduplicate slots with unknown models — we can't assert they're duplicates
    if (model === 'unknown') {
      unique.push(slot);
      continue;
    }
    if (seenModels.has(model)) {
      // Duplicate model — demote to fallback tier
      duplicates.push(slot);
      process.stderr.write(`[nf-dispatch] MODEL-DEDUP: ${slot.slot} (${model}) demoted to fallback — duplicate of ${seenModels.get(model)}\n`);
    } else {
      // New model — keep as primary
      seenModels.set(model, slot.slot);
      unique.push(slot);
    }
  }

  return { unique, duplicates };
}

// Build the FALLBACK-01 dispatch sequence instruction string.
// Extracted as a named function for unit testing — this logic determines what Claude
// sees as the fallback slot list when primaries fail.
function buildFalloverRule(cappedSlots, t1Unused, t2Slots, maxSize, modelDedupSlots) {
  const modelDedupSlots_arr = modelDedupSlots || [];
  if (t1Unused.length > 0 || t2Slots.length > 0 || modelDedupSlots_arr.length > 0) {
    // Always emit the full FALLBACK-01 dispatch sequence when ANY fallback slots exist.
    // Previous bug: when T1 was empty (no auth_type=sub slots), the entire fallback
    // sequence was replaced with a weak "skip it" message, causing Claude to give up
    // instead of trying remaining T2 slots.
    const steps = [`  Step 1 PRIMARY:        [${cappedSlots.map(s => s.slot).join(', ')}]`];
    let nextStep = 2;

    if (modelDedupSlots_arr.length > 0) {
      steps.push(`  Step ${nextStep} MODEL-DEDUP:    [${modelDedupSlots_arr.join(', ')}]  ← same model as a primary, try before T2`);
      nextStep++;
    }

    if (t1Unused.length > 0) {
      steps.push(`  Step ${nextStep} T1 sub-CLI:     [${t1Unused.join(', ')}]  ← try these BEFORE any T2 slot`);
      nextStep++;
      steps.push(`  Step ${nextStep} T2 ccr:         [${t2Slots.length > 0 ? t2Slots.join(', ') : 'none'}]`);
    } else {
      steps.push(`  Step ${nextStep} T2 fallback:    [${t2Slots.join(', ')}]  ← dispatch these when primaries return UNAVAIL`);
    }

    return (
      `SLOT DISPATCH SEQUENCE (FALLBACK-01) — when one or more primaries return UNAVAIL:\n` +
      steps.join('\n') + '\n' +
      `CRITICAL: Do NOT fail-open until ALL tiers are exhausted. Dispatch T${modelDedupSlots_arr.length > 0 ? 'MODEL-DEDUP then ' : ''}${t1Unused.length > 0 ? '1 then T2' : '2'} replacements for UNAVAIL primaries.\n` +
      `PARALLEL DISPATCH: Dispatch ALL needed fallback replacements as parallel sibling Tasks in ONE message turn — not one per UNAVAIL primary.\n` +
      `DEDUP: Each fallback slot is dispatched AT MOST ONCE per round. Never dispatch the same slot twice even if multiple primaries are UNAVAIL.\n` +
      `NO RESUME: slot-worker Task results are final. Never call resume on a completed slot-worker Task.\n` +
      `CHECKPOINT: After handling UNAVAIL, you MUST run quorum-checkpoint.cjs to write a structured FALLBACK-01 checkpoint file (see quorum.md). The Stop hook reads + schema-validates that file and will BLOCK if UNAVAIL is detected without it.\n` +
      `UNAVAIL slots do not count toward the ${maxSize} required quorum votes.`
    );
  }
  return (
    `Failover rule: if a slot-worker returns UNAVAIL or error, skip it — ` +
    `errors do not count toward the ${maxSize} required.`
  );
}

// Check if the circuit breaker is active (and not disabled) for a given git root.
function isBreakerActive(cwd) {
  const gitResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf8', timeout: 5000,
  });
  if (gitResult.status !== 0 || gitResult.error) return false;
  const gitRoot = gitResult.stdout.trim();
  const statePath = path.join(gitRoot, '.claude', 'circuit-breaker-state.json');
  if (!fs.existsSync(statePath)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return state.active === true && state.disabled !== true;
  } catch { return false; }
}

if (require.main === module) {
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const eventType = input.hook_event_name || input.hookEventName || 'UserPromptSubmit';
    const validation = validateHookInput(eventType, input);
    if (!validation.valid) {
      process.stderr.write('[nf] WARNING: nf-prompt: invalid input: ' + JSON.stringify(validation.errors) + '\n');
      process.exit(0); // Fail-open
    }
    const prompt    = (input.prompt || '').trim();
    const cwd       = input.cwd || process.cwd();
    const sessionId = input.session_id || null;

    // Hoisted declarations (were var, now let at function scope)
    let _nfClassification;
    let _nfCacheKey = null;
    let _nfCacheModule = null;
    let _nfCacheDir = null;
    let _nfDispatchSlotCount = 0;

    // ── Priority 1: Circuit breaker active → inject resolution workflow ──────
    if (isBreakerActive(cwd)) {
      const workflow = findResolutionWorkflow(cwd);
      const context = workflow
        ? `CIRCUIT BREAKER ACTIVE — OSCILLATION RESOLUTION MODE\n\nYou MUST follow this procedure immediately before doing anything else:\n\n${workflow}`
        : `CIRCUIT BREAKER ACTIVE — OSCILLATION RESOLUTION MODE\n\nOscillation has been detected in recent commits. Tool calls are NOT blocked — you can still read and write files — but you MUST resolve the oscillation before making further commits.\nFollow the oscillation resolution procedure in R5 of CLAUDE.md:\n1. Run: git log --oneline --name-only -6 to identify the oscillating file set.\n2. Run quorum diagnosis with structural coupling framing.\n3. Present unified solution to user for approval.\n4. Do NOT commit until user approves AND runs: npx nforma --reset-breaker`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: context,
        }
      }));
      process.exit(0);
    }

    // ── Priority 2: Pending task → inject queued command ─────────────────────
    const pendingTask = consumePendingTask(cwd, sessionId);
    if (pendingTask) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `PENDING QUEUED TASK — Execute this immediately before anything else:\n\n${pendingTask}\n\n(This task was queued via /nf:queue before the previous /clear.)`,
        }
      }));
      process.exit(0);
    }

    // ── Priority 3: Planning command → inject quorum instructions ────────────
    const config = loadConfig(cwd);

    // Profile guard — exit early if this hook is not active for the current profile
    const profile = config.hook_profile || 'standard';
    if (!shouldRunHook('nf-prompt', profile)) {
      process.exit(0);
    }

    const commands = config.quorum_commands;

    // Parse --n N override from the raw prompt
    const quorumSizeOverride = parseQuorumSizeFlag(prompt);

    // Dynamic fallback step generation from quorum_active (COMP-02)
    const activeSlots = (config.quorum_active && config.quorum_active.length > 0)
      ? config.quorum_active
      : null; // null = use hardcoded fallback list

    // Regex patterns for context injection (SESSION-01/02/03, ROOT-01/03, CONST-01/02)
    const DEBUG_FIX_REGEX = /\b(debug|fix\b|broken|failing|investigate|root cause|the bug is|the issue is|why.{0,20}not working|error.{0,10}when)\b/i;
    const EDIT_CONTENT_REGEX = /\b(rewrite|update the|change the|modify the|edit the|replace.{0,15}with|make it say)\b/i;
    const NEW_FEATURE_REGEX = /\b(create a new|add a new|build a new|implement a new|new feature|new component|new file)\b/i;

    let instructions;

    // Solo mode: --n 1 means Claude-only quorum — bypass all external slot dispatches
    if (quorumSizeOverride === 1) {
      instructions = `<!-- NF_SOLO_MODE -->\nSOLO MODE ACTIVE (--n 1): Self-quorum only. Skip ALL external slot-worker Task dispatches. Claude's vote is the quorum. Write <!-- GSD_DECISION --> in your final output. The Stop hook is informed.\n\n`;
    } else if (config.quorum_instructions) {
      // Explicit quorum_instructions in config — use as-is
      instructions = config.quorum_instructions;
    } else if (activeSlots) {
      // Build ordered slot list, sub agents first when preferSub is set
      const agentCfg = config.agent_config || {};
      const preferSub = !(config.quorum && config.quorum.preferSub === false);
      // Resolve maxSize ceiling: per-profile override > global default > hardcoded 3
      // --n N is a separate cap applied on top (see below).
      const profileKey = (() => {
        try {
          const cfgPath = path.join(process.cwd(), '.planning', 'config.json');
          const pcfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
          return pcfg.model_profile || null;
        } catch (_) { return null; }
      })();
      const perProfileN = profileKey && config.quorum?.maxSizeByProfile?.[profileKey];
      const globalN = (config.quorum && Number.isInteger(config.quorum.maxSize) && config.quorum.maxSize >= 1)
        ? config.quorum.maxSize : 3;
      const maxSize = Number.isInteger(perProfileN) && perProfileN >= 1 ? perProfileN : globalN;

      // Read risk_level from hook input context (passed by orchestrator via additionalContext or context_yaml)
      // Context YAML format: "risk_level: routine\n..." in input.context or input.context_yaml
      const contextYaml = (input.context || input.context_yaml || '').toString();
      const riskLevelMatch = contextYaml.match(/^risk_level:\s*(\S+)/m);
      const riskLevelFromContext = riskLevelMatch ? riskLevelMatch[1].trim() : null;

      // HOT-05: Hotspot risk escalation — if changed files include high-risk hotspots,
      // escalate quorum fan-out automatically. Fail-open: hotspot errors never block dispatch.
      let hotspotRiskLevel = null;
      try {
        const hotspotRiskModule = require(resolveBin('repowise/resolve-hotspot-risk.cjs'));
        const diffResult = spawnSync('git', ['diff', '--name-only', 'HEAD~1..HEAD'], {
          cwd, encoding: 'utf8', timeout: 5000,
        });
        if (diffResult.status === 0 && diffResult.stdout.trim()) {
          const changedFiles = diffResult.stdout.trim().split('\n').filter(Boolean);
          const hotspotResult = hotspotRiskModule.resolveHotspotRisk(changedFiles, cwd);
          if (hotspotResult.risk_level === 'high') {
            hotspotRiskLevel = 'high';
          } else if (hotspotResult.risk_level === 'medium' && riskLevelFromContext !== 'high') {
            hotspotRiskLevel = 'medium';
          }
        }
      } catch (_) { /* fail-open: hotspot errors never block dispatch */ }

      // Compute fan-out count. Priority chain:
      // 1. risk_level from context YAML or HOT-05 hotspot escalation → adaptive fan-out count
      // 2. config.quorum.maxSize (default ceiling)
      // 3. --n N user flag: treated as a MAXIMUM cap, not a mandatory value.
      //    min(risk-driven count, N) — so --n 3 with risk_level=low (→2) uses 2, not 3.
      // 4. available pool size (hard cap, applied via slice)
      const effectiveRiskLevel = hotspotRiskLevel || riskLevelFromContext;
      const riskDrivenCount = mapRiskLevelToCount(effectiveRiskLevel, maxSize);
      const fanOutCount = quorumSizeOverride !== null
        ? Math.min(riskDrivenCount, quorumSizeOverride)
        : riskDrivenCount;

      let orderedSlots = activeSlots.map(slot => ({
        slot,
        authType: (agentCfg[slot] && agentCfg[slot].auth_type) || 'api',
      }));

      // Guard: empty roster — no external agents configured at all
      if (orderedSlots.length === 0) {
        // Fail-open to solo mode: Claude is the only quorum participant
        process.stderr.write('[nf-dispatch] WARNING: no external agents in roster — falling back to solo quorum\n');
        instructions = `<!-- NF_SOLO_MODE -->\nSOLO MODE ACTIVE (empty roster): No external agents configured in providers.json or quorum_active. Claude's vote is the quorum. Write <!-- GSD_DECISION --> in your final output. The Stop hook is informed.\n\nTo add agents, run /nf:mcp-setup or edit ~/.claude/nf.json quorum_active.\n`;
      } else {
        if (preferSub) {
          orderedSlots.sort((a, b) => {
            if (a.authType === 'sub' && b.authType !== 'sub') return -1;
            if (a.authType !== 'sub' && b.authType === 'sub') return 1;
            return 0;
          });
        }

        // externalSlotCap = fanOutCount - 1 (Claude accounts for the +1 in total participants)
        const externalSlotCap = fanOutCount - 1;
        let cappedSlots = orderedSlots.slice(0, externalSlotCap);

      // DISP-01: Preflight filter — probe CLI-backed slots using quorum-preflight.cjs --all.
      // Covers Layer 1 (binary probe) + Layer 2 (upstream API probe).
      // Fail-open: preflight failures never block dispatch.
      const originalCappedSlotNames = new Set(cappedSlots.map(s => s.slot));
      const preflightResult = runPreflightFilter(cappedSlots);
      cappedSlots = preflightResult.filteredSlots;

      // SHORT-CIRCUIT: If preflight reports all capped slots down, try promoting remaining slots.
      // If promoted slots also fail, emit all-down message and exit.
      if (preflightResult.allDown && orderedSlots.length > 0) {
        // Compute remainingSlots: slots from orderedSlots that were NOT in the original capped set.
        // Use originalCappedSlotNames (pre-filter) so failed slots aren't re-promoted.
        const cappedSlotNames = originalCappedSlotNames;
        const remainingSlots = orderedSlots.filter(s => !cappedSlotNames.has(s.slot));

        if (remainingSlots.length > 0) {
          // Promote remaining slots up to externalSlotCap
          const promotedSlots = remainingSlots.slice(0, externalSlotCap);
          const promotedPreflightResult = runPreflightFilter(promotedSlots);
          const promotedFiltered = promotedPreflightResult.filteredSlots;

          if (promotedFiltered.length > 0) {
            // Promoted slots have survivors — use them instead of exiting
            process.stderr.write(`[nf-dispatch] ALLDOWN-PROMOTE: promoted ${promotedSlots.length} T2 slots after sub-type primaries failed preflight\n`);
            cappedSlots = promotedFiltered;
            // Continue to normal dispatch flow instead of exiting
          } else {
            // Promoted slots also all failed — emit all-down and exit
            const allFailedSlots = cappedSlots.concat(promotedSlots);
            const allFailedNames = new Set(allFailedSlots.map(s => s.slot));
            const combinedUnavail = preflightResult.unavailableSlots.filter(u => allFailedNames.has(u.name));
            const unavailList = combinedUnavail.map(u => u.name + ': ' + u.reason).join('; ');
            const allDownInstructions = `<!-- NF_ALL_SLOTS_DOWN -->\nAll quorum slots are currently unavailable (preflight probe failed for: ${unavailList}). Proceeding without quorum — Claude's vote is the quorum. Write <!-- GSD_DECISION --> in your final output.`;
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: allDownInstructions,
              }
            }));
            process.exit(0);
          }
        } else {
          // No remaining slots to promote — emit all-down and exit (original behavior)
          const unavailList = preflightResult.unavailableSlots.map(u => u.name + ': ' + u.reason).join('; ');
          const allDownInstructions = `<!-- NF_ALL_SLOTS_DOWN -->\nAll quorum slots are currently unavailable (preflight probe failed for: ${unavailList}). Proceeding without quorum — Claude's vote is the quorum. Write <!-- GSD_DECISION --> in your final output.`;
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: allDownInstructions,
            }
          }));
          process.exit(0);
        }
      }

      // Filter out recently failed slots (all error types, not just TIMEOUT).
      const recentFailures = getRecentlyFailedSlots(cwd);
      const skipSet = new Set(recentFailures.map(f => f.slot));
      cappedSlots = cappedSlots.filter(s => !skipSet.has(s.slot));

      // DISP-02: Filter by availability window (exclude cooling-down slots)
      const beforeAvail = cappedSlots.map(s => s.slot);
      cappedSlots = getAvailableSlots(cappedSlots, cwd);
      const availabilitySkips = beforeAvail.filter(s => !cappedSlots.some(c => c.slot === s));

      // DISP-03: Sort by descending success rate
      cappedSlots = sortBySuccessRate(cappedSlots, cwd);

      // ── TASK CLASSIFICATION: Filter slots by recommended model tier ────────
      if (taskClassifier && config.model_routing_enabled !== false) {
        const envelope = taskClassifier.readTaskEnvelope(cwd);
        const complexity = taskClassifier.classifyTask(envelope);
        const recommendation = taskClassifier.getModelRecommendation(complexity, config);

        // Concrete slot filtering: prefer slots matching the recommended tier.
        // TIER_SLOT_MAP maps tier names to slot family prefixes that match that tier.
        const TIER_SLOT_MAP = {
          haiku:  ['gemini', 'copilot', 'opencode'],
          sonnet: ['gemini', 'copilot', 'opencode', 'codex'],
          opus:   ['claude', 'codex'],
        };
        const preferredFamilies = TIER_SLOT_MAP[recommendation.tier] || [];
        if (preferredFamilies.length > 0 && cappedSlots.length > 0) {
          const preferred = cappedSlots.filter(s => preferredFamilies.some(f => s.slot.startsWith(f)));
          // Only filter if we'd still have at least 2 slots (need quorum diversity).
          if (preferred.length >= 2) {
            cappedSlots = preferred;
          }
        }

        // Store classification for thinking budget injection (after instructions are built)
        _nfClassification = recommendation;

        // Write classification to task-classification.json for downstream consumers
        try {
          const envPath = path.join(cwd, '.planning', 'task-classification.json');
          fs.writeFileSync(envPath, JSON.stringify({
            ts: new Date().toISOString(),
            complexity: recommendation.complexity,
            tier: recommendation.tier,
            thinking_budget: recommendation.thinking_budget,
            filtered_slots: cappedSlots.map(s => s.slot),
          }, null, 2) + '\n', 'utf8');
        } catch { /* fail-open */ }
      }

      // SC-4: Graceful fallback — ensure at least one slot in dispatch list
      if (cappedSlots.length === 0 && orderedSlots.length > 0) {
        const relaxedSlots = orderedSlots.filter(s => !skipSet.has(s.slot));
        if (relaxedSlots.length > 0) {
          cappedSlots = [relaxedSlots[0]];
        } else {
          cappedSlots = [orderedSlots[0]]; // last resort: any slot at all
        }
        process.stderr.write(`[nf-dispatch] FALLBACK: all slots filtered, restored ${cappedSlots[0].slot}\n`);
      }

      // ── MODEL DEDUPLICATION: Remove duplicate-model slots from primary dispatch ────
      // Slots sharing the same underlying model are demoted to fallback tier for LLM diversity.
      // This happens AFTER the externalSlotCap slice to ensure we maximize model diversity
      // within the fan-out budget.
      const providersList = findProviders();
      const dedupResult = deduplicateByModel(cappedSlots, agentCfg, providersList);
      const uniqueSlots = dedupResult.unique;
      const modelDedupSlots = dedupResult.duplicates;

      // Record the actually-dispatched roster size for the cache pending-entry write.
      _nfDispatchSlotCount = uniqueSlots.length;

      // ── CACHE CHECK: Short-circuit quorum dispatch on valid cache hit ──────
      // Keyed on uniqueSlots — the FINAL dispatched roster, computed AFTER the SC-4
      // fallback restore and the model dedup above. Keying earlier (on cappedSlots)
      // would let a hit replay a result for a composition that never ran, and let
      // identical real compositions miss each other's cache.
      try {
        const cacheModule = require(resolveBin('quorum-cache.cjs'));
        const cacheDir = path.join(cwd, '.planning', '.quorum-cache');
        const cacheKey = cacheModule.computeCacheKey(prompt, contextYaml, uniqueSlots, config.quorum_active, cacheModule.getGitHead());

        const cachedEntry = cacheModule.readCache(cacheKey, cacheDir);
        if (cachedEntry && cacheModule.isCacheValid(cachedEntry, cacheModule.getGitHead(), config.quorum_active || [])) {
          // Cache hit — serve cached result without dispatching slots
          const ageMs = Date.now() - new Date(cachedEntry.created).getTime();
          const timeAgo = ageMs < 3600000
            ? Math.round(ageMs / 60000) + 'm ago'
            : Math.round(ageMs / 3600000) + 'h ago';

          appendConformanceEvent({
            ts:              new Date().toISOString(),
            phase:           'DECIDING',
            action:          'cache_hit',
            cache_key:       cacheKey.slice(0, 12),
            slots_available: cachedEntry.slot_count,
            vote_result:     cachedEntry.vote_result,
            outcome:         'APPROVE',
            schema_version,
          });

          const cacheInstructions = `<!-- NF_CACHE_HIT -->\n<!-- NF_CACHE_KEY:${cacheKey} -->\nQUORUM CACHE HIT: Identical dispatch was completed ${timeAgo}.\nCached result: ${cachedEntry.vote_result} of ${cachedEntry.slot_count} slots approved.\nDecision: ${cachedEntry.outcome}\nSkip all slot-worker Task dispatches. Use this cached quorum result.\nInclude <!-- GSD_DECISION --> in your final output.`;

          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: cacheInstructions,
            }
          }));
          process.exit(0);
        }

        // Cache miss — store key for embedding in instructions and pending entry write
        _nfCacheKey = cacheKey;
        _nfCacheModule = cacheModule;
        _nfCacheDir = cacheDir;
      } catch (cacheErr) {
        // Fail-open: cache errors never prevent normal quorum dispatch
        process.stderr.write('[nf] cache check failed (fail-open): ' + (cacheErr.message || cacheErr) + '\n');
        _nfCacheKey = null;
        _nfCacheModule = null;
        _nfCacheDir = null;
      }

      // Generate step list, with optional section headers when preferSub is on
      let stepLines = [];
      let stepNum = 1;
      const hasMixed = preferSub && uniqueSlots.some(s => s.authType === 'sub') && uniqueSlots.some(s => s.authType !== 'sub');
      let inApiSection = false;
      for (const { slot, authType } of uniqueSlots) {
        if (hasMixed && authType !== 'sub' && !inApiSection) {
          stepLines.push('  [API agents — overflow if sub count insufficient]');
          inApiSection = true;
        }
        stepLines.push(`  ${stepNum}. Task(subagent_type="nf-quorum-slot-worker", prompt="slot: ${slot}\\nround: 1\\ntimeout_ms: 60000\\nrepo_dir: <cwd>\\nmode: A\\nquestion: <question>")`);
        stepNum++;
      }
      const dynamicSteps = stepLines.join('\n');
      const afterSteps = uniqueSlots.length + 1;

      // Compute T1 unused sub-CLI slots: sub agents cut by the fan-out cap.
      // These are the preferred replacement tier when a dispatched slot returns UNAVAIL.
      // They must be tried before any T2 ccr/api slots (claude-1..6).
      // IMPORTANT: Apply skipSet to fallback tiers too — a slot that failed recently
      // should not be dispatched as a fallback either (prevents cascading UNAVAIL waste).
      const cappedSlotNames = new Set(uniqueSlots.map(s => s.slot));
      const t1Unused = orderedSlots
        .filter(s => s.authType === 'sub' && !cappedSlotNames.has(s.slot) && !skipSet.has(s.slot))
        .map(s => s.slot);
      const t2Slots = orderedSlots
        .filter(s => s.authType !== 'sub' && !cappedSlotNames.has(s.slot) && !skipSet.has(s.slot))
        .map(s => s.slot);

      const tModelDedup = modelDedupSlots.map(s => s.slot);
      const failoverRule = buildFalloverRule(uniqueSlots, t1Unused, t2Slots, maxSize, tModelDedup);

      // Emit a conformance event when FALLBACK-01 is active so audit tooling can detect
      // cases where T2 was used without T1 being exhausted first.
      if (t1Unused.length > 0 || t2Slots.length > 0) {
        try {
          const pp = require(require('path').join(__dirname, '..', 'bin', 'planning-paths.cjs'));
          const logPath = pp.resolve(cwd, 'conformance-events');
          require('fs').appendFileSync(logPath, JSON.stringify({
            type: 'quorum_fallback_t1_required',
            t1Slots: t1Unused,
            t2Slots,
            primarySlots: uniqueSlots.map(s => s.slot),
            fanOutCount,
            ts: new Date().toISOString(),
          }) + '\n', 'utf8');
        } catch (_) { /* non-fatal — conformance logging must not block quorum */ }
      }

      // Always emit --n N so Stop hook's parseQuorumSizeFlag reads the correct ceiling.
      // When user passed --n N explicitly: show OVERRIDE note.
      // Build the quorum size note emitted into Claude's context.
      // --n N is a maximum cap; the actual fanOutCount may be lower due to risk_level.
      const riskSource = hotspotRiskLevel ? `hotspot:${hotspotRiskLevel}` : (riskLevelFromContext || 'default');
      let minNote;
      if (quorumSizeOverride !== null) {
        const capNote = fanOutCount < quorumSizeOverride
          ? `--n ${quorumSizeOverride} (max) → ${fanOutCount} via risk_level=${riskSource}`
          : `--n ${quorumSizeOverride}`;
        minNote = ` (${capNote}: Claude + ${externalSlotCap} external slot${externalSlotCap !== 1 ? 's' : ''})`;
      } else if (effectiveRiskLevel && fanOutCount < maxSize) {
        minNote = ` (--n ${fanOutCount} — risk_level: ${riskSource} → ${externalSlotCap} external slot${externalSlotCap !== 1 ? 's' : ''})`;
      } else {
        minNote = ` (--n ${fanOutCount})`;
      }

      // Build health dashboard and skip notes for Claude's context
      let healthDashboard = '';
      const totalSlots = orderedSlots.length;
      const dispatchCount = uniqueSlots.length;
      const skippedSlots = [];

      let skipNote = '';
      if (recentFailures.length > 0) {
        const failureDetail = recentFailures.map(f => `${f.slot} (${f.error_type}: ${(f.pattern || '').slice(0, 40)})`).join('; ');
        skipNote += `SKIP (FAILED < 5min ago): [${failureDetail}] — do NOT dispatch these slots in ANY tier.\n`;
        skippedSlots.push(...recentFailures.map(f => ({ slot: f.slot, reason: f.error_type })));
      }
      if (preflightResult.unavailableSlots && preflightResult.unavailableSlots.length > 0) {
        const preflightDown = preflightResult.unavailableSlots.map(u => u.name + ': ' + u.reason).join('; ');
        skipNote += `SKIP (PREFLIGHT DOWN): [${preflightDown}] — preflight probe confirmed unavailable.\n`;
        for (const u of preflightResult.unavailableSlots) {
          if (!skippedSlots.some(s => s.slot === u.name)) {
            skippedSlots.push({ slot: u.name, reason: u.reason });
          }
        }
      }
      if (availabilitySkips.length > 0) {
        skipNote += `SKIP (COOLING DOWN): [${availabilitySkips.join(', ')}] — available_at in future, skipping.\n`;
        skippedSlots.push(...availabilitySkips.map(s => ({ slot: s, reason: 'cooling down' })));
      }

      // Build compact health dashboard when there are skipped slots
      if (skippedSlots.length > 0) {
        healthDashboard = `SLOT HEALTH: ${dispatchCount} dispatching, ${skippedSlots.length} skipped of ${totalSlots} total\n` +
          skippedSlots.map(s => `  ✗ ${s.slot}: ${s.reason}`).join('\n') + '\n\n';
      }

      instructions = `QUORUM REQUIRED${minNote} (structural enforcement — Stop hook will verify)\n\n` +
        healthDashboard +
        `Run the full R3 quorum protocol inline (dispatch_pattern from commands/nf/quorum.md):\n` +
        `Dispatch ALL active slots as parallel sibling nf-quorum-slot-worker Tasks in ONE message turn.\n` +
        `NEVER call mcp__*__* tools directly — use Task(subagent_type="nf-quorum-slot-worker") ONLY:\n` +
        (hasMixed ? '  [Subscription agents — preferred, flat-fee]\n' : '') +
        dynamicSteps + '\n\n' +
        skipNote +
        failoverRule + '\n\n' +
        `After quorum:\n` +
        `  ${afterSteps}. Synthesize results inline. Deliberate up to 10 rounds per R3.3 if no consensus.\n` +
        `  ${afterSteps + 1}. Update scoreboard: node ~/.claude/nf-bin/update-scoreboard.cjs merge-wave ...\n` +
        `  ${afterSteps + 2}. [HEAL-01] After EACH deliberation round's merge-wave, check early escalation:\n` +
        `       node ~/.claude/nf-bin/quorum-consensus-gate.cjs --min-quorum=2 --remaining-rounds=R\n` +
        `       where R = (maxDeliberation - currentRound). For example, on round 2 of 7 max: --remaining-rounds=5.\n` +
        `       If exit code 1 (shouldEscalate=true, P(consensus|remaining) below 10% threshold), stop deliberating and proceed to decision immediately.\n` +
        `       This prevents wasting rounds when consensus is mathematically unlikely.\n` +
        `  ${afterSteps + 3}. Include the token <!-- GSD_DECISION --> in your FINAL output\n\n` +
        (failoverRule.includes('FALLBACK-01')
          ? `Fail-open: ONLY after exhausting ALL fallback tiers in FALLBACK-01 above. Do NOT skip fallback dispatch.\n`
          : `Fail-open: if all dispatched slots return UNAVAIL, proceed without quorum.\n`) +
        `The Stop hook reads the transcript — skipping quorum will block your response.`;
      }
    } else {
      // Neither quorum_instructions nor quorum_active configured — use hardcoded fallback
      instructions = DEFAULT_QUORUM_INSTRUCTIONS_FALLBACK;
    }

    // Append model override block if any preferences are set.
    // Skip when activeSlots is configured: Task-based dispatch uses call-quorum-slot.cjs which
    // reads the model from providers.json — injecting mcp__*__* tool names here would
    // re-introduce the direct-MCP escape hatch that the activeSlots branch eliminates.
    const prefs = config.model_preferences || {};
    const overrideEntries = Object.entries(prefs).filter(([, m]) => m && typeof m === 'string');
    if (overrideEntries.length > 0 && !activeSlots) {
      const lines = overrideEntries.map(([agent, model]) => {
        const tool = slotToToolCall(agent);
        return '  - When calling ' + tool + ', include model="' + model + '" in the tool input';
      }).join('\n');
      instructions += '\n\nModel overrides (from nf.json model_preferences):\n' +
        'The following agents have preferred models configured. Pass the specified model parameter:\n' +
        lines;
    }

    // ── THINKING BUDGET: Inject classification directive into instructions ──
    if (typeof _nfClassification !== 'undefined' && _nfClassification) {
      const rec = _nfClassification;
      const thinkingDirective = `\n\nTHINKING BUDGET: Task classified as "${rec.complexity}" (${rec.description}). ` +
        `Use maximum ${rec.thinking_budget} thinking tokens. ` +
        `Model tier recommendation: ${rec.tier}.`;
      instructions += thinkingDirective;
    }

    // Context stack injection (ORCH-02)
    // Hook-level cap is 800 chars, intentionally tighter than the module-level
    // INJECTION_CAP_CHARS (2000 chars), because additionalContext in hooks
    // contends with other injections (quorum instructions, circuit breaker
    // recovery prompt, thinking budget). Keeping this small avoids crowding
    // out higher-priority hook content.
    if (contextStack) {
      try {
        let currentPhase = null;
        const phaseMatch = prompt.match(/v[\d.]+-\d+/);
        if (phaseMatch) currentPhase = phaseMatch[0];
        const stackInjection = contextStack.formatInjection(cwd, currentPhase || 'unknown');
        if (stackInjection && stackInjection.length <= 800) {
          instructions += '\n\n' + stackInjection;
        }
      } catch (_) { /* fail-open */ }
    }

    // ── SESSION STATE INJECTION (SESSION-01/02/03) ──
    // Inject STATE.md summary on first message of each session only.
    // Fail-open: missing STATE.md or read errors are silently skipped.
    if (isFirstMessageOfSession(cwd, sessionId)) {
      try {
        const statePath = path.join(cwd, '.planning', 'STATE.md');
        if (fs.existsSync(statePath)) {
          const stateContent = fs.readFileSync(statePath, 'utf8');
          const stateContext = extractStateContext(stateContent);
          if (stateContext && stateContext.length > 0 && stateContext.length <= 500) {
            instructions += '\n\nSESSION CONTEXT (from STATE.md):\n' + stateContext;
          }
        }
      } catch (_) { /* fail-open: STATE.md read failure is non-fatal */ }
    }

    // ── ROOT CAUSE TEMPLATE INJECTION (ROOT-01, ROOT-03) ──
    // On prompts matching debug/fix patterns, inject causal reasoning template.
    // Fail-open: regex errors silently skip injection.
    try {
      if (DEBUG_FIX_REGEX.test(prompt)) {
        instructions += '\n\nROOT CAUSE ENFORCEMENT: This prompt describes a bug or failure.\n' +
          'Before proposing any fix, you MUST:\n' +
          '1. State the root cause hypothesis (what mechanism is failing and why)\n' +
          '2. Identify the assumption the proposed fix relies on\n' +
          '3. Confirm the fix addresses the root cause, not just the symptom\n' +
          'Do NOT patch symptoms without identifying the root cause first.';
      }
    } catch (_) { /* fail-open */ }

    // ── CO-CHANGE DEBUG INJECTION (COCH-04) ──
    // When debugging, inject co-change partners for files mentioned in the prompt.
    // Fail-open: co-change errors never block dispatch.
    try {
      if (DEBUG_FIX_REGEX.test(prompt)) {
        const cochangeModule = require(resolveBin('repowise/inject-cochange-debug.cjs'));
        // Extract file paths mentioned in the prompt
        const filePathMatch = prompt.match(/(?:^|\s)([\w/.-]+\.\w{1,4})(?:\s|$)/g);
        if (filePathMatch) {
          const mentionedFiles = filePathMatch.map(m => m.trim()).filter(Boolean);
          for (const f of mentionedFiles.slice(0, 3)) {
            const injection = cochangeModule.injectCoChangeDebug(f, cwd);
            if (injection) {
              instructions += '\n\n' + injection;
              break; // only inject once
            }
          }
        }
      }
    } catch (_) { /* fail-open: co-change debug injection is non-fatal */ }

    // ── EDIT CONSTRAINT INJECTION (CONST-01, CONST-02) ──
    // On edit/content prompts (that are NOT debug/fix AND NOT new-feature requests),
    // inject edit-in-place preference. Fail-open on regex errors.
    try {
      if (!DEBUG_FIX_REGEX.test(prompt) && EDIT_CONTENT_REGEX.test(prompt) && !NEW_FEATURE_REGEX.test(prompt)) {
        instructions += '\n\nEDIT CONSTRAINT: This prompt involves editing existing content.\n' +
          'Prefer in-place edits over creating new files or full rewrites.\n' +
          'Identify the minimal change that achieves the goal.\n' +
          'State what you are keeping unchanged before describing what changes.';
      }
    } catch (_) { /* fail-open */ }

    // Anchored allowlist — requires /nf: or /qnf: prefix and word boundary after command name.
    // Strict mode: match ANY /nf: or /qnf: command, not just quorum_commands list.
    const cmdPattern = profile === 'strict'
      ? /^\s*\/(q?nf):[\w][\w-]*(\s|$)/
      : new RegExp('^\\s*\\/(q?nf):(' + commands.join('|') + ')(\\s|$)');
    if (!cmdPattern.test(prompt)) {
      process.exit(0); // Silent pass — UPS-05
    }

    // EXEC-01: Detect review/verification commands for review_mode injection.
    // These commands should trigger review-only dispatch (--review-only flag)
    // so review slots are restricted to read-only tools.
    const reviewCmdPattern = /^\s*\/(q?nf):(verify-work|check)\b/;
    const isReviewTask = reviewCmdPattern.test(prompt);

    // ── CACHE MISS: Embed cache key marker and write pending entry ──────────
    if (typeof _nfCacheKey === 'string' && _nfCacheKey && _nfCacheModule && _nfCacheDir) {
      try {
        instructions = `<!-- NF_CACHE_KEY:${_nfCacheKey} -->\n` + instructions;
        _nfCacheModule.writeCache(_nfCacheKey, {
          version: 1,
          key: _nfCacheKey,
          created: new Date().toISOString(),
          ttl_ms: (config.cache_ttl_ms || 3600000),
          git_head: _nfCacheModule.getGitHead(),
          quorum_active: (config.quorum_active || []).slice(),
          slot_count: _nfDispatchSlotCount,
        }, _nfCacheDir);
      } catch (pendingErr) {
        // Fail-open: pending entry write failure never blocks dispatch
        process.stderr.write('[nf] cache pending write failed (fail-open): ' + (pendingErr.message || pendingErr) + '\n');
      }
    }

    // EXEC-01: Inject review_mode instruction for verification/review commands
    if (isReviewTask) {
      instructions += '\n\nREVIEW MODE: All quorum slot dispatches for this task MUST use --review-only flag.\n' +
        'Pass --review-only to quorum-slot-dispatch.cjs so review slots are restricted to read-only tools.';
    }

    appendConformanceEvent({
      ts:              new Date().toISOString(),
      phase:           'IDLE',
      action:          'quorum_start',
      slots_available: 0,
      vote_result:     null,
      outcome:         null,
      schema_version,
    });

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: instructions,
      }
    }));
    process.exit(0);

  } catch (e) {
    if (e instanceof SyntaxError) {
      process.stderr.write('[nf] WARNING: nf-prompt: malformed JSON on stdin: ' + e.message + '\n');
    }
    process.exit(0); // Fail-open on any error
  }
});
} // end require.main === module guard

// Export helpers for unit testing (tree-shaken at runtime — no cost)
// The file is a script and exits via process.exit() before reaching this line in normal operation.
// When require()d by tests, stdin handlers are not registered (guarded by require.main check).
if (typeof module !== 'undefined') {
  module.exports = module.exports || {};
  module.exports.mapRiskLevelToCount = mapRiskLevelToCount;
  module.exports.parseQuorumSizeFlag = parseQuorumSizeFlag;
  module.exports.getAvailableSlots = getAvailableSlots;
  module.exports.sortBySuccessRate = sortBySuccessRate;
  module.exports.deduplicateByModel = deduplicateByModel;
  module.exports.buildFalloverRule = buildFalloverRule;
}

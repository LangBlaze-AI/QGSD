#!/usr/bin/env node
// hooks/nf-stop.js
// Stop hook — quorum verification gate for NF planning commands.
//
// Reads JSON from stdin (Claude Code Stop event payload), applies guards in
// strict order, then scans the current-turn transcript window for quorum
// evidence. Blocks with decision:block if a planning command was issued but
// quorum tool calls are missing. Fails open on all errors.
//
// Config: ~/.claude/nf.json (two-layer merge via shared config-loader)
// Unavailability: reads ~/.claude.json mcpServers to detect which models are installed
//   (NF_CLAUDE_JSON env var overrides the path — for testing only)

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadConfig, DEFAULT_CONFIG, slotToToolCall, shouldRunHook, validateHookInput } = require('./config-loader');
const { schema_version } = require('./conformance-schema.cjs');
const resolveBin = require('./nf-resolve-bin');

// Cache module — fail-open: if require fails, all cache logic is skipped
let cacheModule = null;
try {
  cacheModule = require(resolveBin('quorum-cache.cjs'));
} catch (_) { /* fail-open: cache unavailable */ }

// Checkpoint module — schema + reader for the structured FALLBACK-01 checkpoint
// file (issue #172). A genuinely missing module is fail-open (enforcement is
// skipped). A syntax/runtime error inside the module is NOT silently swallowed
// — it is surfaced on stderr so a broken gate does not hide behind fail-open.
let checkpointModule = null;
try {
  checkpointModule = require(resolveBin('quorum-checkpoint.cjs'));
} catch (err) {
  if (!err || err.code === 'MODULE_NOT_FOUND' || err.code === 'ENOENT') {
    checkpointModule = null; // genuinely absent — fail-open
  } else {
    process.stderr.write(
      '[nf-stop] WARNING: failed to load quorum-checkpoint module (FALLBACK-01 ' +
      'enforcement degraded): ' + (err.message || err) + '\n'
    );
  }
}

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

// Auto-commits dirty .planning/formal/ files before session ends.
// Called post-decision — does NOT affect PASS/BLOCK quorum logic.
// Fail-open: never blocks session exit on commit failure.
function autoCommitFormalArtifacts() {
  try {
    const { spawnSync } = require('child_process');
    const SPAWN_OPTS = { cwd: process.cwd(), timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] };

    // 1. Check branch safety — skip on protected branches
    const branchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], SPAWN_OPTS);
    const branch = (branchResult.stdout || '').toString().trim();
    const protectedBranches = ['main', 'master'];
    if (protectedBranches.includes(branch)) {
      process.stderr.write('[nf] formal auto-commit skipped: protected branch ' + branch + '\n');
      return;
    }

    // 2. Detect unstaged modified formal files
    const diffResult = spawnSync('git', ['diff', '--name-only', '--', '.planning/formal/'], SPAWN_OPTS);
    const unstagedFiles = (diffResult.stdout || '').toString().trim().split('\n').filter(Boolean);

    // 3. Detect staged-only formal files
    const stagedResult = spawnSync('git', ['diff', '--cached', '--name-only', '--', '.planning/formal/'], SPAWN_OPTS);
    const stagedFiles = (stagedResult.stdout || '').toString().trim().split('\n').filter(Boolean);

    // 4. Detect untracked formal files
    const untrackedResult = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '.planning/formal/'], SPAWN_OPTS);
    const untrackedFiles = (untrackedResult.stdout || '').toString().trim().split('\n').filter(Boolean);

    // Combine and deduplicate (unstaged + staged + untracked)
    const allFiles = [...new Set([...unstagedFiles, ...stagedFiles, ...untrackedFiles])];
    if (allFiles.length === 0) return; // Nothing to commit — exit silently

    // 4. Stage and commit via nf-tools.cjs
    const nfToolsPath = resolveBin('nf-tools.cjs');
    const commitArgs = [nfToolsPath, 'commit', 'chore: [auto] sync regenerated formal artifacts', '--files', ...allFiles];
    const commitResult = spawnSync(process.execPath, commitArgs, SPAWN_OPTS);
    if (commitResult.status !== 0) {
      const errMsg = (commitResult.stderr || '').toString().trim();
      process.stderr.write('[nf] formal auto-commit warning: exit ' + commitResult.status + (errMsg ? ' — ' + errMsg : '') + '\n');
    }
  } catch (acErr) {
    process.stderr.write('[nf] formal auto-commit failed (fail-open): ' + (acErr.message || acErr) + '\n');
  }
}

// Builds the regex that matches /nf:<cmd> or /qnf:<cmd> in any text.
function buildCommandPattern(quorumCommands) {
  const escaped = quorumCommands.map(c => c.replace(/-/g, '\\-'));
  return new RegExp('\\/(q?nf):(' + escaped.join('|') + ')');
}

// Returns true if a parsed JSONL user entry is a human text message.
// Excludes tool_result-only messages (intermediate turn messages from
// multi-step tool call sequences) which also use type:"user" in the JSONL.
function isHumanMessage(entry) {
  const content = entry.message?.content;
  if (typeof content === 'string') return content.length > 0;
  if (Array.isArray(content)) return content.some(c => c?.type === 'text');
  return false;
}

// Scans backward from end to find last HUMAN user message boundary.
// Skips tool_result user messages — those are intermediate turn messages,
// not human turn boundaries. Returns all lines from the boundary forward.
// If no human message is found, returns all lines (conservative — treats
// whole transcript as current turn to avoid false passes).
function getCurrentTurnLines(lines) {
  let lastUserIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'user' && isHumanMessage(entry)) {
        lastUserIdx = i;
        break;
      }
    } catch {
      // Skip malformed lines
    }
  }
  return lastUserIdx >= 0 ? lines.slice(lastUserIdx) : lines;
}

// Extracts the value of the <command-name> XML tag injected by Claude Code for real slash command
// invocations. Returns the trimmed tag content or null if the tag is absent.
// This tag is ONLY present for actual invocations — never in @file-expanded workflow content.
function extractCommandTag(entry) {
  let text = '';
  const content = entry.message?.content;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const first = content.find(c => c?.type === 'text');
    text = first ? (first.text || '') : '';
  }
  const m = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  return m ? m[1].trim() : null;
}

// Returns true if any user entry in currentTurnLines contains an NF quorum command.
// Uses XML-tag-first strategy: if a <command-name> tag is present, only that tag is tested
// against cmdPattern (never the full body). Falls back to first 300 chars of message text
// when no tag is found, to avoid matching @file-expanded workflow content.
function hasQuorumCommand(currentTurnLines, cmdPattern) {
  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user') continue;
      const tag = extractCommandTag(entry);
      if (tag !== null) {
        // Tag present: test only the tag value — do NOT fall through to body scan
        if (cmdPattern.test(tag)) return true;
        continue;
      }
      // No tag: fall back to first 300 chars of message text (avoids @file-expanded content)
      const content = entry.message?.content;
      let textContent = '';
      if (typeof content === 'string') {
        textContent = content;
      } else if (Array.isArray(content)) {
        const first = content.find(c => c?.type === 'text');
        textContent = first ? (first.text || '') : '';
      }
      if (cmdPattern.test(textContent.slice(0, 300))) return true;
    } catch {
      // Skip malformed lines
    }
  }
  return false;
}

// Extracts the matched /nf:<cmd> or /qnf:<cmd> text from the first matching user line.
// Uses XML-tag-first strategy: prefers the <command-name> tag for accurate command identification.
// Falls back to first 300 chars of message text, then to '/nf:plan-phase' as ultimate fallback.
function extractCommand(currentTurnLines, cmdPattern) {
  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user') continue;
      const tag = extractCommandTag(entry);
      if (tag !== null) {
        const tagMatch = cmdPattern.exec(tag);
        if (tagMatch) return tagMatch[0];
        continue; // Tag present but wrong command — do not fall through
      }
      // No tag: fall back to first 300 chars of message text
      const content = entry.message?.content;
      let textContent = '';
      if (typeof content === 'string') {
        textContent = content;
      } else if (Array.isArray(content)) {
        const first = content.find(c => c?.type === 'text');
        textContent = first ? (first.text || '') : '';
      }
      const textMatch = cmdPattern.exec(textContent.slice(0, 300));
      if (textMatch) return textMatch[0];
    } catch {
      // Skip malformed lines
    }
  }
  return '/nf:plan-phase';
}

// Returns true if any assistant turn used Task(subagent_type=nf-quorum-slot-worker).
// Slot-workers are the inline dispatch mechanism — one per active slot per round.
// Replaced nf-quorum-orchestrator (deprecated quick-103) as full quorum evidence.
function wasSlotWorkerUsed(currentTurnLines) {
  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type !== 'tool_use' || block.name !== 'Task') continue;
        const input = block.input || {};
        const subagentType = input.subagent_type || input.subagentType || '';
        if (subagentType === 'nf-quorum-slot-worker') return true;
      }
    } catch { /* skip */ }
  }
  return false;
}

// Returns true if any assistant turn made a tool_use call whose name starts with prefix.
function wasSlotCalled(currentTurnLines, prefix) {
  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_use' && block.name && block.name.startsWith(prefix)) return true;
      }
    } catch { /* skip */ }
  }
  return false;
}

// Returns true if the slot was called AND its tool_result was NOT an error.
// Specifically:
// 1. Scans for assistant entries with tool_use blocks whose name starts with prefix. Records IDs.
// 2. Scans for user entries whose content contains a tool_result matching one of those IDs.
// 3. If the tool_result content contains "type":"tool_error" or is_error:true, returns false.
// 4. If a matching non-error tool_result exists, returns true.
// 5. If no tool_use found for this prefix, returns false.
// Errors and quota responses do NOT count toward the ceiling.
function wasSlotCalledSuccessfully(currentTurnLines, prefix) {
  // Step 1: collect tool_use IDs for this prefix
  const toolUseIds = new Set();
  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_use' && block.name && block.name.startsWith(prefix)) {
          if (block.id) toolUseIds.add(block.id);
        }
      }
    } catch { /* skip */ }
  }

  if (toolUseIds.size === 0) return false; // No tool_use found for this prefix

  // Step 2: find matching tool_result entries and check for errors
  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user') continue;
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        if (!toolUseIds.has(block.tool_use_id)) continue;
        // Matching tool_result found — check for error
        const contentStr = JSON.stringify(block.content || '');
        const isError = block.is_error === true || contentStr.includes('"type":"tool_error"');
        if (isError) return false; // Error/quota response — does not count
        return true; // Non-error response — counts toward ceiling
      }
    } catch { /* skip */ }
  }

  // tool_use found but no tool_result yet — treat as not successfully called
  return false;
}

// Builds the ordered agent pool from config.
// If quorum_active is set, derives pool from it (preferred path).
// Falls back to required_models for backward compat.
// Returns array of { slot, prefix, authType, callTool }.
function buildAgentPool(config) {
  const agentConfig = config.agent_config || {};
  const quorumActive = config.quorum_active || [];

  let entries;
  if (quorumActive.length > 0) {
    entries = quorumActive.map(slot => ({
      slot,
      prefix:   'mcp__' + slot + '__',
      authType: (agentConfig[slot] && agentConfig[slot].auth_type) || 'api',
      callTool: slotToToolCall(slot),
    }));
  } else {
    // Backward compat: derive from required_models
    // Use deriveMissingToolName to get canonical tool names (e.g. copilot → __ask not __copilot)
    entries = Object.entries(config.required_models || {}).map(([key, def]) => ({
      slot:     key,
      prefix:   def.tool_prefix,
      authType: 'api',
      callTool: deriveMissingToolName(key, def),
    }));
  }

  // Sort sub before api when preferSub is enabled
  if (config.quorum && config.quorum.preferSub) {
    entries.sort((a, b) => {
      if (a.authType === 'sub' && b.authType !== 'sub') return -1;
      if (a.authType !== 'sub' && b.authType === 'sub') return 1;
      return 0;
    });
  }

  return entries;
}

// Reads ~/.claude.json to determine which MCP servers are registered.
// Returns an array of derived tool prefixes (e.g. ['mcp__codex-cli-1__', 'mcp__gemini-cli-1__']).
// Returns null if the file is missing or malformed — callers treat null as "unknown" (conservative).
//
// TESTING ONLY: set NF_CLAUDE_JSON env var to override the file path.
// In production, always reads ~/.claude.json.
//
// KNOWN LIMITATION: Only reads ~/.claude.json (user-scoped MCPs). Project-scoped MCPs
// configured in .mcp.json are not checked. If a required model is only configured at
// project level, it will be classified as unavailable and skipped (fail-open).
// In practice, quorum models (Codex, Gemini, OpenCode) are global tools.
function getAvailableMcpPrefixes() {
  const claudeJsonPath = process.env.NF_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(claudeJsonPath)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const servers = d.mcpServers || {};
    return Object.keys(servers).map(name => 'mcp__' + name + '__');
  } catch (e) {
    process.stderr.write('[nf] WARNING: Could not parse ~/.claude.json: ' + e.message + '\n');
    return null;
  }
}

// Planning artifact file path patterns — matches only planning artifacts, not codebase docs.
// Each pattern is specific enough to avoid false positives from ls/cat/grep Bash calls.
const ARTIFACT_PATTERNS = [
  /-PLAN\.md/,        // e.g. 04-01-PLAN.md
  /-RESEARCH\.md/,    // e.g. 04-RESEARCH.md
  /-CONTEXT\.md/,     // e.g. 04-CONTEXT.md (discuss-phase output)
  /-UAT\.md/,         // e.g. 04-UAT.md (verify-work UAT output)
  /ROADMAP\.md/,      // ROADMAP.md (new-project, new-milestone)
  /REQUIREMENTS\.md/, // REQUIREMENTS.md (new-project)
  /PROJECT\.md/,      // PROJECT.md (new-project early commit)
];

// Counts the number of distinct quorum dispatch rounds in the current turn.
// A dispatch round is one assistant message that contains at least one Task tool_use
// block targeting nf-quorum-slot-worker. Multiple parallel dispatches within one
// assistant message count as a single round (they are dispatched simultaneously).
// Returns Math.max(1, rounds) — at least round 1 even if no explicit dispatch detected.
function countDeliberationRounds(currentTurnLines) {
  let rounds = 0;
  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      let hasSlotWorker = false;
      for (const block of content) {
        if (block.type === 'tool_use' && block.name === 'Task') {
          const inputStr = JSON.stringify(block.input || {});
          if (inputStr.includes('nf-quorum-slot-worker')) {
            hasSlotWorker = true;
            break; // One per assistant message — no need to check more blocks
          }
        }
      }
      if (hasSlotWorker) rounds++;
    } catch { /* skip malformed lines */ }
  }
  return Math.max(1, rounds);
}

// Returns true if the current turn contains a Bash tool_use block that BOTH:
// (a) invokes nf-tools.cjs commit, AND
// (b) references a planning artifact file path (not codebase/*.md).
// Requiring both conditions prevents false positives from ls/cat/grep commands.
function hasArtifactCommit(currentTurnLines) {
  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant') continue;
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        if (block.name !== 'Bash') continue;
        const cmdStr = JSON.stringify(block.input || '');
        // Both conditions must hold in the same Bash block
        if (!cmdStr.includes('nf-tools.cjs commit')) continue;
        if (ARTIFACT_PATTERNS.some(p => p.test(cmdStr))) return true;
      }
    } catch { /* skip */ }
  }
  return false;
}

// Returns the current turn's start time (ms epoch) from the boundary human
// message line, or null if unavailable. getCurrentTurnLines() returns lines
// sliced from the last human user message, so currentTurnLines[0] is that
// message and carries the turn-start timestamp.
function getTurnStartTime(currentTurnLines) {
  if (!currentTurnLines || currentTurnLines.length === 0) return null;
  try {
    const entry = JSON.parse(currentTurnLines[0]);
    if (entry && typeof entry.timestamp === 'string') {
      const t = Date.parse(entry.timestamp);
      return Number.isNaN(t) ? null : t;
    }
  } catch { /* fall through */ }
  return null;
}

// Evaluates whether a structured FALLBACK-01 checkpoint (issue #172) clears the
// gate for a dispatch round that contained UNAVAIL. Reads + schema-validates
// .planning/quorum/checkpoints/round-<N>.json — the transcript regex is gone,
// so LLM stylistic variation in any HTML comment cannot bypass or trigger the
// gate. Returns { satisfied: boolean, reason?: string }.
//
// Freshness is anchored to the transcript: `checkpointRoundsWritten` is the set
// of rounds for which a `quorum-checkpoint.cjs` Bash call ran in the CURRENT
// turn. A stale file from a previous turn/session is therefore ignored. The
// checkpoint's own timestamp is cross-checked against the turn start as a
// second guard against a stale file left behind by a failed write.
function evaluateCheckpoint(cwd, protocolRound, checkpointRoundsWritten, turnStartTime, displayRound) {
  const reSuffix =
    ` Run quorum-checkpoint.cjs after dispatching T1/T2 fallback slots, then retry. ` +
    `Re-read FALLBACK-01 in commands/nf/quorum.md.`;

  // Checkpoint module unavailable — fail-open (do not block on missing tooling).
  if (!checkpointModule) {
    process.stderr.write('[nf-stop] WARNING: quorum-checkpoint module unavailable — skipping FALLBACK-01 checkpoint enforcement\n');
    return { satisfied: true };
  }

  // No checkpoint script ran this turn — the checkpoint was skipped entirely.
  if (checkpointRoundsWritten.size === 0) {
    return {
      satisfied: false,
      reason: `FALLBACK-01 VIOLATION: Slot(s) returned UNAVAIL in dispatch round ${displayRound} ` +
        `but no structured checkpoint was written and no fallback slots were dispatched.` + reSuffix,
    };
  }

  // The dispatch round number MUST be known to key the checkpoint to it.
  // quorum-slot-dispatch.cjs always passes --round; if it could not be parsed,
  // fail CLOSED rather than accepting a checkpoint written for some other round
  // — a checkpoint that cannot be tied to this dispatch must not clear the gate.
  if (protocolRound === null) {
    return {
      satisfied: false,
      reason: `FALLBACK-01 VIOLATION: dispatch round ${displayRound} returned UNAVAIL but its ` +
        `quorum round number could not be determined, so no structured checkpoint could be ` +
        `matched to it.` + reSuffix,
    };
  }

  // The checkpoint for this exact round must have been written this turn.
  if (!checkpointRoundsWritten.has(protocolRound)) {
    return {
      satisfied: false,
      reason: `FALLBACK-01 VIOLATION: dispatch round ${displayRound} returned UNAVAIL but no ` +
        `structured checkpoint was written for round ${protocolRound}.` + reSuffix,
    };
  }

  // Read + validate the checkpoint file for exactly this round.
  const res = checkpointModule.readCheckpoint(cwd, protocolRound);
  let stale = false;
  if (res.valid && turnStartTime !== null) {
    const cpTime = Date.parse(res.checkpoint.timestamp);
    // An unparseable timestamp cannot prove freshness — treat it as stale
    // (fail closed). Schema validation already rejects non-date timestamps;
    // this is defense-in-depth.
    stale = Number.isNaN(cpTime) || cpTime < turnStartTime;
  }

  let reason = '';
  if (!res.exists) {
    reason = `checkpoint file for round ${protocolRound} not found`;
  } else if (!res.valid) {
    // Malformed checkpoint — schema validation rejects it; treat as no checkpoint.
    reason = `checkpoint round ${protocolRound} failed schema validation (${res.errors.join('; ')})`;
  } else if (res.checkpoint.round !== protocolRound) {
    reason = `checkpoint round field (${res.checkpoint.round}) does not match dispatch round ${protocolRound}`;
  } else if (stale) {
    reason = `checkpoint round ${protocolRound} is stale (written before the current turn)`;
  } else if (!res.satisfied) {
    reason = `checkpoint round ${protocolRound} has fallback_dispatched=false and all_tiers_exhausted=false`;
  } else {
    return { satisfied: true }; // valid, fresh, and clears the gate
  }

  return {
    satisfied: false,
    reason: `FALLBACK-01 VIOLATION: dispatch round ${displayRound} returned UNAVAIL but no valid ` +
      `structured checkpoint cleared the gate (${reason}).` + reSuffix,
  };
}

// Detects UNAVAIL in slot-worker results without corresponding fallback dispatch.
// Returns { violated: true, reason: string } if fallback was skipped, or { violated: false }.
//
// Logic:
// 1. Walk assistant messages for slot-worker Task dispatches; group by dispatch
//    round and record each round's protocol round number (--round N).
// 2. Walk tool_result blocks for UNAVAIL verdicts in each round's results.
// 3. If UNAVAIL found in round N, it is cleared by EITHER a later dispatch round
//    (fallback Tasks) OR a valid structured checkpoint file for that round.
// 4. If neither condition met, fallback was skipped — return violated.
function detectUnavailWithoutFallback(currentTurnLines, cwd) {
  const root = cwd || process.cwd();
  const dispatchRounds = [];    // Array of { messageIdx, taskIds: Set, protocolRound: number|null }
  const taskResults = new Map(); // taskId → result text
  const checkpointRoundsWritten = new Set();   // protocol rounds checkpointed this turn
  const pendingCheckpointBash = new Map();     // Bash tool_use_id → round (committed on success)

  for (let i = 0; i < currentTurnLines.length; i++) {
    try {
      const entry = JSON.parse(currentTurnLines[i]);

      if (entry.type === 'assistant') {
        const content = entry.message && entry.message.content;
        if (!Array.isArray(content)) continue;

        const taskIds = new Set();
        let protocolRound = null;
        for (const block of content) {
          if (block.type !== 'tool_use') continue;
          // Track slot-worker dispatches via the structured subagent_type field.
          if (block.name === 'Task') {
            const input = block.input || {};
            const subagentType = input.subagent_type || input.subagentType || '';
            if (subagentType === 'nf-quorum-slot-worker') {
              taskIds.add(block.id);
              // Round comes from the slot-dispatch invocation in the prompt,
              // anchored to `node … quorum-slot-dispatch.cjs` so a stray --round
              // elsewhere in the payload cannot bind the wrong protocol round.
              const prompt = typeof input.prompt === 'string' ? input.prompt : '';
              const m = prompt.match(/\bnode\b[^\n]*quorum-slot-dispatch\.cjs[^\n]*?--round[=\s]+(\d+)/);
              if (m && protocolRound === null) protocolRound = parseInt(m[1], 10);
            }
          }
          // Track structured-checkpoint writes (freshness anchor for issue #172).
          // Anchored to an actual `node … quorum-checkpoint.cjs … --round N`
          // invocation; the round is committed only once the Bash tool_result
          // confirms the write succeeded (see the tool_result handler below).
          if (block.name === 'Bash') {
            const cmd = (block.input && block.input.command) || '';
            const m = typeof cmd === 'string'
              ? cmd.match(/\bnode\b[^\n]*quorum-checkpoint\.cjs[^\n]*?--round[=\s]+(\d+)/)
              : null;
            if (m) pendingCheckpointBash.set(block.id, parseInt(m[1], 10));
          }
        }
        if (taskIds.size > 0) {
          dispatchRounds.push({ messageIdx: i, taskIds, protocolRound });
        }
      }

      // Collect tool_result text keyed by tool_use_id
      if (entry.type === 'user') {
        const content = entry.message && entry.message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const resultText = Array.isArray(block.content)
              ? block.content.map(c => c.text || '').join('')
              : (typeof block.content === 'string' ? block.content : '');
            taskResults.set(block.tool_use_id, resultText);
            // A checkpoint round counts only when its Bash call actually succeeded.
            if (pendingCheckpointBash.has(block.tool_use_id) && block.is_error !== true) {
              checkpointRoundsWritten.add(pendingCheckpointBash.get(block.tool_use_id));
            }
          }
        }
      }
    } catch { /* skip malformed */ }
  }

  // No dispatch rounds = not a slot-worker quorum flow
  if (dispatchRounds.length === 0) return { violated: false };

  const turnStartTime = getTurnStartTime(currentTurnLines);

  // Check each round: if any task returned UNAVAIL, was there a next round or valid checkpoint?
  for (let r = 0; r < dispatchRounds.length; r++) {
    const round = dispatchRounds[r];
    let hasUnavail = false;

    for (const taskId of round.taskIds) {
      const result = taskResults.get(taskId) || '';
      if (/verdict:\s*UNAVAIL/i.test(result) || /\bUNAVAIL\b/.test(result)) {
        hasUnavail = true;
        break;
      }
    }

    // TRUNC-03: FLAG_TRUNCATED verdicts are non-votes (like UNAVAIL) for consensus
    for (const taskId of round.taskIds) {
      const result = taskResults.get(taskId) || '';
      if (/verdict:\s*FLAG_TRUNCATED/i.test(result)) {
        process.stderr.write('[nf-stop] WARNING: Slot returned FLAG_TRUNCATED (verdict from truncated output) -- excluding from consensus\n');
        hasUnavail = true;
        break;
      }
    }

    if (!hasUnavail) continue;

    // UNAVAIL in round r is cleared by a later dispatch round (fallback Tasks).
    const hasNextRound = r + 1 < dispatchRounds.length;
    if (hasNextRound) continue;

    // Last dispatch round with UNAVAIL — require a structured checkpoint file.
    const ck = evaluateCheckpoint(root, round.protocolRound, checkpointRoundsWritten, turnStartTime, r + 1);
    if (!ck.satisfied) {
      return { violated: true, reason: ck.reason };
    }
  }

  return { violated: false };
}

// Counts the number of live (non-UNAVAIL, non-FLAG_TRUNCATED) slot-worker results in the
// current turn. Walks assistant messages for Task(nf-quorum-slot-worker) dispatches, then
// checks matching tool_result blocks for UNAVAIL/FLAG_TRUNCATED verdicts.
// Returns the count of results that represent valid votes (APPROVE or BLOCK).
function countLiveSlotWorkers(currentTurnLines) {
  const taskResults = new Map(); // tool_use_id → result text
  const slotWorkerIds = new Set();

  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);

      // Collect slot-worker Task tool_use IDs
      if (entry.type === 'assistant') {
        const content = entry.message && entry.message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === 'tool_use' && block.name === 'Task') {
            const inputStr = JSON.stringify(block.input || {});
            if (inputStr.includes('nf-quorum-slot-worker') && block.id) {
              slotWorkerIds.add(block.id);
            }
          }
        }
      }

      // Collect tool_result text keyed by tool_use_id
      if (entry.type === 'user') {
        const content = entry.message && entry.message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const resultText = Array.isArray(block.content)
              ? block.content.map(c => c.text || '').join('')
              : (typeof block.content === 'string' ? block.content : '');
            taskResults.set(block.tool_use_id, resultText);
          }
        }
      }
    } catch { /* skip malformed */ }
  }

  let liveCount = 0;
  for (const id of slotWorkerIds) {
    const result = taskResults.get(id) || '';
    if (/verdict:\s*UNAVAIL/i.test(result) || /\bUNAVAIL\b/.test(result)) continue;
    if (/verdict:\s*FLAG_TRUNCATED/i.test(result)) continue;
    // Has a result file path or substantive content — counts as live
    if (result.length > 0) liveCount++;
  }
  return liveCount;
}

// Extracts min_live_voters from config with safe default.
function getMinLiveVoters(config) {
  return (config.quorum && Number.isInteger(config.quorum.min_live_voters) && config.quorum.min_live_voters >= 1)
    ? config.quorum.min_live_voters
    : 2;
}

// The exact token Claude must include in its final output to mark a decision turn.
// Used by hasDecisionMarker (Stop hook) and injected into Claude's context (Prompt hook).
const DECISION_MARKER = '<!-- NF_DECISION -->';

// Returns true if the last assistant text block in currentTurnLines contains DECISION_MARKER.
// Walks lines in reverse to find the most recent assistant entry with a text content block.
function hasDecisionMarker(currentTurnLines) {
  for (let i = currentTurnLines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(currentTurnLines[i]);
      if (entry.type !== 'assistant') continue;
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type !== 'text') continue;
        if (block.text && block.text.includes(DECISION_MARKER)) return true;
      }
      // Found the last assistant entry — no text block with marker → stop scanning
      break;
    } catch { /* skip */ }
  }
  return false;
}

// Parses --n N flag from a text string.
// Returns N (integer >= 1) if found, or null if absent/invalid.
function parseQuorumSizeFlag(text) {
  const m = text.match(/--n\s+(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (Number.isInteger(n) && n >= 1) ? n : null;
}

// Extracts the user-typed prompt text from the current turn lines.
// Checks <command-name> tag first; falls back to first 300 chars of message text.
function extractPromptText(currentTurnLines) {
  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user') continue;
      const tag = extractCommandTag(entry);
      if (tag !== null) return tag;
      const content = entry.message?.content;
      if (typeof content === 'string') return content.slice(0, 300);
      if (Array.isArray(content)) {
        const first = content.find(c => c?.type === 'text');
        return first ? (first.text || '').slice(0, 300) : '';
      }
    } catch { /* skip */ }
  }
  return '';
}

// Derives the canonical tool name for the block reason message.
// Uses known model keys first; falls back to prefix + key for unknown models.
function deriveMissingToolName(modelKey, modelDef) {
  const prefix = modelDef.tool_prefix;
  if (modelKey === 'codex') return prefix + 'review';
  if (modelKey === 'gemini') return prefix + 'gemini';
  if (modelKey === 'opencode') return prefix + 'opencode';
  if (modelKey === 'copilot') return prefix + 'ask';
  return prefix + modelKey;
}

// Returns true if any user entry in currentTurnLines contains the NF_CACHE_HIT marker.
// This marker is injected by nf-prompt.js when a valid cache hit is found.
function hasCacheHitMarker(currentTurnLines) {
  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user') continue;
      const content = entry.message?.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(c => c?.type === 'text')
          .map(c => c.text || '')
          .join('');
      }
      if (text.includes('<!-- NF_CACHE_HIT -->')) return true;
    } catch { /* skip malformed lines */ }
  }
  return false;
}

// Extracts the cache key from NF_CACHE_KEY marker in currentTurnLines.
// Returns the hex string or null if not found.
function extractCacheKey(currentTurnLines) {
  const keyPattern = /<!-- NF_CACHE_KEY:([a-f0-9]+) -->/;
  for (const line of currentTurnLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user') continue;
      const content = entry.message?.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(c => c?.type === 'text')
          .map(c => c.text || '')
          .join('');
      }
      const m = text.match(keyPattern);
      if (m) return m[1];
    } catch { /* skip malformed lines */ }
  }
  return null;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      const _eventType = input.hook_event_name || input.hookEventName || 'Stop';
      const _validation = validateHookInput(_eventType, input);
      if (!_validation.valid) {
        process.stderr.write('[nf] WARNING: nf-stop: invalid input: ' + JSON.stringify(_validation.errors) + '\n');
        process.exit(0); // Fail-open
      }

      // GUARD 1: Infinite loop prevention — MUST be first (STOP-02)
      if (input.stop_hook_active) {
        process.exit(0);
      }

      // GUARD 2: Subagent exclusion (STOP-03)
      if (input.hook_event_name === 'SubagentStop') {
        process.exit(0);
      }

      // GUARD 3: Transcript must exist (fail-open)
      if (!input.transcript_path || !fs.existsSync(input.transcript_path)) {
        process.exit(0);
      }

      const config = loadConfig();

      // Profile guard — exit early if this hook is not active for the current profile
      const profile = config.hook_profile || 'standard';
      if (!shouldRunHook('nf-stop', profile)) {
        process.exit(0);
      }

      // Read and split transcript JSONL; skip empty lines
      const lines = fs.readFileSync(input.transcript_path, 'utf8')
        .split('\n')
        .filter(l => l.trim().length > 0);

      // Scope to current turn: lines since last user message (STOP-04)
      const currentTurnLines = getCurrentTurnLines(lines);

      // Build command pattern once; reuse for detection and extraction
      // Strict mode: match ANY /nf: or /qnf: command, not just quorum_commands list.
      const cmdPattern = profile === 'strict'
        ? /\/(q?nf):[\w][\w-]*/
        : buildCommandPattern(config.quorum_commands);

      // GUARD 4: Only enforce quorum if a planning command is in current turn (STOP-06)
      if (!hasQuorumCommand(currentTurnLines, cmdPattern)) {
        process.exit(0);
      }

      // GUARD 5: Only enforce quorum on project decision turns (SCOPE-01, SCOPE-02, SCOPE-03)
      // A turn is a decision turn if it contains a planning artifact commit OR a decision marker.
      // NF-internal operation turns (routing, agent spawning, questioning) have neither.
      const isDecisionTurn = hasArtifactCommit(currentTurnLines) || hasDecisionMarker(currentTurnLines);
      if (!isDecisionTurn) {
        process.exit(0); // NF-internal operation — not a project decision turn
      }

      // Extract --n N flag from current-turn user prompt (if present)
      const promptText = extractPromptText(currentTurnLines);
      const quorumSizeOverride = parseQuorumSizeFlag(promptText);
      const soloMode = quorumSizeOverride === 1;

      // GUARD 6: Solo mode (--n 1) — Claude-only quorum, no external models required
      if (soloMode) {
        appendConformanceEvent({
          ts: new Date().toISOString(),
          phase: 'DECIDING',
          action: 'quorum_complete',
          slots_available: 0,
          vote_result: 1,
          outcome: 'APPROVE',
          schema_version,
        });
        process.exit(0); // Solo mode: Claude's vote is the quorum — no block
      }

      // GUARD 7: Cache hit bypass — nf-prompt.js validated the cache entry and injected
      // the NF_CACHE_HIT marker. Trust it: the entry was completed, within TTL, and
      // matches git HEAD + quorum_active composition (EventualConsensus preserved).
      if (hasCacheHitMarker(currentTurnLines)) {
        appendConformanceEvent({
          ts:              new Date().toISOString(),
          phase:           'DECIDING',
          action:          'quorum_complete',
          cache_hit:       true,
          pass_at_k:       0,
          slots_available: 0,
          vote_result:     0,
          outcome:         'APPROVE',
          schema_version,
        });
        process.exit(0); // Cache hit: quorum approved via cached result
      }

      // Build agent pool from config
      const agentPool = buildAgentPool(config);

      // Get available MCP prefixes from ~/.claude.json
      const availablePrefixes = getAvailableMcpPrefixes();

      // Check if slot-workers handled quorum (inline dispatch counts as full quorum evidence)
      if (wasSlotWorkerUsed(currentTurnLines)) {
        // Slot-workers were used — but check FALLBACK-01 compliance before passing.
        // If any slot returned UNAVAIL without fallback dispatch, BLOCK to force retry.
        const fallbackCheck = detectUnavailWithoutFallback(currentTurnLines);
        if (fallbackCheck.violated) {
          appendConformanceEvent({
            ts:              new Date().toISOString(),
            phase:           'DECIDING',
            action:          'fallback_01_block',
            outcome:         'BLOCK',
            reason:          fallbackCheck.reason,
            schema_version,
          });
          process.stdout.write(JSON.stringify({
            decision: 'block',
            reason: fallbackCheck.reason
          }));
          process.exit(0);
        }

        // MIN_LIVE_VOTERS floor (issue #170)
        const minLiveVoters = getMinLiveVoters(config);
        const liveSlotWorkers = countLiveSlotWorkers(currentTurnLines);
        if (liveSlotWorkers < minLiveVoters) {
          appendConformanceEvent({
            ts:              new Date().toISOString(),
            phase:           'DECIDING',
            action:          'floor_block',
            live_voters:     liveSlotWorkers,
            min_live_voters: minLiveVoters,
            outcome:         'BLOCK',
            schema_version,
          });
          process.stdout.write(JSON.stringify({
            decision: 'block',
            reason: 'QUORUM FLOOR NOT MET: Only ' + liveSlotWorkers + ' live voter(s) (min_live_voters = ' + minLiveVoters + '). ' +
              'Too many slots are UNAVAIL for reliable consensus. Re-dispatch with extended timeouts or add --force-quorum.'
          }));
          process.exit(0);
        }

        process.exit(0);
      }

      // Ceiling: require maxSize successful (non-error) responses from the full pool.
      // Named maxSize for consistency with nf-prompt.js and the config schema.
      // --n N override: N total participants means N-1 external models required.
      const maxSize = quorumSizeOverride !== null && quorumSizeOverride > 1
        ? quorumSizeOverride - 1  // --n N means N-1 external models required
        : (config.quorum && Number.isInteger(config.quorum.maxSize) && config.quorum.maxSize >= 1)
          ? config.quorum.maxSize
          : 2;

      // Iterate the full agentPool (already sorted sub-first when preferSub is set).
      // Count successful (non-error) responses. Stop once ceiling is satisfied.
      // missingAgents is populated for failure reporting — only read in the block path below.
      let successCount = 0;
      const missingAgents = []; // only read when successCount < maxSize (block path)
      for (const agent of agentPool) {
        // If availablePrefixes is null (unknown), treat as available (conservative enforcement)
        const isAvailable = availablePrefixes === null || availablePrefixes.includes(agent.prefix);
        if (!isAvailable) continue; // Model not installed — skip

        if (wasSlotCalledSuccessfully(currentTurnLines, agent.prefix)) {
          successCount++;
          if (successCount >= maxSize) break; // ceiling satisfied — stop counting
        } else {
          // Track failures for error reporting (only used in the block path below)
          let toolName;
          if (agent.callTool) {
            toolName = agent.callTool;
          } else {
            toolName = deriveMissingToolName(agent.slot, { tool_prefix: agent.prefix });
          }
          missingAgents.push(toolName);
        }
      }

      // MIN_LIVE_VOTERS floor — checked when ceiling is met but live voters are too few
      const minLiveVoters = getMinLiveVoters(config);
      if (successCount >= maxSize && successCount < minLiveVoters) {
        appendConformanceEvent({
          ts:              new Date().toISOString(),
          phase:           'DECIDING',
          action:          'floor_block',
          live_voters:     successCount,
          min_live_voters: minLiveVoters,
          outcome:         'BLOCK',
          schema_version,
        });
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: 'QUORUM FLOOR NOT MET: ' + successCount + ' live voter(s) (min_live_voters = ' + minLiveVoters + '). ' +
            'Too few live voters for reliable consensus.'
        }));
        process.exit(0);
      }

      if (successCount < maxSize) {
        // Only read missingAgents here — never in the success path
        appendConformanceEvent({
          ts:              new Date().toISOString(),
          phase:           'DECIDING',
          action:          'quorum_block',
          slots_available: agentPool.length,
          vote_result:     successCount,
          outcome:         'BLOCK',
          schema_version,
        });
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: 'QUORUM REQUIRED: Missing tool calls for: ' + missingAgents.join(', ') + '. Run the required quorum agent(s) before completing this planning command.'
        }));
        process.exit(0);
      }

      // Cache backfill: update pending cache entry with vote result after successful quorum
      if (cacheModule) {
        try {
          const cKey = extractCacheKey(currentTurnLines);
          if (cKey) {
            const cacheDir = path.join(process.cwd(), '.planning', '.quorum-cache');
            const pendingEntry = cacheModule.readCache(cKey, cacheDir);
            // readCache returns null for pending entries (no completed field) — read raw instead
            const cacheFilePath = path.join(cacheDir, `${cKey}.json`);
            if (fs.existsSync(cacheFilePath)) {
              const rawEntry = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
              rawEntry.vote_result = successCount;
              rawEntry.outcome = 'APPROVE';
              rawEntry.completed = new Date().toISOString();
              cacheModule.writeCache(cKey, rawEntry, cacheDir);
            }
          }
        } catch (backfillErr) {
          // Fail-open: backfill failure never blocks quorum approval
          process.stderr.write('[nf] cache backfill failed (fail-open): ' + (backfillErr.message || backfillErr) + '\n');
        }
      }

      appendConformanceEvent({
        ts:              new Date().toISOString(),
        phase:           'DECIDING',
        action:          'quorum_complete',
        pass_at_k:       countDeliberationRounds(currentTurnLines),
        slots_available: agentPool.length,
        vote_result:     successCount,
        outcome:         'APPROVE',
        schema_version,
      });

      // Always-on evidence refresh — runs at end of every session.
      // Fail-open: if refresh fails, never block the stop hook.
      try {
        const { spawnSync } = require('child_process');
        const refreshScript = path.join(__dirname, '..', 'nf-bin', 'refresh-evidence.cjs');
        if (fs.existsSync(refreshScript)) {
          const result = spawnSync(process.execPath, [refreshScript, '--json'], {
            cwd: process.cwd(),
            timeout: 15000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          if (result.status !== 0) {
            process.stderr.write('[nf] evidence refresh warning: exit ' + result.status + '\n');
          }
        }
      } catch (evErr) {
        process.stderr.write('[nf] evidence refresh failed (fail-open): ' + (evErr.message || evErr) + '\n');
      }

      // Auto-commit dirty formal artifacts before session ends.
      // Fail-open: never block session exit on commit failure.
      try {
        autoCommitFormalArtifacts();
      } catch (acErr) {
        process.stderr.write('[nf] formal auto-commit failed (fail-open): ' + (acErr.message || acErr) + '\n');
      }

      process.exit(0);

    } catch (e) {
      if (e instanceof SyntaxError) {
        process.stderr.write('[nf] WARNING: nf-stop: malformed JSON on stdin: ' + e.message + '\n');
      }
      // Fail-open: never crash the user's session on any unexpected error
      process.exit(0);
    }
  });
}

main();

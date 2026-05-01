#!/usr/bin/env node
// hooks/config-loader.js
// Shared two-layer config loader with validation and stderr-only warnings.
//
// Exports: loadConfig(projectDir?), DEFAULT_CONFIG
//
// Load order: DEFAULT_CONFIG → ~/.claude/nf.json (global) → .claude/nf.json in projectDir (project)
// Merge: shallow spread — project values fully replace global values for any overlapping key.
// Warnings: all written to process.stderr — stdout is never touched (it is the hook decision channel).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Maps the family name of a slot (trailing -N stripped) to the MCP tool suffix to call.
// Used by both nf-prompt.js (step generation) and nf-stop.js (evidence detection).
const SLOT_TOOL_SUFFIX = {
  'codex-cli': 'review',
  'codex':     'review',
  'gemini-cli':'gemini',
  'gemini':    'gemini',
  'opencode':  'opencode',
  'copilot-cli':'ask',
  'copilot':   'ask',
  'api':       'claude',
  'ccr':       'ask',
  'claude':    'claude',
  'unified':   'claude',
};

// Returns the recommended tool call name for a slot (e.g. "codex-1" → "mcp__codex-1__review").
function slotToToolCall(slotName) {
  const family = slotName.replace(/-\d+$/, '');
  const suffix = SLOT_TOOL_SUFFIX[family] || 'claude';
  return 'mcp__' + slotName + '__' + suffix;
}

const HOOK_PROFILE_MAP = {
  minimal: new Set([
    'nf-circuit-breaker',
    'nf-precompact',
    'nf-node-eval-guard',
    'nf-session-end',
  ]),
  standard: new Set([
    'nf-circuit-breaker',
    'nf-precompact',
    'nf-prompt',
    'nf-stop',
    'nf-context-monitor',
    'nf-spec-regen',
    'nf-token-collector',
    'nf-slot-correlator',
    'nf-session-start',
    'nf-slot-health-probe',
    'nf-statusline',
    'nf-post-edit-format',
    'nf-console-guard',
    'nf-destructive-git-guard',
    'nf-scope-guard',
    'nf-mcp-dispatch-guard',
    'nf-node-eval-guard',
    'nf-session-end',
  ]),
  strict: new Set([
    'nf-circuit-breaker',
    'nf-precompact',
    'nf-prompt',
    'nf-stop',
    'nf-context-monitor',
    'nf-spec-regen',
    'nf-token-collector',
    'nf-slot-correlator',
    'nf-session-start',
    'nf-slot-health-probe',
    'nf-statusline',
    'nf-post-edit-format',
    'nf-console-guard',
    'nf-destructive-git-guard',
    'nf-scope-guard',
    'nf-mcp-dispatch-guard',
    'nf-node-eval-guard',
    'nf-session-end',
  ]),
};

// Hook execution priority map.
// Higher values = earlier execution within the same event type.
// Inspired by ruflo HookPriority enum: Critical=1000, High=100, Normal=50, Low=10.
// User overrides via nf.json hook_priorities: { "hook-name": number }
const DEFAULT_HOOK_PRIORITIES = {
  'nf-circuit-breaker': 1000,  // Critical — safety, must run first
  'nf-stop':            1000,  // Critical — quorum gate
  'nf-prompt':            50,  // Normal — quorum injection
  'nf-precompact':        50,  // Normal — state injection
  'nf-session-start':     50,  // Normal — secret sync
  'nf-session-end':       50,  // Normal — session cleanup
  'nf-check-update':      10,  // Low — update check
  'nf-context-monitor':  50,  // Normal — context warnings
  'nf-spec-regen':        10,  // Low — spec regeneration
  'nf-post-edit-format':  10,  // Low — formatting
  'nf-console-guard':     10,  // Low — console.log warning
  'nf-statusline':        10,  // Low — status display
  'nf-token-collector':   10,  // Low — token tracking
  'nf-slot-correlator':   10,  // Low — slot correlation
  'nf-slot-health-probe': 10,  // Low — quorum slot responsiveness probe (SessionStart)
  'nf-destructive-git-guard': 50,  // Normal — destructive ops advisory
  'nf-scope-guard': 50,             // Normal — scope advisory (warn-only)
  'nf-mcp-dispatch-guard': 50,    // Normal — MCP dispatch advisory
};

function shouldRunHook(hookBasename, profile) {
  const validProfile = HOOK_PROFILE_MAP[profile] ? profile : 'standard';
  return HOOK_PROFILE_MAP[validProfile].has(hookBasename);
}

const DEFAULT_CONFIG = {
  quorum_commands: [
    'plan-phase', 'new-project', 'new-milestone',
    'discuss-phase', 'verify-work', 'research-phase', 'quick',
  ],
  fail_mode: 'open',
  required_models: {
    codex:    { tool_prefix: 'mcp__codex-cli__',  required: true },
    gemini:   { tool_prefix: 'mcp__gemini-cli__', required: true },
    opencode: { tool_prefix: 'mcp__opencode__',   required: true },
    copilot:  { tool_prefix: 'mcp__copilot-cli__',  required: true },
  },
  // quorum: pool-based enforcement (supersedes required_models when quorum_active is set).
  // maxSize — maximum number of agents that must be called (from the available pool).
  //   Default 4 preserves backward compat with the 4-model required_models check.
  // preferSub — sort sub (subscription) agents before api agents in pool and prompt steps.
  quorum: {
    maxSize: 4,
    preferSub: false,
  },
  // agent_config: per-slot metadata.
  //   auth_type: "sub" (subscription, flat-fee) | "api" (pay-per-token)
  agent_config: {},
  circuit_breaker: {
    oscillation_depth: 3,          // how many run-groups of same file set to trigger
    commit_window: 6,              // how many commits to look back
    haiku_reviewer: true,          // call Claude Haiku to verify before blocking
    haiku_model: 'claude-haiku-4-5-20251001', // model used for review
  },
  model_preferences: {},  // { "<mcp-server-name>": "<model-id>" }
  // context_monitor: PostToolUse hook thresholds for context window warnings.
  // warn_pct — inject WARNING when context used % >= this value (default 70)
  // critical_pct — inject CRITICAL when context used % >= this value (default 90)
  context_monitor: {
    warn_pct: 70,
    critical_pct: 90,
  },
  budget: {
    session_limit_tokens: null,   // null = disabled (fail-open)
    warn_pct: 60,                 // inject warning at this % of session_limit_tokens
    downgrade_pct: 85,            // auto-downgrade model profile at this %
  },
  stall_detection: {
    timeout_s: 90,                // mark slot stalled after this many seconds
    consecutive_threshold: 2,     // require N consecutive stalled dispatches
    check_commits: true,          // only escalate if no new commits
  },
  smart_compact: {
    enabled: true,                // master switch
    context_warn_pct: 60,        // suggest compact above this context usage %
  },
  // quorum_active: array of slot names that participate in quorum.
  // [] = all discovered slots participate (fail-open, backward compatible with pre-Phase-40 installs).
  // A non-empty array is an explicit allowlist.
  // NOTE: loadConfig() uses shallow spread { ...DEFAULT_CONFIG, ...global, ...project } —
  // if project config sets quorum_active, it entirely replaces the global value.
  quorum_active: [],
  // orchestrator_slot_family: slot family prefix identifying the orchestrator (e.g., "claude" or "codex").
  // Slots whose family matches this value are skipped from external dispatch to avoid double-counting the orchestrator vote.
  // Set to "" to keep all slots, even if they share the same family as the orchestrator.
  orchestrator_slot_family: 'claude',
  // model_tier_planner: model tier for planner agents (nf-planner, nf-roadmapper).
  // model_tier_worker: model tier for worker agents (researcher, checker, executor, etc.).
  // Valid values: 'haiku' | 'sonnet' | 'opus'. Flat keys required — nested objects lost in shallow merge.
  model_tier_planner: 'opus',
  model_tier_worker: 'haiku',
  // task_envelope_enabled: master switch for task-envelope.json sidecar writes.
  // Flat key required — nested objects lost in shallow merge.
  task_envelope_enabled: true,
  hook_profile: 'standard',
  hook_priorities: {},
  learning_enabled: true,
  // thinking_budget_scaling: per-task-type thinking token budgets.
  // SHALLOW MERGE NOTE: project nf.json replaces entire object, not individual keys.
  // User must set all 3 keys together: { exploration, review, architecture }.
  thinking_budget_scaling: {
    exploration: 0,
    review: 4096,
    architecture: 31999,
  },
  model_routing_enabled: true,
  model_routing_cooldown_rounds: 3,
  model_routing: {},  // per-complexity tier overrides, e.g. { simple: 'haiku' }
  smart_compact_threshold_pct: 65,  // Proactive compaction at 65% context (midpoint of 60-70% range from research)
  continuous_verify_enabled: true,  // Master switch for continuous verification in PostToolUse hook
  context_retrieval_enabled: true,  // Master switch for context retrieval enrichment in quorum-slot-dispatch
  persist_sessions_within_quorum: true, // Reuse provider sessions inside one quorum invocation when supported
  // post_edit_verify: optional command run after Edit operations (disabled by default).
  // When enabled, runs verify command after formatting and emits additionalContext on failure.
  post_edit_verify_enabled: false,
  post_edit_verify_command: '',
  post_edit_verify_timeout_ms: 15000,
  post_edit_verify_file_patterns: [],
  post_edit_verify_fail_mode: 'warn',
};

// ─── Hook Input Schemas ──────────────────────────────────────────────────────
// Per-event-type schemas defining required and optional fields with expected types.
// Used by validateHookInput() to validate stdin JSON before business logic runs.
const HOOK_INPUT_SCHEMAS = {
  PreToolUse: {
    required: { tool_name: 'string' },
    optional: { tool_input: 'object', cwd: 'string', hook_event_name: 'string', hookEventName: 'string' },
  },
  PostToolUse: {
    required: { tool_name: 'string' },
    optional: { tool_input: 'object', tool_response: 'object', cwd: 'string', context_window: 'object', hook_event_name: 'string', hookEventName: 'string' },
  },
  UserPromptSubmit: {
    required: { prompt: 'string' },
    optional: { cwd: 'string', hook_event_name: 'string', hookEventName: 'string' },
  },
  Stop: {
    required: {},
    optional: { stop_hook_active: 'boolean', transcript_so_far: 'string', cwd: 'string', hook_event_name: 'string', hookEventName: 'string' },
  },
  SubagentStop: {
    required: {},
    optional: { stop_hook_active: 'boolean', transcript_so_far: 'string', cwd: 'string', hook_event_name: 'string', hookEventName: 'string' },
  },
  PreCompact: {
    required: {},
    optional: { cwd: 'string', hook_event_name: 'string', hookEventName: 'string', context_window: 'object' },
  },
  SessionStart: {
    required: {},
    optional: { cwd: 'string', hook_event_name: 'string', hookEventName: 'string' },
  },
  SessionEnd: {
    required: {},
    optional: { cwd: 'string', hook_event_name: 'string', hookEventName: 'string', transcript: 'string' },
  },
};

// Validates hook input against the schema for the given event type.
// Returns { valid: true } on success, or { valid: false, errors: [...] } on failure.
// Unknown event types pass validation (fail-open) so future Claude Code updates do not break hooks.
function validateHookInput(eventType, input) {
  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: [{ field: '(root)', error: 'not_object', expected: 'object', got: typeof input }] };
  }

  const schema = HOOK_INPUT_SCHEMAS[eventType];
  if (!schema) return { valid: true }; // Unknown event type -> fail-open

  const errors = [];

  // Check required fields
  for (const [field, expectedType] of Object.entries(schema.required || {})) {
    if (!(field in input)) {
      errors.push({ field, error: 'missing', expected: expectedType });
    } else if (typeof input[field] !== expectedType) {
      errors.push({ field, error: 'wrong_type', expected: expectedType, got: typeof input[field] });
    }
  }

  // Check optional fields only if present and non-null
  for (const [field, expectedType] of Object.entries(schema.optional || {})) {
    if (field in input && input[field] !== null && input[field] !== undefined) {
      if (typeof input[field] !== expectedType) {
        errors.push({ field, error: 'wrong_type', expected: expectedType, got: typeof input[field] });
      }
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

// Reads and parses a JSON config file.
// Returns the parsed object on success.
// Returns null silently if the file does not exist.
// Returns null with a stderr warning if the file is malformed.
function readConfigFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    process.stderr.write('[nf] WARNING: Malformed config at ' + filePath + ': ' + e.message + '\n');
    return null;
  }
}

// Validates config fields in-place.
// Corrects invalid fields to DEFAULT_CONFIG values and emits a stderr warning for each.
// Returns the (possibly corrected) config object.
function validateConfig(config) {
  if (!Array.isArray(config.quorum_commands)) {
    process.stderr.write('[nf] WARNING: nf.json: quorum_commands must be an array; using defaults\n');
    config.quorum_commands = DEFAULT_CONFIG.quorum_commands;
  }

  if (typeof config.required_models !== 'object' || config.required_models === null) {
    process.stderr.write('[nf] WARNING: nf.json: required_models must be an object; using defaults\n');
    config.required_models = DEFAULT_CONFIG.required_models;
  }

  if (!['open', 'closed'].includes(config.fail_mode)) {
    process.stderr.write('[nf] WARNING: nf.json: fail_mode "' + config.fail_mode + '" invalid; defaulting to "open"\n');
    config.fail_mode = 'open';
  }

  // Validate circuit_breaker sub-object
  if (typeof config.circuit_breaker !== 'object' || config.circuit_breaker === null) {
    process.stderr.write('[nf] WARNING: nf.json: circuit_breaker must be an object; using defaults\n');
    config.circuit_breaker = { ...DEFAULT_CONFIG.circuit_breaker };
  } else {
    // Validate oscillation_depth independently
    if (!Number.isInteger(config.circuit_breaker.oscillation_depth) || config.circuit_breaker.oscillation_depth < 1) {
      process.stderr.write('[nf] WARNING: nf.json: circuit_breaker.oscillation_depth must be a positive integer; defaulting to 3\n');
      config.circuit_breaker.oscillation_depth = 3;
    }
    // Validate commit_window independently
    if (!Number.isInteger(config.circuit_breaker.commit_window) || config.circuit_breaker.commit_window < 1) {
      process.stderr.write('[nf] WARNING: nf.json: circuit_breaker.commit_window must be a positive integer; defaulting to 6\n');
      config.circuit_breaker.commit_window = 6;
    }
    // Fill in missing sub-keys with defaults (handles partial circuit_breaker objects)
    if (config.circuit_breaker.oscillation_depth === undefined) {
      config.circuit_breaker.oscillation_depth = DEFAULT_CONFIG.circuit_breaker.oscillation_depth;
    }
    if (config.circuit_breaker.commit_window === undefined) {
      config.circuit_breaker.commit_window = DEFAULT_CONFIG.circuit_breaker.commit_window;
    }
    if (config.circuit_breaker.haiku_reviewer === undefined) {
      config.circuit_breaker.haiku_reviewer = DEFAULT_CONFIG.circuit_breaker.haiku_reviewer;
    }
    if (config.circuit_breaker.haiku_model === undefined) {
      config.circuit_breaker.haiku_model = DEFAULT_CONFIG.circuit_breaker.haiku_model;
    }
    if (typeof config.circuit_breaker.haiku_reviewer !== 'boolean') {
      process.stderr.write('[nf] WARNING: nf.json: circuit_breaker.haiku_reviewer must be boolean; defaulting to true\n');
      config.circuit_breaker.haiku_reviewer = true;
    }
    if (typeof config.circuit_breaker.haiku_model !== 'string') {
      process.stderr.write('[nf] WARNING: nf.json: circuit_breaker.haiku_model must be a string; using default\n');
      config.circuit_breaker.haiku_model = DEFAULT_CONFIG.circuit_breaker.haiku_model;
    }
  }

  // Validate quorum_active
  if (!Array.isArray(config.quorum_active)) {
    process.stderr.write('[nf] WARNING: nf.json: quorum_active must be an array; using []\n');
    config.quorum_active = [];
  } else {
    config.quorum_active = config.quorum_active.filter(
      s => typeof s === 'string' && s.trim().length > 0
    );
  }

  if (typeof config.orchestrator_slot_family !== 'string') {
    process.stderr.write('[nf] WARNING: nf.json: orchestrator_slot_family must be a string; defaulting to "claude"\n');
    config.orchestrator_slot_family = DEFAULT_CONFIG.orchestrator_slot_family;
  } else {
    config.orchestrator_slot_family = config.orchestrator_slot_family.trim();
    if (!config.orchestrator_slot_family) {
      // Empty string disables auto-filtering
      config.orchestrator_slot_family = '';
    }
  }

  // Validate quorum object
  if (typeof config.quorum !== 'object' || config.quorum === null) {
    config.quorum = { ...DEFAULT_CONFIG.quorum };
  } else {
    // Accept both minSize (legacy) and maxSize (current) — normalize to maxSize
    if (config.quorum.minSize !== undefined && config.quorum.maxSize === undefined) {
      config.quorum.maxSize = config.quorum.minSize;
      delete config.quorum.minSize;
    }
    if (!Number.isInteger(config.quorum.maxSize) || config.quorum.maxSize < 1) {
      process.stderr.write('[nf] WARNING: nf.json: quorum.maxSize must be a positive integer; defaulting to 4\n');
      config.quorum.maxSize = DEFAULT_CONFIG.quorum.maxSize;
    }
    if (typeof config.quorum.preferSub !== 'boolean') {
      config.quorum.preferSub = DEFAULT_CONFIG.quorum.preferSub;
    }
  }

  // Validate agent_config
  if (typeof config.agent_config !== 'object' || config.agent_config === null || Array.isArray(config.agent_config)) {
    process.stderr.write('[nf] WARNING: nf.json: agent_config must be an object; using {}\n');
    config.agent_config = {};
  } else {
    for (const [slot, meta] of Object.entries(config.agent_config)) {
      if (typeof meta !== 'object' || meta === null) {
        process.stderr.write('[nf] WARNING: nf.json: agent_config.' + slot + ' must be an object; removing\n');
        delete config.agent_config[slot];
      } else if (meta.auth_type && !['sub', 'api'].includes(meta.auth_type)) {
        process.stderr.write('[nf] WARNING: nf.json: agent_config.' + slot + '.auth_type must be "sub" or "api"; defaulting to "api"\n');
        meta.auth_type = 'api';
      }
    }
  }

  // Validate model_preferences
  if (typeof config.model_preferences !== 'object' || config.model_preferences === null || Array.isArray(config.model_preferences)) {
    process.stderr.write('[nf] WARNING: nf.json: model_preferences must be an object; using {}\n');
    config.model_preferences = {};
  } else {
    // Remove invalid entries (non-string values) with a warning
    for (const [key, val] of Object.entries(config.model_preferences)) {
      if (typeof val !== 'string' || val.trim() === '') {
        process.stderr.write('[nf] WARNING: nf.json: model_preferences.' + key + ' must be a non-empty string; removing\n');
        delete config.model_preferences[key];
      }
    }
  }

  // Validate context_monitor sub-object
  if (typeof config.context_monitor !== 'object' || config.context_monitor === null) {
    process.stderr.write('[nf] WARNING: nf.json: context_monitor must be an object; using defaults\n');
    config.context_monitor = { ...DEFAULT_CONFIG.context_monitor };
  } else {
    if (!Number.isInteger(config.context_monitor.warn_pct) ||
        config.context_monitor.warn_pct < 1 || config.context_monitor.warn_pct > 99) {
      process.stderr.write('[nf] WARNING: nf.json: context_monitor.warn_pct must be an integer 1-99; defaulting to 70\n');
      config.context_monitor.warn_pct = DEFAULT_CONFIG.context_monitor.warn_pct;
    }
    if (!Number.isInteger(config.context_monitor.critical_pct) ||
        config.context_monitor.critical_pct < 1 || config.context_monitor.critical_pct > 100) {
      process.stderr.write('[nf] WARNING: nf.json: context_monitor.critical_pct must be an integer 1-100; defaulting to 90\n');
      config.context_monitor.critical_pct = DEFAULT_CONFIG.context_monitor.critical_pct;
    }
    if (config.context_monitor.warn_pct >= config.context_monitor.critical_pct) {
      process.stderr.write('[nf] WARNING: nf.json: context_monitor.warn_pct must be less than critical_pct; resetting to defaults\n');
      config.context_monitor.warn_pct = DEFAULT_CONFIG.context_monitor.warn_pct;
      config.context_monitor.critical_pct = DEFAULT_CONFIG.context_monitor.critical_pct;
    }
    // Fill missing sub-keys with defaults
    if (config.context_monitor.warn_pct === undefined) {
      config.context_monitor.warn_pct = DEFAULT_CONFIG.context_monitor.warn_pct;
    }
    if (config.context_monitor.critical_pct === undefined) {
      config.context_monitor.critical_pct = DEFAULT_CONFIG.context_monitor.critical_pct;
    }
  }

  // Validate budget sub-object
  if (typeof config.budget !== 'object' || config.budget === null) {
    process.stderr.write('[nf] WARNING: nf.json: budget must be an object; using defaults\n');
    config.budget = { ...DEFAULT_CONFIG.budget };
  } else {
    // Validate session_limit_tokens: must be null, undefined, or integer >= 1000
    if (config.budget.session_limit_tokens !== null && config.budget.session_limit_tokens !== undefined) {
      if (!Number.isInteger(config.budget.session_limit_tokens) || config.budget.session_limit_tokens < 1000) {
        process.stderr.write('[nf] WARNING: nf.json: budget.session_limit_tokens must be null or integer >= 1000; defaulting to null\n');
        config.budget.session_limit_tokens = null;
      }
    }
    // Validate warn_pct: integer 1-99, default 60
    if (!Number.isInteger(config.budget.warn_pct) || config.budget.warn_pct < 1 || config.budget.warn_pct > 99) {
      process.stderr.write('[nf] WARNING: nf.json: budget.warn_pct must be an integer 1-99; defaulting to 60\n');
      config.budget.warn_pct = DEFAULT_CONFIG.budget.warn_pct;
    }
    // Validate downgrade_pct: integer 1-100, default 85
    if (!Number.isInteger(config.budget.downgrade_pct) || config.budget.downgrade_pct < 1 || config.budget.downgrade_pct > 100) {
      process.stderr.write('[nf] WARNING: nf.json: budget.downgrade_pct must be an integer 1-100; defaulting to 85\n');
      config.budget.downgrade_pct = DEFAULT_CONFIG.budget.downgrade_pct;
    }
    // Validate warn_pct < downgrade_pct
    if (config.budget.warn_pct >= config.budget.downgrade_pct) {
      process.stderr.write('[nf] WARNING: nf.json: budget.warn_pct must be less than downgrade_pct; resetting to defaults\n');
      config.budget.warn_pct = DEFAULT_CONFIG.budget.warn_pct;
      config.budget.downgrade_pct = DEFAULT_CONFIG.budget.downgrade_pct;
    }
    // Fill missing sub-keys with defaults
    if (config.budget.session_limit_tokens === undefined) {
      config.budget.session_limit_tokens = DEFAULT_CONFIG.budget.session_limit_tokens;
    }
    if (config.budget.warn_pct === undefined) {
      config.budget.warn_pct = DEFAULT_CONFIG.budget.warn_pct;
    }
    if (config.budget.downgrade_pct === undefined) {
      config.budget.downgrade_pct = DEFAULT_CONFIG.budget.downgrade_pct;
    }
  }

  // Validate stall_detection sub-object
  if (typeof config.stall_detection !== 'object' || config.stall_detection === null) {
    process.stderr.write('[nf] WARNING: nf.json: stall_detection must be an object; using defaults\n');
    config.stall_detection = { ...DEFAULT_CONFIG.stall_detection };
  } else {
    // Validate timeout_s: positive integer, default 90
    if (!Number.isInteger(config.stall_detection.timeout_s) || config.stall_detection.timeout_s < 1) {
      process.stderr.write('[nf] WARNING: nf.json: stall_detection.timeout_s must be a positive integer; defaulting to 90\n');
      config.stall_detection.timeout_s = DEFAULT_CONFIG.stall_detection.timeout_s;
    }
    // Validate consecutive_threshold: positive integer >= 1, default 2
    if (!Number.isInteger(config.stall_detection.consecutive_threshold) || config.stall_detection.consecutive_threshold < 1) {
      process.stderr.write('[nf] WARNING: nf.json: stall_detection.consecutive_threshold must be a positive integer; defaulting to 2\n');
      config.stall_detection.consecutive_threshold = DEFAULT_CONFIG.stall_detection.consecutive_threshold;
    }
    // Validate check_commits: boolean, default true
    if (typeof config.stall_detection.check_commits !== 'boolean') {
      process.stderr.write('[nf] WARNING: nf.json: stall_detection.check_commits must be a boolean; defaulting to true\n');
      config.stall_detection.check_commits = DEFAULT_CONFIG.stall_detection.check_commits;
    }
    // Fill missing sub-keys with defaults
    if (config.stall_detection.timeout_s === undefined) {
      config.stall_detection.timeout_s = DEFAULT_CONFIG.stall_detection.timeout_s;
    }
    if (config.stall_detection.consecutive_threshold === undefined) {
      config.stall_detection.consecutive_threshold = DEFAULT_CONFIG.stall_detection.consecutive_threshold;
    }
    if (config.stall_detection.check_commits === undefined) {
      config.stall_detection.check_commits = DEFAULT_CONFIG.stall_detection.check_commits;
    }
  }

  // Validate smart_compact sub-object
  if (typeof config.smart_compact !== 'object' || config.smart_compact === null) {
    process.stderr.write('[nf] WARNING: nf.json: smart_compact must be an object; using defaults\n');
    config.smart_compact = { ...DEFAULT_CONFIG.smart_compact };
  } else {
    // Validate enabled: boolean, default true
    if (typeof config.smart_compact.enabled !== 'boolean') {
      process.stderr.write('[nf] WARNING: nf.json: smart_compact.enabled must be a boolean; defaulting to true\n');
      config.smart_compact.enabled = DEFAULT_CONFIG.smart_compact.enabled;
    }
    // Validate context_warn_pct: integer 1-99, default 60
    if (!Number.isInteger(config.smart_compact.context_warn_pct) || config.smart_compact.context_warn_pct < 1 || config.smart_compact.context_warn_pct > 99) {
      process.stderr.write('[nf] WARNING: nf.json: smart_compact.context_warn_pct must be an integer 1-99; defaulting to 60\n');
      config.smart_compact.context_warn_pct = DEFAULT_CONFIG.smart_compact.context_warn_pct;
    }
    // Fill missing sub-keys with defaults
    if (config.smart_compact.enabled === undefined) {
      config.smart_compact.enabled = DEFAULT_CONFIG.smart_compact.enabled;
    }
    if (config.smart_compact.context_warn_pct === undefined) {
      config.smart_compact.context_warn_pct = DEFAULT_CONFIG.smart_compact.context_warn_pct;
    }
  }

  // Validate model_tier_planner and model_tier_worker
  const VALID_TIERS = ['haiku', 'sonnet', 'opus'];
  if (config.model_tier_planner !== undefined) {
    if (typeof config.model_tier_planner !== 'string' || !VALID_TIERS.includes(config.model_tier_planner)) {
      process.stderr.write('[nf] WARNING: nf.json: model_tier_planner must be "haiku", "sonnet", or "opus"; removing\n');
      delete config.model_tier_planner;
    }
  }
  if (config.model_tier_worker !== undefined) {
    if (typeof config.model_tier_worker !== 'string' || !VALID_TIERS.includes(config.model_tier_worker)) {
      process.stderr.write('[nf] WARNING: nf.json: model_tier_worker must be "haiku", "sonnet", or "opus"; removing\n');
      delete config.model_tier_worker;
    }
  }

  // Validate task_envelope_enabled
  if (config.task_envelope_enabled !== undefined) {
    if (typeof config.task_envelope_enabled !== 'boolean') {
      process.stderr.write('[nf] WARNING: nf.json: task_envelope_enabled must be a boolean; using default true\n');
      config.task_envelope_enabled = true;
    }
  }

  // Validate hook_profile
  const VALID_PROFILES = ['minimal', 'standard', 'strict'];
  if (config.hook_profile !== undefined) {
    if (typeof config.hook_profile !== 'string' || !VALID_PROFILES.includes(config.hook_profile)) {
      process.stderr.write('[nf] WARNING: nf.json: hook_profile must be "minimal", "standard", or "strict"; defaulting to "standard"\n');
      config.hook_profile = 'standard';
    }
  }

  // Validate hook_priorities
  if (config.hook_priorities !== undefined) {
    if (typeof config.hook_priorities !== 'object' || config.hook_priorities === null || Array.isArray(config.hook_priorities)) {
      process.stderr.write('[nf] WARNING: nf.json: hook_priorities must be an object; using {}\n');
      config.hook_priorities = {};
    } else {
      // Validate each entry: key must be string, value must be integer
      for (const [hookName, priority] of Object.entries(config.hook_priorities)) {
        if (!Number.isInteger(priority) || priority < 0) {
          process.stderr.write('[nf] WARNING: nf.json: hook_priorities.' + hookName + ' must be a non-negative integer; removing\n');
          delete config.hook_priorities[hookName];
        }
      }
    }
  }

  return config;
}

// Loads the two-layer nForma config.
//
// Layer 1 (global): ~/.claude/nf.json
// Layer 2 (project): <projectDir>/.claude/nf.json  (defaults to process.cwd())
//
// Merge is shallow: { ...DEFAULT_CONFIG, ...global, ...project }
// If both layers are missing/malformed, returns DEFAULT_CONFIG with a warning.
// All warnings go to stderr — stdout is never touched.
function loadConfig(projectDir) {
  const globalPath = path.join(os.homedir(), '.claude', 'nf.json');
  const projectPath = path.join(projectDir || process.cwd(), '.claude', 'nf.json');

  const globalObj = readConfigFile(globalPath);
  const projectObj = readConfigFile(projectPath);

  let config;
  if (!globalObj && !projectObj) {
    process.stderr.write('[nf] WARNING: No nf.json found at ' + globalPath + ' or ' + projectPath + '; using hardcoded defaults\n');
    config = { ...DEFAULT_CONFIG };
  } else {
    config = { ...DEFAULT_CONFIG, ...(globalObj || {}), ...(projectObj || {}) };
  }

  validateConfig(config);
  return config;
}

// ─── Config Write Adapter ────────────────────────────────────────────────────
// Write-side normalization: boolean strings → booleans, case normalization,
// nested/flat key bidirectional conversion, and writeConfig JSON output.

// Bidirectional map: nested path -> flat key.
// Covers keys that users might write in nested form but loadConfig expects flat.
const NESTED_TO_FLAT_MAP = {
  'model_tier.planner': 'model_tier_planner',
  'model_tier.worker': 'model_tier_worker',
  'smart_compact.threshold_pct': 'smart_compact_threshold_pct',
};

// Reverse map: flat key -> { parent, child }
const FLAT_TO_NESTED_MAP = {};
for (const [nestedPath, flatKey] of Object.entries(NESTED_TO_FLAT_MAP)) {
  const [parent, child] = nestedPath.split('.');
  FLAT_TO_NESTED_MAP[flatKey] = { parent, child };
}

function flattenNestedKeys(config) {
  if (typeof config !== 'object' || config === null) return {};
  const result = { ...config };

  for (const [nestedPath, flatKey] of Object.entries(NESTED_TO_FLAT_MAP)) {
    const [parent, child] = nestedPath.split('.');
    if (result[parent] && typeof result[parent] === 'object' && child in result[parent]) {
      // Only flatten if the flat key is NOT already set (flat key takes precedence)
      if (!(flatKey in result)) {
        result[flatKey] = result[parent][child];
      }
      // Remove the child from the nested object
      const nested = { ...result[parent] };
      delete nested[child];
      if (Object.keys(nested).length === 0) {
        // Remove empty parent if it's not a known DEFAULT_CONFIG nested object
        // model_tier is NOT a nested object in DEFAULT_CONFIG (only flat keys exist)
        if (!(parent in DEFAULT_CONFIG) || typeof DEFAULT_CONFIG[parent] !== 'object') {
          delete result[parent];
        } else {
          result[parent] = nested;
        }
      } else {
        result[parent] = nested;
      }
    }
  }
  return result;
}

function nestFlatKeys(config) {
  if (typeof config !== 'object' || config === null) return {};
  const result = { ...config };

  for (const [flatKey, { parent, child }] of Object.entries(FLAT_TO_NESTED_MAP)) {
    if (flatKey in result) {
      if (!result[parent] || typeof result[parent] !== 'object') {
        result[parent] = {};
      }
      result[parent] = { ...result[parent], [child]: result[flatKey] };
      delete result[flatKey];
    }
  }
  return result;
}

function normalizeConfigValue(key, value) {
  // Boolean string normalization: "true"/"false" -> true/false
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  // Profile and tier case normalization
  const CASE_NORMALIZED_KEYS = ['hook_profile', 'model_tier_planner', 'model_tier_worker', 'fail_mode'];
  if (CASE_NORMALIZED_KEYS.includes(key) && typeof value === 'string') {
    return value.toLowerCase();
  }
  // Pass through all other values unchanged
  return value;
}

function normalizeConfig(config) {
  if (typeof config !== 'object' || config === null) return {};
  // Step 1: Flatten any nested keys to their flat equivalents
  const flattened = flattenNestedKeys(config);
  // Step 2: Normalize individual values (booleans, case)
  const result = {};
  for (const [key, value] of Object.entries(flattened)) {
    result[key] = normalizeConfigValue(key, value);
  }
  return result;
}

function writeConfig(filePath, config) {
  const normalized = normalizeConfig(config);
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
}

module.exports = { loadConfig, validateConfig, DEFAULT_CONFIG, SLOT_TOOL_SUFFIX, slotToToolCall, shouldRunHook, HOOK_PROFILE_MAP, validateHookInput, HOOK_INPUT_SCHEMAS, DEFAULT_HOOK_PRIORITIES, normalizeConfigValue, normalizeConfig, flattenNestedKeys, nestFlatKeys, writeConfig };

// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
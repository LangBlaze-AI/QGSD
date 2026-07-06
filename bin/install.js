#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');

// Colors
const cyan = '\x1b[36m';
const salmon = '\x1b[38;5;209m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

// Parse args first to enable verbose logging
const args = process.argv.slice(2);
const hasVerbose = args.includes('--verbose') || args.includes('-v');

// Verbose logging helper — gates per-item detail output behind --verbose flag
function log(...args) {
  if (hasVerbose) console.log(...args);
}

// Get providers.json at startup
let providersData = null;
let providers = [];

// Initialize providers manifest at startup
try {
  const providersJsonPath = path.join(__dirname, 'providers.json');
  providersData = require(providersJsonPath);
  if (!providersData || !Array.isArray(providersData.providers)) {
    console.error('ERROR: Invalid providers.json format. Expected { providers: [...] }');
    process.exit(1);
  }
  if (providersData.providers.length === 0) {
    log('providers.json is empty — scanning PATH for known CLIs...');
    const { resolveCli } = require('./resolve-cli.cjs');
    // Most families' binary name == family name; antigravity is the exception
    // (family "antigravity" ships the `agy` binary), so each entry carries an
    // explicit binary. `cli` is recorded so resolveSpawnTarget spawns the real
    // binary while the slot/model keeps the family name.
    const KNOWN_CLIS = [
      { family: 'claude',      bin: 'claude' },
      { family: 'codex',       bin: 'codex' },
      { family: 'gemini',      bin: 'gemini' },
      { family: 'opencode',    bin: 'opencode' },
      { family: 'copilot',     bin: 'copilot' },
      { family: 'antigravity', bin: 'agy' },
    ];
    const found = [];
    for (const { family, bin } of KNOWN_CLIS) {
      const resolved = resolveCli(bin);
      if (resolved !== bin) {
        found.push({ name: family, cli: bin, resolvedPath: resolved, found: true });
      }
    }
    if (found.length > 0) {
      providers = found;
      log(`Auto-detected ${found.length} CLIs: ${found.map(p => p.name).join(', ')}`);
    } else {
      providers = [];
      log('No known CLIs found on PATH — run /nf:link-daintree to populate providers');
    }
  } else {
    providers = providersData.providers;
  }
  log(`Loaded manifest with ${providers.length} providers`);
} catch (e) {
  console.error('ERROR: providers.json not found at bin/providers.json. Cannot detect CLIs.');
  console.error('Error details:', e.message);
  console.error('Stack:', e.stack);
  process.exit(1);
}

// Helper function to get install hint from manifest
function getInstallHint(mainTool) {
  const provider = providers.find(p => p.mainTool === mainTool);
  if (provider && provider.cli && provider.cli.install_command) {
    return provider.cli.install_command;
  }
  // Fallback hint based on provider name
  const hints = {
    codex:    'npm i -g @openai/codex',
    gemini:   'npm i -g @google/gemini-cli',
    opencode: 'npm i -g opencode',
    copilot:  'npm i -g @githubnext/github-copilot-cli',
    antigravity: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  };
  return hints[mainTool] || '';
}

// Lazy require: coderlm-lifecycle.cjs is an optional sibling module. Deferring
// the require() prevents install.js from failing at startup if the module is
// absent (e.g., partial install or future removal of the feature).
let _coderlmLifecycle = null;
function getCoderlmLifecycle() {
  if (!_coderlmLifecycle) {
    try { _coderlmLifecycle = require('./coderlm-lifecycle.cjs'); } catch (e) { /* not available */ }
  }
  return _coderlmLifecycle;
}

// Get version from package.json
const pkg = require('../package.json');

// Import hook priorities for deterministic ordering
let DEFAULT_HOOK_PRIORITIES;
try {
  DEFAULT_HOOK_PRIORITIES = require('../hooks/config-loader').DEFAULT_HOOK_PRIORITIES;
} catch {
  // Fallback if config-loader not available during initial install
  DEFAULT_HOOK_PRIORITIES = {
    'nf-circuit-breaker': 1000,
    'nf-stop': 1000,
    'nf-prompt': 50,
    'nf-precompact': 50,
    'nf-session-start': 50,
    'nf-session-end': 50,
    'nf-check-update': 10,
    'nf-context-monitor': 50,
    'nf-spec-regen': 10,
    'nf-post-edit-format': 10,
    'nf-console-guard': 10,
    'nf-statusline': 10,
    'nf-token-collector': 10,
    'nf-slot-correlator': 10,
    'nf-slot-health-probe': 10,
  };
}

const hasGlobal = args.includes('--global') || args.includes('-g');
const hasLocal = args.includes('--local') || args.includes('-l');
const hasOpencode = args.includes('--opencode');
const hasClaude = args.includes('--claude');
const hasGemini = args.includes('--gemini');
const hasKilo = args.includes('--kilo');
const hasCursor = args.includes('--cursor');
const hasWindsurf = args.includes('--windsurf');
const hasCodex = args.includes('--codex');
const hasCopilot = args.includes('--copilot');
const hasAntigravity = args.includes('--antigravity');
const hasAugment = args.includes('--augment');
const hasTrae = args.includes('--trae');
const hasCline = args.includes('--cline');
const hasBoth = args.includes('--both'); // Legacy flag, keeps working
const hasAll = args.includes('--all');
const hasUninstall = args.includes('--uninstall') || args.includes('-u');
const hasRedetectMcps = args.includes('--redetect-mcps');
const hasResetBreaker = args.includes('--reset-breaker');
const hasDisableBreaker = args.includes('--disable-breaker');
const hasEnableBreaker = args.includes('--enable-breaker');
const hasMigrateSlots = args.includes('--migrate-slots');
const hasFormal = args.includes('--formal');
const hasUninstallFormal = args.includes('--uninstall-formal');
const hasRescan = args.includes('--rescan');
const hasAllProviders = args.includes('--all-providers');

// Provider slot filter: null = all (backward compat), array = filtered
let selectedProviderSlots = null;

// Runtime selection - can be set by flags or interactive prompt
let selectedRuntimes = [];
if (hasAll) {
  selectedRuntimes = ['claude', 'opencode', 'gemini', 'kilo', 'cursor', 'windsurf', 'codex', 'copilot', 'antigravity', 'augment', 'trae', 'cline'];
} else if (hasBoth) {
  selectedRuntimes = ['claude', 'opencode'];
} else {
  if (hasOpencode) selectedRuntimes.push('opencode');
  if (hasClaude) selectedRuntimes.push('claude');
  if (hasGemini) selectedRuntimes.push('gemini');
  if (hasKilo) selectedRuntimes.push('kilo');
  if (hasCursor) selectedRuntimes.push('cursor');
  if (hasWindsurf) selectedRuntimes.push('windsurf');
  if (hasCodex) selectedRuntimes.push('codex');
  if (hasCopilot) selectedRuntimes.push('copilot');
  if (hasAntigravity) selectedRuntimes.push('antigravity');
  if (hasAugment) selectedRuntimes.push('augment');
  if (hasTrae) selectedRuntimes.push('trae');
  if (hasCline) selectedRuntimes.push('cline');
}

// Helper to get directory name for a runtime (used for local/project installs)
function getDirName(runtime) {
  if (runtime === 'opencode') return '.opencode';
  if (runtime === 'claude') return '.claude';
  if (runtime === 'gemini') return '.gemini';
  if (runtime === 'kilo') return '.kilo';
  if (runtime === 'cursor') return '.cursor';
  if (runtime === 'windsurf') return '.windsurf';
  if (runtime === 'codex') return '.codex';
  if (runtime === 'copilot') return '.copilot';
  if (runtime === 'antigravity') return '.antigravity';
  if (runtime === 'augment') return '.augment';
  if (runtime === 'trae') return '.trae';
  if (runtime === 'cline') return '.cline';
  // Defensive fallback: return runtime prefixed with a dot if unknown
  return `.${runtime}`;
}

/**
 * Get the config directory path relative to home directory for a runtime
 * Used for templating hooks that use path.join(homeDir, '<configDir>', ...)
 * @param {string} runtime - 'claude', 'opencode', or 'gemini'
 * @param {boolean} isGlobal - Whether this is a global install
 */
function getConfigDirFromHome(runtime, isGlobal) {
  if (!isGlobal) {
    // Local installs use the same dir name pattern
    return `'${getDirName(runtime)}'`;
  }
  // Global installs - OpenCode uses XDG path structure
  if (runtime === 'opencode') {
    // OpenCode: ~/.config/opencode -> '.config', 'opencode'
    // Return as comma-separated for path.join() replacement
    return "'.config', 'opencode'";
  }
  if (runtime === 'gemini') return "'.gemini'";
  if (runtime === 'kilo') return "'.config', 'kilo'";
  if (runtime === 'cursor') return "'.cursor'";
  if (runtime === 'windsurf') return "'.windsurf'";
  if (runtime === 'codex') return "'.codex'";
  if (runtime === 'copilot') return "'.copilot'";
  if (runtime === 'antigravity') return "'.antigravity'";
  if (runtime === 'augment') return "'.augment'";
  if (runtime === 'trae') return "'.trae'";
  if (runtime === 'cline') return "'.cline'";
  // Default: claude runtime (and any unknown runtime)
  return "'.claude'";
}

/**
 * Get the global config directory for OpenCode
 * OpenCode follows XDG Base Directory spec and uses ~/.config/opencode/
 * Priority: OPENCODE_CONFIG_DIR > dirname(OPENCODE_CONFIG) > XDG_CONFIG_HOME/opencode > ~/.config/opencode
 */
function getOpencodeGlobalDir() {
  // 1. Explicit OPENCODE_CONFIG_DIR env var
  if (process.env.OPENCODE_CONFIG_DIR) {
    return expandTilde(process.env.OPENCODE_CONFIG_DIR);
  }
  
  // 2. OPENCODE_CONFIG env var (use its directory)
  if (process.env.OPENCODE_CONFIG) {
    return path.dirname(expandTilde(process.env.OPENCODE_CONFIG));
  }
  
  // 3. XDG_CONFIG_HOME/opencode
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(expandTilde(process.env.XDG_CONFIG_HOME), 'opencode');
  }
  
  // 4. Default: ~/.config/opencode (XDG default)
  return path.join(os.homedir(), '.config', 'opencode');
}

/**
 * Get the global config directory for a runtime
 * @param {string} runtime - 'claude', 'opencode', 'gemini', 'kilo', 'cursor', 'windsurf'
 * @param {string|null} explicitDir - Explicit directory from --config-dir flag
 */
function getGlobalDir(runtime, explicitDir = null) {
  if (runtime === 'opencode') {
    // For OpenCode, --config-dir overrides env vars
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    return getOpencodeGlobalDir();
  }
  
  if (runtime === 'gemini') {
    // Gemini: --config-dir > GEMINI_CONFIG_DIR > ~/.gemini
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.GEMINI_CONFIG_DIR) {
      return expandTilde(process.env.GEMINI_CONFIG_DIR);
    }
    return path.join(os.homedir(), '.gemini');
  }

  if (runtime === 'kilo') {
    // Kilo: --config-dir > KILO_CONFIG_DIR > ~/.config/kilo (XDG style)
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.KILO_CONFIG_DIR) {
      return expandTilde(process.env.KILO_CONFIG_DIR);
    }
    return path.join(os.homedir(), '.config', 'kilo');
  }

  if (runtime === 'cursor') {
    // Cursor: --config-dir > CURSOR_CONFIG_DIR > ~/.cursor
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.CURSOR_CONFIG_DIR) {
      return expandTilde(process.env.CURSOR_CONFIG_DIR);
    }
    return path.join(os.homedir(), '.cursor');
  }

  if (runtime === 'windsurf') {
    // Windsurf: --config-dir > WINDSURF_CONFIG_DIR > ~/.windsurf
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.WINDSURF_CONFIG_DIR) {
      return expandTilde(process.env.WINDSURF_CONFIG_DIR);
    }
    return path.join(os.homedir(), '.windsurf');
  }
  
  if (runtime === 'codex') {
    // Codex: --config-dir > CODEX_CONFIG_DIR > ~/.codex
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.CODEX_CONFIG_DIR) {
      return expandTilde(process.env.CODEX_CONFIG_DIR);
    }
    return path.join(os.homedir(), '.codex');
  }

  if (runtime === 'copilot') {
    // Copilot: --config-dir > COPILOT_CONFIG_DIR > ~/.copilot
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.COPILOT_CONFIG_DIR) {
      return expandTilde(process.env.COPILOT_CONFIG_DIR);
    }
    return path.join(os.homedir(), '.copilot');
  }

  if (runtime === 'antigravity') {
    // Antigravity: --config-dir > ANTIGRAVITY_CONFIG_DIR > ~/.antigravity
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.ANTIGRAVITY_CONFIG_DIR) {
      return expandTilde(process.env.ANTIGRAVITY_CONFIG_DIR);
    }
    return path.join(os.homedir(), '.antigravity');
  }

  if (runtime === 'augment') {
    // Augment: --config-dir > AUGMENT_CONFIG_DIR > ~/.augment
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.AUGMENT_CONFIG_DIR) {
      return expandTilde(process.env.AUGMENT_CONFIG_DIR);
    }
    return path.join(os.homedir(), '.augment');
  }

  if (runtime === 'trae') {
    // Trae: --config-dir > TRAE_CONFIG_DIR > ~/.trae
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.TRAE_CONFIG_DIR) {
      return expandTilde(process.env.TRAE_CONFIG_DIR);
    }
    return path.join(os.homedir(), '.trae');
  }

  if (runtime === 'cline') {
    // Cline: --config-dir > CLINE_CONFIG_DIR > ~/.cline
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.CLINE_CONFIG_DIR) {
      return expandTilde(process.env.CLINE_CONFIG_DIR);
    }
    return path.join(os.homedir(), '.cline');
  }
  
  // Claude Code: --config-dir > CLAUDE_CONFIG_DIR > ~/.claude
  if (explicitDir) {
    return expandTilde(explicitDir);
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    return expandTilde(process.env.CLAUDE_CONFIG_DIR);
  }
  return path.join(os.homedir(), '.claude');
}

const banner = '\n' +
  salmon + '          ' + cyan + '███████╗\n' +
  salmon + '          ' + cyan + '██╔════╝\n' +
  salmon + ' ██████╗  ' + cyan + '█████╗\n' +
  salmon + ' ██╔══██╗ ' + cyan + '██╔══╝\n' +
  salmon + ' ██║  ██║ ' + cyan + '██║\n' +
  salmon + ' ╚═╝  ╚═╝ ' + cyan + '╚═╝' + reset + '\n' +
  '\n' +
  '  nForma — Consensus before code. Proof before production. ' + dim + 'v' + pkg.version + reset + '\n' +
  '  Built on NF-CC by TÂCHES.\n' +
  '  A quorum of diverse coding agents + formal verification. By Jonathan Borduas.\n' +
  '\n' +
  cyan + '  The task of leadership is to create an alignment of strengths\n' +
  '   so strong that it makes the system\u2019s weaknesses irrelevant.\n' +
  dim + '  \u2014 Peter Drucker' + reset + '\n';

// nForma: MCP auto-detection — keyword map for quorum model server matching
const NF_KEYWORD_MAP = {
  codex:    { keywords: ['codex'],    defaultPrefix: 'mcp__codex-cli-1__'  },
  gemini:   { keywords: ['gemini'],   defaultPrefix: 'mcp__gemini-cli-1__' },
  opencode: { keywords: ['opencode'], defaultPrefix: 'mcp__opencode-1__'   },
  copilot:  { keywords: ['copilot'],  defaultPrefix: 'mcp__copilot-1__'    },
  cursor:   { keywords: ['cursor'],   defaultPrefix: 'mcp__cursor-1__'     },
  windsurf: { keywords: ['windsurf', 'codeium'], defaultPrefix: 'mcp__windsurf-1__' },
  antigravity: { keywords: ['antigravity'], defaultPrefix: 'mcp__antigravity-1__' },
  augment:  { keywords: ['augment'],  defaultPrefix: 'mcp__augment-1__'  },
  trae:     { keywords: ['trae'],     defaultPrefix: 'mcp__trae-1__'      },
  cline:    { keywords: ['cline'],    defaultPrefix: 'mcp__cline-1__'     },
};

// Reads ~/.claude.json to find MCP server names, keyword-matches to identify quorum candidates,
// and returns a required_models object with derived tool prefixes.
// Falls back to hardcoded defaults if ~/.claude.json is missing, malformed, or has no matching servers.
function buildRequiredModelsFromMcp() {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  let mcpServers = {};

  try {
    if (fs.existsSync(claudeJsonPath)) {
      const d = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      mcpServers = d.mcpServers || {};
    }
  } catch (e) {
    console.warn(`  ${yellow}⚠${reset} Could not read ~/.claude.json: ${e.message}`);
  }

  const requiredModels = {};
  let anyDetected = false;

  for (const [modelKey, { keywords, defaultPrefix }] of Object.entries(NF_KEYWORD_MAP)) {
    const matched = Object.keys(mcpServers).find(serverName =>
      keywords.some(kw => serverName.toLowerCase().includes(kw))
    );
    if (matched) {
      requiredModels[modelKey] = { tool_prefix: `mcp__${matched}__`, required: true };
      anyDetected = true;
      console.log(`  ${green}✓${reset} Detected ${modelKey} MCP server: ${matched} → prefix: mcp__${matched}__`);
    } else {
      requiredModels[modelKey] = { tool_prefix: defaultPrefix, required: true };
      console.warn(`  ${yellow}⚠${reset} No ${modelKey} MCP server found in ~/.claude.json; using default prefix: ${defaultPrefix}`);
    }
  }

  if (!anyDetected) {
    console.warn(`  ${yellow}⚠${reset} No quorum MCP servers detected — using hardcoded defaults. Edit ~/.claude/nf.json to configure.`);
  }

  return requiredModels;
}

// Returns all mcpServer slot names from ~/.claude.json as the default quorum composition.
// Used for COMP-04: fresh install writes quorum_active; reinstall backfills if absent/empty.
function buildActiveSlots() {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    if (fs.existsSync(claudeJsonPath)) {
      const d = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      return Object.keys(d.mcpServers || {});
    }
  } catch (e) {
    console.warn(`  ${yellow}⚠${reset} Could not read ~/.claude.json for quorum_active: ${e.message}`);
  }
  return [];
}

/**
 * Classify providers into tiers: api (direct HTTP), externalPrimary (subprocess),
 * dualSubscription (optional subprocess duplicates).
 * @param {Array} providers - providers array from providers.json
 * @returns {{ api: Array, externalPrimary: Array, dualSubscription: Array }}
 */
function classifyProviders(providers) {
  const api = [];
  const externalPrimary = [];
  const dualSubscription = [];

  for (const p of providers) {
    const cliBase = path.basename(p.cli || '');
    if (p.type === 'http') {
      api.push({ ...p });
    } else if (p.dual_subscription === true) {
      const bareCli = cliBase || p.mainTool;
      dualSubscription.push({ ...p, parent: p.parent_slot || p.name.replace(/-2$/, '-1'), bareCli });
    } else {
      const bareCli = cliBase || p.mainTool;
      externalPrimary.push({ ...p, bareCli });
    }
  }

  return { ccr: [], api, externalPrimary, dualSubscription };
}

/**
 * Detect which external CLIs are installed on the system via resolveCli.
 * @param {Array} externalPrimary - externalPrimary array from classifyProviders
 * @returns {Array} enriched array with found/resolvedPath fields
 */
function detectExternalClis(externalPrimary) {
  const { resolveCli } = require('./resolve-cli.cjs');
  return externalPrimary.map(p => {
    const result = resolveCli(p.mainTool);
    const found = result !== p.mainTool;
    return { ...p, found, resolvedPath: found ? result : null };
  });
}


// providers.json merge: see bin/install-helpers.cjs for the implementation. The wrapper here
// adapts the colored install.js logger and forwards the result so the install path keeps a
// single call site.
const { mergeProvidersJson: _mergeProvidersJson } = require('./install-helpers.cjs');
function mergeProvidersJson(repoPath, userPath) {
  const result = _mergeProvidersJson(repoPath, userPath, {
    log: (msg) => {
      // Re-color based on result kind. The helper just emits plain text so it's easy to test.
      if (msg.startsWith('providers.json: could not read repo source')) {
        log(`  ${yellow}⚠${reset} ${msg}`);
      } else if (msg.startsWith('providers.json: user copy unreadable')) {
        log(`  ${yellow}⚠${reset} ${msg}`);
      } else {
        log(`  ${green}✓${reset} ${msg}`);
      }
    },
  });
  return result;
}

// --- nf-bin install helpers (pure; exported for unit tests) -----------------
// The unified MCP server is a `.mjs` ES module that the nf-bin copy loop must
// install alongside the `.cjs` dispatch scripts. Historically the loop matched
// only `*.cjs`, so `unified-mcp-server.mjs` never landed in ~/.claude/nf-bin/
// and every mcpServers slot was pointed at the user's repo working tree (issue
// #200). These pure helpers centralize the selection / path rules so they can
// be tested without mutating the live ~/.claude environment.

// These pure helpers live in install-helpers.cjs so tests can import them
// WITHOUT requiring install.js (which runs the installer on load). See #200.
const {
  NF_BIN_RUNTIME_MJS,
  shouldCopyToNfBin,
  installedUnifiedMcpPath,
  isUnderInstallDir,
  mcpArgsNeedMigration,
  synthesizeMcpEntry,
} = require('./install-helpers.cjs');

// Ensures all provider slots from providers.json have corresponding MCP entries in ~/.claude.json.
// Only adds missing entries (never modifies existing ones).
// Fail-open: errors are logged but do not abort install.
// MULTI-03 dependency: must run BEFORE buildActiveSlots() is called in install flow,
// so that discovered MCP entries are available for quorum_active population.
function ensureMcpSlotsFromProviders() {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  const providersJsonPath = path.join(__dirname, 'providers.json');
  const unifiedMcpPath = path.join(__dirname, 'unified-mcp-server.mjs');

  try {
    // Step 1: Read providers.json
    let providersData;
    try {
      providersData = JSON.parse(fs.readFileSync(providersJsonPath, 'utf8'));
    } catch (e) {
      console.warn(`  ${yellow}⚠${reset} Could not read providers.json: ${e.message}`);
      return;
    }

    const providers = providersData.providers || [];
    if (providers.length === 0) {
      // providers.json is empty — sync slots from ~/.claude.json (fan-out slots created by
      // /nf:link-daintree) AND auto-detect PATH CLIs so both sources are available.
      if (hasGlobal) {
        const globalProvidersJson = path.join(os.homedir(), '.claude', 'nf-bin', 'providers.json');
        const merged = { providers: [] };
        try {
          // Preserve existing entries — when reconstructing providers.json from ~/.claude.json
          // mcpServers, fields like `daintree_preset_id`, `daintree_preset_name`,
          // `daintree_preset_family`, `env`, `model`, and `health_check_args` only live in the
          // installed providers.json. Without preserving them, every install would strip
          // Daintree metadata from preset-cloned slots and re-running /nf:link-daintree would
          // fail to recognize them as preset-linked, creating duplicate -N slots instead of
          // updating in place.
          // Build existingByName by reading from multiple sources, in order of freshness:
          //   1. nf-bin/providers.json — canonical live location (current install target)
          //   2. nf-local-patches/nf-bin/providers.json — saveLocalPatches() backup
          //   3. nf-local-patches/nf/bin/providers.json — legacy backup path (pre-consolidation)
          //   4. nf/bin/providers.json — legacy live path (pre-consolidation, may be symlink)
          const existingByName = new Map();
          const patchedProvidersPathNfBin = path.join(os.homedir(), '.claude', PATCHES_DIR_NAME, 'nf-bin', 'providers.json');
          const patchedProvidersPathLegacy = path.join(os.homedir(), '.claude', PATCHES_DIR_NAME, 'nf', 'bin', 'providers.json');
          const legacyProvidersPath = path.join(os.homedir(), '.claude', 'nf', 'bin', 'providers.json');
          for (const candidatePath of [globalProvidersJson, patchedProvidersPathNfBin, patchedProvidersPathLegacy, legacyProvidersPath]) {
            try {
              if (fs.existsSync(candidatePath)) {
                const existing = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
                for (const p of existing.providers || []) existingByName.set(p.name, p);
              }
            } catch (_) { /* skip unreadable / malformed */ }
          }

          // Step 1: Sync slots from ~/.claude.json (fan-out creates MCP entries here)
          // Only include slots whose prefix is a known coding agent CLI.
          const KNOWN_CLI_PREFIXES = ['claude', 'codex', 'gemini', 'opencode', 'copilot', 'kilo', 'cursor', 'windsurf', 'antigravity', 'augment', 'trae', 'cline'];
          const { resolveCli } = require('./resolve-cli.cjs');
          const { argsTemplateFor } = require('./provider-arg-templates.cjs');
          const claudeJsonPath = path.join(os.homedir(), '.claude.json');
          const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
          const mcpSlots = Object.keys(claudeJson.mcpServers || {}).filter(name =>
            KNOWN_CLI_PREFIXES.some(prefix => name === prefix || name.startsWith(prefix + '-'))
          );
          for (const slotName of mcpSlots) {
            // Infer mainTool from slot name prefix (e.g., "claude-z-ai" → "claude")
            const dashIdx = slotName.indexOf('-');
            const mainTool = dashIdx > 0 ? slotName.slice(0, dashIdx) : slotName;
            // Base shape derived from slot name; existing entry's fields (if any) win on overlay
            // — preserves daintree_preset_id, env, model, etc.
            const base = {
              name: slotName,
              provider: mainTool,
              type: 'subprocess',
              description: `Slot: ${slotName}`,
              mainTool,
              display_type: mainTool + '-cli',
              display_provider: mainTool.charAt(0).toUpperCase() + mainTool.slice(1),
            };
            // ARGS-TEMPLATE-01: emit the canonical per-family invocation template so
            // call-quorum-slot / unified-mcp-server don't crash on a missing field.
            // Only for families with a KNOWN template — KNOWN_CLI_PREFIXES also admits
            // IDE runtimes (kilo/cursor/windsurf/augment/trae/cline) that are NOT quorum
            // CLIs; writing a guessed `-p {prompt}` for those would be wrong. Leave the
            // field absent for unknown families so the consumer fail-loud contract applies.
            const _tmpl = argsTemplateFor(mainTool);
            if (_tmpl) base.args_template = _tmpl;
            // antigravity's family name ≠ its binary (`agy`); record the resolved binary
            // so spawn targets `agy`, never a non-existent `antigravity`. Persist it even
            // when resolution falls back to bare `agy` (better an explicit ENOENT on `agy`
            // than silently spawning the wrong mainTool).
            if (mainTool === 'antigravity' && !base.cli) {
              base.cli = resolveCli('agy');
            }
            const existing = existingByName.get(slotName);
            // Overlay existing on top of base (preserves Daintree metadata, env, etc.)
            // BUT force `name` and `mainTool` from the base (slot-name-derived). Otherwise
            // historical corruption like `copilot-1: { mainTool: 'ask' }` would persist
            // forever and cause the MCP server to spawn the wrong binary at health_check.
            merged.providers.push(existing
              ? { ...base, ...existing, name: base.name, mainTool: base.mainTool }
              : base);
          }
          // Step 2: Also add PATH-detected CLIs that aren't already in ~/.claude.json.
          // Each family's binary name usually matches the family, except antigravity
          // (family `antigravity` ships the `agy` binary) — so resolve by binary but
          // record the family name + its canonical args_template.
          const KNOWN_CLIS = [
            { family: 'claude',      bin: 'claude' },
            { family: 'codex',       bin: 'codex' },
            { family: 'gemini',      bin: 'gemini' },
            { family: 'opencode',    bin: 'opencode' },
            { family: 'copilot',     bin: 'copilot' },
            { family: 'antigravity', bin: 'agy' },
          ];
          const existingNames = new Set(mcpSlots);
          for (const { family, bin } of KNOWN_CLIS) {
            if (existingNames.has(family + '-1')) continue; // Already covered by step 1
            const resolved = resolveCli(bin);
            if (resolved !== bin) {
              merged.providers.push({
                name: family + '-1',
                provider: 'auto-detected',
                type: 'subprocess',
                description: `Auto-detected ${family} on PATH`,
                mainTool: family,
                cli: resolved,
                display_type: family + '-cli',
                display_provider: family.charAt(0).toUpperCase() + family.slice(1),
                // All Step-2 families have a canonical template; argsTemplateFor is
                // authoritative (no guessed fallback).
                args_template: argsTemplateFor(family),
              });
            }
          }
          // ── Restore daintree presets from install-immune store (issue #168) ──
          // ~/.claude/daintree-presets.json persists across copyWithPathReplacement wipes.
          // Overlay any preset entries that are missing or stripped from the merged providers.
          const { restoreDaintreePresets: _restoreDaintreePresets } = require('./install-helpers.cjs');
          const presetsStorePath = path.join(os.homedir(), '.claude', 'daintree-presets.json');
          let restoreResult = { restoredCount: 0, restoredNames: [] };
          try {
            restoreResult = _restoreDaintreePresets(merged.providers, presetsStorePath);
            if (restoreResult.restoredCount > 0) {
              const tmpPath = globalProvidersJson + '.tmp';
              fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
              fs.renameSync(tmpPath, globalProvidersJson);
              console.log(`  ${green}✓${reset} Restored ${restoreResult.restoredCount} daintree preset(s) from durable store`);
            }
          } catch (e) {
            console.warn(`  ${yellow}⚠${reset} Could not restore daintree presets: ${e.message}`);
          }

          if (merged.providers.length > 0 && restoreResult.restoredCount === 0) {
            const tmpPath = globalProvidersJson + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
            fs.renameSync(tmpPath, globalProvidersJson);
            console.log(`  ${green}✓${reset} Synced ${merged.providers.length} slot(s) to ${globalProvidersJson}`);
          }

          // Backfill UNIFIED_PROVIDERS_CONFIG on existing mcpServers entries that are
          // missing it. The main backfill loop further down only runs when the repo
          // source providers.json is populated (the non-empty branch) — for users
          // whose repo source is empty (the typical case after install), this branch
          // returns early and the main backfill never executes. Self-heal here too.
          try {
            const claudeJsonForBackfill = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
            if (claudeJsonForBackfill?.mcpServers) {
              let backfilled = 0;
              const legacyProvidersJson = path.join(os.homedir(), '.claude', 'nf', 'bin', 'providers.json');
              const nfBinDir = path.join(os.homedir(), '.claude', 'nf-bin');
              const installedMcp = path.join(nfBinDir, 'unified-mcp-server.mjs');
              for (const slotName of mcpSlots) {
                const entry = claudeJsonForBackfill.mcpServers[slotName];
                if (!entry) continue;
                entry.env = entry.env || {};
                // Backfill missing or migrate legacy nf/bin/ path
                if (!entry.env.UNIFIED_PROVIDERS_CONFIG || entry.env.UNIFIED_PROVIDERS_CONFIG === legacyProvidersJson) {
                  entry.env.UNIFIED_PROVIDERS_CONFIG = globalProvidersJson;
                  backfilled++;
                }
                // Args migration (issue #200): the early `return` above means the
                // main Step-4 args migration never runs when the repo source
                // providers.json is empty (the typical case after install). So a slot
                // whose args[0] points at the repo working tree (<repo>/bin/...mjs) or
                // an npx cache would never be repointed at the installed nf-bin copy,
                // leaving the whole fleet coupled to the repo tree. Self-heal it here.
                if (fs.existsSync(installedMcp)) {
                  const a0 = Array.isArray(entry.args) ? entry.args[0] : undefined;
                  if (mcpArgsNeedMigration(a0, nfBinDir)) {
                    entry.args = [installedMcp, ...entry.args.slice(1)];
                    backfilled++;
                  }
                }
              }
              if (backfilled > 0) {
                const tmpPath = claudeJsonPath + '.tmp';
                fs.writeFileSync(tmpPath, JSON.stringify(claudeJsonForBackfill, null, 2) + '\n', 'utf8');
                fs.renameSync(tmpPath, claudeJsonPath);
                console.log(`  ${green}✓${reset} Self-healed ${backfilled} mcpServers entry/entries (UNIFIED_PROVIDERS_CONFIG + args → nf-bin)`);
              }
            }
          } catch (e) {
            console.warn(`  ${yellow}⚠${reset} Could not backfill UNIFIED_PROVIDERS_CONFIG: ${e.message}`);
          }
        } catch (e) {
          console.warn(`  ${yellow}⚠${reset} Could not sync providers to ${globalProvidersJson}: ${e.message}`);
        }
      }
      return; // No providers to sync
    }

    // Step 2: Read ~/.claude.json (or create minimal structure if missing)
    let claudeConfig = { mcpServers: {} };
    try {
      if (fs.existsSync(claudeJsonPath)) {
        const fileContent = fs.readFileSync(claudeJsonPath, 'utf8');
        const parsed = JSON.parse(fileContent);
        claudeConfig = parsed;
        // Normalize: ensure mcpServers is an object
        if (!claudeConfig.mcpServers || typeof claudeConfig.mcpServers !== 'object') {
          claudeConfig.mcpServers = {};
        }
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        console.warn(`  ${yellow}⚠${reset} Could not parse ~/.claude.json: ${e.message}. Consider manual edit.`);
        return;
      } else {
        console.warn(`  ${yellow}⚠${reset} Could not read ~/.claude.json: ${e.message}`);
        return;
      }
    }

    // Step 3: Verify unified-mcp-server.mjs exists (hard fail if missing).
    // Slots must spawn from the INSTALLED copy under ~/.claude/nf-bin/, not the
    // repo working tree (issue #200) — a repo edit/stash/branch-switch must not
    // be able to take all slots down at once. Prefer the installed copy; fall
    // back to the repo source only if the nf-bin copy is not yet in place.
    const claudeHomeDir = path.join(os.homedir(), '.claude');
    const installedMcpPath = installedUnifiedMcpPath(claudeHomeDir);
    const mcpEntryPath = fs.existsSync(installedMcpPath) ? installedMcpPath : unifiedMcpPath;
    if (!fs.existsSync(unifiedMcpPath) && !fs.existsSync(installedMcpPath)) {
      console.error(`  ${yellow}✗${reset} ERROR: unified-mcp-server.mjs not found at ${installedMcpPath} or ${unifiedMcpPath}. MCP slots would be non-functional. Stopping.`);
      return;
    }

    // Step 4: For each provider, add missing MCP entry
    let addedCount = 0;
    for (const provider of providers) {
      const providerName = provider.name;
      if (provider.active === false) {
        continue; // Skip inactive providers (e.g., api-* HTTP slots removed from MCP config)
      }
      if (selectedProviderSlots && !selectedProviderSlots.includes(providerName)) {
        continue;
      }
      // unified-mcp-server reads its providers config from this path; without an explicit
      // pointer it falls back to its own __dirname/providers.json (which ships empty) and
      // exits with "Unknown PROVIDER_SLOT". Set UNIFIED_PROVIDERS_CONFIG on every entry —
      // new entries get it on creation, existing entries get backfilled below.
      const installedProvidersPath = path.join(os.homedir(), '.claude', 'nf-bin', 'providers.json');
      if (!claudeConfig.mcpServers.hasOwnProperty(providerName)) {
        // Create entry for this provider — args point at the INSTALLED nf-bin
        // copy (mcpEntryPath), never the repo working tree (issue #200).
        const entry = synthesizeMcpEntry(providerName, claudeHomeDir);
        entry.args = [mcpEntryPath];
        entry.env.UNIFIED_PROVIDERS_CONFIG = installedProvidersPath;
        claudeConfig.mcpServers[providerName] = entry;
        addedCount++;
        console.log(`  ${green}✓${reset} Added MCP entry for ${providerName}`);
      } else {
        // Backfill UNIFIED_PROVIDERS_CONFIG on existing entries that are missing it —
        // older /nf:mcp-setup runs created entries without this env, causing the spawned
        // server to look at the empty repo source. Self-heal on every install.
        // Also migrate entries still pointing to the legacy nf/bin/ path.
        const existing = claudeConfig.mcpServers[providerName];
        existing.env = existing.env || {};
        const legacyPath = path.join(os.homedir(), '.claude', 'nf', 'bin', 'providers.json');
        if (!existing.env.UNIFIED_PROVIDERS_CONFIG || existing.env.UNIFIED_PROVIDERS_CONFIG === legacyPath) {
          existing.env.UNIFIED_PROVIDERS_CONFIG = installedProvidersPath;
          addedCount++;
          console.log(`  ${green}✓${reset} Backfilled UNIFIED_PROVIDERS_CONFIG on ${providerName}`);
        }
        // Args migration (issue #200): older installs wrote args[0] pointing at
        // the repo working tree (<repo>/bin/unified-mcp-server.mjs) or the npx
        // cache. Rewrite any nForma slot whose args[0] is not under nf-bin to the
        // installed copy so a repo edit/stash/eviction can't take slots down.
        if (fs.existsSync(installedMcpPath)) {
          const args0 = Array.isArray(existing.args) ? existing.args[0] : undefined;
          const pointsAtUnified = typeof args0 === 'string' && args0.endsWith('unified-mcp-server.mjs');
          if (pointsAtUnified && !isUnderInstallDir(args0, path.join(claudeHomeDir, 'nf-bin'))) {
            existing.args = [installedMcpPath];
            addedCount++;
            console.log(`  ${green}✓${reset} Migrated ${providerName} args → ${installedMcpPath}`);
          } else if (!pointsAtUnified) {
            console.log(`  ${dim}↳ MCP entry for ${providerName} already exists (skipped)${reset}`);
          }
        } else {
          console.log(`  ${dim}↳ MCP entry for ${providerName} already exists (skipped)${reset}`);
        }
      }
    }

    // Step 4b: Install-time assertion (issue #200 regression gate) — every
    // nForma mcpServers entry's args[0] must exist AND live under nf-bin. Warn
    // loudly (never abort install) when a slot still points at the repo tree.
    if (fs.existsSync(installedMcpPath)) {
      const nfBinDir = path.join(claudeHomeDir, 'nf-bin');
      for (const provider of providers) {
        const slot = claudeConfig.mcpServers[provider.name];
        if (!slot || !Array.isArray(slot.args)) continue;
        const args0 = slot.args[0];
        if (typeof args0 !== 'string' || !args0.endsWith('unified-mcp-server.mjs')) continue;
        const underInstall = isUnderInstallDir(args0, nfBinDir);
        const exists = fs.existsSync(args0);
        if (!underInstall || !exists) {
          console.warn(`  ${yellow}⚠${reset} MCP slot ${provider.name} args[0] is not a valid installed path: ${args0} (under nf-bin: ${underInstall}, exists: ${exists})`);
        }
      }
    }

    // Step 5: Write back if any entries were added
    if (addedCount > 0) {
      try {
        const tmpPath = claudeJsonPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(claudeConfig, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, claudeJsonPath);
        console.log(`  ${green}✓${reset} Synced ${addedCount} provider slot(s) to ~/.claude.json`);
      } catch (e) {
        console.warn(`  ${yellow}⚠${reset} Could not write ~/.claude.json: ${e.message}. Consider backup and manual edit.`);
      }
    }
  } catch (e) {
    // Outer catch for any unexpected errors
    console.warn(`  ${yellow}⚠${reset} Unexpected error in ensureMcpSlotsFromProviders: ${e.message}`);
  }
}

// Generates quorum_instructions text from detected required_models.
// Uses detected tool_prefix values so behavioral instructions (UserPromptSubmit injection)
// name the same tools as the structural enforcement (Stop hook), preventing mismatch
// when server names differ from defaults (e.g. renamed MCP servers).
function buildQuorumInstructions(requiredModels) {
  function toolName(key, prefix) {
    if (key === 'codex')    return prefix + 'review';
    if (key === 'gemini')   return prefix + 'gemini';
    if (key === 'opencode') return prefix + 'opencode';
    return prefix + key;
  }
  const required = Object.entries(requiredModels).filter(([, def]) => def.required);
  const steps = required.map(([key, def], i) =>
    `  ${i + 1}. Call ${toolName(key, def.tool_prefix)} with the full plan content`
  ).join('\n');
  return (
    'QUORUM REQUIRED (structural enforcement — Stop hook will verify)\n\n' +
    'Before presenting any planning output to the user, you MUST:\n' +
    steps + '\n' +
    `  ${required.length + 1}. Present all model responses, resolve any concerns, then deliver your final output\n` +
    `  ${required.length + 2}. Include the token <!-- NF_DECISION --> somewhere in your FINAL output (not in intermediate messages or status updates — only when you are delivering the completed plan, research, verification report, or filtered question list to the user)\n\n` +
    'Fail-open: if a model is UNAVAILABLE (quota/error), note it and proceed with available models.\n' +
    'The Stop hook reads the transcript — skipping quorum will block your response.'
  );
}

// INST-05: Validate MCP availability and warn (yellow) per missing model.
// Runs on every install/reinstall — not just first-time.
// Does NOT abort installation (fail-open philosophy).
function warnMissingMcpServers() {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  let mcpServers = {};
  try {
    if (fs.existsSync(claudeJsonPath)) {
      const d = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      mcpServers = d.mcpServers || {};
    }
  } catch (e) {
    // If we can't read, skip silently — detection already warned in buildRequiredModelsFromMcp
    return;
  }

  for (const [modelKey, { keywords }] of Object.entries(NF_KEYWORD_MAP)) {
    const found = Object.keys(mcpServers).some(serverName =>
      keywords.some(kw => serverName.toLowerCase().includes(kw))
    );
    if (!found) {
      console.warn(
        `  ${yellow}⚠${reset} No ${modelKey} MCP server found in ~/.claude.json — ` +
        `quorum enforcement for ${modelKey} will be inactive until configured`
      );
    }
  }
}

// INST-01: Detects whether any API/Claude quorum agents are configured.
// Used in finishInstall() to nudge new users to run /nf:mcp-setup.
// Fail-open: returns false on read errors (never blocks install).
function hasClaudeMcpAgents() {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    if (!fs.existsSync(claudeJsonPath)) return false;
    const d = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const mcpServers = d.mcpServers || {};
    return Object.entries(mcpServers).some(([name, cfg]) => {
      // Match direct API slots and real Claude MCP slots
      if (/^(api|claude)-\d+$/.test(name)) return true;
      // Fallback: detect claude-mcp-server in args path (handles new installs before migration)
      if ((cfg.args || []).some(a => String(a).includes('claude-mcp-server'))) return true;
      return false;
    });
  } catch (e) {
    return false;
  }
}

// Parse --config-dir argument
function parseConfigDirArg() {
  const configDirIndex = args.findIndex(arg => arg === '--config-dir' || arg === '-c');
  if (configDirIndex !== -1) {
    const nextArg = args[configDirIndex + 1];
    // Error if --config-dir is provided without a value or next arg is another flag
    if (!nextArg || nextArg.startsWith('-')) {
      console.error(`  ${yellow}--config-dir requires a path argument${reset}`);
      process.exit(1);
    }
    return nextArg;
  }
  // Also handle --config-dir=value format
  const configDirArg = args.find(arg => arg.startsWith('--config-dir=') || arg.startsWith('-c='));
  if (configDirArg) {
    const value = configDirArg.split('=')[1];
    if (!value) {
      console.error(`  ${yellow}--config-dir requires a non-empty path${reset}`);
      process.exit(1);
    }
    return value;
  }
  return null;
}
const explicitConfigDir = parseConfigDirArg();
const hasHelp = args.includes('--help') || args.includes('-h');
const forceStatusline = args.includes('--force-statusline');

console.log(banner);

// Show help if requested
if (hasHelp) {
  console.log(`  ${yellow}Usage:${reset} npx get-shit-done-cc [options]\n\n  ${yellow}Options:${reset}\n    ${cyan}-g, --global${reset}              Install globally (to config directory)\n    ${cyan}-l, --local${reset}               Install locally (to current directory)\n    ${cyan}--claude${reset}                  Install for Claude Code only\n    ${cyan}--opencode${reset}                Install for OpenCode only\n    ${cyan}--gemini${reset}                  Install for Gemini CLI only\n    ${cyan}--kilo${reset}                    Install for Kilo only\n    ${cyan}--cursor${reset}                  Install for Cursor only\n    ${cyan}--windsurf${reset}                Install for Windsurf only\n    ${cyan}--codex${reset}                   Install for Codex only\n    ${cyan}--copilot${reset}                 Install for GitHub Copilot only\n    ${cyan}--antigravity${reset}             Install for Antigravity only\n    ${cyan}--augment${reset}                 Install for Augment only\n    ${cyan}--trae${reset}                    Install for Trae only\n    ${cyan}--cline${reset}                   Install for Cline only\n    ${cyan}--all${reset}                     Install for all runtimes\n    ${cyan}-u, --uninstall${reset}           Uninstall NF (remove all NF files)\n    ${cyan}-c, --config-dir <path>${reset}   Specify custom config directory\n    ${cyan}-h, --help${reset}                Show this help message\n    ${cyan}--force-statusline${reset}        Replace existing statusline config\n    ${cyan}--formal${reset}                  Install formal verification tools (TLA+, Alloy, PRISM)\n    ${cyan}--uninstall-formal${reset}        Remove formal verification tools\n\n  ${yellow}Examples:${reset}\n    ${dim}# Interactive install (prompts for runtime and location)${reset}\n    npx get-shit-done-cc\n\n    ${dim}# Install for Claude Code globally${reset}\n    npx get-shit-done-cc --claude --global\n\n    ${dim}# Install for Gemini globally${reset}\n    npx get-shit-done-cc --gemini --global\n\n    ${dim}# Install for Kilo globally${reset}\n    npx get-shit-done-cc --kilo --global\n\n    ${dim}# Install for Cursor globally${reset}\n    npx get-shit-done-cc --cursor --global\n\n    ${dim}# Install for Windsurf globally${reset}\n    npx get-shit-done-cc --windsurf --global\n\n    ${dim}# Install for Codex globally${reset}\n    npx get-shit-done-cc --codex --global\n\n    ${dim}# Install for GitHub Copilot globally${reset}\n    npx get-shit-done-cc --copilot --global\n\n    ${dim}# Install for Antigravity globally${reset}\n    npx get-shit-done-cc --antigravity --global\n\n    ${dim}# Install for Augment globally${reset}\n    npx get-shit-done-cc --augment --global\n\n    ${dim}# Install for Trae globally${reset}\n    npx get-shit-done-cc --trae --global\n\n    ${dim}# Install for Cline globally${reset}\n    npx get-shit-done-cc --cline --global\n\n    ${dim}# Install for all runtimes globally${reset}\n    npx get-shit-done-cc --all --global\n\n    ${dim}# Install locally to current project${reset}\n    npx get-shit-done-cc --local\n\n    ${dim}# Uninstall from global location${reset}\n    npx get-shit-done-cc --uninstall --global`);
  process.exit(0);
}

/**
 * Expand ~ to home directory (shell doesn't expand in env vars passed to node)
 */
function expandTilde(filePath) {
  if (filePath && filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Build a hook command path using forward slashes for cross-platform compatibility.
 * On Windows, $HOME is not expanded by cmd.exe/PowerShell, so we use the actual path.
 */
function buildHookCommand(configDir, hookName) {
  // Use forward slashes for Node.js compatibility on all platforms
  const hooksPath = configDir.replace(/\\/g, '/') + '/hooks/' + hookName;
  return `node "${hooksPath}"`;
}

/**
 * Read and parse settings.json, returning empty object if it doesn't exist
 */
function readSettings(settingsPath) {
  if (fs.existsSync(settingsPath)) {
    try {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

/**
 * Extracts the hook base name from a hook entry's command string.
 * E.g., "node /Users/foo/.claude/hooks/nf-circuit-breaker.js" -> "nf-circuit-breaker"
 * Returns empty string if no match.
 */
function extractHookName(hookEntry) {
  const cmd = (hookEntry.hooks && hookEntry.hooks[0] && hookEntry.hooks[0].command) || '';
  const match = cmd.match(/\/(nf-[a-z-]+)\.js/);
  return match ? match[1] : '';
}

/**
 * Sorts hook arrays in settings.hooks by priority (higher value = earlier position).
 * Reads user overrides from nf.json hook_priorities merged with DEFAULT_HOOK_PRIORITIES.
 * Hooks without a priority entry default to 50 (Normal).
 */
function sortHooksByPriority(settings, userPriorities) {
  const priorities = { ...DEFAULT_HOOK_PRIORITIES, ...(userPriorities || {}) };

  for (const eventType of Object.keys(settings.hooks || {})) {
    if (!Array.isArray(settings.hooks[eventType])) continue;
    settings.hooks[eventType].sort((a, b) => {
      const aName = extractHookName(a);
      const bName = extractHookName(b);
      const aPrio = priorities[aName] || 50;
      const bPrio = priorities[bName] || 50;
      return bPrio - aPrio; // Higher priority first
    });
  }
}

/**
 * Write settings.json with proper formatting
 */
function writeSettings(settingsPath, settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

// Cache for attribution settings (populated once per runtime during install)
const attributionCache = new Map();

/**
 * Get commit attribution setting for a runtime
 * @param {string} runtime - 'claude', 'opencode', or 'gemini'
 * @returns {null|undefined|string} null = remove, undefined = keep default, string = custom
 */
function getCommitAttribution(runtime) {
  // Return cached value if available
  if (attributionCache.has(runtime)) {
    return attributionCache.get(runtime);
  }

  let result;

  if (runtime === 'opencode') {
    const config = readSettings(path.join(getGlobalDir('opencode', null), 'opencode.json'));
    result = config.disable_ai_attribution === true ? null : undefined;
  } else if (runtime === 'gemini') {
    // Gemini: check gemini settings.json for attribution config
    const settings = readSettings(path.join(getGlobalDir('gemini', explicitConfigDir), 'settings.json'));
    if (!settings.attribution || settings.attribution.commit === undefined) {
      result = undefined;
    } else if (settings.attribution.commit === '') {
      result = null;
    } else {
      result = settings.attribution.commit;
    }
  } else {
    // Claude Code
    const settings = readSettings(path.join(getGlobalDir('claude', explicitConfigDir), 'settings.json'));
    if (!settings.attribution || settings.attribution.commit === undefined) {
      result = undefined;
    } else if (settings.attribution.commit === '') {
      result = null;
    } else {
      result = settings.attribution.commit;
    }
  }

  // Cache and return
  attributionCache.set(runtime, result);
  return result;
}

/**
 * Process Co-Authored-By lines based on attribution setting
 * @param {string} content - File content to process
 * @param {null|undefined|string} attribution - null=remove, undefined=keep, string=replace
 * @returns {string} Processed content
 */
function processAttribution(content, attribution) {
  if (attribution === null) {
    // Remove Co-Authored-By lines and the preceding blank line
    return content.replace(/(\r?\n){2}Co-Authored-By:.*$/gim, '');
  }
  if (attribution === undefined) {
    return content;
  }
  // Replace with custom attribution (escape $ to prevent backreference injection)
  const safeAttribution = attribution.replace(/\$/g, '$$$$');
  return content.replace(/Co-Authored-By:.*$/gim, `Co-Authored-By: ${safeAttribution}`);
}

/**
 * Convert Claude Code frontmatter to opencode format
 * - Converts 'allowed-tools:' array to 'permission:' object
 * @param {string} content - Markdown file content with YAML frontmatter
 * @returns {string} - Content with converted frontmatter
 */
// Color name to hex mapping for opencode compatibility
const colorNameToHex = {
  cyan: '#00FFFF',
  red: '#FF0000',
  green: '#00FF00',
  blue: '#0000FF',
  yellow: '#FFFF00',
  magenta: '#FF00FF',
  orange: '#FFA500',
  purple: '#800080',
  pink: '#FFC0CB',
  white: '#FFFFFF',
  black: '#000000',
  gray: '#808080',
  grey: '#808080',
};

// Tool name mapping from Claude Code to OpenCode
// OpenCode uses lowercase tool names; special mappings for renamed tools
const claudeToOpencodeTools = {
  AskUserQuestion: 'question',
  SlashCommand: 'skill',
  TodoWrite: 'todowrite',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',  // Plugin/MCP - keep for compatibility
};

// Tool name mapping from Claude Code to Gemini CLI
// Gemini CLI uses snake_case built-in tool names
const claudeToGeminiTools = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'replace',
  Bash: 'run_shell_command',
  Glob: 'glob',
  Grep: 'grep_search',
  WebSearch: 'google_web_search',
  WebFetch: 'web_fetch',
  TodoWrite: 'write_todos',
  AskUserQuestion: 'ask_user',
};

const ALL_RUNTIMES = ['claude', 'opencode', 'gemini', 'kilo', 'cursor', 'windsurf', 'codex', 'copilot', 'antigravity', 'augment', 'trae', 'cline'];

/**
 * Convert a Claude Code tool name to OpenCode format
 * - Applies special mappings (AskUserQuestion -> question, etc.)
 * - Converts to lowercase (except MCP tools which keep their format)
 */
function convertToolName(claudeTool) {
  // Check for special mapping first
  if (claudeToOpencodeTools[claudeTool]) {
    return claudeToOpencodeTools[claudeTool];
  }
  // MCP tools (mcp__*) keep their format
  if (claudeTool.startsWith('mcp__')) {
    return claudeTool;
  }
  // Default: convert to lowercase
  return claudeTool.toLowerCase();
}

/**
 * Convert a Claude Code tool name to Gemini CLI format
 * - Applies Claude→Gemini mapping (Read→read_file, Bash→run_shell_command, etc.)
 * - Filters out MCP tools (mcp__*) — they are auto-discovered at runtime in Gemini
 * - Filters out Task — agents are auto-registered as tools in Gemini
 * @returns {string|null} Gemini tool name, or null if tool should be excluded
 */
function convertGeminiToolName(claudeTool) {
  // MCP tools: exclude — auto-discovered from mcpServers config at runtime
  if (claudeTool.startsWith('mcp__')) {
    return null;
  }
  // Task: exclude — agents are auto-registered as callable tools
  if (claudeTool === 'Task') {
    return null;
  }
  // Check for explicit mapping
  if (claudeToGeminiTools[claudeTool]) {
    return claudeToGeminiTools[claudeTool];
  }
  // Default: lowercase
  return claudeTool.toLowerCase();
}

/**
 * Strip HTML <sub> tags for Gemini CLI output
 * Terminals don't support subscript — Gemini renders these as raw HTML.
 * Converts <sub>text</sub> to italic *(text)* for readable terminal output.
 */
function stripSubTags(content) {
  return content.replace(/<sub>(.*?)<\/sub>/g, '*($1)*');
}

/**
 * Convert Claude Code agent frontmatter to Gemini CLI format
 * Gemini agents use .md files with YAML frontmatter, same as Claude,
 * but with different field names and formats:
 * - tools: must be a YAML array (not comma-separated string)
 * - tool names: must use Gemini built-in names (read_file, not Read)
 * - color: must be removed (causes validation error)
 * - mcp__* tools: must be excluded (auto-discovered at runtime)
 */
function convertClaudeToGeminiAgent(content) {
  // Skip leading HTML comments (e.g., <!-- DEPRECATED ... -->)
  // Gemini CLI requires the file to start with --- for YAML frontmatter
  let processedContent = content;
  while (processedContent.trimStart().startsWith('<!--')) {
    const commentEnd = processedContent.indexOf('-->');
    if (commentEnd === -1) break;
    processedContent = processedContent.substring(commentEnd + 3).trimStart();
  }

  if (!processedContent.startsWith('---')) return processedContent;

  const endIndex = processedContent.indexOf('---', 3);
  if (endIndex === -1) return processedContent;

  const frontmatter = processedContent.substring(3, endIndex).trim();
  const body = processedContent.substring(endIndex + 3);

  const lines = frontmatter.split('\n');
  const newLines = [];
  let inAllowedTools = false;
  const tools = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Convert allowed-tools YAML array to tools list
    if (trimmed.startsWith('allowed-tools:')) {
      inAllowedTools = true;
      continue;
    }

    // Handle inline tools: field (comma-separated string)
    if (trimmed.startsWith('tools:')) {
      const toolsValue = trimmed.substring(6).trim();
      if (toolsValue) {
        const parsed = toolsValue.split(',').map(t => t.trim()).filter(t => t);
        for (const t of parsed) {
          const mapped = convertGeminiToolName(t);
          if (mapped) tools.push(mapped);
        }
      } else {
        // tools: with no value means YAML array follows
        inAllowedTools = true;
      }
      continue;
    }

    // Strip fields not supported by Gemini CLI (causes validation error)
    if (trimmed.startsWith('color:')) continue;
    if (trimmed.startsWith('isolation:')) continue;

    // Collect allowed-tools/tools array items
    if (inAllowedTools) {
      if (trimmed.startsWith('- ')) {
        const mapped = convertGeminiToolName(trimmed.substring(2).trim());
        if (mapped) tools.push(mapped);
        continue;
      } else if (trimmed && !trimmed.startsWith('-')) {
        inAllowedTools = false;
      }
    }

    if (!inAllowedTools) {
      newLines.push(line);
    }
  }

  // Add tools as YAML array (Gemini requires array format)
  if (tools.length > 0) {
    newLines.push('tools:');
    for (const tool of tools) {
      newLines.push(`  - ${tool}`);
    }
  }

  const newFrontmatter = newLines.join('\n').trim();

  // Escape ${VAR} patterns in agent body for Gemini CLI compatibility.
  // Gemini's templateString() treats all ${word} patterns as template variables
  // and throws "Template validation failed: Missing required input parameters"
  // when they can't be resolved. NF agents use ${PHASE}, ${PLAN}, etc. as
  // shell variables in bash code blocks — convert to $VAR (no braces) which
  // is equivalent bash and invisible to Gemini's /\$\{(\w+)\}/g regex.
  const escapedBody = body.replace(/\$\{(\w+)\}/g, '$$$1');

  return `---\n${newFrontmatter}\n---${stripSubTags(escapedBody)}`;
}

function convertClaudeToOpencodeFrontmatter(content) {
  // Replace tool name references in content (applies to all files)
  let convertedContent = content;
  convertedContent = convertedContent.replace(/\bAskUserQuestion\b/g, 'question');
  convertedContent = convertedContent.replace(/\bSlashCommand\b/g, 'skill');
  convertedContent = convertedContent.replace(/\bTodoWrite\b/g, 'todowrite');
  // Replace /nf:command with /nf-command for opencode (flat command structure)
  convertedContent = convertedContent.replace(/\/nf:/g, '/nf-');
  // Replace ~/.claude with ~/.config/opencode (OpenCode's correct config location)
  convertedContent = convertedContent.replace(/~\/\.claude\b/g, '~/.config/opencode');
  // Replace general-purpose subagent type with OpenCode's equivalent "general"
  convertedContent = convertedContent.replace(/subagent_type="general-purpose"/g, 'subagent_type="general"');

  // Check if content has frontmatter
  if (!convertedContent.startsWith('---')) {
    return convertedContent;
  }

  // Find the end of frontmatter
  const endIndex = convertedContent.indexOf('---', 3);
  if (endIndex === -1) {
    return convertedContent;
  }

  const frontmatter = convertedContent.substring(3, endIndex).trim();
  const body = convertedContent.substring(endIndex + 3);

  // Parse frontmatter line by line (simple YAML parsing)
  const lines = frontmatter.split('\n');
  const newLines = [];
  let inAllowedTools = false;
  const allowedTools = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect start of allowed-tools array
    if (trimmed.startsWith('allowed-tools:')) {
      inAllowedTools = true;
      continue;
    }

    // Detect inline tools: field (comma-separated string)
    if (trimmed.startsWith('tools:')) {
      const toolsValue = trimmed.substring(6).trim();
      if (toolsValue) {
        // Parse comma-separated tools
        const tools = toolsValue.split(',').map(t => t.trim()).filter(t => t);
        allowedTools.push(...tools);
      }
      continue;
    }

    // Remove name: field - opencode uses filename for command name
    if (trimmed.startsWith('name:')) {
      continue;
    }

    // Convert color names to hex for opencode
    if (trimmed.startsWith('color:')) {
      const colorValue = trimmed.substring(6).trim().toLowerCase();
      const hexColor = colorNameToHex[colorValue];
      if (hexColor) {
        newLines.push(`color: "${hexColor}"`);
      } else if (colorValue.startsWith('#')) {
        // Validate hex color format (#RGB or #RRGGBB)
        if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(colorValue)) {
          // Already hex and valid, keep as is
          newLines.push(line);
        }
        // Skip invalid hex colors
      }
      // Skip unknown color names
      continue;
    }

    // Collect allowed-tools items
    if (inAllowedTools) {
      if (trimmed.startsWith('- ')) {
        allowedTools.push(trimmed.substring(2).trim());
        continue;
      } else if (trimmed && !trimmed.startsWith('-')) {
        // End of array, new field started
        inAllowedTools = false;
      }
    }

    // Keep other fields (including name: which opencode ignores)
    if (!inAllowedTools) {
      newLines.push(line);
    }
  }

  // Add tools object if we had allowed-tools or tools
  if (allowedTools.length > 0) {
    newLines.push('tools:');
    for (const tool of allowedTools) {
      newLines.push(`  ${convertToolName(tool)}: true`);
    }
  }

  // Rebuild frontmatter (body already has tool names converted)
  const newFrontmatter = newLines.join('\n').trim();
  return `---\n${newFrontmatter}\n---${body}`;
}

/**
 * Convert Claude Code markdown command to Gemini TOML format
 * @param {string} content - Markdown file content with YAML frontmatter
 * @returns {string} - TOML content
 */
function convertClaudeToGeminiToml(content) {
  // Check if content has frontmatter
  if (!content.startsWith('---')) {
    return `prompt = ${JSON.stringify(content)}\n`;
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return `prompt = ${JSON.stringify(content)}\n`;
  }

  const frontmatter = content.substring(3, endIndex).trim();
  const body = content.substring(endIndex + 3).trim();
  
  // Extract description from frontmatter
  let description = '';
  const lines = frontmatter.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('description:')) {
      description = trimmed.substring(12).trim();
      break;
    }
  }

  // Construct TOML
  let toml = '';
  if (description) {
    toml += `description = ${JSON.stringify(description)}\n`;
  }
  
  toml += `prompt = ${JSON.stringify(body)}\n`;
  
  return toml;
}

/**
 * Copy commands to a flat structure for OpenCode
 * OpenCode expects: command/nf-help.md (invoked as /nf-help)
 * Source structure: commands/nf/help.md
 *
 * @param {string} srcDir - Source directory (e.g., commands/nf/)
 * @param {string} destDir - Destination directory (e.g., command/)
 * @param {string} prefix - Prefix for filenames (e.g., 'nf')
 * @param {string} pathPrefix - Path prefix for file references
 * @param {string} runtime - Target runtime ('claude' or 'opencode')
 */
function copyFlattenedCommands(srcDir, destDir, prefix, pathPrefix, runtime) {
  if (!fs.existsSync(srcDir)) {
    return;
  }
  
  // Remove old nf-*.md files before copying new ones
  if (fs.existsSync(destDir)) {
    for (const file of fs.readdirSync(destDir)) {
      if (file.startsWith(`${prefix}-`) && file.endsWith('.md')) {
        fs.unlinkSync(path.join(destDir, file));
      }
    }
  } else {
    fs.mkdirSync(destDir, { recursive: true });
  }
  
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    
    if (entry.isDirectory()) {
      // Recurse into subdirectories, adding to prefix
      // e.g., commands/nf/debug/start.md -> command/nf-debug-start.md
      copyFlattenedCommands(srcPath, destDir, `${prefix}-${entry.name}`, pathPrefix, runtime);
    } else if (entry.name.endsWith('.md')) {
      // Flatten: help.md -> nf-help.md
      const baseName = entry.name.replace('.md', '');
      const destName = `${prefix}-${baseName}.md`;
      const destPath = path.join(destDir, destName);

      let content = fs.readFileSync(srcPath, 'utf8');
      const globalClaudeRegex = /~\/\.claude\//g;
      const localClaudeRegex = /\.\/\.claude\//g;
      const opencodeDirRegex = /~\/\.opencode\//g;
      content = content.replace(globalClaudeRegex, pathPrefix);
      content = content.replace(localClaudeRegex, `./${getDirName(runtime)}/`);
      content = content.replace(opencodeDirRegex, pathPrefix);
      content = processAttribution(content, getCommitAttribution(runtime));
      content = convertClaudeToOpencodeFrontmatter(content);

      fs.writeFileSync(destPath, content);
    }
  }
}

/**
 * Recursively copy directory, replacing paths in .md files
 * Deletes existing destDir first to remove orphaned files from previous versions
 * @param {string} srcDir - Source directory
 * @param {string} destDir - Destination directory
 * @param {string} pathPrefix - Path prefix for file references
 * @param {string} runtime - Target runtime ('claude', 'opencode', 'gemini')
 */
function copyWithPathReplacement(srcDir, destDir, pathPrefix, runtime) {
  const isOpencode = runtime === 'opencode';
  const dirName = getDirName(runtime);

  // Clean install: remove existing destination to prevent orphaned files
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyWithPathReplacement(srcPath, destPath, pathPrefix, runtime);
    } else if (entry.name.endsWith('.md')) {
      // Replace ~/.claude/ and ./.claude/ with runtime-appropriate paths
      let content = fs.readFileSync(srcPath, 'utf8');
      const globalClaudeRegex = /~\/\.claude\//g;
      const localClaudeRegex = /\.\/\.claude\//g;
      content = content.replace(globalClaudeRegex, pathPrefix);
      content = content.replace(localClaudeRegex, `./${dirName}/`);
      content = processAttribution(content, getCommitAttribution(runtime));

      // Convert frontmatter for opencode compatibility
      if (isOpencode) {
        content = convertClaudeToOpencodeFrontmatter(content);
        fs.writeFileSync(destPath, content);
      } else if (runtime === 'gemini') {
        // Convert to TOML for Gemini (strip <sub> tags — terminals can't render subscript)
        content = stripSubTags(content);
        const tomlContent = convertClaudeToGeminiToml(content);
        // Replace extension with .toml
        const tomlPath = destPath.replace(/\.md$/, '.toml');
        fs.writeFileSync(tomlPath, tomlContent);
      } else {
        fs.writeFileSync(destPath, content);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Clean up orphaned files from previous NF versions
 */
function cleanupOrphanedFiles(configDir) {
  const orphanedFiles = [
    'hooks/nf-notify.sh',        // Removed in v1.6.x
    'hooks/statusline.js',         // Renamed to nf-statusline.js in v1.9.0
    'hooks/nf-statusline.js',     // Renamed to nf-statusline.js in v0.2
    'hooks/nf-check-update.js',   // Renamed to nf-check-update.js in v0.2
    'hooks/nf-prompt.js',        // Renamed to nf-prompt.js in v0.2
    'hooks/nf-stop.js',          // Renamed to nf-stop.js in v0.2
    'hooks/nf-circuit-breaker.js', // Renamed to nf-circuit-breaker.js in v0.2
    'hooks/nf-session-start.js', // Renamed to nf-session-start.js in v0.2
    'hooks/nf-check-update.js',  // Renamed to nf-check-update.js in v0.2
    'hooks/nf-statusline.js',    // Renamed to nf-statusline.js in v0.2
    'hooks/nf-precompact.js',    // Renamed to nf-precompact.js in v0.2
    'hooks/nf-slot-correlator.js', // Renamed to nf-slot-correlator.js in v0.2
    'hooks/nf-token-collector.js', // Renamed to nf-token-collector.js in v0.2
    'hooks/nf-spec-regen.js',    // Removed — functionality merged into nf-solve
  ];

  for (const relPath of orphanedFiles) {
    const fullPath = path.join(configDir, relPath);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      console.log(`  ${green}✓${reset} Removed orphaned ${relPath}`);
    }
  }
}

/**
 * Clean up orphaned hook registrations from settings.json
 */
function cleanupOrphanedHooks(settings) {
  const orphanedHookPatterns = [
    'nf-notify.sh',  // Removed in v1.6.x
    'hooks/statusline.js',  // Renamed to nf-statusline.js in v1.9.0
    'nf-intel-index.js',  // Removed in v1.9.2
    'nf-intel-session.js',  // Removed in v1.9.2
    'nf-intel-prune.js',  // Removed in v1.9.2
    'hooks/nf-check-update.js',  // Renamed to nf-check-update.js in v0.2
    'hooks/nf-statusline.js',  // Renamed to nf-statusline.js in v0.2
    'nf-prompt.js',  // Renamed to nf-prompt.js in v0.2
    'nf-stop.js',  // Renamed to nf-stop.js in v0.2
    'nf-circuit-breaker.js',  // Renamed to nf-circuit-breaker.js in v0.2
    'nf-session-start.js',  // Renamed to nf-session-start.js in v0.2
    'nf-check-update.js',  // Renamed to nf-check-update.js in v0.2
    'nf-statusline.js',  // Renamed to nf-statusline.js in v0.2
  ];

  let cleanedHooks = false;

  // Check all hook event types (Stop, SessionStart, etc.)
  if (settings.hooks) {
    for (const eventType of Object.keys(settings.hooks)) {
      const hookEntries = settings.hooks[eventType];
      if (Array.isArray(hookEntries)) {
        // Filter out entries that contain orphaned hooks
        const filtered = hookEntries.filter(entry => {
          if (entry.hooks && Array.isArray(entry.hooks)) {
            // Check if any hook in this entry matches orphaned patterns
            const hasOrphaned = entry.hooks.some(h =>
              h.command && orphanedHookPatterns.some(pattern => h.command.includes(pattern))
            );
            if (hasOrphaned) {
              cleanedHooks = true;
              return false;  // Remove this entry
            }
          }
          return true;  // Keep this entry
        });
        settings.hooks[eventType] = filtered;
      }
    }
  }

  if (cleanedHooks) {
    console.log(`  ${green}✓${reset} Removed orphaned hook registrations`);
  }

  // Fix #330 + nf migration: update statusLine if it points to old statusline path
  if (settings.statusLine && settings.statusLine.command) {
    const cmd = settings.statusLine.command;
    if ((cmd.includes('statusline.js') || cmd.includes('nf-statusline.js')) &&
        !cmd.includes('nf-statusline.js')) {
      settings.statusLine.command = cmd
        .replace(/\bnf-statusline\.js\b/, 'nf-statusline.js')
        .replace(/\bnf-statusline\.js\b/, 'nf-statusline.js')
        .replace(/\bstatusline\.js\b/, 'nf-statusline.js');
      console.log(`  ${green}✓${reset} Updated statusline path → nf-statusline.js`);
    }
  }

  return settings;
}

/**
 * Uninstall NF from the specified directory for a specific runtime
 * Removes only NF-specific files/directories, preserves user content
 * @param {boolean} isGlobal - Whether to uninstall from global or local
 * @param {string} runtime - Target runtime ('claude', 'opencode', 'gemini')
 */
function uninstall(isGlobal, runtime = 'claude') {
  const isOpencode = runtime === 'opencode';
  const dirName = getDirName(runtime);

  // Get the target directory based on runtime and install type
  const targetDir = isGlobal
    ? getGlobalDir(runtime, explicitConfigDir)
    : path.join(process.cwd(), dirName);

  const locationLabel = isGlobal
    ? targetDir.replace(os.homedir(), '~')
    : targetDir.replace(process.cwd(), '.');

  let runtimeLabel = 'Claude Code';
  if (runtime === 'opencode') runtimeLabel = 'OpenCode';
  if (runtime === 'gemini') runtimeLabel = 'Gemini';
  if (runtime === 'kilo') runtimeLabel = 'Kilo';
  if (runtime === 'cursor') runtimeLabel = 'Cursor';
  if (runtime === 'windsurf') runtimeLabel = 'Windsurf';
  if (runtime === 'codex') runtimeLabel = 'Codex';
  if (runtime === 'copilot') runtimeLabel = 'GitHub Copilot';
  if (runtime === 'antigravity') runtimeLabel = 'Antigravity';
  if (runtime === 'augment') runtimeLabel = 'Augment';
  if (runtime === 'trae') runtimeLabel = 'Trae';
  if (runtime === 'cline') runtimeLabel = 'Cline';

  console.log(`  Uninstalling NF from ${cyan}${runtimeLabel}${reset} at ${cyan}${locationLabel}${reset}\n`);

  // Check if target directory exists
  if (!fs.existsSync(targetDir)) {
    console.log(`  ${yellow}⚠${reset} Directory does not exist: ${locationLabel}`);
    console.log(`  Nothing to uninstall.\n`);
    return;
  }

  let removedCount = 0;

  // 1. Remove NF commands directory
  if (isOpencode) {
    // OpenCode: remove command/nf-*.md files (and legacy nf-*.md)
    const commandDir = path.join(targetDir, 'command');
    if (fs.existsSync(commandDir)) {
      const files = fs.readdirSync(commandDir);
      for (const file of files) {
        if (file.startsWith('nf-') && file.endsWith('.md')) {
          fs.unlinkSync(path.join(commandDir, file));
          removedCount++;
        }
      }
      console.log(`  ${green}✓${reset} Removed NF commands from command/`);
    }
  } else {
    // Claude Code & Gemini: remove commands/nf/ directory
    const nfCommandsDir = path.join(targetDir, 'commands', 'nf');
    if (fs.existsSync(nfCommandsDir)) {
      fs.rmSync(nfCommandsDir, { recursive: true });
      removedCount++;
      console.log(`  ${green}✓${reset} Removed commands/nf/`);
    }
  }

  // 2. Remove nf directory
  const nfDir = path.join(targetDir, 'nf');
  if (fs.existsSync(nfDir)) {
    fs.rmSync(nfDir, { recursive: true });
    removedCount++;
    console.log(`  ${green}✓${reset} Removed nf/`);
  }

  // 2b. Migration: warn about old get-shit-done/ and commands/nf/ paths from pre-v0.2 nForma installs
  // REN-03: intentional legacy path reference for migration detection
  const oldNfDir = path.join(targetDir, 'get-shit-done');
  const oldCommandsNfDir = path.join(targetDir, 'commands', 'nf');
  if (fs.existsSync(oldNfDir) || fs.existsSync(oldCommandsNfDir)) {
    console.log(`\n  ${yellow}⚠ Migration notice:${reset} Old nForma paths detected from a pre-v0.2 install:`);
    if (fs.existsSync(oldNfDir)) console.log(`    ${yellow}•${reset} ${oldNfDir}`);
    if (fs.existsSync(oldCommandsNfDir)) console.log(`    ${yellow}•${reset} ${oldCommandsNfDir}`);
    console.log(`  ${yellow}  If you don't have upstream NF installed, these can be safely removed:${reset}`);
    if (fs.existsSync(oldNfDir)) console.log(`    rm -rf ${oldNfDir}`);
    if (fs.existsSync(oldCommandsNfDir)) console.log(`    rm -rf ${oldCommandsNfDir}`);
    console.log();
  }

  // 3. Remove NF agents (nf-*.md files only)
  const agentsDir = path.join(targetDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    const files = fs.readdirSync(agentsDir);
    let agentCount = 0;
    for (const file of files) {
      if (file.startsWith('nf-') && file.endsWith('.md')) {
        fs.unlinkSync(path.join(agentsDir, file));
        agentCount++;
      }
    }
    if (agentCount > 0) {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed ${agentCount} nForma agents`);
    }

    // Migration: warn about old nf-*.md agents from pre-v0.2 nForma installs
    const oldAgents = fs.readdirSync(agentsDir).filter(f => f.startsWith('nf-') && f.endsWith('.md'));
    if (oldAgents.length > 0) {
      console.log(`\n  ${yellow}⚠ Migration notice:${reset} Old nForma agents (nf-*.md) detected from a pre-v0.2 install:`);
      oldAgents.forEach(f => console.log(`    ${yellow}•${reset} ${path.join(agentsDir, f)}`));
      console.log(`  ${yellow}  If you don't use upstream NF, these can be safely removed:${reset}`);
      console.log(`    for f in ~/.claude/agents/nf-*.md; do rm "$f"; done\n`);
    }
  }

  // 4. Remove NF hooks
  const hooksDir = path.join(targetDir, 'hooks');
  if (fs.existsSync(hooksDir)) {
    const nfHooks = [
      'nf-statusline.js', 'nf-check-update.js', 'nf-check-update.sh',
      'nf-prompt.js', 'nf-stop.js', 'nf-circuit-breaker.js',
      'nf-session-start.js', 'nf-check-update.js', 'nf-statusline.js',
    ];
    let hookCount = 0;
    for (const hook of nfHooks) {
      const hookPath = path.join(hooksDir, hook);
      if (fs.existsSync(hookPath)) {
        fs.unlinkSync(hookPath);
        hookCount++;
      }
    }
    if (hookCount > 0) {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed ${hookCount} NF hooks`);
    }
  }

  // 5. Remove NF package.json (CommonJS mode marker)
  const pkgJsonPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const content = fs.readFileSync(pkgJsonPath, 'utf8').trim();
      // Only remove if it's our minimal CommonJS marker
      if (content === '{"type":"commonjs"}') {
        fs.unlinkSync(pkgJsonPath);
        removedCount++;
        console.log(`  ${green}✓${reset} Removed NF package.json`);
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  // 6. Clean up settings.json (remove NF hooks and statusline)
  const settingsPath = path.join(targetDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    let settings = readSettings(settingsPath);
    let settingsModified = false;

    // Remove NF statusline if it references our hook (nf-* or old nf-*)
    if (settings.statusLine && settings.statusLine.command &&
        (settings.statusLine.command.includes('nf-statusline') || settings.statusLine.command.includes('nf-statusline'))) {
      delete settings.statusLine;
      settingsModified = true;
      console.log(`  ${green}✓${reset} Removed NF statusline from settings`);
    }

    // Remove NF hooks from SessionStart
    if (settings.hooks && settings.hooks.SessionStart) {
      const before = settings.hooks.SessionStart.length;
      settings.hooks.SessionStart = settings.hooks.SessionStart.filter(entry => {
        if (entry.hooks && Array.isArray(entry.hooks)) {
          // Filter out NF hooks
          const hasNfHook = entry.hooks.some(h =>
            h.command && (
              h.command.includes('nf-check-update') ||
              h.command.includes('nf-statusline') ||
              h.command.includes('nf-session-start') ||
              h.command.includes('nf-slot-health-probe')
            )
          );
          return !hasNfHook;
        }
        return true;
      });
      if (settings.hooks.SessionStart.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed NF hooks from settings`);
      }
      // Clean up empty array
      if (settings.hooks.SessionStart.length === 0) {
        delete settings.hooks.SessionStart;
      }
    }

    if (settings.hooks && settings.hooks.UserPromptSubmit) {
      const before = settings.hooks.UserPromptSubmit.length;
      settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(entry =>
        !(entry.hooks && entry.hooks.some(h => h.command && (h.command.includes('nf-prompt') || h.command.includes('nf-prompt'))))
      );
      if (settings.hooks.UserPromptSubmit.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed nForma quorum injection hook`);
      }
      if (settings.hooks.UserPromptSubmit.length === 0) delete settings.hooks.UserPromptSubmit;
    }
    if (settings.hooks && settings.hooks.Stop) {
      const before = settings.hooks.Stop.length;
      settings.hooks.Stop = settings.hooks.Stop.filter(entry =>
        !(entry.hooks && entry.hooks.some(h => h.command && (h.command.includes('nf-stop') || h.command.includes('nf-stop'))))
      );
      if (settings.hooks.Stop.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed nForma quorum gate hook`);
      }
      if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
    }
    if (settings.hooks && settings.hooks.PreToolUse) {
      const before = settings.hooks.PreToolUse.length;
      settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(entry =>
        !(entry.hooks && entry.hooks.some(h => h.command && (h.command.includes('nf-circuit-breaker') || h.command.includes('nf-circuit-breaker'))))
      );
      if (settings.hooks.PreToolUse.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed nForma circuit breaker hook`);
      }
      if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
    }
    // Remove nf-mcp-dispatch-guard hook (uninstall path)
    if (settings.hooks && settings.hooks.PreToolUse) {
      const before = settings.hooks.PreToolUse.length;
      settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(entry =>
        !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-mcp-dispatch-guard')))
      );
      if (settings.hooks.PreToolUse.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed nForma MCP dispatch guard hook`);
      }
      if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
    }
    // Remove nf-scope-guard hook (uninstall path)
    if (settings.hooks && settings.hooks.PreToolUse) {
      const before = settings.hooks.PreToolUse.length;
      settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(entry =>
        !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-scope-guard')))
      );
      if (settings.hooks.PreToolUse.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed nForma scope guard hook`);
      }
      if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
    }
    if (settings.hooks && settings.hooks.PostToolUse) {
      const before = settings.hooks.PostToolUse.length;
      settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(entry =>
        !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-context-monitor')))
      );
      if (settings.hooks.PostToolUse.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed nForma context monitor hook`);
      }
      if (settings.hooks.PostToolUse.length === 0) delete settings.hooks.PostToolUse;
    }
    // Remove nf-spec-regen hook (uninstall path)
    if (settings.hooks && settings.hooks.PostToolUse) {
      const before = settings.hooks.PostToolUse.length;
      settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(entry =>
        !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-spec-regen')))
      );
      if (settings.hooks.PostToolUse.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed nForma spec-regen hook`);
      }
      if (settings.hooks.PostToolUse.length === 0) delete settings.hooks.PostToolUse;
    }
    // Remove nf-post-edit-format hook (uninstall path)
    if (settings.hooks && settings.hooks.PostToolUse) {
      const before = settings.hooks.PostToolUse.length;
      settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(entry =>
        !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-post-edit-format')))
      );
      if (settings.hooks.PostToolUse.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed nForma post-edit format hook`);
      }
      if (settings.hooks.PostToolUse.length === 0) delete settings.hooks.PostToolUse;
    }
    // Remove nf-console-guard hook (uninstall path)
    if (settings.hooks && settings.hooks.Stop) {
      const before = settings.hooks.Stop.length;
      settings.hooks.Stop = settings.hooks.Stop.filter(entry =>
        !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-console-guard')))
      );
      if (settings.hooks.Stop.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed nForma console guard hook`);
      }
      if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
    }
    if (settings.hooks && settings.hooks.PreCompact) {
      const before = settings.hooks.PreCompact.length;
      settings.hooks.PreCompact = settings.hooks.PreCompact.filter(entry =>
        !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-precompact')))
      );
      if (settings.hooks.PreCompact.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed nForma PreCompact hook`);
      }
      if (settings.hooks.PreCompact.length === 0) delete settings.hooks.PreCompact;
    }
    // Remove nf-session-end hook (uninstall path)
    if (settings.hooks && settings.hooks.SessionEnd) {
      const before = settings.hooks.SessionEnd.length;
      settings.hooks.SessionEnd = settings.hooks.SessionEnd.filter(entry =>
        !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-session-end')))
      );
      if (settings.hooks.SessionEnd.length < before) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed nForma session-end hook`);
      }
      if (settings.hooks.SessionEnd.length === 0) delete settings.hooks.SessionEnd;
    }

    // Clean up empty hooks object
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    if (settingsModified) {
      writeSettings(settingsPath, settings);
      removedCount++;
    }
  }

  // 6. For OpenCode, clean up permissions from opencode.json
  if (isOpencode) {
    // For local uninstalls, clean up ./.opencode/opencode.json
    // For global uninstalls, clean up ~/.config/opencode/opencode.json
    const opencodeConfigDir = isGlobal
      ? getOpencodeGlobalDir()
      : path.join(process.cwd(), '.opencode');
    const configPath = path.join(opencodeConfigDir, 'opencode.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        let modified = false;

        // Remove NF permission entries
        if (config.permission) {
          for (const permType of ['read', 'external_directory']) {
            if (config.permission[permType]) {
              const keys = Object.keys(config.permission[permType]);
              for (const key of keys) {
                if (key.includes('nf')) {
                  delete config.permission[permType][key];
                  modified = true;
                }
              }
              // Clean up empty objects
              if (Object.keys(config.permission[permType]).length === 0) {
                delete config.permission[permType];
              }
            }
          }
          if (Object.keys(config.permission).length === 0) {
            delete config.permission;
          }
        }

        if (modified) {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
          removedCount++;
          console.log(`  ${green}✓${reset} Removed NF permissions from opencode.json`);
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    }
  }

  if (removedCount === 0) {
    console.log(`  ${yellow}⚠${reset} No NF files found to remove.`);
  }

  // Also clean up system-wide formal verification tools (only for global uninstall)
  if (isGlobal) {
    uninstallFormalTools();
  }

  console.log(`
  ${green}Done!${reset} NF has been uninstalled from ${runtimeLabel}.
  Your other files and settings have been preserved.
`);
}

/**
 * Parse JSONC (JSON with Comments) by stripping comments and trailing commas.
 * OpenCode supports JSONC format via jsonc-parser, so users may have comments.
 * This is a lightweight inline parser to avoid adding dependencies.
 */
function parseJsonc(content) {
  // Strip BOM if present
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }

  // Remove single-line and block comments while preserving strings
  let result = '';
  let inString = false;
  let i = 0;
  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    if (inString) {
      result += char;
      // Handle escape sequences
      if (char === '\\' && i + 1 < content.length) {
        result += next;
        i += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      i++;
    } else {
      if (char === '"') {
        inString = true;
        result += char;
        i++;
      } else if (char === '/' && next === '/') {
        // Skip single-line comment until end of line
        while (i < content.length && content[i] !== '\n') {
          i++;
        }
      } else if (char === '/' && next === '*') {
        // Skip block comment
        i += 2;
        while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) {
          i++;
        }
        i += 2; // Skip closing */
      } else {
        result += char;
        i++;
      }
    }
  }

  // Remove trailing commas before } or ]
  result = result.replace(/,(\s*[}\]])/g, '$1');

  return JSON.parse(result);
}

/**
 * Configure OpenCode permissions to allow reading NF reference docs
 * This prevents permission prompts when NF accesses the nf directory
 * @param {boolean} isGlobal - Whether this is a global or local install
 */
function configureOpencodePermissions(isGlobal = true) {
  // For local installs, use ./.opencode/opencode.json
  // For global installs, use ~/.config/opencode/opencode.json
  const opencodeConfigDir = isGlobal
    ? getOpencodeGlobalDir()
    : path.join(process.cwd(), '.opencode');
  const configPath = path.join(opencodeConfigDir, 'opencode.json');

  // Ensure config directory exists
  fs.mkdirSync(opencodeConfigDir, { recursive: true });

  // Read existing config or create empty object
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      config = parseJsonc(content);
    } catch (e) {
      // Cannot parse - DO NOT overwrite user's config
      console.log(`  ${yellow}⚠${reset} Could not parse opencode.json - skipping permission config`);
      console.log(`    ${dim}Reason: ${e.message}${reset}`);
      console.log(`    ${dim}Your config was NOT modified. Fix the syntax manually if needed.${reset}`);
      return;
    }
  }

  // Ensure permission structure exists
  if (!config.permission) {
    config.permission = {};
  }

  // Build the NF path using the actual config directory
  // Use ~ shorthand if it's in the default location, otherwise use full path
  const defaultConfigDir = path.join(os.homedir(), '.config', 'opencode');
  const nfPath = opencodeConfigDir === defaultConfigDir
    ? '~/.config/opencode/nf/*'
    : `${opencodeConfigDir.replace(/\\/g, '/')}/nf/*`;
  
  let modified = false;

  // Configure read permission
  if (!config.permission.read || typeof config.permission.read !== 'object') {
    config.permission.read = {};
  }
  if (config.permission.read[nfPath] !== 'allow') {
    config.permission.read[nfPath] = 'allow';
    modified = true;
  }

  // Configure external_directory permission (the safety guard for paths outside project)
  if (!config.permission.external_directory || typeof config.permission.external_directory !== 'object') {
    config.permission.external_directory = {};
  }
  if (config.permission.external_directory[nfPath] !== 'allow') {
    config.permission.external_directory[nfPath] = 'allow';
    modified = true;
  }

  if (!modified) {
    return; // Already configured
  }

  // Write config back
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`  ${green}✓${reset} Configured read permission for NF docs`);
}

/**
 * Auto-rebuild hooks/dist/ if missing by running scripts/build-hooks.js.
 * Preserves idempotency: if dist/ already exists, returns immediately.
 * @param {string} hooksDir - path to hooks/ source directory
 * @param {string} distDir - path to hooks/dist/ output directory
 * @returns {{ rebuilt: boolean, success: boolean, error?: string }}
 */
function buildHooksIfMissing(hooksDir, distDir) {
  if (fs.existsSync(distDir)) {
    return { rebuilt: false, success: true };
  }

  const buildScript = path.join(path.dirname(hooksDir), 'scripts', 'build-hooks.js');
  if (!fs.existsSync(buildScript)) {
    return { rebuilt: false, success: false, error: `build script not found: ${buildScript}` };
  }

  try {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [buildScript], {
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch (err) {
    return { rebuilt: false, success: false, error: `build-hooks.js failed: ${err.message}` };
  }

  if (fs.existsSync(distDir)) {
    return { rebuilt: true, success: true };
  }
  return { rebuilt: false, success: false, error: 'build-hooks.js completed but hooks/dist/ still missing' };
}

/**
 * Verify a directory exists and contains files
 */
function verifyInstalled(dirPath, description) {
  if (!fs.existsSync(dirPath)) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: directory not created`);
    return false;
  }
  try {
    const entries = fs.readdirSync(dirPath);
    if (entries.length === 0) {
      console.error(`  ${yellow}✗${reset} Failed to install ${description}: directory is empty`);
      return false;
    }
  } catch (e) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: ${e.message}`);
    return false;
  }
  return true;
}

/**
 * Verify a file exists
 */
function verifyFileInstalled(filePath, description) {
  if (!fs.existsSync(filePath)) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: file not created`);
    return false;
  }
  return true;
}

/**
 * Scan installed hook files for path.join(__dirname, ...) patterns and warn
 * about any that resolve to non-existent targets.  Fail-open: never blocks
 * installation, only prints warnings.
 *
 * @param {string} hooksDest  - Absolute path to the installed hooks directory
 * @param {string} targetDir  - Absolute path to the install target root (e.g. ~/.claude)
 * @returns {Array<{file: string, pattern: string, resolved: string, suggestion: string|null}>}
 */
function validateHookPaths(hooksDest, targetDir) {
  const warnings = [];
  let entries;
  try {
    entries = fs.readdirSync(hooksDest);
  } catch {
    return warnings;
  }

  const jsFiles = entries.filter(e => e.endsWith('.js') && !e.endsWith('.test.js'));
  const pathJoinRe = /path\.join\(\s*__dirname\s*,\s*((?:['"][^'"]*['"]\s*,?\s*)+)\)/g;

  for (const file of jsFiles) {
    const filePath = path.join(hooksDest, file);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    let match;
    while ((match = pathJoinRe.exec(content)) !== null) {
      const argsStr = match[1];
      const args = [];
      const localArgRe = /['"]([^'"]*)['"]/g;
      let argMatch;
      while ((argMatch = localArgRe.exec(argsStr)) !== null) {
        args.push(argMatch[1]);
      }
      if (args.length === 0) continue;

      const resolved = path.resolve(hooksDest, ...args);
      if (!fs.existsSync(resolved)) {
        const argsDisplay = args.map(a => `'${a}'`).join(', ');
        let suggestion = null;
        // Check if path contains /bin/ but not /nf-bin/ — common mistake
        if (/\/bin\//.test(resolved) && !/\/nf-bin\//.test(resolved)) {
          suggestion = "Hint: did you mean 'nf-bin' instead of 'bin'? Hooks run from ~/.claude/hooks/, not the repo.";
        }
        console.log(`  ${yellow}\u26A0${reset} ${file}: path.join(__dirname, ${argsDisplay}) resolves to ${resolved} \u2014 not found`);
        if (suggestion) {
          console.log(`    ${suggestion}`);
        }
        warnings.push({ file, pattern: argsDisplay, resolved, suggestion });
      }
    }
  }

  if (warnings.length > 0) {
    console.log(`  ${yellow}${warnings.length} broken path reference(s) found in hooks${reset} (install continues)`);
  }

  return warnings;
}

/**
 * Deep structural validation of the installation.
 * Checks counts, dependency integrity, and runtime transformations.
 * @param {string} targetDir - Root of the installation target (e.g. ~/.claude)
 * @param {string} runtime - 'claude', 'opencode', or 'gemini'
 * @returns {string[]} List of error messages (empty if pass)
 */
function validateStructuralIntegrity(targetDir, runtime) {
  const errors = [];
  const isOpencode = runtime === 'opencode';
  const isGemini = runtime === 'gemini';

  // Helper: Recursive file count
  const countFiles = (dir, filter) => {
    if (!fs.existsSync(dir)) return 0;
    let count = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += countFiles(fullPath, filter);
      } else if (filter(entry.name)) {
        count++;
      }
    }
    return count;
  };

  // 1. Verify Commands (Expected: 60)
  const EXPECTED_COMMANDS = 60;
  let commandCount = 0;
  if (isOpencode) {
    commandCount = countFiles(path.join(targetDir, 'command'), f => f.startsWith('nf-') && f.endsWith('.md'));
  } else {
    const ext = isGemini ? '.toml' : '.md';
    commandCount = countFiles(path.join(targetDir, 'commands', 'nf'), f => f.endsWith(ext));
  }

  if (commandCount < EXPECTED_COMMANDS) {
    errors.push(`Command count mismatch: expected at least ${EXPECTED_COMMANDS}, found ${commandCount}`);
  }

  // 2. Verify Agents (Expected: 17 for Claude/OpenCode, ~13 for Gemini)
  const EXPECTED_AGENTS = isGemini ? 13 : 17;
  const agentCount = countFiles(path.join(targetDir, 'agents'), f => f.startsWith('nf-') && f.endsWith('.md'));
  if (agentCount < EXPECTED_AGENTS) {
    errors.push(`Agent count mismatch: expected at least ${EXPECTED_AGENTS}, found ${agentCount}`);
  }

  // 3. Verify Hooks (Skip for OpenCode as it doesn't use active hooks)
  if (!isOpencode) {
    const hooksDir = path.join(targetDir, 'hooks');
    if (!fs.existsSync(hooksDir)) {
      errors.push('Hooks directory missing');
    } else {
      const hookFiles = fs.readdirSync(hooksDir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js') && !f.endsWith('.test.cjs'));
      
      // Every hook must resolve its local requires
      for (const hookFile of hookFiles) {
        const content = fs.readFileSync(path.join(hooksDir, hookFile), 'utf8');
        const requireMatches = content.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g);
        for (const match of requireMatches) {
          let dep = match[1];
          if (!path.extname(dep)) dep += '.js';
          if (!fs.existsSync(path.join(hooksDir, dep))) {
            errors.push(`Hook dependency missing: ${hookFile} requires ${dep}`);
          }
        }
      }
    }
  }

  // 4. Runtime Transformation Check
  if (isOpencode) {
    const cmdDir = path.join(targetDir, 'command');
    if (fs.existsSync(cmdDir)) {
      const cmdFiles = fs.readdirSync(cmdDir).filter(f => f.startsWith('nf-') && f.endsWith('.md'));
      for (const cmdFile of cmdFiles) {
        const content = fs.readFileSync(path.join(cmdDir, cmdFile), 'utf8');
        if (content.includes('/nf:')) {
          errors.push(`OpenCode transformation failed: found /nf: reference in ${cmdFile}`);
        }
      }
    }
  }

  return errors;
}

/**
 * Install to the specified directory for a specific runtime
 * @param {boolean} isGlobal - Whether to install globally or locally
 * @param {string} runtime - Target runtime ('claude', 'opencode', 'gemini')
 */

// ──────────────────────────────────────────────────────
// Local Patch Persistence
// ──────────────────────────────────────────────────────

const PATCHES_DIR_NAME = 'nf-local-patches';
const MANIFEST_NAME = 'nf-file-manifest.json';

/**
 * Compute SHA256 hash of file contents
 */
function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Recursively collect all files in dir with their hashes
 */
function generateManifest(dir, baseDir) {
  if (!baseDir) baseDir = dir;
  const manifest = {};
  if (!fs.existsSync(dir)) return manifest;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) {
      continue; // skip symlinks (e.g. nf/bin → nf-bin)
    } else if (entry.isDirectory()) {
      Object.assign(manifest, generateManifest(fullPath, baseDir));
    } else {
      manifest[relPath] = fileHash(fullPath);
    }
  }
  return manifest;
}

/**
 * Write file manifest after installation for future modification detection
 */
function writeManifest(configDir) {
  const nfDir = path.join(configDir, 'nf');
  const commandsDir = path.join(configDir, 'commands', 'nf');
  const agentsDir = path.join(configDir, 'agents');
  const manifest = { version: pkg.version, timestamp: new Date().toISOString(), files: {} };

  const nfHashes = generateManifest(nfDir);
  for (const [rel, hash] of Object.entries(nfHashes)) {
    manifest.files['nf/' + rel] = hash;
  }
  if (fs.existsSync(commandsDir)) {
    const cmdHashes = generateManifest(commandsDir);
    for (const [rel, hash] of Object.entries(cmdHashes)) {
      manifest.files['commands/nf/' + rel] = hash;
    }
  }
  if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      if (file.startsWith('nf-') && file.endsWith('.md')) {
        manifest.files['agents/' + file] = fileHash(path.join(agentsDir, file));
      }
    }
  }

  fs.writeFileSync(path.join(configDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Detect user-modified NF files by comparing against install manifest.
 * Backs up modified files to nf-local-patches/ for reapply after update.
 */
function saveLocalPatches(configDir) {
  const manifestPath = path.join(configDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return [];

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return []; }

  const patchesDir = path.join(configDir, PATCHES_DIR_NAME);
  const modified = [];

  for (const [relPath, originalHash] of Object.entries(manifest.files || {})) {
    const fullPath = path.join(configDir, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const currentHash = fileHash(fullPath);
    if (currentHash !== originalHash) {
      const backupPath = path.join(patchesDir, relPath);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(fullPath, backupPath);
      modified.push(relPath);
    }
  }

  if (modified.length > 0) {
    const meta = {
      backed_up_at: new Date().toISOString(),
      from_version: manifest.version,
      files: modified
    };
    fs.writeFileSync(path.join(patchesDir, 'backup-meta.json'), JSON.stringify(meta, null, 2));
    console.log('  ' + yellow + 'i' + reset + '  Found ' + modified.length + ' locally modified NF file(s) — backed up to ' + PATCHES_DIR_NAME + '/');
    for (const f of modified) {
      console.log('     ' + dim + f + reset);
    }
  }
  return modified;
}

/**
 * After install, report backed-up patches for user to reapply.
 */
function reportLocalPatches(configDir) {
  const patchesDir = path.join(configDir, PATCHES_DIR_NAME);
  const metaPath = path.join(patchesDir, 'backup-meta.json');
  if (!fs.existsSync(metaPath)) return [];

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return []; }

  if (meta.files && meta.files.length > 0) {
    console.log('');
    console.log('  ' + yellow + 'Local patches detected' + reset + ' (from v' + meta.from_version + '):');
    for (const f of meta.files) {
      console.log('     ' + cyan + f + reset);
    }
    console.log('');
    console.log('  Your modifications are saved in ' + cyan + PATCHES_DIR_NAME + '/' + reset);
    console.log('  Run ' + cyan + '/nf:reapply-patches' + reset + ' to merge them into the new version.');
    console.log('  Or manually compare and merge the files.');
    console.log('');
  }
  return meta.files || [];
}

function install(isGlobal, runtime = 'claude') {
  const isOpencode = runtime === 'opencode';
  const isGemini = runtime === 'gemini';
  const dirName = getDirName(runtime);
  const src = path.join(__dirname, '..');

  // Get the target directory based on runtime and install type
  const targetDir = isGlobal
    ? getGlobalDir(runtime, explicitConfigDir)
    : path.join(process.cwd(), dirName);

  const locationLabel = isGlobal
    ? targetDir.replace(os.homedir(), '~')
    : targetDir.replace(process.cwd(), '.');

  // Path prefix for file references in markdown content
  // For global installs: use full path
  // For local installs: use relative
  const pathPrefix = isGlobal
    ? `${targetDir.replace(/\\/g, '/')}/`
    : `./${dirName}/`;

  let runtimeLabel = 'Claude Code';
  if (isOpencode) runtimeLabel = 'OpenCode';
  if (isGemini) runtimeLabel = 'Gemini';
  if (runtime === 'kilo') runtimeLabel = 'Kilo';
  if (runtime === 'cursor') runtimeLabel = 'Cursor';
  if (runtime === 'windsurf') runtimeLabel = 'Windsurf';
  if (runtime === 'codex') runtimeLabel = 'Codex';
  if (runtime === 'copilot') runtimeLabel = 'GitHub Copilot';
  if (runtime === 'antigravity') runtimeLabel = 'Antigravity';
  if (runtime === 'augment') runtimeLabel = 'Augment';
  if (runtime === 'trae') runtimeLabel = 'Trae';
  if (runtime === 'cline') runtimeLabel = 'Cline';

  log(`  Installing for ${cyan}${runtimeLabel}${reset} to ${cyan}${locationLabel}${reset}\n`);

  // Track installation failures
  const failures = [];

  // Save any locally modified NF files before they get wiped
  saveLocalPatches(targetDir);

  // Clean up orphaned files from previous versions
  cleanupOrphanedFiles(targetDir);

  // OpenCode uses 'command/' (singular) with flat structure
  // Claude Code & Gemini use 'commands/' (plural) with nested structure
  if (isOpencode) {
    // OpenCode: flat structure in command/ directory
    const commandDir = path.join(targetDir, 'command');
    fs.mkdirSync(commandDir, { recursive: true });
    
    // Copy commands/nf/*.md as command/nf-*.md (flatten structure)
    const nfSrc = path.join(src, 'commands', 'nf');
    copyFlattenedCommands(nfSrc, commandDir, 'nf', pathPrefix, runtime);
    if (verifyInstalled(commandDir, 'command/nf-*')) {
      const count = fs.readdirSync(commandDir).filter(f => f.startsWith('nf-')).length;
      log(`  ${green}✓${reset} Installed ${count} commands to command/`);
    } else {
      failures.push('command/nf-*');
    }
  } else {
    // Claude Code & Gemini: nested structure in commands/ directory
    const commandsDir = path.join(targetDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    
    const nfSrc = path.join(src, 'commands', 'nf');
    const nfDest = path.join(commandsDir, 'nf');
    copyWithPathReplacement(nfSrc, nfDest, pathPrefix, runtime);
    if (verifyInstalled(nfDest, 'commands/nf')) {
      log(`  ${green}✓${reset} Installed commands/nf`);
    } else {
      failures.push('commands/nf');
    }
  }

  // Copy nf skill with path replacement
  const skillSrc = path.join(src, 'core');
  const skillDest = path.join(targetDir, 'nf');
  copyWithPathReplacement(skillSrc, skillDest, pathPrefix, runtime);
  if (verifyInstalled(skillDest, 'nf')) {
    log(`  ${green}✓${reset} Installed nf`);
  } else {
    failures.push('nf');
  }

  // Copy agents to agents directory
  const agentsSrc = path.join(src, 'agents');
  if (fs.existsSync(agentsSrc)) {
    const agentsDest = path.join(targetDir, 'agents');
    fs.mkdirSync(agentsDest, { recursive: true });

    // Remove old nf-*.md files before copying new ones
    if (fs.existsSync(agentsDest)) {
      for (const file of fs.readdirSync(agentsDest)) {
        if (file.startsWith('nf-') && file.endsWith('.md')) {
          fs.unlinkSync(path.join(agentsDest, file));
        }
      }
    }

    // Copy new agents
    const agentEntries = fs.readdirSync(agentsSrc, { withFileTypes: true });
    for (const entry of agentEntries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        let content = fs.readFileSync(path.join(agentsSrc, entry.name), 'utf8');
        // Always replace ~/.claude/ as it is the source of truth in the repo
        const dirRegex = /~\/\.claude\//g;
        content = content.replace(dirRegex, pathPrefix);
        content = processAttribution(content, getCommitAttribution(runtime));
        // Convert frontmatter for runtime compatibility
        if (isOpencode) {
          content = convertClaudeToOpencodeFrontmatter(content);
        } else if (isGemini) {
          content = convertClaudeToGeminiAgent(content);
        }
        fs.writeFileSync(path.join(agentsDest, entry.name), content);
      }
    }
    if (verifyInstalled(agentsDest, 'agents')) {
      log(`  ${green}✓${reset} Installed agents`);
    } else {
      failures.push('agents');
    }
  }

  // Copy CHANGELOG.md
  const changelogSrc = path.join(src, 'CHANGELOG.md');
  const changelogDest = path.join(targetDir, 'nf', 'CHANGELOG.md');
  if (fs.existsSync(changelogSrc)) {
    fs.copyFileSync(changelogSrc, changelogDest);
    if (verifyFileInstalled(changelogDest, 'CHANGELOG.md')) {
      log(`  ${green}✓${reset} Installed CHANGELOG.md`);
    } else {
      failures.push('CHANGELOG.md');
    }
  }

  // Copy skills to skills directory (Claude Code / OpenCode only)
  const skillsSrc = path.join(agentsSrc, 'skills');
  if (fs.existsSync(skillsSrc)) {
    const skillsDest = path.join(targetDir, 'skills');
    let skillCount = 0;
    for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(skillsSrc, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const destDir = path.join(skillsDest, entry.name);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(skillFile, path.join(destDir, 'SKILL.md'));
      skillCount++;
    }
    if (skillCount > 0) {
      log(`  ${green}✓${reset} Installed ${skillCount} skill${skillCount > 1 ? 's' : ''} to skills/`);
    }
  }

  // Write VERSION file (trailing newline — without it, a downstream read that
  // concatenates VERSION with another token produced e.g. `0.41.10LOCAL`, making
  // the install type undetectable; dogfood).
  const versionDest = path.join(targetDir, 'nf', 'VERSION');
  fs.writeFileSync(versionDest, pkg.version + '\n');
  if (verifyFileInstalled(versionDest, 'VERSION')) {
    log(`  ${green}✓${reset} Wrote VERSION (${pkg.version})`);
  } else {
    failures.push('VERSION');
  }

  // Write package.json to force CommonJS mode for NF scripts
  // Prevents "require is not defined" errors when project has "type": "module"
  // Node.js walks up looking for package.json - this stops inheritance from project
  const pkgJsonDest = path.join(targetDir, 'package.json');
  fs.writeFileSync(pkgJsonDest, '{"type":"commonjs"}\n');
  log(`  ${green}✓${reset} Wrote package.json (CommonJS mode)`);

  // Auto-rebuild hooks/dist/ if missing (fresh source clone support)
  const hooksDir = path.join(src, 'hooks');
  const distDir = path.join(src, 'hooks', 'dist');
  const rebuildResult = buildHooksIfMissing(hooksDir, distDir);
  if (!rebuildResult.success) {
    const errMsg = rebuildResult.error || 'unknown error';
    process.stderr.write(
      `\nError: hooks/dist/ missing and rebuild failed:\n  ${errMsg}\n\n` +
      `To fix, run from the nForma source directory:\n` +
      `  npm run build:hooks\n\n` +
      `Then try install again:\n` +
      `  node bin/install.js --claude --global\n\n`
    );
    failures.push('hooks');
  }

  // Copy hooks from dist/ (bundled with dependencies)
  // Template paths for the target runtime (replaces '.claude' with correct config dir)
  const hooksSrc = path.join(src, 'hooks', 'dist');
  if (fs.existsSync(hooksSrc)) {
    const hooksDest = path.join(targetDir, 'hooks');
    fs.mkdirSync(hooksDest, { recursive: true });
    const hookEntries = fs.readdirSync(hooksSrc);
    const configDirReplacement = getConfigDirFromHome(runtime, isGlobal);
    for (const entry of hookEntries) {
      const srcFile = path.join(hooksSrc, entry);
      if (fs.statSync(srcFile).isFile()) {
        const destFile = path.join(hooksDest, entry);
        // Template .js files to replace '.claude' with runtime-specific config dir
        if (entry.endsWith('.js')) {
          let content = fs.readFileSync(srcFile, 'utf8');
          content = content.replace(/'\.claude'/g, configDirReplacement);
          fs.writeFileSync(destFile, content);
        } else {
          fs.copyFileSync(srcFile, destFile);
        }
      }
    }
    if (verifyInstalled(hooksDest, 'hooks')) {
      log(`  ${green}✓${reset} Installed hooks (bundled)`);
    } else {
      failures.push('hooks');
    }
  }

  // Copy bin/*.cjs scripts to nf-bin/ (used by commands with absolute paths).
  // providers.json gets MERGE semantics rather than overwrite: user-added entries
  // (slots created by /nf:link-canopy fan-out, /nf:mcp-setup, hand-edited customizations,
  // anything carrying daintree_preset_id or simply not present in the repo source) are
  // preserved across re-installs. Repo-shipped slot entries are always refreshed from
  // the repo so metadata bumps (description, mainTool, model defaults) propagate.
  const binSrc = path.join(src, 'bin');
  if (fs.existsSync(binSrc)) {
    const binDest = path.join(targetDir, 'nf-bin');
    fs.mkdirSync(binDest, { recursive: true });
    const binEntries = fs.readdirSync(binSrc);
    for (const entry of binEntries) {
      if (entry === 'providers.json') {
        mergeProvidersJson(path.join(binSrc, entry), path.join(binDest, entry));
      } else if (shouldCopyToNfBin(entry)) {
        // Copies *.cjs dispatch scripts AND runtime *.mjs modules (notably
        // unified-mcp-server.mjs — issue #200). Without the .mjs copy, every
        // mcpServers slot is forced to spawn from the repo working tree.
        fs.copyFileSync(path.join(binSrc, entry), path.join(binDest, entry));
      }
    }
    log(`  ${green}✓${reset} Installed nf-bin scripts`);

    // Copy bin/adapters/ to nf-bin/adapters/ (FSM-to-TLA+ transpiler adapters)
    const adaptersSrc = path.join(binSrc, 'adapters');
    if (fs.existsSync(adaptersSrc)) {
      const adaptersDest = path.join(binDest, 'adapters');
      fs.mkdirSync(adaptersDest, { recursive: true });
      for (const entry of fs.readdirSync(adaptersSrc)) {
        if (entry.endsWith('.cjs')) {
          fs.copyFileSync(path.join(adaptersSrc, entry), path.join(adaptersDest, entry));
        }
      }
      log(`  ${green}✓${reset} Installed FSM-to-TLA+ adapters`);
    }

    // Copy bin/repowise/ to nf-bin/repowise/ (Repowise Intelligence modules)
    const repowiseSrc = path.join(binSrc, 'repowise');
    if (fs.existsSync(repowiseSrc)) {
      const repowiseDest = path.join(binDest, 'repowise');
      fs.mkdirSync(repowiseDest, { recursive: true });
      for (const entry of fs.readdirSync(repowiseSrc)) {
        if (entry.endsWith('.cjs') && !entry.endsWith('.test.cjs')) {
          fs.copyFileSync(path.join(repowiseSrc, entry), path.join(repowiseDest, entry));
        }
      }
      log(`  ${green}✓${reset} Installed Repowise Intelligence modules`);
    }

    // Copy dist/machines/ to nf-bin/dist/machines/ (XState bundle for gate scripts)
    const machinesSrc = path.join(src, 'dist', 'machines');
    if (fs.existsSync(machinesSrc)) {
      const machinesDest = path.join(binDest, 'dist', 'machines');
      fs.mkdirSync(machinesDest, { recursive: true });
      for (const entry of fs.readdirSync(machinesSrc)) {
        if (entry.endsWith('.js')) {
          fs.copyFileSync(path.join(machinesSrc, entry), path.join(machinesDest, entry));
        }
      }
      log(`  ${green}✓${reset} Installed XState machine bundle`);
    }

    // Mirror nf-bin/ scripts into nf/bin/ so both paths resolve
    // (LLMs often guess ~/.claude/nf/bin/ instead of ~/.claude/nf-bin/)
    // nf/bin/ already has core/bin/ files (nf-tools.cjs); we add nf-bin/ scripts alongside them
    const nfBinDir = path.join(targetDir, 'nf', 'bin');
    const nfBinProviders = path.join(nfBinDir, 'providers.json');
    const canonicalProviders = path.join(binDest, 'providers.json');
    if (fs.existsSync(nfBinDir) && !fs.lstatSync(nfBinDir).isSymbolicLink()) {
      // Migrate legacy nf/bin/providers.json → nf-bin/providers.json if needed
      if (fs.existsSync(nfBinProviders) && !fs.lstatSync(nfBinProviders).isSymbolicLink()) {
        try {
          const legacyData = JSON.parse(fs.readFileSync(nfBinProviders, 'utf8'));
          const legacyProviders = legacyData.providers || [];
          // Only migrate if legacy has data and nf-bin copy is empty/missing
          if (legacyProviders.length > 0) {
            let canonicalData = { providers: [] };
            try {
              if (fs.existsSync(canonicalProviders)) {
                canonicalData = JSON.parse(fs.readFileSync(canonicalProviders, 'utf8'));
              }
            } catch (_) { /* empty/missing — fine */ }
            const canonicalProvidersList = canonicalData.providers || [];
            if (canonicalProvidersList.length === 0) {
              // nf-bin is empty — migrate legacy data here
              fs.writeFileSync(canonicalProviders, JSON.stringify(legacyData, null, 2) + '\n', 'utf8');
              console.log(`  ${green}✓${reset} Migrated ${legacyProviders.length} provider(s) from nf/bin/ → nf-bin/`);
            }
          }
        } catch (_) { /* unreadable — skip migration */ }

        // Replace legacy nf/bin/providers.json with symlink to canonical nf-bin/providers.json
        // Use atomic rename to avoid losing the legacy file if symlink creation fails
        try {
          const backupPath = nfBinProviders + '.bak';
          fs.renameSync(nfBinProviders, backupPath);
          try {
            fs.symlinkSync(canonicalProviders, nfBinProviders);
            fs.unlinkSync(backupPath);
            console.log(`  ${green}✓${reset} Linked nf/bin/providers.json → nf-bin/providers.json`);
          } catch (e) {
            // Symlink failed — restore backup so legacy readers still work
            try { fs.renameSync(backupPath, nfBinProviders); } catch (_) { /* best effort */ }
            log(`  Could not create providers.json symlink: ${e.message}`);
          }
        } catch (e) {
          log(`  Could not back up legacy providers.json: ${e.message}`);
        }
      }

      // Mirror remaining nf-bin/ scripts (excluding providers.json) into nf/bin/
      let mirrored = 0;
      for (const entry of fs.readdirSync(binDest)) {
        if (entry === 'providers.json') continue;
        const srcFile = path.join(binDest, entry);
        if (fs.statSync(srcFile).isFile()) {
          const destFile = path.join(nfBinDir, entry);
          if (!fs.existsSync(destFile)) {
            fs.copyFileSync(srcFile, destFile);
            mirrored++;
          }
        }
      }
      // Also mirror adapters/ subdirectory
      const adaptersSrcMirror = path.join(binDest, 'adapters');
      const adaptersDstMirror = path.join(nfBinDir, 'adapters');
      if (fs.existsSync(adaptersSrcMirror)) {
        fs.mkdirSync(adaptersDstMirror, { recursive: true });
        for (const entry of fs.readdirSync(adaptersSrcMirror)) {
          const srcFile = path.join(adaptersSrcMirror, entry);
          const destFile = path.join(adaptersDstMirror, entry);
          if (fs.statSync(srcFile).isFile() && !fs.existsSync(destFile)) {
            fs.copyFileSync(srcFile, destFile);
            mirrored++;
          }
        }
      }
      if (mirrored > 0) {
        log(`  ${green}✓${reset} Mirrored ${mirrored} nf-bin scripts into nf/bin`);
      }
    } else if (fs.existsSync(nfBinDir) && fs.lstatSync(nfBinDir).isSymbolicLink()) {
      // Previous install created a symlink — restore as real dir with merged contents
      fs.unlinkSync(nfBinDir);
      fs.mkdirSync(nfBinDir, { recursive: true });
      // Re-copy core/bin/ files
      const coreBinSrc = path.join(src, 'core', 'bin');
      if (fs.existsSync(coreBinSrc)) {
        for (const entry of fs.readdirSync(coreBinSrc)) {
          fs.copyFileSync(path.join(coreBinSrc, entry), path.join(nfBinDir, entry));
        }
      }
      // Copy nf-bin/ files (excluding providers.json — symlink it instead)
      for (const entry of fs.readdirSync(binDest)) {
        if (entry === 'providers.json') continue;
        const srcFile = path.join(binDest, entry);
        if (fs.statSync(srcFile).isFile()) {
          const destFile = path.join(nfBinDir, entry);
          if (!fs.existsSync(destFile)) {
            fs.copyFileSync(srcFile, destFile);
          }
        }
      }
      // Symlink providers.json from nf/bin/ → nf-bin/
      try {
        fs.symlinkSync(canonicalProviders, nfBinProviders);
        console.log(`  ${green}✓${reset} Linked nf/bin/providers.json → nf-bin/providers.json`);
      } catch (e) {
        log(`  Could not create providers.json symlink: ${e.message}`);
      }
      log(`  ${green}✓${reset} Restored nf/bin (was symlink) with merged contents`);
    }
  }

  // Download coderlm binary to nf-bin/ if not already present (fail-open)
  // Skipped when NF_INSTALL_SKIP_OPTIONAL=1 (set by install tests) — git clone can take 60s+
  if (!process.env.NF_INSTALL_SKIP_OPTIONAL) {
    const lifecycle = getCoderlmLifecycle();
    if (lifecycle) {
      // Idempotency check: if coderlm already installed, skip silently
      try {
        fs.accessSync(path.join(os.homedir(), '.claude', 'nf-bin', 'coderlm'), fs.constants.X_OK);
        // Already installed — no-op
      } catch (e) {
        // NOTE: this outer try/catch is ONLY for fs.accessSync (detect missing binary).
        // Only act on ENOENT (file truly absent) — other errors (EACCES, EISDIR, etc.)
        // mean the binary path exists but is inaccessible; skip silently to preserve
        // idempotency and avoid spurious installs.
        // Do NOT wrap ensureBinary() in this catch — it handles its own errors internally.
        if (e.code === 'ENOENT') {
          console.log(`  ${cyan}↓${reset} Installing coderlm...`);
          const result = lifecycle.ensureBinary();
          if (result.ok && result.source !== 'cached') {
            console.log(`  ${green}✓${reset} coderlm installed`);
          } else if (!result.ok) {
            const detail = typeof result.detail === 'string' ? result.detail : '';
            console.log(`  ${yellow}⚠${reset} coderlm download skipped: ${result.error}${detail ? ' (' + detail.slice(0, 80) + ')' : ''}`);
          }
        }
        // Other errors (EACCES, EISDIR, etc.) — assume binary exists, skip silently
      }
    }
  }

  // Optional heavy installs: River ML and @huggingface/transformers.
  // Skipped when NF_INSTALL_SKIP_OPTIONAL=1 (set by install tests to avoid network timeouts).
  if (!process.env.NF_INSTALL_SKIP_OPTIONAL) {
    // Install River ML library into dedicated uv-managed venv (fail-open)
    // Venv lives at ~/.claude/nf-python-env — avoids PEP 668 Homebrew conflicts
    {
      const { spawnSync: _spawnRiver } = require('child_process');
      const nfPythonEnv = path.join(os.homedir(), '.claude', 'nf-python-env');
      const nfPython = path.join(nfPythonEnv, 'bin', 'python');
      try {
        // Check uv availability first — install it if missing
        const uvCheck = _spawnRiver('which', ['uv'], { timeout: 3000 });
        if (uvCheck.status !== 0) {
          log(`  ${cyan}↓${reset} Installing uv...`);
          const uvInstall = _spawnRiver('curl', ['-sSL', 'https://astral.sh/uv/install.sh'], { timeout: 30000 });
          if (uvInstall.status !== 0) {
            log(`  ${yellow}⚠${reset} uv install failed — skipping River ML`);
            return;
          }
          // Reload PATH so uv is found immediately after install
          const newPath = [...new Set([path.join(os.homedir(), '.local', 'bin'), ...process.env.PATH.split(':')])].join(':');
          const uvPathCheck = _spawnRiver('which', ['uv'], { timeout: 3000, env: { ...process.env, PATH: newPath } });
          if (uvPathCheck.status !== 0) {
            log(`  ${yellow}⚠${reset} uv not in PATH after install — skipping River ML`);
            return;
          }
        }
        // Create venv first if missing — River needs the file to be active
        if (!fs.existsSync(nfPythonEnv)) {
          _spawnRiver('uv', ['venv', nfPythonEnv], { timeout: 30000 });
        }
        const riverCheck = _spawnRiver(nfPython, ['-c', 'import river'], { timeout: 3000 });
        if (riverCheck.status !== 0) {
          console.log(`  ${cyan}↓${reset} Installing River ML (uv)...`);
          const riverInstall = _spawnRiver('uv', ['pip', 'install', '--python', nfPythonEnv, 'river'], { timeout: 60000 });
          if (riverInstall.status === 0) {
            console.log(`  ${green}✓${reset} River ML installed`);
          } else {
            const errOut = riverInstall.stderr ? riverInstall.stderr.toString().slice(0, 120) : '';
            console.log(`  ${yellow}⚠${reset} River ML install skipped: uv returned non-zero${errOut ? ' (' + errOut + ')' : ''}`);
          }
        }
        // status === 0: River already importable — skip silently
      } catch (e) {
        // uv or nfPython not found or timed out — skip silently (fail-open)
      }
    }

    // Install @huggingface/transformers to nf-bin if not already present (fail-open)
    {
      const { spawnSync: _spawnEmbed } = require('child_process');
      try {
        const transformersGlobalPath = path.join(os.homedir(), '.claude', 'nf-bin', 'node_modules', '@huggingface', 'transformers');
        if (!fs.existsSync(transformersGlobalPath)) {
          console.log(`  ${cyan}↓${reset} Installing @huggingface/transformers...`);
          const embedInstall = _spawnEmbed('npm', ['install', '--prefix', path.join(os.homedir(), '.claude', 'nf-bin'), '@huggingface/transformers'], { timeout: 120000 });
          if (embedInstall.status === 0) {
            console.log(`  ${green}✓${reset} @huggingface/transformers installed`);
          } else {
            const errOut = embedInstall.stderr ? embedInstall.stderr.toString().slice(0, 120) : '';
            console.log(`  ${yellow}⚠${reset} @huggingface/transformers install skipped: npm returned non-zero${errOut ? ' (' + errOut + ')' : ''}`);
          }
        }
        // Already present — skip silently
      } catch (e) {
        // Unexpected error — skip silently (fail-open)
      }
    }

    // Vendor `xstate` to nf-bin (fail-open). validate-traces.cjs / state-candidates.cjs
    // `require('xstate')` at runtime; from the repo it resolves via the repo's node_modules,
    // but an installed copy in ~/.claude/nf-bin/ has no complete xstate — a stale partial
    // copy (dist + LICENSE, NO package.json) made `require('xstate')` fail, so those tools
    // silently died in every user project. Guard on package.json (not just the dir) so this
    // repairs the partial copy, not just a fresh install.
    {
      const { spawnSync: _spawnXs } = require('child_process');
      try {
        const nfBinRoot = path.join(os.homedir(), '.claude', 'nf-bin');
        const xstatePkg = path.join(nfBinRoot, 'node_modules', 'xstate', 'package.json');
        if (!fs.existsSync(xstatePkg)) {
          console.log(`  ${cyan}↓${reset} Vendoring xstate to nf-bin...`);
          const xsInstall = _spawnXs('npm', ['install', '--prefix', nfBinRoot, 'xstate'], { timeout: 120000 });
          if (xsInstall.status === 0) {
            console.log(`  ${green}✓${reset} xstate vendored`);
          } else {
            const errOut = xsInstall.stderr ? xsInstall.stderr.toString().slice(0, 120) : '';
            console.log(`  ${yellow}⚠${reset} xstate vendoring skipped: npm returned non-zero${errOut ? ' (' + errOut + ')' : ''}`);
          }
        }
      } catch (e) {
        // fail-open
      }
    }
  } // end NF_INSTALL_SKIP_OPTIONAL guard

  // Validate hook path references point to real targets
  const hooksDestValidation = path.join(targetDir, 'hooks');
  if (fs.existsSync(hooksDestValidation)) {
    validateHookPaths(hooksDestValidation, targetDir);
  }

  // Deep structural validation
  const structuralErrors = validateStructuralIntegrity(targetDir, runtime);
  if (structuralErrors.length > 0) {
    console.log(`\n  ${yellow}Structural validation failed:${reset}`);
    for (const err of structuralErrors) {
      console.log(`    ${yellow}✗${reset} ${err}`);
    }
    failures.push('Structural Integrity');
  } else {
    log(`  ${green}✓${reset} Structural validation passed`);
  }

  if (failures.length > 0) {
    console.error(`\n  ${yellow}Installation incomplete!${reset} Failed: ${failures.join(', ')}`);
    process.exit(1);
  }

  // Configure statusline and hooks in settings.json
  // Gemini shares same hook system as Claude Code for now
  const settingsPath = path.join(targetDir, 'settings.json');
  const settings = cleanupOrphanedHooks(readSettings(settingsPath));
  const statuslineCommand = isGlobal
    ? buildHookCommand(targetDir, 'nf-statusline.js')
    : 'node ' + dirName + '/hooks/nf-statusline.js';
  const updateCheckCommand = isGlobal
    ? buildHookCommand(targetDir, 'nf-check-update.js')
    : 'node ' + dirName + '/hooks/nf-check-update.js';

  // Enable experimental agents for Gemini CLI (required for custom sub-agents)
  if (isGemini) {
    if (!settings.experimental) {
      settings.experimental = {};
    }
    if (!settings.experimental.enableAgents) {
      settings.experimental.enableAgents = true;
      log(`  ${green}✓${reset} Enabled experimental agents`);
    }
  }

  // Gemini CLI only supports SessionStart and SessionEnd hook events.
  // All other events (UserPromptSubmit, Stop, PreToolUse, PostToolUse, etc.) cause
  // "Invalid hook event name" warnings and are silently ignored.
  const GEMINI_SUPPORTED_EVENTS = new Set(['SessionStart', 'SessionEnd']);

  // Clean up invalid Gemini hook events from prior installs
  if (isGemini && settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      if (!GEMINI_SUPPORTED_EVENTS.has(event)) {
        delete settings.hooks[event];
        log(`  ${green}!${reset} Removed unsupported Gemini hook event: ${event}`);
      }
    }
  }

  if (isGemini) {
    log(`  ${cyan}i${reset} Gemini CLI: only registering SessionStart + SessionEnd hooks (other events unsupported)`);
  }

  // Configure SessionStart hook for update checking (skip for opencode)
  if (!isOpencode) {
    if (!settings.hooks) {
      settings.hooks = {};
    }
    if (!settings.hooks.SessionStart) {
      settings.hooks.SessionStart = [];
    }

    const hasNfUpdateHook = settings.hooks.SessionStart.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-check-update'))
    );

    if (!hasNfUpdateHook) {
      settings.hooks.SessionStart.push({
        hooks: [
          {
            type: 'command',
            command: updateCheckCommand
          }
        ]
      });
      log(`  ${green}✓${reset} Configured update check hook`);
    }

    // Register nForma session-start secret sync hook
    const hasNfSessionStartHook = settings.hooks.SessionStart.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-session-start'))
    );
    if (!hasNfSessionStartHook) {
      settings.hooks.SessionStart.push({
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(targetDir, 'nf-session-start.js')
          }
        ]
      });
      log(`  ${green}✓${reset} Configured nForma secret sync hook (SessionStart)`);
    }

    // Register nForma slot-health probe (populates ~/.claude/nf/slot-health.json
    // for the statusline's quorum slots line). Probe runs in parallel and finishes
    // in ~400ms for a typical 5-7 slot setup; capped at 15s.
    const hasSlotHealthProbeHook = settings.hooks.SessionStart.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-slot-health-probe'))
    );
    if (!hasSlotHealthProbeHook) {
      settings.hooks.SessionStart.push({
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(targetDir, 'nf-slot-health-probe.js'),
            timeout: 15
          }
        ]
      });
      log(`  ${green}✓${reset} Configured nForma slot-health probe (SessionStart)`);
    }

    // INST-05: Warn (yellow) if quorum MCP servers are absent — runs every install
    warnMissingMcpServers();

    // ── MIGRATION: remove old nf-* hook entries ─────────────────────────
    // Old installs registered hooks as nf-prompt.js, nf-stop.js, nf-circuit-breaker.js.
    // Remove them so the nf-* replacements below can register cleanly.
    // These map an event to OLD/renamed hook names whose stale registrations must
    // be stripped. The matching CURRENT hooks (nf-prompt, nf-stop, …) are
    // re-registered AFTER this migration, so removing them here is harmless.
    // nf-session-start is the EXCEPTION: it is registered ABOVE (before this
    // migration) and never re-added after, so listing it here removed the live
    // hook on every install — silently disabling SessionStart (incl. the
    // post-compaction continuation injection). It is NOT an old name; do not list it.
    const OLD_HOOK_MAP = {
      UserPromptSubmit: 'nf-prompt',
      Stop: 'nf-stop',
      PreToolUse: 'nf-circuit-breaker',
      PostToolUse: ['nf-spec-regen', 'nf-context-monitor', 'nf-context-monitor'],
      SessionStart: ['nf-check-update'],
    };
    for (const [event, oldNames] of Object.entries(OLD_HOOK_MAP)) {
      if (settings.hooks[event]) {
        const names = Array.isArray(oldNames) ? oldNames : [oldNames];
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter(entry =>
          !(entry.hooks && entry.hooks.some(h =>
            h.command && names.some(n => h.command.includes(n))
          ))
        );
        if (settings.hooks[event].length < before) {
          log(`  ${green}✓${reset} Migrated old ${names.join(', ')} hook(s) → nf equivalent`);
        }
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
    }

    // ── Non-Session hooks: skip for Gemini (only supports SessionStart + SessionEnd) ──
    if (!isGemini) {

    // Register nForma UserPromptSubmit hook (quorum injection)
    // MUST be in settings.json — plugin hooks.json silently discards UserPromptSubmit output (GitHub #10225)
    if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
    const hasNfPromptHook = settings.hooks.UserPromptSubmit.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-prompt'))
    );
    if (!hasNfPromptHook) {
      settings.hooks.UserPromptSubmit.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-prompt.js') }]
      });
      log(`  ${green}✓${reset} Configured nForma quorum injection hook (UserPromptSubmit)`);
    }

    // Register nForma Stop hook (quorum gate — verifies quorum evidence before Claude delivers planning output)
    if (!settings.hooks.Stop) settings.hooks.Stop = [];
    const hasNfStopHook = settings.hooks.Stop.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-stop'))
    );
    if (!hasNfStopHook) {
      settings.hooks.Stop.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-stop.js'), timeout: 30 }]
      });
      log(`  ${green}✓${reset} Configured nForma quorum gate hook (Stop)`);
    }

    // INST-08: Register nForma circuit breaker hook (PreToolUse — Claude Code only)
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
    const hasCircuitBreakerHook = settings.hooks.PreToolUse.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-circuit-breaker'))
    );
    if (!hasCircuitBreakerHook) {
      settings.hooks.PreToolUse.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-circuit-breaker.js'), timeout: 10 }]
      });
      log(`  ${green}✓${reset} Configured nForma circuit breaker hook (PreToolUse)`);
    }

    // Register nForma destructive git guard hook (PreToolUse — warn on destructive git ops)
    const hasDestructiveGitGuardHook = settings.hooks.PreToolUse.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-destructive-git-guard'))
    );
    if (!hasDestructiveGitGuardHook) {
      settings.hooks.PreToolUse.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-destructive-git-guard.js'), timeout: 10 }]
      });
      log(`  ${green}✓${reset} Configured nForma destructive git guard hook (PreToolUse)`);
    }

    // Register nForma MCP dispatch guard hook (PreToolUse — warn on direct MCP calls)
    const hasMcpDispatchGuardHook = settings.hooks.PreToolUse.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-mcp-dispatch-guard'))
    );
    if (!hasMcpDispatchGuardHook) {
      settings.hooks.PreToolUse.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-mcp-dispatch-guard.js'), timeout: 10 }]
      });
      log(`  ${green}+${reset} Configured nForma MCP dispatch guard hook (PreToolUse)`);
    }

    // Register nForma scope guard hook (PreToolUse — warn on out-of-scope edits)
    const hasScopeGuardHook = settings.hooks.PreToolUse.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-scope-guard'))
    );
    if (!hasScopeGuardHook) {
      settings.hooks.PreToolUse.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-scope-guard.js'), timeout: 10 }]
      });
      log(`  ${green}+${reset} Configured nForma scope guard hook (PreToolUse)`);
    }

    // Register nForma node-eval guard hook (PreToolUse — rewrite node -e to heredoc for zsh safety)
    const hasNodeEvalGuardHook = settings.hooks.PreToolUse.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-node-eval-guard'))
    );
    if (!hasNodeEvalGuardHook) {
      settings.hooks.PreToolUse.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-node-eval-guard.js'), timeout: 10 }]
      });
      log(`  ${green}+${reset} Configured nForma node-eval guard hook (PreToolUse)`);
    }

    // Register nForma context monitor hook (PostToolUse — context window warnings)
    if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
    const hasContextMonitorHook = settings.hooks.PostToolUse.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-context-monitor'))
    );
    if (!hasContextMonitorHook) {
      settings.hooks.PostToolUse.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-context-monitor.js') }]
      });
      log(`  ${green}✓${reset} Configured nForma context monitor hook (PostToolUse)`);
    }

    // Register nForma spec-regen hook (PostToolUse — auto-regenerate specs on machine file write)
    if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
    const hasSpecRegenHook = settings.hooks.PostToolUse.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-spec-regen'))
    );
    if (!hasSpecRegenHook) {
      settings.hooks.PostToolUse.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-spec-regen.js') }]
      });
      log(`  ${green}✓${reset} Configured nForma spec-regen hook (PostToolUse)`);
    }

    // Register nForma post-edit format hook (PostToolUse — auto-format JS/TS after Edit)
    if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
    const hasPostEditFormatHook = settings.hooks.PostToolUse.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-post-edit-format'))
    );
    if (!hasPostEditFormatHook) {
      settings.hooks.PostToolUse.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-post-edit-format.js') }]
      });
      log(`  ${green}✓${reset} Configured nForma post-edit format hook (PostToolUse)`);
    }

    // Register nForma console guard hook (Stop — warn about leftover console.log)
    if (!settings.hooks.Stop) settings.hooks.Stop = [];
    const hasConsoleGuardHook = settings.hooks.Stop.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-console-guard'))
    );
    if (!hasConsoleGuardHook) {
      settings.hooks.Stop.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-console-guard.js') }]
      });
      log(`  ${green}✓${reset} Configured nForma console guard hook (Stop)`);
    }

    // Register nForma PreCompact hook (phase state injection at compaction time)
    if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
    const hasPreCompactHook = settings.hooks.PreCompact.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-precompact'))
    );
    if (!hasPreCompactHook) {
      settings.hooks.PreCompact.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-precompact.js') }]
      });
      log(`  ${green}✓${reset} Configured nForma PreCompact hook (phase state injection)`);
    }

    // Register nForma token collector hook (SubagentStop — logs per-slot token usage)
    if (!settings.hooks.SubagentStop) settings.hooks.SubagentStop = [];
    const hasTokenCollectorHook = settings.hooks.SubagentStop.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-token-collector'))
    );
    if (!hasTokenCollectorHook) {
      settings.hooks.SubagentStop.push({
        matcher: 'nf-quorum-slot-worker',
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-token-collector.js'), async: true }]
      });
      log(`  ${green}✓${reset} Configured nForma token collector hook (SubagentStop)`);
    }

    // Register nForma slot correlator hook (SubagentStart — writes agent_id correlation file)
    if (!settings.hooks.SubagentStart) settings.hooks.SubagentStart = [];
    const hasSlotCorrelatorHook = settings.hooks.SubagentStart.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-slot-correlator'))
    );
    if (!hasSlotCorrelatorHook) {
      settings.hooks.SubagentStart.push({
        matcher: 'nf-quorum-slot-worker',
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-slot-correlator.js'), async: true }]
      });
      log(`  ${green}✓${reset} Configured nForma slot correlator hook (SubagentStart)`);
    }

    } // end if (!isGemini) — non-Session hooks

    // Register nForma session-end hook (SessionEnd — learning extraction + skill candidates)
    if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];
    const hasSessionEndHook = settings.hooks.SessionEnd.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('nf-session-end'))
    );
    if (!hasSessionEndHook) {
      settings.hooks.SessionEnd.push({
        hooks: [{ type: 'command', command: buildHookCommand(targetDir, 'nf-session-end.js') }]
      });
      log(`  ${green}✓${reset} Configured nForma session-end hook (SessionEnd)`);
    }

    // MULTI-03: ensureMcpSlotsFromProviders() MUST run before buildActiveSlots() because
    // buildActiveSlots() discovers slots from existing mcpServers keys in ~/.claude.json.
    // This ensures codex-2, gemini-2, and all other provider slots have MCP entries before quorum_active discovery.
    ensureMcpSlotsFromProviders();

    // Write nForma config — skip if exists unless --redetect-mcps flag set
    const nfConfigPath = path.join(targetDir, 'nf.json');

    // --redetect-mcps: delete existing config so fresh detection runs below
    if (hasRedetectMcps && fs.existsSync(nfConfigPath)) {
      fs.unlinkSync(nfConfigPath);
      log(`  ${cyan}◆${reset} Re-detecting MCP prefixes (--redetect-mcps)...`);
    }

    if (!fs.existsSync(nfConfigPath)) {
      // Build config with auto-detected MCP prefixes
      const detectedModels = buildRequiredModelsFromMcp();
      const nfConfig = {
        quorum_commands: [
          'plan-phase', 'new-project', 'new-milestone',
          'discuss-phase', 'verify-work', 'research-phase',
        ],
        fail_mode: 'open',
        required_models: detectedModels,
        quorum_active: buildActiveSlots(),   // COMP-04: populated from all discovered slots
        // Generated from detected prefixes — behavioral instructions match structural enforcement
        quorum_instructions: buildQuorumInstructions(detectedModels),
        // INST-09: Must match DEFAULT_CONFIG.circuit_breaker in hooks/config-loader.js
        circuit_breaker: {
          oscillation_depth: 3,
          commit_window: 6,
        },
      };

      fs.writeFileSync(nfConfigPath, JSON.stringify(nfConfig, null, 2) + '\n', 'utf8');
      log(`  ${green}✓${reset} Wrote nForma config with detected MCP prefixes (~/.claude/nf.json)`);
      log(`  ${green}✓${reset} Wrote quorum_active (${nfConfig.quorum_active.length} slots) to nf.json`);
    } else {
      // INST-06: print active config summary on reinstall
      try {
        const existingConfig = JSON.parse(fs.readFileSync(nfConfigPath, 'utf8'));
        const models = existingConfig.required_models || {};
        const summary = Object.entries(models)
          .map(([key, def]) => `${key} → ${def.tool_prefix || '(unset)'}`)
          .join(', ');
        log(`  ${dim}↳ ~/.claude/nf.json exists — active config: ${summary}${reset}`);
        log(`  ${dim}  (run with --redetect-mcps to refresh MCP prefix detection)${reset}`);

        // INST-10: Add missing circuit_breaker block or missing sub-keys without touching existing user values
        if (!existingConfig.circuit_breaker) {
          existingConfig.circuit_breaker = { oscillation_depth: 3, commit_window: 6 };
          fs.writeFileSync(nfConfigPath, JSON.stringify(existingConfig, null, 2) + '\n', 'utf8');
          log(`  ${green}✓${reset} Added circuit_breaker config block to nf.json`);
        } else {
          // Backfill individual missing sub-keys without touching values the user has set
          let subKeyAdded = false;
          if (existingConfig.circuit_breaker.oscillation_depth === undefined) {
            existingConfig.circuit_breaker.oscillation_depth = 3;
            subKeyAdded = true;
          }
          if (existingConfig.circuit_breaker.commit_window === undefined) {
            existingConfig.circuit_breaker.commit_window = 6;
            subKeyAdded = true;
          }
          if (subKeyAdded) {
            fs.writeFileSync(nfConfigPath, JSON.stringify(existingConfig, null, 2) + '\n', 'utf8');
            log(`  ${green}✓${reset} Added missing circuit_breaker sub-keys to nf.json`);
          }
        }

        // COMP-04: Backfill quorum_active if absent or empty (same pattern as circuit_breaker backfill)
        if (!existingConfig.quorum_active || existingConfig.quorum_active.length === 0) {
          const discoveredSlots = buildActiveSlots();
          if (discoveredSlots.length > 0) {
            existingConfig.quorum_active = discoveredSlots;
            fs.writeFileSync(nfConfigPath, JSON.stringify(existingConfig, null, 2) + '\n', 'utf8');
            log(`  ${green}✓${reset} Backfilled quorum_active (${discoveredSlots.length} slots) in nf.json`);
          }
        }

        // MULTI-03: Incremental quorum_active update — append new slots discovered since last install
        // Only runs if quorum_active is already set (non-empty); new slots are appended, existing preserved
        if (existingConfig.quorum_active && existingConfig.quorum_active.length > 0) {
          const { addSlotToQuorumActive } = require('./migrate-to-slots.cjs');
          const allCurrentSlots = buildActiveSlots();
          const newSlots = allCurrentSlots.filter(s => !existingConfig.quorum_active.includes(s));
          for (const newSlot of newSlots) {
            const result = addSlotToQuorumActive(newSlot, nfConfigPath);
            if (result.added) {
              log(`  ${green}✓${reset} Added new slot to quorum_active: ${newSlot}`);
              existingConfig.quorum_active.push(newSlot); // keep in-memory copy consistent
            }
          }
        }
        // If quorum_active is already set and non-empty: do NOT overwrite (user config preserved)
      } catch {
        log(`  ${dim}↳ ~/.claude/nf.json already exists — skipping (user config preserved)${reset}`);
      }
    }
  }

  // Write file manifest for future modification detection
  writeManifest(targetDir);
  log(`  ${green}✓${reset} Wrote file manifest (${MANIFEST_NAME})`);

  // Report any backed-up local patches
  reportLocalPatches(targetDir);

  return { settingsPath, settings, statuslineCommand, runtime };
}

/**
 * Apply statusline config, then print completion message
 * @param {boolean} multiRuntime - If true, suppress per-runtime banner (compact summary printed by caller)
 */
function finishInstall(settingsPath, settings, statuslineCommand, shouldInstallStatusline, runtime = 'claude', isGlobal = true, multiRuntime = false) {
  const isOpencode = runtime === 'opencode';

  if (shouldInstallStatusline && !isOpencode) {
    settings.statusLine = {
      type: 'command',
      command: statuslineCommand
    };
    log(`  ${green}✓${reset} Configured statusline`);
  }

  // PRIO-01: Sort hooks by priority for deterministic execution order
  const nfConfig = (() => {
    try {
      const { loadConfig } = require('../hooks/config-loader');
      return loadConfig(process.cwd());
    } catch {
      return { hook_priorities: {} };
    }
  })();
  sortHooksByPriority(settings, nfConfig.hook_priorities);
  log(`  ${green}✓${reset} Sorted hooks by priority (safety-critical first)`);

  // Always write settings
  writeSettings(settingsPath, settings);

  // Configure OpenCode permissions
  if (isOpencode) {
    configureOpencodePermissions(isGlobal);
  }

  // In multi-runtime mode, skip per-runtime banner (caller prints compact summary)
  if (multiRuntime) return;

  let program = 'Claude Code';
  if (runtime === 'opencode') program = 'OpenCode';
  if (runtime === 'gemini') program = 'Gemini';
  if (runtime === 'kilo') program = 'Kilo';
  if (runtime === 'cursor') program = 'Cursor';
  if (runtime === 'windsurf') program = 'Windsurf';
  if (runtime === 'codex') program = 'Codex';
  if (runtime === 'copilot') program = 'GitHub Copilot';
  if (runtime === 'antigravity') program = 'Antigravity';
  if (runtime === 'augment') program = 'Augment';
  if (runtime === 'trae') program = 'Trae';
  if (runtime === 'cline') program = 'Cline';

  const command = isOpencode ? '/nf-help' : '/nf:help';

  let nudge = '';
  if (runtime === 'claude' && !hasClaudeMcpAgents()) {
    nudge = `\n  ${yellow}⚠${reset} No quorum agents configured.\n    Run ${cyan}/nf:mcp-setup${reset} in Claude Code to set up your agents.\n`;
  }

  console.log(`
  ${green}Done!${reset} Launch ${program} and run ${cyan}${command}${reset}.
${nudge}
  ${dim}TUI dashboard:${reset} ${cyan}npx @nforma.ai/nforma tui${reset}
  ${dim}Or install globally:${reset} ${cyan}npm install -g @nforma.ai/nforma${reset} → then run ${cyan}nforma${reset}

  ${cyan}Join the community:${reset} https://discord.gg/M8SevJEuZG
`);

  // Best-effort formal tools — always runs after success banner, never blocks main install
  if (!hasUninstall && !hasFormal) {
    const { spawnSync: _formalSpawn } = require('child_process');
    const formalScript = path.join(__dirname, 'install-formal-tools.cjs');
    if (fs.existsSync(formalScript)) {
      console.log('  Formal verification tools:');
      _formalSpawn(process.execPath, [formalScript], { stdio: 'inherit' });
      // exit code ignored — best-effort
    }

  }
}

/**
 * Uninstall formal verification tools from system-wide location.
 * Removes ~/.local/share/nf-formal/.
 */
function uninstallFormalTools() {
  const nfFormalHome = path.join(os.homedir(), '.local', 'share', 'nf-formal');
  console.log(`\n  ${cyan}Uninstalling formal verification tools${reset}\n`);

  // Remove ~/.local/share/nf-formal/
  if (fs.existsSync(nfFormalHome)) {
    const tools = [];
    try {
      if (fs.existsSync(path.join(nfFormalHome, 'tla', 'tla2tools.jar'))) tools.push('TLA+');
      if (fs.existsSync(path.join(nfFormalHome, 'alloy', 'org.alloytools.alloy.dist.jar'))) tools.push('Alloy');
    } catch (_) {}

    fs.rmSync(nfFormalHome, { recursive: true, force: true });
    console.log(`  ${green}\u2713${reset} Removed ${nfFormalHome}` + (tools.length ? ` (${tools.join(', ')})` : ''));
  } else {
    console.log(`  ${dim}No formal tools found at ${nfFormalHome}${reset}`);
  }

  // Also clean legacy project-local copies if they exist
  const legacyPaths = [
    path.join(process.cwd(), '.planning', 'formal', 'tla', 'tla2tools.jar'),
    path.join(process.cwd(), '.planning', 'formal', 'alloy', 'org.alloytools.alloy.dist.jar'),
  ];
  let legacyCleaned = 0;
  for (const p of legacyPaths) {
    try {
      if (fs.existsSync(p)) {
        if (fs.statSync(p).isDirectory()) {
          fs.rmSync(p, { recursive: true, force: true });
        } else {
          fs.unlinkSync(p);
        }
        legacyCleaned++;
      }
    } catch (_) {}
  }
  if (legacyCleaned > 0) {
    console.log(`  ${green}\u2713${reset} Cleaned ${legacyCleaned} legacy project-local copies`);
  }

  console.log(`\n  ${dim}Reinstall with: node bin/install.js --formal${reset}\n`);
}

/**
 * Check if ~/.local/bin is on PATH and offer to add it to shell profile.
 * Only prompts if formal tools are installed and ~/.local/bin is missing from PATH.
 */
function ensureLocalBinOnPath() {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const nfFormalHome = path.join(os.homedir(), '.local', 'share', 'nf-formal');

  // Only relevant if formal tools are installed system-wide
  if (!fs.existsSync(nfFormalHome)) return;

  // Check if already on PATH
  const pathDirs = (process.env.PATH || '').split(':');
  const isOnPath = pathDirs.some(d => {
    try { return fs.realpathSync(d) === fs.realpathSync(localBin); } catch (_) { return d === localBin; }
  });
  if (isOnPath) return;

  // Detect shell profile
  const shell = process.env.SHELL || '';
  let profilePath;
  if (shell.includes('zsh')) {
    profilePath = path.join(os.homedir(), '.zshrc');
  } else if (shell.includes('bash')) {
    const bashProfile = path.join(os.homedir(), '.bash_profile');
    profilePath = (process.platform === 'darwin' && fs.existsSync(bashProfile))
      ? bashProfile
      : path.join(os.homedir(), '.bashrc');
  } else {
    console.log(`\n  ${yellow}\u26a0${reset} ~/.local/bin is not on your PATH`);
    console.log(`    Add this to your shell profile: ${cyan}export PATH="$HOME/.local/bin:$PATH"${reset}\n`);
    return;
  }

  const exportLine = 'export PATH="$HOME/.local/bin:$PATH"';

  // Check if already in profile (even if not active in current session)
  try {
    const profileContent = fs.readFileSync(profilePath, 'utf8');
    if (profileContent.includes('.local/bin')) return;
  } catch (_) { /* file doesn't exist yet */ }

  // Non-interactive mode: just print hint
  if (!process.stdin.isTTY) {
    console.log(`\n  ${yellow}\u26a0${reset} ~/.local/bin is not on your PATH`);
    console.log(`    Add to ${dim}${profilePath}${reset}: ${cyan}${exportLine}${reset}\n`);
    return;
  }

  // Interactive prompt
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n  ${yellow}\u26a0${reset} ~/.local/bin is not on your PATH`);
  console.log(`    Formal tools may be symlinked there.\n`);

  rl.question(`  Add ${cyan}${exportLine}${reset} to ${dim}${path.basename(profilePath)}${reset}? ${dim}[Y/n]${reset} `, (answer) => {
    rl.close();
    const choice = (answer.trim().toLowerCase() || 'y');
    if (choice === 'y' || choice === 'yes') {
      try {
        fs.appendFileSync(profilePath, `\n# Added by nForma installer \u2014 formal verification tools\n${exportLine}\n`);
        console.log(`  ${green}\u2713${reset} Added to ${profilePath}`);
        console.log(`    Run ${cyan}source ${profilePath}${reset} or restart your terminal to activate.\n`);
      } catch (err) {
        console.log(`  ${yellow}\u26a0${reset} Could not write to ${profilePath}: ${err.message}`);
        console.log(`    Add manually: ${cyan}${exportLine}${reset}\n`);
      }
    } else {
      console.log(`  ${dim}Skipped \u2014 add manually if needed: ${exportLine}${reset}\n`);
    }
  });
}

/**
 * Handle statusline configuration with optional prompt
 */
function handleStatusline(settings, isInteractive, callback) {
  const hasExisting = settings.statusLine != null;

  if (!hasExisting) {
    callback(true);
    return;
  }

  if (forceStatusline) {
    callback(true);
    return;
  }

  if (!isInteractive) {
    // Only overwrite if current statusline is an nForma/NF one (or unrecognized legacy)
    // Respect third-party statuslines (e.g. cship) — don't silently replace them
    const existingCmd = settings.statusLine.command || settings.statusLine.url || '';
    const isNfOwned = existingCmd.includes('nf-statusline') ||
                      existingCmd.includes('nf-statusline') ||
                      existingCmd.includes('nf-statusline') ||
                      existingCmd.includes('statusline.js');
    callback(isNfOwned);
    return;
  }

  const existingCmd = settings.statusLine.command || settings.statusLine.url || '(custom)';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log(`
  ${yellow}⚠${reset} Existing statusline detected\n
  Your current statusline:
    ${dim}command: ${existingCmd}${reset}

  nForma includes a statusline showing:
    • Model name
    • Current task (from todo list)
    • Context window usage (color-coded)

  ${cyan}1${reset}) Replace with nForma statusline
  ${cyan}2${reset}) Keep existing
`);

  rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
    rl.close();
    const choice = answer.trim() || '1';
    callback(choice === '1');
  });
}

/**
 * Prompt for runtime selection
 */
function promptRuntime(callback) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let answered = false;

  rl.on('close', () => {
    if (!answered) {
      answered = true;
      console.log(`\n  ${yellow}Installation cancelled${reset}\n`);
      process.exit(0);
    }
  });

  console.log(`  ${yellow}Which runtime(s) would you like to install for?${reset}\n\n  ${cyan}1${reset}) Claude Code ${dim}(~/.claude)${reset}
  ${cyan}2${reset}) OpenCode    ${dim}(~/.config/opencode)${reset} - open source, free models
  ${cyan}3${reset}) Gemini      ${dim}(~/.gemini)${reset}
  ${cyan}4${reset}) Kilo        ${dim}(~/.config/kilo)${reset}
  ${cyan}5${reset}) Cursor      ${dim}(~/.cursor)${reset}
  ${cyan}6${reset}) Windsurf    ${dim}(~/.windsurf)${reset}
  ${cyan}7${reset}) Codex       ${dim}(~/.codex)${reset}
  ${cyan}8${reset}) Copilot     ${dim}(~/.copilot)${reset}
  ${cyan}9${reset}) Antigravity ${dim}(~/.antigravity)${reset}
  ${cyan}10${reset}) Augment     ${dim}(~/.augment)${reset}
  ${cyan}11${reset}) Trae        ${dim}(~/.trae)${reset}
  ${cyan}12${reset}) Cline       ${dim}(~/.cline)${reset}
  ${cyan}13${reset}) All
  `);

  rl.question(`  Choice ${dim}[13]${reset}: `, (answer) => {
    answered = true;
    rl.close();
    const choice = answer.trim() || '13';
    if (choice === '13') {
      callback(ALL_RUNTIMES);
    } else if (choice === '12') {
      callback(['cline']);
    } else if (choice === '11') {
      callback(['trae']);
    } else if (choice === '10') {
      callback(['augment']);
    } else if (choice === '9') {
      callback(['antigravity']);
    } else if (choice === '8') {
      callback(['copilot']);
    } else if (choice === '7') {
      callback(['codex']);
    } else if (choice === '6') {
      callback(['windsurf']);
    } else if (choice === '5') {
      callback(['cursor']);
    } else if (choice === '4') {
      callback(['kilo']);
    } else if (choice === '3') {
      callback(['gemini']);
    } else if (choice === '2') {
      callback(['opencode']);
    } else {
      callback(['claude']);
    }
  });
}

/**
 * Interactive provider selection: detect CLIs, prompt user to enable external providers.
 * Chains to callback when selection is complete.
 */
function promptProviders(callback) {
  const provs = providers;
  const classified = classifyProviders(provs);

  // Detect external CLIs from manifest
  const externalPrimary = classified.externalPrimary;
  const detected = detectExternalClis(externalPrimary);

  // Initialize confirmed CLIs array
  const confirmedClis = [];

  console.log(`\n  ${yellow}Quorum agent setup:${reset}`);
  console.log(`  Run /nf:mcp-setup after install to configure quorum slots (api-*, claude-*).\n`);

  // Print detection results
  for (const d of detected) {
    if (d.found) {
      console.log(`  ${green}\u2713${reset} ${d.name} \u2014 ${d.resolvedPath}`);
    } else {
      const hint = getInstallHint(d.mainTool);
      console.log(`  ${yellow}\u2717${reset} ${d.name} \u2014 not found${hint ? ` (${hint})` : ''}`);
    }
  }

  console.log('');

  const foundClis = detected.filter(d => d.found);

  // Check if we're in auto mode or explicit flags are present
  const autoMode = hasAllProviders || explicitFlagsPresent();

  if (foundClis.length === 0) {
    console.log(`  No external CLIs detected. Run /nf:mcp-setup to configure quorum agents.\n`);
    selectedProviderSlots = confirmedClis;
    callback();
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let answered = false;

  rl.on('close', () => {
    if (!answered) {
      answered = true;
      console.log(`\n  ${yellow}Installation cancelled${reset}\n`);
      process.exit(0);
    }
  });

  // Per-CLI confirmation (unless --auto or explicit flags used)
  if (!autoMode && foundClis.length > 0) {
    const foundNames = foundClis.map(d => d.name).join(', ');
    console.log(`  ${yellow}Enable detected CLIs as quorum agents?${reset}\n`);
    console.log(`  ${cyan}1${reset}) Yes, enable all detected (${foundNames})  ${dim}[default]${reset}`);
    console.log(`  ${cyan}2${reset}) Let me choose\n`);

    rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
      const choice = answer.trim() || '1';

      if (choice === '2') {
        // Per-CLI selection
        let idx = 0;
        function askNext() {
          if (idx >= foundClis.length) {
            // Dual-subscription prompt will follow
            promptDualSubscriptionOrContinue();
            return;
          }
          const cli = foundClis[idx];
          rl.question(`  Register ${cli.name}? [Y/n]: `, (ans) => {
            const a = ans.trim().toLowerCase();
            if (a === '' || a === 'y' || a === 'yes') {
              confirmedClis.push(cli.name);
            }
            idx++;
            askNext();
          });
        }
        askNext();
      } else {
        // Choice 1: enable all detected
        for (const cli of foundClis) {
          confirmedClis.push(cli.name);
        }
        selectedProviderSlots = confirmedClis;
        callback();
      }
    });
  } else if (autoMode && foundClis.length > 0) {
    // Auto mode - auto-enable all found CLIs
    for (const cli of foundClis) {
      confirmedClis.push(cli.name);
      console.log(`  ${cyan}Auto-enabled${reset} ${cli.name} (--${cli.mainTool} or --all-providers)`);
    }
    // Skip dual-subscription prompt in auto mode
    selectedProviderSlots = confirmedClis;
    callback();
  } else {
    // No CLIs found
    selectedProviderSlots = confirmedClis;
    callback();
  }

  function promptDualSubscriptionOrContinue() {
    if (!process.stdin.isTTY || confirmedClis.length === 0) {
      selectedProviderSlots = confirmedClis;
      callback();
      return;
    }

    const rl2 = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    let answered = false;

    rl2.on('close', () => {
      if (!answered) {
        answered = true;
        console.log(`\n  ${yellow}Installation cancelled${reset}\n`);
        process.exit(0);
      }
    });

    if (confirmedClis.length === 0) {
      console.log(`  No external CLIs detected. Run /nf:mcp-setup to configure quorum agents.\n`);
      selectedProviderSlots = confirmedClis;
      rl2.close();
      callback();
      return;
    }

    const foundNames = confirmedClis.join(', ');
    console.log(`  ${yellow}Enable detected CLIs as quorum agents?${reset}\n`);
    console.log(`  ${cyan}1${reset}) Yes, enable all detected (${foundNames})  ${dim}[default]${reset}`);
    console.log(`  ${cyan}2${reset}) Skip -- Claude slots only\n`);

    rl2.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
      const choice = answer.trim() || '1';

      if (choice === '2') {
        // Skip all external
        selectedProviderSlots = confirmedClis;
        rl2.close();
        callback();
      } else {
        // Choice 1: enable all confirmed
        selectedProviderSlots = confirmedClis;
        rl2.close();
        callback();
      }
    });
  }
}

/**
 * For each dual-subscription slot whose parent is selected, prompt to enable it.
 */
function askDualSlots(rl, selected, dualSubscription, done) {
  const eligible = dualSubscription.filter(d => selected.includes(d.parent));
  let idx = 0;
  function askNext() {
    if (idx >= eligible.length) {
      done();
      return;
    }
    const ds = eligible[idx];
    rl.question(`  Enable ${ds.name} (dual-subscription slot)? [y/N]: `, (ans) => {
      const a = ans.trim().toLowerCase();
      if (a === 'y' || a === 'yes') {
        selected.push(ds.name);
      }
      idx++;
      askNext();
    });
  }
  askNext();
}

/**
 * Check if explicit flags are present that should skip interactive prompts
 */
function explicitFlagsPresent() {
  return hasCodex || hasGemini || hasOpencode || hasCopilot || hasAllProviders;
}

/**
 * Prompt for install location
 */
function promptLocation(runtimes) {
  if (!process.stdin.isTTY) {
    console.log(`  ${yellow}Non-interactive terminal detected, defaulting to global install${reset}\n`);
    installAllRuntimes(runtimes, true, false);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let answered = false;

  rl.on('close', () => {
    if (!answered) {
      answered = true;
      console.log(`\n  ${yellow}Installation cancelled${reset}\n`);
      process.exit(0);
    }
  });

  const pathExamples = runtimes.map(r => {
    const globalPath = getGlobalDir(r, explicitConfigDir);
    return globalPath.replace(os.homedir(), '~');
  }).join(', ');

  const localExamples = runtimes.map(r => `./${getDirName(r)}`).join(', ');

  console.log(`  ${yellow}Where would you like to install?${reset}\n\n  ${cyan}1${reset}) Global ${dim}(${pathExamples})${reset} - available in all projects
  ${cyan}2${reset}) Local  ${dim}(${localExamples})${reset} - this project only
`);

  rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
    answered = true;
    rl.close();
    const choice = answer.trim() || '1';
    const isGlobal = choice !== '2';
    installAllRuntimes(runtimes, isGlobal, true);
  });
}

/**
 * Runtime label map for display
 */
const RUNTIME_LABELS = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  kilo: 'Kilo',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  antigravity: 'Antigravity',
  augment: 'Augment',
  trae: 'Trae',
  cline: 'Cline',
};

/**
 * Print compact multi-runtime summary (one banner instead of twelve)
 */
function printMultiRuntimeSummary(runtimes, isGlobal) {
  const runtimeNames = runtimes.map(r => RUNTIME_LABELS[r] || r);
  const nudge = runtimes.includes('claude') && !hasClaudeMcpAgents()
    ? `\n  ${yellow}⚠${reset} No quorum agents configured.\n    Run ${cyan}/nf:mcp-setup${reset} in Claude Code to set up your agents.\n`
    : '';

  console.log(`
  ${green}Done!${reset} Installed for ${cyan}${runtimeNames.length}${reset} runtime${runtimeNames.length > 1 ? 's' : ''}:
  ${runtimeNames.map(n => `${green}✓${reset} ${n}`).join('\n  ')}
${nudge}
  Run ${cyan}/nf:help${reset} (or ${cyan}/nf-help${reset} in OpenCode) to get started.

  ${dim}TUI dashboard:${reset} ${cyan}npx @nforma.ai/nforma tui${reset}
  ${dim}Or install globally:${reset} ${cyan}npm install -g @nforma.ai/nforma${reset} → then run ${cyan}nforma${reset}

  ${cyan}Join the community:${reset} https://discord.gg/M8SevJEuZG
`);

  // Best-effort formal tools — always runs after success banner, never blocks main install
  if (!hasUninstall && !hasFormal) {
    const { spawnSync: _formalSpawn } = require('child_process');
    const formalScript = path.join(__dirname, 'install-formal-tools.cjs');
    if (fs.existsSync(formalScript)) {
      console.log('  Formal verification tools:');
      _formalSpawn(process.execPath, [formalScript], { stdio: 'inherit' });
    }
  }
}

/**
 * Install NF for all selected runtimes
 */
function installAllRuntimes(runtimes, isGlobal, isInteractive) {
  const results = [];
  const isMulti = runtimes.length > 1;

  for (const runtime of runtimes) {
    const result = install(isGlobal, runtime);
    results.push(result);
  }

  // Handle statusline for Claude & Gemini (OpenCode uses themes)
  const claudeResult = results.find(r => r.runtime === 'claude');
  const geminiResult = results.find(r => r.runtime === 'gemini');
  const opencodeResult = results.find(r => r.runtime === 'opencode');

  if (results.length === 1) {
    // Single runtime install — full banner
    const result = results[0];
    const runtime = result.runtime;
    const shouldInstallStatusline = (runtime === 'claude' || runtime === 'gemini') && !hasUninstall;
    finishInstall(result.settingsPath, result.settings, result.statuslineCommand, shouldInstallStatusline, runtime, isGlobal, false);
  } else {
    // Multi-runtime install — finalize each runtime silently, then print one summary
    const finishAll = (shouldInstallStatusline) => {
      if (claudeResult) {
        finishInstall(claudeResult.settingsPath, claudeResult.settings, claudeResult.statuslineCommand, shouldInstallStatusline, 'claude', isGlobal, true);
      }
      if (geminiResult) {
        finishInstall(geminiResult.settingsPath, geminiResult.settings, geminiResult.statuslineCommand, shouldInstallStatusline, 'gemini', isGlobal, true);
      }
      if (opencodeResult) {
        finishInstall(opencodeResult.settingsPath, opencodeResult.settings, opencodeResult.statuslineCommand, false, 'opencode', isGlobal, true);
      }
      for (const result of results) {
        if (result.runtime !== 'claude' && result.runtime !== 'gemini' && result.runtime !== 'opencode') {
          finishInstall(result.settingsPath, result.settings, result.statuslineCommand, false, result.runtime, isGlobal, true);
        }
      }
      // Print compact summary
      printMultiRuntimeSummary(runtimes, isGlobal);
    };

    if (claudeResult || geminiResult) {
      const primaryResult = claudeResult || geminiResult;
      handleStatusline(primaryResult.settings, isInteractive, finishAll);
    } else {
      finishAll(false);
    }
  }
}

// install.js is require-safe: the entire main-execution block below runs ONLY when this file
// is invoked directly (node bin/install.js). When required as a library (tests, tooling) the
// block is skipped and only the module.exports at the bottom are reached — requiring this file
// never triggers a real global install.
if (require.main === module) {

// RECV-01: --reset-breaker clears project-relative circuit breaker state and exits before any install logic
if (hasResetBreaker) {
  const { spawnSync } = require('child_process');
  const gitResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
  });
  const projectRoot = (gitResult.status === 0 && !gitResult.error)
    ? gitResult.stdout.trim()
    : process.cwd();
  const stateFile = path.join(projectRoot, '.claude', 'circuit-breaker-state.json');
  if (fs.existsSync(stateFile)) {
    fs.rmSync(stateFile);
    console.log(`  ${green}✓${reset} Circuit breaker state cleared. Claude can resume Bash execution.`);
    console.log(`    Removed: ${stateFile.replace(os.homedir(), '~')}`);
  } else {
    console.log(`  ${dim}No active circuit breaker state found at ${stateFile.replace(os.homedir(), '~')}${reset}`);
  }
  // Stamp manualResetAt on all active oscillation-log.json entries
  const oscLogFile = path.join(projectRoot, '.planning', 'oscillation-log.json');
  if (fs.existsSync(oscLogFile)) {
    try {
      const oscLog = JSON.parse(fs.readFileSync(oscLogFile, 'utf8'));
      const now = new Date().toISOString();
      let touched = 0;
      for (const key of Object.keys(oscLog)) {
        if (!oscLog[key].resolvedAt) {
          oscLog[key].manualResetAt = now;
          touched++;
        }
      }
      fs.writeFileSync(oscLogFile, JSON.stringify(oscLog, null, 2), 'utf8');
      if (touched > 0) {
        console.log(`  ${green}✓${reset} Stamped manualResetAt on ${touched} active oscillation log entr${touched === 1 ? 'y' : 'ies'}.`);
      }
    } catch (e) {
      console.log(`  ${dim}Could not update oscillation log: ${e.message}${reset}`);
    }
  }
  process.exit(0);
}

// DISABLE-01: --disable-breaker pauses circuit breaker enforcement without resetting detection
if (hasDisableBreaker) {
  const { spawnSync } = require('child_process');
  const gitResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
  });
  const projectRoot = (gitResult.status === 0 && !gitResult.error)
    ? gitResult.stdout.trim()
    : process.cwd();
  const stateFile = path.join(projectRoot, '.claude', 'circuit-breaker-state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const existing = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : {};
  fs.writeFileSync(stateFile, JSON.stringify({ ...existing, disabled: true, active: false }, null, 2), 'utf8');
  console.log(`  ${yellow}⊘${reset} Circuit breaker ${yellow}disabled${reset}. Detection and enforcement paused.`);
  console.log(`    Run ${cyan}npx nforma --enable-breaker${reset} to resume.`);
  process.exit(0);
}

// DISABLE-02: --enable-breaker resumes circuit breaker enforcement
if (hasEnableBreaker) {
  const { spawnSync } = require('child_process');
  const gitResult = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
  });
  const projectRoot = (gitResult.status === 0 && !gitResult.error)
    ? gitResult.stdout.trim()
    : process.cwd();
  const stateFile = path.join(projectRoot, '.claude', 'circuit-breaker-state.json');
  if (fs.existsSync(stateFile)) {
    const existing = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...existing, disabled: false, active: false }, null, 2), 'utf8');
  }
  // If no state file, nothing to do — circuit breaker is already effectively enabled
  console.log(`  ${green}✓${reset} Circuit breaker ${green}enabled${reset}. Oscillation detection resumed.`);
  process.exit(0);
}

// SLOT-02: --migrate-slots renames mcpServers keys and patches nf.json tool_prefix values
if (hasMigrateSlots) {
  const { migrateClaudeJson, migrateNfJson } = require('./migrate-to-slots.cjs');
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  const nfJsonPath = path.join(os.homedir(), '.claude', 'nf.json');
  const dryRun = args.includes('--dry-run');
  const r1 = migrateClaudeJson(claudeJsonPath, dryRun);
  const r2 = migrateNfJson(nfJsonPath, dryRun);
  if (r1.changed === 0 && r2.changed === 0) {
    console.log(`  ${green}✓${reset} Already migrated — no changes needed`);
  } else {
    if (r1.changed > 0) {
      console.log(`  ${green}✓${reset} Migrated ${r1.changed} mcpServers entries:`);
      r1.renamed.forEach(r => console.log(`      ${r.from} → ${r.to}`));
    }
    if (r2.changed > 0) {
      console.log(`  ${green}✓${reset} Patched ${r2.changed} nf.json tool_prefix values`);
    }
  }
  process.exit(0);
}

if (hasFormal) {
  const { spawnSync } = require('child_process');
  const formalScript = path.join(__dirname, 'install-formal-tools.cjs');
  const result = spawnSync(process.execPath, [formalScript], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

if (hasUninstallFormal) {
  uninstallFormalTools();
  process.exit(0);
}

// RESCAN-01: --rescan re-detects installed CLIs and syncs missing MCP slots to ~/.claude.json
if (hasRescan) {
  console.log(`\n  ${cyan}Rescanning for CLI providers...${reset}\n`);
  const provs = providers;
  const classified = classifyProviders(provs);

  // Detect external CLIs from manifest
  const externalPrimary = classified.externalPrimary;
  const detected = detectExternalClis(externalPrimary);
  const foundNames = detected.filter(d => d.found).map(d => d.name);

  selectedProviderSlots = foundNames;

  if (selectedProviderSlots.length === 0) {
    console.log(`  ${yellow}No external CLIs detected. Install CLIs first, then run --rescan.${reset}\n`);
    process.exit(0);
  }

  // Print detection summary
  for (const d of detected) {
    if (d.found) {
      console.log(`  ${green}\u2713${reset} ${d.name} \u2014 ${d.resolvedPath}`);
    }
  }
  console.log('');

  // Sync missing slots to ~/.claude.json
  ensureMcpSlotsFromProviders();

  process.exit(0);
}

// Main logic
if (hasGlobal && hasLocal) {
  console.error(`  ${yellow}Cannot specify both --global and --local${reset}`);
  process.exit(1);
} else if (explicitConfigDir && hasLocal) {
  console.error(`  ${yellow}Cannot use --config-dir with --local${reset}`);
  process.exit(1);
} else if (hasUninstall) {
  if (!hasGlobal && !hasLocal) {
    console.error(`  ${yellow}--uninstall requires --global or --local${reset}`);
    process.exit(1);
  }
  const runtimes = selectedRuntimes.length > 0 ? selectedRuntimes : ALL_RUNTIMES;
  for (const runtime of runtimes) {
    uninstall(hasGlobal, runtime);
  }
} else if (selectedRuntimes.length > 0) {
  if (!hasGlobal && !hasLocal) {
    // Interactive with runtime flags — chain through provider selection
    if (!hasAllProviders && selectedRuntimes.includes('claude')) {
      promptProviders(() => { promptLocation(selectedRuntimes); });
    } else {
      promptLocation(selectedRuntimes);
    }
  } else {
    // Non-interactive flag-based path (e.g. --claude --global)
    if (!hasAllProviders && selectedRuntimes.includes('claude')) {
      const provs = providers;
      const classified = classifyProviders(provs);
      const detected = detectExternalClis(classified.externalPrimary);
      const foundNames = detected.filter(d => d.found).map(d => d.name);
      selectedProviderSlots = foundNames;
      if (foundNames.length > 0) {
        console.log(`  ${green}✓${reset} Auto-including detected CLIs: ${foundNames.join(', ')}`);
      }
    }
    installAllRuntimes(selectedRuntimes, hasGlobal, false);
  }
} else if (hasGlobal || hasLocal) {
  // Default to all runtimes if no runtime specified but location is
  if (!hasAllProviders) {
    const provs = providers;
    const classified = classifyProviders(provs);
    const detected = detectExternalClis(classified.externalPrimary);
    const foundNames = detected.filter(d => d.found).map(d => d.name);
    selectedProviderSlots = foundNames;
    if (foundNames.length > 0) {
      console.log(`  ${green}✓${reset} Auto-including detected CLIs: ${foundNames.join(', ')}`);
    }
  }
  installAllRuntimes(ALL_RUNTIMES, hasGlobal, false);
} else {
  // Interactive
  if (!process.stdin.isTTY) {
    console.log(`  ${yellow}Non-interactive terminal detected, defaulting to all runtimes global install${reset}\n`);
    if (!hasAllProviders) {
      const provs = providers;
      const classified = classifyProviders(provs);
      const detected = detectExternalClis(classified.externalPrimary);
      const foundNames = detected.filter(d => d.found).map(d => d.name);
      selectedProviderSlots = foundNames;
      if (foundNames.length > 0) {
        console.log(`  ${green}✓${reset} Auto-including detected CLIs: ${foundNames.join(', ')}`);
      }
    }
    installAllRuntimes(ALL_RUNTIMES, true, false);
  } else {
    promptRuntime((runtimes) => {
      if (!hasAllProviders && runtimes.includes('claude')) {
        promptProviders(() => { promptLocation(runtimes); });
      } else {
        promptLocation(runtimes);
      }
    });
  }
}

} // end: if (require.main === module) — main-execution guard for require-safety

// Export for testing. Reached whether run directly or required; the guard above ensures
// requiring this file exposes these helpers WITHOUT running the installer.
module.exports = { validateStructuralIntegrity, validateHookPaths, fileHash, generateManifest, saveLocalPatches, reportLocalPatches, PATCHES_DIR_NAME, MANIFEST_NAME, classifyProviders, detectExternalClis, shouldCopyToNfBin, isUnderInstallDir, synthesizeMcpEntry, installedUnifiedMcpPath, NF_BIN_RUNTIME_MJS };

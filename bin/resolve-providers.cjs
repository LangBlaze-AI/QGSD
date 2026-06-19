'use strict';

/**
 * resolve-providers.cjs — single source of truth for locating providers.json
 *
 * Historically ~14 call sites re-implemented this resolution inline, disagreeing
 * on order and on empty-file skipping. The divergence was the structural root of
 * the config-drift bug class (#150 #148 #162 #163 #165 #186) — which physical
 * copy loaded depended on cwd/__dirname. This module replaces every inline
 * resolver with ONE deterministic order.
 *
 * Resolution order (first match wins):
 *   1. UNIFIED_PROVIDERS_CONFIG env  — explicit override, written by install.js
 *                                      into every mcpServers env entry
 *   2. ~/.claude.json pointer        — dirname of the unified-mcp-server.mjs script
 *                                      referenced by an mcpServers entry
 *   3. __dirname/providers.json      — same dir as this module (nf-bin after
 *                                      install), accepted only if NON-EMPTY
 *   4. ~/.claude/nf-bin/providers.json   — installed canonical copy
 *   5. ~/.claude/nf/bin/providers.json   — legacy pre-migration path, NON-EMPTY only
 *
 * "Empty" means a parsed file whose `providers` array is missing or length 0.
 * The shipped repo source (bin/providers.json) is empty by design — it is
 * populated at install time — so __dirname and the legacy path must be skipped
 * when empty to avoid masking a populated downstream copy.
 *
 * The chosen path is logged to stderr (once per process unless quiet).
 *
 * Hermetic testing: set NF_CLAUDE_JSON to point at a fake ~/.claude.json and
 * HOME to a temp dir; the resolver reads both via these knobs so an isolated
 * resolution-order test asserts every entry point loads the SAME file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Path to ~/.claude.json, honoring the NF_CLAUDE_JSON test override. */
function claudeJsonPath() {
  return process.env.NF_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
}

/**
 * Read and parse a providers.json file.
 * @returns {{providers: any[]}|null} parsed object, or null on read/parse error.
 */
function readProvidersFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** True when a parsed providers.json has a non-empty providers array. */
function isNonEmpty(data) {
  return !!data && Array.isArray(data.providers) && data.providers.length > 0;
}

/**
 * Derive the providers.json path from a unified-mcp-server entry in ~/.claude.json.
 * Scans every mcpServers entry for an arg ending in unified-mcp-server.mjs and
 * returns <dirname>/providers.json for the first match.
 * @returns {string|null}
 */
function pointerFromClaudeJson() {
  const data = readProvidersFile(claudeJsonPath());
  if (!data || !data.mcpServers || typeof data.mcpServers !== 'object') return null;
  for (const server of Object.values(data.mcpServers)) {
    // Explicit UNIFIED_PROVIDERS_CONFIG in the server env wins.
    const envPath = server?.env?.UNIFIED_PROVIDERS_CONFIG;
    if (typeof envPath === 'string' && envPath) return envPath;
    const args = Array.isArray(server?.args) ? server.args : [];
    const serverScript = args.find(
      (a) => typeof a === 'string' && a.endsWith('unified-mcp-server.mjs')
    );
    if (serverScript) return path.join(path.dirname(serverScript), 'providers.json');
  }
  return null;
}

/**
 * Resolve the canonical providers.json path.
 *
 * @param {object} [options]
 * @param {string} [options.baseDir] - directory of the caller (its __dirname);
 *        used for the step-3 "same dir" candidate. Defaults to this module's dir.
 * @param {boolean} [options.quiet] - suppress the stderr log line.
 * @returns {{path: string, data: {providers: any[]}}|null}
 *          chosen path + parsed data, or null when no populated file is found.
 */
function resolveProvidersConfig(options = {}) {
  const baseDir = options.baseDir || __dirname;
  const quiet = !!options.quiet;

  // 1. Explicit env override (set by install.js into every mcpServers env).
  const explicit = process.env.UNIFIED_PROVIDERS_CONFIG;
  if (explicit) {
    const data = readProvidersFile(explicit);
    if (data) return logged({ path: explicit, data }, 'UNIFIED_PROVIDERS_CONFIG env', quiet);
  }

  // 2. Pointer derived from a unified-mcp-server entry in ~/.claude.json.
  const pointer = pointerFromClaudeJson();
  if (pointer) {
    const data = readProvidersFile(pointer);
    if (data) return logged({ path: pointer, data }, '~/.claude.json pointer', quiet);
  }

  // 3. __dirname/providers.json — accepted only if non-empty (repo source is empty).
  const sameDir = path.join(baseDir, 'providers.json');
  const sameDirData = readProvidersFile(sameDir);
  if (isNonEmpty(sameDirData)) {
    return logged({ path: sameDir, data: sameDirData }, '__dirname', quiet);
  }

  // 4. Installed canonical copy.
  const userPath = path.join(os.homedir(), '.claude', 'nf-bin', 'providers.json');
  const userData = readProvidersFile(userPath);
  if (userData) return logged({ path: userPath, data: userData }, '~/.claude/nf-bin', quiet);

  // 5. Legacy pre-migration path — accepted only if non-empty.
  const legacyPath = path.join(os.homedir(), '.claude', 'nf', 'bin', 'providers.json');
  const legacyData = readProvidersFile(legacyPath);
  if (isNonEmpty(legacyData)) {
    return logged({ path: legacyPath, data: legacyData }, 'legacy ~/.claude/nf/bin', quiet);
  }

  return null;
}

function logged(result, source, quiet) {
  if (!quiet) {
    try {
      process.stderr.write(`[resolve-providers] using ${result.path} (via ${source})\n`);
    } catch (_) { /* stderr unavailable — ignore */ }
  }
  return result;
}

/**
 * Convenience: resolve and return the providers array (or null when none found).
 * @param {object} [options] - same options as resolveProvidersConfig.
 * @returns {any[]|null}
 */
function loadProviders(options = {}) {
  const resolved = resolveProvidersConfig(options);
  if (!resolved) return null;
  const providers = resolved.data && resolved.data.providers;
  return Array.isArray(providers) ? providers : null;
}

module.exports = {
  resolveProvidersConfig,
  loadProviders,
  // exported for targeted testing
  _internal: { pointerFromClaudeJson, isNonEmpty, readProvidersFile, claudeJsonPath },
};

// ---------------------------------------------------------------------------
// Standalone CLI interface — prints the resolved path (or exits 1 if none).
// ---------------------------------------------------------------------------
if (require.main === module) {
  const resolved = resolveProvidersConfig({ quiet: true });
  if (!resolved) {
    process.stderr.write('[resolve-providers] no populated providers.json found\n');
    process.exit(1);
  }
  console.log(resolved.path);
}

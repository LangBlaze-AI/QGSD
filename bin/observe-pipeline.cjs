'use strict';

/**
 * observe-pipeline.cjs — Programmatic observe data-gathering pipeline
 *
 * Extracted from the /nf:observe skill so that both /nf:observe (interactive)
 * and /nf:solve-diagnose (programmatic, Step 0d) share a single source of truth.
 *
 * This module registers ALL handlers, loads config, injects the internal source,
 * dispatches all sources in parallel, and writes results to the debt ledger.
 * It does NOT render output, prompt the user, or route to actions.
 *
 * Usage:
 *   const { refreshDebtLedger } = require('./observe-pipeline.cjs');
 *   const result = await refreshDebtLedger({ sourceFilter, sinceOverride, limitOverride });
 *   // result = { written, updated, errors, merged, linked, observations, results, sourceCount }
 */

const path = require('path');
const fs = require('fs');

/**
 * Portable bin path resolver — tries ~/.claude/nf-bin/ first, falls back to ./bin/
 */
function _nfBin(name) {
  const p = path.join(require('os').homedir(), '.claude/nf-bin', name);
  return fs.existsSync(p) ? p : path.join(__dirname, name);
}

/**
 * Register all known observe handlers with the registry.
 * Clears any previously registered handlers first (safe for repeated calls).
 *
 * @returns {{ registerHandler, dispatchAll, clearHandlers }} Registry exports
 */
function registerAllHandlers() {
  const registry = require(_nfBin('observe-registry.cjs'));
  const handlers = require(_nfBin('observe-handlers.cjs'));

  // Clear to avoid "already registered" errors on repeated calls
  registry.clearHandlers();

  registry.registerHandler('github', handlers.handleGitHub);
  registry.registerHandler('sentry', handlers.handleSentry);
  registry.registerHandler('sentry-feedback', handlers.handleSentryFeedback);
  registry.registerHandler('bash', handlers.handleBash);
  registry.registerHandler('internal', handlers.handleInternal);
  registry.registerHandler('upstream', handlers.handleUpstream);
  registry.registerHandler('deps', handlers.handleDeps);

  // Production drift handlers
  if (typeof handlers.handlePrometheus === 'function') {
    registry.registerHandler('prometheus', handlers.handlePrometheus);
  }
  if (typeof handlers.handleGrafana === 'function') {
    registry.registerHandler('grafana', handlers.handleGrafana);
  }
  if (typeof handlers.handleLogstash === 'function') {
    registry.registerHandler('logstash', handlers.handleLogstash);
  }

  return registry;
}

/**
 * Run the full observe data-gathering pipeline programmatically.
 * No rendering, no user prompts, no routing — pure data.
 *
 * @param {object} [opts] - Options
 * @param {string} [opts.sourceFilter] - Filter to one source type (e.g., "github")
 * @param {string} [opts.sinceOverride] - Time window override (e.g., "24h", "7d")
 * @param {number} [opts.limitOverride] - Max issues per source
 * @param {string} [opts.ledgerPath] - Custom debt.json path
 * @param {boolean} [opts.skipDebtWrite] - If true, skip writing to debt ledger
 * @returns {Promise<object>} { written, updated, errors, merged, linked, observations, results, sourceCount }
 */
async function refreshDebtLedger(opts = {}) {
  if (!opts || typeof opts !== 'object') opts = {};
  const { loadObserveConfig } = require(_nfBin('observe-config.cjs'));
  const { writeObservationsToDebt } = require(_nfBin('observe-debt-writer.cjs'));

  // Step 1: Load config
  const config = loadObserveConfig();
  if (config.error) {
    return {
      written: 0, updated: 0, errors: 0, merged: 0, linked: 0,
      observations: [], results: [], sourceCount: 0,
      configError: config.error
    };
  }

  let sources = config.sources || [];

  // Step 2: Apply source filter
  if (opts.sourceFilter) {
    sources = sources.filter(s => s.type === opts.sourceFilter);
  }

  // Step 3: Inject internal source unconditionally
  if (!sources.find(s => s.type === 'internal')) {
    if (!opts.sourceFilter || opts.sourceFilter === 'internal') {
      sources.push({ type: 'internal', label: 'Internal Work', issue_type: 'issue' });
    }
  }

  if (sources.length === 0) {
    return {
      written: 0, updated: 0, errors: 0, merged: 0, linked: 0,
      observations: [], results: [], sourceCount: 0
    };
  }

  // Step 4: Register handlers and dispatch
  const registry = registerAllHandlers();
  const dispatchOpts = {};
  if (opts.sinceOverride) dispatchOpts.sinceOverride = opts.sinceOverride;
  if (opts.limitOverride) dispatchOpts.limitOverride = opts.limitOverride;

  const results = await registry.dispatchAll(sources, dispatchOpts);

  // Step 5: Collect observations from successful results
  const observations = results
    .filter(r => r.status === 'ok')
    .flatMap(r => r.issues || []);

  // Step 6: Write to debt ledger (unless skipped)
  let debtResult = { written: 0, updated: 0, errors: 0, merged: 0, linked: 0 };
  if (!opts.skipDebtWrite && observations.length > 0) {
    debtResult = writeObservationsToDebt(observations, opts.ledgerPath);
  }

  return {
    ...debtResult,
    observations,
    results,
    sourceCount: sources.length
  };
}

module.exports = { refreshDebtLedger, registerAllHandlers, _nfBin };

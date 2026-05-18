#!/usr/bin/env node
'use strict';

/**
 * planning-paths.cjs — Centralized path resolver for .planning/ hierarchy.
 *
 * New layout (v0.27+):
 *   .planning/quorum/rounds/          quorum-rounds-session-*.jsonl
 *   .planning/quorum/correlations/    quorum-slot-corr-*.json
 *   .planning/telemetry/              conformance-events.jsonl, token-usage.jsonl
 *   .planning/milestones/             v*-MILESTONE-AUDIT.md, v*-INTEGRATION-*.{md,txt}
 *   .planning/archive/state-backups/  STATE.md.bak-*
 *   .planning/archive/designs/        dated docs, old roadmaps
 *
 * Legacy layout (pre-v0.27):
 *   All above files lived directly in .planning/
 *
 * API:
 *   resolve(root, type, params)             → canonical (new) path
 *   resolveWithFallback(root, type, params) → new path if exists, else legacy path
 *   legacy(root, type, params)              → legacy flat path
 *   needsMigration(root)                    → boolean
 */

const fs   = require('fs');
const path = require('path');

// ─── Path definitions ────────────────────────────────────────────────────────

const TYPES = {
  // Quorum runtime (high-volume ephemeral)
  'quorum-rounds': {
    canonical: (root, p) => path.join(root, '.planning', 'quorum', 'rounds', `quorum-rounds-${p.sessionId}.jsonl`),
    legacy:    (root, p) => path.join(root, '.planning', `quorum-rounds-${p.sessionId}.jsonl`),
  },
  'quorum-correlation': {
    canonical: (root, p) => path.join(root, '.planning', 'quorum', 'correlations', `quorum-slot-corr-${p.agentId}.json`),
    legacy:    (root, p) => path.join(root, '.planning', `quorum-slot-corr-${p.agentId}.json`),
  },

  // Quorum aggregate data
  'quorum-scoreboard': {
    canonical: (root) => path.join(root, '.planning', 'quorum', 'scoreboard.json'),
    legacy:    (root) => path.join(root, '.planning', 'quorum-scoreboard.json'),
  },
  'quorum-failures': {
    canonical: (root) => path.join(root, '.planning', 'quorum', 'failures.json'),
    legacy:    (root) => path.join(root, '.planning', 'quorum-failures.json'),
  },
  'quorum-debate': {
    canonical: (root, p) => path.join(root, '.planning', 'quorum', 'debates', p.filename),
    legacy:    (root, p) => path.join(root, '.planning', 'debates', p.filename),
  },
  'calibrated-deltas': {
    canonical: (root) => path.join(root, '.planning', 'quorum', 'calibrated-deltas.json'),
    legacy:    (root) => path.join(root, '.planning', 'calibrated-deltas.json'),
  },

  // Telemetry
  'conformance-events': {
    canonical: (root) => path.join(root, '.planning', 'telemetry', 'conformance-events.jsonl'),
    legacy:    (root) => path.join(root, '.planning', 'conformance-events.jsonl'),
  },
  'token-usage': {
    canonical: (root) => path.join(root, '.planning', 'telemetry', 'token-usage.jsonl'),
    legacy:    (root) => path.join(root, '.planning', 'token-usage.jsonl'),
  },
  'feature-events': {
    canonical: (root) => path.join(root, '.planning', 'telemetry', 'feature-events.jsonl'),
    legacy:    (root) => path.join(root, '.planning', 'feature-events.jsonl'),
  },

  // Milestone artifacts (loose ones at root → milestones/)
  'milestone-audit': {
    canonical: (root, p) => path.join(root, '.planning', 'milestones', `${p.version}-MILESTONE-AUDIT.md`),
    legacy:    (root, p) => path.join(root, '.planning', `${p.version}-MILESTONE-AUDIT.md`),
  },
  'integration-check': {
    canonical: (root, p) => path.join(root, '.planning', 'milestones', `${p.version}-INTEGRATION-CHECK.md`),
    legacy:    (root, p) => path.join(root, '.planning', `${p.version}-INTEGRATION-CHECK.md`),
  },
  'integration-summary': {
    canonical: (root, p) => path.join(root, '.planning', 'milestones', `${p.version}-INTEGRATION-SUMMARY.txt`),
    legacy:    (root, p) => path.join(root, '.planning', `${p.version}-INTEGRATION-SUMMARY.txt`),
  },
  'integration-key-files': {
    canonical: (root, p) => path.join(root, '.planning', 'milestones', `${p.version}-INTEGRATION-KEY-FILES.md`),
    legacy:    (root, p) => path.join(root, '.planning', `${p.version}-INTEGRATION-KEY-FILES.md`),
  },
  'integration-report': {
    canonical: (root, p) => path.join(root, '.planning', 'milestones', `${p.version}-INTEGRATION-REPORT.md`),
    legacy:    (root, p) => path.join(root, '.planning', `${p.version}-INTEGRATION-REPORT.md`),
  },

  // Quorum cache
  'quorum-cache': {
    canonical: (root) => path.join(root, '.planning', '.quorum-cache'),
    legacy:    (root) => path.join(root, '.planning', '.quorum-cache'),
  },

  // Memory persistence (MEMP-01/03/04)
  'memory-decisions': {
    canonical: (root) => path.join(root, '.planning', 'memory', 'decisions.jsonl'),
    legacy:    (root) => path.join(root, '.planning', 'memory', 'decisions.jsonl'),
  },
  'memory-errors': {
    canonical: (root) => path.join(root, '.planning', 'memory', 'errors.jsonl'),
    legacy:    (root) => path.join(root, '.planning', 'memory', 'errors.jsonl'),
  },
  'memory-quorum': {
    canonical: (root) => path.join(root, '.planning', 'memory', 'quorum-decisions.jsonl'),
    legacy:    (root) => path.join(root, '.planning', 'memory', 'quorum-decisions.jsonl'),
  },

  // State backups
  'state-backup': {
    canonical: (root, p) => path.join(root, '.planning', 'archive', 'state-backups', `STATE.md.bak-${p.timestamp}`),
    legacy:    (root, p) => path.join(root, '.planning', `STATE.md.bak-${p.timestamp}`),
  },
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the canonical (new) path for a given type.
 * Ensures parent directory exists.
 */
function resolve(root, type, params) {
  const def = TYPES[type];
  if (!def) throw new Error(`Unknown planning path type: ${type}`);
  const p = def.canonical(root, params || {});
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

/**
 * Returns the canonical path if the file exists there,
 * otherwise falls back to the legacy path.
 * Does NOT create directories — use for readers only.
 */
function resolveWithFallback(root, type, params) {
  const def = TYPES[type];
  if (!def) throw new Error(`Unknown planning path type: ${type}`);
  const canonical = def.canonical(root, params || {});
  if (fs.existsSync(canonical)) return canonical;
  const leg = def.legacy(root, params || {});
  if (fs.existsSync(leg)) return leg;
  // Neither exists — return canonical (caller will handle missing file)
  return canonical;
}

/**
 * Returns the legacy (flat) path.
 */
function legacy(root, type, params) {
  const def = TYPES[type];
  if (!def) throw new Error(`Unknown planning path type: ${type}`);
  return def.legacy(root, params || {});
}

/**
 * Detect if the .planning/ directory has legacy flat layout.
 * Returns true if any quorum-rounds-session or quorum-slot-corr files
 * exist at the root level.
 */
function needsMigration(root) {
  const planDir = path.join(root, '.planning');
  if (!fs.existsSync(planDir)) return false;
  try {
    const entries = fs.readdirSync(planDir);
    return entries.some(e =>
      e.startsWith('quorum-rounds-session-') ||
      e.startsWith('quorum-slot-corr-') ||
      e === 'conformance-events.jsonl' ||
      e === 'token-usage.jsonl' ||
      e === 'quorum-scoreboard.json' ||
      e === 'quorum-failures.json' ||
      e === 'debates' ||
      /^v[\d.]+-MILESTONE-AUDIT\.md$/.test(e) ||
      /^v[\d.]+-INTEGRATION-/.test(e) ||
      /^STATE\.md\.bak-/.test(e)
    );
  } catch (_) {
    return false;
  }
}

/**
 * Returns all known type names.
 */
function types() {
  return Object.keys(TYPES);
}

module.exports = { resolve, resolveWithFallback, legacy, needsMigration, types, TYPES };

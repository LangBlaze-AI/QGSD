'use strict';

/**
 * Pure data functions for requirements management.
 * No blessed dependency — all functions are testable in isolation.
 * Consumers: bin/nf.cjs (blessed TUI)
 *
 * Data sources (project-relative paths via process.cwd()):
 *   .planning/formal/requirements.json    — 210 requirements in frozen envelope
 *   .planning/formal/model-registry.json  — formal models with requirement links
 *   .planning/formal/check-results.ndjson — check results (NDJSON)
 */

const fs   = require('fs');
const path = require('path');
const { getRequirementIds } = require('./requirement-map.cjs');
const { PRINCIPLES, getCategoryPrinciple } = require('./principle-mapping.cjs');

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

function readRequirementsJson(basePath) {
  const p = path.join(basePath || process.cwd(), '.planning', 'formal', 'requirements.json');
  if (!fs.existsSync(p)) return { envelope: null, requirements: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const reqs = raw.requirements || [];
    const envelope = {
      aggregated_at: raw.aggregated_at || null,
      content_hash:  raw.content_hash  || null,
      frozen_at:     raw.frozen_at     || null,
    };
    return { envelope, requirements: reqs };
  } catch (_) {
    return { envelope: null, requirements: [] };
  }
}

function readModelRegistry(basePath) {
  const p = path.join(basePath || process.cwd(), '.planning', 'formal', 'model-registry.json');
  if (!fs.existsSync(p)) return { version: null, last_sync: null, models: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      version:   raw.version   || null,
      last_sync: raw.last_sync || null,
      models:    raw.models    || {},
    };
  } catch (_) {
    return { version: null, last_sync: null, models: {} };
  }
}

function readCheckResults(basePath) {
  const p = path.join(basePath || process.cwd(), '.planning', 'formal', 'check-results.ndjson');
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

function computeCoverage(requirements, registry, checkResults) {
  const total = requirements.length;

  // By status
  const byStatus = {};
  for (const r of requirements) {
    if (!r || typeof r !== 'object') continue;
    const s = r.status || 'Unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  // By category. Use hasOwnProperty + defineProperty so a category literally
  // named '__proto__'/'constructor' becomes an ordinary own data property
  // (shadowing the Object.prototype accessor) rather than mutating the global
  // prototype or being silently dropped.
  const byCategory = {};
  for (const r of requirements) {
    if (!r || typeof r !== 'object') continue;
    const c = r.category || 'Uncategorized';
    if (!Object.prototype.hasOwnProperty.call(byCategory, c)) {
      Object.defineProperty(byCategory, c, {
        value: { total: 0, complete: 0 },
        enumerable: true, writable: true, configurable: true,
      });
    }
    byCategory[c].total++;
    if (r.status === 'Complete') byCategory[c].complete++;
  }

  // Formal model coverage: which requirements have at least one formal model?
  const reqsWithModels = new Set();
  const models = (registry && registry.models) || {};
  for (const entry of Object.values(models)) {
    for (const reqId of (entry.requirements || [])) {
      reqsWithModels.add(reqId);
    }
  }
  // Also include requirements with direct formal_models field (SCHEMA-04)
  for (const r of requirements) {
    if (Array.isArray(r.formal_models) && r.formal_models.length > 0) {
      reqsWithModels.add(r.id);
    }
  }
  const withFormalModels = requirements.filter(r => reqsWithModels.has(r.id)).length;
  const totalModels = Object.keys(models).length;

  // Check results summary
  const checksByResult = {};
  for (const cr of (checkResults || [])) {
    const res = cr.result || 'unknown';
    checksByResult[res] = (checksByResult[res] || 0) + 1;
  }

  // Requirements with at least one check result (via requirement_ids or requirement-map)
  const reqsWithChecks = new Set();
  for (const cr of (checkResults || [])) {
    // Direct requirement_ids on the check result
    if (Array.isArray(cr.requirement_ids)) {
      for (const rid of cr.requirement_ids) reqsWithChecks.add(rid);
    }
    // Reverse lookup via requirement-map
    if (cr.check_id) {
      for (const rid of getRequirementIds(cr.check_id)) reqsWithChecks.add(rid);
    }
  }
  const withCheckResults = requirements.filter(r => reqsWithChecks.has(r.id)).length;

  return {
    total,
    byStatus,
    byCategory,
    withFormalModels,
    withCheckResults,
    totalModels,
    checksByResult,
  };
}

function buildTraceability(reqId, requirements, registry, checkResults) {
  const requirement = requirements.find(r => r.id === reqId);
  if (!requirement) return null;

  // Forward: find formal models that list this requirement
  const formalModels = [];
  const models = (registry && registry.models) || {};
  for (const [modelPath, entry] of Object.entries(models)) {
    if ((entry.requirements || []).includes(reqId)) {
      formalModels.push({
        path:        modelPath,
        description: entry.description || '',
        version:     entry.version || null,
      });
    }
  }
  // Also include models listed in requirement's own formal_models field (SCHEMA-04)
  if (Array.isArray(requirement.formal_models)) {
    for (const modelPath of requirement.formal_models) {
      // Deduplicate: skip if already found via registry
      if (!formalModels.some(fm => fm.path === modelPath)) {
        // Try to get description from registry if available
        const registryEntry = models[modelPath];
        formalModels.push({
          path:        modelPath,
          description: (registryEntry && registryEntry.description) || '',
          version:     (registryEntry && registryEntry.version) || null,
        });
      }
    }
  }

  // Reverse: find check results linked to this requirement
  const matchingChecks = [];
  const unmappedCheckIds = [];
  for (const cr of (checkResults || [])) {
    // Direct match via requirement_ids field
    const directIds = Array.isArray(cr.requirement_ids) ? cr.requirement_ids : [];
    // Reverse lookup via requirement-map
    const mapIds = cr.check_id ? getRequirementIds(cr.check_id) : [];
    const allIds = new Set([...directIds, ...mapIds]);

    if (allIds.has(reqId)) {
      matchingChecks.push(cr);
    }
  }

  // Find check_ids from requirement-map that link to this req but have no results
  const { CHECK_ID_TO_REQUIREMENTS } = require('./requirement-map.cjs');
  for (const [checkId, reqIds] of Object.entries(CHECK_ID_TO_REQUIREMENTS)) {
    if (reqIds.includes(reqId)) {
      const hasResult = (checkResults || []).some(cr => cr.check_id === checkId);
      if (!hasResult) unmappedCheckIds.push(checkId);
    }
  }

  return {
    requirement,
    formalModels,
    checkResults: matchingChecks,
    unmappedCheckIds,
  };
}

function filterRequirements(requirements, filters) {
  filters = filters || {};
  let result = requirements;

  if (filters.category) {
    result = result.filter(r => (r.category || 'Uncategorized') === filters.category);
  }
  if (filters.status) {
    result = result.filter(r => (r.status || 'Unknown') === filters.status);
  }
  if (filters.search) {
    const s = filters.search.toLowerCase();
    result = result.filter(r =>
      (r.id || '').toLowerCase().includes(s) ||
      (r.text || '').toLowerCase().includes(s)
    );
  }

  return result;
}

function getUniqueCategories(requirements) {
  const cats = new Set();
  for (const r of requirements) {
    if (!r || typeof r !== 'object') continue;
    cats.add(r.category || 'Uncategorized');
  }
  return [...cats].sort();
}

// ---------------------------------------------------------------------------
// Requirement creation
// ---------------------------------------------------------------------------

/**
 * Generate the next sequential requirement ID for a given prefix.
 * Scans existing requirements for IDs matching `PREFIX-NN` and returns `PREFIX-(max+1)`.
 * @param {string} prefix  e.g. 'SOLVE'
 * @param {string} [basePath]  project root (defaults to cwd)
 * @returns {string} e.g. 'SOLVE-16'
 */
function nextRequirementId(prefix, basePath) {
  const { requirements } = readRequirementsJson(basePath);
  const re = new RegExp('^' + prefix + '-(\\d+)$');
  let max = 0;
  for (const r of requirements) {
    const m = (r.id || '').match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  const next = max + 1;
  return prefix + '-' + String(next).padStart(2, '0');
}

/**
 * Append a requirement to requirements.json atomically.
 * @param {Object} reqObj  Must have { id, text, category, status }
 * @param {string} [basePath]  project root (defaults to cwd)
 * @returns {{ ok: boolean, id?: string, reason?: string }}
 */
function addRequirement(reqObj, basePath) {
  const base = basePath || process.cwd();
  const reqPath = path.join(base, '.planning', 'formal', 'requirements.json');

  // Validate required fields
  if (!reqObj || !reqObj.id || !reqObj.text || !reqObj.category || !reqObj.status) {
    return { ok: false, reason: 'missing required fields (id, text, category, status)' };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'cannot read requirements.json: ' + err.message };
  }

  const requirements = raw.requirements || [];

  // Check for duplicate ID
  if (requirements.some(r => r.id === reqObj.id)) {
    return { ok: false, reason: 'duplicate' };
  }

  // Append
  requirements.push(reqObj);
  raw.requirements = requirements;

  // Update envelope metadata
  raw.aggregated_at = new Date().toISOString();
  delete raw.frozen_at;

  // Recompute content_hash (first 16 hex chars of sha256 of JSON.stringify(requirements))
  const crypto = require('crypto');
  raw.content_hash = crypto.createHash('sha256')
    .update(JSON.stringify(requirements))
    .digest('hex')
    .slice(0, 16);

  // Atomic write: .tmp then rename
  const tmpPath = reqPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, reqPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return { ok: false, reason: 'write error: ' + err.message };
  }

  return { ok: true, id: reqObj.id };
}

// ---------------------------------------------------------------------------
// Grouping by principle
// ---------------------------------------------------------------------------

/**
 * Group requirements by principle (8 high-level groups).
 * @param {Array} requirements
 * @returns {Object} { [principle]: { count, requirements: [...] } }
 */
function groupByPrinciple(requirements) {
  // Initialize all 8 principles in order
  const grouped = {};
  for (const p of PRINCIPLES) {
    grouped[p] = { count: 0, requirements: [] };
  }

  for (const r of requirements) {
    let principle = getCategoryPrinciple(r.category);
    if (!Object.prototype.hasOwnProperty.call(grouped, principle)) {
      principle = 'Planning Discipline';
    }
    grouped[principle].count++;
    grouped[principle].requirements.push(r);
  }

  return grouped;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  readRequirementsJson,
  readModelRegistry,
  readCheckResults,
  computeCoverage,
  buildTraceability,
  filterRequirements,
  getUniqueCategories,
  addRequirement,
  nextRequirementId,
  groupByPrinciple,
};

module.exports._pure = module.exports;

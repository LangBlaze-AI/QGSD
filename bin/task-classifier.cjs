'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Task complexity classifier for dynamic model selection.
 *
 * Classifies tasks by complexity and recommends model tiers + thinking budgets.
 * Used by nf-prompt.js to inject THINKING BUDGET directives and filter activeSlots.
 *
 * Zero new dependencies — built on Node.js built-ins only.
 */

const COMPLEXITY_MAP = {
  trivial:  { tier: 'haiku',  thinking_budget: 0,     description: 'formatting, typos, simple renames' },
  simple:   { tier: 'sonnet', thinking_budget: 8000,   description: 'single-file edits, config changes, test fixes' },
  moderate: { tier: 'sonnet', thinking_budget: 16000,  description: 'multi-file changes, refactoring, feature additions' },
  complex:  { tier: 'opus',   thinking_budget: 31999,  description: 'architecture decisions, new subsystems, formal verification' },
};

/**
 * Classifies a task envelope into a complexity level.
 *
 * @param {object|null|undefined} taskEnvelope - Task envelope object (or null/undefined)
 * @returns {'trivial'|'simple'|'moderate'|'complex'} Complexity classification
 */
function classifyTask(taskEnvelope) {
  if (!taskEnvelope) return 'moderate';

  const objective = (taskEnvelope.objective || '').toString();
  const fileCount = (taskEnvelope.files || []).length;
  const hasArchitecture = /architect|design|system|interface|api/i.test(objective);
  const isExploration = /explore|research|investigate|discover/i.test(objective);
  const isReview = /review|check|audit|inspect/i.test(objective);
  const riskLevel = taskEnvelope.risk_level || 'medium';
  const planTaskCount = taskEnvelope.task_count || 1;

  if (isExploration) return 'trivial';

  if (isReview && fileCount <= 3) return 'simple';

  if (riskLevel === 'high' || hasArchitecture) return 'complex';

  if (fileCount > 5 || planTaskCount > 3) return 'moderate';

  if (riskLevel === 'low' || riskLevel === 'routine') return 'simple';

  return 'moderate';
}

function adjustForHotspotRisk(complexity, taskFiles, cwd) {
  if (!taskFiles || taskFiles.length === 0) return complexity;

  try {
    const hotspotPath = path.join(cwd || process.cwd(), '.planning', 'repowise', 'hotspot-cache.json');
    if (!fs.existsSync(hotspotPath)) return complexity;

    const data = JSON.parse(fs.readFileSync(hotspotPath, 'utf8'));
    if (!data || !data.files) return complexity;

    const hotspotMap = new Map();
    for (const f of data.files) {
      hotspotMap.set(f.path, f.hotspot_score);
    }

    let maxScore = 0;
    for (const fp of taskFiles) {
      const score = hotspotMap.get(fp) || 0;
      if (score > maxScore) maxScore = score;
    }

    if (maxScore > 0.7 && complexity === 'simple') return 'moderate';
    if (maxScore > 0.7 && complexity === 'moderate') return 'complex';
    if (maxScore > 0.4 && complexity === 'simple') return 'moderate';
  } catch (_) {
    // fail-open: return unchanged complexity
  }

  return complexity;
}

// Complexity-to-config-key mapping for thinking_budget_scaling overrides.
const COMPLEXITY_BUDGET_KEY = {
  trivial:  'exploration',
  simple:   'review',
  // moderate: no override key — uses COMPLEXITY_MAP default
  complex:  'architecture',
};

/**
 * Returns model recommendation for a given complexity level.
 *
 * @param {'trivial'|'simple'|'moderate'|'complex'} complexity
 * @param {object} config - nForma config object (from loadConfig)
 * @returns {{ complexity: string, tier: string, thinking_budget: number, description: string }}
 */
function getModelRecommendation(complexity, config) {
  const base = Object.prototype.hasOwnProperty.call(COMPLEXITY_MAP, complexity)
    ? COMPLEXITY_MAP[complexity]
    : COMPLEXITY_MAP.moderate;
  const result = {
    complexity,
    tier: base.tier,
    thinking_budget: base.thinking_budget,
    description: base.description,
  };

  // Apply model_routing tier override
  if (config && config.model_routing && config.model_routing[complexity]) {
    result.tier = config.model_routing[complexity];
  }

  // Apply thinking_budget_scaling override
  const budgetKey = Object.prototype.hasOwnProperty.call(COMPLEXITY_BUDGET_KEY, complexity)
    ? COMPLEXITY_BUDGET_KEY[complexity]
    : undefined;
  if (budgetKey && config && config.thinking_budget_scaling &&
      config.thinking_budget_scaling[budgetKey] !== undefined) {
    result.thinking_budget = config.thinking_budget_scaling[budgetKey];
  }

  return result;
}

/**
 * Reads .planning/task-envelope.json if it exists.
 *
 * @param {string} cwd - Working directory
 * @returns {object|null} Parsed task envelope or null
 */
function readTaskEnvelope(cwd) {
  try {
    const envelopePath = path.join(cwd, '.planning', 'task-envelope.json');
    if (!fs.existsSync(envelopePath)) return null;
    return JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
  } catch {
    return null; // fail-open
  }
}

module.exports = { classifyTask, adjustForHotspotRisk, getModelRecommendation, readTaskEnvelope, COMPLEXITY_MAP };

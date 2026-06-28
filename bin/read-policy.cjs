#!/usr/bin/env node
'use strict';
// bin/read-policy.cjs
// Reads and validates .planning/formal/policy.yaml using lightweight regex extraction.
// No external YAML parser required — policy.yaml uses flat key: value structure.
// Requirements: CALIB-01, CALIB-04

const fs   = require('fs');
const path = require('path');

/**
 * Read and validate .planning/formal/policy.yaml.
 * Throws Error with descriptive message on missing file or missing required fields.
 *
 * @param {string} policyPath  Absolute path to policy.yaml
 * @returns {{ cold_start: { min_ci_runs: number, min_quorum_rounds: number, min_days: number },
 *             steady_state: { mode: string },
 *             conservative_priors: { tp_rate: number, unavail: number } }}
 */
function readPolicy(policyPath) {
  if (!fs.existsSync(policyPath)) {
    throw new Error('[read-policy] Policy file not found: ' + policyPath);
  }
  if (!fs.statSync(policyPath).isFile()) {
    throw new Error('[read-policy] Policy path is not a file: ' + policyPath);
  }

  const yaml = fs.readFileSync(policyPath, 'utf8');

  // Extract flat key: value using regex (ignores YAML comments)
  const extract = (key, asFloat) => {
    const match = yaml.match(new RegExp('^\\s*' + key + ':\\s*([\\d.]+)', 'm'));
    if (!match) {
      throw new Error('[read-policy] Policy missing required key: ' + key);
    }
    const num = asFloat ? parseFloat(match[1]) : parseInt(match[1], 10);
    if (!Number.isFinite(num)) {
      throw new Error('[read-policy] Policy key has non-numeric value: ' + key);
    }
    return num;
  };

  const extractStr = (key) => {
    const match = yaml.match(new RegExp('^\\s*' + key + ':\\s*["\']?([\\w]+)["\']?', 'm'));
    if (!match) {
      throw new Error('[read-policy] Policy missing required key: ' + key);
    }
    return match[1];
  };

  return {
    cold_start: {
      min_ci_runs:       extract('min_ci_runs', false),
      min_quorum_rounds: extract('min_quorum_rounds', false),
      min_days:          extract('min_days', true),
    },
    steady_state: {
      mode: extractStr('mode'),
    },
    conservative_priors: {
      tp_rate: extract('tp_rate', true),
      unavail: extract('unavail', true),
    },
  };
}

module.exports = { readPolicy };

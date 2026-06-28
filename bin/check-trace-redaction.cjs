#!/usr/bin/env node
'use strict';
// bin/check-trace-redaction.cjs
// Validates trace event files against .planning/formal/trace/redaction.yaml policy.
// Prevents secrets and PII from persisting in trace event artifacts.
//
// Exit code 0: no violations (or no trace directory/files)
// Exit code 1: one or more violations found

const fs   = require('fs');
const path = require('path');
const { writeCheckResult } = require('./write-check-result.cjs');
const { getRequirementIds } = require('./requirement-map.cjs');

const DEFAULT_POLICY_PATH = path.join(__dirname, '..', '.planning', 'formal', 'trace', 'redaction.yaml');

/**
 * Parse redaction.yaml using line-by-line regex (no external YAML parser).
 * Handles two sections:
 *   forbidden_keys:  - "key_name"
 *   forbidden_patterns:  - name: "n"\n    regex: "r"
 *
 * @param {string} policyPath  Absolute path to redaction.yaml
 * @returns {{ forbidden_keys: string[], forbidden_patterns: Array<{name: string, regex: string, compiled: RegExp}> }}
 */
function parseRedactionPolicy(policyPath) {
  const yaml = fs.readFileSync(policyPath, 'utf8');
  const lines = yaml.split('\n');

  const forbidden_keys = [];
  const forbidden_patterns = [];

  let inKeys = false;
  let inPatterns = false;
  let currentPattern = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Section headers
    if (trimmed === 'forbidden_keys:') {
      inKeys = true;
      inPatterns = false;
      if (currentPattern) {
        if (currentPattern.name && currentPattern.regex) {
          forbidden_patterns.push({
            name: currentPattern.name,
            regex: currentPattern.regex,
            compiled: new RegExp(currentPattern.regex),
          });
        }
        currentPattern = null;
      }
      continue;
    }
    if (trimmed === 'forbidden_patterns:') {
      inKeys = false;
      inPatterns = true;
      if (currentPattern) {
        if (currentPattern.name && currentPattern.regex) {
          forbidden_patterns.push({
            name: currentPattern.name,
            regex: currentPattern.regex,
            compiled: new RegExp(currentPattern.regex),
          });
        }
        currentPattern = null;
      }
      continue;
    }

    // Skip blank lines and top-level comments
    if (trimmed === '' || (trimmed.startsWith('#') && !line.startsWith('  '))) {
      continue;
    }

    if (inKeys) {
      // Lines like:  - "api_key"  or  - api_key
      const keyMatch = trimmed.match(/^-\s+"?([^"]+)"?$/);
      if (keyMatch) {
        forbidden_keys.push(keyMatch[1].trim());
      }
    }

    if (inPatterns) {
      // New pattern entry starts with "- name:"
      const newEntryMatch = trimmed.match(/^-\s+name:\s+"?([^"]+)"?$/);
      if (newEntryMatch) {
        // Flush previous pattern
        if (currentPattern && currentPattern.name && currentPattern.regex) {
          forbidden_patterns.push({
            name: currentPattern.name,
            regex: currentPattern.regex,
            compiled: new RegExp(currentPattern.regex),
          });
        }
        currentPattern = { name: newEntryMatch[1].trim(), regex: null };
        continue;
      }
      // Regex line within a pattern entry
      const regexMatch = trimmed.match(/^regex:\s+"?(.+?)"?$/);
      if (regexMatch && currentPattern) {
        currentPattern.regex = regexMatch[1].trim();
        continue;
      }
    }
  }

  // Flush last pattern
  if (currentPattern && currentPattern.name && currentPattern.regex) {
    forbidden_patterns.push({
      name: currentPattern.name,
      regex: currentPattern.regex,
      compiled: new RegExp(currentPattern.regex),
    });
  }

  return { forbidden_keys, forbidden_patterns };
}

/**
 * Validate a single trace event object against the redaction policy.
 * Returns an array of violation objects (empty if clean).
 *
 * @param {Object} event   Parsed trace event object
 * @param {{ forbidden_keys: string[], forbidden_patterns: Array<{name: string, compiled: RegExp}> }} policy
 * @returns {Array<{ key: string, value?: string, pattern_name?: string, violation_type: 'forbidden_key'|'forbidden_pattern' }>}
 */
function validateTraceEvent(event, policy) {
  const violations = [];
  if (!event || typeof event !== 'object') return violations;

  for (const [key, value] of Object.entries(event)) {
    // Check forbidden keys
    if (policy.forbidden_keys.includes(key)) {
      violations.push({ key, violation_type: 'forbidden_key' });
    }

    // Check forbidden patterns against string values
    if (typeof value === 'string') {
      for (const pattern of policy.forbidden_patterns) {
        if (pattern.compiled.test(value)) {
          violations.push({ key, value, pattern_name: pattern.name, violation_type: 'forbidden_pattern' });
        }
      }
    } else if (value && typeof value === 'object') {
      // Recurse into nested objects/arrays so secrets and forbidden keys
      // nested at any depth are still detected (fail-closed).
      for (const nested of validateTraceEvent(value, policy)) {
        violations.push(nested);
      }
    }
  }

  return violations;
}

if (require.main === module) {
  // Parse CLI args: optional --trace-dir <path>
  let traceDir = path.join(process.cwd(), '.planning', 'formal', 'trace');
  const args = process.argv.slice(2);
  const traceDirIdx = args.indexOf('--trace-dir');
  if (traceDirIdx !== -1 && args[traceDirIdx + 1]) {
    traceDir = args[traceDirIdx + 1];
  }

  // Load policy
  const policy = parseRedactionPolicy(DEFAULT_POLICY_PATH);

  // Graceful: no trace directory
  const _startMs = Date.now();
  if (!fs.existsSync(traceDir)) {
    try {
      writeCheckResult({
        tool: 'check-trace-redaction',
        formalism: 'redaction',
        result: 'pass',
        check_id: 'ci:trace-redaction', surface: 'ci', property: 'Trace redaction — no forbidden keys or patterns in conformance event logs',
        runtime_ms: Date.now() - _startMs, summary: 'pass: ci:trace-redaction in ' + (Date.now() - _startMs) + 'ms', triage_tags: [],
        requirement_ids: getRequirementIds('ci:trace-redaction'),
        metadata: { reason: 'no-trace-directory', directory: traceDir },
      });
    } catch (e) {
      process.stderr.write('[check-trace-redaction] Warning: failed to write check result: ' + e.message + '\n');
    }
    process.exit(0);
  }

  // Find .json and .jsonl files (non-recursive). Fail open if the path
  // exists but is not a readable directory (e.g. a regular file → ENOTDIR).
  let allFiles;
  try {
    allFiles = fs.readdirSync(traceDir);
  } catch (_) {
    allFiles = [];
  }
  const traceFiles = allFiles.filter(f => f.endsWith('.json') || f.endsWith('.jsonl'));

  if (traceFiles.length === 0) {
    try {
      writeCheckResult({
        tool: 'check-trace-redaction',
        formalism: 'redaction',
        result: 'pass',
        check_id: 'ci:trace-redaction', surface: 'ci', property: 'Trace redaction — no forbidden keys or patterns in conformance event logs',
        runtime_ms: Date.now() - _startMs, summary: 'pass: ci:trace-redaction in ' + (Date.now() - _startMs) + 'ms', triage_tags: [],
        requirement_ids: getRequirementIds('ci:trace-redaction'),
        metadata: { reason: 'no-trace-events', directory: traceDir },
      });
    } catch (e) {
      process.stderr.write('[check-trace-redaction] Warning: failed to write check result: ' + e.message + '\n');
    }
    process.exit(0);
  }

  // Scan all files — collect all violations (no fail-fast)
  const allViolations = [];
  let fileCount = 0;
  let eventCount = 0;

  for (const filename of traceFiles) {
    const filePath = path.join(traceDir, filename);
    const raw = fs.readFileSync(filePath, 'utf8');
    const fileLines = raw.split('\n').filter(l => l.trim().length > 0);
    fileCount++;

    for (const line of fileLines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (_) {
        continue; // skip unparseable lines
      }
      eventCount++;
      const violations = validateTraceEvent(event, policy);
      for (const v of violations) {
        allViolations.push({ file: filename, ...v });
      }
    }
  }

  const _runtimeMs = Date.now() - _startMs;
  if (allViolations.length > 0) {
    process.stdout.write('[check-trace-redaction] ' + allViolations.length + ' violation(s) found:\n');
    for (const v of allViolations.slice(0, 10)) {
      process.stdout.write('  ' + JSON.stringify(v) + '\n');
    }
    try {
      writeCheckResult({
        tool: 'check-trace-redaction',
        formalism: 'redaction',
        result: 'fail',
        check_id: 'ci:trace-redaction', surface: 'ci', property: 'Trace redaction — no forbidden keys or patterns in conformance event logs',
        runtime_ms: _runtimeMs, summary: 'fail: ci:trace-redaction in ' + _runtimeMs + 'ms', triage_tags: [],
        requirement_ids: getRequirementIds('ci:trace-redaction'),
        metadata: {
          violations: allViolations.slice(0, 10),
          total_violations: allViolations.length,
        },
      });
    } catch (e) {
      process.stderr.write('[check-trace-redaction] Warning: failed to write check result: ' + e.message + '\n');
    }
    process.exit(1);
  }

  try {
    writeCheckResult({
      tool: 'check-trace-redaction',
      formalism: 'redaction',
      result: 'pass',
      check_id: 'ci:trace-redaction', surface: 'ci', property: 'Trace redaction — no forbidden keys or patterns in conformance event logs',
      runtime_ms: _runtimeMs, summary: 'pass: ci:trace-redaction in ' + _runtimeMs + 'ms', triage_tags: [],
      requirement_ids: getRequirementIds('ci:trace-redaction'),
      metadata: { files_checked: fileCount, events_checked: eventCount },
    });
  } catch (e) {
    process.stderr.write('[check-trace-redaction] Warning: failed to write check result: ' + e.message + '\n');
  }
  process.exit(0);
}

module.exports = { parseRedactionPolicy, validateTraceEvent };

#!/usr/bin/env node
'use strict';

/**
 * validate-requirements-haiku.cjs
 *
 * Semantic requirements validator using Claude Haiku
 *
 * Detects:
 * - DUPLICATES: Different requirement IDs with same intent
 * - CONTRADICTIONS: Requirements that cannot both be satisfied
 * - AMBIGUITY: Requirements with multiple incompatible interpretations
 *
 * Usage:
 *   node bin/validate-requirements-haiku.cjs [--envelope=path] [--passes=3] [--freeze]
 *
 * Exits with code 0 for validation complete (regardless of findings).
 * Exits with code 1 for operational errors (missing file, API failure, etc).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ─────────────────────────────────────────────────────────────────────────────
// Raw HTTPS Haiku API helper (replaces SDK dependency)
// ─────────────────────────────────────────────────────────────────────────────

function callHaikuAPI(apiKey, prompt, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = ((parsed.content || [])[0] || {}).text || '';
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// buildValidationPrompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construct the Haiku validation prompt with explicit rubrics
 * @param {Array} requirements - Array of requirement objects { id, text, category, phase }
 * @returns {string} The prompt string
 */
function buildValidationPrompt(requirements) {
  const reqList = requirements
    .map(r => `- ${r.id}: ${r.text}`)
    .join('\n');

  const prompt = `You are reviewing a requirements envelope for quality issues.

Requirements:
${reqList}

Analyze for exactly these three categories:

1. DUPLICATES: Different IDs where the INTENT is the same (not just similar wording).
   Example: "Users can log in" and "Authentication allows user access" are duplicates.
   NOT duplicates: "Users can log in" and "Admins can log in" (different scope).

2. CONTRADICTIONS: Two requirements that CANNOT BOTH be satisfied.
   Example: "Data is immutable" and "Data auto-updates daily" are contradictory.
   NOT contradictions: "Data is immutable" and "Amendments require approval" (compatible).

3. AMBIGUITY: A single requirement that admits two or more INCOMPATIBLE interpretations.
   Example: "The system should be fast" (fast for whom? what metric?).
   NOT ambiguous: "Response time under 200ms for 95th percentile" (specific).

Return ONLY valid JSON (no markdown, no explanation):
{
  "findings": [
    {
      "type": "duplicate|contradiction|ambiguity",
      "requirement_ids": ["ENV-XX", "ENV-YY"],
      "description": "...",
      "severity": "high|medium|low",
      "suggested_resolution": "..."
    }
  ],
  "summary": "N duplicates, N contradictions, N ambiguities found"
}

If no issues found, return: {"findings": [], "summary": "No issues found"}`;

  return prompt;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseHaikuResponse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse Haiku JSON response, handling markdown wrapping
 * @param {string} responseText - Raw Haiku response
 * @returns {Object} Parsed findings or error object
 */
function parseHaikuResponse(responseText) {
  try {
    // Try to extract JSON from markdown code fence
    let jsonStr = responseText;
    const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1];
    }

    const parsed = JSON.parse(jsonStr);

    // Validate structure
    if (!Array.isArray(parsed.findings)) {
      return { findings: [], summary: 'Invalid structure', error: true };
    }

    // Ensure each finding has required fields
    for (const finding of parsed.findings) {
      if (!finding.type || !Array.isArray(finding.requirement_ids) || !finding.description) {
        return { findings: [], summary: 'Invalid finding structure', error: true };
      }
    }

    return parsed;
  } catch (e) {
    return { findings: [], summary: 'Parse error: ' + e.message, error: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// aggregateFindings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate multi-pass results — only report findings in 2+ of N passes
 * @param {Array} passResults - Array of parsed responses from Haiku passes
 * @returns {Object} { confirmed, total_passes, agreement_threshold }
 */
function aggregateFindings(passResults) {
  const total_passes = passResults.length;
  const agreement_threshold = Math.ceil(total_passes / 2);

  // Collect all unique findings with pass counts
  const findingMap = new Map();

  for (let passIdx = 0; passIdx < passResults.length; passIdx++) {
    const result = passResults[passIdx];
    if (!result.findings) continue;

    for (const finding of result.findings) {
      // Create a key for matching: type + sorted IDs
      const key = JSON.stringify({
        type: finding.type,
        ids: Array.from(new Set(finding.requirement_ids)).sort(),
      });

      if (!findingMap.has(key)) {
        findingMap.set(key, {
          finding: finding,
          passes: new Set(),
        });
      }

      findingMap.get(key).passes.add(passIdx);
    }
  }

  // Filter to confirmed findings (2+ passes)
  const confirmed = Array.from(findingMap.values())
    .filter(item => item.passes.size >= agreement_threshold)
    .map(item => item.finding);

  return { confirmed, total_passes, agreement_threshold };
}

// ─────────────────────────────────────────────────────────────────────────────
// validateRequirements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main validation pipeline
 * @param {Object} options - { envelopePath, passes, apiKey, mockCall }
 * @returns {Promise<Object>} Validation result
 */
async function validateRequirements(options = {}) {
  const {
    envelopePath = '.planning/formal/requirements.json',
    passes = 3,
    apiKey = process.env.ANTHROPIC_API_KEY,
    mockCall = null, // For testing: mock Haiku response
  } = options;

  // Read envelope first (needed to check frozen_at before SDK availability)
  if (!fs.existsSync(envelopePath)) {
    return { status: 'error', reason: `Envelope file not found: ${envelopePath}` };
  }

  let envelope;
  try {
    const content = fs.readFileSync(envelopePath, 'utf8');
    envelope = JSON.parse(content);
  } catch (e) {
    return { status: 'error', reason: `Failed to read envelope: ${e.message}` };
  }

  // Check if already frozen (before SDK check)
  if (envelope.frozen_at) {
    return { status: 'already-frozen', frozen_at: envelope.frozen_at };
  }

  // Check if API key is available (skip check if using mockCall).
  // Warn loudly on stderr: subscription users (Claude Code via OAuth, no API key)
  // would otherwise have this semantic-validation pass silently no-op, leaving
  // them to believe review-requirements ran every pass.
  if (!apiKey && !mockCall) {
    process.stderr.write(
      '[validate-requirements-haiku] WARNING: semantic validation pass SKIPPED — ' +
      'ANTHROPIC_API_KEY is not set. Findings below come from the structural passes only. ' +
      'Set ANTHROPIC_API_KEY to enable the Haiku semantic pass.\n'
    );
    return { status: 'skipped', reason: 'ANTHROPIC_API_KEY not set', skipped_pass: 'semantic-validation' };
  }

  // Extract requirements array
  const requirements = Array.isArray(envelope.requirements) ? envelope.requirements : [];
  if (requirements.length === 0) {
    return { status: 'validated', confirmed: [], total_passes: 0, message: 'No requirements to validate' };
  }

  // Build prompt
  const prompt = buildValidationPrompt(requirements);

  // Run Haiku passes
  const rawPasses = [];

  try {
    for (let i = 0; i < passes; i++) {
      let responseText;

      if (mockCall) {
        // For testing
        responseText = mockCall();
      } else {
        // Real Haiku call via raw HTTPS
        responseText = await callHaikuAPI(apiKey, prompt, 4096);
      }

      const parsed = parseHaikuResponse(responseText);
      rawPasses.push(parsed);
    }
  } catch (e) {
    return { status: 'error', reason: `Haiku call failed: ${e.message}` };
  }

  // Aggregate findings
  const { confirmed, total_passes, agreement_threshold } = aggregateFindings(rawPasses);

  return {
    status: 'validated',
    confirmed,
    total_passes,
    agreement_threshold,
    raw_passes: rawPasses,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// freezeEnvelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Freeze the envelope by setting frozen_at timestamp
 * @param {string} envelopePath - Path to envelope file
 * @returns {Object} { frozen: true, frozen_at }
 */
function freezeEnvelope(envelopePath) {
  if (!fs.existsSync(envelopePath)) {
    throw new Error(`Envelope file not found: ${envelopePath}`);
  }

  let envelope;
  try {
    const content = fs.readFileSync(envelopePath, 'utf8');
    envelope = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to read envelope: ${e.message}`);
  }

  // Set frozen_at timestamp
  const frozen_at = new Date().toISOString();
  envelope.frozen_at = frozen_at;

  // Write atomically: temp file + rename
  const dir = path.dirname(envelopePath);
  const basename = path.basename(envelopePath);
  const tempPath = path.join(dir, '.' + basename + '.tmp');

  try {
    fs.writeFileSync(tempPath, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
    fs.renameSync(tempPath, envelopePath);
  } catch (e) {
    // Clean up temp file if rename failed
    try {
      fs.unlinkSync(tempPath);
    } catch (e2) {
      // Ignore cleanup error
    }
    throw new Error(`Failed to write envelope: ${e.message}`);
  }

  return { frozen: true, frozen_at };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entrypoint
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // Parse CLI arguments
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      args[key] = value || true;
    }
  }

  const envelopePath = args.envelope || '.planning/formal/requirements.json';
  const passes = parseInt(args.passes || '3', 10);
  const shouldFreeze = args.freeze === true || args.freeze === '';

  try {
    // Run validation
    const result = await validateRequirements({ envelopePath, passes });

    if (result.status === 'skipped') {
      console.log(`Validation skipped: ${result.reason}`);
      process.exit(0);
    }

    if (result.status === 'error') {
      console.error(`Validation error: ${result.reason}`);
      process.exit(1);
    }

    if (result.status === 'already-frozen') {
      console.log(`Envelope already frozen at ${result.frozen_at}`);
      process.exit(0);
    }

    // Display results
    console.log(`\nValidation Results (${result.total_passes} passes, ${result.agreement_threshold}+ agreement):\n`);

    if (result.confirmed.length === 0) {
      console.log('CONFIRMED FINDINGS: None\n');
    } else {
      console.log('CONFIRMED FINDINGS:');
      for (const finding of result.confirmed) {
        const severity = finding.severity?.toUpperCase() || 'MEDIUM';
        const type = finding.type.toUpperCase();
        const ids = finding.requirement_ids.join(', ');
        console.log(`  [${severity}] ${type}: ${ids} -- ${finding.description}`);
      }
      console.log('');
    }

    // Summary
    const counts = {
      duplicates: result.confirmed.filter(f => f.type === 'duplicate').length,
      contradictions: result.confirmed.filter(f => f.type === 'contradiction').length,
      ambiguities: result.confirmed.filter(f => f.type === 'ambiguity').length,
    };

    const summary = `${counts.duplicates} duplicates, ${counts.contradictions} contradictions, ${counts.ambiguities} ambiguities`;
    console.log(`Summary: ${summary}\n`);

    // Freeze if requested and no high-severity findings
    if (shouldFreeze) {
      const hasHighSeverity = result.confirmed.some(f => f.severity === 'high');
      if (hasHighSeverity) {
        console.log('Cannot freeze: high-severity findings must be resolved first\n');
        process.exit(0);
      }

      const frozen = freezeEnvelope(envelopePath);
      console.log(`Envelope frozen at: ${frozen.frozen_at}`);
    } else {
      console.log(`To freeze: node bin/validate-requirements-haiku.cjs --freeze`);
    }

    process.exit(0);
  } catch (e) {
    console.error(`Fatal error: ${e.message}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  buildValidationPrompt,
  parseHaikuResponse,
  validateRequirements,
  aggregateFindings,
  freezeEnvelope,
};

// Run CLI if this is the main module
if (require.main === module) {
  main().catch(err => {
    console.error(`Unhandled error: ${err.message}`);
    process.exit(1);
  });
}

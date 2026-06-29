#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Domain-specific pattern words for keyword extraction
const DOMAIN_PATTERNS = [
  'NDJSON', 'TLA', 'TLA+', 'Alloy', 'PRISM', 'xstate',
  'frontmatter', 'quorum', 'circuit-breaker', 'hook', 'MCP', 'scoreboard',
  'liveness', 'fairness', 'CTL', 'LTL'
];

// Stopwords for filtering
const STOPWORDS = new Set([
  'the', 'and', 'is', 'a', 'for', 'to', 'in', 'of', 'with', 'that',
  'on', 'from', 'all', 'be', 'have', 'has', 'are', 'as', 'at', 'by',
  'or', 'it', 'this', 'an', 'was', 'were', 'been', 'can', 'will'
]);

/**
 * Simple YAML frontmatter parser (supports basic key: value format).
 * Does not use external dependencies.
 */
function parseSimpleYaml(yamlStr) {
  const result = {};
  const lines = yamlStr.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      // Line without colon is invalid YAML syntax
      throw new Error(`Invalid YAML: ${trimmed}`);
    }

    const key = trimmed.substring(0, colonIdx).trim();
    const value = trimmed.substring(colonIdx + 1).trim();

    // Skip empty keys
    if (!key) {
      throw new Error(`Invalid YAML: empty key on line "${trimmed}"`);
    }

    // Parse value type
    let parsedValue;
    if (value === '' || value === 'null') {
      parsedValue = null;
    } else if (value === 'true') {
      parsedValue = true;
    } else if (value === 'false') {
      parsedValue = false;
    } else if (/^\d+$/.test(value)) {
      parsedValue = parseInt(value, 10);
    } else if (/^\d+\.\d+$/.test(value)) {
      parsedValue = parseFloat(value);
    } else if (value.startsWith('[') && value.endsWith(']')) {
      // Simple array parsing
      try {
        parsedValue = JSON.parse(value);
      } catch (e) {
        parsedValue = value;
      }
    } else {
      // String value (remove quotes if present)
      parsedValue = value.replace(/^["']|["']$/g, '');
    }

    result[key] = parsedValue;
  }

  return result;
}

/**
 * Parse YAML frontmatter from a markdown file content string.
 * Returns an object with parsed fields or empty object if no frontmatter.
 */
function parseVerificationFrontmatter(content) {
  if (typeof content !== 'string') {
    return {};
  }
  const lines = content.split('\n');
  if (lines.length < 3 || lines[0] !== '---') {
    return {};
  }

  let endMarker = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endMarker = i;
      break;
    }
  }

  if (endMarker === -1) {
    return {};
  }

  const yamlStr = lines.slice(1, endMarker).join('\n');
  try {
    const parsed = parseSimpleYaml(yamlStr);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (e) {
    // Return empty object for malformed YAML (do not throw)
    return {};
  }
}

/**
 * Extract requirement IDs from content using [A-Z]+-\d+ pattern.
 * Returns array of unique uppercase IDs.
 */
function extractRequirementIds(content) {
  const reqPattern = /[A-Z]+-\d+/g;
  const matches = content.match(reqPattern) || [];
  return [...new Set(matches)].sort();
}

/**
 * Extract keywords from directory name, phase goal text, and Observable Truths.
 * Returns array of keywords capped at 12.
 */
function extractKeywords(dirName, phaseGoal, truthsText) {
  const keywords = new Set();

  // From directory name: split on hyphens, filter version prefix
  const parts = (typeof dirName === 'string' ? dirName : '').split('-');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Skip version prefix (v0.XX, v0.XX-NN)
    if (/^v\d+/.test(part)) {
      continue;
    }
    // Skip plan numbers
    if (/^\d+$/.test(part)) {
      continue;
    }
    const word = part.toLowerCase();
    if (word && !STOPWORDS.has(word)) {
      keywords.add(word);
    }
  }

  // From phase goal text: extract nouns, filter stopwords
  if (phaseGoal) {
    const goalWords = phaseGoal
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w && w.length > 2 && !STOPWORDS.has(w));

    // Keep distinctive words (top 5-8)
    const wordFreq = {};
    goalWords.forEach(w => {
      wordFreq[w] = (wordFreq[w] || 0) + 1;
    });
    const sorted = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([w]) => w);
    sorted.forEach(w => keywords.add(w));
  }

  // From Observable Truths text: look for domain-specific patterns
  if (truthsText) {
    const lowerTruths = truthsText.toLowerCase();
    DOMAIN_PATTERNS.forEach(pattern => {
      if (lowerTruths.includes(pattern.toLowerCase())) {
        keywords.add(pattern.toLowerCase());
      }
    });

    // Also extract distinctive words from truths text
    const truthWords = truthsText
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w && w.length > 2 && !STOPWORDS.has(w));
    truthWords.forEach(w => keywords.add(w));
  }

  // Deduplicate and cap at 12
  const result = Array.from(keywords).slice(0, 12);
  return result;
}

/**
 * Extract Observable Truths text from VERIFICATION.md content.
 * Looks for a markdown table with "Observable Truth" or similar header.
 */
function extractObservableTruths(content) {
  const lines = content.split('\n');
  let truthsText = '';
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for table header with "Observable" or "Truth"
    if (/observable|truth/i.test(line) && /\|/.test(line)) {
      inTable = true;
      continue;
    }

    // Collect table rows
    if (inTable && /^\|/.test(line)) {
      truthsText += ' ' + line;
    } else if (inTable && !/^\|/.test(line)) {
      break;
    }
  }

  return truthsText;
}

/**
 * Extract phase name from content (H1 heading).
 * Pattern: # Phase vX.YY-NN: {Name}
 */
function extractPhaseName(content) {
  const match = content.match(/^#\s+Phase\s+([^:]+):\s*(.+)$/m);
  if (match) {
    return match[2].trim();
  }
  return '';
}

/**
 * Build the complete phase index from all VERIFICATION.md files.
 * Returns { version, generated_at, phases }
 */
function buildPhaseIndex() {
  const phasesDir = '.planning/phases';
  const skipped = [];
  const phases = [];

  if (!fs.existsSync(phasesDir)) {
    console.error(`Error: ${phasesDir} not found`);
    process.exit(1);
  }

  const entries = fs.readdirSync(phasesDir);

  for (const entry of entries) {
    const dirPath = path.join(phasesDir, entry);
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) continue;

    // Look for primary VERIFICATION.md (without plan suffix)
    let verificationPath = null;
    const files = fs.readdirSync(dirPath);

    // First try to find primary VERIFICATION.md (matches v0.XX-NN-VERIFICATION.md pattern)
    for (const file of files) {
      if (file.endsWith('-VERIFICATION.md')) {
        // Check if this is primary (no extra plan number suffix)
        // e.g., v0.14-02-VERIFICATION.md is primary, v0.14-02-03-VERIFICATION.md is not
        const baseName = file.replace(/-VERIFICATION\.md$/, '');
        const parts = baseName.split('-');
        // Primary format: v0.XX-NN (version and phase number only)
        if (parts.length === 2 && /^v\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
          verificationPath = path.join(dirPath, file);
          break;
        }
      }
    }

    // Fallback: use first VERIFICATION.md found
    if (!verificationPath) {
      const verFile = files.find(f => f.endsWith('-VERIFICATION.md'));
      if (verFile) {
        verificationPath = path.join(dirPath, verFile);
      }
    }

    if (!verificationPath) {
      continue;
    }

    try {
      const content = fs.readFileSync(verificationPath, 'utf-8');
      const frontmatter = parseVerificationFrontmatter(content);

      // Skip if frontmatter is empty (malformed file)
      if (!frontmatter || Object.keys(frontmatter).length === 0) {
        const relPath = path.relative(process.cwd(), verificationPath);
        console.error(`WARN: Skipping ${relPath}: no valid YAML frontmatter found`);
        skipped.push(verificationPath);
        continue;
      }

      const phaseId = frontmatter.phase || entry;
      const status = frontmatter.status || 'unknown';
      const phaseName = extractPhaseName(content) || entry;

      // Extract requirement IDs (newer format)
      const requirementIds = extractRequirementIds(content);

      // Extract keywords (especially for older phases)
      const truthsText = extractObservableTruths(content);
      const keywords = extractKeywords(entry, phaseName, truthsText);

      const phaseEntry = {
        phase_id: phaseId,
        phase_name: phaseName,
        status: status,
        requirement_ids: requirementIds,
        keywords: keywords,
        verification_path: path.relative(process.cwd(), verificationPath)
      };

      phases.push(phaseEntry);
    } catch (e) {
      const relPath = path.relative(process.cwd(), verificationPath);
      console.error(`WARN: Skipping ${relPath}: ${e.message}`);
      skipped.push(verificationPath);
    }
  }

  // Sort by phase_id for consistent ordering
  phases.sort((a, b) => a.phase_id.localeCompare(b.phase_id));

  const index = {
    version: '1.0',
    generated_at: new Date().toISOString(),
    phases: phases
  };

  // Write compact JSON (one entry per line for readability)
  const outputPath = '.planning/formal/phase-index.json';
  const jsonLines = [
    '{',
    `  "version": "${index.version}",`,
    `  "generated_at": "${index.generated_at}",`,
    '  "phases": ['
  ];

  for (let i = 0; i < phases.length; i++) {
    const entry = JSON.stringify(phases[i]);
    const comma = i < phases.length - 1 ? ',' : '';
    jsonLines.push(`    ${entry}${comma}`);
  }

  jsonLines.push('  ]');
  jsonLines.push('}');

  fs.writeFileSync(outputPath, jsonLines.join('\n'));

  // Print summary
  const skippedMsg = skipped.length > 0 ? ` (${skipped.length} skipped — see warnings above)` : '';
  console.log(`Phase index: ${phases.length} phases indexed${skippedMsg}, written to ${outputPath}`);

  return index;
}

/**
 * Append or update a single phase entry in the existing phase-index.json.
 * Idempotent: removes old entry with same phase_id before appending.
 */
function appendPhaseEntry(phaseDir, verificationPath) {
  // Read or create base index
  const indexPath = '.planning/formal/phase-index.json';
  let index = {
    version: '1.0',
    generated_at: new Date().toISOString(),
    phases: []
  };

  if (fs.existsSync(indexPath)) {
    try {
      const content = fs.readFileSync(indexPath, 'utf-8');
      index = JSON.parse(content);
    } catch (e) {
      // Start fresh if parse fails
      console.error(`WARN: Could not parse ${indexPath}, starting fresh`);
    }
  }

  // Ensure phases array exists
  if (!Array.isArray(index.phases)) {
    index.phases = [];
  }

  // Parse the verification file
  try {
    if (!fs.existsSync(verificationPath)) {
      console.error(`WARN: Verification file not found: ${verificationPath}`);
      return;
    }

    const content = fs.readFileSync(verificationPath, 'utf-8');
    const frontmatter = parseVerificationFrontmatter(content);

    if (!frontmatter || Object.keys(frontmatter).length === 0) {
      console.error(`WARN: No valid frontmatter in ${verificationPath}`);
      return;
    }

    const phaseId = frontmatter.phase || path.basename(phaseDir);
    const status = frontmatter.status || 'unknown';
    const phaseName = extractPhaseName(content) || path.basename(phaseDir);
    const requirementIds = extractRequirementIds(content);
    const truthsText = extractObservableTruths(content);
    const keywords = extractKeywords(path.basename(phaseDir), phaseName, truthsText);

    // Remove any existing entry with same phase_id (idempotent upsert).
    // Also drop malformed null/non-object entries so a corrupt index
    // cannot abort the upsert.
    index.phases = index.phases.filter(
      p => p && typeof p === 'object' && p.phase_id !== phaseId
    );

    // Add new entry
    const phaseEntry = {
      phase_id: phaseId,
      phase_name: phaseName,
      status: status,
      requirement_ids: requirementIds,
      keywords: keywords,
      verification_path: path.relative(process.cwd(), verificationPath)
    };

    index.phases.push(phaseEntry);

    // Re-sort by phase_id
    index.phases.sort((a, b) => a.phase_id.localeCompare(b.phase_id));

    // Update timestamp
    index.generated_at = new Date().toISOString();

    // Write back
    const jsonLines = [
      '{',
      `  "version": "${index.version}",`,
      `  "generated_at": "${index.generated_at}",`,
      '  "phases": ['
    ];

    for (let i = 0; i < index.phases.length; i++) {
      const entry = JSON.stringify(index.phases[i]);
      const comma = i < index.phases.length - 1 ? ',' : '';
      jsonLines.push(`    ${entry}${comma}`);
    }

    jsonLines.push('  ]');
    jsonLines.push('}');

    fs.writeFileSync(indexPath, jsonLines.join('\n'));
  } catch (e) {
    console.error(`WARN: Could not append phase entry: ${e.message}`);
  }
}

// Export functions
module.exports = {
  buildPhaseIndex,
  appendPhaseEntry,
  parseVerificationFrontmatter,
  extractKeywords,
  extractRequirementIds,
  extractObservableTruths,
  extractPhaseName,
  _pure: {
    buildPhaseIndex,
    appendPhaseEntry,
    parseVerificationFrontmatter,
    extractKeywords,
    extractRequirementIds,
    extractObservableTruths,
    extractPhaseName
  }
};

// CLI mode
if (require.main === module) {
  buildPhaseIndex();
}

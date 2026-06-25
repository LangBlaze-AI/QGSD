#!/usr/bin/env node
// bin/aggregate-requirements.cjs
// Requirements aggregation pipeline: parse .planning/REQUIREMENTS.md into .planning/formal/requirements.json
// Provides: parseRequirements, parseTraceability, validateEnvelope, aggregateRequirements

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Parse requirement bullets from REQUIREMENTS.md
// Returns array of { id, text, category, completed } sorted by id
function parseRequirements(content) {
  const requirements = [];
  let currentCategory = null;

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match category headers: ### Category — PREFIX, ### Category (PREFIX), ### Category — Multi Word, ### Category
    const headerMatch = line.match(/^###\s+(.+)$/);
    if (headerMatch) {
      let cat = headerMatch[1].trim();
      cat = cat.replace(/\s+[—–-]{1,2}\s+.+$/, '');  // "Foo — Bar" → "Foo"
      cat = cat.replace(/\s*\([^)]+\)\s*$/, '');       // "Foo (BAR)" → "Foo"
      currentCategory = cat.trim() || null;
      continue;
    }

    // Match requirement bullets: - [ ] **ID**: text or - [x] **ID**: text
    const reqMatch = line.match(/^-\s+\[([ x])\]\s+\*\*([A-Z]+-\d+)\*\*:\s*(.+)$/);
    if (reqMatch) {
      const [, completed_mark, id, text] = reqMatch;
      let reqText = text.trim();
      let tier = 'user';

      // Check for (technical) suffix and strip it from text
      if (reqText.endsWith('(technical)')) {
        tier = 'technical';
        reqText = reqText.slice(0, -'(technical)'.length).trim();
      }

      requirements.push({
        id,
        text: reqText,
        category: currentCategory || 'Uncategorized',
        tier: tier,
        completed: completed_mark === 'x'
      });
    }
  }

  // Sort by id (lexicographic) for determinism
  return requirements.sort((a, b) => a.id.localeCompare(b.id));
}

// Parse the Traceability table from REQUIREMENTS.md
// Returns map: { [reqId]: { phase, status } }
function parseTraceability(content) {
  const traceability = {};

  // Match table rows: | REQ-ID | vX.XX-NN | Status |
  const tableRowRegex = /^\|\s*([A-Z]+-\d+)\s*\|\s*(v[\d.]+-\d+)\s*\|\s*(\w+)\s*\|/gm;
  let match;

  while ((match = tableRowRegex.exec(content)) !== null) {
    const [, reqId, phase, status] = match;
    traceability[reqId] = {
      phase,
      status: status === 'Complete' ? 'Complete' : 'Pending'
    };
  }

  return traceability;
}

// Extract milestone from document title
// Matches: # Requirements: nForma vX.XX ... or similar
function extractMilestone(content) {
  const match = content.match(/#\s+Requirements:.*?(v[\d.]+)/);
  return match ? match[1] : 'unknown';
}

// Discover archived milestone REQUIREMENTS.md files
// Returns paths sorted by milestone version (oldest first)
function discoverArchiveFiles(archiveDir) {
  if (!fs.existsSync(archiveDir)) return [];

  const entries = fs.readdirSync(archiveDir)
    .filter(function(f) { return /^v[\d.]+-REQUIREMENTS\.md$/.test(f); });

  // Sort by version: extract numeric parts and compare
  entries.sort(function(a, b) {
    const va = a.match(/^v([\d.]+)-/);
    const vb = b.match(/^v([\d.]+)-/);
    if (!va || !vb) return a.localeCompare(b);
    const partsA = va[1].split('.').map(Number);
    const partsB = vb[1].split('.').map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });

  return entries.map(function(f) { return path.join(archiveDir, f); });
}

// Inline schema validation: check all required fields and types
function validateEnvelope(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object') {
    errors.push('Envelope must be an object');
    return { valid: false, errors };
  }

  // Check schema_version
  if (typeof obj.schema_version !== 'string' || obj.schema_version !== '1') {
    errors.push('schema_version must be string "1"');
  }

  // Check source
  if (typeof obj.source !== 'string') {
    errors.push('source must be a string');
  }

  // Check aggregated_at (ISO 8601)
  if (typeof obj.aggregated_at !== 'string') {
    errors.push('aggregated_at must be a string (ISO 8601)');
  } else if (!isValidISO8601(obj.aggregated_at)) {
    errors.push('aggregated_at is not valid ISO 8601');
  }

  // Check frozen_at (string or null)
  if (obj.frozen_at !== null && typeof obj.frozen_at !== 'string') {
    errors.push('frozen_at must be null or a string (ISO 8601)');
  } else if (obj.frozen_at && !isValidISO8601(obj.frozen_at)) {
    errors.push('frozen_at is not valid ISO 8601');
  }

  // Check content_hash
  if (!obj.content_hash || typeof obj.content_hash !== 'string') {
    errors.push('content_hash must be a string');
  } else if (!/^sha256:[a-f0-9]{64}$/.test(obj.content_hash)) {
    errors.push('content_hash must match pattern sha256:[64-hex-chars]');
  }

  // Check requirements array
  if (!Array.isArray(obj.requirements)) {
    errors.push('requirements must be an array');
    return { valid: false, errors };
  }

  // Validate each requirement
  obj.requirements.forEach((req, idx) => {
    if (!req.id || typeof req.id !== 'string') {
      errors.push('requirements[' + idx + '].id must be a string');
    } else if (!/^[A-Z]+-\d+$/.test(req.id)) {
      errors.push('requirements[' + idx + '].id does not match pattern');
    }

    if (!req.text || typeof req.text !== 'string') {
      errors.push('requirements[' + idx + '].text must be a non-empty string');
    }

    if (!req.category || typeof req.category !== 'string') {
      errors.push('requirements[' + idx + '].category must be a non-empty string');
    }

    if (!req.phase || typeof req.phase !== 'string') {
      errors.push('requirements[' + idx + '].phase must be a string');
    } else if (req.phase !== 'unknown' && !/^v[\d.]+-\d+$/.test(req.phase)) {
      errors.push('requirements[' + idx + '].phase does not match pattern');
    }

    if (!['Pending', 'Complete'].includes(req.status)) {
      errors.push('requirements[' + idx + '].status must be Pending or Complete');
    }

    if (req.tier !== undefined && !['user', 'technical'].includes(req.tier)) {
      errors.push('requirements[' + idx + '].tier must be "user" or "technical" if present');
    }

    if (req.background !== undefined && typeof req.background !== 'string') {
      errors.push('requirements[' + idx + '].background must be a string if present');
    }

    if (req.category_raw !== undefined && typeof req.category_raw !== 'string') {
      errors.push('requirements[' + idx + '].category_raw must be a string if present');
    }

    if (!req.provenance || typeof req.provenance !== 'object') {
      errors.push('requirements[' + idx + '].provenance must be an object');
    } else {
      if (typeof req.provenance.source_file !== 'string') {
        errors.push('requirements[' + idx + '].provenance.source_file must be a string');
      }
      if (typeof req.provenance.milestone !== 'string') {
        errors.push('requirements[' + idx + '].provenance.milestone must be a string');
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

// Validate ISO 8601 datetime string
function isValidISO8601(dateString) {
  const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
  if (!iso8601Regex.test(dateString)) {
    return false;
  }
  return !isNaN(Date.parse(dateString));
}

// Compute SHA-256 hash of content
function computeContentHash(obj) {
  const jsonStr = JSON.stringify(obj, null, 2);
  return 'sha256:' + crypto.createHash('sha256').update(jsonStr).digest('hex');
}

// Process a single requirements file into a Map (mutates reqMap in place)
function mergeFileIntoMap(reqMap, filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const requirements = parseRequirements(content);
  const traceability = parseTraceability(content);
  const milestone = extractMilestone(content);

  requirements.forEach(function(req) {
    // Use traceability table when available; fall back to checkbox state [x] = Complete
    const trace = traceability[req.id] || { phase: 'unknown', status: req.completed ? 'Complete' : 'Pending' };
    reqMap.set(req.id, {
      id: req.id,
      text: req.text,
      category: req.category,
      tier: req.tier || 'user',
      phase: trace.phase,
      status: trace.status,
      provenance: {
        source_file: filePath,
        milestone: milestone
      }
    });
  });
}

// Main aggregation pipeline
function aggregateRequirements(options) {
  options = options || {};
  const requirementsPath = options.requirementsPath || '.planning/REQUIREMENTS.md';
  const outputPath = options.outputPath || '.planning/formal/requirements.json';
  const deterministic = options.deterministic || false;
  const skipArchive = options.skipArchive || false;
  const archiveDir = options.archiveDir || '.planning/milestones';

  // Check if output path exists and is frozen; also capture existing formal_models enrichment
  // formal_models is enrichment data (not milestone-sourced) and must survive re-aggregation
  const existingFormalModels = {};
  if (fs.existsSync(outputPath)) {
    const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    // Truthy check, not `!== null`: a fresh envelope often omits `frozen_at` (or
    // sets it undefined), and `undefined !== null` is true — which falsely tripped
    // the frozen guard on every absent key (dogfood). Only a real timestamp freezes.
    if (existing.frozen_at) {
      throw new Error('Envelope is frozen -- use amendment workflow (ENV-04)');
    }
    // Capture formal_models keyed by requirement id for merge-back after aggregation
    if (Array.isArray(existing.requirements)) {
      existing.requirements.forEach(function(req) {
        if (req.formal_models !== undefined) {
          existingFormalModels[req.id] = req.formal_models;
        }
      });
    }
  }

  // Build merged requirement map: archive oldest→newest, then current (last write wins)
  const reqMap = new Map();

  if (!skipArchive) {
    var archiveFiles = discoverArchiveFiles(archiveDir);
    archiveFiles.forEach(function(archivePath) {
      mergeFileIntoMap(reqMap, archivePath);
    });
  }

  // Current REQUIREMENTS.md is optional when archives provide requirements
  if (fs.existsSync(requirementsPath)) {
    mergeFileIntoMap(reqMap, requirementsPath);
  } else if (reqMap.size === 0) {
    throw new Error('REQUIREMENTS.md not found at ' + requirementsPath + ' and no archive files found');
  }

  // Convert Map to sorted array
  const merged = Array.from(reqMap.values());
  merged.sort(function(a, b) { return a.id.localeCompare(b.id); });

  // Merge back formal_models enrichment data (preserved from previous output)
  // formal_models is not milestone-sourced so the aggregator must not discard it
  merged.forEach(function(req) {
    if (existingFormalModels[req.id] !== undefined) {
      req.formal_models = existingFormalModels[req.id];
    }
  });

  // Default tier: all existing requirements are user-tier unless explicitly marked
  merged.forEach(function(req) {
    if (!req.tier) {
      req.tier = 'user';
    }
  });

  // Apply category group consolidation from .planning/formal/category-groups.json
  const groupsPath = path.join(path.dirname(outputPath), 'category-groups.json');
  let categoryGroups = null;
  const unmappedCategories = [];
  if (fs.existsSync(groupsPath)) {
    try {
      categoryGroups = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
    } catch (_) { /* ignore parse errors, skip grouping */ }
  }
  if (categoryGroups) {
    const seen = new Set();
    merged.forEach(function(req) {
      const group = categoryGroups[req.category];
      if (group) {
        req.category_raw = req.category;
        req.category = group;
      } else if (req.category !== 'Uncategorized') {
        if (!seen.has(req.category)) {
          unmappedCategories.push(req.category);
          seen.add(req.category);
        }
      }
    });
  }

  // Compute content hash from the requirements array (before envelope wrapping)
  const contentHash = computeContentHash(merged);

  // Get current timestamp or use fixed timestamp for deterministic mode
  const now = deterministic
    ? '2026-03-01T20:32:24.000Z'
    : new Date().toISOString();

  // Build envelope with keys in alphabetical order for determinism
  const envelope = {
    aggregated_at: now,
    content_hash: contentHash,
    frozen_at: null,
    requirements: merged,
    schema_version: '1',
    source: requirementsPath
  };

  // Validate envelope
  const validation = validateEnvelope(envelope);
  if (!validation.valid) {
    throw new Error('Envelope validation failed: ' + validation.errors.join('; '));
  }

  // Write atomically (temp + rename)
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = outputPath + '.' + Date.now() + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf8');
    fs.renameSync(tmpPath, outputPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_ignored) {}
    throw e;
  }

  return {
    valid: true,
    requirementCount: merged.length,
    outputPath: outputPath,
    unmappedCategories: unmappedCategories
  };
}

// CLI entrypoint
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const opts = {};
    let dryRun = false;
    let deterministic = false;
    let skipArchive = false;

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--dry-run') {
        dryRun = true;
      } else if (args[i] === '--deterministic') {
        deterministic = true;
      } else if (args[i] === '--skip-archive') {
        skipArchive = true;
      } else if (args[i].indexOf('--requirements=') === 0) {
        opts.requirementsPath = args[i].split('=')[1];
      } else if (args[i].indexOf('--output=') === 0) {
        opts.outputPath = args[i].split('=')[1];
      }
    }

    opts.deterministic = deterministic;
    opts.skipArchive = skipArchive;

    if (dryRun) {
      // Dry run: output to stdout without writing file
      const requirementsPath = opts.requirementsPath || '.planning/REQUIREMENTS.md';
      const archiveDir = opts.archiveDir || '.planning/milestones';

      const reqMap = new Map();

      if (!skipArchive) {
        var archiveFiles = discoverArchiveFiles(archiveDir);
        archiveFiles.forEach(function(archivePath) {
          mergeFileIntoMap(reqMap, archivePath);
        });
      }

      if (fs.existsSync(requirementsPath)) {
        mergeFileIntoMap(reqMap, requirementsPath);
      } else if (reqMap.size === 0) {
        throw new Error('REQUIREMENTS.md not found at ' + requirementsPath + ' and no archive files found');
      }

      const merged = Array.from(reqMap.values());
      merged.sort(function(a, b) { return a.id.localeCompare(b.id); });

      // Apply category group consolidation (same as write path)
      const groupsPath = path.join('.planning', 'formal', 'category-groups.json');
      if (fs.existsSync(groupsPath)) {
        try {
          const categoryGroups = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
          merged.forEach(function(req) {
            const group = categoryGroups[req.category];
            if (group) {
              req.category_raw = req.category;
              req.category = group;
            }
          });
        } catch (_) { /* ignore */ }
      }

      const contentHash = computeContentHash(merged);
      const now = deterministic
        ? '2026-03-01T20:32:24.000Z'
        : new Date().toISOString();

      const envelope = {
        aggregated_at: now,
        content_hash: contentHash,
        frozen_at: null,
        requirements: merged,
        schema_version: '1',
        source: requirementsPath
      };

      console.log(JSON.stringify(envelope, null, 2));
    } else {
      const result = aggregateRequirements(opts);
      console.log('Aggregated ' + result.requirementCount + ' requirements to ' + result.outputPath);
    }
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }
}

// Exports
module.exports = {
  parseRequirements: parseRequirements,
  parseTraceability: parseTraceability,
  validateEnvelope: validateEnvelope,
  aggregateRequirements: aggregateRequirements,
  discoverArchiveFiles: discoverArchiveFiles
};

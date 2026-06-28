'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Compute SHA-256 hash of file content.
 * Returns null if file doesn't exist or error occurs.
 */
function hashFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (err) {
    return null;
  }
}

/**
 * Parse source files from model header comments.
 * Looks for "-- Source:" or "* Source:" in the first 10 lines.
 * Returns array of source file paths (relative to project root).
 */
function parseSourceFiles(modelContent) {
  const lines = modelContent.split('\n').slice(0, 10);
  for (const line of lines) {
    // Match "-- Source:" (Alloy) or "* Source:" (TLA+/other)
    const match = line.match(/(?:--|\\*)\s+Source:\s*(.+)/);
    if (match) {
      // Split by comma, trim, filter empty strings
      return match[1]
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
    }
  }
  return [];
}

/**
 * Check staleness of formal models by comparing stored vs computed hashes.
 * @param {string} root - Project root directory
 * @param {Object} options - { updateHashes?: boolean }
 * @returns {Object} { stale, total_checked, total_stale, first_hash_count, skipped }
 */
function checkStaleness(root, options = {}) {
  const { updateHashes = false } = options;

  const registryPath = path.join(root, '.planning', 'formal', 'model-registry.json');

  // Graceful degradation: missing registry
  if (!fs.existsSync(registryPath)) {
    return {
      stale: [],
      total_checked: 0,
      total_stale: 0,
      first_hash_count: 0,
      skipped: true,
    };
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (err) {
    return {
      stale: [],
      total_checked: 0,
      total_stale: 0,
      first_hash_count: 0,
      skipped: true,
    };
  }

  const models = (registry && typeof registry === 'object' && registry.models && typeof registry.models === 'object')
    ? registry.models
    : {};
  const stale = [];
  let total_checked = 0;
  let first_hash_count = 0;
  let registryModified = false;

  // Check each model
  for (const [modelPath, entry] of Object.entries(models)) {
    total_checked++;

    // Graceful degradation: malformed (null/non-object) registry entry
    if (entry === null || typeof entry !== 'object') {
      continue;
    }

    const fullModelPath = path.join(root, modelPath);
    const modelHash = hashFile(fullModelPath);

    // Skip if model file missing (graceful degradation)
    if (modelHash === null) {
      continue;
    }

    // Parse source files from model header
    let modelContent = '';
    try {
      modelContent = fs.readFileSync(fullModelPath, 'utf8');
    } catch (err) {
      // Can't read content; skip
      continue;
    }

    const sourceFiles = parseSourceFiles(modelContent);

    // Compute source hashes
    const sourceHashes = {};
    for (const srcPath of sourceFiles) {
      const srcHash = hashFile(path.join(root, srcPath));
      if (srcHash !== null) {
        sourceHashes[srcPath] = srcHash;
      }
    }

    const computedHashes = {
      model_hash: modelHash,
      source_hashes: sourceHashes,
    };

    // Compare against stored hashes
    const storedHashes = entry.content_hashes;

    if (!storedHashes) {
      // First run: no stored hashes yet
      first_hash_count++;
      if (updateHashes) {
        entry.content_hashes = computedHashes;
        registryModified = true;
      }
      continue;
    }

    // Check model hash
    if (storedHashes.model_hash !== modelHash) {
      stale.push({
        model: modelPath,
        reason: 'model_changed',
        changed_sources: [],
        requirements: entry.requirements || [],
      });
      if (updateHashes) {
        entry.content_hashes = computedHashes;
        registryModified = true;
      }
      continue;
    }

    // Check source hashes
    const changedSources = [];
    const storedSources = storedHashes.source_hashes || {};

    for (const [srcPath, srcHash] of Object.entries(sourceHashes)) {
      if (storedSources[srcPath] !== srcHash) {
        changedSources.push(srcPath);
      }
    }

    // Also check for removed sources (were in stored but not computed)
    for (const srcPath of Object.keys(storedSources)) {
      if (sourceHashes[srcPath] === undefined) {
        changedSources.push(srcPath + ' (removed)');
      }
    }

    if (changedSources.length > 0) {
      stale.push({
        model: modelPath,
        reason: 'source_changed',
        changed_sources: changedSources,
        requirements: entry.requirements || [],
      });
      if (updateHashes) {
        entry.content_hashes = computedHashes;
        registryModified = true;
      }
    }
  }

  // Write registry if modified and updateHashes is true
  if (updateHashes && registryModified) {
    try {
      const tmpPath = registryPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpPath, registryPath);
    } catch (err) {
      process.stderr.write('WARNING: Could not write model-registry.json: ' + err.message + '\n');
    }
  }

  return {
    stale,
    total_checked,
    total_stale: stale.length,
    first_hash_count,
  };
}

/**
 * CLI entry point
 */
function main() {
  const args = process.argv.slice(2);
  const flags = {
    json: false,
    dryRun: false,
    updateHashes: false,
    projectRoot: process.cwd(),
  };

  // Parse CLI flags
  for (const arg of args) {
    if (arg === '--json') flags.json = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--update-hashes') flags.updateHashes = true;
    else if (arg.startsWith('--project-root=')) {
      flags.projectRoot = arg.split('=')[1];
    }
  }

  // Dry-run overrides update-hashes
  if (flags.dryRun) flags.updateHashes = false;

  try {
    const result = checkStaleness(flags.projectRoot, { updateHashes: flags.updateHashes });

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // CLI text output
      if (result.skipped) {
        process.stderr.write('model-registry.json not found; skipping\n');
      } else {
        process.stderr.write(`Checked ${result.total_checked} models, ${result.total_stale} stale, ${result.first_hash_count} first-hash\n`);
        for (const s of result.stale) {
          process.stderr.write(`  ! ${s.model} -- ${s.reason}`);
          if (s.changed_sources && s.changed_sources.length > 0) {
            process.stderr.write(` (${s.changed_sources.join(', ')})`);
          }
          process.stderr.write('\n');
        }
      }
    }
    process.exit(0);
  } catch (err) {
    if (flags.json) {
      console.log(JSON.stringify({
        stale: [],
        total_checked: 0,
        total_stale: 0,
        first_hash_count: 0,
        error: err.message,
      }, null, 2));
    } else {
      process.stderr.write('ERROR: ' + err.message + '\n');
    }
    process.exit(0); // Fail-open
  }
}

module.exports = { checkStaleness };

// CLI entry point
if (require.main === module) {
  main();
}

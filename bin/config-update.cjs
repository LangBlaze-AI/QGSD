#!/usr/bin/env node
'use strict';

/**
 * config-update.cjs
 *
 * Configuration update utilities for iteration limits and session management.
 * Provides functions to read/write max_iterations from .planning/config.json
 * and create session directories with random identifiers.
 *
 * Module exports:
 *   { getMaxIterations, updateMaxIterations, createSessionDirectory, parseMaxIterationsArg }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Get the maximum iterations limit from config.
 * Reads from .planning/config.json, falls back to 3 if key missing.
 *
 * @param {string} [projectRoot] - Project root directory (defaults to cwd parent)
 * @returns {number} Maximum iterations (default: 3)
 */
function getMaxIterations(projectRoot) {
  try {
    const root = projectRoot || path.join(__dirname, '..');
    const configPath = path.join(root, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const v = config.max_iterations;
    return (Number.isInteger(v) && v > 0) ? v : 3;
  } catch (_err) {
    // Fail-open: return default
    return 3;
  }
}

/**
 * Update the maximum iterations limit in .planning/config.json.
 * Writes atomically with 2-space indent and trailing newline.
 *
 * @param {number} value - New iteration limit (must be positive integer)
 * @param {string} [projectRoot] - Project root directory (defaults to cwd parent)
 * @throws {Error} If value is not a positive integer
 */
function updateMaxIterations(value, projectRoot) {
  const numValue = parseInt(value, 10);
  if (!Number.isInteger(numValue) || numValue <= 0) {
    throw new Error(`Invalid max_iterations value: ${value}. Must be a positive integer.`);
  }

  try {
    const root = projectRoot || path.join(__dirname, '..');
    const configPath = path.join(root, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config.max_iterations = numValue;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err) {
    throw new Error(`Failed to update max_iterations: ${err.message}`);
  }
}

/**
 * Create a session directory with random identifier.
 * Creates .planning/formal/.tmp/session-<hex16>/ if it doesn't exist.
 *
 * @param {string} [projectRoot] - Project root directory (defaults to cwd parent)
 * @returns {string} Absolute path to created session directory
 */
function createSessionDirectory(projectRoot) {
  try {
    const root = projectRoot || path.join(__dirname, '..');
    const tmpDir = path.join(root, '.planning', 'formal', '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });

    const sessionId = crypto.randomBytes(8).toString('hex');
    const sessionDir = path.join(tmpDir, 'session-' + sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    return sessionDir;
  } catch (err) {
    throw new Error(`Failed to create session directory: ${err.message}`);
  }
}

/**
 * Parse --max-iterations=N from argv array.
 * Returns parsed integer or null if not found.
 *
 * @param {string[]} [argv] - argv array (defaults to process.argv)
 * @returns {number|null} Parsed value or null if not found
 */
function parseMaxIterationsArg(argv) {
  const args = argv || process.argv;
  for (const arg of args) {
    if (typeof arg === 'string' && arg.startsWith('--max-iterations=')) {
      const value = arg.slice('--max-iterations='.length);
      const numValue = parseInt(value, 10);
      return Number.isInteger(numValue) && numValue > 0 ? numValue : null;
    }
  }
  return null;
}

// Module exports
module.exports = {
  getMaxIterations,
  updateMaxIterations,
  createSessionDirectory,
  parseMaxIterationsArg
};

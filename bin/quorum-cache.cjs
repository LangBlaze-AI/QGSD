'use strict';

/**
 * quorum-cache.cjs — Cache infrastructure for quorum results.
 *
 * Provides deterministic cache key computation (SHA-256), file-based read/write
 * with TTL validation, and invalidation logic based on git HEAD and quorum
 * composition changes.
 *
 * Cache files are stored in .planning/.quorum-cache/ (gitignored).
 * All operations fail-open: errors return null/undefined, never throw.
 */

const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Compute a deterministic SHA-256 cache key from quorum inputs.
 *
 * @param {string} prompt - The user prompt string
 * @param {string} context - Additional context string
 * @param {Array<{slot: string}>} slots - Slot objects with .slot property
 * @param {Array} configQuorumActive - quorum_active array from config
 * @param {string} gitHead - Current git HEAD hash
 * @returns {string} Full hex SHA-256 digest
 */
function computeCacheKey(prompt, context, slots, configQuorumActive, gitHead) {
  const sortedSlotNames = (Array.isArray(slots) ? slots : [])
    .filter(s => s && typeof s === 'object')
    .map(s => s.slot)
    .filter(s => s != null)
    .map(String)
    .sort()
    .join(',');

  const configHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(configQuorumActive || []))
    .digest('hex')
    .slice(0, 16);

  const payload = [
    String(prompt || ''),
    String(context || ''),
    sortedSlotNames,
    configHash,
    String(gitHead || ''),
  ].join('\x00');

  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Get current git HEAD hash.
 * Runs `git rev-parse HEAD` with a 3s timeout. Fail-open.
 *
 * @returns {string} Trimmed HEAD hash or empty string on failure
 */
function getGitHead() {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (result.stdout || '').trim();
  } catch (_) {
    return '';
  }
}

/**
 * Read a cache entry from disk.
 * Returns parsed entry if valid (version 1, not expired, has completed field).
 * Fail-open: returns null on any error or invalid state.
 *
 * @param {string} cacheKey - The cache key (hex digest)
 * @param {string} cacheDir - Directory containing cache files
 * @returns {object|null} Parsed cache entry or null
 */
function readCache(cacheKey, cacheDir) {
  try {
    const filePath = path.join(cacheDir, `${cacheKey}.json`);
    const raw = fs.readFileSync(filePath, 'utf8');
    const entry = JSON.parse(raw);

    // Version check
    if (entry.version !== 1) return null;

    // Must have completed field (pending entries are cache misses)
    if (!entry.completed) return null;

    // TTL check — reject entries with missing/invalid created or ttl
    const createdMs = new Date(entry.created).getTime();
    if (!Number.isFinite(createdMs) || typeof entry.ttl_ms !== 'number') return null;
    const age = Date.now() - createdMs;
    if (age > entry.ttl_ms) return null;

    return entry;
  } catch (_) {
    return null;
  }
}

/**
 * Write a cache entry to disk. Creates cacheDir if needed. Fail-open.
 *
 * @param {string} cacheKey - The cache key (hex digest)
 * @param {object} entry - Cache entry object
 * @param {string} cacheDir - Directory to write cache files
 */
function writeCache(cacheKey, entry, cacheDir) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const filePath = path.join(cacheDir, `${cacheKey}.json`);
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf8');
  } catch (_) {
    // Fail-open: swallow errors
  }
}

/**
 * Validate a cache entry against current state.
 * Returns false if git HEAD changed, quorum composition changed, or TTL expired.
 *
 * @param {object} entry - Cache entry to validate
 * @param {string} currentGitHead - Current git HEAD hash
 * @param {Array} currentQuorumActive - Current quorum_active config
 * @returns {boolean} True if cache entry is still valid
 */
function isCacheValid(entry, currentGitHead, currentQuorumActive) {
  if (!entry) return false;

  // Git HEAD must match
  if (entry.git_head !== currentGitHead) return false;

  // Quorum composition must match
  if (JSON.stringify(entry.quorum_active) !== JSON.stringify(currentQuorumActive)) return false;

  // TTL must not be expired
  const age = Date.now() - new Date(entry.created).getTime();
  if (age > entry.ttl_ms) return false;

  return true;
}

module.exports = { computeCacheKey, readCache, writeCache, getGitHead, isCacheValid };

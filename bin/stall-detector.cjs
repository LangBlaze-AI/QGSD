'use strict';
// bin/stall-detector.cjs
// Stall detection for quorum slots — INFORMATIONAL ONLY, never blocks.
// Uses only node:fs, node:path, node:child_process. No external dependencies.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Detect stalled quorum slots from quorum-failures.json.
 * @param {string} cwd - Project working directory.
 * @param {object} config - Config object (needs stall_detection section).
 * @returns {Array} Array of { slot, consecutiveTimeouts, lastSeen }.
 */
function detectStalledSlots(cwd, config) {
  try {
    let failuresPath;
    try {
      const planningPaths = require(path.join(__dirname, 'planning-paths.cjs'));
      failuresPath = planningPaths.resolveWithFallback(cwd, 'quorum-failures');
    } catch {
      failuresPath = path.join(cwd, '.planning', 'quorum', 'failures.json');
    }

    if (!fs.existsSync(failuresPath)) return [];

    const data = JSON.parse(fs.readFileSync(failuresPath, 'utf8'));
    if (!Array.isArray(data) || data.length === 0) return [];

    // Group records by slot (null prototype so slot names like '__proto__'/'constructor' are ordinary keys)
    const bySlot = Object.create(null);
    for (const record of data) {
      if (!record || typeof record !== 'object') continue;
      const slot = record.slot || record.slot_name || 'unknown';
      if (!bySlot[slot]) bySlot[slot] = [];
      bySlot[slot].push(record);
    }

    const results = [];
    for (const [slot, records] of Object.entries(bySlot)) {
      // Count consecutive TIMEOUT entries from the end
      let consecutive = 0;
      let lastSeen = null;
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        const reason = (r.reason || r.type || '').toUpperCase();
        if (reason === 'TIMEOUT') {
          consecutive++;
          if (!lastSeen) lastSeen = r.ts || r.timestamp || null;
        } else {
          break;
        }
      }
      if (consecutive >= 1) {
        results.push({ slot, consecutiveTimeouts: consecutive, lastSeen });
      }
    }

    return results;
  } catch {
    return []; // Fail-open
  }
}

/**
 * Determine if stall should be escalated to user.
 * @param {Array} stalledSlots - Output from detectStalledSlots.
 * @param {object} config - Config object.
 * @param {string} cwd - Project working directory.
 * @returns {object} Escalation result.
 */
function shouldEscalate(stalledSlots, config, cwd) {
  const stallCfg = (config && config.stall_detection) || {};
  const threshold = stallCfg.consecutive_threshold || 2;

  const list = Array.isArray(stalledSlots) ? stalledSlots : [];
  const filtered = list.filter(s => s && s.consecutiveTimeouts >= threshold);

  if (filtered.length === 0) {
    return { escalate: false, reason: 'below_threshold', stalledSlots: [] };
  }

  // Check for recent commit activity
  if (stallCfg.check_commits !== false) {
    try {
      const result = spawnSync('git', ['rev-list', '--count', 'HEAD', '--since=10 minutes ago'], {
        cwd: cwd || process.cwd(),
        timeout: 3000,
        encoding: 'utf8',
      });
      const count = parseInt(result.stdout.trim(), 10);
      if (count > 0) {
        return { escalate: false, reason: 'commits_active', stalledSlots: filtered };
      }
    } catch {
      // Fail-open: if git fails, proceed with escalation check
    }
  }

  return { escalate: true, stalledSlots: filtered };
}

/**
 * Format a structured stall report for additionalContext injection.
 * @param {object} escalationResult - Output from shouldEscalate.
 * @returns {object|null} Stall report or null.
 */
function formatStallReport(escalationResult) {
  if (!escalationResult || !escalationResult.escalate) return null;

  const slotNames = escalationResult.stalledSlots.map(s => s.slot).join(', ');

  return {
    type: 'stall_report',
    ts: new Date().toISOString(),
    stalled_slots: escalationResult.stalledSlots.map(s => ({
      slot: s.slot,
      consecutive_timeouts: s.consecutiveTimeouts,
      last_seen: s.lastSeen,
      recommendation: 'Check provider health: node bin/check-mcp-health.cjs',
    })),
    recommendation: 'Stalled slots detected with no new commits. Consider checking provider status or adjusting quorum composition.',
    message: `STALL DETECTED: ${escalationResult.stalledSlots.length} slot(s) stalled (${slotNames}). Run \`node bin/check-mcp-health.cjs\` to diagnose.`,
  };
}

module.exports = { detectStalledSlots, shouldEscalate, formatStallReport };

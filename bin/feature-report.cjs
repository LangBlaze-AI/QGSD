#!/usr/bin/env node
'use strict';

/**
 * feature-report.cjs
 *
 * Feature usefulness report generator for nForma.
 * Reads .planning/telemetry/feature-events.jsonl, aggregates per-feature metrics,
 * links bugs to detecting features, and generates narrative insights.
 *
 * Usage:
 *   node bin/feature-report.cjs [--json] [--since=30d] [--project-root=PATH]
 *
 * Exports:
 *   generateReport(root, opts) — for programmatic use (returns report object)
 */

const fs   = require('fs');
const path = require('path');

const { validateFeatureEvent, FEATURE_IDS } = require('./feature-telemetry-schema.cjs');
const pp = require('./planning-paths.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse --since=Nd or --since=Nh into milliseconds.
 * @param {string} since - e.g. '30d', '24h'
 * @returns {number} milliseconds
 */
function parseSince(since) {
  const m = String(since).match(/^(\d+)(d|h)$/);
  if (!m) return 30 * 24 * 60 * 60 * 1000; // default 30d
  const val = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === 'h') return val * 60 * 60 * 1000;
  return val * 24 * 60 * 60 * 1000;
}

/**
 * Compute percentile from sorted array.
 */
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Load and validate events from JSONL file.
 * @param {string} filePath - Path to feature-events.jsonl
 * @param {number} cutoffMs - Timestamp cutoff in epoch ms
 * @returns {{ events: object[], invalidCount: number }}
 */
function loadEvents(filePath, cutoffMs) {
  const events = [];
  let invalidCount = 0;

  if (!fs.existsSync(filePath)) {
    return { events, invalidCount };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalidCount++;
      continue;
    }

    const validation = validateFeatureEvent(parsed);
    if (!validation.valid) {
      invalidCount++;
      continue;
    }

    // Filter by time window
    const ts = new Date(parsed.timestamp).getTime();
    if (ts < cutoffMs) {
      continue;
    }

    events.push(parsed);
  }

  return { events, invalidCount };
}

/**
 * Aggregate per-feature metrics from events.
 * @param {object[]} events - Validated events
 * @returns {object} Map of feature_id -> metrics
 */
function generateMetrics(events) {
  const metrics = {};

  // Initialize all known features
  for (const id of FEATURE_IDS) {
    metrics[id] = {
      usage_count: 0,
      unique_sessions: 0,
      success_count: 0,
      failure_count: 0,
      success_rate: 0,
      avg_duration_ms: 0,
      p95_duration_ms: 0,
      _sessions: new Set(),
      _durations: [],
    };
  }

  for (const evt of events) {
    const id = evt.feature_id;
    if (!metrics[id]) {
      metrics[id] = {
        usage_count: 0,
        unique_sessions: 0,
        success_count: 0,
        failure_count: 0,
        success_rate: 0,
        avg_duration_ms: 0,
        p95_duration_ms: 0,
        _sessions: new Set(),
        _durations: [],
      };
    }

    const m = metrics[id];

    // Count usage: 'complete' or 'fail' actions
    if (evt.action === 'complete' || evt.action === 'fail') {
      m.usage_count++;
    }

    // Track sessions
    m._sessions.add(evt.session_id);

    // Track outcomes
    if (evt.outcome === 'success') m.success_count++;
    if (evt.outcome === 'failure') m.failure_count++;

    // Track durations
    if (typeof evt.duration_ms === 'number') {
      m._durations.push(evt.duration_ms);
    }
  }

  // Finalize computed metrics
  for (const [id, m] of Object.entries(metrics)) {
    m.unique_sessions = m._sessions.size;
    m.success_rate = m.usage_count > 0 ? m.success_count / m.usage_count : 0;
    m.avg_duration_ms = m._durations.length > 0
      ? Math.round(m._durations.reduce((a, b) => a + b, 0) / m._durations.length)
      : 0;
    m.p95_duration_ms = percentile(m._durations, 95);

    // Remove internal tracking fields
    delete m._sessions;
    delete m._durations;
  }

  return metrics;
}

/**
 * Generate bug linkage from events with bug_link field.
 * @param {object[]} events - Validated events
 * @returns {{ bugs: object[] }}
 */
function generateBugLinks(events) {
  const bugMap = Object.create(null);

  for (const evt of events) {
    if (!evt.bug_link) continue;

    const url = evt.bug_link.issue_url;
    if (!bugMap[url]) {
      bugMap[url] = {
        issue_url: url,
        detection_type: evt.bug_link.detection_type,
        features: new Set(),
        first_detected: evt.timestamp,
      };
    }

    bugMap[url].features.add(evt.feature_id);

    // Track earliest timestamp
    if (evt.timestamp < bugMap[url].first_detected) {
      bugMap[url].first_detected = evt.timestamp;
    }
  }

  const bugs = Object.values(bugMap).map(b => ({
    issue_url: b.issue_url,
    detection_type: b.detection_type,
    features: [...b.features],
    first_detected: b.first_detected,
  }));

  return { bugs };
}

/**
 * Generate narrative insights from metrics and bug links.
 * @param {object} metrics - Per-feature metrics
 * @param {{ bugs: object[] }} bugLinks - Bug linkage data
 * @param {string} window - Time window string (e.g. '30d')
 * @returns {string[]} Array of insight strings
 */
function generateInsights(metrics, bugLinks, window) {
  const insights = [];

  // Check if there are any events at all
  const totalUsage = Object.values(metrics).reduce((sum, m) => sum + m.usage_count, 0);
  if (totalUsage === 0) {
    insights.push('No feature telemetry events found. Emit events using createFeatureEvent() from feature-telemetry-schema.cjs to start tracking.');
    return insights;
  }

  // Find top feature by usage
  let topFeature = null;
  let topUsage = 0;
  for (const [id, m] of Object.entries(metrics)) {
    if (m.usage_count > topUsage) {
      topUsage = m.usage_count;
      topFeature = id;
    }
  }

  if (topFeature && topUsage > 0) {
    const rate = Math.round(metrics[topFeature].success_rate * 100);
    insights.push(`Feature '${topFeature}' is the most-used feature with ${topUsage} invocations and ${rate}% success rate`);
  }

  // High failure rates (>50%)
  for (const [id, m] of Object.entries(metrics)) {
    if (m.usage_count > 0 && m.success_rate < 0.5) {
      const failRate = Math.round((1 - m.success_rate) * 100);
      insights.push(`Feature '${id}' has a ${failRate}% failure rate over ${m.usage_count} uses — investigate recurring failures`);
    }
  }

  // Bug catchers
  const featureBugCounts = {};
  for (const bug of bugLinks.bugs) {
    for (const fid of bug.features) {
      featureBugCounts[fid] = (featureBugCounts[fid] || 0) + 1;
    }
  }
  for (const [id, count] of Object.entries(featureBugCounts)) {
    const bugUrls = bugLinks.bugs
      .filter(b => b.features.includes(id))
      .map(b => b.issue_url);
    insights.push(`Feature '${id}' detected ${count} bugs including ${bugUrls[0]} — demonstrating strong defect detection`);
  }

  // Unused features
  for (const [id, m] of Object.entries(metrics)) {
    if (m.usage_count === 0 && m.unique_sessions === 0) {
      insights.push(`Feature '${id}' had 0 uses in the last ${window} — consider if it needs promotion or removal`);
    }
  }

  // Performance outliers
  const allP95 = Object.values(metrics).filter(m => m.p95_duration_ms > 0).map(m => m.p95_duration_ms);
  if (allP95.length > 0) {
    const avgP95 = allP95.reduce((a, b) => a + b, 0) / allP95.length;
    for (const [id, m] of Object.entries(metrics)) {
      if (m.p95_duration_ms > 0 && avgP95 > 0 && m.p95_duration_ms > avgP95 * 3) {
        const multiplier = Math.round(m.p95_duration_ms / avgP95 * 10) / 10;
        insights.push(`Feature '${id}' p95 duration is ${m.p95_duration_ms}ms — ${multiplier}x slower than average feature`);
      }
    }
  }

  return insights;
}

/**
 * Generate the full feature usefulness report.
 * @param {string} root - Project root directory
 * @param {object} opts - { since?: string, json?: boolean }
 * @returns {object} Report object
 */
function generateReport(root, opts = {}) {
  if (!opts || typeof opts !== 'object') opts = {};
  const since = opts.since || '30d';
  const sinceMs = parseSince(since);
  const cutoffMs = Date.now() - sinceMs;

  // Resolve events file path
  const eventsPath = pp.resolveWithFallback(root, 'feature-events');

  // Load and validate events
  const { events, invalidCount } = loadEvents(eventsPath, cutoffMs);

  // Generate metrics
  const metrics = generateMetrics(events);

  // Generate bug links
  const bugLinks = generateBugLinks(events);

  // Generate insights
  const insights = generateInsights(metrics, bugLinks, since);

  return {
    generated_at: new Date().toISOString(),
    time_window: since,
    total_events: events.length,
    invalid_events: invalidCount,
    features: metrics,
    bug_links: bugLinks.bugs,
    insights,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const jsonFlag = args.includes('--json');
    const sinceArg = args.find(a => a.startsWith('--since='));
    const rootArg = args.find(a => a.startsWith('--project-root='));

    const since = sinceArg ? sinceArg.split('=')[1] : '30d';
    const root = rootArg ? rootArg.split('=')[1] : process.cwd();

    const report = generateReport(root, { since, json: jsonFlag });

    if (jsonFlag) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      // Human-readable output
      process.stdout.write(`\n═══ Feature Usefulness Report ═══\n`);
      process.stdout.write(`Generated: ${report.generated_at}\n`);
      process.stdout.write(`Time window: ${report.time_window}\n`);
      process.stdout.write(`Total events: ${report.total_events} (${report.invalid_events} invalid skipped)\n\n`);

      // Per-feature metrics table
      process.stdout.write(`── Per-Feature Metrics ──\n`);
      process.stdout.write(`${'Feature'.padEnd(25)} ${'Uses'.padStart(6)} ${'Sessions'.padStart(10)} ${'Success%'.padStart(10)} ${'Avg(ms)'.padStart(10)} ${'P95(ms)'.padStart(10)}\n`);
      process.stdout.write(`${'─'.repeat(25)} ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)}\n`);

      for (const [id, m] of Object.entries(report.features)) {
        if (m.usage_count > 0 || m.unique_sessions > 0) {
          const rate = Math.round(m.success_rate * 100);
          process.stdout.write(`${id.padEnd(25)} ${String(m.usage_count).padStart(6)} ${String(m.unique_sessions).padStart(10)} ${(rate + '%').padStart(10)} ${String(m.avg_duration_ms).padStart(10)} ${String(m.p95_duration_ms).padStart(10)}\n`);
        }
      }

      // Bug linkage
      if (report.bug_links.length > 0) {
        process.stdout.write(`\n── Bug Linkage ──\n`);
        for (const bug of report.bug_links) {
          process.stdout.write(`  ${bug.detection_type}: ${bug.issue_url} (by ${bug.features.join(', ')})\n`);
        }
      }

      // Insights
      if (report.insights.length > 0) {
        process.stdout.write(`\n── Insights ──\n`);
        report.insights.forEach((insight, i) => {
          process.stdout.write(`  ${i + 1}. ${insight}\n`);
        });
      }

      process.stdout.write('\n');
    }
  } catch (err) {
    process.stderr.write(`[feature-report] Error: ${err.message}\n`);
    // Fail-open: output empty report on error
    process.stdout.write(JSON.stringify({
      generated_at: new Date().toISOString(),
      time_window: '30d',
      total_events: 0,
      invalid_events: 0,
      features: {},
      bug_links: [],
      insights: [],
    }, null, 2) + '\n');
  }
}

module.exports = { generateReport };

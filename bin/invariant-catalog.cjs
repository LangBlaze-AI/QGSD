#!/usr/bin/env node
'use strict';
// bin/invariant-catalog.cjs
// Builds a unified invariant catalog aggregating declared (TLA+ .cfg, spec/invariants.md)
// and observed (trace-mined) invariants into a queryable JSON catalog.
// Requirements: SEM-01
//
// Usage:
//   node bin/invariant-catalog.cjs            # print summary to stdout
//   node bin/invariant-catalog.cjs --json     # print full catalog JSON to stdout

const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const FORMAL = path.join(ROOT, '.planning', 'formal');
const TLA_DIR = path.join(FORMAL, 'tla');
const SPEC_DIR = path.join(FORMAL, 'spec');
const OUT_DIR = path.join(FORMAL, 'semantics');
const OUT_FILE = path.join(OUT_DIR, 'invariant-catalog.json');
const CONFORMANCE_PATH = path.join(ROOT, '.planning', 'telemetry', 'conformance-events.jsonl');
const TRACE_STATS_PATH = path.join(FORMAL, 'evidence', 'trace-corpus-stats.json');

const JSON_FLAG = process.argv.includes('--json');

// ── Source A: TLC .cfg files ─────────────────────────────────────────────────

function parseCfgFiles() {
  const invariants = [];
  const cfgFiles = fs.readdirSync(TLA_DIR).filter(f => f.startsWith('MC') && f.endsWith('.cfg'));

  for (const cfgFile of cfgFiles) {
    const content = fs.readFileSync(path.join(TLA_DIR, cfgFile), 'utf8');
    const lines = content.split('\n');
    const config = cfgFile.replace(/\.cfg$/, '');
    let inBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Single-line: INVARIANT Name
      const singleMatch = trimmed.match(/^INVARIANT\s+(\S+)$/);
      if (singleMatch) {
        invariants.push({
          name: singleMatch[1],
          source: 'tla_cfg',
          source_file: `tla/${cfgFile}`,
          type: 'declared',
          formalism: 'tla',
          config,
        });
        continue;
      }

      // Single-line: PROPERTY Name
      const propMatch = trimmed.match(/^PROPERTY\s+(\S+)$/);
      if (propMatch) {
        invariants.push({
          name: propMatch[1],
          source: 'tla_cfg',
          source_file: `tla/${cfgFile}`,
          type: 'declared',
          formalism: 'tla',
          config,
        });
        continue;
      }

      // Block: INVARIANTS keyword
      if (trimmed === 'INVARIANTS') {
        inBlock = true;
        continue;
      }

      // Block: PROPERTIES keyword
      if (trimmed === 'PROPERTIES') {
        inBlock = true;
        continue;
      }

      // End block on next keyword, empty line, or non-indented line
      if (inBlock) {
        const isIndented = line.length > 0 && (line[0] === ' ' || line[0] === '\t');
        if (!trimmed || (!isIndented && /^[A-Z]/.test(trimmed))) {
          inBlock = false;
          // re-process this line (might be a keyword)
          if (trimmed.match(/^INVARIANT\s*/)) i--;
          else if (trimmed.match(/^PROPERTY\s*/)) i--;
          else if (trimmed.match(/^SPECIFICATION\s*/)) { /* skip */ }
          else if (trimmed.match(/^CONSTANTS?\s*/)) { /* skip */ }
          else if (trimmed.match(/^CONSTRAINT\s*/)) { /* skip */ }
          else if (trimmed.match(/^CHECK_DEADLOCK\s*/)) { /* skip */ }
          continue;
        }
        invariants.push({
          name: trimmed,
          source: 'tla_cfg',
          source_file: `tla/${cfgFile}`,
          type: 'declared',
          formalism: 'tla',
          config,
        });
      }
    }
  }
  return invariants;
}

// ── Source B: spec/*/invariants.md files ──────────────────────────────────────

function parseSpecInvariants() {
  const invariants = [];
  if (!fs.existsSync(SPEC_DIR)) return invariants;

  const specDirs = fs.readdirSync(SPEC_DIR).filter(d =>
    fs.statSync(path.join(SPEC_DIR, d)).isDirectory()
  );

  for (const dir of specDirs) {
    const invFile = path.join(SPEC_DIR, dir, 'invariants.md');
    if (!fs.existsSync(invFile)) continue;

    const content = fs.readFileSync(invFile, 'utf8');
    const lines = content.split('\n');
    let currentName = null;
    let propertyExpr = null;

    for (const line of lines) {
      // ## section headers = invariant names
      const headerMatch = line.match(/^##\s+(.+)$/);
      if (headerMatch) {
        // Save previous if exists
        if (currentName) {
          const formalism = (propertyExpr && /(<>|PROPERTY|liveness|LivenessProperty|Reachable|Eventually|Terminates|Progress)/i.test(propertyExpr || currentName))
            ? 'liveness' : 'safety';
          invariants.push({
            name: currentName,
            source: 'spec_invariants_md',
            source_file: `spec/${dir}/invariants.md`,
            type: 'declared',
            formalism,
            property_expression: propertyExpr || null,
          });
        }
        currentName = headerMatch[1].trim();
        propertyExpr = null;
        continue;
      }

      // **Property:** `expression`
      const propMatch = line.match(/\*\*Property:\*\*\s*`([^`]+)`/);
      if (propMatch && currentName) {
        propertyExpr = propMatch[1];
      }
    }

    // Save last entry
    if (currentName) {
      const formalism = (propertyExpr && /<>|PROPERTY|liveness|LivenessProperty|Reachable|Eventually|Terminates|Progress/i.test(propertyExpr || currentName))
        ? 'liveness' : 'safety';
      invariants.push({
        name: currentName,
        source: 'spec_invariants_md',
        source_file: `spec/${dir}/invariants.md`,
        type: 'declared',
        formalism,
        property_expression: propertyExpr || null,
      });
    }
  }
  return invariants;
}

// ── Source C: Observed invariants (curated trace checks) ─────────────────────

function mineObservedInvariants() {
  const invariants = [];

  // Load trace-corpus-stats.json for aggregate data
  let traceStats = null;
  if (fs.existsSync(TRACE_STATS_PATH)) {
    try {
      traceStats = JSON.parse(fs.readFileSync(TRACE_STATS_PATH, 'utf8'));
    } catch {
      traceStats = null; /* corrupt trace stats -> treat as unavailable */
    }
  }

  // Load conformance-events.jsonl for sequence-based checks
  let events = [];
  if (fs.existsSync(CONFORMANCE_PATH)) {
    const raw = fs.readFileSync(CONFORMANCE_PATH, 'utf8').trim().split('\n');
    for (const line of raw) {
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }

  if (!traceStats && events.length === 0) {
    process.stderr.write('Warning: No trace data available for observed invariants\n');
    return invariants;
  }

  const totalSessions = traceStats ? traceStats.sessions.length : 0;

  // Check 1: quorum_start always precedes quorum_complete within a session
  // Requires conformance-events.jsonl for event ordering per session
  if (events.length > 0 && traceStats) {
    let holds = true;
    let sessionsChecked = 0;

    for (const session of traceStats.sessions) {
      const sessionStart = new Date(session.start).getTime();
      const sessionEnd = new Date(session.end).getTime();
      const sessionEvents = events.filter(e => {
        const t = new Date(e.ts).getTime();
        return t >= sessionStart && t <= sessionEnd;
      });

      const relevant = sessionEvents.filter(e =>
        e.action === 'quorum_start' || e.action === 'quorum_complete'
      );

      let startCount = 0;
      for (const evt of relevant) {
        if (evt.action === 'quorum_start') startCount++;
        if (evt.action === 'quorum_complete') {
          if (startCount === 0) { holds = false; break; }
        }
      }
      if (!holds) break;
      sessionsChecked++;
    }

    if (holds) {
      invariants.push({
        name: 'quorum_start_precedes_complete',
        source: 'trace_mining',
        type: 'observed',
        property_expression: 'quorum_start always precedes quorum_complete within a session',
        confidence: 'curated',
        evidence_sessions: sessionsChecked,
      });
    }
  }

  // Check 2: circuit_break events only occur during active quorum sessions
  // Requires conformance-events.jsonl to check session context
  if (events.length > 0 && traceStats) {
    let holds = true;
    let sessionsChecked = 0;

    for (const session of traceStats.sessions) {
      const sessionStart = new Date(session.start).getTime();
      const sessionEnd = new Date(session.end).getTime();
      const sessionEvents = events.filter(e => {
        const t = new Date(e.ts).getTime();
        return t >= sessionStart && t <= sessionEnd;
      });

      const circuitBreaks = sessionEvents.filter(e => e.action === 'circuit_break');
      const hasQuorumStart = sessionEvents.some(e => e.action === 'quorum_start');

      if (circuitBreaks.length > 0 && !hasQuorumStart) {
        holds = false;
        break;
      }
      sessionsChecked++;
    }

    if (holds) {
      invariants.push({
        name: 'circuit_break_within_quorum_session',
        source: 'trace_mining',
        type: 'observed',
        property_expression: 'circuit_break events only occur during active quorum sessions',
        confidence: 'curated',
        evidence_sessions: sessionsChecked,
      });
    }
  }

  // Check 3: no session has more quorum_complete than quorum_start
  // Can use trace-corpus-stats.json aggregate counts
  if (traceStats) {
    let holds = true;
    let sessionsChecked = 0;

    for (const session of traceStats.sessions) {
      const starts = session.actions.quorum_start || 0;
      const completes = session.actions.quorum_complete || 0;
      if (completes > starts) {
        holds = false;
        break;
      }
      sessionsChecked++;
    }

    if (holds) {
      invariants.push({
        name: 'complete_bounded_by_start',
        source: 'trace_mining',
        type: 'observed',
        property_expression: 'no session has more quorum_complete events than quorum_start events',
        confidence: 'curated',
        evidence_sessions: sessionsChecked,
      });
    }
  }

  // Check 4: sessions with quorum_complete also have quorum_block
  // Requires trace-corpus-stats.json -- quorum must block before completing
  if (traceStats) {
    let holds = true;
    let sessionsChecked = 0;

    for (const session of traceStats.sessions) {
      const blocks = (session.actions.quorum_block || 0) + (session.actions.quorum_block_r3_2 || 0);
      const completes = session.actions.quorum_complete || 0;
      if (completes > 0 && blocks === 0) {
        holds = false;
        break;
      }
      sessionsChecked++;
    }

    if (holds) {
      invariants.push({
        name: 'complete_requires_block',
        source: 'trace_mining',
        type: 'observed',
        property_expression: 'sessions with quorum_complete also have quorum_block events',
        confidence: 'curated',
        evidence_sessions: sessionsChecked,
      });
    }
  }

  // Check 5: event action counts are consistent (sum of actions = event_count)
  // Requires trace-corpus-stats.json -- structural data integrity check
  if (traceStats) {
    let holds = true;
    let sessionsChecked = 0;

    for (const session of traceStats.sessions) {
      const sum = Object.values(session.actions).reduce((a, b) => a + b, 0);
      if (sum !== session.event_count) {
        holds = false;
        break;
      }
      sessionsChecked++;
    }

    if (holds) {
      invariants.push({
        name: 'action_count_consistency',
        source: 'trace_mining',
        type: 'observed',
        property_expression: 'sum of per-action counts equals total event_count for every session',
        confidence: 'curated',
        evidence_sessions: sessionsChecked,
      });
    }
  }

  return invariants;
}

// ── Deduplication ────────────────────────────────────────────────────────────

function deduplicateInvariants(rawInvariants) {
  const map = new Map();
  if (!Array.isArray(rawInvariants)) return [];

  for (const inv of rawInvariants) {
    if (!inv || typeof inv !== 'object') continue;
    // For tla_cfg: deduplicate by (name, config/model)
    // For others: deduplicate by (name, source)
    const modelKey = inv.config || inv.source_file || inv.source;
    const key = `${inv.name}::${modelKey}`;

    if (map.has(key)) {
      const existing = map.get(key);
      if (!existing.check_references) {
        existing.check_references = [existing.source_file || existing.source];
      }
      existing.check_references.push(inv.source_file || inv.source);
    } else {
      map.set(key, { ...inv });
    }
  }

  return [...map.values()];
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const cfgInvariants = parseCfgFiles();
  const specInvariants = parseSpecInvariants();
  const observedInvariants = mineObservedInvariants();

  const allRaw = [...cfgInvariants, ...specInvariants, ...observedInvariants];
  const deduped = deduplicateInvariants(allRaw);

  const byType = { declared: 0, observed: 0 };
  const bySource = { tla_cfg: 0, spec_invariants_md: 0, trace_mining: 0 };

  for (const inv of deduped) {
    byType[inv.type] = (byType[inv.type] || 0) + 1;
    bySource[inv.source] = (bySource[inv.source] || 0) + 1;
  }

  const catalog = {
    schema_version: '1',
    generated: new Date().toISOString(),
    invariants: deduped,
    summary: {
      total_raw: allRaw.length,
      total_deduplicated: deduped.length,
      by_type: byType,
      by_source: bySource,
    },
  };

  // Ensure output directory exists
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(catalog, null, 2) + '\n');

  if (JSON_FLAG) {
    process.stdout.write(JSON.stringify(catalog, null, 2) + '\n');
  } else {
    console.log(`Invariant Catalog written to ${path.relative(ROOT, OUT_FILE)}`);
    console.log(`  Raw: ${allRaw.length}  Deduplicated: ${deduped.length}`);
    console.log(`  By type:   declared=${byType.declared}  observed=${byType.observed}`);
    console.log(`  By source: tla_cfg=${bySource.tla_cfg}  spec_invariants_md=${bySource.spec_invariants_md}  trace_mining=${bySource.trace_mining}`);
  }
}

// Export for testing
module.exports = { parseCfgFiles, parseSpecInvariants, mineObservedInvariants, deduplicateInvariants };

if (require.main === module) main();

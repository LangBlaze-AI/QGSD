#!/usr/bin/env node
'use strict';
// bin/design-impact.test.cjs
// Tests for bin/design-impact.cjs — three-layer git diff impact analysis

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseGitDiff, parseDiffLineRanges, analyzeImpact, analyzeL1, analyzeL2, analyzeL3, isLineInRanges } = require('./design-impact.cjs');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_DIFF = `diff --git a/hooks/nf-prompt.js b/hooks/nf-prompt.js
--- a/hooks/nf-prompt.js
+++ b/hooks/nf-prompt.js
@@ -630,4 +630,6 @@ function quorumStart() {
+  // new code at line 634
+  doSomething();
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
+# Updated readme`;

const SAMPLE_INSTRUMENTATION_MAP = {
  emission_points: [
    { file: 'hooks/nf-prompt.js', line_number: 531, action: 'quorum_fallback_t1_required', xstate_event: null },
    { file: 'hooks/nf-prompt.js', line_number: 634, action: 'quorum_start', xstate_event: 'QUORUM_START' },
    { file: 'hooks/nf-stop.js', line_number: 472, action: 'quorum_complete', xstate_event: 'VOTES_COLLECTED' },
    { file: 'hooks/nf-stop.js', line_number: 531, action: 'quorum_block', xstate_event: 'BLOCK_DECISION' },
    { file: 'hooks/nf-circuit-breaker.js', line_number: 665, action: 'circuit_break', xstate_event: 'CIRCUIT_BREAK' },
  ],
};

const SAMPLE_FSM = {
  observed_transitions: {
    IDLE: {
      QUORUM_START: { to_state: 'COLLECTING_VOTES', count: 12453 },
      CIRCUIT_BREAK: { to_state: 'IDLE', count: 6429 },
    },
    COLLECTING_VOTES: {
      QUORUM_START: { to_state: 'COLLECTING_VOTES', count: 2499 },
      VOTES_COLLECTED: { to_state: 'DELIBERATING', count: 162 },
    },
    DELIBERATING: {
      DECIDE: { to_state: 'DECIDED', count: 159 },
    },
  },
};

const SAMPLE_HAZARD_MODEL = {
  hazards: [
    { id: 'HAZARD-IDLE-QUORUM_START', state: 'IDLE', event: 'QUORUM_START', rpn: 80, severity: 4 },
    { id: 'HAZARD-IDLE-CIRCUIT_BREAK', state: 'IDLE', event: 'CIRCUIT_BREAK', rpn: 120, severity: 6 },
    { id: 'HAZARD-COLLECTING_VOTES-QUORUM_START', state: 'COLLECTING_VOTES', event: 'QUORUM_START', rpn: 80, severity: 4 },
    { id: 'HAZARD-DELIBERATING-DECIDE', state: 'DELIBERATING', event: 'DECIDE', rpn: 96, severity: 8 },
  ],
};

const SAMPLE_FAILURE_MODES = {
  failure_modes: [
    { id: 'FM-IDLE-QUORUM_START-OMISSION', state: 'IDLE', event: 'QUORUM_START', failure_mode: 'omission', severity_class: 'degraded' },
    { id: 'FM-IDLE-CIRCUIT_BREAK-OMISSION', state: 'IDLE', event: 'CIRCUIT_BREAK', failure_mode: 'omission', severity_class: 'stalled' },
    { id: 'FM-DELIBERATING-DECIDE-OMISSION', state: 'DELIBERATING', event: 'DECIDE', failure_mode: 'omission', severity_class: 'stalled' },
  ],
};

// ---------------------------------------------------------------------------
// Unit: parseGitDiff
// ---------------------------------------------------------------------------

describe('parseGitDiff', () => {
  it('extracts file names from diff --git and +++ lines', () => {
    const files = parseGitDiff(SAMPLE_DIFF);
    assert.ok(files.includes('hooks/nf-prompt.js'));
    assert.ok(files.includes('README.md'));
    assert.equal(files.length, 2);
  });

  it('returns empty array for empty diff', () => {
    const files = parseGitDiff('');
    assert.deepEqual(files, []);
  });

  it('handles binary file markers without errors', () => {
    const diff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
diff --git a/hooks/nf-prompt.js b/hooks/nf-prompt.js
--- a/hooks/nf-prompt.js
+++ b/hooks/nf-prompt.js
@@ -1,2 +1,3 @@
+added line`;
    const files = parseGitDiff(diff);
    assert.ok(files.includes('image.png'));
    assert.ok(files.includes('hooks/nf-prompt.js'));
  });
});

// ---------------------------------------------------------------------------
// Unit: parseDiffLineRanges
// ---------------------------------------------------------------------------

describe('parseDiffLineRanges', () => {
  it('extracts line ranges from @@ hunk headers', () => {
    const ranges = parseDiffLineRanges(SAMPLE_DIFF);
    const promptRanges = ranges.get('hooks/nf-prompt.js');
    assert.ok(promptRanges, 'should have ranges for nf-prompt.js');
    assert.equal(promptRanges.length, 1);
    assert.equal(promptRanges[0].start, 630);
    assert.equal(promptRanges[0].count, 6);
  });

  it('handles hunk without count (single line)', () => {
    const diff = `+++ b/foo.js
@@ -5 +5 @@ context`;
    const ranges = parseDiffLineRanges(diff);
    const fooRanges = ranges.get('foo.js');
    assert.ok(fooRanges);
    assert.equal(fooRanges[0].start, 5);
    assert.equal(fooRanges[0].count, 1);
  });

  it('returns empty map for empty diff', () => {
    const ranges = parseDiffLineRanges('');
    assert.equal(ranges.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Unit: isLineInRanges
// ---------------------------------------------------------------------------

describe('isLineInRanges', () => {
  it('returns true when line is within a range', () => {
    assert.equal(isLineInRanges(632, [{ start: 630, count: 6 }]), true);
  });

  it('returns false when line is outside ranges', () => {
    assert.equal(isLineInRanges(100, [{ start: 630, count: 6 }]), false);
  });

  it('returns false for empty ranges', () => {
    assert.equal(isLineInRanges(100, []), false);
  });

  it('returns false for null/undefined ranges', () => {
    assert.equal(isLineInRanges(100, null), false);
  });
});

// ---------------------------------------------------------------------------
// Unit: L1 matching
// ---------------------------------------------------------------------------

describe('L1 impact analysis', () => {
  it('finds emission points for instrumented files', () => {
    const changedFiles = ['hooks/nf-prompt.js'];
    const lineRanges = new Map([['hooks/nf-prompt.js', [{ start: 630, count: 6 }]]]);
    const l1 = analyzeL1(changedFiles, lineRanges, SAMPLE_INSTRUMENTATION_MAP);

    assert.equal(l1.affected_emission_points, 2); // both emission points in nf-prompt.js
    assert.ok(l1.direct_hits >= 1); // line 634 is within 630-636
    assert.ok(l1.details.some(d => d.action === 'quorum_start' && d.impact_type === 'direct'));
    assert.ok(l1.details.some(d => d.action === 'quorum_fallback_t1_required' && d.impact_type === 'file_level'));
  });

  it('returns empty for non-instrumented files (docs, tests)', () => {
    const changedFiles = ['README.md', 'docs/guide.md', 'tests/foo.test.js'];
    const lineRanges = new Map();
    const l1 = analyzeL1(changedFiles, lineRanges, SAMPLE_INSTRUMENTATION_MAP);

    assert.equal(l1.affected_emission_points, 0);
    assert.equal(l1.direct_hits, 0);
    assert.deepEqual(l1.details, []);
  });
});

// ---------------------------------------------------------------------------
// Unit: L2 chaining
// ---------------------------------------------------------------------------

describe('L2 impact analysis', () => {
  it('finds transitions for affected xstate_events', () => {
    const l1 = {
      details: [
        { xstate_event: 'QUORUM_START', action: 'quorum_start' },
      ],
    };
    const l2 = analyzeL2(l1, SAMPLE_FSM);

    assert.ok(l2.affected_transitions > 0);
    assert.ok(l2.affected_events.includes('QUORUM_START'));
    assert.ok(l2.details.some(t => t.state === 'IDLE' && t.event === 'QUORUM_START'));
    assert.ok(l2.details.some(t => t.state === 'COLLECTING_VOTES' && t.event === 'QUORUM_START'));
  });

  it('skips emission points with null xstate_event', () => {
    const l1 = {
      details: [
        { xstate_event: null, action: 'quorum_fallback_t1_required' },
      ],
    };
    const l2 = analyzeL2(l1, SAMPLE_FSM);
    assert.equal(l2.affected_transitions, 0);
  });
});

// ---------------------------------------------------------------------------
// Unit: L3 chaining
// ---------------------------------------------------------------------------

describe('L3 impact analysis', () => {
  it('finds hazards for affected state-event pairs', () => {
    const l2 = {
      details: [
        { state: 'IDLE', event: 'QUORUM_START', to_state: 'COLLECTING_VOTES', count: 12453 },
      ],
    };
    const l3 = analyzeL3(l2, SAMPLE_HAZARD_MODEL, SAMPLE_FAILURE_MODES);

    assert.ok(l3.affected_hazards >= 1);
    assert.ok(l3.details.some(h => h.hazard_id === 'HAZARD-IDLE-QUORUM_START'));
    assert.equal(l3.max_rpn, 80);
    assert.ok(l3.affected_failure_modes >= 1);
    assert.ok(l3.failure_mode_details.some(fm => fm.id === 'FM-IDLE-QUORUM_START-OMISSION'));
  });

  it('excludes hazards for non-affected state-event pairs', () => {
    const l2 = {
      details: [
        { state: 'DELIBERATING', event: 'DECIDE', to_state: 'DECIDED', count: 159 },
      ],
    };
    const l3 = analyzeL3(l2, SAMPLE_HAZARD_MODEL, SAMPLE_FAILURE_MODES);

    // Should find DELIBERATING-DECIDE hazard but NOT IDLE-QUORUM_START
    assert.ok(l3.details.every(h => h.state === 'DELIBERATING'));
    assert.ok(!l3.details.some(h => h.hazard_id === 'HAZARD-IDLE-QUORUM_START'));
  });
});

// ---------------------------------------------------------------------------
// Unit: no-impact case
// ---------------------------------------------------------------------------

describe('no-impact case', () => {
  it('produces explicit zero-impact report for docs-only diff', () => {
    const report = analyzeImpact({
      changedFiles: ['README.md', 'docs/guide.md'],
      lineRanges: new Map(),
      instrumentationMap: SAMPLE_INSTRUMENTATION_MAP,
      observedFsm: SAMPLE_FSM,
      hazardModel: SAMPLE_HAZARD_MODEL,
      failureModeCatalog: SAMPLE_FAILURE_MODES,
    });

    assert.equal(report.l1_impact.affected_emission_points, 0);
    assert.equal(report.l2_impact.affected_transitions, 0);
    assert.equal(report.l3_impact.affected_hazards, 0);
    assert.equal(report.summary, 'No instrumented files affected by this change');
  });
});

// ---------------------------------------------------------------------------
// Integration: full three-layer chain
// ---------------------------------------------------------------------------

describe('analyzeImpact integration', () => {
  it('chains through all 3 layers with synthetic diff data', () => {
    const changedFiles = ['hooks/nf-prompt.js'];
    const lineRanges = new Map([['hooks/nf-prompt.js', [{ start: 630, count: 6 }]]]);

    const report = analyzeImpact({
      changedFiles,
      lineRanges,
      instrumentationMap: SAMPLE_INSTRUMENTATION_MAP,
      observedFsm: SAMPLE_FSM,
      hazardModel: SAMPLE_HAZARD_MODEL,
      failureModeCatalog: SAMPLE_FAILURE_MODES,
    });

    // L1: should find emission points in nf-prompt.js
    assert.ok(report.l1_impact.affected_emission_points >= 1);
    assert.ok(report.l1_impact.direct_hits >= 1);

    // L2: QUORUM_START event should chain to state transitions
    assert.ok(report.l2_impact.affected_transitions >= 1);
    assert.ok(report.l2_impact.affected_events.includes('QUORUM_START'));

    // L3: should chain to hazards
    assert.ok(report.l3_impact.affected_hazards >= 1);
    assert.ok(report.l3_impact.max_rpn > 0);

    // Schema
    assert.equal(report.schema_version, '1');
    assert.ok(report.generated);
    assert.equal(report.changed_files, 1);
    assert.ok(report.summary.includes('emission point'));
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles empty diff (no files changed)', () => {
    const report = analyzeImpact({
      changedFiles: [],
      lineRanges: new Map(),
      instrumentationMap: SAMPLE_INSTRUMENTATION_MAP,
      observedFsm: SAMPLE_FSM,
      hazardModel: SAMPLE_HAZARD_MODEL,
      failureModeCatalog: SAMPLE_FAILURE_MODES,
    });

    assert.equal(report.changed_files, 0);
    assert.equal(report.l1_impact.affected_emission_points, 0);
    assert.equal(report.summary, 'No instrumented files affected by this change');
  });

  it('handles diff with only non-instrumented files', () => {
    const report = analyzeImpact({
      changedFiles: ['package.json', 'tsconfig.json', '.gitignore'],
      lineRanges: new Map(),
      instrumentationMap: SAMPLE_INSTRUMENTATION_MAP,
      observedFsm: SAMPLE_FSM,
      hazardModel: SAMPLE_HAZARD_MODEL,
      failureModeCatalog: SAMPLE_FAILURE_MODES,
    });

    assert.equal(report.l1_impact.affected_emission_points, 0);
    assert.equal(report.l2_impact.affected_transitions, 0);
    assert.equal(report.l3_impact.affected_hazards, 0);
  });

  it('handles binary file markers in git diff without parse errors', () => {
    const binaryDiff = `diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ`;

    const files = parseGitDiff(binaryDiff);
    assert.ok(files.includes('logo.png'));

    const ranges = parseDiffLineRanges(binaryDiff);
    // Binary files have no hunk headers
    assert.equal(ranges.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Hardening: malformed-but-parseable formal artifacts (fail-open contract)
// ---------------------------------------------------------------------------

describe('L1 malformed instrumentation hardening', () => {
  it('does not crash on a null emission point entry', () => {
    const map = { emission_points: [null, { file: 'hooks/nf-prompt.js', line_number: 1, action: 'a', xstate_event: null }] };
    let l1;
    assert.doesNotThrow(() => { l1 = analyzeL1(['hooks/nf-prompt.js'], new Map(), map); });
    assert.equal(l1.affected_emission_points, 1);
  });
});

describe('L2 malformed FSM hardening', () => {
  it('does not crash when a state maps to a null transition object', () => {
    const l1 = { details: [{ xstate_event: 'QUORUM_START', action: 'quorum_start' }] };
    const fsm = {
      observed_transitions: {
        IDLE: null,
        COLLECTING_VOTES: { QUORUM_START: { to_state: 'COLLECTING_VOTES', count: 1 } },
      },
    };
    let l2;
    assert.doesNotThrow(() => { l2 = analyzeL2(l1, fsm); });
    assert.ok(l2.details.some(t => t.state === 'COLLECTING_VOTES' && t.event === 'QUORUM_START'));
    assert.ok(!l2.details.some(t => t.state === 'IDLE'));
  });
});

describe('L3 rpn hardening', () => {
  it('does not return NaN max_rpn when an affected hazard is missing rpn', () => {
    const l2 = { details: [{ state: 'IDLE', event: 'QUORUM_START', to_state: 'COLLECTING_VOTES', count: 1 }] };
    const hazardModel = { hazards: [{ id: 'H1', state: 'IDLE', event: 'QUORUM_START', severity: 4 }] };
    const l3 = analyzeL3(l2, hazardModel, { failure_modes: [] });
    assert.equal(l3.affected_hazards, 1);
    assert.ok(Number.isFinite(l3.max_rpn), `max_rpn should be finite, got ${l3.max_rpn}`);
  });
});

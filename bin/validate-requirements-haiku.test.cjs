'use strict';

/**
 * Test suite for bin/validate-requirements-haiku.cjs
 * Uses Node.js built-in test runner: node --test bin/validate-requirements-haiku.test.cjs
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  buildValidationPrompt,
  parseHaikuResponse,
  validateRequirements,
  aggregateFindings,
  freezeEnvelope,
} = require('./validate-requirements-haiku.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let tempDir;

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'validate-requirements-test-'));
}

function cleanupTempDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createTempEnvelope(dir, data = {}) {
  const defaultData = {
    schema_version: '1',
    source: '.planning/REQUIREMENTS.md',
    aggregated_at: new Date().toISOString(),
    frozen_at: null,
    requirements: [],
    ...data,
  };
  const envPath = path.join(dir, 'requirements.json');
  fs.writeFileSync(envPath, JSON.stringify(defaultData, null, 2), 'utf8');
  return envPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: buildValidationPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('buildValidationPrompt', () => {
  test('includes all requirement IDs and text', () => {
    const reqs = [
      { id: 'ENV-01', text: 'First requirement', category: 'cat1', phase: 'v0.22-01' },
      { id: 'ENV-02', text: 'Second requirement', category: 'cat1', phase: 'v0.22-01' },
      { id: 'ENV-03', text: 'Third requirement', category: 'cat2', phase: 'v0.22-02' },
    ];

    const prompt = buildValidationPrompt(reqs);

    assert.ok(prompt.includes('ENV-01'), 'Should include ENV-01');
    assert.ok(prompt.includes('First requirement'), 'Should include first requirement text');
    assert.ok(prompt.includes('ENV-02'), 'Should include ENV-02');
    assert.ok(prompt.includes('Second requirement'), 'Should include second requirement text');
    assert.ok(prompt.includes('ENV-03'), 'Should include ENV-03');
    assert.ok(prompt.includes('Third requirement'), 'Should include third requirement text');
  });

  test('includes DUPLICATES, CONTRADICTIONS, AMBIGUITY rubrics', () => {
    const reqs = [{ id: 'ENV-01', text: 'Test', category: 'cat', phase: 'v0.22-01' }];
    const prompt = buildValidationPrompt(reqs);

    assert.ok(prompt.includes('DUPLICATES'), 'Should include DUPLICATES rubric');
    assert.ok(prompt.includes('CONTRADICTIONS'), 'Should include CONTRADICTIONS rubric');
    assert.ok(prompt.includes('AMBIGUITY'), 'Should include AMBIGUITY rubric');
  });

  test('handles empty requirements array', () => {
    const prompt = buildValidationPrompt([]);

    assert.ok(typeof prompt === 'string', 'Should return string');
    assert.ok(prompt.length > 0, 'Should return non-empty prompt');
    assert.ok(prompt.includes('DUPLICATES'), 'Should still have rubrics');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: parseHaikuResponse
// ─────────────────────────────────────────────────────────────────────────────

describe('parseHaikuResponse', () => {
  test('extracts valid JSON findings', () => {
    const response = JSON.stringify({
      findings: [
        {
          type: 'duplicate',
          requirement_ids: ['ENV-01', 'ENV-02'],
          description: 'Duplicate requirement',
          severity: 'high',
          suggested_resolution: 'Merge',
        },
      ],
      summary: '1 duplicate',
    });

    const result = parseHaikuResponse(response);

    assert.equal(result.findings.length, 1, 'Should have 1 finding');
    assert.equal(result.findings[0].type, 'duplicate', 'Should have correct type');
    assert.deepEqual(result.findings[0].requirement_ids, ['ENV-01', 'ENV-02'], 'Should have correct IDs');
    assert.equal(result.summary, '1 duplicate', 'Should have correct summary');
  });

  test('handles markdown-wrapped JSON', () => {
    const response = `\`\`\`json
{
  "findings": [
    {
      "type": "contradiction",
      "requirement_ids": ["ENV-03", "ENV-04"],
      "description": "Contradictory",
      "severity": "medium",
      "suggested_resolution": "Resolve"
    }
  ],
  "summary": "1 contradiction"
}
\`\`\``;

    const result = parseHaikuResponse(response);

    assert.equal(result.findings.length, 1, 'Should extract from markdown');
    assert.equal(result.findings[0].type, 'contradiction', 'Should parse correct type');
  });

  test('returns error object for invalid JSON', () => {
    const response = 'This is not JSON at all';

    const result = parseHaikuResponse(response);

    assert.ok(result.error, 'Should have error flag');
    assert.equal(result.findings.length, 0, 'Should have empty findings');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: aggregateFindings
// ─────────────────────────────────────────────────────────────────────────────

describe('aggregateFindings', () => {
  test('confirms findings appearing in 2+ of 3 passes', () => {
    const passes = [
      {
        findings: [
          { type: 'duplicate', requirement_ids: ['ENV-01', 'ENV-02'], description: 'A' },
          { type: 'ambiguity', requirement_ids: ['ENV-03'], description: 'B' },
          { type: 'contradiction', requirement_ids: ['ENV-04', 'ENV-05'], description: 'C' },
        ],
      },
      {
        findings: [
          { type: 'duplicate', requirement_ids: ['ENV-01', 'ENV-02'], description: 'A (2nd)' },
          { type: 'contradiction', requirement_ids: ['ENV-04', 'ENV-05'], description: 'C (2nd)' },
        ],
      },
      {
        findings: [
          { type: 'duplicate', requirement_ids: ['ENV-01', 'ENV-02'], description: 'A (3rd)' },
          { type: 'contradiction', requirement_ids: ['ENV-04', 'ENV-05'], description: 'C (3rd)' },
        ],
      },
    ];

    const result = aggregateFindings(passes);

    assert.equal(result.confirmed.length, 2, 'Should have 2 confirmed findings (A and C, not B)');
    assert.equal(result.total_passes, 3, 'Should have 3 total passes');
    assert.equal(result.agreement_threshold, 2, 'Should have 2-pass agreement threshold');

    const types = result.confirmed.map(f => f.type);
    assert.ok(types.includes('duplicate'), 'Should include duplicate');
    assert.ok(types.includes('contradiction'), 'Should include contradiction');
    assert.ok(!types.includes('ambiguity'), 'Should NOT include single-pass ambiguity');
  });

  test('handles empty passes', () => {
    const passes = [{ findings: [] }, { findings: [] }, { findings: [] }];

    const result = aggregateFindings(passes);

    assert.equal(result.confirmed.length, 0, 'Should have no confirmed findings');
    assert.equal(result.total_passes, 3, 'Should still count passes');
  });

  test('matches findings by type and overlapping requirement_ids', () => {
    const passes = [
      {
        findings: [
          { type: 'duplicate', requirement_ids: ['ENV-01', 'ENV-02'], description: 'Match' },
          { type: 'duplicate', requirement_ids: ['ENV-03', 'ENV-04'], description: 'Different' },
        ],
      },
      {
        findings: [
          { type: 'duplicate', requirement_ids: ['ENV-02', 'ENV-01'], description: 'Match again (different order)' },
        ],
      },
      {
        findings: [],
      },
    ];

    const result = aggregateFindings(passes);

    // Should match first finding (same type, overlapping IDs) across passes 1 and 2
    assert.equal(result.confirmed.length, 1, 'Should confirm the overlapping finding');
    assert.ok(
      result.confirmed[0].requirement_ids.includes('ENV-01'),
      'Confirmed finding should have ENV-01'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: validateRequirements
// ─────────────────────────────────────────────────────────────────────────────

describe('validateRequirements', () => {
  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test('returns skipped when API key missing', async () => {
    const envPath = createTempEnvelope(tempDir, {
      requirements: [{ id: 'ENV-01', text: 'Test', category: 'cat', phase: 'v0.22-01' }],
    });

    const result = await validateRequirements({
      envelopePath: envPath,
      apiKey: null,
    });

    assert.equal(result.status, 'skipped', 'Should skip when API key missing');
  });

  test('returns already-frozen for frozen envelope', async () => {
    const envPath = createTempEnvelope(tempDir, {
      frozen_at: '2026-03-01T12:00:00Z',
      requirements: [{ id: 'ENV-01', text: 'Test', category: 'cat', phase: 'v0.22-01' }],
    });

    const result = await validateRequirements({
      envelopePath: envPath,
      apiKey: 'dummy-key',
      mockCall: () => JSON.stringify({ findings: [], summary: 'No issues' }),
    });

    assert.equal(result.status, 'already-frozen', 'Should return already-frozen');
    assert.ok(result.frozen_at, 'Should include frozen_at timestamp');
  });

  test('uses mockCall for testing without real API', async () => {
    const envPath = createTempEnvelope(tempDir, {
      requirements: [{ id: 'ENV-01', text: 'Test', category: 'cat', phase: 'v0.22-01' }],
    });

    const mockResponse = JSON.stringify({
      findings: [
        {
          type: 'ambiguity',
          requirement_ids: ['ENV-01'],
          description: 'Test ambiguity',
          severity: 'low',
        },
      ],
      summary: '1 ambiguity',
    });

    const result = await validateRequirements({
      envelopePath: envPath,
      apiKey: 'dummy-key',
      passes: 2,
      mockCall: () => mockResponse,
    });

    assert.equal(result.status, 'validated', 'Should validate with mock');
    assert.equal(result.total_passes, 2, 'Should run 2 passes');
    assert.equal(result.confirmed.length, 1, 'Should have 1 confirmed finding (both passes had it)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite: freezeEnvelope
// ─────────────────────────────────────────────────────────────────────────────

describe('freezeEnvelope', () => {
  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test('sets frozen_at timestamp', () => {
    const envPath = createTempEnvelope(tempDir, {
      requirements: [{ id: 'ENV-01', text: 'Test', category: 'cat', phase: 'v0.22-01' }],
    });

    const result = freezeEnvelope(envPath);

    assert.ok(result.frozen, 'Should have frozen flag');
    assert.ok(result.frozen_at, 'Should have frozen_at timestamp');

    // Verify it's a valid ISO timestamp
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(result.frozen_at), 'Should be ISO timestamp format');

    // Read file and verify
    const envelope = JSON.parse(fs.readFileSync(envPath, 'utf8'));
    assert.equal(envelope.frozen_at, result.frozen_at, 'File should have matching frozen_at');
  });

  test('preserves existing envelope data', () => {
    const originalData = {
      requirements: [
        { id: 'ENV-01', text: 'First', category: 'cat1', phase: 'v0.22-01' },
        { id: 'ENV-02', text: 'Second', category: 'cat2', phase: 'v0.22-02' },
      ],
      some_metadata: 'should-be-preserved',
    };

    const envPath = createTempEnvelope(tempDir, originalData);

    freezeEnvelope(envPath);

    const frozen = JSON.parse(fs.readFileSync(envPath, 'utf8'));

    assert.equal(frozen.requirements.length, 2, 'Should preserve requirements array');
    assert.deepEqual(frozen.requirements, originalData.requirements, 'Requirements should be unchanged');
    assert.equal(frozen.some_metadata, originalData.some_metadata, 'Should preserve other metadata');
    assert.ok(frozen.frozen_at, 'Should have frozen_at added');
  });

  test('writes atomically (temp + rename)', () => {
    const envPath = createTempEnvelope(tempDir, {
      requirements: [{ id: 'ENV-01', text: 'Test', category: 'cat', phase: 'v0.22-01' }],
    });

    // Freeze should not leave temp files
    freezeEnvelope(envPath);

    const dir = fs.readdirSync(tempDir);
    const tempFiles = dir.filter(f => f.startsWith('.requirements'));
    assert.equal(tempFiles.length, 0, 'Should not leave temp files');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge case: Large requirement sets
// ─────────────────────────────────────────────────────────────────────────────

test('buildValidationPrompt handles large requirement sets', () => {
  const largeReqs = [];
  for (let i = 0; i < 100; i++) {
    largeReqs.push({
      id: `REQ-${String(i).padStart(3, '0')}`,
      text: `Requirement number ${i}`,
      category: 'large-set',
      phase: 'v0.22-01',
    });
  }

  const prompt = buildValidationPrompt(largeReqs);

  assert.ok(prompt.length > 1000, 'Should generate substantial prompt');
  assert.ok(prompt.includes('REQ-099'), 'Should include last requirement');
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge case: Special characters in requirement text
// ─────────────────────────────────────────────────────────────────────────────

test('buildValidationPrompt preserves markdown in requirement text', () => {
  const reqs = [
    {
      id: 'ENV-01',
      text: 'Must validate `.planning/formal/requirements.json` with **strong** emphasis and [links](http://example.com)',
      category: 'cat',
      phase: 'v0.22-01',
    },
  ];

  const prompt = buildValidationPrompt(reqs);

  assert.ok(prompt.includes('`.planning/formal/requirements.json`'), 'Should preserve backticks');
  assert.ok(prompt.includes('**strong**'), 'Should preserve bold');
});

// Dogfood regression: the 0-requirements early return omitted `agreement_threshold`,
// which the /nf:review-requirements renderer reads — printing `undefined`.
const fsH = require('node:fs');
const osH = require('node:os');
const pathH = require('node:path');
// (validateRequirements is already imported at the top of this file)

test('0-requirement envelope returns agreement_threshold (not undefined)', async () => {
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'nf-haiku-'));
  // A key must be set to pass the ANTHROPIC_API_KEY short-circuit and reach the
  // requirements-length branch — but with 0 requirements the function returns
  // BEFORE building/sending any prompt, so no network call is made by this dummy.
  const hadKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy';
  try {
    const envPath = pathH.join(dir, 'requirements.json');
    fsH.writeFileSync(envPath, JSON.stringify({ requirements: [] }));
    const result = await validateRequirements({ envelopePath: envPath });
    assert.strictEqual(result.agreement_threshold, 0, 'agreement_threshold must be present (0), not undefined');
    assert.strictEqual(result.total_passes, 0);
  } finally {
    if (hadKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = hadKey;
    fsH.rmSync(dir, { recursive: true, force: true });
  }
});

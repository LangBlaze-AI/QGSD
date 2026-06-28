'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { classifyTask, adjustForHotspotRisk, getModelRecommendation, readTaskEnvelope, COMPLEXITY_MAP } = require('./task-classifier.cjs');

describe('classifyTask', () => {
  it('returns moderate for null envelope (fail-open)', () => {
    assert.equal(classifyTask(null), 'moderate');
  });

  it('returns moderate for undefined envelope', () => {
    assert.equal(classifyTask(undefined), 'moderate');
  });

  it('returns trivial for exploration tasks', () => {
    assert.equal(classifyTask({ objective: 'explore options' }), 'trivial');
  });

  it('returns trivial for research tasks', () => {
    assert.equal(classifyTask({ objective: 'research alternatives' }), 'trivial');
  });

  it('returns simple for review with few files', () => {
    assert.equal(classifyTask({ objective: 'review PR', files: ['a.js'] }), 'simple');
  });

  it('returns complex for high risk architecture tasks', () => {
    assert.equal(classifyTask({ risk_level: 'high', objective: 'design auth system' }), 'complex');
  });

  it('returns complex for architecture keywords even without high risk', () => {
    assert.equal(classifyTask({ objective: 'design new API' }), 'complex');
  });

  it('returns moderate for many files', () => {
    assert.equal(classifyTask({ files: ['a', 'b', 'c', 'd', 'e', 'f'], objective: 'refactor' }), 'moderate');
  });

  it('returns simple for low risk tasks', () => {
    assert.equal(classifyTask({ risk_level: 'low', objective: 'fix typo' }), 'simple');
  });

  it('returns simple for routine risk tasks', () => {
    assert.equal(classifyTask({ risk_level: 'routine', objective: 'update config' }), 'simple');
  });

  it('returns moderate for default cases', () => {
    assert.equal(classifyTask({ objective: 'do something' }), 'moderate');
  });
});

describe('getModelRecommendation', () => {
  it('returns opus tier for complex tasks', () => {
    const rec = getModelRecommendation('complex', {});
    assert.equal(rec.tier, 'opus');
    assert.equal(rec.thinking_budget, 31999);
    assert.equal(rec.complexity, 'complex');
    assert.ok(rec.description.length > 0);
  });

  it('returns haiku tier for trivial tasks', () => {
    const rec = getModelRecommendation('trivial', {});
    assert.equal(rec.tier, 'haiku');
    assert.equal(rec.thinking_budget, 0);
  });

  it('respects model_routing tier override', () => {
    const rec = getModelRecommendation('simple', { model_routing: { simple: 'haiku' } });
    assert.equal(rec.tier, 'haiku');
  });

  it('respects thinking_budget_scaling for trivial (exploration)', () => {
    const rec = getModelRecommendation('trivial', { thinking_budget_scaling: { exploration: 500 } });
    assert.equal(rec.thinking_budget, 500);
  });

  it('respects thinking_budget_scaling for complex (architecture)', () => {
    const rec = getModelRecommendation('complex', { thinking_budget_scaling: { architecture: 16000 } });
    assert.equal(rec.thinking_budget, 16000);
  });

  it('respects thinking_budget_scaling for simple (review)', () => {
    const rec = getModelRecommendation('simple', { thinking_budget_scaling: { review: 2048 } });
    assert.equal(rec.thinking_budget, 2048);
  });

  it('uses COMPLEXITY_MAP default for moderate (no override key)', () => {
    const rec = getModelRecommendation('moderate', { thinking_budget_scaling: { exploration: 0 } });
    assert.equal(rec.thinking_budget, 16000);
  });

  it('handles missing config gracefully', () => {
    const rec = getModelRecommendation('simple', {});
    assert.equal(rec.tier, 'sonnet');
    assert.equal(rec.thinking_budget, 8000);
  });

  it('falls back to moderate for prototype-key complexity (no inherited-member leak)', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const rec = getModelRecommendation(key, {});
      assert.equal(rec.tier, 'sonnet', `tier for ${key}`);
      assert.equal(rec.thinking_budget, 16000, `budget for ${key}`);
      assert.ok(rec.description && rec.description.length > 0, `description for ${key}`);
    }
  });
});

describe('readTaskEnvelope', () => {
  it('returns null for nonexistent path', () => {
    const result = readTaskEnvelope('/tmp/nonexistent-dir-' + Date.now());
    assert.equal(result, null);
  });
});

describe('COMPLEXITY_MAP', () => {
  it('exports all four complexity levels', () => {
    assert.ok(COMPLEXITY_MAP.trivial);
    assert.ok(COMPLEXITY_MAP.simple);
    assert.ok(COMPLEXITY_MAP.moderate);
    assert.ok(COMPLEXITY_MAP.complex);
  });
});

describe('adjustForHotspotRisk', () => {
  it('returns unchanged complexity when no files provided', () => {
    assert.equal(adjustForHotspotRisk('simple', [], '/tmp'), 'simple');
  });

  it('returns unchanged complexity when no cache exists', () => {
    assert.equal(adjustForHotspotRisk('simple', ['src/foo.js'], '/tmp/nonexistent-' + Date.now()), 'simple');
  });

  it('upgrades simple to moderate when file has high hotspot score', () => {
    const os = require('os');
    const fs2 = require('fs');
    const tmpDir = fs2.mkdtempSync(path.join(os.tmpdir(), 'hotspot-risk-'));
    const repowiseDir = path.join(tmpDir, '.planning', 'repowise');
    fs2.mkdirSync(repowiseDir, { recursive: true });
    fs2.writeFileSync(path.join(repowiseDir, 'hotspot-cache.json'), JSON.stringify({
      files: [{ path: 'src/risky.js', hotspot_score: 0.85, risk: 'high' }],
    }));
    try {
      assert.equal(adjustForHotspotRisk('simple', ['src/risky.js'], tmpDir), 'moderate');
    } finally {
      fs2.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('upgrades moderate to complex when file has high hotspot score', () => {
    const os = require('os');
    const fs2 = require('fs');
    const tmpDir = fs2.mkdtempSync(path.join(os.tmpdir(), 'hotspot-risk-'));
    const repowiseDir = path.join(tmpDir, '.planning', 'repowise');
    fs2.mkdirSync(repowiseDir, { recursive: true });
    fs2.writeFileSync(path.join(repowiseDir, 'hotspot-cache.json'), JSON.stringify({
      files: [{ path: 'src/critical.js', hotspot_score: 0.8, risk: 'high' }],
    }));
    try {
      assert.equal(adjustForHotspotRisk('moderate', ['src/critical.js'], tmpDir), 'complex');
    } finally {
      fs2.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('upgrades simple to moderate when file has medium hotspot score', () => {
    const os = require('os');
    const fs2 = require('fs');
    const tmpDir = fs2.mkdtempSync(path.join(os.tmpdir(), 'hotspot-risk-'));
    const repowiseDir = path.join(tmpDir, '.planning', 'repowise');
    fs2.mkdirSync(repowiseDir, { recursive: true });
    fs2.writeFileSync(path.join(repowiseDir, 'hotspot-cache.json'), JSON.stringify({
      files: [{ path: 'src/medium.js', hotspot_score: 0.5, risk: 'medium' }],
    }));
    try {
      assert.equal(adjustForHotspotRisk('simple', ['src/medium.js'], tmpDir), 'moderate');
    } finally {
      fs2.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not upgrade when hotspot score is low', () => {
    const os = require('os');
    const fs2 = require('fs');
    const tmpDir = fs2.mkdtempSync(path.join(os.tmpdir(), 'hotspot-risk-'));
    const repowiseDir = path.join(tmpDir, '.planning', 'repowise');
    fs2.mkdirSync(repowiseDir, { recursive: true });
    fs2.writeFileSync(path.join(repowiseDir, 'hotspot-cache.json'), JSON.stringify({
      files: [{ path: 'src/safe.js', hotspot_score: 0.1, risk: 'low' }],
    }));
    try {
      assert.equal(adjustForHotspotRisk('simple', ['src/safe.js'], tmpDir), 'simple');
    } finally {
      fs2.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

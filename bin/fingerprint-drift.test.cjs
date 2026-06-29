const test = require('node:test');
const assert = require('node:assert');
const { fingerprintDrift } = require('./fingerprint-drift.cjs');

test('Drift Fingerprinting - Determinism', async (t) => {
  await t.test('same parameter key produces same fingerprint (run 5 times)', () => {
    const drift = { formal_parameter_key: 'MCsafety.cfg:MaxDeliberation' };

    const fingerprints = Array(5).fill(0).map(() => fingerprintDrift(drift));
    const first = fingerprints[0];

    for (let i = 1; i < fingerprints.length; i++) {
      assert.strictEqual(fingerprints[i], first, `Fingerprint ${i} differs from first`);
    }
  });
});

test('Drift Fingerprinting - Separation', async (t) => {
  await t.test('different parameter keys produce different fingerprints', () => {
    const fp1 = fingerprintDrift({ formal_parameter_key: 'MCsafety.cfg:MaxDeliberation' });
    const fp2 = fingerprintDrift({ formal_parameter_key: 'MCsafety.cfg:MinQuorum' });

    assert.notStrictEqual(fp1, fp2, 'Different parameter keys should produce different fingerprints');
  });

  await t.test('different model files produce different fingerprints', () => {
    const fp1 = fingerprintDrift({ formal_parameter_key: 'MCsafety.cfg:MaxDeliberation' });
    const fp2 = fingerprintDrift({ formal_parameter_key: 'MCliveness.cfg:MaxDeliberation' });

    assert.notStrictEqual(fp1, fp2, 'Different model files should produce different fingerprints');
  });
});

test('Drift Fingerprinting - Values Irrelevant', async (t) => {
  await t.test('measured values do not affect fingerprint', () => {
    const fp1 = fingerprintDrift({
      formal_parameter_key: 'MCsafety.cfg:MaxDeliberation',
      measured_value: 100
    });

    const fp2 = fingerprintDrift({
      formal_parameter_key: 'MCsafety.cfg:MaxDeliberation',
      measured_value: 999
    });

    assert.strictEqual(fp1, fp2, 'Different measured values should produce same fingerprint');
  });

  await t.test('timestamps do not affect fingerprint', () => {
    const fp1 = fingerprintDrift({
      formal_parameter_key: 'MCsafety.cfg:MaxDeliberation',
      observed_at: '2026-03-04T12:00:00Z'
    });

    const fp2 = fingerprintDrift({
      formal_parameter_key: 'MCsafety.cfg:MaxDeliberation',
      observed_at: '2026-03-05T14:30:00Z'
    });

    assert.strictEqual(fp1, fp2, 'Different timestamps should produce same fingerprint');
  });
});

test('Drift Fingerprinting - Format', async (t) => {
  await t.test('fingerprint length is consistent (16 hex chars)', () => {
    const drift = { formal_parameter_key: 'MCsafety.cfg:MaxDeliberation' };
    const fp = fingerprintDrift(drift);

    assert.strictEqual(fp.length, 16, 'Fingerprint must be 16 characters');
  });

  await t.test('fingerprint contains only lowercase hex chars [a-f0-9]', () => {
    const drift = { formal_parameter_key: 'MCsafety.cfg:MaxDeliberation' };
    const fp = fingerprintDrift(drift);

    assert.match(fp, /^[a-f0-9]{16}$/, 'Fingerprint should be lowercase hex');
  });
});

test('Drift Fingerprinting - Validation', async (t) => {
  await t.test('missing formal_parameter_key throws Error', () => {
    const drift = {};

    assert.throws(() => {
      fingerprintDrift(drift);
    }, /formal_parameter_key required/, 'Should throw error when formal_parameter_key is missing');
  });

  await t.test('empty string formal_parameter_key throws Error', () => {
    const drift = { formal_parameter_key: '' };

    assert.throws(() => {
      fingerprintDrift(drift);
    }, /formal_parameter_key required/, 'Should throw error when formal_parameter_key is empty');
  });
});

test('Drift Fingerprinting - Non-object input', async (t) => {
  await t.test('null drift throws controlled Error, not a raw TypeError', () => {
    assert.throws(() => {
      fingerprintDrift(null);
    }, /formal_parameter_key required/, 'Should throw the documented controlled error for null drift');
  });

  await t.test('undefined drift throws controlled Error, not a raw TypeError', () => {
    assert.throws(() => {
      fingerprintDrift(undefined);
    }, /formal_parameter_key required/, 'Should throw the documented controlled error for undefined drift');
  });

  await t.test('string drift throws controlled Error', () => {
    assert.throws(() => {
      fingerprintDrift('MCsafety.cfg:MaxDeliberation');
    }, /formal_parameter_key required/, 'Should throw the documented controlled error for non-object drift');
  });
});

test('Drift Fingerprinting - Key Formats', async (t) => {
  await t.test('various key formats work: file.cfg:Param', () => {
    const fp = fingerprintDrift({ formal_parameter_key: 'file.cfg:Param' });
    assert.match(fp, /^[a-f0-9]{16}$/, 'Should produce valid fingerprint');
  });

  await t.test('various key formats work: model.prism:lambda_rate', () => {
    const fp = fingerprintDrift({ formal_parameter_key: 'model.prism:lambda_rate' });
    assert.match(fp, /^[a-f0-9]{16}$/, 'Should produce valid fingerprint');
  });

  await t.test('various key formats work: requirement:REQ-123', () => {
    const fp = fingerprintDrift({ formal_parameter_key: 'requirement:REQ-123' });
    assert.match(fp, /^[a-f0-9]{16}$/, 'Should produce valid fingerprint');
  });
});

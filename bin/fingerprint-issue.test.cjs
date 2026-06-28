const test = require('node:test');
const assert = require('node:assert');
const { fingerprintIssue, hashMessage } = require('./fingerprint-issue.cjs');

test('Issue Fingerprinting - Determinism', async (t) => {
  await t.test('same input produces same fingerprint (run 5 times)', () => {
    const issue = {
      exception_type: 'TypeError',
      function_name: 'parseConfig',
      message: 'Cannot read property "id" of undefined'
    };

    const fingerprints = Array(5).fill(0).map(() => fingerprintIssue(issue));
    const first = fingerprints[0];

    for (let i = 1; i < fingerprints.length; i++) {
      assert.strictEqual(fingerprints[i], first, `Fingerprint ${i} differs from first`);
    }
  });
});

test('Issue Fingerprinting - Separation', async (t) => {
  await t.test('different exception types produce different fingerprints', () => {
    const base = {
      function_name: 'parseConfig',
      message: 'Cannot read property "id" of undefined'
    };

    const fp1 = fingerprintIssue({ ...base, exception_type: 'TypeError' });
    const fp2 = fingerprintIssue({ ...base, exception_type: 'ReferenceError' });

    assert.notStrictEqual(fp1, fp2, 'Different exception types should produce different fingerprints');
  });

  await t.test('different function names produce different fingerprints', () => {
    const base = {
      exception_type: 'TypeError',
      message: 'Cannot read property "id" of undefined'
    };

    const fp1 = fingerprintIssue({ ...base, function_name: 'parseConfig' });
    const fp2 = fingerprintIssue({ ...base, function_name: 'loadConfig' });

    assert.notStrictEqual(fp1, fp2, 'Different function names should produce different fingerprints');
  });

  await t.test('different messages produce different fingerprints', () => {
    const base = {
      exception_type: 'TypeError',
      function_name: 'parseConfig'
    };

    const fp1 = fingerprintIssue({ ...base, message: 'Cannot read property "id" of undefined' });
    const fp2 = fingerprintIssue({ ...base, message: 'Cannot read property "name" of undefined' });

    assert.notStrictEqual(fp1, fp2, 'Different messages should produce different fingerprints');
  });
});

test('Issue Fingerprinting - Normalization', async (t) => {
  await t.test('timestamps in message do not affect fingerprint', () => {
    const base = {
      exception_type: 'TypeError',
      function_name: 'parseConfig'
    };

    const fp1 = fingerprintIssue({
      ...base,
      message: 'Error at 2026-03-04T12:00:00Z in parseConfig'
    });

    const fp2 = fingerprintIssue({
      ...base,
      message: 'Error at 2026-03-05T14:30:00Z in parseConfig'
    });

    assert.strictEqual(fp1, fp2, 'Different timestamps should produce same fingerprint');
  });

  await t.test('line numbers in message do not affect fingerprint', () => {
    const base = {
      exception_type: 'TypeError',
      function_name: 'parseConfig'
    };

    const fp1 = fingerprintIssue({
      ...base,
      message: 'Error at parseConfig:42 in module'
    });

    const fp2 = fingerprintIssue({
      ...base,
      message: 'Error at parseConfig:99 in module'
    });

    assert.strictEqual(fp1, fp2, 'Different line numbers should produce same fingerprint');
  });

  await t.test('case normalization (uppercase to lowercase)', () => {
    const base = {
      function_name: 'parseConfig',
      message: 'Error occurred'
    };

    const fp1 = fingerprintIssue({ ...base, exception_type: 'TypeError' });
    const fp2 = fingerprintIssue({ ...base, exception_type: 'typeerror' });

    assert.strictEqual(fp1, fp2, 'Case should not affect fingerprint');
  });
});

test('Issue Fingerprinting - Format', async (t) => {
  await t.test('fingerprint length is consistent (16 hex chars)', () => {
    const issue = {
      exception_type: 'TypeError',
      function_name: 'parseConfig',
      message: 'Cannot read property "id" of undefined'
    };

    const fp = fingerprintIssue(issue);
    assert.strictEqual(fp.length, 16, 'Fingerprint must be 16 characters');
  });

  await t.test('fingerprint contains only lowercase hex chars [a-f0-9]', () => {
    const issue = {
      exception_type: 'TypeError',
      function_name: 'parseConfig',
      message: 'Cannot read property "id" of undefined'
    };

    const fp = fingerprintIssue(issue);
    assert.match(fp, /^[a-f0-9]{16}$/, 'Fingerprint should be lowercase hex');
  });
});

test('Issue Fingerprinting - Defaults', async (t) => {
  await t.test('missing exception_type defaults to "unknown"', () => {
    const issue = {
      function_name: 'parseConfig',
      message: 'Some error'
    };

    const fp1 = fingerprintIssue(issue);
    const fp2 = fingerprintIssue({
      exception_type: 'unknown',
      function_name: 'parseConfig',
      message: 'Some error'
    });

    assert.strictEqual(fp1, fp2, 'Missing exception_type should default to "unknown"');
  });

  await t.test('missing function_name defaults to "unknown"', () => {
    const issue = {
      exception_type: 'TypeError',
      message: 'Some error'
    };

    const fp1 = fingerprintIssue(issue);
    const fp2 = fingerprintIssue({
      exception_type: 'TypeError',
      function_name: 'unknown',
      message: 'Some error'
    });

    assert.strictEqual(fp1, fp2, 'Missing function_name should default to "unknown"');
  });

  await t.test('empty message produces valid fingerprint', () => {
    const issue = {
      exception_type: 'TypeError',
      function_name: 'parseConfig',
      message: ''
    };

    const fp = fingerprintIssue(issue);
    assert.match(fp, /^[a-f0-9]{16}$/, 'Empty message should still produce valid fingerprint');
  });
});

test('hashMessage helper', async (t) => {
  await t.test('strips timestamps and line numbers', () => {
    const msg1 = 'Error at 2026-03-04T12:00:00Z on line:42';
    const msg2 = 'Error at 2026-03-05T14:30:00Z on line:99';

    const hash1 = hashMessage(msg1);
    const hash2 = hashMessage(msg2);

    assert.strictEqual(hash1, hash2, 'Timestamps and line numbers should not affect message hash');
  });

  await t.test('lowercases message', () => {
    const hash1 = hashMessage('UPPERCASE ERROR');
    const hash2 = hashMessage('uppercase error');

    assert.strictEqual(hash1, hash2, 'Case should not affect message hash');
  });
});

test('Issue Fingerprinting - Null Safety', async (t) => {
  await t.test('null issue does not throw and yields valid fingerprint', () => {
    let fp;
    assert.doesNotThrow(() => { fp = fingerprintIssue(null); });
    assert.match(fp, /^[a-f0-9]{16}$/, 'null issue should still produce valid fingerprint');
  });

  await t.test('undefined issue does not throw', () => {
    assert.doesNotThrow(() => fingerprintIssue(undefined));
  });

  await t.test('non-object issue (string/number) does not throw', () => {
    assert.doesNotThrow(() => fingerprintIssue('boom'));
    assert.doesNotThrow(() => fingerprintIssue(42));
  });

  await t.test('null issue equals an all-defaults empty object', () => {
    const fpNull = fingerprintIssue(null);
    const fpEmpty = fingerprintIssue({});
    assert.strictEqual(fpNull, fpEmpty, 'null should be treated as empty issue');
  });
});

test('hashMessage helper - non-string input', async (t) => {
  await t.test('numeric message does not throw and yields hex', () => {
    let h;
    assert.doesNotThrow(() => { h = hashMessage(42); });
    assert.match(h, /^[a-f0-9]{16}$/);
  });

  await t.test('object/array message does not throw', () => {
    assert.doesNotThrow(() => hashMessage({ text: 'x' }));
    assert.doesNotThrow(() => hashMessage(['a', 'b']));
  });

  await t.test('fingerprintIssue tolerates numeric message', () => {
    let fp;
    assert.doesNotThrow(() => {
      fp = fingerprintIssue({ exception_type: 'TypeError', function_name: 'f', message: 42 });
    });
    assert.match(fp, /^[a-f0-9]{16}$/);
  });
});

test('Issue Fingerprinting - Non-string fields', async (t) => {
  await t.test('numeric exception_type does not throw', () => {
    let fp;
    assert.doesNotThrow(() => {
      fp = fingerprintIssue({ exception_type: 500, function_name: 'f', message: 'x' });
    });
    assert.match(fp, /^[a-f0-9]{16}$/);
  });

  await t.test('object function_name does not throw', () => {
    assert.doesNotThrow(() => {
      fingerprintIssue({ exception_type: 'TypeError', function_name: { name: 'parse' }, message: 'x' });
    });
  });
});

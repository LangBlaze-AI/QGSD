const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { renderObserveOutput, classifySeverity } = require('./observe-render.cjs');

describe('classifySeverity', () => {
  it('ranks error highest', () => assert.equal(classifySeverity('error'), 0));
  it('ranks bug second', () => assert.equal(classifySeverity('bug'), 1));
  it('ranks warning third', () => assert.equal(classifySeverity('warning'), 2));
  it('ranks info fourth', () => assert.equal(classifySeverity('info'), 3));
  it('ranks unknown lowest', () => assert.equal(classifySeverity('other'), 4));
});

describe('renderObserveOutput', () => {
  it('shows "All clear" for empty results with no errors', () => {
    const output = renderObserveOutput([
      { source_label: 'GH', source_type: 'github', status: 'ok', issues: [] }
    ]);
    assert.ok(output.includes('All clear'));
  });

  it('separates issues and drifts into two tables', () => {
    const results = [
      {
        source_label: 'GH', source_type: 'github', status: 'ok',
        issues: [
          { id: 'gh-1', title: 'Bug report', severity: 'bug', age: '2h', created_at: new Date().toISOString(), source_type: 'github', issue_type: 'issue' }
        ]
      },
      {
        source_label: 'Prom', source_type: 'prometheus', status: 'ok',
        issues: [
          { id: 'drift-1', title: 'Max deliberation', severity: 'warning', issue_type: 'drift', formal_parameter_key: 'MCsafety.cfg:MaxDeliberation', formal_value: '5', actual_value: '12' }
        ]
      }
    ];

    const output = renderObserveOutput(results);
    assert.ok(output.includes('ISSUES'));
    assert.ok(output.includes('DRIFTS'));
    assert.ok(output.includes('Bug report'));
    assert.ok(output.includes('1 issue(s), 1 drift(s)'));
  });

  it('sorts issues by severity then age', () => {
    const now = Date.now();
    const results = [{
      source_label: 'GH', source_type: 'github', status: 'ok',
      issues: [
        { id: '1', title: 'Warning issue', severity: 'warning', age: '1h', created_at: new Date(now - 3600000).toISOString(), issue_type: 'issue' },
        { id: '2', title: 'Error issue', severity: 'error', age: '5m', created_at: new Date(now - 300000).toISOString(), issue_type: 'issue' },
        { id: '3', title: 'Info issue', severity: 'info', age: '3d', created_at: new Date(now - 259200000).toISOString(), issue_type: 'issue' }
      ]
    }];

    const output = renderObserveOutput(results);
    const errorPos = output.indexOf('Error issue');
    const warningPos = output.indexOf('Warning issue');
    const infoPos = output.indexOf('Info issue');
    assert.ok(errorPos < warningPos, 'Error should appear before warning');
    assert.ok(warningPos < infoPos, 'Warning should appear before info');
  });

  it('shows error sources at bottom without blocking output', () => {
    const results = [
      {
        source_label: 'GH', source_type: 'github', status: 'ok',
        issues: [
          { id: 'gh-1', title: 'Test issue', severity: 'info', age: '1h', created_at: new Date().toISOString(), issue_type: 'issue' }
        ]
      },
      {
        source_label: 'Sentry', source_type: 'sentry', status: 'error',
        error: 'Timeout after 10s', issues: []
      }
    ];

    const output = renderObserveOutput(results);
    assert.ok(output.includes('ISSUES'));
    assert.ok(output.includes('Test issue'));
    assert.ok(output.includes('1 failed'));
    assert.ok(output.includes('Sentry'));
    assert.ok(output.includes('Timeout after 10s'));
  });

  it('renders only errors section when all sources fail', () => {
    const results = [
      { source_label: 'GH', source_type: 'github', status: 'error', error: 'gh not found', issues: [] },
      { source_label: 'Sentry', source_type: 'sentry', status: 'error', error: 'MCP timeout', issues: [] }
    ];

    const output = renderObserveOutput(results);
    assert.ok(output.includes('0 issue(s), 0 drift(s)'));
    assert.ok(output.includes('2 failed'));
    assert.ok(output.includes('gh not found'));
    assert.ok(output.includes('MCP timeout'));
  });

  it('handles mixed results (some ok, some error)', () => {
    const results = [
      {
        source_label: 'GH', source_type: 'github', status: 'ok',
        issues: [
          { id: 'gh-1', title: 'A bug', severity: 'bug', age: '1d', created_at: new Date().toISOString(), issue_type: 'issue' }
        ]
      },
      {
        source_label: 'Sentry', source_type: 'sentry', status: 'error',
        error: 'Connection refused', issues: []
      }
    ];

    const output = renderObserveOutput(results);
    assert.ok(output.includes('ISSUES'));
    assert.ok(output.includes('A bug'));
    assert.ok(output.includes('1 source(s) failed'));
    assert.ok(output.includes('Connection refused'));
  });

  it('renders drifts table with Parameter/Formal/Actual columns', () => {
    const results = [{
      source_label: 'Prom', source_type: 'prometheus', status: 'ok',
      issues: [
        {
          id: 'drift-1', title: 'avgLatencyP95', severity: 'warning',
          issue_type: 'drift', formal_parameter_key: 'latency-p95',
          formal_value: '<100ms', actual_value: '245ms'
        }
      ]
    }];

    const output = renderObserveOutput(results);
    assert.ok(output.includes('DRIFTS'));
    assert.ok(output.includes('Parameter'));
    assert.ok(output.includes('Formal'));
    assert.ok(output.includes('Actual'));
  });

  it('handles empty results array', () => {
    const output = renderObserveOutput([]);
    assert.ok(output.includes('All clear'));
  });
});

describe('renderObserveOutput hardening', () => {
  it('skips null / non-object entries in the results array without crashing', () => {
    const results = [
      null,
      undefined,
      'garbage',
      {
        source_label: 'GH', source_type: 'github', status: 'ok',
        issues: [
          { id: 'gh-1', title: 'Real issue', severity: 'bug', age: '1h', created_at: new Date().toISOString(), issue_type: 'issue' }
        ]
      }
    ];
    let output;
    assert.doesNotThrow(() => { output = renderObserveOutput(results); });
    assert.ok(output.includes('Real issue'));
  });
});

describe('renderObserveOutput non-array issues', () => {
  it('treats a non-array issues field as empty instead of throwing', () => {
    const results = [
      { source_label: 'Bad', source_type: 'custom', status: 'ok', issues: { 'gh-1': { title: 'x' } } },
      {
        source_label: 'GH', source_type: 'github', status: 'ok',
        issues: [
          { id: 'gh-2', title: 'Good issue', severity: 'bug', age: '1h', created_at: new Date().toISOString(), issue_type: 'issue' }
        ]
      }
    ];
    let output;
    assert.doesNotThrow(() => { output = renderObserveOutput(results); });
    assert.ok(output.includes('Good issue'));
  });
});

describe('renderObserveOutput null issue entries', () => {
  it('skips null / non-object issue entries without crashing', () => {
    const results = [{
      source_label: 'GH', source_type: 'github', status: 'ok',
      issues: [
        null,
        'garbage',
        { id: 'gh-1', title: 'Survivor', severity: 'bug', age: '1h', created_at: new Date().toISOString(), issue_type: 'issue' }
      ]
    }];
    let output;
    assert.doesNotThrow(() => { output = renderObserveOutput(results); });
    assert.ok(output.includes('Survivor'));
  });
});

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Will be implemented in GREEN phase
let handlePrometheus;
try {
  ({ handlePrometheus } = require('./observe-handler-prometheus.cjs'));
} catch {
  // RED phase: module doesn't exist yet
  handlePrometheus = async () => { throw new Error('Not implemented'); };
}

// Mock fetch factory
function mockFetch(responses) {
  return async function fakeFetch(url, opts) {
    for (const [pattern, response] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        if (response instanceof Error) throw response;
        return {
          ok: response.ok !== undefined ? response.ok : true,
          status: response.status || 200,
          json: async () => response.body
        };
      }
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
}

// Sample Prometheus alerts response
const SAMPLE_ALERTS = {
  status: 'success',
  data: {
    alerts: [
      {
        labels: { alertname: 'HighMemoryUsage', severity: 'critical', instance: 'prod-01' },
        annotations: { summary: 'Memory usage above 90%' },
        state: 'firing',
        activeAt: '2026-03-04T10:00:00Z',
        value: '0.95'
      },
      {
        labels: { alertname: 'DiskSpaceLow', severity: 'warning', instance: 'prod-02' },
        annotations: { summary: 'Disk space below 10%' },
        state: 'firing',
        activeAt: '2026-03-04T12:00:00Z',
        value: '0.08'
      }
    ]
  }
};

// Sample PromQL query response
const SAMPLE_QUERY = {
  status: 'success',
  data: {
    resultType: 'vector',
    result: [
      {
        metric: { __name__: 'max_deliberation_ms', instance: 'prod-01' },
        value: [1709553600, '7500']
      },
      {
        metric: { __name__: 'max_deliberation_ms', instance: 'prod-02' },
        value: [1709553600, '3200']
      }
    ]
  }
};

describe('handlePrometheus — Alerts mode', () => {
  it('fetches /api/v1/alerts when no query field in config', async () => {
    let fetchedUrl = '';
    const fetchFn = async (url) => {
      fetchedUrl = url;
      return { ok: true, status: 200, json: async () => SAMPLE_ALERTS };
    };

    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom Alerts', endpoint: 'http://prom:9090', issue_type: 'drift' },
      { fetchFn }
    );

    assert.ok(fetchedUrl.includes('/api/v1/alerts'), 'Should fetch alerts endpoint');
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 2);
  });

  it('maps firing alerts to standard issue schema', async () => {
    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom', endpoint: 'http://prom:9090', issue_type: 'drift' },
      { fetchFn: mockFetch({ '/api/v1/alerts': { body: SAMPLE_ALERTS } }) }
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.source_type, 'prometheus');
    assert.equal(result.issues.length, 2);

    const alert1 = result.issues[0];
    assert.equal(alert1.title, 'HighMemoryUsage');
    assert.equal(alert1.severity, 'critical');
    assert.equal(alert1.source_type, 'prometheus');
    assert.equal(alert1.issue_type, 'drift');
    assert.ok(alert1.id, 'Should have an id');
    assert.ok(alert1.created_at, 'Should have created_at');
    assert.ok(alert1.meta, 'Should have meta');

    const alert2 = result.issues[1];
    assert.equal(alert2.title, 'DiskSpaceLow');
    assert.equal(alert2.severity, 'warning');
  });

  it('sends Bearer auth header when auth_env is set', async () => {
    const origEnv = process.env.TEST_PROM_TOKEN;
    process.env.TEST_PROM_TOKEN = 'my-secret-token';

    let capturedHeaders = {};
    const fetchFn = async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: { alerts: [] } }) };
    };

    await handlePrometheus(
      { type: 'prometheus', label: 'Prom', endpoint: 'http://prom:9090', auth_env: 'TEST_PROM_TOKEN' },
      { fetchFn }
    );

    assert.equal(capturedHeaders['Authorization'], 'Bearer my-secret-token');

    if (origEnv === undefined) delete process.env.TEST_PROM_TOKEN;
    else process.env.TEST_PROM_TOKEN = origEnv;
  });

  it('returns error on auth failure (401)', async () => {
    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom', endpoint: 'http://prom:9090' },
      { fetchFn: mockFetch({ '/api/v1/alerts': { ok: false, status: 401, body: { error: 'unauthorized' } } }) }
    );

    assert.equal(result.status, 'error');
    assert.equal(result.issues.length, 0);
    assert.ok(result.error, 'Should have error message');
  });

  it('returns error on timeout', async () => {
    const fetchFn = async () => { throw new Error('Timeout after 10s'); };

    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom', endpoint: 'http://prom:9090' },
      { fetchFn }
    );

    assert.equal(result.status, 'error');
    assert.equal(result.issues.length, 0);
  });

  it('returns error on malformed JSON', async () => {
    const fetchFn = async () => ({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); }
    });

    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom', endpoint: 'http://prom:9090' },
      { fetchFn }
    );

    assert.equal(result.status, 'error');
    assert.equal(result.issues.length, 0);
  });

  it('returns ok with empty issues on empty alerts array', async () => {
    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom', endpoint: 'http://prom:9090' },
      { fetchFn: mockFetch({ '/api/v1/alerts': { body: { status: 'success', data: { alerts: [] } } } }) }
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 0);
  });

  it('includes pending alerts with state in meta', async () => {
    const alertsWithPending = {
      status: 'success',
      data: {
        alerts: [{
          labels: { alertname: 'PendingAlert', severity: 'info' },
          annotations: {},
          state: 'pending',
          activeAt: '2026-03-04T14:00:00Z'
        }]
      }
    };

    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom', endpoint: 'http://prom:9090', issue_type: 'drift' },
      { fetchFn: mockFetch({ '/api/v1/alerts': { body: alertsWithPending } }) }
    );

    assert.equal(result.issues.length, 1);
    assert.ok(result.issues[0].meta.includes('pending'), 'Meta should include state');
  });

  it('defaults severity to warning when no severity label', async () => {
    const alertsNoSev = {
      status: 'success',
      data: {
        alerts: [{
          labels: { alertname: 'NoSeverity' },
          annotations: {},
          state: 'firing',
          activeAt: '2026-03-04T14:00:00Z'
        }]
      }
    };

    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom', endpoint: 'http://prom:9090' },
      { fetchFn: mockFetch({ '/api/v1/alerts': { body: alertsNoSev } }) }
    );

    assert.equal(result.issues[0].severity, 'warning');
  });
});

describe('handlePrometheus — Query mode', () => {
  it('fetches /api/v1/query when query field is set', async () => {
    let fetchedUrl = '';
    const fetchFn = async (url) => {
      fetchedUrl = url;
      return { ok: true, status: 200, json: async () => SAMPLE_QUERY };
    };

    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom Query', endpoint: 'http://prom:9090', query: 'max_deliberation_ms > 5000', issue_type: 'drift' },
      { fetchFn }
    );

    assert.ok(fetchedUrl.includes('/api/v1/query'), 'Should fetch query endpoint');
    assert.ok(fetchedUrl.includes('query='), 'Should include query param');
    assert.equal(result.status, 'ok');
  });

  it('maps vector results to standard schema', async () => {
    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom Query', endpoint: 'http://prom:9090', query: 'some_metric', issue_type: 'drift' },
      { fetchFn: mockFetch({ '/api/v1/query': { body: SAMPLE_QUERY } }) }
    );

    assert.equal(result.issues.length, 2);
    const issue1 = result.issues[0];
    assert.ok(issue1.title.includes('max_deliberation_ms'), 'Title should include metric name');
    assert.equal(issue1.source_type, 'prometheus');
    assert.equal(issue1.issue_type, 'drift');
    assert.ok(issue1.meta.includes('7500'), 'Meta should include value');
  });

  it('returns ok with empty issues on empty query result', async () => {
    const emptyQuery = { status: 'success', data: { resultType: 'vector', result: [] } };

    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom', endpoint: 'http://prom:9090', query: 'some_metric' },
      { fetchFn: mockFetch({ '/api/v1/query': { body: emptyQuery } }) }
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 0);
  });

  it('handles scalar result type', async () => {
    const scalarResult = { status: 'success', data: { resultType: 'scalar', result: [1709553600, '42'] } };

    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom', endpoint: 'http://prom:9090', query: 'count(up)', issue_type: 'drift' },
      { fetchFn: mockFetch({ '/api/v1/query': { body: scalarResult } }) }
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 1);
    assert.ok(result.issues[0].meta.includes('42'), 'Meta should include scalar value');
  });
});

describe('handlePrometheus — adversarial sourceConfig', () => {
  it('does not reject when sourceConfig is null (fail-open contract)', async () => {
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ status: 'success', data: { alerts: [] } }) });
    const result = await handlePrometheus(null, { fetchFn });
    assert.equal(result.source_type, 'prometheus');
    assert.ok(Array.isArray(result.issues), 'issues must be an array');
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 0);
  });
});

describe('handlePrometheus — malformed alert element', () => {
  it('survives a null alert element without dropping valid siblings', async () => {
    const body = { status: 'success', data: { alerts: [
      null,
      { labels: { alertname: 'Good', severity: 'critical' }, annotations: {}, state: 'firing', activeAt: '2026-03-04T10:00:00Z' }
    ] } };
    const result = await handlePrometheus(
      { type: 'prometheus', label: 'Prom', endpoint: 'http://prom:9090' },
      { fetchFn: mockFetch({ '/api/v1/alerts': { body } }) }
    );
    assert.equal(result.status, 'ok');
    assert.ok(result.issues.some(i => i.title === 'Good'), 'valid alert must survive a malformed sibling');
  });
});

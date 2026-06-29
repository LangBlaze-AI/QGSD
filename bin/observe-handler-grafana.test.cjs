const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Will be implemented in GREEN phase
let handleGrafana;
try {
  ({ handleGrafana } = require('./observe-handler-grafana.cjs'));
} catch {
  // RED phase: module doesn't exist yet
  handleGrafana = async () => { throw new Error('Not implemented'); };
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

// Sample Grafana alert rules response (array of rule objects)
const SAMPLE_ALERT_RULES = [
  {
    id: 1,
    uid: 'rule-abc',
    title: 'High CPU Usage',
    folderUID: 'folder-1',
    ruleGroup: 'infra-alerts',
    updated: '2026-03-04T10:00:00Z',
    labels: { grafana_state: 'alerting', severity: 'critical' },
    annotations: { summary: 'CPU above 90% on prod-01' },
    dashboardUid: 'dash-123',
    panelId: 4
  },
  {
    id: 2,
    uid: 'rule-def',
    title: 'Memory Pressure',
    folderUID: 'folder-1',
    ruleGroup: 'infra-alerts',
    updated: '2026-03-04T11:00:00Z',
    labels: { grafana_state: 'pending' },
    annotations: { summary: 'Memory usage climbing' },
    dashboardUid: 'dash-456',
    panelId: 2
  },
  {
    id: 3,
    uid: 'rule-ghi',
    title: 'Disk Check',
    folderUID: 'folder-2',
    ruleGroup: 'storage-alerts',
    updated: '2026-03-04T12:00:00Z',
    labels: { grafana_state: 'normal' },
    annotations: {},
    dashboardUid: null,
    panelId: null
  }
];

describe('handleGrafana — Alert fetching', () => {
  it('fetches /api/v1/provisioning/alert-rules', async () => {
    let fetchedUrl = '';
    const fetchFn = async (url) => {
      fetchedUrl = url;
      return { ok: true, status: 200, json: async () => SAMPLE_ALERT_RULES };
    };

    const result = await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com', issue_type: 'drift' },
      { fetchFn }
    );

    assert.ok(fetchedUrl.includes('/api/v1/provisioning/alert-rules'), 'Should fetch alert-rules endpoint');
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 3);
  });

  it('maps alert rules to standard issue schema', async () => {
    const result = await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com', issue_type: 'drift' },
      { fetchFn: mockFetch({ '/api/v1/provisioning/alert-rules': { body: SAMPLE_ALERT_RULES } }) }
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.source_type, 'grafana');
    assert.equal(result.issues.length, 3);

    const issue1 = result.issues[0];
    assert.equal(issue1.title, 'High CPU Usage');
    assert.equal(issue1.severity, 'error'); // alerting → error
    assert.equal(issue1.source_type, 'grafana');
    assert.equal(issue1.issue_type, 'drift');
    assert.ok(issue1.id, 'Should have an id');
    assert.ok(issue1.created_at, 'Should have created_at');

    const issue2 = result.issues[1];
    assert.equal(issue2.title, 'Memory Pressure');
    assert.equal(issue2.severity, 'warning'); // pending → warning

    const issue3 = result.issues[2];
    assert.equal(issue3.title, 'Disk Check');
    assert.equal(issue3.severity, 'info'); // normal → info
  });

  it('constructs dashboard URL when dashboardUid is available', async () => {
    const result = await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com', issue_type: 'drift' },
      { fetchFn: mockFetch({ '/api/v1/provisioning/alert-rules': { body: SAMPLE_ALERT_RULES } }) }
    );

    assert.ok(result.issues[0].url.includes('/d/dash-123'), 'Should include dashboard UID in URL');
    assert.ok(result.issues[1].url.includes('/d/dash-456'), 'Second alert should have dashboard URL');
    // Third alert has no dashboardUid — should fall back to endpoint
    assert.ok(result.issues[2].url, 'Third alert should still have a URL');
  });

  it('includes annotations summary in meta', async () => {
    const result = await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com', issue_type: 'drift' },
      { fetchFn: mockFetch({ '/api/v1/provisioning/alert-rules': { body: SAMPLE_ALERT_RULES } }) }
    );

    assert.ok(result.issues[0].meta.includes('CPU above 90%'), 'Meta should include annotation summary');
  });

  it('sends Bearer auth header when auth_env is set', async () => {
    const origEnv = process.env.TEST_GRAFANA_TOKEN;
    process.env.TEST_GRAFANA_TOKEN = 'grafana-secret';

    let capturedHeaders = {};
    const fetchFn = async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      return { ok: true, status: 200, json: async () => [] };
    };

    await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com', auth_env: 'TEST_GRAFANA_TOKEN' },
      { fetchFn }
    );

    assert.equal(capturedHeaders['Authorization'], 'Bearer grafana-secret');

    if (origEnv === undefined) delete process.env.TEST_GRAFANA_TOKEN;
    else process.env.TEST_GRAFANA_TOKEN = origEnv;
  });

  it('returns error on auth failure (401)', async () => {
    const result = await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com' },
      { fetchFn: mockFetch({ '/api/v1/provisioning/alert-rules': { ok: false, status: 401, body: { message: 'unauthorized' } } }) }
    );

    assert.equal(result.status, 'error');
    assert.equal(result.issues.length, 0);
    assert.ok(result.error, 'Should have error message');
  });

  it('returns error on timeout', async () => {
    const fetchFn = async () => { throw new Error('Timeout after 15s'); };

    const result = await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com' },
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

    const result = await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com' },
      { fetchFn }
    );

    assert.equal(result.status, 'error');
    assert.equal(result.issues.length, 0);
  });

  it('returns ok with empty issues on empty rules array', async () => {
    const result = await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com' },
      { fetchFn: mockFetch({ '/api/v1/provisioning/alert-rules': { body: [] } }) }
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 0);
  });
});

describe('handleGrafana — State mapping', () => {
  async function testState(state, expectedSeverity) {
    const rules = [{
      id: 1, uid: 'test', title: 'Test',
      updated: '2026-03-04T10:00:00Z',
      labels: { grafana_state: state },
      annotations: {}
    }];

    const result = await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com', issue_type: 'drift' },
      { fetchFn: mockFetch({ '/api/v1/provisioning/alert-rules': { body: rules } }) }
    );

    assert.equal(result.issues[0].severity, expectedSeverity, `State "${state}" should map to "${expectedSeverity}"`);
  }

  it('maps "alerting" to error', () => testState('alerting', 'error'));
  it('maps "firing" to error', () => testState('firing', 'error'));
  it('maps "pending" to warning', () => testState('pending', 'warning'));
  it('maps "nodata" to warning', () => testState('nodata', 'warning'));
  it('maps "normal" to info', () => testState('normal', 'info'));
  it('maps "ok" to info', () => testState('ok', 'info'));
  it('maps unknown state to info', () => testState('some_unknown', 'info'));

  it('defaults to info when no state label exists', async () => {
    const rules = [{
      id: 1, uid: 'test', title: 'No State',
      updated: '2026-03-04T10:00:00Z',
      labels: {},
      annotations: {}
    }];

    const result = await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com', issue_type: 'drift' },
      { fetchFn: mockFetch({ '/api/v1/provisioning/alert-rules': { body: rules } }) }
    );

    assert.equal(result.issues[0].severity, 'info');
  });
});

describe('handleGrafana — Adversarial hardening', () => {
  it('skips null/non-object rule entries instead of failing the whole batch', async () => {
    const rules = [
      { id: 1, title: 'High CPU', updated: '2026-03-04T10:00:00Z', labels: { grafana_state: 'alerting' }, annotations: {} },
      null,
      { id: 3, title: 'Disk', updated: '2026-03-04T12:00:00Z', labels: { grafana_state: 'normal' }, annotations: {} }
    ];

    const result = await handleGrafana(
      { type: 'grafana', label: 'Grafana', endpoint: 'https://grafana.example.com', issue_type: 'drift' },
      { fetchFn: mockFetch({ '/api/v1/provisioning/alert-rules': { body: rules } }) }
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 2, 'valid rules survive a null entry');
    assert.equal(result.issues[0].title, 'High CPU');
    assert.equal(result.issues[1].title, 'Disk');
  });

  it('returns the standard error shape for a null sourceConfig (does not reject)', async () => {
    const result = await handleGrafana(null, { fetchFn: async () => ({ ok: true, status: 200, json: async () => [] }) });

    assert.equal(result.source_type, 'grafana');
    assert.equal(result.status, 'error');
    assert.ok(Array.isArray(result.issues));
    assert.equal(result.issues.length, 0);
  });
});

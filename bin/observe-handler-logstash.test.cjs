const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Will be implemented in GREEN phase
let handleLogstash;
try {
  ({ handleLogstash } = require('./observe-handler-logstash.cjs'));
} catch {
  // RED phase: module doesn't exist yet
  handleLogstash = async () => { throw new Error('Not implemented'); };
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

// Sample Elasticsearch search response
const SAMPLE_ES_RESPONSE = {
  hits: {
    total: { value: 3, relation: 'eq' },
    hits: [
      {
        _id: 'abc123',
        _source: {
          message: 'Connection refused to database host db-primary:5432',
          level: 'error',
          '@timestamp': '2026-03-04T14:00:00Z',
          host: 'app-server-01',
          service: 'api-gateway'
        }
      },
      {
        _id: 'def456',
        _source: {
          message: 'Slow query detected: SELECT * FROM users took 5200ms',
          level: 'warn',
          '@timestamp': '2026-03-04T13:30:00Z',
          host: 'app-server-02',
          service: 'user-service'
        }
      },
      {
        _id: 'ghi789',
        _source: {
          message: 'Failed to parse request body: unexpected EOF',
          level: 'error',
          '@timestamp': '2026-03-04T13:00:00Z',
          host: 'app-server-01',
          service: 'api-gateway'
        }
      }
    ]
  }
};

describe('handleLogstash — Query execution', () => {
  it('POSTs to /{index}/_search with correct URL', async () => {
    let fetchedUrl = '';
    let fetchedMethod = '';
    const fetchFn = async (url, opts) => {
      fetchedUrl = url;
      fetchedMethod = opts?.method || 'GET';
      return { ok: true, status: 200, json: async () => SAMPLE_ES_RESPONSE };
    };

    await handleLogstash(
      { type: 'logstash', label: 'ES Logs', endpoint: 'https://es.example.com:9200', index: 'logstash-*', issue_type: 'issue' },
      { fetchFn }
    );

    assert.ok(fetchedUrl.includes('logstash-*/_search'), 'Should POST to /{index}/_search');
    assert.equal(fetchedMethod, 'POST', 'Should use POST method');
  });

  it('maps ES hits to standard issue schema', async () => {
    const result = await handleLogstash(
      { type: 'logstash', label: 'ES Logs', endpoint: 'https://es.example.com:9200', index: 'logstash-*', issue_type: 'issue' },
      { fetchFn: mockFetch({ '/_search': { body: SAMPLE_ES_RESPONSE } }) }
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.source_type, 'logstash');
    assert.equal(result.issues.length, 3);

    const issue1 = result.issues[0];
    assert.equal(issue1.title, 'Connection refused to database host db-primary:5432');
    assert.equal(issue1.severity, 'error');
    assert.equal(issue1.source_type, 'logstash');
    assert.equal(issue1.issue_type, 'issue');
    assert.equal(issue1.created_at, '2026-03-04T14:00:00Z');
    assert.ok(issue1.id.includes('abc123'), 'ID should include hit _id');

    const issue2 = result.issues[1];
    assert.equal(issue2.severity, 'warning'); // warn → warning
  });

  it('truncates long messages to 120 chars', async () => {
    const longHit = {
      hits: {
        total: { value: 1 },
        hits: [{
          _id: 'long1',
          _source: {
            message: 'A'.repeat(200),
            level: 'error',
            '@timestamp': '2026-03-04T14:00:00Z'
          }
        }]
      }
    };

    const result = await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200', index: 'logstash-*' },
      { fetchFn: mockFetch({ '/_search': { body: longHit } }) }
    );

    assert.ok(result.issues[0].title.length <= 123, 'Title should be truncated (120 + "...")');
  });

  it('uses default index logstash-* when not configured', async () => {
    let fetchedUrl = '';
    const fetchFn = async (url, opts) => {
      fetchedUrl = url;
      return { ok: true, status: 200, json: async () => ({ hits: { hits: [] } }) };
    };

    await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
      { fetchFn }
    );

    assert.ok(fetchedUrl.includes('logstash-*/_search'), 'Should default to logstash-* index');
  });

  it('sends Content-Type application/json header', async () => {
    let capturedHeaders = {};
    const fetchFn = async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      return { ok: true, status: 200, json: async () => ({ hits: { hits: [] } }) };
    };

    await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
      { fetchFn }
    );

    assert.equal(capturedHeaders['Content-Type'], 'application/json');
  });
});

describe('handleLogstash — Query construction', () => {
  it('builds default query with @timestamp >= now-1h and error/warn levels', async () => {
    let capturedBody = null;
    const fetchFn = async (url, opts) => {
      capturedBody = JSON.parse(opts?.body || '{}');
      return { ok: true, status: 200, json: async () => ({ hits: { hits: [] } }) };
    };

    await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
      { fetchFn }
    );

    assert.ok(capturedBody.query, 'Should have query');
    const filters = capturedBody.query.bool.filter;
    // Check time range filter
    const rangeFilter = filters.find(f => f.range);
    assert.ok(rangeFilter, 'Should have range filter');
    assert.ok(rangeFilter.range['@timestamp'].gte, 'Should have gte for @timestamp');

    // Check level filter
    const termsFilter = filters.find(f => f.terms);
    assert.ok(termsFilter, 'Should have terms filter');
    assert.ok(termsFilter.terms.level.includes('error'), 'Should include error level');
    assert.ok(termsFilter.terms.level.includes('warn'), 'Should include warn level');
  });

  it('uses custom since from filter config', async () => {
    let capturedBody = null;
    const fetchFn = async (url, opts) => {
      capturedBody = JSON.parse(opts?.body || '{}');
      return { ok: true, status: 200, json: async () => ({ hits: { hits: [] } }) };
    };

    await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200', filter: { since: '24h' } },
      { fetchFn }
    );

    const rangeFilter = capturedBody.query.bool.filter.find(f => f.range);
    assert.ok(rangeFilter.range['@timestamp'].gte.includes('24h'), 'Should use custom since value');
  });

  it('uses custom levels from filter config', async () => {
    let capturedBody = null;
    const fetchFn = async (url, opts) => {
      capturedBody = JSON.parse(opts?.body || '{}');
      return { ok: true, status: 200, json: async () => ({ hits: { hits: [] } }) };
    };

    await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200', filter: { levels: ['error'] } },
      { fetchFn }
    );

    const termsFilter = capturedBody.query.bool.filter.find(f => f.terms);
    assert.deepEqual(termsFilter.terms.level, ['error'], 'Should use custom levels');
  });

  it('uses custom limit from filter config', async () => {
    let capturedBody = null;
    const fetchFn = async (url, opts) => {
      capturedBody = JSON.parse(opts?.body || '{}');
      return { ok: true, status: 200, json: async () => ({ hits: { hits: [] } }) };
    };

    await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200', filter: { limit: 25 } },
      { fetchFn }
    );

    assert.equal(capturedBody.size, 25, 'Should use custom limit');
  });
});

describe('handleLogstash — Auth and errors', () => {
  it('sends ApiKey auth header by default when auth_env is set', async () => {
    const origEnv = process.env.TEST_ES_KEY;
    process.env.TEST_ES_KEY = 'my-api-key';

    let capturedHeaders = {};
    const fetchFn = async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      return { ok: true, status: 200, json: async () => ({ hits: { hits: [] } }) };
    };

    await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200', auth_env: 'TEST_ES_KEY' },
      { fetchFn }
    );

    assert.equal(capturedHeaders['Authorization'], 'ApiKey my-api-key');

    if (origEnv === undefined) delete process.env.TEST_ES_KEY;
    else process.env.TEST_ES_KEY = origEnv;
  });

  it('sends Bearer auth header when auth_type is Bearer', async () => {
    const origEnv = process.env.TEST_ES_TOKEN;
    process.env.TEST_ES_TOKEN = 'my-bearer-token';

    let capturedHeaders = {};
    const fetchFn = async (url, opts) => {
      capturedHeaders = opts?.headers || {};
      return { ok: true, status: 200, json: async () => ({ hits: { hits: [] } }) };
    };

    await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200', auth_env: 'TEST_ES_TOKEN', auth_type: 'Bearer' },
      { fetchFn }
    );

    assert.equal(capturedHeaders['Authorization'], 'Bearer my-bearer-token');

    if (origEnv === undefined) delete process.env.TEST_ES_TOKEN;
    else process.env.TEST_ES_TOKEN = origEnv;
  });

  it('returns error on auth failure (401)', async () => {
    const result = await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
      { fetchFn: mockFetch({ '/_search': { ok: false, status: 401, body: {} } }) }
    );

    assert.equal(result.status, 'error');
    assert.equal(result.issues.length, 0);
    assert.ok(result.error);
  });

  it('returns error on auth failure (403)', async () => {
    const result = await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
      { fetchFn: mockFetch({ '/_search': { ok: false, status: 403, body: {} } }) }
    );

    assert.equal(result.status, 'error');
    assert.equal(result.issues.length, 0);
  });

  it('returns error on timeout', async () => {
    const fetchFn = async () => { throw new Error('Timeout after 15s'); };

    const result = await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
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

    const result = await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
      { fetchFn }
    );

    assert.equal(result.status, 'error');
    assert.equal(result.issues.length, 0);
  });

  it('returns ok with empty issues on empty hits', async () => {
    const result = await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
      { fetchFn: mockFetch({ '/_search': { body: { hits: { hits: [] } } } }) }
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 0);
  });
});

describe('handleLogstash — Field edge cases', () => {
  it('uses "No message" when message field is missing', async () => {
    const noMsgHits = {
      hits: { hits: [{ _id: 'x1', _source: { level: 'error', '@timestamp': '2026-03-04T14:00:00Z' } }] }
    };

    const result = await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
      { fetchFn: mockFetch({ '/_search': { body: noMsgHits } }) }
    );

    assert.equal(result.issues[0].title, 'No message');
  });

  it('defaults to info severity when level field is missing', async () => {
    const noLevelHits = {
      hits: { hits: [{ _id: 'x2', _source: { message: 'Test', '@timestamp': '2026-03-04T14:00:00Z' } }] }
    };

    const result = await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
      { fetchFn: mockFetch({ '/_search': { body: noLevelHits } }) }
    );

    assert.equal(result.issues[0].severity, 'info');
  });

  it('normalizes "warning" level to warning severity', async () => {
    const warningHits = {
      hits: { hits: [{ _id: 'x3', _source: { message: 'Test', level: 'warning', '@timestamp': '2026-03-04T14:00:00Z' } }] }
    };

    const result = await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
      { fetchFn: mockFetch({ '/_search': { body: warningHits } }) }
    );

    assert.equal(result.issues[0].severity, 'warning');
  });

  it('includes compact meta from extra _source fields', async () => {
    const result = await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200', index: 'logstash-*', issue_type: 'issue' },
      { fetchFn: mockFetch({ '/_search': { body: SAMPLE_ES_RESPONSE } }) }
    );

    // Meta should include extra fields like host, service
    assert.ok(result.issues[0].meta.includes('app-server-01') || result.issues[0].meta.includes('api-gateway'),
      'Meta should include extra source fields');
  });
});

describe('handleLogstash — Adversarial config', () => {
  it('returns error result instead of throwing when sourceConfig is null', async () => {
    const result = await handleLogstash(null, {});
    assert.equal(result.status, 'error', 'null config should fail-open to error');
    assert.equal(result.source_type, 'logstash');
    assert.ok(Array.isArray(result.issues), 'issues must be an array');
    assert.equal(result.issues.length, 0);
  });

  it('returns error result when sourceConfig is undefined', async () => {
    const result = await handleLogstash(undefined, {});
    assert.equal(result.status, 'error');
    assert.equal(result.issues.length, 0);
  });
});

describe('handleLogstash — non-string message', () => {
  it('coerces a non-string (object) message to a string title', async () => {
    const objMsgHits = {
      hits: { hits: [{ _id: 'm1', _source: { message: { code: 500, detail: 'boom' }, level: 'error', '@timestamp': '2026-03-04T14:00:00Z' } }] }
    };
    const result = await handleLogstash(
      { type: 'logstash', label: 'ES', endpoint: 'https://es:9200' },
      { fetchFn: mockFetch({ '/_search': { body: objMsgHits } }) }
    );
    assert.equal(result.status, 'ok');
    assert.equal(typeof result.issues[0].title, 'string', 'title must be a string even for non-string message');
  });
});

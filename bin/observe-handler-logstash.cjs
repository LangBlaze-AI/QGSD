/**
 * Logstash/Elasticsearch source handler for /nf:observe
 * Queries Elasticsearch indices for log entries matching severity filters
 * Returns standard issue schema for the observe registry
 */

const { formatAge } = require('./observe-utils.cjs');

/**
 * Normalize log level to standard severity
 * @param {string} level - Log level from Elasticsearch hit
 * @returns {string} Normalized severity
 */
function normalizeSeverity(level) {
  if (!level) return 'info';
  const lower = String(level).toLowerCase();
  const mapping = {
    error: 'error',
    fatal: 'error',
    critical: 'error',
    warn: 'warning',
    warning: 'warning',
    info: 'info',
    debug: 'info',
    trace: 'info'
  };
  return mapping[lower] || 'info';
}

/**
 * Logstash/Elasticsearch source handler
 * Queries Elasticsearch indices for log entries and maps hits to standard schema
 *
 * @param {object} sourceConfig - { type, label, endpoint, index?, auth_env?, auth_type?, filter?, issue_type? }
 * @param {object} options - { fetchFn? }
 * @returns {Promise<object>} Standard schema result
 */
async function handleLogstash(sourceConfig, options) {
  if (!sourceConfig || typeof sourceConfig !== 'object') {
    return {
      source_label: 'Logstash',
      source_type: 'logstash',
      status: 'error',
      error: 'Invalid sourceConfig: expected an object',
      issues: []
    };
  }
  const label = sourceConfig.label || 'Logstash';
  const endpoint = (sourceConfig.endpoint || '').replace(/\/$/, '');
  const index = sourceConfig.index || 'logstash-*';
  const fetchFn = (options && options.fetchFn) || globalThis.fetch;
  const filter = sourceConfig.filter || {};

  try {
    // Build auth headers
    const headers = { 'Content-Type': 'application/json' };
    if (sourceConfig.auth_env) {
      const token = process.env[sourceConfig.auth_env];
      if (token) {
        const authType = sourceConfig.auth_type || 'ApiKey';
        headers['Authorization'] = `${authType} ${token}`;
      }
    }

    // Build Elasticsearch DSL query
    const since = filter.since || '1h';
    const levels = filter.levels || ['error', 'warn'];
    const limit = filter.limit || 50;

    const queryBody = {
      query: {
        bool: {
          filter: [
            { range: { '@timestamp': { gte: `now-${since}` } } },
            { terms: { level: levels } }
          ]
        }
      },
      size: limit,
      sort: [{ '@timestamp': 'desc' }]
    };

    const url = `${endpoint}/${index}/_search`;
    const response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(queryBody)
    });

    if (!response.ok) {
      return {
        source_label: label,
        source_type: 'logstash',
        status: 'error',
        error: `HTTP ${response.status} from Elasticsearch`,
        issues: []
      };
    }

    const data = await response.json();
    const hits = (data && data.hits && Array.isArray(data.hits.hits)) ? data.hits.hits : [];

    const issues = hits.map((hit, idx) => {
      const source = hit._source || {};
      const message = source.message ? String(source.message) : 'No message';
      const title = message.length > 120 ? message.slice(0, 120) + '...' : message;
      const level = source.level || '';
      const timestamp = source['@timestamp'] || new Date().toISOString();

      // Build compact meta from extra fields (exclude message and @timestamp)
      const extraFields = Object.entries(source)
        .filter(([k]) => k !== 'message' && k !== '@timestamp' && k !== 'level')
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      const meta = extraFields.length > 200 ? extraFields.slice(0, 200) + '...' : extraFields;

      return {
        id: `es-${hit._id || idx}`,
        title,
        severity: normalizeSeverity(level),
        url: '',
        age: formatAge(timestamp),
        created_at: timestamp,
        meta,
        source_type: 'logstash',
        issue_type: sourceConfig.issue_type || 'issue'
      };
    });

    return {
      source_label: label,
      source_type: 'logstash',
      status: 'ok',
      issues
    };
  } catch (err) {
    return {
      source_label: label,
      source_type: 'logstash',
      status: 'error',
      error: `Elasticsearch fetch failed: ${err.message}`,
      issues: []
    };
  }
}

module.exports = { handleLogstash };

/**
 * Prometheus source handler for /nf:observe
 * Supports: /api/v1/alerts (active alerts) and /api/v1/query (PromQL)
 * Returns standard issue schema for the observe registry
 */

const { formatAge } = require('./observe-utils.cjs');

/**
 * Prometheus source handler
 * Fetches alerts or runs PromQL query, maps results to standard issue schema
 *
 * @param {object} sourceConfig - { type, label, endpoint, auth_env?, query?, threshold?, issue_type? }
 * @param {object} options - { fetchFn? }
 * @returns {Promise<object>} Standard schema result
 */
async function handlePrometheus(sourceConfig, options) {
  if (!sourceConfig || typeof sourceConfig !== 'object') sourceConfig = {};
  const label = sourceConfig.label || 'Prometheus';
  const endpoint = (sourceConfig.endpoint || '').replace(/\/$/, '');
  const fetchFn = (options && options.fetchFn) || globalThis.fetch;

  try {
    // Build auth headers
    const headers = {};
    if (sourceConfig.auth_env) {
      const token = process.env[sourceConfig.auth_env];
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    // Choose mode: query field → PromQL, else → alerts
    const hasQuery = sourceConfig.query && sourceConfig.query.trim().length > 0;
    const url = hasQuery
      ? `${endpoint}/api/v1/query?query=${encodeURIComponent(sourceConfig.query)}`
      : `${endpoint}/api/v1/alerts`;

    const response = await fetchFn(url, { headers });

    if (!response.ok) {
      return {
        source_label: label,
        source_type: 'prometheus',
        status: 'error',
        error: `HTTP ${response.status} from Prometheus`,
        issues: []
      };
    }

    const data = await response.json();

    if (hasQuery) {
      return mapQueryResult(data, sourceConfig, label);
    } else {
      return mapAlertsResult(data, sourceConfig, label);
    }
  } catch (err) {
    return {
      source_label: label,
      source_type: 'prometheus',
      status: 'error',
      error: `Prometheus fetch failed: ${err.message}`,
      issues: []
    };
  }
}

/**
 * Map /api/v1/alerts response to standard schema
 */
function mapAlertsResult(data, sourceConfig, label) {
  const alerts = (data && data.data && Array.isArray(data.data.alerts)) ? data.data.alerts : [];

  const issues = alerts.map((alert, idx) => {
    if (!alert || typeof alert !== 'object') alert = {};
    const labels = alert.labels || {};
    const annotations = alert.annotations || {};
    const alertname = labels.alertname || `alert-${idx}`;
    const severity = labels.severity || 'warning';
    const state = alert.state || 'unknown';
    const activeAt = alert.activeAt || new Date().toISOString();

    // Build meta: state + key labels
    const metaParts = [`state: ${state}`];
    if (annotations.summary) metaParts.push(annotations.summary);
    const labelKeys = Object.keys(labels).filter(k => k !== 'alertname' && k !== 'severity');
    if (labelKeys.length > 0) {
      metaParts.push(labelKeys.map(k => `${k}=${labels[k]}`).join(', '));
    }

    return {
      id: `prom-alert-${idx}`,
      title: alertname,
      severity,
      url: alert.generatorURL || `${sourceConfig.endpoint || ''}/alerts`,
      age: formatAge(activeAt),
      created_at: activeAt,
      meta: metaParts.join(' | '),
      source_type: 'prometheus',
      issue_type: sourceConfig.issue_type || 'drift'
    };
  });

  return {
    source_label: label,
    source_type: 'prometheus',
    status: 'ok',
    issues
  };
}

/**
 * Map /api/v1/query response to standard schema
 */
function mapQueryResult(data, sourceConfig, label) {
  const resultType = (data && data.data && data.data.resultType) || 'vector';
  const result = (data && data.data && data.data.result) || [];

  let issues = [];

  if (resultType === 'scalar') {
    // Scalar: result is [timestamp, "value"]
    const value = Array.isArray(result) ? result[1] : String(result);
    issues = [{
      id: 'prom-query-scalar',
      title: `Query result: ${sourceConfig.query || 'scalar'}`,
      severity: 'info',
      url: sourceConfig.endpoint || '',
      age: '',
      created_at: new Date().toISOString(),
      meta: `value: ${value}`,
      source_type: 'prometheus',
      issue_type: sourceConfig.issue_type || 'drift'
    }];
  } else {
    // Vector: result is array of { metric: {...}, value: [ts, "val"] }
    issues = (Array.isArray(result) ? result : []).map((item, idx) => {
      if (!item || typeof item !== 'object') item = {};
      const metric = item.metric || {};
      const metricName = metric.__name__ || 'unknown_metric';
      const value = Array.isArray(item.value) ? item.value[1] : '0';

      // Build title from metric name + labels
      const labelParts = Object.entries(metric)
        .filter(([k]) => k !== '__name__')
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ');
      const title = labelParts ? `${metricName}{${labelParts}}` : metricName;

      return {
        id: `prom-query-${idx}`,
        title,
        severity: 'info',
        url: sourceConfig.endpoint || '',
        age: '',
        created_at: new Date().toISOString(),
        meta: `value: ${value}`,
        source_type: 'prometheus',
        issue_type: sourceConfig.issue_type || 'drift'
      };
    });
  }

  return {
    source_label: label,
    source_type: 'prometheus',
    status: 'ok',
    issues
  };
}

module.exports = { handlePrometheus };

/**
 * Dependency freshness handler for /nf:observe
 * Auto-detects project ecosystem (Node/Python) and checks for:
 *   - Outdated packages (npm outdated / pip list --outdated)
 *   - Runtime version (node / python LTS vs current)
 *   - Security audit (npm audit / pip-audit)
 *
 * issue_type: 'deps' — rendered in its own DEPENDENCIES table
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Detect which ecosystems are present in the project
 * @param {string} basePath
 * @returns {string[]} Array of ecosystem identifiers: 'node', 'python'
 */
function detectEcosystems(basePath) {
  const base = basePath || process.cwd();
  const ecosystems = [];
  if (fs.existsSync(path.join(base, 'package.json'))) ecosystems.push('node');
  if (
    fs.existsSync(path.join(base, 'requirements.txt')) ||
    fs.existsSync(path.join(base, 'pyproject.toml')) ||
    fs.existsSync(path.join(base, 'Pipfile'))
  ) {
    ecosystems.push('python');
  }
  return ecosystems;
}

/**
 * Parse a semver string into [major, minor, patch]
 * @param {string} ver
 * @returns {number[]}
 */
function parseSemver(ver) {
  if (!ver) return [0, 0, 0];
  const clean = String(ver).replace(/^v/, '');
  const parts = clean.split('.').map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Classify severity based on version bump type
 * @param {string} current
 * @param {string} latest
 * @returns {string} 'error' | 'warning' | 'info'
 */
function classifyVersionBump(current, latest) {
  const [curMaj, curMin] = parseSemver(current);
  const [latMaj, latMin] = parseSemver(latest);
  if (latMaj > curMaj) return 'warning'; // major bump — potential breaking
  if (latMin > curMin) return 'info';     // minor bump — new features
  return 'info';                          // patch bump
}

/**
 * Check Node.js outdated packages via npm outdated
 * @param {string} basePath
 * @param {Function} execFn
 * @returns {object[]} Array of dep issue objects
 */
function checkNpmOutdated(basePath, execFn) {
  const execFile = execFn || execFileSync;
  const issues = [];

  try {
    // npm outdated exits with code 1 when there are outdated deps — that's expected
    let output;
    try {
      output = execFile('npm', ['outdated', '--json'], { encoding: 'utf8', cwd: basePath });
    } catch (err) {
      // npm outdated returns exit code 1 when outdated packages exist
      output = err.stdout || '';
    }

    if (!output || !output.trim()) return issues;
    const outdated = JSON.parse(output);

    for (const [pkg, info] of Object.entries(outdated)) {
      const current = info.current || '?';
      const latest = info.latest || '?';
      const wanted = info.wanted || latest;
      const severity = classifyVersionBump(current, latest);
      const bumpType = (() => {
        const [curMaj] = parseSemver(current);
        const [latMaj, latMin] = parseSemver(latest);
        if (latMaj > curMaj) return 'MAJOR';
        if (latMin > parseSemver(current)[1]) return 'minor';
        return 'patch';
      })();

      issues.push({
        id: `dep-npm-${pkg}`,
        title: `${pkg} ${current} → ${latest}`,
        severity,
        url: `https://www.npmjs.com/package/${pkg}`,
        age: '',
        created_at: new Date().toISOString(),
        meta: `${bumpType} · wanted ${wanted}`,
        source_type: 'deps',
        issue_type: 'deps',
        _deps: { ecosystem: 'node', pkg, current, latest, wanted, bumpType }
      });
    }
  } catch {
    // npm not available or parse error — silently skip
  }

  return issues;
}

// Known Node.js LTS major versions — update when new LTS ships
// See https://nodejs.org/en/about/previous-releases
const NODE_LTS_MAJOR = 22; // LTS codename "Jod", active until 2027-10

/**
 * Check Node.js runtime version against known LTS major
 * Uses a locally maintained constant instead of unreliable npm registry queries.
 * @param {Function} execFn
 * @returns {object|null} Issue object or null if up to date
 */
function checkNodeVersion(execFn) {
  const execFile = execFn || execFileSync;
  try {
    const current = execFile('node', ['--version'], { encoding: 'utf8' }).trim();
    const [curMaj] = parseSemver(current);

    if (NODE_LTS_MAJOR > curMaj) {
      return {
        id: 'dep-runtime-node',
        title: `Node.js ${current} → v${NODE_LTS_MAJOR}.x LTS`,
        severity: 'warning',
        url: 'https://nodejs.org/en/download',
        age: '',
        created_at: new Date().toISOString(),
        meta: `runtime · ${NODE_LTS_MAJOR - curMaj} major version(s) behind`,
        source_type: 'deps',
        issue_type: 'deps',
        _deps: { ecosystem: 'node', pkg: 'node', current, latest: `v${NODE_LTS_MAJOR}.x`, bumpType: 'MAJOR' }
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check npm audit for known vulnerabilities
 * @param {string} basePath
 * @param {Function} execFn
 * @returns {object[]} Array of vulnerability issue objects
 */
function checkNpmAudit(basePath, execFn) {
  const execFile = execFn || execFileSync;
  const issues = [];

  try {
    let output;
    try {
      output = execFile('npm', ['audit', '--json'], { encoding: 'utf8', cwd: basePath });
    } catch (err) {
      output = err.stdout || '';
    }

    if (!output || !output.trim()) return issues;
    const audit = JSON.parse(output);
    const vulnerabilities = audit.vulnerabilities || {};

    for (const [pkg, info] of Object.entries(vulnerabilities)) {
      const sevMap = { critical: 'error', high: 'error', moderate: 'warning', low: 'info' };
      const severity = sevMap[info.severity] || 'info';
      const via = Array.isArray(info.via) ? info.via.map(v => typeof v === 'string' ? v : v.title || v.name || '').filter(Boolean).join(', ') : '';

      issues.push({
        id: `dep-vuln-${pkg}`,
        title: `[VULN] ${pkg}: ${via || info.severity}`,
        severity,
        url: info.url || `https://www.npmjs.com/advisories`,
        age: '',
        created_at: new Date().toISOString(),
        meta: `${info.severity} · ${info.range || 'all versions'} · fix: ${info.fixAvailable ? 'available' : 'none'}`,
        source_type: 'deps',
        issue_type: 'deps',
        _deps: { ecosystem: 'node', pkg, bumpType: 'VULN', severity: info.severity }
      });
    }
  } catch {
    // npm audit not available — skip
  }

  return issues;
}

/**
 * Check Python outdated packages via pip
 * @param {string} basePath
 * @param {Function} execFn
 * @returns {object[]} Array of dep issue objects
 */
function checkPipOutdated(basePath, execFn) {
  const execFile = execFn || execFileSync;
  const issues = [];

  try {
    const output = execFile('pip', ['list', '--outdated', '--format=json'], { encoding: 'utf8', cwd: basePath });
    const outdated = JSON.parse(output);

    for (const pkg of outdated) {
      const current = pkg.version || '?';
      const latest = pkg.latest_version || '?';
      const severity = classifyVersionBump(current, latest);
      const bumpType = (() => {
        const [curMaj] = parseSemver(current);
        const [latMaj, latMin] = parseSemver(latest);
        if (latMaj > curMaj) return 'MAJOR';
        if (latMin > parseSemver(current)[1]) return 'minor';
        return 'patch';
      })();

      issues.push({
        id: `dep-pip-${pkg.name}`,
        title: `${pkg.name} ${current} → ${latest}`,
        severity,
        url: `https://pypi.org/project/${pkg.name}/`,
        age: '',
        created_at: new Date().toISOString(),
        meta: `${bumpType} · ${pkg.latest_filetype || 'wheel'}`,
        source_type: 'deps',
        issue_type: 'deps',
        _deps: { ecosystem: 'python', pkg: pkg.name, current, latest, bumpType }
      });
    }
  } catch {
    // pip not available — skip
  }

  return issues;
}

// Known Python minimum recommended minor version — update when new stable ships
// See https://devguide.python.org/versions/
const PYTHON_MIN_MINOR = 12; // 3.12+ recommended (3.11 security-only since 2025-10)

/**
 * Check Python runtime version against minimum recommended
 * Uses a locally maintained constant for the threshold.
 * @param {Function} execFn
 * @returns {object|null}
 */
function checkPythonVersion(execFn) {
  const execFile = execFn || execFileSync;
  try {
    const output = execFile('python3', ['--version'], { encoding: 'utf8' }).trim();
    const current = output.replace(/^Python\s+/, '');
    const [curMaj, curMin] = parseSemver(current);
    if (curMaj === 3 && curMin < PYTHON_MIN_MINOR) {
      return {
        id: 'dep-runtime-python',
        title: `Python ${current} → 3.${PYTHON_MIN_MINOR}+`,
        severity: 'info',
        url: 'https://www.python.org/downloads/',
        age: '',
        created_at: new Date().toISOString(),
        meta: `runtime · consider upgrading`,
        source_type: 'deps',
        issue_type: 'deps',
        _deps: { ecosystem: 'python', pkg: 'python', current, latest: `3.${PYTHON_MIN_MINOR}+`, bumpType: 'MAJOR' }
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Deps source handler
 * Auto-detects ecosystem and checks outdated packages, runtime version, and audit
 *
 * @param {object} sourceConfig - { type: 'deps', label, ecosystems?: ['node','python'], skip_audit?: boolean }
 * @param {object} options - { execFn?, basePath? }
 * @returns {object} Standard observe schema result
 */
function handleDeps(sourceConfig, options) {
  const cfg = sourceConfig && typeof sourceConfig === 'object' ? sourceConfig : {};
  const opts = options && typeof options === 'object' ? options : {};
  const label = cfg.label || 'Dependencies';
  const basePath = opts.basePath || process.cwd();
  const execFile = opts.execFn || execFileSync;
  const skipAudit = cfg.skip_audit || false;

  try {
    // Auto-detect or use configured ecosystems
    const ecosystems = cfg.ecosystems
      ? (Array.isArray(cfg.ecosystems) ? cfg.ecosystems : [cfg.ecosystems])
      : detectEcosystems(basePath);

    if (ecosystems.length === 0) {
      return {
        source_label: label,
        source_type: 'deps',
        status: 'ok',
        issues: []
      };
    }

    const issues = [];

    if (ecosystems.includes('node')) {
      issues.push(...checkNpmOutdated(basePath, execFile));
      const nodeVer = checkNodeVersion(execFile);
      if (nodeVer) issues.push(nodeVer);
      if (!skipAudit) {
        issues.push(...checkNpmAudit(basePath, execFile));
      }
    }

    if (ecosystems.includes('python')) {
      issues.push(...checkPipOutdated(basePath, execFile));
      const pyVer = checkPythonVersion(execFile);
      if (pyVer) issues.push(pyVer);
    }

    return {
      source_label: label,
      source_type: 'deps',
      status: 'ok',
      issues
    };
  } catch (err) {
    return {
      source_label: label,
      source_type: 'deps',
      status: 'error',
      error: `Deps check failed: ${err.message}`,
      issues: []
    };
  }
}

module.exports = {
  handleDeps,
  detectEcosystems,
  checkNpmOutdated,
  checkNpmAudit,
  checkNodeVersion,
  checkPipOutdated,
  checkPythonVersion,
  classifyVersionBump,
  parseSemver,
  NODE_LTS_MAJOR,
  PYTHON_MIN_MINOR
};

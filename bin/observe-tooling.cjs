'use strict';

/**
 * observe-tooling.cjs — CLI tooling preflight for /nf:observe
 *
 * Some observe sources are backed by an external CLI rather than a plain HTTP
 * endpoint: the Sentry sources lean on `sentry-cli` and the Grafana source on
 * `gcx` (the Grafana Cloud CLI). When one of those sources errors, the failure
 * is frequently NOT a real drift/issue — it's that the CLI is missing or the
 * user never authenticated it. This module detects install + auth state for
 * those CLIs so observe can (a) show a preflight line and (b) annotate any
 * errored source with a tooling hint instead of surfacing it as noise.
 *
 * Split into PURE (testable without shelling out) and IMPURE (runs the CLI):
 *   - interpretTool / renderToolingStatus / annotateResultsWithTooling are pure
 *   - detectObserveTooling shells out (spawnFn injectable for tests)
 *
 * Fail-open everywhere: a missing CLI, a crash, or an odd exit code degrades to
 * "not installed / not authed" — it never throws into the observe pipeline.
 */

const { spawnSync } = require('child_process');

// Each tool maps to the observe source `type`s whose errors it can explain.
const OBSERVE_TOOLS = [
  {
    name: 'sentry-cli',
    bin: 'sentry-cli',
    versionArgs: ['--version'],
    authArgs: ['info'],
    sources: ['sentry', 'sentry-feedback'],
    // `sentry-cli info` prints an "Authentication Info:" block with a "Method:"
    // line only when a token is present; absent when unauthenticated.
    authOk: (r) => r.status === 0 && /Method:/.test(String((r && r.stdout) || '')),
    installHint: 'brew install getsentry/tools/sentry-cli  (or npm i -g @sentry/cli)',
    authHint: 'sentry-cli login  (or set SENTRY_AUTH_TOKEN)',
  },
  {
    name: 'gcx',
    bin: 'gcx',
    versionArgs: ['--version'],
    authArgs: ['config', 'current-context'],
    sources: ['grafana'],
    // `gcx config current-context` prints the active context name (non-empty)
    // once a login context exists; errors / prints nothing when unconfigured.
    authOk: (r) => r.status === 0 && String((r && r.stdout) || '').trim().length > 0,
    installHint: 'brew install grafana/grafana/gcx',
    authHint: 'gcx login',
  },
];

/**
 * PURE — pull an X.Y.Z-ish version out of a --version line. Returns null when
 * no version token is present (e.g. the CLI was not found).
 * @param {string} stdout
 * @returns {string|null}
 */
function parseVersion(stdout) {
  const m = String(stdout || '').match(/(\d+\.\d+\.\d+[\w.-]*)/);
  return m ? m[1] : null;
}

/**
 * PURE — turn raw (versionResult, authResult) spawn shapes into a status object.
 * A spawn shape is `{ status, stdout, error }` (as spawnSync returns; `error`
 * set + `status` null means the binary was not found — ENOENT).
 *
 * @param {object} tool  - one OBSERVE_TOOLS entry
 * @param {object} versionResult - spawn result of `<bin> --version`
 * @param {object} authResult    - spawn result of the tool's auth-probe command
 * @returns {{name,installed,authed,healthy,version,sources,hint}}
 */
function interpretTool(tool, versionResult, authResult) {
  const vr = versionResult || {};
  // Installed = the version probe actually ran a real binary and exited 0.
  // ENOENT surfaces as vr.error truthy with vr.status === null.
  const installed = !vr.error && vr.status === 0;
  const version = installed ? parseVersion(vr.stdout) : null;
  const authed = installed ? !!tool.authOk(authResult || {}) : false;
  const hint = !installed ? tool.installHint : (!authed ? tool.authHint : null);
  return {
    name: tool.name,
    installed,
    authed,
    healthy: installed && authed,
    version,
    sources: tool.sources.slice(),
    hint,
  };
}

/**
 * IMPURE — probe every tool in OBSERVE_TOOLS. spawnFn is injectable so tests
 * never touch the real CLIs. Each probe is time-boxed; any throw degrades that
 * tool to "not installed" rather than propagating.
 *
 * @param {object} [opts]
 * @param {Function} [opts.spawnFn] - spawnSync-compatible (cmd, args, options)
 * @param {number}   [opts.timeoutMs] - per-probe timeout (default 5000)
 * @param {object[]} [opts.tools] - override tool list (tests)
 * @param {string[]|Set<string>} [opts.sourceTypes] - if given, only probe tools
 *   that back at least one of these observe source types. Lets callers skip the
 *   sentry-cli/gcx subprocess probes entirely on internal-only or single-backend
 *   runs, keeping the common no-op path fast.
 * @returns {object[]} array of interpretTool status objects
 */
function detectObserveTooling(opts = {}) {
  const spawnFn = (opts && opts.spawnFn) || spawnSync;
  const timeout = (opts && opts.timeoutMs) || 5000;
  let tools = (opts && opts.tools) || OBSERVE_TOOLS;
  if (opts && opts.sourceTypes) {
    const wanted = opts.sourceTypes instanceof Set
      ? opts.sourceTypes
      : new Set(Array.isArray(opts.sourceTypes) ? opts.sourceTypes : []);
    // Only probe a CLI whose backed sources intersect the configured types —
    // no shelling out for a tool this run can't possibly need.
    tools = tools.filter((t) => t.sources.some((s) => wanted.has(s)));
  }
  const run = (bin, args) => {
    try {
      return spawnFn(bin, args, { encoding: 'utf8', timeout });
    } catch (err) {
      // Treat a thrown spawn (rare) the same as ENOENT.
      return { status: null, stdout: '', error: err };
    }
  };
  return tools.map((tool) => {
    const versionResult = run(tool.bin, tool.versionArgs);
    // Skip the auth probe entirely when the binary isn't there — no point.
    const looksInstalled = versionResult && !versionResult.error && versionResult.status === 0;
    const authResult = looksInstalled ? run(tool.bin, tool.authArgs) : {};
    return interpretTool(tool, versionResult, authResult);
  });
}

/**
 * PURE — one-line human status per tool, for the observe preflight header.
 * @param {object[]} statuses - output of detectObserveTooling
 * @returns {string}
 */
function renderToolingStatus(statuses) {
  const rows = (Array.isArray(statuses) ? statuses : []).map((s) => {
    const mark = s.healthy ? '✓' : '✗';
    const state = !s.installed ? 'not installed'
      : !s.authed ? 'not authenticated'
      : 'authenticated';
    const ver = s.version ? ` ${s.version}` : '';
    const scope = `(${(s.sources || []).join(', ')})`;
    const tip = s.hint ? `  → ${s.hint}` : '';
    return ` ${mark} ${s.name}${ver}  ${state}  ${scope}${tip}`;
  });
  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ' nForma > OBSERVE: tooling preflight',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ...rows,
  ].join('\n');
}

/**
 * PURE — annotate errored source results with a tooling hint when the failing
 * source's type is backed by a CLI that is missing/unauthenticated. Leaves
 * healthy tools and successful (status:'ok') results untouched. Returns the
 * same array (mutated in place) for convenient chaining.
 *
 * @param {object[]} results  - observe dispatch results
 * @param {object[]} statuses - detectObserveTooling output
 * @returns {object[]}
 */
function annotateResultsWithTooling(results, statuses) {
  if (!Array.isArray(results)) return results;
  const bySource = {};
  for (const s of (Array.isArray(statuses) ? statuses : [])) {
    if (s.healthy) continue; // healthy tool can't be the cause of an error
    for (const src of (s.sources || [])) {
      // First unhealthy tool wins per source type.
      if (!bySource[src]) bySource[src] = s;
    }
  }
  for (const r of results) {
    if (!r || r.status === 'ok') continue;
    const s = bySource[r.source_type];
    if (!s) continue;
    const reason = !s.installed ? `${s.name} not installed` : `${s.name} not authenticated`;
    r.tooling_hint = `${reason} — this error is likely tooling, not drift. Fix: ${s.hint}`;
  }
  return results;
}

module.exports = {
  OBSERVE_TOOLS,
  parseVersion,
  interpretTool,
  detectObserveTooling,
  renderToolingStatus,
  annotateResultsWithTooling,
};

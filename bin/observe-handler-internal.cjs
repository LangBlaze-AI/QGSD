/**
 * Internal work detection handler for /nf:observe
 * Scans local project state for:
 * 1. Unfinished quick tasks (PLAN.md without SUMMARY.md)
 * 2. Stale debug sessions (quorum-debug-latest.md)
 * 3. TODO/FIXME/HACK/XXX comments in codebase (tracked as debt)
 * 4. Active milestone phases without VERIFICATION.md
 * 5. Proposed metrics from formal models (unimplemented instrumentation)
 * 6. Quorum slot reachability (probe-quorum-slots.cjs)
 * 7. XState maxDeliberation calibration (verify-quorum-health.cjs)
 * 8. MCP server health (check-mcp-health.cjs)
 * 9. MCP debug log anomalies (review-mcp-logs.cjs)
 * 10. Telemetry anomalies (telemetry-collector.cjs)
 * 11. Observed FSM divergences (observed-fsm.cjs)
 * 12. Sensitivity sweep prediction mismatches (sensitivity-sweep-feedback.cjs)
 * 13. Security findings (security-sweep.cjs)
 * 14. Issue classification from telemetry (issue-classifier.cjs)
 * 15. Health diagnostics (nf-tools validate health) — QNF repo only
 * 16. Accumulated error patterns (errors.jsonl via memory-store.cjs)
 * 17. Feature usefulness report (feature-report.cjs)
 *
 * Returns standard observe schema: { source_label, source_type, status, issues[] }
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const os = require('node:os');
const { formatAgeFromMtime } = require('./observe-utils.cjs');
const { loadProviders } = require('./resolve-providers.cjs');

/**
 * Internal work detection handler
 * Scans 17 categories: quick tasks, debug sessions, TODOs, unverified phases,
 * proposed metrics, quorum slots, XState calibration, MCP health, MCP logs,
 * telemetry, observed FSM, sensitivity sweep, security, issue classification,
 * health diagnostics, error patterns, feature usefulness
 *
 * @param {object} sourceConfig - { label?, ...other config }
 * @param {object} options - { projectRoot?, limitOverride? }
 * @returns {object} Standard observe schema result
 */
function handleInternal(sourceConfig, options) {
  // Defensive normalization: tolerate null/undefined/non-object args so the
  // fail-open contract holds even before the outer try block below.
  const cfg = (sourceConfig && typeof sourceConfig === 'object') ? sourceConfig : {};
  const opts = (options && typeof options === 'object') ? options : {};
  const label = cfg.label || 'Internal Work';
  const projectRoot = opts.projectRoot || process.cwd();
  const issues = [];

  // Categories 6–14 and 17 shell out (via resolveScript, below) to installed
  // diagnostic scripts that probe the network / telemetry / MCP fleet and take
  // real wall-clock time (each spawnSync carries a 15–30s timeout, and because
  // this handler is synchronous the dispatch-layer race timeout cannot preempt
  // them). A caller running in a unit/CI context — or simply offline — can
  // suppress those live probes with opts.skipLiveProbes or the
  // NF_OBSERVE_SKIP_LIVE_PROBES=1 env var. The fast, deterministic file-scan
  // categories (1–5, 15, 16) are unaffected: they resolve project-local paths
  // directly rather than through resolveScript.
  const skipLiveProbes = opts.skipLiveProbes === true
    || process.env.NF_OBSERVE_SKIP_LIVE_PROBES === '1';

  try {
    // Category 1: Unfinished quick tasks
    try {
      const quickDir = path.resolve(projectRoot, '.planning/quick');
      if (fs.existsSync(quickDir)) {
        const entries = fs.readdirSync(quickDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          // Extract task number from directory name: e.g., "168-add-internal-work-detection"
          const dirName = entry.name;
          const match = dirName.match(/^(\d+)-/);
          if (!match) continue;

          const taskNum = match[1];
          const slug = dirName.slice(match[0].length);

          const planPath = path.join(quickDir, dirName, `${taskNum}-PLAN.md`);
          const summaryPath = path.join(quickDir, dirName, `${taskNum}-SUMMARY.md`);

          // Check: PLAN exists but SUMMARY does not
          if (fs.existsSync(planPath) && !fs.existsSync(summaryPath)) {
            const planStat = fs.statSync(planPath);
            issues.push({
              id: `internal-quick-${taskNum}`,
              title: `Unfinished quick task #${taskNum}: ${slug}`,
              severity: 'warning',
              url: '',
              age: formatAgeFromMtime(planStat.mtime),
              created_at: planStat.mtime.toISOString(),
              meta: 'PLAN exists, no SUMMARY',
              source_type: 'internal',
              issue_type: 'issue',
              _route: `/nf:quick "${slug}"`
            });
          }
        }
      }
    } catch (err) {
      // Log warning but continue with other scans (fail-open)
      console.warn(`[observe-internal] Warning scanning quick tasks: ${err.message}`);
    }

    // Category 2: Stale debug sessions
    try {
      const debugPath = path.resolve(projectRoot, '.planning/quick/quorum-debug-latest.md');
      if (fs.existsSync(debugPath)) {
        const stat = fs.statSync(debugPath);

        // Check if less than 7 days old
        const diffMs = Date.now() - stat.mtime.getTime();
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

        if (diffMs < sevenDaysMs) {
          // Read file content to check for "unresolved" or "status: open"
          const content = fs.readFileSync(debugPath, 'utf8');
          const isUnresolved = /unresolved|status:\s*open/i.test(content);

          if (isUnresolved) {
            issues.push({
              id: 'internal-debug-latest',
              title: 'Unresolved debug session: quorum-debug-latest.md',
              severity: 'info',
              url: '',
              age: formatAgeFromMtime(stat.mtime),
              created_at: stat.mtime.toISOString(),
              meta: 'Debug session may need resolution',
              source_type: 'internal',
              issue_type: 'issue',
              _route: '/nf:debug --resume'
            });
          }
        }
      }
    } catch (err) {
      // Log warning but continue with other scans (fail-open)
      console.warn(`[observe-internal] Warning scanning debug sessions: ${err.message}`);
    }

    // Category 3: TODO/FIXME/HACK/XXX comments in codebase
    try {
      // Fix 5: Validate projectRoot exists before running grep
      if (!fs.existsSync(projectRoot)) {
        console.warn(`[observe-internal] projectRoot does not exist: ${projectRoot}, skipping TODO scan`);
      } else {
        const todoPatterns = [
          { tag: 'FIXME', severity: 'warning' },
          { tag: 'HACK', severity: 'warning' },
          { tag: 'XXX', severity: 'warning' },
          { tag: 'TODO', severity: 'info' }
        ];

        // Fix 2: Exclude .planning/ at grep level (not post-filter) to ensure
        // limit cap applies to real results, not .planning/ noise
        const excludeDirs = [
          'node_modules', '.git', '.planning',
          'vendor', 'dist', '.next', 'coverage'
        ];
        const excludeGlobs = excludeDirs.map(d => `--exclude-dir=${d}`);

        // File extensions to scan
        const includeExts = ['--include=*.js', '--include=*.cjs', '--include=*.mjs',
          '--include=*.ts', '--include=*.tsx', '--include=*.jsx',
          '--include=*.md', '--include=*.json', '--include=*.py',
          '--include=*.sh', '--include=*.css', '--include=*.html'];

        // Single grep call for all patterns: TODO|FIXME|HACK|XXX
        // Fix 1: Use -Z (--null) for NUL-separated file:line:content to handle colons in paths
        const pattern = '\\b(TODO|FIXME|HACK|XXX)\\b';
        const grepArgs = ['-rnZ', '-E', pattern, ...includeExts, ...excludeGlobs, projectRoot];

        let grepOutput = '';
        try {
          grepOutput = execFileSync('grep', grepArgs, {
            encoding: 'utf8',
            maxBuffer: 5 * 1024 * 1024, // 5MB cap
            timeout: 15000 // 15s timeout
          });
        } catch (grepErr) {
          // grep exits 1 when no matches found — that's fine
          if (grepErr.status !== 1) {
            console.warn(`[observe-internal] grep failed: ${grepErr.message}`);
          }
        }

        if (grepOutput) {
          const lines = grepOutput.split('\n').filter(l => l.trim());
          const limit = opts.limitOverride || 50; // Cap to avoid noise
          const todoSeverityMap = Object.fromEntries(todoPatterns.map(p => [p.tag, p.severity]));

          let count = 0;
          for (const line of lines) {
            if (count >= limit) break;

            // Fix 1: With -Z flag, grep outputs: filePath\0lineNum:content
            // Split on first NUL byte to get filePath, then split remainder on first colon for lineNum:content
            const nulIdx = line.indexOf('\0');
            if (nulIdx < 0) {
              // Fallback for grep implementations that don't support -Z:
              // use legacy colon-split parsing
              const colonIdx = line.indexOf(':');
              if (colonIdx < 0) continue;
              const afterFile = line.indexOf(':', colonIdx + 1);
              if (afterFile < 0) continue;
              var filePath = line.slice(0, colonIdx);
              var lineNum = line.slice(colonIdx + 1, afterFile);
              var content = line.slice(afterFile + 1).trim();
            } else {
              var filePath = line.slice(0, nulIdx);
              const remainder = line.slice(nulIdx + 1);
              const colonIdx = remainder.indexOf(':');
              if (colonIdx < 0) continue;
              var lineNum = remainder.slice(0, colonIdx);
              var content = remainder.slice(colonIdx + 1).trim();
            }

            // Determine which tag matched
            const tagMatch = content.match(/\b(TODO|FIXME|HACK|XXX)\b/);
            const tag = tagMatch ? tagMatch[1] : 'TODO';
            const severity = todoSeverityMap[tag] || 'info';

            // Make path relative to project root for readability
            const relPath = path.relative(projectRoot, filePath);

            // Fix 3: Enrich TODO issues with fingerprint fields for debt writer
            // fingerprintIssue expects: { exception_type, function_name, message }
            issues.push({
              id: `internal-todo-${relPath}:${lineNum}`,
              title: `${tag} in ${relPath}:${lineNum}`,
              severity,
              url: '',
              age: '',
              created_at: new Date().toISOString(),
              meta: content.slice(0, 120),
              source_type: 'internal',
              issue_type: 'issue',
              exception_type: tag,
              function_name: relPath,
              _route: `/nf:quick "Resolve ${tag} at ${relPath}:${lineNum}"`
            });
            count++;
          }
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning scanning TODOs: ${err.message}`);
    }

    // Category 4: Active milestone phases without VERIFICATION.md
    try {
      const stateFilePath = path.resolve(projectRoot, '.planning/STATE.md');
      if (fs.existsSync(stateFilePath)) {
        const stateContent = fs.readFileSync(stateFilePath, 'utf8');

        // Extract Phase: value from STATE.md
        const phaseMatch = stateContent.match(/^Phase:\s+(.+?)$/m);
        if (phaseMatch) {
          let phase = phaseMatch[1].trim();

          // Skip if phase is empty or placeholder
          if (phase && phase !== '-' && phase !== '---') {
            // Sanitize phase string to prevent path traversal
            phase = phase.replace(/[^a-z0-9-]/g, '');

            if (phase) {
              const phaseDir = path.join(projectRoot, '.planning/phases', phase);

              // Check if phase directory exists
              if (fs.existsSync(phaseDir) && fs.statSync(phaseDir).isDirectory()) {
                // Check if any VERIFICATION.md file exists
                const entries = fs.readdirSync(phaseDir);
                const hasVerification = entries.some(f => f.endsWith('-VERIFICATION.md'));

                if (!hasVerification) {
                  issues.push({
                    id: `internal-milestone-${phase}`,
                    title: `Active phase ${phase} has no verification`,
                    severity: 'warning',
                    url: '',
                    age: '',
                    created_at: new Date().toISOString(),
                    meta: 'Phase active in STATE.md but no VERIFICATION.md found',
                    source_type: 'internal',
                    issue_type: 'issue',
                    _route: '/nf:solve'
                  });
                }
              }
            }
          }
        }
      }
    } catch (err) {
      // Log warning but continue with other scans (fail-open)
      console.warn(`[observe-internal] Warning scanning milestone phases: ${err.message}`);
    }

    // ── Helper: resolve script path (installed location first, then repo-local) ──
    function resolveScript(scriptName) {
      // Live-probe suppression: returning null makes every resolveScript-based
      // category (6–14, 17) no-op cleanly, without touching the file-scan ones.
      if (skipLiveProbes) return null;
      const installed = path.join(os.homedir(), '.claude', 'nf-bin', scriptName);
      if (fs.existsSync(installed)) return installed;
      const local = path.join(projectRoot, 'bin', scriptName);
      if (fs.existsSync(local)) return local;
      return null;
    }

    // Category 5: Proposed metrics from formal models (unimplemented instrumentation)
    try {
      const pmPath = path.resolve(projectRoot, '.planning/formal/evidence/proposed-metrics.json');
      if (fs.existsSync(pmPath)) {
        const pm = JSON.parse(fs.readFileSync(pmPath, 'utf8'));
        const metrics = pm.metrics || [];
        const outstanding = metrics.filter(m => m.status === 'proposed');
        const limit = opts.limitOverride || 20;

        // Surface tier-1 outstanding metrics first, then tier-2
        const sorted = outstanding.sort((a, b) => (a.tier || 99) - (b.tier || 99));

        let count = 0;
        for (const m of sorted) {
          if (count >= limit) break;
          issues.push({
            id: `internal-metric-${m.metric_name}`,
            title: `Unimplemented metric: ${m.metric_name} (tier ${m.tier})`,
            severity: m.tier === 1 ? 'warning' : 'info',
            url: '',
            age: '',
            created_at: pm.generated || new Date().toISOString(),
            meta: `${m.assumption_type} "${m.assumption_name}" from ${m.source_model} — ${m.metric_type}`,
            source_type: 'internal',
            issue_type: 'drift',
            _route: `/nf:quick "Add ${m.metric_name} instrumentation from ${m.source_model}"`
          });
          count++;
        }

        // Add a summary drift if there are outstanding metrics
        if (pm.outstanding > 0) {
          issues.push({
            id: 'internal-metrics-summary',
            title: `${pm.outstanding} proposed metrics outstanding (${pm.implemented} implemented, ${pm.partial} partial)`,
            severity: pm.outstanding > 10 ? 'warning' : 'info',
            url: '',
            age: '',
            created_at: pm.generated || new Date().toISOString(),
            meta: `Formal models propose ${pm.total_proposed} metrics total`,
            source_type: 'internal',
            issue_type: 'drift',
            _route: '/nf:solve'
          });
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning scanning proposed metrics: ${err.message}`);
    }

    // Category 6: Quorum slot reachability (probe-quorum-slots.cjs)
    try {
      const probeScript = resolveScript('probe-quorum-slots.cjs');
      if (probeScript) {
        // Discover active slots via the single resolver (#197/#218)
        const providers = loadProviders({ baseDir: path.dirname(probeScript) }) || [];
        const slotNames = providers.map(p => p.name).join(',');
        if (slotNames) {
          const result = spawnSync(process.execPath, [probeScript, '--slots', slotNames, '--timeout', '8000'], {
            encoding: 'utf8',
            timeout: 30000,
            cwd: projectRoot
          });
          if (result.status === 0 && result.stdout) {
            const probes = JSON.parse(result.stdout);
            for (const probe of probes) {
              if (!probe.healthy) {
                issues.push({
                  id: `internal-quorum-unreachable-${probe.slot}`,
                  title: `Quorum slot unreachable: ${probe.slot}`,
                  severity: 'warning',
                  url: '',
                  age: '',
                  created_at: new Date().toISOString(),
                  meta: probe.error || `Probe failed (${probe.latencyMs || '?'}ms)`,
                  source_type: 'internal',
                  issue_type: 'drift',
                  _route: `/nf:mcp-setup`
                });
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning probing quorum slots: ${err.message}`);
    }

    // Category 7: XState maxDeliberation calibration (verify-quorum-health.cjs)
    try {
      const verifyScript = resolveScript('verify-quorum-health.cjs');
      if (verifyScript) {
        const result = spawnSync(process.execPath, [verifyScript], {
          encoding: 'utf8',
          timeout: 15000,
          cwd: projectRoot
        });
        // Exit code 1 means calibration is below target confidence
        if (result.status === 1 && result.stdout) {
          issues.push({
            id: 'internal-quorum-calibration-drift',
            title: 'XState maxDeliberation calibration below target confidence',
            severity: 'warning',
            url: '',
            age: '',
            created_at: new Date().toISOString(),
            meta: result.stdout.trim().split('\n').pop() || 'Calibration drift detected',
            source_type: 'internal',
            issue_type: 'drift',
            _route: '/nf:solve'
          });
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning verifying quorum health: ${err.message}`);
    }

    // Category 8: MCP server health (check-mcp-health.cjs)
    try {
      const healthScript = resolveScript('check-mcp-health.cjs');
      if (healthScript) {
        const result = spawnSync(process.execPath, [healthScript, '--json'], {
          encoding: 'utf8',
          timeout: 30000,
          cwd: projectRoot
        });
        if (result.stdout) {
          let healthData;
          try { healthData = JSON.parse(result.stdout); } catch (_) { /* non-JSON output */ }
          if (healthData && Array.isArray(healthData.servers)) {
            for (const srv of healthData.servers) {
              if (!srv.healthy) {
                issues.push({
                  id: `internal-mcp-unhealthy-${srv.name || srv.server || 'unknown'}`,
                  title: `MCP server unhealthy: ${srv.name || srv.server || 'unknown'}`,
                  severity: 'warning',
                  url: '',
                  age: '',
                  created_at: new Date().toISOString(),
                  meta: srv.error || `latency=${srv.latencyMs || '?'}ms`,
                  source_type: 'internal',
                  issue_type: 'issue',
                  _route: '/nf:mcp-setup'
                });
              }
            }
          } else if (healthData && Array.isArray(healthData)) {
            // Alternate format: flat array of server results
            for (const srv of healthData) {
              if (!srv.healthy) {
                issues.push({
                  id: `internal-mcp-unhealthy-${srv.name || srv.server || 'unknown'}`,
                  title: `MCP server unhealthy: ${srv.name || srv.server || 'unknown'}`,
                  severity: 'warning',
                  url: '',
                  age: '',
                  created_at: new Date().toISOString(),
                  meta: srv.error || `latency=${srv.latencyMs || '?'}ms`,
                  source_type: 'internal',
                  issue_type: 'issue',
                  _route: '/nf:mcp-setup'
                });
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning checking MCP health: ${err.message}`);
    }

    // Category 9: MCP debug log anomalies (review-mcp-logs.cjs)
    try {
      const logScript = resolveScript('review-mcp-logs.cjs');
      if (logScript) {
        const result = spawnSync(process.execPath, [logScript, '--json', '--days', '3'], {
          encoding: 'utf8',
          timeout: 30000,
          cwd: projectRoot
        });
        if (result.status === 0 && result.stdout) {
          let logData;
          try { logData = JSON.parse(result.stdout); } catch (_) { /* non-JSON */ }
          if (logData) {
            // Surface hung tools
            const hangs = logData.hangs || logData.hung_tools || [];
            for (const h of hangs.slice(0, 5)) {
              issues.push({
                id: `internal-mcp-hang-${h.server || 'unknown'}-${h.tool || 'unknown'}`,
                title: `MCP tool hang: ${h.server || '?'}/${h.tool || '?'} (${h.count || 1}x)`,
                severity: 'warning',
                url: '',
                age: '',
                created_at: new Date().toISOString(),
                meta: `${h.elapsed_seconds || h.maxElapsed || '?'}s max elapsed`,
                source_type: 'internal',
                issue_type: 'issue',
                _route: '/nf:mcp-setup'
              });
            }
            // Surface failures
            const failures = logData.failures || logData.failed_tools || [];
            for (const f of failures.slice(0, 5)) {
              issues.push({
                id: `internal-mcp-fail-${f.server || 'unknown'}-${f.tool || 'unknown'}`,
                title: `MCP tool failure: ${f.server || '?'}/${f.tool || '?'} (${f.count || 1}x)`,
                severity: 'info',
                url: '',
                age: '',
                created_at: new Date().toISOString(),
                meta: f.error || f.reason || 'See debug logs',
                source_type: 'internal',
                issue_type: 'issue',
                _route: '/nf:mcp-setup'
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning reviewing MCP logs: ${err.message}`);
    }

    // Category 10: Telemetry anomalies (telemetry-collector.cjs)
    try {
      const telScript = resolveScript('telemetry-collector.cjs');
      if (telScript) {
        const result = spawnSync(process.execPath, [telScript], {
          encoding: 'utf8',
          timeout: 30000,
          cwd: projectRoot
        });
        if (result.status === 0) {
          // Read the generated report
          const reportPath = path.join(projectRoot, '.planning', 'telemetry', 'report.json');
          if (fs.existsSync(reportPath)) {
            const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            // Surface circuit breaker active state
            if (report.circuitBreaker && report.circuitBreaker.active) {
              issues.push({
                id: 'internal-telemetry-breaker-active',
                title: 'Circuit breaker is currently ACTIVE',
                severity: 'warning',
                url: '',
                age: '',
                created_at: new Date().toISOString(),
                meta: `Trigger count: ${report.circuitBreaker.triggerCount || '?'}`,
                source_type: 'internal',
                issue_type: 'drift',
                _route: '/nf:solve'
              });
            }
            // Surface always-failing servers
            const servers = report.servers || report.mcpServers || {};
            for (const [name, srv] of Object.entries(servers)) {
              if (srv.failureRate >= 1.0 || srv.alwaysFailing) {
                issues.push({
                  id: `internal-telemetry-always-failing-${name}`,
                  title: `MCP server always failing: ${name}`,
                  severity: 'warning',
                  url: '',
                  age: '',
                  created_at: new Date().toISOString(),
                  meta: `${srv.totalCalls || '?'} calls, 100% failure`,
                  source_type: 'internal',
                  issue_type: 'issue',
                  _route: '/nf:mcp-setup'
                });
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning collecting telemetry: ${err.message}`);
    }

    // Category 11: Observed FSM divergences (observed-fsm.cjs)
    try {
      const fsmScript = resolveScript('observed-fsm.cjs');
      if (fsmScript) {
        const result = spawnSync(process.execPath, [fsmScript, '--json'], {
          encoding: 'utf8',
          timeout: 30000,
          cwd: projectRoot,
          env: { ...process.env, PROJECT_ROOT: projectRoot }
        });
        if (result.status === 0 && result.stdout) {
          let fsmData;
          try { fsmData = JSON.parse(result.stdout); } catch (_) { /* non-JSON */ }
          if (fsmData) {
            const observedOnly = fsmData.observedOnlyTransitions || fsmData.observed_only || [];
            const modelOnly = fsmData.modelOnlyTransitions || fsmData.model_only || [];
            if (observedOnly.length > 0) {
              issues.push({
                id: 'internal-fsm-observed-only',
                title: `${observedOnly.length} transition(s) observed but not in designed FSM`,
                severity: 'warning',
                url: '',
                age: '',
                created_at: new Date().toISOString(),
                meta: observedOnly.slice(0, 3).map(t => `${t.from || t.source}→${t.to || t.target}`).join(', '),
                source_type: 'internal',
                issue_type: 'drift',
                _route: '/nf:solve'
              });
            }
            if (modelOnly.length > 0) {
              issues.push({
                id: 'internal-fsm-model-only',
                title: `${modelOnly.length} designed transition(s) never observed in traces`,
                severity: 'info',
                url: '',
                age: '',
                created_at: new Date().toISOString(),
                meta: modelOnly.slice(0, 3).map(t => `${t.from || t.source}→${t.to || t.target}`).join(', '),
                source_type: 'internal',
                issue_type: 'drift',
                _route: '/nf:solve'
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning comparing observed FSM: ${err.message}`);
    }

    // Category 12: Sensitivity sweep prediction mismatches (sensitivity-sweep-feedback.cjs)
    try {
      const sweepScript = resolveScript('sensitivity-sweep-feedback.cjs');
      if (sweepScript) {
        const result = spawnSync(process.execPath, [sweepScript], {
          encoding: 'utf8',
          timeout: 30000,
          cwd: projectRoot
        });
        // Exit 0 = no new violations; stderr may contain deviation info
        // Parse stderr for deviation warnings
        const stderr = (result.stderr || '').trim();
        if (stderr) {
          const deviationMatch = stderr.match(/deviation.*?(\d+\.\d+)/i);
          if (deviationMatch) {
            issues.push({
              id: 'internal-sensitivity-deviation',
              title: 'Sensitivity sweep: empirical TP rate deviates from prediction',
              severity: 'warning',
              url: '',
              age: '',
              created_at: new Date().toISOString(),
              meta: stderr.split('\n').pop() || `Deviation: ${deviationMatch[1]}`,
              source_type: 'internal',
              issue_type: 'drift',
              _route: '/nf:solve'
            });
          }
        }
        // Also check if exit code indicates a threshold violation
        if (result.status !== 0 && result.status !== null) {
          issues.push({
            id: 'internal-sensitivity-threshold-violation',
            title: 'Sensitivity sweep threshold violation detected',
            severity: 'warning',
            url: '',
            age: '',
            created_at: new Date().toISOString(),
            meta: stderr.split('\n').pop() || 'TP rate below predicted threshold',
            source_type: 'internal',
            issue_type: 'drift',
            _route: '/nf:solve'
          });
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning running sensitivity sweep feedback: ${err.message}`);
    }

    // Category 13: Security findings (security-sweep.cjs)
    try {
      const secScript = resolveScript('security-sweep.cjs');
      if (secScript) {
        const result = spawnSync(process.execPath, [secScript, '--json', '--cwd', projectRoot], {
          encoding: 'utf8',
          timeout: 30000,
          cwd: projectRoot
        });
        if (result.status === 0 && result.stdout) {
          let secData;
          try { secData = JSON.parse(result.stdout); } catch (_) { /* non-JSON */ }
          if (secData) {
            const findings = secData.findings || secData.results || [];
            const limit = opts.limitOverride || 10;
            let count = 0;
            for (const f of findings) {
              if (count >= limit) break;
              issues.push({
                id: `internal-security-${f.name || f.pattern || 'finding'}-${f.file || count}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
                title: `Security: ${f.name || f.pattern || 'finding'} in ${f.file || 'unknown'}:${f.line || '?'}`,
                severity: f.severity === 'high' ? 'warning' : 'info',
                url: '',
                age: '',
                created_at: new Date().toISOString(),
                meta: f.match || f.content || '',
                source_type: 'internal',
                issue_type: 'issue',
                _route: `/nf:quick "Fix security finding: ${f.name || 'secret'} in ${f.file || 'unknown'}:${f.line || '?'}"`
              });
              count++;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning running security sweep: ${err.message}`);
    }

    // Category 14: Issue classification from telemetry (issue-classifier.cjs)
    try {
      const classifierScript = resolveScript('issue-classifier.cjs');
      if (classifierScript) {
        const result = spawnSync(process.execPath, [classifierScript], {
          encoding: 'utf8',
          timeout: 15000,
          cwd: projectRoot
        });
        if (result.status === 0) {
          const fixesPath = path.join(projectRoot, '.planning', 'telemetry', 'pending-fixes.json');
          if (fs.existsSync(fixesPath)) {
            const fixes = JSON.parse(fs.readFileSync(fixesPath, 'utf8'));
            const classified = fixes.issues || [];
            for (const issue of classified) {
              issues.push({
                id: `internal-classified-${issue.slug || issue.id || 'unknown'}`,
                title: `Classified issue: ${issue.title || issue.description || 'unknown'} (priority ${issue.priority || '?'})`,
                severity: (issue.priority || 0) >= 80 ? 'warning' : 'info',
                url: '',
                age: '',
                created_at: fixes.generatedAt || new Date().toISOString(),
                meta: issue.reason || issue.meta || '',
                source_type: 'internal',
                issue_type: 'issue',
                _route: issue.route || '/nf:solve'
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning classifying issues: ${err.message}`);
    }

    // Category 15: nf:health diagnostics (self-development only)
    try {
      const nfToolsPath = path.join(projectRoot, 'core', 'bin', 'nf-tools.cjs');
      if (fs.existsSync(nfToolsPath)) {
        const result = spawnSync(process.execPath, [nfToolsPath, 'validate', 'health'], {
          encoding: 'utf8',
          timeout: 15000,
          cwd: projectRoot
        });
        if (result.status === 0 && result.stdout) {
          let healthData;
          try { healthData = JSON.parse(result.stdout); } catch (_) { /* non-JSON */ }
          if (healthData) {
            // Map errors -> severity 'error'
            for (const e of (healthData.errors || [])) {
              issues.push({
                id: `internal-health-${e.code}`,
                title: `Health: ${e.message}`,
                severity: 'error',
                url: '',
                age: '',
                created_at: new Date().toISOString(),
                meta: e.fix || '',
                source_type: 'internal',
                issue_type: 'issue',
                _route: '/nf:solve'
              });
            }
            // Map warnings -> severity 'warning', route to /nf:health --repair if repairable
            for (const w of (healthData.warnings || [])) {
              issues.push({
                id: `internal-health-${w.code}`,
                title: `Health: ${w.message}`,
                severity: 'warning',
                url: '',
                age: '',
                created_at: new Date().toISOString(),
                meta: w.fix || '',
                source_type: 'internal',
                issue_type: 'issue',
                _route: w.repairable ? '/nf:health --repair' : '/nf:solve'
              });
            }
            // Map info -> severity 'info'
            for (const i of (healthData.info || [])) {
              issues.push({
                id: `internal-health-${i.code}`,
                title: `Health: ${i.message}`,
                severity: 'info',
                url: '',
                age: '',
                created_at: new Date().toISOString(),
                meta: i.fix || '',
                source_type: 'internal',
                issue_type: 'issue',
                _route: '/nf:solve'
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning running health diagnostics: ${err.message}`);
    }

    // Category 16: Accumulated error patterns from errors.jsonl (nForma repo only)
    // Uses smart clustering to reduce ~22 individual errors to ~3-5 actionable clusters
    try {
      const memoryStorePath = path.join(projectRoot, 'bin', 'memory-store.cjs');
      if (fs.existsSync(memoryStorePath)) {
        const { readLastN } = require(memoryStorePath);
        const { clusterErrors } = require(path.join(projectRoot, 'bin', 'error-clusterer.cjs'));
        const limit = opts.limitOverride || 20;
        const recentErrors = readLastN(projectRoot, 'errors', limit);

        // Filter entries that have actionable content
        const actionableErrors = recentErrors.filter(e => e.root_cause || e.fix);

        // Cluster instead of emitting individually
        const clusters = clusterErrors(actionableErrors);

        for (const cluster of clusters) {
          const severity = cluster.stale ? 'info' : 'warning';
          const rep = cluster.representative;

          issues.push({
            id: `internal-error-cluster-${cluster.clusterId}`,
            title: `Error cluster (${cluster.count}): ${cluster.label}`,
            severity,
            url: '',
            age: rep.ts ? formatAgeFromMtime(new Date(rep.ts)) : '',
            created_at: rep.ts || new Date().toISOString(),
            meta: rep.fix
              ? `Fix: ${(rep.fix || '').slice(0, 100)}`
              : `Cause: ${(rep.root_cause || '').slice(0, 100)}`,
            source_type: 'internal',
            issue_type: 'issue',
            _route: '/nf:solve',
            _cluster_count: cluster.count
          });
        }
      }
    } catch (err) {
      console.warn(`[observe-internal] Warning scanning error patterns: ${err.message}`);
    }

    // Category 17: Feature usefulness report (feature-report.cjs)
    try {
      const reportScript = resolveScript('feature-report.cjs');
      if (reportScript) {
        const result = spawnSync(process.execPath, [reportScript, '--json', '--project-root', projectRoot], {
          encoding: 'utf8',
          timeout: 15000,
        });
        if (result.status === 0 && result.stdout) {
          const report = JSON.parse(result.stdout);
          // Surface features with high failure rates
          if (report.features) {
            for (const [featureId, metrics] of Object.entries(report.features)) {
              if (metrics.usage_count > 0 && metrics.success_rate < 0.5) {
                issues.push({
                  id: `internal-feature-high-failure-${featureId}`,
                  title: `Feature '${featureId}' has ${Math.round((1 - metrics.success_rate) * 100)}% failure rate (${metrics.usage_count} uses)`,
                  severity: 'medium',
                  source: 'internal:feature-report',
                  raw: { feature_id: featureId, ...metrics },
                });
              }
            }
          }
          // Surface bugs detected by features
          if (Array.isArray(report.bug_links)) {
            for (const bug of report.bug_links) {
              issues.push({
                id: `internal-feature-bug-${bug.issue_url.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 60)}`,
                title: `Bug ${bug.issue_url} ${bug.detection_type} by ${bug.features.join(', ')}`,
                severity: 'info',
                source: 'internal:feature-report',
                raw: bug,
              });
            }
          }
          // Surface top narrative insights as info-level issues
          if (Array.isArray(report.insights) && report.insights.length > 0) {
            issues.push({
              id: 'internal-feature-insights',
              title: `Feature report: ${report.insights.length} insight(s) — ${report.insights[0].slice(0, 80)}`,
              severity: 'info',
              source: 'internal:feature-report',
              raw: { insights: report.insights },
            });
          }
        }
      }
    } catch (e17) {
      console.warn(`[observe-internal] Warning collecting feature report: ${e17.message}`);
    }

    return {
      source_label: label,
      source_type: 'internal',
      status: 'ok',
      issues
    };
  } catch (err) {
    return {
      source_label: label,
      source_type: 'internal',
      status: 'error',
      error: `Internal work detection failed: ${err.message}`,
      issues: []
    };
  }
}

// Re-export formatAgeFromMtime (imported from observe-utils above) so callers and
// tests can reach it through the handler surface, as the internal test expects.
module.exports = { handleInternal, formatAgeFromMtime };

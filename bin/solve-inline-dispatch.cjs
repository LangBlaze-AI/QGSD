#!/usr/bin/env node
'use strict';
// bin/solve-inline-dispatch.cjs
// Pre-runs trivial remediation layers (hazard_model, d_to_c, l3_to_tc preflight)
// before the main remediation Agent dispatch, saving ~15-30s of Agent overhead.
//
// Input: residual_vector JSON via --input=<path> or stdin
// Output: JSON to stdout with inline_results, skip_layers, preflight_data
//
// Requirements: QUICK-339

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const _nfBin = (n) => {
  const p = path.join(os.homedir(), '.claude/nf-bin', n);
  return fs.existsSync(p) ? p : path.join(process.cwd(), 'bin', n);
};

let ROOT = process.cwd();
const args = process.argv.slice(2);
let inputPath = null;

for (const arg of args) {
  if (arg.startsWith('--project-root=')) ROOT = arg.slice('--project-root='.length);
  if (arg.startsWith('--input=')) inputPath = arg.slice('--input='.length);
}

function loadResidualVector() {
  if (inputPath) {
    return JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  }
  // Read from stdin (non-blocking check)
  const stdinData = fs.readFileSync('/dev/stdin', 'utf8').trim();
  if (!stdinData) return {};
  return JSON.parse(stdinData);
}

function runHazardModel() {
  const scriptPath = _nfBin('hazard-model.cjs');
  if (!fs.existsSync(scriptPath)) {
    return { status: 'skipped', summary: 'hazard-model.cjs not found', total_hazards: 0, high_rpn_count: 0 };
  }
  try {
    const out = execFileSync(process.execPath, [scriptPath, '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const data = JSON.parse(out);
    const totalHazards = data.total_hazards || data.hazards?.length || 0;
    const highRpn = data.high_rpn_count || (data.hazards || []).filter(h => (h.rpn || 0) > 100).length;
    return { status: 'ok', summary: `${totalHazards} hazards scored, ${highRpn} high-RPN (>100)`, total_hazards: totalHazards, high_rpn_count: highRpn };
  } catch (e) {
    return { status: 'error', summary: e.message.slice(0, 200), total_hazards: 0, high_rpn_count: 0 };
  }
}

function runDtoC(residualVector) {
  const dtoc = residualVector.d_to_c;
  if (!dtoc || dtoc.residual <= 0) {
    return { status: 'skipped', summary: 'D->C residual is 0', broken_claims_count: 0, table: '' };
  }
  const claims = Array.isArray(dtoc.detail?.broken_claims) ? dtoc.detail.broken_claims : [];
  if (claims.length === 0) {
    return { status: 'skipped', summary: 'No broken claims in detail', broken_claims_count: 0, table: '' };
  }
  // Format display table
  const header = '  Doc File              Line  Type         Value                    Reason';
  const sep =    '  ──────────────────────────────────────────────────────────────────────────';
  const rows = claims.map(c => {
    const e = (c && typeof c === 'object') ? c : {};
    const doc = String(e.doc_file || e.file || '').padEnd(22);
    const line = String(e.line || '').padEnd(6);
    const type = String(e.type || '').padEnd(13);
    const value = String(e.value || '').padEnd(25);
    const reason = String(e.reason || '');
    return `  ${doc}${line}${type}${value}${reason}`;
  });
  const table = `D->C: ${claims.length} stale structural claim(s) in docs:\n${header}\n${sep}\n${rows.join('\n')}`;
  return { status: 'ok', summary: `${claims.length} stale structural claim(s)`, broken_claims_count: claims.length, table };
}

function runL3toTCPreflight() {
  // Run test-recipe-gen.cjs then gate-c-validation.cjs
  const recipeScript = _nfBin('test-recipe-gen.cjs');
  const gateScript = _nfBin('gate-c-validation.cjs');

  // Step 1: regenerate test recipes
  if (fs.existsSync(recipeScript)) {
    try {
      execFileSync(process.execPath, [recipeScript], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return { status: 'error', summary: 'test-recipe-gen.cjs failed: ' + e.message.slice(0, 100), unvalidated_after_regen: -1 };
    }
  }

  // Step 2: run gate-c-validation
  if (!fs.existsSync(gateScript)) {
    return { status: 'skipped', summary: 'gate-c-validation.cjs not found', unvalidated_after_regen: -1 };
  }
  try {
    const out = execFileSync(process.execPath, [gateScript, '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const data = JSON.parse(out);
    const unvalidated = data.unvalidated_count || data.unvalidated_entries?.length || 0;
    return { status: 'ok', summary: `${unvalidated} unvalidated failure modes after regen`, unvalidated_after_regen: unvalidated };
  } catch (e) {
    return { status: 'error', summary: 'gate-c-validation.cjs failed: ' + e.message.slice(0, 100), unvalidated_after_regen: -1 };
  }
}

function main() {
  let residualVector;
  try {
    residualVector = loadResidualVector();
  } catch (e) {
    // Fail-open: empty residual
    residualVector = {};
  }

  const result = {
    inline_results: {},
    skip_layers: [],
    preflight_data: {},
  };

  // 1. Hazard model refresh
  const hazardRes = residualVector.hazard_model;
  if (hazardRes && hazardRes.residual !== undefined) {
    result.inline_results.hazard_model = runHazardModel();
    if (result.inline_results.hazard_model.status !== 'error') {
      result.skip_layers.push('hazard_model');
    }
  } else {
    result.inline_results.hazard_model = { status: 'skipped', summary: 'no hazard_model in residual', total_hazards: 0, high_rpn_count: 0 };
    result.skip_layers.push('hazard_model');
  }

  // 2. D->C display
  result.inline_results.d_to_c = runDtoC(residualVector);
  result.skip_layers.push('d_to_c'); // Always skip — display-only, no Agent needed

  // 3. L3->TC preflight (gate script pre-computation)
  const l3Res = residualVector.l3_to_tc;
  if (l3Res && l3Res.residual > 0) {
    result.inline_results.l3_to_tc_preflight = runL3toTCPreflight();
    if (result.inline_results.l3_to_tc_preflight.status === 'ok') {
      result.preflight_data.l3_to_tc_unvalidated = result.inline_results.l3_to_tc_preflight.unvalidated_after_regen;
    }
  } else {
    result.inline_results.l3_to_tc_preflight = { status: 'skipped', summary: 'l3_to_tc residual is 0', unvalidated_after_regen: 0 };
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// Export for testing; only run main() when executed directly
module.exports = { runHazardModel, runDtoC, runL3toTCPreflight, _nfBin };

if (require.main === module) {
  main();
}

#!/usr/bin/env node
'use strict';
// bin/build-layer-manifest.cjs
// Classifies all formal models in model-registry.json into L1/L2/L3 layers
// and generates layer-manifest.json. Extends model-registry.json with
// source_layer, gate_maturity, and layer_maturity fields per model.
//
// Requirements: INTG-01, INTG-05, INTG-06

const fs   = require('fs');
const path = require('path');

const ROOT = process.env.PROJECT_ROOT || path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, '.planning', 'formal', 'model-registry.json');
const MANIFEST_PATH = path.join(ROOT, '.planning', 'formal', 'layer-manifest.json');
const SPEC_DIR = path.join(ROOT, '.planning', 'formal', 'spec');

const JSON_FLAG = process.argv.includes('--json');

// ── Classification rules ────────────────────────────────────────────────────

/**
 * Classify a model path into L1, L2, or L3.
 *
 * L3 (Reasoning): formalism "tla", "alloy", "prism"; files in tla/, alloy/, prism/ directories
 * L2 (Semantics): spec/invariants.md files; XState machine definition; assumption-gaps.md
 * L1 (Evidence): formalism "trace" or "redaction"; conformance-events.jsonl; debt.json; observe-handler outputs
 */
function classifyModel(modelPath) {
  const normalized = modelPath.replace(/\\/g, '/');

  // L3: files in tla/, alloy/, prism/ directories or with those extensions
  if (/\/(tla|alloy|prism)\//.test(normalized)) return 'L3';
  if (/\.(tla|als|pm)$/.test(normalized)) return 'L3';

  // L2: spec/*/invariants.md, xstate machine definitions, assumption-gaps
  if (/\/spec\/[^/]+\/invariants\.md$/.test(normalized)) return 'L2';
  if (/xstate|machine\.js|machine\.ts/.test(normalized)) return 'L2';
  if (/assumption-gaps/.test(normalized)) return 'L2';

  // L1: trace, redaction, conformance-events, debt, observe-handler
  if (/conformance-events/.test(normalized)) return 'L1';
  if (/debt\.json/.test(normalized)) return 'L1';
  if (/observe-handler/.test(normalized)) return 'L1';
  if (/trace|redaction/.test(normalized)) return 'L1';

  // Fallback: classify by check-result formalism if available
  return 'L1'; // default to L1 (evidence)
}

/**
 * Determine layer_maturity for a model.
 * Level 0: ungrounded (default)
 * Level 1: has L2 semantic declarations (spec invariants.md exists for related module)
 */
function computeLayerMaturity(modelPath, specModules) {
  const normalized = modelPath.replace(/\\/g, '/');
  const normalizedLower = normalized.toLowerCase();
  // Strip hyphens/underscores for fuzzy matching (e.g., "account-manager" -> "accountmanager"
  // matches "NFAccountManager.tla" -> "nfaccountmanager.tla")
  const strippedPath = normalizedLower.replace(/[-_]/g, '');

  for (const mod of specModules) {
    const modLower = mod.toLowerCase();
    // Path 1: exact substring match (original behavior)
    if (normalizedLower.includes(modLower)) {
      return 1;
    }
    // Path 2: stripped match — remove hyphens/underscores from both sides
    const strippedMod = modLower.replace(/[-_]/g, '');
    if (strippedPath.includes(strippedMod)) {
      return 1;
    }
    // Path 3: all hyphen-parts present in path (order-independent)
    // e.g., "tui-nav" -> ["tui","nav"] both in "tuinavigation"
    const parts = modLower.split('-').filter(p => p.length > 1);
    if (parts.length > 1 && parts.every(p => strippedPath.includes(p))) {
      return 1;
    }
  }
  return 0;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  // Read registry
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const models = (registry && typeof registry.models === 'object' && registry.models !== null && !Array.isArray(registry.models))
    ? registry.models
    : {};
  registry.models = models;
  const modelPaths = Object.keys(models);

  // Discover spec modules with invariants.md
  const specModules = [];
  if (fs.existsSync(SPEC_DIR)) {
    for (const entry of fs.readdirSync(SPEC_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const invPath = path.join(SPEC_DIR, entry.name, 'invariants.md');
        if (fs.existsSync(invPath)) {
          specModules.push(entry.name);
        }
      }
    }
  }

  // Classify each model and extend registry
  const layers = { L1: [], L2: [], L3: [] };
  const maturityDist = { 0: 0, 1: 0 };

  for (const modelPath of modelPaths) {
    const entry = models[modelPath];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue; // skip corrupt/non-object registry entries instead of crashing
    }
    const layer = classifyModel(modelPath);
    const layerMaturity = computeLayerMaturity(modelPath, specModules);
    const gateMat = 'ADVISORY';

    // Extend registry entry
    models[modelPath].source_layer = layer;
    models[modelPath].gate_maturity = gateMat;
    models[modelPath].layer_maturity = layerMaturity;

    // Add to manifest layers
    layers[layer].push({
      path: modelPath,
      description: models[modelPath].description || '',
      grounding_status: layerMaturity > 0 ? 'has_semantic_declarations' : 'ungrounded'
    });

    maturityDist[layerMaturity] = (maturityDist[layerMaturity] || 0) + 1;
  }

  // Write updated model-registry.json
  registry.last_sync = new Date().toISOString();
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  // Generate layer-manifest.json
  const manifest = {
    schema_version: '2',
    generated: new Date().toISOString(),
    layers,
    gate_relationships: {
      A: { from: 'L1', to: 'L3', description: 'Evidence grounds reasoning models (L2 collapsed)' },
      B: { from: 'L3', to: 'purpose', description: 'Reasoning models have requirement backing' },
      C: { from: 'L3', to: 'TC', description: 'Reasoning models prove traceability completeness' }
    },
    collapsed_layers: {
      L2: {
        reason: 'Empty layer — zero entries permanently blocked Gate B (STRUCT-01)',
        collapsed_at: new Date().toISOString()
      }
    },
    summary: {
      total_models: modelPaths.length,
      L1_count: layers.L1.length,
      L2_count: layers.L2.length,
      L3_count: layers.L3.length,
      maturity_distribution: maturityDist,
      spec_modules_with_invariants: specModules.length
    }
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // Output
  if (JSON_FLAG) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(`Layer Manifest Generated`);
    console.log(`  Total models: ${modelPaths.length}`);
    console.log(`  L1 (Evidence):  ${layers.L1.length}`);
    console.log(`  L2 (Semantics): ${layers.L2.length}`);
    console.log(`  L3 (Reasoning): ${layers.L3.length}`);
    console.log(`  Maturity 0 (ungrounded): ${maturityDist[0] || 0}`);
    console.log(`  Maturity 1 (has semantics): ${maturityDist[1] || 0}`);
    console.log(`  Spec modules with invariants: ${specModules.length}`);
  }
}

main();

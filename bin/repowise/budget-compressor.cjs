#!/usr/bin/env node
'use strict';
// bin/repowise/budget-compressor.cjs — Budget-aware context compression for Repowise
//
// Adapts context output to fit within token budget constraints.
// High-risk hotspot files retain more detail than low-risk files.
// When budget is insufficient for minimum skeletons, produces filename-only listing.

const path = require('path');
const { escapeXml } = require('./escape-xml.cjs');

// ---------------------------------------------------------------------------
// Token estimation (rough: 1 token ≈ 4 chars for code)
// ---------------------------------------------------------------------------

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Detail levels
// ---------------------------------------------------------------------------

const DETAIL_LEVELS = {
  full: 'full',
  skeleton: 'skeleton',
  signatures: 'signatures',
  names_only: 'names_only',
};

function formatEntryByDetail(entry, detail) {
  switch (detail) {
    case 'full':
      return entry.fullContent || '';
    case 'skeleton':
      return entry.skeletonXml || '';
    case 'signatures':
      if (entry.skeletonEntries && entry.skeletonEntries.length > 0) {
        return entry.skeletonEntries
          .filter(e => e && typeof e.type === 'string' && (e.type.includes('function') || e.type.includes('class') || e.type.includes('method')))
          .map(e => `${e.type} ${e.name} [${e.start}-${e.end}]`)
          .join('\n');
      }
      return path.basename(entry.filePath || '');
    case 'names_only':
    default:
      return entry.filePath || '';
  }
}

// ---------------------------------------------------------------------------
// Budget allocation
// ---------------------------------------------------------------------------

function allocateBudget(files, totalBudget, options) {
  const opts = options || {};
  const minBudgetPerFile = opts.minBudgetPerFile || 50;
  const riskThreshold = opts.riskThreshold || 0.4;

  if (!Array.isArray(files) || files.length === 0) return { allocations: [], totalUsed: 0, overflow: false };

  const totalMinBudget = files.length * minBudgetPerFile;
  if (!Number.isFinite(totalBudget) || totalBudget < totalMinBudget) {
    // Budget insufficient — produce filename-only listing
    return {
      allocations: files.map(f => ({
        filePath: f.filePath,
        detail: DETAIL_LEVELS.names_only,
        budget: 0,
        content: f.filePath,
      })),
      totalUsed: files.length * 20,
      overflow: true,
    };
  }

  // Categorize files by risk
  const highRisk = files.filter(f => (f.hotspotRisk || 0) > 0.7);
  const mediumRisk = files.filter(f => (f.hotspotRisk || 0) > riskThreshold && (f.hotspotRisk || 0) <= 0.7);
  const lowRisk = files.filter(f => (f.hotspotRisk || 0) <= riskThreshold);

  // Allocate budget proportionally: high risk gets 3x, medium 2x, low 1x
  const weights = [];
  for (const f of files) {
    if ((f.hotspotRisk || 0) > 0.7) weights.push(3);
    else if ((f.hotspotRisk || 0) > riskThreshold) weights.push(2);
    else weights.push(1);
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const allocations = [];
  let budgetRemaining = totalBudget;

  for (let i = 0; i < files.length; i++) {
    const fileShare = (weights[i] / totalWeight) * totalBudget;
    const budget = Math.max(minBudgetPerFile, Math.floor(fileShare));
    const actualBudget = Math.min(budget, budgetRemaining);

    let detail;
    if (actualBudget >= 500) detail = DETAIL_LEVELS.skeleton;
    else if (actualBudget >= 200) detail = DETAIL_LEVELS.signatures;
    else detail = DETAIL_LEVELS.names_only;

    allocations.push({
      filePath: files[i].filePath,
      detail,
      budget: actualBudget,
      hotspotRisk: files[i].hotspotRisk || 0,
    });

    budgetRemaining -= actualBudget;
  }

  return { allocations, totalUsed: totalBudget - budgetRemaining, overflow: false };
}

// ---------------------------------------------------------------------------
// Main API: compressContext
// ---------------------------------------------------------------------------

function compressContext(files, tokenBudget, options) {
  const result = allocateBudget(files, tokenBudget, options);

  const xmlParts = [];
  const jsonParts = [];

  if (result.overflow) {
    // Budget too small — produce filename-only listing
    const fileList = files.map(f => `<file path="${escapeXml(f.filePath)}"/>`).join('\n');
    const xml = `<repowise budget_mode="overflow" token_budget="${tokenBudget}">\n<skeleton available="false" reason="budget_exceeded"/>\n<hotspot available="false"/>\n<cochange available="false"/>\n<files>\n${fileList}\n</files>\n</repowise>`;
    const json = {
      repowise: {
        budget_mode: 'overflow',
        token_budget: tokenBudget,
        skeleton: { available: false, reason: 'budget_exceeded' },
        files: files.map(f => ({ path: f.filePath, detail: 'names_only' })),
      },
    };
    return { xml, json, allocations: result.allocations };
  }

  for (const alloc of result.allocations) {
    const file = files.find(f => f.filePath === alloc.filePath);
    const content = file ? formatEntryByDetail(file, alloc.detail) : alloc.filePath;

    if (alloc.detail === DETAIL_LEVELS.names_only) {
      xmlParts.push(`<file path="${escapeXml(alloc.filePath)}" detail="${alloc.detail}"/>`);
    } else {
      xmlParts.push(`<file path="${escapeXml(alloc.filePath)}" detail="${alloc.detail}" budget="${alloc.budget}" hotspot_risk="${alloc.hotspotRisk}">${escapeXml(content)}</file>`);
    }

    jsonParts.push({
      path: alloc.filePath,
      detail: alloc.detail,
      budget: alloc.budget,
      hotspot_risk: alloc.hotspotRisk,
    });
  }

  const xml = `<repowise budget_mode="compressed" token_budget="${tokenBudget}">\n<files>\n${xmlParts.join('\n')}\n</files>\n</repowise>`;
  const json = {
    repowise: {
      budget_mode: 'compressed',
      token_budget: tokenBudget,
      files: jsonParts,
    },
  };

  return { xml, json, allocations: result.allocations };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node bin/repowise/budget-compressor.cjs [options]

Options:
  --files=path1,path2     Comma-separated file paths
  --budget=N              Token budget (default: 4000)
  --project-root=/path    Override project root directory
  --json                  Output structured JSON
  --help                  Show this help message

Exit codes:
  0 — success
  1 — error`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const jsonOutput = args.includes('--json');
  const tokenBudget = (() => {
    const a = args.find(a => a.startsWith('--budget='));
    return a ? parseInt(a.split('=')[1], 10) : 4000;
  })();
  const filesArg = (() => {
    const a = args.find(a => a.startsWith('--files='));
    return a ? a.split('=').slice(1).join('=') : null;
  })();

  if (!filesArg) {
    printHelp();
    process.exit(1);
  }

  try {
    const filePaths = filesArg.split(',').map(p => p.trim()).filter(Boolean);
    const files = filePaths.map(fp => ({ filePath: fp, hotspotRisk: 0 }));
    const result = compressContext(files, tokenBudget);

    if (jsonOutput) {
      console.log(JSON.stringify(result.json, null, 2));
    } else {
      console.log(result.xml);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  compressContext,
  allocateBudget,
  estimateTokens,
  formatEntryByDetail,
  DETAIL_LEVELS,
};

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

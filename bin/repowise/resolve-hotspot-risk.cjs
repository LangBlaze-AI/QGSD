#!/usr/bin/env node
'use strict';
// bin/repowise/resolve-hotspot-risk.cjs — Resolve hotspot risk level for quorum fan-out escalation

const fs = require('fs');
const path = require('path');
const { computeHotspots } = require('./hotspot.cjs');

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getCachePath(projectRoot) {
  return path.join(projectRoot, '.planning', 'repowise', 'hotspot-cache.json');
}

function loadCachedHotspots(projectRoot) {
  const cachePath = getCachePath(projectRoot);
  try {
    if (!fs.existsSync(cachePath)) return null;
    const stat = fs.statSync(cachePath);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveCachedHotspots(projectRoot, data) {
  const cachePath = getCachePath(projectRoot);
  try {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (_) {
    // fail-open: cache write failure is non-fatal
  }
}

// ---------------------------------------------------------------------------
// Risk resolution
// ---------------------------------------------------------------------------

function resolveHotspotRisk(changedFiles, projectRoot, options) {
  let hotspots = loadCachedHotspots(projectRoot);
  if (!hotspots || !Array.isArray(hotspots.files)) {
    hotspots = computeHotspots(projectRoot, options);
    saveCachedHotspots(projectRoot, hotspots);
  }

  const hotspotMap = new Map();
  for (const f of hotspots.files) {
    hotspotMap.set(f.path, f);
  }

  const matchingFiles = [];
  let maxScore = 0;
  let riskLevel = 'routine';

  const safeChangedFiles = Array.isArray(changedFiles) ? changedFiles : [];
  for (const filePath of safeChangedFiles) {
    const entry = hotspotMap.get(filePath);
    if (!entry) continue;

    matchingFiles.push(entry);
    if (entry.hotspot_score > maxScore) {
      maxScore = entry.hotspot_score;
    }

    if (entry.hotspot_score > 0.7) {
      riskLevel = 'high';
    } else if (entry.hotspot_score > 0.4 && riskLevel !== 'high') {
      riskLevel = 'medium';
    }
  }

  return {
    risk_level: riskLevel,
    hotspot_files: matchingFiles,
    max_score: Math.round(maxScore * 1000) / 1000,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node bin/repowise/resolve-hotspot-risk.cjs [options]

Options:
  --files=path1,path2   Comma-separated changed file paths
  --project-root=/path  Override project root directory
  --json                Output structured JSON
  --help                Show this help message

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

  const projectRoot = (() => {
    const a = args.find(a => a.startsWith('--project-root='));
    if (a) return a.split('=').slice(1).join('=');
    if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
    return path.resolve(__dirname, '../..');
  })();

  const filesArg = (() => {
    const a = args.find(a => a.startsWith('--files='));
    return a ? a.split('=').slice(1).join('=') : null;
  })();
  const jsonOutput = args.includes('--json');

  if (!filesArg) {
    printHelp();
    process.exit(1);
  }

  try {
    const changedFiles = filesArg.split(',').map(p => p.trim()).filter(Boolean);
    const result = resolveHotspotRisk(changedFiles, projectRoot);

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Hotspot Risk: ${result.risk_level.toUpperCase()}`);
      console.log(`Max Score: ${result.max_score}`);
      console.log(`Matching Files: ${result.hotspot_files.length}`);
      for (const f of result.hotspot_files) {
        console.log(`  ${f.path} (score: ${f.hotspot_score}, risk: ${f.risk})`);
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { resolveHotspotRisk, loadCachedHotspots, saveCachedHotspots };

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

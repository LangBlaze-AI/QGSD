#!/usr/bin/env node
'use strict';
// bin/repowise/inject-cochange-debug.cjs — Inject co-change partners into debug context bundles

const path = require('path');
const { computeCoChange, getPartnersForFile } = require('./cochange.cjs');

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const fs = require('fs');
const CACHE_TTL_MS = 60 * 60 * 1000;

function getCachePath(projectRoot) {
  return path.join(projectRoot, '.planning', 'repowise', 'cochange-cache.json');
}

function loadCachedCoChange(projectRoot) {
  try {
    const cachePath = getCachePath(projectRoot);
    if (!fs.existsSync(cachePath)) return null;
    const stat = fs.statSync(cachePath);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveCachedCoChange(projectRoot, data) {
  try {
    const cachePath = getCachePath(projectRoot);
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (_) {
    // fail-open
  }
}

// ---------------------------------------------------------------------------
// Debug injection (COCH-04)
// ---------------------------------------------------------------------------

function injectCoChangeDebug(filePath, projectRoot, options) {
  let cochange = loadCachedCoChange(projectRoot);
  if (!cochange) {
    cochange = computeCoChange(projectRoot, options);
    const serializable = {
      pairs: cochange.pairs,
      summary: cochange.summary,
    };
    saveCachedCoChange(projectRoot, serializable);
  }

  // Rebuild fileIndex from pairs if it's missing (e.g., loaded from cache)
  if (!cochange.fileIndex || !(cochange.fileIndex instanceof Map)) {
    const fileIndex = new Map();
    const pairs = Array.isArray(cochange.pairs) ? cochange.pairs : [];
    for (const p of pairs) {
      if (!p || typeof p !== 'object') continue;
      if (!fileIndex.has(p.file1)) fileIndex.set(p.file1, []);
      if (!fileIndex.has(p.file2)) fileIndex.set(p.file2, []);
      fileIndex.get(p.file1).push({ partner: p.file2, shared_commits: p.shared_commits, coupling_degree: p.coupling_degree });
      fileIndex.get(p.file2).push({ partner: p.file1, shared_commits: p.shared_commits, coupling_degree: p.coupling_degree });
    }
    cochange.fileIndex = fileIndex;
  }

  const partners = getPartnersForFile(filePath, cochange);
  if (partners.length === 0) return null;

  const lines = partners.slice(0, 10).map(p =>
    `  - ${p.partner} (shared commits: ${p.shared_commits}, coupling: ${p.coupling_degree})`
  );

  return `CO-CHANGE PARTNERS: The following files frequently change together with ${filePath}:\n${lines.join('\n')}\nConsider investigating these files when debugging ${filePath}.`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node bin/repowise/inject-cochange-debug.cjs [options]

Options:
  --file=path          File path to find co-change partners for
  --project-root=/path Override project root directory
  --json               Output structured JSON
  --help               Show this help message

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

  const fileArg = (() => {
    const a = args.find(a => a.startsWith('--file='));
    return a ? a.split('=').slice(1).join('=') : null;
  })();
  const jsonOutput = args.includes('--json');

  if (!fileArg) {
    printHelp();
    process.exit(1);
  }

  try {
    const result = injectCoChangeDebug(fileArg, projectRoot);
    if (jsonOutput) {
      const cochange = computeCoChange(projectRoot);
      const partners = getPartnersForFile(fileArg, cochange);
      console.log(JSON.stringify({ file: fileArg, partners, injection: result }, null, 2));
    } else if (result) {
      console.log(result);
    } else {
      console.log(`No co-change partners found for ${fileArg}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { injectCoChangeDebug, loadCachedCoChange, saveCachedCoChange };

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

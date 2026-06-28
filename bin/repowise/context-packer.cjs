#!/usr/bin/env node
'use strict';
// bin/repowise/context-packer.cjs — Single entry point for Repowise context packing

const fs = require('fs');
const path = require('path');
const { packFile } = require('./pack-file.cjs');
const { escapeXml } = require('./escape-xml.cjs');
const { computeHotspots, formatHotspotXml } = require('./hotspot.cjs');
const { computeCoChange, formatCoChangeXml } = require('./cochange.cjs');
const { extractSkeleton, formatSkeletonXml, enrichSkeleton } = require('./skeleton.cjs');
const { compressContext } = require('./budget-compressor.cjs');

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------

function resolveProjectRoot() {
  const args = process.argv.slice(2);
  const rootArg = args.find(a => a.startsWith('--project-root='));
  if (rootArg) return rootArg.split('=').slice(1).join('=');
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  return path.resolve(__dirname, '../..');
}

// ---------------------------------------------------------------------------
// packContext — programmatic API
// ---------------------------------------------------------------------------

function packContext({ files, projectRoot, signals }) {
  const sig = signals || {};
  const fileList = (Array.isArray(files) ? files : [])
    .filter(f => f && typeof f === 'object')
    .map(f => ({ ...f, filePath: typeof f.filePath === 'string' ? f.filePath : '' }));

  const skeletonSection = sig.skeleton
    ? `<skeleton available="true">${sig.skeleton}</skeleton>`
    : '<skeleton available="false"/>';
  const hotspotSection = sig.hotspot
    ? `<hotspot available="true">${sig.hotspot}</hotspot>`
    : '<hotspot available="false"/>';
  const cochangeSection = sig.cochange
    ? `<cochange available="true">${sig.cochange}</cochange>`
    : '<cochange available="false"/>';

  const fileTags = fileList.map(f => packFile({ filePath: f.filePath, content: f.content, lang: f.lang }));

  const filesSection = fileTags.length > 0
    ? `<files>\n${fileTags.join('\n')}\n</files>`
    : '<files/>';

  const xml = `<repowise>\n${skeletonSection}\n${hotspotSection}\n${cochangeSection}\n${filesSection}\n</repowise>`;

  const json = {
    repowise: {
      skeleton: { available: !!sig.skeleton, data: sig.skeleton || null, ...(sig._skeletonData ? { files: sig._skeletonData } : {}) },
      hotspot: { available: !!sig.hotspot, data: sig.hotspot || null, ...(sig._hotspotData ? { summary: sig._hotspotData.summary, files: sig._hotspotData.files } : {}) },
      cochange: { available: !!sig.cochange, data: sig.cochange || null, ...(sig._cochangeData ? { summary: sig._cochangeData.summary, pairs: sig._cochangeData.pairs } : {}) },
      files: fileList.map(f => ({
        path: f.filePath,
        lang: f.lang !== undefined ? f.lang : (path.extname(f.filePath) ? null : null),
        content: f.content,
      })),
    },
  };

  return { xml, json };
}

// ---------------------------------------------------------------------------
// resolveFileList — resolve file paths from CLI args or stdin
// ---------------------------------------------------------------------------

function resolveFileList(filesArg, stdinMode, projectRoot) {
  let filePaths;

  if (stdinMode) {
    const stdin = fs.readFileSync(0, 'utf8');
    filePaths = stdin.split('\n').map(l => l.trim()).filter(Boolean);
  } else if (filesArg) {
    filePaths = filesArg.split(',').map(p => p.trim()).filter(Boolean);
  } else {
    return [];
  }

  return filePaths.map(fp => {
    const resolved = path.resolve(projectRoot, fp);
    const content = fs.readFileSync(resolved, 'utf8');
    const relativePath = path.relative(projectRoot, resolved);
    return { filePath: relativePath, content };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node bin/repowise/context-packer.cjs [options]

Options:
  --files=path1,path2   Comma-separated file paths to pack
  --stdin               Read file paths from stdin (one per line)
  --json                Output structured JSON instead of XML
  --project-root=/path  Override project root directory
  --hotspot             Include hotspot detection data in output
  --cochange            Include co-change prediction data in output
  --skeleton            Include skeleton views for packed files
  --budget=N            Token budget for budget-aware compression
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

  const filesArg = (() => {
    const a = args.find(a => a.startsWith('--files='));
    return a ? a.split('=').slice(1).join('=') : null;
  })();
  const stdinMode = args.includes('--stdin');
  const jsonOutput = args.includes('--json');
  const includeHotspot = args.includes('--hotspot');
  const includeCochange = args.includes('--cochange');
  const includeSkeleton = args.includes('--skeleton');
  const budgetArg = (() => {
    const a = args.find(a => a.startsWith('--budget='));
    return a ? parseInt(a.split('=')[1], 10) : null;
  })();
  const projectRoot = resolveProjectRoot();

  if (!filesArg && !stdinMode) {
    printHelp();
    process.exit(1);
  }

  try {
    const files = resolveFileList(filesArg, stdinMode, projectRoot);

    const signals = {};
    if (includeHotspot) {
      const hotspots = computeHotspots(projectRoot);
      signals.hotspot = formatHotspotXml(hotspots);
      signals._hotspotData = hotspots;
    }
    if (includeCochange) {
      const cochange = computeCoChange(projectRoot);
      signals.cochange = formatCoChangeXml(cochange);
      signals._cochangeData = cochange;
    }
    if (includeSkeleton) {
      const skeletonEntries = [];
      for (const f of files) {
        const skeleton = await extractSkeleton(f.filePath, projectRoot);
        const enriched = enrichSkeleton(
          { ...skeleton, filePath: f.filePath },
          signals._hotspotData,
          signals._cochangeData
        );
        skeletonEntries.push(enriched);
      }
      signals.skeleton = skeletonEntries.map(s =>
        `<file path="${escapeXml(s.filePath || '')}" lang="${s.lang || ''}" method="${s.method}" lines="${s.lineCount}">\n${formatSkeletonXml(s.entries)}\n</file>`
      ).join('\n');
      signals._skeletonData = skeletonEntries;
    }

    const { xml, json } = packContext({ files, projectRoot, signals });

    if (budgetArg !== null) {
      const budgetFiles = files.map(f => ({
        filePath: f.filePath,
        hotspotRisk: (signals._hotspotData?.files || []).find(h => h.path === f.filePath)?.hotspot_score || 0,
        skeletonEntries: (signals._skeletonData || []).find(s => s.filePath === f.filePath)?.entries || [],
        fullContent: f.content,
        skeletonXml: (signals._skeletonData || []).find(s => s.filePath === f.filePath)
          ? formatSkeletonXml((signals._skeletonData.find(s => s.filePath === f.filePath) || {}).entries || [])
          : '',
      }));
      const compressed = compressContext(budgetFiles, budgetArg);
      if (jsonOutput) {
        console.log(JSON.stringify(compressed.json, null, 2));
      } else {
        console.log(compressed.xml);
      }
    } else if (jsonOutput) {
      console.log(JSON.stringify(json, null, 2));
    } else {
      console.log(xml);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { packContext, resolveFileList };

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

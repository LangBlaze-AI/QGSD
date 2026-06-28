#!/usr/bin/env node
'use strict';
// bin/repowise/skeleton.cjs — AST-based structural skeleton views for Repowise

const fs = require('fs');
const path = require('path');
const { escapeXml } = require('./escape-xml.cjs');

// ---------------------------------------------------------------------------
// Grammar configuration
// ---------------------------------------------------------------------------

const LANG_GRAMMAR_MAP = {
  js: { wasmFile: 'tree-sitter-javascript/tree-sitter-javascript.wasm', definitionNodes: ['function_declaration', 'function', 'arrow_function', 'class_declaration', 'method_definition', 'generator_function_declaration', 'lexical_declaration'] },
  ts: { wasmFile: 'tree-sitter-typescript/tree-sitter-typescript.wasm', definitionNodes: ['function_declaration', 'function', 'arrow_function', 'class_declaration', 'method_definition', 'generator_function_declaration', 'lexical_declaration', 'abstract_class_declaration'] },
  tsx: { wasmFile: 'tree-sitter-typescript/tree-sitter-tsx.wasm', definitionNodes: ['function_declaration', 'function', 'arrow_function', 'class_declaration', 'method_definition', 'generator_function_declaration', 'lexical_declaration', 'abstract_class_declaration'] },
  py: { wasmFile: 'tree-sitter-python/tree-sitter-python.wasm', definitionNodes: ['function_definition', 'class_definition'] },
};

const DECISION_NODE_TYPES = new Set([
  'if_statement', 'for_statement', 'for_in_statement', 'while_statement',
  'do_statement', 'switch_case', 'conditional_expression', 'try_statement',
  'catch_clause', 'and_expr', 'or_expr', 'boolean_operator',
]);

// ---------------------------------------------------------------------------
// Lazy web-tree-sitter initialization
// ---------------------------------------------------------------------------

let parserInitPromise = null;
let ParserClass = null;

async function ensureParser() {
  if (parserInitPromise) return parserInitPromise;

  parserInitPromise = (async () => {
    try {
      const wt = require('web-tree-sitter');
      await wt.Parser.init();
      ParserClass = wt.Parser;
      return true;
    } catch (_) {
      ParserClass = null;
      return false;
    }
  })();

  return parserInitPromise;
}

// ---------------------------------------------------------------------------
// Language loading
// ---------------------------------------------------------------------------

const languageCache = new Map();

async function loadLanguage(lang) {
  if (languageCache.has(lang)) return languageCache.get(lang);

  const config = LANG_GRAMMAR_MAP[lang];
  if (!config) return null;

  try {
    const wt = require('web-tree-sitter');
    const wasmPath = require.resolve(config.wasmFile);
    const language = await wt.Language.load(wasmPath);
    languageCache.set(lang, { language, definitionNodes: config.definitionNodes });
    return languageCache.get(lang);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// AST-based skeleton extraction
// ---------------------------------------------------------------------------

function extractName(node) {
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'property_identifier' || child.type === 'type_identifier') {
      return child.text;
    }
  }
  return null;
}

function extractSkeletonFromTree(tree, definitionNodes) {
  const entries = [];

  function walk(node) {
    if (definitionNodes.includes(node.type)) {
      const name = extractName(node);
      const complexity = countDecisionPoints(node);
      entries.push({
        type: node.type,
        name: name || '<anonymous>',
        start: node.startPosition.row + 1,
        end: node.endPosition.row + 1,
        complexity: complexity + 1,
      });
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  walk(tree.rootNode);
  return entries;
}

function countDecisionPoints(node) {
  let count = 0;

  function walk(n) {
    if (DECISION_NODE_TYPES.has(n.type)) count++;
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i));
    }
  }

  walk(node);
  return count;
}

// ---------------------------------------------------------------------------
// Regex-based fallback skeleton extraction
// ---------------------------------------------------------------------------

const REGEX_PATTERNS = {
  js: /^(export\s+)?(async\s+)?(function|const|let|var|class)\s+(\w+)/gm,
  ts: /^(export\s+)?(async\s+)?(function|const|let|var|class|interface|type)\s+(\w+)/gm,
  tsx: /^(export\s+)?(async\s+)?(function|const|let|var|class|interface|type)\s+(\w+)/gm,
  py: /^(def|class)\s+(\w+)/gm,
};

function extractSkeletonRegex(content, lang) {
  const pattern = REGEX_PATTERNS[lang];
  if (!pattern) return [];

  const lines = content.split('\n');
  const entries = [];
  let match;

  pattern.lastIndex = 0;
  while ((match = pattern.exec(content)) !== null) {
    const offset = match.index;
    let lineNum = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
      if (content[i] === '\n') lineNum++;
    }
    entries.push({
      type: match[3] || match[1] || 'function',
      name: match[4] || match[2] || '<unknown>',
      start: lineNum,
      end: lineNum,
      complexity: 1,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Main API: extractSkeleton
// ---------------------------------------------------------------------------

async function extractSkeleton(filePath, projectRoot, options) {
  const opts = options || {};
  const fullPath = path.resolve(projectRoot, filePath);

  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch (_) {
    return { entries: [], lang: null, lineCount: 0, method: 'none' };
  }

  const ext = path.extname(filePath);
  const langMap = require('./pack-file.cjs').LANG_MAP;
  const lang = langMap[ext] || null;

  if (!lang) {
    return { entries: [], lang: null, lineCount: content.split('\n').length, method: 'none' };
  }

  const lineCount = content.split('\n').length;

  // Try AST-based extraction first
  const parserReady = await ensureParser();
  if (parserReady && ParserClass) {
    const langConfig = await loadLanguage(lang);
    if (langConfig) {
      try {
        const parser = new ParserClass();
        parser.setLanguage(langConfig.language);
        const tree = parser.parse(content);
        const entries = extractSkeletonFromTree(tree, langConfig.definitionNodes);
        tree.delete();
        parser.delete();
        return { entries, lang, lineCount, method: 'ast' };
      } catch (_) {
        // Fall through to regex
      }
    }
  }

  // Regex fallback
  const entries = extractSkeletonRegex(content, lang);
  return { entries, lang, lineCount, method: 'regex' };
}

// ---------------------------------------------------------------------------
// Enrichment with hotspot and co-change data
// ---------------------------------------------------------------------------

function enrichSkeleton(skeleton, hotspots, cochange) {
  const hotspotMap = new Map();
  if (hotspots && Array.isArray(hotspots.files)) {
    for (const f of hotspots.files) {
      if (f && typeof f === 'object' && f.path !== undefined) hotspotMap.set(f.path, f);
    }
  }

  const cochangeMap = new Map();
  if (cochange && cochange.fileIndex) {
    for (const [filePath, partners] of cochange.fileIndex) {
      cochangeMap.set(filePath, partners);
    }
  }

  const filePath = skeleton.filePath || '';
  const hotspotEntry = hotspotMap.get(filePath);
  const cochangePartners = cochangeMap.get(filePath) || [];

  return {
    ...skeleton,
    hotspot_risk: hotspotEntry ? hotspotEntry.hotspot_score : undefined,
    max_coupling_degree: (() => {
      const degrees = (Array.isArray(cochangePartners) ? cochangePartners : [])
        .map(p => (p && typeof p.coupling_degree === 'number' ? p.coupling_degree : NaN))
        .filter(d => Number.isFinite(d));
      return degrees.length > 0 ? Math.max(...degrees) : undefined;
    })(),
  };
}

// ---------------------------------------------------------------------------
// XML formatting
// ---------------------------------------------------------------------------

function formatSkeletonXml(skeletons) {
  const entries = skeletons.map(s => {
    const parts = [`type="${escapeXml(s.type)}"`, `name="${escapeXml(s.name)}"`, `start="${s.start}"`, `end="${s.end}"`, `complexity="${s.complexity}"`];
    if (s.hotspot_risk !== undefined) parts.push(`hotspot_risk="${s.hotspot_risk}"`);
    if (s.max_coupling_degree !== undefined) parts.push(`coupling_degree="${s.max_coupling_degree}"`);
    return `<entry ${parts.join(' ')}/>`;
  });
  return entries.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node bin/repowise/skeleton.cjs [options]

Options:
  --file=path            File path to extract skeleton for
  --project-root=/path   Override project root directory
  --json                 Output structured JSON
  --help                 Show this help message

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
    const result = await extractSkeleton(fileArg, projectRoot);
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Skeleton: ${fileArg} (${result.method})`);
      for (const e of result.entries) {
        console.log(`  ${e.type} ${e.name} [${e.start}-${e.end}] complexity=${e.complexity}`);
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  extractSkeleton,
  extractSkeletonFromTree,
  extractSkeletonRegex,
  enrichSkeleton,
  formatSkeletonXml,
  countDecisionPoints,
  LANG_GRAMMAR_MAP,
  DECISION_NODE_TYPES,
};

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

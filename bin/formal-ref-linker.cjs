/**
 * Formal reference auto-linker for debt entries
 * Layered resolution: manual > auto-detect > spec-inferred > null
 *
 * - manual: existing formal_ref set by human (never overwritten)
 * - auto-detect: keyword matching against requirements.json
 * - spec-inferred: module name matching against .planning/formal/spec/ directories
 * - null: no match found
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Tokenize a string into lowercase keywords (split on spaces, hyphens, underscores)
 * Filters out short tokens (< 3 chars) to reduce noise
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return (typeof text === 'string' ? text : '')
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter(t => t.length >= 3);
}

/**
 * Score keyword overlap between two token sets
 * @param {string[]} tokensA
 * @param {string[]} tokensB
 * @returns {number} Count of matching tokens
 */
function keywordScore(tokensA, tokensB) {
  const setB = new Set(tokensB);
  return tokensA.filter(t => setB.has(t)).length;
}

/**
 * Link debt entries to formal model references using layered resolution.
 *
 * @param {object[]} entries - Array of debt entries
 * @param {object} [options] - Options
 * @param {string} [options.requirementsPath] - Path to requirements.json
 * @param {string} [options.specDir] - Path to .planning/formal/spec/ directory
 * @returns {{ entries: object[], linkedCount: number, linkLog: object[] }}
 */
function linkFormalRefs(entries, options = {}) {
  const requirementsPath = options.requirementsPath || path.resolve(process.cwd(), '.planning/formal/requirements.json');
  const specDir = options.specDir || path.resolve(process.cwd(), '.planning/formal/spec');

  const linkLog = [];
  let linkedCount = 0;

  // Load requirements (fail-open)
  let requirements = [];
  try {
    const content = fs.readFileSync(requirementsPath, 'utf8');
    requirements = JSON.parse(content);
    if (!Array.isArray(requirements)) requirements = [];
  } catch {
    // fail-open: skip auto-detect layer
  }

  // Tokenize requirements for keyword matching
  const reqTokens = requirements
    .filter(req => req != null && typeof req === 'object')
    .map(req => ({
      id: req.id,
      tokens: tokenize(`${req.id} ${req.text || ''}`)
    }));

  // Load spec module names (fail-open)
  let specModules = [];
  try {
    const dirEntries = fs.readdirSync(specDir, { withFileTypes: true });
    specModules = dirEntries
      .filter(de => de.isDirectory())
      .map(de => de.name.toLowerCase());
  } catch {
    // fail-open: skip spec-inferred layer
  }

  // Load proximity index (fail-open)
  let proximityIndex = null;
  try {
    const indexPath = path.resolve(process.cwd(), '.planning', 'formal', 'proximity-index.json');
    if (fs.existsSync(indexPath)) {
      proximityIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    }
  } catch {
    // fail-open: skip proximity-graph layer
  }

  for (const entry of entries) {
    // Layer 1: Manual — existing formal_ref with source already set
    if (entry.formal_ref != null && entry.formal_ref_source != null) {
      // Already linked manually — do not overwrite
      continue;
    }

    // If formal_ref is set but formal_ref_source is not, mark as manual
    if (entry.formal_ref != null && entry.formal_ref_source == null) {
      entry.formal_ref_source = 'manual';
      linkLog.push({ entry_id: entry.id, formal_ref: entry.formal_ref, source: 'manual' });
      linkedCount++;
      continue;
    }

    // Layer 2: Auto-detect — keyword matching against requirements
    const titleTokens = tokenize(entry.title);
    let bestReq = null;
    let bestScore = 0;

    for (const req of reqTokens) {
      const score = keywordScore(titleTokens, req.tokens);
      if (score > bestScore) {
        bestScore = score;
        bestReq = req;
      }
    }

    if (bestReq && bestScore > 0) {
      entry.formal_ref = `requirement:${bestReq.id}`;
      entry.formal_ref_source = 'auto-detect';
      linkLog.push({ entry_id: entry.id, formal_ref: entry.formal_ref, source: 'auto-detect', score: bestScore });
      linkedCount++;
      continue;
    }

    // Layer 2.5: Proximity graph — walk from source file to formal modules (fail-open)
    if (entry.source_file && proximityIndex && proximityIndex.nodes) {
      const fileKey = 'code_file::' + entry.source_file;
      if (proximityIndex.nodes[fileKey]) {
        const visited = new Set([fileKey]);
        let frontier = [{ key: fileKey, depth: 0 }];
        let bestProxModule = null;

        while (frontier.length > 0) {
          const nextFrontier = [];
          for (const { key, depth } of frontier) {
            if (depth >= 2) continue;
            const node = proximityIndex.nodes[key];
            if (!node || !Array.isArray(node.edges)) continue;
            for (const edge of node.edges) {
              if (visited.has(edge.to)) continue;
              visited.add(edge.to);
              const target = proximityIndex.nodes[edge.to];
              if (!target) continue;
              if (target.type === 'formal_module') {
                bestProxModule = edge.to.replace('formal_module::', '');
                break;
              }
              nextFrontier.push({ key: edge.to, depth: depth + 1 });
            }
            if (bestProxModule) break;
          }
          if (bestProxModule) break;
          frontier = nextFrontier;
        }

        if (bestProxModule) {
          entry.formal_ref = `spec:${bestProxModule}`;
          entry.formal_ref_source = 'proximity-graph';
          linkLog.push({ entry_id: entry.id, formal_ref: entry.formal_ref, source: 'proximity-graph' });
          linkedCount++;
          continue;
        }
      }
    }

    // Layer 3: Spec-inferred — module name substring matching
    const titleLower = (typeof entry.title === 'string' ? entry.title : '').toLowerCase();
    let matched = false;
    for (const mod of specModules) {
      if (titleLower.includes(mod)) {
        entry.formal_ref = `spec:${mod}`;
        entry.formal_ref_source = 'spec-inferred';
        linkLog.push({ entry_id: entry.id, formal_ref: entry.formal_ref, source: 'spec-inferred' });
        linkedCount++;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Layer 4: No match
      entry.formal_ref = null;
      entry.formal_ref_source = null;
    }
  }

  return { entries, linkedCount, linkLog };
}

module.exports = { linkFormalRefs };

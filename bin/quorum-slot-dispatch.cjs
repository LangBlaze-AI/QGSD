#!/usr/bin/env node
'use strict';

/**
 * quorum-slot-dispatch.cjs — prompt construction + output parsing wrapper
 *
 * Usage:
 *   node quorum-slot-dispatch.cjs \
 *     --slot <name> \
 *     --mode <A|B> \
 *     --round <n> \
 *     --question <text> \
 *     [--artifact-path <path>] \
 *     [--review-context <string>] \
 *     [--prior-positions-file <path>] \
 *     [--traces-file <path>] \
 *     [--request-improvements] \
 *     [--timeout <ms>] \
 *     [--cwd <dir>]
 *
 * Builds the Mode A or Mode B prompt from deterministic JS templates matching
 * agents/nf-quorum-slot-worker.md Step 2, pipes it to call-quorum-slot.cjs via
 * child_process.spawn, parses the output, and emits a structured YAML result block.
 *
 * Exported pure functions (testable without subprocess):
 *   buildModeAPrompt, buildModeBPrompt, parseVerdict, parseReasoning,
 *   parseCitations, parseImprovements, emitResultBlock, stripQuotes
 */

const { spawn }  = require('child_process');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const planningPaths = require('./planning-paths.cjs');
const { loadProviders } = require('./resolve-providers.cjs');
const { buildDispatchArgv } = require('./quorum-dispatch-argv.cjs'); // #202: parent→child argv contract

// ─── Providers.json (single source of truth — issue #197) ────────────────────
// Canonical installed path: ~/.claude/nf-bin/providers.json
// (`'.claude', 'nf-bin', 'providers.json'`). Returns [] when no populated file is found.
function loadDispatchProviders() {
  return loadProviders({ baseDir: __dirname }) || [];
}

// ─── Routing reward recording (fail-open) ───────────────────────────────────
let recordRoutingReward;
try {
  recordRoutingReward = require(path.join(__dirname, 'coding-task-router.cjs')).recordRoutingReward;
} catch (_) {
  recordRoutingReward = () => {};  // fail-open
}

// ─── Per-provider rate-limit semaphore (SOLVE-10) ───────────────────────────
// CONSOLIDATED (#201): the previous divergent semaphore here (sha256(baseUrl) key,
// PATH `sleep`, count-then-write TOCTOU over-admission, no TTL, deleted live locks
// on EPERM) was a SECOND guard over the same provider resource already protected by
// bin/provider-concurrency.cjs. The spawned call-quorum-slot.cjs child acquires a
// provider-concurrency slot in runHttp() for the FULL request lifetime, so the cap
// is enforced there with the single hardened module. Guarding again at dispatch
// level only doubled the bookkeeping with a buggier implementation, so it is removed.

// ─── Config-loader integration (two-layer merge for nf.json settings) ────────
function loadNfConfig(cwd) {
  const candidates = [
    path.join(os.homedir(), '.claude', 'hooks', 'config-loader.js'),
    path.join(__dirname, '..', 'hooks', 'dist', 'config-loader.js'),
    path.join(__dirname, '..', 'hooks', 'config-loader.js'),
  ];
  for (const p of candidates) {
    try {
      const { loadConfig } = require(p);
      return loadConfig(cwd);
    } catch (_) {}
  }
  return {}; // fail-open: empty config uses defaults
}

// ─── classifyDispatchError — classify UNAVAIL output into a human-readable type ──────────────
/**
 * Classify the raw output/error string from a failed dispatch into a concise error type.
 * Mirrors the classifyErrorType logic from call-quorum-slot.cjs.
 *
 * @param {string} output — combined stdout/stderr from the failed child process
 * @returns {'IDLE_TIMEOUT'|'HARD_TIMEOUT'|'TIMEOUT'|'AUTH'|'QUOTA'|'SPAWN_ERROR'|'CLI_SYNTAX'|'UNKNOWN'}
 */
function classifyDispatchError(output) {
  const s = String(output || '');
  if (/CONTEXT_OVERFLOW/i.test(s) || /exceeds.*maximum context length|token count exceeds|too many tokens/i.test(s)) return 'CONTEXT_OVERFLOW';
  if (/RATE_LIMITED/i.test(s)) return 'RATE_LIMITED';
  if (/STALL/i.test(s)) return 'STALL';
  if (/IDLE_TIMEOUT/i.test(s)) return 'IDLE_TIMEOUT';
  if (/HARD_TIMEOUT/i.test(s)) return 'HARD_TIMEOUT';
  if (/TIMEOUT/i.test(s)) return 'TIMEOUT'; // backward compat
  if (/402|quota|rate.?limit|resource.?exhausted|Too Many Requests|exhausted your capacity/i.test(s)) return 'QUOTA';
  if (/401|403|unauthorized|forbidden/i.test(s)) return 'AUTH';
  if (/service not running|service.?down|not.?started/i.test(s)) return 'SERVICE_DOWN';
  if (/spawn error/i.test(s)) return 'SPAWN_ERROR';
  if (/usage:|unknown flag|unknown option|invalid flag|unrecognized/i.test(s)) return 'CLI_SYNTAX';
  return 'UNKNOWN';
}

// ─── Arg parsing (mirrors call-quorum-slot.cjs pattern) ───────────────────────
const argv   = process.argv.slice(2);
const getArg = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
};
const hasFlag = (f) => argv.includes(f);
const reviewOnly = hasFlag('--review-only'); // EXEC-01: review-only tool restriction

// ─── Precedent loading, matching, and formatting functions ───────────────────

/**
 * Cache for loaded precedents, keyed by projectRoot.
 * @type {Map<string, Array>}
 */
const precedentsCache = new Map();

/**
 * loadPrecedents — reads `.planning/quorum/precedents.json` from projectRoot.
 * Fail-open: returns [] if file missing, malformed, or any error occurs.
 *
 * @param {string} projectRoot
 * @returns {Array} — array of precedent objects, or [] if load failed
 */
function loadPrecedents(projectRoot) {
  if (precedentsCache.has(projectRoot)) {
    return precedentsCache.get(projectRoot);
  }
  try {
    const precPath = path.join(projectRoot, '.planning', 'quorum', 'precedents.json');
    const raw = fs.readFileSync(precPath, 'utf8');
    const parsed = JSON.parse(raw);
    const precedents = Array.isArray(parsed.precedents) ? parsed.precedents : [];
    precedentsCache.set(projectRoot, precedents);
    return precedents;
  } catch (e) {
    process.stderr.write(`[quorum-slot-dispatch] precedents load failed (fail-open): ${e.message}\n`);
    precedentsCache.set(projectRoot, []);
    return [];
  }
}

/**
 * matchPrecedentsByKeywords — scores and selects relevant precedents for a question.
 * Reuses extractKeywords() for tokenization. Filters stale entries (>90 days).
 *
 * @param {Array} precedents — array of precedent objects
 * @param {string} question — the current quorum question
 * @param {number} [maxMatches=3] — max precedents to return
 * @returns {Array} — matched precedent objects sorted by relevance
 */
function matchPrecedentsByKeywords(precedents, question, maxMatches = 3) {
  if (!precedents || precedents.length === 0 || !question) return [];

  const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const questionKw = extractKeywords(question);
  if (questionKw.size === 0) return [];

  const scored = [];
  for (const prec of precedents) {
    // TTL check — inline to avoid cross-module dependency
    try {
      const precTime = new Date(prec.date).getTime();
      if (isNaN(precTime) || (Date.now() - precTime) >= MAX_AGE_MS) continue;
    } catch {
      continue;
    }

    const precQuestionKw = extractKeywords(prec.question);
    const precOutcomeKw = extractKeywords(prec.outcome);

    // Score: question overlap * 1 + outcome overlap * 2
    let score = 0;
    for (const kw of questionKw) {
      if (precQuestionKw.has(kw)) score += 1;
      if (precOutcomeKw.has(kw)) score += 2;
    }

    if (score > 0) {
      scored.push({ prec, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxMatches).map(s => s.prec);
}

/**
 * formatPrecedentsSection — formats matched precedents into a text block for prompt injection.
 * Returns null if input is empty/null.
 *
 * @param {Array} precedents — array of matched precedent objects
 * @returns {string|null} — formatted section or null
 */
function formatPrecedentsSection(precedents) {
  if (!precedents || precedents.length === 0) return null;

  const lines = [];
  lines.push('=== PAST QUORUM PRECEDENTS ===');
  lines.push('The following past quorum decisions are relevant to this question.');
  lines.push('Consider whether they apply or should be revisited:');
  lines.push('');

  for (const prec of precedents) {
    const q = prec.question && prec.question.length > 120
      ? prec.question.slice(0, 120) + '...'
      : (prec.question || '');
    const o = prec.outcome && prec.outcome.length > 150
      ? prec.outcome.slice(0, 150) + '...'
      : (prec.outcome || '');
    lines.push(`- **${prec.consensus}** (${prec.date}): ${q}`);
    lines.push(`  Outcome: ${o}`);
  }

  lines.push('');
  lines.push('================================');

  return lines.join('\n');
}

// ─── Requirements loading and matching functions ──────────────────────────────

/**
 * Cache for loaded requirements, keyed by projectRoot to avoid re-reading disk.
 * @type {Map<string, Array>}
 */
const requirementsCache = new Map();

/**
 * loadRequirements — reads `.planning/formal/requirements.json` from projectRoot.
 * Fail-open: returns [] if file missing, malformed, or any error occurs.
 * Caches result keyed by projectRoot to avoid re-reading disk.
 *
 * @param {string} projectRoot
 * @returns {Array} — array of requirement objects, or [] if load failed
 */
function loadRequirements(projectRoot) {
  if (requirementsCache.has(projectRoot)) {
    return requirementsCache.get(projectRoot);
  }

  try {
    const filePath = path.join(projectRoot, '.planning', 'formal', 'requirements.json');
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    const reqs = Array.isArray(data.requirements) ? data.requirements : [];
    requirementsCache.set(projectRoot, reqs);
    return reqs;
  } catch (e) {
    // Fail-open: return empty array on any error (missing file, malformed JSON, etc.)
    requirementsCache.set(projectRoot, []);
    return [];
  }
}

/**
 * List of English stopwords to filter out during keyword extraction.
 * @type {Set<string>}
 */
const STOPWORDS = new Set([
  'the', 'a', 'is', 'it', 'to', 'of', 'and', 'or', 'in', 'for', 'this', 'that',
  'with', 'from', 'be', 'are', 'was', 'has', 'have', 'do', 'does', 'not', 'but',
  'an', 'on', 'at', 'by', 'we', 'should', 'would', 'could', 'will', 'can',
  'what', 'how', 'why', 'when', 'which', 'these', 'those', 'as', 'if', 'then',
  'there', 'their', 'they', 'them', 'its', 'so', 'some', 'any', 'all', 'each',
  'every', 'both', 'other', 'very', 'just', 'only', 'more', 'most', 'less', 'too'
]);

/**
 * Map artifact path segments to category groups for stronger matching.
 * @type {Map<string, string>}
 */
const PATH_CATEGORY_MAP = new Map([
  ['hook', 'Hooks & Enforcement'],
  ['quorum', 'Quorum & Dispatch'],
  ['dispatch', 'Quorum & Dispatch'],
  ['install', 'Installer & CLI'],
  ['mcp', 'MCP & Agents'],
  ['agent', 'MCP & Agents'],
  ['slot', 'MCP & Agents'],
  ['formal', 'Formal Verification'],
  ['alloy', 'Formal Verification'],
  ['tla', 'Formal Verification'],
  ['prism', 'Formal Verification'],
  ['config', 'Configuration'],
  ['plan', 'Planning & Tracking'],
  ['state', 'Planning & Tracking'],
  ['test', 'Testing & Quality'],
  ['observe', 'Observability & Diagnostics'],
  ['telemetry', 'Observability & Diagnostics'],
  ['scoreboard', 'Observability & Diagnostics']
]);

/**
 * matchRequirementsByKeywords — filters requirements based on keywords from question and artifact path.
 * Returns max 20 matching requirements, sorted by relevance score (descending).
 *
 * @param {Array} requirements — full requirements array
 * @param {string} question — the question text
 * @param {string|null} artifactPath — optional artifact path (e.g. "hooks/nf-stop.js")
 * @returns {Array} — filtered requirements (max 20), sorted by score descending
 */
function matchRequirementsByKeywords(requirements, question, artifactPath) {
  if (!requirements || requirements.length === 0) {
    return [];
  }

  // Extract keywords from question
  const questionKeywords = extractKeywords(question);

  // Extract keywords from artifact path
  const pathKeywords = artifactPath ? extractPathKeywords(artifactPath) : new Set();
  const pathCategories = artifactPath ? extractPathCategories(artifactPath) : [];

  // Score each requirement
  const scored = requirements.map(req => {
    let score = 0;

    // Match on id prefix (e.g. "DISP" from "DISP-01")
    const idPrefix = req.id ? req.id.split('-')[0].toLowerCase() : '';
    if (idPrefix && (questionKeywords.has(idPrefix) || pathKeywords.has(idPrefix))) {
      score += 2;
    }

    // Match on category_raw
    if (req.category_raw) {
      const catRaw = req.category_raw.toLowerCase();
      for (const kw of questionKeywords) {
        if (catRaw.includes(kw)) score += 1;
      }
    }

    // Match on category (group)
    if (req.category) {
      const cat = req.category.toLowerCase();
      for (const kw of questionKeywords) {
        if (cat.includes(kw)) score += 1;
      }
      // Boost if category matches path-derived categories
      for (const pathCat of pathCategories) {
        if (cat === pathCat.toLowerCase()) {
          score += 3; // Strong signal from artifact path
        }
      }
    }

    // Match on text
    if (req.text) {
      const text = req.text.toLowerCase();
      for (const kw of questionKeywords) {
        if (text.includes(kw)) score += 1;
      }
      for (const kw of pathKeywords) {
        if (text.includes(kw)) score += 1;
      }
    }

    return { req, score };
  });

  // Sort by score descending, filter out zero-score entries, cap at 20
  return scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(({ req }) => req);
}

/**
 * extractKeywords — splits text into tokens and filters out stopwords.
 * Splits on spaces, slashes, hyphens, dots, underscores.
 *
 * @param {string} text
 * @returns {Set<string>} — set of meaningful lowercase tokens
 */
function extractKeywords(text) {
  if (!text) return new Set();

  // Split on common delimiters: space, /, -, ., _
  const tokens = text.toLowerCase()
    .split(/[\s\/\-\._]+/)
    .filter(t => t.length > 0 && !STOPWORDS.has(t));

  return new Set(tokens);
}

/**
 * extractPathKeywords — extracts tokens from artifact path (just filename parts).
 *
 * @param {string} artifactPath
 * @returns {Set<string>} — meaningful tokens from path
 */
function extractPathKeywords(artifactPath) {
  if (!artifactPath) return new Set();

  // Extract just the filename part
  const filename = path.basename(artifactPath);
  const tokens = filename.toLowerCase()
    .split(/[\s\/\-\._]+/)
    .filter(t => t.length > 0 && !STOPWORDS.has(t));

  return new Set(tokens);
}

/**
 * extractPathCategories — maps artifact path segments to category groups.
 * Checks each segment of the path against PATH_CATEGORY_MAP.
 *
 * @param {string} artifactPath
 * @returns {Array<string>} — matching category groups
 */
function extractPathCategories(artifactPath) {
  if (!artifactPath) return [];

  const categories = new Set();
  const segments = artifactPath.toLowerCase().split(/[\s\/\-\._]+/);

  for (const segment of segments) {
    if (PATH_CATEGORY_MAP.has(segment)) {
      categories.add(PATH_CATEGORY_MAP.get(segment));
    }
  }

  return Array.from(categories);
}

/**
 * formatRequirementsSection — formats an array of requirements into a text block.
 * Returns null if the array is empty (no section should be injected).
 *
 * @param {Array} requirements — array of requirement objects
 * @returns {string|null} — formatted section or null
 */
function formatRequirementsSection(requirements) {
  if (!requirements || requirements.length === 0) {
    return null;
  }

  const lines = [];
  lines.push('=== APPLICABLE REQUIREMENTS ===');
  lines.push('The following project requirements are relevant to this review.');
  lines.push('Consider whether the proposed change satisfies or violates these:');
  lines.push('');

  for (const req of requirements) {
    const category = req.category || 'Unknown';
    lines.push(`- [${req.id}] ${req.text} (${category})`);
  }

  lines.push('');
  lines.push('================================');

  return lines.join('\n');
}

// ─── Mode C prompt construction (delegates to coding-task-router.cjs) ───────

/**
 * buildModeCPrompt — constructs the Mode C coding task delegation prompt.
 *
 * Delegates to coding-task-router.cjs's buildCodingPrompt() to keep prompt
 * construction centralized. This wrapper maintains the pattern established
 * by buildModeAPrompt/buildModeBPrompt.
 *
 * @param {object} opts
 * @param {string}  opts.repoDir
 * @param {string}  opts.task
 * @param {string[]} [opts.files]
 * @param {string[]} [opts.constraints]
 * @param {string}  [opts.context]
 * @returns {string}
 */
function buildModeCPrompt({ repoDir, task, files, constraints, context }) {
  const { buildCodingPrompt } = require(path.join(__dirname, 'coding-task-router.cjs'));
  return buildCodingPrompt({ task, repoDir, files, constraints, context });
}

// ─── Pure prompt-construction functions ──────────────────────────────────────

/**
 * formatDiagnosticForPrompt — converts diagnostic JSON to structured markdown section.
 * Used in both Mode A and Mode B when diagnostic review-context is provided.
 *
 * @param {Object|null|undefined} diagnosticJson - Parsed diagnostic object with mismatch_diff, correction_proposals, trace_alignment
 * @returns {string} Formatted markdown section (empty string if not a diagnostic)
 */
function formatDiagnosticForPrompt(diagnosticJson) {
  if (!diagnosticJson || typeof diagnosticJson !== 'object') {
    return '';
  }

  const { mismatch_diff, correction_proposals, trace_alignment } = diagnosticJson;

  // Fail-open: if doesn't look like diagnostic structure, return empty
  if (!mismatch_diff || !Array.isArray(correction_proposals)) {
    return '';
  }

  let section = '\n\n## Model Diagnostic Feedback\n\n';
  section += 'The model is INCOMPLETE. It does not capture the bug. ';
  section += 'Here is what the model assumes vs. what the bug trace shows:\n\n';
  section += mismatch_diff + '\n\n';
  section += '### Correction Proposals (ranked by priority)\n\n';

  for (let i = 0; i < correction_proposals.length; i++) {
    const p = correction_proposals[i];
    section += `${i + 1}. **[${p.type}]** ${p.target}: ${p.reasoning}\n`;
    section += `   Example: \`${p.example}\`\n`;
  }

  section += '\n### Trace Alignment\n';
  if (trace_alignment) {
    section += `- Model states: ${trace_alignment.model_state_count || '?'}\n`;
    section += `- Bug trace states: ${trace_alignment.bug_state_count || '?'}\n`;
    section += `- First divergence: state ${trace_alignment.first_divergence_index ?? '?'}\n`;
    section += `- Diverged fields: ${(trace_alignment.diverged_fields || []).join(', ')}\n`;
  }
  section += '\nUse these proposals to guide your model refinement. Address high-priority proposals first.';

  return section;
}

/**
 * buildModeAPrompt — constructs the Mode A question prompt.
 *
 * Matches the EXACT template from agents/nf-quorum-slot-worker.md Step 2 Mode A.
 *
 * @param {object} opts
 * @param {number}  opts.round
 * @param {string}  opts.repoDir
 * @param {string}  opts.question
 * @param {string} [opts.artifactPath]
 * @param {string} [opts.artifactContent]  - pre-read content (avoids model read failures)
 * @param {string} [opts.reviewContext]
 * @param {string} [opts.priorPositions]   - Round 2+ cross-pollination
 * @param {boolean}[opts.requestImprovements]
 * @param {Array}  [opts.requirements]     - array of requirement objects to inject
 * @returns {string}
 */
function buildModeAPrompt({ round, repoDir, question, artifactPath, artifactContent, reviewContext, priorPositions, requestImprovements, requirements, precedents, hasFileAccess }) {
  const lines = [];

  // Header
  lines.push(`nForma Quorum — Round ${round}`);
  lines.push('');

  // Repository + question
  lines.push(`Repository: ${repoDir}`);
  lines.push('');
  lines.push(`Question: ${question}`);

  // Artifact section (conditional)
  if (artifactPath) {
    lines.push('');
    lines.push('=== Artifact ===');
    lines.push(`Path: ${artifactPath}`);
    if (artifactContent) {
      lines.push('Content:');
      lines.push(artifactContent);
    } else {
      lines.push('(Read this file to obtain its full content before evaluating.)');
    }
    lines.push('================');
  }

  // Requirements section (conditional — injected right after question/artifact, before review context)
  if (requirements && requirements.length > 0) {
    const reqSection = formatRequirementsSection(requirements);
    if (reqSection) {
      lines.push('');
      lines.push(reqSection);
    }
  }

  // Precedents section (conditional — injected after requirements, before review context)
  if (precedents && precedents.length > 0) {
    const precSection = formatPrecedentsSection(precedents);
    if (precSection) {
      lines.push('');
      lines.push(precSection);
    }
  }

  // Diagnostic context formatter — detect and format diagnostic JSON in review-context
  let diagnosticSection = '';
  if (reviewContext) {
    try {
      const parsed = JSON.parse(reviewContext);
      if (parsed.mismatch_diff && parsed.correction_proposals) {
        diagnosticSection = formatDiagnosticForPrompt(parsed);
        // Nullify reviewContext so it doesn't double-render
        reviewContext = null;
      }
    } catch (_) {
      // Not JSON — leave reviewContext as-is for normal string handling
    }
  }

  // Insert diagnostic section after requirements/precedents, before regular review context
  if (diagnosticSection) {
    lines.push('');
    lines.push(diagnosticSection);
  }

  // Review context (conditional — first occurrence, only if not nullified by diagnostic branch)
  if (reviewContext) {
    lines.push('');
    lines.push(`\u26a0 REVIEW CONTEXT: ${reviewContext}`);
  }

  if (round >= 2 && priorPositions) {
    // ── Round 2+ path ─────────────────────────────────────────────────────
    lines.push('');
    lines.push('The following positions are from other AI models in this quorum — not human experts.');
    lines.push('Evaluate them as peer AI opinions.');
    lines.push('');
    lines.push('Prior positions:');
    lines.push(priorPositions);

    // Review context reminder (Round 2+ only, when reviewContext present)
    if (reviewContext) {
      lines.push('');
      lines.push(`\u26a0 REVIEW CONTEXT REMINDER: ${reviewContext}`);
      lines.push('(If any prior position applied evaluation criteria inconsistent with the above — e.g.');
      lines.push('rejected a plan because code was absent, or approved test results without checking');
      lines.push('assertions — reconsider your position in light of the correct evaluation criteria.)');
    }

    lines.push('');
    if (artifactContent) {
      lines.push('Before revising your position, re-review the artifact content provided above and');
      lines.push('use your tools to check any other relevant files if needed.');
    } else {
      lines.push('Before revising your position, use your tools to re-check relevant files. At minimum');
      lines.push('re-read CLAUDE.md and .planning/STATE.md if they exist, and re-read the artifact file if');
      lines.push('one was provided.');
    }
    lines.push('');
    lines.push('Given the above, do you maintain your answer or revise it? State your updated position');
    lines.push('clearly (2\u20134 sentences).');
    lines.push('');
    lines.push('IMPORTANT: Keep your TOTAL response under 3000 characters.');

    // Improvements block (Round 2+, when requestImprovements)
    if (requestImprovements) {
      lines.push('If you APPROVE and have specific, actionable improvements, append:');
      lines.push('');
      lines.push('Improvements:');
      lines.push('- suggestion: [concise change \u2014 one sentence]');
      lines.push('  rationale: [why this strengthens the plan]');
      lines.push('');
      lines.push('Omit this section entirely if you have no improvements, or if you BLOCK.');
    }

    lines.push('');
    lines.push('If your re-check references specific files, line numbers, or code snippets, record');
    lines.push('them in a citations: field in your response (optional).');

  } else {
    // ── Round 1 path ──────────────────────────────────────────────────────
    lines.push('');
    if (hasFileAccess === false) {
      // HTTP slots: no tools available — answer from provided context only
      lines.push('You have NO file access or tools. Answer ONLY from the context provided in this');
      lines.push('message (artifact content, requirements, retrieved context sections above).');
      lines.push('Do NOT attempt tool calls, emit JSON blocks, or reference files you cannot see.');
      lines.push('Your answer must be grounded in what is provided above.');
    } else if (artifactContent) {
      lines.push('The artifact content is provided above. Use your available tools to read any other');
      lines.push('relevant files from the Repository directory if needed. Your answer must be grounded');
      lines.push('in the artifact content and what you actually find in the repo.');
    } else {
      lines.push('IMPORTANT: Before answering, use your available tools to read files from the');
      lines.push('Repository directory above. At minimum read: CLAUDE.md (if it exists),');
      lines.push('.planning/STATE.md (if it exists), and the artifact file at the path shown in the');
      lines.push('Artifact section above (if present). Then read any other files directly relevant to');
      lines.push('the question. Your answer must be grounded in what you actually find in the repo.');
    }
    lines.push('');
    lines.push('You are one AI model in a multi-model quorum. Your peer reviewers are other AI language');
    lines.push('models \u2014 not human experts. Give your honest answer with reasoning. Be concise (3\u20136');
    lines.push('sentences). Do not defer to peer models.');
    lines.push('');
    lines.push('IMPORTANT: Keep your TOTAL response under 3000 characters. Do not include lengthy code');
    lines.push('excerpts, full file contents, or verbose explanations. Summarize findings concisely.');

    // Improvements block (Round 1, when requestImprovements)
    if (requestImprovements) {
      lines.push('If you APPROVE and have specific, actionable improvements, append:');
      lines.push('');
      lines.push('Improvements:');
      lines.push('- suggestion: [concise change \u2014 one sentence]');
      lines.push('  rationale: [why this strengthens the plan]');
      lines.push('');
      lines.push('Omit this section entirely if you have no improvements, or if you BLOCK.');
    }

    lines.push('');
    lines.push('If your answer references specific files, line numbers, or code snippets from the');
    lines.push('repository, record them in a citations: field in your response (optional \u2014 only');
    lines.push('include if you actually cite code).');
  }

  return lines.join('\n');
}

/**
 * buildModeBPrompt — constructs the Mode B execution review prompt.
 *
 * Matches the EXACT template from agents/nf-quorum-slot-worker.md Step 2 Mode B.
 *
 * @param {object} opts
 * @param {number}  opts.round
 * @param {string}  opts.repoDir
 * @param {string}  opts.question
 * @param {string}  opts.traces             - execution trace output (required for Mode B)
 * @param {string} [opts.artifactPath]
 * @param {string} [opts.artifactContent]  - pre-read content (avoids model read failures)
 * @param {string} [opts.reviewContext]
 * @param {string} [opts.priorPositions]   - Round 2+
 * @param {Array}  [opts.requirements]     - array of requirement objects to inject
 * @param {boolean}[opts.reviewOnly]       - EXEC-01: inject read-only tool restriction
 * @returns {string}
 */
function buildModeBPrompt({ round, repoDir, question, traces, artifactPath, artifactContent, reviewContext, priorPositions, requirements, precedents, reviewOnly, hasFileAccess }) {
  const lines = [];

  // Header
  lines.push(`nForma Quorum — Execution Review (Round ${round})`);

  // EXEC-01: Review-only tool restriction for Mode B prompts
  if (reviewOnly) {
    lines.push('');
    lines.push('IMPORTANT: This is a READ-ONLY review task. You MUST NOT modify any files. Only use read operations (Read, Grep, Glob tools). Do NOT use Write, Edit, Bash(write), or any destructive commands.');
  }
  lines.push('');

  // Repository + question
  lines.push(`Repository: ${repoDir}`);
  lines.push('');
  lines.push(`QUESTION: ${question}`);

  // Artifact section (conditional)
  if (artifactPath) {
    lines.push('');
    lines.push('=== Artifact ===');
    lines.push(`Path: ${artifactPath}`);
    if (artifactContent) {
      lines.push('Content:');
      lines.push(artifactContent);
    } else {
      lines.push('(Read this file to obtain its full content before evaluating.)');
    }
    lines.push('================');
  }

  // Requirements section (conditional — injected right after question/artifact, before review context)
  if (requirements && requirements.length > 0) {
    const reqSection = formatRequirementsSection(requirements);
    if (reqSection) {
      lines.push('');
      lines.push(reqSection);
    }
  }

  // Precedents section (conditional — injected after requirements, before review context)
  if (precedents && precedents.length > 0) {
    const precSection = formatPrecedentsSection(precedents);
    if (precSection) {
      lines.push('');
      lines.push(precSection);
    }
  }

  // Diagnostic context formatter — detect and format diagnostic JSON in review-context
  let diagnosticSection = '';
  if (reviewContext) {
    try {
      const parsed = JSON.parse(reviewContext);
      if (parsed.mismatch_diff && parsed.correction_proposals) {
        diagnosticSection = formatDiagnosticForPrompt(parsed);
        // Nullify reviewContext so it doesn't double-render
        reviewContext = null;
      }
    } catch (_) {
      // Not JSON — leave reviewContext as-is for normal string handling
    }
  }

  // Insert diagnostic section after requirements/precedents, before regular review context
  if (diagnosticSection) {
    lines.push('');
    lines.push(diagnosticSection);
  }

  // Review context (conditional — first occurrence, only if not nullified by diagnostic branch)
  if (reviewContext) {
    lines.push('');
    lines.push(`\u26a0 REVIEW CONTEXT: ${reviewContext}`);
  }

  // Execution traces (always present in Mode B)
  lines.push('');
  lines.push('=== EXECUTION TRACES ===');
  lines.push(traces || '');

  // Prior positions (Round 2+)
  if (round >= 2 && priorPositions) {
    lines.push('');
    lines.push('Prior positions:');
    lines.push(priorPositions);

    // Review context reminder (Round 2+ only, when reviewContext present)
    if (reviewContext) {
      lines.push('');
      lines.push(`\u26a0 REVIEW CONTEXT REMINDER: ${reviewContext}`);
      lines.push('(If any prior position applied incorrect evaluation criteria, reconsider in light of the above.)');
    }
  }

  lines.push('');
  if (hasFileAccess === false) {
    lines.push('You have NO file access or tools. Evaluate ONLY from the execution traces and');
    lines.push('context provided above. Do NOT attempt tool calls or emit JSON tool-use blocks.');
  } else if (artifactContent) {
    lines.push('The artifact content is provided above. Use your tools to read any other relevant files');
    lines.push('from the Repository directory if needed.');
  } else {
    lines.push('Before giving your verdict, use your tools to read files from the Repository directory');
    lines.push('above. At minimum read: CLAUDE.md (if it exists), .planning/STATE.md (if it exists), and');
    lines.push('the artifact file at the path shown above (if present).');
  }
  lines.push('');
  lines.push('Note: prior positions are opinions from other AI models \u2014 not human specialists.');
  lines.push('');
  lines.push('Review the execution traces above. Give:');
  lines.push('');
  lines.push('verdict: APPROVE | REJECT | FLAG');
  lines.push('reasoning: [2\u20134 sentences grounded in the actual trace output \u2014 not assumptions]');
  lines.push('');
  lines.push('APPROVE if output clearly shows the question is satisfied.');
  lines.push('REJECT if output shows it is NOT satisfied.');
  lines.push('FLAG if output is ambiguous or requires human judgment.');
  lines.push('');
  lines.push('IMPORTANT: Keep your TOTAL response under 3000 characters. Do not reproduce full');
  lines.push('trace output — summarize key findings concisely.');
  lines.push('');
  lines.push('If your verdict references specific lines from the execution traces or files, record');
  lines.push('them in a citations: field (optional \u2014 only when you directly cite output lines or');
  lines.push('file content).');

  return lines.join('\n');
}

// ─── Output parsing functions ─────────────────────────────────────────────────

/**
 * parseVerdict — extracts verdict from raw CLI output.
 *
 * Mode A: first 500 chars of rawOutput (free-form position summary)
 * Mode B (default): extract APPROVE|REJECT|FLAG from "verdict:" line; default FLAG
 *
 * @param {string} rawOutput
 * @param {string} [mode]  'A' or 'B' (default B)
 * @returns {string}
 */
function parseVerdict(rawOutput, mode) {
  const hasTruncationMarker = (rawOutput || '').includes('[OUTPUT TRUNCATED');
  if (mode === 'A') {
    // Side-channel: in Mode A, verdict is free-form (first 500 chars), never FLAG_TRUNCATED
    parseVerdict.lastTruncationNote = false;
    return (rawOutput || '').slice(0, 500);
  }
  // Mode B: extract APPROVE|REJECT|FLAG
  const match = (rawOutput || '').match(/verdict:\s*(APPROVE|REJECT|FLAG)/i);
  // Side-channel: only flag truncation when verdict was DEFAULT (no verdict: line found)
  // AND truncation marker is present. A genuine "verdict: FLAG" survives truncation — it's real.
  parseVerdict.lastTruncationNote = hasTruncationMarker && !match;
  return match ? match[1].toUpperCase() : 'FLAG';
}

/**
 * parseReasoning — extracts reasoning from "reasoning: ..." line.
 *
 * @param {string} rawOutput
 * @returns {string|null}
 */
function parseReasoning(rawOutput) {
  if (!rawOutput) return null;
  const match = rawOutput.match(/^reasoning:\s*(.+)$/m);
  if (match) return match[1].trim();
  // Fallback: first 400 chars
  return null;
}

/**
 * parseCitations — extracts citations block from "citations: |" section.
 *
 * Handles both space-indented and tab-indented YAML block scalar content.
 *
 * @param {string} rawOutput
 * @returns {string|null}
 */
function parseCitations(rawOutput) {
  if (!rawOutput) return null;

  const lines = rawOutput.split('\n');
  let inCitations = false;
  const citationLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!inCitations) {
      // Detect "citations: |" or "citations:" line
      if (/^citations:\s*\|?\s*$/.test(trimmed)) {
        inCitations = true;
        continue;
      }
    } else {
      // Indented continuation (space or tab)
      if (line.startsWith(' ') || line.startsWith('\t')) {
        citationLines.push(trimmed);
      } else if (trimmed === '') {
        // blank line inside block — keep
        citationLines.push('');
      } else {
        // Non-indented non-empty line — end of block
        break;
      }
    }
  }

  if (citationLines.length === 0) return null;

  // Remove trailing empty lines
  while (citationLines.length > 0 && citationLines[citationLines.length - 1] === '') {
    citationLines.pop();
  }

  return citationLines.length > 0 ? citationLines.join('\n') : null;
}

/**
 * stripQuotes — strips surrounding single or double quotes from a string.
 * @param {string} s
 * @returns {string}
 */
function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * parseImprovements — scans rawOutput for "Improvements:" section, parses list entries.
 *
 * Migrated from bin/nf-quorum-slot-worker-improvements.test.cjs (canonical location).
 * Never throws — improvements are additive, not required.
 *
 * @param {string} rawOutput
 * @returns {Array<{suggestion: string, rationale: string}>}
 */
function parseImprovements(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') return [];

  const lines = rawOutput.split('\n');
  let inSection = false;
  const results = [];
  let currentEntry = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect section start
    if (!inSection && line.trimStart().startsWith('Improvements:')) {
      inSection = true;
      continue;
    }

    if (!inSection) continue;

    // Detect section end: non-indented non-empty line that isn't a list item
    const trimmed = line.trim();
    if (trimmed === '') continue; // blank lines: skip, stay in section

    // Check if this is a new top-level key (non-indented, non-list-item) — section ends
    if (!line.startsWith(' ') && !line.startsWith('\t') && !trimmed.startsWith('-') && trimmed !== '') {
      // End of improvements section
      if (currentEntry && currentEntry.suggestion && currentEntry.rationale) {
        results.push({ suggestion: currentEntry.suggestion, rationale: currentEntry.rationale });
      }
      currentEntry = null;
      inSection = false;
      continue;
    }

    // Match `- suggestion:` line — starts a new entry
    const suggestionMatch = trimmed.match(/^-\s+suggestion:\s*(.*)$/);
    if (suggestionMatch) {
      // Save previous entry if complete
      if (currentEntry && currentEntry.suggestion && currentEntry.rationale) {
        results.push({ suggestion: currentEntry.suggestion, rationale: currentEntry.rationale });
      }
      const val = stripQuotes(suggestionMatch[1].trim());
      currentEntry = { suggestion: val, rationale: null };
      continue;
    }

    // Match `rationale:` line (indented continuation)
    const rationaleMatch = trimmed.match(/^rationale:\s*(.*)$/);
    if (rationaleMatch && currentEntry) {
      const val = stripQuotes(rationaleMatch[1].trim());
      currentEntry.rationale = val;
      continue;
    }
  }

  // Flush last entry
  if (currentEntry && currentEntry.suggestion && currentEntry.rationale) {
    results.push({ suggestion: currentEntry.suggestion, rationale: currentEntry.rationale });
  }

  return results;
}

/**
 * emitResultBlock — produces the YAML-formatted result block matching the agent spec Step 4.
 *
 * Returns a string (does NOT write to stdout — main() handles that).
 *
 * @param {object} opts
 * @param {string}  opts.slot
 * @param {number}  opts.round
 * @param {string}  opts.verdict
 * @param {string}  opts.reasoning
 * @param {string} [opts.citations]
 * @param {Array}  [opts.improvements]
 * @param {string} [opts.rawOutput]
 * @param {boolean}[opts.isUnavail]
 * @param {string} [opts.error_type] — classified error type for UNAVAIL results (IDLE_TIMEOUT/HARD_TIMEOUT/TIMEOUT/AUTH/QUOTA/SPAWN_ERROR/CLI_SYNTAX/UNKNOWN)
 * @param {string} [opts.unavailMessage]
 * @param {string} [opts.dispatch_nonce] — 32-char hex nonce proving the dispatch script ran
 * @returns {string}
 */
function emitResultBlock({ slot, round, verdict, reasoning, citations, improvements, matched_requirement_ids, rawOutput, isUnavail, error_type, dispatch_nonce, unavailMessage, truncated, truncationLayer, originalSizeBytes, logical_slot, dispatch_slot, compact_actions, budget, retrieval_skipped }) {
  const lines = [];

  lines.push(`slot: ${slot}`);
  lines.push(`round: ${round}`);
  lines.push(`verdict: ${verdict}`);
  if (error_type) {
    lines.push(`error_type: ${error_type}`);
  }
  if (dispatch_nonce) {
    lines.push(`dispatch_nonce: ${dispatch_nonce}`);
  }

  if (reasoning) {
    lines.push(`reasoning: ${reasoning}`);
  } else {
    lines.push('reasoning:');
  }

  if (citations) {
    lines.push('citations: |');
    const citLines = citations.split('\n');
    for (const cl of citLines) {
      lines.push(`  ${cl}`);
    }
  }

  if (improvements && improvements.length > 0) {
    lines.push('improvements:');
    for (const imp of improvements) {
      lines.push(`  - suggestion: "${imp.suggestion}"`);
      lines.push(`    rationale: "${imp.rationale}"`);
    }
  }

  if (matched_requirement_ids && matched_requirement_ids.length > 0) {
    lines.push(`matched_requirement_ids: [${matched_requirement_ids.join(', ')}]`);
  }

  if (isUnavail && unavailMessage) {
    lines.push('unavail_message: |');
    const msgLines = unavailMessage.slice(0, 500).split('\n');
    for (const ml of msgLines) {
      lines.push(`  ${ml}`);
    }
  }

  if (logical_slot) {
    lines.push(`logical_slot: ${logical_slot}`);
  }
  if (dispatch_slot) {
    lines.push(`dispatch_slot: ${dispatch_slot}`);
  }

  if (compact_actions) {
    if (compact_actions.length === 0) {
      lines.push('compact_actions: []');
    } else {
      lines.push('compact_actions:');
      for (const entry of compact_actions) {
        lines.push(`  - ${entry}`);
      }
    }
  }

  if (budget) {
    lines.push('budget:');
    lines.push(`  prompt_tokens: ${budget.promptTokens}`);
    lines.push(`  overhead_tokens: ${budget.overheadTokens}`);
    lines.push(`  total_estimate: ${budget.totalEstimate}`);
    if (budget.maxContextTokens != null) {
      lines.push(`  max_context_tokens: ${budget.maxContextTokens}`);
    }
  }

  if (retrieval_skipped) {
    lines.push('retrieval_skipped: true');
  }

  // L6: raw field truncation with marker (TRUNC-05)
  lines.push('raw: |');
  const rawStr = rawOutput || '';
  const l6Truncated = rawStr.length > 5000;
  let rawTruncated = rawStr.slice(0, 5000);
  if (l6Truncated) {
    rawTruncated += '\n[RAW TRUNCATED at 5KB]';
  }
  const rawLines = rawTruncated.split('\n');
  for (const rl of rawLines) {
    lines.push(`  ${rl}`);
  }

  // Verdict integrity tagging (TRUNC-04, TRUNC-05)
  const effectiveTruncated = truncated || l6Truncated;
  const effectiveLayer = truncationLayer || (l6Truncated ? 'L6' : null);
  if (effectiveTruncated) {
    lines.push('verdict_integrity: truncated');
    lines.push('truncation:');
    lines.push('  truncated: true');
    lines.push(`  layer: ${effectiveLayer}`);
    if (originalSizeBytes) {
      lines.push(`  original_size_bytes: ${originalSizeBytes}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ─── L3/L6 supplementary telemetry (TRUNC-04) ────────────────────────────────

/**
 * appendTelemetryUpdate — writes a supplementary telemetry record for L3/L6 truncation.
 * The primary record (from call-quorum-slot.cjs) only captures L1.
 * This closes the TLA+ TelemetryRecordsTruncation gap for L3/L6.
 * @param {Object} opts
 */
function appendTelemetryUpdate({ slot, round, l3Truncated, l6Truncated, effectiveLayer, originalSizeBytes, verdictIntegrity, cwd }) {
  try {
    const sessionId = process.env.CLAUDE_SESSION_ID || 'session-' + Date.now();
    const record = JSON.stringify({
      ts: new Date().toISOString(),
      session_id: sessionId,
      slot,
      round: parseInt(round, 10) || 0,
      truncation_update: true,
      l3_truncated: l3Truncated || false,
      l6_truncated: l6Truncated || false,
      effective_layer: effectiveLayer || null,
      original_size_bytes: originalSizeBytes || null,
      verdict_integrity: verdictIntegrity || null,
    });
    const pp = require('./planning-paths.cjs');
    const logPath = pp.resolve(cwd || process.cwd(), 'quorum-rounds', { sessionId });
    require('fs').appendFileSync(logPath, record + '\n', 'utf8');
  } catch (_) {
    // Fail-open: telemetry errors never block dispatch
  }
}

// ─── Pre-dispatch context enrichment (ORCH-01) ───────────────────────────────
//
// ARCHITECTURAL RATIONALE (ORCH-01):
// Pre-dispatch enrichment with up to 2 iterative retrieval rounds approximates
// on-demand retrieval without requiring slot workers to have direct tool access.
// This is architecturally necessary because slot workers dispatch to external
// CLIs (codex, gemini, opencode, copilot) that lack Read/Grep/Glob tools --
// they cannot perform retrieval themselves. By enriching the prompt BEFORE
// dispatch, we satisfy ORCH-01's intent ("iterative retrieval") within Claude
// Code's subagent constraints.
//

/**
 * enrichPromptWithRetrieval — enriches a quorum prompt with domain-specific
 * retrieved context from context-retriever.cjs and context-stack.cjs.
 *
 * Fail-open: on ANY error (missing modules, I/O failures, etc.), returns the
 * original prompt unchanged. Retrieval errors never prevent quorum dispatch.
 *
 * @param {string} prompt      — the built prompt to enrich
 * @param {string} question    — the question being asked
 * @param {string|null} artifactPath — optional artifact path
 * @param {string} cwd         — working directory
 * @returns {string} — enriched prompt, or original prompt on error
 */
function enrichPromptWithRetrieval(prompt, question, artifactPath, cwd) {
  try {
    // Dual-path require for context-retriever.cjs
    const retriever = (() => {
      try { return require(path.join(__dirname, 'context-retriever.cjs')); }
      catch { return null; }
    })();
    if (!retriever) return prompt;

    // Dual-path require for context-stack.cjs (optional)
    const contextStack = (() => {
      try { return require(path.join(__dirname, 'context-stack.cjs')); }
      catch { return null; }
    })();

    const charBudget = retriever.TOKEN_BUDGET_CHARS || 32000;
    let additionalContext = '';
    let existingContext = '';

    // Iterative retrieval: up to MAX_ROUNDS (2) rounds
    const maxRounds = retriever.MAX_ROUNDS || 2;
    for (let round = 0; round < maxRounds; round++) {
      const needs = retriever.analyzeContextNeeds(question, artifactPath, existingContext);
      if (!needs || needs.length === 0) break;

      const remainingBudget = charBudget - additionalContext.length;
      if (remainingBudget <= 0) break;

      const fetched = retriever.fetchContext(cwd, needs, remainingBudget);
      if (!fetched) break;

      additionalContext += fetched;
      existingContext = additionalContext;
    }

    // Append context stack entries if available and within budget
    if (contextStack) {
      try {
        const stackInjection = contextStack.formatInjection(cwd, 'current');
        if (stackInjection) {
          const remaining = charBudget - additionalContext.length;
          if (stackInjection.length <= remaining) {
            additionalContext += '\n' + stackInjection;
          }
        }
      } catch { /* fail-open */ }
    }

    // Only append if we actually retrieved something
    if (additionalContext.trim()) {
      return prompt + '\n\n=== RETRIEVED CONTEXT ===\n' + additionalContext + '\n=========================\n';
    }

    return prompt;
  } catch {
    // Fail-open: retrieval errors never prevent quorum dispatch
    return prompt;
  }
}

function estimatePromptTokens(prompt, charsPerToken = 4) {
  return Math.ceil(String(prompt || '').length / charsPerToken);
}

function computeProviderBudget(provider, prompt, charsPerToken = 4) {
  const isCcr = provider && provider.display_type === 'claude-code-router';
  const promptTokens = estimatePromptTokens(prompt, charsPerToken);
  const overheadTokens = isCcr ? ((provider.ccr_overhead_tokens ?? 95000) + (provider.ccr_response_budget_tokens ?? 64000)) : 0;
  const totalEstimate = promptTokens + overheadTokens;
  return {
    promptTokens,
    overheadTokens,
    totalEstimate,
    maxContextTokens: provider?.max_context_tokens ?? null,
    fits: provider?.max_context_tokens ? totalEstimate <= provider.max_context_tokens : true,
  };
}

function stripRetrievedContext(prompt) {
  const marker = '\n\n=== RETRIEVED CONTEXT ===\n';
  const start = prompt.indexOf(marker);
  if (start === -1) return { prompt, changed: false };
  const endMarker = '\n=========================\n';
  const end = prompt.indexOf(endMarker, start);
  if (end === -1) return { prompt, changed: false };
  return {
    prompt: prompt.slice(0, start) + prompt.slice(end + endMarker.length),
    changed: true,
  };
}

function stripBlockByHeading(prompt, heading) {
  const idx = prompt.indexOf(heading);
  if (idx === -1) return { prompt, changed: false };
  let end = prompt.indexOf('\n\n', idx + heading.length);
  if (end === -1) end = prompt.length;
  else {
    while (end < prompt.length && prompt.slice(end, end + 2) === '\n\n') end += 2;
  }
  return {
    prompt: prompt.slice(0, idx) + prompt.slice(end),
    changed: true,
  };
}

function stripPriorPositions(prompt) {
  const heading = 'Prior positions:\n';
  const idx = prompt.indexOf(heading);
  if (idx === -1) return { prompt, changed: false };
  let end = prompt.indexOf('\n\n', idx + heading.length);
  if (end === -1) end = prompt.length;
  else {
    while (end < prompt.length && prompt.slice(end, end + 2) === '\n\n') end += 2;
  }
  return {
    prompt: prompt.slice(0, idx) + prompt.slice(end),
    changed: true,
  };
}

function compactPromptToFitBudget(prompt, provider, options = {}) {
  const charsPerToken = options.charsPerToken ?? 4;
  const actions = [];
  let current = prompt;
  let budget = computeProviderBudget(provider, current, charsPerToken);
  if (budget.fits) return { prompt: current, budget, actions, fits: true };

  const steps = [
    { name: 'stripped_retrieved_context', fn: stripRetrievedContext },
    { name: 'stripped_precedents', fn: (p) => stripBlockByHeading(p, '=== RELEVANT PRECEDENTS ===\n') },
    { name: 'stripped_requirements', fn: (p) => stripBlockByHeading(p, '=== APPLICABLE REQUIREMENTS ===\n') },
    { name: 'stripped_prior_positions', fn: stripPriorPositions },
  ];

  for (const step of steps) {
    const result = step.fn(current);
    if (!result.changed) continue;
    current = result.prompt;
    actions.push(step.name);
    budget = computeProviderBudget(provider, current, charsPerToken);
    if (budget.fits) break;
  }

  return { prompt: current, budget, actions, fits: budget.fits };
}

function shouldSkipRetrieval(provider, budget, threshold = 0.8) {
  if (!provider || provider.display_type !== 'claude-code-router') return false;
  if (!provider.max_context_tokens) return false;
  return budget.totalEstimate >= provider.max_context_tokens * threshold;
}

// ─── Main (CLI entry point) ───────────────────────────────────────────────────

async function main() {
  const slot               = getArg('--slot');
  const mode               = getArg('--mode') || 'A';
  const roundArg           = getArg('--round');
  const questionArg        = getArg('--question') || '';
  const questionFile       = getArg('--question-file') || null;
  const nonceFile          = getArg('--nonce-file') || null;
  const artifactPath       = getArg('--artifact-path') || null;
  const reviewContext      = getArg('--review-context') || null;
  const priorPositionsFile = getArg('--prior-positions-file') || null;
  const tracesFile         = getArg('--traces-file') || null;
  const requestImprovements = hasFlag('--request-improvements');
  const timeoutArg         = getArg('--timeout');
  const cwd                = getArg('--cwd') || process.cwd();
  const filesArg              = getArg('--files') || null;
  const constraintsArg        = getArg('--constraints') || null;

  if (!slot) {
    process.stderr.write('[quorum-slot-dispatch] --slot is required\n');
    process.exit(1);
  }
  if (!roundArg) {
    process.stderr.write('[quorum-slot-dispatch] --round is required\n');
    process.exit(1);
  }

  const round   = parseInt(roundArg, 10);

  // Resolve timeout: explicit --timeout > providers.json quorum_timeout_ms > 180s default
  const DEFAULT_QUORUM_TIMEOUT_MS = 300000;
  let timeout;
  if (timeoutArg) {
    timeout = parseInt(timeoutArg, 10);
  } else {
    try {
      const providers = loadDispatchProviders();
      const provider = providers.find(p => p.name === slot);
      timeout = (provider && provider.quorum_timeout_ms) || DEFAULT_QUORUM_TIMEOUT_MS;
    } catch {
      timeout = DEFAULT_QUORUM_TIMEOUT_MS;
    }
  }

  // Resolve question: --question-file takes precedence over --question
  let question = questionArg;
  if (questionFile) {
    try {
      question = fs.readFileSync(questionFile, 'utf8').trim();
    } catch (e) {
      process.stderr.write(`[quorum-slot-dispatch] Could not read question-file: ${e.message}\n`);
      // Fall back to --question if file read fails
    }
  }

  // Generate dispatch nonce (proves this script ran)
  const dispatchNonce = crypto.randomBytes(16).toString('hex');
  if (nonceFile) {
    try {
      fs.writeFileSync(nonceFile, dispatchNonce, 'utf8');
    } catch (e) {
      process.stderr.write(`[quorum-slot-dispatch] Could not write nonce-file: ${e.message}\n`);
    }
  }

  // Early output-file write: proves script was actually invoked (not Haiku fabrication).
  // Written immediately with nonce + PENDING marker. Overwritten with final result at end.
  // If file contains PENDING after Task returns → script ran but didn't finish (timeout/crash).
  // If file is missing → script was never invoked (Haiku didn't run Bash).
  const outputFile = getArg('--output-file');
  if (outputFile) {
    try {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, `slot: ${slot}\nround: ${round}\nverdict: PENDING\ndispatch_nonce: ${dispatchNonce}\nreasoning: dispatch started, awaiting CLI response\n`, 'utf8');
    } catch (e) {
      process.stderr.write(`[quorum-slot-dispatch] early output-file write failed: ${e.message}\n`);
    }
  }

  // Read optional temp files
  let priorPositions = null;
  if (priorPositionsFile) {
    try {
      priorPositions = fs.readFileSync(priorPositionsFile, 'utf8');
    } catch (e) {
      process.stderr.write(`[quorum-slot-dispatch] Could not read prior-positions-file: ${e.message}\n`);
    }
  }

  let traces = null;
  if (tracesFile) {
    try {
      traces = fs.readFileSync(tracesFile, 'utf8');
    } catch (e) {
      process.stderr.write(`[quorum-slot-dispatch] Could not read traces-file: ${e.message}\n`);
    }
  }

  // Build prompt
  const repoDir = cwd;

  // Pre-read artifact file content to inline in prompt (prevents read failures in models)
  const ARTIFACT_MAX_BYTES = 50 * 1024; // 50KB cap
  let artifactContent = null;
  if (artifactPath) {
    try {
      const resolvedPath = path.isAbsolute(artifactPath) ? artifactPath : path.join(cwd, artifactPath);
      const stat = fs.statSync(resolvedPath);
      if (stat.size <= ARTIFACT_MAX_BYTES) {
        artifactContent = fs.readFileSync(resolvedPath, 'utf8');
      } else {
        process.stderr.write(`[quorum-slot-dispatch] artifact too large (${stat.size} bytes > ${ARTIFACT_MAX_BYTES}), models must read it themselves\n`);
      }
    } catch (e) {
      process.stderr.write(`[quorum-slot-dispatch] could not pre-read artifact: ${e.message}\n`);
    }
  }

  // Load and match requirements (fail-open: if loading fails, requirements will be empty)
  const allRequirements = loadRequirements(repoDir);
  const matchedRequirements = matchRequirementsByKeywords(allRequirements, question, artifactPath);

  // Load and match precedents (fail-open: if loading fails, precedents will be empty)
  const allPrecedents = loadPrecedents(repoDir);
  const matchedPrecedents = matchPrecedentsByKeywords(allPrecedents, question);

  const providers = loadDispatchProviders();

  // EXEC-01: Determine review mode — Mode B or explicit --review-only flag
  const isReviewMode = mode === 'B' || reviewOnly;
  const originalProvider = providers.find(p => p.name === slot) || null;
  let dispatchSlot = slot;
  let dispatchProvider = originalProvider;

  const buildPromptForProvider = (provider) => {
    const hasFileAccess = provider ? provider.has_file_access !== false : true;
    if (mode === 'C') {
      const parsedFiles = filesArg ? filesArg.split(',').map(f => f.trim()).filter(Boolean) : [];
      const parsedConstraints = constraintsArg ? constraintsArg.split(',').map(c => c.trim()).filter(Boolean) : [];
      return buildModeCPrompt({
        repoDir,
        task: question,
        files: parsedFiles,
        constraints: parsedConstraints,
        context: reviewContext,
      });
    }
    if (mode === 'B') {
      return buildModeBPrompt({
        round,
        repoDir,
        question,
        artifactPath,
        artifactContent,
        reviewContext,
        priorPositions,
        traces: traces || '',
        requirements: matchedRequirements,
        precedents: matchedPrecedents,
        reviewOnly: isReviewMode,
        hasFileAccess,
      });
    }
    return buildModeAPrompt({
      round,
      repoDir,
      question,
      artifactPath,
      artifactContent,
      reviewContext,
      priorPositions,
      requestImprovements,
      requirements: matchedRequirements,
      precedents: matchedPrecedents,
      hasFileAccess,
    });
  };

  const basePrompt = buildPromptForProvider(dispatchProvider);

  // ── Context retrieval enrichment (ORCH-01) ──────────────────────────────────
  // Check config kill switch via two-layer config-loader merge (DEFAULT_CONFIG -> global -> project).
  // Fail-open: if config load fails, retrieval is ON (default enabled).
  const nfConfig = loadNfConfig(cwd);
  const retrievalEnabled = nfConfig.context_retrieval_enabled !== false;

  const CHARS_PER_TOKEN = 4;
  let prompt = basePrompt;
  let retrievalSkipped = false;
  const applyRetrieval = () => {
    if (!retrievalEnabled || !dispatchProvider) return;
    const budget = computeProviderBudget(dispatchProvider, prompt, CHARS_PER_TOKEN);
    if (!shouldSkipRetrieval(dispatchProvider, budget, 0.8)) {
      prompt = enrichPromptWithRetrieval(prompt, question, artifactPath, cwd);
      retrievalSkipped = false;
    } else {
      retrievalSkipped = true;
    }
  };
  applyRetrieval();

  // ── Pre-flight context window check (CTXWIN-01) ─────────────────────────────
  // For CCR slots, compact the prompt in multiple stages using provider-specific
  // overhead metadata. If the compacted prompt still does not fit, optionally
  // reroute to the paired direct API slot and rebuild the prompt for no-tool mode.
  let compactActions = [];
  let budgetResult;
  const enforceBudget = () => {
    if (!dispatchProvider || !dispatchProvider.max_context_tokens) {
      return computeProviderBudget(dispatchProvider, prompt, CHARS_PER_TOKEN);
    }
    budgetResult = computeProviderBudget(dispatchProvider, prompt, CHARS_PER_TOKEN);
    if (budgetResult.fits) return budgetResult;
    if (dispatchProvider.display_type === 'claude-code-router') {
      compactActions = [];
      const compacted = compactPromptToFitBudget(prompt, dispatchProvider, { charsPerToken: CHARS_PER_TOKEN });
      prompt = compacted.prompt;
      compactActions = compacted.actions;
      budgetResult = compacted.budget;
      for (const action of compactActions) {
        process.stderr.write(`[quorum-slot-dispatch] CTXWIN-01: ${action} for ${dispatchSlot} (${budgetResult.totalEstimate} > ${dispatchProvider.max_context_tokens} tokens)\n`);
      }
      if (!budgetResult.fits && dispatchProvider.fallback_slot) {
        const fallbackProvider = providers.find(p => p.name === dispatchProvider.fallback_slot);
        if (fallbackProvider) {
          process.stderr.write(`[quorum-slot-dispatch] CTXWIN-01: rerouting ${dispatchSlot} to ${fallbackProvider.name} due to CCR budget overflow\n`);
          dispatchSlot = fallbackProvider.name;
          dispatchProvider = fallbackProvider;
          prompt = buildPromptForProvider(dispatchProvider);
          applyRetrieval();
          return enforceBudget();
        }
      }
    }
    return budgetResult;
  };
  try {
    budgetResult = enforceBudget();
    if (!budgetResult.fits) {
      const result = emitResultBlock({
        slot,
        round,
        verdict: 'UNAVAIL',
        reasoning: `CONTEXT_OVERFLOW: estimated ${budgetResult.totalEstimate} tokens exceeds ${dispatchSlot} limit of ${dispatchProvider.max_context_tokens} (prompt: ${budgetResult.promptTokens}, overhead: ${budgetResult.overheadTokens})`,
        rawOutput: `Prompt too large for logical slot ${slot} via ${dispatchSlot} (${dispatchProvider?.model || 'unknown'}): ~${budgetResult.totalEstimate} tokens > ${dispatchProvider.max_context_tokens} max`,
        isUnavail: true,
        error_type: 'CONTEXT_OVERFLOW',
        dispatch_nonce: dispatchNonce,
        unavailMessage: `Prompt size: ${prompt.length} chars (~${budgetResult.promptTokens} tokens). Model limit: ${dispatchProvider.max_context_tokens}. Overhead: ${budgetResult.overheadTokens}. Dispatch slot: ${dispatchSlot}.`,
        compact_actions: compactActions,
        logical_slot: slot,
        dispatch_slot: dispatchSlot,
        budget: budgetResult,
        retrieval_skipped: retrievalSkipped,
      });
      if (outputFile) {
        try {
          fs.mkdirSync(path.dirname(outputFile), { recursive: true });
          fs.writeFileSync(outputFile, result.endsWith('\n') ? result : result + '\n', 'utf8');
        } catch (e) {
          process.stderr.write(`[quorum-slot-dispatch] output-file write failed: ${e.message}\n`);
        }
      }
      process.stdout.write(result);
      if (!result.endsWith('\n')) process.stdout.write('\n');
      process.exit(0);
    }
  } catch (_) {
    /* fail-open: context check errors never block dispatch */
  }

  const finalBudget = budgetResult ?? (dispatchProvider ? computeProviderBudget(dispatchProvider, prompt, CHARS_PER_TOKEN) : null);
  const compactActionsFinal = compactActions;
  const retrievalSkippedFinal = retrievalSkipped;
  const fallbacked = dispatchSlot !== slot;

  // Locate call-quorum-slot.cjs relative to this script
  const cqsPath = path.join(__dirname, 'call-quorum-slot.cjs');

  // EXEC-01: Detect ccr-based slot to pass --allowed-tools for review-only restriction
  const isCcrSlot = (() => {
    try {
      const providers = loadDispatchProviders();
      const provider = providers.find(p => p.name === dispatchSlot);
      return provider && (provider.display_type === 'claude-code-router' || (provider.cli && provider.cli.includes('ccr')));
    } catch { return false; }
  })();

  // Build spawn args via the shared dispatch-argv contract (#202).
  // Only flags call-quorum-slot.cjs actually parses are emitted. --round is now
  // passed so the child's roundNum is populated (telemetry → #175 calibration);
  // the previously-pushed --dispatch-slot/--compact-actions/--retrieval-skipped/
  // --quorum-invocation-id/--persist-sessions were never parsed by the child and
  // have been removed. Their parent-side data still flows via emitResultBlock.
  const spawnArgs = buildDispatchArgv(cqsPath, {
    slot: dispatchSlot,
    timeout: String(timeout),
    round,                                                  // #202: child telemetry round
    cwd,
    // add --allowed-tools for ccr slots in review mode
    allowedTools: (isReviewMode && isCcrSlot) ? 'Read,Grep,Glob' : null,
    // Pass --output-file and --dispatch-nonce so the child can write the result file
    // even if the outer script's argv was modified by Haiku (defense-in-depth)
    outputFile: outputFile || null,
    dispatchNonce,
  });

  // Per-provider concurrency (SOLVE-10) is enforced inside the spawned
  // call-quorum-slot.cjs child via provider-concurrency.cjs (acquireSlot in
  // runHttp), held for the full request lifetime. No second semaphore here — see
  // the SOLVE-10 consolidation note near the top of this file (#201).

  // Spawn call-quorum-slot.cjs as child process with stdin pipe
  const rawOutput = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, spawnArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ exitCode: 1, output: `[spawn error: ${err.message}]` });
      return;
    }

    // Write prompt to child stdin and close
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    // Cap subprocess output to 50KB — prevents 100K+ responses from overflowing
    // Claude Code's MCP result size limit when emitted via emitResultBlock.
    // The emitResultBlock rawOutput field is already truncated to 5K (line ~780),
    // but capping here avoids buffering megabytes of unused data in memory.
    const MAX_BUF = 50 * 1024;
    let truncated = false;

    child.stdout.on('data', d => {
      if (!truncated) {
        const chunk = d.toString();
        if (stdout.length + chunk.length > MAX_BUF) {
          stdout += chunk.slice(0, MAX_BUF - stdout.length);
          truncated = true;
        } else {
          stdout += chunk;
        }
      }
    });
    child.stderr.on('data', d => {
      stderr += d.toString().slice(0, 4096);
    });

    child.on('close', (code) => {
      const suffix = truncated ? '\n\n[OUTPUT TRUNCATED at 50KB by quorum-slot-dispatch]' : '';
      resolve({ exitCode: code, output: (stdout || stderr || '(no output)') + suffix, truncated, originalSize: stdout.length });
    });

    child.on('error', (err) => {
      resolve({ exitCode: 1, output: `[spawn error: ${err.message}]` });
    });
  });

  // Per-provider slot is released by the child (runHttp) when the request completes.

  const { exitCode, output, truncated: l3Truncated, originalSize: l3OriginalSize } = rawOutput;
  const l1Truncated = output.includes('[OUTPUT TRUNCATED at 10MB');
  // Non-zero exit with valid output = available_with_warning only when the output
  // looks like an actual model answer. API/provider failures can also be lengthy,
  // especially for CCR, and must still classify as UNAVAIL.
  const looksLikeProviderFailure =
    /\[exit code \d+\]/i.test(output) ||
    /^API Error:/i.test(output) ||
    /provider_response_error/i.test(output) ||
    /requested token count exceeds/i.test(output) ||
    /invalid_request_error/i.test(output);
  const hasValidOutput = (output.length > 100 || /verdict:\s*(APPROVE|REJECT|FLAG)/i.test(output)) && !looksLikeProviderFailure;
  const isUnavail = (exitCode !== 0 && !hasValidOutput) || output.includes('TIMEOUT') || looksLikeProviderFailure;

  let result;
  if (isUnavail) {
    result = emitResultBlock({
      slot,
      round,
      verdict: 'UNAVAIL',
      reasoning: `UNAVAIL (${classifyDispatchError(output)}): ${output.slice(0, 200).replace(/\n/g, ' ')}`,
      rawOutput: output,
      isUnavail: true,
      error_type: classifyDispatchError(output),
      dispatch_nonce: dispatchNonce,
      unavailMessage: output.slice(0, 500)
    });
  } else {
    let verdict;
    let codingResult = null;

    if (mode === 'C') {
      // Mode C: parse coding result and derive verdict from status
      const { parseCodingResult } = require(path.join(__dirname, 'coding-task-router.cjs'));
      codingResult = parseCodingResult(output);
      const statusVerdictMap = { SUCCESS: 'APPROVE', PARTIAL: 'FLAG', FAILED: 'REJECT', UNKNOWN: 'FLAG' };
      verdict = statusVerdictMap[codingResult.status] || 'FLAG';

      // Record routing reward for Q-learning loop (fail-open)
      try {
        const rewardMap = { SUCCESS: 1.0, PARTIAL: 0.5, FAILED: 0.0, UNKNOWN: 0.25 };
        const rewardValue = rewardMap[codingResult.status] || 0.25;
        if (recordRoutingReward && dispatchSlot) {
          // Derive taskType from question keywords; default to 'implement'
          const qLower = (question || '').toLowerCase();
          const taskType = qLower.includes('fix') ? 'fix'
            : qLower.includes('refactor') ? 'refactor'
            : qLower.includes('test') ? 'test'
            : 'implement';
          recordRoutingReward({
            taskType,
            slot: dispatchSlot,
            reward: rewardValue,
            latencyMs: 0,
          });
        }
      } catch (_) {
        // Fail-open: reward recording must never block dispatch
      }
    } else {
      verdict = parseVerdict(output, mode);
    }

    // TRUNC-03: distinguish truncation-derived FLAG from genuine FLAG
    if (verdict === 'FLAG' && parseVerdict.lastTruncationNote) {
      verdict = 'FLAG_TRUNCATED';
    }
    const reasoning    = parseReasoning(output) || output.slice(0, 400);
    const citations    = parseCitations(output);
    const improvements = requestImprovements ? parseImprovements(output) : [];
    const matchedReqIds = matchedRequirements.map(r => r.id).filter(Boolean);

    result = emitResultBlock({
      slot,
      round,
      verdict,
      reasoning,
      citations,
      improvements: improvements.length > 0 ? improvements : undefined,
      matched_requirement_ids: matchedReqIds,
      dispatch_nonce: dispatchNonce,
      rawOutput: output,
      truncated: l3Truncated || l1Truncated,
      truncationLayer: l1Truncated ? 'L1' : (l3Truncated ? 'L3' : null),
      originalSizeBytes: l3OriginalSize || null,
      compact_actions: compactActionsFinal,
      logical_slot: slot,
      dispatch_slot: dispatchSlot,
      budget: finalBudget,
      retrieval_skipped: retrievalSkippedFinal,
    });

    // L3/L6 supplementary telemetry (TRUNC-04 gap closure)
    if (l3Truncated || (output || '').length > 5000) {
      const l6Truncated_flag = (output || '').length > 5000;
      appendTelemetryUpdate({
        slot,
        round,
        l3Truncated: l3Truncated || false,
        l6Truncated: l6Truncated_flag,
        effectiveLayer: l1Truncated ? 'L1' : (l3Truncated ? 'L3' : (l6Truncated_flag ? 'L6' : null)),
        originalSizeBytes: l3OriginalSize || null,
        verdictIntegrity: (l3Truncated || l1Truncated || l6Truncated_flag) ? 'truncated' : null,
        cwd,
      });
    }

    // Auto-persist debate trace file (fail-open)
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      const slug = question.replace(/[^a-z0-9]+/gi, '-').slice(0, 50).toLowerCase().replace(/-+$/, '');
      const traceFilename = `${dateStr}-${slot}-${slug}.md`;
      const debatePath = planningPaths.resolve(cwd, 'quorum-debate', { filename: traceFilename });
      const traceContent = [
        '---',
        `date: ${dateStr}`,
        `question: "${question.replace(/"/g, '\\"')}"`,
        `slot: ${slot}`,
        `round: ${round}`,
        `mode: "${mode || 'unknown'}"`,
        `verdict: ${verdict}`,
        `matched_requirement_ids: [${matchedReqIds.join(', ')}]`,
        `artifact_path: "${artifactPath || ''}"`,
        '---',
        '',
        `# Debate Trace: ${slot} on round ${round}`,
        '',
        '## Reasoning',
        reasoning || '(none)',
        '',
        '## Citations',
        citations || '(none)',
        ''
      ].join('\n');
      fs.mkdirSync(path.dirname(debatePath), { recursive: true });
      fs.writeFileSync(debatePath, traceContent, 'utf8');
    } catch (e) {
      process.stderr.write(`[quorum-slot-dispatch] debate trace write failed: ${e.message}\n`);
    }
  }

  // --output-file: overwrite early PENDING marker with final result (Option C — file is source of truth)
  if (outputFile) {
    try {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, result.endsWith('\n') ? result : result + '\n', 'utf8');
    } catch (e) {
      process.stderr.write(`[quorum-slot-dispatch] output-file write failed: ${e.message}\n`);
    }
  }

  process.stdout.write(result);
  if (!result.endsWith('\n')) process.stdout.write('\n');
  process.exit(0);
}

// ─── Module exports ───────────────────────────────────────────────────────────
module.exports = {
    buildModeAPrompt,
    buildModeBPrompt,
    buildModeCPrompt,
    formatDiagnosticForPrompt,
    parseVerdict,
    parseReasoning,
    parseCitations,
    parseImprovements,
    emitResultBlock,
    stripQuotes,
    loadRequirements,
    matchRequirementsByKeywords,
    formatRequirementsSection,
    loadPrecedents,
    matchPrecedentsByKeywords,
    formatPrecedentsSection,
    enrichPromptWithRetrieval,
    estimatePromptTokens,
    computeProviderBudget,
    compactPromptToFitBudget,
    stripRetrievedContext,
    stripPriorPositions,
    shouldSkipRetrieval,
    classifyDispatchError,
    appendTelemetryUpdate,
  };

// ─── Entry point guard ────────────────────────────────────────────────────────
if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`[quorum-slot-dispatch] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}

// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
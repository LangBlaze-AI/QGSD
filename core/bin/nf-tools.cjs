#!/usr/bin/env node

/**
 * NF Tools — CLI utility for NF workflow operations
 *
 * Replaces repetitive inline bash patterns across ~50 NF command/workflow/agent files.
 * Centralizes: config parsing, model resolution, phase lookup, git commits, summary verification.
 *
 * Usage: node nf-tools.cjs <command> [args] [--raw]
 *
 * Atomic Commands:
 *   state load                         Load project config + state
 *   state update <field> <value>       Update a STATE.md field
 *   state get [section]                Get STATE.md content or section
 *   state patch --field val ...        Batch update STATE.md fields
 *   resolve-model <agent-type>         Get model for agent based on profile
 *   find-phase <phase>                 Find phase directory by number
 *   commit <message> [--files f1 f2]   Commit planning docs
 *   verify-summary <path>              Verify a SUMMARY.md file
 *   generate-slug <text>               Convert text to URL-safe slug
 *   current-timestamp [format]         Get timestamp (full|date|filename)
 *   list-todos [area]                  Count and enumerate pending todos
 *   verify-path-exists <path>          Check file/directory existence
 *   config-ensure-section              Initialize .planning/config.json
 *   history-digest                     Aggregate all SUMMARY.md data
 *   summary-extract <path> [--fields]  Extract structured data from SUMMARY.md
 *   state-snapshot                     Structured parse of STATE.md
 *   phase-plan-index <phase>           Index plans with waves and status
 *   websearch <query>                  Search web via Brave API (if configured)
 *     [--limit N] [--freshness day|week|month]
 *
 * Phase Operations:
 *   phase next-decimal <phase>         Calculate next decimal phase number
 *   phase add <description>            Append new phase to roadmap + create dir
 *   phase insert <after> <description> Insert decimal phase after existing
 *   phase remove <phase> [--force]     Remove phase, renumber all subsequent
 *   phase complete <phase>             Mark phase done, update state + roadmap
 *
 * Roadmap Operations:
 *   roadmap get-phase <phase>          Extract phase section from ROADMAP.md
 *   roadmap analyze                    Full roadmap parse with disk status
 *   roadmap update-plan-progress <N>   Update progress table row from disk (PLAN vs SUMMARY counts)
 *
 * Requirements Operations:
 *   requirements mark-complete <ids>   Mark requirement IDs as complete in REQUIREMENTS.md
 *                                      Accepts: REQ-01,REQ-02 or REQ-01 REQ-02 or [REQ-01, REQ-02]
 *
 * Milestone Operations:
 *   milestone complete <version>       Archive milestone, create MILESTONES.md
 *     [--name <name>]
 *     [--archive-phases]               Move phase dirs to milestones/vX.Y-phases/
 *
 * Validation:
 *   validate consistency               Check phase numbering, disk/roadmap sync
 *   validate health [--repair]         Check .planning/ integrity, optionally repair
 *
 * Progress:
 *   progress [json|table|bar]          Render progress in various formats
 *
 * Todos:
 *   todo complete <filename>           Move todo from pending to completed
 *
 * Scaffolding:
 *   scaffold context --phase <N>       Create CONTEXT.md template
 *   scaffold uat --phase <N>           Create UAT.md template
 *   scaffold verification --phase <N>  Create VERIFICATION.md template
 *   scaffold phase-dir --phase <N>     Create phase directory
 *     --name <name>
 *
 * Frontmatter CRUD:
 *   frontmatter get <file> [--field k] Extract frontmatter as JSON
 *   frontmatter set <file> --field k   Update single frontmatter field
 *     --value jsonVal
 *   frontmatter merge <file>           Merge JSON into frontmatter
 *     --data '{json}'
 *   frontmatter validate <file>        Validate required fields
 *     --schema plan|summary|verification
 *
 * Verification Suite:
 *   verify plan-structure <file>       Check PLAN.md structure + tasks
 *   verify phase-completeness <phase>  Check all plans have summaries
 *   verify references <file>           Check @-refs + paths resolve
 *   verify commits <h1> [h2] ...      Batch verify commit hashes
 *   verify artifacts <plan-file>       Check must_haves.artifacts
 *   verify key-links <plan-file>       Check must_haves.key_links
 *
 * Template Fill:
 *   template fill summary --phase N    Create pre-filled SUMMARY.md
 *     [--plan M] [--name "..."]
 *     [--fields '{json}']
 *   template fill plan --phase N       Create pre-filled PLAN.md
 *     [--plan M] [--type execute|tdd]
 *     [--wave N] [--fields '{json}']
 *   template fill verification         Create pre-filled VERIFICATION.md
 *     --phase N [--fields '{json}']
 *
 * State Progression:
 *   state advance-plan                 Increment plan counter
 *   state record-metric --phase N      Record execution metrics
 *     --plan M --duration Xmin
 *     [--tasks N] [--files N]
 *   state update-progress              Recalculate progress bar
 *   state add-decision --summary "..."  Add decision to STATE.md
 *     [--phase N] [--rationale "..."]
 *   state add-blocker --text "..."     Add blocker
 *   state resolve-blocker --text "..." Remove blocker
 *   state record-session               Update session continuity
 *     --stopped-at "..."
 *     [--resume-file path]
 *
 * Compound Commands (workflow-specific initialization):
 *   init execute-phase <phase>         All context for execute-phase workflow
 *   init plan-phase <phase>            All context for plan-phase workflow
 *   init new-project                   All context for new-project workflow
 *   init new-milestone                 All context for new-milestone workflow
 *   init quick <description>           All context for quick workflow
 *   init resume                        All context for resume-project workflow
 *   init verify-work <phase>           All context for verify-work workflow
 *   init phase-op <phase>              Generic phase operation context
 *   init todos [area]                  All context for todo workflows
 *   init milestone-op                  All context for milestone operations
 *   init map-codebase                  All context for map-codebase workflow
 *   init progress                      All context for progress workflow
 *
 * Activity Tracking:
 *   activity-set <json>                Write current activity state to .planning/current-activity.json
 *                                      (always overwrites `updated` with current ISO timestamp)
 *   activity-clear                     Remove .planning/current-activity.json (idempotent)
 *   activity-get                       Read .planning/current-activity.json; returns {} if missing
 *
 * Test Maintenance:
 *   maintain-tests discover [--runner auto|jest|playwright|pytest] [--dir path] [--output-file path]
 *                              Detect test frameworks from config files and list all tests via framework CLI
 *   maintain-tests batch --input-file <path> [--size N] [--seed N] [--exclude-file <path>] [--manifest-file <path>]
 *                              Shuffle and split test list into batches; write manifest to disk before execution
 *   maintain-tests run-batch --batch-file <path> [--timeout N] [--env KEY=VALUE...] [--output-file <path>] [--parallel N]
 *                              Execute a single batch from manifest; capture output to temp file; 3-run flakiness check
 *                              --parallel N: run up to N test files concurrently (opt-in; default: sequential)
 *   maintain-tests ddmin --failing-test <path> --candidates-file <path> [--timeout N] [--run-cap N] [--runner auto|jest|playwright|pytest] [--output-file path]
 *                              Delta-debugging: find minimal subset of co-runner tests causing failing-test to fail (default run cap: 50)
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync, spawn } = require('child_process');

// ─── Model Profile Table ─────────────────────────────────────────────────────

const MODEL_PROFILES = {
  'nf-planner':              { quality: 'opus', balanced: 'opus',   budget: 'sonnet' },
  'nf-roadmapper':           { quality: 'opus', balanced: 'sonnet', budget: 'sonnet' },
  'nf-executor':             { quality: 'opus', balanced: 'sonnet', budget: 'sonnet' },
  'nf-phase-researcher':     { quality: 'opus', balanced: 'sonnet', budget: 'haiku' },
  'nf-project-researcher':   { quality: 'opus', balanced: 'sonnet', budget: 'haiku' },
  'nf-research-synthesizer': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
  'nf-debugger':             { quality: 'opus', balanced: 'sonnet', budget: 'sonnet' },
  'nf-codebase-mapper':      { quality: 'sonnet', balanced: 'haiku', budget: 'haiku' },
  'nf-verifier':             { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
  'nf-plan-checker':         { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
  'nf-integration-checker': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function extractGoalFromSection(section) {
  // Canonical roadmap field marker: **Goal**:
  const goalMatch = section.match(/\*\*Goal:?\*\*:?\s*([^\n]+)/i);
  return goalMatch ? goalMatch[1].trim() : null;
}

function loadConfig(cwd) {
  const configPath = path.join(cwd, '.planning', 'config.json');
  const defaults = {
    model_profile: 'balanced',
    commit_docs: true,
    search_gitignored: false,
    branching_strategy: 'none',
    phase_branch_template: 'nf/phase-{phase}-{slug}',
    milestone_branch_template: 'nf/{milestone}-{slug}',
    additional_protected_branches: [],
    quick_branch_template: 'nf/quick-{number}-{slug}',
    research: true,
    plan_checker: true,
    verifier: true,
    parallelization: true,
    brave_search: false,
    auto_advance: true,
    nyquist_validation: true,
    model_tier_planner: 'opus',   // Planner agents (nf-planner, nf-roadmapper) default to opus
    model_tier_worker: 'haiku',   // Worker agents (researcher, checker, executor) default to haiku
    default_milestone: null,
  };

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    const get = (key, nested) => {
      if (parsed[key] !== undefined) return parsed[key];
      if (nested && parsed[nested.section] && parsed[nested.section][nested.field] !== undefined) {
        return parsed[nested.section][nested.field];
      }
      return undefined;
    };

    const parallelization = (() => {
      const val = get('parallelization');
      if (typeof val === 'boolean') return val;
      if (typeof val === 'object' && val !== null && 'enabled' in val) return val.enabled;
      return defaults.parallelization;
    })();

    return {
      model_profile: get('model_profile') ?? defaults.model_profile,
      commit_docs: get('commit_docs', { section: 'planning', field: 'commit_docs' }) ?? defaults.commit_docs,
      search_gitignored: get('search_gitignored', { section: 'planning', field: 'search_gitignored' }) ?? defaults.search_gitignored,
      branching_strategy: get('branching_strategy', { section: 'git', field: 'branching_strategy' }) ?? defaults.branching_strategy,
      phase_branch_template: get('phase_branch_template', { section: 'git', field: 'phase_branch_template' }) ?? defaults.phase_branch_template,
      milestone_branch_template: get('milestone_branch_template', { section: 'git', field: 'milestone_branch_template' }) ?? defaults.milestone_branch_template,
      additional_protected_branches: get('additional_protected_branches', { section: 'git', field: 'additional_protected_branches' }) ?? defaults.additional_protected_branches,
      quick_branch_template: get('quick_branch_template', { section: 'git', field: 'quick_branch_template' }) ?? defaults.quick_branch_template,
      research: get('research', { section: 'workflow', field: 'research' }) ?? defaults.research,
      plan_checker: get('plan_checker', { section: 'workflow', field: 'plan_check' }) ?? defaults.plan_checker,
      verifier: get('verifier', { section: 'workflow', field: 'verifier' }) ?? defaults.verifier,
      parallelization,
      brave_search: get('brave_search') ?? defaults.brave_search,
      auto_advance: get('auto_advance', { section: 'workflow', field: 'auto_advance' }) ?? defaults.auto_advance,
      nyquist_validation: get('nyquist_validation', { section: 'workflow', field: 'nyquist_validation' }) ?? defaults.nyquist_validation,
      model_tier_planner: get('model_tier_planner') ?? defaults.model_tier_planner,
      model_tier_worker: get('model_tier_worker') ?? defaults.model_tier_worker,
      model_overrides: get('model_overrides') || {},
      default_milestone: get('default_milestone') ?? defaults.default_milestone,
    };
  } catch {
    return defaults;
  }
}

function isGitIgnored(cwd, targetPath) {
  try {
    execSync('git check-ignore -q -- ' + targetPath.replace(/[^a-zA-Z0-9._\-/]/g, ''), {
      cwd,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function execGit(cwd, args) {
  try {
    const escaped = args.map(a => {
      if (/^[a-zA-Z0-9._\-/=:@]+$/.test(a)) return a;
      return "'" + a.replace(/'/g, "'\\''") + "'";
    });
    const stdout = execSync('git ' + escaped.join(' '), {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout ?? '').toString().trim(),
      stderr: (err.stderr ?? '').toString().trim(),
    };
  }
}

/**
 * Parse a milestone-scoped phase ID like "v0.7-01" or "v0.7-01.1"
 * Returns null if input is not in milestone-scoped format.
 * Returns { milestone: 'v0.7', seq: '01', decimal: null, full: 'v0.7-01' }
 * or      { milestone: 'v0.7', seq: '01', decimal: '1', full: 'v0.7-01.1' }
 */
function parseMilestonePhaseId(phase) {
  const match = phase.match(/^(v\d+\.\d+)-(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  const milestone = match[1].toLowerCase();
  const seq = match[2].padStart(2, '0');
  const decimal = match[3] || null;
  const full = decimal ? `${milestone}-${seq}.${decimal}` : `${milestone}-${seq}`;
  return { milestone, seq, decimal, full };
}

function normalizePhaseName(phase) {
  // Milestone-scoped format: v0.7-01, v0.7-01.1
  const msp = parseMilestonePhaseId(phase);
  if (msp) return msp.full;

  // Legacy integer format: 40, 39.1
  const match = phase.match(/^(\d+(?:\.\d+)?)/);
  if (!match) return phase;
  const num = match[1];
  const parts = num.split('.');
  const padded = parts[0].padStart(2, '0');
  return parts.length > 1 ? `${padded}.${parts[1]}` : padded;
}

function extractFrontmatter(content) {
  const frontmatter = {};
  const match = content.match(/^---\n([\s\S]+?)\n---/);
  if (!match) return frontmatter;

  const yaml = match[1];
  const lines = yaml.split('\n');

  // Stack to track nested objects: [{obj, key, indent}]
  // obj = object to write to, key = current key collecting array items, indent = indentation level
  let stack = [{ obj: frontmatter, key: null, indent: -1 }];

  for (const line of lines) {
    // Skip empty lines
    if (line.trim() === '') continue;

    // Calculate indentation (number of leading spaces)
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    // Pop stack back to appropriate level
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1];

    // Check for key: value pattern
    const keyMatch = line.match(/^(\s*)([a-zA-Z0-9_-]+):\s*(.*)/);
    if (keyMatch) {
      const key = keyMatch[2];
      const value = keyMatch[3].trim();

      if (value === '' || value === '[') {
        // Key with no value or opening bracket — could be nested object or array
        // We'll determine based on next lines, for now create placeholder
        current.obj[key] = value === '[' ? [] : {};
        current.key = null;
        // Push new context for potential nested content
        stack.push({ obj: current.obj[key], key: null, indent });
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array: key: [a, b, c]
        current.obj[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        current.key = null;
      } else {
        // Simple key: value
        current.obj[key] = value.replace(/^["']|["']$/g, '');
        current.key = null;
      }
    } else if (line.trim().startsWith('- ')) {
      // Array item
      const itemValue = line.trim().slice(2).replace(/^["']|["']$/g, '');

      // If current context is an empty object, convert to array
      if (typeof current.obj === 'object' && !Array.isArray(current.obj) && Object.keys(current.obj).length === 0) {
        // Find the key in parent that points to this object and convert it
        const parent = stack.length > 1 ? stack[stack.length - 2] : null;
        if (parent) {
          for (const k of Object.keys(parent.obj)) {
            if (parent.obj[k] === current.obj) {
              parent.obj[k] = [itemValue];
              current.obj = parent.obj[k];
              break;
            }
          }
        }
      } else if (Array.isArray(current.obj)) {
        current.obj.push(itemValue);
      }
    }
  }

  return frontmatter;
}

function reconstructFrontmatter(obj) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (value.every(v => typeof v === 'string') && value.length <= 3 && value.join(', ').length < 60) {
        lines.push(`${key}: [${value.join(', ')}]`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${typeof item === 'string' && (item.includes(':') || item.includes('#')) ? `"${item}"` : item}`);
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [subkey, subval] of Object.entries(value)) {
        if (subval === null || subval === undefined) continue;
        if (Array.isArray(subval)) {
          if (subval.length === 0) {
            lines.push(`  ${subkey}: []`);
          } else if (subval.every(v => typeof v === 'string') && subval.length <= 3 && subval.join(', ').length < 60) {
            lines.push(`  ${subkey}: [${subval.join(', ')}]`);
          } else {
            lines.push(`  ${subkey}:`);
            for (const item of subval) {
              lines.push(`    - ${typeof item === 'string' && (item.includes(':') || item.includes('#')) ? `"${item}"` : item}`);
            }
          }
        } else if (typeof subval === 'object') {
          lines.push(`  ${subkey}:`);
          for (const [subsubkey, subsubval] of Object.entries(subval)) {
            if (subsubval === null || subsubval === undefined) continue;
            if (Array.isArray(subsubval)) {
              if (subsubval.length === 0) {
                lines.push(`    ${subsubkey}: []`);
              } else {
                lines.push(`    ${subsubkey}:`);
                for (const item of subsubval) {
                  lines.push(`      - ${item}`);
                }
              }
            } else {
              lines.push(`    ${subsubkey}: ${subsubval}`);
            }
          }
        } else {
          const sv = String(subval);
          lines.push(`  ${subkey}: ${sv.includes(':') || sv.includes('#') ? `"${sv}"` : sv}`);
        }
      }
    } else {
      const sv = String(value);
      if (sv.includes(':') || sv.includes('#') || sv.startsWith('[') || sv.startsWith('{')) {
        lines.push(`${key}: "${sv}"`);
      } else {
        lines.push(`${key}: ${sv}`);
      }
    }
  }
  return lines.join('\n');
}

function spliceFrontmatter(content, newObj) {
  const yamlStr = reconstructFrontmatter(newObj);
  const match = content.match(/^---\n[\s\S]+?\n---/);
  if (match) {
    return `---\n${yamlStr}\n---` + content.slice(match[0].length);
  }
  return `---\n${yamlStr}\n---\n\n` + content;
}

function parseMustHavesBlock(content, blockName) {
  // Extract a specific block from must_haves in raw frontmatter YAML
  // Handles 3-level nesting: must_haves > artifacts/key_links > [{path, provides, ...}]
  const fmMatch = content.match(/^---\n([\s\S]+?)\n---/);
  if (!fmMatch) return [];

  const yaml = fmMatch[1];
  // Find the block (e.g., "truths:", "artifacts:", "key_links:")
  const blockPattern = new RegExp(`^\\s{4}${blockName}:\\s*$`, 'm');
  const blockStart = yaml.search(blockPattern);
  if (blockStart === -1) return [];

  const afterBlock = yaml.slice(blockStart);
  const blockLines = afterBlock.split('\n').slice(1); // skip the header line

  const items = [];
  let current = null;

  for (const line of blockLines) {
    // Stop at same or lower indent level (non-continuation)
    if (line.trim() === '') continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= 4 && line.trim() !== '') break; // back to must_haves level or higher

    if (line.match(/^\s{6}-\s+/)) {
      // New list item at 6-space indent
      if (current) items.push(current);
      current = {};
      // Check if it's a simple string item
      const simpleMatch = line.match(/^\s{6}-\s+"?([^"]+)"?\s*$/);
      if (simpleMatch && !line.includes(':')) {
        current = simpleMatch[1];
      } else {
        // Key-value on same line as dash: "- path: value"
        const kvMatch = line.match(/^\s{6}-\s+(\w+):\s*"?([^"]*)"?\s*$/);
        if (kvMatch) {
          current = {};
          current[kvMatch[1]] = kvMatch[2];
        }
      }
    } else if (current && typeof current === 'object') {
      // Continuation key-value at 8+ space indent
      const kvMatch = line.match(/^\s{8,}(\w+):\s*"?([^"]*)"?\s*$/);
      if (kvMatch) {
        const val = kvMatch[2];
        // Try to parse as number
        current[kvMatch[1]] = /^\d+$/.test(val) ? parseInt(val, 10) : val;
      }
      // Array items under a key
      const arrMatch = line.match(/^\s{10,}-\s+"?([^"]+)"?\s*$/);
      if (arrMatch) {
        // Find the last key added and convert to array
        const keys = Object.keys(current);
        const lastKey = keys[keys.length - 1];
        if (lastKey && !Array.isArray(current[lastKey])) {
          current[lastKey] = current[lastKey] ? [current[lastKey]] : [];
        }
        if (lastKey) current[lastKey].push(arrMatch[1]);
      }
    }
  }
  if (current) items.push(current);

  return items;
}

function output(result, raw, rawValue) {
  let data;
  if (raw && rawValue !== undefined) {
    data = String(rawValue);
  } else {
    const json = JSON.stringify(result, null, 2);
    // Large payloads exceed Claude Code's Bash tool buffer (~50KB).
    // Write to tmpfile and output the path prefixed with @file: so callers can detect it.
    if (json.length > 50000) {
      const tmpPath = path.join(require('os').tmpdir(), `nf-${Date.now()}.json`);
      fs.writeFileSync(tmpPath, json, 'utf-8');
      data = '@file:' + tmpPath;
    } else {
      data = json;
    }
  }
  // Use synchronous fd write — process.stdout.write() buffers 8KB for pipes and
  // process.exit() can kill the process before the buffer drains.
  fs.writeSync(1, data);
  process.exit(0);
}

function error(message) {
  process.stderr.write('Error: ' + message + '\n');
  process.exit(1);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdGenerateSlug(text, raw) {
  if (!text) {
    error('text required for slug generation');
  }

  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const result = { slug };
  output(result, raw, slug);
}

function cmdCurrentTimestamp(format, raw) {
  const now = new Date();
  let result;

  switch (format) {
    case 'date':
      result = now.toISOString().split('T')[0];
      break;
    case 'filename':
      result = now.toISOString().replace(/:/g, '-').replace(/\..+/, '');
      break;
    case 'full':
    default:
      result = now.toISOString();
      break;
  }

  output({ timestamp: result }, raw, result);
}

function cmdListTodos(cwd, area, raw) {
  const pendingDir = path.join(cwd, '.planning', 'todos', 'pending');

  let count = 0;
  const todos = [];

  try {
    const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(pendingDir, file), 'utf-8');
        const createdMatch = content.match(/^created:\s*(.+)$/m);
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        const areaMatch = content.match(/^area:\s*(.+)$/m);

        const todoArea = areaMatch ? areaMatch[1].trim() : 'general';

        // Apply area filter if specified
        if (area && todoArea !== area) continue;

        count++;
        todos.push({
          file,
          created: createdMatch ? createdMatch[1].trim() : 'unknown',
          title: titleMatch ? titleMatch[1].trim() : 'Untitled',
          area: todoArea,
          path: path.join('.planning', 'todos', 'pending', file),
        });
      } catch {}
    }
  } catch {}

  const result = { count, todos };
  output(result, raw, count.toString());
}

function cmdVerifyPathExists(cwd, targetPath, raw) {
  if (!targetPath) {
    error('path required for verification');
  }

  const fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath);

  try {
    const stats = fs.statSync(fullPath);
    const type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
    const result = { exists: true, type };
    output(result, raw, 'true');
  } catch {
    const result = { exists: false, type: null };
    output(result, raw, 'false');
  }
}

function cmdConfigEnsureSection(cwd, raw) {
  const configPath = path.join(cwd, '.planning', 'config.json');
  const planningDir = path.join(cwd, '.planning');

  // Ensure .planning directory exists
  try {
    if (!fs.existsSync(planningDir)) {
      fs.mkdirSync(planningDir, { recursive: true });
    }
  } catch (err) {
    error('Failed to create .planning directory: ' + err.message);
  }

  // Check if config already exists
  if (fs.existsSync(configPath)) {
    const result = { created: false, reason: 'already_exists' };
    output(result, raw, 'exists');
    return;
  }

  // Detect Brave Search API key availability
  const homedir = require('os').homedir();
  const braveKeyFile = path.join(homedir, '.nf', 'brave_api_key');
  const hasBraveSearch = !!(process.env.BRAVE_API_KEY || fs.existsSync(braveKeyFile));

  // Load user-level defaults from ~/.nf/defaults.json if available
  const globalDefaultsPath = path.join(homedir, '.nf', 'defaults.json');
  let userDefaults = {};
  try {
    if (fs.existsSync(globalDefaultsPath)) {
      userDefaults = JSON.parse(fs.readFileSync(globalDefaultsPath, 'utf-8'));
    }
  } catch (err) {
    // Ignore malformed global defaults, fall back to hardcoded
  }

  // Create default config (user-level defaults override hardcoded defaults)
  const hardcoded = {
    model_profile: 'balanced',
    commit_docs: true,
    search_gitignored: false,
    branching_strategy: 'none',
    phase_branch_template: 'nf/phase-{phase}-{slug}',
    milestone_branch_template: 'nf/{milestone}-{slug}',
    workflow: {
      research: true,
      plan_check: true,
      verifier: true,
      nyquist_validation: true,
    },
    // Allow projects to set a default milestone when ROADMAP.md / STATE.md are absent
    default_milestone: null,
    parallelization: true,
    brave_search: hasBraveSearch,
  };
  const defaults = {
    ...hardcoded,
    ...userDefaults,
    workflow: { ...hardcoded.workflow, ...(userDefaults.workflow || {}) },
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), 'utf-8');
    const result = { created: true, path: '.planning/config.json' };
    output(result, raw, 'created');
  } catch (err) {
    error('Failed to create config.json: ' + err.message);
  }
}

function cmdConfigSet(cwd, keyPath, value, raw) {
  const configPath = path.join(cwd, '.planning', 'config.json');

  if (!keyPath) {
    error('Usage: config-set <key.path> <value>');
  }

  // Parse value (handle booleans and numbers)
  let parsedValue = value;
  if (value === 'true') parsedValue = true;
  else if (value === 'false') parsedValue = false;
  else if (!isNaN(value) && value !== '') parsedValue = Number(value);

  // Load existing config or start with empty object
  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (err) {
    error('Failed to read config.json: ' + err.message);
  }

  // Set nested value using dot notation (e.g., "workflow.research")
  const keys = keyPath.split('.');
  let current = config;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = parsedValue;

  // Write back
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    const result = { updated: true, key: keyPath, value: parsedValue };
    output(result, raw, `${keyPath}=${parsedValue}`);
  } catch (err) {
    error('Failed to write config.json: ' + err.message);
  }
}

function cmdConfigGet(cwd, keyPath, raw) {
  const configPath = path.join(cwd, '.planning', 'config.json');

  if (!keyPath) {
    error('Usage: config-get <key.path>');
  }

  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else {
      error('No config.json found at ' + configPath);
    }
  } catch (err) {
    if (err.message.startsWith('No config.json')) throw err;
    error('Failed to read config.json: ' + err.message);
  }

  // Traverse dot-notation path (e.g., "workflow.auto_advance")
  const keys = keyPath.split('.');
  let current = config;
  for (const key of keys) {
    if (current === undefined || current === null || typeof current !== 'object') {
      error(`Key not found: ${keyPath}`);
    }
    current = current[key];
  }

  if (current === undefined) {
    error(`Key not found: ${keyPath}`);
  }

  output(current, raw, String(current));
}

function cmdHistoryDigest(cwd, raw) {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const digest = { phases: {}, decisions: [], tech_stack: new Set() };

  // Collect all phase directories: archived + current
  const allPhaseDirs = [];

  // Add archived phases first (oldest milestones first)
  const archived = getArchivedPhaseDirs(cwd);
  for (const a of archived) {
    allPhaseDirs.push({ name: a.name, fullPath: a.fullPath, milestone: a.milestone });
  }

  // Add current phases
  if (fs.existsSync(phasesDir)) {
    try {
      const currentDirs = fs.readdirSync(phasesDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
      for (const dir of currentDirs) {
        allPhaseDirs.push({ name: dir, fullPath: path.join(phasesDir, dir), milestone: null });
      }
    } catch {}
  }

  if (allPhaseDirs.length === 0) {
    digest.tech_stack = [];
    output(digest, raw);
    return;
  }

  try {
    for (const { name: dir, fullPath: dirPath } of allPhaseDirs) {
      const summaries = fs.readdirSync(dirPath).filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');

      for (const summary of summaries) {
        try {
          const content = fs.readFileSync(path.join(dirPath, summary), 'utf-8');
          const fm = extractFrontmatter(content);
          
          const phaseNum = fm.phase || dir.split('-')[0];
          
          if (!digest.phases[phaseNum]) {
            digest.phases[phaseNum] = {
              name: fm.name || dir.split('-').slice(1).join(' ') || 'Unknown',
              provides: new Set(),
              affects: new Set(),
              patterns: new Set(),
            };
          }

          // Merge provides
          if (fm['dependency-graph'] && fm['dependency-graph'].provides) {
            fm['dependency-graph'].provides.forEach(p => digest.phases[phaseNum].provides.add(p));
          } else if (fm.provides) {
            fm.provides.forEach(p => digest.phases[phaseNum].provides.add(p));
          }

          // Merge affects
          if (fm['dependency-graph'] && fm['dependency-graph'].affects) {
            fm['dependency-graph'].affects.forEach(a => digest.phases[phaseNum].affects.add(a));
          }

          // Merge patterns
          if (fm['patterns-established']) {
            fm['patterns-established'].forEach(p => digest.phases[phaseNum].patterns.add(p));
          }

          // Merge decisions
          if (fm['key-decisions']) {
            fm['key-decisions'].forEach(d => {
              digest.decisions.push({ phase: phaseNum, decision: d });
            });
          }

          // Merge tech stack
          if (fm['tech-stack'] && fm['tech-stack'].added) {
            fm['tech-stack'].added.forEach(t => digest.tech_stack.add(typeof t === 'string' ? t : t.name));
          }

        } catch (e) {
          // Skip malformed summaries
        }
      }
    }

    // Convert Sets to Arrays for JSON output
    Object.keys(digest.phases).forEach(p => {
      digest.phases[p].provides = [...digest.phases[p].provides];
      digest.phases[p].affects = [...digest.phases[p].affects];
      digest.phases[p].patterns = [...digest.phases[p].patterns];
    });
    digest.tech_stack = [...digest.tech_stack];

    output(digest, raw);
  } catch (e) {
    error('Failed to generate history digest: ' + e.message);
  }
}

function cmdPhasesList(cwd, options, raw) {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const { type, phase, includeArchived } = options;

  // If no phases directory, return empty
  if (!fs.existsSync(phasesDir)) {
    if (type) {
      output({ files: [], count: 0 }, raw, '');
    } else {
      output({ directories: [], count: 0 }, raw, '');
    }
    return;
  }

  try {
    // Get all phase directories
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    let dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

    // Include archived phases if requested
    if (includeArchived) {
      const archived = getArchivedPhaseDirs(cwd);
      for (const a of archived) {
        dirs.push(`${a.name} [${a.milestone}]`);
      }
    }

    // Sort numerically (handles decimals: 01, 02, 02.1, 02.2, 03) and milestone-scoped IDs
    dirs.sort((a, b) => {
      const parseSortKey = (d) => {
        // Milestone-scoped: v0.7-01, v0.7-01.1
        const msp = parseMilestonePhaseId(d);
        if (msp) {
          // Sort by milestone version numerically, then by sequence
          const versionParts = msp.milestone.replace('v', '').split('.');
          const major = parseInt(versionParts[0] || '0', 10);
          const minor = parseInt(versionParts[1] || '0', 10);
          const seqNum = parseInt(msp.seq, 10);
          const dec = msp.decimal ? parseFloat(`0.${msp.decimal}`) : 0;
          // Encode as large number to sort after legacy integers
          return 1000000 + major * 10000 + minor * 100 + seqNum + dec;
        }
        // Legacy integer
        return parseFloat(d.match(/^(\d+(?:\.\d+)?)/)?.[1] || '0');
      };
      return parseSortKey(a) - parseSortKey(b);
    });

    // If filtering by phase number
    if (phase) {
      const normalized = normalizePhaseName(phase);
      const match = dirs.find(d => d.startsWith(normalized));
      if (!match) {
        output({ files: [], count: 0, phase_dir: null, error: 'Phase not found' }, raw, '');
        return;
      }
      dirs = [match];
    }

    // If listing files of a specific type
    if (type) {
      const files = [];
      for (const dir of dirs) {
        const dirPath = path.join(phasesDir, dir);
        const dirFiles = fs.readdirSync(dirPath);

        let filtered;
        if (type === 'plans') {
          filtered = dirFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md');
        } else if (type === 'summaries') {
          filtered = dirFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
        } else {
          filtered = dirFiles;
        }

        files.push(...filtered.sort());
      }

      const result = {
        files,
        count: files.length,
        phase_dir: phase ? dirs[0].replace(/^\d+(?:\.\d+)?-?/, '') : null,
      };
      output(result, raw, files.join('\n'));
      return;
    }

    // Default: list directories
    output({ directories: dirs, count: dirs.length }, raw, dirs.join('\n'));
  } catch (e) {
    error('Failed to list phases: ' + e.message);
  }
}

function cmdRoadmapGetPhase(cwd, phaseNum, raw) {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');

  if (!fs.existsSync(roadmapPath)) {
    output({ found: false, error: 'ROADMAP.md not found' }, raw, '');
    return;
  }

  try {
    const content = fs.readFileSync(roadmapPath, 'utf-8');

    // Escape special regex chars in phase number, handle decimal
    const escapedPhase = phaseNum.replace(/\./g, '\\.');

    // Match "## Phase X:", "### Phase X:", or "#### Phase X:" with optional name
    const phasePattern = new RegExp(
      `#{2,4}\\s*Phase\\s+${escapedPhase}:\\s*([^\\n]+)`,
      'i'
    );
    const headerMatch = content.match(phasePattern);

    if (!headerMatch) {
      // Fallback: check if phase exists in summary list but missing detail section
      const checklistPattern = new RegExp(
        `-\\s*\\[[ x]\\]\\s*\\*\\*Phase\\s+${escapedPhase}:\\s*([^*]+)\\*\\*`,
        'i'
      );
      const checklistMatch = content.match(checklistPattern);

      if (checklistMatch) {
        // Phase exists in summary but missing detail section - malformed ROADMAP
        output({
          found: false,
          phase_number: phaseNum,
          phase_name: checklistMatch[1].trim(),
          error: 'malformed_roadmap',
          message: `Phase ${phaseNum} exists in summary list but missing "### Phase ${phaseNum}:" detail section. ROADMAP.md needs both formats.`
        }, raw, '');
        return;
      }

      output({ found: false, phase_number: phaseNum }, raw, '');
      return;
    }

    const phaseName = headerMatch[1].trim();
    const headerIndex = headerMatch.index;

    // Find the end of this section (next ## or ### phase header, or end of file)
    const restOfContent = content.slice(headerIndex);
    const nextHeaderMatch = restOfContent.match(/\n#{2,4}\s+Phase\s+(?:\d|v\d)/i);
    const sectionEnd = nextHeaderMatch
      ? headerIndex + nextHeaderMatch.index
      : content.length;

    const section = content.slice(headerIndex, sectionEnd).trim();

    // Extract goal if present
    const goal = extractGoalFromSection(section);

    // Extract success criteria as structured array
    const criteriaMatch = section.match(/\*\*Success Criteria\*\*[^\n]*:\s*\n((?:\s*\d+\.\s*[^\n]+\n?)+)/i);
    const success_criteria = criteriaMatch
      ? criteriaMatch[1].trim().split('\n').map(line => line.replace(/^\s*\d+\.\s*/, '').trim()).filter(Boolean)
      : [];

    output(
      {
        found: true,
        phase_number: phaseNum,
        phase_name: phaseName,
        goal,
        success_criteria,
        section,
      },
      raw,
      section
    );
  } catch (e) {
    error('Failed to read ROADMAP.md: ' + e.message);
  }
}

function cmdPhaseNextDecimal(cwd, basePhase, raw) {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const normalized = normalizePhaseName(basePhase);

  // Check if phases directory exists
  if (!fs.existsSync(phasesDir)) {
    output(
      {
        found: false,
        base_phase: normalized,
        next: `${normalized}.1`,
        existing: [],
      },
      raw,
      `${normalized}.1`
    );
    return;
  }

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

    // Check if base phase exists
    const baseExists = dirs.some(d => d.startsWith(normalized + '-') || d === normalized);

    // Find existing decimal phases for this base
    const decimalPattern = new RegExp(`^${normalized}\\.(\\d+)`);
    const existingDecimals = [];

    for (const dir of dirs) {
      const match = dir.match(decimalPattern);
      if (match) {
        existingDecimals.push(`${normalized}.${match[1]}`);
      }
    }

    // Sort numerically
    existingDecimals.sort((a, b) => {
      const aNum = parseFloat(a);
      const bNum = parseFloat(b);
      return aNum - bNum;
    });

    // Calculate next decimal
    let nextDecimal;
    if (existingDecimals.length === 0) {
      nextDecimal = `${normalized}.1`;
    } else {
      const lastDecimal = existingDecimals[existingDecimals.length - 1];
      const lastNum = parseInt(lastDecimal.split('.')[1], 10);
      nextDecimal = `${normalized}.${lastNum + 1}`;
    }

    output(
      {
        found: baseExists,
        base_phase: normalized,
        next: nextDecimal,
        existing: existingDecimals,
      },
      raw,
      nextDecimal
    );
  } catch (e) {
    error('Failed to calculate next decimal phase: ' + e.message);
  }
}

function cmdStateLoad(cwd, raw) {
  const config = loadConfig(cwd);
  const planningDir = path.join(cwd, '.planning');

  let stateRaw = '';
  try {
    stateRaw = fs.readFileSync(path.join(planningDir, 'STATE.md'), 'utf-8');
  } catch {}

  const configExists = fs.existsSync(path.join(planningDir, 'config.json'));
  const roadmapExists = fs.existsSync(path.join(planningDir, 'ROADMAP.md'));
  const stateExists = stateRaw.length > 0;

  const result = {
    config,
    state_raw: stateRaw,
    state_exists: stateExists,
    roadmap_exists: roadmapExists,
    config_exists: configExists,
  };

  // For --raw, output a condensed key=value format
  if (raw) {
    const c = config;
    const lines = [
      `model_profile=${c.model_profile}`,
      `commit_docs=${c.commit_docs}`,
      `branching_strategy=${c.branching_strategy}`,
      `phase_branch_template=${c.phase_branch_template}`,
      `milestone_branch_template=${c.milestone_branch_template}`,
      `parallelization=${c.parallelization}`,
      `research=${c.research}`,
      `plan_checker=${c.plan_checker}`,
      `verifier=${c.verifier}`,
      `config_exists=${configExists}`,
      `roadmap_exists=${roadmapExists}`,
      `state_exists=${stateExists}`,
    ];
    fs.writeSync(1, lines.join('\n'));
    process.exit(0);
  }

  output(result);
}

function cmdStateGet(cwd, section, raw) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  try {
    const content = fs.readFileSync(statePath, 'utf-8');
    
    if (!section) {
      output({ content }, raw, content);
      return;
    }

    // Try to find markdown section or field
    const fieldEscaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // Check for **field:** value
    const fieldPattern = new RegExp(`\\*\\*${fieldEscaped}:\\*\\*\\s*(.*)`, 'i');
    const fieldMatch = content.match(fieldPattern);
    if (fieldMatch) {
      output({ [section]: fieldMatch[1].trim() }, raw, fieldMatch[1].trim());
      return;
    }

    // Check for ## Section
    const sectionPattern = new RegExp(`##\\s*${fieldEscaped}\\s*\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
    const sectionMatch = content.match(sectionPattern);
    if (sectionMatch) {
      output({ [section]: sectionMatch[1].trim() }, raw, sectionMatch[1].trim());
      return;
    }

    output({ error: `Section or field "${section}" not found` }, raw, '');
  } catch {
    error('STATE.md not found');
  }
}

function cmdStatePatch(cwd, patches, raw) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  try {
    let content = fs.readFileSync(statePath, 'utf-8');
    const results = { updated: [], failed: [] };

    for (const [field, value] of Object.entries(patches)) {
      const fieldEscaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(\\*\\*${fieldEscaped}:\\*\\*\\s*)(.*)`, 'i');
      
      if (pattern.test(content)) {
        content = content.replace(pattern, `$1${value}`);
        results.updated.push(field);
      } else {
        results.failed.push(field);
      }
    }

    if (results.updated.length > 0) {
      fs.writeFileSync(statePath, content, 'utf-8');
    }

    output(results, raw, results.updated.length > 0 ? 'true' : 'false');
  } catch {
    error('STATE.md not found');
  }
}

function cmdStateUpdate(cwd, field, value) {
  if (!field || value === undefined) {
    error('field and value required for state update');
  }

  const statePath = path.join(cwd, '.planning', 'STATE.md');
  try {
    let content = fs.readFileSync(statePath, 'utf-8');
    const fieldEscaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(\\*\\*${fieldEscaped}:\\*\\*\\s*)(.*)`, 'i');
    if (pattern.test(content)) {
      content = content.replace(pattern, `$1${value}`);
      fs.writeFileSync(statePath, content, 'utf-8');
      output({ updated: true });
    } else {
      output({ updated: false, reason: `Field "${field}" not found in STATE.md` });
    }
  } catch {
    output({ updated: false, reason: 'STATE.md not found' });
  }
}

// ─── State Progression Engine ────────────────────────────────────────────────

function stateExtractField(content, fieldName) {
  const pattern = new RegExp(`\\*\\*${fieldName}:\\*\\*\\s*(.+)`, 'i');
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

function stateReplaceField(content, fieldName, newValue) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(\\*\\*${escaped}:\\*\\*\\s*)(.*)`, 'i');
  if (pattern.test(content)) {
    return content.replace(pattern, `$1${newValue}`);
  }
  return null;
}

function cmdStateAdvancePlan(cwd, raw) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw); return; }

  let content = fs.readFileSync(statePath, 'utf-8');
  const currentPlan = parseInt(stateExtractField(content, 'Current Plan'), 10);
  const totalPlans = parseInt(stateExtractField(content, 'Total Plans in Phase'), 10);
  const today = new Date().toISOString().split('T')[0];

  if (isNaN(currentPlan) || isNaN(totalPlans)) {
    output({ error: 'Cannot parse Current Plan or Total Plans in Phase from STATE.md' }, raw);
    return;
  }

  if (currentPlan >= totalPlans) {
    content = stateReplaceField(content, 'Status', 'Phase complete — ready for verification') || content;
    content = stateReplaceField(content, 'Last Activity', today) || content;
    fs.writeFileSync(statePath, content, 'utf-8');
    output({ advanced: false, reason: 'last_plan', current_plan: currentPlan, total_plans: totalPlans, status: 'ready_for_verification' }, raw, 'false');
  } else {
    const newPlan = currentPlan + 1;
    content = stateReplaceField(content, 'Current Plan', String(newPlan)) || content;
    content = stateReplaceField(content, 'Status', 'Ready to execute') || content;
    content = stateReplaceField(content, 'Last Activity', today) || content;
    fs.writeFileSync(statePath, content, 'utf-8');
    output({ advanced: true, previous_plan: currentPlan, current_plan: newPlan, total_plans: totalPlans }, raw, 'true');
  }
}

function cmdStateRecordMetric(cwd, options, raw) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw); return; }

  let content = fs.readFileSync(statePath, 'utf-8');
  const { phase, plan, duration, tasks, files } = options;

  if (!phase || !plan || !duration) {
    output({ error: 'phase, plan, and duration required' }, raw);
    return;
  }

  // Find Performance Metrics section and its table
  const metricsPattern = /(##\s*Performance Metrics[\s\S]*?\n\|[^\n]+\n\|[-|\s]+\n)([\s\S]*?)(?=\n##|\n$|$)/i;
  const metricsMatch = content.match(metricsPattern);

  if (metricsMatch) {
    const tableHeader = metricsMatch[1];
    let tableBody = metricsMatch[2].trimEnd();
    const newRow = `| Phase ${phase} P${plan} | ${duration} | ${tasks || '-'} tasks | ${files || '-'} files |`;

    if (tableBody.trim() === '' || tableBody.includes('None yet')) {
      tableBody = newRow;
    } else {
      tableBody = tableBody + '\n' + newRow;
    }

    content = content.replace(metricsPattern, `${tableHeader}${tableBody}\n`);
    fs.writeFileSync(statePath, content, 'utf-8');
    output({ recorded: true, phase, plan, duration }, raw, 'true');
  } else {
    output({ recorded: false, reason: 'Performance Metrics section not found in STATE.md' }, raw, 'false');
  }
}

function cmdStateUpdateProgress(cwd, raw) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw); return; }

  let content = fs.readFileSync(statePath, 'utf-8');

  // Count summaries across all phases
  const phasesDir = path.join(cwd, '.planning', 'phases');
  let totalPlans = 0;
  let totalSummaries = 0;

  if (fs.existsSync(phasesDir)) {
    const phaseDirs = fs.readdirSync(phasesDir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name);
    for (const dir of phaseDirs) {
      const files = fs.readdirSync(path.join(phasesDir, dir));
      totalPlans += files.filter(f => f.match(/-PLAN\.md$/i)).length;
      totalSummaries += files.filter(f => f.match(/-SUMMARY\.md$/i)).length;
    }
  }

  const percent = totalPlans > 0 ? Math.round(totalSummaries / totalPlans * 100) : 0;
  const barWidth = 10;
  // Clamp to [0, barWidth] \u2014 percent can exceed 100 when summaries > plans
  // (orphan SUMMARY files), which would make repeat() throw on a negative count.
  const filled = Math.max(0, Math.min(barWidth, Math.round(percent / 100 * barWidth)));
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
  const progressStr = `[${bar}] ${percent}%`;

  const progressPattern = /(\*\*Progress:\*\*\s*).*/i;
  if (progressPattern.test(content)) {
    content = content.replace(progressPattern, `$1${progressStr}`);
    fs.writeFileSync(statePath, content, 'utf-8');
    output({ updated: true, percent, completed: totalSummaries, total: totalPlans, bar: progressStr }, raw, progressStr);
  } else {
    output({ updated: false, reason: 'Progress field not found in STATE.md' }, raw, 'false');
  }
}

function cmdStateAddDecision(cwd, options, raw) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw); return; }

  const { phase, summary, rationale } = options;
  if (!summary) { output({ error: 'summary required' }, raw); return; }

  let content = fs.readFileSync(statePath, 'utf-8');
  const entry = `- [Phase ${phase || '?'}]: ${summary}${rationale ? ` — ${rationale}` : ''}`;

  // Find Decisions section (various heading patterns)
  const sectionPattern = /(###?\s*(?:Decisions|Decisions Made|Accumulated.*Decisions)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i;
  const match = content.match(sectionPattern);

  if (match) {
    let sectionBody = match[2];
    // Remove placeholders
    sectionBody = sectionBody.replace(/None yet\.?\s*\n?/gi, '').replace(/No decisions yet\.?\s*\n?/gi, '');
    sectionBody = sectionBody.trimEnd() + '\n' + entry + '\n';
    content = content.replace(sectionPattern, `${match[1]}${sectionBody}`);
    fs.writeFileSync(statePath, content, 'utf-8');
    output({ added: true, decision: entry }, raw, 'true');
  } else {
    output({ added: false, reason: 'Decisions section not found in STATE.md' }, raw, 'false');
  }
}

function cmdStateAddBlocker(cwd, text, raw) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw); return; }
  if (!text) { output({ error: 'text required' }, raw); return; }

  let content = fs.readFileSync(statePath, 'utf-8');
  const entry = `- ${text}`;

  const sectionPattern = /(###?\s*(?:Blockers|Blockers\/Concerns|Concerns)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i;
  const match = content.match(sectionPattern);

  if (match) {
    let sectionBody = match[2];
    sectionBody = sectionBody.replace(/None\.?\s*\n?/gi, '').replace(/None yet\.?\s*\n?/gi, '');
    sectionBody = sectionBody.trimEnd() + '\n' + entry + '\n';
    content = content.replace(sectionPattern, `${match[1]}${sectionBody}`);
    fs.writeFileSync(statePath, content, 'utf-8');
    output({ added: true, blocker: text }, raw, 'true');
  } else {
    output({ added: false, reason: 'Blockers section not found in STATE.md' }, raw, 'false');
  }
}

function cmdStateResolveBlocker(cwd, text, raw) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw); return; }
  if (!text) { output({ error: 'text required' }, raw); return; }

  let content = fs.readFileSync(statePath, 'utf-8');

  const sectionPattern = /(###?\s*(?:Blockers|Blockers\/Concerns|Concerns)\s*\n)([\s\S]*?)(?=\n###?|\n##[^#]|$)/i;
  const match = content.match(sectionPattern);

  if (match) {
    const sectionBody = match[2];
    const lines = sectionBody.split('\n');
    const filtered = lines.filter(line => {
      if (!line.startsWith('- ')) return true;
      return !line.toLowerCase().includes(text.toLowerCase());
    });

    let newBody = filtered.join('\n');
    // If section is now empty, add placeholder
    if (!newBody.trim() || !newBody.includes('- ')) {
      newBody = 'None\n';
    }

    content = content.replace(sectionPattern, `${match[1]}${newBody}`);
    fs.writeFileSync(statePath, content, 'utf-8');
    output({ resolved: true, blocker: text }, raw, 'true');
  } else {
    output({ resolved: false, reason: 'Blockers section not found in STATE.md' }, raw, 'false');
  }
}

function cmdStateRecordSession(cwd, options, raw) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!fs.existsSync(statePath)) { output({ error: 'STATE.md not found' }, raw); return; }

  let content = fs.readFileSync(statePath, 'utf-8');
  const now = new Date().toISOString();
  const updated = [];

  // Update Last session / Last Date
  let result = stateReplaceField(content, 'Last session', now);
  if (result) { content = result; updated.push('Last session'); }
  result = stateReplaceField(content, 'Last Date', now);
  if (result) { content = result; updated.push('Last Date'); }

  // Update Stopped at
  if (options.stopped_at) {
    result = stateReplaceField(content, 'Stopped At', options.stopped_at);
    if (!result) result = stateReplaceField(content, 'Stopped at', options.stopped_at);
    if (result) { content = result; updated.push('Stopped At'); }
  }

  // Update Resume file
  const resumeFile = options.resume_file || 'None';
  result = stateReplaceField(content, 'Resume File', resumeFile);
  if (!result) result = stateReplaceField(content, 'Resume file', resumeFile);
  if (result) { content = result; updated.push('Resume File'); }

  if (updated.length > 0) {
    fs.writeFileSync(statePath, content, 'utf-8');
    output({ recorded: true, updated }, raw, 'true');
  } else {
    output({ recorded: false, reason: 'No session fields found in STATE.md' }, raw, 'false');
  }
}

function cmdResolveModel(cwd, agentType, raw) {
  if (!agentType) {
    error('agent-type required');
  }

  const config = loadConfig(cwd);
  const profile = config.model_profile || 'balanced';
  const model = resolveModelInternal(cwd, agentType);
  const result = { model, profile };
  output(result, raw, model);
}

function cmdFindPhase(cwd, phase, raw) {
  if (!phase) {
    error('phase identifier required');
  }

  const notFound = { found: false, directory: null, phase_number: null, phase_name: null, plans: [], summaries: [] };

  // Delegate to findPhaseInternal so this resolves phases the SAME way as
  // `init plan-phase`/`phase-op`: it searches `.planning/phases/` AND archived
  // `.planning/milestones/v*-phases/`. The previous standalone scan here only
  // looked in `.planning/phases/`, so `find-phase` returned found:false for
  // archived parents that `init plan-phase` resolves — silently skipping
  // parent UAT/artifact closure in execute-phase / audit-milestone / resume-work.
  const found = findPhaseInternal(cwd, phase);
  if (!found) {
    output(notFound, raw, '');
    return;
  }

  const result = {
    found: true,
    directory: found.directory,
    phase_number: found.phase_number,
    phase_name: found.phase_name,
    plans: found.plans || [],
    summaries: found.summaries || [],
  };
  output(result, raw, result.directory);
}

function cmdCommit(cwd, message, files, raw, amend) {
  if (!message && !amend) {
    error('commit message required');
  }

  const config = loadConfig(cwd);

  // Check commit_docs config
  if (!config.commit_docs) {
    const result = { committed: false, hash: null, reason: 'skipped_commit_docs_false' };
    output(result, raw, 'skipped');
    return;
  }

  // Check if .planning is gitignored
  if (isGitIgnored(cwd, '.planning')) {
    const result = { committed: false, hash: null, reason: 'skipped_gitignored' };
    output(result, raw, 'skipped');
    return;
  }

  // Stage files
  const filesToStage = files && files.length > 0 ? files : ['.planning/'];
  for (const file of filesToStage) {
    execGit(cwd, ['add', file]);
  }

  // Commit
  const commitArgs = amend ? ['commit', '--amend', '--no-edit'] : ['commit', '-m', message];
  const commitResult = execGit(cwd, commitArgs);
  if (commitResult.exitCode !== 0) {
    if (commitResult.stdout.includes('nothing to commit') || commitResult.stderr.includes('nothing to commit')) {
      const result = { committed: false, hash: null, reason: 'nothing_to_commit' };
      output(result, raw, 'nothing');
      return;
    }
    const result = { committed: false, hash: null, reason: 'nothing_to_commit', error: commitResult.stderr };
    output(result, raw, 'nothing');
    return;
  }

  // Get short hash
  const hashResult = execGit(cwd, ['rev-parse', '--short', 'HEAD']);
  const hash = hashResult.exitCode === 0 ? hashResult.stdout : null;
  const result = { committed: true, hash, reason: 'committed' };
  output(result, raw, hash || 'committed');
}

function cmdVerifySummary(cwd, summaryPath, checkFileCount, raw) {
  if (!summaryPath) {
    error('summary-path required');
  }

  const fullPath = path.join(cwd, summaryPath);
  const checkCount = checkFileCount || 2;

  // Check 1: Summary exists
  if (!fs.existsSync(fullPath)) {
    const result = {
      passed: false,
      checks: {
        summary_exists: false,
        files_created: { checked: 0, found: 0, missing: [] },
        commits_exist: false,
        self_check: 'not_found',
      },
      errors: ['SUMMARY.md not found'],
    };
    output(result, raw, 'failed');
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const errors = [];

  // Check 2: Spot-check files mentioned in summary
  const mentionedFiles = new Set();
  const patterns = [
    /`([^`]+\.[a-zA-Z]+)`/g,
    /(?:Created|Modified|Added|Updated|Edited):\s*`?([^\s`]+\.[a-zA-Z]+)`?/gi,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const filePath = m[1];
      if (filePath && !filePath.startsWith('http') && filePath.includes('/')) {
        mentionedFiles.add(filePath);
      }
    }
  }

  const filesToCheck = Array.from(mentionedFiles).slice(0, checkCount);
  const missing = [];
  for (const file of filesToCheck) {
    if (!fs.existsSync(path.join(cwd, file))) {
      missing.push(file);
    }
  }

  // Check 3: Commits exist
  const commitHashPattern = /\b[0-9a-f]{7,40}\b/g;
  const hashes = content.match(commitHashPattern) || [];
  let commitsExist = false;
  if (hashes.length > 0) {
    for (const hash of hashes.slice(0, 3)) {
      const result = execGit(cwd, ['cat-file', '-t', hash]);
      if (result.exitCode === 0 && result.stdout === 'commit') {
        commitsExist = true;
        break;
      }
    }
  }

  // Check 4: Self-check section
  let selfCheck = 'not_found';
  const selfCheckPattern = /##\s*(?:Self[- ]?Check|Verification|Quality Check)/i;
  if (selfCheckPattern.test(content)) {
    const passPattern = /(?:all\s+)?(?:pass|✓|✅|complete|succeeded)/i;
    const failPattern = /(?:fail|✗|❌|incomplete|blocked)/i;
    const checkSection = content.slice(content.search(selfCheckPattern));
    if (failPattern.test(checkSection)) {
      selfCheck = 'failed';
    } else if (passPattern.test(checkSection)) {
      selfCheck = 'passed';
    }
  }

  if (missing.length > 0) errors.push('Missing files: ' + missing.join(', '));
  if (!commitsExist && hashes.length > 0) errors.push('Referenced commit hashes not found in git history');
  if (selfCheck === 'failed') errors.push('Self-check section indicates failure');

  const checks = {
    summary_exists: true,
    files_created: { checked: filesToCheck.length, found: filesToCheck.length - missing.length, missing },
    commits_exist: commitsExist,
    self_check: selfCheck,
  };

  const passed = missing.length === 0 && selfCheck !== 'failed';
  const result = { passed, checks, errors };
  output(result, raw, passed ? 'passed' : 'failed');
}

function cmdTemplateSelect(cwd, planPath, raw) {
  if (!planPath) {
    error('plan-path required');
  }

  try {
    const fullPath = path.join(cwd, planPath);
    const content = fs.readFileSync(fullPath, 'utf-8');
    
    // Simple heuristics
    const taskMatch = content.match(/###\s*Task\s*\d+/g) || [];
    const taskCount = taskMatch.length;
    
    const decisionMatch = content.match(/decision/gi) || [];
    const hasDecisions = decisionMatch.length > 0;
    
    // Count file mentions
    const fileMentions = new Set();
    const filePattern = /`([^`]+\.[a-zA-Z]+)`/g;
    let m;
    while ((m = filePattern.exec(content)) !== null) {
      if (m[1].includes('/') && !m[1].startsWith('http')) {
        fileMentions.add(m[1]);
      }
    }
    const fileCount = fileMentions.size;

    let template = 'templates/summary-standard.md';
    let type = 'standard';

    if (taskCount <= 2 && fileCount <= 3 && !hasDecisions) {
      template = 'templates/summary-minimal.md';
      type = 'minimal';
    } else if (hasDecisions || fileCount > 6 || taskCount > 5) {
      template = 'templates/summary-complex.md';
      type = 'complex';
    }

    const result = { template, type, taskCount, fileCount, hasDecisions };
    output(result, raw, template);
  } catch (e) {
    // Fallback to standard
    output({ template: 'templates/summary-standard.md', type: 'standard', error: e.message }, raw, 'templates/summary-standard.md');
  }
}

function cmdTemplateFill(cwd, templateType, options, raw) {
  if (!templateType) { error('template type required: summary, plan, or verification'); }
  if (!options.phase) { error('--phase required'); }

  const phaseInfo = findPhaseInternal(cwd, options.phase);
  if (!phaseInfo || !phaseInfo.found) { output({ error: 'Phase not found', phase: options.phase }, raw); return; }

  const padded = normalizePhaseName(options.phase);
  const today = new Date().toISOString().split('T')[0];
  const phaseName = options.name || phaseInfo.phase_name || 'Unnamed';
  const phaseSlug = phaseInfo.phase_slug || generateSlugInternal(phaseName);
  const phaseId = `${padded}-${phaseSlug}`;
  const planNum = (options.plan || '01').padStart(2, '0');
  const fields = options.fields || {};

  let frontmatter, body, fileName;

  switch (templateType) {
    case 'summary': {
      frontmatter = {
        phase: phaseId,
        plan: planNum,
        subsystem: '[primary category]',
        tags: [],
        provides: [],
        affects: [],
        'tech-stack': { added: [], patterns: [] },
        'key-files': { created: [], modified: [] },
        'key-decisions': [],
        'patterns-established': [],
        duration: '[X]min',
        completed: today,
        ...fields,
      };
      body = [
        `# Phase ${options.phase}: ${phaseName} Summary`,
        '',
        '**[Substantive one-liner describing outcome]**',
        '',
        '## Performance',
        '- **Duration:** [time]',
        '- **Tasks:** [count completed]',
        '- **Files modified:** [count]',
        '',
        '## Accomplishments',
        '- [Key outcome 1]',
        '- [Key outcome 2]',
        '',
        '## Task Commits',
        '1. **Task 1: [task name]** - `hash`',
        '',
        '## Files Created/Modified',
        '- `path/to/file.ts` - What it does',
        '',
        '## Decisions & Deviations',
        '[Key decisions or "None - followed plan as specified"]',
        '',
        '## Next Phase Readiness',
        '[What\'s ready for next phase]',
      ].join('\n');
      fileName = `${padded}-${planNum}-SUMMARY.md`;
      break;
    }
    case 'plan': {
      const planType = options.type || 'execute';
      const wave = parseInt(options.wave) || 1;
      frontmatter = {
        phase: phaseId,
        plan: planNum,
        type: planType,
        wave,
        depends_on: [],
        files_modified: [],
        autonomous: true,
        user_setup: [],
        must_haves: { truths: [], artifacts: [], key_links: [] },
        ...fields,
      };
      body = [
        `# Phase ${options.phase} Plan ${planNum}: [Title]`,
        '',
        '## Objective',
        '- **What:** [What this plan builds]',
        '- **Why:** [Why it matters for the phase goal]',
        '- **Output:** [Concrete deliverable]',
        '',
        '## Context',
        '@.planning/PROJECT.md',
        '@.planning/ROADMAP.md',
        '@.planning/STATE.md',
        '',
        '## Tasks',
        '',
        '<task type="code">',
        '  <name>[Task name]</name>',
        '  <files>[file paths]</files>',
        '  <action>[What to do]</action>',
        '  <verify>[How to verify]</verify>',
        '  <done>[Definition of done]</done>',
        '</task>',
        '',
        '## Verification',
        '[How to verify this plan achieved its objective]',
        '',
        '## Success Criteria',
        '- [ ] [Criterion 1]',
        '- [ ] [Criterion 2]',
      ].join('\n');
      fileName = `${padded}-${planNum}-PLAN.md`;
      break;
    }
    case 'verification': {
      frontmatter = {
        phase: phaseId,
        verified: new Date().toISOString(),
        status: 'pending',
        score: '0/0 must-haves verified',
        ...fields,
      };
      body = [
        `# Phase ${options.phase}: ${phaseName} — Verification`,
        '',
        '## Observable Truths',
        '| # | Truth | Status | Evidence |',
        '|---|-------|--------|----------|',
        '| 1 | [Truth] | pending | |',
        '',
        '## Required Artifacts',
        '| Artifact | Expected | Status | Details |',
        '|----------|----------|--------|---------|',
        '| [path] | [what] | pending | |',
        '',
        '## Key Link Verification',
        '| From | To | Via | Status | Details |',
        '|------|----|----|--------|---------|',
        '| [source] | [target] | [connection] | pending | |',
        '',
        '## Requirements Coverage',
        '| Requirement | Status | Blocking Issue |',
        '|-------------|--------|----------------|',
        '| [req] | pending | |',
        '',
        '## Result',
        '[Pending verification]',
      ].join('\n');
      fileName = `${padded}-VERIFICATION.md`;
      break;
    }
    default:
      error(`Unknown template type: ${templateType}. Available: summary, plan, verification`);
      return;
  }

  const fullContent = `---\n${reconstructFrontmatter(frontmatter)}\n---\n\n${body}\n`;
  const outPath = path.join(cwd, phaseInfo.directory, fileName);

  if (fs.existsSync(outPath)) {
    output({ error: 'File already exists', path: path.relative(cwd, outPath) }, raw);
    return;
  }

  fs.writeFileSync(outPath, fullContent, 'utf-8');
  const relPath = path.relative(cwd, outPath);
  output({ created: true, path: relPath, template: templateType }, raw, relPath);
}

function cmdPhasePlanIndex(cwd, phase, raw) {
  if (!phase) {
    error('phase required for phase-plan-index');
  }

  const phasesDir = path.join(cwd, '.planning', 'phases');
  const normalized = normalizePhaseName(phase);

  // Find phase directory
  let phaseDir = null;
  let phaseDirName = null;
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    const match = dirs.find(d => d.startsWith(normalized));
    if (match) {
      phaseDir = path.join(phasesDir, match);
      phaseDirName = match;
    }
  } catch {
    // phases dir doesn't exist
  }

  if (!phaseDir) {
    output({ phase: normalized, error: 'Phase not found', plans: [], waves: {}, incomplete: [], has_checkpoints: false }, raw);
    return;
  }

  // Get all files in phase directory
  const phaseFiles = fs.readdirSync(phaseDir);
  const planFiles = phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md').sort();
  const summaryFiles = phaseFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');

  // Build set of plan IDs with summaries
  const completedPlanIds = new Set(
    summaryFiles.map(s => s.replace('-SUMMARY.md', '').replace('SUMMARY.md', ''))
  );

  const plans = [];
  const waves = {};
  const incomplete = [];
  let hasCheckpoints = false;

  for (const planFile of planFiles) {
    const planId = planFile.replace('-PLAN.md', '').replace('PLAN.md', '');
    const planPath = path.join(phaseDir, planFile);
    const content = fs.readFileSync(planPath, 'utf-8');
    const fm = extractFrontmatter(content);

    // Count tasks (## Task N patterns)
    const taskMatches = content.match(/##\s*Task\s*\d+/gi) || [];
    const taskCount = taskMatches.length;

    // Parse wave as integer
    const wave = parseInt(fm.wave, 10) || 1;

    // Parse autonomous (default true if not specified)
    let autonomous = true;
    if (fm.autonomous !== undefined) {
      autonomous = fm.autonomous === 'true' || fm.autonomous === true;
    }

    if (!autonomous) {
      hasCheckpoints = true;
    }

    // Parse files-modified
    let filesModified = [];
    if (fm['files-modified']) {
      filesModified = Array.isArray(fm['files-modified']) ? fm['files-modified'] : [fm['files-modified']];
    }

    const hasSummary = completedPlanIds.has(planId);
    if (!hasSummary) {
      incomplete.push(planId);
    }

    const plan = {
      id: planId,
      wave,
      autonomous,
      objective: fm.objective || null,
      files_modified: filesModified,
      task_count: taskCount,
      has_summary: hasSummary,
    };

    plans.push(plan);

    // Group by wave
    const waveKey = String(wave);
    if (!waves[waveKey]) {
      waves[waveKey] = [];
    }
    waves[waveKey].push(planId);
  }

  const result = {
    phase: normalized,
    plans,
    waves,
    incomplete,
    has_checkpoints: hasCheckpoints,
  };

  // Populate milestone context — expose chosen_milestone and whether default was used
  try {
    const milestone = getMilestoneInfo(cwd);
    if (milestone && milestone.version) {
      result.chosen_milestone = milestone.version;
      result.chosen_milestone_name = milestone.name;
      try {
        const cfg = loadConfig(cwd);
        if (cfg && cfg.default_milestone && typeof cfg.default_milestone === 'string') {
          const dm = cfg.default_milestone.trim();
          if (dm && dm.toLowerCase() !== 'auto') {
            result.default_milestone_used = true;
          }
        }
      } catch {}
    }
  } catch {}

  output(result, raw);
}

function cmdStateSnapshot(cwd, raw) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');

  if (!fs.existsSync(statePath)) {
    output({ error: 'STATE.md not found' }, raw);
    return;
  }

  const content = fs.readFileSync(statePath, 'utf-8');

  // Helper to extract **Field:** value patterns
  const extractField = (fieldName) => {
    const pattern = new RegExp(`\\*\\*${fieldName}:\\*\\*\\s*(.+)`, 'i');
    const match = content.match(pattern);
    return match ? match[1].trim() : null;
  };

  // Extract basic fields
  const currentPhase = extractField('Current Phase');
  const currentPhaseName = extractField('Current Phase Name');
  const totalPhasesRaw = extractField('Total Phases');
  const currentPlan = extractField('Current Plan');
  const totalPlansRaw = extractField('Total Plans in Phase');
  const status = extractField('Status');
  const progressRaw = extractField('Progress');
  const lastActivity = extractField('Last Activity');
  const lastActivityDesc = extractField('Last Activity Description');
  const pausedAt = extractField('Paused At');

  // Parse numeric fields
  const totalPhases = totalPhasesRaw ? parseInt(totalPhasesRaw, 10) : null;
  const totalPlansInPhase = totalPlansRaw ? parseInt(totalPlansRaw, 10) : null;
  const progressPercent = progressRaw ? parseInt(progressRaw.replace('%', ''), 10) : null;

  // Extract decisions table
  const decisions = [];
  const decisionsMatch = content.match(/##\s*Decisions Made[\s\S]*?\n\|[^\n]+\n\|[-|\s]+\n([\s\S]*?)(?=\n##|\n$|$)/i);
  if (decisionsMatch) {
    const tableBody = decisionsMatch[1];
    const rows = tableBody.trim().split('\n').filter(r => r.includes('|'));
    for (const row of rows) {
      const cells = row.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 3) {
        decisions.push({
          phase: cells[0],
          summary: cells[1],
          rationale: cells[2],
        });
      }
    }
  }

  // Extract blockers list
  const blockers = [];
  const blockersMatch = content.match(/##\s*Blockers\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (blockersMatch) {
    const blockersSection = blockersMatch[1];
    const items = blockersSection.match(/^-\s+(.+)$/gm) || [];
    for (const item of items) {
      blockers.push(item.replace(/^-\s+/, '').trim());
    }
  }

  // Extract session info
  const session = {
    last_date: null,
    stopped_at: null,
    resume_file: null,
  };

  const sessionMatch = content.match(/##\s*Session\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (sessionMatch) {
    const sessionSection = sessionMatch[1];
    const lastDateMatch = sessionSection.match(/\*\*Last Date:\*\*\s*(.+)/i);
    const stoppedAtMatch = sessionSection.match(/\*\*Stopped At:\*\*\s*(.+)/i);
    const resumeFileMatch = sessionSection.match(/\*\*Resume File:\*\*\s*(.+)/i);

    if (lastDateMatch) session.last_date = lastDateMatch[1].trim();
    if (stoppedAtMatch) session.stopped_at = stoppedAtMatch[1].trim();
    if (resumeFileMatch) session.resume_file = resumeFileMatch[1].trim();
  }

  const result = {
    current_phase: currentPhase,
    current_phase_name: currentPhaseName,
    total_phases: totalPhases,
    current_plan: currentPlan,
    total_plans_in_phase: totalPlansInPhase,
    status,
    progress_percent: progressPercent,
    last_activity: lastActivity,
    last_activity_desc: lastActivityDesc,
    decisions,
    blockers,
    paused_at: pausedAt,
    session,
  };

  output(result, raw);
}

function cmdSummaryExtract(cwd, summaryPath, fields, raw) {
  if (!summaryPath) {
    error('summary-path required for summary-extract');
  }

  const fullPath = path.join(cwd, summaryPath);

  if (!fs.existsSync(fullPath)) {
    output({ error: 'File not found', path: summaryPath }, raw);
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const fm = extractFrontmatter(content);

  // Parse key-decisions into structured format
  const parseDecisions = (decisionsList) => {
    if (!decisionsList || !Array.isArray(decisionsList)) return [];
    return decisionsList.map(d => {
      const colonIdx = d.indexOf(':');
      if (colonIdx > 0) {
        return {
          summary: d.substring(0, colonIdx).trim(),
          rationale: d.substring(colonIdx + 1).trim(),
        };
      }
      return { summary: d, rationale: null };
    });
  };

  // Build full result
  const fullResult = {
    path: summaryPath,
    one_liner: fm['one-liner'] || null,
    key_files: fm['key-files'] || [],
    tech_added: (fm['tech-stack'] && fm['tech-stack'].added) || [],
    patterns: fm['patterns-established'] || [],
    decisions: parseDecisions(fm['key-decisions']),
  };

  // If fields specified, filter to only those fields
  if (fields && fields.length > 0) {
    const filtered = { path: summaryPath };
    for (const field of fields) {
      if (fullResult[field] !== undefined) {
        filtered[field] = fullResult[field];
      }
    }
    output(filtered, raw);
    return;
  }

  output(fullResult, raw);
}

// ─── Formal Summary ───────────────────────────────────────────────────────────

function cmdFormalSummary(cwd, raw) {
  const requirementsPath = path.join(cwd, '.planning', 'formal', 'requirements.json');
  const modelRegistryPath = path.join(cwd, '.planning', 'formal', 'model-registry.json');

  // Default response for missing files
  const defaultResponse = {
    available: false,
    total: 0,
    complete_count: 0,
    pending_count: 0,
    covered_by_model: 0,
    coverage_pct: 0,
    uncovered_count: 0,
    uncovered_ids: [],
    pending_ids: [],
  };

  // Read requirements.json
  let requirements = [];
  if (fs.existsSync(requirementsPath)) {
    try {
      const content = fs.readFileSync(requirementsPath, 'utf-8');
      const data = JSON.parse(content);
      requirements = Array.isArray(data.requirements) ? data.requirements : [];
    } catch (e) {
      console.error(`Warning: Failed to parse requirements.json: ${e.message}`);
      output(defaultResponse, raw, JSON.stringify(defaultResponse));
      return;
    }
  } else {
    output(defaultResponse, raw, JSON.stringify(defaultResponse));
    return;
  }

  // Count requirements by status
  const completeCount = requirements.filter(r => r.status === 'Complete').length;
  const pendingCount = requirements.filter(r => r.status === 'Pending').length;
  const total = requirements.length;

  // Collect pending IDs
  const pendingIds = requirements
    .filter(r => r.status === 'Pending')
    .map(r => r.id);

  // Read model-registry.json to get covered requirements
  let coveredByModel = 0;
  const modelCoverageSet = new Set();

  if (fs.existsSync(modelRegistryPath)) {
    try {
      const content = fs.readFileSync(modelRegistryPath, 'utf-8');
      const data = JSON.parse(content);
      const models = data.models || {};

      // Flatten and deduplicate all requirement IDs from model requirements arrays
      for (const modelKey in models) {
        const model = models[modelKey];
        if (model.requirements && Array.isArray(model.requirements)) {
          for (const reqId of model.requirements) {
            modelCoverageSet.add(reqId);
          }
        }
      }

    } catch (e) {
      console.error(`Warning: Failed to parse model-registry.json: ${e.message}`);
      // Continue with empty coverage
    }
  }

  // Compute uncovered IDs (IDs in requirements.json but not in model-registry)
  const allReqIds = requirements.map(r => r.id).filter(Boolean);
  const uncoveredIds = allReqIds.filter(id => !modelCoverageSet.has(id));
  const uncoveredCount = uncoveredIds.length;

  // covered_by_model = requirements that ARE in model-registry (intersection, not raw set size)
  coveredByModel = total - uncoveredCount;

  // Compute coverage percentage
  const coveragePct = total > 0 ? Math.round((coveredByModel / total) * 100) : 0;

  const result = {
    available: true,
    total,
    complete_count: completeCount,
    pending_count: pendingCount,
    covered_by_model: coveredByModel,
    coverage_pct: coveragePct,
    uncovered_count: uncoveredCount,
    uncovered_ids: uncoveredIds,
    pending_ids: pendingIds,
  };

  output(result, raw, JSON.stringify(result));
}

// ─── Web Search (Brave API) ──────────────────────────────────────────────────

async function cmdWebsearch(query, options, raw) {
  const apiKey = process.env.BRAVE_API_KEY;

  if (!apiKey) {
    // No key = silent skip, agent falls back to built-in WebSearch
    output({ available: false, reason: 'BRAVE_API_KEY not set' }, raw, '');
    return;
  }

  if (!query) {
    output({ available: false, error: 'Query required' }, raw, '');
    return;
  }

  const params = new URLSearchParams({
    q: query,
    count: String(options.limit || 10),
    country: 'us',
    search_lang: 'en',
    text_decorations: 'false'
  });

  if (options.freshness) {
    params.set('freshness', options.freshness);
  }

  try {
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params}`,
      {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey
        }
      }
    );

    if (!response.ok) {
      output({ available: false, error: `API error: ${response.status}` }, raw, '');
      return;
    }

    const data = await response.json();

    const results = (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description,
      age: r.age || null
    }));

    output({
      available: true,
      query,
      count: results.length,
      results
    }, raw, results.map(r => `${r.title}\n${r.url}\n${r.description}`).join('\n\n'));
  } catch (err) {
    output({ available: false, error: err.message }, raw, '');
  }
}

// ─── Frontmatter CRUD ────────────────────────────────────────────────────────

function cmdFrontmatterGet(cwd, filePath, field, raw) {
  if (!filePath) { error('file path required'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw); return; }
  const fm = extractFrontmatter(content);
  if (field) {
    const value = fm[field];
    if (value === undefined) { output({ error: 'Field not found', field }, raw); return; }
    output({ [field]: value }, raw, JSON.stringify(value));
  } else {
    output(fm, raw);
  }
}

function cmdFrontmatterSet(cwd, filePath, field, value, raw) {
  if (!filePath || !field || value === undefined) { error('file, field, and value required'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!fs.existsSync(fullPath)) { output({ error: 'File not found', path: filePath }, raw); return; }
  const content = fs.readFileSync(fullPath, 'utf-8');
  const fm = extractFrontmatter(content);
  let parsedValue;
  try { parsedValue = JSON.parse(value); } catch { parsedValue = value; }
  fm[field] = parsedValue;
  const newContent = spliceFrontmatter(content, fm);
  fs.writeFileSync(fullPath, newContent, 'utf-8');
  output({ updated: true, field, value: parsedValue }, raw, 'true');
}

function cmdFrontmatterMerge(cwd, filePath, data, raw) {
  if (!filePath || !data) { error('file and data required'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!fs.existsSync(fullPath)) { output({ error: 'File not found', path: filePath }, raw); return; }
  const content = fs.readFileSync(fullPath, 'utf-8');
  const fm = extractFrontmatter(content);
  let mergeData;
  try { mergeData = JSON.parse(data); } catch { error('Invalid JSON for --data'); return; }
  Object.assign(fm, mergeData);
  const newContent = spliceFrontmatter(content, fm);
  fs.writeFileSync(fullPath, newContent, 'utf-8');
  output({ merged: true, fields: Object.keys(mergeData) }, raw, 'true');
}

const FRONTMATTER_SCHEMAS = {
  plan: { required: ['phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves'] },
  summary: { required: ['phase', 'plan', 'subsystem', 'tags', 'duration', 'completed'] },
  verification: { required: ['phase', 'verified', 'status', 'score'] },
};

function cmdFrontmatterValidate(cwd, filePath, schemaName, raw) {
  if (!filePath || !schemaName) { error('file and schema required'); }
  const schema = FRONTMATTER_SCHEMAS[schemaName];
  if (!schema) { error(`Unknown schema: ${schemaName}. Available: ${Object.keys(FRONTMATTER_SCHEMAS).join(', ')}`); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw); return; }
  const fm = extractFrontmatter(content);
  const missing = schema.required.filter(f => fm[f] === undefined);
  const present = schema.required.filter(f => fm[f] !== undefined);
  output({ valid: missing.length === 0, missing, present, schema: schemaName }, raw, missing.length === 0 ? 'valid' : 'invalid');
}

// ─── Verification Suite ──────────────────────────────────────────────────────

function cmdVerifyPlanStructure(cwd, filePath, raw) {
  if (!filePath) { error('file path required'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw); return; }

  const fm = extractFrontmatter(content);
  const errors = [];
  const warnings = [];

  // Check required frontmatter fields
  const required = ['phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves'];
  for (const field of required) {
    if (fm[field] === undefined) errors.push(`Missing required frontmatter field: ${field}`);
  }

  // Parse and check task elements
  const taskPattern = /<task[^>]*>([\s\S]*?)<\/task>/g;
  const tasks = [];
  let taskMatch;
  while ((taskMatch = taskPattern.exec(content)) !== null) {
    const taskContent = taskMatch[1];
    const nameMatch = taskContent.match(/<name>([\s\S]*?)<\/name>/);
    const taskName = nameMatch ? nameMatch[1].trim() : 'unnamed';
    const hasFiles = /<files>/.test(taskContent);
    const hasAction = /<action>/.test(taskContent);
    const hasVerify = /<verify>/.test(taskContent);
    const hasDone = /<done>/.test(taskContent);

    if (!nameMatch) errors.push('Task missing <name> element');
    if (!hasAction) errors.push(`Task '${taskName}' missing <action>`);
    if (!hasVerify) warnings.push(`Task '${taskName}' missing <verify>`);
    if (!hasDone) warnings.push(`Task '${taskName}' missing <done>`);
    if (!hasFiles) warnings.push(`Task '${taskName}' missing <files>`);

    tasks.push({ name: taskName, hasFiles, hasAction, hasVerify, hasDone });
  }

  if (tasks.length === 0) warnings.push('No <task> elements found');

  // Wave/depends_on consistency
  if (fm.wave && parseInt(fm.wave) > 1 && (!fm.depends_on || (Array.isArray(fm.depends_on) && fm.depends_on.length === 0))) {
    warnings.push('Wave > 1 but depends_on is empty');
  }

  // Autonomous/checkpoint consistency
  const hasCheckpoints = /<task\s+type=["']?checkpoint/.test(content);
  if (hasCheckpoints && fm.autonomous !== 'false' && fm.autonomous !== false) {
    errors.push('Has checkpoint tasks but autonomous is not false');
  }

  output({
    valid: errors.length === 0,
    errors,
    warnings,
    task_count: tasks.length,
    tasks,
    frontmatter_fields: Object.keys(fm),
  }, raw, errors.length === 0 ? 'valid' : 'invalid');
}

function cmdVerifyPhaseCompleteness(cwd, phase, raw) {
  if (!phase) { error('phase required'); }
  const phaseInfo = findPhaseInternal(cwd, phase);
  if (!phaseInfo || !phaseInfo.found) {
    output({ error: 'Phase not found', phase }, raw);
    return;
  }

  const errors = [];
  const warnings = [];
  const phaseDir = path.join(cwd, phaseInfo.directory);

  // List plans and summaries
  let files;
  try { files = fs.readdirSync(phaseDir); } catch { output({ error: 'Cannot read phase directory' }, raw); return; }

  const plans = files.filter(f => f.match(/-PLAN\.md$/i));
  const summaries = files.filter(f => f.match(/-SUMMARY\.md$/i));

  // Extract plan IDs (everything before -PLAN.md)
  const planIds = new Set(plans.map(p => p.replace(/-PLAN\.md$/i, '')));
  const summaryIds = new Set(summaries.map(s => s.replace(/-SUMMARY\.md$/i, '')));

  // Plans without summaries
  const incompletePlans = [...planIds].filter(id => !summaryIds.has(id));
  if (incompletePlans.length > 0) {
    errors.push(`Plans without summaries: ${incompletePlans.join(', ')}`);
  }

  // Summaries without plans (orphans)
  const orphanSummaries = [...summaryIds].filter(id => !planIds.has(id));
  if (orphanSummaries.length > 0) {
    warnings.push(`Summaries without plans: ${orphanSummaries.join(', ')}`);
  }

  // VERIFICATION.md check — phases must be verified before completion
  const hasVerification = files.some(f => f.match(/-VERIFICATION\.md$/i));
  if (!hasVerification) {
    errors.push('Missing VERIFICATION.md — verifier must run before phase completion');
  }

  output({
    complete: errors.length === 0,
    phase: phaseInfo.phase_number,
    plan_count: plans.length,
    summary_count: summaries.length,
    has_verification: hasVerification,
    incomplete_plans: incompletePlans,
    orphan_summaries: orphanSummaries,
    errors,
    warnings,
  }, raw, errors.length === 0 ? 'complete' : 'incomplete');
}

function cmdVerifyReferences(cwd, filePath, raw) {
  if (!filePath) { error('file path required'); }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: filePath }, raw); return; }

  const found = [];
  const missing = [];

  // Find @-references: @path/to/file (must contain / to be a file path)
  const atRefs = content.match(/@([^\s\n,)]+\/[^\s\n,)]+)/g) || [];
  for (const ref of atRefs) {
    const cleanRef = ref.slice(1); // remove @
    const resolved = cleanRef.startsWith('~/')
      ? path.join(process.env.HOME || '', cleanRef.slice(2))
      : path.join(cwd, cleanRef);
    if (fs.existsSync(resolved)) {
      found.push(cleanRef);
    } else {
      missing.push(cleanRef);
    }
  }

  // Find backtick file paths that look like real paths (contain / and have extension)
  const backtickRefs = content.match(/`([^`]+\/[^`]+\.[a-zA-Z]{1,10})`/g) || [];
  for (const ref of backtickRefs) {
    const cleanRef = ref.slice(1, -1); // remove backticks
    if (cleanRef.startsWith('http') || cleanRef.includes('${') || cleanRef.includes('{{')) continue;
    if (found.includes(cleanRef) || missing.includes(cleanRef)) continue; // dedup
    const resolved = path.join(cwd, cleanRef);
    if (fs.existsSync(resolved)) {
      found.push(cleanRef);
    } else {
      missing.push(cleanRef);
    }
  }

  output({
    valid: missing.length === 0,
    found: found.length,
    missing,
    total: found.length + missing.length,
  }, raw, missing.length === 0 ? 'valid' : 'invalid');
}

function cmdVerifyCommits(cwd, hashes, raw) {
  if (!hashes || hashes.length === 0) { error('At least one commit hash required'); }

  const valid = [];
  const invalid = [];
  for (const hash of hashes) {
    const result = execGit(cwd, ['cat-file', '-t', hash]);
    if (result.exitCode === 0 && result.stdout.trim() === 'commit') {
      valid.push(hash);
    } else {
      invalid.push(hash);
    }
  }

  output({
    all_valid: invalid.length === 0,
    valid,
    invalid,
    total: hashes.length,
  }, raw, invalid.length === 0 ? 'valid' : 'invalid');
}

function cmdVerifyArtifacts(cwd, planFilePath, raw) {
  if (!planFilePath) { error('plan file path required'); }
  const fullPath = path.isAbsolute(planFilePath) ? planFilePath : path.join(cwd, planFilePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: planFilePath }, raw); return; }

  const artifacts = parseMustHavesBlock(content, 'artifacts');
  if (artifacts.length === 0) {
    output({ error: 'No must_haves.artifacts found in frontmatter', path: planFilePath }, raw);
    return;
  }

  const results = [];
  for (const artifact of artifacts) {
    if (typeof artifact === 'string') continue; // skip simple string items
    const artPath = artifact.path;
    if (!artPath) continue;

    const artFullPath = path.join(cwd, artPath);
    const exists = fs.existsSync(artFullPath);
    const check = { path: artPath, exists, issues: [], passed: false };

    if (exists) {
      const fileContent = safeReadFile(artFullPath) || '';
      const lineCount = fileContent.split('\n').length;

      if (artifact.min_lines && lineCount < artifact.min_lines) {
        check.issues.push(`Only ${lineCount} lines, need ${artifact.min_lines}`);
      }
      if (artifact.contains && !fileContent.includes(artifact.contains)) {
        check.issues.push(`Missing pattern: ${artifact.contains}`);
      }
      if (artifact.exports) {
        const exports = Array.isArray(artifact.exports) ? artifact.exports : [artifact.exports];
        for (const exp of exports) {
          if (!fileContent.includes(exp)) check.issues.push(`Missing export: ${exp}`);
        }
      }
      check.passed = check.issues.length === 0;
    } else {
      check.issues.push('File not found');
    }

    results.push(check);
  }

  const passed = results.filter(r => r.passed).length;
  output({
    all_passed: passed === results.length,
    passed,
    total: results.length,
    artifacts: results,
  }, raw, passed === results.length ? 'valid' : 'invalid');
}

function cmdVerifyKeyLinks(cwd, planFilePath, raw) {
  if (!planFilePath) { error('plan file path required'); }
  const fullPath = path.isAbsolute(planFilePath) ? planFilePath : path.join(cwd, planFilePath);
  const content = safeReadFile(fullPath);
  if (!content) { output({ error: 'File not found', path: planFilePath }, raw); return; }

  const keyLinks = parseMustHavesBlock(content, 'key_links');
  if (keyLinks.length === 0) {
    output({ error: 'No must_haves.key_links found in frontmatter', path: planFilePath }, raw);
    return;
  }

  const results = [];
  for (const link of keyLinks) {
    if (typeof link === 'string') continue;
    const check = { from: link.from, to: link.to, via: link.via || '', verified: false, detail: '' };

    const sourceContent = safeReadFile(path.join(cwd, link.from || ''));
    if (!sourceContent) {
      check.detail = 'Source file not found';
    } else if (link.pattern) {
      try {
        const regex = new RegExp(link.pattern);
        if (regex.test(sourceContent)) {
          check.verified = true;
          check.detail = 'Pattern found in source';
        } else {
          const targetContent = safeReadFile(path.join(cwd, link.to || ''));
          if (targetContent && regex.test(targetContent)) {
            check.verified = true;
            check.detail = 'Pattern found in target';
          } else {
            check.detail = `Pattern "${link.pattern}" not found in source or target`;
          }
        }
      } catch {
        check.detail = `Invalid regex pattern: ${link.pattern}`;
      }
    } else {
      // No pattern: just check source references target
      if (sourceContent.includes(link.to || '')) {
        check.verified = true;
        check.detail = 'Target referenced in source';
      } else {
        check.detail = 'Target not referenced in source';
      }
    }

    results.push(check);
  }

  const verified = results.filter(r => r.verified).length;
  output({
    all_verified: verified === results.length,
    verified,
    total: results.length,
    links: results,
  }, raw, verified === results.length ? 'valid' : 'invalid');
}

// ─── Roadmap Analysis ─────────────────────────────────────────────────────────

function cmdRoadmapAnalyze(cwd, raw) {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');

  if (!fs.existsSync(roadmapPath)) {
    output({ error: 'ROADMAP.md not found', milestones: [], phases: [], current_phase: null }, raw);
    return;
  }

  const content = fs.readFileSync(roadmapPath, 'utf-8');
  const phasesDir = path.join(cwd, '.planning', 'phases');

  // Extract all phase headings: ## Phase N: Name or ### Phase N: Name (integer or milestone-scoped)
  const phasePattern = /(?:#{2,4}\s*|[-*]\s+\[[^\]]\]\s+(?:\*{1,2}\s*)?)Phase\s+(v\d+\.\d+-\d+(?:\.\d+)?|\d+(?:\.\d+)?)\s*:\s*([^\n]+)/gi;
  const phases = [];
  let match;

  while ((match = phasePattern.exec(content)) !== null) {
    const phaseNum = match[1];
    const phaseName = match[2].replace(/\(INSERTED\)/i, '').trim();

    // Extract goal from the section
    const sectionStart = match.index;
    const restOfContent = content.slice(sectionStart);
    const nextHeader = restOfContent.match(/\n#{2,4}\s+Phase\s+(?:\d|v\d)/i);
    const sectionEnd = nextHeader ? sectionStart + nextHeader.index : content.length;
    const section = content.slice(sectionStart, sectionEnd);

    const goal = extractGoalFromSection(section);

    const dependsMatch = section.match(/\*\*Depends on:\*\*\s*([^\n]+)/i);
    const depends_on = dependsMatch ? dependsMatch[1].trim() : null;

    // Check completion on disk
    const normalized = normalizePhaseName(phaseNum);
    let diskStatus = 'no_directory';
    let planCount = 0;
    let summaryCount = 0;
    let hasContext = false;
    let hasResearch = false;

    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
      const dirMatch = dirs.find(d => d.startsWith(normalized + '-') || d === normalized);

      if (dirMatch) {
        const phaseFiles = fs.readdirSync(path.join(phasesDir, dirMatch));
        planCount = phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md').length;
        summaryCount = phaseFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md').length;
        hasContext = phaseFiles.some(f => f.endsWith('-CONTEXT.md') || f === 'CONTEXT.md');
        hasResearch = phaseFiles.some(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md');

        if (summaryCount >= planCount && planCount > 0) diskStatus = 'complete';
        else if (summaryCount > 0) diskStatus = 'partial';
        else if (planCount > 0) diskStatus = 'planned';
        else if (hasResearch) diskStatus = 'researched';
        else if (hasContext) diskStatus = 'discussed';
        else diskStatus = 'empty';
      }
    } catch {}

    // Check ROADMAP checkbox status
    const escapedPhaseNum = phaseNum.replace(/\./g, '\\.').replace(/-/g, '\\-');
    const checkboxPattern = new RegExp(`-\\s*\\[(x| )\\]\\s*.*Phase\\s+${escapedPhaseNum}`, 'i');
    const checkboxMatch = content.match(checkboxPattern);
    const roadmapComplete = checkboxMatch ? checkboxMatch[1] === 'x' : false;

    phases.push({
      number: phaseNum,
      name: phaseName,
      goal,
      depends_on,
      plan_count: planCount,
      summary_count: summaryCount,
      has_context: hasContext,
      has_research: hasResearch,
      disk_status: diskStatus,
      roadmap_complete: roadmapComplete,
    });
  }

  // Extract milestone info
  const milestones = [];
  const milestonePattern = /##\s*(.*v(\d+\.\d+)[^(\n]*)/gi;
  let mMatch;
  while ((mMatch = milestonePattern.exec(content)) !== null) {
    milestones.push({
      heading: mMatch[1].trim(),
      version: 'v' + mMatch[2],
    });
  }

  // Find current and next phase
  const currentPhase = phases.find(p => p.disk_status === 'planned' || p.disk_status === 'partial') || null;
  const nextPhase = phases.find(p => p.disk_status === 'empty' || p.disk_status === 'no_directory' || p.disk_status === 'discussed' || p.disk_status === 'researched') || null;

  // Aggregated stats
  const totalPlans = phases.reduce((sum, p) => sum + p.plan_count, 0);
  const totalSummaries = phases.reduce((sum, p) => sum + p.summary_count, 0);
  const completedPhases = phases.filter(p => p.disk_status === 'complete').length;

  // Detect phases in summary list without detail sections (malformed ROADMAP)
  const checklistPattern = /-\s*\[[ x]\]\s*\*\*Phase\s+(v\d+\.\d+-\d+(?:\.\d+)?|\d+(?:\.\d+)?)/gi;
  const checklistPhases = new Set();
  let checklistMatch;
  while ((checklistMatch = checklistPattern.exec(content)) !== null) {
    checklistPhases.add(checklistMatch[1]);
  }
  const detailPhases = new Set(phases.map(p => p.number));
  const missingDetails = [...checklistPhases].filter(p => !detailPhases.has(p));

  const result = {
    milestones,
    phases,
    phase_count: phases.length,
    completed_phases: completedPhases,
    total_plans: totalPlans,
    total_summaries: totalSummaries,
    progress_percent: totalPlans > 0 ? Math.round((totalSummaries / totalPlans) * 100) : 0,
    current_phase: currentPhase ? currentPhase.number : null,
    next_phase: nextPhase ? nextPhase.number : null,
    missing_phase_details: missingDetails.length > 0 ? missingDetails : null,
  };

  output(result, raw);
}

// ─── Phase Add ────────────────────────────────────────────────────────────────

function cmdPhaseAdd(cwd, description, raw) {
  if (!description) {
    error('description required for phase add');
  }

  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const content = fs.readFileSync(roadmapPath, 'utf-8');
  const slug = generateSlugInternal(description);

  // Detect if project uses milestone-scoped phase IDs
  const msHeaderPat = /#{2,4}\s*Phase\s+(v\d+\.\d+-\d+)(?:\.\d+)?\s*:/gi;
  const msMatches = [...content.matchAll(msHeaderPat)];

  let newPhaseNum, paddedNum, dirName, prevPhaseNum;

  if (msMatches.length > 0) {
    const milestoneSeqs = {};
    for (const mm of msMatches) {
      const msp = parseMilestonePhaseId(mm[1]);
      if (!msp) continue;
      if (!milestoneSeqs[msp.milestone]) milestoneSeqs[msp.milestone] = 0;
      const seqNum = parseInt(msp.seq, 10);
      if (seqNum > milestoneSeqs[msp.milestone]) milestoneSeqs[msp.milestone] = seqNum;
    }
    const latestMilestone = Object.keys(milestoneSeqs).pop();
    const maxSeq = milestoneSeqs[latestMilestone] || 0;
    const nextSeq = maxSeq + 1;
    paddedNum = String(nextSeq).padStart(2, '0');
    prevPhaseNum = `${latestMilestone}-${String(maxSeq).padStart(2, '0')}`;
    newPhaseNum = `${latestMilestone}-${paddedNum}`;
    dirName = `${newPhaseNum}-${slug}`;
  } else {
    const intPhasePat = /#{2,4}\s*Phase\s+(\d+)(?:\.\d+)?:/gi;
    let maxPhase = 0;
    let m;
    while ((m = intPhasePat.exec(content)) !== null) {
      const num = parseInt(m[1], 10);
      if (num > maxPhase) maxPhase = num;
    }
    prevPhaseNum = maxPhase;
    newPhaseNum = maxPhase + 1;
    paddedNum = String(newPhaseNum).padStart(2, '0');
    dirName = `${paddedNum}-${slug}`;
  }
  const dirPath = path.join(cwd, '.planning', 'phases', dirName);

  // Create directory with .gitkeep so git tracks empty folders
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, '.gitkeep'), '');

  // Build phase entry
  const phaseEntry = `\n### Phase ${newPhaseNum}: ${description}\n\n**Goal**: [To be planned]\n**Depends on:** Phase ${prevPhaseNum}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run /nf:plan-phase ${newPhaseNum} to break down)\n`;

  // Find insertion point: before last "---" or at end
  let updatedContent;
  const lastSeparator = content.lastIndexOf('\n---');
  if (lastSeparator > 0) {
    updatedContent = content.slice(0, lastSeparator) + phaseEntry + content.slice(lastSeparator);
  } else {
    updatedContent = content + phaseEntry;
  }

  fs.writeFileSync(roadmapPath, updatedContent, 'utf-8');

  const result = {
    phase_number: newPhaseNum,
    padded: paddedNum,
    name: description,
    slug,
    directory: `.planning/phases/${dirName}`,
  };

  output(result, raw, paddedNum);
}

// ─── Phase Insert (Decimal) ──────────────────────────────────────────────────

function cmdPhaseInsert(cwd, afterPhase, description, raw) {
  if (!afterPhase || !description) {
    error('after-phase and description required for phase insert');
  }

  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  const content = fs.readFileSync(roadmapPath, 'utf-8');
  const slug = generateSlugInternal(description);

  // Normalize input then strip leading zeros for flexible matching
  const normalizedAfter = normalizePhaseName(afterPhase);
  const isMilestoneScoped = parseMilestonePhaseId(normalizedAfter) !== null;
  const unpadded = isMilestoneScoped ? normalizedAfter : normalizedAfter.replace(/^0+/, '');
  const afterPhaseEscaped = unpadded.replace(/\./g, '\\.').replace(/-/g, '\\-');
  // For milestone-scoped IDs match exact text; for legacy integers allow optional leading zeros
  const targetPattern = isMilestoneScoped
    ? new RegExp(`#{2,4}\\s*Phase\\s+${afterPhaseEscaped}:`, 'i')
    : new RegExp(`#{2,4}\\s*Phase\\s+0*${afterPhaseEscaped}:`, 'i');
  if (!targetPattern.test(content)) {
    error(`Phase ${afterPhase} not found in ROADMAP.md`);
  }

  // Calculate next decimal using existing logic
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const normalizedBase = normalizePhaseName(afterPhase);
  let existingDecimals = [];

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    const decimalPattern = new RegExp(`^${normalizedBase.replace(/\./g, '\\.')}\\.(\\d+)`);
    for (const dir of dirs) {
      const dm = dir.match(decimalPattern);
      if (dm) existingDecimals.push(parseInt(dm[1], 10));
    }
  } catch {}

  const nextDecimal = existingDecimals.length === 0 ? 1 : Math.max(...existingDecimals) + 1;
  const decimalPhase = `${normalizedBase}.${nextDecimal}`;
  const dirName = `${decimalPhase}-${slug}`;
  const dirPath = path.join(cwd, '.planning', 'phases', dirName);

  // Create directory with .gitkeep so git tracks empty folders
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, '.gitkeep'), '');

  // Build phase entry
  const phaseEntry = `\n### Phase ${decimalPhase}: ${description} (INSERTED)\n\n**Goal**: [Urgent work - to be planned]\n**Depends on:** Phase ${afterPhase}\n**Plans:** 0 plans\n\nPlans:\n- [ ] TBD (run /nf:plan-phase ${decimalPhase} to break down)\n`;

  // Insert after the target phase section
  const headerPattern = isMilestoneScoped
    ? new RegExp(`(#{2,4}\\s*Phase\\s+${afterPhaseEscaped}:[^\\n]*\\n)`, 'i')
    : new RegExp(`(#{2,4}\\s*Phase\\s+0*${afterPhaseEscaped}:[^\\n]*\\n)`, 'i');
  const headerMatch = content.match(headerPattern);
  if (!headerMatch) {
    error(`Could not find Phase ${afterPhase} header`);
  }

  const headerIdx = content.indexOf(headerMatch[0]);
  const afterHeader = content.slice(headerIdx + headerMatch[0].length);
  const nextPhaseMatch = afterHeader.match(/\n#{2,4}\s+Phase\s+(?:\d|v\d)/i);

  let insertIdx;
  if (nextPhaseMatch) {
    insertIdx = headerIdx + headerMatch[0].length + nextPhaseMatch.index;
  } else {
    insertIdx = content.length;
  }

  const updatedContent = content.slice(0, insertIdx) + phaseEntry + content.slice(insertIdx);
  fs.writeFileSync(roadmapPath, updatedContent, 'utf-8');

  const result = {
    phase_number: decimalPhase,
    after_phase: afterPhase,
    name: description,
    slug,
    directory: `.planning/phases/${dirName}`,
  };

  output(result, raw, decimalPhase);
}

// ─── Phase Remove ─────────────────────────────────────────────────────────────

function cmdPhaseRemove(cwd, targetPhase, options, raw) {
  if (!targetPhase) {
    error('phase number required for phase remove');
  }

  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const force = options.force || false;

  if (!fs.existsSync(roadmapPath)) {
    error('ROADMAP.md not found');
  }

  // Normalize the target
  const normalized = normalizePhaseName(targetPhase);
  const isDecimal = targetPhase.includes('.');

  // Find and validate target directory
  let targetDir = null;
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    targetDir = dirs.find(d => d.startsWith(normalized + '-') || d === normalized);
  } catch {}

  // Check for executed work (SUMMARY.md files)
  if (targetDir && !force) {
    const targetPath = path.join(phasesDir, targetDir);
    const files = fs.readdirSync(targetPath);
    const summaries = files.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
    if (summaries.length > 0) {
      error(`Phase ${targetPhase} has ${summaries.length} executed plan(s). Use --force to remove anyway.`);
    }
  }

  // Delete target directory
  if (targetDir) {
    fs.rmSync(path.join(phasesDir, targetDir), { recursive: true, force: true });
  }

  // Renumber subsequent phases
  const renamedDirs = [];
  const renamedFiles = [];

  if (isDecimal) {
    // Decimal removal: renumber sibling decimals (e.g., removing 06.2 → 06.3 becomes 06.2)
    const baseParts = normalized.split('.');
    const baseInt = baseParts[0];
    const removedDecimal = parseInt(baseParts[1], 10);

    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();

      // Find sibling decimals with higher numbers
      const decPattern = new RegExp(`^${baseInt}\\.(\\d+)-(.+)$`);
      const toRename = [];
      for (const dir of dirs) {
        const dm = dir.match(decPattern);
        if (dm && parseInt(dm[1], 10) > removedDecimal) {
          toRename.push({ dir, oldDecimal: parseInt(dm[1], 10), slug: dm[2] });
        }
      }

      // Sort descending to avoid conflicts
      toRename.sort((a, b) => b.oldDecimal - a.oldDecimal);

      for (const item of toRename) {
        const newDecimal = item.oldDecimal - 1;
        const oldPhaseId = `${baseInt}.${item.oldDecimal}`;
        const newPhaseId = `${baseInt}.${newDecimal}`;
        const newDirName = `${baseInt}.${newDecimal}-${item.slug}`;

        // Rename directory
        fs.renameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
        renamedDirs.push({ from: item.dir, to: newDirName });

        // Rename files inside
        const dirFiles = fs.readdirSync(path.join(phasesDir, newDirName));
        for (const f of dirFiles) {
          // Files may have phase prefix like "06.2-01-PLAN.md"
          if (f.includes(oldPhaseId)) {
            const newFileName = f.replace(oldPhaseId, newPhaseId);
            fs.renameSync(
              path.join(phasesDir, newDirName, f),
              path.join(phasesDir, newDirName, newFileName)
            );
            renamedFiles.push({ from: f, to: newFileName });
          }
        }
      }
    } catch {}

  } else {
    // Integer removal: renumber all subsequent integer phases
    const removedInt = parseInt(normalized, 10);

    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();

      // Collect directories that need renumbering (integer phases > removed, and their decimals)
      const toRename = [];
      for (const dir of dirs) {
        const dm = dir.match(/^(\d+)(?:\.(\d+))?-(.+)$/);
        if (!dm) continue;
        const dirInt = parseInt(dm[1], 10);
        if (dirInt > removedInt) {
          toRename.push({
            dir,
            oldInt: dirInt,
            decimal: dm[2] ? parseInt(dm[2], 10) : null,
            slug: dm[3],
          });
        }
      }

      // Sort descending to avoid conflicts
      toRename.sort((a, b) => {
        if (a.oldInt !== b.oldInt) return b.oldInt - a.oldInt;
        return (b.decimal || 0) - (a.decimal || 0);
      });

      for (const item of toRename) {
        const newInt = item.oldInt - 1;
        const newPadded = String(newInt).padStart(2, '0');
        const oldPadded = String(item.oldInt).padStart(2, '0');
        const decimalSuffix = item.decimal !== null ? `.${item.decimal}` : '';
        const oldPrefix = `${oldPadded}${decimalSuffix}`;
        const newPrefix = `${newPadded}${decimalSuffix}`;
        const newDirName = `${newPrefix}-${item.slug}`;

        // Rename directory
        fs.renameSync(path.join(phasesDir, item.dir), path.join(phasesDir, newDirName));
        renamedDirs.push({ from: item.dir, to: newDirName });

        // Rename files inside
        const dirFiles = fs.readdirSync(path.join(phasesDir, newDirName));
        for (const f of dirFiles) {
          if (f.startsWith(oldPrefix)) {
            const newFileName = newPrefix + f.slice(oldPrefix.length);
            fs.renameSync(
              path.join(phasesDir, newDirName, f),
              path.join(phasesDir, newDirName, newFileName)
            );
            renamedFiles.push({ from: f, to: newFileName });
          }
        }
      }
    } catch {}
  }

  // Update ROADMAP.md
  let roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');

  // Remove the target phase section
  const targetEscaped = targetPhase.replace(/\./g, '\\.');
  const sectionPattern = new RegExp(
    `\\n?#{2,4}\\s*Phase\\s+${targetEscaped}\\s*:[\\s\\S]*?(?=\\n#{2,4}\\s+Phase\\s+\\d|$)`,
    'i'
  );
  roadmapContent = roadmapContent.replace(sectionPattern, '');

  // Remove from phase list (checkbox)
  const checkboxPattern = new RegExp(`\\n?-\\s*\\[[ x]\\]\\s*.*Phase\\s+${targetEscaped}[:\\s][^\\n]*`, 'gi');
  roadmapContent = roadmapContent.replace(checkboxPattern, '');

  // Remove from progress table
  const tableRowPattern = new RegExp(`\\n?\\|\\s*${targetEscaped}\\.?\\s[^|]*\\|[^\\n]*`, 'gi');
  roadmapContent = roadmapContent.replace(tableRowPattern, '');

  // Renumber references in ROADMAP for subsequent phases
  if (!isDecimal) {
    const removedInt = parseInt(normalized, 10);

    // Collect all integer phases > removedInt
    const maxPhase = 99; // reasonable upper bound
    for (let oldNum = maxPhase; oldNum > removedInt; oldNum--) {
      const newNum = oldNum - 1;
      const oldStr = String(oldNum);
      const newStr = String(newNum);
      const oldPad = oldStr.padStart(2, '0');
      const newPad = newStr.padStart(2, '0');

      // Phase headings: ## Phase 18: or ### Phase 18: → ## Phase 17: or ### Phase 17:
      roadmapContent = roadmapContent.replace(
        new RegExp(`(#{2,4}\\s*Phase\\s+)${oldStr}(\\s*:)`, 'gi'),
        `$1${newStr}$2`
      );

      // Checkbox items: - [ ] **Phase 18:** → - [ ] **Phase 17:**
      roadmapContent = roadmapContent.replace(
        new RegExp(`(Phase\\s+)${oldStr}([:\\s])`, 'g'),
        `$1${newStr}$2`
      );

      // Plan references: 18-01 → 17-01
      roadmapContent = roadmapContent.replace(
        new RegExp(`${oldPad}-(\\d{2})`, 'g'),
        `${newPad}-$1`
      );

      // Table rows: | 18. → | 17.
      roadmapContent = roadmapContent.replace(
        new RegExp(`(\\|\\s*)${oldStr}\\.\\s`, 'g'),
        `$1${newStr}. `
      );

      // Depends on references
      roadmapContent = roadmapContent.replace(
        new RegExp(`(Depends on:\\*\\*\\s*Phase\\s+)${oldStr}\\b`, 'gi'),
        `$1${newStr}`
      );
    }
  }

  fs.writeFileSync(roadmapPath, roadmapContent, 'utf-8');

  // Update STATE.md phase count
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (fs.existsSync(statePath)) {
    let stateContent = fs.readFileSync(statePath, 'utf-8');
    // Update "Total Phases" field
    const totalPattern = /(\*\*Total Phases:\*\*\s*)(\d+)/;
    const totalMatch = stateContent.match(totalPattern);
    if (totalMatch) {
      const oldTotal = parseInt(totalMatch[2], 10);
      stateContent = stateContent.replace(totalPattern, `$1${oldTotal - 1}`);
    }
    // Update "Phase: X of Y" pattern
    const ofPattern = /(\bof\s+)(\d+)(\s*(?:\(|phases?))/i;
    const ofMatch = stateContent.match(ofPattern);
    if (ofMatch) {
      const oldTotal = parseInt(ofMatch[2], 10);
      stateContent = stateContent.replace(ofPattern, `$1${oldTotal - 1}$3`);
    }
    fs.writeFileSync(statePath, stateContent, 'utf-8');
  }

  const result = {
    removed: targetPhase,
    directory_deleted: targetDir || null,
    renamed_directories: renamedDirs,
    renamed_files: renamedFiles,
    roadmap_updated: true,
    state_updated: fs.existsSync(statePath),
  };

  output(result, raw);
}

// ─── Roadmap Update Plan Progress ────────────────────────────────────────────

function cmdRoadmapUpdatePlanProgress(cwd, phaseNum, raw) {
  if (!phaseNum) {
    error('phase number required for roadmap update-plan-progress');
  }

  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');

  const phaseInfo = findPhaseInternal(cwd, phaseNum);
  if (!phaseInfo) {
    error(`Phase ${phaseNum} not found`);
  }

  const planCount = phaseInfo.plans.length;
  const summaryCount = phaseInfo.summaries.length;

  if (planCount === 0) {
    output({ updated: false, reason: 'No plans found', plan_count: 0, summary_count: 0 }, raw, 'no plans');
    return;
  }

  const isComplete = summaryCount >= planCount;
  const status = isComplete ? 'Complete' : summaryCount > 0 ? 'In Progress' : 'Planned';
  const today = new Date().toISOString().split('T')[0];

  if (!fs.existsSync(roadmapPath)) {
    output({ updated: false, reason: 'ROADMAP.md not found', plan_count: planCount, summary_count: summaryCount }, raw, 'no roadmap');
    return;
  }

  let roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
  const phaseEscaped = phaseNum.replace('.', '\\.');

  // Progress table row: update Plans column (summaries/plans) and Status column
  const tablePattern = new RegExp(
    `(\\|\\s*${phaseEscaped}\\.?\\s[^|]*\\|)[^|]*(\\|)\\s*[^|]*(\\|)\\s*[^|]*(\\|)`,
    'i'
  );
  const dateField = isComplete ? ` ${today} ` : '  ';
  roadmapContent = roadmapContent.replace(
    tablePattern,
    `$1 ${summaryCount}/${planCount} $2 ${status.padEnd(11)}$3${dateField}$4`
  );

  // Update plan count in phase detail section
  const planCountPattern = new RegExp(
    `(#{2,4}\\s*Phase\\s+${phaseEscaped}[\\s\\S]*?\\*\\*Plans:\\*\\*\\s*)[^\\n]+`,
    'i'
  );
  const planCountText = isComplete
    ? `${summaryCount}/${planCount} plans complete`
    : `${summaryCount}/${planCount} plans executed`;
  roadmapContent = roadmapContent.replace(planCountPattern, `$1${planCountText}`);

  // If complete: check checkbox
  if (isComplete) {
    const checkboxPattern = new RegExp(
      `(-\\s*\\[)[ ](\\]\\s*.*Phase\\s+${phaseEscaped}[:\\s][^\\n]*)`,
      'i'
    );
    roadmapContent = roadmapContent.replace(checkboxPattern, `$1x$2 (completed ${today})`);
  }

  fs.writeFileSync(roadmapPath, roadmapContent, 'utf-8');

  output({
    updated: true,
    phase: phaseNum,
    plan_count: planCount,
    summary_count: summaryCount,
    status,
    complete: isComplete,
  }, raw, `${summaryCount}/${planCount} ${status}`);
}

// ─── Requirements Mark Complete ───────────────────────────────────────────────

function cmdRequirementsMarkComplete(cwd, reqIdsRaw, raw) {
  if (!reqIdsRaw || reqIdsRaw.length === 0) {
    error('requirement IDs required. Usage: requirements mark-complete REQ-01,REQ-02 or REQ-01 REQ-02');
  }

  // Accept comma-separated, space-separated, or bracket-wrapped: [REQ-01, REQ-02]
  const reqIds = reqIdsRaw
    .join(' ')
    .replace(/[\[\]]/g, '')
    .split(/[,\s]+/)
    .map(r => r.trim())
    .filter(Boolean);

  if (reqIds.length === 0) {
    error('no valid requirement IDs found');
  }

  const reqPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
  if (!fs.existsSync(reqPath)) {
    output({ updated: false, reason: 'REQUIREMENTS.md not found', ids: reqIds }, raw, 'no requirements file');
    return;
  }

  let reqContent = fs.readFileSync(reqPath, 'utf-8');
  const updated = [];
  const notFound = [];

  for (const reqId of reqIds) {
    let found = false;

    // Update checkbox: - [ ] **REQ-ID** → - [x] **REQ-ID**
    const checkboxPattern = new RegExp(`(-\\s*\\[)[ ](\\]\\s*\\*\\*${reqId}\\*\\*)`, 'gi');
    if (checkboxPattern.test(reqContent)) {
      reqContent = reqContent.replace(checkboxPattern, '$1x$2');
      found = true;
    }

    // Update traceability table: | REQ-ID | Phase N | Pending | → | REQ-ID | Phase N | Complete |
    const tablePattern = new RegExp(`(\\|\\s*${reqId}\\s*\\|[^|]+\\|)\\s*Pending\\s*(\\|)`, 'gi');
    if (tablePattern.test(reqContent)) {
      // Re-read since test() advances lastIndex for global regex
      reqContent = reqContent.replace(
        new RegExp(`(\\|\\s*${reqId}\\s*\\|[^|]+\\|)\\s*Pending\\s*(\\|)`, 'gi'),
        '$1 Complete $2'
      );
      found = true;
    }

    if (found) {
      updated.push(reqId);
    } else {
      notFound.push(reqId);
    }
  }

  if (updated.length > 0) {
    fs.writeFileSync(reqPath, reqContent, 'utf-8');
  }

  output({
    updated: updated.length > 0,
    marked_complete: updated,
    not_found: notFound,
    total: reqIds.length,
  }, raw, `${updated.length}/${reqIds.length} requirements marked complete`);
}

// ─── Phase Complete (Transition) ──────────────────────────────────────────────

function cmdPhaseComplete(cwd, phaseNum, raw) {
  if (!phaseNum) {
    error('phase number required for phase complete');
  }

  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const normalized = normalizePhaseName(phaseNum);
  const today = new Date().toISOString().split('T')[0];

  // Verify phase info
  const phaseInfo = findPhaseInternal(cwd, phaseNum);
  if (!phaseInfo) {
    error(`Phase ${phaseNum} not found`);
  }

  const planCount = phaseInfo.plans.length;
  const summaryCount = phaseInfo.summaries.length;

  // Hard gate: VERIFICATION.md must exist before phase can be marked complete.
  // This is structural enforcement — even if the workflow forgets to spawn nf-verifier,
  // the CLI refuses to advance. Use --skip-verification only for retroactive backfills.
  const skipVerification = process.argv.includes('--skip-verification');
  const hasVerification = phaseInfo.has_verification;
  if (!hasVerification && !skipVerification) {
    error(
      `Phase ${phaseNum} has no VERIFICATION.md. ` +
      `The verifier must run before a phase can be marked complete. ` +
      `If backfilling retroactively, pass --skip-verification.`
    );
  }

  // Update ROADMAP.md: mark phase complete
  if (fs.existsSync(roadmapPath)) {
    let roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');

    // Checkbox: - [ ] Phase N: → - [x] Phase N: (...completed DATE)
    const checkboxPattern = new RegExp(
      `(-\\s*\\[)[ ](\\]\\s*.*Phase\\s+${phaseNum.replace('.', '\\.')}[:\\s][^\\n]*)`,
      'i'
    );
    roadmapContent = roadmapContent.replace(checkboxPattern, `$1x$2 (completed ${today})`);

    // Progress table: update Status to Complete, add date
    const phaseEscaped = phaseNum.replace('.', '\\.');
    const tablePattern = new RegExp(
      `(\\|\\s*${phaseEscaped}\\.?\\s[^|]*\\|[^|]*\\|)\\s*[^|]*(\\|)\\s*[^|]*(\\|)`,
      'i'
    );
    roadmapContent = roadmapContent.replace(
      tablePattern,
      `$1 Complete    $2 ${today} $3`
    );

    // Update plan count in phase section
    const planCountPattern = new RegExp(
      `(#{2,4}\\s*Phase\\s+${phaseEscaped}[\\s\\S]*?\\*\\*Plans:\\*\\*\\s*)[^\\n]+`,
      'i'
    );
    roadmapContent = roadmapContent.replace(
      planCountPattern,
      `$1${summaryCount}/${planCount} plans complete`
    );

    fs.writeFileSync(roadmapPath, roadmapContent, 'utf-8');

    // Update REQUIREMENTS.md traceability for this phase's requirements
    const reqPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
    if (fs.existsSync(reqPath)) {
      // Extract Requirements line from roadmap for this phase
      const reqMatch = roadmapContent.match(
        new RegExp(`Phase\\s+${phaseNum.replace('.', '\\.')}[\\s\\S]*?\\*\\*Requirements:\\*\\*\\s*([^\\n]+)`, 'i')
      );

      if (reqMatch) {
        const reqIds = reqMatch[1].replace(/[\[\]]/g, '').split(/[,\s]+/).map(r => r.trim()).filter(Boolean);
        let reqContent = fs.readFileSync(reqPath, 'utf-8');

        for (const reqId of reqIds) {
          const escapedReqId = reqId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Update checkbox: - [ ] **REQ-ID** → - [x] **REQ-ID**
          reqContent = reqContent.replace(
            new RegExp(`(-\\s*\\[)[ ](\\]\\s*\\*\\*${escapedReqId}\\*\\*)`, 'gi'),
            '$1x$2'
          );
          // Update traceability table: | REQ-ID | Phase N | Pending | → | REQ-ID | Phase N | Complete |
          reqContent = reqContent.replace(
            new RegExp(`(\\|\\s*${escapedReqId}\\s*\\|[^|]+\\|)\\s*Pending\\s*(\\|)`, 'gi'),
            '$1 Complete $2'
          );
        }

        fs.writeFileSync(reqPath, reqContent, 'utf-8');
      }
    }
  }

  // Find next phase
  let nextPhaseNum = null;
  let nextPhaseName = null;
  let isLastPhase = true;

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    const currentFloat = parseFloat(phaseNum);

    // Find the next phase directory after current
    for (const dir of dirs) {
      const dm = dir.match(/^(\d+(?:\.\d+)?)-?(.*)/);
      if (dm) {
        const dirFloat = parseFloat(dm[1]);
        if (dirFloat > currentFloat) {
          nextPhaseNum = dm[1];
          nextPhaseName = dm[2] || null;
          isLastPhase = false;
          break;
        }
      }
    }
  } catch {}

  // Segment-aware version comparator: splits on '-' and compares sub-segments as numbers.
  // parseFloat('0.28-01') === parseFloat('0.28-02') === 0.28, so parseFloat is WRONG
  // for versioned phases like v0.28-01 vs v0.28-02. This helper compares [0.28, 1] vs [0.28, 2].
  function comparePhaseVersions(a, b) {
    const sa = String(a).replace(/^v/i, '').split('-').map(Number);
    const sb = String(b).replace(/^v/i, '').split('-').map(Number);
    const len = Math.max(sa.length, sb.length);
    for (let i = 0; i < len; i++) {
      const va = sa[i] || 0;
      const vb = sb[i] || 0;
      if (va !== vb) return va - vb;
    }
    return 0;
  }

  // Fallback: check ROADMAP.md for phases not yet on disk
  if (isLastPhase && fs.existsSync(roadmapPath)) {
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    const phasePattern = /(?:#{2,4}\s*|[-*]\s+\[[^\]]\]\s+(?:\*{1,2}\s*)?)Phase\s+(v\d+\.\d+-\d+(?:\.\d+)?|\d+(?:\.\d+)?)\s*:\s*([^\n]+)/gi;
    let pm;
    while ((pm = phasePattern.exec(roadmapContent)) !== null) {
      if (comparePhaseVersions(pm[1], phaseNum) > 0) {
        nextPhaseNum = pm[1];
        nextPhaseName = pm[2].replace(/\(INSERTED\)/i, '').trim().replace(/\s+/g, '-').toLowerCase();
        isLastPhase = false;
        break;
      }
    }
  }

  // Update STATE.md
  if (fs.existsSync(statePath)) {
    let stateContent = fs.readFileSync(statePath, 'utf-8');

    // Update Current Phase
    stateContent = stateContent.replace(
      /(\*\*Current Phase:\*\*\s*).*/,
      `$1${nextPhaseNum || phaseNum}`
    );

    // Update Current Phase Name
    if (nextPhaseName) {
      stateContent = stateContent.replace(
        /(\*\*Current Phase Name:\*\*\s*).*/,
        `$1${nextPhaseName.replace(/-/g, ' ')}`
      );
    }

    // Update Status
    stateContent = stateContent.replace(
      /(\*\*Status:\*\*\s*).*/,
      `$1${isLastPhase ? 'Milestone complete' : 'Ready to plan'}`
    );

    // Update Current Plan
    stateContent = stateContent.replace(
      /(\*\*Current Plan:\*\*\s*).*/,
      `$1Not started`
    );

    // Update Last Activity
    stateContent = stateContent.replace(
      /(\*\*Last Activity:\*\*\s*).*/,
      `$1${today}`
    );

    // Update Last Activity Description
    stateContent = stateContent.replace(
      /(\*\*Last Activity Description:\*\*\s*).*/,
      `$1Phase ${phaseNum} complete${nextPhaseNum ? `, transitioned to Phase ${nextPhaseNum}` : ''}`
    );

    fs.writeFileSync(statePath, stateContent, 'utf-8');
  }

  const result = {
    completed_phase: phaseNum,
    phase_name: phaseInfo.phase_name,
    plans_executed: `${summaryCount}/${planCount}`,
    verification_present: hasVerification,
    verification_skipped: skipVerification && !hasVerification,
    next_phase: nextPhaseNum,
    next_phase_name: nextPhaseName,
    is_last_phase: isLastPhase,
    date: today,
    roadmap_updated: fs.existsSync(roadmapPath),
    state_updated: fs.existsSync(statePath),
  };

  output(result, raw);
}

// ─── Milestone Complete ───────────────────────────────────────────────────────

function cmdMilestoneComplete(cwd, version, options, raw) {
  if (!version) {
    error('version required for milestone complete (e.g., v1.0)');
  }

  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  const reqPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  const milestonesPath = path.join(cwd, '.planning', 'MILESTONES.md');
  const archiveDir = path.join(cwd, '.planning', 'milestones');
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const today = new Date().toISOString().split('T')[0];
  const milestoneName = options.name || version;

  // Ensure archive directory exists
  fs.mkdirSync(archiveDir, { recursive: true });

  // Gather stats from phases
  let phaseCount = 0;
  let totalPlans = 0;
  let totalTasks = 0;
  const accomplishments = [];

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();

    for (const dir of dirs) {
      phaseCount++;
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md');
      const summaries = phaseFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
      totalPlans += plans.length;

      // Extract one-liners from summaries
      for (const s of summaries) {
        try {
          const content = fs.readFileSync(path.join(phasesDir, dir, s), 'utf-8');
          const fm = extractFrontmatter(content);
          if (fm['one-liner']) {
            accomplishments.push(fm['one-liner']);
          }
          // Count tasks
          const taskMatches = content.match(/##\s*Task\s*\d+/gi) || [];
          totalTasks += taskMatches.length;
        } catch {}
      }
    }
  } catch {}

  // Archive ROADMAP.md
  if (fs.existsSync(roadmapPath)) {
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    fs.writeFileSync(path.join(archiveDir, `${version}-ROADMAP.md`), roadmapContent, 'utf-8');
  }

  // Archive REQUIREMENTS.md
  if (fs.existsSync(reqPath)) {
    const reqContent = fs.readFileSync(reqPath, 'utf-8');
    const archiveHeader = `# Requirements Archive: ${version} ${milestoneName}\n\n**Archived:** ${today}\n**Status:** SHIPPED\n\nFor current requirements, see \`.planning/REQUIREMENTS.md\`.\n\n---\n\n`;
    fs.writeFileSync(path.join(archiveDir, `${version}-REQUIREMENTS.md`), archiveHeader + reqContent, 'utf-8');
  }

  // Archive audit file if exists (check new milestones/ path first, then legacy root)
  const auditFileNew = path.join(cwd, '.planning', 'milestones', `${version}-MILESTONE-AUDIT.md`);
  const auditFileLegacy = path.join(cwd, '.planning', `${version}-MILESTONE-AUDIT.md`);
  const auditFile = fs.existsSync(auditFileNew) ? auditFileNew : auditFileLegacy;
  if (fs.existsSync(auditFile)) {
    fs.renameSync(auditFile, path.join(archiveDir, `${version}-MILESTONE-AUDIT.md`));
  }

  // Create/append MILESTONES.md entry
  const accomplishmentsList = accomplishments.map(a => `- ${a}`).join('\n');
  const milestoneEntry = `## ${version} ${milestoneName} (Shipped: ${today})\n\n**Phases completed:** ${phaseCount} phases, ${totalPlans} plans, ${totalTasks} tasks\n\n**Key accomplishments:**\n${accomplishmentsList || '- (none recorded)'}\n\n---\n\n`;

  if (fs.existsSync(milestonesPath)) {
    const existing = fs.readFileSync(milestonesPath, 'utf-8');
    fs.writeFileSync(milestonesPath, existing + '\n' + milestoneEntry, 'utf-8');
  } else {
    fs.writeFileSync(milestonesPath, `# Milestones\n\n${milestoneEntry}`, 'utf-8');
  }

  // Update STATE.md
  if (fs.existsSync(statePath)) {
    let stateContent = fs.readFileSync(statePath, 'utf-8');
    stateContent = stateContent.replace(
      /(\*\*Status:\*\*\s*).*/,
      `$1${version} milestone complete`
    );
    stateContent = stateContent.replace(
      /(\*\*Last Activity:\*\*\s*).*/,
      `$1${today}`
    );
    stateContent = stateContent.replace(
      /(\*\*Last Activity Description:\*\*\s*).*/,
      `$1${version} milestone completed and archived`
    );
    fs.writeFileSync(statePath, stateContent, 'utf-8');
  }

  // Archive phase directories if requested
  let phasesArchived = false;
  if (options.archivePhases) {
    try {
      const phaseArchiveDir = path.join(archiveDir, `${version}-phases`);
      fs.mkdirSync(phaseArchiveDir, { recursive: true });

      const phaseEntries = fs.readdirSync(phasesDir, { withFileTypes: true });
      const phaseDirNames = phaseEntries.filter(e => e.isDirectory()).map(e => e.name);
      for (const dir of phaseDirNames) {
        fs.renameSync(path.join(phasesDir, dir), path.join(phaseArchiveDir, dir));
      }
      phasesArchived = phaseDirNames.length > 0;
    } catch {}
  }

  const result = {
    version,
    name: milestoneName,
    date: today,
    phases: phaseCount,
    plans: totalPlans,
    tasks: totalTasks,
    accomplishments,
    archived: {
      roadmap: fs.existsSync(path.join(archiveDir, `${version}-ROADMAP.md`)),
      requirements: fs.existsSync(path.join(archiveDir, `${version}-REQUIREMENTS.md`)),
      audit: fs.existsSync(path.join(archiveDir, `${version}-MILESTONE-AUDIT.md`)),
      phases: phasesArchived,
    },
    milestones_updated: true,
    state_updated: fs.existsSync(statePath),
  };

  output(result, raw);
}

// ─── Validate Consistency ─────────────────────────────────────────────────────

function cmdValidateConsistency(cwd, raw) {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const errors = [];
  const warnings = [];

  // Check for ROADMAP
  if (!fs.existsSync(roadmapPath)) {
    errors.push('ROADMAP.md not found');
    output({ passed: false, errors, warnings }, raw, 'failed');
    return;
  }

  const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');

  // Extract phases from ROADMAP
  const roadmapPhases = new Set();
  const phasePattern = /(?:#{2,4}\s*|[-*]\s+\[[^\]]\]\s+(?:\*{1,2}\s*)?)Phase\s+(v\d+\.\d+-\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)\s*:/gi;
  let m;
  while ((m = phasePattern.exec(roadmapContent)) !== null) {
    roadmapPhases.add(m[1]);
  }

  // Get phases on disk
  const diskPhases = new Set();
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    for (const dir of dirs) {
      const dm = dir.match(/^(v\d+\.\d+-\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)/);
      if (dm) diskPhases.add(dm[1]);
    }
  } catch {}

  // Check: phases in ROADMAP but not on disk
  for (const p of roadmapPhases) {
    if (!diskPhases.has(p) && !diskPhases.has(normalizePhaseName(p))) {
      warnings.push(`Phase ${p} in ROADMAP.md but no directory on disk`);
    }
  }

  // Check: phases on disk but not in ROADMAP
  for (const p of diskPhases) {
    const normalized = normalizePhaseName(p);
    const parts = p.split('.');
    const unpadded = parts.length > 1
      ? `${parseInt(parts[0], 10)}.${parts[1]}`
      : String(parseInt(parts[0], 10));
    if (!roadmapPhases.has(p) && !roadmapPhases.has(normalized) && !roadmapPhases.has(unpadded)) {
      warnings.push(`Phase ${p} exists on disk but not in ROADMAP.md`);
    }
  }

  // Check: sequential phase numbers (integers only)
  const integerPhases = [...diskPhases]
    .filter(p => !p.includes('.'))
    .map(p => parseInt(p, 10))
    .sort((a, b) => a - b);

  for (let i = 1; i < integerPhases.length; i++) {
    if (integerPhases[i] !== integerPhases[i - 1] + 1) {
      warnings.push(`Gap in phase numbering: ${integerPhases[i - 1]} → ${integerPhases[i]}`);
    }
  }

  // Check: plan numbering within phases
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();

    for (const dir of dirs) {
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter(f => f.endsWith('-PLAN.md')).sort();

      // Extract plan numbers
      const planNums = plans.map(p => {
        const pm = p.match(/-(\d{2})-PLAN\.md$/);
        return pm ? parseInt(pm[1], 10) : null;
      }).filter(n => n !== null);

      for (let i = 1; i < planNums.length; i++) {
        if (planNums[i] !== planNums[i - 1] + 1) {
          warnings.push(`Gap in plan numbering in ${dir}: plan ${planNums[i - 1]} → ${planNums[i]}`);
        }
      }

      // Check: plans without summaries (completed plans)
      const summaries = phaseFiles.filter(f => f.endsWith('-SUMMARY.md'));
      const planIds = new Set(plans.map(p => p.replace('-PLAN.md', '')));
      const summaryIds = new Set(summaries.map(s => s.replace('-SUMMARY.md', '')));

      // Summary without matching plan is suspicious
      for (const sid of summaryIds) {
        if (!planIds.has(sid)) {
          warnings.push(`Summary ${sid}-SUMMARY.md in ${dir} has no matching PLAN.md`);
        }
      }
    }
  } catch {}

  // Check: frontmatter in plans has required fields
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

    for (const dir of dirs) {
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter(f => f.endsWith('-PLAN.md'));

      for (const plan of plans) {
        const content = fs.readFileSync(path.join(phasesDir, dir, plan), 'utf-8');
        const fm = extractFrontmatter(content);

        if (!fm.wave) {
          warnings.push(`${dir}/${plan}: missing 'wave' in frontmatter`);
        }
      }
    }
  } catch {}

  const passed = errors.length === 0;
  output({ passed, errors, warnings, warning_count: warnings.length }, raw, passed ? 'passed' : 'failed');
}

// ─── Validate Health ──────────────────────────────────────────────────────────

function cmdValidateHealth(cwd, options, raw) {
  const planningDir = path.join(cwd, '.planning');
  const projectPath = path.join(planningDir, 'PROJECT.md');
  const roadmapPath = path.join(planningDir, 'ROADMAP.md');
  const statePath = path.join(planningDir, 'STATE.md');
  const configPath = path.join(planningDir, 'config.json');
  const phasesDir = path.join(planningDir, 'phases');

  const errors = [];
  const warnings = [];
  const info = [];
  const repairs = [];

  // Helper to add issue
  const addIssue = (severity, code, message, fix, repairable = false) => {
    const issue = { code, message, fix, repairable };
    if (severity === 'error') errors.push(issue);
    else if (severity === 'warning') warnings.push(issue);
    else info.push(issue);
  };

  // ─── Check 1: .planning/ exists ───────────────────────────────────────────
  if (!fs.existsSync(planningDir)) {
    addIssue('error', 'E001', '.planning/ directory not found', 'Run /nf:new-project to initialize');
    output({
      status: 'broken',
      errors,
      warnings,
      info,
      repairable_count: 0,
    }, raw);
    return;
  }

  // ─── Check 2: PROJECT.md exists and has required sections ─────────────────
  if (!fs.existsSync(projectPath)) {
    addIssue('error', 'E002', 'PROJECT.md not found', 'Run /nf:new-project to create');
  } else {
    const content = fs.readFileSync(projectPath, 'utf-8');
    const requiredSections = ['## What This Is', '## Core Value', '## Requirements'];
    for (const section of requiredSections) {
      if (!content.includes(section)) {
        addIssue('warning', 'W001', `PROJECT.md missing section: ${section}`, 'Add section manually');
      }
    }
  }

  // ─── Check 3: ROADMAP.md exists ───────────────────────────────────────────
  if (!fs.existsSync(roadmapPath)) {
    addIssue('error', 'E003', 'ROADMAP.md not found', 'Run /nf:new-milestone to create roadmap');
  }

  // ─── Check 4: STATE.md exists and references valid phases ─────────────────
  if (!fs.existsSync(statePath)) {
    addIssue('error', 'E004', 'STATE.md not found', 'Run /nf:health --repair to regenerate', true);
    repairs.push('regenerateState');
  } else {
    const stateContent = fs.readFileSync(statePath, 'utf-8');
    // Extract phase references from STATE.md
    const phaseRefs = [...stateContent.matchAll(/[Pp]hase\s+(v\d+\.\d+-\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)/g)].map(m => m[1]);
    // Get disk phases
    const diskPhases = new Set();
    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const m = e.name.match(/^(v\d+\.\d+-\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)/);
          if (m) diskPhases.add(m[1]);
        }
      }
    } catch {}
    // Check for invalid references
    for (const ref of phaseRefs) {
      const normalizedRef = normalizePhaseName(ref);
      const refParts = ref.split('.');
      const unpaddedRef = refParts.length > 1
        ? `${parseInt(refParts[0], 10)}.${refParts[1]}`
        : String(parseInt(refParts[0], 10));
      if (!diskPhases.has(ref) && !diskPhases.has(normalizedRef) && !diskPhases.has(unpaddedRef)) {
        // Only warn if phases dir has any content (not just an empty project)
        if (diskPhases.size > 0) {
          addIssue('warning', 'W002', `STATE.md references phase ${ref}, but only phases ${[...diskPhases].sort().join(', ')} exist`, 'Run /nf:health --repair to regenerate STATE.md', true);
          if (!repairs.includes('regenerateState')) repairs.push('regenerateState');
        }
      }
    }
  }

  // ─── Check 5: config.json valid JSON + valid schema ───────────────────────
  if (!fs.existsSync(configPath)) {
    addIssue('warning', 'W003', 'config.json not found', 'Run /nf:health --repair to create with defaults', true);
    repairs.push('createConfig');
  } else {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Validate known fields
      const validProfiles = ['quality', 'balanced', 'budget'];
      if (parsed.model_profile && !validProfiles.includes(parsed.model_profile)) {
        addIssue('warning', 'W004', `config.json: invalid model_profile "${parsed.model_profile}"`, `Valid values: ${validProfiles.join(', ')}`);
      }
    } catch (err) {
      addIssue('error', 'E005', `config.json: JSON parse error - ${err.message}`, 'Run /nf:health --repair to reset to defaults', true);
      repairs.push('resetConfig');
    }
  }

  // ─── Check 6: Phase directory naming (NN-name format) ─────────────────────
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.match(/^(v\d+\.\d+-\d{2}(?:\.\d+)?-[.\w-]+|\d{2}(?:\.\d+)?-[\w-]+)$/)) {
        addIssue('warning', 'W005', `Phase directory "${e.name}" doesn't follow NN-name format`, 'Rename to match pattern (e.g., 01-setup)');
      }
    }
  } catch {}

  // ─── Check 7: Orphaned plans (PLAN without SUMMARY) ───────────────────────
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const phaseFiles = fs.readdirSync(path.join(phasesDir, e.name));
      const plans = phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md');
      const summaries = phaseFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
      const summaryBases = new Set(summaries.map(s => s.replace('-SUMMARY.md', '').replace('SUMMARY.md', '')));

      for (const plan of plans) {
        const planBase = plan.replace('-PLAN.md', '').replace('PLAN.md', '');
        if (!summaryBases.has(planBase)) {
          addIssue('info', 'I001', `${e.name}/${plan} has no SUMMARY.md`, 'May be in progress');
        }
      }
    }
  } catch {}

  // ─── Check 8: Run existing consistency checks ─────────────────────────────
  // Inline subset of cmdValidateConsistency
  if (fs.existsSync(roadmapPath)) {
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    const roadmapPhases = new Set();
    const phasePattern = /(?:#{2,4}\s*|[-*]\s+\[[^\]]\]\s+(?:\*{1,2}\s*)?)Phase\s+(v\d+\.\d+-\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)\s*:/gi;
    let m;
    while ((m = phasePattern.exec(roadmapContent)) !== null) {
      roadmapPhases.add(m[1]);
    }

    const diskPhases = new Set();
    const archivedPhaseIds = new Set();
    try {
      const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const dm = e.name.match(/^(v\d+\.\d+-\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)/);
          if (dm) diskPhases.add(dm[1]);
        }
      }
    } catch {}

    // Also count archived phases (milestones/v*-phases/ and archive/legacy/) so W006
    // doesn't fire for phases that were legitimately archived rather than deleted
    const archivedPhaseDirs = getArchivedPhaseDirs(cwd);
    for (const a of archivedPhaseDirs) {
      const dm = a.name.match(/^(v\d+\.\d+-\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)/);
      if (dm) {
        diskPhases.add(dm[1]);
        archivedPhaseIds.add(dm[1]);
      }
    }
    const legacyArchiveDir = path.join(planningDir, 'archive', 'legacy');
    if (fs.existsSync(legacyArchiveDir)) {
      try {
        const legacyEntries = fs.readdirSync(legacyArchiveDir, { withFileTypes: true });
        for (const e of legacyEntries) {
          if (e.isDirectory()) {
            const dm = e.name.match(/^(v\d+\.\d+-\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)/);
            if (dm) {
              diskPhases.add(dm[1]);
              archivedPhaseIds.add(dm[1]);
            }
          }
        }
      } catch {}
    }

    // Phases in ROADMAP but not on disk
    for (const p of roadmapPhases) {
      const normalized = normalizePhaseName(p);
      const pParts = p.split('.');
      const unpadded = pParts.length > 1
        ? `${parseInt(pParts[0], 10)}.${pParts[1]}`
        : String(parseInt(pParts[0], 10));
      if (!diskPhases.has(p) && !diskPhases.has(normalized) && !diskPhases.has(unpadded)) {
        addIssue('warning', 'W006', `Phase ${p} in ROADMAP.md but no directory on disk`, 'Create phase directory or remove from roadmap');
      }
    }

    // Phases on disk but not in ROADMAP (skip archived phases — they are expected to be absent from ROADMAP).
    // Collapse into ONE warning: emitting one W007 per orphan flooded /nf:health with dozens of
    // duplicates and pinned the report at DEGRADED (especially when the ROADMAP parser missed the
    // checklist phase format and matched nothing — see the phasePattern fix).
    const orphanPhases = [];
    for (const p of diskPhases) {
      if (archivedPhaseIds.has(p)) continue;
      const normalized = normalizePhaseName(p);
      const dParts = p.split('.');
      const unpadded = dParts.length > 1
        ? `${parseInt(dParts[0], 10)}.${dParts[1]}`
        : String(parseInt(dParts[0], 10));
      if (!roadmapPhases.has(p) && !roadmapPhases.has(normalized) && !roadmapPhases.has(unpadded)) {
        orphanPhases.push(p);
      }
    }
    if (orphanPhases.length > 0) {
      addIssue(
        'warning',
        'W007',
        `${orphanPhases.length} phase(s) exist on disk but not in ROADMAP.md: ${orphanPhases.join(', ')}`,
        'Add them to the roadmap, remove the directories, or run /nf:cleanup'
      );
    }
  }

  // ─── Check 9: Quorum failure patterns ─────────────────────────────────────────
  let failuresPath;
  try {
    const pp = require(path.join(__dirname, '..', '..', 'bin', 'planning-paths.cjs'));
    failuresPath = pp.resolveWithFallback(path.dirname(planningDir), 'quorum-failures');
  } catch (_) {
    failuresPath = path.join(planningDir, 'quorum-failures.json');
  }
  if (fs.existsSync(failuresPath)) {
    try {
      const failures = JSON.parse(fs.readFileSync(failuresPath, 'utf-8'));
      if (Array.isArray(failures)) {
        for (const entry of failures) {
          if (typeof entry.count === 'number' && entry.count >= 3) {
            addIssue(
              'warning',
              'W008',
              `Quorum slot "${entry.slot}" has ${entry.count} recurring failures (${entry.error_type})`,
              `Review slot "${entry.slot}" availability. Check .planning/quorum-failures.json for details.`
            );
          }
        }
      }
    } catch {}
  }

  // ─── Perform repairs if requested ─────────────────────────────────────────
  const repairActions = [];
  if (options.repair && repairs.length > 0) {
    for (const repair of repairs) {
      try {
        switch (repair) {
          case 'createConfig':
          case 'resetConfig': {
            const defaults = {
              model_profile: 'balanced',
              commit_docs: true,
              search_gitignored: false,
              branching_strategy: 'none',
              research: true,
              plan_checker: true,
              verifier: true,
              parallelization: true,
            };
            fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), 'utf-8');
            repairActions.push({ action: repair, success: true, path: 'config.json' });
            break;
          }
          case 'regenerateState': {
            // Content-length safety gate — prevent silent overwrite of rich STATE.md
            if (fs.existsSync(statePath)) {
              const existingContent = fs.readFileSync(statePath, 'utf-8');
              const lineCount = existingContent.split('\n').length;
              const SAFE_LINE_THRESHOLD = 50;
              if (lineCount > SAFE_LINE_THRESHOLD && !options.force) {
                repairActions.push({
                  action: 'regenerateState',
                  success: false,
                  skipped: true,
                  reason: `STATE.md has ${lineCount} lines (threshold: ${SAFE_LINE_THRESHOLD}). Re-run with --force to overwrite.`,
                });
                break;
              }
            }
            // Create timestamped backup before overwriting
            if (fs.existsSync(statePath)) {
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              const backupPath = `${statePath}.bak-${timestamp}`;
              fs.copyFileSync(statePath, backupPath);
              repairActions.push({ action: 'backupState', success: true, path: backupPath });
            }
            // Generate minimal STATE.md from ROADMAP.md structure
            const milestone = getMilestoneInfo(cwd);
            let stateContent = `# Session State\n\n`;
            stateContent += `## Project Reference\n\n`;
            stateContent += `See: .planning/PROJECT.md\n\n`;
            stateContent += `## Position\n\n`;
            stateContent += `**Milestone:** ${milestone.version} ${milestone.name}\n`;
            stateContent += `**Current phase:** (determining...)\n`;
            stateContent += `**Status:** Resuming\n\n`;
            stateContent += `## Session Log\n\n`;
            stateContent += `- ${new Date().toISOString().split('T')[0]}: STATE.md regenerated by /nf:health --repair\n`;
            fs.writeFileSync(statePath, stateContent, 'utf-8');
            repairActions.push({ action: repair, success: true, path: 'STATE.md' });
            break;
          }
        }
      } catch (err) {
        repairActions.push({ action: repair, success: false, error: err.message });
      }
    }
  }

  // ─── Determine overall status ─────────────────────────────────────────────
  let status;
  if (errors.length > 0) {
    status = 'broken';
  } else if (warnings.length > 0) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  const repairableCount = errors.filter(e => e.repairable).length +
                         warnings.filter(w => w.repairable).length;

  output({
    status,
    errors,
    warnings,
    info,
    repairable_count: repairableCount,
    repairs_performed: repairActions.length > 0 ? repairActions : undefined,
  }, raw);
}

// ─── Progress Render ──────────────────────────────────────────────────────────

function cmdProgressRender(cwd, format, raw) {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  const milestone = getMilestoneInfo(cwd);

  const phases = [];
  let totalPlans = 0;
  let totalSummaries = 0;

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => {
      const aNum = parseFloat(a.match(/^(\d+(?:\.\d+)?)/)?.[1] || '0');
      const bNum = parseFloat(b.match(/^(\d+(?:\.\d+)?)/)?.[1] || '0');
      return aNum - bNum;
    });

    for (const dir of dirs) {
      const dm = dir.match(/^(\d+(?:\.\d+)?)-?(.*)/);
      const phaseNum = dm ? dm[1] : dir;
      const phaseName = dm && dm[2] ? dm[2].replace(/-/g, ' ') : '';
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md').length;
      const summaries = phaseFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md').length;

      totalPlans += plans;
      totalSummaries += summaries;

      let status;
      if (plans === 0) status = 'Pending';
      else if (summaries >= plans) status = 'Complete';
      else if (summaries > 0) status = 'In Progress';
      else status = 'Planned';

      phases.push({ number: phaseNum, name: phaseName, plans, summaries, status });
    }
  } catch {}

  const percent = totalPlans > 0 ? Math.round((totalSummaries / totalPlans) * 100) : 0;

  if (format === 'table') {
    // Render markdown table
    const barWidth = 10;
    const filled = Math.max(0, Math.min(barWidth, Math.round((percent / 100) * barWidth)));
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
    let out = `# ${milestone.version} ${milestone.name}\n\n`;
    out += `**Progress:** [${bar}] ${totalSummaries}/${totalPlans} plans (${percent}%)\n\n`;
    out += `| Phase | Name | Plans | Status |\n`;
    out += `|-------|------|-------|--------|\n`;
    for (const p of phases) {
      out += `| ${p.number} | ${p.name} | ${p.summaries}/${p.plans} | ${p.status} |\n`;
    }
    output({ rendered: out }, raw, out);
  } else if (format === 'bar') {
    const barWidth = 20;
    const filled = Math.max(0, Math.min(barWidth, Math.round((percent / 100) * barWidth)));
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
    const text = `[${bar}] ${totalSummaries}/${totalPlans} plans (${percent}%)`;
    output({ bar: text, percent, completed: totalSummaries, total: totalPlans }, raw, text);
  } else {
    // JSON format
    output({
      milestone_version: milestone.version,
      milestone_name: milestone.name,
      phases,
      total_plans: totalPlans,
      total_summaries: totalSummaries,
      percent,
    }, raw);
  }
}

// ─── Todo Complete ────────────────────────────────────────────────────────────

function cmdTodoComplete(cwd, filename, raw) {
  if (!filename) {
    error('filename required for todo complete');
  }

  const pendingDir = path.join(cwd, '.planning', 'todos', 'pending');
  const completedDir = path.join(cwd, '.planning', 'todos', 'completed');
  const sourcePath = path.join(pendingDir, filename);

  if (!fs.existsSync(sourcePath)) {
    error(`Todo not found: ${filename}`);
  }

  // Ensure completed directory exists
  fs.mkdirSync(completedDir, { recursive: true });

  // Read, add completion timestamp, move
  let content = fs.readFileSync(sourcePath, 'utf-8');
  const today = new Date().toISOString().split('T')[0];
  content = `completed: ${today}\n` + content;

  fs.writeFileSync(path.join(completedDir, filename), content, 'utf-8');
  fs.unlinkSync(sourcePath);

  output({ completed: true, file: filename, date: today }, raw, 'completed');
}

// ─── Scaffold ─────────────────────────────────────────────────────────────────

function cmdScaffold(cwd, type, options, raw) {
  const { phase, name } = options;
  const padded = phase ? normalizePhaseName(phase) : '00';
  const today = new Date().toISOString().split('T')[0];

  // Find phase directory
  const phaseInfo = phase ? findPhaseInternal(cwd, phase) : null;
  const phaseDir = phaseInfo ? path.join(cwd, phaseInfo.directory) : null;

  if (phase && !phaseDir && type !== 'phase-dir') {
    error(`Phase ${phase} directory not found`);
  }

  let filePath, content;

  switch (type) {
    case 'context': {
      filePath = path.join(phaseDir, `${padded}-CONTEXT.md`);
      content = `---\nphase: "${padded}"\nname: "${name || phaseInfo?.phase_name || 'Unnamed'}"\ncreated: ${today}\n---\n\n# Phase ${phase}: ${name || phaseInfo?.phase_name || 'Unnamed'} — Context\n\n## Decisions\n\n_Decisions will be captured during /nf:discuss-phase ${phase}_\n\n## Discretion Areas\n\n_Areas where the executor can use judgment_\n\n## Deferred Ideas\n\n_Ideas to consider later_\n`;
      break;
    }
    case 'uat': {
      filePath = path.join(phaseDir, `${padded}-UAT.md`);
      content = `---\nphase: "${padded}"\nname: "${name || phaseInfo?.phase_name || 'Unnamed'}"\ncreated: ${today}\nstatus: pending\n---\n\n# Phase ${phase}: ${name || phaseInfo?.phase_name || 'Unnamed'} — User Acceptance Testing\n\n## Test Results\n\n| # | Test | Status | Notes |\n|---|------|--------|-------|\n\n## Summary\n\n_Pending UAT_\n`;
      break;
    }
    case 'verification': {
      filePath = path.join(phaseDir, `${padded}-VERIFICATION.md`);
      content = `---\nphase: "${padded}"\nname: "${name || phaseInfo?.phase_name || 'Unnamed'}"\ncreated: ${today}\nstatus: pending\n---\n\n# Phase ${phase}: ${name || phaseInfo?.phase_name || 'Unnamed'} — Verification\n\n## Goal-Backward Verification\n\n**Phase Goal:** [From ROADMAP.md]\n\n## Checks\n\n| # | Requirement | Status | Evidence |\n|---|------------|--------|----------|\n\n## Result\n\n_Pending verification_\n`;
      break;
    }
    case 'phase-dir': {
      if (!phase || !name) {
        error('phase and name required for phase-dir scaffold');
      }
      const slug = generateSlugInternal(name);
      const dirName = `${padded}-${slug}`;
      const phasesParent = path.join(cwd, '.planning', 'phases');
      fs.mkdirSync(phasesParent, { recursive: true });
      const dirPath = path.join(phasesParent, dirName);
      fs.mkdirSync(dirPath, { recursive: true });
      output({ created: true, directory: `.planning/phases/${dirName}`, path: dirPath }, raw, dirPath);
      return;
    }
    default:
      error(`Unknown scaffold type: ${type}. Available: context, uat, verification, phase-dir`);
  }

  if (fs.existsSync(filePath)) {
    output({ created: false, reason: 'already_exists', path: filePath }, raw, 'exists');
    return;
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  const relPath = path.relative(cwd, filePath);
  output({ created: true, path: relPath }, raw, relPath);
}

// ─── Compound Commands ────────────────────────────────────────────────────────

function resolveModelInternal(cwd, agentType) {
  const config = loadConfig(cwd);

  // Check per-agent override first
  const override = config.model_overrides?.[agentType];
  if (override) {
    return override === 'opus' ? 'inherit' : override;
  }

  // NEW: Tier lookup (after per-agent override, before profile fallback)
  // Maps agent types to cost tiers: planner (high-value) vs worker (repetitive/cheap)
  const agentToTier = {
    'nf-planner': 'planner',
    'nf-roadmapper': 'planner',
    'nf-phase-researcher': 'worker',
    'nf-plan-checker': 'worker',
    'nf-executor': 'worker',
    'nf-verifier': 'worker',
    'nf-codebase-mapper': 'worker',
    'nf-project-researcher': 'worker',
    'nf-research-synthesizer': 'worker',
    'nf-debugger': 'worker',
  };
  const tier = agentToTier[agentType] || 'worker';
  const tierKey = 'model_tier_' + tier; // 'model_tier_planner' or 'model_tier_worker'
  const tierModel = config[tierKey];
  if (tierModel && ['haiku', 'sonnet', 'opus'].includes(tierModel)) {
    return tierModel === 'opus' ? 'inherit' : tierModel;
  }

  // Fall back to profile lookup
  const profile = config.model_profile || 'balanced';
  const agentModels = MODEL_PROFILES[agentType];
  if (!agentModels) return 'sonnet';
  const resolved = agentModels[profile] || agentModels['balanced'] || 'sonnet';
  return resolved === 'opus' ? 'inherit' : resolved;
}

function getArchivedPhaseDirs(cwd) {
  const milestonesDir = path.join(cwd, '.planning', 'milestones');
  const results = [];

  if (!fs.existsSync(milestonesDir)) return results;

  try {
    const milestoneEntries = fs.readdirSync(milestonesDir, { withFileTypes: true });
    // Find v*-phases directories, sort newest first
    const phaseDirs = milestoneEntries
      .filter(e => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse();

    for (const archiveName of phaseDirs) {
      const version = archiveName.match(/^(v[\d.]+)-phases$/)[1];
      const archivePath = path.join(milestonesDir, archiveName);
      const entries = fs.readdirSync(archivePath, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();

      for (const dir of dirs) {
        results.push({
          name: dir,
          milestone: version,
          basePath: path.join('.planning', 'milestones', archiveName),
          fullPath: path.join(archivePath, dir),
        });
      }
    }
  } catch {}

  return results;
}

function searchPhaseInDir(baseDir, relBase, normalized) {
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    const match = dirs.find(d => d.startsWith(normalized));
    if (!match) return null;

    const dirMatch = match.match(/^(\d+(?:\.\d+)?)-?(.*)/);
    const phaseNumber = dirMatch ? dirMatch[1] : normalized;
    const phaseName = dirMatch && dirMatch[2] ? dirMatch[2] : null;
    const phaseDir = path.join(baseDir, match);
    const phaseFiles = fs.readdirSync(phaseDir);

    const plans = phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md').sort();
    const summaries = phaseFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md').sort();
    const hasResearch = phaseFiles.some(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md');
    const hasContext = phaseFiles.some(f => f.endsWith('-CONTEXT.md') || f === 'CONTEXT.md');
    const hasVerification = phaseFiles.some(f => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md');

    const completedPlanIds = new Set(
      summaries.map(s => s.replace('-SUMMARY.md', '').replace('SUMMARY.md', ''))
    );
    const incompletePlans = plans.filter(p => {
      const planId = p.replace('-PLAN.md', '').replace('PLAN.md', '');
      return !completedPlanIds.has(planId);
    });

    return {
      found: true,
      directory: path.join(relBase, match),
      phase_number: phaseNumber,
      phase_name: phaseName,
      phase_slug: phaseName ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null,
      plans,
      summaries,
      incomplete_plans: incompletePlans,
      has_research: hasResearch,
      has_context: hasContext,
      has_verification: hasVerification,
    };
  } catch {
    return null;
  }
}

function findPhaseInternal(cwd, phase) {
  if (!phase) return null;

  const phasesDir = path.join(cwd, '.planning', 'phases');
  const normalized = normalizePhaseName(phase);

  // Search current phases first
  const current = searchPhaseInDir(phasesDir, path.join('.planning', 'phases'), normalized);
  if (current) return current;

  // Search archived milestone phases (newest first)
  const milestonesDir = path.join(cwd, '.planning', 'milestones');
  if (!fs.existsSync(milestonesDir)) return null;

  try {
    const milestoneEntries = fs.readdirSync(milestonesDir, { withFileTypes: true });
    const archiveDirs = milestoneEntries
      .filter(e => e.isDirectory() && /^v[\d.]+-phases$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse();

    for (const archiveName of archiveDirs) {
      const version = archiveName.match(/^(v[\d.]+)-phases$/)[1];
      const archivePath = path.join(milestonesDir, archiveName);
      const relBase = path.join('.planning', 'milestones', archiveName);
      const result = searchPhaseInDir(archivePath, relBase, normalized);
      if (result) {
        result.archived = version;
        return result;
      }
    }
  } catch {}

  return null;
}

function getRoadmapPhaseInternal(cwd, phaseNum) {
  if (!phaseNum) return null;
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!fs.existsSync(roadmapPath)) return null;

  try {
    const content = fs.readFileSync(roadmapPath, 'utf-8');
    const escapedPhase = phaseNum.toString().replace(/\./g, '\\.');
    const phasePattern = new RegExp(`#{2,4}\\s*Phase\\s+${escapedPhase}:\\s*([^\\n]+)`, 'i');
    const headerMatch = content.match(phasePattern);
    if (!headerMatch) return null;

    const phaseName = headerMatch[1].trim();
    const headerIndex = headerMatch.index;
    const restOfContent = content.slice(headerIndex);
    const nextHeaderMatch = restOfContent.match(/\n#{2,4}\s+Phase\s+\d/i);
    const sectionEnd = nextHeaderMatch ? headerIndex + nextHeaderMatch.index : content.length;
    const section = content.slice(headerIndex, sectionEnd).trim();

    const goal = extractGoalFromSection(section);

    return {
      found: true,
      phase_number: phaseNum.toString(),
      phase_name: phaseName,
      goal,
      section,
    };
  } catch {
    return null;
  }
}

function pathExistsInternal(cwd, targetPath) {
  const fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath);
  try {
    fs.statSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

function generateSlugInternal(text) {
  if (!text) return null;
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function getMilestoneInfo(cwd) {
  // Prefer project config default_milestone when present (allows work without ROADMAP.md)
  try {
    const cfg = loadConfig(cwd);
    if (cfg && cfg.default_milestone && typeof cfg.default_milestone === 'string') {
      const dm = cfg.default_milestone.trim();
      if (dm && dm.toLowerCase() !== 'auto') {
        // Accept formats: "v0.9", "v0.9 Name...", or "v0.9: Name"
        const m = dm.match(/^(v?\d+\.\d+)(?:[:\s-]+(.+))?$/i);
        if (m) {
          const ver = m[1].toLowerCase().startsWith('v') ? m[1].toLowerCase() : 'v' + m[1];
          const name = m[2] ? m[2].trim() : 'milestone';
          return { version: ver, name };
        }
      }
    }
  } catch {}

  // 1. Try STATE.md — authoritative source for current milestone
  try {
    const state = fs.readFileSync(path.join(cwd, '.planning', 'STATE.md'), 'utf-8');
    // "**Current focus:** v28.0 Provider-Agnostic E2E Testing"
    const focusMatch = state.match(/\*\*Current focus:\*\*\s*v(\d+\.\d+)\s+([^\n]+)/);
    if (focusMatch) {
      return { version: 'v' + focusMatch[1], name: focusMatch[2].trim() };
    }
    // "Milestone: v0.35 — Install & Setup Bug Fixes — SHIPPED ..."
    const milestoneMatch = state.match(/Milestone:\s*v(\d+\.\d+)\s*[—–-]\s*([^—–\-\n]+)/);
    if (milestoneMatch) {
      return { version: 'v' + milestoneMatch[1], name: milestoneMatch[2].trim() };
    }
  } catch {}

  // 2. Fallback to ROADMAP.md — use LAST listed milestone (not first)
  try {
    const roadmap = fs.readFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), 'utf-8');
    const allVersions = [...roadmap.matchAll(/\*\*v(\d+\.\d+)\s+([^*]+)\*\*/g)];
    if (allVersions.length > 0) {
      const last = allVersions[allVersions.length - 1];
      return { version: 'v' + last[1], name: last[2].trim() };
    }
    // Bare fallback — first v#.# found
    const versionMatch = roadmap.match(/v(\d+\.\d+)/);
    const nameMatch = roadmap.match(/## .*v\d+\.\d+[:\s]+([^\n(]+)/);
    return {
      version: versionMatch ? versionMatch[0] : 'v1.0',
      name: nameMatch ? nameMatch[1].trim() : 'milestone',
    };
  } catch {
    return { version: 'v1.0', name: 'milestone' };
  }
}

function cmdInitExecutePhase(cwd, phase, raw) {
  if (!phase) {
    error('phase required for init execute-phase');
  }

  const config = loadConfig(cwd);
  const phaseInfo = findPhaseInternal(cwd, phase);
  const milestone = getMilestoneInfo(cwd);

  const result = {
    // Models
    executor_model: resolveModelInternal(cwd, 'nf-executor'),
    verifier_model: resolveModelInternal(cwd, 'nf-verifier'),

    // Config flags
    commit_docs: config.commit_docs,
    parallelization: config.parallelization,
    branching_strategy: config.branching_strategy,
    phase_branch_template: config.phase_branch_template,
    milestone_branch_template: config.milestone_branch_template,
    verifier_enabled: config.verifier,

    // Phase info
    phase_found: !!phaseInfo,
    phase_dir: phaseInfo?.directory || null,
    phase_number: phaseInfo?.phase_number || null,
    phase_name: phaseInfo?.phase_name || null,
    phase_slug: phaseInfo?.phase_slug || null,

    // Plan inventory
    plans: phaseInfo?.plans || [],
    summaries: phaseInfo?.summaries || [],
    incomplete_plans: phaseInfo?.incomplete_plans || [],
    plan_count: phaseInfo?.plans?.length || 0,
    incomplete_count: phaseInfo?.incomplete_plans?.length || 0,

    // Branch name (pre-computed)
    branch_name: config.branching_strategy === 'phase' && phaseInfo
      ? config.phase_branch_template
          .replace('{phase}', phaseInfo.phase_number)
          .replace('{slug}', phaseInfo.phase_slug || 'phase')
      : config.branching_strategy === 'milestone'
        ? config.milestone_branch_template
            .replace('{milestone}', milestone.version)
            .replace('{slug}', generateSlugInternal(milestone.name) || 'milestone')
        : null,

    // Milestone info
    milestone_version: milestone.version,
    milestone_name: milestone.name,
    milestone_slug: generateSlugInternal(milestone.name),

    // File existence
    state_exists: pathExistsInternal(cwd, '.planning/STATE.md'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    config_exists: pathExistsInternal(cwd, '.planning/config.json'),
    // File paths
    state_path: '.planning/STATE.md',
    roadmap_path: '.planning/ROADMAP.md',
    config_path: '.planning/config.json',
  };

  output(result, raw);
}

function cmdInitPlanPhase(cwd, phase, raw) {
  if (!phase) {
    error('phase required for init plan-phase');
  }

  const config = loadConfig(cwd);
  const phaseInfo = findPhaseInternal(cwd, phase);

  const result = {
    // Models
    researcher_model: resolveModelInternal(cwd, 'nf-phase-researcher'),
    planner_model: resolveModelInternal(cwd, 'nf-planner'),
    checker_model: resolveModelInternal(cwd, 'nf-plan-checker'),

    // Workflow flags
    research_enabled: config.research,
    plan_checker_enabled: config.plan_checker,
    nyquist_validation_enabled: config.nyquist_validation,
    commit_docs: config.commit_docs,

    // Phase info
    phase_found: !!phaseInfo,
    phase_dir: phaseInfo?.directory || null,
    phase_number: phaseInfo?.phase_number || null,
    phase_name: phaseInfo?.phase_name || null,
    phase_slug: phaseInfo?.phase_slug || null,
    padded_phase: phaseInfo?.phase_number?.padStart(2, '0') || null,

    // Existing artifacts
    has_research: phaseInfo?.has_research || false,
    has_context: phaseInfo?.has_context || false,
    has_plans: (phaseInfo?.plans?.length || 0) > 0,
    plan_count: phaseInfo?.plans?.length || 0,

    // Environment
    planning_exists: pathExistsInternal(cwd, '.planning'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),

    // File paths
    state_path: '.planning/STATE.md',
    roadmap_path: '.planning/ROADMAP.md',
    requirements_path: '.planning/REQUIREMENTS.md',
  };

  if (phaseInfo?.directory) {
    // Find *-CONTEXT.md in phase directory
    const phaseDirFull = path.join(cwd, phaseInfo.directory);
    try {
      const files = fs.readdirSync(phaseDirFull);
      const contextFile = files.find(f => f.endsWith('-CONTEXT.md') || f === 'CONTEXT.md');
      if (contextFile) {
        result.context_path = path.join(phaseInfo.directory, contextFile);
      }
      const researchFile = files.find(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md');
      if (researchFile) {
        result.research_path = path.join(phaseInfo.directory, researchFile);
      }
      const verificationFile = files.find(f => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md');
      if (verificationFile) {
        result.verification_path = path.join(phaseInfo.directory, verificationFile);
      }
      const uatFile = files.find(f => f.endsWith('-UAT.md') || f === 'UAT.md');
      if (uatFile) {
        result.uat_path = path.join(phaseInfo.directory, uatFile);
      }
    } catch {}
  }

  output(result, raw);
}

function cmdInitNewProject(cwd, raw) {
  const config = loadConfig(cwd);

  // Detect Brave Search API key availability
  const homedir = require('os').homedir();
  const braveKeyFile = path.join(homedir, '.nf', 'brave_api_key');
  const hasBraveSearch = !!(process.env.BRAVE_API_KEY || fs.existsSync(braveKeyFile));

  // Detect existing code
  let hasCode = false;
  let hasPackageFile = false;
  try {
    const files = execSync('find . -maxdepth 3 \\( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.swift" -o -name "*.java" \\) 2>/dev/null | grep -v node_modules | grep -v .git | head -5', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    hasCode = files.trim().length > 0;
  } catch {}

  hasPackageFile = pathExistsInternal(cwd, 'package.json') ||
                   pathExistsInternal(cwd, 'requirements.txt') ||
                   pathExistsInternal(cwd, 'Cargo.toml') ||
                   pathExistsInternal(cwd, 'go.mod') ||
                   pathExistsInternal(cwd, 'Package.swift');

  const result = {
    // Models
    researcher_model: resolveModelInternal(cwd, 'nf-project-researcher'),
    synthesizer_model: resolveModelInternal(cwd, 'nf-research-synthesizer'),
    roadmapper_model: resolveModelInternal(cwd, 'nf-roadmapper'),

    // Config
    commit_docs: config.commit_docs,

    // Existing state
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    has_codebase_map: pathExistsInternal(cwd, '.planning/codebase'),
    planning_exists: pathExistsInternal(cwd, '.planning'),

    // Brownfield detection
    has_existing_code: hasCode,
    has_package_file: hasPackageFile,
    is_brownfield: hasCode || hasPackageFile,
    needs_codebase_map: (hasCode || hasPackageFile) && !pathExistsInternal(cwd, '.planning/codebase'),

    // Git state
    has_git: pathExistsInternal(cwd, '.git'),

    // Enhanced search
    brave_search_available: hasBraveSearch,

    // File paths
    project_path: '.planning/PROJECT.md',
  };

  output(result, raw);
}

function cmdInitNewMilestone(cwd, raw) {
  const config = loadConfig(cwd);
  const milestone = getMilestoneInfo(cwd);

  const result = {
    // Models
    researcher_model: resolveModelInternal(cwd, 'nf-project-researcher'),
    synthesizer_model: resolveModelInternal(cwd, 'nf-research-synthesizer'),
    roadmapper_model: resolveModelInternal(cwd, 'nf-roadmapper'),

    // Config
    commit_docs: config.commit_docs,
    research_enabled: config.research,

    // Current milestone
    current_milestone: milestone.version,
    current_milestone_name: milestone.name,

    // File existence
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    state_exists: pathExistsInternal(cwd, '.planning/STATE.md'),

    // File paths
    project_path: '.planning/PROJECT.md',
    roadmap_path: '.planning/ROADMAP.md',
    state_path: '.planning/STATE.md',
  };

  output(result, raw);
}

function acquireInitLock(quickDir, timeoutMs) {
  if (!fs.existsSync(quickDir)) {
    fs.mkdirSync(quickDir, { recursive: true });
  }
  const lockPath = path.join(quickDir, '.init-lock');
  const staleTtlMs = 5 * 60 * 1000;
  const isProcessRunning = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const cleanupStale = () => {
    try {
      if (!fs.existsSync(lockPath)) return;
      const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const ageMs = Date.now() - new Date(content.ts).getTime();
      if (!isProcessRunning(content.pid) || ageMs > staleTtlMs) {
        try { fs.unlinkSync(lockPath); } catch {}
      }
    } catch { try { fs.unlinkSync(lockPath); } catch {} }
  };
  const startTime = Date.now();
  const backoffMs = [50, 100, 200, 400, 800, 1600, 3200];
  let attempt = 0;
  while (true) {
    cleanupStale();
    try {
      const lockContent = JSON.stringify({ pid: process.pid, ts: new Date().toISOString() });
      fs.writeFileSync(lockPath, lockContent, { flag: 'wx' });
      return { acquired: true, lockPath, release: () => { try { fs.unlinkSync(lockPath); } catch {} } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (Date.now() - startTime >= timeoutMs) {
      return { acquired: false, lockPath: null, release: () => {} };
    }
    const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)];
    const jitter = Math.floor(Math.random() * 50);
    const sleepMs = Math.min(delay + jitter, timeoutMs - (Date.now() - startTime));
    if (sleepMs > 0) { const end = Date.now() + sleepMs; while (Date.now() < end) {} }
    attempt++;
  }
}

function cmdInitQuick(cwd, description, raw) {
  const config = loadConfig(cwd);
  const now = new Date();
  const slug = description ? generateSlugInternal(description)?.substring(0, 40) : null;

  const quickDir = path.join(cwd, '.planning', 'quick');
  const INIT_LOCK_TIMEOUT_MS = 10000;
  const lock = acquireInitLock(quickDir, INIT_LOCK_TIMEOUT_MS);
  if (!lock.acquired) {
    process.stderr.write(
      `[init-quick] ERROR: Could not acquire init lock within ${INIT_LOCK_TIMEOUT_MS / 1000}s. ` +
      `Another /nf:quick invocation appears to be initializing. Wait a few seconds and retry.\n`
    );
    process.exit(1);
  }
  let nextNum = 1;
  try {
    try {
      const existing = fs.readdirSync(quickDir)
        .filter(f => /^\d+-/.test(f))
        .map(f => parseInt(f.split('-')[0], 10))
        .filter(n => !isNaN(n));
      if (existing.length > 0) {
        nextNum = Math.max(...existing) + 1;
      }
    } catch {}

    if (slug) {
      const taskDir = path.join(quickDir, `${nextNum}-${slug}`);
      fs.mkdirSync(taskDir, { recursive: true });
      const claimedPath = path.join(taskDir, '.claimed');
      fs.writeFileSync(claimedPath, JSON.stringify({ pid: process.pid, ts: now.toISOString(), task_id: nextNum }));
    }

    const collisionDirs = fs.readdirSync(quickDir).filter(f => f.startsWith(`${nextNum}-`) && /^\d+-/.test(f));
    if (collisionDirs.length > 1) {
      process.stderr.write(
        `[init-quick] WARNING: task_id ${nextNum} has ${collisionDirs.length} directories. ` +
        `This should not happen. Directories: ${collisionDirs.join(', ')}\n`
      );
    }
  } finally {
    lock.release();
  }

  // Branch detection: detect current branch
  let currentBranch = 'unknown';
  try {
    currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8' }).trim();
  } catch {}

  // Detect remote default branch
  let defaultBranch = null;
  try {
    const refLine = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd, encoding: 'utf-8' }).trim();
    defaultBranch = refLine.replace('refs/remotes/origin/', '');
  } catch {}

  // Build protected branches set
  const protectedBranchList = defaultBranch ? [defaultBranch] : ['main', 'master'];
  if (config.additional_protected_branches && Array.isArray(config.additional_protected_branches)) {
    protectedBranchList.push(...config.additional_protected_branches);
  }
  const protectedBranches = Array.from(new Set(protectedBranchList));

  // Check if current branch is protected
  let isProtected = false;
  for (const pattern of protectedBranches) {
    if (pattern.includes('*')) {
      // Convert glob pattern to regex
      const regexPattern = pattern.replace(/\*/g, '.*');
      const regex = new RegExp(`^${regexPattern}$`);
      if (regex.test(currentBranch)) {
        isProtected = true;
        break;
      }
    } else {
      // Exact string match
      if (currentBranch === pattern) {
        isProtected = true;
        break;
      }
    }
  }

  // Compute quick branch name
  let quickBranchName = null;
  if (isProtected) {
    const number = String(nextNum);
    const taskSlug = slug || 'task';
    quickBranchName = config.quick_branch_template
      .replace('{number}', number)
      .replace('{slug}', taskSlug);
  }

  const result = {
    // Models
    planner_model: resolveModelInternal(cwd, 'nf-planner'),
    executor_model: resolveModelInternal(cwd, 'nf-executor'),
    checker_model: resolveModelInternal(cwd, 'nf-plan-checker'),
    verifier_model: resolveModelInternal(cwd, 'nf-verifier'),

    // Config
    commit_docs: config.commit_docs,

    // Quick task info
    next_num: nextNum,
    slug: slug,
    description: description || null,

    // Timestamps
    date: now.toISOString().split('T')[0],
    timestamp: now.toISOString(),

    // Paths
    quick_dir: '.planning/quick',
    task_dir: slug ? `.planning/quick/${nextNum}-${slug}` : null,

    // File existence
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    planning_exists: pathExistsInternal(cwd, '.planning'),

    // Milestone context (may come from config.default_milestone or STATE/ROADMAP)
    chosen_milestone: null,
    default_milestone_used: false,

    // Branch detection
    current_branch: currentBranch,
    is_protected: isProtected,
    quick_branch_name: quickBranchName,
    protected_branches: protectedBranches,
  };

  // Populate milestone context (only if a real source exists: config, STATE.md, or ROADMAP.md)
  try {
    // Check if a real milestone source exists
    const hasConfig = config.default_milestone && typeof config.default_milestone === 'string' && config.default_milestone.trim() && config.default_milestone.trim().toLowerCase() !== 'auto';
    const hasState = pathExistsInternal(cwd, '.planning/STATE.md');
    const hasRoadmap = pathExistsInternal(cwd, '.planning/ROADMAP.md');

    if (hasConfig || hasState || hasRoadmap) {
      const milestone = getMilestoneInfo(cwd);
      if (milestone && milestone.version) {
        result.chosen_milestone = milestone.version;
        if (hasConfig) {
          result.default_milestone_used = true;
        }
      }
    }
  } catch {}

  output(result, raw);
}

function cmdInitResume(cwd, raw) {
  const config = loadConfig(cwd);

  // Check for interrupted agent
  let interruptedAgentId = null;
  try {
    interruptedAgentId = fs.readFileSync(path.join(cwd, '.planning', 'current-agent-id.txt'), 'utf-8').trim();
  } catch {}

  const result = {
    // File existence
    state_exists: pathExistsInternal(cwd, '.planning/STATE.md'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    planning_exists: pathExistsInternal(cwd, '.planning'),

    // File paths
    state_path: '.planning/STATE.md',
    roadmap_path: '.planning/ROADMAP.md',
    project_path: '.planning/PROJECT.md',

    // Agent state
    has_interrupted_agent: !!interruptedAgentId,
    interrupted_agent_id: interruptedAgentId,

    // Config
    commit_docs: config.commit_docs,
  };

  output(result, raw);
}

function cmdInitVerifyWork(cwd, phase, raw) {
  if (!phase) {
    error('phase required for init verify-work');
  }

  const config = loadConfig(cwd);
  const phaseInfo = findPhaseInternal(cwd, phase);

  const result = {
    // Models
    planner_model: resolveModelInternal(cwd, 'nf-planner'),
    checker_model: resolveModelInternal(cwd, 'nf-plan-checker'),

    // Config
    commit_docs: config.commit_docs,

    // Phase info
    phase_found: !!phaseInfo,
    phase_dir: phaseInfo?.directory || null,
    phase_number: phaseInfo?.phase_number || null,
    phase_name: phaseInfo?.phase_name || null,

    // Existing artifacts
    has_verification: phaseInfo?.has_verification || false,
  };

  output(result, raw);
}

function cmdInitPhaseOp(cwd, phase, raw) {
  const config = loadConfig(cwd);
  let phaseInfo = findPhaseInternal(cwd, phase);

  // Fallback to ROADMAP.md if no directory exists (e.g., Plans: TBD)
  if (!phaseInfo) {
    const roadmapPhase = getRoadmapPhaseInternal(cwd, phase);
    if (roadmapPhase?.found) {
      const phaseName = roadmapPhase.phase_name;
      phaseInfo = {
        found: true,
        directory: null,
        phase_number: roadmapPhase.phase_number,
        phase_name: phaseName,
        phase_slug: phaseName ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null,
        plans: [],
        summaries: [],
        incomplete_plans: [],
        has_research: false,
        has_context: false,
        has_verification: false,
      };
    }
  }

  const result = {
    // Config
    commit_docs: config.commit_docs,
    brave_search: config.brave_search,

    // Phase info
    phase_found: !!phaseInfo,
    phase_dir: phaseInfo?.directory || null,
    phase_number: phaseInfo?.phase_number || null,
    phase_name: phaseInfo?.phase_name || null,
    phase_slug: phaseInfo?.phase_slug || null,
    padded_phase: phaseInfo?.phase_number?.padStart(2, '0') || null,

    // Existing artifacts
    has_research: phaseInfo?.has_research || false,
    has_context: phaseInfo?.has_context || false,
    has_plans: (phaseInfo?.plans?.length || 0) > 0,
    has_verification: phaseInfo?.has_verification || false,
    plan_count: phaseInfo?.plans?.length || 0,

    // File existence
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    planning_exists: pathExistsInternal(cwd, '.planning'),

    // File paths
    state_path: '.planning/STATE.md',
    roadmap_path: '.planning/ROADMAP.md',
    requirements_path: '.planning/REQUIREMENTS.md',
  };

  if (phaseInfo?.directory) {
    const phaseDirFull = path.join(cwd, phaseInfo.directory);
    try {
      const files = fs.readdirSync(phaseDirFull);
      const contextFile = files.find(f => f.endsWith('-CONTEXT.md') || f === 'CONTEXT.md');
      if (contextFile) {
        result.context_path = path.join(phaseInfo.directory, contextFile);
      }
      const researchFile = files.find(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md');
      if (researchFile) {
        result.research_path = path.join(phaseInfo.directory, researchFile);
      }
      const verificationFile = files.find(f => f.endsWith('-VERIFICATION.md') || f === 'VERIFICATION.md');
      if (verificationFile) {
        result.verification_path = path.join(phaseInfo.directory, verificationFile);
      }
      const uatFile = files.find(f => f.endsWith('-UAT.md') || f === 'UAT.md');
      if (uatFile) {
        result.uat_path = path.join(phaseInfo.directory, uatFile);
      }
    } catch {}
  }

  output(result, raw);
}

function cmdInitTodos(cwd, area, raw) {
  const config = loadConfig(cwd);
  const now = new Date();

  // List todos (reuse existing logic)
  const pendingDir = path.join(cwd, '.planning', 'todos', 'pending');
  let count = 0;
  const todos = [];

  try {
    const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(pendingDir, file), 'utf-8');
        const createdMatch = content.match(/^created:\s*(.+)$/m);
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        const areaMatch = content.match(/^area:\s*(.+)$/m);
        const todoArea = areaMatch ? areaMatch[1].trim() : 'general';

        if (area && todoArea !== area) continue;

        count++;
        todos.push({
          file,
          created: createdMatch ? createdMatch[1].trim() : 'unknown',
          title: titleMatch ? titleMatch[1].trim() : 'Untitled',
          area: todoArea,
          path: path.join('.planning', 'todos', 'pending', file),
        });
      } catch {}
    }
  } catch {}

  const result = {
    // Config
    commit_docs: config.commit_docs,

    // Timestamps
    date: now.toISOString().split('T')[0],
    timestamp: now.toISOString(),

    // Todo inventory
    todo_count: count,
    todos,
    area_filter: area || null,

    // Paths
    pending_dir: '.planning/todos/pending',
    completed_dir: '.planning/todos/completed',

    // File existence
    planning_exists: pathExistsInternal(cwd, '.planning'),
    todos_dir_exists: pathExistsInternal(cwd, '.planning/todos'),
    pending_dir_exists: pathExistsInternal(cwd, '.planning/todos/pending'),
  };

  output(result, raw);
}

function cmdInitMilestoneOp(cwd, raw) {
  const config = loadConfig(cwd);
  const milestone = getMilestoneInfo(cwd);

  // Count phases
  let phaseCount = 0;
  let completedPhases = 0;
  const phasesDir = path.join(cwd, '.planning', 'phases');
  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    phaseCount = dirs.length;

    // Count phases with summaries (completed)
    for (const dir of dirs) {
      try {
        const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
        const hasSummary = phaseFiles.some(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
        if (hasSummary) completedPhases++;
      } catch {}
    }
  } catch {}

  // Check archive
  const archiveDir = path.join(cwd, '.planning', 'archive');
  let archivedMilestones = [];
  try {
    archivedMilestones = fs.readdirSync(archiveDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {}

  const result = {
    // Config
    commit_docs: config.commit_docs,

    // Current milestone
    milestone_version: milestone.version,
    milestone_name: milestone.name,
    milestone_slug: generateSlugInternal(milestone.name),

    // Phase counts
    phase_count: phaseCount,
    completed_phases: completedPhases,
    all_phases_complete: phaseCount > 0 && phaseCount === completedPhases,

    // Archive
    archived_milestones: archivedMilestones,
    archive_count: archivedMilestones.length,

    // File existence
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    state_exists: pathExistsInternal(cwd, '.planning/STATE.md'),
    archive_exists: pathExistsInternal(cwd, '.planning/archive'),
    phases_dir_exists: pathExistsInternal(cwd, '.planning/phases'),
  };

  output(result, raw);
}

function cmdInitMapCodebase(cwd, raw) {
  const config = loadConfig(cwd);

  // Check for existing codebase maps
  const codebaseDir = path.join(cwd, '.planning', 'codebase');
  let existingMaps = [];
  try {
    existingMaps = fs.readdirSync(codebaseDir).filter(f => f.endsWith('.md'));
  } catch {}

  const result = {
    // Models
    mapper_model: resolveModelInternal(cwd, 'nf-codebase-mapper'),

    // Config
    commit_docs: config.commit_docs,
    search_gitignored: config.search_gitignored,
    parallelization: config.parallelization,

    // Paths
    codebase_dir: '.planning/codebase',

    // Existing maps
    existing_maps: existingMaps,
    has_maps: existingMaps.length > 0,

    // File existence
    planning_exists: pathExistsInternal(cwd, '.planning'),
    codebase_dir_exists: pathExistsInternal(cwd, '.planning/codebase'),
  };

  output(result, raw);
}

function cmdInitProgress(cwd, raw) {
  const config = loadConfig(cwd);
  const milestone = getMilestoneInfo(cwd);

  // Analyze phases
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const phases = [];
  let currentPhase = null;
  let nextPhase = null;

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();

    for (const dir of dirs) {
      const match = dir.match(/^(\d+(?:\.\d+)?)-?(.*)/);
      const phaseNumber = match ? match[1] : dir;
      const phaseName = match && match[2] ? match[2] : null;

      const phasePath = path.join(phasesDir, dir);
      const phaseFiles = fs.readdirSync(phasePath);

      const plans = phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md');
      const summaries = phaseFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
      const hasResearch = phaseFiles.some(f => f.endsWith('-RESEARCH.md') || f === 'RESEARCH.md');

      const status = summaries.length >= plans.length && plans.length > 0 ? 'complete' :
                     plans.length > 0 ? 'in_progress' :
                     hasResearch ? 'researched' : 'pending';

      const phaseInfo = {
        number: phaseNumber,
        name: phaseName,
        directory: path.join('.planning', 'phases', dir),
        status,
        plan_count: plans.length,
        summary_count: summaries.length,
        has_research: hasResearch,
      };

      phases.push(phaseInfo);

      // Find current (first incomplete with plans) and next (first pending)
      if (!currentPhase && (status === 'in_progress' || status === 'researched')) {
        currentPhase = phaseInfo;
      }
      if (!nextPhase && status === 'pending') {
        nextPhase = phaseInfo;
      }
    }
  } catch {}

  // Check for paused work
  let pausedAt = null;
  try {
    const state = fs.readFileSync(path.join(cwd, '.planning', 'STATE.md'), 'utf-8');
    const pauseMatch = state.match(/\*\*Paused At:\*\*\s*(.+)/);
    if (pauseMatch) pausedAt = pauseMatch[1].trim();
  } catch {}

  const result = {
    // Models
    executor_model: resolveModelInternal(cwd, 'nf-executor'),
    planner_model: resolveModelInternal(cwd, 'nf-planner'),

    // Config
    commit_docs: config.commit_docs,

    // Milestone
    milestone_version: milestone.version,
    milestone_name: milestone.name,

    // Phase overview
    phases,
    phase_count: phases.length,
    completed_count: phases.filter(p => p.status === 'complete').length,
    in_progress_count: phases.filter(p => p.status === 'in_progress').length,

    // Current state
    current_phase: currentPhase,
    next_phase: nextPhase,
    paused_at: pausedAt,
    has_work_in_progress: !!currentPhase,

    // File existence
    project_exists: pathExistsInternal(cwd, '.planning/PROJECT.md'),
    roadmap_exists: pathExistsInternal(cwd, '.planning/ROADMAP.md'),
    state_exists: pathExistsInternal(cwd, '.planning/STATE.md'),
    // File paths
    state_path: '.planning/STATE.md',
    roadmap_path: '.planning/ROADMAP.md',
    project_path: '.planning/PROJECT.md',
    config_path: '.planning/config.json',
  };

  output(result, raw);
}

// ─── CLI Router ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const rawIndex = args.indexOf('--raw');
  const raw = rawIndex !== -1;
  if (rawIndex !== -1) args.splice(rawIndex, 1);

  const command = args[0];
  const cwd = process.cwd();

  if (!command) {
    error('Usage: nf-tools <command> [args] [--raw]\nCommands: state, resolve-model, find-phase, commit, verify-summary, verify, frontmatter, template, generate-slug, current-timestamp, list-todos, verify-path-exists, config-ensure-section, init');
  }

  switch (command) {
    case 'state': {
      const subcommand = args[1];
      if (subcommand === 'update') {
        cmdStateUpdate(cwd, args[2], args[3]);
      } else if (subcommand === 'get') {
        cmdStateGet(cwd, args[2], raw);
      } else if (subcommand === 'patch') {
        const patches = {};
        for (let i = 2; i < args.length; i += 2) {
          const key = args[i].replace(/^--/, '');
          const value = args[i + 1];
          if (key && value !== undefined) {
            patches[key] = value;
          }
        }
        cmdStatePatch(cwd, patches, raw);
      } else if (subcommand === 'advance-plan') {
        cmdStateAdvancePlan(cwd, raw);
      } else if (subcommand === 'record-metric') {
        const phaseIdx = args.indexOf('--phase');
        const planIdx = args.indexOf('--plan');
        const durationIdx = args.indexOf('--duration');
        const tasksIdx = args.indexOf('--tasks');
        const filesIdx = args.indexOf('--files');
        cmdStateRecordMetric(cwd, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          plan: planIdx !== -1 ? args[planIdx + 1] : null,
          duration: durationIdx !== -1 ? args[durationIdx + 1] : null,
          tasks: tasksIdx !== -1 ? args[tasksIdx + 1] : null,
          files: filesIdx !== -1 ? args[filesIdx + 1] : null,
        }, raw);
      } else if (subcommand === 'update-progress') {
        cmdStateUpdateProgress(cwd, raw);
      } else if (subcommand === 'add-decision') {
        const phaseIdx = args.indexOf('--phase');
        const summaryIdx = args.indexOf('--summary');
        const rationaleIdx = args.indexOf('--rationale');
        cmdStateAddDecision(cwd, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          summary: summaryIdx !== -1 ? args[summaryIdx + 1] : null,
          rationale: rationaleIdx !== -1 ? args[rationaleIdx + 1] : '',
        }, raw);
      } else if (subcommand === 'add-blocker') {
        const textIdx = args.indexOf('--text');
        cmdStateAddBlocker(cwd, textIdx !== -1 ? args[textIdx + 1] : null, raw);
      } else if (subcommand === 'resolve-blocker') {
        const textIdx = args.indexOf('--text');
        cmdStateResolveBlocker(cwd, textIdx !== -1 ? args[textIdx + 1] : null, raw);
      } else if (subcommand === 'record-session') {
        const stoppedIdx = args.indexOf('--stopped-at');
        const resumeIdx = args.indexOf('--resume-file');
        cmdStateRecordSession(cwd, {
          stopped_at: stoppedIdx !== -1 ? args[stoppedIdx + 1] : null,
          resume_file: resumeIdx !== -1 ? args[resumeIdx + 1] : 'None',
        }, raw);
      } else {
        cmdStateLoad(cwd, raw);
      }
      break;
    }

    case 'resolve-model': {
      cmdResolveModel(cwd, args[1], raw);
      break;
    }

    case 'find-phase': {
      cmdFindPhase(cwd, args[1], raw);
      break;
    }

    case 'commit': {
      const amend = args.includes('--amend');
      const message = args[1];
      // Parse --files flag (collect args after --files, stopping at other flags)
      const filesIndex = args.indexOf('--files');
      const files = filesIndex !== -1 ? args.slice(filesIndex + 1).filter(a => !a.startsWith('--')) : [];
      cmdCommit(cwd, message, files, raw, amend);
      break;
    }

    case 'verify-summary': {
      const summaryPath = args[1];
      const countIndex = args.indexOf('--check-count');
      const checkCount = countIndex !== -1 ? parseInt(args[countIndex + 1], 10) : 2;
      cmdVerifySummary(cwd, summaryPath, checkCount, raw);
      break;
    }

    case 'template': {
      const subcommand = args[1];
      if (subcommand === 'select') {
        cmdTemplateSelect(cwd, args[2], raw);
      } else if (subcommand === 'fill') {
        const templateType = args[2];
        const phaseIdx = args.indexOf('--phase');
        const planIdx = args.indexOf('--plan');
        const nameIdx = args.indexOf('--name');
        const typeIdx = args.indexOf('--type');
        const waveIdx = args.indexOf('--wave');
        const fieldsIdx = args.indexOf('--fields');
        cmdTemplateFill(cwd, templateType, {
          phase: phaseIdx !== -1 ? args[phaseIdx + 1] : null,
          plan: planIdx !== -1 ? args[planIdx + 1] : null,
          name: nameIdx !== -1 ? args[nameIdx + 1] : null,
          type: typeIdx !== -1 ? args[typeIdx + 1] : 'execute',
          wave: waveIdx !== -1 ? args[waveIdx + 1] : '1',
          fields: fieldsIdx !== -1 ? JSON.parse(args[fieldsIdx + 1]) : {},
        }, raw);
      } else {
        error('Unknown template subcommand. Available: select, fill');
      }
      break;
    }

    case 'frontmatter': {
      const subcommand = args[1];
      const file = args[2];
      if (subcommand === 'get') {
        const fieldIdx = args.indexOf('--field');
        cmdFrontmatterGet(cwd, file, fieldIdx !== -1 ? args[fieldIdx + 1] : null, raw);
      } else if (subcommand === 'set') {
        const fieldIdx = args.indexOf('--field');
        const valueIdx = args.indexOf('--value');
        cmdFrontmatterSet(cwd, file, fieldIdx !== -1 ? args[fieldIdx + 1] : null, valueIdx !== -1 ? args[valueIdx + 1] : undefined, raw);
      } else if (subcommand === 'merge') {
        const dataIdx = args.indexOf('--data');
        cmdFrontmatterMerge(cwd, file, dataIdx !== -1 ? args[dataIdx + 1] : null, raw);
      } else if (subcommand === 'validate') {
        const schemaIdx = args.indexOf('--schema');
        cmdFrontmatterValidate(cwd, file, schemaIdx !== -1 ? args[schemaIdx + 1] : null, raw);
      } else {
        error('Unknown frontmatter subcommand. Available: get, set, merge, validate');
      }
      break;
    }

    case 'verify': {
      const subcommand = args[1];
      if (subcommand === 'plan-structure') {
        cmdVerifyPlanStructure(cwd, args[2], raw);
      } else if (subcommand === 'phase-completeness') {
        cmdVerifyPhaseCompleteness(cwd, args[2], raw);
      } else if (subcommand === 'references') {
        cmdVerifyReferences(cwd, args[2], raw);
      } else if (subcommand === 'commits') {
        cmdVerifyCommits(cwd, args.slice(2), raw);
      } else if (subcommand === 'artifacts') {
        cmdVerifyArtifacts(cwd, args[2], raw);
      } else if (subcommand === 'key-links') {
        cmdVerifyKeyLinks(cwd, args[2], raw);
      } else {
        error('Unknown verify subcommand. Available: plan-structure, phase-completeness, references, commits, artifacts, key-links');
      }
      break;
    }

    case 'generate-slug': {
      cmdGenerateSlug(args[1], raw);
      break;
    }

    case 'current-timestamp': {
      cmdCurrentTimestamp(args[1] || 'full', raw);
      break;
    }

    case 'list-todos': {
      cmdListTodos(cwd, args[1], raw);
      break;
    }

    case 'verify-path-exists': {
      cmdVerifyPathExists(cwd, args[1], raw);
      break;
    }

    case 'config-ensure-section': {
      cmdConfigEnsureSection(cwd, raw);
      break;
    }

    case 'config-set': {
      cmdConfigSet(cwd, args[1], args[2], raw);
      break;
    }

    case 'config-get': {
      cmdConfigGet(cwd, args[1], raw);
      break;
    }

    case 'history-digest': {
      cmdHistoryDigest(cwd, raw);
      break;
    }

    case 'phases': {
      const subcommand = args[1];
      if (subcommand === 'list') {
        const typeIndex = args.indexOf('--type');
        const phaseIndex = args.indexOf('--phase');
        const options = {
          type: typeIndex !== -1 ? args[typeIndex + 1] : null,
          phase: phaseIndex !== -1 ? args[phaseIndex + 1] : null,
          includeArchived: args.includes('--include-archived'),
        };
        cmdPhasesList(cwd, options, raw);
      } else {
        error('Unknown phases subcommand. Available: list');
      }
      break;
    }

    case 'roadmap': {
      const subcommand = args[1];
      if (subcommand === 'get-phase') {
        cmdRoadmapGetPhase(cwd, args[2], raw);
      } else if (subcommand === 'analyze') {
        cmdRoadmapAnalyze(cwd, raw);
      } else if (subcommand === 'update-plan-progress') {
        cmdRoadmapUpdatePlanProgress(cwd, args[2], raw);
      } else {
        error('Unknown roadmap subcommand. Available: get-phase, analyze, update-plan-progress');
      }
      break;
    }

    case 'requirements': {
      const subcommand = args[1];
      if (subcommand === 'mark-complete') {
        cmdRequirementsMarkComplete(cwd, args.slice(2), raw);
      } else {
        error('Unknown requirements subcommand. Available: mark-complete');
      }
      break;
    }

    case 'phase': {
      const subcommand = args[1];
      if (subcommand === 'next-decimal') {
        cmdPhaseNextDecimal(cwd, args[2], raw);
      } else if (subcommand === 'add') {
        cmdPhaseAdd(cwd, args.slice(2).join(' '), raw);
      } else if (subcommand === 'insert') {
        cmdPhaseInsert(cwd, args[2], args.slice(3).join(' '), raw);
      } else if (subcommand === 'remove') {
        const forceFlag = args.includes('--force');
        cmdPhaseRemove(cwd, args[2], { force: forceFlag }, raw);
      } else if (subcommand === 'complete') {
        cmdPhaseComplete(cwd, args[2], raw);
      } else {
        error('Unknown phase subcommand. Available: next-decimal, add, insert, remove, complete');
      }
      break;
    }

    case 'milestone': {
      const subcommand = args[1];
      if (subcommand === 'complete') {
        const nameIndex = args.indexOf('--name');
        const archivePhases = args.includes('--archive-phases');
        // Collect --name value (everything after --name until next flag or end)
        let milestoneName = null;
        if (nameIndex !== -1) {
          const nameArgs = [];
          for (let i = nameIndex + 1; i < args.length; i++) {
            if (args[i].startsWith('--')) break;
            nameArgs.push(args[i]);
          }
          milestoneName = nameArgs.join(' ') || null;
        }
        cmdMilestoneComplete(cwd, args[2], { name: milestoneName, archivePhases }, raw);
      } else {
        error('Unknown milestone subcommand. Available: complete');
      }
      break;
    }

    case 'validate': {
      const subcommand = args[1];
      if (subcommand === 'consistency') {
        cmdValidateConsistency(cwd, raw);
      } else if (subcommand === 'health') {
        const repairFlag = args.includes('--repair');
        const forceFlag = args.includes('--force');
        cmdValidateHealth(cwd, { repair: repairFlag, force: forceFlag }, raw);
      } else {
        error('Unknown validate subcommand. Available: consistency, health');
      }
      break;
    }

    case 'progress': {
      const subcommand = args[1] || 'json';
      cmdProgressRender(cwd, subcommand, raw);
      break;
    }

    case 'todo': {
      const subcommand = args[1];
      if (subcommand === 'complete') {
        cmdTodoComplete(cwd, args[2], raw);
      } else {
        error('Unknown todo subcommand. Available: complete');
      }
      break;
    }

    case 'scaffold': {
      const scaffoldType = args[1];
      const phaseIndex = args.indexOf('--phase');
      const nameIndex = args.indexOf('--name');
      const scaffoldOptions = {
        phase: phaseIndex !== -1 ? args[phaseIndex + 1] : null,
        name: nameIndex !== -1 ? args.slice(nameIndex + 1).join(' ') : null,
      };
      cmdScaffold(cwd, scaffoldType, scaffoldOptions, raw);
      break;
    }

    case 'init': {
      const workflow = args[1];
      switch (workflow) {
        case 'execute-phase':
          cmdInitExecutePhase(cwd, args[2], raw);
          break;
        case 'plan-phase':
          cmdInitPlanPhase(cwd, args[2], raw);
          break;
        case 'new-project':
          cmdInitNewProject(cwd, raw);
          break;
        case 'new-milestone':
          cmdInitNewMilestone(cwd, raw);
          break;
        case 'quick':
          cmdInitQuick(cwd, args.slice(2).join(' '), raw);
          break;
        case 'resume':
          cmdInitResume(cwd, raw);
          break;
        case 'verify-work':
          cmdInitVerifyWork(cwd, args[2], raw);
          break;
        case 'phase-op':
          cmdInitPhaseOp(cwd, args[2], raw);
          break;
        case 'todos':
          cmdInitTodos(cwd, args[2], raw);
          break;
        case 'milestone-op':
          cmdInitMilestoneOp(cwd, raw);
          break;
        case 'map-codebase':
          cmdInitMapCodebase(cwd, raw);
          break;
        case 'progress':
          cmdInitProgress(cwd, raw);
          break;
        default:
          error(`Unknown init workflow: ${workflow}\nAvailable: execute-phase, plan-phase, new-project, new-milestone, quick, resume, verify-work, phase-op, todos, milestone-op, map-codebase, progress`);
      }
      break;
    }

    case 'phase-plan-index': {
      cmdPhasePlanIndex(cwd, args[1], raw);
      break;
    }

    case 'state-snapshot': {
      cmdStateSnapshot(cwd, raw);
      break;
    }

    case 'summary-extract': {
      const summaryPath = args[1];
      const fieldsIndex = args.indexOf('--fields');
      const fields = fieldsIndex !== -1 ? args[fieldsIndex + 1].split(',') : null;
      cmdSummaryExtract(cwd, summaryPath, fields, raw);
      break;
    }

    case 'websearch': {
      const query = args[1];
      const limitIdx = args.indexOf('--limit');
      const freshnessIdx = args.indexOf('--freshness');
      await cmdWebsearch(query, {
        limit: limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10,
        freshness: freshnessIdx !== -1 ? args[freshnessIdx + 1] : null,
      }, raw);
      break;
    }

    case 'activity-set': {
      cmdActivitySet(cwd, args[1], raw);
      break;
    }

    case 'activity-clear': {
      cmdActivityClear(cwd, raw);
      break;
    }

    case 'activity-get': {
      cmdActivityGet(cwd, raw);
      break;
    }

    case 'formal-summary': {
      cmdFormalSummary(cwd, raw);
      break;
    }

    case 'maintain-tests': {
      const subCmd = args[1];
      switch (subCmd) {
        case 'run-batch': {
          const batchFileIdx = args.indexOf('--batch-file');
          const timeoutIdx = args.indexOf('--timeout');
          const outputIdx = args.indexOf('--output-file');
          const batchIndexIdx = args.indexOf('--batch-index');
          const parallelIdx = args.indexOf('--parallel');
          // Collect all --env KEY=VALUE pairs
          const envPairs = {};
          for (let i = 0; i < args.length; i++) {
            if (args[i] === '--env' && args[i + 1]) {
              const [key, ...vals] = args[i + 1].split('=');
              envPairs[key] = vals.join('=');
              i++;
            }
          }
          await cmdMaintainTestsRunBatch(cwd, {
            batchFile: batchFileIdx !== -1 ? args[batchFileIdx + 1] : null,
            timeoutSec: timeoutIdx !== -1 ? parseInt(args[timeoutIdx + 1], 10) : 3600,
            outputFile: outputIdx !== -1 ? args[outputIdx + 1] : null,
            batchIndex: batchIndexIdx !== -1 ? parseInt(args[batchIndexIdx + 1], 10) : 0,
            parallel: parallelIdx !== -1 ? args[parallelIdx + 1] : null,
            env: { ...process.env, ...envPairs },
          }, raw);
          break;
        }
        case 'batch': {
          const inputFileIdx = args.indexOf('--input-file');
          const inputJsonIdx = args.indexOf('--input-json');
          const sizeIdx = args.indexOf('--size');
          const seedIdx = args.indexOf('--seed');
          const excludeIdx = args.indexOf('--exclude-file');
          const manifestIdx = args.indexOf('--manifest-file');
          const outputIdx = args.indexOf('--output-file');
          cmdMaintainTestsBatch(cwd, {
            inputFile: inputFileIdx !== -1 ? args[inputFileIdx + 1] : null,
            inputJson: inputJsonIdx !== -1 ? args[inputJsonIdx + 1] : null,
            size: sizeIdx !== -1 ? parseInt(args[sizeIdx + 1], 10) : null,
            seed: seedIdx !== -1 ? parseInt(args[seedIdx + 1], 10) : null,
            excludeFile: excludeIdx !== -1 ? args[excludeIdx + 1] : null,
            manifestFile: manifestIdx !== -1 ? args[manifestIdx + 1] : (outputIdx !== -1 ? args[outputIdx + 1] : null),
          }, raw);
          break;
        }
        case 'discover': {
          const runnerIdx = args.indexOf('--runner');
          const dirIdx = args.indexOf('--dir');
          const outputIdx = args.indexOf('--output-file');
          cmdMaintainTestsDiscover(cwd, {
            runner: runnerIdx !== -1 ? args[runnerIdx + 1] : 'auto',
            dir: dirIdx !== -1 ? args[dirIdx + 1] : null,
            outputFile: outputIdx !== -1 ? args[outputIdx + 1] : null,
          }, raw);
          break;
        }
        case 'save-state': {
          const stateFileIdx = args.indexOf('--state-file');
          const stateJsonIdx = args.indexOf('--state-json');
          cmdMaintainTestsSaveState(cwd, {
            stateFile: stateFileIdx !== -1 ? args[stateFileIdx + 1] : null,
            stateJson: stateJsonIdx !== -1 ? args[stateJsonIdx + 1] : null,
          }, raw);
          break;
        }
        case 'load-state': {
          const stateFileIdx = args.indexOf('--state-file');
          cmdMaintainTestsLoadState(cwd, {
            stateFile: stateFileIdx !== -1 ? args[stateFileIdx + 1] : null,
          }, raw);
          break;
        }
        case 'ddmin': {
          const failingTestIdx = args.indexOf('--failing-test');
          const candidatesIdx = args.indexOf('--candidates-file');
          const timeoutIdx = args.indexOf('--timeout');
          const outputIdx = args.indexOf('--output-file');
          const runnerIdx = args.indexOf('--runner');
          const runCapIdx = args.indexOf('--run-cap');
          await cmdMaintainTestsDdmin(cwd, {
            failingTest: failingTestIdx !== -1 ? args[failingTestIdx + 1] : null,
            candidatesFile: candidatesIdx !== -1 ? args[candidatesIdx + 1] : null,
            timeoutSec: timeoutIdx !== -1 ? parseInt(args[timeoutIdx + 1], 10) : 60,
            outputFile: outputIdx !== -1 ? args[outputIdx + 1] : null,
            runner: runnerIdx !== -1 ? args[runnerIdx + 1] : 'auto',
            runCap: runCapIdx !== -1 ? parseInt(args[runCapIdx + 1], 10) : 50,
            env: process.env,
          }, raw);
          break;
        }
        default:
          error(`Unknown maintain-tests subcommand: ${subCmd}\nAvailable: discover, batch, run-batch, save-state, load-state, ddmin`);
      }
      break;
    }

    default:
      error(`Unknown command: ${command}`);
  }
}

// ─── Maintain Tests: Batch Commands ──────────────────────────────────────────

// Detect whether node:sqlite (DatabaseSync) is available (Node >= 22.5.0)
function hasSqliteSupport() {
  const [major, minor] = process.version.slice(1).split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

// Mulberry32 — deterministic PRNG (no external dependency)
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Fisher-Yates shuffle with Mulberry32 PRNG — deterministic for same seed + input
function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const result = arr.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function cmdMaintainTestsBatch(cwd, options, raw) {
  const {
    inputFile,
    inputJson,
    size: sizeOpt,
    seed: seedOpt,
    excludeFile,
    manifestFile,
  } = options;

  // Read input
  let discoverData;
  if (inputFile) {
    const absInput = path.isAbsolute(inputFile) ? inputFile : path.join(cwd, inputFile);
    try {
      discoverData = JSON.parse(fs.readFileSync(absInput, 'utf-8'));
    } catch (e) {
      error(`maintain-tests batch: failed to read --input-file "${inputFile}" — ${e.message}`);
    }
  } else if (inputJson) {
    try {
      discoverData = JSON.parse(inputJson);
    } catch (e) {
      error(`maintain-tests batch: failed to parse --input-json — ${e.message}`);
    }
  } else {
    error('maintain-tests batch: either --input-file or --input-json is required');
  }

  if (!Array.isArray(discoverData.test_files)) {
    error('maintain-tests batch: input JSON must have a "test_files" array');
  }

  // Read config for default batch_size
  let configBatchSize = 100;
  try {
    const nfConfigPath = path.join(cwd, '.claude', 'nf.json');
    const nfConfig = JSON.parse(fs.readFileSync(nfConfigPath, 'utf-8'));
    if (nfConfig.maintain_tests && typeof nfConfig.maintain_tests.batch_size === 'number') {
      configBatchSize = nfConfig.maintain_tests.batch_size;
    }
  } catch { /* config absent — use default */ }

  const batchSize = (sizeOpt !== null && sizeOpt !== undefined && !isNaN(sizeOpt)) ? sizeOpt : configBatchSize;
  const seed = (seedOpt !== null && seedOpt !== undefined && !isNaN(seedOpt)) ? seedOpt : (Date.now() % 2147483647);

  // Apply exclude filter if provided
  let testFiles = discoverData.test_files.slice();
  if (excludeFile) {
    const absExclude = path.isAbsolute(excludeFile) ? excludeFile : path.join(cwd, excludeFile);
    try {
      const excludeList = JSON.parse(fs.readFileSync(absExclude, 'utf-8'));
      if (!Array.isArray(excludeList)) {
        error(`maintain-tests batch: --exclude-file must contain a JSON array`);
      }
      const excludeSet = new Set(excludeList.map(p => path.resolve(p)));
      testFiles = testFiles.filter(p => !excludeSet.has(path.resolve(p)));
    } catch (e) {
      if (e.message && e.message.startsWith('maintain-tests batch')) throw e;
      error(`maintain-tests batch: failed to read --exclude-file "${excludeFile}" — ${e.message}`);
    }
  }

  // Deterministic shuffle
  const shuffled = seededShuffle(testFiles, seed);

  // Split into batches
  const batches = [];
  for (let i = 0; i < shuffled.length; i += batchSize) {
    const chunk = shuffled.slice(i, i + batchSize);
    batches.push({
      batch_id: batches.length + 1,
      files: chunk,
      file_count: chunk.length,
      runner: discoverData.runners && discoverData.runners[0] ? discoverData.runners[0] : 'jest',
    });
  }

  const manifest = {
    seed,
    batch_size: batchSize,
    total_files: testFiles.length,
    total_batches: batches.length,
    batches,
  };

  const manifestJson = JSON.stringify(manifest, null, 2);

  // Write to disk if --manifest-file / --output-file was specified (before returning)
  if (manifestFile) {
    const absManifest = path.isAbsolute(manifestFile) ? manifestFile : path.join(cwd, manifestFile);
    fs.writeFileSync(absManifest, manifestJson, 'utf-8');
  }

  // Always output to stdout
  output(manifest, raw);
}

function cmdMaintainTestsSaveState(cwd, options, raw) {
  const { stateFile: stateFileOpt, stateJson } = options;
  const defaultStatePath = path.join(cwd, '.planning', 'maintain-tests-state.json');
  const absStatePath = stateFileOpt
    ? (path.isAbsolute(stateFileOpt) ? stateFileOpt : path.join(cwd, stateFileOpt))
    : defaultStatePath;

  if (!stateJson) {
    error('maintain-tests save-state: --state-json is required');
  }
  let stateObj;
  try {
    stateObj = JSON.parse(stateJson);
  } catch (e) {
    error('maintain-tests save-state: invalid JSON \u2014 ' + e.message);
  }
  stateObj.updated = new Date().toISOString();

  if (hasSqliteSupport()) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(absStatePath);
      db.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated TEXT NOT NULL)');
      const upsert = db.prepare('INSERT OR REPLACE INTO state (key, value, updated) VALUES (?, ?, ?)');
      upsert.run('session', JSON.stringify(stateObj), stateObj.updated);
      db.close();
      output({ written: true, path: absStatePath, backend: 'sqlite' }, raw);
    } catch (e) {
      error('maintain-tests save-state: SQLite write failed \u2014 ' + e.message);
    }
  } else {
    try {
      fs.writeFileSync(absStatePath, JSON.stringify(stateObj, null, 2), 'utf-8');
      output({ written: true, path: absStatePath, backend: 'json' }, raw);
    } catch (e) {
      error('maintain-tests save-state: JSON write failed \u2014 ' + e.message);
    }
  }
}

function cmdMaintainTestsLoadState(cwd, options, raw) {
  const { stateFile: stateFileOpt } = options;
  const defaultStatePath = path.join(cwd, '.planning', 'maintain-tests-state.json');
  const absStatePath = stateFileOpt
    ? (path.isAbsolute(stateFileOpt) ? stateFileOpt : path.join(cwd, stateFileOpt))
    : defaultStatePath;

  if (!fs.existsSync(absStatePath)) {
    output(null, raw);
    return;
  }

  if (hasSqliteSupport()) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(absStatePath);
      let state = null;
      try {
        const select = db.prepare('SELECT value FROM state WHERE key = ?');
        const row = select.get('session');
        state = row ? JSON.parse(row.value) : null;
      } catch (_e) {
        // Table does not exist or schema mismatch
      }
      db.close();
      output(state, raw);
    } catch (_e) {
      // SQLite open failed (may be JSON file from fallback path)
      try {
        const state = JSON.parse(fs.readFileSync(absStatePath, 'utf-8'));
        output(state, raw);
      } catch (__e) {
        output(null, raw);
      }
    }
  } else {
    try {
      const state = JSON.parse(fs.readFileSync(absStatePath, 'utf-8'));
      output(state, raw);
    } catch (_e) {
      output(null, raw);
    }
  }
}

// ─── Python environment resolver ──────────────────────────────────────────────

/**
 * Resolve the best Python executable for the given project directory.
 * Priority (lock files are the discriminating signal — pyproject.toml alone is ambiguous):
 *   1. uv run python    — uv.lock present AND uv in PATH
 *   2. poetry run python — poetry.lock present AND poetry in PATH
 *   3. pipenv run python — Pipfile.lock present AND pipenv in PATH
 *   4. .venv/bin/python3 or venv/bin/python3 — local in-project virtualenv
 *   5. python3 in PATH
 *   6. python  (fallback)
 *
 * Returns an array [cmd, ...prefixArgs] for spreading into spawnSync / spawn:
 *   const [exe, ...pre] = getPythonArgs(dir);
 *   spawnSync(exe, [...pre, '-m', 'pytest', ...]);
 */
function getPythonArgs(dir) {
  function inPath(cmd) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf-8', stdio: 'pipe' });
    return r.status === 0 && !r.error;
  }
  // 1. uv — lock file is the definitive uv signal
  if (fs.existsSync(path.join(dir, 'uv.lock')) && inPath('uv')) return ['uv', 'run', 'python'];
  // 2. poetry
  if (fs.existsSync(path.join(dir, 'poetry.lock')) && inPath('poetry')) return ['poetry', 'run', 'python'];
  // 3. pipenv
  if (fs.existsSync(path.join(dir, 'Pipfile.lock')) && inPath('pipenv')) return ['pipenv', 'run', 'python'];
  // 4. local in-project virtualenv (covers uv --project-local, plain venv, conda envs exported here)
  for (const rel of ['.venv/bin/python3', '.venv/bin/python', 'venv/bin/python3', 'venv/bin/python']) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) return [abs];
  }
  // 5. python3 / python in PATH
  return inPath('python3') ? ['python3'] : ['python'];
}

// ─── Maintain-Tests: Discover ─────────────────────────────────────────────────

/**
 * Detect test frameworks from config files and list all tests via framework CLI.
 * Never globs for test files — always uses each framework's own CLI invocation.
 */
function cmdMaintainTestsDiscover(cwd, options, raw) {
  const searchDir = options.dir ? path.resolve(cwd, options.dir) : cwd;

  // ── Framework Detection ────────────────────────────────────────────────────

  function detectJest(dir) {
    const configFiles = [
      'jest.config.js', 'jest.config.cjs', 'jest.config.mjs',
      'jest.config.ts', 'jest.config.json',
    ];
    for (const f of configFiles) {
      if (fs.existsSync(path.join(dir, f))) return true;
    }
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.jest) return true;
        const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
        if (deps.jest) return true;
      } catch (e) { /* ignore parse errors */ }
    }
    return false;
  }

  function detectPlaywright(dir) {
    const configFiles = [
      'playwright.config.js', 'playwright.config.cjs',
      'playwright.config.mjs', 'playwright.config.ts',
    ];
    return configFiles.some(f => fs.existsSync(path.join(dir, f)));
  }

  function detectPytest(dir) {
    if (fs.existsSync(path.join(dir, 'pytest.ini'))) return true;
    const setupCfg = path.join(dir, 'setup.cfg');
    if (fs.existsSync(setupCfg)) {
      try {
        const content = fs.readFileSync(setupCfg, 'utf-8');
        if (content.includes('[tool:pytest]')) return true;
      } catch (e) { /* ignore */ }
    }
    const pyproject = path.join(dir, 'pyproject.toml');
    if (fs.existsSync(pyproject)) {
      try {
        const content = fs.readFileSync(pyproject, 'utf-8');
        if (content.includes('[tool.pytest.ini_options]')) return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  // ── Determine which runners to invoke ─────────────────────────────────────

  let runnersToUse;
  if (options.runner && options.runner !== 'auto') {
    runnersToUse = [options.runner];
  } else {
    runnersToUse = [];
    if (detectJest(searchDir)) runnersToUse.push('jest');
    if (detectPlaywright(searchDir)) runnersToUse.push('playwright');
    if (detectPytest(searchDir)) runnersToUse.push('pytest');
  }

  // ── CLI invocation per framework ──────────────────────────────────────────

  const warnings = [];
  const byRunner = {};
  const seenPaths = new Set();
  const allFiles = [];

  function addPaths(runner, paths) {
    byRunner[runner] = [];
    for (const p of paths) {
      const abs = path.isAbsolute(p) ? p : path.resolve(searchDir, p);
      if (!seenPaths.has(abs)) {
        seenPaths.add(abs);
        allFiles.push(abs);
        byRunner[runner].push(abs);
      }
    }
  }

  function invokeJest() {
    // Try npx jest --listTests first, fall back to local binary
    let result = spawnSync('npx', ['jest', '--listTests'], {
      cwd: searchDir,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB — prevents ENOBUFS on large test suites
    });
    if (result.error || (result.status !== 0 && !(result.stdout || '').trim())) {
      result = spawnSync('./node_modules/.bin/jest', ['--listTests'], {
        cwd: searchDir,
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
      });
    }
    if (result.error || (result.status !== 0 && !(result.stdout || '').trim())) {
      const errMsg = result.error ? result.error.message : (result.stderr || 'non-zero exit');
      warnings.push({ runner: 'jest', error: errMsg });
      addPaths('jest', []);
      return;
    }
    const lines = (result.stdout || '').split('\n').filter(l => l.trim() !== '');
    addPaths('jest', lines);
  }

  function invokePlaywright() {
    const result = spawnSync('npx', ['playwright', 'test', '--list'], {
      cwd: searchDir,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB — prevents ENOBUFS on large test suites
    });
    if (result.error) {
      warnings.push({ runner: 'playwright', error: result.error.message });
      addPaths('playwright', []);
      return;
    }
    if (result.status !== 0 && !(result.stdout || '').trim()) {
      warnings.push({ runner: 'playwright', error: result.stderr || 'non-zero exit' });
      addPaths('playwright', []);
      return;
    }
    // Parse lines matching spec file paths
    const specPattern = /\s+(\S+\.spec\.(ts|js|tsx|jsx))/;
    const lines = (result.stdout || '').split('\n');
    const files = [];
    for (const line of lines) {
      const match = line.match(specPattern);
      if (match) {
        const filePath = match[1].trim();
        const abs = path.isAbsolute(filePath) ? filePath : path.resolve(searchDir, filePath);
        files.push(abs);
      }
    }
    addPaths('playwright', files);
  }

  function invokePytest() {
    const [pyExe, ...pyPre] = getPythonArgs(searchDir);
    const result = spawnSync(pyExe, [...pyPre, '-m', 'pytest', '--collect-only', '-q', '--override-ini=addopts='], {
      cwd: searchDir,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB — prevents ENOBUFS on large test suites (~11K+ tests)
    });
    if (result.error) {
      warnings.push({ runner: 'pytest', error: result.error.message });
      addPaths('pytest', []);
      return;
    }
    // pytest exits 1 when no tests found or some tests fail — that is acceptable.
    // Only treat as invocation failure if the process could not be spawned (result.error).
    // Output format: path/to/test.py::test_name
    const lines = (result.stdout || '').split('\n');
    const files = new Set();
    for (const line of lines) {
      if (line.startsWith('ERROR') || line.startsWith('=') || line.trim() === '') continue;
      if (line.includes('::')) {
        const filePart = line.split('::')[0].trim();
        if (filePart) {
          const abs = path.isAbsolute(filePart) ? filePart : path.resolve(searchDir, filePart);
          files.add(abs);
        }
      }
    }
    // Fallback: if no :: lines found, try parsing verbose <Module filename.py> tree format
    if (files.size === 0) {
      const modulePattern = /^<Module\s+(.+\.py)>/;
      for (const line of lines) {
        const m = line.trim().match(modulePattern);
        if (m) {
          const filePart = m[1].trim();
          const abs = path.isAbsolute(filePart) ? filePart : path.resolve(searchDir, filePart);
          files.add(abs);
        }
      }
    }
    addPaths('pytest', Array.from(files));
  }

  // ── Invoke detected runners ────────────────────────────────────────────────

  if (runnersToUse.length === 0) {
    warnings.push({ runner: null, error: 'No test framework config files detected' });
  } else {
    for (const runner of runnersToUse) {
      if (runner === 'jest') invokeJest();
      else if (runner === 'playwright') invokePlaywright();
      else if (runner === 'pytest') invokePytest();
      else warnings.push({ runner, error: `Unknown runner: ${runner}` });
    }
  }

  // ── Build result ──────────────────────────────────────────────────────────

  const discoverResult = {
    runners: runnersToUse,
    test_files: allFiles,
    total_count: allFiles.length,
    by_runner: byRunner,
  };
  if (warnings.length > 0) {
    discoverResult.warnings = warnings;
  }

  // ── Output ────────────────────────────────────────────────────────────────

  const json = JSON.stringify(discoverResult, null, 2);
  if (options.outputFile) {
    const outPath = path.isAbsolute(options.outputFile)
      ? options.outputFile
      : path.resolve(cwd, options.outputFile);
    fs.writeFileSync(outPath, json, 'utf-8');
  } else {
    process.stdout.write(json + '\n');
  }
}

// ─── Maintain-Tests: Run-Batch ────────────────────────────────────────────────

/**
 * spawnToFile — Spawn a subprocess, piping stdout+stderr to a file.
 * Uses spawn (async streaming) NOT spawnSync — avoids Node.js maxBuffer overflow.
 */
function spawnToFile(cmd, cmdArgs, opts, outputPath) {
  return new Promise((resolve, reject) => {
    const outStream = fs.createWriteStream(outputPath);
    const proc = spawn(cmd, cmdArgs, {
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.pipe(outStream);
    proc.stderr.pipe(outStream); // capture both to same file

    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, opts.timeoutMs) : null;

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      outStream.end(() => {
        resolve({ exitCode: code, timedOut, outputPath });
      });
    });

    proc.on('error', reject);
  });
}

/**
 * truncateErrorSummary — Truncate error output to first 500 chars.
 */
function truncateErrorSummary(text) {
  if (!text) return null;
  const str = String(text);
  return str.length > 500 ? str.slice(0, 500) : str;
}

/**
 * runTestFile — Run a single test file using the appropriate framework CLI.
 * Returns an array of per-test result records.
 */
async function runTestFile(testFile, runner, opts, batchTmpPrefix) {
  const os = require('os');
  const timestamp = Date.now();
  const safeFile = path.basename(testFile).replace(/[^a-zA-Z0-9._-]/g, '_');
  const tmpOutput = path.join(os.tmpdir(), `${batchTmpPrefix}-${safeFile}-${timestamp}.tmp`);
  const startMs = Date.now();
  let spawnResult;
  let durationMs = 0;
  const perTestResults = [];

  try {
    if (runner === 'jest') {
      const jestJsonOutput = path.join(os.tmpdir(), `${batchTmpPrefix}-${safeFile}-${timestamp}-jest.json`);
      spawnResult = await spawnToFile(
        'npx',
        ['jest', testFile, '--json', `--outputFile=${jestJsonOutput}`, '--passWithNoTests', '--forceExit'],
        { cwd: opts.cwd, env: opts.env, timeoutMs: opts.fileTimeoutMs },
        tmpOutput
      );
      durationMs = Date.now() - startMs;

      if (spawnResult.timedOut) {
        perTestResults.push({ file: testFile, runner, status: 'timeout', duration_ms: durationMs, error_summary: 'timed out', flaky: false, flaky_pass_count: 0 });
      } else {
        try {
          const jestJson = JSON.parse(fs.readFileSync(jestJsonOutput, 'utf-8'));
          const testResults = (jestJson.testResults && jestJson.testResults[0] && jestJson.testResults[0].testResults) || [];
          if (testResults.length === 0) {
            perTestResults.push({ file: testFile, runner, status: 'passed', duration_ms: durationMs, error_summary: null, flaky: false, flaky_pass_count: 0 });
          } else {
            for (const t of testResults) {
              const tStatus = t.status === 'passed' ? 'passed' : t.status === 'pending' ? 'skipped' : 'failed';
              const errMsg = t.failureMessages && t.failureMessages.length > 0 ? t.failureMessages.join('\n') : null;
              perTestResults.push({ file: testFile, runner, status: tStatus, duration_ms: t.duration || durationMs, error_summary: truncateErrorSummary(errMsg), flaky: false, flaky_pass_count: 0 });
            }
          }
        } catch (e) {
          const rawOutput = safeReadFile(tmpOutput) || '';
          perTestResults.push({ file: testFile, runner, status: 'failed', duration_ms: durationMs, error_summary: truncateErrorSummary(rawOutput), flaky: false, flaky_pass_count: 0 });
        }
        try { fs.unlinkSync(jestJsonOutput); } catch (e) { /* ignore */ }
      }

    } else if (runner === 'playwright') {
      spawnResult = await spawnToFile(
        'npx',
        ['playwright', 'test', testFile, '--reporter=json'],
        { cwd: opts.cwd, env: opts.env, timeoutMs: opts.fileTimeoutMs },
        tmpOutput
      );
      durationMs = Date.now() - startMs;

      if (spawnResult.timedOut) {
        perTestResults.push({ file: testFile, runner, status: 'timeout', duration_ms: durationMs, error_summary: 'timed out', flaky: false, flaky_pass_count: 0 });
      } else {
        try {
          const pwJson = JSON.parse(fs.readFileSync(tmpOutput, 'utf-8'));
          const suites = pwJson.suites || [];
          for (const suite of suites) {
            for (const spec of (suite.specs || [])) {
              for (const t of (spec.tests || [])) {
                for (const r of (t.results || [])) {
                  const tStatus = r.status === 'passed' ? 'passed' : r.status === 'skipped' ? 'skipped' : 'failed';
                  perTestResults.push({ file: testFile, runner, status: tStatus, duration_ms: r.duration || durationMs, error_summary: truncateErrorSummary(r.error ? (r.error.message || JSON.stringify(r.error)) : null), flaky: false, flaky_pass_count: 0 });
                }
              }
            }
          }
          if (perTestResults.length === 0) {
            perTestResults.push({ file: testFile, runner, status: 'passed', duration_ms: durationMs, error_summary: null, flaky: false, flaky_pass_count: 0 });
          }
        } catch (e) {
          const rawOutput = safeReadFile(tmpOutput) || '';
          perTestResults.push({ file: testFile, runner, status: 'failed', duration_ms: durationMs, error_summary: truncateErrorSummary(rawOutput), flaky: false, flaky_pass_count: 0 });
        }
      }

    } else if (runner === 'pytest') {
      const pytestJsonOutput = path.join(os.tmpdir(), `${batchTmpPrefix}-${safeFile}-${timestamp}-pytest.json`);
      const [pyExe, ...pyPre] = getPythonArgs(opts.cwd || cwd);
      spawnResult = await spawnToFile(
        pyExe,
        [...pyPre, '-m', 'pytest', testFile, '--json-report', `--json-report-file=${pytestJsonOutput}`, '-q'],
        { cwd: opts.cwd, env: opts.env, timeoutMs: opts.fileTimeoutMs },
        tmpOutput
      );
      durationMs = Date.now() - startMs;

      if (spawnResult.timedOut) {
        perTestResults.push({ file: testFile, runner, status: 'timeout', duration_ms: durationMs, error_summary: 'timed out', flaky: false, flaky_pass_count: 0 });
      } else if (spawnResult.exitCode === 5) {
        // pytest exit code 5 = "no tests collected" — NOT a failure.
        // Happens with helper modules that have test_ prefix, or pytest.importorskip() when optional deps are missing.
        perTestResults.push({ file: testFile, runner, status: 'skipped', duration_ms: durationMs, error_summary: 'no tests collected (pytest exit code 5)', flaky: false, flaky_pass_count: 0 });
        try { fs.unlinkSync(pytestJsonOutput); } catch (e) { /* ignore */ }
      } else {
        let parsed = false;
        try {
          if (fs.existsSync(pytestJsonOutput)) {
            const pytestJson = JSON.parse(fs.readFileSync(pytestJsonOutput, 'utf-8'));
            const tests = pytestJson.tests || [];
            for (const t of tests) {
              const tStatus = t.outcome === 'passed' ? 'passed' : t.outcome === 'skipped' ? 'skipped' : 'failed';
              const errMsg = t.call && t.call.longrepr ? t.call.longrepr : null;
              perTestResults.push({ file: testFile, runner, status: tStatus, duration_ms: Math.round((t.duration || 0) * 1000), error_summary: truncateErrorSummary(errMsg), flaky: false, flaky_pass_count: 0 });
            }
            parsed = tests.length > 0;
            try { fs.unlinkSync(pytestJsonOutput); } catch (e) { /* ignore */ }
          }
        } catch (e) { /* fall through to stdout parsing */ }

        if (!parsed) {
          // Fallback: parse stdout for PASSED/FAILED/SKIPPED lines
          const rawOutput = safeReadFile(tmpOutput) || '';
          const lines = rawOutput.split('\n');
          let parsedLines = false;
          for (const line of lines) {
            const m = line.match(/^(.+::[\w\[\]]+)\s+(PASSED|FAILED|SKIPPED)/);
            if (m) {
              parsedLines = true;
              const tStatus = m[2] === 'PASSED' ? 'passed' : m[2] === 'SKIPPED' ? 'skipped' : 'failed';
              perTestResults.push({ file: testFile, runner, status: tStatus, duration_ms: durationMs, error_summary: tStatus === 'failed' ? truncateErrorSummary(rawOutput) : null, flaky: false, flaky_pass_count: 0 });
            }
          }
          if (!parsedLines) {
            const exitStatus = spawnResult.exitCode === 0 ? 'passed' : 'failed';
            perTestResults.push({ file: testFile, runner, status: exitStatus, duration_ms: durationMs, error_summary: exitStatus === 'failed' ? truncateErrorSummary(rawOutput) : null, flaky: false, flaky_pass_count: 0 });
          }
        }
      }

    } else {
      perTestResults.push({ file: testFile, runner, status: 'error', duration_ms: 0, error_summary: `Unknown runner: ${runner}`, flaky: false, flaky_pass_count: 0 });
    }
  } catch (e) {
    durationMs = Date.now() - startMs;
    perTestResults.push({ file: testFile, runner, status: 'error', duration_ms: durationMs, error_summary: truncateErrorSummary(e.message), flaky: false, flaky_pass_count: 0 });
  }

  // Cleanup temp output file
  try { fs.unlinkSync(tmpOutput); } catch (e) { /* log warning but do not error */ }

  return perTestResults;
}

/**
 * cmdMaintainTestsRunBatch — Execute a batch manifest and record per-test pass/fail/skip.
 *
 * EXEC-02: Batch execution with file-based output capture (not memory buffers).
 * EXEC-04: 3-run flakiness pre-check for all failing tests.
 */
async function cmdMaintainTestsRunBatch(cwd, options, raw) {
  const os = require('os');
  const { batchFile, timeoutSec = 3600, outputFile, batchIndex = 0, env, parallel } = options;

  if (!batchFile) {
    error('maintain-tests run-batch: --batch-file is required');
  }

  // Read batch manifest
  const resolvedBatchFile = path.isAbsolute(batchFile) ? batchFile : path.join(cwd, batchFile);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedBatchFile, 'utf-8'));
  } catch (e) {
    error(`maintain-tests run-batch: could not read batch file "${batchFile}" — ${e.message}`);
  }

  // Support both top-level batch object and manifest with batches array
  // If manifest has a `batches` array, use batches[batchIndex] (zero-based)
  let batchObj;
  if (manifest.batches && Array.isArray(manifest.batches)) {
    const batch = manifest.batches[batchIndex];
    if (!batch) {
      error('maintain-tests run-batch: --batch-index ' + batchIndex + ' out of range (manifest has ' + manifest.batches.length + ' batches)');
    }
    batchObj = batch;
  } else {
    batchObj = manifest;
  }

  const batchId = batchObj.batch_id || manifest.batch_id || 1;
  const runner = batchObj.runner || manifest.runner || 'jest';
  const files = batchObj.files || [];

  const timeoutMs = (timeoutSec || 3600) * 1000;
  const batchStartMs = Date.now();
  const batchTmpPrefix = `maintain-tests-batch-${batchId}-${batchStartMs}`;

  const results = [];
  let batchTimedOut = false;
  const workerCount = parallel ? Math.max(1, parseInt(parallel, 10) || 1) : 0;

  if (workerCount > 1) {
    // Parallel execution — worker pool with N concurrent subprocess runners.
    // Results are collected per-file and merged in manifest order at the end.
    const fileResults = new Array(files.length);
    let nextIndex = 0;

    async function worker() {
      while (true) {
        if (Date.now() - batchStartMs >= timeoutMs) {
          batchTimedOut = true;
          return;
        }
        const idx = nextIndex++;
        if (idx >= files.length) return;
        const testFile = files[idx];
        if (batchTimedOut) {
          fileResults[idx] = [{ file: testFile, runner, status: 'timeout', duration_ms: 0, error_summary: 'batch timeout exceeded', flaky: false, flaky_pass_count: 0 }];
          return;
        }
        const fileOpts = { cwd, env, fileTimeoutMs: undefined };
        fileResults[idx] = await runTestFile(testFile, runner, fileOpts, `${batchTmpPrefix}-w${idx}`);
      }
    }

    // Launch N workers — they self-schedule from the shared nextIndex counter
    await Promise.all(Array.from({ length: Math.min(workerCount, files.length) }, () => worker()));

    // Merge results in manifest order (preserves seed-pinned ordering in output)
    for (let i = 0; i < files.length; i++) {
      if (fileResults[i]) {
        results.push(...fileResults[i]);
      } else {
        results.push({ file: files[i], runner, status: 'timeout', duration_ms: 0, error_summary: 'batch timeout exceeded', flaky: false, flaky_pass_count: 0 });
      }
    }
  } else {
    // Sequential execution (default) — per-file result isolation, deterministic ordering
    for (const testFile of files) {
      // Check batch-level timeout
      if (Date.now() - batchStartMs >= timeoutMs) {
        batchTimedOut = true;
        results.push({ file: testFile, runner, status: 'timeout', duration_ms: 0, error_summary: 'batch timeout exceeded', flaky: false, flaky_pass_count: 0 });
        continue;
      }

      const fileOpts = { cwd, env, fileTimeoutMs: undefined };
      const perTestResults = await runTestFile(testFile, runner, fileOpts, batchTmpPrefix);
      results.push(...perTestResults);
    }
  }

  // 3-run flakiness pre-check for failing tests (EXEC-04)
  // Sequential — not parallel — to preserve predictability
  for (const result of results) {
    if (result.status !== 'failed') continue;

    if (Date.now() - batchStartMs >= timeoutMs) {
      batchTimedOut = true;
      break;
    }

    let passCount = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() - batchStartMs >= timeoutMs) {
        batchTimedOut = true;
        break;
      }
      const rerunResults = await runTestFile(result.file, runner, { cwd, env }, `${batchTmpPrefix}-rerun${attempt}`);
      const anyPassed = rerunResults.some(r => r.status === 'passed');
      if (anyPassed) passCount++;
    }

    if (passCount >= 1) {
      result.flaky = true;
      result.flaky_pass_count = passCount;
      result.status = 'flaky';
    }
  }

  // Tally counts
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let flakyCount = 0;
  let timeoutCount = 0;

  for (const r of results) {
    if (r.status === 'passed') passedCount++;
    else if (r.status === 'failed' || r.status === 'error') failedCount++;
    else if (r.status === 'skipped') skippedCount++;
    else if (r.status === 'flaky') flakyCount++;
    else if (r.status === 'timeout') timeoutCount++;
  }

  const batchOutput = {
    batch_id: batchId,
    runner,
    executed_count: results.length,
    passed_count: passedCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    flaky_count: flakyCount,
    timeout_count: timeoutCount,
    batch_timed_out: batchTimedOut,
    results,
  };

  // Write to --output-file if specified; otherwise output() to stdout
  if (outputFile) {
    const resolvedOutputFile = path.isAbsolute(outputFile) ? outputFile : path.join(cwd, outputFile);
    fs.writeFileSync(resolvedOutputFile, JSON.stringify(batchOutput, null, 2), 'utf-8');
    output({ written: true, path: outputFile, executed_count: results.length }, raw);
  } else {
    output(batchOutput, raw);
  }
}

// ─── Maintain Tests: Ddmin Command ───────────────────────────────────────────

/**
 * cmdMaintainTestsDdmin — Delta debugging: find the minimal subset of co-runner
 * test files that causes `failingTest` to fail when those files are run first.
 *
 * Algorithm: standard ddmin2 adapted for test-order sensitivity.
 * Run cap: configurable via --run-cap N (default 50 for backward compatibility).
 *   Use --run-cap 200 for whole-suite ddmin isolation.
 */
async function cmdMaintainTestsDdmin(cwd, options, raw) {
  const { failingTest, candidatesFile, timeoutSec = 60, outputFile, runner = 'auto', runCap = 50, env } = options;

  if (!failingTest) {
    error('maintain-tests ddmin: --failing-test is required');
  }
  if (!candidatesFile) {
    error('maintain-tests ddmin: --candidates-file is required');
  }

  const timeoutMs = timeoutSec * 1000;
  const RUN_CAP = parseInt(runCap, 10) || 50;
  let runsPerformed = 0;

  // Read candidates list
  let candidates = [];
  try {
    const resolvedCandidates = path.isAbsolute(candidatesFile)
      ? candidatesFile
      : path.join(cwd, candidatesFile);
    const raw2 = fs.readFileSync(resolvedCandidates, 'utf-8');
    const parsed = JSON.parse(raw2);
    candidates = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.test_files) ? parsed.test_files : []);
  } catch (e) {
    error(`maintain-tests ddmin: failed to read --candidates-file "${candidatesFile}" — ${e.message}`);
  }

  // Fast path: no candidates
  if (candidates.length === 0) {
    const result = {
      failing_test: failingTest,
      polluter_set: [],
      candidates_tested: 0,
      runs_performed: 0,
      ddmin_ran: false,
      reason: 'no candidates',
    };
    if (outputFile) {
      const resolved = path.isAbsolute(outputFile) ? outputFile : path.join(cwd, outputFile);
      fs.writeFileSync(resolved, JSON.stringify(result, null, 2), 'utf-8');
      output({ written: true, path: outputFile, ...result }, raw);
    } else {
      output(result, raw);
    }
    return;
  }

  /**
   * runSequence — run prefixFiles in order, then target, return true if target failed.
   * Returns null on timeout (inconclusive).
   */
  async function runSequence(prefixFiles, targetFile) {
    const startMs = Date.now();
    const allFiles = [...prefixFiles, targetFile];
    const opts = { cwd, env };

    for (const testFile of allFiles) {
      if (Date.now() - startMs > timeoutMs) return null;
      runsPerformed++;
      const perTestResults = await runTestFile(testFile, runner, opts, `ddmin-seq-${runsPerformed}`);
      const isTarget = testFile === targetFile;
      if (isTarget) {
        const targetResult = Array.isArray(perTestResults)
          ? perTestResults.find(r => r.file === targetFile || r.file === path.basename(targetFile))
          : perTestResults;
        if (!targetResult) return false;
        return targetResult.status === 'failed' || targetResult.status === 'error';
      }
      // For prefix files we just run them (side effects matter), ignore result
    }
    return false;
  }

  // Sanity check: does the failing test fail alone?
  const failsAlone = await runSequence([], failingTest);
  if (failsAlone === true) {
    const result = {
      failing_test: failingTest,
      polluter_set: [],
      candidates_tested: candidates.length,
      runs_performed: runsPerformed,
      ddmin_ran: false,
      reason: 'test fails in isolation — not an ordering issue',
    };
    if (outputFile) {
      const resolved = path.isAbsolute(outputFile) ? outputFile : path.join(cwd, outputFile);
      fs.writeFileSync(resolved, JSON.stringify(result, null, 2), 'utf-8');
      output({ written: true, path: outputFile, ...result }, raw);
    } else {
      output(result, raw);
    }
    return;
  }

  // Full set check: does the full candidate set trigger the failure?
  if (runsPerformed >= RUN_CAP) {
    const result = {
      failing_test: failingTest,
      polluter_set: [],
      candidates_tested: candidates.length,
      runs_performed: runsPerformed,
      ddmin_ran: true,
      reason: 'run cap reached',
    };
    if (outputFile) {
      const resolved = path.isAbsolute(outputFile) ? outputFile : path.join(cwd, outputFile);
      fs.writeFileSync(resolved, JSON.stringify(result, null, 2), 'utf-8');
      output({ written: true, path: outputFile, ...result }, raw);
    } else {
      output(result, raw);
    }
    return;
  }

  const fullSetFails = await runSequence(candidates, failingTest);
  if (fullSetFails === null) {
    const result = {
      failing_test: failingTest,
      polluter_set: [],
      candidates_tested: candidates.length,
      runs_performed: runsPerformed,
      ddmin_ran: true,
      reason: 'timeout during ddmin',
    };
    if (outputFile) {
      const resolved = path.isAbsolute(outputFile) ? outputFile : path.join(cwd, outputFile);
      fs.writeFileSync(resolved, JSON.stringify(result, null, 2), 'utf-8');
      output({ written: true, path: outputFile, ...result }, raw);
    } else {
      output(result, raw);
    }
    return;
  }
  if (fullSetFails === false) {
    const result = {
      failing_test: failingTest,
      polluter_set: [],
      candidates_tested: candidates.length,
      runs_performed: runsPerformed,
      ddmin_ran: true,
      reason: 'full candidate set does not reproduce failure',
    };
    if (outputFile) {
      const resolved = path.isAbsolute(outputFile) ? outputFile : path.join(cwd, outputFile);
      fs.writeFileSync(resolved, JSON.stringify(result, null, 2), 'utf-8');
      output({ written: true, path: outputFile, ...result }, raw);
    } else {
      output(result, raw);
    }
    return;
  }

  // Ddmin loop (standard ddmin2)
  let remaining = candidates.slice();
  let n = 2;
  let ddminReason = 'minimal polluter set found';
  let timedOut = false;

  ddminLoop: while (remaining.length > 1 && runsPerformed < RUN_CAP) {
    // Split remaining into n equal chunks
    const chunkSize = Math.ceil(remaining.length / n);
    const chunks = [];
    for (let i = 0; i < remaining.length; i += chunkSize) {
      chunks.push(remaining.slice(i, i + chunkSize));
    }

    let reduced = false;
    for (let ci = 0; ci < chunks.length; ci++) {
      if (runsPerformed >= RUN_CAP) {
        ddminReason = 'run cap reached';
        timedOut = true;
        break ddminLoop;
      }

      const chunk = chunks[ci];

      // Test: does just this chunk trigger the failure?
      const chunkFails = await runSequence(chunk, failingTest);
      if (chunkFails === null) {
        ddminReason = 'timeout during ddmin';
        timedOut = true;
        break ddminLoop;
      }
      if (chunkFails === true) {
        remaining = chunk;
        n = Math.max(2, n - 1);
        reduced = true;
        break;
      }

      if (runsPerformed >= RUN_CAP) {
        ddminReason = 'run cap reached';
        timedOut = true;
        break ddminLoop;
      }

      // Test: does remaining minus this chunk trigger the failure?
      const complement = remaining.filter(f => !chunk.includes(f));
      if (complement.length === 0) continue;
      const compFails = await runSequence(complement, failingTest);
      if (compFails === null) {
        ddminReason = 'timeout during ddmin';
        timedOut = true;
        break ddminLoop;
      }
      if (compFails === true) {
        remaining = complement;
        n = Math.max(2, n - 1);
        reduced = true;
        break;
      }
    }

    if (!reduced) {
      if (n >= remaining.length) break;
      n = Math.min(n * 2, remaining.length);
    }
  }

  if (runsPerformed >= RUN_CAP && !timedOut) {
    ddminReason = 'run cap reached';
  }

  const finalResult = {
    failing_test: failingTest,
    polluter_set: remaining,
    candidates_tested: candidates.length,
    runs_performed: runsPerformed,
    ddmin_ran: true,
    reason: ddminReason,
  };

  if (outputFile) {
    const resolved = path.isAbsolute(outputFile) ? outputFile : path.join(cwd, outputFile);
    fs.writeFileSync(resolved, JSON.stringify(finalResult, null, 2), 'utf-8');
    output({ written: true, path: outputFile, ...finalResult }, raw);
  } else {
    output(finalResult, raw);
  }
}

// ─── Activity Commands ────────────────────────────────────────────────────────

function cmdActivitySet(cwd, jsonStr, raw) {
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (e) {
    error(`activity-set: invalid JSON — ${e.message}`);
  }
  data.updated = new Date().toISOString();
  const filePath = path.join(cwd, '.planning', 'current-activity.json');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  output({ written: true, path: '.planning/current-activity.json' }, raw);
}

function cmdActivityClear(cwd, raw) {
  const filePath = path.join(cwd, '.planning', 'current-activity.json');
  try { fs.unlinkSync(filePath); } catch (e) { /* idempotent — no error if file absent */ }
  output({ cleared: true }, raw);
}

function cmdActivityGet(cwd, raw) {
  const filePath = path.join(cwd, '.planning', 'current-activity.json');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    output(JSON.parse(content), raw);
  } catch (e) {
    output({}, raw);
  }
}

main();

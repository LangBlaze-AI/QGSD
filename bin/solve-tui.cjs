#!/usr/bin/env node
'use strict';

/**
 * solve-tui.cjs — Interactive TUI for browsing and acting on human-gated solve items.
 *
 * Imports sweep functions from nf-solve.cjs and presents items (D->C broken claims,
 * C->R untraced modules, T->R orphan tests, D->R unbacked claims) in a paginated
 * navigable interface with actions: acknowledge as false positive, add regex suppression,
 * view item detail.
 *
 * Requirements: QUICK-228
 *
 * Usage:
 *   node bin/solve-tui.cjs              # launch interactive TUI
 *   node bin/solve-tui.cjs --help       # print usage and exit
 *   node bin/solve-tui.cjs --debug-invariants  # enable runtime invariant checks
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();

// STRUCT-04: Configurable Haiku model
const HAIKU_MODEL_DEFAULT = 'claude-haiku-4-5-20251001';
function getHaikuModel() {
  try {
    const cfgPath = path.join(process.env.HOME || '', '.claude', 'nf.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return (cfg.classify && cfg.classify.haiku_model) || HAIKU_MODEL_DEFAULT;
  } catch { return HAIKU_MODEL_DEFAULT; }
}

// ── Claude CLI binary resolver ──────────────────────────────────────────────
// Claude Code installs versioned binaries at ~/.local/share/claude/versions/X.Y.Z
// and does NOT place them on PATH. Resolve the latest version dynamically.
function resolveClaudeCLI() {
  const versionsDir = path.join(os.homedir(), '.local', 'share', 'claude', 'versions');
  if (!fs.existsSync(versionsDir)) return 'claude'; // fallback to PATH lookup
  const versions = fs.readdirSync(versionsDir)
    .filter(f => /^\d+\.\d+\.\d+$/.test(f) && fs.statSync(path.join(versionsDir, f)).isFile())
    .sort((a, b) => {
      const ap = a.split('.').map(Number), bp = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) { if (ap[i] !== bp[i]) return bp[i] - ap[i]; }
      return 0;
    });
  return versions.length > 0 ? path.join(versionsDir, versions[0]) : 'claude';
}

// ── Global error handlers — prevent silent crashes ──────────────────────────
process.on('uncaughtException', (err) => {
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch (_) {}
  process.stderr.write(`\n\x1B[31m[solve-tui] Uncaught exception: ${err.message}\x1B[0m\n`);
  process.stderr.write(err.stack + '\n');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch (_) {}
  process.stderr.write(`\n\x1B[31m[solve-tui] Unhandled rejection: ${reason}\x1B[0m\n`);
  process.exit(1);
});
const FP_PATH = path.join(ROOT, '.planning', 'formal', 'acknowledged-false-positives.json');
const ARCHIVE_PATH = path.join(ROOT, '.planning', 'formal', 'archived-solve-items.json');
const CHANGELOG_PATH = path.join(ROOT, '.planning', 'formal', 'promotion-changelog.json');
const DEBUG_INVARIANTS = process.argv.includes('--debug-invariants');
const PAGE_SIZE = 10;

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const BOLD = '\x1B[1m';
const CYAN = '\x1B[36m';
const YELLOW = '\x1B[33m';
const GREEN = '\x1B[32m';
const RED = '\x1B[31m';
const DIM = '\x1B[2m';
const RESET = '\x1B[0m';
const CLEAR = '\x1B[2J\x1B[0;0H';

// ── Box-drawing characters (follows cross-layer-dashboard.cjs patterns) ──────

const BOX = {
  tl: '\u250C', tr: '\u2510', bl: '\u2514', br: '\u2518',
  h: '\u2500', v: '\u2502',
  ml: '\u251C', mr: '\u2524',
  dtl: '\u2554', dtr: '\u2557', dbl: '\u255A', dbr: '\u255D',
  dh: '\u2550', dv: '\u2551',
};

// ── Data loading ──────────────────────────────────────────────────────────────

const CATEGORIES = [
  { key: 'dtoc', label: 'D->C Broken Claims', sweepFn: 'sweepDtoC', itemKey: 'broken_claims' },
  { key: 'ctor', label: 'C->R Untraced Modules', sweepFn: 'sweepCtoR', itemKey: 'untraced_modules' },
  { key: 'ttor', label: 'T->R Orphan Tests', sweepFn: 'sweepTtoR', itemKey: 'orphan_tests' },
  { key: 'dtor', label: 'D->R Unbacked Claims', sweepFn: 'sweepDtoR', itemKey: 'unbacked_claims' },
];

/**
 * Load sweep data from nf-solve.cjs and normalize to uniform item format.
 * @returns {Object} Map of category key -> { label, items[], error? }
 */
// Lazy-load classification cache (read once per loadSweepData call)
let _classCacheSingleton = null;
function _loadClassCacheLazy() {
  if (_classCacheSingleton) return _classCacheSingleton;
  try {
    const cached = JSON.parse(fs.readFileSync(CLASSIFY_CACHE_PATH, 'utf8'));
    _classCacheSingleton = cached.classifications || {};
  } catch (_) {
    _classCacheSingleton = {};
  }
  return _classCacheSingleton;
}

function loadSweepData() {
  _classCacheSingleton = null; // reset per call
  let solve;
  try {
    solve = require(path.join(__dirname, 'nf-solve.cjs'));
  } catch (err) {
    const result = {};
    for (const cat of CATEGORIES) {
      result[cat.key] = { label: cat.label, items: [], error: 'Failed to load nf-solve.cjs: ' + err.message };
    }
    return result;
  }

  const result = {};
  for (const cat of CATEGORIES) {
    try {
      const fn = solve[cat.sweepFn];
      if (typeof fn !== 'function') {
        result[cat.key] = { label: cat.label, items: [], error: cat.sweepFn + ' is not a function' };
        continue;
      }
      const sweep = fn();
      const detail = sweep.detail || {};

      let rawItems = [];
      if (cat.key === 'dtoc') {
        rawItems = (detail.broken_claims || []).map(item => ({
          type: 'dtoc',
          summary: `${item.type}: ${item.value}`,
          doc_file: item.doc_file,
          line: item.line,
          claimType: item.type,
          value: item.value,
          reason: item.reason,
          category: item.category,
        }));
      } else if (cat.key === 'ctor') {
        rawItems = (detail.untraced_modules || []).map(item => ({
          type: 'ctor',
          summary: item.file || item,
          file: item.file || item,
          nearest_req: item.nearest_req,
          proximity_context: item.proximity_context,
        }));
      } else if (cat.key === 'ttor') {
        rawItems = (detail.orphan_tests || []).map(item => ({
          type: 'ttor',
          summary: typeof item === 'string' ? item : item.file || JSON.stringify(item),
          file: typeof item === 'string' ? item : item.file,
          nearest_req: typeof item === 'object' ? item.nearest_req : undefined,
          proximity_context: typeof item === 'object' ? item.proximity_context : undefined,
        }));
      } else if (cat.key === 'dtor') {
        rawItems = (detail.unbacked_claims || []).map(item => ({
          type: 'dtor',
          summary: item.claim_text || '',
          doc_file: item.doc_file,
          line: item.line,
          claim_text: item.claim_text,
        }));
      }

      // Filter out Haiku-classified FPs so they never enter residual counts
      const classCache = _loadClassCacheLazy();
      const catVerdicts = classCache[cat.key] || {};
      const filtered = rawItems.filter(item => catVerdicts[itemKey(cat.key, item)] !== 'fp');
      const fpCount = rawItems.length - filtered.length;

      result[cat.key] = { label: cat.label, items: filtered, residual: sweep.residual, haiku_fp: fpCount };
    } catch (err) {
      result[cat.key] = { label: cat.label, items: [], error: 'Error: ' + err.message };
    }
  }

  return result;
}

// ── FP persistence ────────────────────────────────────────────────────────────

function readFPFile() {
  try {
    return JSON.parse(fs.readFileSync(FP_PATH, 'utf8'));
  } catch {
    return { entries: [], patterns: [] };
  }
}

function writeFPFile(data) {
  const tmpPath = FP_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, FP_PATH);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

function acknowledgeItem(item) {
  const fpData = readFPFile();
  const now = new Date().toISOString();

  if (item.type === 'dtoc') {
    fpData.entries.push({
      doc_file: item.doc_file,
      value: item.value,
      type: item.claimType,
      reason: 'Acknowledged via TUI',
      acknowledged_at: now,
    });
  } else {
    const sourceMap = { ctor: 'C->R', ttor: 'T->R', dtor: 'D->R' };
    fpData.entries.push({
      source: sourceMap[item.type] || item.type,
      value: item.type === 'dtor' ? itemKey('dtor', item) : (item.file || item.claim_text || item.summary),
      reason: 'Acknowledged via TUI',
      acknowledged_at: now,
    });
  }

  return writeFPFile(fpData);
}

function addRegexPattern(item, regex, reason) {
  const fpData = readFPFile();
  const typeMap = { dtoc: item.claimType || 'general', ctor: 'C->R', ttor: 'T->R', dtor: 'D->R' };
  fpData.patterns.push({
    type: typeMap[item.type] || 'general',
    regex: regex,
    reason: reason,
    enabled: true,
  });
  return writeFPFile(fpData);
}

// ── Archive persistence (dismiss but resurfaceable) ──────────────────────────

function readArchiveFile() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
  } catch {
    return { entries: [] };
  }
}

function writeArchiveFile(data) {
  const tmpPath = ARCHIVE_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, ARCHIVE_PATH);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

function archiveItem(item) {
  const archiveData = readArchiveFile();
  const now = new Date().toISOString();
  const key = item.type === 'dtoc' ? `${item.doc_file}:${item.value}`
    : item.type === 'dtor' ? itemKey('dtor', item)
    : item.file || item.summary;

  // Refuse to archive an item with no identifying key (empty/garbage item) — an
  // empty `{}` used to push an all-undefined entry into the archive (dogfood).
  if (!key || key === 'undefined:undefined') return false;

  // Don't duplicate
  if (archiveData.entries.some(e => e.key === key)) return true;

  archiveData.entries.push({
    key,
    type: item.type,
    summary: item.summary || item.value || item.claim_text || item.file,
    doc_file: item.doc_file,
    file: item.file,
    value: item.value,
    line: item.line,
    archived_at: now,
  });
  return writeArchiveFile(archiveData);
}

function unarchiveItem(item) {
  const archiveData = readArchiveFile();
  const key = item.type === 'dtoc' ? `${item.doc_file}:${item.value}`
    : item.type === 'dtor' ? itemKey('dtor', item)
    : item.file || item.summary;
  archiveData.entries = archiveData.entries.filter(e => e.key !== key);
  return writeArchiveFile(archiveData);
}

function isArchived(item) {
  const archiveData = readArchiveFile();
  const key = item.type === 'dtoc' ? `${item.doc_file}:${item.value}`
    : item.type === 'dtor' ? itemKey('dtor', item)
    : item.file || item.summary;
  const entry = archiveData.entries.find(e => e.key === key);
  if (!entry) return false;

  // Staleness check: if archived >30 days ago AND underlying file modified since, re-surface
  const STALE_DAYS = 30;
  const archivedAt = entry.archived_at ? new Date(entry.archived_at).getTime() : 0;
  const now = Date.now();
  const isOldEnough = (now - archivedAt) > (STALE_DAYS * 24 * 60 * 60 * 1000);

  if (isOldEnough) {
    // Determine the underlying file path to check mtime
    const filePath = item.file || item.doc_file;
    if (filePath) {
      try {
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
        const stat = fs.statSync(absPath);
        if (stat.mtimeMs > archivedAt) {
          return false; // stale archive — re-surface
        }
      } catch (_) {
        // File doesn't exist anymore — keep archived
      }
    }
  }

  return true;
}

// ── File context reader ───────────────────────────────────────────────────────

function readFileContext(filePath, targetLine, contextLines) {
  contextLines = contextLines || 3;
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    const lines = content.split('\n');
    return { lines, totalLines: lines.length };
  } catch (err) {
    return { lines: [], totalLines: 0, error: err.message };
  }
}

// ── TUI State ─────────────────────────────────────────────────────────────────

const state = {
  depth: 0,              // 0=main menu, 1=category list, 2=item detail
  selectedCategory: 0,   // index into CATEGORIES
  selectedItem: 0,       // index into filtered items
  page: 0,               // current page in list view
  filter: '',            // text filter
  typeFilter: 'all',     // D->C type filter
  categoryFilter: 'all', // D->C category filter
  viewMode: 'detail',    // 'detail' or 'file'
  fileViewOffset: 0,     // scroll offset for file viewer
  data: null,            // sweep data
  message: '',           // transient status message
  inputMode: null,       // null, 'filter', 'regex', 'reason'
  inputBuffer: '',       // for line input
  pendingRegex: '',      // temp storage during regex flow
  sessionAcknowledged: 0,
  sessionPatterns: 0,
};

// ── Filtering ─────────────────────────────────────────────────────────────────

function getFilteredItems() {
  if (!state.data) return [];
  const catKey = CATEGORIES[state.selectedCategory].key;
  const catData = state.data[catKey];
  if (!catData || !catData.items) return [];

  let items = catData.items;

  // Text filter
  if (state.filter) {
    const lower = state.filter.toLowerCase();
    items = items.filter(item => {
      const searchable = Object.values(item).map(v => String(v)).join(' ').toLowerCase();
      return searchable.includes(lower);
    });
  }

  // D->C type filter
  if (catKey === 'dtoc' && state.typeFilter !== 'all') {
    items = items.filter(item => item.claimType === state.typeFilter);
  }

  // D->C category filter
  if (catKey === 'dtoc' && state.categoryFilter !== 'all') {
    items = items.filter(item => item.category === state.categoryFilter);
  }

  return items;
}

function getTotalPages() {
  const items = getFilteredItems();
  return Math.max(1, Math.ceil(items.length / PAGE_SIZE));
}

function getPageItems() {
  const items = getFilteredItems();
  const start = state.page * PAGE_SIZE;
  return items.slice(start, start + PAGE_SIZE);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  const W = 78;
  const hr = BOX.h.repeat(W);
  const dhr = BOX.dh.repeat(W);
  const lines = [];

  // Header
  lines.push(BOX.dtl + dhr + BOX.dtr);
  const breadcrumb = getBreadcrumb();
  lines.push(BOX.dv + (BOLD + CYAN + '  nForma Solve TUI' + RESET + DIM + '  ' + breadcrumb + RESET).padEnd(W + 20) + BOX.dv);
  lines.push(BOX.dbl + dhr + BOX.dbr);
  lines.push('');

  if (state.depth === 0) {
    renderMainMenu(lines, W, hr);
  } else if (state.depth === 1) {
    renderCategoryList(lines, W, hr);
  } else if (state.depth === 2) {
    if (state.viewMode === 'file') {
      renderFileView(lines, W, hr);
    } else {
      renderItemDetail(lines, W, hr);
    }
  }

  // Message bar
  if (state.message) {
    lines.push('');
    lines.push(GREEN + '  ' + state.message + RESET);
  }

  // Input mode prompt
  if (state.inputMode === 'filter') {
    lines.push('');
    lines.push(YELLOW + '  Filter: ' + state.inputBuffer + '_' + RESET);
  } else if (state.inputMode === 'regex') {
    lines.push('');
    lines.push(YELLOW + '  Regex pattern: ' + state.inputBuffer + '_' + RESET);
  } else if (state.inputMode === 'reason') {
    lines.push('');
    lines.push(YELLOW + '  Reason: ' + state.inputBuffer + '_' + RESET);
  }

  // Footer
  lines.push('');
  lines.push(DIM + '  ' + getFooterHints() + RESET);

  process.stdout.write(CLEAR + lines.join('\n') + '\n');
}

function getBreadcrumb() {
  if (state.depth === 0) return '';
  const catLabel = CATEGORIES[state.selectedCategory].label;
  if (state.depth === 1) return '> ' + catLabel;
  const items = getFilteredItems();
  const item = items[state.selectedItem];
  const itemLabel = item ? truncate(item.summary, 30) : '?';
  return '> ' + catLabel + ' > ' + itemLabel;
}

function getFooterHints() {
  if (state.inputMode) return 'Enter: confirm | ESC: cancel';
  if (state.depth === 0) return 'Up/Down: navigate | Enter: select | q/ESC: quit';
  if (state.depth === 1) {
    let hints = 'Up/Down: navigate | Enter: select | n/p: page | f: filter | ESC: back | q: quit';
    const catKey = CATEGORIES[state.selectedCategory].key;
    if (catKey === 'dtoc') hints += ' | t: type | c: category';
    return hints;
  }
  if (state.depth === 2) {
    if (state.viewMode === 'file') return 'Up/Down: scroll | ESC: back';
    return 'a: acknowledge FP | r: add regex | v: view file | ESC: back | q: quit';
  }
  return '';
}

// Helper: compute visible (non-ANSI) length of a string
function visLen(s) { return s.replace(/\x1b\[[0-9;]*m/g, '').length; }
// Helper: pad string to visible width W, accounting for ANSI escapes
function visPad(s, w) { return s + ' '.repeat(Math.max(0, w - visLen(s))); }

/**
 * Loads recent promotion/demotion entries from promotion-changelog.json.
 * Returns entries within the last `days` days, sorted by timestamp descending.
 * Fail-open: returns [] on any error.
 */
function loadRecentPromotions(days) {
  try {
    if (!fs.existsSync(CHANGELOG_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(CHANGELOG_PATH, 'utf8'));
    if (!Array.isArray(data)) return [];
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    return data
      .filter(e => e.timestamp && new Date(e.timestamp).getTime() >= cutoff)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  } catch (_) {
    return [];
  }
}

function renderMainMenu(lines, W, hr) {
  if (!state.data) {
    lines.push('  Loading...');
    return;
  }

  // Stats box
  let totalItems = 0;
  for (const cat of CATEGORIES) {
    const d = state.data[cat.key];
    if (d) totalItems += d.items.length;
  }

  lines.push(BOX.tl + hr + BOX.tr);
  lines.push(BOX.v + BOLD + '  Summary'.padEnd(W) + RESET + BOX.v);
  lines.push(BOX.ml + hr + BOX.mr);
  lines.push(BOX.v + `  Total items: ${totalItems}`.padEnd(W) + BOX.v);
  lines.push(BOX.v + `  Acknowledged this session: ${state.sessionAcknowledged}`.padEnd(W) + BOX.v);
  lines.push(BOX.v + `  Patterns added this session: ${state.sessionPatterns}`.padEnd(W) + BOX.v);
  lines.push(BOX.bl + hr + BOX.br);
  lines.push('');

  // Category list
  lines.push(BOX.tl + hr + BOX.tr);
  lines.push(BOX.v + BOLD + '  Categories'.padEnd(W) + RESET + BOX.v);
  lines.push(BOX.ml + hr + BOX.mr);

  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    const d = state.data[cat.key];
    const prefix = i === state.selectedCategory ? CYAN + '> ' + RESET : '  ';
    const highlight = i === state.selectedCategory ? BOLD : '';

    let detail = '';
    if (d && d.error) {
      detail = RED + ' (error)' + RESET;
    } else if (d && d.items.length === 0) {
      detail = DIM + ' (empty)' + RESET;
    } else if (d) {
      const count = d.items.length;
      if (cat.key === 'dtoc') {
        // Show type breakdown
        const types = {};
        for (const item of d.items) {
          types[item.claimType] = (types[item.claimType] || 0) + 1;
        }
        const breakdown = Object.entries(types).map(([t, c]) => `${c} ${t}`).join(', ');
        detail = `: ${count} items (${breakdown})`;
      } else {
        detail = `: ${count} items`;
      }
    }

    lines.push(BOX.v + prefix + highlight + cat.label + RESET + detail.padEnd(W - cat.label.length - 2) + BOX.v);
  }

  lines.push(BOX.bl + hr + BOX.br);

  // Recent Promotions section (display-only — no new depth states)
  const recentPromos = loadRecentPromotions(7);
  if (recentPromos.length > 0) {
    lines.push('');
    lines.push(BOX.tl + hr + BOX.tr);
    lines.push(BOX.v + BOLD + visPad('  Recent Gate Changes (7d)', W) + RESET + BOX.v);
    lines.push(BOX.ml + hr + BOX.mr);
    for (const p of recentPromos.slice(0, 5)) {
      const arrow = p.trigger === 'evidence_regression' ? RED + ' DEMOTED ' + RESET : GREEN + ' PROMOTED' + RESET;
      const model = (p.model || '').length > 30 ? '...' + p.model.slice(-27) : p.model;
      const line = '  ' + arrow + ' ' + model.padEnd(32) + p.from_level + ' -> ' + p.to_level;
      lines.push(BOX.v + visPad(line, W) + BOX.v);
    }
    if (recentPromos.length > 5) {
      const moreLine = DIM + '  ... and ' + (recentPromos.length - 5) + ' more' + RESET;
      lines.push(BOX.v + visPad(moreLine, W) + BOX.v);
    }
    lines.push(BOX.bl + hr + BOX.br);
  }
}

function renderCategoryList(lines, W, hr) {
  const catKey = CATEGORIES[state.selectedCategory].key;
  const catLabel = CATEGORIES[state.selectedCategory].label;
  const filtered = getFilteredItems();
  const totalPages = getTotalPages();
  const pageItems = getPageItems();

  // Info bar
  lines.push(BOX.tl + hr + BOX.tr);
  const pageInfo = `Page ${state.page + 1}/${totalPages} | ${filtered.length} items`;
  lines.push(BOX.v + BOLD + ('  ' + catLabel).padEnd(W - pageInfo.length - 2) + RESET + DIM + pageInfo + '  ' + RESET + BOX.v);
  lines.push(BOX.ml + hr + BOX.mr);

  // Active filters
  const filters = [];
  if (state.filter) filters.push('text: "' + state.filter + '"');
  if (catKey === 'dtoc' && state.typeFilter !== 'all') filters.push('type: ' + state.typeFilter);
  if (catKey === 'dtoc' && state.categoryFilter !== 'all') filters.push('cat: ' + state.categoryFilter);
  if (filters.length > 0) {
    lines.push(BOX.v + YELLOW + '  Filters: ' + filters.join(' | ') + RESET + ' '.repeat(Math.max(0, W - 12 - filters.join(' | ').length)) + BOX.v);
    lines.push(BOX.ml + hr + BOX.mr);
  }

  if (pageItems.length === 0) {
    lines.push(BOX.v + DIM + '  (no items)'.padEnd(W) + RESET + BOX.v);
  } else {
    for (let i = 0; i < pageItems.length; i++) {
      const globalIdx = state.page * PAGE_SIZE + i;
      const item = pageItems[i];
      const prefix = globalIdx === state.selectedItem ? CYAN + '> ' + RESET : '  ';
      const highlight = globalIdx === state.selectedItem ? BOLD : '';
      const num = String(globalIdx + 1).padStart(3) + '. ';
      const summary = truncate(item.summary, W - 8);
      lines.push(BOX.v + prefix + highlight + num + summary + RESET + ' '.repeat(Math.max(0, W - summary.length - 6)) + BOX.v);
    }
  }

  lines.push(BOX.bl + hr + BOX.br);
}

function renderItemDetail(lines, W, hr) {
  const filtered = getFilteredItems();
  const item = filtered[state.selectedItem];
  if (!item) {
    lines.push('  No item selected');
    return;
  }

  lines.push(BOX.tl + hr + BOX.tr);
  lines.push(BOX.v + BOLD + '  Item Detail'.padEnd(W) + RESET + BOX.v);
  lines.push(BOX.ml + hr + BOX.mr);

  if (item.type === 'dtoc') {
    addDetailLine(lines, W, 'File', item.doc_file);
    addDetailLine(lines, W, 'Line', String(item.line || 'N/A'));
    addDetailLine(lines, W, 'Type', item.claimType);
    addDetailLine(lines, W, 'Value', item.value);
    addDetailLine(lines, W, 'Reason', item.reason);
    addDetailLine(lines, W, 'Category', item.category);
  } else if (item.type === 'ctor') {
    addDetailLine(lines, W, 'File', item.file);
    // Show first 5 lines
    const ctx = readFileContext(item.file);
    if (ctx.error) {
      addDetailLine(lines, W, 'Preview', RED + ctx.error + RESET);
    } else {
      lines.push(BOX.ml + hr + BOX.mr);
      const previewLines = ctx.lines.slice(0, 5);
      for (let i = 0; i < previewLines.length; i++) {
        const ln = DIM + String(i + 1).padStart(4) + BOX.v + RESET + ' ' + truncate(previewLines[i], W - 8);
        lines.push(BOX.v + '  ' + ln + ' '.repeat(Math.max(0, W - ln.length - 2 + 10)) + BOX.v);
      }
    }
  } else if (item.type === 'ttor') {
    addDetailLine(lines, W, 'Test file', item.file);
    const ctx = readFileContext(item.file);
    if (ctx.error) {
      addDetailLine(lines, W, 'Preview', RED + ctx.error + RESET);
    } else {
      lines.push(BOX.ml + hr + BOX.mr);
      const previewLines = ctx.lines.slice(0, 10);
      for (let i = 0; i < previewLines.length; i++) {
        const ln = DIM + String(i + 1).padStart(4) + BOX.v + RESET + ' ' + truncate(previewLines[i], W - 8);
        lines.push(BOX.v + '  ' + ln + ' '.repeat(Math.max(0, W - ln.length - 2 + 10)) + BOX.v);
      }
    }
  } else if (item.type === 'dtor') {
    addDetailLine(lines, W, 'File', item.doc_file);
    addDetailLine(lines, W, 'Line', String(item.line || 'N/A'));
    addDetailLine(lines, W, 'Claim', item.claim_text);
  }

  // Show context lines for items with line numbers
  if ((item.doc_file || item.file) && item.line) {
    const filePath = item.doc_file || item.file;
    const ctx = readFileContext(filePath);
    if (!ctx.error && ctx.lines.length > 0) {
      lines.push(BOX.ml + hr + BOX.mr);
      lines.push(BOX.v + BOLD + '  Context'.padEnd(W) + RESET + BOX.v);
      lines.push(BOX.ml + hr + BOX.mr);
      const startLine = Math.max(0, item.line - 4);
      const endLine = Math.min(ctx.lines.length, item.line + 3);
      for (let i = startLine; i < endLine; i++) {
        const lineNum = String(i + 1).padStart(4);
        const isTarget = i + 1 === item.line;
        const color = isTarget ? YELLOW : '';
        const marker = isTarget ? '>' : ' ';
        const lineText = truncate(ctx.lines[i] || '', W - 10);
        lines.push(BOX.v + color + ' ' + marker + lineNum + BOX.v + ' ' + lineText + RESET + ' '.repeat(Math.max(0, W - lineText.length - 8)) + BOX.v);
      }
    }
  }

  lines.push(BOX.bl + hr + BOX.br);
}

function renderFileView(lines, W, hr) {
  const filtered = getFilteredItems();
  const item = filtered[state.selectedItem];
  if (!item) { lines.push('  No item'); return; }

  const filePath = item.doc_file || item.file;
  if (!filePath) { lines.push('  No file associated'); return; }

  const ctx = readFileContext(filePath);
  if (ctx.error) {
    lines.push('  ' + RED + 'Error: ' + ctx.error + RESET);
    return;
  }

  const viewLines = 20;
  const start = state.fileViewOffset;
  const end = Math.min(ctx.lines.length, start + viewLines);

  lines.push(BOX.tl + hr + BOX.tr);
  const info = `Lines ${start + 1}-${end} of ${ctx.totalLines}`;
  lines.push(BOX.v + BOLD + ('  ' + truncate(filePath, W - info.length - 4)).padEnd(W - info.length - 2) + RESET + DIM + info + '  ' + RESET + BOX.v);
  lines.push(BOX.ml + hr + BOX.mr);

  for (let i = start; i < end; i++) {
    const lineNum = String(i + 1).padStart(4);
    const isTarget = item.line && (i + 1 === item.line);
    const color = isTarget ? YELLOW : '';
    const marker = isTarget ? '>' : ' ';
    const lineText = truncate(ctx.lines[i] || '', W - 10);
    lines.push(BOX.v + color + ' ' + marker + lineNum + BOX.v + ' ' + lineText + RESET + ' '.repeat(Math.max(0, W - lineText.length - 8)) + BOX.v);
  }

  lines.push(BOX.bl + hr + BOX.br);
}

function addDetailLine(lines, W, label, value) {
  const padLabel = (label + ':').padEnd(12);
  const text = '  ' + padLabel + (value || 'N/A');
  lines.push(BOX.v + truncate(text, W).padEnd(W) + BOX.v);
}

function truncate(str, maxLen) {
  if (!str) return '';
  str = String(str);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

// ── Invariant checks ──────────────────────────────────────────────────────────

function checkInvariants(lastAction, oldDepth) {
  if (!DEBUG_INVARIANTS) return;

  // DepthBounded: depth >= 0 && depth <= 3
  if (state.depth < 0 || state.depth > 3) {
    process.stderr.write(`[INVARIANT VIOLATION] DepthBounded: depth=${state.depth}\n`);
    state.depth = 0;
  }

  // EscapeProgress: ESC always reduces depth
  if (lastAction === 'escape' && state.depth >= oldDepth) {
    process.stderr.write(`[INVARIANT VIOLATION] EscapeProgress: depth went ${oldDepth}->${state.depth}\n`);
    state.depth = Math.max(0, oldDepth - 1);
  }

  // NoDeadlock: at least one valid keypress is handled
  const validKeys = state.depth === 0
    ? ['up', 'down', 'return', 'escape', 'q']
    : state.depth === 1
      ? ['up', 'down', 'return', 'escape', 'q', 'n', 'p', 'f']
      : ['escape', 'q', 'a', 'r', 'v'];
  if (validKeys.length === 0) {
    process.stderr.write(`[INVARIANT VIOLATION] NoDeadlock: no valid keys at depth=${state.depth}\n`);
    state.depth = 0;
  }
}

// ── Input handling ────────────────────────────────────────────────────────────

const TYPE_CYCLE = ['all', 'file_path', 'cli_command', 'dependency'];
const CATEGORY_CYCLE = ['all', 'user', 'developer', 'examples'];

function handleKeypress(str, key) {
  if (!key) return;

  state.message = '';
  const oldDepth = state.depth;

  // Input mode handling (filter, regex, reason prompts)
  if (state.inputMode) {
    handleInputMode(str, key);
    render();
    return;
  }

  // Global: q to quit
  if (key.name === 'q' && !key.ctrl) {
    exitTUI();
    return;
  }

  // Ctrl+C
  if (key.ctrl && key.name === 'c') {
    exitTUI();
    return;
  }

  // ESC: reduce depth (EscapeProgress invariant)
  if (key.name === 'escape') {
    if (state.depth === 2 && state.viewMode === 'file') {
      state.viewMode = 'detail';
    } else if (state.depth > 0) {
      state.depth--;
      if (state.depth === 0) {
        state.filter = '';
        state.typeFilter = 'all';
        state.categoryFilter = 'all';
      }
    } else {
      exitTUI();
      return;
    }
    checkInvariants('escape', oldDepth);
    render();
    return;
  }

  if (state.depth === 0) {
    handleMainMenu(key);
  } else if (state.depth === 1) {
    handleCategoryList(str, key);
  } else if (state.depth === 2) {
    handleItemDetail(str, key);
  }

  checkInvariants(key.name, oldDepth);
  render();
}

function handleMainMenu(key) {
  if (key.name === 'up') {
    state.selectedCategory = Math.max(0, state.selectedCategory - 1);
  } else if (key.name === 'down') {
    state.selectedCategory = Math.min(CATEGORIES.length - 1, state.selectedCategory + 1);
  } else if (key.name === 'return') {
    state.depth = 1;
    state.selectedItem = 0;
    state.page = 0;
    state.filter = '';
    state.typeFilter = 'all';
    state.categoryFilter = 'all';
  }
}

function handleCategoryList(str, key) {
  const filtered = getFilteredItems();

  if (key.name === 'up') {
    state.selectedItem = Math.max(0, state.selectedItem - 1);
    // Adjust page if needed
    state.page = Math.floor(state.selectedItem / PAGE_SIZE);
  } else if (key.name === 'down') {
    state.selectedItem = Math.min(filtered.length - 1, state.selectedItem + 1);
    state.page = Math.floor(state.selectedItem / PAGE_SIZE);
  } else if (key.name === 'return') {
    if (filtered.length > 0 && state.selectedItem < filtered.length) {
      state.depth = 2;
      state.viewMode = 'detail';
      state.fileViewOffset = 0;
    }
  } else if (str === 'n' || key.name === 'pagedown') {
    const totalPages = getTotalPages();
    if (state.page < totalPages - 1) {
      state.page++;
      state.selectedItem = state.page * PAGE_SIZE;
    }
  } else if (str === 'p' || key.name === 'pageup') {
    if (state.page > 0) {
      state.page--;
      state.selectedItem = state.page * PAGE_SIZE;
    }
  } else if (str === 'f') {
    if (state.filter) {
      state.filter = '';
      state.selectedItem = 0;
      state.page = 0;
    } else {
      state.inputMode = 'filter';
      state.inputBuffer = '';
    }
  } else if (str === 't') {
    const catKey = CATEGORIES[state.selectedCategory].key;
    if (catKey === 'dtoc') {
      const idx = TYPE_CYCLE.indexOf(state.typeFilter);
      state.typeFilter = TYPE_CYCLE[(idx + 1) % TYPE_CYCLE.length];
      state.selectedItem = 0;
      state.page = 0;
    }
  } else if (str === 'c') {
    const catKey = CATEGORIES[state.selectedCategory].key;
    if (catKey === 'dtoc') {
      const idx = CATEGORY_CYCLE.indexOf(state.categoryFilter);
      state.categoryFilter = CATEGORY_CYCLE[(idx + 1) % CATEGORY_CYCLE.length];
      state.selectedItem = 0;
      state.page = 0;
    }
  }
}

function handleItemDetail(str, key) {
  if (state.viewMode === 'file') {
    // File viewer mode
    const item = getFilteredItems()[state.selectedItem];
    if (!item) return;
    const filePath = item.doc_file || item.file;
    if (!filePath) return;
    const ctx = readFileContext(filePath);
    if (key.name === 'up') {
      state.fileViewOffset = Math.max(0, state.fileViewOffset - 1);
    } else if (key.name === 'down') {
      state.fileViewOffset = Math.min(Math.max(0, ctx.totalLines - 20), state.fileViewOffset + 1);
    }
    return;
  }

  // Detail mode actions
  if (str === 'a') {
    const items = getFilteredItems();
    const item = items[state.selectedItem];
    if (item) {
      const ok = acknowledgeItem(item);
      if (ok) {
        state.sessionAcknowledged++;
        state.message = 'Acknowledged -- will be suppressed on next sweep';
        // Remove from in-memory list
        const catKey = CATEGORIES[state.selectedCategory].key;
        const catItems = state.data[catKey].items;
        const originalIdx = catItems.indexOf(item);
        if (originalIdx >= 0) catItems.splice(originalIdx, 1);
        state.depth = 1;
        state.selectedItem = Math.min(state.selectedItem, getFilteredItems().length - 1);
        if (state.selectedItem < 0) state.selectedItem = 0;
        state.page = Math.floor(state.selectedItem / PAGE_SIZE);
      } else {
        state.message = RED + 'Error writing acknowledgment file' + RESET;
      }
    }
  } else if (str === 'r') {
    state.inputMode = 'regex';
    state.inputBuffer = '';
  } else if (str === 'v') {
    const item = getFilteredItems()[state.selectedItem];
    if (item && (item.doc_file || item.file)) {
      state.viewMode = 'file';
      state.fileViewOffset = 0;
      if (item.line) {
        state.fileViewOffset = Math.max(0, item.line - 10);
      }
    } else {
      state.message = 'No file associated with this item';
    }
  }
}

function handleInputMode(str, key) {
  if (key.name === 'escape') {
    state.inputMode = null;
    state.inputBuffer = '';
    return;
  }

  if (key.name === 'return') {
    if (state.inputMode === 'filter') {
      state.filter = state.inputBuffer;
      state.selectedItem = 0;
      state.page = 0;
      state.inputMode = null;
      state.inputBuffer = '';
    } else if (state.inputMode === 'regex') {
      // Validate regex
      try {
        new RegExp(state.inputBuffer);
        state.pendingRegex = state.inputBuffer;
        state.inputMode = 'reason';
        state.inputBuffer = '';
      } catch (err) {
        state.message = RED + 'Invalid regex: ' + err.message + RESET;
        state.inputBuffer = '';
      }
    } else if (state.inputMode === 'reason') {
      const item = getFilteredItems()[state.selectedItem];
      if (item) {
        const ok = addRegexPattern(item, state.pendingRegex, state.inputBuffer || 'Added via TUI');
        if (ok) {
          state.sessionPatterns++;
          state.message = 'Pattern added -- will be applied on next sweep';
          state.depth = 1;
          state.selectedItem = Math.min(state.selectedItem, getFilteredItems().length - 1);
          if (state.selectedItem < 0) state.selectedItem = 0;
        } else {
          state.message = RED + 'Error writing pattern file' + RESET;
        }
      }
      state.inputMode = null;
      state.inputBuffer = '';
      state.pendingRegex = '';
    }
    return;
  }

  if (key.name === 'backspace') {
    state.inputBuffer = state.inputBuffer.slice(0, -1);
    return;
  }

  // Regular character input
  if (str && !key.ctrl && !key.meta && str.length === 1) {
    state.inputBuffer += str;
  }
}

// ── Terminal management ───────────────────────────────────────────────────────

function exitTUI() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.removeAllListeners('keypress');

  console.log('');
  console.log(BOLD + 'Session Summary' + RESET);
  console.log(`  Acknowledged: ${state.sessionAcknowledged} items`);
  console.log(`  Patterns added: ${state.sessionPatterns}`);
  console.log('');
  process.exit(0);
}

// ── Help text ─────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${BOLD}nForma Solve TUI${RESET} — Interactive browser for human-gated solve items

${BOLD}Usage:${RESET}
  node bin/solve-tui.cjs              Launch interactive TUI
  node bin/solve-tui.cjs --help       Show this help
  node bin/solve-tui.cjs --debug-invariants  Enable runtime invariant checks

${BOLD}Navigation:${RESET}
  Up/Down     Navigate within lists
  Enter       Select item / enter category
  ESC         Go back one level (always reduces depth)
  q           Quit from any level
  n/p         Next/Previous page in list view
  PgUp/PgDn   Same as n/p

${BOLD}Filtering (in list view):${RESET}
  f           Toggle text filter
  t           Cycle type filter (D->C only: all/file_path/cli_command/dependency)
  c           Cycle category filter (D->C only: all/user/developer/examples)

${BOLD}Actions (in item detail):${RESET}
  a           Acknowledge item as false positive
  r           Add regex suppression pattern
  v           View file content around the item

${BOLD}Data Sources:${RESET}
  D->C        Broken structural claims in documentation
  C->R        Source modules with no requirement tracing
  T->R        Test files with no requirement annotation
  D->R        Documentation claims without requirement backing
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Load data
  state.data = loadSweepData();

  // Check if all empty
  let totalItems = 0;
  for (const cat of CATEGORIES) {
    const d = state.data[cat.key];
    if (d) totalItems += d.items.length;
  }
  if (totalItems === 0) {
    console.log(GREEN + 'All clean! No human-gated items found.' + RESET);
    process.exit(0);
  }

  // Enter raw mode
  if (!process.stdin.isTTY) {
    console.error('Error: solve-tui requires an interactive terminal (TTY)');
    process.exit(1);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', handleKeypress);

  render();
}

// ── Requirement & TODO creation ───────────────────────────────────────────

/**
 * Create a requirement from a solve item (C->R, T->R, or D->R).
 * @param {Object} item  Normalized solve item
 * @param {string} catKey  Category key: 'ctor', 'ttor', 'dtor'
 * @returns {{ ok: boolean, id?: string, reason?: string }}
 */
/**
 * Build the default requirement text for a solve item (without creating it).
 * @param {Object} item  Normalized solve item
 * @param {string} catKey  Category key (ctor, ttor, dtor, dtoc)
 * @returns {string} Proposed requirement text
 */
function proposeRequirementText(item, catKey) {
  const prefixMap = { ctor: 'Code module', ttor: 'Test file', dtor: 'Doc claim' };
  const prefix = prefixMap[catKey] || 'Solve item';
  return prefix + ': ' + (item.file || item.claim_text || item.value || item.summary);
}

/**
 * Create a requirement from a solve item.
 * @param {Object} item  Normalized solve item
 * @param {string} catKey  Category key (ctor, ttor, dtor, dtoc)
 * @param {string} [textOverride]  Optional custom text (replaces default)
 * @returns {{ ok: boolean, id?: string, text?: string }}
 */
function createRequirementFromItem(item, catKey, textOverride) {
  const rc = require(path.join(__dirname, 'requirements-core.cjs'));
  const text = textOverride || proposeRequirementText(item, catKey);

  const id = rc.nextRequirementId('SOLVE');
  const reqObj = {
    id,
    text,
    category: 'Solver-Discovered',
    status: 'Proposed',
    provenance: {
      source_file: item.file || item.doc_file,
      milestone: 'solver-tui',
    },
  };

  return rc.addRequirement(reqObj);
}

/**
 * Create a TODO item from a D->C broken claim.
 * @param {Object} item  Normalized D->C solve item
 * @returns {{ ok: boolean, id?: string }}
 */
function createTodoFromItem(item) {
  // Refuse to write a garbage todo from an empty/invalid item — an empty `{}` used
  // to push a TODO with all-undefined fields into the real .planning/todos.json
  // (dogfood: createTodoFromItem({}) polluted live state).
  if (!item || (item.value == null && item.doc_file == null && item.file == null)) {
    return { ok: false, reason: 'invalid item: no value/doc_file/file' };
  }
  const todoPath = path.join(ROOT, '.planning', 'todos.json');
  let todoData;
  try {
    todoData = JSON.parse(fs.readFileSync(todoPath, 'utf8'));
  } catch (_) {
    todoData = { created_at: new Date().toISOString(), items: [] };
  }
  if (!Array.isArray(todoData.items)) todoData.items = [];

  const now = new Date().toISOString();
  const id = 'TODO-' + Date.now();
  todoData.items.push({
    id,
    source: 'solver-dtoc',
    file: item.doc_file,
    value: item.value,
    reason: item.reason,
    line: item.line,
    created_at: now,
  });

  // Atomic write
  const tmpPath = todoPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(todoData, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, todoPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return { ok: false, reason: err.message };
  }

  return { ok: true, id };
}

// ── Haiku sub-agent classifier ────────────────────────────────────────────────

const CLASSIFY_CACHE_PATH = path.join(ROOT, '.planning', 'formal', 'solve-classifications.json');

/**
 * Classify solve items using Claude Haiku as a sub-agent (via claude CLI subprocess).
 * Per-item forever cache: once an item is classified, its verdict persists until
 * the item disappears from sweep results. Only NEW/unclassified items are sent to Haiku.
 *
 * Verdicts:
 *   genuine  — real gap that needs human action
 *   fp       — false positive, safe to auto-suppress
 *   review   — ambiguous, needs human judgment
 *
 * @param {Object} sweepData - Output of loadSweepData()
 * @param {Object} opts - { force: boolean } to reclassify all items
 * @param {Function} [onProgress] - callback(message) for progress updates
 * @returns {Object} { dtoc: {[itemKey]: verdict}, ctor: {...}, ... , _stats: {cached, classified, failed} }
 */
function classifyWithHaiku(sweepData, opts = {}, onProgress) {
  // Load existing per-item cache
  let existingCache = {};
  try {
    const cached = JSON.parse(fs.readFileSync(CLASSIFY_CACHE_PATH, 'utf8'));
    existingCache = cached.classifications || {};
  } catch (_) { /* no cache yet */ }

  const classifications = {};
  const stats = { cached: 0, classified: 0, failed: 0 };

  for (const catKey of ['dtoc', 'ctor', 'ttor', 'dtor']) {
    const cat = sweepData[catKey];
    if (!cat || cat.error || !cat.items || cat.items.length === 0) {
      classifications[catKey] = existingCache[catKey] || {};
      continue;
    }

    // Start with existing cached verdicts for this category
    const catClassifications = { ...(existingCache[catKey] || {}) };
    const items = cat.items;

    // Find items that need classification (not in cache, or force mode)
    const needsClassification = [];
    for (let i = 0; i < items.length; i++) {
      const key = itemKey(catKey, items[i]);
      if (opts.force || !catClassifications[key]) {
        needsClassification.push({ idx: i, item: items[i], key });
      } else {
        stats.cached++;
      }
    }

    if (needsClassification.length === 0) {
      classifications[catKey] = catClassifications;
      continue;
    }

    if (onProgress) onProgress(`Classifying ${needsClassification.length} new items in ${catKey}...`);

    // Batch unclassified items to Haiku
    const BATCH_SIZE = 50;
    for (let batchStart = 0; batchStart < needsClassification.length; batchStart += BATCH_SIZE) {
      const batch = needsClassification.slice(batchStart, batchStart + BATCH_SIZE);
      const itemLines = batch.map((entry, batchIdx) => {
        const item = entry.item;
        if (catKey === 'dtoc') {
          return `${batchIdx}: [${item.claimType}] "${item.value}" in ${item.doc_file}:${item.line} — ${item.reason}`;
        } else if (catKey === 'ctor') {
          return `${batchIdx}: ${item.file} — module not traced to any requirement${item.nearest_req ? ' (nearest: ' + item.nearest_req + ')' : ''}${item.proximity_context ? ' (near: ' + item.proximity_context.slice(0, 3).join(', ') + ')' : ''}`;
        } else if (catKey === 'ttor') {
          return `${batchIdx}: ${item.file} — test has no @req annotation${item.nearest_req ? ' (nearest: ' + item.nearest_req + ')' : ''}${item.proximity_context ? ' (near: ' + item.proximity_context.slice(0, 3).join(', ') + ')' : ''}`;
        } else if (catKey === 'dtor') {
          return `${batchIdx}: "${(item.claim_text || '').slice(0, 80)}" in ${item.doc_file}:${item.line}`;
        }
        return `${batchIdx}: ${JSON.stringify(item).slice(0, 100)}`;
      }).join('\n');

      const categoryDesc = {
        dtoc: 'D→C Broken Claims: doc references to files/commands/dependencies that don\'t exist in the codebase',
        ctor: 'C→R Untraced Modules: code files not mentioned in any requirement. Infrastructure/utility scripts (build, lint, migrate, validate, check, install tools) are typically NOT requirement-traced and should be classified as "fp". Feature modules that implement user-facing or system behavior SHOULD be traced. Items marked \'(nearest: REQ-XX)\' have a nearby requirement in the proximity graph — more likely fp.',
        ttor: 'T→R Orphan Tests: test files without @req annotations. Tests for infrastructure/utility scripts are typically "fp". Tests for feature modules should be "review". Items marked \'(nearest: REQ-XX)\' have a nearby requirement — more likely fp.',
        dtor: 'D→R Unbacked Claims: doc sentences with action verbs (provides, ensures, validates...) that don\'t match any requirement keywords',
      };

      const prompt = `You are classifying items from a formal verification sweep of a Node.js CLI project called nForma (a Claude Code plugin for multi-model planning workflows).

Category: ${categoryDesc[catKey]}

Classify each item as ONE of:
- genuine: Real gap that needs human action (missing file, real broken reference, feature module that should have requirement tracing)
- fp: False positive — noise that should be auto-suppressed (infrastructure scripts, utility modules, config references, English words misclassified as packages, test helpers)
- review: Ambiguous — needs human judgment

Items to classify:
${itemLines}

Respond with ONLY a JSON object mapping index to verdict. Example: {"0":"fp","1":"genuine","2":"review"}
No explanation, no markdown, just the JSON object.`;

      // Retry loop with backoff (#26: retry failed classifications)
      const MAX_RETRIES = 2;
      let batchSuccess = false;
      for (let attempt = 0; attempt < MAX_RETRIES && !batchSuccess; attempt++) {
        try {
          if (attempt > 0) {
            // Backoff: 2s for retry
            const { execSync: sleepExec } = require('child_process');
            try { sleepExec('sleep 2', { stdio: 'ignore' }); } catch (_) {}
          }
          const cleanEnv = { ...process.env };
          delete cleanEnv.CLAUDECODE; // Prevent "cannot launch inside another session" block
          const result = execFileSync(
            resolveClaudeCLI(),
            ['-p', prompt, '--model', getHaikuModel()],
            { env: cleanEnv, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
          ).trim();

          const jsonMatch = result.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const verdicts = JSON.parse(jsonMatch[0]);
            for (const [idxStr, verdict] of Object.entries(verdicts)) {
              const batchIdx = parseInt(idxStr, 10);
              if (!isNaN(batchIdx) && batchIdx < batch.length && ['genuine', 'fp', 'review'].includes(verdict)) {
                catClassifications[batch[batchIdx].key] = verdict;
                stats.classified++;
              }
            }
            batchSuccess = true;
          } else {
            if (!stats.error_types) stats.error_types = {};
            stats.error_types['parse_error'] = (stats.error_types['parse_error'] || 0) + 1;
          }
        } catch (e) {
          if (attempt === MAX_RETRIES - 1) {
            // Final attempt failed — track error details (#26)
            stats.failed += batch.length;
            if (!stats.error_types) stats.error_types = {};
            const errType = e.killed ? 'timeout' : (e.code === 'ENOENT' ? 'cli_not_found' : 'api_error');
            stats.error_types[errType] = (stats.error_types[errType] || 0) + batch.length;
            if (!stats.failed_items) stats.failed_items = [];
            for (const entry of batch) {
              stats.failed_items.push(entry.key);
            }
          }
        }
      }
    }

    classifications[catKey] = catClassifications;
  }

  // Clean up old-format keys that are no longer valid (cache migration)
  for (const catKey of ['dtoc', 'dtor']) {
    const catCache = existingCache[catKey] || {};
    for (const key of Object.keys(catCache)) {
      // New keys are 16-char hex strings; old keys contain ':' or '/'
      if (key.includes(':') || key.includes('/')) {
        delete catCache[key];
      }
    }
  }

  // Persist merged cache (keeps old items that may no longer appear in sweeps)
  try {
    const mergedCache = {};
    for (const catKey of ['dtoc', 'ctor', 'ttor', 'dtor']) {
      mergedCache[catKey] = { ...(existingCache[catKey] || {}), ...(classifications[catKey] || {}) };
    }
    const cacheData = { updated_at: new Date().toISOString(), classifications: mergedCache };
    fs.writeFileSync(CLASSIFY_CACHE_PATH, JSON.stringify(cacheData, null, 2));
  } catch (_) { /* best effort */ }

  // Auto-archive FP items so they're pre-dismissed in the TUI
  let autoArchived = 0;
  try {
    const archiveData = readArchiveFile();
    const existingKeys = new Set(archiveData.entries.map(e => e.key));
    const now = new Date().toISOString();

    for (const catKey of ['dtoc', 'ctor', 'ttor', 'dtor']) {
      const items = sweepData[catKey]?.items || [];
      const catVerdicts = classifications[catKey] || {};

      for (const item of items) {
        const iKey = itemKey(catKey, item);
        if (catVerdicts[iKey] !== 'fp') continue;

        // Derive archive key (same logic as archiveItem)
        const archKey = catKey === 'dtoc' ? `${item.doc_file}:${item.value}`
          : catKey === 'dtor' ? itemKey('dtor', item)
          : item.file || item.summary;
        if (existingKeys.has(archKey)) continue;

        archiveData.entries.push({
          key: archKey,
          type: catKey,
          summary: item.summary || item.value || item.claim_text || item.file,
          doc_file: item.doc_file,
          file: item.file,
          value: item.value,
          line: item.line,
          archived_at: now,
          auto_classified: 'fp',
        });
        existingKeys.add(archKey);
        autoArchived++;
      }
    }

    if (autoArchived > 0) writeArchiveFile(archiveData);
  } catch (_) { /* best effort */ }

  stats.auto_archived = autoArchived;
  classifications._stats = stats;

  // Prune stale entries from cache and archive (best-effort cleanup)
  try {
    const pruned = pruneStaleEntries(sweepData);
    classifications._pruned = pruned;
  } catch (_) { /* best effort */ }

  return classifications;
}

// NOTE: Keys changed from path:value to SHA-256 content hashes in v0.36-02 (CLASS-01).
// Old-format keys (containing ':' or '/') are treated as cache misses and cleaned up
// during the next classifyWithHaiku() run.
/** Generate a stable content-hash key for an item to use in classification cache */
function itemKey(catKey, item) {
  if (catKey === 'dtoc') {
    // Discriminate on value + doc_file too. `reason` is generic for whole classes of
    // dtoc items (e.g. "not in any dependency manifest"), so hashing reason alone
    // collapsed dozens of distinct items to ONE cache key — a single Haiku verdict
    // was then silently applied to all of them (dogfood: 44 items → 1 key → wrong
    // classifications).
    const content = [item.reason || '', item.value || '', item.doc_file || ''].join('\x00');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
  if (catKey === 'ctor') return item.file;
  if (catKey === 'ttor') return item.file;
  if (catKey === 'dtor') {
    const content = item.claim_text || item.reason || item.value || '';
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
  return JSON.stringify(item).slice(0, 100);
}

/** Read cached classifications if they exist */
function readClassificationCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(CLASSIFY_CACHE_PATH, 'utf8'));
    return cached.classifications || {};
  } catch (_) { return {}; }
}

/**
 * pruneStaleEntries(sweepData)
 *
 * Remove cache and archive entries for items that are no longer in the current sweep.
 * This cleans up stale entries from pre-code-trace-index era that no longer appear.
 *
 * @param {object} sweepData - result from loadSweepData() with structure {catKey: {items: [...]}}
 * @returns {object} {cache_pruned: N, archive_pruned: M}
 */
function pruneStaleEntries(sweepData) {
  let cachePruned = 0;
  let archivePruned = 0;

  // Build set of all current item keys per category
  const currentKeys = {};
  for (const cat of CATEGORIES) {
    currentKeys[cat.key] = new Set();
    const catData = sweepData[cat.key];
    if (catData && catData.items) {
      for (const item of catData.items) {
        currentKeys[cat.key].add(itemKey(cat.key, item));
      }
    }
  }

  // Prune classification cache
  try {
    const cached = JSON.parse(fs.readFileSync(CLASSIFY_CACHE_PATH, 'utf8'));
    const classifications = cached.classifications || {};
    const envelope = { updated_at: new Date().toISOString(), classifications };

    for (const catKey of ['dtoc', 'ctor', 'ttor', 'dtor']) {
      const catCache = classifications[catKey] || {};
      const keysToRemove = [];

      for (const key of Object.keys(catCache)) {
        if (!currentKeys[catKey].has(key)) {
          keysToRemove.push(key);
          cachePruned++;
        }
      }

      for (const key of keysToRemove) {
        delete catCache[key];
      }

      classifications[catKey] = catCache;
    }

    fs.writeFileSync(CLASSIFY_CACHE_PATH, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  } catch (_) { /* best effort */ }

  // Prune archive
  try {
    const archiveData = readArchiveFile();
    const originalLength = archiveData.entries.length;

    archiveData.entries = archiveData.entries.filter(entry => {
      // Keep the entry if its key exists in current items for that type
      if (!currentKeys[entry.type]) return true; // Unknown type — keep to be safe
      return currentKeys[entry.type].has(entry.key);
    });

    archivePruned = originalLength - archiveData.entries.length;
    if (archivePruned > 0) {
      writeArchiveFile(archiveData);
    }
  } catch (_) { /* best effort */ }

  return { cache_pruned: cachePruned, archive_pruned: archivePruned };
}

// ── Live residual computation ─────────────────────────────────────────────────

/**
 * Returns known_issues from solve-state.json with net_residual recomputed live
 * from current FP classifications and archive state. This avoids stale snapshots
 * when items are triaged via /nf:resolve between /nf:solve runs.
 */
function getLiveKnownIssues() {
  let solveState;
  try {
    solveState = JSON.parse(fs.readFileSync(path.join(ROOT, '.planning', 'formal', 'solve-state.json'), 'utf8'));
  } catch (_) { return []; }

  const issues = solveState.known_issues || [];
  if (issues.length === 0) return issues;

  // Load current sweep data (already applies Haiku FP filtering)
  const sweepData = loadSweepData();

  const LAYER_TO_CAT = {
    d_to_c: 'dtoc',
    c_to_r: 'ctor',
    t_to_r: 'ttor',
    d_to_r: 'dtor',
  };

  return issues.map(issue => {
    const catKey = LAYER_TO_CAT[issue.layer];
    if (!catKey) return issue; // non-human-gated layer, return as-is

    const cat = sweepData[catKey];
    if (!cat || !cat.items) return { ...issue, net_residual: 0 };

    // Count items that survive both FP filter (already done by loadSweepData) AND archive
    const live = cat.items.filter(i => !isArchived(i));
    return { ...issue, net_residual: live.length };
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  main();
} else {
  module.exports = {
    loadSweepData,
    getLiveKnownIssues,
    readFPFile,
    writeFPFile,
    acknowledgeItem,
    addRegexPattern,
    readFileContext,
    CATEGORIES,
    proposeRequirementText,
    createRequirementFromItem,
    createTodoFromItem,
    classifyWithHaiku,
    readClassificationCache,
    itemKey,
    readArchiveFile,
    archiveItem,
    unarchiveItem,
    isArchived,
    pruneStaleEntries,
  };
}

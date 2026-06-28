#!/usr/bin/env node
'use strict';
// bin/solve-focus-filter.cjs
// Focus filter for nf:solve — tokenizes a focus phrase and matches against
// requirements.json + category-groups.json to scope diagnostic sweeps.
//
// Requirements: QUICK-252

const fs = require('fs');
const path = require('path');

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'in', 'of', 'and', 'or', 'is',
  'it', 'on', 'by', 'with', 'from', 'that', 'this', 'at', 'as',
]);

/**
 * Tokenize a focus phrase: lowercase, split on whitespace/hyphens,
 * remove stop words, keep tokens >= 2 chars.
 */
function tokenize(phrase) {
  if (!phrase || typeof phrase !== 'string') return [];
  return phrase
    .toLowerCase()
    .split(/[\s\-]+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Filter requirements by focus phrase.
 *
 * @param {string|null|undefined} focusPhrase - The focus phrase to match against
 * @param {{ root?: string }} options
 * @returns {Set<string>|null} Set of matching requirement IDs, or null if no filter
 */
function filterRequirementsByFocus(focusPhrase, { root = process.cwd() } = {}) {
  if (!focusPhrase || typeof focusPhrase !== 'string') return null;

  const tokens = tokenize(focusPhrase);
  if (tokens.length === 0) return null;

  // Load requirements.json (envelope format)
  const reqPath = path.join(root, '.planning', 'formal', 'requirements.json');
  let requirements = [];
  try {
    const reqData = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
    if (Array.isArray(reqData)) {
      requirements = reqData;
    } else if (reqData.requirements && Array.isArray(reqData.requirements)) {
      requirements = reqData.requirements;
    } else if (reqData.groups && Array.isArray(reqData.groups)) {
      for (const group of reqData.groups) {
        if (group.requirements && Array.isArray(group.requirements)) {
          for (const r of group.requirements) requirements.push(r);
        }
      }
    }
  } catch (e) {
    // If requirements.json missing or invalid, return empty set
    return new Set();
  }

  // Load category-groups.json
  const cgPath = path.join(root, '.planning', 'formal', 'category-groups.json');
  let categoryGroups = {};
  try {
    categoryGroups = JSON.parse(fs.readFileSync(cgPath, 'utf8'));
  } catch (e) {
    // Fail-open: proceed without category group matching
  }

  const matched = new Set();

  for (const r of requirements) {
    if (!r || typeof r !== 'object') continue;
    const id = String(r.id || r.requirement_id || '').toLowerCase();
    const category = String(r.category || '').toLowerCase();
    const text = String(r.text || r.description || '').toLowerCase();
    const background = String(r.background || '').toLowerCase();

    // Look up the category group name for this requirement's raw category
    const rawCategory = r.category_raw || r.category || '';
    const groupRaw = Object.prototype.hasOwnProperty.call(categoryGroups, rawCategory)
      ? categoryGroups[rawCategory]
      : '';
    const groupName = (typeof groupRaw === 'string' ? groupRaw : '').toLowerCase();

    let score = 0;

    for (const token of tokens) {
      // +2 for ID match
      if (id.includes(token)) {
        score += 2;
      }
      // +2 for category match
      if (category.includes(token)) {
        score += 2;
      }
      // +3 for category group name match
      if (groupName && groupName.includes(token)) {
        score += 3;
      }
      // +1 for text match
      if (text.includes(token)) {
        score += 1;
      }
      // +1 for background match (graceful: field may not exist)
      if (background.includes(token)) {
        score += 1;
      }
    }

    if (score >= 2) {
      matched.add(r.id || r.requirement_id || '');
    }
  }

  return matched;
}

/**
 * Returns a one-line description of the focus filter result.
 *
 * @param {string} focusPhrase
 * @param {Set<string>} matchedIds
 * @param {number} totalIds
 * @returns {string}
 */
function describeFocusFilter(focusPhrase, matchedIds, totalIds) {
  return `Focus: '${focusPhrase}' -- ${matchedIds.size}/${totalIds} requirements matched`;
}

module.exports = { filterRequirementsByFocus, describeFocusFilter, tokenize };

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
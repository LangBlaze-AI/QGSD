#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Load baseline requirements filtered by project profile.
 *
 * @param {string} profile - One of: web, mobile, desktop, api, cli, library
 * @param {string} [basePath] - Path to baseline-requirements directory, defaults to core/defaults/baseline-requirements
 * @returns {Object} { profile, label, description, categories: [...], total }
 */
function loadBaselineRequirements(profile, basePath) {
  const defaultBasePath = path.resolve(__dirname, '../core/defaults/baseline-requirements');
  const basePathToUse = basePath || defaultBasePath;

  // Read index.json
  const indexPath = path.join(basePathToUse, 'index.json');
  const indexContent = fs.readFileSync(indexPath, 'utf8');
  const index = JSON.parse(indexContent);

  // Validate profile (own-property check so __proto__/constructor/toString are rejected)
  if (!Object.prototype.hasOwnProperty.call(index.profiles, profile)) {
    throw new Error(`Invalid profile: ${profile}. Supported profiles: ${Object.keys(index.profiles).join(', ')}`);
  }

  const profileConfig = index.profiles[profile];
  const profileLabel = profileConfig.label;
  const profileDescription = profileConfig.description;

  // Process categories
  const categories = [];
  let totalRequirements = 0;

  for (const categoryMeta of index.categories) {
    const categoryFile = categoryMeta.file;
    const categoryPath = path.join(basePathToUse, categoryFile);

    // Check if we should load this category at all
    if (profileConfig.includes_only && !profileConfig.includes_only.includes(categoryFile.replace('.json', ''))) {
      continue; // Skip categories not in includes_only
    }

    const categoryContent = fs.readFileSync(categoryPath, 'utf8');
    const category = JSON.parse(categoryContent);

    // Filter requirements based on profile
    let filteredRequirements = category.requirements;

    if (!profileConfig.includes_all) {
      // Filter based on per-requirement profiles array
      filteredRequirements = category.requirements.filter(req => req.profiles.includes(profile));
    }

    if (filteredRequirements.length === 0) {
      continue; // Skip empty categories
    }

    // Assign sequential IDs per category using id_template
    // Extract prefix from id_template (e.g., "UX-{N}" -> "UX")
    const idTemplate = filteredRequirements[0].id_template;
    const prefix = idTemplate.split('-')[0];

    const categoryRequirements = filteredRequirements.map((req, index) => {
      const reqId = `${prefix}-${String(index + 1).padStart(2, '0')}`;
      return {
        id: reqId,
        text: req.text,
        intent: req.intent,
        verifiable_by: req.verifiable_by,
      };
    });

    categories.push({
      name: category.category,
      description: category.description,
      requirements: categoryRequirements,
    });

    totalRequirements += categoryRequirements.length;
  }

  return {
    profile,
    label: profileLabel,
    description: profileDescription,
    categories,
    total: totalRequirements,
  };
}

/**
 * Load baseline requirements filtered by intent object.
 * Supports conditional packs activated by intent dimensions.
 *
 * @param {Object} intent - Intent object with base_profile and optional dimensions
 * @param {string} intent.base_profile - Required: one of web, mobile, desktop, api, cli, library
 * @param {boolean} [intent.iac] - Optional: include IaC pack if true
 * @param {boolean} [intent.deploy] - Optional: deployment target (for future use)
 * @param {boolean} [intent.sensitive] - Optional: handles sensitive data
 * @param {boolean} [intent.oss] - Optional: open source project
 * @param {boolean} [intent.monorepo] - Optional: monorepo setup
 * @param {string} [basePath] - Path to baseline-requirements directory
 * @returns {Object} { profile, label, intent, categories, packs_applied, total }
 */
function loadBaselineRequirementsFromIntent(intent, basePath) {
  const defaultBasePath = path.resolve(__dirname, '../core/defaults/baseline-requirements');
  const basePathToUse = basePath || defaultBasePath;

  // Validate base_profile
  if (!intent || !intent.base_profile) {
    throw new Error('intent.base_profile is required');
  }

  // Read index.json
  const indexPath = path.join(basePathToUse, 'index.json');
  const indexContent = fs.readFileSync(indexPath, 'utf8');
  const index = JSON.parse(indexContent);

  // Validate base_profile exists (own-property check so __proto__/constructor/toString are rejected)
  if (!Object.prototype.hasOwnProperty.call(index.profiles, intent.base_profile)) {
    throw new Error(`Invalid base_profile: ${intent.base_profile}. Supported profiles: ${Object.keys(index.profiles).join(', ')}`);
  }

  const baseProfile = intent.base_profile;
  const profileConfig = index.profiles[baseProfile];
  const profileLabel = profileConfig.label;

  // Derive has_ui from base_profile
  const has_ui = ['web', 'mobile', 'desktop'].includes(baseProfile);

  // Build enriched intent with defaults
  const defaultIntent = {
    iac: false,
    deploy: 'none',
    sensitive: false,
    oss: false,
    monorepo: false,
  };

  const enrichedIntent = {
    ...defaultIntent,
    ...intent,
    has_ui,
  };

  // Process packs
  const categories = [];
  let totalRequirements = 0;
  const packsApplied = [];

  if (!index.packs) {
    throw new Error('index.json missing packs section');
  }

  for (const [packName, packConfig] of Object.entries(index.packs)) {
    let shouldIncludePack = false;

    if (packConfig.activation === 'always') {
      shouldIncludePack = true;
    } else if (packConfig.activation === 'conditional') {
      const intentKey = packConfig.intent_key;
      const intentValue = packConfig.intent_value;
      shouldIncludePack = enrichedIntent[intentKey] === intentValue;
    }

    if (!shouldIncludePack) {
      continue;
    }

    const categoryFile = packConfig.file;
    const categoryPath = path.join(basePathToUse, categoryFile);

    // Check if we should load this category based on profile config
    if (profileConfig.includes_only && !profileConfig.includes_only.includes(categoryFile.replace('.json', ''))) {
      continue;
    }

    const categoryContent = fs.readFileSync(categoryPath, 'utf8');
    const category = JSON.parse(categoryContent);

    // Filter requirements based on profile
    let filteredRequirements = category.requirements;

    if (!profileConfig.includes_all) {
      // Filter based on per-requirement profiles array
      filteredRequirements = category.requirements.filter(req => req.profiles.includes(baseProfile));
    }

    if (filteredRequirements.length === 0) {
      continue;
    }

    // Assign sequential IDs per category using id_template
    const idTemplate = filteredRequirements[0].id_template;
    const prefix = idTemplate.split('-')[0];

    const categoryRequirements = filteredRequirements.map((req, index) => {
      const reqId = `${prefix}-${String(index + 1).padStart(2, '0')}`;
      return {
        id: reqId,
        text: req.text,
        intent: req.intent,
        verifiable_by: req.verifiable_by,
      };
    });

    categories.push({
      name: category.category,
      description: category.description,
      requirements: categoryRequirements,
    });

    totalRequirements += categoryRequirements.length;
    packsApplied.push(packName);
  }

  return {
    profile: baseProfile,
    label: profileLabel,
    intent: enrichedIntent,
    categories,
    packs_applied: packsApplied,
    total: totalRequirements,
  };
}

// CLI mode
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--list-profiles')) {
    const indexPath = path.resolve(__dirname, '../core/defaults/baseline-requirements/index.json');
    const indexContent = fs.readFileSync(indexPath, 'utf8');
    const index = JSON.parse(indexContent);
    const profiles = Object.entries(index.profiles).map(([key, val]) => ({
      key,
      label: val.label,
      description: val.description,
    }));
    console.log(JSON.stringify(profiles, null, 2));
    process.exit(0);
  }

  // Check for --intent-file flag
  const intentFileIdx = args.indexOf('--intent-file');
  if (intentFileIdx !== -1 && args[intentFileIdx + 1]) {
    const intentFilePath = args[intentFileIdx + 1];
    try {
      const intentContent = fs.readFileSync(intentFilePath, 'utf8');
      const intent = JSON.parse(intentContent);
      const result = loadBaselineRequirementsFromIntent(intent);
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(`Error loading intent file: ${err.message}`);
      process.exit(1);
    }
  }

  const profileIdx = args.indexOf('--profile');
  if (profileIdx === -1 || !args[profileIdx + 1]) {
    console.error('Usage: node bin/load-baseline-requirements.cjs --profile <web|mobile|desktop|api|cli|library>');
    console.error('       node bin/load-baseline-requirements.cjs --intent-file <path>');
    console.error('       node bin/load-baseline-requirements.cjs --list-profiles');
    process.exit(1);
  }

  const profile = args[profileIdx + 1];
  const result = loadBaselineRequirements(profile);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { loadBaselineRequirements, loadBaselineRequirementsFromIntent };

#!/usr/bin/env node
// bin/task-envelope.cjs
// Task envelope CLI tool for structured research→plan→quorum handoff
// Provides: init, update, read, validate commands + exported validation functions

'use strict';

const fs = require('fs');
const path = require('path');

// Schema definition
const ENVELOPE_SCHEMA = {
  schema_version: 'string (must be "1")',
  phase: 'string (must match v\\d+\\.\\d+-\\d{2})',
  created_at: 'string (ISO 8601, auto-generated)',
  risk_level: 'string (low|medium|high)',
  research: 'object (optional)',
  plan: 'object (optional)',
  quorum: 'object (optional)'
};

// Validate envelope against schema
function validateEnvelope(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object') {
    errors.push('Envelope must be an object');
    return { valid: false, errors };
  }

  // Check schema_version
  if (typeof obj.schema_version !== 'string' || obj.schema_version !== '1') {
    errors.push('schema_version must be string "1"');
  }

  // Check phase format: v\d+\.\d+-\d{2}
  if (!obj.phase || typeof obj.phase !== 'string' || !/^v\d+\.\d+-\d{2}/.test(obj.phase)) {
    errors.push('phase must match format v\\d+\\.\\d+-\\d{2} (e.g., v0.18-03)');
  }

  // Check risk_level
  if (!obj.risk_level || !['low', 'medium', 'high'].includes(obj.risk_level)) {
    errors.push('risk_level must be one of: low, medium, high');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// Find phase directory in .planning/phases/
function findPhaseDir(phaseId) {
  const phasesDir = path.join(process.cwd(), '.planning', 'phases');

  if (!fs.existsSync(phasesDir)) {
    return null;
  }

  // Look for directory matching phaseId or phaseId-*
  const dirs = fs.readdirSync(phasesDir);
  const match = dirs.find(d => d === phaseId || d.startsWith(phaseId + '-'));

  if (!match) {
    return null;
  }

  return path.join(phasesDir, match);
}

// Get envelope path for a phase
function getEnvelopePath(phaseId) {
  const phaseDir = findPhaseDir(phaseId);
  if (!phaseDir) {
    return null;
  }
  return path.join(phaseDir, 'task-envelope.json');
}

// Write JSON atomically: tmpPath + renameSync
function writeAtomicJson(targetPath, obj) {
  const dir = path.dirname(targetPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${targetPath}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmpPath, targetPath);
    return true;
  } catch (e) {
    // Clean up temp file if rename failed
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw e;
  }
}

// Parse comma-separated arguments into array
function parseCommaList(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// main: handle CLI commands
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    process.stderr.write('[task-envelope] ERROR: no command specified\n');
    process.stderr.write('Usage: task-envelope.cjs <init|update|read|validate> [options]\n');
    process.exit(1);
  }

  const command = args[0];

  try {
    if (command === 'init') {
      commandInit(args);
    } else if (command === 'update') {
      commandUpdate(args);
    } else if (command === 'read') {
      commandRead(args);
    } else if (command === 'validate') {
      commandValidate(args);
    } else {
      process.stderr.write(`[task-envelope] ERROR: unknown command "${command}"\n`);
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`[task-envelope] ERROR: ${e.message}\n`);
    process.exit(1);
  }
}

// Command: init
function commandInit(args) {
  // Parse arguments
  let phase, objective = '', constraints = '', targetFiles = [], confidence = 'HIGH', riskLevel = 'medium';

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--phase' && i + 1 < args.length) {
      phase = args[++i];
    } else if (args[i] === '--objective' && i + 1 < args.length) {
      objective = args[++i];
    } else if (args[i] === '--constraints' && i + 1 < args.length) {
      constraints = args[++i];
    } else if (args[i] === '--target-files' && i + 1 < args.length) {
      targetFiles = parseCommaList(args[++i]);
    } else if (args[i] === '--confidence' && i + 1 < args.length) {
      confidence = args[++i];
    } else if (args[i] === '--risk-level' && i + 1 < args.length) {
      riskLevel = args[++i];
    }
  }

  if (!phase) {
    process.stderr.write('[task-envelope] ERROR: --phase is required\n');
    process.exit(1);
  }

  // Validate risk_level
  const validRiskLevels = ['low', 'medium', 'high'];
  let finalRiskLevel = riskLevel;
  if (!validRiskLevels.includes(riskLevel)) {
    process.stderr.write(`[task-envelope] WARNING: invalid risk_level "${riskLevel}"; using "medium"\n`);
    finalRiskLevel = 'medium';
  }

  // Find phase directory
  const phaseDir = findPhaseDir(phase);
  if (!phaseDir) {
    process.stderr.write(`[task-envelope] ERROR: phase directory not found for "${phase}"\n`);
    process.exit(1);
  }

  // Create envelope object
  const envelope = {
    schema_version: '1',
    phase,
    created_at: new Date().toISOString(),
    risk_level: finalRiskLevel,
    research: {
      objective,
      constraints,
      target_files: targetFiles,
      confidence
    }
  };

  // Validate and write
  const validation = validateEnvelope(envelope);
  if (!validation.valid) {
    process.stderr.write(`[task-envelope] ERROR: invalid envelope: ${validation.errors.join('; ')}\n`);
    process.exit(1);
  }

  const envelopePath = path.join(phaseDir, 'task-envelope.json');
  writeAtomicJson(envelopePath, envelope);
  console.log(`[task-envelope] initialized: ${envelopePath}`);
}

// Command: update
function commandUpdate(args) {
  // Parse arguments
  let section = null;
  let phase, planPath, keyDecisions = [], waveCount = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--section' && i + 1 < args.length) {
      section = args[++i];
    } else if (args[i] === '--phase' && i + 1 < args.length) {
      phase = args[++i];
    } else if (args[i] === '--plan-path' && i + 1 < args.length) {
      planPath = args[++i];
    } else if (args[i] === '--key-decisions' && i + 1 < args.length) {
      keyDecisions = parseCommaList(args[++i]);
    } else if (args[i] === '--wave-count' && i + 1 < args.length) {
      waveCount = parseInt(args[++i], 10);
    }
  }

  if (!section) {
    process.stderr.write('[task-envelope] ERROR: --section is required for update\n');
    process.exit(1);
  }

  if (!phase) {
    process.stderr.write('[task-envelope] ERROR: --phase is required\n');
    process.exit(1);
  }

  if (section === 'plan' && !planPath) {
    process.stderr.write('[task-envelope] ERROR: --plan-path is required for --section plan\n');
    process.exit(1);
  }

  // Find phase directory
  const phaseDir = findPhaseDir(phase);
  if (!phaseDir) {
    process.stderr.write(`[task-envelope] ERROR: phase directory not found for "${phase}"\n`);
    process.exit(1);
  }

  const envelopePath = path.join(phaseDir, 'task-envelope.json');

  // Read existing envelope or create minimal one.
  // Recover to a fresh minimal envelope when the file is missing, unreadable,
  // corrupt, or not a plain object — mirroring the missing-file branch so a
  // garbage file is never strictly worse than no file.
  const minimalEnvelope = () => ({
    schema_version: '1',
    phase,
    created_at: new Date().toISOString(),
    risk_level: 'medium'
  });
  let envelope = minimalEnvelope();
  if (fs.existsSync(envelopePath)) {
    try {
      const content = fs.readFileSync(envelopePath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        envelope = parsed;
      }
    } catch {
      // corrupt/unreadable file -> fall back to minimal envelope
    }
  }

  // Update section
  if (section === 'plan') {
    envelope.plan = {
      plan_path: planPath,
      key_decisions: keyDecisions
    };
    if (waveCount !== null && !isNaN(waveCount)) {
      envelope.plan.wave_count = waveCount;
    }
  }

  // Validate and write
  const validation = validateEnvelope(envelope);
  if (!validation.valid) {
    process.stderr.write(`[task-envelope] ERROR: invalid envelope: ${validation.errors.join('; ')}\n`);
    process.exit(1);
  }

  writeAtomicJson(envelopePath, envelope);
  console.log(`[task-envelope] updated: ${envelopePath}`);
}

// Command: read
function commandRead(args) {
  // Parse arguments
  let phase;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--phase' && i + 1 < args.length) {
      phase = args[++i];
    }
  }

  if (!phase) {
    process.stderr.write('[task-envelope] ERROR: --phase is required\n');
    process.exit(1);
  }

  const envelopePath = getEnvelopePath(phase);
  if (!envelopePath || !fs.existsSync(envelopePath)) {
    process.stderr.write(`[task-envelope] ERROR: envelope not found for "${phase}"\n`);
    process.exit(1);
  }

  const content = fs.readFileSync(envelopePath, 'utf8');
  const envelope = JSON.parse(content);
  console.log(JSON.stringify(envelope, null, 2));
}

// Command: validate
function commandValidate(args) {
  // Parse arguments
  let phase;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--phase' && i + 1 < args.length) {
      phase = args[++i];
    }
  }

  if (!phase) {
    process.stderr.write('[task-envelope] ERROR: --phase is required\n');
    process.exit(1);
  }

  const envelopePath = getEnvelopePath(phase);
  if (!envelopePath || !fs.existsSync(envelopePath)) {
    console.log(JSON.stringify({ valid: false, errors: ['envelope not found'] }));
    return;
  }

  const content = fs.readFileSync(envelopePath, 'utf8');
  let envelope;
  try {
    envelope = JSON.parse(content);
  } catch (e) {
    console.log(JSON.stringify({ valid: false, errors: ['malformed JSON'] }));
    return;
  }

  const result = validateEnvelope(envelope);
  console.log(JSON.stringify(result));
}

// Exports for testing
module.exports = {
  validateEnvelope,
  ENVELOPE_SCHEMA
};

// Run main if executed directly
if (require.main === module) {
  main();
}

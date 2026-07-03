#!/usr/bin/env node
'use strict';
// bin/lint-formal-models.cjs
// Formal model health linter — finds fat, unbounded, and overly complex models.
// For each violation, identifies the hottest field/variable and suggests a fix.
//
// NOTE: This script uses ONLY fs/path — no child_process, no shell commands.
//
// Data sources:
//   .planning/formal/policy.yaml        — model_health budgets
//   .planning/formal/alloy/*.als        — Alloy models
//   .planning/formal/state-space-report.json — pre-computed TLA+ analysis
//
// Usage:
//   node bin/lint-formal-models.cjs              # lint all models
//   node bin/lint-formal-models.cjs --json       # JSON output
//   node bin/lint-formal-models.cjs --summary    # counts only
//
// Exit codes:
//   0 — no violations (or mode=warn)
//   1 — violations found and mode=fail

var fs   = require('fs');
var path = require('path');

var ROOT      = process.cwd();
var ALLOY_DIR = path.join(ROOT, '.planning', 'formal', 'alloy');
var POLICY    = path.join(ROOT, '.planning', 'formal', 'policy.yaml');
var TLA_REPORT = path.join(ROOT, '.planning', 'formal', 'state-space-report.json');
var TAG       = '[lint-formal]';

var cliArgs = process.argv.slice(2);
var jsonMode    = cliArgs.indexOf('--json') !== -1;
var summaryMode = cliArgs.indexOf('--summary') !== -1;

// ── Policy loader (simple YAML subset — no dependency needed) ────────────────

function loadPolicy() {
  var defaults = {
    max_scenarios: 1e12,
    max_sigs: 12,
    max_fields: 10,
    require_bounded_tla: true,
    mode: 'warn',
  };

  if (!fs.existsSync(POLICY)) return defaults;

  var content = fs.readFileSync(POLICY, 'utf8');
  var section = extractYamlSection(content, 'model_health');
  if (!section) return defaults;

  return {
    max_scenarios: parseYamlNumber(section, 'max_scenarios', defaults.max_scenarios),
    max_sigs: parseYamlNumber(section, 'max_sigs', defaults.max_sigs),
    max_fields: parseYamlNumber(section, 'max_fields', defaults.max_fields),
    require_bounded_tla: parseYamlBool(section, 'require_bounded_tla', defaults.require_bounded_tla),
    mode: parseYamlString(section, 'mode', defaults.mode),
  };
}

function extractYamlSection(content, key) {
  var regex = new RegExp('^' + key + ':\\s*$', 'm');
  var match = content.match(regex);
  if (!match) return null;
  var start = match.index + match[0].length;
  var rest = content.substring(start);
  var lines = rest.split('\n');
  var sectionLines = [];
  for (var i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i].length > 0 && !lines[i].startsWith(' ') && !lines[i].startsWith('#')) break;
    sectionLines.push(lines[i]);
  }
  return sectionLines.join('\n');
}

function parseYamlNumber(section, key, fallback) {
  var match = section.match(new RegExp('^\\s*' + key + ':\\s*([\\d.e+]+)', 'm'));
  return match ? parseFloat(match[1]) : fallback;
}

function parseYamlBool(section, key, fallback) {
  var match = section.match(new RegExp('^\\s*' + key + ':\\s*(true|false)', 'm'));
  return match ? match[1] === 'true' : fallback;
}

function parseYamlString(section, key, fallback) {
  var match = section.match(new RegExp('^\\s*' + key + ':\\s*"?([\\w]+)"?', 'm'));
  return match ? match[1] : fallback;
}

// ── Alloy parser ────────────────────────────────────────────────────────────

function parseAlloySigs(content) {
  var sigs = [];
  var sigRegex = /\b(abstract\s+)?(one\s+|lone\s+)?sig\s+(\w+(?:\s*,\s*\w+)*)\s*(?:extends\s+(\w+)\s*)?\{([^}]*)\}/g;
  var match;
  while ((match = sigRegex.exec(content)) !== null) {
    var isAbstract = !!match[1];
    var mult = (match[2] || '').trim();
    var names = match[3].split(',').map(function(n) { return n.trim(); }).filter(Boolean);
    var parent = match[4] || null;
    var body = match[5];
    for (var i = 0; i < names.length; i++) {
      sigs.push({ name: names[i], isAbstract: isAbstract, mult: mult, parent: parent, fields: parseFields(body) });
    }
  }
  return sigs;
}

function parseFields(body) {
  var fields = [];
  var lines = body.split(',');
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].replace(/--.*$/, '').trim();
    if (!trimmed) continue;
    var m = trimmed.match(/^(\w+)\s*:\s*(one\s+|set\s+|lone\s+|seq\s+)?(.+)$/);
    if (m) {
      fields.push({ name: m[1], mult: (m[2] || 'one').trim(), type: m[3].trim() });
    }
  }
  return fields;
}

// Static semantic check: flag references to signatures that are not defined in
// this model — a dangling signature reference (e.g. a predicate quantifying over
// a nonexistent sig, or a field targeting an undefined type). This catches
// semantic corruption that the structural counters (max-sigs/fields/scenarios)
// miss, without invoking the real Alloy analyzer (stays --fast-native, no Java).
//
// Conservative to avoid false positives on valid models: only Capitalized
// identifiers (Alloy sig naming convention) that appear in a TYPE position —
// a field target type, an `extends` parent, or a quantifier binding `x: Type` —
// and are neither a defined sig nor an Alloy built-in are flagged. nForma's
// models use no `open` imports, so the in-file sig set is the complete universe.
var ALLOY_BUILTINS = new Set(['Int', 'Bool', 'univ', 'none', 'iden', 'seq', 'String', 'Time', 'Ord']);

function extractAlloyTypeRefs(typeExpr) {
  // Candidate sig identifiers in a (possibly composite) type expression, e.g.
  // "Account -> lone Balance", "set PoolState". Capitalized tokens only. Inline
  // comments are stripped first — a multi-field sig body can leave a trailing
  // `-- …Word` on an earlier field's type (parseFields only removes one to EOS),
  // and prose Capitalized words must never be read as signatures.
  // Strip ALL comment forms (line --/// AND block; per CodeRabbit review) — an
  // inline block comment in a field type ("one /* Word */ Balance") would leak a
  // prose Capitalized word as a false-positive dangling ref.
  var clean = stripAlloyComments(String(typeExpr));
  return clean.match(/\b[A-Z]\w*/g) || [];
}

// Strip Alloy comments so prose (which is full of Capitalized words) is never
// mistaken for code: line comments `--…` and `//…`, and block comments `/* … */`.
function stripAlloyComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function checkAlloyDanglingRefs(content, sigs) {
  var violations = [];
  var known = new Set();
  for (var s = 0; s < sigs.length; s++) known.add(sigs[s].name);
  var seen = new Set();
  function consider(name, where) {
    if (!name || known.has(name) || ALLOY_BUILTINS.has(name)) return;
    if (seen.has(name)) return;
    seen.add(name);
    violations.push({ rule: 'dangling-sig-ref', message: 'reference to undefined signature "' + name + '" (' + where + ')' });
  }
  // Field target types and `extends` parents come from the structural parse.
  for (var i = 0; i < sigs.length; i++) {
    if (sigs[i].parent) consider(sigs[i].parent, 'extends ' + sigs[i].name);
    for (var j = 0; j < sigs[i].fields.length; j++) {
      var refs = extractAlloyTypeRefs(sigs[i].fields[j].type);
      for (var k = 0; k < refs.length; k++) consider(refs[k], 'field ' + sigs[i].name + '.' + sigs[i].fields[j].name);
    }
  }
  // Quantifier bindings must be anchored to a real Alloy quantifier keyword —
  // `all x: Type`, `some x: Type`, etc. — NOT any `word: Word` (which matches
  // prose). Comments are stripped first. This is what catches a predicate that
  // quantifies over a nonexistent signature.
  var code = stripAlloyComments(content);
  var bindingRe = /\b(?:all|some|no|one|lone|sum)\s+(?:disj\s+)?\w+(?:\s*,\s*\w+)*\s*:\s*(?:set\s+|one\s+|lone\s+|some\s+|seq\s+)?([A-Z]\w*)/g;
  var m;
  while ((m = bindingRe.exec(code)) !== null) consider(m[1], 'quantifier binding');
  return violations;
}

function parseAlloyCommands(content) {
  var commands = [];
  var cmdRegex = /\b(run|check)\s+(?:(\w+)\s*)?(?:\{[^}]*\}\s*)?for\s+(.+)/g;
  var match;
  while ((match = cmdRegex.exec(content)) !== null) {
    commands.push({
      type: match[1],
      name: match[2] || '(anon)',
      scopeStr: match[3].trim(),
      scope: parseScopeStr(match[3].trim()),
    });
  }
  return commands;
}

function parseScopeStr(scopeStr) {
  var scope = {};
  var defaultScope = null;
  var clean = scopeStr.replace(/--.*$/, '').trim();
  var butMatch = clean.match(/^(\d+)\s+but\s+(.+)$/);
  var entries = butMatch ? butMatch[2] : clean;
  if (butMatch) defaultScope = parseInt(butMatch[1], 10);

  var parts = entries.split(',');
  for (var i = 0; i < parts.length; i++) {
    var trimmed = parts[i].trim();
    var m = trimmed.match(/^(\d+)\s+(\w+)$/);
    if (m) {
      scope[m[2]] = parseInt(m[1], 10);
    } else if (defaultScope === null) {
      var bare = trimmed.match(/^(\d+)$/);
      if (bare) defaultScope = parseInt(bare[1], 10);
    }
  }
  if (defaultScope !== null) scope._default = defaultScope;
  return scope;
}

function getSigScope(sigName, scope, sigs) {
  if (scope[sigName] !== undefined) return scope[sigName];
  var sig = sigs.find(function(s) { return s.name === sigName; });
  if (sig && (sig.mult === 'one' || sig.mult === 'lone')) return 1;
  if (scope._default !== undefined) return scope._default;
  return 3;
}

// ── Heat analysis — finds which field contributes most to blowup ────────────

function analyzeAlloyHeat(sigs, scope) {
  var intBits = scope['int'] || scope['Int'] || 4;
  var intRange = Math.pow(2, intBits);

  var sigAtoms = {};
  var i, j, sig;
  for (i = 0; i < sigs.length; i++) {
    sig = sigs[i];
    if (sig.isAbstract && !sig.mult) {
      sigAtoms[sig.name] = 0;
    } else {
      sigAtoms[sig.name] = getSigScope(sig.name, scope, sigs);
    }
  }
  for (i = 0; i < sigs.length; i++) {
    sig = sigs[i];
    if (sig.isAbstract && !sig.mult) {
      var children = sigs.filter(function(s) { return s.parent === sig.name; });
      var sum = 0;
      for (j = 0; j < children.length; j++) sum += (sigAtoms[children[j].name] || 0);
      sigAtoms[sig.name] = sum;
    }
  }

  var heatMap = [];
  var totalScenarios = 1n;

  for (i = 0; i < sigs.length; i++) {
    sig = sigs[i];
    var atomCount = sigAtoms[sig.name] || 0;
    if (atomCount === 0) continue;

    for (var k = 0; k < sig.fields.length; k++) {
      var field = sig.fields[k];
      var targetSize;
      if (field.type === 'Int' || field.type === 'int') {
        targetSize = intRange;
      } else if (field.type === 'Bool' || field.type === 'BOOLEAN') {
        targetSize = 2;
      } else if (sigAtoms[field.type] !== undefined) {
        targetSize = sigAtoms[field.type];
      } else {
        targetSize = scope._default || 3;
      }
      if (targetSize <= 0) targetSize = 1;

      var fieldScenarios;
      if (field.mult === 'one') {
        fieldScenarios = BigInt(targetSize) ** BigInt(atomCount);
      } else if (field.mult === 'lone') {
        fieldScenarios = BigInt(targetSize + 1) ** BigInt(atomCount);
      } else if (field.mult === 'set') {
        fieldScenarios = (2n ** BigInt(targetSize)) ** BigInt(atomCount);
      } else if (field.mult === 'seq') {
        fieldScenarios = BigInt(targetSize) ** BigInt(atomCount * 3);
      } else {
        fieldScenarios = BigInt(targetSize) ** BigInt(atomCount);
      }

      totalScenarios *= fieldScenarios;
      heatMap.push({
        sig: sig.name, field: field.name, mult: field.mult, type: field.type,
        targetSize: targetSize, atomCount: atomCount, contribution: fieldScenarios,
      });
    }
  }

  heatMap.sort(function(a, b) {
    if (a.contribution > b.contribution) return -1;
    if (a.contribution < b.contribution) return 1;
    return 0;
  });

  return { totalScenarios: totalScenarios, heatMap: heatMap, sigAtoms: sigAtoms };
}

// ── Fix suggestions ─────────────────────────────────────────────────────────

function suggestAlloyFix(heatMap, totalScenarios, budget, sigAtoms) {
  var suggestions = [];
  if (heatMap.length === 0) return suggestions;

  var hottest = heatMap[0];

  // 1. Constrain set fields (biggest blowup source)
  if (hottest.mult === 'set') {
    suggestions.push({
      priority: 'high',
      type: 'constrain-set',
      message: 'Hottest: ' + hottest.sig + '.' + hottest.field +
        ' (set ' + hottest.type + ', ' + hottest.atomCount + ' atoms) -> ' + formatBig(hottest.contribution) +
        ' scenarios. Add: fact { all x: ' + hottest.sig + ' | #x.' + hottest.field + ' <= 2 }',
    });
  }

  // 2. Reduce scope of dominant sig
  if (hottest.atomCount > 3) {
    var reduced = hottest.atomCount;
    var budgetBig = BigInt(Math.floor(budget));
    while (reduced > 1) {
      reduced--;
      var ratio = Math.pow(hottest.targetSize, hottest.atomCount - reduced);
      var est = totalScenarios / BigInt(Math.max(1, Math.floor(ratio)));
      if (est <= budgetBig) break;
    }
    suggestions.push({
      priority: 'medium',
      type: 'reduce-scope',
      message: 'Reduce ' + hottest.sig + ' scope from ' + hottest.atomCount + ' to ' + reduced +
        ' in run/check commands.',
    });
  }

  // 3. Split if too many sigs
  var activeSigs = Object.keys(sigAtoms).filter(function(k) { return sigAtoms[k] > 0; });
  if (activeSigs.length > 8) {
    suggestions.push({
      priority: 'medium',
      type: 'split-model',
      message: activeSigs.length + ' active sigs. Split into smaller models, each verifying a property subset.' +
        ' Overlapping sigs at seams is fine — it tests coupling.',
    });
  }

  // 4. Reduce Int bitwidth
  for (var i = 0; i < heatMap.length; i++) {
    if ((heatMap[i].type === 'Int' || heatMap[i].type === 'int') && heatMap[i].targetSize > 16) {
      suggestions.push({
        priority: 'low',
        type: 'reduce-int-bits',
        message: 'Int bitwidth gives ' + heatMap[i].targetSize + ' values. Use "4 int" (16 values) unless wider range needed.',
      });
      break;
    }
  }

  return suggestions;
}

function suggestTLAFix(data) {
  var suggestions = [];
  if (data.has_unbounded) {
    var domains = data.unbounded_domains || [];
    for (var i = 0; i < domains.length; i++) {
      suggestions.push({
        priority: 'high',
        type: 'add-bound',
        message: 'Unbounded: ' + domains[i] + '. Add .cfg with CONSTANTS bounding this domain.',
      });
    }
  }
  if (!data.cfg_file) {
    suggestions.push({
      priority: 'high',
      type: 'add-cfg',
      message: 'No .cfg file. Create one with SPECIFICATION, CONSTANTS, INVARIANT to enable TLC checking.',
    });
  }
  return suggestions;
}

// ── Lint engine ─────────────────────────────────────────────────────────────

function lintAlloyModels(policy) {
  var findings = [];
  if (!fs.existsSync(ALLOY_DIR)) return findings;

  var files = fs.readdirSync(ALLOY_DIR).filter(function(f) { return f.endsWith('.als'); }).sort();

  for (var i = 0; i < files.length; i++) {
    var filePath = path.join(ALLOY_DIR, files[i]);
    var modelName = files[i].replace('.als', '');

    try {
      var content = fs.readFileSync(filePath, 'utf8');
      var sigs = parseAlloySigs(content);
      var commands = parseAlloyCommands(content);
      var violations = [];
      var suggestions = [];

      // Semantic: dangling signature references (undefined sigs used in fields,
      // extends, or quantifier bindings). Catches corruption the counters miss.
      var danglingRefs = checkAlloyDanglingRefs(content, sigs);
      for (var dr = 0; dr < danglingRefs.length; dr++) violations.push(danglingRefs[dr]);

      if (sigs.length > policy.max_sigs) {
        violations.push({ rule: 'max-sigs', message: sigs.length + ' sigs (max ' + policy.max_sigs + ')' });
      }

      var totalFields = sigs.reduce(function(s, sig) { return s + sig.fields.length; }, 0);
      if (totalFields > policy.max_fields) {
        violations.push({ rule: 'max-fields', message: totalFields + ' fields (max ' + policy.max_fields + ')' });
      }

      var worstScenarios = 0n;
      var worstScope = null;
      var worstHeat = null;
      var worstSigAtoms = null;

      for (var c = 0; c < commands.length; c++) {
        var analysis = analyzeAlloyHeat(sigs, commands[c].scope);
        if (analysis.totalScenarios > worstScenarios) {
          worstScenarios = analysis.totalScenarios;
          worstScope = commands[c].scopeStr;
          worstHeat = analysis.heatMap;
          worstSigAtoms = analysis.sigAtoms;
        }
      }

      if (worstScenarios > BigInt(Math.floor(policy.max_scenarios))) {
        violations.push({
          rule: 'max-scenarios',
          message: formatBig(worstScenarios) + ' scenarios (max ' + formatBig(BigInt(Math.floor(policy.max_scenarios))) + ')',
          scope: worstScope,
        });
        if (worstHeat && worstSigAtoms) {
          suggestions = suggestAlloyFix(worstHeat, worstScenarios, policy.max_scenarios, worstSigAtoms);
        }
      }

      var heatSummary = [];
      if (worstHeat) {
        for (var h = 0; h < Math.min(3, worstHeat.length); h++) {
          var entry = worstHeat[h];
          heatSummary.push({
            sig: entry.sig, field: entry.field, mult: entry.mult,
            type: entry.type, contribution: formatBig(entry.contribution),
          });
        }
      }

      findings.push({
        framework: 'Alloy', model: modelName, file: files[i],
        scenarios: worstScenarios, scenariosStr: formatBig(worstScenarios),
        sigCount: sigs.length, fieldCount: totalFields, commandCount: commands.length,
        violations: violations, suggestions: suggestions, heatMap: heatSummary,
        pass: violations.length === 0,
      });
    } catch (err) {
      findings.push({
        framework: 'Alloy', model: modelName, file: files[i],
        scenarios: null, scenariosStr: '?', sigCount: 0, fieldCount: 0, commandCount: 0,
        violations: [{ rule: 'parse-error', message: err.message }],
        suggestions: [], heatMap: [], pass: false,
      });
    }
  }
  return findings;
}

function lintTLAModels(policy) {
  var findings = [];
  if (!fs.existsSync(TLA_REPORT)) return findings;

  var report;
  try { report = JSON.parse(fs.readFileSync(TLA_REPORT, 'utf8')); } catch (_) { return findings; }

  var entries = Object.entries(report.models || {});
  for (var i = 0; i < entries.length; i++) {
    var modelPath = entries[i][0];
    var data = entries[i][1];
    var name = data.module_name || path.basename(modelPath, '.tla');
    if (name.indexOf('_TTrace_') !== -1) continue;

    var violations = [];
    var suggestions = [];
    var states = data.estimated_states;

    if (policy.require_bounded_tla && data.has_unbounded) {
      violations.push({ rule: 'unbounded-tla', message: 'Unbounded: ' + (data.unbounded_domains || []).join(', ') });
      suggestions = suggestTLAFix(data);
    }
    if (states !== null && states > policy.max_scenarios) {
      violations.push({ rule: 'max-scenarios', message: states + ' states (max ' + policy.max_scenarios + ')' });
    }
    if (!data.cfg_file && policy.require_bounded_tla) {
      violations.push({ rule: 'missing-cfg', message: 'No .cfg file — cannot be checked by TLC' });
      if (suggestions.length === 0) suggestions = suggestTLAFix(data);
    }

    findings.push({
      framework: 'TLA+', model: name, file: path.basename(modelPath),
      scenarios: states !== null ? BigInt(states) : null,
      scenariosStr: states !== null ? String(states) : (data.has_unbounded ? 'UNBOUNDED' : '?'),
      sigCount: (data.variables || []).length, fieldCount: 0,
      commandCount: (data.invariant_count || 0) + (data.property_count || 0),
      violations: violations, suggestions: suggestions, heatMap: [],
      pass: violations.length === 0,
    });
  }
  return findings;
}

// ── Output ──────────────────────────────────────────────────────────────────

function formatBig(n) {
  if (n === null || n === undefined) return '?';
  var s = n.toString();
  if (s.length <= 6) return s;
  return s[0] + '.' + s.substring(1, 3) + 'e' + (s.length - 1);
}

function printFindings(findings, policy) {
  var bad = findings.filter(function(f) { return !f.pass; });
  var good = findings.filter(function(f) { return f.pass; });

  if (summaryMode) {
    console.log(TAG + ' ' + findings.length + ' models scanned');
    console.log(TAG + ' ' + good.length + ' pass, ' + bad.length + ' violations');
    if (bad.length > 0) {
      for (var i = 0; i < bad.length; i++) {
        var rules = bad[i].violations.map(function(v) { return v.rule; }).join(', ');
        console.log(TAG + '   ' + bad[i].framework + '/' + bad[i].model + ': ' + rules);
      }
    }
    return;
  }

  console.log('');
  console.log('Formal Model Health Report');
  console.log('='.repeat(70));
  console.log('Policy: max_scenarios=' + policy.max_scenarios +
    '  max_sigs=' + policy.max_sigs + '  max_fields=' + policy.max_fields +
    '  mode=' + policy.mode);
  console.log('');

  if (bad.length > 0) {
    console.log('VIOLATIONS (' + bad.length + ')');
    console.log('-'.repeat(70));

    for (var i = 0; i < bad.length; i++) {
      var f = bad[i];
      console.log('');
      console.log('  ' + f.framework + '/' + f.model + '  (' + f.file + ')');
      console.log('    Scenarios: ' + f.scenariosStr + '  |  Sigs: ' + f.sigCount + '  |  Fields: ' + f.fieldCount);

      for (var v = 0; v < f.violations.length; v++) {
        console.log('    VIOLATION: ' + f.violations[v].message);
      }

      if (f.heatMap.length > 0) {
        console.log('    Hottest fields:');
        for (var h = 0; h < f.heatMap.length; h++) {
          var e = f.heatMap[h];
          console.log('      ' + (h + 1) + '. ' + e.sig + '.' + e.field +
            ' (' + e.mult + ' ' + e.type + ') -> ' + e.contribution);
        }
      }

      if (f.suggestions.length > 0) {
        console.log('    Fix:');
        for (var s = 0; s < f.suggestions.length; s++) {
          console.log('      [' + f.suggestions[s].priority + '] ' + f.suggestions[s].message);
        }
      }
    }
  }

  if (good.length > 0) {
    console.log('');
    console.log('PASSING (' + good.length + ')');
    console.log('-'.repeat(70));
    for (var i = 0; i < good.length; i++) {
      console.log('  ' + good[i].framework + '/' + good[i].model + ': ' + good[i].scenariosStr);
    }
  }

  console.log('');
  console.log('='.repeat(70));
  console.log('Total: ' + findings.length + '  |  Pass: ' + good.length + '  |  Violations: ' + bad.length +
    '  |  Mode: ' + policy.mode);
  if (bad.length > 0 && policy.mode === 'warn') {
    console.log('(mode=warn: exit 0 despite violations)');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  var policy = loadPolicy();
  var findings = lintAlloyModels(policy).concat(lintTLAModels(policy));

  findings.sort(function(a, b) {
    if (a.pass !== b.pass) return a.pass ? 1 : -1;
    var sa = a.scenarios || 0n;
    var sb = b.scenarios || 0n;
    if (sa > sb) return -1;
    if (sa < sb) return 1;
    return 0;
  });

  if (jsonMode) {
    var jsonFindings = findings.map(function(f) {
      return Object.assign({}, f, { scenarios: f.scenarios !== null ? f.scenarios.toString() : null });
    });
    process.stdout.write(JSON.stringify({
      policy: policy, findings: jsonFindings,
      summary: { total: findings.length, pass: good(findings), violations: bad(findings) },
    }, null, 2) + '\n');
    return;
  }

  printFindings(findings, policy);

  if (findings.some(function(f) { return !f.pass; }) && policy.mode === 'fail') {
    process.exit(1);
  }
}

function good(f) { return f.filter(function(x) { return x.pass; }).length; }
function bad(f) { return f.filter(function(x) { return !x.pass; }).length; }

// Export semantic-check helpers for unit testing without running the CLI scan.
module.exports = { checkAlloyDanglingRefs: checkAlloyDanglingRefs, extractAlloyTypeRefs: extractAlloyTypeRefs, stripAlloyComments: stripAlloyComments, parseAlloySigs: parseAlloySigs };

if (require.main === module) {
  main();
}

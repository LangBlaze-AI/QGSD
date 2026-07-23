'use strict';

// ARGS-TEMPLATE-01 regression suite.
//
// The install-time auto-detect path wrote providers.json entries WITHOUT an
// args_template field; every consumer then did `provider.args_template.map(...)`
// unguarded, so quorum dispatch crashed for ALL slots with an opaque
// "Cannot read properties of undefined (reading 'map')". This suite locks in:
//   1. the canonical per-family template map,
//   2. the explicit-field-wins / family-default / null resolution order,
//   3. that call-quorum-slot's buildSpawnArgs falls back to the family default
//      and fails LOUD (clear message) on an unknown family — never the bare crash.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { FAMILY_ARGS_TEMPLATE, argsTemplateFor, resolveArgsTemplate } = require('./provider-arg-templates.cjs');
const { buildSpawnArgs } = require('./call-quorum-slot.cjs');

describe('provider-arg-templates: canonical map', () => {
  it('has a template for every quorum CLI family incl. antigravity + kimi', () => {
    for (const fam of ['claude', 'codex', 'gemini', 'opencode', 'copilot', 'antigravity', 'kimi']) {
      assert.ok(Array.isArray(FAMILY_ARGS_TEMPLATE[fam]), `${fam} must have a template`);
      assert.ok(FAMILY_ARGS_TEMPLATE[fam].includes('{prompt}'), `${fam} template must carry {prompt}`);
    }
  });

  it('codex uses exec; antigravity + kimi use -p print mode', () => {
    assert.deepEqual(argsTemplateFor('codex'), ['exec', '{prompt}']);
    assert.deepEqual(argsTemplateFor('antigravity'), ['-p', '{prompt}']);
    // kimi (Kimi Code) `-p/--prompt <prompt>` — verified against kimi v0.27.0 --help.
    assert.deepEqual(argsTemplateFor('kimi'), ['-p', '{prompt}']);
  });

  it('argsTemplateFor returns a fresh copy (no shared mutation) and null for unknown', () => {
    const a = argsTemplateFor('gemini');
    a.push('MUTATED');
    assert.ok(!argsTemplateFor('gemini').includes('MUTATED'), 'must return a defensive copy');
    assert.equal(argsTemplateFor('nope'), null);
  });

  it('IDE runtimes (kilo/cursor/windsurf/augment/trae/cline) have NO canonical template', () => {
    // install.js admits these as KNOWN_CLI_PREFIXES but they are not quorum CLIs;
    // they must NOT get a guessed `-p {prompt}` template (CodeRabbit #275).
    for (const ide of ['kilo', 'cursor', 'windsurf', 'augment', 'trae', 'cline']) {
      assert.equal(argsTemplateFor(ide), null, `${ide} must have no canonical template`);
    }
  });
});

describe('resolveArgsTemplate: resolution order', () => {
  it('explicit args_template on the provider wins', () => {
    const p = { mainTool: 'gemini', args_template: ['--custom', '{prompt}'] };
    assert.deepEqual(resolveArgsTemplate(p), ['--custom', '{prompt}']);
  });
  it('falls back to the family default by mainTool', () => {
    assert.deepEqual(resolveArgsTemplate({ mainTool: 'codex' }), ['exec', '{prompt}']);
  });
  it('returns null when neither explicit nor a known family is present', () => {
    assert.equal(resolveArgsTemplate({ mainTool: 'mystery' }), null);
    assert.equal(resolveArgsTemplate({}), null);
  });
});

describe('buildSpawnArgs: no crash on a provider missing args_template', () => {
  it('a slot with no args_template falls back to the family template (the crash regression)', () => {
    const { args } = buildSpawnArgs({ name: 'gemini-1', mainTool: 'gemini' }, 'HELLO');
    assert.deepEqual(args, ['-p', 'HELLO']);
  });

  it('antigravity slot (no args_template) dispatches via -p', () => {
    const { args } = buildSpawnArgs({ name: 'antigravity-1', mainTool: 'antigravity', cli: '/x/agy' }, 'HI');
    assert.deepEqual(args, ['-p', 'HI']);
  });

  it('kimi slot (no args_template) dispatches via -p, prompt substituted verbatim', () => {
    const { args } = buildSpawnArgs({ name: 'kimi-1', mainTool: 'kimi', cli: '/x/kimi' }, 'HI');
    assert.deepEqual(args, ['-p', 'HI']);
  });

  it('an explicit args_template is still honored', () => {
    const { args } = buildSpawnArgs({ name: 'codex-1', mainTool: 'codex', args_template: ['exec', '{prompt}'] }, 'Q');
    assert.deepEqual(args, ['exec', 'Q']);
  });

  it('an unknown family with no template fails LOUD, not with an opaque TypeError', () => {
    assert.throws(
      () => buildSpawnArgs({ name: 'weird-1', mainTool: 'weird' }, 'x'),
      (e) => /no args_template/.test(e.message) && !/undefined \(reading 'map'\)/.test(e.message),
      'must throw a clear, actionable error'
    );
  });
});

// ─── ADVERSARIAL edge cases (added to expose shape-guard / coercion gaps) ──────
describe('ADVERSARIAL: provider-arg-templates + buildSpawnArgs edge cases', () => {
  it('argsTemplateFor("__proto__") treats a prototype-chain key as unknown and returns null (no thrown TypeError)', () => {
    // FAMILY_ARGS_TEMPLATE['__proto__'] resolves to Object.prototype (truthy), so the
    // `t ? t.slice() : null` guard calls Object.prototype.slice → TypeError instead of
    // returning null for this unknown "family". A dotted-path/prototype key must be
    // handled identically to any other unknown family: null, not a crash.
    assert.equal(argsTemplateFor('__proto__'), null, '__proto__ must be treated as an unknown family');
  });

  it('buildSpawnArgs does NOT misclassify a non-ccr slot as CCR when the CLI path merely contains the substring "ccr"', () => {
    // isCcr uses `cli.includes('ccr')` — a loose substring match. A perfectly normal
    // home-dir path like /Users/mccray/bin/gemini contains "ccr" (m-c-c-r-ay), so the
    // gemini slot is wrongly treated as CCR and its prompt gets $/!/backtick-neutralized,
    // corrupting any review that cites those characters.
    const { isCcr, promptMutated, args } = buildSpawnArgs(
      { name: 'gemini-1', mainTool: 'gemini', cli: '/Users/mccray/bin/gemini' },
      'fix the `code` and the $VAR and the bang!'
    );
    assert.equal(Boolean(isCcr), false, 'a username substring "ccr" must not flag the slot as CCR');
    assert.equal(promptMutated, false, 'the prompt must not be mutated for a non-CCR slot');
    assert.equal(args[1], 'fix the `code` and the $VAR and the bang!', 'prompt passed through verbatim');
  });

  it('buildSpawnArgs substitutes an embedded {prompt} token (e.g. --prompt={prompt}), not only a bare element', () => {
    // Substitution is `a === '{prompt}'` (exact element equality). A provider that writes
    // the placeholder embedded in a flag (--prompt={prompt}) gets the literal token sent
    // to the CLI instead of the real prompt — a silent, hard-to-debug dispatch failure.
    const { args } = buildSpawnArgs(
      { name: 'x-1', mainTool: 'gemini', args_template: ['--prompt={prompt}'] },
      'HELLO'
    );
    assert.equal(args[0], '--prompt=HELLO', 'embedded {prompt} token must be substituted');
  });
});

// ─── ADVERSARIAL round 2: silent prompt-drop + reference aliasing ─────────────
describe('ADVERSARIAL round 2: silent prompt-drop + template aliasing', () => {
  it('buildSpawnArgs does NOT silently drop the prompt when args_template is an empty array []', () => {
    // resolveArgsTemplate accepts [] (it IS an Array, so the shape guard passes), then
    // buildSpawnArgs maps it to [] and returns an EMPTY argv — the prompt vanishes and
    // the CLI is spawned with no input at all. There is no guard that the resolved
    // template actually carries a {prompt} slot, so the slot runs the model against an
    // empty prompt instead of failing LOUD the way an unknown family does. A malformed
    // providers.json with `args_template: []` is exactly the ARGS-TEMPLATE-01 failure
    // class (auto-generated bad templates) — it should not silently mis-dispatch.
    // Fix chose the loud-failure path (which this test's own comment endorses): an
    // empty template can't carry the prompt, so dispatch throws a clear config error
    // rather than spawning the CLI with an empty argv. Safer than guessing where to
    // append the prompt.
    assert.throws(
      () => buildSpawnArgs({ name: 'gemini-1', mainTool: 'gemini', args_template: [] }, 'PAYLOAD'),
      /no \{prompt\} placeholder/,
      'an empty args_template must fail loud, not silently drop the prompt'
    );
  });

  it('buildSpawnArgs does NOT silently drop the prompt when args_template has no {prompt} placeholder', () => {
    // A provider that forgets the {prompt} token (e.g. a typo'd ['-p'] template) is
    // mapped verbatim — nothing matches `.includes('{prompt}')`, so the prompt is never
    // substituted in. The CLI is invoked with flags but NO actual question. Exact-token
    // substitution means a missing placeholder is completely undetected; the model
    // answers an empty prompt and the verdict telemetry records garbage.
    // Loud-failure path (per the test's own comment): a template lacking {prompt}
    // can't deliver the prompt, so dispatch throws rather than invoking the CLI with
    // flags but no question.
    assert.throws(
      () => buildSpawnArgs({ name: 'gemini-1', mainTool: 'gemini', args_template: ['-p'] }, 'PAYLOAD'),
      /no \{prompt\} placeholder/,
      'a template missing {prompt} must fail loud, not silently drop the prompt'
    );
  });

  it('resolveArgsTemplate returns a defensive COPY of an explicit args_template, not the provider\'s own array by reference', () => {
    // argsTemplateFor() returns `t.slice()` (round-1 locked this in), but the explicit
    // branch of resolveArgsTemplate returns `provider.args_template` DIRECTLY. A caller
    // that mutates the returned array (e.g. an EXEC-01 --allowedTools splice, or any
    // consumer in unified-mcp-server / probe-quorum-slots) corrupts the provider's
    // STORED template for every subsequent dispatch in the same process — an
    // inconsistent, unsafe aliasing gap relative to argsTemplateFor.
    const p = { mainTool: 'gemini', args_template: ['-p', '{prompt}'] };
    const returned = resolveArgsTemplate(p);
    returned.push('MUTATED');
    assert.ok(
      !p.args_template.includes('MUTATED'),
      'resolveArgsTemplate must not expose the provider\'s stored template by reference'
    );
  });
});

// ─── ADVERSARIAL round 3 (convergence check): EXEC-01 allowedTools splice branch ──
// The `if (allowedToolsFlag && isCcr)` injection in buildSpawnArgs was entirely
// untested across rounds 1+2. Round-3 sweep of the source (atomicUpdateJson,
// findProjectRoot, writeFailureLog, stallTimeoutFor(null), lowercase/anchored
// verdict parsing, {prompt} substitution) surfaced NO new real defect — the helpers
// fail-open and the shape guards hold. This test locks in the one genuinely
// uncovered code path so a future regression in the splice (wrong order, missing
// value, or accidental duplication) is caught.
describe('ADVERSARIAL round 3: EXEC-01 --allowedTools injection for review-only CCR slots', () => {
  it('injects --allowedTools once, ordered before --dangerously-skip-permissions, and ONLY for CCR slots', () => {
    // Positive: a CCR slot gets the flag/value pair spliced directly before
    // --dangerously-skip-permissions, exactly once (no order/duplication drift).
    const ccr = buildSpawnArgs(
      { name: 'ccr-rev-1', display_type: 'claude-code-router', mainTool: 'claude' },
      'review this',
      'Read,Grep,Glob'
    );
    assert.equal(ccr.isCcr, true, 'a claude-code-router slot must be classified as CCR');
    const atIdx = ccr.args.indexOf('--allowedTools');
    const dspIdx = ccr.args.indexOf('--dangerously-skip-permissions');
    assert.ok(atIdx !== -1, '--allowedTools must be injected for a review-only CCR slot');
    assert.equal(ccr.args[atIdx + 1], 'Read,Grep,Glob', 'the tools value must immediately follow the flag');
    assert.equal(dspIdx - atIdx, 2, 'the flag/value pair must sit directly before --dangerously-skip-permissions');
    assert.equal(
      ccr.args.filter(a => a === '--allowedTools').length, 1,
      'must not duplicate --allowedTools'
    );

    // Negative guard: the injection is claude-CLI-specific (`&& isCcr`). A plain
    // gemini slot must never receive --allowedTools (gemini has no such flag).
    const gem = buildSpawnArgs({ name: 'gemini-1', mainTool: 'gemini' }, 'review this', 'Read,Grep,Glob');
    assert.equal(gem.isCcr, false);
    assert.deepEqual(gem.args, ['-p', 'review this'], 'non-CCR argv is unaffected by the allowedTools flag');
  });
});

// ─── ADVERSARIAL round 4 (final convergence): non-string template elements + ──
// empty/special-only CCR prompt. Round-4 re-swept the three remaining "last
// things to consider": (a) an explicit args_template carrying non-string
// elements alongside a bare {prompt}; (b) safePrompt CCR neutralization on a
// prompt that is empty or only special chars; (c) the shallow-copy depth of
// argsTemplateFor (arrays of immutable strings → .slice() suffices). All three
// are non-defects: the `typeof a === 'string'` gate fronts every `.includes`,
// neutralization always yields a valid string argv element, and the templates
// have no nested mutation surface. This single invariant locks in the riskiest
// of the three — the typeof gate around substitution — so a future regression
// that drops it (and calls `.includes`/`.split` on a number → TypeError) is
// caught. CONVERGED — no new real gaps.
describe('ADVERSARIAL round 4: non-string template elements + empty/special CCR prompt', () => {
  it('passes non-string args_template elements through untouched while substituting a bare {prompt} (no TypeError on numbers/objects)', () => {
    // The {prompt}-presence guard and the substitution map both front `.includes`
    // with `typeof a === 'string'`, so numeric/object elements never hit a string
    // method. They must survive verbatim and the lone string {prompt} must resolve.
    const obj = { k: 'v' };
    const { args } = buildSpawnArgs(
      { name: 'x-1', mainTool: 'gemini', args_template: [42, obj, '{prompt}', true] },
      'HELLO'
    );
    assert.equal(args.length, 4, 'all four elements preserved');
    assert.equal(args[0], 42, 'numeric element passes through unchanged');
    assert.equal(args[1], obj, 'object element passes through by reference, untouched');
    assert.equal(args[2], 'HELLO', 'the bare string {prompt} is substituted');
    assert.equal(args[3], true, 'boolean element passes through unchanged');
  });

  it('a CCR slot with an empty-string prompt yields a valid empty argv element (not undefined, not dropped, promptMutated=false)', () => {
    // safePrompt on '' is '' (no special chars to neutralize), so the {prompt}
    // slot must still materialize as an empty string element — a valid argv entry —
    // and promptMutated must be false (nothing changed).
    const { args, isCcr, promptMutated } = buildSpawnArgs(
      { name: 'ccr-1', display_type: 'claude-code-router', mainTool: 'claude' },
      ''
    );
    assert.equal(isCcr, true);
    assert.equal(promptMutated, false, 'an empty prompt is unchanged by neutralization');
    const pIdx = args.indexOf('-p');
    assert.equal(args[pIdx + 1], '', 'the prompt slot is a valid empty string, not undefined/dropped');
  });

  it('a CCR slot with an only-special-chars prompt neutralizes to a valid string element and flags promptMutated', () => {
    // '`$!' → backtick→', $→stripped, !→.  → produces "'." — still a non-empty,
    // valid string argv element, and promptMutated is true (chars were changed).
    const { args, promptMutated } = buildSpawnArgs(
      { name: 'ccr-1', display_type: 'claude-code-router', mainTool: 'claude' },
      '`$!'
    );
    assert.equal(promptMutated, true, 'special chars were neutralized');
    const pIdx = args.indexOf('-p');
    assert.equal(typeof args[pIdx + 1], 'string', 'neutralized prompt remains a string argv element');
    assert.equal(args[pIdx + 1], "'.", 'backtick→quote, $ stripped, !→. — deterministic neutralization');
  });
});

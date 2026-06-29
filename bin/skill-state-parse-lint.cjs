'use strict';
// bin/skill-state-parse-lint.cjs
//
// THE STANDARD (Rule 7, enforced by scripts/lint-isolation.js — the required
// "Lint" CI check): in skill/workflow markdown, every inline
//   JSON.parse( <...>readFileSync(...) )
// must be inside a try/catch.
//
// Why — the F47/F48 dogfooding class: parsing a file that may be missing or
// malformed (a corrupt `.planning/*` state file, a partially-written
// `~/.claude.json`, a half-flushed `providers.json`) crashes the skill's
// embedded-JS step with a raw stack trace. An `existsSync(...)` ternary guards
// the MISSING case but NOT the MALFORMED one, so it does not count — only a
// try/catch around the parse does.
//
// Pure, dependency-free; exported for the linter and its test.

// Matches `JSON.parse(fs.readFileSync(` / `JSON.parse(readFileSync(` /
// `JSON.parse(await fs.promises.readFile(` / `JSON.parse(require('fs').readFileSync(`
// — the read-then-parse shape. The `(?:ident(args).)*` segment covers a call
// receiver such as `require('fs').` (or `getFs().`), which a plain identifier-dot
// chain misses, so the inline-`require` idiom common in skills is now caught too.
const PARSE_RE = /JSON\.parse\(\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\([^()]*\)\.)*(?:[A-Za-z_$][\w$]*\.)*read[A-Za-z]*\(/g;

// Brace-matched ranges of every `try { … }` that is followed by catch/finally.
// Operating on the whole markdown is fine: embedded JS blocks are brace-balanced,
// so a try opened in one block closes in the same block.
function tryRanges(code) {
  const ranges = [];
  const re = /\btry\s*\{/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < code.length && depth > 0) {
      const c = code[i];
      // Skip string/template literals and // and /* */ comments so a stray { or }
      // inside a string, jq filter, or comment cannot skew the brace counter. This
      // is scoped to the try BODY (real JS, balanced quotes) — doing it across the
      // whole markdown would mis-handle unbalanced apostrophes in prose.
      if (c === '"' || c === "'" || c === '`') {
        const q = c; i++;
        while (i < code.length && code[i] !== q) {
          if (code[i] === '\\') i++;
          i++;
        }
        i++; // closing quote
        continue;
      }
      if (c === '/' && code[i + 1] === '/') {
        while (i < code.length && code[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && code[i + 1] === '*') {
        i += 2;
        while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    if (/^\s*(catch|finally)\b/.test(code.slice(i, i + 30))) ranges.push([m.index, i]);
  }
  return ranges;
}

// Returns [{ file, line, snippet }] for every read-then-parse not inside a try.
function findUnguardedParses(text, file) {
  const ranges = tryRanges(text);
  const out = [];
  PARSE_RE.lastIndex = 0;
  let m;
  while ((m = PARSE_RE.exec(text)) !== null) {
    const idx = m.index;
    if (ranges.some(([a, b]) => idx >= a && idx < b)) continue; // guarded by try/catch
    out.push({
      file,
      line: text.slice(0, idx).split('\n').length,
      snippet: text.slice(idx, idx + 60).replace(/\s+/g, ' '),
    });
  }
  return out;
}

module.exports = { findUnguardedParses, tryRanges };

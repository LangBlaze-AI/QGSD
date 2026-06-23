'use strict';
// bin/skill-eval-lint.cjs
//
// THE STANDARD (enforced by scripts/lint-isolation.js, a required CI check):
//   In skill/workflow markdown, NOTHING may trail an inline `node -e "<js>"`
//   except a redirect/operator/closer (`2>`, `>`, `|`, `&&`, `||`, `;`, `)`, …).
//
// Why — two recurring bug classes this catches:
//   • env-after-eval (F1): `node -e "<js>" VAR="x"` — shell assignments AFTER a
//     command are positional argv, NOT environment, so `process.env.VAR` is
//     `undefined`. Fix: put the assignment BEFORE node (`VAR="x" node -e "…"`).
//   • arg-after-eval (F21): `node -e "<js>" --flag` / `… -- "$X"` — args after the
//     eval break when the eval-guard rewrites `node -e` to a quoted heredoc (the
//     terminator line is no longer alone). Fix: pass inputs via env and read
//     `process.env.*`.
//
// Pure, dependency-free; exported for the linter and its test.

// Built by concatenation so this file's own text never contains the literal
// `node -e "` (keeps it clear of the eval-guard and of this very scan).
const NEEDLE = 'node -e ' + '"';

// Returns [{ file, line, rule, text }] for every inline eval with an illegal
// trailing token. `rule` is 'eval-env-after' or 'eval-arg-after'.
function findEvalTrailingViolations(text, file) {
  const out = [];
  let i = 0;
  while ((i = text.indexOf(NEEDLE, i)) !== -1) {
    // find the matching closing double-quote (honoring \" escapes)
    let j = i + NEEDLE.length;
    for (; j < text.length; j++) {
      if (text[j] === '\\') { j++; continue; }
      if (text[j] === '"') break;
    }
    if (j >= text.length) break; // unterminated — skip
    const lineEnd = text.indexOf('\n', j);
    const rest = text.slice(j + 1, lineEnd === -1 ? text.length : lineEnd);
    const leadWs = /^[ \t]/.test(rest); // is the next token whitespace-separated?
    const t = rest.replace(/^[ \t]+/, '');
    let rule = null;
    if (t === '' || /^(\)|2>|1>|>|<|\||&|;|\}|`|\\)/.test(t)) {
      rule = null; // legal: nothing, or a redirect/operator/closer follows
    } else if (!leadWs && /^["']/.test(t)) {
      // A quote *immediately* after the close (no space) is shell string
      // concatenation — the eval string continues (e.g. `"a""b"`), not a
      // trailing arg. A *whitespace-separated* quoted token, however, is a
      // positional arg (the F21 bug) and falls through to be flagged below.
      rule = null;
    } else if (/^[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)/.test(t)) {
      rule = 'eval-env-after'; // F1
    } else {
      rule = 'eval-arg-after'; // F21 — incl. a whitespace-separated quoted arg
    }
    if (rule) {
      out.push({ file, line: text.slice(0, i).split('\n').length, rule, text: t.slice(0, 60) });
    }
    i = j + 1;
  }
  return out;
}

module.exports = { findEvalTrailingViolations };

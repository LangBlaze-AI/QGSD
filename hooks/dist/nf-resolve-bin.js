'use strict';
// hooks/nf-resolve-bin.js
// Shared path resolver for hook scripts.
//
// Hooks run from two locations:
//   1. Repo:      hooks/ → ../bin/ has the scripts
//   2. Installed:  ~/.claude/hooks/ → ../nf-bin/ has the scripts
//
// This module tries both paths and returns the first that exists.

const fs   = require('fs');
const path = require('path');

function resolveBin(name) {
  const candidates = [
    path.join(__dirname, '..', 'nf-bin', name),  // installed path (primary)
    path.join(__dirname, '..', 'bin', name),      // repo dev path (fallback)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]; // default to nf-bin even if missing (let caller handle)
}

module.exports = resolveBin;

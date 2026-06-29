#!/usr/bin/env node
'use strict';

/**
 * solve-worker.cjs — Forked child process for running solve sweep functions
 * off the main event loop. Keeps the blessed TUI responsive while sweeps run.
 *
 * Protocol (IPC via process.send / process.on('message')):
 *   Parent → Worker:  { cmd, ...args }
 *   Worker → Parent:  { ok, result } | { ok: false, error }
 *
 * Commands:
 *   sweep        — Run a single nf-solve.cjs sweep function by name
 *   loadSweepData — Run solveTui.loadSweepData()
 *   classify     — Run solveTui.classifyWithHaiku()
 *   batchSweep   — Run multiple sweep functions, streaming results one at a time
 */

const path = require('path');

// Resolve project root from argv or cwd
const rootArg = process.argv.find(a => a.startsWith('--project-root='));
const ROOT = rootArg ? rootArg.split('=')[1] : process.cwd();
process.chdir(ROOT);

let nfSolve, solveTui;

function loadModules() {
  if (!nfSolve) nfSolve = require(path.join(__dirname, 'nf-solve.cjs'));
  if (!solveTui) solveTui = require(path.join(__dirname, 'solve-tui.cjs'));
}

function handleMessage(msg) {
  if (!msg || !msg.cmd) return;

  try {
    loadModules();
  } catch (err) {
    process.send({ ok: false, error: 'Failed to load modules: ' + err.message, cmd: msg.cmd, id: msg.id });
    return;
  }

  try {
    switch (msg.cmd) {
      case 'sweep': {
        const fn = Object.prototype.hasOwnProperty.call(nfSolve, msg.fnName) ? nfSolve[msg.fnName] : undefined;
        if (typeof fn !== 'function') {
          process.send({ ok: false, error: `Sweep function "${msg.fnName}" not found`, cmd: msg.cmd, id: msg.id });
          return;
        }
        const result = fn();
        process.send({ ok: true, result, cmd: msg.cmd, id: msg.id, fnName: msg.fnName });
        break;
      }

      case 'loadSweepData': {
        const result = solveTui.loadSweepData();
        process.send({ ok: true, result, cmd: msg.cmd, id: msg.id });
        break;
      }

      case 'classify': {
        const result = solveTui.classifyWithHaiku(msg.sweepData, msg.opts || {});
        process.send({ ok: true, result, cmd: msg.cmd, id: msg.id });
        break;
      }

      case 'batchSweep': {
        // Run multiple sweep functions, sending each result as it completes
        const fnNames = Array.isArray(msg.fnNames) ? msg.fnNames : [];
        for (const fnName of fnNames) {
          try {
            const fn = Object.prototype.hasOwnProperty.call(nfSolve, fnName) ? nfSolve[fnName] : undefined;
            if (typeof fn !== 'function') {
              process.send({ ok: false, error: `"${fnName}" not found`, cmd: 'sweepResult', id: msg.id, fnName, done: false });
              continue;
            }
            const result = fn();
            process.send({ ok: true, result, cmd: 'sweepResult', id: msg.id, fnName, done: false });
          } catch (err) {
            process.send({ ok: false, error: err.message, cmd: 'sweepResult', id: msg.id, fnName, done: false });
          }
        }
        // Signal batch completion
        process.send({ ok: true, cmd: 'batchDone', id: msg.id });
        break;
      }

      default:
        process.send({ ok: false, error: `Unknown command: ${msg.cmd}`, cmd: msg.cmd, id: msg.id });
    }
  } catch (err) {
    process.send({ ok: false, error: err.message, cmd: msg.cmd, id: msg.id });
  }
}

process.on('message', handleMessage);

// Signal ready
if (process.send) {
  process.send({ ok: true, cmd: 'ready' });
}

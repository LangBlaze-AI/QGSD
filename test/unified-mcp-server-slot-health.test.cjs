'use strict';

// Regression: in PROVIDER_SLOT mode, `health_check` is advertised in tools/list and
// runSubprocessHealthCheck defaults to ['--version'] when health_check_args is absent
// — but the dispatcher gated on `&& slotProvider.health_check_args`, so every
// auto-detected subprocess slot (which has no health_check_args) answered
// "Unknown tool in slot <name>: health_check". This drives the REAL server over
// MCP stdio and asserts health_check now succeeds for such a slot.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { createInterface } = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'bin', 'unified-mcp-server.mjs');

// Drive the slot-mode server through a scripted JSON-RPC sequence; resolve with the
// health_check tools/call response (id 3).
function driveHealthCheck(providersPath, slot) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER], {
      env: { ...process.env, PROVIDER_SLOT: slot, UNIFIED_PROVIDERS_CONFIG: providersPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const done = (fn) => { try { child.kill(); } catch (_) {} fn(); };
    const timer = setTimeout(() => done(() => reject(new Error('timeout'))), 20000);
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      let m; try { m = JSON.parse(t); } catch { return; }
      if (m.id === 1) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health_check', arguments: {} } });
      } else if (m.id === 3) {
        clearTimeout(timer);
        done(() => resolve(m));
      }
    });
    child.on('error', (e) => { clearTimeout(timer); done(() => reject(e)); });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  });
}

test('slot-mode health_check works for a subprocess slot with no health_check_args', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-umcp-'));
  const providersPath = path.join(dir, 'providers.json');
  // Use the node binary itself as the slot CLI: runSubprocessHealthCheck runs
  // `<cli> --version`, and `node --version` exits 0 → healthy. No health_check_args.
  fs.writeFileSync(providersPath, JSON.stringify({
    providers: [{
      name: 'probe-1', provider: 'test', type: 'subprocess',
      mainTool: 'probe', cli: process.execPath,
      display_type: 'probe-cli', display_provider: 'Probe',
    }],
  }), 'utf8');

  const resp = await driveHealthCheck(providersPath, 'probe-1');
  const text = resp.result?.content?.[0]?.text ?? '';
  assert.ok(!/Unknown tool/i.test(text), `health_check must be handled, got: ${text}`);
  assert.equal(resp.result?.isError ?? false, false, 'health_check must not be an error');
  const parsed = JSON.parse(text);
  assert.equal(parsed.healthy, true, 'node --version → healthy:true');
  assert.equal(parsed.type, 'subprocess');
});

// ─── Adversarial integration probes ──────────────────────────────────────────
// These spawn the REAL server in slot mode and speak the MCP stdio protocol with
// edge/malformed input. Each must FAIL on a real defect: a server crash/hang on
// bad input, or a missing clean-error path. The server should always answer with a
// clean JSON-RPC frame (or exit cleanly for a startup error) and never hang.

function writeProviders(providerEntries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-umcp-adv-'));
  const providersPath = path.join(dir, 'providers.json');
  fs.writeFileSync(providersPath, JSON.stringify({ providers: providerEntries }), 'utf8');
  return providersPath;
}

/**
 * Spawn the slot-mode server and drive a scripted exchange.
 *
 *  - Default mode: completes the initialize handshake, then invokes `afterInit`
 *    with { sendRaw, sendObj, waitForId } so a test can push arbitrary (even
 *    malformed) frames and await specific response ids. Resolves with afterInit's
 *    return value. An unexpected server exit before afterInit settles is surfaced
 *    as a rejection (so a CRASH on bad input fails the test loudly).
 *  - expectExit mode: provokes a startup error and resolves with { exitCode } when
 *    the process exits. A HANG (no exit) trips the timeout and fails the test.
 *
 * Always kills the child; always resolves/rejects within the timeout.
 */
function driveServer(env, { afterInit, expectExit, timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = new Map();
    const waiters = new Map();
    let settled = false;
    const cleanup = () => { try { child.kill(); } catch (_) {} };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; cleanup();
      reject(new Error('timeout — server hung (no response / no exit)'));
    }, timeoutMs);
    const finish = (val) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); resolve(val); };
    const fail = (err) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); reject(err); };

    // Swallow EPIPE when writing to a server that already exited.
    child.stdin.on('error', () => {});

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      let m; try { m = JSON.parse(t); } catch { return; }
      if (m.id !== undefined && m.id !== null) {
        responses.set(m.id, m);
        const w = waiters.get(m.id);
        if (w) { waiters.delete(m.id); w(m); }
      }
    });

    child.on('exit', (code) => {
      if (expectExit) { finish({ exitCode: code }); return; }
      if (!settled) fail(new Error(`server exited unexpectedly (code=${code}) — likely a crash on input`));
    });
    child.on('error', (e) => fail(e));

    const sendRaw = (s) => child.stdin.write(s + '\n');
    const sendObj = (o) => sendRaw(JSON.stringify(o));
    const waitForId = (id) => new Promise((res) => {
      if (responses.has(id)) return res(responses.get(id));
      waiters.set(id, res);
    });

    if (expectExit) {
      // Nudge stdin to ensure the process is alive enough to reach its exit path;
      // the unknown-slot check runs at module top-level before stdin is read, so
      // this is belt-and-suspenders.
      sendObj({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      return;
    }

    sendObj({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    waitForId(1).then(async () => {
      sendObj({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      try { finish(await afterInit({ sendRaw, sendObj, waitForId })); }
      catch (e) { fail(e); }
    });
  });
}

const textOf = (m) => m?.result?.content?.[0]?.text ?? '';

// A minimal subprocess slot whose CLI is the node binary itself (always present).
// mainTool='probe' is an UNKNOWN family, so there is no canonical args_template.
const PROBE_SLOT = {
  name: 'probe-1', provider: 'test', type: 'subprocess',
  mainTool: 'probe', cli: process.execPath,
  display_type: 'probe-cli', display_provider: 'Probe',
};

test('malformed JSON-RPC line does NOT crash the server — next valid request still answered', async () => {
  const providersPath = writeProviders([PROBE_SLOT]);
  const out = await driveServer(
    { PROVIDER_SLOT: 'probe-1', UNIFIED_PROVIDERS_CONFIG: providersPath },
    {
      afterInit: async ({ sendRaw, sendObj, waitForId }) => {
        // Garbage line — must be tolerated (Parse error with id:null), not fatal.
        sendRaw('this is { not ] valid JSON at all ::::');
        sendRaw('');               // blank line — must be skipped
        sendObj({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ping', arguments: { prompt: 'echo-me' } } });
        return waitForId(5);
      },
    }
  );
  const text = textOf(out);
  assert.equal(out.result?.isError ?? false, false, 'ping after malformed line must not error');
  assert.match(text, /echo-me/, `server must process the next valid request, got: ${text}`);
});

test('tools/call for an UNKNOWN tool returns a clean isError (no crash, server stays alive)', async () => {
  const providersPath = writeProviders([PROBE_SLOT]);
  const out = await driveServer(
    { PROVIDER_SLOT: 'probe-1', UNIFIED_PROVIDERS_CONFIG: providersPath },
    {
      afterInit: async ({ sendObj, waitForId }) => {
        sendObj({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no-such-tool', arguments: {} } });
        const unknown = await waitForId(5);
        // Server must still be alive afterward.
        sendObj({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ping', arguments: { prompt: 'alive' } } });
        const alive = await waitForId(6);
        return { unknown, alive };
      },
    }
  );
  assert.equal(out.unknown.result?.isError, true, 'unknown tool must be a clean isError');
  assert.match(textOf(out.unknown), /Unknown tool/i, 'unknown tool error text');
  assert.match(textOf(out.alive), /alive/, 'server must survive an unknown-tool call');
});

test('tools/call with MISSING name / MISSING arguments is handled cleanly (no crash)', async () => {
  const providersPath = writeProviders([PROBE_SLOT]);
  const out = await driveServer(
    { PROVIDER_SLOT: 'probe-1', UNIFIED_PROVIDERS_CONFIG: providersPath },
    {
      afterInit: async ({ sendObj, waitForId }) => {
        // No `name`, no `arguments` at all.
        sendObj({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} });
        const noName = await waitForId(5);
        // Known tool but no `arguments` key — must default, not throw.
        sendObj({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ping' } });
        const noArgs = await waitForId(6);
        return { noName, noArgs };
      },
    }
  );
  assert.equal(out.noName.result?.isError, true, 'missing name → clean isError, not a crash');
  assert.match(textOf(out.noName), /Unknown tool/i, 'missing name treated as unknown tool');
  assert.equal(out.noArgs.result?.isError ?? false, false, 'ping with no arguments must succeed');
  assert.match(textOf(out.noArgs), /pong|probe-1/, 'ping with no arguments defaults the message');
});

test('unknown PROVIDER_SLOT exits cleanly (code 1), does NOT hang', async () => {
  const providersPath = writeProviders([PROBE_SLOT]);
  const out = await driveServer(
    { PROVIDER_SLOT: 'this-slot-does-not-exist', UNIFIED_PROVIDERS_CONFIG: providersPath },
    { expectExit: true, timeoutMs: 15000 }
  );
  assert.equal(out.exitCode, 1, 'unknown slot must exit(1), not hang');
});

test('args_template fallback: known family dispatches (#275); unknown family returns a clean config error (no hang)', async () => {
  // (a) Known family 'gemini', NO args_template → must dispatch via the canonical
  //     fallback ['-p','{prompt}']. node -p '1+1' → "2"; proves the fallback fired.
  const geminiPath = writeProviders([{
    name: 'gemini-1', provider: 'test', type: 'subprocess',
    mainTool: 'gemini', cli: process.execPath,
    display_type: 'gemini-cli', display_provider: 'Gemini',
  }]);
  const geminiOut = await driveServer(
    { PROVIDER_SLOT: 'gemini-1', UNIFIED_PROVIDERS_CONFIG: geminiPath },
    {
      afterInit: async ({ sendObj, waitForId }) => {
        sendObj({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'gemini', arguments: { prompt: '1+1' } } });
        return waitForId(5);
      },
    }
  );
  const gText = textOf(geminiOut);
  assert.equal(geminiOut.result?.isError ?? false, false, 'known-family dispatch must not error');
  assert.ok(!/no args_template|has no canonical/i.test(gText), `#275 fallback must apply, got: ${gText}`);
  assert.match(gText, /2/, `gemini-template dispatch should run node -p '1+1' → 2, got: ${gText}`);

  // (b) Unknown family 'probe', NO args_template → must FAIL LOUD with a config
  //     error (clean isError), NOT crash and NOT hang to timeout.
  const probePath = writeProviders([PROBE_SLOT]);
  const probeOut = await driveServer(
    { PROVIDER_SLOT: 'probe-1', UNIFIED_PROVIDERS_CONFIG: probePath },
    {
      afterInit: async ({ sendObj, waitForId }) => {
        sendObj({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'probe', arguments: { prompt: 'hi' } } });
        const cfgErr = await waitForId(5);
        // Server must still be responsive after the config error.
        sendObj({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ping', arguments: { prompt: 'still-here' } } });
        const alive = await waitForId(6);
        return { cfgErr, alive };
      },
    }
  );
  assert.equal(probeOut.cfgErr.result?.isError, true, 'unknown family must yield a clean config error');
  assert.match(textOf(probeOut.cfgErr), /args_template/i, 'config error must name the missing args_template');
  assert.match(textOf(probeOut.alive), /still-here/, 'server must survive the config error');
});

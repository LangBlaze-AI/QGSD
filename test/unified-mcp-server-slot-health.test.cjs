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
    const frames = []; // every parsed frame, including id:null error frames
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
      frames.push(m);
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
      try { finish(await afterInit({ sendRaw, sendObj, waitForId, frames })); }
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
      afterInit: async ({ sendRaw, sendObj, waitForId, frames }) => {
        // Garbage line — must be tolerated (Parse error with id:null), not fatal.
        sendRaw('this is { not ] valid JSON at all ::::');
        sendRaw('');               // blank line — must be skipped
        sendObj({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ping', arguments: { prompt: 'echo-me' } } });
        const pong = await waitForId(5);
        return { pong, frames };
      },
    }
  );
  const text = textOf(out.pong);
  assert.equal(out.pong.result?.isError ?? false, false, 'ping after malformed line must not error');
  assert.match(text, /echo-me/, `server must process the next valid request, got: ${text}`);
  // The server must ACTIVELY emit a JSON-RPC Parse error (-32700, id:null) for the
  // garbage line — not silently swallow it (CodeRabbit #278).
  const parseErr = out.frames.find(f => f && f.error && f.error.code === -32700 && f.id === null);
  assert.ok(parseErr, `server must emit a -32700 Parse error frame for malformed input; frames=${JSON.stringify(out.frames)}`);
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

// ─── Round 2: convergence-confirmation probes ─────────────────────────────────
// Round 1 covered malformed-json / unknown-tool / missing-args / unknown-slot /
// missing-cli. These exercise three paths round 1 never reached: the child-exit
// close handler (non-zero exit + stderr-only-exit-0), env-secret non-leakage, and
// deep_health_check with no deep_probe config. Each fails on a REAL defect — a
// mid-exchange server exit is a crash; a hang trips driveServer's timeout.

// A 'gemini'-family slot whose CLI is the node binary. mainTool='gemini' HAS a
// canonical args_template ['-p','{prompt}'], so dispatch runs `node -p '<prompt>'`
// — letting a test choose the child's stdout/stderr/exit-code from the prompt.
const GEMINI_NODE_SLOT = {
  name: 'gemini-1', provider: 'test', type: 'subprocess',
  mainTool: 'gemini', cli: process.execPath,
  display_type: 'gemini-cli', display_provider: 'Gemini',
};

test('subprocess exit non-zero AND stderr-only-exit-0 both return clean frames; server stays alive', async () => {
  const providersPath = writeProviders([GEMINI_NODE_SLOT]);
  const out = await driveServer(
    { PROVIDER_SLOT: 'gemini-1', UNIFIED_PROVIDERS_CONFIG: providersPath },
    {
      afterInit: async ({ sendObj, waitForId }) => {
        // (a) child writes to stderr then exits NON-ZERO. The close handler must
        //     surface stderr as text + an [exit code N] note, isError:false, no crash.
        sendObj({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
          name: 'gemini',
          arguments: { prompt: "process.stderr.write('BOOM_STDERR');process.exit(3)" },
        } });
        const nonZero = await waitForId(5);
        // (b) child writes ONLY to stderr but exits 0 → stderr surfaces as the output
        //     (stdout||stderr fallback), isError:false, and NO [exit code] note.
        sendObj({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {
          name: 'gemini',
          arguments: { prompt: "process.stderr.write('WARN_ONLY');process.exit(0)" },
        } });
        const stderrOk = await waitForId(6);
        // (c) server must still answer after both subprocess exits.
        sendObj({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ping', arguments: { prompt: 'still-alive' } } });
        const alive = await waitForId(7);
        return { nonZero, stderrOk, alive };
      },
    }
  );
  // Non-zero exit: clean frame, NOT a JSON-RPC error, carries stderr + exit note.
  assert.equal(out.nonZero.result?.isError ?? false, false, 'non-zero exit must be a clean result frame, not isError');
  assert.match(textOf(out.nonZero), /BOOM_STDERR/, 'stderr of a failing child must be surfaced');
  assert.match(textOf(out.nonZero), /\[exit code 3\]/, 'non-zero exit must append the [exit code N] note');
  // stderr-only, exit 0: surfaced as output, no exit-code note.
  assert.equal(out.stderrOk.result?.isError ?? false, false, 'stderr-with-exit-0 must not be an error');
  assert.match(textOf(out.stderrOk), /WARN_ONLY/, 'stderr must be the output when stdout is empty');
  assert.ok(!/\[exit code/.test(textOf(out.stderrOk)), 'exit-0 must NOT append an [exit code] note');
  // Survival proof — a crash on either prior call would have rejected via child exit.
  assert.match(textOf(out.alive), /still-alive/, 'server must survive both child exits');
});

test('slot env secrets are NEVER echoed into identity/ping/health_check responses (no leak)', async () => {
  const CANARY = 'sk-leak-canary-DEADBEEF-0xC0FFEE';
  // Literal (non-${...}) env value: passed straight into the child env, must never
  // reflect back into any tool response. Uses the node-cli probe slot (health_check
  // runs `node --version`, which does not echo its environment).
  const providersPath = writeProviders([{
    ...PROBE_SLOT,
    env: { ANTHROPIC_AUTH_TOKEN: CANARY, ANTHROPIC_API_KEY: CANARY },
  }]);
  const out = await driveServer(
    { PROVIDER_SLOT: 'probe-1', UNIFIED_PROVIDERS_CONFIG: providersPath },
    {
      afterInit: async ({ sendObj, waitForId }) => {
        sendObj({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'identity', arguments: {} } });
        const identity = await waitForId(5);
        sendObj({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'health_check', arguments: {} } });
        const health = await waitForId(6);
        sendObj({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ping', arguments: { prompt: 'hello' } } });
        const ping = await waitForId(7);
        return { identity, health, ping };
      },
    }
  );
  // Scan whole frames (text AND any envelope field) — secret must appear nowhere.
  for (const [label, frame] of Object.entries(out)) {
    const blob = JSON.stringify(frame);
    assert.ok(!blob.includes(CANARY), `secret leaked into ${label} response: ${blob.slice(0, 300)}`);
  }
  // Sanity: identity still returned its documented shape (proves the calls ran).
  const idJson = JSON.parse(textOf(out.identity));
  assert.equal(idJson.name, 'unified-mcp-server', 'identity must carry documented name field');
  assert.equal(idJson.slot, 'probe-1', 'identity must carry the slot name');
});

test('deep_health_check on a slot with NO deep_probe config returns a clean error frame (no crash/hang)', async () => {
  // PROBE_SLOT has no deep_probe; runDeepHealthCheck must short-circuit to a clean
  // { healthy:false, layer:'BINARY_MISSING', error:'No deep_probe config' } result —
  // not throw, not hang, and not block subsequent requests.
  const providersPath = writeProviders([PROBE_SLOT]);
  const out = await driveServer(
    { PROVIDER_SLOT: 'probe-1', UNIFIED_PROVIDERS_CONFIG: providersPath },
    {
      afterInit: async ({ sendObj, waitForId }) => {
        sendObj({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'deep_health_check', arguments: {} } });
        const deep = await waitForId(5);
        sendObj({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ping', arguments: { prompt: 'alive' } } });
        const alive = await waitForId(6);
        return { deep, alive };
      },
    }
  );
  assert.equal(out.deep.result?.isError ?? false, false, 'missing deep_probe must be a clean result, not isError/crash');
  const parsed = JSON.parse(textOf(out.deep));
  assert.equal(parsed.healthy, false, 'no deep_probe → healthy:false');
  assert.match(parsed.error, /No deep_probe config/i, 'must name the missing deep_probe config');
  assert.match(textOf(out.alive), /alive/, 'server must survive a deep_health_check with no probe config');
});

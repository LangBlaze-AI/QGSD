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

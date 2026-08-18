#!/usr/bin/env node
'use strict';
// bin/daintree-fleet.cjs
// Daintree-as-fleet-substrate helper: session handshake, per-call workspace
// assertion, and pane classification for the TEAMLEAD/IMPLEMENTER pattern (#405).
//
// Every guard here exists because its absence caused a measured failure while
// running the pattern by hand. Each is cited at the point it is enforced.

const http = require('node:http');
const https = require('node:https');

/**
 * Terminal panes render the input box ABOVE the status bar, so a shallow
 * `includeOutput.lines` window cannot reach it. Measured: at lines=5 the box is
 * structurally invisible and every read returns "empty"; at lines=14 it appears.
 * Six queued instructions went unseen for an hour behind a lines=5 window.
 */
const BOX_TAIL_LINES = 14;

/** A pane idle beyond this with an empty scrollback has no agent behind it. */
const DEAD_PANE_MIN = 120;

/** Prompt marker the agent pane renders for its input line. */
const PROMPT_MARK = '❯';

/**
 * Separates instrument validity from domain value, so a failed read can never
 * be mistaken for a legitimate value (e.g. "no pending input").
 * @param {boolean} valid
 * @param {*} value
 * @param {string|null} error
 * @returns {{valid: boolean, value: *, error: string|null}}
 */
function reading(valid, value = null, error = null) {
  return { valid, value, error };
}

/**
 * Recover unsubmitted text from a pane's rendered scrollback.
 *
 * This is a workaround, not a design: pending input should be a first-class
 * field. Callers that pass a short tail will silently get null.
 * @param {string|string[]} recentOutput
 * @returns {string|null} pending text, or null when the box is empty
 */
function extractPendingInput(recentOutput) {
  const text = Array.isArray(recentOutput) ? recentOutput.join('\n') : (recentOutput || '');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(PROMPT_MARK));
  if (lines.length === 0) return null;
  const pending = lines[lines.length - 1].slice(PROMPT_MARK.length).trim();
  return pending.length > 0 ? pending : null;
}

/**
 * Assert the resolved workspace on EVERY response.
 *
 * The MCP session resolves against the host's ACTIVE workspace and ignores a
 * workspaceId argument. Measured: it flipped mid-session between two calls in
 * one cycle, to an unrelated project that had its own identically-titled panes.
 * A connect-time assertion passes and is then silently wrong.
 * @param {object} result - the JSON-RPC `result` object
 * @param {string} expectedWorkspaceId
 * @returns {{valid: boolean, value: *, error: string|null}}
 */
function assertWorkspace(result, expectedWorkspaceId) {
  const meta = (result && result._meta) || {};
  const ws = meta['org.daintree/resolved-workspace'] || {};
  if (!expectedWorkspaceId) return reading(true, ws);
  if (ws.workspaceId !== expectedWorkspaceId) {
    return reading(false, ws,
      `workspace flip: resolved ${ws.workspacePath || '?'} (${String(ws.workspaceId || '').slice(0, 12)}), expected ${expectedWorkspaceId.slice(0, 12)}`);
  }
  return reading(true, ws);
}

/**
 * Classify a pane into the four states an orchestrator must distinguish.
 *
 * `agentState` alone collapses IDLE and UNDELIVERED into "waiting". Acting on
 * that conflation is destructive: retasking a pane with pending input overwrites
 * the instruction it was waiting on.
 * @param {object} pane - merged terminal.list + terminal.getStatus entry
 * @param {number} nowMs
 * @param {{idleMinutes?: number}} [opts]
 * @returns {{kind: string, title: string, terminalId: string, idleMin: number, pendingInput: string|null, action: string}}
 */
function classifyPane(pane, nowMs, opts = {}) {
  const idleThreshold = opts.idleMinutes != null ? opts.idleMinutes : 10;
  const idleMin = (nowMs - (pane.lastTransitionAt || nowMs)) / 60000;
  const raw = Array.isArray(pane.recentOutput) ? pane.recentOutput.join('\n') : (pane.recentOutput || '');
  const pending = extractPendingInput(raw);
  const scrollbackEmpty = raw.trim().length <= 8;

  let kind;
  let action;
  if (scrollbackEmpty || idleMin > DEAD_PANE_MIN) {
    // lastTransitionAt advances on a dead pane too, so it cannot establish
    // liveness on its own. Only an empty scrollback separates the two.
    kind = 'DEAD';
    action = 'no agent behind this pane; do not dispatch here';
  } else if (pending) {
    kind = 'UNDELIVERED';
    action = 'deliver the pending instruction; do NOT retask (send replaces the box)';
  } else if (pane.agentState === 'waiting' && idleMin >= idleThreshold) {
    kind = 'IDLE';
    action = 'genuinely free; retask or confirm done';
  } else {
    kind = 'WORKING';
    action = 'none';
  }
  return {
    kind,
    title: pane.title || '(untitled)',
    terminalId: pane.terminalId || pane.id,
    idleMin: Math.round(idleMin * 10) / 10,
    pendingInput: pending,
    action,
  };
}

/**
 * Decide whether a submission may proceed.
 *
 * Two measured footguns: `sendCommand` REPLACES pending input (silently losing
 * it), and a pane whose agent has exited accepts the text as a shell command
 * while still reporting success.
 * @param {object} classified - output of classifyPane
 * @param {{force?: boolean}} [opts]
 * @returns {{allowed: boolean, reason: string|null, displaced: string|null}}
 */
function sendGuard(classified, opts = {}) {
  if (classified.kind === 'DEAD') {
    return { allowed: false, reason: 'pane has no live agent; text would run as a shell command', displaced: null };
  }
  if (classified.pendingInput && !opts.force) {
    return {
      allowed: false,
      reason: 'pane holds unsubmitted input; sending would discard it (pass force to override)',
      displaced: classified.pendingInput,
    };
  }
  return { allowed: true, reason: null, displaced: classified.pendingInput || null };
}

/**
 * An enqueue acknowledgement is not delivery. Measured: `{"sent": true}` was
 * returned for a dead pane, for a flipped workspace, and for text that landed
 * in the box unsubmitted. Callers must verify an off-pane effect.
 * @param {object} sendResult
 * @returns {{acknowledged: boolean, delivered: null, note: string}}
 */
function interpretSendResult(sendResult) {
  const ack = Boolean(sendResult && sendResult.sent);
  return {
    acknowledged: ack,
    delivered: null,
    note: 'acknowledgement only — confirm an off-pane effect (branch pushed, file changed, state advanced)',
  };
}

// ── transport ───────────────────────────────────────────────────────────────

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      { method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/**
 * Open a session. The handshake (initialize -> capture Mcp-Session-Id ->
 * notifications/initialized) is boilerplate every caller would otherwise
 * reimplement; getting it wrong yields "Server not initialized".
 * @param {{url: string, token: string}} cfg
 * @returns {Promise<{valid: boolean, value: *, error: string|null}>}
 */
async function openSession(cfg) {
  const auth = { Authorization: `Bearer ${cfg.token}` };
  let res;
  try {
    res = await postJson(cfg.url, auth, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nforma-fleet', version: '1' } },
    });
  } catch (e) {
    return reading(false, null, `transport: ${e.message}`);
  }
  const sid = res.headers['mcp-session-id'];
  if (!sid) return reading(false, null, `no Mcp-Session-Id (status ${res.status})`);
  await postJson(cfg.url, { ...auth, 'Mcp-Session-Id': sid }, { jsonrpc: '2.0', method: 'notifications/initialized' });
  return reading(true, { sessionId: sid, headers: { ...auth, 'Mcp-Session-Id': sid } });
}

/**
 * Invoke a tool, asserting workspace binding on the response.
 * @param {{url: string, workspaceId?: string}} cfg
 * @param {object} session - value from openSession
 * @param {string} name
 * @param {object} args
 */
async function callTool(cfg, session, name, args) {
  let res;
  try {
    res = await postJson(cfg.url, session.headers, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} },
    });
  } catch (e) {
    return reading(false, null, `transport: ${e.message}`);
  }
  let parsed;
  try {
    const line = res.body.replace(/^data: /gm, '').trim().split('\n').filter(Boolean).pop();
    parsed = JSON.parse(line);
  } catch (e) {
    return reading(false, null, `unparseable response: ${e.message}`);
  }
  if (parsed.error) return reading(false, null, `rpc error: ${JSON.stringify(parsed.error).slice(0, 200)}`);
  const ws = assertWorkspace(parsed.result, cfg.workspaceId);
  if (!ws.valid) return reading(false, null, ws.error);
  const content = ((parsed.result || {}).content || [{}])[0] || {};
  if (parsed.result && parsed.result.isError) return reading(false, null, String(content.text || '').slice(0, 200));
  return reading(true, content.text);
}

module.exports = {
  BOX_TAIL_LINES,
  DEAD_PANE_MIN,
  PROMPT_MARK,
  reading,
  extractPendingInput,
  assertWorkspace,
  classifyPane,
  sendGuard,
  interpretSendResult,
  openSession,
  callTool,
};

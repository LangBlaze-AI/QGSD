'use strict';

/**
 * auth-drivers/simple.cjs — login-only driver (no account pool)
 *
 * For providers where there is a single account / session and no concept
 * of switching between multiple credentials. The only operation is "add"
 * (i.e., log in), which opens a terminal window running auth.login.
 *
 * Applies to: codex-1/2, opencode-1, and any future CLIs before pool support is added.
 *
 * Required providers.json fields:
 *   auth.login                     — login command (e.g. ["opencode", "auth"])
 *   oauth_rotation.active_file     — optional; if present, JWT email is decoded from it
 */

const os = require('os');
const fs = require('fs');

/**
 * list() → []
 * No pool — there are no accounts to enumerate.
 */
function list(_provider) {
  return [];
}

/**
 * switch() — not supported; simple providers have no multi-account concept.
 */
function switchAccount(_provider, _name) {
  throw new Error('Account switching is not supported for this provider.');
}

/**
 * addCredentialFile() → null
 * No known credential file to poll; promptLoginExternal waits for manual [Enter].
 */
function addCredentialFile(_provider) {
  return null;
}

/**
 * extractAccountName(provider) → string | null
 *
 * Two strategies, tried in order:
 *
 * 1. identity_detect (regex on a plain text/YAML/JSON file)
 *    Configured via providers.json identity_detect.{file, pattern}.
 *    Used for providers whose identity lives in a third-party config file,
 *    e.g. OpenCode delegates to gh: file=~/.config/gh/hosts.yml.
 *
 * 2. JWT decode from oauth_rotation.active_file
 *    Reads the credential JSON and decodes the id_token claim (or
 *    tokens.id_token for Codex-style nesting) to extract the email.
 *
 * Returns null if no strategy succeeds or on any I/O / parse error.
 */
function extractAccountName(provider) {
  // Strategy 1 — identity_detect (data-driven regex on a config file)
  try {
    const det = provider.identity_detect;
    if (det?.file && det?.pattern) {
      const filePath = det.file.replace(/^~/, os.homedir());
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const m = content.match(new RegExp(det.pattern, 'm'));
        if (m && m[1] != null) return m[1];
      }
    }
  } catch (_) {}

  // Strategy 2 — JWT email from oauth_rotation.active_file
  try {
    const activeFile = provider.oauth_rotation?.active_file;
    if (!activeFile) return null;
    const filePath = activeFile.replace(/^~/, os.homedir());
    if (!fs.existsSync(filePath)) return null;
    const creds = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Gemini-style: { id_token: "..." }  |  Codex-style: { tokens: { id_token: "..." } }
    const jwt = creds.id_token ?? creds.tokens?.id_token;
    if (!jwt) return null;
    const payload = Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8');
    const email = JSON.parse(payload).email;
    return typeof email === 'string' ? email : null;
  } catch (_) {
    return null;
  }
}

/**
 * add() — no-op: the terminal already ran auth.login; nothing to capture.
 */
async function add(_provider, _name) {}

module.exports = { list, switch: switchAccount, addCredentialFile, extractAccountName, add };

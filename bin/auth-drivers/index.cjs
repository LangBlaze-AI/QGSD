'use strict';

/**
 * auth-drivers/index.cjs — driver loader
 *
 * loadDriver(type) resolves an auth driver by name, validates the 4-method
 * interface contract, and returns the driver module.
 *
 * Driver interface (all methods required):
 *   list(provider)              → [{ name: string, active: boolean }]
 *   switch(provider, name)      → void  (throws on error)
 *   addCredentialFile(provider) → string | null  (file to poll for mtime, null = keychain)
 *   extractAccountName(provider)→ string | null  (auto-detect after add, null = must prompt)
 */

const path = require('path');

const DRIVER_DIR = __dirname;

const REQUIRED_METHODS = ['list', 'switch', 'addCredentialFile', 'extractAccountName'];

function loadDriver(type) {
  if (!type) return null;

  if (typeof type !== 'string' || !/^[a-z0-9_-]+$/i.test(type)) {
    throw new Error(`Unknown auth driver "${type}" — expected ${path.join(DRIVER_DIR, String(type) + '.cjs')}`);
  }

  const driverPath = path.join(DRIVER_DIR, type + '.cjs');
  let driver;
  try {
    driver = require(driverPath);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      throw new Error(`Unknown auth driver "${type}" — expected ${driverPath}`);
    }
    throw err;
  }

  // Validate interface contract
  for (const method of REQUIRED_METHODS) {
    if (typeof driver[method] !== 'function') {
      throw new Error(`Auth driver "${type}" missing required method: ${method}()`);
    }
  }

  return driver;
}

module.exports = { loadDriver };

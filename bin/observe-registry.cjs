/**
 * Source handler registry with pluggable dispatch
 * Provides register/get/list/dispatch with timeout wrapping and Promise.allSettled parallel dispatch
 */

// Internal handler map
const handlers = new Map();

/**
 * Register a source handler function
 * @param {string} sourceType - Source type identifier (e.g., "github", "sentry")
 * @param {Function} handlerFn - Async handler: (sourceConfig, options) -> { source_label, source_type, status, issues[], error? }
 * @throws {Error} If sourceType is already registered
 */
function registerHandler(sourceType, handlerFn) {
  if (handlers.has(sourceType)) {
    throw new Error(`Handler already registered for source type: ${sourceType}`);
  }
  if (typeof handlerFn !== 'function') {
    throw new Error(`Handler must be a function, got: ${typeof handlerFn}`);
  }
  handlers.set(sourceType, handlerFn);
}

/**
 * Get the registered handler for a source type
 * @param {string} sourceType - Source type identifier
 * @returns {Function|null} Handler function or null if not registered
 */
function getHandler(sourceType) {
  return handlers.get(sourceType) || null;
}

/**
 * List all registered source types
 * @returns {string[]} Array of registered source type strings
 */
function listHandlers() {
  return Array.from(handlers.keys());
}

/**
 * Dispatch a single source with timeout wrapping
 * Looks up handler, wraps in Promise.race with timeout, returns standard schema on error
 *
 * @param {object} sourceConfig - Source configuration object with type, label, etc.
 * @param {object} options - Options passed to handler (sinceOverride, limitOverride)
 * @param {number} [timeoutSeconds=10] - Timeout in seconds
 * @returns {Promise<object>} Standard schema result { source_label, source_type, status, issues[], error? }
 */
async function dispatchSource(sourceConfig, options, timeoutSeconds) {
  const cfg = (sourceConfig && typeof sourceConfig === 'object') ? sourceConfig : {};
  const timeout = timeoutSeconds ?? 10;
  const label = cfg.label || cfg.type || 'unknown';
  const type = cfg.type || 'unknown';

  const handlerFn = getHandler(type);
  if (!handlerFn) {
    return {
      source_label: label,
      source_type: type,
      status: 'error',
      error: `No handler registered for type: ${type}`,
      issues: []
    };
  }

  try {
    const handlerPromise = handlerFn(cfg, options || {});
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeout}s`)), timeout * 1000)
    );

    const result = await Promise.race([handlerPromise, timeoutPromise]);
    return result;
  } catch (err) {
    return {
      source_label: label,
      source_type: type,
      status: 'error',
      error: err.message || 'Unknown error',
      issues: []
    };
  }
}

/**
 * Dispatch all sources in parallel via Promise.allSettled
 * One failing source does not block others (OBS-08)
 *
 * @param {object[]} sources - Array of source config objects
 * @param {object} options - Options passed to each handler
 * @returns {Promise<object[]>} Array of results (standard schema)
 */
async function dispatchAll(sources, options) {
  // A non-array `sources` (corrupt/empty config) → no dispatches, not a `.map` crash.
  const list = Array.isArray(sources) ? sources : [];
  const promises = list.map(source =>
    dispatchSource(source, options, (source && typeof source === 'object') ? source.timeout : undefined)
  );

  const settled = await Promise.allSettled(promises);

  return settled.map((result, idx) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // Rejected — should not happen since dispatchSource catches errors,
    // but handle defensively
    return {
      source_label: sources[idx].label || sources[idx].type || 'unknown',
      source_type: sources[idx].type || 'unknown',
      status: 'error',
      error: `Dispatch failed: ${result.reason?.message || 'Unknown error'}`,
      issues: []
    };
  });
}

/**
 * Clear all registered handlers (for testing)
 */
function clearHandlers() {
  handlers.clear();
}

module.exports = {
  registerHandler,
  getHandler,
  listHandlers,
  dispatchSource,
  dispatchAll,
  clearHandlers
};

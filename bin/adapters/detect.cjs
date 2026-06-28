'use strict';
// bin/adapters/detect.cjs
// Auto-detection registry — runs all adapters to identify the framework of a source file.

const ADAPTER_IDS = [
  // JS/TS
  'xstate-v5',
  'xstate-v4',
  'jsm',
  'robot',
  'machina',
  'jssm',
  'use-state-machine',
  // JSON
  'asl',
  'stately',
  // Python
  'python-transitions',
  'sismic',
  'django-fsm',
  'python-statemachine',
  // Go
  'looplab-fsm',
  'qmuntal-stateless',
  // Java/Kotlin
  'spring-statemachine',
  'squirrel',
  'stateless4j',
  'kstatemachine',
  // C#/.NET
  'dotnet-stateless',
  'automatonymous',
  // Ruby
  'aasm',
  'ruby-state-machines',
  // Rust
  'rust-fsm',
  'statig',
  // Elixir/Erlang
  'gen-statem',
  'machinery',
  // Swift
  'swift-state',
];

const ADAPTER_FILES = {
  'xstate-v5':          './xstate-v5.cjs',
  'xstate-v4':          './xstate-v4.cjs',
  'jsm':                './jsm.cjs',
  'robot':              './robot.cjs',
  'machina':            './machina.cjs',
  'jssm':               './jssm.cjs',
  'use-state-machine':  './use-state-machine.cjs',
  'asl':                './asl.cjs',
  'stately':            './stately.cjs',
  'python-transitions': './python-transitions.cjs',
  'sismic':             './sismic.cjs',
  'django-fsm':         './django-fsm.cjs',
  'python-statemachine':'./python-statemachine.cjs',
  'looplab-fsm':        './looplab-fsm.cjs',
  'qmuntal-stateless':  './qmuntal-stateless.cjs',
  'spring-statemachine':'./spring-statemachine.cjs',
  'squirrel':           './squirrel.cjs',
  'stateless4j':        './stateless4j.cjs',
  'kstatemachine':      './kstatemachine.cjs',
  'dotnet-stateless':   './dotnet-stateless.cjs',
  'automatonymous':     './automatonymous.cjs',
  'aasm':               './aasm.cjs',
  'ruby-state-machines':'./ruby-state-machines.cjs',
  'rust-fsm':           './rust-fsm.cjs',
  'statig':             './statig.cjs',
  'gen-statem':         './gen-statem.cjs',
  'machinery':          './machinery.cjs',
  'swift-state':        './swift-state.cjs',
};

/**
 * Lazily load all available adapters.
 * @returns {Array<Object>} adapter modules
 */
function listAdapters() {
  const adapters = [];
  for (const id of ADAPTER_IDS) {
    try {
      adapters.push(require(ADAPTER_FILES[id]));
    } catch (e) {
      // Adapter not yet created — fail-open with warning
      process.stderr.write('[detect] Warning: adapter "' + id + '" not loadable: ' + e.message + '\n');
    }
  }
  return adapters;
}

/**
 * Auto-detect the framework of a source file.
 * @param {string} filePath
 * @param {string} content
 * @returns {{ adapter: Object, confidence: number } | null}
 */
function detectFramework(filePath, content) {
  const adapters = listAdapters();
  let best = null;
  let bestConfidence = 0;

  for (const adapter of adapters) {
    try {
      const confidence = adapter.detect(filePath, content);
      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        best = adapter;
      }
    } catch (_) {
      // Skip broken adapters
    }
  }

  if (best && bestConfidence >= 60) {
    return { adapter: best, confidence: bestConfidence };
  }
  return null;
}

/**
 * Get adapter by framework id.
 * @param {string} frameworkId
 * @returns {Object}
 */
function getAdapter(frameworkId) {
  const file = Object.prototype.hasOwnProperty.call(ADAPTER_FILES, frameworkId)
    ? ADAPTER_FILES[frameworkId]
    : undefined;
  if (typeof file !== 'string') {
    throw new Error('Unknown framework: "' + frameworkId + '". Available: ' + ADAPTER_IDS.join(', '));
  }
  return require(file);
}

module.exports = { listAdapters, detectFramework, getAdapter };

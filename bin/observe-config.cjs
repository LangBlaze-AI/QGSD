/**
 * Observe config loader
 * Loads source configuration from .planning/observe-sources.md (or triage-sources.md fallback)
 * Parses YAML frontmatter, infers issue_type, applies defaults, validates required fields
 */

const fs = require('node:fs');
const path = require('node:path');

// Source types that default to "issue"
const ISSUE_TYPES = ['github', 'sentry', 'sentry-feedback', 'bash'];
// Source types that default to "drift"
const DRIFT_TYPES = ['prometheus', 'grafana', 'logstash'];
// Source types that default to "upstream"
const UPSTREAM_TYPES = ['upstream'];
// Source types that default to "deps"
const DEPS_TYPES = ['deps'];

/**
 * Parse a YAML value string into appropriate JS type
 * @param {string} val - Value string
 * @returns {*} Parsed value
 */
function parseYamlValue(val) {
  if (val === undefined || val === null || val === '') return '';

  // Remove inline comments (but not inside quotes)
  if (!val.startsWith('"') && !val.startsWith("'")) {
    val = val.replace(/\s+#.*$/, '').trim();
  }

  // Boolean
  if (val === 'true') return true;
  if (val === 'false') return false;

  // Null
  if (val === 'null' || val === '~') return null;

  // Number
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);

  // Inline array [a, b, c]
  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => parseYamlValue(s.trim()));
  }

  // Quoted string
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }

  return val;
}

/**
 * Minimal YAML parser for observe config frontmatter
 * Handles: key-value pairs, nested objects, arrays of objects (- key: val), inline arrays
 *
 * @param {string} yamlStr - YAML string to parse
 * @returns {object} Parsed object
 */
function parseSimpleYaml(yamlStr) {
  const lines = yamlStr.split('\n');

  // Pre-process: strip comments and track indent + content
  const entries = [];
  for (const line of lines) {
    // Preserve empty lines for structure but skip pure comment lines
    const stripped = line.replace(/#.*$/, '');
    const trimmed = stripped.trim();
    if (!trimmed) continue;
    const indent = stripped.search(/\S/);
    entries.push({ indent, raw: trimmed });
  }

  return parseBlock(entries, 0, -1).result;
}

/**
 * Parse a block of YAML entries starting at index `start` with parent indent `parentIndent`.
 * Returns { result, nextIndex }
 */
function parseBlock(entries, start, parentIndent) {
  const result = {};
  let i = start;

  while (i < entries.length) {
    const entry = entries[i];

    // If this line is at or before parent indent, we're done with this block
    if (entry.indent <= parentIndent) break;

    const raw = entry.raw;

    // Array item: "- key: val" or "- val"
    if (raw.startsWith('- ')) {
      // This shouldn't happen at top level without a key — skip
      i++;
      continue;
    }

    // Key: value
    const colonIdx = raw.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = raw.slice(0, colonIdx).trim();
    const valStr = raw.slice(colonIdx + 1).trim();

    if (valStr === '' || valStr === undefined) {
      // Check what follows: nested object, array of objects, or empty
      const nextIdx = i + 1;
      if (nextIdx < entries.length && entries[nextIdx].indent > entry.indent) {
        // Check if it's an array (next line starts with "- ")
        if (entries[nextIdx].raw.startsWith('- ')) {
          const arrResult = parseArray(entries, nextIdx, entry.indent);
          result[key] = arrResult.items;
          i = arrResult.nextIndex;
        } else {
          // Nested object
          const blockResult = parseBlock(entries, nextIdx, entry.indent);
          result[key] = blockResult.result;
          i = blockResult.nextIndex;
        }
      } else {
        result[key] = {};
        i++;
      }
    } else {
      result[key] = parseYamlValue(valStr);
      i++;
    }
  }

  return { result, nextIndex: i };
}

/**
 * Parse an array block starting at index `start`.
 * Each "- key: val" starts a new object; subsequent indented lines add to it.
 */
function parseArray(entries, start, parentIndent) {
  const items = [];
  let i = start;

  while (i < entries.length) {
    const entry = entries[i];

    // If we've dedented back to parent level or less, we're done
    if (entry.indent <= parentIndent) break;

    if (entry.raw.startsWith('- ')) {
      // Start of a new array item
      const content = entry.raw.slice(2).trim();
      const arrayItemIndent = entry.indent;

      if (content.includes(':')) {
        // Object item
        const item = {};
        const colonIdx = content.indexOf(':');
        const k = content.slice(0, colonIdx).trim();
        const v = content.slice(colonIdx + 1).trim();

        if (v === '') {
          // Nested value under this array item key
          const nextIdx = i + 1;
          if (nextIdx < entries.length && entries[nextIdx].indent > arrayItemIndent) {
            if (entries[nextIdx].raw.startsWith('- ')) {
              const nestedArr = parseArray(entries, nextIdx, arrayItemIndent);
              item[k] = nestedArr.items;
              i = nestedArr.nextIndex;
            } else {
              const nestedBlock = parseBlock(entries, nextIdx, arrayItemIndent);
              item[k] = nestedBlock.result;
              i = nestedBlock.nextIndex;
            }
          } else {
            item[k] = {};
            i++;
          }
        } else {
          item[k] = parseYamlValue(v);
          i++;
        }

        // Collect additional key:val pairs for this array item (indented deeper than "- ")
        while (i < entries.length && entries[i].indent > arrayItemIndent && !entries[i].raw.startsWith('- ')) {
          const subEntry = entries[i];
          const subColonIdx = subEntry.raw.indexOf(':');
          if (subColonIdx !== -1) {
            const sk = subEntry.raw.slice(0, subColonIdx).trim();
            const sv = subEntry.raw.slice(subColonIdx + 1).trim();

            if (sv === '') {
              // Nested block under this key
              const nextIdx = i + 1;
              if (nextIdx < entries.length && entries[nextIdx].indent > subEntry.indent) {
                if (entries[nextIdx].raw.startsWith('- ')) {
                  const nestedArr = parseArray(entries, nextIdx, subEntry.indent);
                  item[sk] = nestedArr.items;
                  i = nestedArr.nextIndex;
                } else {
                  const nestedBlock = parseBlock(entries, nextIdx, subEntry.indent);
                  item[sk] = nestedBlock.result;
                  i = nestedBlock.nextIndex;
                }
              } else {
                item[sk] = {};
                i++;
              }
            } else {
              item[sk] = parseYamlValue(sv);
              i++;
            }
          } else {
            i++;
          }
        }

        items.push(item);
      } else {
        // Simple value array item
        items.push(parseYamlValue(content));
        i++;
      }
    } else {
      // Not an array item, done with this array
      break;
    }
  }

  return { items, nextIndex: i };
}

/**
 * Load observe configuration from YAML frontmatter file
 *
 * @param {string} [configPath] - Optional explicit config file path
 * @param {string} [basePath] - Base directory (default: process.cwd())
 * @returns {object} { sources, configFile, observeConfig, error? }
 */
function loadObserveConfig(configPath, basePath) {
  const base = basePath || process.cwd();

  // Resolve config file: explicit path > observe-sources.md > triage-sources.md
  let configFile = null;
  if (configPath) {
    const resolved = path.resolve(base, configPath);
    if (fs.existsSync(resolved)) {
      configFile = resolved;
    }
  }

  if (!configFile) {
    const observePath = path.resolve(base, '.planning/observe-sources.md');
    if (fs.existsSync(observePath)) {
      configFile = observePath;
    }
  }

  if (!configFile) {
    const triagePath = path.resolve(base, '.planning/triage-sources.md');
    if (fs.existsSync(triagePath)) {
      configFile = triagePath;
    }
  }

  if (!configFile) {
    return {
      sources: [],
      configFile: null,
      observeConfig: {},
      error: 'No observe sources configured'
    };
  }

  // Read and parse frontmatter
  let content;
  try {
    content = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    return {
      sources: [],
      configFile,
      observeConfig: {},
      error: `Failed to read config file: ${err.message}`
    };
  }
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return {
      sources: [],
      configFile,
      observeConfig: {},
      error: 'No YAML frontmatter found in config file'
    };
  }

  const frontmatter = parseSimpleYaml(fmMatch[1]);

  // Extract observe_config global settings
  const observeConfig = frontmatter.observe_config || {};
  const defaultTimeout = observeConfig.default_timeout ?? 10;
  const failOpenDefault = observeConfig.fail_open_default ?? true;

  // Extract sources array
  let sources = [];
  if (Array.isArray(frontmatter.sources)) {
    sources = frontmatter.sources;
  } else if (observeConfig && Array.isArray(observeConfig.sources)) {
    sources = observeConfig.sources;
  }

  // Validate and apply defaults
  const validationErrors = [];
  sources = sources.map((source, idx) => {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      validationErrors.push(`sources[${idx}]: must be a mapping with type and label`);
      return { timeout: defaultTimeout, fail_open: failOpenDefault };
    }
    const errors = [];

    // Required fields
    if (!source.type || typeof source.type !== 'string') {
      errors.push(`sources[${idx}]: type required (string)`);
    }
    if (!source.label || typeof source.label !== 'string') {
      errors.push(`sources[${idx}]: label required (string)`);
    }

    if (errors.length > 0) {
      validationErrors.push(...errors);
    }

    // Infer issue_type if not specified
    if (!source.issue_type) {
      if (ISSUE_TYPES.includes(source.type)) {
        source.issue_type = 'issue';
      } else if (DRIFT_TYPES.includes(source.type)) {
        source.issue_type = 'drift';
      } else if (UPSTREAM_TYPES.includes(source.type)) {
        source.issue_type = 'upstream';
      } else if (DEPS_TYPES.includes(source.type)) {
        source.issue_type = 'deps';
      }
    }

    // Apply defaults
    source.timeout = source.timeout ?? defaultTimeout;
    source.fail_open = source.fail_open ?? failOpenDefault;

    return source;
  });

  const result = {
    sources,
    configFile,
    observeConfig: {
      default_timeout: defaultTimeout,
      fail_open_default: failOpenDefault
    }
  };

  if (validationErrors.length > 0) {
    result.error = validationErrors.join('; ');
  }

  return result;
}

module.exports = { loadObserveConfig, parseSimpleYaml, parseYamlValue };

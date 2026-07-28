'use strict';

/**
 * Native Codex installation helpers.
 *
 * Codex does not load Claude-style commands or Markdown agents. It discovers
 * reusable workflows as skills and custom agents as standalone TOML files.
 * These helpers keep the installer conversion deterministic and testable.
 */

const fs = require('fs');
const path = require('path');
const { argsTemplateFor } = require('./provider-arg-templates.cjs');

const MCP_BLOCK_BEGIN = '# BEGIN nForma managed MCP servers';
const MCP_BLOCK_END = '# END nForma managed MCP servers';

function splitFrontmatter(content) {
  if (!content.startsWith('---')) {
    return { frontmatter: '', body: content };
  }

  const lines = content.split(/\r?\n/);
  if (lines[0].trim() !== '---') {
    return { frontmatter: '', body: content };
  }

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) {
    return { frontmatter: '', body: content };
  }

  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n').replace(/^\n+/, ''),
  };
}

function readFrontmatterField(frontmatter, field) {
  const lines = frontmatter.split(/\r?\n/);
  const fieldPattern = new RegExp(`^${field}:\\s*(.*)$`);

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(fieldPattern);
    if (!match) continue;

    const value = match[1].trim();
    if (value !== '>' && value !== '|') {
      return value.replace(/^(['"])(.*)\1$/, '$2');
    }

    const continuation = [];
    for (index += 1; index < lines.length; index++) {
      if (!/^\s+/.test(lines[index])) break;
      continuation.push(lines[index].trim());
    }
    return value === '>' ? continuation.join(' ') : continuation.join('\n');
  }

  return '';
}

function normalizeSkillName(name, fallbackName) {
  let result = (name || fallbackName || '').trim();
  if (!result.startsWith('nf:')) {
    result = `nf:${result.replace(/^nf[-:]/, '')}`;
  }
  return result;
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function adaptCodexMarkdown(content, pathPrefix) {
  const prefix = pathPrefix.endsWith('/') ? pathPrefix : `${pathPrefix}/`;
  return content
    .replace(/~\/\.claude\//g, prefix)
    .replace(/\.\/\.claude\//g, prefix)
    .replace(/\/nf:/g, '$nf:')
    .replace(/(\/agents\/nf-[a-z0-9-]+)\.md\b/gi, '$1.toml');
}

function convertMarkdownToCodexSkill(content, fallbackName) {
  const { frontmatter, body } = splitFrontmatter(content);
  const name = normalizeSkillName(readFrontmatterField(frontmatter, 'name'), fallbackName);
  const description = readFrontmatterField(frontmatter, 'description')
    || `Run the ${name} nForma workflow in Codex.`;

  const adapter = [
    '<codex_adapter>',
    'This nForma workflow is running in Codex.',
    `- Treat text after \`$${name}\` as \`$ARGUMENTS\`.`,
    '- Read every file referenced with `@` in an `<execution_context>` before acting.',
    '- Interpret Claude-style `Task(...)` blocks as native Codex subagent delegation. Use the custom agent named by `subagent_type` and preserve the prompt, parallelism, and result-handling instructions.',
    '- Invoke another nForma workflow by mentioning its `$nf:*` skill.',
    '- Map Claude-specific tool names to the equivalent available Codex tools while preserving the workflow intent and safety gates.',
    '</codex_adapter>',
    '',
  ].join('\n');

  return {
    name,
    description,
    content: [
      '---',
      `name: ${yamlScalar(name)}`,
      `description: ${yamlScalar(description.replace(/\/nf:/g, '$nf:'))}`,
      '---',
      '',
      adapter + body,
    ].join('\n').replace(/\s+$/, '') + '\n',
  };
}

function convertMarkdownToCodexAgent(content, fallbackName) {
  const { frontmatter, body } = splitFrontmatter(content);
  const name = readFrontmatterField(frontmatter, 'name') || fallbackName;
  const description = (readFrontmatterField(frontmatter, 'description')
    || `nForma custom agent: ${name}`).replace(/\/nf:/g, '$nf:');
  const instructions = [
    'You are a native Codex custom agent converted from an nForma agent definition.',
    'Map any Claude-specific tool names to equivalent Codex tools. Preserve all role boundaries, required reads, output contracts, and safety rules.',
    '',
    body,
  ].join('\n').replace(/\s+$/, '') + '\n';

  return [
    `name = ${JSON.stringify(name)}`,
    `description = ${JSON.stringify(description)}`,
    `developer_instructions = ${JSON.stringify(instructions)}`,
    '',
  ].join('\n');
}

function collectMarkdownFiles(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) return files;

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

function removeOwnedSkillDirectories(skillsDir) {
  if (!fs.existsSync(skillsDir)) return;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const { frontmatter } = splitFrontmatter(fs.readFileSync(skillPath, 'utf8'));
    if (readFrontmatterField(frontmatter, 'name').startsWith('nf:')) {
      fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
    }
  }
}

function installCodexSkills({
  commandsDir,
  packagedSkillsDir,
  destinationDirs,
  pathPrefix,
  transformContent = content => content,
}) {
  const skillsByName = new Map();

  for (const commandPath of collectMarkdownFiles(commandsDir)) {
    const fallbackName = path.relative(commandsDir, commandPath)
      .replace(/\\/g, '-')
      .replace(/\.md$/, '');
    const adapted = adaptCodexMarkdown(transformContent(fs.readFileSync(commandPath, 'utf8')), pathPrefix);
    const skill = convertMarkdownToCodexSkill(adapted, fallbackName);
    skillsByName.set(skill.name, skill);
  }

  // Hand-authored packaged skills are more focused than their command wrappers,
  // so they intentionally win when the two sources expose the same skill name.
  if (fs.existsSync(packagedSkillsDir)) {
    for (const entry of fs.readdirSync(packagedSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(packagedSkillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const adapted = adaptCodexMarkdown(transformContent(fs.readFileSync(skillPath, 'utf8')), pathPrefix);
      const skill = convertMarkdownToCodexSkill(adapted, entry.name);
      skillsByName.set(skill.name, skill);
    }
  }

  const uniqueDestinations = [...new Set(destinationDirs.map(dir => path.resolve(dir)))];
  for (const destination of uniqueDestinations) {
    fs.mkdirSync(destination, { recursive: true });
    removeOwnedSkillDirectories(destination);
    for (const skill of skillsByName.values()) {
      const directoryName = skill.name.replace(':', '-').replace(/[^a-zA-Z0-9_-]/g, '-');
      const skillDir = path.join(destination, directoryName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.content, 'utf8');
    }
  }

  return skillsByName.size;
}

function removeCodexSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return 0;
  const before = fs.readdirSync(skillsDir).length;
  removeOwnedSkillDirectories(skillsDir);
  return before - fs.readdirSync(skillsDir).length;
}

function normalizeDetectedProvider(provider) {
  const family = provider.mainTool || provider.name;
  if (!family) return null;
  const argsTemplate = provider.args_template || argsTemplateFor(family);
  if (!argsTemplate) return null;
  const rawName = (provider.name || family).replace(/^nforma-/, '');
  const slotName = rawName === family ? `${family}-1` : rawName;
  const aliases = {
    codex: [{
      name: 'review',
      description: 'Send a review prompt to the Codex CLI.',
      args_template: argsTemplate,
    }],
    copilot: [{
      name: 'ask',
      description: 'Send a prompt to the GitHub Copilot CLI.',
      args_template: argsTemplate,
    }],
  };

  return {
    ...provider,
    name: `nforma-${slotName}`,
    provider: provider.provider || 'auto-detected',
    type: provider.type || 'subprocess',
    description: provider.description || `Auto-detected ${family} on PATH`,
    mainTool: family,
    cli: provider.resolvedPath || provider.cli || family,
    display_type: provider.display_type || `${family}-cli`,
    display_provider: provider.display_provider || family.charAt(0).toUpperCase() + family.slice(1),
    args_template: argsTemplate,
    ...(provider.extraTools
      ? { extraTools: provider.extraTools }
      : (aliases[family] ? { extraTools: aliases[family] } : {})),
    ...(provider.env ? { env: provider.env } : {}),
    ...(provider.model ? { model: provider.model } : {}),
  };
}

function ensureCodexProviders(providersPath, detectedProviders, selectedSlots = null) {
  let data = { providers: [] };
  try {
    if (fs.existsSync(providersPath)) {
      data = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
    }
  } catch (_) {
    data = { providers: [] };
  }

  const existing = (Array.isArray(data.providers) ? data.providers : [])
    .map(normalizeDetectedProvider)
    .filter(Boolean);
  const byName = new Map(existing.map(provider => [provider.name, provider]));

  for (const rawProvider of detectedProviders || []) {
    const provider = normalizeDetectedProvider(rawProvider);
    if (!provider) continue;
    if (selectedSlots
        && !selectedSlots.includes(provider.name)
        && !selectedSlots.includes(rawProvider.name)
        && !selectedSlots.includes(provider.mainTool)) {
      continue;
    }
    if (!byName.has(provider.name)) byName.set(provider.name, provider);
  }

  const isSelected = provider => {
    if (!selectedSlots) return true;
    const unprefixedName = provider.name.replace(/^nforma-/, '');
    const familyName = unprefixedName.replace(/-\d+$/, '');
    return selectedSlots.includes(provider.name)
      || selectedSlots.includes(unprefixedName)
      || selectedSlots.includes(provider.mainTool)
      || selectedSlots.includes(familyName);
  };
  const active = [...byName.values()].filter(provider =>
    provider && provider.name && provider.active !== false && isSelected(provider)
  );
  fs.mkdirSync(path.dirname(providersPath), { recursive: true });
  fs.writeFileSync(providersPath, JSON.stringify({ ...data, providers: [...byName.values()] }, null, 2) + '\n', 'utf8');
  return active;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function renderCodexMcpBlock(providers, targetDir, providersPath) {
  if (!providers.length) return '';
  const unifiedServer = path.join(targetDir, 'nf-bin', 'unified-mcp-server.mjs');
  const lines = [MCP_BLOCK_BEGIN];

  for (const provider of providers) {
    const serverName = provider.name.startsWith('nforma-') ? provider.name : `nforma-${provider.name}`;
    lines.push(
      '',
      `[mcp_servers.${tomlString(serverName)}]`,
      'command = "node"',
      `args = [${tomlString(unifiedServer)}]`,
      '',
      `[mcp_servers.${tomlString(serverName)}.env]`,
      `PROVIDER_SLOT = ${tomlString(provider.name)}`,
      `UNIFIED_PROVIDERS_CONFIG = ${tomlString(providersPath)}`,
    );
  }
  lines.push('', MCP_BLOCK_END);
  return lines.join('\n');
}

function replaceManagedMcpBlock(content, block) {
  const escapedBegin = MCP_BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = MCP_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const managedPattern = new RegExp(`(?:^|\\n)${escapedBegin}[\\s\\S]*?${escapedEnd}(?:\\n|$)`);
  const withoutManaged = content.replace(managedPattern, '\n').replace(/\s+$/, '');
  return [withoutManaged, block].filter(Boolean).join(withoutManaged ? '\n\n' : '') + '\n';
}

function configureCodexMcp(configPath, providers, targetDir, providersPath) {
  let existing = '';
  try {
    existing = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    // A missing config is a normal first-install case.
  }
  const block = renderCodexMcpBlock(providers, targetDir, providersPath);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, replaceManagedMcpBlock(existing, block), 'utf8');

  const requiredModels = {};
  const activeSlots = [];
  for (const provider of providers) {
    const family = provider.mainTool || provider.name.replace(/-\d+$/, '');
    const serverName = provider.name.startsWith('nforma-') ? provider.name : `nforma-${provider.name}`;
    activeSlots.push(provider.name);
    if (!requiredModels[family]) {
      requiredModels[family] = {
        tool_prefix: `mcp__${serverName}__`,
        required: true,
      };
    }
  }
  return { requiredModels, activeSlots };
}

function removeCodexMcp(configPath) {
  if (!fs.existsSync(configPath)) return false;
  const existing = fs.readFileSync(configPath, 'utf8');
  if (!existing.includes(MCP_BLOCK_BEGIN)) return false;
  const updated = replaceManagedMcpBlock(existing, '');
  if (updated === existing) return false;
  if (updated.trim()) {
    fs.writeFileSync(configPath, updated, 'utf8');
  } else {
    fs.unlinkSync(configPath);
  }
  return true;
}

module.exports = {
  MCP_BLOCK_BEGIN,
  MCP_BLOCK_END,
  adaptCodexMarkdown,
  configureCodexMcp,
  convertMarkdownToCodexAgent,
  convertMarkdownToCodexSkill,
  ensureCodexProviders,
  installCodexSkills,
  normalizeDetectedProvider,
  removeCodexMcp,
  removeCodexSkills,
  replaceManagedMcpBlock,
  splitFrontmatter,
};

import { execFileSync } from 'node:child_process';
import { TextDecoder, TextEncoder } from 'node:util';
import { DEFAULT_AGENT_SKILL_REGISTRY, classifyTask, diagnoseAgentSkillBindings, formatAgentRuntimeContext, resolveAgentProfile, resolveAgentSkillBindings, resolveAgentSkillNames } from '../../agents/AgentSkillRegistry.js';
import { buildCodebaseMap } from '../../agents/CodebaseMap.js';
import { buildCodeContextEvidence, normalizeCodeContextEvidence, summarizeCodeContextEvidence } from '../../agents/CodeContextEvidence.js';
import { inferCodeContextSignals } from '../../agents/CodeContextSignals.js';
import { normalizeSymbolGraph, summarizeSymbolGraph } from '../../agents/SymbolGraph.js';
import { agentPolicyStore as defaultAgentPolicyStore, effectiveAgentRegistry } from '../../agents/AgentPolicyStore.js';
import { skillStore as defaultSkillStore } from '../../skills/SkillStore.js';
import { requireOwnerToken } from '../auth/owner-token.js';

function installedSkillMap(skillStore) {
  const list = typeof skillStore?.list === 'function' ? skillStore.list() : [];
  return new Map(list.map((skill) => [skill.name, skill]));
}

const gitPathDecoder = new TextDecoder('utf8');
const gitPathEncoder = new TextEncoder();

function decodeGitQuotedPath(path = '') {
  let input = String(path || '').trim();
  if (!(input.startsWith('"') && input.endsWith('"'))) return input;
  input = input.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char !== '\\') {
      bytes.push(...gitPathEncoder.encode(char));
      continue;
    }

    const next = input[i + 1];
    if (!next) {
      bytes.push(92);
      continue;
    }
    if (/[0-7]/.test(next)) {
      let octal = next;
      let cursor = i + 2;
      while (cursor < input.length && octal.length < 3 && /[0-7]/.test(input[cursor])) {
        octal += input[cursor];
        cursor += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      i = cursor - 1;
      continue;
    }

    const escapeBytes = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      '\\': 92,
    };
    if (Object.hasOwn(escapeBytes, next)) {
      bytes.push(escapeBytes[next]);
    } else {
      bytes.push(...gitPathEncoder.encode(next));
    }
    i += 1;
  }
  return gitPathDecoder.decode(new Uint8Array(bytes));
}

function summarizeProfile(profile, installedByName) {
  const skillCoverage = (profile.skillBindings || []).map((name) => {
    const skill = installedByName.get(name);
    return {
      name,
      installed: !!skill,
      enabled: skill ? skill.enabled !== false : false,
      displayName: skill?.displayName || name,
    };
  });
  return {
    id: profile.id,
    roles: profile.roles || [],
    title: profile.title,
    mission: profile.mission,
    boundaries: profile.boundaries || [],
    skillBindings: profile.skillBindings || [],
    skillCoverage,
    governance: profile.governance || null,
    governanceOverridden: !!profile.governanceOverridden,
  };
}

function parseGitPorcelainStatus(output = '') {
  const files = [];
  const seen = new Set();
  for (const rawLine of String(output || '').split('\n')) {
    if (!rawLine.trim()) continue;
    const status = rawLine.slice(0, 2).trim() || '??';
    let path = rawLine.length > 3 ? rawLine.slice(3).trim() : rawLine.trim();
    if (!path) continue;
    if (path.includes(' -> ')) path = path.split(' -> ').pop().trim();
    path = decodeGitQuotedPath(path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push({ path, status });
    if (files.length >= 200) break;
  }
  return files;
}

export function readGitChangedFiles(cwd, { gitStatusProvider = null } = {}) {
  if (!cwd || typeof cwd !== 'string') return { ok: false, error: 'cwd required', files: [] };
  try {
    const output = typeof gitStatusProvider === 'function'
      ? gitStatusProvider(cwd)
      : execFileSync('git', ['-C', cwd, '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'], {
        encoding: 'utf8',
        maxBuffer: 512 * 1024,
        timeout: 3000,
      });
    const files = parseGitPorcelainStatus(output);
    const codeContextEvidence = buildCodeContextEvidence({ cwd, files });
    return {
      ok: true,
      cwd,
      count: files.length,
      files,
      codeContextEvidence,
      codeContextEvidenceSummary: summarizeCodeContextEvidence(codeContextEvidence),
      codeContextSignals: inferCodeContextSignals({ affectedFiles: files }),
    };
  } catch (e) {
    return {
      ok: false,
      cwd,
      error: e?.message || String(e),
      files: [],
      codeContextEvidence: [],
      codeContextEvidenceSummary: summarizeCodeContextEvidence([]),
      codeContextSignals: inferCodeContextSignals({ affectedFiles: [] }),
    };
  }
}

function resolveRouteCwd(req, { safeResolveFsPath = null } = {}) {
  const hasExplicitCwd = typeof req.query?.cwd === 'string' && req.query.cwd.trim();
  const rawCwd = hasExplicitCwd ? req.query.cwd.trim() : process.cwd();
  const cwd = hasExplicitCwd && safeResolveFsPath ? safeResolveFsPath(rawCwd) : rawCwd;
  return cwd || '';
}

export function buildAgentRegistrySnapshot({
  registry = DEFAULT_AGENT_SKILL_REGISTRY,
  skillStore = defaultSkillStore,
  policyStore = null,
} = {}) {
  const installedByName = installedSkillMap(skillStore);
  const profiles = (registry.profiles || []).map((profile) => summarizeProfile(profile, installedByName));
  const missingSkillNames = [...new Set(profiles
    .flatMap((profile) => profile.skillCoverage)
    .filter((skill) => !skill.installed)
    .map((skill) => skill.name))]
    .sort();
  return {
    ok: true,
    generatedAt: Date.now(),
    counts: {
      profiles: profiles.length,
      rules: (registry.rules || []).length,
      installedSkills: installedByName.size,
      missingBoundSkills: missingSkillNames.length,
    },
    profiles,
    rules: (registry.rules || []).map((rule) => ({
      tag: rule.tag,
      agentId: rule.agentId,
      keywords: rule.keywords || [],
      skillHints: rule.skillHints || [],
    })),
    roleFallback: registry.roleFallback || {},
    missingSkillNames,
    policyOverrides: typeof policyStore?.list === 'function' ? policyStore.list() : [],
  };
}

export function buildAgentClassification({
  text = '',
  codeContext = null,
  room = {},
  member = {},
  registry = DEFAULT_AGENT_SKILL_REGISTRY,
  skillStore = defaultSkillStore,
} = {}) {
  const safeText = String(text || '').slice(0, 32_000);
  const codeContextSignals = inferCodeContextSignals(codeContext || room?.codeContext || {
    affectedFiles: room?.affectedFiles || room?.changedFiles || [],
  });
  const codeContextEvidence = normalizeCodeContextEvidence(codeContext || room?.codeContext || room?.codeContextEvidence || []);
  const codeContextGraph = normalizeSymbolGraph(codeContext || room?.codeContext || room?.codeContextGraph || {});
  const dispatchMatches = classifyTask(safeText, registry, { codeContext: codeContextSignals });
  const profile = resolveAgentProfile(member, room, registry);
  const suggestedSkillBindings = resolveAgentSkillBindings({ profile, dispatchMatches, room });
  const installedSkillBindings = resolveAgentSkillBindings({ profile, dispatchMatches, room, skillStore });
  const suggestedSkillNames = resolveAgentSkillNames({ profile, dispatchMatches, room });
  const installedSkillNames = installedSkillBindings.map((binding) => binding.name);
  const skillDiagnostics = diagnoseAgentSkillBindings(installedSkillBindings);
  const installedSet = new Set(installedSkillNames);
  const missingSkillNames = suggestedSkillNames.filter((name) => !installedSet.has(name));
  return {
    ok: true,
    profile: profile ? {
      id: profile.id,
      title: profile.title,
      roles: profile.roles || [],
      mission: profile.mission,
      boundaries: profile.boundaries || [],
      governance: profile.governance || null,
      governanceOverridden: !!profile.governanceOverridden,
    } : null,
    codeContextSignals,
    codeContextEvidence,
    codeContextEvidenceSummary: summarizeCodeContextEvidence(codeContextEvidence),
    codeContextGraph,
    codeContextGraphSummary: summarizeSymbolGraph(codeContextGraph),
    matches: dispatchMatches,
    suggestedSkillBindings,
    installedSkillBindings,
    skillDiagnostics,
    suggestedSkillNames,
    installedSkillNames,
    missingSkillNames,
    governance: profile?.governance || null,
    promptPreview: formatAgentRuntimeContext({
      profile,
      dispatchMatches,
      skillNames: installedSkillNames,
      skillBindings: installedSkillBindings,
      skillDiagnostics,
      codeContextSignals,
      codeContextEvidence,
      codeContextGraph,
      member,
      governance: profile?.governance || null,
    }),
  };
}

export function registerAgentRegistryRoutes(app, {
  registry = DEFAULT_AGENT_SKILL_REGISTRY,
  skillStore = defaultSkillStore,
  policyStore = defaultAgentPolicyStore,
  safeResolveFsPath = null,
  gitStatusProvider = null,
} = {}) {
  function getEffectiveRegistry() {
    return effectiveAgentRegistry({ registry, policyStore });
  }

  app.get('/api/agent-registry', requireOwnerToken, (req, res) => {
    try {
      res.json(buildAgentRegistrySnapshot({
        registry: getEffectiveRegistry(),
        skillStore,
        policyStore,
      }));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.post('/api/agent-registry/classify', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) return res.status(400).json({ ok: false, error: 'text required' });
      if (text.length > 32_000) return res.status(413).json({ ok: false, error: 'text too long (max 32000 chars)' });
      res.json(buildAgentClassification({
        text,
        codeContext: body.codeContext || body.affectedFiles || body.files || null,
        room: body.room && typeof body.room === 'object' ? body.room : {},
        member: body.member && typeof body.member === 'object' ? body.member : {},
        registry: getEffectiveRegistry(),
        skillStore,
      }));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/agent-registry/changed-files', requireOwnerToken, (req, res) => {
    try {
      const cwd = resolveRouteCwd(req, { safeResolveFsPath });
      if (!cwd) return res.status(403).json({ ok: false, error: 'cwd 越权或敏感目录' });
      const result = readGitChangedFiles(cwd, { gitStatusProvider });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/agent-registry/codebase-map', requireOwnerToken, (req, res) => {
    try {
      const cwd = resolveRouteCwd(req, { safeResolveFsPath });
      if (!cwd) return res.status(403).json({ ok: false, error: 'cwd 越权或敏感目录' });
      const query = typeof req.query?.q === 'string' ? req.query.q : '';
      const limit = Math.max(4, Math.min(24, Number(req.query?.limit) || 16));
      const result = buildCodebaseMap(cwd, { query, limit });
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.put('/api/agent-registry/profiles/:id/governance', requireOwnerToken, (req, res) => {
    try {
      const profileId = String(req.params?.id || '').trim().toLowerCase();
      const baseRegistry = registry || DEFAULT_AGENT_SKILL_REGISTRY;
      if (!profileId || !baseRegistry.profileById?.has(profileId)) {
        return res.status(404).json({ ok: false, error: 'agent profile not found' });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const policyInput = body.governance && typeof body.governance === 'object' ? body.governance : body;
      const policy = policyStore.upsert(profileId, policyInput);
      const effectiveRegistry = getEffectiveRegistry();
      const installedByName = installedSkillMap(skillStore);
      const profile = effectiveRegistry.profileById.get(profileId);
      res.json({
        ok: true,
        policy,
        profile: profile ? summarizeProfile(profile, installedByName) : null,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.delete('/api/agent-registry/profiles/:id/governance', requireOwnerToken, (req, res) => {
    try {
      const profileId = String(req.params?.id || '').trim().toLowerCase();
      const baseRegistry = registry || DEFAULT_AGENT_SKILL_REGISTRY;
      if (!profileId || !baseRegistry.profileById?.has(profileId)) {
        return res.status(404).json({ ok: false, error: 'agent profile not found' });
      }
      const deleted = policyStore.delete(profileId);
      const effectiveRegistry = getEffectiveRegistry();
      const installedByName = installedSkillMap(skillStore);
      const profile = effectiveRegistry.profileById.get(profileId);
      res.json({
        ok: true,
        deleted,
        profile: profile ? summarizeProfile(profile, installedByName) : null,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message || String(e) });
    }
  });
}

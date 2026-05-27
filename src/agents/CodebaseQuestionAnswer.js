const MAX_ANSWER_RESULTS = 6;
const MAX_REASON_COUNT = 4;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function uniq(list = []) {
  return [...new Set((list || []).filter(Boolean))];
}

function shortReasonList(reasons = []) {
  return uniq(reasons).slice(0, MAX_REASON_COUNT);
}

function citationSnippet(result = {}) {
  const text = safeString(result.text, 260);
  if (text) return text;
  const evidence = result.citation?.evidence || [];
  const snippet = evidence.find(item => item.text);
  return safeString(snippet?.text, 260);
}

function citationEvidenceCounts(citation = {}) {
  const graphReferences = Array.isArray(citation.graph?.references) ? citation.graph.references : [];
  const routeTestChains = Array.isArray(citation.graph?.routeTestChains) ? citation.graph.routeTestChains : [];
  const unresolvedReferences = Array.isArray(citation.graph?.unresolvedReferences) ? citation.graph.unresolvedReferences : [];
  return {
    evidence: Array.isArray(citation.evidence) ? citation.evidence.length : 0,
    graphReferences: graphReferences.length,
    typeImplementations: graphReferences.filter((item) => item.kind === 'type-implementation').length,
    routeUsages: Array.isArray(citation.graph?.routeUsages) ? citation.graph.routeUsages.length : 0,
    routeTestChains: routeTestChains.length,
    unresolvedReferences: unresolvedReferences.length,
    citationPaths: Array.isArray(citation.paths) ? citation.paths.length : 0,
  };
}

function buildCitation(result = {}, index = 0) {
  const line = Math.max(1, Number(result.line) || 1);
  const counts = citationEvidenceCounts(result.citation || {});
  return {
    id: `C${index + 1}`,
    path: safeString(result.path, 300),
    line,
    label: `${safeString(result.path, 300)}:${line}`,
    kind: safeString(result.kind || result.citation?.kind || 'file', 100),
    anchor: safeString(result.anchor || result.citation?.anchor || '', 180),
    parser: safeString(result.parser || result.citation?.parser || 'unknown', 80),
    score: Number(result.score || 0),
    semanticScore: Number.isFinite(Number(result.semanticScore)) ? Number(result.semanticScore) : null,
    reasons: shortReasonList(result.reason || result.citation?.reason || []),
    snippet: citationSnippet(result),
    evidenceCount: counts.evidence,
    graphReferenceCount: counts.graphReferences,
    typeImplementationCount: counts.typeImplementations,
    routeUsageCount: counts.routeUsages,
    routeToTestChainCount: counts.routeTestChains,
    unresolvedReferenceCount: counts.unresolvedReferences,
    citationPathCount: counts.citationPaths,
  };
}

function confidenceFor(results = [], citations = []) {
  if (!results.length) return 'none';
  const top = Number(results[0]?.score || 0);
  const evidence = citations.reduce((sum, item) => (
    sum + item.evidenceCount + item.graphReferenceCount + item.routeUsageCount + item.routeToTestChainCount
  ), 0);
  if (top >= 130 && evidence >= 2) return 'high';
  if (top >= 80 || evidence >= 1) return 'medium';
  return 'low';
}

function answerLine(citation = {}) {
  const anchor = citation.anchor ? ` ${citation.anchor}` : '';
  const reasons = citation.reasons.length ? `; signals: ${citation.reasons.join(', ')}` : '';
  const chains = citation.routeToTestChainCount ? `; route-test chains: ${citation.routeToTestChainCount}` : '';
  return `[${citation.id}] ${citation.label} (${citation.kind}${anchor})${reasons}${chains}`;
}

function limitationsFor({ confidence, coverage } = {}) {
  const limitations = [
    'Deterministic local evidence only',
    'No model inference',
    'LSP/Tree-sitter dynamic references are not complete yet',
  ];
  const supportCount = (coverage?.evidenceItemCount || 0) +
    (coverage?.graphReferenceCount || 0) +
    (coverage?.routeUsageCount || 0) +
    (coverage?.routeToTestChainCount || 0);
  if (confidence === 'low' || supportCount === 0) {
    limitations.push('Evidence is insufficient for a complete implementation summary; use citations as leads only');
  }
  if ((coverage?.unresolvedReferenceCount || 0) > 0) {
    limitations.push(`${coverage.unresolvedReferenceCount} indexed references were unresolved in the local graph`);
  }
  if ((coverage?.routeUsageCount || 0) > 0 && (coverage?.routeToTestChainCount || 0) === 0) {
    limitations.push('Route usage was found, but no route-to-test chain was proven');
  }
  return limitations;
}

export function buildCodebaseQuestionAnswer(queryResult = {}) {
  const question = safeString(queryResult.query || queryResult.question, 500);
  const results = Array.isArray(queryResult.results) ? queryResult.results.slice(0, MAX_ANSWER_RESULTS) : [];
  const citations = results.map(buildCitation);
  const uniqueFiles = uniq(citations.map(item => item.path));
  const confidence = confidenceFor(results, citations);
  const graphSummary = queryResult.symbolGraphSummary || queryResult.status?.symbolGraphSummary || {};
  const routeToTestChainCount = citations.reduce((sum, item) => sum + item.routeToTestChainCount, 0);
  const unresolvedReferenceCount = citations.reduce((sum, item) => sum + item.unresolvedReferenceCount, 0);
  // P0-A 证据 summary：按 reference kind 聚合（callback-registration / object-property-flow / type-implementation 等），
  // 让前端能标注命中的结构级证据类别，而不仅是总数。
  const referenceKindCounts = {};
  for (const result of results) {
    for (const ref of result.citation?.graph?.references || []) {
      const k = safeString(ref.kind, 80);
      if (k) referenceKindCounts[k] = (referenceKindCounts[k] || 0) + 1;
    }
  }
  const coverage = {
    resultCount: Number(queryResult.resultCount || queryResult.results?.length || 0),
    citedResultCount: citations.length,
    uniqueFileCount: uniqueFiles.length,
    evidenceItemCount: citations.reduce((sum, item) => sum + item.evidenceCount, 0),
    graphReferenceCount: citations.reduce((sum, item) => sum + item.graphReferenceCount, 0),
    typeImplementationCount: citations.reduce((sum, item) => sum + item.typeImplementationCount, 0),
    routeUsageCount: citations.reduce((sum, item) => sum + item.routeUsageCount, 0),
    routeToTestChainCount: Math.max(routeToTestChainCount, Number(graphSummary.routeToTestChainCount) || 0),
    unresolvedReferenceCount: Math.max(unresolvedReferenceCount, Number(graphSummary.unresolvedReferenceCount) || 0),
    citationPathCount: citations.reduce((sum, item) => sum + item.citationPathCount, 0),
    referenceKindCounts,
  };
  // 结构级证据（引用/路由/类型/route-test）——纯文本或符号名命中不算，用于标记弱证据
  const structuralEvidenceCount =
    coverage.graphReferenceCount + coverage.routeUsageCount + coverage.typeImplementationCount + coverage.routeToTestChainCount;
  const weakEvidence = confidence === 'low' || structuralEvidenceCount === 0;
  const limitations = limitationsFor({ confidence, coverage });
  if (citations.length && structuralEvidenceCount === 0) {
    limitations.push('No structural (reference/route/type) evidence — answer rests on name/text matches; verify citations before relying on it');
  }

  if (!citations.length) {
    return {
      ok: true,
      mode: 'local-codebase-question',
      generatedBy: 'CodebaseIndexStore',
      question,
      confidence,
      weakEvidence: true,
      answer: 'No indexed code evidence matched this question. Rebuild the local Codebase Index or narrow the question to a symbol, route, file, or UI element.',
      answerLines: [],
      citations: [],
      coverage,
      nextActions: ['Rebuild Codebase Index', 'Try a symbol, route, file path, or UI element name'],
      limitations,
    };
  }

  const answerLines = citations.map(answerLine);
  const top = citations[0];
  const support = citations.slice(1, 4).map(item => item.label);
  const supportText = support.length ? ` Supporting evidence: ${support.join(', ')}.` : '';
  return {
    ok: true,
    mode: 'local-codebase-question',
    generatedBy: 'CodebaseIndexStore',
    question,
    confidence,
    weakEvidence,
    answer: `Most relevant local evidence points to ${top.label}${top.anchor ? ` (${top.anchor})` : ''}.${supportText} Use the citations below as the source of truth; this answer is a deterministic summary of indexed code evidence.${weakEvidence ? ' Evidence is weak (no structural or low-confidence matches); treat the citations as leads only, not a complete implementation map.' : ''}`,
    answerLines,
    citations,
    coverage,
    nextActions: ['Add cited files to Dispatch Preview', 'Open the top path in the editor', 'Rebuild if the code changed after the last index'],
    limitations,
  };
}

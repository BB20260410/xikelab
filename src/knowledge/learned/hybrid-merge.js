// hybrid-merge — BM25 + vector 两路结果 RRF 融合（W10 R2R 学习）
// 独立 helper，未接入 KnowledgeStore——等 sprint 级独立集成

/**
 * Reciprocal Rank Fusion (RRF)
 * 经典融合算法：对每个文档，score = Σ(1 / (k + rank_i))
 * k 通常取 60（让靠前结果差距明显），rank 从 1 开始
 *
 * @param {Array<Array<{id, score}>>} rankedLists  多个排好序的结果列表
 * @param {number} [k=60]
 * @returns {Array<{id, rrfScore, sources}>}
 */
export function rrf(rankedLists, k = 60) {
  if (!Array.isArray(rankedLists) || rankedLists.length === 0) return [];

  const scores = new Map();    // id → { rrfScore, sources }

  rankedLists.forEach((list, listIdx) => {
    if (!Array.isArray(list)) return;
    list.forEach((doc, rankIdx) => {
      const rank = rankIdx + 1;
      const contribution = 1 / (k + rank);
      if (!scores.has(doc.id)) {
        scores.set(doc.id, { id: doc.id, rrfScore: 0, sources: [] });
      }
      const entry = scores.get(doc.id);
      entry.rrfScore += contribution;
      entry.sources.push({ listIdx, rank, originalScore: doc.score });
    });
  });

  return [...scores.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * 便利函数：直接传 BM25 结果和 vector 结果，输出融合
 */
export function mergeHybrid(bm25Results, vectorResults, opts = {}) {
  const { k = 60, topN = 10 } = opts;
  const merged = rrf([bm25Results, vectorResults], k);
  return merged.slice(0, topN);
}

/**
 * 用法（未来接入示例）：
 *   const bm25Hits = await bm25Search(query, { topN: 20 });
 *   const vecHits = await vectorSearch(query, { topN: 20 });
 *   const fused = mergeHybrid(bm25Hits, vecHits, { topN: 10 });
 *   // fused[0..9] 含 rrfScore + sources 数组（显示"BM25 #2 + vector #5"）
 */

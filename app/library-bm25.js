/*
 * library-bm25.js — 资料库召回的 BM25 打分核
 *
 * 算法移植自 imkelt/DSH-RAG 的 rankBm25（MIT，Copyright (c) 2026 kai232，
 * 完整许可见 app/licenses/DSH-RAG-MIT.txt，经 DSH-SEP 的 vendored 副本引入）。
 * 原实现每次查询对全库重新分词（O(词数×文档数×长度)），对几十万字的备赛包太慢；
 * 这里只移植打分数学：分词与扫描由 server.js 的 bigram 管线完成，
 * 本模块接收每篇文档的「查询词频表」，输出 BM25 分数。
 *
 * 相对旧版原始词频打分的三个升级：
 *   1. IDF —— 「问题/观点」这类常见词自动降权，稀有词（如「赋魅」）自动升权；
 *   2. TF 边际递减（k1）—— 词出现 60 次 ≠ 相关性是出现 2 次的 30 倍；
 *   3. 长度归一（b）—— 长文档不再靠「出现次数多」白赚分。
 *
 * df 必须按「全库」统计而不是候选池：候选池是 FTS 预筛后的「至少命中一词」集合，
 * 在池内算 df 会让每个查询词的 df≈N、IDF 塌成 0（单字词召回直接归零）。
 */
'use strict';

const K1 = 1.2;
const B = 0.75;

/*
 * docs:   [{ tf: Map(term -> 词频), len: 文档长度（字符） }]
 * weights: Map(term -> 查询权重)（原词 1.0，同义扩展 0.6）
 * stats:   { total: 全库文档数, df: Map(term -> 全库文档频次) }；缺省退回池内统计
 * 返回：与 docs 等长的分数数组
 */
function bm25Scores(docs, weights, stats) {
  const n = docs.length;
  if (!n) return [];
  let total = stats && Number.isFinite(stats.total) && stats.total > 0 ? stats.total : n;
  let df = stats && stats.df;
  if (!df) {
    df = new Map();
    for (const [term] of weights) {
      let c = 0;
      for (const d of docs) if ((d.tf.get(term) || 0) > 0) c++;
      if (c) df.set(term, c);
    }
    total = n;
  }
  let sumLen = 0;
  for (const d of docs) sumLen += d.len;
  const avgLen = Math.max(1, sumLen / n);
  return docs.map((d) => {
    let score = 0;
    for (const [term, w] of weights) {
      const tf = d.tf.get(term) || 0;
      if (!tf) continue;
      const dcf = df.get(term) || 0;
      const idf = Math.log(1 + (total - dcf + 0.5) / (dcf + 0.5));
      const norm = 1 - B + B * (d.len / avgLen);
      score += w * idf * (tf * (K1 + 1)) / (tf + K1 * norm);
    }
    return score;
  });
}

module.exports = { bm25Scores, K1, B };

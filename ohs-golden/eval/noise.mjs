// Mức nhiễu của mốc eval: so nhiều lượt chạy OHS (cùng máy hai lần, hay linux với darwin).
//
//   node tools/ohs-golden/eval/noise.mjs --out <noise.json> <thư mục lượt 1> <thư mục lượt 2> [...]
//
// Mỗi thư mục lượt là đầu ra của `run-all.mjs` (`<nhãn>/<corpus>/per-query.jsonl`). Với từng corpus ghi:
// - `ndcg_5`: nDCG@5 tổng và từng hạng mục của mỗi lượt, chênh lớn nhất giữa hai lượt bất kỳ;
// - `top5_changed`: số câu mà tập top 5 khác nhau giữa các lượt (kèm id), `order_changed`: số câu thứ tự top 10 khác;
// - `score_delta_max`: chênh điểm `hybrid` lớn nhất của cùng một note trong top 10 giữa hai lượt;
// - `boundary`: khoảng cách điểm giữa hạng 5 và hạng 6 (nhỏ nhất, trung vị), và số câu có khoảng cách nhỏ hơn
//   `score_delta_max` (biên top 5 có thể lật vì nhiễu).

import fs from 'node:fs';
import path from 'node:path';
import { args, writeJson } from '../lib/common.mjs';

const a = args();
const runs = a._.map((d) => path.resolve(d));
if (runs.length < 2 || !a.out) throw new Error('cần --out và ít nhất hai thư mục lượt');
const read = (dir, corpus) =>
  fs
    .readFileSync(path.join(dir, corpus, 'per-query.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const corpora = fs.readdirSync(runs[0]).filter((c) => fs.existsSync(path.join(runs[0], c, 'per-query.jsonl')));
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

const result = { runs: runs.map((r) => path.basename(r)), corpora: {} };
for (const corpus of corpora.sort()) {
  const rows = runs.map((r) => read(r, corpus));
  const ids = rows[0].map((q) => q.id);
  const cats = [...new Set(rows[0].map((q) => q.category))].sort();
  const ndcg = (rs, cat) => mean(rs.filter((q) => !cat || q.category === cat).map((q) => q.ndcg_5));
  const spread = (vals) => Math.max(...vals) - Math.min(...vals);
  const byCat = Object.fromEntries(
    cats.map((c) => {
      const vals = rows.map((rs) => ndcg(rs, c));
      return [c, { values: vals, max_delta: spread(vals) }];
    }),
  );
  let scoreDelta = 0;
  const top5Changed = [];
  const orderChanged = [];
  const gaps = [];
  ids.forEach((id, i) => {
    const qs = rows.map((rs) => rs[i]);
    if (qs.some((q) => q.id !== id)) throw new Error(`${corpus}: thứ tự câu khác nhau giữa các lượt`);
    const top5 = qs.map((q) => q.top.slice(0, 5).map((t) => t.path).sort().join('\n'));
    if (new Set(top5).size > 1) top5Changed.push(id);
    const order = qs.map((q) => q.top.map((t) => t.path).join('\n'));
    if (new Set(order).size > 1) orderChanged.push(id);
    const scores = qs.map((q) => new Map(q.top.map((t) => [t.path, t.score])));
    for (const [p, s0] of scores[0]) {
      for (const m of scores.slice(1)) if (m.has(p)) scoreDelta = Math.max(scoreDelta, Math.abs(m.get(p) - s0));
    }
    for (const q of qs) if (q.top.length >= 6) gaps.push({ id, gap: q.top[4].score - q.top[5].score });
  });
  const fragile = [...new Set(gaps.filter((g) => g.gap <= scoreDelta).map((g) => g.id))];
  result.corpora[corpus] = {
    queries: ids.length,
    ndcg_5: {
      all: { values: rows.map((rs) => ndcg(rs)), max_delta: spread(rows.map((rs) => ndcg(rs))) },
      by_category: byCat,
    },
    top5_changed: { count: top5Changed.length, ids: top5Changed },
    order_changed: { count: orderChanged.length, ids: orderChanged },
    score_delta_max: scoreDelta,
    boundary: {
      gap_min: gaps.length ? Math.min(...gaps.map((g) => g.gap)) : null,
      gap_median: median(gaps.map((g) => g.gap)),
      fragile: { count: fragile.length, ids: fragile },
    },
  };
}
writeJson(path.resolve(a.out), result);
for (const [c, r] of Object.entries(result.corpora)) {
  console.error(
    `${c}: nDCG@5 chênh ${r.ndcg_5.all.max_delta.toExponential(2)}, top5 đổi ${r.top5_changed.count}, ` +
      `thứ tự đổi ${r.order_changed.count}, điểm chênh tối đa ${r.score_delta_max.toExponential(2)}, ` +
      `biên mong manh ${r.boundary.fragile.count}`,
  );
}

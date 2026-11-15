// Mốc eval của OHS: hạng và điểm từng nhánh của từng câu, nDCG@5 từng hạng mục.
//
//   <bundle>/node/bin/node tools/ohs-golden/eval/run.mjs --bundle <bundle> --corpus <tên> --vault <vault> \
//       --golden <golden-set.json> --pack vi|de|none [--pack-dir <thư mục gói de đã dựng>] \
//       [--index parallel|ordered] [--mode hybrid|fulltext] --out <thư mục>
//
// Câu chạy như `eval/evaluate.ts` của OHS (`search(query, {mode: 'hybrid', limit: 10})`), thêm `explain` để có hạng
// từng nhánh; một lượt nữa với `limit: 50` để biết hạng của note đúng khi nó rơi khỏi top 10. Chỉ số theo
// `eval/metrics.ts` của OHS (đường dẫn so ở dạng NFD như OHS lưu).
//
// `--mode fulltext` chạy cả hai lượt ở chế độ `fulltext` của OHS (BM25 và view, không vector) và ghi vào thư mục con
// `fulltext/` của `--out`; cổng G4 "top 10 trùng" so với mốc này. Index dựng như nhau ở hai chế độ.
//
// `--index parallel` (mặc định) index như OHS chạy thật (song song, thứ tự note vào DB đổi giữa các lần): dùng để đo
// mức nhiễu. `ordered` nạp note tuần tự theo đường dẫn trước (như golden ngôn ngữ).
//
// Ghi `<out>/<corpus>/per-query.jsonl` và `summary.json` (`--mode fulltext`: `<out>/fulltext/<corpus>/`, summary có
// thêm `mode`).

import fs from 'node:fs';
import path from 'node:path';
import { args, buildIndex, openBundle, scratchVault, setOhsEnv, writeJson, writeJsonl } from '../lib/common.mjs';

const K = 10;
const DEEP = 50;
const a = args();
const bundle = openBundle(a.bundle);
for (const k of ['corpus', 'vault', 'golden', 'out', 'pack']) if (!a[k]) throw new Error(`thiếu --${k}`);
const packDir = { vi: bundle.langVi, de: a['pack-dir'] && path.resolve(a['pack-dir']), none: undefined }[a.pack];
if (a.pack !== 'none' && !packDir) throw new Error(`gói ${a.pack}: thiếu --pack-dir`);
const mode = a.mode ?? 'hybrid';
if (!['hybrid', 'fulltext'].includes(mode)) throw new Error(`--mode ${mode}: chỉ hybrid hay fulltext`);
const golden = JSON.parse(fs.readFileSync(a.golden, 'utf8'));
const outDir = mode === 'hybrid' ? path.resolve(a.out, a.corpus) : path.resolve(a.out, mode, a.corpus);

const scratch = scratchVault(path.resolve(a.vault));
setOhsEnv({ vault: scratch.vault, db: scratch.db, langPack: packDir });

let index;
if (a.index === 'ordered') index = await buildIndex(bundle, scratch.vault);
else {
  const { createIndexService, openIndexDatabase } = await import(bundle.url('src/indexing/index-service.js'));
  const db = await import(bundle.url('src/storage/db.js'));
  const service = createIndexService();
  await openIndexDatabase();
  db.applyDbConfigDefaults();
  const result = await service.reindex({ force: true });
  if (result.errors?.length) throw new Error(`OHS index lỗi: ${JSON.stringify(result.errors).slice(0, 2000)}`);
  index = { db, close: async () => (await service.close?.(), db.closeDb()) };
}

const { search } = await import(bundle.url('src/search/searcher.js'));
const { languagePackStatus } = await import(bundle.url('src/language/loader.js'));
const pack = languagePackStatus();
if (a.pack !== 'none' && !pack?.loaded) throw new Error(`gói ${a.pack} không nạp được: ${JSON.stringify(pack)}`);

const nfd = (p) => p.normalize('NFD');
const dcg = (rels) => rels.reduce((s, r, i) => s + r / Math.log2(i + 2), 0);
function metrics(paths, relevant, partial) {
  const rel = new Set(relevant.map(nfd));
  const part = new Set(partial.map(nfd));
  const top = paths.slice(0, K).map(nfd);
  const ndcgAt = (k) => {
    const ideal = dcg([...relevant.map(() => 1), ...partial.map(() => 0.5)].slice(0, k));
    return ideal ? dcg(top.slice(0, k).map((p) => (rel.has(p) ? 1 : part.has(p) ? 0.5 : 0))) / ideal : 0;
  };
  const first = top.findIndex((p) => rel.has(p));
  const hit = (k) => top.slice(0, k).some((p) => rel.has(p));
  return {
    ndcg_5: ndcgAt(5),
    ndcg_10: ndcgAt(10),
    mrr: first < 0 ? 0 : 1 / (first + 1),
    hit_1: hit(1),
    hit_3: hit(3),
    hit_5: hit(5),
    recall_k: relevant.length ? top.filter((p) => rel.has(p)).length / relevant.length : 0,
  };
}

const rows = [];
try {
  for (const q of golden) {
    const hits = await search(q.query, { mode, limit: K, explain: true, scope: q.scope });
    const deep = await search(q.query, { mode, limit: DEEP, scope: q.scope });
    const deepPaths = deep.map((h) => nfd(h.path));
    rows.push({
      id: q.id,
      category: q.category,
      query: q.query,
      relevant: q.relevant_paths.map((p) => p.normalize('NFC')),
      partial: q.partial_paths.map((p) => p.normalize('NFC')),
      // Hạng (1-based) của từng note đúng trong top 50; null nếu không có.
      relevant_rank: q.relevant_paths.map((p) => {
        const i = deepPaths.indexOf(nfd(p));
        return i < 0 ? null : i + 1;
      }),
      top: hits.map((h) => ({
        path: h.path.normalize('NFC'),
        score: h.score,
        scores: h.scores ?? null,
        ranks: h.explain?.ranks ?? null,
        matched_by: h.matchedBy ?? null,
      })),
      ...metrics(
        hits.map((h) => h.path),
        q.relevant_paths,
        q.partial_paths,
      ),
    });
  }
} finally {
  await index.close();
  fs.rmSync(scratch.work, { recursive: true, force: true });
}

const KEYS = ['ndcg_5', 'ndcg_10', 'mrr', 'hit_1', 'hit_3', 'hit_5', 'recall_k'];
const aggregate = (rs) =>
  Object.fromEntries([
    ['queries', rs.length],
    ...KEYS.map((k) => [k, rs.reduce((s, r) => s + Number(r[k]), 0) / (rs.length || 1)]),
  ]);
const categories = [...new Set(rows.map((r) => r.category))];
writeJsonl(path.join(outDir, 'per-query.jsonl'), rows);
writeJson(path.join(outDir, 'summary.json'), {
  corpus: a.corpus,
  pack: pack ? { id: pack.id ?? a.pack, version: pack.version ?? null } : null,
  index: a.index === 'ordered' ? 'ordered' : 'parallel',
  ...(mode === 'hybrid' ? {} : { mode }),
  k: K,
  all: aggregate(rows),
  by_category: Object.fromEntries(categories.map((c) => [c, aggregate(rows.filter((r) => r.category === c))])),
});
const label = mode === 'hybrid' ? a.corpus : `${a.corpus} (${mode})`;
console.error(`${label}: nDCG@5 ${aggregate(rows).ndcg_5.toFixed(3)} trên ${rows.length} câu -> ${outDir}`);

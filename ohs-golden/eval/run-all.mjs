// Một lượt eval OHS trên bốn corpus, ghi vào `<out>/<nhãn>/<corpus>/`:
//
//   node tools/ohs-golden/eval/run-all.mjs --bundle <bundle> --ohs-repo <checkout OHS ở 2949022> \
//       --otf <checkout obsidian-test-fixture ở v0.12.0> --out <thư mục> --label <nhãn> [--index parallel|ordered] \
//       [--mode hybrid|fulltext]
//
// `--mode fulltext` ghi vào `<out>/<nhãn>/fulltext/<corpus>/` và `<out>/<nhãn>/fulltext/run.json` (có `mode`), không
// đụng kết quả hybrid cùng nhãn.
//
// Corpus: `vi-search` (fixture v0.12.0, 315 câu, gói vi), `smoke` (smoke-vault, 16 câu, gói vi), `obsidian-help`
// (tài liệu tiếng Anh của Obsidian ở revision OHS ghim, 58 câu, gói vi như pkm luôn bật), `de` (vault eval của
// `ohs-lang-de`, 39 câu, gói de dựng bằng `build-de.mjs`). Cần mạng để lấy obsidian-help (git fetch một revision).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OHS_COMMIT, args, writeJson } from '../lib/common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const a = args();
for (const k of ['bundle', 'ohs-repo', 'otf', 'out', 'label']) if (!a[k]) throw new Error(`thiếu --${k}`);
const bundle = path.resolve(a.bundle);
const ohs = path.resolve(a['ohs-repo']);
const otf = path.resolve(a.otf);
const out = path.resolve(a.out, a.label);
const index = a.index === 'ordered' ? 'ordered' : 'parallel';
const mode = a.mode ?? 'hybrid';
if (!['hybrid', 'fulltext'].includes(mode)) throw new Error(`--mode ${mode}: chỉ hybrid hay fulltext`);
const modeOut = mode === 'hybrid' ? out : path.join(out, mode);
const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8' }).trim();
if (!git('-C', ohs, 'rev-parse', 'HEAD').startsWith(OHS_COMMIT)) throw new Error(`--ohs-repo phải ở ${OHS_COMMIT}`);
if (git('-C', otf, 'rev-parse', 'HEAD') !== git('-C', otf, 'rev-parse', 'v0.12.0^{commit}'))
  throw new Error('--otf phải ở v0.12.0');

const node =
  process.platform === 'win32' ? path.join(bundle, 'node', 'node.exe') : path.join(bundle, 'node', 'bin', 'node');
const run = (argv) => {
  const r = spawnSync(node, argv, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error(`lỗi: ${argv.join(' ')}`);
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-eval-'));
try {
  // vi-search
  const viCorpus = path.join(work, 'vi-search');
  run([path.join(otf, 'bin', 'otf.mjs'), 'generate', '--preset', 'vi-search', '--out', viCorpus, '--answers-out',
    path.join(work, 'answers.json')]);
  // obsidian-help ở revision ghim, kiểm sha1 từng file như corpus của OHS
  const corpus = JSON.parse(fs.readFileSync(path.join(ohs, 'eval', 'obsidian-help-corpus.json'), 'utf8'));
  const src = path.join(work, 'obsidian-help-src');
  git('init', '-q', src);
  git('-C', src, 'fetch', '-q', '--depth', '1', corpus.repository, corpus.revision);
  git('-C', src, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'checkout', '-q', '--detach', 'FETCH_HEAD');
  const ohVault = path.join(work, 'obsidian-help');
  fs.cpSync(path.join(src, 'en'), ohVault, { recursive: true });
  for (const [rel, sha] of Object.entries(corpus.files)) {
    const bytes = fs.readFileSync(path.join(ohVault, rel));
    const got = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (got !== sha) throw new Error(`obsidian-help ${rel}: sha1 ${got}, cần ${sha}`);
  }
  // gói de
  const dePack = path.join(work, 'de-pack');
  run([path.join(here, 'build-de.mjs'), '--ohs-repo', ohs, '--out', dePack]);

  const vi = path.join(ohs, 'vantt', 'eval', 'vi');
  const de = path.join(ohs, 'vantt', 'packages', 'ohs-lang-de', 'eval');
  const jobs = [
    ['vi-search', viCorpus, path.join(vi, 'golden-set.json'), 'vi'],
    ['smoke', path.join(vi, 'smoke-vault'), path.join(vi, 'smoke-golden-set.json'), 'vi'],
    ['obsidian-help', ohVault, path.join(ohs, 'fixtures', 'obsidian-help', 'golden-set.json'), 'vi'],
    ['de', path.join(de, 'vault'), path.join(de, 'golden-set.json'), 'de'],
  ];
  // Lượt hybrid không xoá thư mục `fulltext/` cùng nhãn.
  if (fs.existsSync(modeOut))
    for (const e of fs.readdirSync(modeOut))
      if (mode !== 'hybrid' || e !== 'fulltext') fs.rmSync(path.join(modeOut, e), { recursive: true, force: true });
  for (const [name, vault, golden, pack] of jobs) {
    run([path.join(here, 'run.mjs'), '--bundle', bundle, '--corpus', name, '--vault', vault, '--golden', golden,
      '--pack', pack, ...(pack === 'de' ? ['--pack-dir', dePack] : []), '--index', index, '--mode', mode, '--out', out]);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'MANIFEST.json'), 'utf8'));
  writeJson(path.join(modeOut, 'run.json'), {
    label: a.label,
    index,
    ...(mode === 'hybrid' ? {} : { mode }),
    ohs: manifest.version,
    platform: manifest.platform,
    node: manifest.node_version,
    cpu: os.cpus()[0]?.model ?? null,
    cores: os.cpus().length,
    obsidian_help_revision: corpus.revision,
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

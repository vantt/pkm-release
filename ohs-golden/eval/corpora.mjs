#!/usr/bin/env node
// Dựng bốn corpus của eval tìm kiếm (cùng dữ liệu `run-all.mjs` đưa cho OHS) để chạy bản Rust trên đó, không chạy OHS.
// Ghi `<out>/corpora.json`: `{corpus: {vault, pack}}`. Kiểm như `run-all.mjs`: commit OHS ghim, fixture ở v0.12.0,
// sha1 từng file của obsidian-help.
//
// Dùng: node corpora.mjs --ohs-repo <checkout obsidian-hybrid-search ở OHS_COMMIT> \
//       --otf <checkout obsidian-test-fixture ở v0.12.0> --out <thư mục>

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { OHS_COMMIT, args, writeJson } from '../lib/common.mjs';

const a = args();
for (const k of ['ohs-repo', 'otf', 'out']) if (!a[k]) throw new Error(`thiếu --${k}`);
const ohs = path.resolve(a['ohs-repo']);
const otf = path.resolve(a.otf);
const out = path.resolve(a.out);
const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8' }).trim();
if (!git('-C', ohs, 'rev-parse', 'HEAD').startsWith(OHS_COMMIT)) throw new Error(`--ohs-repo phải ở ${OHS_COMMIT}`);
if (git('-C', otf, 'rev-parse', 'HEAD') !== git('-C', otf, 'rev-parse', 'v0.12.0^{commit}'))
  throw new Error('--otf phải ở v0.12.0');
const run = (argv) => {
  const r = spawnSync(process.execPath, argv, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error(`lỗi: ${argv.join(' ')}`);
};

fs.mkdirSync(out, { recursive: true });
const viCorpus = path.join(out, 'vi-search');
run([path.join(otf, 'bin', 'otf.mjs'), 'generate', '--preset', 'vi-search', '--out', viCorpus, '--answers-out',
  path.join(out, 'answers.json')]);
const corpus = JSON.parse(fs.readFileSync(path.join(ohs, 'eval', 'obsidian-help-corpus.json'), 'utf8'));
const src = path.join(out, 'obsidian-help-src');
git('init', '-q', src);
git('-C', src, 'fetch', '-q', '--depth', '1', corpus.repository, corpus.revision);
git('-C', src, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'checkout', '-q', '--detach', 'FETCH_HEAD');
const ohVault = path.join(out, 'obsidian-help');
fs.cpSync(path.join(src, 'en'), ohVault, { recursive: true });
for (const [rel, sha] of Object.entries(corpus.files)) {
  const bytes = fs.readFileSync(path.join(ohVault, rel));
  const got = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (got !== sha) throw new Error(`obsidian-help ${rel}: sha1 ${got}, cần ${sha}`);
}
const vi = path.join(ohs, 'vantt', 'eval', 'vi');
const de = path.join(ohs, 'vantt', 'packages', 'ohs-lang-de', 'eval');
writeJson(path.join(out, 'corpora.json'), {
  'vi-search': { vault: viCorpus, pack: 'vi' },
  smoke: { vault: path.join(vi, 'smoke-vault'), pack: 'vi' },
  'obsidian-help': { vault: ohVault, pack: 'vi' },
  de: { vault: path.join(de, 'vault'), pack: 'de' },
});
console.log(`corpus: ${out}/corpora.json`);

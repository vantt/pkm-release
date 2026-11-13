// Dựng gói `ohs-lang-de` 0.1.0 từ mã nguồn TypeScript của checkout OHS, không cần npm: bỏ kiểu bằng
// `module.stripTypeScriptTypes` của Node (đầu ra giữ nguyên dòng), ghi vào `<out>` với `package.json` trỏ `index.js`.
//
//   <bundle>/node/bin/node tools/ohs-golden/eval/build-de.mjs --ohs-repo <checkout OHS> --out <thư mục>

import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { args } from '../lib/common.mjs';

const a = args();
if (!a['ohs-repo'] || !a.out) throw new Error('thiếu --ohs-repo hoặc --out');
const src = path.join(path.resolve(a['ohs-repo']), 'vantt', 'packages', 'ohs-lang-de');
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
if (pkg.version !== '0.1.0') throw new Error(`ohs-lang-de ${pkg.version}, cần 0.1.0`);
const out = path.resolve(a.out);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(path.join(src, 'src'))) {
  if (!f.endsWith('.ts')) continue;
  const code = stripTypeScriptTypes(fs.readFileSync(path.join(src, 'src', f), 'utf8'), { mode: 'strip' });
  fs.writeFileSync(path.join(out, f.replace(/\.ts$/, '.js')), code);
}
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify({ name: 'ohs-lang-de', version: pkg.version, type: 'module', main: 'index.js' }, null, 2) + '\n',
);
const mod = await import(new URL(`file://${path.join(out, 'index.js')}`).href);
const pack = (mod.default ?? mod.createPack)();
console.error(`ohs-lang-de ${pack.version}: ${pack.views.length} view -> ${out}`);

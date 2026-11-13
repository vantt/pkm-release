// Phần chung của các script ghi mốc so từ OHS: tìm bundle, dựng vault tạm, đặt môi trường, ghi JSONL ổn định.
//
// Mốc so lấy từ bundle phát hành của fork (`ohs-0.17.2-vantt.8-<nền tảng>`): Node, `app/dist` (mã OHS đã dựng từ
// `vantt/obsidian-hybrid-search@2949022`) và `lang/ohs-lang-vi`. Script chỉ import module của bundle, không chạy CLI
// hay script npm nào của OHS.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const OHS_VERSION = '0.17.2-vantt.8';
export const OHS_COMMIT = '2949022';

/** Đối số dạng `--tên giá-trị` và cờ `--tên`. */
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

/** Bundle OHS đã giải nén; kiểm đúng phiên bản ghim và đang chạy bằng Node của chính bundle (module native). */
export function openBundle(dir) {
  if (!dir) throw new Error('thiếu --bundle <thư mục bundle OHS đã giải nén>');
  const root = path.resolve(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8'));
  if (manifest.version !== OHS_VERSION)
    throw new Error(`bundle là ${manifest.version}, mốc so ghim ${OHS_VERSION}`);
  const node = path.join(root, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const nodeWin = path.join(root, 'node', 'node.exe');
  const want = fs.existsSync(node) ? node : nodeWin;
  if (fs.realpathSync(process.execPath) !== fs.realpathSync(want))
    throw new Error(`chạy bằng Node của bundle: ${want}`);
  return {
    root,
    manifest,
    langVi: path.join(root, 'lang', 'ohs-lang-vi'),
    /** URL của một module trong `app/dist`, ví dụ `src/search/searcher.js`. */
    url: (rel) => pathToFileURL(path.join(root, 'app', 'dist', rel)).href,
  };
}

/** Chép vault vào thư mục tạm mới (OHS ghi DB và có thể sửa vault), trả `{work, vault, db}`. */
export function scratchVault(src, name = 'vault') {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-golden-'));
  const vault = path.join(work, name);
  fs.cpSync(src, vault, { recursive: true });
  return { work, vault, db: path.join(work, 'ohs.db') };
}

/**
 * Môi trường của OHS giống cách pkm chạy gói (`crates/pkm-core/src/ohs.rs`): vault, DB ngoài vault, gói vi, mẫu bỏ
 * qua có `_ohs/**`, không kiểm bản mới. Xoá mọi biến OHS khác để lần chạy không phụ thuộc máy.
 */
export function setOhsEnv({ vault, db, langPack }) {
  for (const k of Object.keys(process.env)) {
    if (/^(OBSIDIAN_|OHS_|OPENAI_|LOCAL_EMBEDDING|RERANKER_|LOG_LEVEL)/.test(k)) delete process.env[k];
  }
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.OBSIDIAN_DB_PATH = db;
  process.env.OBSIDIAN_IGNORE_PATTERNS = '.obsidian/**,templates/**,*.canvas,_ohs/**';
  process.env.OHS_DISABLE_UPDATE_CHECK = '1';
  if (langPack) process.env.OHS_LANGUAGE_PACK = langPack;
}

/** JSON với khoá object sắp theo thứ tự chữ, để file golden không đổi theo thứ tự chèn. */
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  }
  return value;
}

export function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(stable(r))).join('\n') + (rows.length ? '\n' : ''));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stable(value), null, 2) + '\n');
}

/** Đường dẫn tương đối (dấu `/`) của mọi note `.md` trong vault, trừ thư mục bị bỏ qua, theo thứ tự chữ. */
export function listNotes(vault) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!['.obsidian', 'templates', '_ohs'].includes(e.name) || rel) walk(path.join(dir, e.name), r);
      } else if (e.isFile() && e.name.endsWith('.md')) out.push(r);
    }
  };
  walk(vault, '');
  return out.sort();
}

/**
 * Dựng index OHS cho vault theo thứ tự cố định. OHS đánh index song song nên thứ tự note vào DB (rowid) đổi giữa các
 * lần, mà nhánh `title` xếp chỗ hoà theo thứ tự đó: nạp từng note theo thứ tự đường dẫn trước (tuần tự), rồi chạy
 * index cả vault như thường để OHS làm phần còn lại (link, view ngôn ngữ, dọn). Note đã có không bị ghi lại.
 */
export async function buildIndex(bundle, vault) {
  const { createIndexService, openIndexDatabase } = await import(bundle.url('src/indexing/index-service.js'));
  const db = await import(bundle.url('src/storage/db.js'));
  const service = createIndexService();
  await openIndexDatabase();
  db.applyDbConfigDefaults();
  const first = await service.reindexFiles(listNotes(vault));
  if (first.errors?.length) throw new Error(`OHS index lỗi: ${JSON.stringify(first.errors).slice(0, 2000)}`);
  const rest = await service.reindex({});
  if (rest.errors?.length) throw new Error(`OHS index lỗi: ${JSON.stringify(rest.errors).slice(0, 2000)}`);
  return {
    db,
    close: async () => {
      await service.close?.();
      db.closeDb();
    },
  };
}

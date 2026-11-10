#!/usr/bin/env node
/**
 * 大肥鱼衣橱 · 构建源素材获取器（assets-src-v2）
 *
 * 从 GitHub Release asset（tag `assets-v2`）下载 `assets-src-v2.tar.zst`，
 * 校验 sha256 后解到 `<repo>/.cache/assets-src/`（gitignored），并按包内
 * `manifest.json` 逐文件校验 size/sha256。也支持 `--from <local tar.zst>`（离线/CI）。
 *
 * 源包不入 git：发布流程 = `npm run pack:sources` → 上传 GitHub Release(tag assets-v1)
 * → 用户/CI `npm run fetch:sources` → `npm run build:assets`。
 *
 * 用法：
 *   node tools/art/fetch-sources.mjs                     # 下载官方 release asset
 *   node tools/art/fetch-sources.mjs --from /path/assets-src-v1.tar.zst
 *   node tools/art/fetch-sources.mjs --url <url> --sha256 <hex> --dest <dir> --force
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const DEFAULT_URL = 'https://github.com/GIT121995/dsh-feiyu-wardrobe/releases/download/assets-v2/assets-src-v2.tar.zst';
// 官方 assets-v2 包固定 sha256（pack-sources.mjs 打印；v2.6.1 起含 hi/ 高 DPI 2x 源）；发布者可用 --sha256/env 覆盖。
// 留 placeholder 时仍会执行 manifest 逐文件校验，并打印警告。
const PINNED_SHA256 = '2e6a003bd4b4695e7550142dbed2d1487d70e8a8c7d0f3110384e791ec3dc934';
const ARCHIVE_ROOT = 'assets-src-v2';

function parseArgs(argv) {
  const out = {
    from: null,
    url: process.env.FEIYU_ASSETS_URL || DEFAULT_URL,
    sha256: process.env.FEIYU_ASSETS_SRC_SHA256 || PINNED_SHA256,
    dest: join(REPO, '.cache', 'assets-src'),
    force: false,
    keepArchive: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--from') out.from = resolve(next());
    else if (a === '--url') out.url = next();
    else if (a === '--sha256') out.sha256 = next();
    else if (a === '--dest') out.dest = resolve(next());
    else if (a === '--force') out.force = true;
    else if (a === '--keep-archive') out.keepArchive = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: node tools/art/fetch-sources.mjs [--from TAR.ZST | --url URL] [--sha256 HEX] [--dest DIR] [--force] [--keep-archive]');
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function run(cmd) {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`command failed (${r.status}): ${cmd}\n${r.stderr || r.stdout}`);
  return r.stdout;
}

async function download(url, destPath) {
  console.error(`[fetch] downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('downloaded archive is empty');
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buf);
  return buf.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const bin of ['tar', 'zstd']) {
    const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`required tool missing: ${bin} (install tar + zstd)`);
  }

  // ---- 1) 取包 ----
  let archive;
  if (args.from) {
    archive = args.from;
    if (!existsSync(archive)) throw new Error(`--from archive missing: ${archive}`);
  } else {
    archive = join(REPO, '.cache', 'downloads', 'assets-src-v1.tar.zst');
    if (!existsSync(archive)) await download(args.url, archive);
    else console.error(`[fetch] using cached archive ${archive} (delete it to re-download)`);
  }

  // ---- 2) tarball sha256 ----
  const archiveSha = sha256File(archive);
  const pinned = !/^PENDING/.test(args.sha256);
  if (pinned) {
    if (archiveSha !== args.sha256) {
      throw new Error(`sha256 mismatch for ${archive}\n  expected ${args.sha256}\n  actual   ${archiveSha}`);
    }
    console.error(`[fetch] tarball sha256 OK (${archiveSha})`);
  } else {
    console.error(`[fetch] WARNING: no pinned sha256 (set FEIYU_ASSETS_SRC_SHA256 / --sha256 to enforce); `
      + `actual ${archiveSha}; continuing with manifest verification`);
  }

  // ---- 3) 解包到临时目录 ----
  const dest = args.dest;
  if (existsSync(dest) && !args.force) {
    throw new Error(`destination exists: ${dest} (pass --force to replace)`);
  }
  const parent = dirname(dest);
  const tmp = join(parent, `.assets-src.tmp-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    run(`zstd -dc ${shq(archive)} | tar -xf - -C ${shq(tmp)}`);
    // 兼容两种包布局：assets-src-v1/ 根目录（标准）或直接根级（history/手工包）
    const extracted = [join(tmp, ARCHIVE_ROOT), tmp].find((p) => existsSync(join(p, 'manifest.json')));
    if (!extracted) throw new Error('manifest.json not found in extracted archive (expect assets-src-v1/)');
    // ---- 4) manifest 逐文件校验（size + sha256）----
    const manifestPath = join(extracted, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error('manifest.json missing in archive root');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.schema !== 'feiyu-assets-src-manifest' || manifest.version !== 1) {
      throw new Error(`unsupported manifest schema/version: ${manifest.schema} v${manifest.version}`);
    }
    const bad = [];
    let bytes = 0;
    for (const f of manifest.files) {
      if (bad.length >= 5) break;
      const p = join(extracted, f.path);
      if (!existsSync(p)) { bad.push(`${f.path}: missing`); continue; }
      const st = statSync(p);
      if (st.size !== f.size) { bad.push(`${f.path}: size ${st.size} != ${f.size}`); continue; }
      if (sha256File(p) !== f.sha256) { bad.push(`${f.path}: sha256 mismatch`); continue; }
      bytes += st.size;
    }
    if (bad.length) throw new Error(`manifest verification failed (${bad.length}+):\n  ${bad.join('\n  ')}`);
    if (bytes !== manifest.totalBytes) throw new Error(`manifest totalBytes mismatch: ${bytes} != ${manifest.totalBytes}`);
    for (const meta of ['VERSION', 'sources.json']) {
      if (!existsSync(join(extracted, meta))) throw new Error(`archive root missing ${meta}`);
    }
    console.error(`[fetch] manifest OK: ${manifest.files.length} files, ${(bytes / 1e6).toFixed(1)} MB, assetVersion=${manifest.assetVersion}`);

    // ---- 5) 就位 ----
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(parent, { recursive: true });
    try {
      renameSync(extracted, dest);
    } catch {
      run(`cp -a ${shq(extracted)} ${shq(dest)}`);
    }
    if (!args.keepArchive && !args.from) rmSync(archive, { force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const version = readFileSync(join(dest, 'VERSION'), 'utf8').trim();
  console.log(JSON.stringify({
    ok: true,
    dest,
    assetVersion: version,
    archiveSha256: archiveSha,
    pinnedSha256: pinned,
    archive,
  }, null, 2));
}

main().catch((e) => {
  console.error(`[fetch] FAILED: ${e.message}`);
  process.exit(1);
});

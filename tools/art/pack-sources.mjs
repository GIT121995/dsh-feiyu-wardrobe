#!/usr/bin/env node
/**
 * 大肥鱼衣橱 · 构建源素材打包器（assets-src-v1）
 *
 * 把 staging 后的源根（默认 `<repo>/.cache/assets-src`）打包成可上传 GitHub Release
 * 的 `assets-src-v1.tar.zst`，同时生成：
 *   - 包内 `manifest.json`：245 个 payload 文件（相对路径/大小/sha256），供 fetch 侧逐文件校验；
 *   - 包内 `sources.json`：历史源工程的布局映射（art→M2 / m4→M4 / prod→refs+seamfill /
 *     hands→HANDS / feet→FEET），审计用；
 *   - 包内 `VERSION`：资产源包版本（`assets-v1`）；
 *   - 包外 `SHA256SUMS`：tarball 的 sha256（同目录，release 上传时一并核对）。
 *
 * 确定性：文件列表排序、tar `--sort=name --mtime=@0 --owner/group=0 --numeric-owner`、
 * zstd 固定参数；同一 staging 树重复打包 sha256 一致（不写入时间戳）。tarball 不入 git，
 * 上传 GitHub Release（tag `assets-v1`）。
 *
 * 用法：
 *   node tools/art/pack-sources.mjs [--src .cache/assets-src] [--out .cache/release/assets-src-v1.tar.zst]
 *        [--version assets-v1] [--level 19] [--threads 0]
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const PAYLOAD_DIRS = ['art', 'm4', 'feet', 'hands', 'prod'];

function parseArgs(argv) {
  const out = {
    src: join(REPO, '.cache', 'assets-src'),
    out: join(REPO, '.cache', 'release', 'assets-src-v1.tar.zst'),
    version: 'assets-v1',
    level: 19,
    threads: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--src') out.src = resolve(next());
    else if (a === '--out') out.out = resolve(next());
    else if (a === '--version') out.version = next();
    else if (a === '--level') out.level = Number(next());
    else if (a === '--threads') out.threads = Number(next());
    else if (a === '-h' || a === '--help') {
      console.log('usage: node tools/art/pack-sources.mjs [--src DIR] [--out TAR.ZST] [--version assets-v1] [--level 19] [--threads 0]');
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function walkFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) files.push(p);
      else throw new Error(`unsupported file type (symlink?): ${p}`);
    }
  };
  walk(root);
  return files;
}

const args = parseArgs(process.argv.slice(2));
const tarballName = 'assets-src-v1.tar.zst';
if (!existsSync(args.src)) throw new Error(`source root missing: ${args.src} (run the staging step / fetch:sources first)`);
for (const d of PAYLOAD_DIRS) {
  if (!existsSync(join(args.src, d))) throw new Error(`source layout incomplete: missing ${d}/ under ${args.src}`);
}
for (const bin of ['tar', 'zstd']) {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`required tool missing: ${bin} (install tar + zstd)`);
}

// ---- 1) 枚举 payload 文件（确定性顺序）----
const payload = [];
for (const d of PAYLOAD_DIRS) {
  for (const p of walkFiles(join(args.src, d))) payload.push({ rel: relative(args.src, p), abs: p });
}
const files = payload.map(({ rel, abs }) => {
  const st = statSync(abs);
  return { path: rel.split('\\').join('/'), size: st.size, sha256: sha256File(abs) };
});
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const totalBytes = files.reduce((s, f) => s + f.size, 0);

// ---- 2) 写包内元数据 ----
const version = args.version;
const sources = {
  schema: 'feiyu-assets-src-layout',
  version: 1,
  assetVersion: version,
  note: '源工程（.scratch 历史目录）→ 冻结源包布局映射；tools/art/build_prod.py 按此布局解析输入。',
  layout: {
    'art/': 'M2 cutout art（base/{shape}/ + garments/{shape}/{combo}/ + MANIFEST.json）',
    'm4/': 'M4 production 模板（dist/{shape}/{rig.json,tex/hair-*,face-*} + assets/art-v2/{shape}/ 生产层）',
    'prod/': 'P3 冻结构建输入（seamfill-{shape}.npz + ref/{shape}_{combo}_rgba.png rest 颜色参考）',
    'hands/': 'T2 手部精修（overlay-1x/{shape}.png + masks/hands-mask-{shape}.png + refined2x/）',
    'feet/': 'P2 脚部精修（{shape}/feet.png + masks/feet.png）',
  },
  consumer: 'tools/art/build_prod.py --src <this root>',
  fileCount: files.length,
  totalBytes,
};
writeFileSync(join(args.src, 'VERSION'), version + '\n');
writeFileSync(join(args.src, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
writeFileSync(join(args.src, 'manifest.json'), JSON.stringify({
  schema: 'feiyu-assets-src-manifest',
  version: 1,
  assetVersion: version,
  root: 'assets-src-v1',
  fileCount: files.length,
  totalBytes,
  files,
}, null, 1) + '\n');

// ---- 3) 确定性 tar + zstd ----
mkdirSync(dirname(args.out), { recursive: true });
const tmpTar = args.out.replace(/\.zst$/, '') + '.tar.tmp';
rmSync(tmpTar, { force: true });
rmSync(args.out, { force: true });
const entries = ['VERSION', 'sources.json', 'manifest.json', ...PAYLOAD_DIRS];
// 用 execFile 风格的 spawn（避免 shell 引号差异）；tar/zstd 参数固定 -> 可复现。
// 包内统一包一层 assets-src-v1/（--transform 前缀，确定性不受影响）
const tar = spawnSync('tar', [
  '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=pax',
  // pax 默认会写 atime/ctime 扩展头 -> 打包不确定；删掉（mtime 已固定为 0）
  '--pax-option=delete=atime,delete=ctime',
  '--transform=s|^|assets-src-v1/|',
  '-cf', tmpTar, '-C', args.src, ...entries,
], { encoding: 'utf8', maxBuffer: 1 << 24 });
if (tar.status !== 0) throw new Error(`tar failed (${tar.status}): ${tar.stderr || tar.stdout}`);
const zstd = spawnSync('zstd', [
  '-q', `-${args.level}`, `-T${args.threads}`, '--no-progress', '-f', tmpTar, '-o', args.out,
], { encoding: 'utf8', maxBuffer: 1 << 24 });
if (zstd.status !== 0) throw new Error(`zstd failed (${zstd.status}): ${zstd.stderr || zstd.stdout}`);
rmSync(tmpTar, { force: true });

// ---- 4) 包外 SHA256SUMS ----
const tarSha = sha256File(args.out);
const sumsPath = join(dirname(args.out), 'SHA256SUMS');
writeFileSync(sumsPath, `${tarSha}  ${tarballName}\n`);
const tarBytes = statSync(args.out).size;

console.log(JSON.stringify({
  ok: true,
  tarball: args.out,
  sha256: tarSha,
  sha256sums: sumsPath,
  payloadFiles: files.length,
  payloadBytes: totalBytes,
  tarballBytes: tarBytes,
  ratio: Number((tarBytes / totalBytes).toFixed(3)),
  version,
}, null, 2));

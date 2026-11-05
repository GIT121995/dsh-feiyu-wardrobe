/**
 * W0-a · 2.5D 资产构建契约测试（tools/art 管线）
 *
 * 设计目标：`npm run verify` 在**没有** 150MB 源素材的机器上也保持全绿（源缺失 → skip），
 * 而在源就绪（`npm run fetch:sources` / 本地 stage）时验证：
 *   1) 源包 manifest 契约：schema/assetVersion/fileCount/totalBytes + 逐文件 size/sha256；
 *   2) 源包布局（art/m4/feet/hands/prod + VERSION/sources.json）；
 *   3) tools/art 脚本可用（build_prod/build_2d5/pack/fetch 的 --help 冒烟）；
 *   4) 构建确定性：单身形（默认 chibi）双跑 build_prod → rig.json + atlas.webp md5 一致；
 *      设 `FEIYU_ASSET_VERIFY_DIST=1` 时额外与 `docs/dress-up/art/2d5/<shape>` 官方 dist
 *      逐字节比对（rig.json/atlas.webp 必须一致；build-report 允许 provenance 文案差异）。
 *
 * 环境变量：
 *   FEIYU_ASSETS_SRC              源根覆盖（默认 <repo>/.cache/assets-src）
 *   FEIYU_ASSET_TEST_SHAPE        确定性测试身形（默认 chibi）
 *   FEIYU_ASSET_VERIFY_DIST=1     额外校验官方 dist md5
 *   DSH_FEIYU_PYTHON              python 解释器（默认 python3）
 *
 * 运行：`npm test`（源缺失自动 skip）/ `npm run verify:full`（源在时做完整校验）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const PYTHON = process.env.DSH_FEIYU_PYTHON || 'python3';
const SRC = process.env.FEIYU_ASSETS_SRC ? resolve(process.env.FEIYU_ASSETS_SRC) : join(ROOT, '.cache', 'assets-src');
const SHAPE = process.env.FEIYU_ASSET_TEST_SHAPE || 'chibi';
const VERIFY_DIST = process.env.FEIYU_ASSET_VERIFY_DIST === '1';
const PAYLOAD_PREFIXES = ['art/', 'm4/', 'feet/', 'hands/', 'prod/'];
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** python3 + 构建依赖可用？（numpy/cv2/Pillow；缺失时跳过构建类测试） */
function pythonBuildDeps() {
	const r = spawnSync(PYTHON, ['-c', 'import numpy, cv2, PIL'], { encoding: 'utf8' });
	return r.status === 0;
}

const manifestPath = join(SRC, 'manifest.json');
const hasSources = existsSync(manifestPath);

// ---------------------------------------------------------------- 静态契约 --
test('package.json：npm 打包契约（W0-a 修正）', () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
	assert.ok(Array.isArray(pkg.files), 'package.json 缺少 files 数组');
	assert.ok(pkg.files.includes('docs/preview/*.png'), 'files 应含 docs/preview/*.png（只打包预览 PNG）');
	assert.ok(!pkg.files.includes('docs/preview'), 'files 不应整体打包 docs/preview（会混入 gitignored dev html）');
	assert.ok(!pkg.files.includes('screenshots.json'), 'files 不应含已删除的 screenshots.json');
	assert.equal(new Set(pkg.files).size, pkg.files.length, 'files 不应有重复项');
	assert.ok(!pkg.files.some((f) => /preview.*\.html$/.test(f)), 'files 不应打包 dev html');
	for (const script of ['fetch:sources', 'build:assets', 'verify:full', 'visual:qa', 'release:prepare']) {
		assert.ok(pkg.scripts?.[script], `package.json 缺少 scripts.${script}`);
	}
	assert.match(pkg.scripts['verify:full'], /typecheck/);
	assert.match(pkg.scripts['verify:full'], /\btest\b/, 'verify:full 应跑 test');
	const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
	for (const entry of ['.cache/', 'tools/art/dist/']) {
		assert.ok(gitignore.split('\n').includes(entry), `.gitignore 应包含 ${entry}`);
	}
});

test('tools/art 脚本冒烟：pack/fetch --help 可运行', () => {
	for (const script of ['pack-sources.mjs', 'fetch-sources.mjs']) {
		const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'art', script), '--help'], { encoding: 'utf8' });
		assert.equal(r.status, 0, `${script} --help 失败：${r.stderr}`);
		assert.match(r.stdout, /usage:/, `${script} --help 缺少 usage`);
	}
});

// ------------------------------------------------------- 源包 manifest 契约 --
test('assets-src manifest：schema + 逐文件 size/sha256 契约（源缺失 skip）', (t) => {
	if (!hasSources) return t.skip(`源包未就绪：${SRC}（先跑 npm run fetch:sources）`);
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	assert.equal(manifest.schema, 'feiyu-assets-src-manifest');
	assert.equal(manifest.version, 1);
	assert.match(String(manifest.assetVersion), /^assets-v\d+$/, 'assetVersion 形如 assets-v1');
	assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'manifest.files 应为非空数组');
	assert.equal(manifest.fileCount, manifest.files.length, 'fileCount 与 files 长度不一致');
	const seen = new Set();
	let bytes = 0;
	for (const f of manifest.files) {
		assert.match(f.path, /^(art|m4|feet|hands|prod)\//, `非法 payload 路径：${f.path}`);
		assert.ok(!seen.has(f.path), `manifest 路径重复：${f.path}`);
		seen.add(f.path);
		const p = join(SRC, f.path);
		assert.ok(existsSync(p), `manifest 文件缺失：${f.path}`);
		assert.equal(statSync(p).size, f.size, `size 不一致：${f.path}`);
		assert.equal(sha256(p), f.sha256, `sha256 不一致：${f.path}`);
		bytes += f.size;
	}
	assert.equal(bytes, manifest.totalBytes, 'totalBytes 与文件大小合计不一致');
	// 布局元数据与构建入口
	const version = readFileSync(join(SRC, 'VERSION'), 'utf8').trim();
	assert.equal(version, manifest.assetVersion, 'VERSION 与 manifest.assetVersion 不一致');
	const sources = JSON.parse(readFileSync(join(SRC, 'sources.json'), 'utf8'));
	assert.equal(sources.assetVersion, manifest.assetVersion);
	for (const dir of ['art/', 'm4/', 'feet/', 'hands/', 'prod/']) {
		assert.ok(sources.layout?.[dir], `sources.json 缺少 ${dir} 布局映射`);
	}
	for (const prefix of PAYLOAD_PREFIXES) {
		assert.ok(manifest.files.some((f) => f.path.startsWith(prefix)), `manifest 缺少 ${prefix} 文件`);
	}
	t.diagnostic(`${manifest.fileCount} files / ${(manifest.totalBytes / 1e6).toFixed(1)} MB / ${manifest.assetVersion}`);
});

// ---------------------------------------------------------- 构建确定性 ----
test(`build_prod 确定性：${SHAPE} 双跑 rig.json + atlas.webp md5 一致（源缺失/依赖缺失 skip）`, (t) => {
	if (!hasSources) return t.skip(`源包未就绪：${SRC}`);
	if (!pythonBuildDeps()) return t.skip(`python 构建依赖不可用（${PYTHON}: numpy/cv2/Pillow）`);
	const builder = join(ROOT, 'tools', 'art', 'build_prod.py');
	assert.ok(existsSync(builder), 'tools/art/build_prod.py 缺失');
	const scratch = mkdtempSync(join(tmpdir(), 'feiyu-asset-build-'));
	const runs = [1, 2].map((n) => ({
		out: join(scratch, `dist-${n}`),
		work: join(scratch, `work-${n}`),
	}));
	try {
		for (const run of runs) {
			const r = spawnSync(PYTHON, [
				builder, '--shape', SHAPE, '--build-atlas',
				'--src', SRC, '--outdir', run.out, '--workdir', run.work,
			], { encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 1 << 26 });
			assert.equal(r.status, 0, `build_prod 失败（${SHAPE}）：\n${(r.stderr || '').slice(-4000)}\n${(r.stdout || '').slice(-4000)}`);
		}
		const files = ['rig.json', 'atlas.webp'];
		const md5s = runs.map((run) => Object.fromEntries(files.map((f) => [f, sha256(join(run.out, SHAPE, f))])));
		for (const f of files) {
			assert.equal(md5s[0][f], md5s[1][f], `${SHAPE}/${f} 双跑 md5 不一致（构建不确定）：${md5s[0][f]} vs ${md5s[1][f]}`);
		}
		// 图集必须 lossless 回读逐像素相等（与 pixelEqual 语义一致）
		const report = JSON.parse(readFileSync(join(runs[0].out, SHAPE, 'build-report.json'), 'utf8'));
		const pages = report.atlases ?? (report.atlas ? [report.atlas] : []);
		assert.ok(pages.length >= 1, `${SHAPE} build-report 缺少图集页信息`);
		for (const page of pages) assert.equal(page.pixelEqual, true, `${SHAPE} 图集 pixelEqual != true`);
		t.diagnostic(`${SHAPE}: rig sha256 ${md5s[0]['rig.json']} / atlas sha256 ${md5s[0]['atlas.webp']}`);

		// verify:full 口径：重建产物必须与仓库官方 dist 逐字节一致（rig + atlas）
		if (VERIFY_DIST) {
			const official = join(ROOT, 'docs', 'dress-up', 'art', '2d5', SHAPE);
			for (const f of files) {
				assert.ok(existsSync(join(official, f)), `官方 dist 缺少 ${SHAPE}/${f}`);
				assert.equal(
					sha256(join(runs[0].out, SHAPE, f)),
					sha256(join(official, f)),
					`重建 ${SHAPE}/${f} 与官方 dist md5 不一致（源包或 builder 漂移）`,
				);
			}
			t.diagnostic(`${SHAPE}: 重建产物与 docs/dress-up/art/2d5 逐字节一致（rig+atlas）`);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

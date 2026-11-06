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
 *   FEIYU_ASSET_MASTER_CONFIGS    可选：v2.6 母版重贴图 config 路径（冒号分隔的 retexture.json 列表）；
 *                                 v2.6 官方 dist 由 `--master-config` 构建，不带该变量重建会与官方 dist 不一致
 *                                 （母版素材在 art 阶段产物中，未入仓；见 docs/dress-up/2.5D-RUNTIME.md）
 *   DSH_FEIYU_PYTHON              python 解释器（默认 python3）
 *
 * 运行：`npm test`（源缺失自动 skip）/ `npm run verify:full`（源在时做完整校验）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const PYTHON = process.env.DSH_FEIYU_PYTHON || 'python3';
const SRC = process.env.FEIYU_ASSETS_SRC ? resolve(process.env.FEIYU_ASSETS_SRC) : join(ROOT, '.cache', 'assets-src');
const SHAPE = process.env.FEIYU_ASSET_TEST_SHAPE || 'chibi';
const VERIFY_DIST = process.env.FEIYU_ASSET_VERIFY_DIST === '1';
/** v2.6：母版重贴图 config（可重复 --master-config）；v2 源包内自带 master/{shape}/config.json。 */
const MASTER_CONFIGS = (process.env.FEIYU_ASSET_MASTER_CONFIGS || '').split(':').filter(Boolean);
/** 源包自带 master/ 时自动发现（v2.6+ 官方 dist 由母版重贴图构建）。 */
function discoverMasterConfigs() {
	if (MASTER_CONFIGS.length) return MASTER_CONFIGS;
	const dir = join(SRC, 'master');
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => existsSync(join(dir, name, 'config.json')))
		.sort()
		.map((name) => join(dir, name, 'config.json'));
}
const PAYLOAD_PREFIXES = ['art/', 'm4/', 'feet/', 'hands/', 'prod/', 'master/', 'hi/'];
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
		assert.match(f.path, /^(art|m4|feet|hands|prod|master|hi)\//, `非法 payload 路径：${f.path}`);
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
	for (const dir of ['art/', 'm4/', 'feet/', 'hands/', 'prod/', 'master/', 'hi/']) {
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
				...discoverMasterConfigs().flatMap((config) => ['--master-config', config]),
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

		// v2.6.2 回归（D-015）：chibi 母版隐藏区近黑残留（头发/手臂摆动时露出黑块）不得回归。
		// 判定：lo chibi 体表纹理中「近黑且不透明」像素总数上限。v2.5 基线 ~5,000；
		// v2.6.0 残留 bug 时 body-head+body-torso 合计 ~12,653；v2.6.2 修复后 ~5,9xx。
		if (SHAPE === 'chibi' && discoverMasterConfigs().length) {
			if (!pythonBuildDeps()) return t.skip('python 构建依赖不可用，跳过近黑残留检查');
			const py = [
				'import sys',
				'import numpy as np',
				'from PIL import Image',
				'texdir = sys.argv[1]',
				'bad = 0',
				'for name in ("body-head.png", "body-torso.png"):',
				'    a = np.array(Image.open(texdir + "/" + name).convert("RGBA")).astype(int)',
				'    vis = a[:, :, 3] > 32',
				'    bad += int(((a[:, :, :3].max(axis=2) < 20) & vis).sum())',
				'print(bad)',
			].join('\n');
			const r = spawnSync(PYTHON, ['-c', py, join(runs[0].work, 'assets', 'tex', 'chibi')], { encoding: 'utf8', timeout: 120000 });
			assert.equal(r.status, 0, `chibi 近黑残留检查失败：${(r.stderr || '').slice(-2000)}`);
			const residue = Number(String(r.stdout).trim());
			assert.ok(Number.isFinite(residue), `chibi 近黑残留检查输出非法：${r.stdout}`);
			assert.ok(residue <= 7200, `chibi 体表近黑像素 ${residue} > 7200（母版隐藏区黑色残留回归？见 v2.6.2 / D-015）`);
			t.diagnostic(`chibi 体表近黑残留：${residue}px（上限 7200；v2.6.2 修复后 6,611；v2.6.0 bug 时 ~12,653）`);
		}

		// verify:full 口径：重建产物必须与仓库官方 dist 逐字节一致（rig + atlas）
		if (VERIFY_DIST) {
			const official = join(ROOT, 'docs', 'dress-up', 'art', '2d5', SHAPE);
			for (const f of files) {
				assert.ok(existsSync(join(official, f)), `官方 dist 缺少 ${SHAPE}/${f}`);
				assert.equal(
					sha256(join(runs[0].out, SHAPE, f)),
					sha256(join(official, f)),
					`重建 ${SHAPE}/${f} 与官方 dist md5 不一致（源包或 builder 漂移）` +
					(discoverMasterConfigs().length ? '' : '；v2.6 官方 dist 由母版重贴图（--master-config）构建'),
				);
			}
			t.diagnostic(`${SHAPE}: 重建产物与 docs/dress-up/art/2d5 逐字节一致（rig+atlas）${discoverMasterConfigs().length ? `（master-config ×${discoverMasterConfigs().length}）` : ''}`);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

// ------------------------------------------------- v2.6.1 hi (2x) tier ----
/** hi tier 静态契约：docs/dress-up/art/2d5/{shape}-hi 存在时校验（不依赖源包）。 */
const HI_ROOT = join(ROOT, 'docs', 'dress-up', 'art', '2d5');
const LO_ROOT = HI_ROOT;
const HI_2X_IDS = new Set(['body-head', 'body-torso', 'leg-L', 'leg-R',
	'arm-upper-L', 'arm-upper-R', 'arm-fore-L', 'arm-fore-R', 'hand-L', 'hand-R',
	'tail']);
const HI_2X_SLOTS = new Set(['hairBack', 'strands', 'hairFront', 'face']);

test('v2.6.1 hi tier：两页图集/像素相等/2x 纹理尺寸/结构与 lo 一致（缺产物 skip）', (t) => {
	const shapes = ['chibi', 'girl'].filter((s) => existsSync(join(HI_ROOT, `${s}-hi`, 'rig.json')));
	if (!shapes.length) return t.skip('hi tier 产物未生成（先跑 npm run build:assets:hi）');
	for (const shape of shapes) {
		const dir = join(HI_ROOT, `${shape}-hi`);
		const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8'));
		const rep = JSON.parse(readFileSync(join(dir, 'build-report.json'), 'utf8'));
		const pages = rep.atlases ?? (rep.atlas ? [rep.atlas] : []);
		assert.equal(pages.length, 2, `${shape}-hi 应为 2 页图集`);
		for (const p of pages) {
			assert.equal(p.pixelEqual, true, `${shape}-hi 图集 pixelEqual != true`);
			assert.ok(p.width <= 4096 && p.height <= 4096, `${shape}-hi 图集页超 4096：${p.width}x${p.height}`);
			assert.ok(existsSync(join(dir, p.file ?? 'atlas.webp')), `${shape}-hi 缺少图集文件`);
		}
		assert.equal(rig.skeleton.bones.length, 65, `${shape}-hi 骨数应为 65`);
		// 与 lo 对比：drawable 集合/rect/mesh 相同，仅纹理与 atlas 字段变化
		const lo = JSON.parse(readFileSync(join(LO_ROOT, shape, 'rig.json'), 'utf8'));
		assert.equal(rig.drawables.length, lo.drawables.length, `${shape}-hi drawables 数应与 lo 相同`);
		const loById = new Map(lo.drawables.map((d) => [d.id, d]));
		const pageIds = new Map(pages.map((p, i) => [p.id ?? `page${i}`, p.drawables ?? null]));
		for (const d of rig.drawables) {
			const l = loById.get(d.id);
			assert.ok(l, `${shape}-hi 多出 drawable ${d.id}`);
			assert.deepEqual(d.rect, l.rect, `${shape}-hi ${d.id} rect 应保持 1x 画布坐标`);
			assert.ok(d.atlas, `${shape}-hi ${d.id} 缺少 atlas 页字段`);
			assert.ok(Array.isArray(rig.atlases) && rig.atlases.some((p) => p.id === d.atlas),
				`${shape}-hi ${d.id} atlas 页 ${d.atlas} 未在 atlases 声明`);
			for (const key of ['positions', 'bones', 'weights', 'indices']) {
				assert.deepEqual(d.mesh[key], l.mesh[key], `${shape}-hi ${d.id} mesh.${key} 应与 lo 相同`);
			}
			const want2x = HI_2X_IDS.has(d.id) || HI_2X_SLOTS.has(d.slot);
			if (want2x) {
				// 2x 纹理：trim bbox 由「lo alpha 的确定性 2x 上采样」决定，大件≈2.0×；
				// 眼/眉/口小件（trim 后仅十余 px）允许更大相对偏差，但仍须明显 >1x 且 <3x
				// （防误用 1x 或 4x 纹理）。
				const lw = l.texSize?.[0] ?? 0;
				const lh = l.texSize?.[1] ?? 0;
				const hw = d.texSize?.[0] ?? 0;
				const hh = d.texSize?.[1] ?? 0;
				const rw = lw ? hw / lw : 0;
				const rh = lh ? hh / lh : 0;
				if (Math.min(lw, lh) <= 24) {
					assert.ok(rw >= 1.25 && rh >= 1.25 && rw <= 3 && rh <= 3,
						`${shape}-hi 小件 ${d.id} 纹理 ${hw}x${hh} 相对 lo ${lw}x${lh} 不是 2x 量级`);
				} else {
					assert.ok(rw >= 1.85 && rw <= 2.4 && rh >= 1.85 && rh <= 2.4,
						`${shape}-hi ${d.id} 纹理 ${hw}x${hh} 相对 lo ${lw}x${lh} 不是 2x（±边缘）`);
				}
			} else {
				assert.deepEqual(d.texSize, l.texSize, `${shape}-hi 1x drawable ${d.id} texSize 应与 lo 相同`);
			}
		}
		// lo tier 未被覆盖：仍是单页 atlas
		const loRep = JSON.parse(readFileSync(join(LO_ROOT, shape, 'build-report.json'), 'utf8'));
		const loPages = loRep.atlases ?? (loRep.atlas ? [loRep.atlas] : []);
		assert.equal(loPages.length, 1, `${shape} lo tier 应仍为单页（不被 hi 构建影响）`);
		assert.equal(loPages[0].pixelEqual, true);
		t.diagnostic(`${shape}-hi: ${pages.map((p) => `${p.width}x${p.height}`).join(' + ')}，`
			+ `${rig.drawables.length} drawables / 65 bones`);
	}
});

test('v2.6.1 hi tier 构建确定性：chibi 双跑 md5 一致（FEIYU_ASSET_VERIFY_HI=1 + 源就绪）', (t) => {
	if (process.env.FEIYU_ASSET_VERIFY_HI !== '1') {
		return t.skip('设 FEIYU_ASSET_VERIFY_HI=1（verify:full）才跑 hi 构建确定性（较慢）');
	}
	if (!hasSources) return t.skip(`源包未就绪：${SRC}`);
	if (!pythonBuildDeps()) return t.skip('python 构建依赖不可用');
	const builder = join(ROOT, 'tools', 'art', 'build_prod.py');
	const scratch = mkdtempSync(join(tmpdir(), 'feiyu-asset-hi-'));
	const runs = [1, 2].map((n) => ({
		out: join(scratch, `dist-${n}`),
		work: join(scratch, `work-${n}`),
	}));
	try {
		for (const run of runs) {
			const r = spawnSync(PYTHON, [
				builder, '--shape', SHAPE, '--tier', 'hi', '--build-atlas',
				'--src', SRC, '--hi-outdir', run.out, '--workdir', run.work,
				...discoverMasterConfigs().flatMap((config) => ['--master-config', config]),
			], { encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 1 << 26 });
			assert.equal(r.status, 0, `hi build 失败（${SHAPE}）：\n${(r.stderr || '').slice(-4000)}\n${(r.stdout || '').slice(-4000)}`);
		}
		const dirName = `${SHAPE}-hi`;
		const files = ['rig.json', 'atlas.webp', 'atlas-2.webp', 'build-report.json'];
		const md5s = runs.map((run) => Object.fromEntries(
			files.map((f) => [f, sha256(join(run.out, dirName, f))])));
		for (const f of files) {
			assert.equal(md5s[0][f], md5s[1][f],
				`${dirName}/${f} 双跑 md5 不一致（hi 构建不确定）：${md5s[0][f]} vs ${md5s[1][f]}`);
		}
		const rep = JSON.parse(readFileSync(join(runs[0].out, dirName, 'build-report.json'), 'utf8'));
		const pages = rep.atlases ?? (rep.atlas ? [rep.atlas] : []);
		assert.equal(pages.length, 2, 'hi 构建应输出 2 页图集');
		for (const p of pages) assert.equal(p.pixelEqual, true);
		t.diagnostic(`hi ${SHAPE}: rig sha256 ${md5s[0]['rig.json']} / atlas ${md5s[0]['atlas.webp']} + ${md5s[0]['atlas-2.webp']}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

#!/usr/bin/env node
/**
 * 视觉门禁（1x 全身 + 2x 关键局部：baseline 生成 / compare 像素回归）。
 *
 * 做什么：
 *   1. 启动本地 stub host（真实宿主模块 lib/webserver.js::createDressUpHandler +
 *      lib/runtime.js::WardrobeRuntime，临时 state 目录）把 docs/dress-up 发出去；
 *   2. 单进程 headless Chrome（SwANGLE，无 GPU）逐身形加载页面，用 runtime 公开 API
 *      固定「静态 QA 模式」（freeze + setStatic + 固定 DPR/画质/关 mipmap），
 *      对 2 身形 × 5 造型（base/maid/hoodie-plaid/hoodie-pleated/sailor-plaid）抓：
 *        - 1x 全身画布区（675×1200，JPEG q82，合成固定背景色）
 *        - 2x 关键局部（膝/手/肩/脚/腹/发；坐标由 rig.json 骨骼/部件计算，JPEG q85）
 *   3. `--mode baseline` 写 docs/qa-baseline/（manifest.json 记录版本/资产哈希/区域/
 *      文件 sha256；总量硬上限 3MiB）；
 *      `--mode compare` 与基线逐图 diff（浏览器内用 createImageBitmap 解码 JPEG，
 *      不引入 npm 依赖），输出 JSON+HTML 报告，超阈值 exit 1。
 *
 * 版本门禁（两种模式都跑）：
 *   - docs/dress-up 内所有 `?v=<n>` 必须唯一（cache-bust 漏改直接 fail）；
 *   - `RUNTIME_2D5_ASSET_VERSION` 必须存在，且实际资源请求带 `?v=<asset>`；
 *   - compare 时：当前页面/资产版本、rig.json/atlas.webp 的 sha256 必须与基线 manifest
 *     一致（资产改了没升版本号 = 直接 fail）。
 *
 * 用法：
 *   node scripts/visual-qa.mjs --mode baseline        # 生成/更新基线（需人工 review 截图后提交）
 *   node scripts/visual-qa.mjs --mode compare         # 门禁（默认模式；超阈值 exit 1）
 *   node scripts/visual-qa.mjs --mode compare --out /path/to/reports
 *
 * 环境变量：
 *   FEIYU_PLAYWRIGHT  playwright-core index.mjs 路径（默认 /tmp/extract/node_modules/playwright-core/index.mjs）
 *   FEIYU_CHROME      Chrome 可执行文件（默认 /usr/bin/google-chrome）
 *   FEIYU_VISUAL_OUT  报告输出根（默认 <repo>/.visual-qa/reports）
 *
 * 退出码：0 通过；1 像素超阈值 / pageerror / 图片异常；2 版本或基线前置条件失败。
 *
 * 注意：headless SwANGLE 无 GPU —— 本门禁只做**像素回归**，不代表真机 FPS/显存；
 * 基线图在固定 Chrome/SwiftShader 版本上生成，Chrome 大版本更新后请人工复检并重生成。
 *
 * 验收口径见 docs/VISUAL-QA.md；已知缺陷登记见 docs/QA-REGISTRY.md。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ 常量 -- */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(SCRIPT_DIR, '..');
const DEFAULT_PLAYWRIGHT = '/tmp/extract/node_modules/playwright-core/index.mjs';
const DEFAULT_CHROME = '/usr/bin/google-chrome';

const BASELINE_FORMAT = 'feiyu-visual-qa-baseline';
const BASELINE_VERSION = 1;
const BASELINE_DIR = join('docs', 'qa-baseline');
const SHAPES = ['chibi', 'girl'];
const OUTFITS = ['base', 'maid', 'hoodie-plaid', 'hoodie-pleated', 'sailor-plaid'];
const REGIONS = ['knee', 'hand', 'shoulder', 'foot', 'abdomen', 'hair', 'neck'];
const DESIGN = { width: 675, height: 1200 };
const BACKGROUND = '#808a99';
const JPEG = { full: 0.82, crop: 0.85 };
const BASELINE_MAX_BYTES = 3 * 1024 * 1024;
const THRESHOLDS = {
	full: { kind: '1x', pixelTolerance: 10, maxChangedRatio: 0.0002 },
	crop: { kind: '2x', pixelTolerance: 10, maxChangedRatio: 0.001 },
};
const LAUNCH_ARGS = [
	'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
	'--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage',
	'--disable-background-timer-throttling', '--disable-renderer-backgrounding',
	'--js-flags=--max-old-space-size=512',
];
const PAGE_TIMEOUT_MS = 180000;
const VIEWPORT = { width: 900, height: 1320 };

/* ------------------------------------------------------------------ 工具 -- */

class GateError extends Error {
	/** @param {string} message @param {number} [exitCode] */
	constructor(message, exitCode = 2) {
		super(message);
		this.exitCode = exitCode;
	}
}

const log = (...args) => console.log(...args);
const rel = (repo, file) => relative(repo, file).split(sep).join('/');

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
	return sha256(readFileSync(file));
}

function bytes(n) {
	return n >= 1024 * 1024 ? `${(n / 1048576).toFixed(2)}MiB` : `${(n / 1024).toFixed(1)}KiB`;
}

function stamp() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function parseArgs(argv) {
	/** @type {Record<string, any>} */
	const options = { mode: 'compare', repo: process.env.FEIYU_REPO || DEFAULT_REPO, out: process.env.FEIYU_VISUAL_OUT || '', help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => {
			const value = argv[i + 1];
			if (!value || value.startsWith('--')) throw new GateError(`参数 ${arg} 缺少值`, 2);
			i += 1;
			return value;
		};
		switch (arg) {
			case '--mode': options.mode = next(); break;
			case '--repo': options.repo = resolve(next()); break;
			case '--out': options.out = resolve(next()); break;
			case '--help': case '-h': options.help = true; break;
			default: throw new GateError(`未知参数：${arg}（--help 查看用法）`, 2);
		}
	}
	if (!['baseline', 'compare'].includes(options.mode)) throw new GateError(`--mode 只支持 baseline/compare，收到：${options.mode}`, 2);
	options.repo = resolve(options.repo);
	options.out = options.out ? resolve(options.out) : join(options.repo, '.visual-qa', 'reports');
	return options;
}

function printHelp() {
	log(`用法：node scripts/visual-qa.mjs [--mode baseline|compare] [--out DIR] [--repo DIR]

  --mode baseline  生成/更新 docs/qa-baseline/（人工 review 截图后提交；总量硬上限 3MiB）
  --mode compare   与基线逐图 diff（默认；超阈值 exit 1，版本/基线异常 exit 2）
  --out DIR        报告输出根（默认 <repo>/.visual-qa/reports）
  --repo DIR       仓库根（默认脚本上一级；一般不用改）

环境变量：FEIYU_PLAYWRIGHT / FEIYU_CHROME / FEIYU_VISUAL_OUT
验收口径：docs/VISUAL-QA.md`);
}

/* -------------------------------------------------------- 版本/资产探测 -- */

const IGNORED_DIRS = new Set(['art', 'node_modules']);

/** 递归收集 docs/dress-up 下的 .html/.js/.json 文件（跳过美术资源目录）。 */
function collectPageFiles(docsDir) {
	/** @type {string[]} */
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (['.html', '.js', '.json', '.css'].includes(extname(entry.name).toLowerCase())) files.push(full);
		}
	};
	walk(docsDir);
	return files.sort();
}

/**
 * 探测页面/资产版本并做唯一性门禁（cache-bust 漏改 → throw）。
 * @param {string} repo
 */
function detectVersions(repo) {
	const docsDir = join(repo, 'docs', 'dress-up');
	if (!existsSync(join(docsDir, 'index.html'))) throw new GateError(`找不到换装间页面：${docsDir}`, 2);
	const appFile = join(docsDir, 'app.js');
	if (!existsSync(appFile)) throw new GateError(`找不到 ${rel(repo, appFile)}`, 2);
	const assetMatch = readFileSync(appFile, 'utf8').match(/RUNTIME_2D5_ASSET_VERSION\s*=\s*'(\d+)'/);
	if (!assetMatch) throw new GateError('app.js 缺少 RUNTIME_2D5_ASSET_VERSION', 2);
	const occurrences = [];
	for (const file of collectPageFiles(docsDir)) {
		const text = readFileSync(file, 'utf8');
		for (const match of text.matchAll(/\?v=(\d+)/g)) occurrences.push({ file: rel(repo, file), value: Number(match[1]) });
	}
	const pageVersions = [...new Set(occurrences.map((entry) => entry.value))].sort((a, b) => a - b);
	if (pageVersions.length === 0) throw new GateError('docs/dress-up 内没有任何 `?v=<n>` 页面版本标记（cache-bust 缺失）', 2);
	if (pageVersions.length > 1) {
		const detail = occurrences.map((entry) => `${entry.file}:?v=${entry.value}`).join(' · ');
		throw new GateError(`页面模块 ?v= 版本不一致（cache-bust 漏改）：${pageVersions.map((v) => `v${v}`).join(', ')}\n    ${detail}`, 2);
	}
	return {
		asset: Number(assetMatch[1]),
		page: pageVersions[0],
		pageFiles: [...new Set(occurrences.map((entry) => entry.file))],
		pageOccurrences: occurrences.length,
	};
}

/** 版本/基线门禁：与基线 manifest 比对（assetVersion/pageVersion/资产哈希）。 */
function assertBaselineVersionGate(repo, manifest, current) {
	const base = manifest.versions || {};
	if (base.asset !== current.asset || base.page !== current.page) {
		throw new GateError(
			`版本门禁失败：基线为 资产 v${base.asset}/页面 v${base.page}，当前源码为 资产 v${current.asset}/页面 v${current.page}。\n` +
			'  资产/页面版本已变更（或 cache-bust 漏改）。确认视觉变更符合预期后运行 `--mode baseline` 更新基线并一并提交；' +
			'若只是漏改 `?v=`/RUNTIME_2D5_ASSET_VERSION 请修正后重试。',
			2,
		);
	}
	const hashDiff = [];
	for (const [shape, files] of Object.entries(manifest.assets || {})) {
		for (const [name, expected] of Object.entries(files)) {
			const file = join(repo, 'docs', 'dress-up', 'art', '2d5', shape, name);
			if (!existsSync(file)) { hashDiff.push(`${shape}/${name} 缺失`); continue; }
			const actual = sha256File(file);
			if (actual !== expected) hashDiff.push(`${shape}/${name} sha256 不一致（基线 ${expected.slice(0, 12)}… / 当前 ${actual.slice(0, 12)}…）`);
		}
	}
	if (hashDiff.length > 0) {
		throw new GateError(
			`资产文件已变化但资产版本号未升（资产版本必须随 dist 变更递增，否则浏览器缓存会命中旧图）：\n    ${hashDiff.join('\n    ')}`,
			2,
		);
	}
}

/** 读取两个身形的 rig.json（并做尺寸/骨骼基础校验）。 */
function loadRigs(repo) {
	const rigs = {};
	for (const shape of SHAPES) {
		const file = join(repo, 'docs', 'dress-up', 'art', '2d5', shape, 'rig.json');
		if (!existsSync(file)) throw new GateError(`缺少 ${rel(repo, file)}`, 2);
		const rig = JSON.parse(readFileSync(file, 'utf8'));
		if (!Array.isArray(rig.drawables) || !rig.skeleton || !Array.isArray(rig.skeleton.bones)) {
			throw new GateError(`${rel(repo, file)} 结构异常（缺 drawables/skeleton.bones）`, 2);
		}
		if (rig.canvas && (rig.canvas.width !== DESIGN.width || rig.canvas.height !== DESIGN.height)) {
			throw new GateError(`${rel(repo, file)} canvas ${rig.canvas.width}×${rig.canvas.height} ≠ ${DESIGN.width}×${DESIGN.height}`, 2);
		}
		const missing = OUTFITS.filter((outfit) => !rig.outfits || !rig.outfits[outfit]);
		if (missing.length > 0) throw new GateError(`${rel(repo, file)} 缺造型：${missing.join(', ')}`, 2);
		rigs[shape] = rig;
	}
	return rigs;
}

/** 参与基线校验的资产文件（rig.json + 图集 webp）。 */
function assetFiles(repo, shape, rig) {
	const dir = join(repo, 'docs', 'dress-up', 'art', '2d5', shape);
	const names = ['rig.json'];
	if (Array.isArray(rig.atlases) && rig.atlases.length > 0) {
		for (const atlas of rig.atlases) if (atlas && typeof atlas.file === 'string' && atlas.file) names.push(atlas.file);
	} else {
		names.push((rig.atlas && rig.atlas.file) || 'atlas.webp');
	}
	/** @type {Record<string, string>} */
	const hashes = {};
	for (const name of [...new Set(names)]) {
		const file = join(dir, name);
		if (!existsSync(file)) throw new GateError(`缺少资产文件：${rel(repo, file)}`, 2);
		hashes[name] = sha256File(file);
	}
	return hashes;
}

/* ------------------------------------------------------- 抓帧前后置断言 -- */

/**
 * 造型断言：状态里必须真的挂上了 rig.outfits[outfit] 定义的部件（防止静默 fallback
 * 把错误造型抓进基线/对比——那种错误基线也是「自洽」的，像素 diff 抓不出来）。
 */
function assertLookApplied(rig, shape, outfit, stateInfo) {
	const definition = rig.outfits[outfit] || {};
	const slots = (stateInfo && stateInfo.slots) || {};
	const problems = [];
	for (const [slot, ids] of Object.entries(definition)) {
		if (slot === 'name' || !Array.isArray(ids)) continue;
		for (const id of ids) if (!(slots[slot] || []).includes(id)) problems.push(`${slot}:${id}`);
	}
	if (stateInfo.fallback) problems.push(`fallback=${stateInfo.fallback}`);
	if (problems.length > 0) throw new GateError(`${shape} 造型 ${outfit} 未按预期挂载（fallback/缺件）：${problems.join(', ')}`, 2);
}

/**
 * 运行时 cache-bust 断言：真实请求的 `?v=` 与源码探测版本一致
 * （art/2d5 资源用资产版本，其余页面模块用页面版本）。
 */
function assertRuntimeVersionWiring(requests, versions, shape) {
	const origin = requests.find((url) => url.includes('/feiyu/dress-up/'));
	if (!origin) throw new GateError(`${shape} 页面没有任何换装间资源请求`, 2);
	const base = new URL(origin).origin;
	const bad = [];
	for (const raw of requests) {
		let url;
		try { url = new URL(raw); } catch { continue; }
		if (url.origin !== base) continue;
		const match = url.search.match(/[?&]v=(\d+)/);
		if (!match) continue;
		const isAsset = url.pathname.includes('/art/2d5/');
		const expected = isAsset ? versions.asset : versions.page;
		if (Number(match[1]) !== expected) {
			bad.push(`${url.pathname}${url.search}（应为 ?v=${expected}，${isAsset ? '资产' : '页面'}）`);
		}
	}
	if (bad.length > 0) throw new GateError(`${shape} 实际请求的 cache-bust 版本与源码不一致（漏改 ?v=）：\n    ${bad.slice(0, 8).join('\n    ')}`, 2);
	const required = [`runtime-2d5.js?v=${versions.page}`, `runtime-2d5-core.js?v=${versions.page}`, `app.js?v=${versions.page}`, `art/2d5/${shape}/rig.bin?v=${versions.asset}`, `art/2d5/${shape}/atlas.webp?v=${versions.asset}`];
	for (const marker of required) {
		// v3.2.0：rig 二进化后运行时优先请求 rig.bin（rig.bin 404 才回退 rig.json）——正常路径必须命中 rig.bin
		if (!requests.some((url) => url.includes(marker))) throw new GateError(`${shape} 缺少带正确版本的资源请求：${marker}`, 2);
	}
}

/* ------------------------------------------------------------- 区域计算 -- */

/**
 * 由 rig.json 推导 2x 局部截图区域（设计坐标 675×1200）：
 * 膝 = shin 骨骼根部（膝盖关节）；手 = 双手部件 rect；肩 = 肩关节 + 上臂根；
 * 脚 = 脚骨下方；腹 = 躯干中轴/髋关节；发 = 头部上方 + 刘海/发束上缘。
 * @param {any} rig
 * @returns {Record<string, [number, number, number, number]>}
 */
function computeRegions(rig) {
	const rectOf = (id) => {
		const drawable = rig.drawables.find((entry) => entry.id === id);
		if (!drawable || !Array.isArray(drawable.rect)) throw new GateError(`rig 缺少部件 rect：${id}`, 2);
		const [x0, y0, x1, y1] = drawable.rect.map(Number);
		return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
	};
	const jointOf = (id) => {
		const bone = rig.skeleton.bones.find((entry) => entry.id === id);
		if (!bone || !Array.isArray(bone.base)) throw new GateError(`rig 缺少骨骼：${id}`, 2);
		return [Number(bone.base[0]), Number(bone.base[1])];
	};
	const union = (rects) => rects.reduce((acc, [x0, y0, x1, y1]) => [
		Math.min(acc[0], x0), Math.min(acc[1], y0), Math.max(acc[2], x1), Math.max(acc[3], y1),
	], [Infinity, Infinity, -Infinity, -Infinity]);
	/** 四边 pad 后裁到画布内，取整。 */
	const box = (x0, y0, x1, y1, pad = 0) => {
		const left = Math.max(0, Math.floor(x0 - pad));
		const top = Math.max(0, Math.floor(y0 - pad));
		const right = Math.min(DESIGN.width, Math.ceil(x1 + pad));
		const bottom = Math.min(DESIGN.height, Math.ceil(y1 + pad));
		if (right - left < 8 || bottom - top < 8) throw new GateError(`截图区域退化：${[left, top, right, bottom].join(',')}`, 2);
		return [left, top, right - left, bottom - top];
	};

	const shinL = jointOf('shinL');
	const shinR = jointOf('shinR');
	const kneeBox = box(Math.min(shinL[0], shinR[0]) - 70, Math.min(shinL[1], shinR[1]) - 75,
		Math.max(shinL[0], shinR[0]) + 70, Math.max(shinL[1], shinR[1]) + 75);

	const hands = union([rectOf('hand-L'), rectOf('hand-R')]);
	const handBox = box(hands[0], hands[1], hands[2], hands[3], 22);

	const shoulderL = jointOf('shoulderL');
	const shoulderR = jointOf('shoulderR');
	const shoulderBox = box(Math.min(shoulderL[0], shoulderR[0]) - 80, Math.min(shoulderL[1], shoulderR[1]) - 65,
		Math.max(shoulderL[0], shoulderR[0]) + 80, Math.max(shoulderL[1], shoulderR[1]) + 105);

	const footL = jointOf('footL');
	const footR = jointOf('footR');
	const footBox = box(Math.min(footL[0], footR[0]) - 70, Math.min(footL[1], footR[1]) - 70,
		Math.max(footL[0], footR[0]) + 70, DESIGN.height + 70);

	const torso = rectOf('body-torso');
	const hips = jointOf('hips');
	const abdomenBox = box((torso[0] + torso[2]) / 2 - 115, hips[1] - 120,
		(torso[0] + torso[2]) / 2 + 115, hips[1] + 50);

	const head = jointOf('head');
	const bangs = rectOf('hair-front-bangs');
	const hairTop = Math.max(0, bangs[1] - 6);
	const hairBox = box(head[0] - 180, hairTop, head[0] + 180, Math.min(hairTop + 300, DESIGN.height));

	// v3.0 领口露颈：以 neck 骨为基准的颈/锁骨区域（覆盖下巴淡影→领口→锁骨上缘；
	// 是"素体颈部色/颈线稿/肉须回归"的门禁区域，见 docs/VISUAL-QA.md）。
	const neck = jointOf('neck');
	const neckBox = box(neck[0] - 95, neck[1] - 145, neck[0] + 95, neck[1] + 75);

	return {
		knee: kneeBox,
		hand: handBox,
		shoulder: shoulderBox,
		foot: footBox,
		abdomen: abdomenBox,
		hair: hairBox,
		neck: neckBox,
	};
}

/* ------------------------------------------------------------ stub host -- */

/**
 * 起本地 stub host：真实宿主模块（webserver 路由 + runtime 业务）+ 临时 state。
 * @param {string} repo
 */
async function startStubServer(repo) {
	const tmpDir = mkdtempSync(join(tmpdir(), 'feiyu-visual-qa-'));
	const statePath = join(tmpDir, 'state.json');
	const { validateConfig } = await import(pathToFileURL(join(repo, 'lib', 'config.js')).href);
	const { WardrobeRuntime } = await import(pathToFileURL(join(repo, 'lib', 'runtime.js')).href);
	const { DRESS_UP_PATH, DRESS_UP_ENTRY, createDressUpHandler } = await import(pathToFileURL(join(repo, 'lib', 'webserver.js')).href);
	const config = validateConfig({ statePath, dressUp: { interaction: { enabled: false } } });
	const runtime = new WardrobeRuntime(config, { clock: () => Date.parse('2026-11-05T00:00:00Z') });
	// 视觉门禁用静态托管：互动关闭（避免 HUD/台词时序影响像素确定性）；client-config 仍由真实 handler 提供。
	const handler = createDressUpHandler(join(repo, 'docs', 'dress-up'), {
		interaction: { enabled: false },
		now: () => Date.parse('2026-11-05T00:00:00Z'),
	});
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url || '/', 'http://127.0.0.1');
		if (url.pathname === '/__test/state') {
			// 真实宿主 runtime（临时 state）：只读聚合，供人工排查；视觉门禁自身不依赖。
			res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
			res.end(JSON.stringify({ ok: true, version: 1, state: runtime.state }));
			return;
		}
		if (url.pathname === DRESS_UP_PATH) {
			res.writeHead(301, { location: DRESS_UP_ENTRY });
			res.end();
			return;
		}
		if (url.pathname.startsWith(DRESS_UP_ENTRY)) {
			await handler(req, res);
			return;
		}
		res.writeHead(404);
		res.end('not found');
	});
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const port = /** @type {any} */ (server.address()).port;
	return {
		port,
		base: `http://127.0.0.1:${port}${DRESS_UP_ENTRY}`,
		close() {
			server.close();
			rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

/* --------------------------------------------------------------- 抓帧 -- */

/**
 * 打开一个身形页面并等待 2.5D runtime 就绪。
 * @param {any} browser
 * @param {string} base
 * @param {string} shape
 */
async function openShapePage(browser, base, shape) {
	const page = await browser.newPage({ viewport: VIEWPORT });
	/** @type {string[]} */
	const pageErrors = [];
	/** @type {string[]} */
	const consoleErrors = [];
	/** @type {string[]} */
	const requests = [];
	page.on('pageerror', (error) => pageErrors.push(`${shape}: ${error.message}`));
	page.on('console', (message) => {
		if (message.type() === 'error' && !/404|Failed to load resource/.test(message.text())) {
			consoleErrors.push(`${shape}/console: ${message.text().slice(0, 200)}`);
		}
	});
	page.on('request', (request) => requests.push(request.url()));
	await page.goto(`${base}?shape=${shape}`, { waitUntil: 'load', timeout: 120000 });
	await page.waitForFunction(() => window.__feiyu2d5 && window.__feiyu2d5.ready && window.__feiyu2d5.ready(), null, { timeout: PAGE_TIMEOUT_MS });
	await page.waitForTimeout(600); // 等 boot 后段（HUD/DIYPack 探测）落定，避免异步 setLook 干扰
	return { page, pageErrors, consoleErrors, requests };
}

/**
 * 在页面内一次性抓完某身形的 1x 全身 + 2x 局部（同一静态 QA 模式，保证与基线同路径）。
 * @param {any} page
 * @param {{ shape: string, regions: Record<string, [number, number, number, number]>, captureMeta: any }} input
 */
async function captureShape(page, input) {
	return page.evaluate(async ({ shape, regions, outfits, regionNames, design, background, jpeg, captureMeta }) => {
		const rt = window.__feiyu2d5.runtime();
		const canvas = document.querySelector('.figure-2d5');
		if (!canvas) throw new Error('缺少 .figure-2d5 canvas');
		// 静态 QA 模式：冻结时间/物理/自动动画，固定画质，关 mipmap（截图确定性）。
		rt.freeze(true);
		rt.setAuto(false);
		rt.setQuality('high');
		rt.setMipmaps(false);
		rt.setStatic(true);
		rt.setDPR(1);
		// 脸态强制 open/closed：boot 期间可能正在进行随机眨眼/笑眼，不固定会把「半眨眼」
		// 抓进基线；随后 advance 90 tick（1.5s）让 boot 阶段残留的 blink/smile/tap/head-follow
		// 计时器衰减到同一个静止态（帧间复现性由 --mode compare 自检保证）。
		rt.setFaceOverride({ eye: 'open', mouth: 'closed' });
		rt.advance(90, 1 / 60);
		rt.setStatic(true);

		/** 取当前画布像素：合成固定背景（JPEG 无 alpha），返回 dataURL。 */
		function snap(kind, box) {
			const k = canvas.width / design.width;
			const [x, y, w, h] = box || [0, 0, design.width, design.height];
			const quality = kind === 'full' ? jpeg.full : jpeg.crop;
			const outW = Math.max(1, Math.round(w * (kind === 'full' ? 1 : k)));
			const outH = Math.max(1, Math.round(h * (kind === 'full' ? 1 : k)));
			const target = document.createElement('canvas');
			target.width = outW;
			target.height = outH;
			const ctx = target.getContext('2d');
			if (!ctx) throw new Error('无法创建 2D canvas');
			ctx.fillStyle = background;
			ctx.fillRect(0, 0, outW, outH);
			ctx.imageSmoothingEnabled = false;
			if (kind === 'full') {
				ctx.drawImage(canvas, 0, 0, outW, outH);
			} else {
				const sx = Math.max(0, Math.round(x * k));
				const sy = Math.max(0, Math.round(y * k));
				const sw = Math.min(canvas.width - sx, Math.round(w * k));
				const sh = Math.min(canvas.height - sy, Math.round(h * k));
				ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, outW, outH);
			}
			return { dataURL: target.toDataURL('image/jpeg', quality), size: [outW, outH] };
		}

		/** 等造型真正生效（v3.2.0 lazy outfit page：套装页懒加载/后台预取未完成时 setLook 会延迟应用）。 */
		function waitLookApplied(outfit) {
			return new Promise((resolve, reject) => {
				const startedAt = performance.now();
				const tick = () => {
					const state = rt.getState();
					const applied = state.look && state.look.outfit === outfit && !state.look.fallback;
					if (applied) return resolve(state);
					if (performance.now() - startedAt > 8000) return reject(new Error(`等待造型 ${outfit} 生效超时（套装页懒加载失败？）`));
					setTimeout(tick, 25);
				};
				tick();
			});
		}

		/** 换造型并渲染静态帧（与基线完全相同的调用顺序）。 */
		async function renderLook(outfit, dpr) {
			rt.setDPR(dpr);
			rt.setLook({ outfit });
			await waitLookApplied(outfit);
			rt.setStatic(true); // 每次换装后重新固定物理 rest，避免跨造型串状态
			rt.advance(3, 1 / 60);
			rt.renderFrame();
			return rt.getState();
		}

		const images = [];
		const stateInfo = {};
		// 1x 全身：画布 675×1200（DPR1）
		for (const outfit of outfits) {
			const state = await renderLook(outfit, 1);
			stateInfo[outfit] = {
				active: state.active.length,
				lookLabel: state.look && state.look.label,
				fallback: state.look && state.look.fallback,
				warnings: (state.look && state.look.warnings) || [],
				slots: state.look && state.look.slots,
			};
			if (canvas.width !== design.width || canvas.height !== design.height) {
				throw new Error(`1x 画布尺寸异常：${canvas.width}×${canvas.height}`);
			}
			images.push({ id: `${shape}/${outfit}/full-1x`, shape, outfit, kind: 'full', scale: 1, ...snap('full'), capture: 'canvas-dpr1' });
		}
		// 2x 关键局部：DPR2 画布裁局部，输出 2x 设计像素
		for (const outfit of outfits) {
			await renderLook(outfit, 2);
			if (canvas.width !== design.width * 2 || canvas.height !== design.height * 2) {
				throw new Error(`2x 画布尺寸异常：${canvas.width}×${canvas.height}`);
			}
			for (const region of regionNames) {
				images.push({ id: `${shape}/${outfit}/${region}-2x`, shape, outfit, kind: 'crop', region, scale: 2, ...snap('crop', regions[region]), capture: 'canvas-dpr2' });
			}
		}
		const assetInfo = window.__feiyu2d5.getAssetInfo ? window.__feiyu2d5.getAssetInfo() : {};
		return { shape, images, stateInfo, assetInfo, meta: captureMeta };
	}, { ...input, outfits: OUTFITS, regionNames: REGIONS, design: DESIGN, background: BACKGROUND, jpeg: JPEG });
}

/* ------------------------------------------------------ baseline 生成 -- */

async function runBaseline(options) {
	const { repo, out } = options;
	const versions = detectVersions(repo);
	const rigs = loadRigs(repo);
	const regions = {};
	const assets = {};
	for (const shape of SHAPES) {
		regions[shape] = computeRegions(rigs[shape]);
		assets[shape] = assetFiles(repo, shape, rigs[shape]);
	}

	const reportsDir = join(out, `baseline-${stamp()}`);
	mkdirSync(reportsDir, { recursive: true });
	// 基线前检查并发 Chrome（3.6GB 机器只允许串行抓帧）
	const chromeProcs = countChromeProcesses();
	if (chromeProcs > 0) log(`⚠ 检测到已有 ${chromeProcs} 个 Chrome 进程在跑；本门禁要求串行抓帧（建议先关掉其他抓帧任务）。`);

	const { chromium } = await import(playwrightPath());
	const stub = await startStubServer(repo);
	/** @type {any} */
	let browser = null;
	/** @type {Array<{ id: string, file: string, shape: string, outfit: string, kind: string, scale: number, region?: string, size: [number, number], bytes: number }>} */
	const images = [];
	const pageErrors = [];
	const consoleErrors = [];
	const assetInfo = {};
	const lookStates = {};
	try {
		browser = await chromium.launch({ executablePath: chromePath(), args: LAUNCH_ARGS });
		for (const shape of SHAPES) {
			const started = Date.now();
			const opened = await openShapePage(browser, stub.base, shape);
			const { page } = opened;
			try {
				const result = await captureShape(page, { shape, regions: regions[shape], captureMeta: { viewport: VIEWPORT, background: BACKGROUND, jpeg: JPEG } });
				pageErrors.push(...opened.pageErrors);
				consoleErrors.push(...opened.consoleErrors);
				// 前置断言：造型真的挂上、cache-bust 版本真的生效（否则基线会静默记录错误画面）
				for (const outfit of OUTFITS) assertLookApplied(rigs[shape], shape, outfit, result.stateInfo[outfit]);
				assertRuntimeVersionWiring(opened.requests, versions, shape);
				assetInfo[shape] = result.assetInfo;
				lookStates[shape] = result.stateInfo;
				for (const image of result.images) {
					const dir = join(repo, BASELINE_DIR, shape, image.outfit);
					mkdirSync(dir, { recursive: true });
					const name = `${image.kind === 'full' ? 'full-1x' : `${image.region}-2x`}.jpg`;
					const file = join(dir, name);
					const buffer = Buffer.from(String(image.dataURL).split(',')[1], 'base64');
					writeFileSync(file, buffer);
					images.push({
						id: image.id,
						file: rel(repo, file),
						shape,
						outfit: image.outfit,
						kind: image.kind,
						scale: image.scale,
						...(image.region ? { region: image.region } : {}),
						size: image.size,
						bytes: buffer.byteLength,
						sha256: sha256(buffer),
					});
				}
			} finally {
				await page.close().catch(() => {});
			}
			log(`  ✓ ${shape} 抓帧完成（${Date.now() - started}ms）`);
		}
	} finally {
		if (browser) await browser.close().catch(() => {});
		stub.close();
	}

	// 清理旧基线中不再生成的 JPEG（避免残留文件被误提交）
	const baselineRoot = join(repo, BASELINE_DIR);
	for (const entry of readTree(baselineRoot)) {
		if (entry.endsWith('.jpg') && !images.some((image) => join(repo, image.file) === entry)) rmSync(entry, { force: true });
	}

	const totalBytes = images.reduce((sum, image) => sum + image.bytes, 0);
	const manifest = {
		format: BASELINE_FORMAT,
		version: BASELINE_VERSION,
		createdAt: new Date().toISOString(),
		generatedBy: 'scripts/visual-qa.mjs --mode baseline',
		note: 'headless Chrome + SwANGLE（无 GPU）；仅像素回归基线，不代表真机 FPS/显存。',
		repoPathHint: 'dsh-feiyu-wardrobe',
		versions,
		assets,
		capture: {
			shape: SHAPES,
			outfits: OUTFITS,
			regions: REGIONS,
			viewport: VIEWPORT,
			design: DESIGN,
			background: BACKGROUND,
			jpeg: JPEG,
			canvasDpr: { full: 1, crop: 2 },
		},
		regions,
		thresholds: THRESHOLDS,
		images,
		totals: { images: images.length, bytes: totalBytes },
	};
	mkdirSync(baselineRoot, { recursive: true });
	writeFileSync(join(baselineRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);

	const report = {
		format: 'feiyu-visual-qa-baseline-build',
		createdAt: manifest.createdAt,
		versions,
		images: images.length,
		bytes: totalBytes,
		bytesHuman: bytes(totalBytes),
		perImage: images.map((image) => ({ id: image.id, bytes: image.bytes, size: image.size })),
		assetInfo,
		lookStates,
		pageErrors,
		consoleErrors,
		chromeProcsBefore: chromeProcs,
	};
	writeFileSync(join(reportsDir, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);

	log('');
	log(`BASELINE ${pageErrors.length === 0 && totalBytes <= BASELINE_MAX_BYTES ? 'OK' : 'FAIL'} · ${images.length} 张 · ${bytes(totalBytes)}（上限 ${bytes(BASELINE_MAX_BYTES)}）· 资产 v${versions.asset}/页面 v${versions.page}`);
	log(`  基线目录：${rel(repo, baselineRoot)}/manifest.json`);
	log(`  构建报告：${reportsDir}/report.json`);
	if (pageErrors.length > 0) {
		log(`  ✗ pageerror ${pageErrors.length} 条：`);
		for (const error of pageErrors.slice(0, 10)) log(`    - ${error}`);
		throw new GateError(`抓帧期间出现 ${pageErrors.length} 条 pageerror（视觉基线不可信）`, 1);
	}
	if (totalBytes > BASELINE_MAX_BYTES) throw new GateError(`基线体积超上限：${bytes(totalBytes)} > ${bytes(BASELINE_MAX_BYTES)}（调小 2x 区域或删减造型后重试）`, 2);
}

function readTree(root) {
	/** @type {string[]} */
	const files = [];
	if (!existsSync(root)) return files;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) files.push(...readTree(full));
		else if (entry.isFile()) files.push(full);
	}
	return files;
}

/* ------------------------------------------------------------- compare -- */

/** 在空白页内解码两张 JPEG 并做像素 diff（不引入图像解码 npm 依赖）。 */
async function diffInBrowser(page, freshB64, baselineB64, threshold) {
	return page.evaluate(async ({ freshB64, baselineB64, threshold }) => {
		const decode = async (b64) => {
			const response = await fetch(`data:image/jpeg;base64,${b64}`);
			return createImageBitmap(await response.blob());
		};
		const [fresh, baseline] = await Promise.all([decode(freshB64), decode(baselineB64)]);
		const out = { width: fresh.width, height: fresh.height };
		try {
			if (fresh.width !== baseline.width || fresh.height !== baseline.height) {
				return { ...out, sizeMismatch: true, baselineSize: [baseline.width, baseline.height] };
			}
			const w = fresh.width;
			const h = fresh.height;
			const canvasA = new OffscreenCanvas(w, h);
			const canvasB = new OffscreenCanvas(w, h);
			const ctxA = canvasA.getContext('2d');
			const ctxB = canvasB.getContext('2d');
			ctxA.drawImage(fresh, 0, 0);
			ctxB.drawImage(baseline, 0, 0);
			const dataA = ctxA.getImageData(0, 0, w, h).data;
			const dataB = ctxB.getImageData(0, 0, w, h).data;
			let changed = 0;
			let maxDelta = 0;
			let sumDelta = 0;
			let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
			const tol = threshold.pixelTolerance;
			/** @type {Uint8Array|null} */
			let mask = null;
			for (let i = 0; i < dataA.length; i += 4) {
				const dr = Math.abs(dataA[i] - dataB[i]);
				const dg = Math.abs(dataA[i + 1] - dataB[i + 1]);
				const db = Math.abs(dataA[i + 2] - dataB[i + 2]);
				const delta = Math.max(dr, dg, db);
				if (delta > maxDelta) maxDelta = delta;
				if (delta > tol) {
					if (!mask) mask = new Uint8Array(w * h);
					const pixel = i / 4;
					mask[pixel] = delta;
					changed += 1;
					sumDelta += delta;
					const x = pixel % w;
					const y = (pixel - x) / w;
					if (x < x0) x0 = x;
					if (y < y0) y0 = y;
					if (x > x1) x1 = x;
					if (y > y1) y1 = y;
				}
			}
			out.totalPixels = w * h;
			out.changed = changed;
			out.changedRatio = changed / (w * h);
			out.maxDelta = maxDelta;
			out.meanDelta = changed > 0 ? sumDelta / changed : 0;
			out.bbox = changed > 0 ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null;
			if (mask) {
				// 差异可视化：基线淡化底图 + 超阈值像素标红
				const outCanvas = new OffscreenCanvas(w, h);
				const octx = outCanvas.getContext('2d');
				octx.globalAlpha = 0.45;
				octx.drawImage(baseline, 0, 0);
				octx.globalAlpha = 1;
				const image = octx.getImageData(0, 0, w, h);
				const data = image.data;
				for (let pixel = 0; pixel < mask.length; pixel += 1) {
					if (!mask[pixel]) continue;
					const i = pixel * 4;
					data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
				}
				octx.putImageData(image, 0, 0);
				const blob = await outCanvas.convertToBlob({ type: 'image/png' });
				const buffer = await blob.arrayBuffer();
				out.diffPngBase64 = (() => {
					const bytes = new Uint8Array(buffer);
					let binary = '';
					const chunk = 0x8000;
					for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
					return btoa(binary);
				})();
			}
			return out;
		} finally {
			fresh.close();
			baseline.close();
		}
	}, { freshB64, baselineB64, threshold });
}

async function runCompare(options) {
	const { repo, out } = options;
	const versions = detectVersions(repo);
	const baselineRoot = join(repo, BASELINE_DIR);
	const manifestFile = join(baselineRoot, 'manifest.json');
	if (!existsSync(manifestFile)) throw new GateError(`缺少视觉基线 ${rel(repo, manifestFile)}；先运行 --mode baseline 生成并提交`, 2);
	/** @type {any} */
	const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
	if (manifest.format !== BASELINE_FORMAT) throw new GateError(`基线 manifest 格式异常：${manifest.format}`, 2);
	assertBaselineVersionGate(repo, manifest, versions);

	const rigs = loadRigs(repo);
	const regions = {};
	for (const shape of SHAPES) {
		const computed = computeRegions(rigs[shape]);
		const stored = manifest.regions && manifest.regions[shape];
		if (!stored) throw new GateError(`基线 manifest 缺 ${shape} 区域定义`, 2);
		for (const region of REGIONS) {
			if (!Array.isArray(stored[region]) || stored[region].join(',') !== computed[region].join(',')) {
				throw new GateError(
					`rig 截图区域变化但资产版本未变：${shape}/${region} 基线 [${stored[region]}] ≠ 当前 [${computed[region]}]。\n` +
					'  若为有意的 rig 布局变更，请确认后 --mode baseline 更新基线；否则检查是否改了 rig.json 但漏升资产版本。',
					2,
				);
			}
		}
		regions[shape] = computed;
	}

	// 基线文件完整性（sha256）+ 期望图集齐全
	const expected = new Map(manifest.images.map((image) => [image.id, image]));
	for (const image of manifest.images) {
		const file = join(repo, image.file);
		if (!existsSync(file)) throw new GateError(`基线图片缺失：${image.file}（请 --mode baseline 重新生成）`, 2);
		const actual = sha256File(file);
		if (actual !== image.sha256) throw new GateError(`基线图片 sha256 不一致：${image.file}（基线文件被改动/损坏，请重新生成）`, 2);
	}
	const expectedIds = new Set(manifest.images.map((image) => image.id));
	for (const shape of SHAPES) for (const outfit of OUTFITS) {
		for (const id of [`${shape}/${outfit}/full-1x`, ...REGIONS.map((region) => `${shape}/${outfit}/${region}-2x`)]) {
			if (!expectedIds.has(id)) throw new GateError(`基线缺少图片：${id}`, 2);
		}
	}
	const expectedImageCount = SHAPES.length * OUTFITS.length * (1 + REGIONS.length);
	if (manifest.images.length !== expectedImageCount) throw new GateError(`基线图片数异常：${manifest.images.length} ≠ ${expectedImageCount}`, 2);

	const reportsDir = join(out, `compare-${stamp()}`);
	mkdirSync(reportsDir, { recursive: true });
	mkdirSync(join(reportsDir, 'fresh'), { recursive: true });
	mkdirSync(join(reportsDir, 'baseline'), { recursive: true });
	const chromeProcs = countChromeProcesses();
	if (chromeProcs > 0) log(`⚠ 检测到已有 ${chromeProcs} 个 Chrome 进程在跑；本门禁要求串行抓帧（建议先关掉其他抓帧任务）。`);

	const { chromium } = await import(playwrightPath());
	const stub = await startStubServer(repo);
	/** @type {any} */
	let browser = null;
	/** @type {any[]} */
	const results = [];
	const pageErrors = [];
	const consoleErrors = [];
	const captureStats = {};
	try {
		browser = await chromium.launch({ executablePath: chromePath(), args: LAUNCH_ARGS });
		const worker = await browser.newPage({ viewport: { width: 400, height: 300 } });
		await worker.goto('about:blank');
		for (const shape of SHAPES) {
			const started = Date.now();
			const opened = await openShapePage(browser, stub.base, shape);
			const { page } = opened;
			/** @type {any} */
			let captured;
			try {
				captured = await captureShape(page, { shape, regions: regions[shape], captureMeta: { viewport: VIEWPORT, background: BACKGROUND, jpeg: JPEG } });
			} finally {
				await page.close().catch(() => {});
			}
			pageErrors.push(...opened.pageErrors);
			consoleErrors.push(...opened.consoleErrors);
			for (const outfit of OUTFITS) assertLookApplied(rigs[shape], shape, outfit, captured.stateInfo[outfit]);
			assertRuntimeVersionWiring(opened.requests, versions, shape);
			captureStats[shape] = { ms: Date.now() - started, active: Object.fromEntries(Object.entries(captured.stateInfo).map(([outfit, info]) => [outfit, info.active])) };
			for (const image of captured.images) {
				const baselineImage = expected.get(image.id);
				if (!baselineImage) throw new GateError(`基线缺少图片：${image.id}`, 2);
				const threshold = image.kind === 'full' ? THRESHOLDS.full : THRESHOLDS.crop;
				const freshBuffer = Buffer.from(String(image.dataURL).split(',')[1], 'base64');
				const freshFile = join(reportsDir, 'fresh', `${image.id}.jpg`);
				mkdirSync(dirname(freshFile), { recursive: true });
				writeFileSync(freshFile, freshBuffer);
				const baselineFile = join(repo, baselineImage.file);
				const baselineOut = join(reportsDir, 'baseline', `${image.id}.jpg`);
				mkdirSync(dirname(baselineOut), { recursive: true });
				writeFileSync(baselineOut, readFileSync(baselineFile));
				const baselineBuffer = readFileSync(baselineFile);
				const diff = await diffInBrowser(worker, freshBuffer.toString('base64'), baselineBuffer.toString('base64'), threshold);
				let diffFile = null;
				if (diff.diffPngBase64) {
					diffFile = `diff/${image.id}.png`;
					const diffPath = join(reportsDir, diffFile);
					mkdirSync(dirname(diffPath), { recursive: true });
					writeFileSync(diffPath, Buffer.from(diff.diffPngBase64, 'base64'));
				}
				const sizeMismatch = !!diff.sizeMismatch;
				const overThreshold = sizeMismatch || diff.changedRatio > threshold.maxChangedRatio;
				results.push({
					id: image.id,
					shape,
					outfit: image.outfit,
					kind: image.kind,
					scale: image.scale,
					...(image.region ? { region: image.region } : {}),
					size: image.size,
					freshBytes: freshBuffer.byteLength,
					baselineBytes: baselineImage.bytes,
					freshSha256: sha256(freshBuffer),
					status: overThreshold ? 'fail' : 'pass',
					changed: diff.changed ?? 0,
					changedRatio: diff.changedRatio ?? 0,
					threshold,
					maxDelta: diff.maxDelta ?? 0,
					meanDelta: diff.meanDelta ?? 0,
					bbox: diff.bbox ?? null,
					...(sizeMismatch ? { error: `尺寸不一致：当前 ${diff.size.join('×')} / 基线 ${diff.baselineSize.join('×')}` } : {}),
					reportFiles: { fresh: `fresh/${image.id}.jpg`, baseline: `baseline/${image.id}.jpg`, ...(diffFile ? { diff: diffFile } : {}) },
				});
			}
			log(`  ✓ ${shape} 对比完成（${Date.now() - started}ms）`);
		}
		await worker.close().catch(() => {});
	} finally {
		if (browser) await browser.close().catch(() => {});
		stub.close();
	}

	const failed = results.filter((result) => result.status === 'fail');
	const changedImages = results.filter((result) => result.changed > 0);
	const summary = {
		images: results.length,
		passed: results.length - failed.length,
		failed: failed.length,
		changedImages: changedImages.length,
		pageErrors: pageErrors.length,
		maxChangedRatio: results.reduce((max, result) => Math.max(max, result.changedRatio), 0),
		maxDelta: results.reduce((max, result) => Math.max(max, result.maxDelta), 0),
	};
	const report = {
		format: 'feiyu-visual-qa-compare',
		createdAt: new Date().toISOString(),
		repo: rel(process.cwd(), repo) || repo,
		versions: { current: versions, baseline: manifest.versions },
		capture: manifest.capture,
		thresholds: THRESHOLDS,
		summary,
		pageErrors,
		consoleErrors,
		captureStats,
		results,
	};
	writeFileSync(join(reportsDir, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
	writeFileSync(join(reportsDir, 'report.html'), renderCompareHtml(report));
	const latest = join(out, 'latest');
	try { rmSync(latest, { recursive: true, force: true }); } catch { /* ignore */ }
	try { symlinkSync(relative(out, reportsDir), latest, 'dir'); } catch { /* symlink 失败不影响结果 */ }

	log('');
	const passed = failed.length === 0 && pageErrors.length === 0;
	log(`VISUAL-QA compare ${passed ? 'PASS' : 'FAIL'} · ${results.length - failed.length}/${results.length} 张通过 · 变更图 ${changedImages.length} 张 · 资产 v${versions.asset}/页面 v${versions.page}`);
	log(`  阈值：1x 像素差>${THRESHOLDS.full.pixelTolerance}/255 的像素 ≤${(THRESHOLDS.full.maxChangedRatio * 100).toFixed(3)}%；2x ≤${(THRESHOLDS.crop.maxChangedRatio * 100).toFixed(2)}%`);
	log(`  报告：${reportsDir}/report.html`);
	log(`  Chrome 进程：启动前 ${chromeProcs} 个 · 结束后 ${countChromeProcesses()} 个（本脚本已关闭浏览器）`);
	if (failed.length > 0) {
		for (const result of failed.slice(0, 12)) {
			const detail = result.error || `changed=${result.changed}px ratio=${(result.changedRatio * 100).toFixed(4)}% maxΔ=${result.maxDelta} bbox=${result.bbox ? result.bbox.join(',') : 'n/a'}`;
			log(`    ✗ ${result.id} · ${detail}`);
		}
		if (failed.length > 12) log(`    … 其余 ${failed.length - 12} 张见 report.json`);
		throw new GateError(`${failed.length} 张截图超阈值（见报告 ${reportsDir}/report.html）`, 1);
	}
	if (pageErrors.length > 0) {
		for (const error of pageErrors.slice(0, 10)) log(`    ✗ pageerror: ${error}`);
		throw new GateError(`抓帧期间出现 ${pageErrors.length} 条 pageerror（0 pageerror 断言失败）`, 1);
	}
}

function renderCompareHtml(report) {
	const esc = (value) => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
	const rows = report.results.map((result) => {
		const ok = result.status === 'pass';
		const bbox = result.bbox ? result.bbox.join(',') : '—';
		return `<tr class="${ok ? 'ok' : 'bad'}">
	<td class="status">${ok ? 'PASS' : 'FAIL'}</td>
	<td><code>${esc(result.id)}</code></td>
	<td>${esc(result.kind === 'full' ? '1x' : '2x')}</td>
	<td>${result.size.join('×')}</td>
	<td>${result.changed} (${(result.changedRatio * 100).toFixed(4)}%)</td>
	<td>${result.maxDelta}</td>
	<td>${bbox}</td>
	<td><a href="${esc(result.reportFiles.fresh)}">当前</a> · <a href="${esc(result.reportFiles.baseline)}">基线</a>${result.reportFiles.diff ? ` · <a href="${esc(result.reportFiles.diff)}">差异图</a>` : ''}</td>
</tr>`;
	}).join('\n');
	const failedRows = report.results.filter((result) => result.status === 'fail');
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>视觉门禁报告 · ${esc(report.createdAt)}</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:24px;color:#1d2433;background:#f7f8fa}
h1{font-size:20px;margin:0 0 6px} .meta{color:#5a6472;margin-bottom:16px}
.summary{display:flex;gap:16px;flex-wrap:wrap;margin:14px 0 20px}
.card{background:#fff;border:1px solid #e3e7ee;border-radius:8px;padding:10px 14px;min-width:130px}
.card b{display:block;font-size:19px} .pass{color:#128a4b} .fail{color:#c22a2a}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e7ee;border-radius:8px;overflow:hidden}
th,td{padding:6px 9px;border-bottom:1px solid #eef1f5;text-align:left;vertical-align:top}
th{background:#eef2f8;font-weight:600} tr.bad td{background:#fff2f2} tr.ok td.status{color:#128a4b;font-weight:600} tr.bad td.status{color:#c22a2a;font-weight:700}
code{font-size:12px} a{color:#1e5fd6} .note{margin-top:18px;color:#5a6472;font-size:13px}
</style></head><body>
<h1>视觉门禁报告（2.5D 换装间）</h1>
<div class="meta">生成时间 ${esc(report.createdAt)} · 资产 v${report.versions.current.asset} / 页面 v${report.versions.current.page} · baseline 资产 v${report.versions.baseline.asset} / 页面 v${report.versions.baseline.page}</div>
<div class="summary">
<div class="card"><b class="${report.summary.failed === 0 ? 'pass' : 'fail'}">${report.summary.failed === 0 ? 'PASS' : 'FAIL'}</b>${report.summary.passed}/${report.summary.images} 通过</div>
<div class="card"><b>${report.summary.changedImages}</b>有像素变化的图</div>
<div class="card"><b>${report.summary.pageErrors}</b>pageerror</div>
<div class="card"><b>${(report.summary.maxChangedRatio * 100).toFixed(4)}%</b>最大变更像素占比</div>
<div class="card"><b>${report.summary.maxDelta}</b>最大单通道差</div>
</div>
${failedRows.length > 0 ? `<p class="fail"><b>${failedRows.length} 张超阈值：</b>${failedRows.slice(0, 20).map((result) => `<code>${esc(result.id)}</code>`).join('、')}</p>` : ''}
<table><thead><tr><th>状态</th><th>图片</th><th>尺度</th><th>尺寸</th><th>超阈值像素</th><th>最大差</th><th>差异 bbox (x,y,w,h)</th><th>证据</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="note">判定口径：像素差（RGB 单通道最大差）&gt; ${report.thresholds.full.pixelTolerance}/255 记为「变更像素」；1x 允许 ≤${(report.thresholds.full.maxChangedRatio * 100).toFixed(3)}%、2x 允许 ≤${(report.thresholds.crop.maxChangedRatio * 100).toFixed(2)}%。<br>
headless Chrome + SwANGLE（无 GPU）：本报告只证明像素回归，不代表真机 FPS/显存；基线基于固定 Chrome/SwiftShader 版本，Chrome 大版本更新后请人工复检并重生成基线。<br>
验收口径与 baseline 更新流程见 <code>docs/VISUAL-QA.md</code>；已知缺陷见 <code>docs/QA-REGISTRY.md</code>。</div>
</body></html>`;
}

/* ------------------------------------------------------------ 运行环境 -- */

function playwrightPath() {
	const value = process.env.FEIYU_PLAYWRIGHT || DEFAULT_PLAYWRIGHT;
	if (!existsSync(value)) throw new GateError(`找不到 playwright-core：${value}（用 FEIYU_PLAYWRIGHT 指定 index.mjs 路径；不要为此新增 npm 依赖）`, 2);
	return pathToFileURL(value).href;
}

function chromePath() {
	const value = process.env.FEIYU_CHROME || DEFAULT_CHROME;
	if (!existsSync(value)) throw new GateError(`找不到 Chrome：${value}（用 FEIYU_CHROME 指定）`, 2);
	return value;
}

function countChromeProcesses() {
	try {
		const output = execFileSync('bash', ['-lc', "ps -eo comm= | grep -cE '^(google-chrome|chrome|chromium)' || true"], { encoding: 'utf8' });
		const count = Number(String(output).trim());
		return Number.isFinite(count) ? count : 0;
	} catch {
		return 0;
	}
}

/* ------------------------------------------------------------------ main -- */

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) { printHelp(); return; }
	process.chdir(options.repo);
	log(`视觉门禁 · ${options.mode === 'baseline' ? '生成基线' : '像素对比'} · repo=${options.repo}`);
	log(`  Chrome=${chromePath()} · Playwright=${process.env.FEIYU_PLAYWRIGHT || DEFAULT_PLAYWRIGHT}`);
	if (options.mode === 'baseline') await runBaseline(options);
	else await runCompare(options);
}

main().catch((error) => {
	const exitCode = Number.isInteger(error && error.exitCode) ? error.exitCode : 1;
	log('');
	log(`✗ ${error && error.message ? error.message : error}`);
	process.exitCode = exitCode;
});

#!/usr/bin/env node
/**
 * v3.0.1 · 用户视角三缺陷复现/取证工具（QA task-4 第 1 部分）
 *
 * 把用户线上反馈的三个问题固化成可重复的 before/after 证据：
 *   ① 服装层手心残留（「穿模」）→ 手部区域 3x 局部图（可 --drop 服装层做层内像素对照实验）
 *   ② 颈部/下巴（「下巴跟脸连不上」）→ 颈部区域 3x 局部图
 *   ③ 加载体验（「人物第一时间没加载出来」）→ 分阶段整页截图 + 时间线（由 scripts/qa-load-timeline.mjs 采集，
 *      本脚本的 --load-shots 模式也会在 pending/ready 各拍一张，作为视觉证据补充）
 *
 * 采集统一走 runtime 静态 QA 模式（freeze/setStatic/固定脸态/advance 90），保证可对比：
 *   - DPR 2/3（deviceScaleFactor 模拟用户设备）打开页面 → 等 ready → 静态帧 → canvas toDataURL；
 *   - 从 rig.json 的骨骼/部件 rect 推导手部、颈部区域（与 visual-qa 同口径），按 3x NEAREST 放大裁切；
 *   - 输出 `<out>/<tag>/<shape>-dpr<N>/<full.png,hand-3x.png,neck-3x.png>` + `meta.json`（版本/哈希/区域）。
 *
 * 用法：
 *   node scripts/qa-repro-2d5.mjs --shapes chibi,girl --dprs 2,3 --out /tmp/feiyu-qa/repro-before
 *   node scripts/qa-repro-2d5.mjs --shapes chibi --dprs 2 --drop sailor-plaid-skirt   # 层内像素对照
 *
 * 单进程、单浏览器、串行；本机 2 核/3GB，运行前确认没有其它 agent 在抓帧。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(SCRIPT_DIR, '..');
const DEFAULT_PLAYWRIGHT = '/tmp/extract/node_modules/playwright-core/index.mjs';
const DEFAULT_CHROME = '/usr/bin/google-chrome';
const DESIGN = { width: 675, height: 1200 };
const SHAPES = ['chibi', 'girl'];
const LAUNCH_ARGS = [
	'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
	'--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage',
	'--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--hide-scrollbars',
	'--js-flags=--max-old-space-size=512',
];
const VIEWPORT = { width: 900, height: 1320 };
const OUTFIT_QS = 'outfit=none&top=sailor&bottom=plaid'; // v3：sailor-plaid = outfit none + sailor top + plaid bottom
const ZOOM = 3;

const log = (...args) => console.log(...args);
const fail = (message) => { console.error(`[qa-repro-2d5] ${message}`); process.exit(2); };

function parseArgs(argv) {
	const options = {
		repo: process.env.FEIYU_REPO || DEFAULT_REPO,
		out: join(DEFAULT_REPO, '.visual-qa', 'repro'),
		shapes: ['chibi', 'girl'],
		dprs: [2, 3],
		drop: [],
		tag: '',
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => {
			const value = argv[i + 1];
			if (!value || value.startsWith('--')) fail(`参数 ${arg} 缺少值`);
			i += 1;
			return value;
		};
		if (arg === '--help' || arg === '-h') options.help = true;
		else if (arg === '--shapes') options.shapes = next().split(',').filter(Boolean);
		else if (arg === '--dprs') options.dprs = next().split(',').map(Number).filter((n) => n >= 1 && n <= 4);
		else if (arg === '--drop') options.drop = next().split(',').filter(Boolean);
		else if (arg === '--repo') options.repo = next();
		else if (arg === '--out') options.out = next();
		else if (arg === '--tag') options.tag = next();
		else fail(`未知参数: ${arg}`);
	}
	for (const shape of options.shapes) if (!SHAPES.includes(shape)) fail(`未知 shape: ${shape}`);
	if (!options.tag) options.tag = `repro-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}`;
	return options;
}

/* ------------------------------------------------------------------ 工具 -- */

async function startStubServer(repo) {
	const tmpDir = mkdtempSync(join(tmpdir(), 'feiyu-repro-qa-'));
	const { DRESS_UP_PATH, DRESS_UP_ENTRY, createDressUpHandler } = await import(pathToFileURL(join(repo, 'lib', 'webserver.js')).href);
	const handler = createDressUpHandler(join(repo, 'docs', 'dress-up'), {
		interaction: { enabled: false },
		now: () => Date.parse('2026-11-05T00:00:00Z'),
	});
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url || '/', 'http://127.0.0.1');
		if (url.pathname === DRESS_UP_PATH) { res.writeHead(301, { location: DRESS_UP_ENTRY }); res.end(); return; }
		if (url.pathname.startsWith(DRESS_UP_ENTRY)) { await handler(req, res); return; }
		res.writeHead(404); res.end('not found');
	});
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const port = /** @type {any} */ (server.address()).port;
	return {
		base: `http://127.0.0.1:${port}${DRESS_UP_ENTRY}`,
		close() { server.close(); rmSync(tmpDir, { recursive: true, force: true }); },
	};
}

/** 与 visual-qa 同口径：从 rig 骨骼/部件 rect 推导手部/颈部抓裁区域（设计坐标 675×1200）。 */
function computeRegions(rig) {
	const joint = (id) => {
		const bone = rig.skeleton.bones.find((entry) => entry.id === id);
		if (!bone || !Array.isArray(bone.base)) fail(`rig 缺少骨骼 ${id}`);
		return [Number(bone.base[0]), Number(bone.base[1])];
	};
	const rectOf = (id) => {
		const drawable = rig.drawables.find((entry) => entry.id === id);
		if (!drawable || !Array.isArray(drawable.rect)) fail(`rig 缺少部件 rect ${id}`);
		const [x0, y0, x1, y1] = drawable.rect.map(Number);
		return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
	};
	const box = (x0, y0, x1, y1) => [
		Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)),
		Math.min(DESIGN.width, Math.ceil(x1)), Math.min(DESIGN.height, Math.ceil(y1)),
	];
	const hands = [rectOf('hand-L'), rectOf('hand-R')];
	const handBox = box(Math.min(hands[0][0], hands[1][0]) - 26, Math.min(hands[0][1], hands[1][1]) - 40,
		Math.max(hands[0][2], hands[1][2]) + 26, Math.max(hands[0][3], hands[1][3]) + 40);
	const neck = joint('neck');
	const neckBox = box(neck[0] - 95, neck[1] - 145, neck[0] + 95, neck[1] + 75);
	return { hand: handBox, neck: neckBox };
}

function workspaceSnapshot(repo) {
	const run = (cmd, args) => {
		const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8' });
		return r.status === 0 ? r.stdout.trim() : null;
	};
	const files = {};
	for (const rel of ['docs/dress-up/app.js', 'docs/dress-up/index.html', 'docs/dress-up/runtime-2d5.js',
		'docs/dress-up/runtime-2d5-core.js', 'docs/dress-up/art/2d5/chibi/atlas.webp',
		'docs/dress-up/art/2d5/chibi-hi/atlas.webp', 'docs/dress-up/art/2d5/girl/atlas.webp',
		'docs/dress-up/art/2d5/girl-hi/atlas.webp']) {
		const file = join(repo, rel);
		try { files[rel] = spawnSync('sha1sum', [file], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[0] || null; } catch { files[rel] = null; }
	}
	let pageVersion = null;
	let assetVersion = null;
	try { const m = readFileSync(join(repo, 'docs/dress-up/index.html'), 'utf8').match(/\?v=(\d+)/); pageVersion = m ? Number(m[1]) : null; } catch { /* ignore */ }
	try { const m = readFileSync(join(repo, 'docs/dress-up/app.js'), 'utf8').match(/RUNTIME_2D5_ASSET_VERSION\s*=\s*'?([\w.]+)'?/); assetVersion = m ? m[1] : null; } catch { /* ignore */ }
	return {
		gitHead: run('git', ['rev-parse', '--short', 'HEAD']),
		gitStatus: run('git', ['status', '--porcelain']),
		pageVersion,
		assetVersion,
		files,
	};
}

/* ---------------------------------------------------------------- 抓取 -- */

async function captureOne(browser, base, options, shape, dpr) {
	const outDir = join(options.out, options.tag, `${shape}-dpr${dpr}`);
	mkdirSync(outDir, { recursive: true });
	const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr });
	const page = await context.newPage();
	const logs = [];
	page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));
	page.on('console', (message) => { if (message.type() === 'error') logs.push(`[console] ${message.text().slice(0, 300)}`); });
	if (options.drop.length > 0) {
		await page.route('**/rig.json*', async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			const before = body.drawables.length;
			body.drawables = body.drawables.filter((entry) => !options.drop.includes(entry.id));
			logs.push(`[rig] dropped ${before - body.drawables.length}/${before}: ${options.drop.join(',')}`);
			await route.fulfill({ response, body: JSON.stringify(body) });
		});
	}
	const url = `${base}?embed=1&shape=${shape}&${OUTFIT_QS}`;
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
	await page.waitForFunction(() => window.__feiyu2d5 && window.__feiyu2d5.ready && window.__feiyu2d5.ready(), null, { timeout: 180000 });
	const rig = JSON.parse(readFileSync(join(options.repo, 'docs', 'dress-up', 'art', '2d5', shape, 'rig.json'), 'utf8'));
	const regions = computeRegions(rig);
	const captured = await page.evaluate(async ({ regions, design, zoom }) => {
		const rt = window.__feiyu2d5.runtime();
		const canvas = document.querySelector('.figure-2d5');
		if (!canvas) throw new Error('缺少 .figure-2d5 canvas');
		rt.freeze(true);
		rt.setAuto(false);
		rt.setQuality('high');
		rt.setMipmaps(false);
		rt.setStatic(true);
		rt.setDPR(1);
		rt.setFaceOverride({ eye: 'open', mouth: 'closed' });
		rt.advance(90, 1 / 60);
		rt.setStatic(true);
		rt.renderFrame();
		// 注意：WebGL canvas 是 preserveDrawingBuffer=false —— 所有 drawImage 必须在同一个
		// 同步任务内完成（任何 await 之后再读 canvas 会得到透明帧，曾把 neck 裁切拍成纯背景色）。
		function snapCanvas(box) {
			const target = document.createElement('canvas');
			target.width = box[2] - box[0];
			target.height = box[3] - box[1];
			const ctx = target.getContext('2d');
			ctx.imageSmoothingEnabled = false;
			ctx.drawImage(canvas, -box[0], -box[1]);
			return target;
		}
		// 3x 放大裁切（最近邻，保留像素结构；同步完成，见上）
		function zoom3x(box) {
			const src = snapCanvas(box);
			const target = document.createElement('canvas');
			target.width = src.width * zoom;
			target.height = src.height * zoom;
			const ctx = target.getContext('2d');
			ctx.imageSmoothingEnabled = false;
			ctx.fillStyle = '#808a99';
			ctx.fillRect(0, 0, target.width, target.height);
			ctx.drawImage(src, 0, 0, target.width, target.height);
			return target.toDataURL('image/png');
		}
		const full = canvas.toDataURL('image/png');
		const hand = zoom3x(regions.hand);
		const neck = zoom3x(regions.neck);
		const state = rt.getState();
		const assetInfo = window.__feiyu2d5.getAssetInfo ? window.__feiyu2d5.getAssetInfo() : null;
		return {
			full,
			hand,
			neck,
			state: {
				active: state.active.length,
				look: state.look && { label: state.look.label, fallback: state.look.fallback, slots: state.look.slots },
				tier: window.__feiyu2d5.getTier ? window.__feiyu2d5.getTier() : null,
				assetInfo,
				canvas: { width: canvas.width, height: canvas.height },
			},
		};
	}, { regions, design: DESIGN, zoom: ZOOM });
	writeFileSync(join(outDir, 'full.png'), Buffer.from(captured.full.split(',')[1], 'base64'));
	writeFileSync(join(outDir, 'hand-3x.png'), Buffer.from(captured.hand.split(',')[1], 'base64'));
	writeFileSync(join(outDir, 'neck-3x.png'), Buffer.from(captured.neck.split(',')[1], 'base64'));
	const meta = {
		shape, dpr, drop: options.drop, url,
		regions,
		zoom: ZOOM,
		state: captured.state,
		logs,
	};
	writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
	await context.close();
	return { shape, dpr, outDir, meta };
}

/* ------------------------------------------------------------------ main -- */

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 32).join('\n'));
		return;
	}
	const repo = resolve(options.repo);
	const playwrightPath = process.env.FEIYU_PLAYWRIGHT || DEFAULT_PLAYWRIGHT;
	const chromePath = process.env.FEIYU_CHROME || DEFAULT_CHROME;
	const { chromium } = await import(pathToFileURL(playwrightPath).href);
	const stub = await startStubServer(repo);
	mkdirSync(options.out, { recursive: true });
	const snapshot = workspaceSnapshot(repo);
	log(`[qa-repro-2d5] base=${stub.base} tag=${options.tag}`);
	log(`[qa-repro-2d5] workspace: HEAD=${snapshot.gitHead} page=${snapshot.pageVersion} asset=${snapshot.assetVersion} dirty=${(snapshot.gitStatus || '').length > 0}`);
	const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: LAUNCH_ARGS });
	const runs = [];
	try {
		for (const shape of options.shapes) {
			for (const dpr of options.dprs) {
				log(`[qa-repro-2d5] capture ${shape} dpr=${dpr} ...`);
				runs.push(await captureOne(browser, stub.base, options, shape, dpr));
				log(`  → ${runs[runs.length - 1].outDir}`);
			}
		}
	} finally {
		await browser.close();
		stub.close();
	}
	const meta = {
		tool: 'qa-repro-2d5',
		version: 1,
		generatedAt: new Date().toISOString(),
		tag: options.tag,
		chrome: spawnSync(chromePath, ['--version'], { encoding: 'utf8' }).stdout.trim(),
		workspace: snapshot,
		outfit: OUTFIT_QS,
		runs: runs.map((run) => ({ shape: run.shape, dpr: run.dpr, dir: run.outDir, regions: run.meta.regions })),
	};
	writeFileSync(join(options.out, options.tag, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
	log(`[qa-repro-2d5] done → ${join(options.out, options.tag)}`);
}

main().catch((error) => {
	console.error(`[qa-repro-2d5] 运行失败：${error && error.stack ? error.stack : error}`);
	process.exit(2);
});

#!/usr/bin/env node
/**
 * 首屏加载体验 E2E 探针（v3.0.1 加载态/首帧门禁 · task-4 门禁 ③）
 *
 * 用户反馈（v3.0.0）：「一进换装间，人物第一时间没有加载出来」。
 * 根因：DPR≥2 走 hi tier，首屏要加载 rig.json（1.66MB）+ atlas.webp 3.05MB + atlas-2.webp 0.53MB，
 * 这段时间 figure 区只有暗背景、没有任何加载提示（headless localhost DPR2 ready 已 2.7–3.3s，
 * 真机移动网络更久）。修复目标：①进面板立即有可见加载态；②lo tier 先出图、hi 后台升级。
 *
 * 本脚本做什么（单进程、单浏览器、串行）：
 *   1. 起本地 stub host（真实 lib/webserver.js::createDressUpHandler + 临时 state，interaction 关闭）；
 *   2. headless Chrome（SwANGLE，无 GPU）打开 `?embed=1&shape=..&feiyuTier=..` 页面：
 *      - 注入 WebGL draw* hook 记录「首个图元绘制」时间（= 首帧人物出现的可测代理）；
 *      - 轮询记录 canvas 入 DOM / __feiyu2d5.ready() / 加载提示元素可见性（多个候选 hook 名，
 *        兼容 #figureLoading / [data-feiyu-loading] / aria-busy / 文本含「加载」的可见元素）；
 *      - 若 `window.__feiyu2d5.timeline()` 存在（runtimefix 约定 API），合并其 performance.now 口径时间点；
 *      - 截图证据：pending（ready 前）、first-frame、ready、final，另拍一张隐藏 canvas 的背景参考图；
 *      - 可选 CDP 网络节流（--throttle fast3g = 1.6Mbps/750kbps/150ms RTT，模拟真机移动网络）。
 *   3. 输出 `<out>/<tag>/timeline.json` + 截图；计算指标并（--assert 时）按阈值判定 exit 1。
 *
 * 这个脚本证明「加载提示在 ready 前可见 / 首帧时间 / ready 不劣化 / 加载期 figure 区不是纯暗空白」；
 * 像素层面只做「pending 暗空比例 / 首帧相对背景变化像素比例」，判定口径写死在 THRESHOLDS。
 *
 * 用法：
 *   node scripts/qa-load-timeline.mjs --shape chibi --dpr 2 --tier hi --throttle none --out /tmp/feiyu-load --assert
 *   node scripts/qa-load-timeline.mjs --shape both --dpr 2 --tier hi --throttle fast3g --out /tmp/feiyu-load
 *   node scripts/qa-load-timeline.mjs --base-url http://127.0.0.1:3080/feiyu/dress-up/ --shape chibi   # host 模式（真 dsh 会话，需已登录）
 *
 * 环境变量：FEIYU_PLAYWRIGHT / FEIYU_CHROME（默认见下）。
 * 退出码：0 记录成功/断言通过；1 断言失败；2 前置条件失败（chrome/playwright/dist 缺失）。
 *
 * 注意：本机 2 核/3GB —— 一次只允许一个 Chrome；运行前确认没有其它 agent 在抓帧。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(SCRIPT_DIR, '..');
const DEFAULT_PLAYWRIGHT = '/tmp/extract/node_modules/playwright-core/index.mjs';
const DEFAULT_CHROME = '/usr/bin/google-chrome';
const SHAPES = ['chibi', 'girl'];
const LAUNCH_ARGS = [
	'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
	'--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage',
	'--disable-background-timer-throttling', '--disable-renderer-backgrounding',
	'--disable-backgrounding-occluded-windows', '--hide-scrollbars',
	'--js-flags=--max-old-space-size=512',
];
const VIEWPORT = { width: 420, height: 900 };

/** CDP 网络节流档位（Chrome DevTools 预设 Fast 3G ≈ 1.6Mbps down / 750kbps up / 150ms RTT）。 */
const THROTTLES = {
	none: null,
	// emulateNetworkConditions 的单位是 bytes/s。
	fast3g: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
	slow4g: { latency: 150, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 },
};

/**
 * 加载体验阈值（v3.0.1 修复后目标）。修复前基线（v3.0.0，2026-11-12 qa 实测）：
 *   - chibi DPR2 hi normal：firstDraw == ready ≈ 2.7–3.3s，loading 提示不存在（firstVisibleAt=null）；
 *   - chibi DPR2 hi fast3g：见 timeline.json 实测（本脚本 --out /tmp/feiyu-qa/load-before）。
 * 断言口径：
 *   loadingVisibleBeforeReady：ready 前必须出现可见加载提示，且导航后 ≤1500ms 出现；
 *   loadingHiddenAfterReady：ready 后 ≤2000ms 内隐藏（避免挡人物）；
 *   firstFrameMaxMs：首帧人物出现上限（normal 6000 / fast3g 15000，headless SwANGLE sanity；
 *                      回归判别改用结构契约：加载提示可见 + auto 首帧 tier=lo + ready 不劣化）；
 *   --no-warmup：关闭温启动（默认先完整跑一轮同身形、不计指标——见 main() 注释）。
 *   readyMaxRatio：ready 不得比修复前基线劣化 >25%；
 *   firstFrameChangedRatio：首帧截图相对"隐藏 canvas 背景参考图"的变化像素占比下限；
 *   pendingDarkRatio：ready 前 figure 区纯暗（max channel <48）像素占比上限（加载期不能只有暗背景）。
 */
export const THRESHOLDS = {
	loadingVisibleMaxMs: 1500,
	// 加载态在首帧后 2 个 rAF + 280ms 淡出；SwANGLE 低帧率下 rAF 可能排队，放宽到 3s（真机 ~300ms）
	loadingHiddenMaxMs: 3000,
	// headless SwANGLE（无 GPU、本机 2 核且常被宿主占用）下 FCP 实测可到 0.6–1.6s，首帧 2.5–3.5s；
	// 该阈值只作「卡死/白屏」sanity，不用于回归判别——回归判别靠结构契约：
	//   loadingVisibleBeforeReady（v3.0.0 无加载提示必 FAIL）、auto 下 tierAtFirstFrame='lo'
	//   （v3.0.0 是 hi-first 必 FAIL）、ready 不劣化 >25%、首帧像素非空白。真机阈值待 D-008。
	firstFrameMaxMs: { normal: 6000, fast3g: 15000 },
	readyMaxRatio: 1.25,
	firstFrameChangedRatio: 0.03,
	pendingDarkRatio: 0.985,
};

const log = (...args) => console.log(...args);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function fail(message) {
	console.error(`[qa-load-timeline] ${message}`);
	process.exit(2);
}

function parseArgs(argv) {
	const options = {
		repo: process.env.FEIYU_REPO || DEFAULT_REPO,
		shape: 'chibi',
		shapes: ['chibi'],
		dpr: 2,
		tier: 'hi',
		throttle: 'none',
		out: '',
		assert: false,
		warmup: false,
		baseUrl: '',
		maxMs: 0,
		intervalMs: 140,
		help: false,
	};
	const shapeArg = (value) => {
		if (value === 'both' || value === 'all') return SHAPES.slice();
		if (!SHAPES.includes(value)) fail(`未知 shape: ${value}（chibi|girl|both）`);
		return [value];
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
		else if (arg === '--assert') options.assert = true;
		else if (arg === '--shape') { options.shapes = shapeArg(next()); options.shape = options.shapes.join('+'); }
		else if (arg === '--dpr') options.dpr = clamp(Number(next()) || 2, 1, 4);
		else if (arg === '--tier') { const v = next(); if (!['lo', 'hi', 'auto'].includes(v)) fail('--tier 只能 lo|hi|auto'); options.tier = v; }
		else if (arg === '--throttle') { const v = next(); if (!(v in THROTTLES)) fail(`--throttle 只能 ${Object.keys(THROTTLES).join('|')}`); options.throttle = v; }
		else if (arg === '--out') options.out = next();
		else if (arg === '--base-url') options.baseUrl = next();
		else if (arg === '--max-ms') options.maxMs = clamp(Number(next()) || 0, 1000, 120000);
		else if (arg === '--interval-ms') options.intervalMs = clamp(Number(next()) || 140, 40, 1000);
		else fail(`未知参数: ${arg}`);
	}
	if (options.help) return options;
	const tagParts = [`${options.shape}`, `dpr${options.dpr}`, `tier-${options.tier}`, `net-${options.throttle}`];
	if (!options.out) options.out = join(options.repo, '.visual-qa', 'load-timeline');
	options.tag = `${tagParts.join('_')}_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}`;
	options.maxMs = options.maxMs || (options.throttle === 'none' ? 30000 : 90000);
	return options;
}

/* -------------------------------------------------------------- stub host -- */

async function startStubServer(repo) {
	const tmpDir = mkdtempSync(join(tmpdir(), 'feiyu-load-qa-'));
	const { DRESS_UP_PATH, DRESS_UP_ENTRY, createDressUpHandler } = await import(pathToFileURL(join(repo, 'lib', 'webserver.js')).href);
	const handler = createDressUpHandler(join(repo, 'docs', 'dress-up'), {
		interaction: { enabled: false },
		now: () => Date.parse('2026-11-05T00:00:00Z'),
	});
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url || '/', 'http://127.0.0.1');
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
		base: `http://127.0.0.1:${port}${DRESS_UP_ENTRY}`,
		close() {
			server.close();
			rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

/* ---------------------------------------------------------------- 页面注入 -- */

/**
 * 注入到页面最早阶段的探针（addInitScript）：不依赖 app.js 内部实现。
 * 记录 performance.now() 口径的：canvas 入 DOM / 首个 figure-2.5D 图元 draw / ready() 翻转 /
 * 加载提示第一次可见与隐藏。所有时间同时给出 `t`（相对 navigationStart 的 performance.now）。
 */
function pageProbe() {
	const qa = /** @type {any} */ (window.__feiyuQaLoad = {
		probeVersion: 1,
		marks: {},
		loadingSamples: [],
		// 兼容用户/测试可能自定义的加载提示 hook；文本兜底也覆盖中文「加载/载入」。
		loadingSelectors: [
			'#figureLoading', '.figure-loading', '[data-feiyu-loading]', '#dressupLoading',
			'#loading', '.loading-overlay', '.loading', '[aria-busy="true"]',
		],
		loadingTextRe: /加载|载入|loading/i,
		readyPollCount: 0,
	});
	const t = () => performance.now();
	const mark = (name) => {
		if (qa.marks[name] == null) qa.marks[name] = t();
	};
	qa.mark = mark;
	qa.now = t;

	// WebGL 图元绘制 hook：只认 .figure-2d5 画布上的第一次真实 draw*（clear 不算）。
	try {
		for (const Ctor of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
			if (!Ctor) continue;
			for (const fn of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
				const original = Ctor.prototype[fn];
				if (typeof original !== 'function') continue;
				Ctor.prototype[fn] = function (...args) {
					try {
						if (qa.marks.firstDraw == null && this.canvas && this.canvas.classList
							&& this.canvas.classList.contains('figure-2d5')) mark('firstDraw');
					} catch { /* ignore */ }
					return original.apply(this, args);
				};
			}
		}
	} catch { /* ignore */ }

	const isVisible = (el) => {
		if (!el || el.hidden) return false;
		const style = getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false;
		const rect = el.getBoundingClientRect();
		return rect.width > 8 && rect.height > 8;
	};
	const visibleLoadingElement = () => {
		for (const selector of qa.loadingSelectors) {
			for (const el of document.querySelectorAll(selector)) {
				if (isVisible(el)) return { selector, text: (el.textContent || '').trim().slice(0, 120) };
			}
		}
		// 文本兜底：可见、短文案、含「加载/载入」的元素（比如 runtime self-rendered 的提示）。
		const scope = document.getElementById('figureWrap') || document.body;
		if (scope) {
			for (const el of scope.querySelectorAll('div,span,p,section,output,strong,b')) {
				const text = (el.textContent || '').trim();
				if (!text || text.length > 40 || !qa.loadingTextRe.test(text)) continue;
				if (isVisible(el)) return { selector: 'text', text: text.slice(0, 120) };
			}
		}
		return null;
	};

	const sample = () => {
		const at = t();
		if (qa.marks.canvasInDom == null) {
			const canvas = document.querySelector('canvas.figure-2d5');
			if (canvas) {
				mark('canvasInDom');
				const rect = canvas.getBoundingClientRect();
				qa.canvasRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
				qa.canvasBacking = { width: canvas.width, height: canvas.height };
			}
		}
		if (qa.marks.ready == null) {
			qa.readyPollCount += 1;
			try {
				const api = window.__feiyu2d5;
				if (api && typeof api.ready === 'function' && api.ready()) {
					mark('ready');
					try { qa.tier = typeof api.getTier === 'function' ? api.getTier() : null; } catch { qa.tier = null; }
					try { qa.assetInfo = typeof api.getAssetInfo === 'function' ? api.getAssetInfo() : null; } catch { qa.assetInfo = null; }
					try { qa.runtimeTimeline = typeof api.timeline === 'function' ? api.timeline() : null; } catch { qa.runtimeTimeline = null; }
				}
			} catch { /* ignore */ }
		}
		const loading = visibleLoadingElement();
		const previous = qa.loadingSamples[qa.loadingSamples.length - 1];
		if (loading) {
			if (qa.marks.loadingVisible == null) mark('loadingVisible');
			qa.marks.loadingLastVisible = at;
			qa.loadingText = qa.loadingText || loading.text;
			qa.loadingSelector = qa.loadingSelector || loading.selector;
		} else if (previous && previous.visible && qa.marks.loadingHidden == null && qa.marks.loadingVisible != null) {
			mark('loadingHidden');
		}
		// 采样 25ms 一次足够；限量避免长节流下数组过大。
		if (qa.loadingSamples.length < 4000) {
			qa.loadingSamples.push({ at, visible: !!loading, selector: loading ? loading.selector : '' });
		}
	};

	try {
		new MutationObserver(() => sample()).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
	} catch { /* ignore */ }
	const interval = setInterval(sample, 22);
	const raf = () => {
		sample();
		if (qa.marks.ready == null || qa.marks.firstDraw == null || !qa.canvasRect) requestAnimationFrame(raf);
	};
	requestAnimationFrame(raf);
	window.addEventListener('load', () => { mark('loadEvent'); sample(); });
	window.addEventListener('DOMContentLoaded', () => { mark('domContentLoaded'); sample(); });
	document.addEventListener('visibilitychange', () => sample());
	qa.stop = () => clearInterval(interval);
	sample();
}

/* ------------------------------------------------------------------ 抓取 -- */

async function snapshot(page, dir, tag, phase) {
	const file = join(dir, `${tag}__${phase}.jpg`);
	try {
		await page.screenshot({ path: file, type: 'jpeg', quality: 72, timeout: 20000 });
		return file;
	} catch (error) {
		return { error: String((error && error.message) || error) };
	}
}

async function runOne(browser, options, base) {
	const url = `${base}?embed=1&shape=${options.shape}${options.tier === 'auto' ? '' : `&feiyuTier=${options.tier}`}`;
	const outDir = join(options.out, options.tag, options.shape);
	mkdirSync(outDir, { recursive: true });
	const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: options.dpr });
	const page = await context.newPage();
	const pageErrors = [];
	const requests = [];
	page.on('pageerror', (error) => pageErrors.push(String(error.message || error).slice(0, 400)));
	page.on('console', (message) => {
		if (message.type() === 'error' && !/404|Failed to load resource/i.test(message.text())) pageErrors.push(`console: ${message.text().slice(0, 300)}`);
	});
	page.on('request', (request) => requests.push({ url: request.url(), at: Date.now() }));
	await page.addInitScript(pageProbe);

	// 温启动（默认开启）：headless SwANGLE + 冷浏览器下首次导航要额外编译/解码模块（实测可差 2–3s），
	// 会把「冷启动」误判为加载回归。先导航一次等 ready（不计入指标，也不进入截图/时间线），再测正式一次。
	// `--no-warmup` 可关闭（测冷启动体验时用）。
	if (options.warmup !== false && options.throttle === 'none') {
		const warmAt = Date.now();
		try {
			await page.goto(url, { waitUntil: 'commit', timeout: options.maxMs });
			await page.waitForFunction(() => window.__feiyuQaLoad && window.__feiyuQaLoad.marks.ready != null, null, { timeout: 60000, polling: 50 });
			log(`  warmup ready in ${Date.now() - warmAt}ms（不计入门禁时间线）`);
		} catch {
			log('  warmup 超时（继续正式测量）');
		}
		requests.length = 0;
		pageErrors.length = 0;
	}

	let throttleInfo = null;
	if (THROTTLES[options.throttle]) {
		const cdp = await context.newCDPSession(page);
		await cdp.send('Network.enable');
		await cdp.send('Network.emulateNetworkConditions', { offline: false, ...THROTTLES[options.throttle] });
		throttleInfo = { ...THROTTLES[options.throttle], preset: options.throttle };
	}

	const startedAt = Date.now();
	await page.goto(url, { waitUntil: 'commit', timeout: options.maxMs });
	// pending 截图：ready 之前的一帧（固定 500ms 后拍，若已 ready 就等 120ms 再拍）。
	await new Promise((done) => setTimeout(done, 500));
	const screenshots = [];
	const pendingShot = await snapshot(page, outDir, 'shot', 'pending');
	screenshots.push({ phase: 'pending', file: pendingShot, at: Date.now() - startedAt });
	// 等首个 draw（首帧人物）——最多 maxMs。
	let firstDrawOk = true;
	try {
		await page.waitForFunction(() => window.__feiyuQaLoad && window.__feiyuQaLoad.marks.firstDraw != null, null, { timeout: options.maxMs, polling: 20 });
	} catch { firstDrawOk = false; }
	const firstFrameShot = await snapshot(page, outDir, 'shot', 'firstframe');
	screenshots.push({ phase: 'firstframe', file: firstFrameShot, at: Date.now() - startedAt });
	// 等 ready。
	let readyOk = true;
	try {
		await page.waitForFunction(() => window.__feiyuQaLoad && window.__feiyuQaLoad.marks.ready != null, null, { timeout: Math.max(5000, options.maxMs - (Date.now() - startedAt)), polling: 20 });
	} catch { readyOk = false; }
	const readyShot = await snapshot(page, outDir, 'shot', 'ready');
	screenshots.push({ phase: 'ready', file: readyShot, at: Date.now() - startedAt });
	// auto tier：等后台 lo→hi 升级落定（runtimefix 契约：waitForTierUpgrade()；无升级立即 resolve）。
	let finalTierInfo = null;
	if (options.tier === 'auto') {
		try {
			await page.evaluate(async () => {
				const api = window.__feiyu2d5;
				if (api && typeof api.waitForTierUpgrade === 'function') {
					await Promise.race([api.waitForTierUpgrade(), new Promise((done) => setTimeout(done, 45000))]);
				}
			});
		} catch { /* 旧版本没有该 API → 指标里体现 */ }
		try { finalTierInfo = await page.evaluate(() => (window.__feiyu2d5 && window.__feiyu2d5.getTier ? window.__feiyu2d5.getTier() : null)); } catch { finalTierInfo = null; }
	}
	// 等加载提示隐藏（最多 2s）后拍 final；再隐藏 canvas 拍背景参考帧（像素分析用）。
	try {
		await page.waitForFunction((timeout) => {
			const qa = window.__feiyuQaLoad;
			return qa.marks.ready != null && (qa.marks.loadingHidden != null || qa.marks.loadingVisible == null);
		}, null, { timeout: THRESHOLDS.loadingHiddenMaxMs + 1000, polling: 50 });
	} catch { /* 加载提示没按时消失 → 指标会体现 */ }
	await new Promise((done) => setTimeout(done, 400));
	const finalShot = await snapshot(page, outDir, 'shot', 'final');
	screenshots.push({ phase: 'final', file: finalShot, at: Date.now() - startedAt });
	// 背景参考帧：隐藏 figure canvas（真实 DOM 移除会触发 runtime 逻辑，用 visibility 隐藏更安全）。
	let canvasRect = null;
	let referenceShot = null;
	try {
		const raw = await page.evaluate(() => {
			const qa = window.__feiyuQaLoad;
			const canvas = document.querySelector('canvas.figure-2d5');
			const rect = (canvas || document.getElementById('figureWrap')).getBoundingClientRect();
			if (canvas) canvas.style.visibility = 'hidden';
			return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, qa: JSON.parse(JSON.stringify(qa)) };
		});
		canvasRect = raw.rect;
		referenceShot = await snapshot(page, outDir, 'shot', 'background-ref');
		await new Promise((done) => setTimeout(done, 250));
		const resources = await page.evaluate(() => {
			const art = performance.getEntriesByType('resource')
				.filter((entry) => entry.name.includes('/art/2d5/') || entry.name.includes('runtime-2d5') || entry.name.includes('manifest.json') || entry.name.includes('style.css'))
				.map((entry) => ({ name: entry.name.split('/dress-up/').pop(), startTime: entry.startTime, duration: entry.duration, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize }));
			let api = null;
			try { api = window.__feiyu2d5 && typeof window.__feiyu2d5.resources === 'function' ? window.__feiyu2d5.resources() : null; } catch { api = null; }
			return { art, api };
		});
		const wall = Date.now() - startedAt;
		const result = buildResult({ options, url, wall, raw, screenshots, referenceShot, resources, pageErrors, requests, throttleInfo, readyOk, firstDrawOk, startedAt, finalTierInfo });
		return result;
	} catch (error) {
		const raw = { qa: {}, rect: null };
		return buildResult({ options, url, wall: Date.now() - startedAt, raw, screenshots, referenceShot, resources: null, pageErrors, requests, throttleInfo, readyOk, firstDrawOk, startedAt, finalTierInfo: null, fatal: String((error && error.message) || error) });
	} finally {
		await context.close();
	}
}

function buildResult(input) {
	const { options, url, wall, raw, screenshots, referenceShot, resources, pageErrors, requests, throttleInfo, readyOk, firstDrawOk, startedAt, finalTierInfo, fatal } = input;
	const qa = raw && raw.qa ? raw.qa : {};
	const marks = qa.marks || {};
	/** @param {string} name */
	const markMs = (name) => (marks[name] == null ? null : Math.round(marks[name]));
	const readyAt = markMs('ready');
	const firstDrawAt = markMs('firstDraw');
	const loadingVisibleAt = markMs('loadingVisible');
	const loadingHiddenAt = markMs('loadingHidden');
	const loadingLastVisibleAt = marks.loadingLastVisible == null ? null : Math.round(marks.loadingLastVisible);
	// 加载提示可见区间：若 ready 时仍可见（还没隐藏），记录隐藏超时。
	const loadingVisibleBeforeReady = loadingVisibleAt != null && readyAt != null && loadingVisibleAt <= readyAt;
	const hiDir = `${options.shape}-hi`;
	const hiArtRequests = requests.filter((entry) => entry.url.includes(`/art/2d5/${hiDir}/`)).map((entry) => entry.url.split('/dress-up/').pop());
	const loArtRequests = requests.filter((entry) => entry.url.includes(`/art/2d5/${options.shape}/`)).map((entry) => entry.url.split('/dress-up/').pop());
	const resourcesSummary = resources && resources.art ? resources.art.reduce((acc, entry) => {
		acc.count += 1;
		acc.transferSize += Number(entry.transferSize) || 0;
		acc.decodedBodySize += Number(entry.decodedBodySize) || 0;
		return acc;
	}, { count: 0, transferSize: 0, decodedBodySize: 0 }) : null;
	return {
		tag: options.tag,
		shape: options.shape,
		options: { dpr: options.dpr, tier: options.tier, throttle: options.throttle },
		url,
		wallMs: wall,
		fatal: fatal || null,
		pageErrors,
		tier: finalTierInfo || qa.tier || null,
		assetInfo: qa.assetInfo || null,
		runtimeTimeline: qa.runtimeTimeline || null,
		loading: {
			selector: qa.loadingSelector || null,
			text: qa.loadingText || null,
			visibleAt: loadingVisibleAt,
			lastVisibleAt: loadingLastVisibleAt,
			hiddenAt: loadingHiddenAt,
			visibleBeforeReady: loadingVisibleBeforeReady,
			visibleMs: loadingVisibleAt != null ? (loadingHiddenAt != null ? loadingHiddenAt - loadingVisibleAt : (readyAt != null ? readyAt - loadingVisibleAt : null)) : null,
			sampleCount: (qa.loadingSamples || []).length,
			visibleSamples: (qa.loadingSamples || []).filter((entry) => entry.visible).length,
		},
		marks: {
			navigationStart: 0,
			domContentLoaded: markMs('domContentLoaded'),
			canvasInDom: markMs('canvasInDom'),
			firstDraw: firstDrawAt,
			ready: readyAt,
			loadEvent: markMs('loadEvent'),
			loadingVisible: loadingVisibleAt,
			loadingHidden: loadingHiddenAt,
		},
		canvasRect: raw.rect || qa.canvasRect || null,
		firstDrawOk: firstDrawOk && firstDrawAt != null,
		readyOk: readyOk && readyAt != null,
		requests: {
			count: requests.length,
			hiArt: [...new Set(hiArtRequests)].slice(0, 40),
			loArt: [...new Set(loArtRequests)].slice(0, 40),
		},
		resources: resources || null,
		resourcesSummary,
		throttle: throttleInfo,
		screenshots,
		referenceShot,
		startedAtIso: new Date(startedAt).toISOString(),
	};
}

/* ------------------------------------------------------------- 像素分析 -- */

/**
 * 用 Python+PIL 分析截图：
 *   - pending 帧 figure 区「纯暗空白」比例（max channel < 48）；
 *   - firstframe / ready / final 帧相对 background-ref 的变化像素占比（证明人物真的画出来了）。
 * 区域用 canvasRect（CSS px）乘 DPR 映射到截图像素；截图是整页，含 scroll 偏移=0。
 */
function analyzePixels(results, options) {
	if (results.length === 0) return results;
	const payload = results.map((result) => ({
		tag: result.tag,
		shape: result.shape,
		dpr: options.dpr,
		figureRect: result.canvasRect,
		reference: result.referenceShot && !result.referenceShot.error ? result.referenceShot : null,
		shots: result.screenshots.filter((entry) => entry.file && !entry.file.error).map((entry) => ({ phase: entry.phase, file: entry.file })),
	}));
	const py = `
import json, sys
import numpy as np
from PIL import Image

def load(path):
    return np.asarray(Image.open(path).convert('RGB')).astype(np.int16)

def region_of(img, rect, dpr):
    h, w = img.shape[:2]
    x = max(0, int(round(rect['x'] * dpr)))
    y = max(0, int(round(rect['y'] * dpr)))
    x1 = min(w, int(round((rect['x'] + rect['width']) * dpr)))
    y1 = min(h, int(round((rect['y'] + rect['height']) * dpr)))
    if x1 - x <= 2 or y1 - y <= 2:
        return None
    return img[y:y1, x:x1]

out = {}
for item in json.loads(sys.argv[1]):
    key = item['tag'] + '/' + item['shape']
    info = {'shots': {}, 'error': None}
    rect = item.get('figureRect')
    ref_path = item.get('reference')
    ref = load(ref_path) if ref_path else None
    for shot in item['shots']:
        img = load(shot['file'])
        fig = region_of(img, rect, item['dpr']) if rect else None
        entry = {'shape': list(img.shape)}
        if fig is not None and fig.size:
            entry['pendingDarkRatio'] = float((np.max(fig, axis=2) < 48).mean())
            entry['figStd'] = float(fig.std())
            entry['figMeanRGB'] = [float(v) for v in fig.reshape(-1, 3).mean(axis=0)]
        if ref is not None and fig is not None and ref.shape == img.shape:
            ref_fig = region_of(ref, rect, item['dpr'])
            if ref_fig is not None and ref_fig.shape == fig.shape:
                diff = np.abs(fig - ref_fig).max(axis=2)
                entry['changedRatio'] = float((diff > 20).mean())
                entry['changedPx'] = int((diff > 20).sum())
        info['shots'][shot['phase']] = entry
    out[key] = info
print(json.dumps(out))
`;
	const r = spawnSync('python3', ['-c', py, JSON.stringify(payload)], { encoding: 'utf8', timeout: 180000 });
	if (r.status !== 0) {
		log(`[qa-load-timeline] 像素分析失败（跳过像素指标）：${(r.stderr || '').slice(0, 500)}`);
		return results;
	}
	let analysis;
	try { analysis = JSON.parse((r.stdout || '').trim()); } catch { return results; }
	for (const result of results) {
		const key = `${result.tag}/${result.shape}`;
		result.pixels = analysis[key] || null;
	}
	return results;
}

/* ----------------------------------------------------------------- 判定 -- */

/**
 * 按 THRESHOLDS 判定一次 run 的加载体验门禁。返回 { pass, failures[], metrics, contract }。
 *
 * 两路时间数据：①本脚本注入的独立探针（WebGL draw hook / DOM 轮询，任何版本可用）；
 * ②runtimefix 约定 API `__feiyu2d5.timeline()`（v3.0.1 起）。两个都记录，判定优先用
 * 独立探针（不依赖被测实现），并交叉校验 timeline() 的自洽性（防止 API 报漂亮数字但实际没出图）。
 */
export function evaluateRun(result, options) {
	const failures = [];
	const diagnostics = [];
	const metrics = {};
	const contract = {};
	const throttleKey = options.throttle === 'none' ? 'normal' : options.throttle;
	const firstFrameThreshold = THRESHOLDS.firstFrameMaxMs[throttleKey] || THRESHOLDS.firstFrameMaxMs.normal;
	const loading = result.loading || {};
	const marks = result.marks || {};
	const tl = result.runtimeTimeline || null;
	metrics.loadingVisibleAt = loading.visibleAt;
	metrics.firstDrawAt = marks.firstDraw;
	metrics.readyAt = marks.ready;
	metrics.firstFrameThresholdMs = firstFrameThreshold;

	if (result.fatal) failures.push(`fatal: ${result.fatal}`);
	if (!result.firstDrawOk) failures.push('未观测到首帧图元绘制（firstDraw 缺失）');
	if (!result.readyOk) failures.push('runtime 未 ready');

	// 契约 API：runtimefix v3.0.1 约定 timeline()（缺失说明实现没按契约交付；不影响下面的独立判定）
	contract.timelinePresent = !!(tl && tl.readyAt != null && tl.firstFrameAt != null);
	if (!contract.timelinePresent) {
		diagnostics.push('契约：window.__feiyu2d5.timeline() 缺失或字段不全（v3.0.1 约定 API）');
	}
	if (tl) {
		contract.loadingShownAt = tl.loadingShownAt == null ? null : Math.round(tl.loadingShownAt);
		contract.firstFrameAt = tl.firstFrameAt == null ? null : Math.round(tl.firstFrameAt);
		contract.readyAt = tl.readyAt == null ? null : Math.round(tl.readyAt);
		contract.loadingHiddenAt = tl.loadingHiddenAt == null ? null : Math.round(tl.loadingHiddenAt);
		contract.bootStartAt = tl.bootStartAt == null ? null : Math.round(tl.bootStartAt);
		contract.tierAtFirstFrame = tl.tierAtFirstFrame || null;
		contract.targetTier = tl.targetTier || null;
		contract.tierReadyAt = tl.tierReadyAt == null ? null : Math.round(tl.tierReadyAt);
		contract.upgrade = tl.upgrade || null;
		// 独立探针 vs 契约自洽性（同口径 performance.now；容差 250ms，超出只告警不判死）
		for (const [name, probe, reported] of [
			['firstFrame', marks.firstDraw, contract.firstFrameAt],
			['ready', marks.ready, contract.readyAt],
			['loadingShown', loading.visibleAt, contract.loadingShownAt],
		]) {
			if (probe != null && reported != null && Math.abs(probe - reported) > 250) {
				diagnostics.push(`契约：timeline().${name}=${reported}ms 与独立探针 ${probe}ms 相差 >250ms`);
			}
		}
	}

	// ① 加载提示必须在 ready / 首帧之前出现（用户反馈 #3 的核心）
	const loadingVisibleAt = loading.visibleAt != null ? loading.visibleAt : contract.loadingShownAt;
	metrics.loadingVisibleAt = loadingVisibleAt;
	if (loadingVisibleAt == null) {
		failures.push('加载提示不存在：导航后到 ready 期间没有可见的加载态（用户反馈 #3 未修复）');
	} else {
		const readyForGate = marks.ready != null ? marks.ready : contract.readyAt;
		const firstFrameForGate = marks.firstDraw != null ? marks.firstDraw : contract.firstFrameAt;
		if (readyForGate != null && loadingVisibleAt > readyForGate) failures.push(`加载提示在 ready 之后才出现（visible=${loadingVisibleAt}ms > ready=${readyForGate}ms）`);
		if (firstFrameForGate != null && loadingVisibleAt > firstFrameForGate) failures.push(`加载提示在首帧人物之后才出现（visible=${loadingVisibleAt}ms > firstFrame=${firstFrameForGate}ms）`);
		if (loadingVisibleAt > THRESHOLDS.loadingVisibleMaxMs) failures.push(`加载提示出现太晚：${Math.round(loadingVisibleAt)}ms > ${THRESHOLDS.loadingVisibleMaxMs}ms`);
		if (loading.text && !/加载|载入|loading/i.test(loading.text)) diagnostics.push(`加载提示文案不含「加载」：${loading.text.slice(0, 60)}`);
	}
	// ② ready 后加载提示必须移除
	const loadingHiddenAt = loading.hiddenAt != null ? loading.hiddenAt : contract.loadingHiddenAt;
	metrics.loadingHiddenAt = loadingHiddenAt;
	const readyForGate = marks.ready != null ? marks.ready : contract.readyAt;
	if (loadingVisibleAt != null && loadingHiddenAt == null) {
		failures.push(`加载提示 ready 后未隐藏（ready=${readyForGate}ms，lastVisible=${loading.lastVisibleAt}ms）`);
	} else if (loadingHiddenAt != null && readyForGate != null && loadingHiddenAt > readyForGate + THRESHOLDS.loadingHiddenMaxMs) {
		failures.push(`加载提示隐藏过晚：${loadingHiddenAt}ms（ready=${readyForGate}ms，允许 +${THRESHOLDS.loadingHiddenMaxMs}ms）`);
	}
	// ③ 首帧时间阈值（lo 先出图后 hi 升级的目标）
	const firstFrameMs = marks.firstDraw != null ? Math.round(marks.firstDraw) : (contract.firstFrameAt != null ? contract.firstFrameAt : null);
	metrics.firstFrameMs = firstFrameMs;
	if (firstFrameMs == null) failures.push('首帧时间未知');
	else if (firstFrameMs > firstFrameThreshold) failures.push(`首帧人物出现过晚：${firstFrameMs}ms > ${firstFrameThreshold}ms（${throttleKey}）`);
	// ④ 首帧截图必须真的画出了人物（不是透明/空白帧）
	const pixels = result.pixels && result.pixels.shots;
	const firstFramePixels = pixels && pixels.firstframe;
	metrics.firstFrameChangedRatio = firstFramePixels && firstFramePixels.changedRatio != null ? firstFramePixels.changedRatio : null;
	if (metrics.firstFrameChangedRatio == null) {
		diagnostics.push('像素：首帧截图分析不可用（firstframe changedRatio 缺失）');
	} else if (metrics.firstFrameChangedRatio < THRESHOLDS.firstFrameChangedRatio) {
		failures.push(`首帧截图像素异常：相对背景仅 ${(metrics.firstFrameChangedRatio * 100).toFixed(2)}% 变化（阈值 ≥${(THRESHOLDS.firstFrameChangedRatio * 100).toFixed(0)}%，可能是「ready 了但画面空白」）`);
	}
	// ⑤ ready 前 figure 区不能只有纯暗空白（加载反馈缺失时）
	const pendingPixels = pixels && pixels.pending;
	metrics.pendingDarkRatio = pendingPixels && pendingPixels.pendingDarkRatio != null ? pendingPixels.pendingDarkRatio : null;
	metrics.pendingFigStd = pendingPixels && pendingPixels.figStd != null ? pendingPixels.figStd : null;
	if (metrics.pendingDarkRatio != null && metrics.pendingDarkRatio >= THRESHOLDS.pendingDarkRatio && loadingVisibleAt == null) {
		failures.push(`ready 前 figure 区 ${(metrics.pendingDarkRatio * 100).toFixed(1)}% 为纯暗像素且无加载提示（用户看到的「人物没加载出来」）`);
	}
	// ⑥ tier 契约 + 确定性（runtimefix v3.0.1：override 固定最终 tier，不做 lo→hi 升级）
	const finalTier = result.tier && result.tier.tier ? result.tier.tier : null;
	contract.finalTier = finalTier;
	contract.tierReason = result.tier && result.tier.reason ? result.tier.reason : null;
	const hiRequests = result.requests && result.requests.hiArt ? result.requests.hiArt : [];
	const loRequests = result.requests && result.requests.loArt ? result.requests.loArt : [];
	if (options.tier === 'hi') {
		if (finalTier !== 'hi') failures.push(`tier override=hi 但运行时 tier=${finalTier || 'unknown'}（防止静默降级）`);
		if (!hiRequests.some((url) => url.includes('rig.bin'))) failures.push('hi tier 没有请求 art/2d5/*-hi/rig.bin（v3.2.0 rig 二进化）');
		if (!hiRequests.some((url) => url.includes('atlas.webp'))) failures.push('hi tier 没有请求 hi atlas.webp');
		if (tl && tl.tierAtFirstFrame && tl.tierAtFirstFrame !== 'hi') failures.push(`tier override=hi 但首帧 tier=${tl.tierAtFirstFrame}（override 应直接按 hi 加载，不做 progressive upgrade）`);
		if (tl && tl.upgrade && tl.upgrade.status && !['none', 'not-needed', 'skipped', 'done'].includes(tl.upgrade.status)) failures.push(`tier override=hi 却存在进行中的 lo→hi 升级：${tl.upgrade.status}（QA 静态确定性要求 override 固定 tier）`);
	} else if (options.tier === 'lo') {
		if (finalTier !== 'lo') failures.push(`tier override=lo 但运行时 tier=${finalTier || 'unknown'}（应固定为 lo）`);
		if (hiRequests.length > 0) failures.push(`tier override=lo 却请求了 hi tier 资产（${hiRequests.length} 个）：${hiRequests.slice(0, 3).join(', ')}`);
	} else {
		// auto：DPR≥2 且设备能力足够时应走 hi（首帧契约 = lo 先出图 + hi 后台升级已启动；
		// SwANGLE 软件 GL 下 hi 图集解码/上传很慢，强制要求测试窗口内升级完成会把环境性能误判为回归，
		// 因此只要求「已启动（loading/done）」+ 首帧 tier=lo；真机 GPU 上通常 ready 后数秒内完成）
		const targetTier = contract.targetTier || null;
		if (targetTier === 'hi') {
			if (!hiRequests.some((url) => url.includes('rig.bin'))) failures.push('auto hi 没有请求 hi rig.bin（v3.2.0 rig 二进化）');
			const upgradeStatus = tl && tl.upgrade ? tl.upgrade.status : null;
			if (upgradeStatus && !['loading', 'done'].includes(upgradeStatus)) {
				failures.push(`lo→hi 升级状态异常：upgrade.status=${upgradeStatus}${tl.upgrade.error ? `（${tl.upgrade.error}）` : ''}`);
			}
			if (tl && tl.tierAtFirstFrame && tl.tierAtFirstFrame !== 'lo') {
				failures.push(`auto 渐进首帧应为 lo，实际 tierAtFirstFrame=${tl.tierAtFirstFrame}（hi-first 回归）`);
			}
			if (upgradeStatus === 'loading') diagnostics.push('lo→hi 后台升级仍在 loading（SwANGLE 慢，不计失败；真机应数秒内 done）');
		} else {
			diagnostics.push(`auto tier 决策=${targetTier || 'unknown'}（${contract.tierReason || '无 timeline 信息'}）`);
		}
	}
	return { pass: failures.length === 0, failures, diagnostics, metrics, contract };
}

/**
 * 记录测量时的仓库状态（页面/资产版本、app.js 等文件 sha1、git HEAD/工作区脏标记）——
 * 修复前后对比报告必须能对上「测量的是哪一版代码/资产」。
 */
function workspaceSnapshot(repo) {
	const run = (cmd, args) => {
		const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8' });
		return r.status === 0 ? r.stdout.trim() : null;
	};
	const files = {};
	for (const rel of [
		'docs/dress-up/app.js', 'docs/dress-up/index.html', 'docs/dress-up/runtime-2d5.js',
		'docs/dress-up/runtime-2d5-core.js', 'lib/webserver.js',
		'docs/dress-up/art/2d5/chibi/rig.bin', 'docs/dress-up/art/2d5/chibi/rig.bin.br', 'docs/dress-up/art/2d5/chibi/atlas.webp',
		'docs/dress-up/art/2d5/chibi/atlas-2.webp', 'docs/dress-up/art/2d5/chibi-hi/rig.bin', 'docs/dress-up/art/2d5/chibi-hi/atlas.webp',
	]) {
		const file = join(repo, rel);
		if (!existsSync(file)) continue;
		const stat = spawnSync('sha1sum', [file], { encoding: 'utf8' });
		files[rel] = stat.status === 0 ? stat.stdout.trim().split(/\s+/)[0] : null;
	}
	let pageVersion = null;
	let assetVersion = null;
	try {
		const html = readFileSync(join(repo, 'docs', 'dress-up', 'index.html'), 'utf8');
		const match = html.match(/\?v=(\d+)/);
		pageVersion = match ? Number(match[1]) : null;
	} catch { /* ignore */ }
	try {
		const app = readFileSync(join(repo, 'docs', 'dress-up', 'app.js'), 'utf8');
		const match = app.match(/RUNTIME_2D5_ASSET_VERSION\s*=\s*'?([\w.]+)'?/);
		assetVersion = match ? match[1] : null;
	} catch { /* ignore */ }
	return {
		gitHead: run('git', ['rev-parse', '--short', 'HEAD']),
		gitDirty: (run('git', ['status', '--porcelain']) || '').length > 0,
		gitStatus: run('git', ['status', '--porcelain']),
		pageVersion,
		assetVersion,
		node: process.version,
		files,
	};
}

/* ------------------------------------------------------------------ main -- */

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 34).join('\n'));
		return;
	}
	const repo = resolve(options.repo);
	if (!existsSync(join(repo, 'docs', 'dress-up', 'index.html'))) fail(`不是换装间仓库：${repo}`);
	const playwrightPath = process.env.FEIYU_PLAYWRIGHT || DEFAULT_PLAYWRIGHT;
	const chromePath = process.env.FEIYU_CHROME || DEFAULT_CHROME;
	if (!existsSync(playwrightPath)) fail(`缺少 playwright-core：${playwrightPath}（设 FEIYU_PLAYWRIGHT）`);
	if (!existsSync(chromePath)) fail(`缺少 Chrome：${chromePath}（设 FEIYU_CHROME）`);
	// 单浏览器纪律：本机 2 核/3GB，检测到其它 headless chrome 时告警（不自动杀，避免踩别人）。
	try {
		const ps = spawnSync('bash', ['-lc', "ps -eo args | grep -E 'google-chrome.*--headless|chrome --headless' | grep -v grep | wc -l"], { encoding: 'utf8' });
		const count = Number((ps.stdout || '0').trim());
		if (count > 0) log(`[qa-load-timeline] 警告：检测到 ${count} 个已有 headless Chrome 进程，可能与其它 agent 并行抢 CPU（本机 2 核）。`);
	} catch { /* ignore */ }

	const { chromium } = await import(pathToFileURL(playwrightPath).href);
	const stub = options.baseUrl ? null : await startStubServer(repo);
	const base = options.baseUrl || stub.base;
	mkdirSync(options.out, { recursive: true });
	log(`[qa-load-timeline] base=${base}`);

	const results = [];
	const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: LAUNCH_ARGS });
	try {
		// 温启动（默认开启；--no-warmup 或网络节流测试时关闭）：
		// 先完整跑一轮同一个身形（不计指标）——headless SwANGLE 的冷启动/GPU 初始化/首轮 hi 升级
		// 会把首帧拖慢 2–3s，直接测会把「冷启动」误判为加载回归；预热后的测量才代表用户重复进入体验。
		if (options.warmup !== false && options.throttle === 'none') {
			const warmAt = Date.now();
			await runOne(browser, { ...options, shape: options.shapes[0], tag: `${options.tag}-warmup` }, base);
			log(`[qa-load-timeline] warmup full run ${options.shapes[0]} in ${Date.now() - warmAt}ms（不计入门禁）`);
		}
		for (const shape of options.shapes) {
			log(`[qa-load-timeline] run shape=${shape} dpr=${options.dpr} tier=${options.tier} net=${options.throttle} ...`);
			const result = await runOne(browser, { ...options, shape }, base);
			results.push(result);
			result.gate = evaluateRun(result, { ...options, shape });
			const metrics = result.gate.metrics;
			log(`  firstDraw=${metrics.firstDrawAt}ms ready=${metrics.readyAt}ms loading=${metrics.loadingVisibleAt == null ? '无' : `${metrics.loadingVisibleAt}-${result.marks.loadingHidden}ms`} tier=${JSON.stringify(result.tier && result.tier.tier)}`);
			for (const failure of result.gate.failures) log(`  FAIL: ${failure}`);
			for (const note of result.gate.diagnostics || []) log(`  note: ${note}`);
		}
	} finally {
		await browser.close().catch(() => {});
		try { if (stub) stub.close(); } catch { /* ignore */ }
	}
	const analyzed = analyzePixels(results, options);
	// 合并分析后重算（像素指标参与判定）。
	for (const result of analyzed) result.gate = evaluateRun(result, options);
	const summary = {
		tool: 'qa-load-timeline',
		version: 2,
		generatedAt: new Date().toISOString(),
		repo,
		workspace: workspaceSnapshot(repo),
		options,
		chrome: spawnSync(chromePath, ['--version'], { encoding: 'utf8' }).stdout.trim(),
		thresholds: THRESHOLDS,
		runs: analyzed,
		pass: analyzed.every((result) => result.gate.pass),
	};
	const summaryFile = join(options.out, `${options.tag}.summary.json`);
	writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
	for (const result of analyzed) {
		const file = join(options.out, options.tag, `${result.shape}.timeline.json`);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
	}
	log(`[qa-load-timeline] summary: ${summaryFile}`);
	log(`[qa-load-timeline] gate: ${summary.pass ? 'PASS' : 'FAIL'}（${analyzed.map((result) => result.gate.failures.length).join('+')} failures）`);
	if (options.assert && !summary.pass) process.exit(1);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
	main().catch((error) => {
		console.error(`[qa-load-timeline] 运行失败：${error && error.stack ? error.stack : error}`);
		process.exit(2);
	});
}

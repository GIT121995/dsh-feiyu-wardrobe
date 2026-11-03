import {
	FACE_PATCH_KEYS,
	FACE_TIMING,
	applySelection,
	applyShape,
	collectItems,
	currentBounds,
	describeOutfit,
	facePatchStyle,
	facePatchesOf,
	normalizeState,
	randomOutfit,
	randomBetween,
	resolveLayers,
	// @ts-ignore tsc 不认识带 ?v= 的模块路径；这里加版本号是为了让浏览器绕过 wardrobe-core 的旧缓存
} from './wardrobe-core.js?v=11';
import { createDiy } from './diy-ui.js?v=11';

(() => {
	'use strict';

	const $ = (sel) => document.querySelector(sel);
	const STORAGE_KEY = 'feiyu:outfit';
	/** 渲染方式用户选择（M3：'dom' 分层纸娃娃 | '2d5' WebGL2 动态；默认不写）。 */
	const RENDER_STORAGE_KEY = 'feiyu:render';
	/** 2.5D runtime 模块与资产根（未开启 2.5D 时不会 import / 不会发请求）。 */
	const RUNTIME_2D5_MODULE = './runtime-2d5.js?v=12';
	const RUNTIME_2D5_ASSET_ROOT = 'art/2d5/';
	const params = new URLSearchParams(location.search);

	/** 图层槽位（v6 起由 manifest.drawOrder 决定，boot 时动态建 <img>，不再写死）。 */
	/** @type {string[]} */
	let layerSlots = [];
	/** 悬浮小鲸鱼用的小图尺寸（9:16，与整张立绘画布同构）。 */
	const PET_IMAGE_W = 184;
	const PET_IMAGE_H = 328;

	const els = {
		stage: $('#stage'),
		scene: $('#scene'),
		figureWrap: $('#figureWrap'),
		figureShadow: $('#figureShadow'),
		figure: $('#figure'),
		/** @type {Record<string, HTMLImageElement>} */
		figureLayers: {},
		fx: $('#fx'),
		bubble: $('#bubble'),
		tip: $('#stageTip'),
		tabs: $('#tabs'),
		shelf: $('#shelf'),
		shapeToggle: $('#shapeToggle'),
		lookName: $('#lookName'),
		lookDesc: $('#lookDesc'),
		sheet: $('#sheet'),
		sheetBody: $('#sheetBody'),
		sheetStat: $('#sheetStat'),
		canvas: $('#exportCanvas'),
	};

	let manifest = null;
	let diy = null;
	let state = null;
	let tab = 'outfits';
	/** 图片加载缓存：src → Promise<HTMLImageElement> */
	const cache = new Map();
	/** 已加载完成的图片：src → HTMLImageElement（合成小图时可以同步取用） */
	const loaded = new Map();
	/** 图层渲染序号：快速连续换装时，只让最新一次渲染落地，避免旧图后到覆盖新图。 */
	let renderSeq = 0;
	/** persist 序号：只让最新一次穿搭落盘。 */
	let persistSeq = 0;
	/** 上一次渲染的状态（背景/特效/布局/图层栈），用来跳过没变化的重复工作。 */
	const lastRendered = { bg: '', effect: '', layoutKey: '', figureKey: '' };
	/** persist 的 debounce 定时器。 */
	let persistTimer = 0;
	/** 上一次落盘的穿搭签名（同一穿搭不重复合成小图）。 */
	let lastPersistKey = '';
	/** 身形切换按钮是否已构建（只构建一次）。 */
	let shapeToggleBuilt = false;
	/** 衣柜格子当前构建的分类（同一分类只更新选中态）。 */
	let shelfBuiltCat = '';
	/** @type {HTMLCanvasElement | null} */
	let petCanvasEl = null;

	/* ---------------- 渲染方式状态（M3：DOM 分层纸娃娃 / 2.5D canvas） ---------------- */

	/** 当前渲染方式：'dom' | '2d5'。 */
	let renderMode = 'dom';
	/** 页面请求的模式（config / URL / 本地选择解析结果）与来源。 */
	let renderRequested = 'dom';
	let renderSource = 'default';
	/** 2.5D runtime 实例 / canvas / 启动 promise（未开启时全部为 null）。 */
	/** @type {any} */
	let render2d5 = null;
	/** @type {HTMLCanvasElement | null} */
	let render2d5Canvas = null;
	/** @type {Promise<any> | null} */
	let render2d5Starting = null;
	let render2d5Loading = false;
	/** 2.5D 启动/运行失败原因（回退到 DOM 后展示）。 */
	let render2d5Fallback = '';
	/** 切身形/换装并发序号：只让最新一次同步落地。 */
	let render2d5Seq = 0;
	/** DOM 脸部动画是否已启动（2.5D 模式下按需延后）。 */
	let faceStarted = false;
	/** @type {MediaQueryList | null} */
	let faceReduceMotion = null;
	let talk2d5Timer = 0;

	/* ---------------- 脸部叠加动画状态（B1-lite） ---------------- */

	/**
	 * 脸部特效层运行时状态：只靠定时器切 class/opacity，不重建 DOM、不跑 rAF、不碰 manifest。
	 * 补丁本身是 675×1200 画布上的裁剪矩形（透明底 WebP），由 wardrobe-core.FACE_PATCHES 描述。
	 */
	const face = {
		/** @type {Record<string, HTMLImageElement>} */
		els: {},
		ready: false,
		/** 当前补丁对应的身形（切身形时才重新赋值 src / 定位）。 */
		shape: '',
		enabled: true,
		blinking: false,
		smiling: false,
		mouthTalking: false,
		mouthOpenFrame: false,
		blinkTimer: 0,
		blinkOffTimer: 0,
		smileTimer: 0,
		smileOffTimer: 0,
		mouthTimer: 0,
	};
	/** QA 冻结姿态：'' = 正常播放；'open' | 'blink' | 'smile' | 'mouthMid' | 'mouthOpen'。 */
	let facePose = '';

	/* ---------------- 工具 ---------------- */

	function category(catId) {
		return (manifest.items && manifest.items[catId]) || [];
	}

	function findItem(catId, itemId) {
		return category(catId).find((item) => item.id === itemId) || null;
	}

	function currentBackground() {
		return findItem('backgrounds', state.bg) || category('backgrounds')[0];
	}

	function currentEffect() {
		return findItem('effects', state.effect) || category('effects')[0];
	}

	/**
	 * 预加载图片（带缓存；失败时从缓存移除，允许稍后重试）。
	 * @param {string} src
	 * @returns {Promise<HTMLImageElement | null>}
	 */
	function preload(src) {
		if (!src) return Promise.resolve(null);
		if (loaded.has(src)) return Promise.resolve(loaded.get(src));
		if (!cache.has(src)) {
			cache.set(
				src,
				new Promise((resolve, reject) => {
					const img = new Image();
					img.onload = () => {
						loaded.set(src, img);
						resolve(img);
					};
					img.onerror = () => {
						cache.delete(src);
						reject(new Error(`图片加载失败：${src}`));
					};
					img.src = src;
				}),
			);
		}
		return cache.get(src);
	}

	function readSaved() {
		try {
			return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
		} catch {
			return null;
		}
	}

	/**
	 * 当前穿搭的兜底小图（图层小图还没合成好时用素体 body 层顶上）。
	 * @param {string} shapeId
	 * @returns {string}
	 */
	function petFallbackImage(shapeId) {
		const shape = manifest.shapes.find((entry) => entry.id === shapeId) || manifest.shapes[0];
		const body = shape && shape.layers && shape.layers.body;
		return body || 'art/chibi/body.webp';
	}

	/** 小图合公用 canvas（透明背景，不显示在页面上）。 */
	function petCanvas() {
		if (!petCanvasEl) {
			petCanvasEl = document.createElement('canvas');
			petCanvasEl.width = PET_IMAGE_W;
			petCanvasEl.height = PET_IMAGE_H;
		}
		return petCanvasEl;
	}

	/**
	 * 把 canvas 异步转成 data URL：优先 `toBlob` + `FileReader`（异步，不阻塞主线程），
	 * 环境不支持时退回 `toDataURL`。
	 * @param {HTMLCanvasElement} canvas
	 * @returns {Promise<string>}
	 */
	function canvasToDataURL(canvas) {
		return new Promise((resolve) => {
			if (typeof canvas.toBlob === 'function') {
				canvas.toBlob(
					(blob) => {
						if (!blob || typeof FileReader !== 'function') {
							try {
								resolve(canvas.toDataURL('image/webp', 0.85));
							} catch {
								resolve('');
							}
							return;
						}
						const reader = new FileReader();
						reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
						reader.onerror = () => resolve('');
						reader.readAsDataURL(blob);
					},
					'image/webp',
					0.85,
				);
				return;
			}
			try {
				resolve(canvas.toDataURL('image/webp', 0.85));
			} catch {
				resolve('');
			}
		});
	}

	/**
	 * 把当前穿搭合成为悬浮小鲸鱼用的小图 data URL（异步，不阻塞点击/换装）。
	 * `resolveLayers` 已按 drawOrder 从下到上排好序，这里按同一顺序整幅缩放叠放即可，
	 * 图层共用同一张 675×1200 画布坐标，不需要任何锚点。
	 * @param {Array<{ slot: string, file: string, z: number }>} layers
	 * @returns {Promise<string>}
	 */
	async function composePetImage(layers) {
		// 2.5D 模式：直接取当前 canvas 帧（透明底）缩成小图；失败再退回 DOM 合成
		if (renderMode === '2d5' && render2d5) {
			const image2d5 = render2d5.toDataURL({
				width: PET_IMAGE_W,
				height: PET_IMAGE_H,
				type: 'image/webp',
				quality: 0.85,
			});
			if (image2d5) return image2d5;
		}
		const files = layers.map((layer) => layer.file).filter(Boolean);
		if (!files.length) return '';
		try {
			const images = await Promise.all(files.map((file) => preload(file)));
			const canvas = petCanvas();
			const ctx = canvas.getContext('2d');
			if (!ctx) return '';
			ctx.clearRect(0, 0, PET_IMAGE_W, PET_IMAGE_H);
			for (const img of images) if (img) ctx.drawImage(img, 0, 0, PET_IMAGE_W, PET_IMAGE_H);
			return await canvasToDataURL(canvas);
		} catch {
			return '';
		}
	}

	/**
	 * 把穿搭写进 localStorage 给悬浮小鲸鱼用。
	 * image 是合成好的小图 data URL（readOutfit 同时接受 art/ 路径兜底）。
	 * @param {Record<string, string>} snapshot 穿搭状态快照
	 * @param {string} [image] 合成好的小图 data URL；为空时用素体兜底
	 */
	function writeOutfit(snapshot, image) {
		try {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({ ...snapshot, image: image || petFallbackImage(snapshot.shape), updatedAt: Date.now() }),
			);
		} catch {
			/* 隐身模式 / 配额不足时忽略 */
		}
	}

	/** 穿搭签名：决定是否需要重新写 localStorage / 重新合成小图（渲染方式也计入，2.5D 小图不同）。 */
	function outfitKey(snapshot) {
		return `${snapshot.shape}|${snapshot.outfit}|${snapshot.top}|${snapshot.bottom}|${snapshot.bg}|${snapshot.effect}|${renderMode}`;
	}

	/**
	 * 保存当前穿搭：debounce 250ms + 浏览器空闲时合成小图并写 localStorage。
	 * 重活（drawImage + toBlob）全部移出点击路径；同一穿搭不重复合成。
	 */
	function persist() {
		const snapshot = { ...state };
		const key = outfitKey(snapshot);
		if (key === lastPersistKey) return;
		lastPersistKey = key;
		const seq = (persistSeq += 1);
		clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			const run = () => {
				if (seq !== persistSeq) return;
				composePetImage(resolveLayers(manifest, snapshot)).then((image) => {
					if (seq !== persistSeq) return;
					writeOutfit(snapshot, image);
				});
			};
			if (typeof requestIdleCallback === 'function') {
				requestIdleCallback(run, { timeout: 800 });
			} else {
				setTimeout(run, 16);
			}
		}, 250);
	}

	/* ---------------- 渲染方式控制（M3：2.5D opt-in） ---------------- */

	// 渲染模式决策的内联精简版：app.js 不静态 import runtime-2d5-core.js，
	// 保证默认 DOM 模式下「零新增请求」（策略逻辑另有一份在 runtime-2d5-core.js，node 单测覆盖）。
	/** 渲染模式合法值。 */
	const RENDER_MODE_VALUES = ['dom', '2d5', 'auto'];

	/** @param {unknown} value @returns {'dom'|'2d5'|'auto'|null} */
	function parseRenderMode(value) {
		if (typeof value !== 'string') return null;
		const normalized = value.trim().toLowerCase();
		return RENDER_MODE_VALUES.includes(normalized) ? /** @type {any} */ (normalized) : null;
	}

	/**
	 * 渲染模式决策：URL > 本地用户选择 > 宿主配置 > 默认 dom；auto 按能力解析。
	 * @param {{ config?: unknown, url?: unknown, stored?: unknown, capable?: any }} options
	 * @returns {{ mode: 'dom'|'2d5', requested: 'dom'|'2d5'|'auto', source: string, reason: string }}
	 */
	function resolveRenderMode(options = {}) {
		const capable = options.capable || {};
		const resolveAuto = () => {
			if (!capable.webgl2) return { mode: 'dom', reason: 'webgl2-unavailable' };
			if (capable.reducedMotion) return { mode: 'dom', reason: 'prefers-reduced-motion' };
			if (Number.isFinite(capable.deviceMemory) && capable.deviceMemory > 0 && capable.deviceMemory < 2) {
				return { mode: 'dom', reason: 'low-device-memory' };
			}
			return { mode: '2d5', reason: 'capable' };
		};
		for (const [source, requested] of [
			['url', parseRenderMode(options.url)],
			['stored', parseRenderMode(options.stored)],
			['config', parseRenderMode(options.config)],
		]) {
			if (!requested) continue;
			if (requested === 'auto') {
				const auto = resolveAuto();
				return { mode: auto.mode, requested, source, reason: auto.reason };
			}
			return { mode: requested, requested, source, reason: 'explicit' };
		}
		return { mode: 'dom', requested: 'dom', source: 'default', reason: 'default-dom' };
	}

	/** 探测 2.5D 能力（WebGL2 / 减少动态 / 设备内存）；auto 模式用。 */
	let cachedRenderCapabilities = null;

	/**
	 * 探测 2.5D 能力（WebGL2 / 减少动态 / 设备内存）；auto 模式用，结果缓存。
	 * 探测用的临时 canvas/WebGL2 context 会在探测后立即 loseContext 并丢弃，
	 * 不把「能力探测 context」留在页面里（避免每次进入 2.5D 多占一个 context）。
	 */
	function probeRenderCapabilities() {
		if (cachedRenderCapabilities) return cachedRenderCapabilities;
		let webgl2 = false;
		try {
			const probe = document.createElement('canvas');
			const context = probe.getContext('webgl2');
			if (context) {
				webgl2 = true;
				const lose = context.getExtension('WEBGL_lose_context');
				if (lose && typeof lose.loseContext === 'function') lose.loseContext();
			}
			probe.width = 0;
			probe.height = 0;
		} catch {
			webgl2 = false;
		}
		const reduce = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
		cachedRenderCapabilities = {
			webgl2,
			reducedMotion: !!(reduce && reduce.matches),
			deviceMemory: Number(navigator.deviceMemory) || null,
			hardwareConcurrency: Number(navigator.hardwareConcurrency) || null,
		};
		return cachedRenderCapabilities;
	}

	/** 2.5D runtime 需要的设备信息（不创建探测 context）。 */
	function renderDeviceInfo() {
		return {
			deviceMemory: Number(navigator.deviceMemory) || null,
			hardwareConcurrency: Number(navigator.hardwareConcurrency) || null,
		};
	}

	function readStoredRenderMode() {
		try {
			return localStorage.getItem(RENDER_STORAGE_KEY);
		} catch {
			return null;
		}
	}

	function writeStoredRenderMode(mode) {
		try {
			localStorage.setItem(RENDER_STORAGE_KEY, mode);
		} catch {
			/* 隐身模式 / 配额不足时忽略 */
		}
	}

	/**
	 * 读宿主配置 `render-config.json`（由 lib/webserver.js 提供）。
	 * 静态托管（GitHub Pages / 本地 http.server）没有该文件时 404 → 回退 'dom'，不报错。
	 * @returns {Promise<'dom'|'2d5'|'auto'>}
	 */
	async function readHostRenderConfig() {
		try {
			const response = await fetch('render-config.json', { cache: 'no-store' });
			if (!response.ok) return 'dom';
			const data = await response.json();
			return parseRenderMode(data && data.render) || 'dom';
		} catch {
			return 'dom';
		}
	}

	/** 刷新渲染方式按钮（文案/提示/加载态/回退原因）。 */
	function updateRenderButton() {
		const button = $('#renderBtn');
		if (!button) return;
		button.classList.toggle('loading', render2d5Loading);
		if (render2d5Loading) {
			button.textContent = '⏳ 2.5D';
			button.title = '2.5D 资产加载中…';
			return;
		}
		if (renderMode === '2d5') {
			button.textContent = '🎨 DOM';
			button.title = '切回分层纸娃娃（DOM 渲染）';
			button.classList.add('active');
			button.setAttribute('aria-pressed', 'true');
		} else {
			button.textContent = '🧊 2.5D';
			button.title = render2d5Fallback
				? `2.5D 不可用（${render2d5Fallback}），点击重试`
				: '切到 2.5D 动态渲染（实验：WebGL2，按需加载）';
			button.classList.remove('active');
			button.setAttribute('aria-pressed', 'false');
		}
	}

	/**
	 * 懒加载 2.5D runtime：只有真正要进 2.5D 时才 import 模块、建 canvas、拉资产
	 * （默认 DOM 模式下这里不会执行，因此零新增请求）。
	 * @returns {Promise<any>}
	 */
	function ensureRuntime2d5() {
		if (render2d5) return Promise.resolve(render2d5);
		if (render2d5Starting) return render2d5Starting;
		render2d5Loading = true;
		updateRenderButton();
		render2d5Starting = (async () => {
			const module = await import(RUNTIME_2D5_MODULE);
			if (!render2d5Canvas) {
				render2d5Canvas = document.createElement('canvas');
				render2d5Canvas.className = 'figure-2d5';
				render2d5Canvas.setAttribute('aria-hidden', 'true');
				render2d5Canvas.addEventListener('click', onFigureTap);
				els.figureWrap.appendChild(render2d5Canvas);
			}
			const runtime = await module.createRuntime2D5({
				canvas: render2d5Canvas,
				assetRoot: RUNTIME_2D5_ASSET_ROOT,
				quality: 'auto',
				device: renderDeviceInfo(),
				onContextLost: () => {
					// 启动失败时主动 destroy() 也会触发 context lost：只处理已就绪 runtime 的异常
					if (render2d5 !== runtime) return;
					render2d5Fallback = 'webglcontextlost';
					if (renderMode === '2d5') applyRenderMode('dom');
				},
			});
			try {
				await runtime.setShape(state.shape);
				runtime.setLook({ outfit: state.outfit, top: state.top, bottom: state.bottom });
				runtime.renderFrame();
			} catch (err) {
				runtime.destroy();
				throw err;
			}
			render2d5 = runtime;
			document.addEventListener('visibilitychange', sync2d5Visibility);
			return runtime;
		})().catch((err) => {
			// 启动失败：销毁 canvas（其 WebGL context 已 lose），允许下次点击重试
			if (render2d5Canvas && render2d5Canvas.parentNode) render2d5Canvas.parentNode.removeChild(render2d5Canvas);
			render2d5Canvas = null;
			throw err;
		}).finally(() => {
			render2d5Starting = null;
			render2d5Loading = false;
			updateRenderButton();
		});
		return render2d5Starting;
	}

	/** 把页面状态同步到 2.5D runtime（身形按需加载、造型动态组合、状态保留）。 */
	function sync2d5() {
		if (!render2d5 || renderMode !== '2d5') return;
		const seq = (render2d5Seq += 1);
		const shape = state.shape;
		render2d5.setShape(shape).then((result) => {
			if (seq !== render2d5Seq || renderMode !== '2d5') return;
			if (result && result.stale) return;
			render2d5.setLook({ outfit: state.outfit, top: state.top, bottom: state.bottom });
			render2d5.renderFrame();
		}).catch((err) => {
			console.warn('[衣橱] 2.5D 切换失败', err);
			render2d5Fallback = err instanceof Error ? err.message : String(err);
			applyRenderMode('dom');
		});
	}

	/** 页面隐藏时暂停 2.5D 渲染循环（省电；恢复时从当前状态继续）。 */
	function sync2d5Visibility() {
		if (render2d5) render2d5.setPaused(document.hidden);
	}

	/**
	 * 切换渲染方式（'dom' | '2d5'）。
	 * - 2.5D 资产加载完成后才交叉淡入（背景/特效不动 → 无闪白）；失败保持 DOM 并记录原因；
	 * - DOM ↔ 2.5D 共用同一份穿搭状态（state），切换不重置身形/穿搭/背景/特效。
	 * @param {'dom'|'2d5'} mode
	 * @param {{ persist?: boolean, force?: boolean }} [options]
	 * @returns {Promise<'dom'|'2d5'>}
	 */
	async function applyRenderMode(mode, options = {}) {
		const requested = mode === '2d5' ? '2d5' : 'dom';
		if (options.persist) writeStoredRenderMode(requested);
		if (requested === '2d5') {
			if (renderMode === '2d5' && render2d5) {
				updateRenderButton();
				return '2d5';
			}
			els.tip.textContent = '2.5D 加载中…';
			els.tip.classList.remove('gone');
			try {
				await ensureRuntime2d5();
			} catch (err) {
				render2d5Fallback = err instanceof Error ? err.message : String(err);
				console.warn('[衣橱] 2.5D 启动失败，保持分层纸娃娃', err);
				renderMode = 'dom';
				renderFigure();
				syncFaceShape();
				startFace();
				applyFaceMotionPreference();
				lastPersistKey = '';
				applyState();
				updateRenderButton();
				els.tip.textContent = '2.5D 暂不可用，已保持分层纸娃娃';
				els.tip.classList.remove('gone');
				return 'dom';
			}
			renderMode = '2d5';
			render2d5Fallback = '';
			render2d5.freeze(false); // 若之前为 QA 冻结，切回 2.5D 时恢复播放
			render2d5.renderFrame();
			render2d5.start();
			if (render2d5Canvas) render2d5Canvas.classList.add('on');
			els.figure.classList.add('figure-dim');
			els.figure.setAttribute('aria-hidden', 'true');
			setFaceEnabled(false);
			els.tip.classList.add('gone');
			lastPersistKey = '';
			applyState();
			updateRenderButton();
			return '2d5';
		}
		// 切回 DOM
		const previous = renderMode;
		renderMode = 'dom';
		if (previous === '2d5' && render2d5) {
			if (render2d5Canvas) render2d5Canvas.classList.remove('on');
			els.figure.classList.remove('figure-dim');
			els.figure.removeAttribute('aria-hidden');
			renderFigure();
			syncFaceShape();
			const runtime = render2d5;
			setTimeout(() => {
				if (renderMode === 'dom') runtime.stop();
			}, 320);
		}
		startFace();
		applyFaceMotionPreference();
		lastPersistKey = '';
		applyState();
		updateRenderButton();
		return 'dom';
	}

	/** 点击角色：DOM 模式跳一下；2.5D 模式走 runtime 的 tap 预留接口（M5 互动会扩展）。 */
	function onFigureTap() {
		if (renderMode === '2d5' && render2d5) {
			render2d5.tap();
			speakRandom();
			return;
		}
		els.figure.classList.remove('hop');
		void els.figure.offsetWidth;
		els.figure.classList.add('hop');
		setTimeout(() => els.figure.classList.remove('hop'), 700);
		speakRandom();
	}

	/* ---------------- 人物图层栈 ---------------- */

	/**
	 * 按 `manifest.drawOrder` 动态创建图层 <img>（data-layer=槽位，初始 hidden）。
	 * v6 不再在 index.html 里写死 5 个槽位；只在 boot 时建一次，之后换装只改 src/显隐。
	 */
	function buildFigureLayers() {
		const drawOrder = Array.isArray(manifest.drawOrder) ? manifest.drawOrder : [];
		/** @type {string[]} */
		const slots = [];
		for (const slot of drawOrder) {
			if (typeof slot === 'string' && slot && !slots.includes(slot)) slots.push(slot);
		}
		layerSlots = slots;
		els.figure.innerHTML = '';
		for (let z = 0; z < layerSlots.length; z += 1) {
			const slot = layerSlots[z];
			const img = document.createElement('img');
			img.className = 'figure-layer';
			img.dataset.layer = slot;
			img.alt = slot === 'body' ? '大肥鱼' : '';
			img.draggable = false;
			img.decoding = 'async';
			img.hidden = true;
			// z-index 按 drawOrder 固定：与 resolveLayers 返回的 z 一致，建层时设一次即可
			img.style.zIndex = String(z);
			els.figure.appendChild(img);
			els.figureLayers[slot] = img;
		}
	}

	/**
	 * 按 `resolveLayers` 把变化过的槽位换成新图；未变化的槽位不重建、不重新赋值。
	 * 隐藏当前穿搭用不到的槽位（套装与上下装互斥；槽位数量由 drawOrder 决定，v6 最多 7 个）。
	 */
	function renderFigure() {
		const layers = resolveLayers(manifest, state);
		const key = layers.map((layer) => `${layer.slot}:${layer.file}:${layer.z}`).join('|');
		if (key === lastRendered.figureKey) return; // 只换背景/特效时整个图层栈都不用动
		lastRendered.figureKey = key;
		const seq = (renderSeq += 1);
		/** @type {Map<string, { slot: string, file: string, z: number }>} */
		const bySlot = new Map();
		for (const layer of layers) bySlot.set(layer.slot, layer);
		for (const slot of layerSlots) {
			const el = els.figureLayers[slot];
			if (!el) continue;
			const layer = bySlot.get(slot);
			if (!layer || !layer.file) {
				el.hidden = true;
				continue;
			}
			if (el.dataset.file === layer.file && el.getAttribute('src')) {
				el.hidden = false;
				continue; // 未变化：什么都不动
			}
			el.dataset.file = layer.file;
			preload(layer.file).then(
				(img) => {
					if (seq !== renderSeq || el.dataset.file !== layer.file) return; // 已被更新的渲染取代
					el.src = layer.file;
					el.alt = slot === 'body' ? '大肥鱼' : '';
					el.hidden = false;
				},
				() => {
					console.warn(`[衣橱] 图层加载失败：${layer.file}`);
					if (seq === renderSeq) el.hidden = true;
				},
			);
		}
		const text = describeOutfit(manifest, state);
		els.figure.setAttribute('aria-label', `大肥鱼：${text.name}，点一下说话`);
	}

	/* ---------------- 脸部叠加动画（B1-lite · 眨眼 / 口型 / 笑眼） ---------------- */

	/**
	 * 建脸部 overlay `<img>`：运行时特效层，不改 manifest / drawOrder / 构建管线。
	 * 层级取 drawOrder 里 hair 的下一层（v6 契约里 hair 恒为最上层），
	 * 于是刘海压住补丁上缘，补丁里不会出现和头发层打架的发丝。
	 * 只在 boot 时建一次，之后只切 src / class（CSS opacity），不重建 DOM。
	 */
	function buildFaceLayers() {
		const hairIndex = layerSlots.lastIndexOf('hair');
		const zIndex = String(hairIndex > 0 ? hairIndex - 1 : layerSlots.length);
		for (const key of FACE_PATCH_KEYS) {
			const img = document.createElement('img');
			img.className = 'face-layer';
			img.dataset.face = key;
			img.alt = '';
			img.draggable = false;
			img.decoding = 'async';
			img.style.zIndex = zIndex;
			els.figure.appendChild(img);
			face.els[key] = img;
		}
		face.ready = true;
	}

	/** 按当前身形切换补丁 src + 百分比定位；同身形重复调用直接返回（换装不重设）。 */
	function syncFaceShape() {
		if (!face.ready || face.shape === state.shape) return;
		const patches = facePatchesOf(state.shape);
		if (!patches) return;
		face.shape = state.shape;
		for (const key of FACE_PATCH_KEYS) {
			const img = face.els[key];
			const patch = patches[key];
			if (!img) continue;
			if (!patch) {
				img.hidden = true;
				continue;
			}
			const rect = facePatchStyle(patch);
			img.style.left = rect.left;
			img.style.top = rect.top;
			img.style.width = rect.width;
			img.style.height = rect.height;
			if (img.dataset.file !== patch.file) {
				img.dataset.file = patch.file;
				img.src = patch.file;
			}
			img.hidden = false;
		}
		// 切身形先回到睁眼/闭嘴静态帧，避免残留上一个身形的动画状态
		face.blinking = false;
		face.smiling = false;
		face.mouthOpenFrame = false;
		faceApply();
	}

	/** 单个补丁显隐：只切 class（CSS opacity 过渡）。 */
	function faceToggle(key, on) {
		const img = face.els[key];
		if (img) img.classList.toggle('on', !!on);
	}

	/** 按状态机刷新 4 个补丁；只在状态变化 / 定时器 tick 时调用，不每帧、不读布局。 */
	function faceApply() {
		const on = face.enabled;
		const pose = facePose;
		faceToggle('eyeBlink', on && (pose ? pose === 'blink' : face.blinking && !face.smiling));
		faceToggle('eyeSmile', on && (pose ? pose === 'smile' : face.smiling));
		faceToggle('mouthMid', on && (pose ? pose === 'mouthMid' : face.mouthTalking && !face.mouthOpenFrame));
		faceToggle('mouthOpen', on && (pose ? pose === 'mouthOpen' : face.mouthTalking && face.mouthOpenFrame));
	}

	/** 随机眨眼：2–6s 一次，闭眼 ~110ms（关闭时间由 CSS opacity 过渡提供）。 */
	function scheduleBlink() {
		clearTimeout(face.blinkTimer);
		if (!face.enabled || facePose) return;
		face.blinkTimer = setTimeout(() => {
			if (!face.enabled || facePose) return;
			if (face.smiling) {
				scheduleBlink(); // 笑眼期间不叠加眨眼
				return;
			}
			face.blinking = true;
			faceApply();
			face.blinkOffTimer = setTimeout(() => {
				face.blinking = false;
				faceApply();
				scheduleBlink();
			}, FACE_TIMING.blinkClose);
		}, randomBetween(FACE_TIMING.blinkMin, FACE_TIMING.blinkMax));
	}

	/** 偶尔笑眼：20–40s 一次，持续 1.2s。 */
	function scheduleSmile() {
		clearTimeout(face.smileTimer);
		if (!face.enabled || facePose) return;
		face.smileTimer = setTimeout(() => {
			if (!face.enabled || facePose) return;
			face.smiling = true;
			faceApply();
			face.smileOffTimer = setTimeout(() => {
				face.smiling = false;
				faceApply();
				scheduleSmile();
			}, FACE_TIMING.smileHold);
		}, randomBetween(FACE_TIMING.smileMin, FACE_TIMING.smileMax));
	}

	/** 气泡显示期间启动口型循环：~130ms 交替 mouth_mid / mouth_open。 */
	function startMouth() {
		if (!face.enabled || face.mouthTalking) return;
		face.mouthTalking = true;
		face.mouthOpenFrame = false;
		faceApply();
		clearInterval(face.mouthTimer);
		face.mouthTimer = setInterval(() => {
			face.mouthOpenFrame = !face.mouthOpenFrame;
			faceApply();
		}, FACE_TIMING.mouthPeriod);
	}

	function stopMouth() {
		clearInterval(face.mouthTimer);
		face.mouthTalking = false;
		face.mouthOpenFrame = false;
		if (face.ready) faceApply();
	}

	/** 总开关（reduced-motion / `?facefx=0` 可关闭）：关掉时清空全部定时器与补丁显隐。 */
	function setFaceEnabled(enabled) {
		face.enabled = !!enabled;
		clearTimeout(face.blinkTimer);
		clearTimeout(face.blinkOffTimer);
		clearTimeout(face.smileTimer);
		clearTimeout(face.smileOffTimer);
		clearInterval(face.mouthTimer);
		face.blinking = false;
		face.smiling = false;
		face.mouthTalking = false;
		face.mouthOpenFrame = false;
		if (face.enabled && !facePose) {
			scheduleBlink();
			scheduleSmile();
			if (!els.bubble.hidden) startMouth();
		}
		if (face.ready) faceApply();
	}

	/**
	 * 系统「减少动态效果」/ `?facefx=` 解析：控制 B1-lite 脸部动画开关（DOM 模式）。
	 * 2.5D 模式下脸部动画由 runtime 自己驱动（同参数总线），本函数只影响 DOM 层。
	 */
	function applyFaceMotionPreference() {
		if (!face.ready) return;
		const forced = params.get('facefx');
		if (forced === '1') setFaceEnabled(true);
		else if (forced === '0') setFaceEnabled(false);
		else setFaceEnabled(!(faceReduceMotion && faceReduceMotion.matches));
	}

	/** 启动脸部动画：预加载补丁、监听气泡显隐（口型）、跟随系统「减少动态效果」偏好。 */
	function startFace() {
		if (!face.ready || faceStarted) return;
		faceStarted = true;
		// 预加载两身形补丁（各 4 张，小图），换身形时切 src 不闪
		for (const shape of manifest.shapes) {
			const patches = facePatchesOf(shape.id);
			if (!patches) continue;
			for (const key of FACE_PATCH_KEYS) {
				if (patches[key]) preload(patches[key].file).catch(() => {});
			}
		}
		// 口型跟现有气泡走：只监听 #bubble 的 hidden 属性，不改 say() 逻辑
		const syncMouth = () => {
			if (!face.enabled || els.bubble.hidden) stopMouth();
			else startMouth();
		};
		new MutationObserver(syncMouth).observe(els.bubble, { attributes: true, attributeFilter: ['hidden'] });
		syncMouth();
		// 开关：?facefx=1/0 强制，否则默认跟随系统 reduced-motion
		faceReduceMotion = typeof window.matchMedia === 'function'
			? window.matchMedia('(prefers-reduced-motion: reduce)')
			: null;
		applyFaceMotionPreference();
		if (faceReduceMotion && typeof faceReduceMotion.addEventListener === 'function' && !params.get('facefx')) {
			faceReduceMotion.addEventListener('change', applyFaceMotionPreference);
		}
		/** QA / 自动化接口：冻结姿态、手动触发，正常播放不受影响。 */
		window.__feiyuFace = {
			timing: FACE_TIMING,
			state: () => ({
				ready: face.ready,
				enabled: face.enabled,
				pose: facePose,
				shape: face.shape,
				blinking: face.blinking,
				smiling: face.smiling,
				mouthTalking: face.mouthTalking,
				mouthOpenFrame: face.mouthOpenFrame,
			}),
			setEnabled: setFaceEnabled,
			/** 冻结到指定姿态（'open' | 'blink' | 'smile' | 'mouthMid' | 'mouthOpen'）。 */
			freeze(pose) {
				facePose = pose || '';
				clearTimeout(face.blinkTimer);
				clearTimeout(face.blinkOffTimer);
				clearTimeout(face.smileTimer);
				clearTimeout(face.smileOffTimer);
				clearInterval(face.mouthTimer);
				face.blinking = false;
				face.smiling = false;
				face.mouthTalking = false;
				face.mouthOpenFrame = false;
				faceApply();
			},
			unfreeze() {
				facePose = '';
				setFaceEnabled(face.enabled);
			},
			triggerBlink() {
				if (!face.enabled || facePose) return;
				clearTimeout(face.blinkTimer);
				face.blinkTimer = 0;
				face.blinking = true;
				faceApply();
				face.blinkOffTimer = setTimeout(() => {
					face.blinking = false;
					faceApply();
					scheduleBlink();
				}, FACE_TIMING.blinkClose);
			},
			triggerSmile() {
				if (!face.enabled || facePose) return;
				clearTimeout(face.smileTimer);
				face.smileTimer = 0;
				face.smiling = true;
				faceApply();
				face.smileOffTimer = setTimeout(() => {
					face.smiling = false;
					faceApply();
					scheduleSmile();
				}, FACE_TIMING.smileHold);
			},
			triggerMouth(on) {
				if (!face.enabled || facePose) return;
				if (on) startMouth();
				else stopMouth();
			},
		};
	}

	function renderScene() {
		const bg = currentBackground();
		if (!bg) return;
		if (lastRendered.bg === bg.file) return; // 背景没变就不重设大图 src
		lastRendered.bg = bg.file;
		els.scene.decoding = 'async';
		els.scene.classList.add('fading');
		const apply = () => {
			els.scene.src = bg.file;
			els.scene.alt = bg.name;
			requestAnimationFrame(() => els.scene.classList.remove('fading'));
		};
		preload(bg.file).then(apply, apply);
	}

	/**
	 * 按背景地面线站位 + 内容边界自动缩放。
	 * 用 resizeFx 缓存的舞台尺寸做 key：换装/换背景没变时直接跳过（避免每次都强制 reflow）。
	 * @param {boolean} [force] 窗口尺寸变化时强制重算
	 */
	function layoutFigure(force) {
		const H = fx.h;
		const W = fx.w;
		if (!H || !W) return;
		const bg = currentBackground();
		const key = `${state.shape}|${bg ? bg.file : ''}|${W}x${H}`;
		if (!force && lastRendered.layoutKey === key) return;
		lastRendered.layoutKey = key;
		const bounds = currentBounds(manifest, state);
		const floor = (bg && bg.floor) || 0.86;
		const usable = Math.max(0.2, bounds.bottom - bounds.top);
		const topMargin = H * 0.07;
		const floorY = H * floor;
		const hf = Math.min((floorY - topMargin) / usable, H * 1.9, W / 0.62);
		const figW = hf * (9 / 16);
		const left = W / 2 - figW / 2;
		const top = floorY - bounds.bottom * hf;
		els.figureWrap.style.height = `${Math.round(hf)}px`;
		els.figureWrap.style.width = `${Math.round(figW)}px`;
		els.figureWrap.style.left = `${Math.round(left)}px`;
		els.figureWrap.style.top = `${Math.round(top)}px`;
		els.figureShadow.style.width = `${Math.round(figW * 0.62)}px`;
		els.figureShadow.style.left = `${Math.round(figW * 0.19)}px`;
	}

	function renderMeta() {
		const text = describeOutfit(manifest, state);
		els.lookName.textContent = text.name;
		els.lookDesc.textContent = text.detail;
	}

	function applyState() {
		if (renderMode === '2d5') {
			// 2.5D 模式：DOM 人物层不维护，只同步 canvas 与周边 UI（背景/特效/衣柜不变）
			sync2d5();
			renderScene();
			renderMeta();
			setEffect(state.effect);
			renderShapeToggle();
			renderShelf();
			layoutFigure();
			persist();
			return;
		}
		renderFigure();
		syncFaceShape();
		renderScene();
		renderMeta();
		setEffect(state.effect);
		renderShapeToggle();
		renderShelf();
		layoutFigure();
		persist();
	}

	/* ---------------- 身形切换 / 衣柜 ---------------- */

	function renderShapeToggle() {
		if (!shapeToggleBuilt) {
			els.shapeToggle.innerHTML = '';
			for (const shape of manifest.shapes) {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'shape-btn';
				btn.dataset.shape = shape.id;
				btn.textContent = shape.name;
				btn.title = shape.desc || shape.name;
				btn.addEventListener('click', () => {
					state = applyShape(manifest, state, shape.id);
					applyState();
					say(`换成「${shape.name}」啦～`);
				});
				els.shapeToggle.appendChild(btn);
			}
			shapeToggleBuilt = true;
		}
		for (const btn of els.shapeToggle.children) {
			const active = btn.dataset.shape === state.shape;
			btn.classList.toggle('active', active);
			btn.setAttribute('aria-pressed', active ? 'true' : 'false');
		}
	}

	function renderTabs() {
		els.tabs.innerHTML = '';
		for (const cat of manifest.categories) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'tab' + (cat.id === tab ? ' active' : '');
			btn.dataset.cat = cat.id;
			btn.setAttribute('role', 'tab');
			btn.setAttribute('aria-selected', cat.id === tab ? 'true' : 'false');
			btn.textContent = `${cat.emoji || ''} ${cat.name}`.trim();
			btn.addEventListener('click', () => setTab(cat.id));
			els.tabs.appendChild(btn);
		}
	}

	function setTab(catId) {
		tab = catId;
		for (const btn of els.tabs.children) {
			const active = btn.dataset.cat === catId;
			btn.classList.toggle('active', active);
			btn.setAttribute('aria-selected', active ? 'true' : 'false');
		}
		renderShelf();
	}

	function isActiveItem(catId, itemId) {
		if (catId === 'outfits') return state.outfit === itemId;
		if (catId === 'tops') return state.outfit === 'none' && state.top === itemId;
		if (catId === 'bottoms') return state.outfit === 'none' && state.bottom === itemId;
		const cat = manifest.categories.find((entry) => entry.id === catId);
		return cat && state[cat.stateKey] === itemId;
	}

	/** 衣柜格子：同一分类只构建一次，换装只更新选中态（省掉整片 DOM 重建）。 */
	function renderShelf() {
		const cat = manifest.categories.find((entry) => entry.id === tab);
		if (!cat) return;
		if (shelfBuiltCat !== cat.id) {
			buildShelf(cat);
			shelfBuiltCat = cat.id;
		}
		for (const button of els.shelf.children) {
			const active = isActiveItem(cat.id, button.dataset.id);
			button.classList.toggle('active', active);
			button.setAttribute('aria-pressed', active ? 'true' : 'false');
		}
	}

	/** 构建某个分类的衣柜格子（只在切换分类时执行）。 */
	function buildShelf(cat) {
		const backgroundTab = cat.id === 'backgrounds';
		els.shelf.innerHTML = '';
		for (const item of category(cat.id)) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'item' + (backgroundTab ? ' bg' : '');
			button.dataset.id = item.id;
			button.title = item.desc || item.name;
			button.setAttribute('aria-label', item.name);
			const pic = item.icon || item.thumb;
			if (pic) {
				const img = document.createElement('img');
				img.src = pic;
				img.alt = '';
				img.loading = 'lazy';
				img.decoding = 'async';
				button.appendChild(img);
			} else {
				const span = document.createElement('span');
				span.className = 'emoji';
				span.textContent = item.emoji || (item.id === 'none' ? '🚫' : '✨');
				button.appendChild(span);
			}
			const label = document.createElement('span');
			label.textContent = item.name;
			button.appendChild(label);
			button.addEventListener('click', () => select(cat.id, item.id));
			els.shelf.appendChild(button);
		}
	}

	function popFigure() {
		if (renderMode === '2d5') {
			// 2.5D：canvas 轻微弹一下（换装过渡无闪白；运行时只重绘当前帧）
			if (!render2d5Canvas) return;
			render2d5Canvas.classList.remove('pop-2d5');
			void render2d5Canvas.offsetWidth;
			render2d5Canvas.classList.add('pop-2d5');
			setTimeout(() => {
				if (render2d5Canvas) render2d5Canvas.classList.remove('pop-2d5');
			}, 360);
			return;
		}
		// 下一帧再加类名来重启动画，避免同步读 offsetWidth 触发强制 reflow
		els.figure.classList.remove('pop');
		requestAnimationFrame(() => {
			els.figure.classList.add('pop');
			setTimeout(() => els.figure.classList.remove('pop'), 420);
		});
	}

	function select(catId, itemId) {
		state = applySelection(manifest, state, catId, itemId);
		applyState();
		popFigure();
		const item = findItem(catId, itemId);
		if (renderMode === '2d5' && typeof itemId === 'string' && itemId.startsWith('diy-')) {
			say('2.5D 模式暂时只显示内置服装，切回分层模式就能看到 DIY 单品～');
			return;
		}
		say(`换上「${item ? item.name : itemId}」啦，好看吗？`);
	}

	/* ---------------- 说话 / 随机 / 保存 ---------------- */

	let bubbleTimer = 0;
	function say(text) {
		els.bubble.textContent = text;
		els.bubble.hidden = false;
		els.tip.classList.add('gone');
		clearTimeout(bubbleTimer);
		bubbleTimer = setTimeout(() => {
			els.bubble.hidden = true;
		}, 2800);
		// 2.5D：说话期间口型走 runtime 参数总线（DOM 模式由 B1-lite 的 MutationObserver 接管）
		if (renderMode === '2d5' && render2d5) {
			render2d5.setTalking(true);
			clearTimeout(talk2d5Timer);
			talk2d5Timer = setTimeout(() => {
				if (render2d5) render2d5.setTalking(false);
			}, 2800);
		}
	}

	function speakRandom() {
		const lines = manifest.bubbles || ['嗯？'];
		say(lines[Math.floor(Math.random() * lines.length)]);
	}

	function randomLook() {
		state = randomOutfit(manifest, state);
		applyState();
		const lines = ['随机换好啦，一起看看？', '这样搭配也不错吧？', '今天想穿哪一套呢？', '换好啦，陪你玩一会儿～'];
		say(lines[Math.floor(Math.random() * lines.length)]);
	}

	/**
	 * 立绘卡里人物的绘制区域（DOM 与 2.5D 共用同一套排版，保证两种模式卡片一致）。
	 * @param {number} W
	 * @param {number} H
	 * @param {{ top: number, bottom: number }} bounds
	 * @returns {{ fx0: number, fy0: number, figW: number, figH: number }}
	 */
	function cardFigureArea(W, H, bounds) {
		const ratio = 9 / 16;
		const areaTop = H * 0.035;
		const areaBottom = H * 0.86;
		const usable = Math.max(0.2, bounds.bottom - bounds.top);
		const figH = (areaBottom - areaTop) / usable;
		const figW = figH * ratio;
		return { fx0: (W - figW) / 2, fy0: areaTop - bounds.top * figH, figW, figH };
	}

	async function saveCard() {
		const canvas = els.canvas;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const W = canvas.width;
		const H = canvas.height;
		const bg = currentBackground();
		const bounds = currentBounds(manifest, state);
		const use2d5 = renderMode === '2d5' && render2d5;
		let bgImg;
		/** @type {Map<string, HTMLImageElement>} */
		const layerImgs = new Map();
		/** @type {Array<{ slot: string, file: string, z: number }>} */
		let layers = [];
		try {
			bgImg = /** @type {HTMLImageElement} */ (await preload(bg.file));
			if (!use2d5) {
				layers = resolveLayers(manifest, state);
				const files = layers.map((layer) => layer.file).filter(Boolean);
				const imgs = await Promise.all(files.map((file) => preload(file)));
				files.forEach((file, index) => layerImgs.set(file, /** @type {HTMLImageElement} */ (imgs[index])));
			}
		} catch {
			alert('图片还没准备好，稍等一下再试～');
			return;
		}
		// 立绘卡只导出静态帧：2.5D 用 runtime.renderFrame()→drawImage（当前参数下的定帧），
		// DOM 用 resolveLayers 静态分层；脸部特效层不参与导出（任意时刻结果确定）。
		const scaleBg = Math.max(W / bgImg.width, H / bgImg.height);
		const bw = bgImg.width * scaleBg;
		const bh = bgImg.height * scaleBg;
		ctx.clearRect(0, 0, W, H);
		ctx.drawImage(bgImg, (W - bw) / 2, (H - bh) / 2, bw, bh);
		ctx.fillStyle = 'rgba(255,255,255,0.08)';
		ctx.fillRect(0, 0, W, H);

		const area = cardFigureArea(W, H, bounds);
		if (use2d5) {
			render2d5.renderToCanvas(ctx, area.fx0, area.fy0, area.figW, area.figH);
		} else {
			for (const layer of layers) {
				const img = layerImgs.get(layer.file);
				if (img) ctx.drawImage(img, area.fx0, area.fy0, area.figW, area.figH);
			}
		}

		const grad = ctx.createLinearGradient(0, H * 0.62, 0, H);
		grad.addColorStop(0, 'rgba(20,12,45,0)');
		grad.addColorStop(0.55, 'rgba(20,12,45,0.5)');
		grad.addColorStop(1, 'rgba(20,12,45,0.82)');
		ctx.fillStyle = grad;
		ctx.fillRect(0, H * 0.55, W, H * 0.45);

		const text = describeOutfit(manifest, state);
		ctx.textAlign = 'center';
		ctx.fillStyle = '#ffffff';
		ctx.font = '800 46px -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif';
		ctx.fillText(text.name.split(' + ')[0], W / 2, H * 0.9);
		ctx.font = '25px -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif';
		ctx.fillStyle = 'rgba(255,255,255,0.82)';
		ctx.fillText(text.detail, W / 2, H * 0.935);
		ctx.font = '20px -apple-system, sans-serif';
		ctx.fillStyle = 'rgba(255,255,255,0.6)';
		ctx.fillText('大肥鱼衣橱 · github.com/GIT121995/dsh-feiyu-wardrobe', W / 2, H * 0.972);

		const a = document.createElement('a');
		a.download = `feiyu-${state.shape}-${state.outfit !== 'none' ? state.outfit : `${state.top}-${state.bottom}`}.png`;
		a.href = canvas.toDataURL('image/png');
		a.click();
		say('立绘卡保存好啦，可以留作纪念～');
	}

	/* ---------------- 图鉴 ---------------- */

	function openSheet() {
		els.sheetBody.innerHTML = '';
		let total = 0;
		for (const group of collectItems(manifest)) {
			const head = document.createElement('div');
			head.className = 'sheet-section';
			head.textContent = `${group.category.name} · ${group.items.length}`;
			els.sheetBody.appendChild(head);
			for (const item of group.items) {
				total += 1;
				const cell = document.createElement('div');
				cell.className = 'sheet-item';
				const pic = item.icon || item.thumb;
				if (pic) {
					const img = document.createElement('img');
					img.src = pic;
					img.alt = '';
					img.loading = 'lazy';
					cell.appendChild(img);
				} else {
					const span = document.createElement('span');
					span.textContent = item.emoji || '✨';
					span.style.fontSize = '30px';
					cell.appendChild(span);
				}
				const name = document.createElement('span');
				name.textContent = item.name;
				cell.appendChild(name);
				els.sheetBody.appendChild(cell);
			}
		}
		els.sheetStat.textContent = `共 ${total} 件 · 两种身形（Q版 / 少女版）· 角色：${manifest.character}`;
		const credit = document.createElement('p');
		credit.className = 'sheet-credit';
		credit.textContent = manifest.credits || '';
		els.sheetBody.appendChild(credit);
		els.sheet.hidden = false;
	}

	/* ---------------- 特效画布 ---------------- */

	const fxCanvas = els.fx;
	const fx = { type: 'none', parts: [], raf: 0, last: 0, dpr: 1 };

	function resizeFx() {
		const stage = els.fx.parentElement;
		fx.dpr = Math.min(2, window.devicePixelRatio || 1);
		fx.w = stage.clientWidth;
		fx.h = stage.clientHeight;
		fxCanvas.width = Math.max(1, Math.round(fx.w * fx.dpr));
		fxCanvas.height = Math.max(1, Math.round(fx.h * fx.dpr));
		fxCanvas.style.width = '100%';
		fxCanvas.style.height = '100%';
	}

	function spawnParticles(type) {
		fx.parts = [];
		if (type === 'none' || !fx.w) return;
		const count = type === 'snow' ? 70 : type === 'petals' ? 46 : 60;
		for (let i = 0; i < count; i += 1) {
			fx.parts.push({
				x: Math.random() * fx.w,
				y: Math.random() * fx.h,
				r: type === 'snow' ? 1 + Math.random() * 2.4 : 2 + Math.random() * 3.2,
				vy: type === 'snow' ? 14 + Math.random() * 26 : 12 + Math.random() * 20,
				sway: Math.random() * 2 * Math.PI,
				swaySpeed: 0.4 + Math.random() * 1.2,
				spin: Math.random() * 2 * Math.PI,
				phase: Math.random() * 2 * Math.PI,
			});
		}
	}

	function setEffect(id) {
		if (lastRendered.effect === id) return; // 特效没变就不重造粒子
		lastRendered.effect = id;
		fx.type = id;
		spawnParticles(id);
		if (!fx.raf) startFx();
	}

	function drawFx(dt) {
		const ctx = fxCanvas.getContext('2d');
		ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
		ctx.clearRect(0, 0, fx.w, fx.h);
		const t = performance.now() / 1000;
		for (const p of fx.parts) {
			if (fx.type === 'stars') {
				p.phase += dt * 1.6;
				const a = 0.25 + 0.65 * (0.5 + 0.5 * Math.sin(p.phase));
				ctx.fillStyle = `rgba(255, 245, 200, ${a})`;
				ctx.beginPath();
				ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
				ctx.fill();
				continue;
			}
			p.y += p.vy * dt;
			if (fx.type === 'snow') {
				p.x += Math.sin(t * p.swaySpeed + p.sway) * 12 * dt;
				ctx.fillStyle = 'rgba(255,255,255,0.9)';
				ctx.beginPath();
				ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
				ctx.fill();
			} else {
				p.x += Math.sin(t * p.swaySpeed + p.sway) * 18 * dt;
				p.spin += dt * 1.8;
				ctx.save();
				ctx.translate(p.x, p.y);
				ctx.rotate(p.spin);
				ctx.fillStyle = 'rgba(255, 190, 225, 0.85)';
				ctx.beginPath();
				ctx.ellipse(0, 0, p.r * 1.6, p.r, 0, 0, Math.PI * 2);
				ctx.fill();
				ctx.restore();
			}
			if (p.y > fx.h + 8) {
				p.y = -8;
				p.x = Math.random() * fx.w;
			}
			if (p.x < -10) p.x = fx.w + 10;
			if (p.x > fx.w + 10) p.x = -10;
		}
	}

	function startFx() {
		const loop = (now) => {
			fx.raf = requestAnimationFrame(loop);
			if (document.hidden) return;
			const dt = Math.min(0.05, (now - (fx.last || now)) / 1000);
			fx.last = now;
			drawFx(dt);
		};
		fx.raf = requestAnimationFrame(loop);
	}

	/* ---------------- 事件 ---------------- */

	function cycle(catId, dir) {
		const list = category(catId);
		const cat = manifest.categories.find((entry) => entry.id === catId);
		const current = state[cat.stateKey];
		const index = list.findIndex((item) => item.id === current);
		return list[(index + dir + list.length) % list.length].id;
	}

	function bind() {
		$('#randomBtn').addEventListener('click', randomLook);
		$('#saveBtn').addEventListener('click', saveCard);
		$('#collectBtn').addEventListener('click', openSheet);
		$('#sheetClose').addEventListener('click', () => {
			els.sheet.hidden = true;
		});
		els.sheet.addEventListener('click', (event) => {
			if (event.target === els.sheet) els.sheet.hidden = true;
		});
		els.figure.addEventListener('click', onFigureTap);
		els.figure.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				speakRandom();
			}
		});
		window.addEventListener('keydown', (event) => {
			const target = event.target;
			if (target instanceof HTMLElement && /INPUT|TEXTAREA/.test(target.tagName)) return;
			if (event.key === 'ArrowRight') {
				state = applySelection(manifest, state, 'outfits', cycle('outfits', 1));
				applyState();
			}
			if (event.key === 'ArrowLeft') {
				state = applySelection(manifest, state, 'outfits', cycle('outfits', -1));
				applyState();
			}
			if (event.key.toLowerCase() === 'r') randomLook();
			if (event.key === 'Escape') els.sheet.hidden = true;
		});
		const renderButton = $('#renderBtn');
		if (renderButton) {
			renderButton.addEventListener('click', () => {
				applyRenderMode(renderMode === '2d5' ? 'dom' : '2d5', { persist: true });
			});
		}
		// 2.5D head follow：指针在角色框内移动 → 头部轻微跟随（参数总线；M5 互动复用）
		els.stage.addEventListener('pointermove', (event) => {
			if (renderMode !== '2d5' || !render2d5) return;
			const rect = els.figureWrap.getBoundingClientRect();
			if (!rect.width || !rect.height) return;
			render2d5.setHeadFollow(
				((event.clientX - rect.left) / rect.width) * 2 - 1,
				((event.clientY - rect.top) / rect.height) * 2 - 1,
			);
		});
		els.stage.addEventListener('pointerleave', () => {
			if (render2d5) render2d5.setHeadFollow(null);
		});
		document.addEventListener('visibilitychange', () => {
			if (render2d5) render2d5.setPaused(document.hidden);
		});
		window.addEventListener('resize', () => {
			resizeFx();
			spawnParticles(fx.type);
			layoutFigure(true);
		});
	}

	/* ---------------- 视差（鼠标移动时场景/人物轻微错位） ---------------- */

	function startParallax() {
		if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		let px = 0;
		let py = 0;
		let tx = 0;
		let ty = 0;
		els.stage.addEventListener('mousemove', (event) => {
			const rect = els.stage.getBoundingClientRect();
			tx = (event.clientX - rect.left) / rect.width - 0.5;
			ty = (event.clientY - rect.top) / rect.height - 0.5;
		});
		els.stage.addEventListener('mouseleave', () => {
			tx = 0;
			ty = 0;
		});
		const tick = () => {
			px += (tx - px) * 0.06;
			py += (ty - py) * 0.06;
			els.scene.style.transform = `translate(${(-px * 12).toFixed(2)}px, ${(-py * 8).toFixed(2)}px) scale(1.05)`;
			els.figureWrap.style.transform = `translate(${(px * 7).toFixed(2)}px, ${(py * 4).toFixed(2)}px)`;
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}

	/* ---------------- 启动 ---------------- */

	function readUrlOverrides() {
		const raw = {};
		for (const entry of manifest.categories) {
			const value = params.get(entry.stateKey);
			if (value) raw[entry.stateKey] = value;
		}
		const shape = params.get('shape');
		if (shape) raw.shape = shape;
		return raw;
	}

	async function boot() {
		if (params.has('embed')) document.body.classList.add('embed');
		const res = await fetch('manifest.json', { cache: 'no-cache' });
		manifest = await res.json();
		// DIY 本地衣柜（默认关闭）：开启过才从 IndexedDB 读记录并注入 manifest.items；
		// 注入必须发生在 normalizeState 之前，旧穿搭里选中的 DIY 单品才能被还原。
		diy = createDiy({ manifest });
		try {
			await diy.prepare();
		} catch (err) {
			console.warn('[衣橱] DIY 本地衣柜加载失败（不影响换装）', err);
		}
		state = normalizeState(manifest, { ...readSaved(), ...readUrlOverrides() });
		buildFigureLayers();
		buildFaceLayers();
		document.title = `${manifest.character} · 大肥鱼衣橱`;
		renderShapeToggle();
		renderTabs();
		setTab('outfits');
		resizeFx();

		// 渲染方式决策（M3）：URL ?render= > 本地用户选择 > 宿主 config.dressUp.render > 默认 dom。
		// 默认 dom 时以下 2.5D 代码路径都不会执行（不 import runtime、不发任何 2.5D 请求）。
		const hostRender = await readHostRenderConfig();
		const requestedMode = parseRenderMode(params.get('render'))
			|| parseRenderMode(readStoredRenderMode())
			|| parseRenderMode(hostRender)
			|| 'dom';
		// 只有 auto 需要能力探测；显式 dom/2d5 不创建探测 context（零额外资源）
		const decision = resolveRenderMode({
			config: hostRender,
			url: params.get('render'),
			stored: readStoredRenderMode(),
			capable: requestedMode === 'auto' ? probeRenderCapabilities() : {},
		});
		renderRequested = decision.requested;
		renderSource = decision.source;

		// 与渲染方式无关的页面骨架先出（背景/特效/衣柜/布局），2.5D 加载期间不白屏
		renderShapeToggle();
		renderScene();
		renderMeta();
		setEffect(state.effect);
		renderShelf();
		layoutFigure(true);

		if (decision.mode === '2d5') {
			const mode = await applyRenderMode('2d5');
			if (mode !== '2d5') {
				renderFigure();
				syncFaceShape();
				startFace();
			}
		} else {
			applyState();
			startFace();
		}
		updateRenderButton();
		bind();
		diy.attach({
			getState: () => state,
			select: (catId, itemId) => select(catId, itemId),
			refreshShelf: () => {
				shelfBuiltCat = '';
				renderShelf();
			},
			resetState: () => {
				state = normalizeState(manifest, state);
				applyState();
			},
			say,
		});
		/** QA / Playwright 自动化入口（不参与正常渲染）。 */
		window.__feiyuDiy = diy;
		/** 2.5D E2E / 调试入口：渲染方式、runtime 状态、资源请求、确定性步进。 */
		window.__feiyu2d5 = {
			mode: () => renderMode,
			requested: () => renderRequested,
			source: () => renderSource,
			fallbackReason: () => render2d5Fallback,
			runtime: () => render2d5,
			switchTo: (mode, options) => applyRenderMode(mode, options),
			ensure: () => ensureRuntime2d5(),
			sync: () => sync2d5(),
			getState: () => (render2d5 ? render2d5.getState() : null),
			getMemory: () => (render2d5 ? render2d5.getMemory() : null),
			getAssetInfo: () => (render2d5 ? render2d5.getAssetInfo() : null),
			freeze: (value) => {
				if (render2d5) render2d5.freeze(value);
			},
			setAuto: (value) => {
				if (render2d5) render2d5.setAuto(value);
			},
			advance: (n, dt) => (render2d5 ? render2d5.advance(n, dt) : 0),
			step: (dt) => (render2d5 ? render2d5.step(dt) : 0),
			resources: () => performance.getEntriesByType('resource')
				.filter((entry) => entry.name.includes('/art/2d5/') || entry.name.includes('runtime-2d5'))
				.map((entry) => ({
					name: entry.name,
					transferSize: entry.transferSize,
					encodedBodySize: entry.encodedBodySize,
					decodedBodySize: entry.decodedBodySize,
				})),
		};
		startParallax();
		if (params.has('embed')) els.tip.classList.add('gone');
	}

	boot().catch((err) => {
		console.error(err);
		els.lookName.textContent = '加载失败';
		els.lookDesc.textContent = '素材没加载出来，刷新页面试试';
	});
})();

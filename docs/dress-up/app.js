/**
 * 大肥鱼衣橱 · 换装间（v2：2.5D-only）
 *
 * 唯一可见渲染路径：WebGL2 2.5D runtime（docs/dress-up/runtime-2d5.js）。
 * - 不再有 DOM 分层纸娃娃 / B1-lite 脸部补丁 / 渲染方式开关；
 * - 无 WebGL2 或 context lost：只显示纯文本提示（+重试按钮），不做任何静态图/人物兜底；
 * - DIY 条目：runtime 冻结为静态帧 + canvas 2D 贴片（全画布位图），UI 明确提示「静态，不支持骨骼动画」；
 * - 互动/喂食 HUD、背景/特效、立绘卡、悬浮鲸鱼小图、图鉴/衣柜均保留。
 *
 * @module dsh-feiyu-wardrobe/dress-up-app
 */
import {
	applySelection,
	applyShape,
	collectItems,
	currentBounds,
	describeOutfit,
	diyLayerUrls,
	normalizeState,
	randomOutfit,
	// @ts-ignore tsc 不认识带 ?v= 的模块路径；加版本号让浏览器绕过旧缓存
} from './wardrobe-core.js?v=25';
import { createDiy } from './diy-ui.js?v=25';
import { createDiyPacks } from './diy-packs.js?v=25';
import {
	ACTION_SPECS,
	actionParams,
	feedLines,
	hitZone,
	moodFacePlan,
	pickLine,
} from './interaction-model.js?v=25';

(() => {
	'use strict';

	const $ = (sel) => document.querySelector(sel);
	const STORAGE_KEY = 'feiyu:outfit';
	/** 2.5D runtime 模块（v2 唯一渲染路径；页面模块版本 v25）。 */
	const RUNTIME_2D5_MODULE = './runtime-2d5.js?v=25';
	const RUNTIME_2D5_ASSET_ROOT = 'art/2d5/';
	/** 2.5D 资产版本（v3.0 = 22：整层 outfit 资产契约，页面模块 v25）。 */
	const RUNTIME_2D5_ASSET_VERSION = '22';
	const params = new URLSearchParams(location.search);
	/**
	 * v2.6.1 资产 tier 调试覆盖：URL `?feiyuTier=lo|hi` 优先，其次 localStorage `feiyu:tier`。
	 * 无覆盖时 runtime 按 DPR/内存/核数/纹理上限自动决策（弱机/DPR1 → lo）。
	 */
	function resolveTierOverride() {
		const fromUrl = String(params.get('feiyuTier') || '').trim().toLowerCase();
		if (fromUrl === 'lo' || fromUrl === 'hi') return { tier: fromUrl, source: 'url' };
		try {
			const stored = String(localStorage.getItem('feiyu:tier') || '').trim().toLowerCase();
			if (stored === 'lo' || stored === 'hi') return { tier: stored, source: 'storage' };
		} catch {
			/* 隐私模式/存储被禁用时忽略 */
		}
		return null;
	}
	/** 悬浮小鲸鱼用的小图尺寸（9:16，与整张立绘画布同构）。 */
	const PET_IMAGE_W = 184;
	const PET_IMAGE_H = 328;

	/** M5 互动控制器状态（宿主状态为唯一真相；local = 静态托管降级）。 */
	const interaction = {
		enabled: false,
		host: null,
		summary: null,
		mode: 'local',
		inFlight: false,
		recentLines: [],
		action: null,
		idleTimer: 0,
		moodTimer: 0,
		reducedMotion: false,
	};
	const INTERACTION_TIMEOUT_MS = 2500;

	const els = {
		stage: $('#stage'),
		scene: $('#scene'),
		figureWrap: $('#figureWrap'),
		figureShadow: $('#figureShadow'),
		fallbackNotice: $('#fallbackNotice'),
		retryBtn: $('#retryBtn'),
		diyNote: $('#diyNote'),
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
		interactionHud: $('#interactionHud'),
		moodHud: $('#moodHud'),
		affinityHud: $('#affinityHud'),
		coinsHud: $('#coinsHud'),
		moodFace: $('#moodFace'),
		patBtn: $('#patBtn'),
		feedSmallBtn: $('#feedSmallBtn'),
		feedBigBtn: $('#feedBigBtn'),
		interactionNote: $('#interactionNote'),
		interactionLocal: $('#interactionLocal'),
	};

	let manifest = null;
	let diy = null;
	/** S3：宿主已安装的 DIY 动态套装（registry + 增量 pack）。 */
	let diyPacks = null;
	let state = null;
	let tab = 'outfits';
	/** 图片加载缓存：src → Promise<HTMLImageElement> */
	const cache = new Map();
	/** 已加载完成的图片：src → HTMLImageElement */
	const loaded = new Map();
	/** persist 序号/定时器/签名。 */
	let persistSeq = 0;
	let persistTimer = 0;
	let lastPersistKey = '';
	/** 上一次渲染的状态（背景/特效/布局），用来跳过没变化的重复工作。 */
	const lastRendered = { bg: '', effect: '', layoutKey: '' };
	/** 身形切换按钮是否已构建（只构建一次）。 */
	let shapeToggleBuilt = false;
	/** 衣柜格子当前构建的分类。 */
	let shelfBuiltCat = '';
	/** @type {HTMLCanvasElement | null} */
	let petCanvasEl = null;

	/* ---------------- 2.5D runtime 状态（唯一渲染路径） ---------------- */

	/** @type {any} */
	let runtime = null;
	/** @type {HTMLCanvasElement | null} */
	let runtimeCanvas = null;
	/** @type {Promise<any> | null} */
	let runtimeStarting = null;
	/** WebGL2 不可用/context lost 的原因（纯文本提示用）。 */
	let runtimeFailure = '';
	/** 切身形/换装并发序号：只让最新一次同步落地。 */
	let syncSeq = 0;
	/** DIY 静态贴片：overlay canvas + 当前是否处于 DIY 静态模式。 */
	/** @type {HTMLCanvasElement | null} */
	let diyOverlay = null;
	let diyStatic = false;
	/** 当前 DIY 条目（避免重复重绘）与贴片图片缓存。 */
	let diyItemId = '';
	/** @type {Map<string, HTMLImageElement>} */
	const diyLayerImages = new Map();
	let talkTimer = 0;

	/* ---------------- 工具 ---------------- */

	function category(catId) {
		return (manifest.items && manifest.items[catId]) || [];
	}

	function findItem(catId, itemId) {
		return category(catId).find((item) => item.id === itemId) || null;
	}

	/** 在所有分类里找单品（DIY 注入可能出现在 tops/bottoms/outfits）。 */
	function findAnyItem(itemId) {
		for (const cat of manifest.categories) {
			const found = findItem(cat.id, itemId);
			if (found) return found;
		}
		return null;
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

	/** 悬浮鲸鱼兜底图（2.5D 未就绪/合成失败时给固定占位）。 */
	function petFallbackImage() {
		return 'art/pet-default.webp';
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
	 * 把 canvas 转成 data URL：优先 `toBlob` + `FileReader`（异步，不阻塞主线程），
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
	 * 把当前 2.5D 帧（+ DIY 静态贴片）合成为悬浮小鲸鱼用的 data URL。
	 * @returns {Promise<string>}
	 */
	async function composePetImage() {
		if (!runtime) return '';
		const canvas = petCanvas();
		const ctx = canvas.getContext('2d');
		if (!ctx) return '';
		try {
			runtime.renderFrame();
			ctx.clearRect(0, 0, PET_IMAGE_W, PET_IMAGE_H);
			ctx.drawImage(runtimeCanvas, 0, 0, PET_IMAGE_W, PET_IMAGE_H);
			if (diyStatic && diyOverlay) ctx.drawImage(diyOverlay, 0, 0, PET_IMAGE_W, PET_IMAGE_H);
			return await canvasToDataURL(canvas);
		} catch {
			return '';
		}
	}

	/**
	 * 把穿搭写进 localStorage 给悬浮小鲸鱼用。
	 * @param {Record<string, string>} snapshot
	 * @param {string} image
	 */
	function writeOutfit(snapshot, image) {
		try {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({ ...snapshot, image: image || petFallbackImage(), updatedAt: Date.now() }),
			);
		} catch {
			/* 隐身模式 / 配额不足时忽略 */
		}
	}

	/** 穿搭签名：决定是否需要重新写 localStorage / 重新合成小图。 */
	function outfitKey(snapshot) {
		return `${snapshot.shape}|${snapshot.outfit}|${snapshot.top}|${snapshot.bottom}|${snapshot.bg}|${snapshot.effect}|${diyStatic ? 'diy' : 'live'}`;
	}

	/**
	 * 保存当前穿搭：debounce 250ms + 浏览器空闲时合成小图并写 localStorage。
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
				composePetImage().then((image) => {
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

	/* ---------------- 2.5D runtime 启动 / 失败提示 / 同步 ---------------- */

	function renderDeviceInfo() {
		return {
			deviceMemory: Number(navigator.deviceMemory) || null,
			hardwareConcurrency: Number(navigator.hardwareConcurrency) || null,
		};
	}

	/** 无 WebGL2 / context lost：只显示纯文本提示，不做任何静态图/人物兜底。 */
	function showRuntimeUnavailable(reason) {
		runtimeFailure = reason instanceof Error ? reason.message : String(reason || 'WebGL2 unavailable');
		console.warn('[衣橱] 2.5D 不可用：', runtimeFailure);
		if (runtime) {
			try { runtime.destroy(); } catch { /* ignore */ }
			runtime = null;
		}
		if (runtimeCanvas && runtimeCanvas.parentNode) runtimeCanvas.parentNode.removeChild(runtimeCanvas);
		runtimeCanvas = null;
		diyStatic = false;
		diyItemId = '';
		if (diyOverlay) diyOverlay.classList.remove('on');
		if (els.diyNote) els.diyNote.hidden = true;
		if (els.fallbackNotice) els.fallbackNotice.hidden = false;
		if (els.figureShadow) els.figureShadow.style.display = 'none';
		if (els.tip) els.tip.classList.add('gone');
	}

	function hideRuntimeUnavailable() {
		runtimeFailure = '';
		if (els.fallbackNotice) els.fallbackNotice.hidden = true;
		if (els.figureShadow) els.figureShadow.style.display = '';
	}

	/** 懒加载 runtime 模块 + 建 canvas（v2 是唯一渲染路径，boot 即调用）。 */
	function ensureRuntime() {
		if (runtime) return Promise.resolve(runtime);
		if (runtimeStarting) return runtimeStarting;
		runtimeStarting = (async () => {
			const tierOverride = resolveTierOverride();
			const module = await import(RUNTIME_2D5_MODULE);
			if (!runtimeCanvas) {
				runtimeCanvas = document.createElement('canvas');
				runtimeCanvas.className = 'figure-2d5';
				runtimeCanvas.setAttribute('aria-hidden', 'true');
				els.figureWrap.appendChild(runtimeCanvas);
			}
			const rt = await module.createRuntime2D5({
				canvas: runtimeCanvas,
				assetRoot: RUNTIME_2D5_ASSET_ROOT,
				assetVersion: RUNTIME_2D5_ASSET_VERSION,
				quality: 'auto',
				device: renderDeviceInfo(),
				devicePixelRatio: window.devicePixelRatio || 1,
				tierOverride: tierOverride ? tierOverride.tier : null,
				tierOverrideSource: tierOverride ? tierOverride.source : null,
				onContextLost: () => {
					if (runtime !== rt) return; // 启动失败主动 destroy 触发的 lost 不重复处理
					showRuntimeUnavailable('webglcontextlost');
				},
			});
			runtime = rt;
			document.addEventListener('visibilitychange', () => {
				if (runtime) runtime.setPaused(document.hidden);
			});
			return rt;
		})().catch((err) => {
			if (runtimeCanvas && runtimeCanvas.parentNode) runtimeCanvas.parentNode.removeChild(runtimeCanvas);
			runtimeCanvas = null;
			throw err;
		}).finally(() => {
			runtimeStarting = null;
		});
		return runtimeStarting;
	}

	/** 启动/重试 2.5D：失败 → 纯文本提示（可重试）。 */
	async function bootRuntime() {
		try {
			await ensureRuntime();
			hideRuntimeUnavailable();
			await runtime.setShape(state.shape);
			runtime.setLook({ outfit: state.outfit, top: state.top, bottom: state.bottom });
			runtime.freeze(false);
			applyReducedMotionPreference();
			applyDiyStatic();
			runtime.renderFrame();
			runtime.start();
			lastPersistKey = '';
			applyState();
		} catch (err) {
			showRuntimeUnavailable(err);
		}
	}

	/** 把页面状态同步到 2.5D runtime（身形按需加载、造型动态组合、DIY 静态贴片）。 */
	function sync2d5() {
		if (!runtime) return;
		const seq = (syncSeq += 1);
		const shape = state.shape;
		runtime.setShape(shape).then(async (result) => {
			if (seq !== syncSeq || !runtime) return;
			if (result && result.stale) return;
			// S3：动态 DIY 套装按需加载（多纹理；不重建 base 图集）
			if (diyPacks) {
				const packItem = diyPacks.findByOutfit(state.outfit);
				if (packItem && packItem.animated) {
					try {
						await diyPacks.ensureLoaded(runtime, packItem.id);
					} catch (err) {
						console.warn('[衣橱] DIY 动态套装加载失败，回退静态提示', err);
						say('这套 DIY 加载失败了，先看看别的套装吧');
					}
				}
			}
			if (seq !== syncSeq || !runtime) return;
			runtime.setLook({ outfit: state.outfit, top: state.top, bottom: state.bottom });
			applyDiyStatic();
			runtime.renderFrame();
		}).catch((err) => {
			console.warn('[衣橱] 2.5D 换装同步失败', err);
			showRuntimeUnavailable(err);
		});
	}

	/** 减少动态效果：关闭随机眨眼/笑眼等自动动画（互动动作也由 interaction.reducedMotion 控制）。 */
	function applyReducedMotionPreference() {
		const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
		interaction.reducedMotion = reduce;
		if (runtime) runtime.setAuto(!reduce);
	}

	/* ---------------- DIY 静态贴片（canvas 2D，不退回 DOM） ---------------- */

	/** 当前选中单品里是否有 DIY 静态回退项（动态套装走 runtime，不进静态贴片）。 */
	function activeDiyItem() {
		for (const itemId of [state.outfit, state.top, state.bottom]) {
			if (typeof itemId !== 'string' || !itemId.startsWith('diy-')) continue;
			const item = findAnyItem(itemId);
			if (item && item.diy && item.diyAnimated !== true) return item;
		}
		return null;
	}

	function ensureDiyOverlay() {
		if (diyOverlay) return diyOverlay;
		diyOverlay = document.createElement('canvas');
		diyOverlay.className = 'diy-overlay';
		diyOverlay.setAttribute('aria-hidden', 'true');
		els.figureWrap.appendChild(diyOverlay);
		return diyOverlay;
	}

	/**
	 * 进入 DIY 静态模式：runtime 冻结为静态帧，DIY 全画布位图以 canvas 2D 叠在上面。
	 * @param {any} item
	 */
	async function enterDiyStatic(item) {
		if (!runtime || !item) return;
		const itemId = item.id;
		// DIY 造型 = 基础身体 + DIY 贴片：先切到 bare（隐藏所有基础服装层），
		// 避免出现「基础造型衣服 + DIY 贴片」两层衣服（v2.0.1 修复）。
		runtime.setLook({ bare: true });
		runtime.freeze(true);
		runtime.renderFrame();
		if (diyStatic && diyItemId === itemId) {
			if (els.diyNote) els.diyNote.hidden = false;
			if (diyOverlay) diyOverlay.classList.add('on');
			return;
		}
		diyStatic = true;
		diyItemId = itemId;
		if (els.diyNote) els.diyNote.hidden = false;
		const urls = diyLayerUrls(item, 'chibi');
		const overlay = ensureDiyOverlay();
		const quality = runtime.getQuality();
		overlay.width = quality.canvas[0];
		overlay.height = quality.canvas[1];
		const ctx = overlay.getContext('2d');
		if (ctx) {
			ctx.clearRect(0, 0, overlay.width, overlay.height);
			for (const url of urls) {
				try {
					const img = await new Promise((resolve, reject) => {
						const cached = diyLayerImages.get(url);
						if (cached) return resolve(cached);
						const image = new Image();
						image.onload = () => { diyLayerImages.set(url, image); resolve(image); };
						image.onerror = reject;
						image.src = url;
					});
					if (!diyStatic || diyItemId !== itemId) return;
					ctx.drawImage(img, 0, 0, overlay.width, overlay.height);
				} catch {
					/* 单张贴片失败不影响其它层 */
				}
			}
		}
		overlay.classList.add('on');
	}

	/** 退出 DIY 静态模式：清贴片、恢复 runtime 播放。 */
	function exitDiyStatic() {
		if (!diyStatic) return;
		diyStatic = false;
		diyItemId = '';
		if (diyOverlay) diyOverlay.classList.remove('on');
		if (els.diyNote) els.diyNote.hidden = true;
		if (runtime) {
			runtime.freeze(false);
			runtime.setLook({ outfit: state.outfit, top: state.top, bottom: state.bottom });
			runtime.renderFrame();
			runtime.start();
		}
	}

	/** 根据当前 state 决定是否进入/退出 DIY 静态贴片。 */
	function applyDiyStatic() {
		if (!runtime) return;
		const item = activeDiyItem();
		if (!item || state.shape !== 'chibi') {
			exitDiyStatic();
			return;
		}
		void enterDiyStatic(item);
	}

	/* ---------------- 人物交互（点击/键盘） ---------------- */

	/** 点击角色：头部=摸摸头（M5 互动），身体=说话；动作走 2.5D 参数总线。 */
	function onFigureTap(event) {
		const zone = hitZoneFromEvent(event && typeof event.clientX === 'number' ? event : null);
		if (zone === 'head' && (interaction.enabled || interaction.mode === 'local')) {
			void interactPat();
			return;
		}
		if (runtime && !diyStatic) runtime.tap();
		speakRandom();
	}

	/* ---------------- 背景 / 布局 / 状态 ---------------- */

	function renderScene() {
		const bg = currentBackground();
		if (!bg) return;
		if (lastRendered.bg === bg.file) return;
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
	 * 按背景地面线站位 + 内容边界自动缩放（2.5D canvas 铺满 figureWrap）。
	 * @param {boolean} [force]
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
		const lookKey = `${state.shape}|${state.outfit}|${state.top}|${state.bottom}`;
		if (lastLookKey && lastLookKey !== lookKey) flashSwap();
		lastLookKey = lookKey;
		sync2d5();
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

	/** 衣柜格子：同一分类只构建一次，换装只更新选中态。 */
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
		if (!runtimeCanvas) return;
		runtimeCanvas.classList.remove('pop-2d5');
		void runtimeCanvas.offsetWidth;
		runtimeCanvas.classList.add('pop-2d5');
		setTimeout(() => {
			if (runtimeCanvas) runtimeCanvas.classList.remove('pop-2d5');
		}, 360);
	}

	function select(catId, itemId) {
		state = applySelection(manifest, state, catId, itemId);
		applyState();
		popFigure();
		const item = findItem(catId, itemId);
		if (item && item.diyAnimated) {
			say(`穿上「${item.name}」啦～（DIY 动态 2.5D）`);
			return;
		}
		if (item && item.diy) {
			if (state.shape !== 'chibi') {
				say('DIY 单品只做了 Q 版，切到 Q 版就能看到啦～');
				return;
			}
			say('穿上 DIY 单品啦～（静态贴片，不支持骨骼动画）');
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
		if (runtime && !diyStatic) {
			runtime.setTalking(true);
			clearTimeout(talkTimer);
			talkTimer = setTimeout(() => {
				if (runtime) runtime.setTalking(false);
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
	 * 立绘卡里人物的绘制区域（2.5D canvas 与卡片共用同一套排版）。
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
		if (!runtime) {
			say('当前设备不支持 WebGL2，暂时生成不了 2.5D 立绘卡');
			return;
		}
		const W = canvas.width;
		const H = canvas.height;
		const bg = currentBackground();
		const bounds = currentBounds(manifest, state);
		let bgImg;
		try {
			bgImg = /** @type {HTMLImageElement} */ (await preload(bg.file));
		} catch {
			alert('图片还没准备好，稍等一下再试～');
			return;
		}
		const scaleBg = Math.max(W / bgImg.width, H / bgImg.height);
		const bw = bgImg.width * scaleBg;
		const bh = bgImg.height * scaleBg;
		ctx.clearRect(0, 0, W, H);
		ctx.drawImage(bgImg, (W - bw) / 2, (H - bh) / 2, bw, bh);
		ctx.fillStyle = 'rgba(255,255,255,0.08)';
		ctx.fillRect(0, 0, W, H);

		const area = cardFigureArea(W, H, bounds);
		// 立绘卡只导出静态帧：runtime.renderFrame() → drawImage（当前参数下的定帧）
		runtime.renderToCanvas(ctx, area.fx0, area.fy0, area.figW, area.figH);
		if (diyStatic && diyOverlay) ctx.drawImage(diyOverlay, area.fx0, area.fy0, area.figW, area.figH);

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
		const hasDiy = collectItems(manifest).some((group) => group.items.some((item) => item.diy));
		els.sheetStat.textContent = `共 ${total} 件 · 2.5D 动态角色（Q版 / 少女版）· 角色：${manifest.character}${hasDiy ? ' · 含本地 DIY（静态）' : ''}`;
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
		if (lastRendered.effect === id) return;
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
		els.figureWrap.addEventListener('click', onFigureTap);
		els.figureWrap.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				onFigureTap(event);
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
		if (els.retryBtn) els.retryBtn.addEventListener('click', () => void bootRuntime());
		// M5 互动 HUD 按钮（宿主模式生效；local-only 时拍头可播动作、喂食禁用）
		if (els.patBtn) els.patBtn.addEventListener('click', () => void interactPat());
		if (els.feedSmallBtn) els.feedSmallBtn.addEventListener('click', () => void interactFeed('small'));
		if (els.feedBigBtn) els.feedBigBtn.addEventListener('click', () => void interactFeed('big'));
		// head follow：指针在角色框内移动 → 头部轻微跟随（参数总线；M5 互动复用）
		els.stage.addEventListener('pointermove', (event) => {
			if (!runtime || diyStatic) return;
			const rect = els.figureWrap.getBoundingClientRect();
			if (!rect.width || !rect.height) return;
			runtime.setHeadFollow(
				((event.clientX - rect.left) / rect.width) * 2 - 1,
				((event.clientY - rect.top) / rect.height) * 2 - 1,
			);
		});
		els.stage.addEventListener('pointerleave', () => {
			if (runtime) runtime.setHeadFollow(null);
		});
		window.addEventListener('resize', () => {
			resizeFx();
			spawnParticles(fx.type);
			layoutFigure(true);
		});
		const reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
		if (reduce && typeof reduce.addEventListener === 'function') {
			reduce.addEventListener('change', applyReducedMotionPreference);
		}
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

	/* ---------------- M5 互动控制器（摸摸头 / 喂食 / 每日问候 / 待机 / 动作曲线） ---------------- */

	/** 受审台词以外不产生任何台词（21 条已审，见 manifest.bubbleSets）。 */
	function sayLine(text) {
		if (!text) return;
		interaction.recentLines.push(text);
		if (interaction.recentLines.length > 2) interaction.recentLines.shift();
		say(text);
	}

	function pickInteractionLine(group) {
		const fallback = (manifest.bubbles && manifest.bubbles[0]) || '嗯？';
		return pickLine(manifest.bubbleSets, group, { recent: interaction.recentLines, fallback });
	}

	/** 指针 → 角色框归一化坐标 → 头部/身体/框外。 */
	function hitZoneFromEvent(event) {
		if (!event) return 'body';
		const rect = els.figureWrap.getBoundingClientRect();
		if (!rect.width || !rect.height) return 'body';
		return hitZone((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
	}

	/** 换装过渡（figure-wrap 容器；reduced-motion 时跳过）。 */
	let lastLookKey = '';
	function flashSwap() {
		if (interaction.reducedMotion) return;
		els.figureWrap.classList.remove('swapping');
		void els.figureWrap.offsetWidth;
		els.figureWrap.classList.add('swapping');
		setTimeout(() => els.figureWrap.classList.remove('swapping'), 220);
	}

	/** 动作曲线驱动器：同一时刻只跑一条曲线；端点回位（interaction-model.actionParams）。 */
	function playAction(kind) {
		const spec = ACTION_SPECS[kind];
		if (!spec || interaction.reducedMotion || kind === 'idle') return;
		// 打断上一条动作：先把上一动作的基准参数写回，避免把中间态当成新基准（端点不归零）
		if (interaction.action) {
			if (interaction.action.raf) cancelAnimationFrame(interaction.action.raf);
			if (runtime && interaction.action.base) runtime.setParams(interaction.action.base);
			interaction.action = null;
		}
		if (!runtime) return;
		const base = runtime.getState().params;
		if (kind === 'pat' && !diyStatic) runtime.tap();
		if (spec.face && spec.face.smileMs) runtime.triggerSmile(spec.face.smileMs / 1000);
		if (kind === 'feed' && !diyStatic) runtime.triggerTalk(1.3);
		const startedAt = performance.now();
		const tick = () => {
			const { done, params: next } = actionParams(kind, performance.now() - startedAt, base);
			if (runtime) runtime.setParams(next);
			if (!done) interaction.action.raf = requestAnimationFrame(tick);
			else {
				if (runtime) runtime.setParams(base);
				interaction.action = null;
			}
		};
		interaction.action = { kind, raf: requestAnimationFrame(tick) };
	}

	const INTERACTION_REASON_TEXT = {
		cooldown: '再等一小会儿',
		'no-coins': '鱼粮还不够',
		'daily-cap': '今天已经够啦',
		full: '已经吃得很饱啦',
		'rate-limited': '慢一点呀',
		disabled: '现在不方便',
		'rejected': '现在不方便',
	};

	function showInteractionNote(text) {
		if (!els.interactionNote) return;
		els.interactionNote.hidden = !text;
		els.interactionNote.textContent = text || '';
		if (text) {
			clearTimeout(showInteractionNote.timer);
			showInteractionNote.timer = setTimeout(() => {
				els.interactionNote.hidden = true;
			}, 2400);
		}
	}

	/** 页面 HUD（心情/亲密度/鱼粮/按钮可用性）。summary=null → 本地模式。 */
	function renderInteractionHud(summary) {
		if (!els.interactionHud) return;
		els.interactionHud.hidden = false;
		if (els.interactionLocal) els.interactionLocal.hidden = !!summary;
		if (!summary) {
			els.moodHud.textContent = '—';
			els.affinityHud.textContent = '—';
			els.coinsHud.textContent = '—';
			els.moodFace.textContent = '🐳';
			els.patBtn.disabled = false;
			els.feedSmallBtn.disabled = true;
			els.feedBigBtn.disabled = true;
			els.patBtn.textContent = '🫳 摸摸头';
			els.feedSmallBtn.textContent = '🍚 鱼粮×3';
			els.feedBigBtn.textContent = '🍱 鱼粮×8';
			return;
		}
		els.moodHud.textContent = summary.mood.label;
		els.moodFace.textContent = summary.mood.emoji;
		els.affinityHud.textContent = `${summary.intimacy.emoji} ${summary.intimacy.title}`;
		els.coinsHud.textContent = String(summary.coins);
		els.patBtn.disabled = !summary.allowed.pat;
		els.feedSmallBtn.disabled = !summary.allowed.feedSmall;
		els.feedBigBtn.disabled = !summary.allowed.feedBig;
		const retry = Math.ceil((summary.retryIn.pat || 0) / 1000);
		els.patBtn.textContent = summary.allowed.pat ? '🫳 摸摸头' : `🫳 ${retry}s`;
		els.feedSmallBtn.textContent = `🍚 鱼粮×${summary.costs.small}`;
		els.feedBigBtn.textContent = `🍱 鱼粮×${summary.costs.big}`;
	}

	async function fetchInteractionState() {
		if (!interaction.host) return null;
		try {
			const res = await fetch(interaction.host.stateUrl, { cache: 'no-store' });
			if (!res.ok) return null;
			const data = await res.json();
			return data && data.ok ? data : null;
		} catch {
			return null;
		}
	}

	/** 宿主动作（唯一经济写入）；失败/超限返回 null 且不播放动作。 */
	async function postInteraction(kind, tier) {
		if (interaction.mode !== 'host' || !interaction.host || interaction.inFlight) return null;
		interaction.inFlight = true;
		try {
			const controller = typeof AbortController === 'function' ? new AbortController() : null;
			const timer = controller ? setTimeout(() => controller.abort(), INTERACTION_TIMEOUT_MS) : 0;
			const res = await fetch(interaction.host.actionUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-feiyu-interaction': '1' },
				body: JSON.stringify(tier ? { kind, tier } : { kind }),
				cache: 'no-store',
				...(controller ? { signal: controller.signal } : {}),
			});
			clearTimeout(timer);
			const data = await res.json().catch(() => null);
			if (!res.ok || !data || !data.ok) {
				showInteractionNote(INTERACTION_REASON_TEXT[(data && data.code) || 'rejected'] || '现在不方便');
				return null;
			}
			interaction.summary = data.state;
			renderInteractionHud(data.state);
			return data.state;
		} catch {
			showInteractionNote(INTERACTION_REASON_TEXT.rejected);
			return null;
		} finally {
			interaction.inFlight = false;
		}
	}

	async function interactPat() {
		if (interaction.inFlight) return;
		const next = await postInteraction('pat');
		if (!next) {
			if (interaction.mode === 'local') {
				playAction('pat');
				sayLine(pickInteractionLine('pat'));
			}
			return;
		}
		playAction('pat');
		sayLine(pickInteractionLine('pat'));
	}

	async function interactFeed(tier) {
		if (interaction.inFlight) return;
		if (interaction.mode !== 'host') {
			showInteractionNote('本地模式 · 不消耗鱼粮');
			return;
		}
		const next = await postInteraction('feed', tier);
		if (!next) return;
		playAction('feed');
		const [first, second] = feedLines(manifest.bubbleSets, { recent: interaction.recentLines });
		sayLine(first);
		setTimeout(() => sayLine(second), 900);
	}

	/** 每日问候：宿主 state 允许时每日一次（页面打开/刷新时判定）。 */
	async function maybeDailyGreet() {
		const summary = interaction.summary;
		if (!summary || !summary.allowed || !summary.allowed.greet) return;
		const next = await postInteraction('greet');
		if (!next) return;
		playAction('greet');
		sayLine(pickInteractionLine('greet'));
	}

	function scheduleIdleLine() {
		clearTimeout(interaction.idleTimer);
		const delay = 25000 + Math.random() * 15000;
		interaction.idleTimer = setTimeout(() => {
			if (document.hidden) {
				scheduleIdleLine();
				return;
			}
			const plan = moodFacePlan(interaction.summary ? interaction.summary.mood.key : 'fine');
			sayLine(pickInteractionLine(plan.idleGroup));
			scheduleIdleLine();
		}, delay);
	}

	/** 心情档 → 笑眼节奏（idle 时按计划触发；reduced-motion 时不触发）。 */
	function startMoodFaceLoop() {
		clearTimeout(interaction.moodTimer);
		const tick = () => {
			const plan = moodFacePlan(interaction.summary ? interaction.summary.mood.key : 'fine');
			const range = plan.smileEvery;
			const wait = range ? range[0] + Math.random() * (range[1] - range[0]) : 15000;
			interaction.moodTimer = setTimeout(() => {
				if (!document.hidden && !interaction.reducedMotion && runtime && !diyStatic) {
					runtime.triggerSmile(1.2);
				}
				tick();
			}, wait);
		};
		tick();
	}

	async function refreshInteraction() {
		if (interaction.mode !== 'host') return;
		const summary = await fetchInteractionState();
		if (summary) {
			interaction.summary = summary;
			renderInteractionHud(summary);
		}
	}

	/**
	 * 初始化互动：读宿主客户端配置（client-config.json，仅 interaction 段）；
	 * 失败/静态托管 → local-only（台词/动作可用、鱼粮不扣）。
	 * @param {{ enabled: boolean, stateUrl?: string, actionUrl?: string }} host
	 */
	async function initInteraction(host) {
		applyReducedMotionPreference();
		if (!host || host.enabled !== true) {
			interaction.mode = 'local';
			interaction.enabled = false;
			renderInteractionHud(null);
			return;
		}
		interaction.host = host;
		const summary = await fetchInteractionState();
		if (!summary) {
			interaction.mode = 'local';
			interaction.enabled = false;
			renderInteractionHud(null);
			return;
		}
		interaction.mode = 'host';
		interaction.enabled = true;
		interaction.summary = summary;
		renderInteractionHud(summary);
		scheduleIdleLine();
		startMoodFaceLoop();
		await maybeDailyGreet();
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) void refreshInteraction();
		});
		window.addEventListener('focus', () => void refreshInteraction());
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

	/** 读宿主客户端配置（v2：只含 interaction；无渲染开关）。 */
	async function readHostConfig() {
		const fallback = { interaction: { enabled: false } };
		try {
			const response = await fetch('client-config.json', { cache: 'no-store' });
			if (!response.ok) return fallback;
			const data = await response.json();
			const raw = data && typeof data.interaction === 'object' ? data.interaction : null;
			const enabled = !!(
				raw &&
				raw.enabled !== false &&
				typeof raw.stateUrl === 'string' &&
				typeof raw.actionUrl === 'string'
			);
			return {
				interaction: enabled
					? { enabled: true, stateUrl: raw.stateUrl, actionUrl: raw.actionUrl }
					: { enabled: false },
			};
		} catch {
			return fallback;
		}
	}

	async function boot() {
		if (params.has('embed')) document.body.classList.add('embed');
		const res = await fetch('manifest.json', { cache: 'no-cache' });
		manifest = await res.json();
		// DIY 本地衣柜（默认关闭）：开启过才从 IndexedDB 读记录并注入 manifest.items。
		diy = createDiy({ manifest });
		try {
			await diy.prepare();
		} catch (err) {
			console.warn('[衣橱] DIY 本地衣柜加载失败（不影响换装）', err);
		}
		// S3：宿主已安装 DIY 动态套装（默认关闭/静态托管 404 → 无 DIY，不阻塞）
		diyPacks = createDiyPacks({ manifest });
		try {
			await diyPacks.prepare();
			diyPacks.inject(manifest);
		} catch (err) {
			console.warn('[衣橱] 宿主 DIY 套装加载失败（不影响换装）', err);
		}
		state = normalizeState(manifest, { ...readSaved(), ...readUrlOverrides() });
		document.title = `${manifest.character} · 大肥鱼衣橱`;
		renderShapeToggle();
		renderTabs();
		setTab('outfits');
		resizeFx();

		// 页面骨架先出（背景/特效/衣柜/布局），2.5D 加载期间不白屏
		renderScene();
		renderMeta();
		setEffect(state.effect);
		renderShelf();
		layoutFigure(true);

		bind();
		// 2.5D 是唯一渲染路径：boot 即尝试；失败 → 纯文本提示（可重试）
		await bootRuntime();
		const hostConfig = await readHostConfig();
		await initInteraction(hostConfig.interaction);
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
		// S3：DIY 已安装套装面板（试穿/导出导入 .dshskin/删除/刷新）
		if (diyPacks) {
			diyPacks.mountUi(els.stage, {
				runtime: () => runtime,
				select: (itemId) => {
					state = applySelection(manifest, state, 'outfits', itemId);
					applyState();
				},
				refresh: () => {
					shelfBuiltCat = '';
					renderShelf();
					if (typeof state.outfit === 'string' && state.outfit.startsWith('diy-') && !diyPacks.find(state.outfit)) {
						state = applySelection(manifest, state, 'outfits', 'maid');
					}
					applyState();
				},
			});
			window.__feiyuDiyPacks = {
				available: () => diyPacks.available(),
				error: () => diyPacks.error(),
				items: () => diyPacks.list(),
				prepare: () => diyPacks.prepare(),
				refresh: () => diyPacks.refresh(),
				inject: () => diyPacks.inject(manifest),
				select: (itemId) => {
					state = applySelection(manifest, state, 'outfits', itemId);
					applyState();
				},
				exportSkin: (itemId) => diyPacks.exportSkin(itemId),
				importSkin: (bundle) => diyPacks.importSkin(bundle),
				remove: (itemId) => diyPacks.remove(itemId, runtime),
				loadedPacks: () => (runtime ? runtime.getOutfitPacks() : []),
			};
		}
		/** M5 互动 E2E / 调试入口。 */
		window.__feiyuInteraction = {
			mode: () => interaction.mode,
			summary: () => interaction.summary,
			inFlight: () => interaction.inFlight,
			act: (kind, tier) => postInteraction(kind, tier),
			pat: () => interactPat(),
			feed: (tier) => interactFeed(tier),
			play: (kind) => playAction(kind),
			recentLines: () => interaction.recentLines.slice(),
			hitZone: (nx, ny) => hitZone(nx, ny),
			reducedMotion: () => interaction.reducedMotion,
			lastAction: () => (interaction.action ? interaction.action.kind : ''),
		};
		/** 2.5D E2E / 调试入口（v2：无渲染模式开关）。 */
		window.__feiyu2d5 = {
			ready: () => !!runtime,
			runtime: () => runtime,
			failure: () => runtimeFailure,
			unavailable: () => !!(els.fallbackNotice && !els.fallbackNotice.hidden),
			retry: () => bootRuntime(),
			getState: () => (runtime ? runtime.getState() : null),
			getMemory: () => (runtime ? runtime.getMemory() : null),
			getAssetInfo: () => (runtime ? runtime.getAssetInfo() : null),
			getTier: () => (runtime ? runtime.getTier() : null),
			diyMode: () => diyStatic,
			diyOverlayVisible: () => !!(diyOverlay && diyOverlay.classList.contains('on')),
			/** E2E 预置：模拟选中一个 DIY 贴片（url 为 675×1200 透明到底图）。 */
			simulateDiy: (url, slot) => {
				const item = {
					id: 'diy-e2e',
					diy: true,
					layers: { chibi: { [slot || 'topBody']: url } },
				};
				void enterDiyStatic(item);
			},
			clearDiy: () => exitDiyStatic(),
			freeze: (value) => {
				if (runtime) runtime.freeze(value);
			},
			setAuto: (value) => {
				if (runtime) runtime.setAuto(value);
			},
			advance: (n, dt) => (runtime ? runtime.advance(n, dt) : 0),
			step: (dt) => (runtime ? runtime.step(dt) : 0),
			resources: () => performance.getEntriesByType('resource')
				.filter((entry) => entry.name.includes('/art/2d5/') || entry.name.includes('runtime-2d5') || entry.name.includes('manifest.json'))
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

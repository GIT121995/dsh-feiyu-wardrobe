import {
	applySelection,
	applyShape,
	collectItems,
	currentBounds,
	describeOutfit,
	normalizeState,
	randomOutfit,
	resolveLayers,
	// @ts-ignore tsc 不认识带 ?v= 的模块路径；这里加版本号是为了让浏览器绕过 wardrobe-core 的旧缓存
} from './wardrobe-core.js?v=9';

(() => {
	'use strict';

	const $ = (sel) => document.querySelector(sel);
	const STORAGE_KEY = 'feiyu:outfit';
	const params = new URLSearchParams(location.search);

	/** 图层栈的 5 个固定槽位（与 resolveLayers 的 kind 一一对应）。 */
	const LAYER_SLOTS = ['base', 'bottom', 'top', 'outfit', 'overlay'];
	/** 悬浮小鲸鱼用的小图尺寸（9:16，与旧整套立绘同构）。 */
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
	for (const slot of LAYER_SLOTS) {
		els.figureLayers[slot] = /** @type {HTMLImageElement} */ (document.querySelector(`.figure-layer[data-layer="${slot}"]`));
	}

	let manifest = null;
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
	 * 当前穿搭的兜底小图（图层小图还没合成好时用素体顶上）。
	 * @param {string} shapeId
	 * @returns {string}
	 */
	function petFallbackImage(shapeId) {
		const shape = manifest.shapes.find((entry) => entry.id === shapeId) || manifest.shapes[0];
		return (shape && shape.base) || 'art/chibi/base.webp';
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
	 * 图层共用同一张 675×1200 画布坐标，直接整幅缩放叠放即可，不需要任何锚点。
	 * @param {Array<{ file: string }>} layers
	 * @returns {Promise<string>}
	 */
	async function composePetImage(layers) {
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

	/** 穿搭签名：决定是否需要重新写 localStorage / 重新合成小图。 */
	function outfitKey(snapshot) {
		return `${snapshot.shape}|${snapshot.outfit}|${snapshot.top}|${snapshot.bottom}|${snapshot.bg}|${snapshot.effect}`;
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

	/* ---------------- 人物图层栈 ---------------- */

	/**
	 * 按 `resolveLayers` 把变化过的槽位换成新图；未变化的槽位不重建、不重新赋值。
	 * 隐藏当前穿搭用不到的槽位（套装与上下装互斥，槽位数量固定为 5 个）。
	 */
	function renderFigure() {
		const layers = resolveLayers(manifest, state);
		const key = layers.map((layer) => `${layer.kind}:${layer.file}:${layer.z}`).join('|');
		if (key === lastRendered.figureKey) return; // 只换背景/特效时整个图层栈都不用动
		lastRendered.figureKey = key;
		const seq = (renderSeq += 1);
		/** @type {Map<string, { file: string, z: number }>} */
		const byKind = new Map();
		for (const layer of layers) {
			if (layer.file) byKind.set(layer.kind, layer);
		}
		for (const slot of LAYER_SLOTS) {
			const el = els.figureLayers[slot];
			if (!el) continue;
			const layer = byKind.get(slot);
			if (!layer) {
				el.hidden = true;
				continue;
			}
			el.style.zIndex = String(layer.z);
			if (el.dataset.file === layer.file && el.getAttribute('src')) {
				el.hidden = false;
				continue; // 未变化：什么都不动
			}
			el.dataset.file = layer.file;
			preload(layer.file).then(
				(img) => {
					if (seq !== renderSeq || el.dataset.file !== layer.file) return; // 已被更新的渲染取代
					el.src = layer.file;
					el.alt = slot === 'base' ? '大肥鱼' : '';
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
		renderFigure();
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

	async function saveCard() {
		const canvas = els.canvas;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const W = canvas.width;
		const H = canvas.height;
		const bg = currentBackground();
		const layers = resolveLayers(manifest, state);
		const bounds = currentBounds(manifest, state);
		let bgImg;
		/** @type {Map<string, HTMLImageElement>} */
		const layerImgs = new Map();
		try {
			bgImg = /** @type {HTMLImageElement} */ (await preload(bg.file));
			const files = layers.map((layer) => layer.file).filter(Boolean);
			const imgs = await Promise.all(files.map((file) => preload(file)));
			files.forEach((file, index) => layerImgs.set(file, /** @type {HTMLImageElement} */ (imgs[index])));
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

		// 人物：所有图层共用同一张画布坐标，按 z 序在同一个矩形里依次 drawImage
		const baseLayer = layers.find((layer) => layer.kind === 'base');
		const baseImg = baseLayer ? layerImgs.get(baseLayer.file) : null;
		const ratio = baseImg && baseImg.width && baseImg.height ? baseImg.width / baseImg.height : 9 / 16;
		const areaTop = H * 0.035;
		const areaBottom = H * 0.86;
		const usable = Math.max(0.2, bounds.bottom - bounds.top);
		const figH = (areaBottom - areaTop) / usable;
		const figW = figH * ratio;
		const fx0 = (W - figW) / 2;
		const fy0 = areaTop - bounds.top * figH;
		for (const layer of layers) {
			const img = layerImgs.get(layer.file);
			if (img) ctx.drawImage(img, fx0, fy0, figW, figH);
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
		els.figure.addEventListener('click', () => {
			els.figure.classList.remove('hop');
			void els.figure.offsetWidth;
			els.figure.classList.add('hop');
			setTimeout(() => els.figure.classList.remove('hop'), 700);
			speakRandom();
		});
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
		state = normalizeState(manifest, { ...readSaved(), ...readUrlOverrides() });
		document.title = `${manifest.character} · 大肥鱼衣橱`;
		renderShapeToggle();
		renderTabs();
		setTab('outfits');
		resizeFx();
		applyState();
		bind();
		startParallax();
		if (params.has('embed')) els.tip.classList.add('gone');
	}

	boot().catch((err) => {
		console.error(err);
		els.lookName.textContent = '加载失败';
		els.lookDesc.textContent = '素材没加载出来，刷新页面试试';
	});
})();

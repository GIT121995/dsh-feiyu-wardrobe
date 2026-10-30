import {
	applySelection,
	applyShape,
	collectItems,
	currentBounds,
	describeOutfit,
	normalizeState,
	randomOutfit,
	resolveImage,
} from './wardrobe-core.js';

(() => {
	'use strict';

	const $ = (sel) => document.querySelector(sel);
	const STORAGE_KEY = 'feiyu:outfit';
	const params = new URLSearchParams(location.search);

	const els = {
		scene: $('#scene'),
		figure: $('#figure'),
		figureImg: $('#figureImg'),
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
	let state = null;
	let tab = 'outfits';
	const cache = new Map();

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

	function preload(src) {
		if (!src) return Promise.resolve(null);
		if (!cache.has(src)) {
			cache.set(src, new Promise((resolve, reject) => {
				const img = new Image();
				img.onload = () => resolve(img);
				img.onerror = reject;
				img.src = src;
			}));
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

	function persist() {
		const image = resolveImage(manifest, state);
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, image, updatedAt: Date.now() }));
		} catch {
			/* 隐身模式忽略 */
		}
	}

	/* ---------------- 舞台 ---------------- */

	function swapFigure() {
		const file = resolveImage(manifest, state);
		const alt = describeOutfit(manifest, state).name;
		els.figureImg.classList.add('fading');
		const apply = () => {
			els.figureImg.src = file;
			els.figureImg.alt = alt;
			requestAnimationFrame(() => els.figureImg.classList.remove('fading'));
		};
		preload(file).then(apply, apply);
	}

	function renderScene() {
		const bg = currentBackground();
		els.scene.classList.add('fading');
		const apply = () => {
			els.scene.src = bg.file;
			els.scene.alt = bg.name;
			requestAnimationFrame(() => els.scene.classList.remove('fading'));
		};
		preload(bg.file).then(apply, apply);
	}

	/** 按当前立绘的内容边界自动定位/缩放。 */
	function layoutFigure() {
		const stage = els.figure.parentElement;
		const H = stage.clientHeight;
		const W = stage.clientWidth;
		if (!H || !W) return;
		const bounds = currentBounds(manifest, state);
		const usable = Math.max(0.2, bounds.bottom - bounds.top);
		const TOP = 0.1;
		const BOTTOM = 0.97;
		const hf = Math.min(
			((BOTTOM - TOP) * H) / usable,
			H * 1.7,
			(W * 0.98) / 0.5625,
		);
		els.figure.style.height = `${Math.round(hf)}px`;
		els.figure.style.top = `${Math.round(TOP * H - bounds.top * hf)}px`;
	}

	function renderMeta() {
		const text = describeOutfit(manifest, state);
		els.lookName.textContent = text.name;
		els.lookDesc.textContent = text.detail;
	}

	function applyState() {
		swapFigure();
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
		els.shapeToggle.innerHTML = '';
		for (const shape of manifest.shapes) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'shape-btn' + (shape.id === state.shape ? ' active' : '');
			btn.textContent = shape.name;
			btn.title = shape.desc || shape.name;
			btn.setAttribute('aria-pressed', shape.id === state.shape ? 'true' : 'false');
			btn.addEventListener('click', () => {
				state = applyShape(manifest, state, shape.id);
				applyState();
				say(`换成「${shape.name}」啦！`);
			});
			els.shapeToggle.appendChild(btn);
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

	function renderShelf() {
		const cat = manifest.categories.find((entry) => entry.id === tab);
		if (!cat) return;
		const backgroundTab = cat.id === 'backgrounds';
		els.shelf.innerHTML = '';
		for (const item of category(cat.id)) {
			const button = document.createElement('button');
			button.type = 'button';
			const active = isActiveItem(cat.id, item.id);
			button.className = 'item' + (backgroundTab ? ' bg' : '') + (active ? ' active' : '');
			button.dataset.id = item.id;
			button.title = item.desc || item.name;
			button.setAttribute('aria-label', item.name);
			button.setAttribute('aria-pressed', active ? 'true' : 'false');
			if (item.thumb) {
				const img = document.createElement('img');
				img.src = item.thumb;
				img.alt = '';
				img.loading = 'lazy';
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

	function select(catId, itemId) {
		state = applySelection(manifest, state, catId, itemId);
		applyState();
		const item = findItem(catId, itemId);
		say(`换上「${item ? item.name : itemId}」啦！`);
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
		const lines = ['这样好不好看？', '转一圈——怎么样！', '嘿嘿，随机出来的也挺配。', '换好啦，像不像新的我？'];
		say(lines[Math.floor(Math.random() * lines.length)]);
	}

	async function saveCard() {
		const canvas = els.canvas;
		const ctx = canvas.getContext('2d');
		const W = canvas.width;
		const H = canvas.height;
		const bg = currentBackground();
		const file = resolveImage(manifest, state);
		const bounds = currentBounds(manifest, state);
		let bgImg;
		let figImg;
		try {
			[bgImg, figImg] = await Promise.all([preload(bg.file), preload(file)]);
		} catch {
			alert('图片还没准备好，稍等一下再试～');
			return;
		}
		const scaleBg = Math.max(W / bgImg.width, H / bgImg.height);
		const bw = bgImg.width * scaleBg;
		const bh = bgImg.height * scaleBg;
		ctx.drawImage(bgImg, (W - bw) / 2, (H - bh) / 2, bw, bh);
		ctx.fillStyle = 'rgba(255,255,255,0.08)';
		ctx.fillRect(0, 0, W, H);

		// 立绘：按内容边界铺满卡片主体区域
		const areaTop = H * 0.035;
		const areaBottom = H * 0.86;
		const usable = Math.max(0.2, bounds.bottom - bounds.top);
		const figH = ((areaBottom - areaTop) / usable);
		const figW = figH * (figImg.width / figImg.height);
		const fx0 = (W - figW) / 2;
		const fy0 = areaTop - bounds.top * figH;
		ctx.drawImage(figImg, fx0, fy0, figW, figH);

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
		say('立绘卡保存好啦，发群里给朋友看看～');
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
				if (item.thumb) {
					const img = document.createElement('img');
					img.src = item.thumb;
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
		els.sheetStat.textContent =
			`共 ${total} 件 · 两种身形（Q版 / 少女版）· 角色：${manifest.character}`;
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
		els.figure.addEventListener('click', speakRandom);
		els.figure.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				speakRandom();
			}
		});
		window.addEventListener('keydown', (event) => {
			if (event.target && /INPUT|TEXTAREA/.test(event.target.tagName)) return;
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
			layoutFigure();
		});
	}

	/* ---------------- 启动 ---------------- */

	function readUrlOverrides() {
		const raw = {};
		for (const category of manifest.categories) {
			const value = params.get(category.stateKey);
			if (value) raw[category.stateKey] = value;
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
		if (params.has('embed')) els.tip.classList.add('gone');
	}

	boot().catch((err) => {
		console.error(err);
		els.lookName.textContent = '加载失败';
		els.lookDesc.textContent = '素材没加载出来，刷新页面试试';
	});
})();

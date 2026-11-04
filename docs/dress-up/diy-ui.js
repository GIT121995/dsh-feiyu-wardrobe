// @ts-nocheck — 浏览器 UI 编排（DOM/canvas/fetch/IndexedDB）；纯逻辑在 diy-*.js 纯模块里有单测
/**
 * 大肥鱼衣橱 · DIY 上传面板（换装间内 UI 编排）
 *
 * 流程：宿主状态探测 → 默认关闭开关/首次显式同意（隐私+费用）→ 上传衣服图（本地压缩）
 *   → 描述内容守卫（pass/downgrade/reject）→ 费用预估确认 → 宿主代理生成 look+flatout
 *   → 浏览器本地成层（diy-layers）→ 预览（look/层/4x）+ 自动 QA → 确认入库（IndexedDB）
 *   → 注入 manifest.items，用现有 7 槽位渲染路径直接试穿；支持删除/配额/LRU/失败重试。
 *   `.dshskin` 导入导出在本地面板完成（不经服务器）。
 *
 * 设计约束：
 *   - 默认关闭；不开启时只有打开面板才 GET 一次本地 status（无费用、无外链）；
 *   - 生成前必须有同意记录 + 费用确认；内容守卫在客户端先拦截（reject 不请求宿主）；
 *   - 不写 telemetry / 外链；图片数据只在本机内存/IndexedDB。
 *
 * @module dsh-feiyu-wardrobe/diy-ui
 */

import {
	DIY_CATEGORIES,
	DIY_CATEGORY_LABELS,
	DIY_CATEGORY_SLOTS,
	DIY_GUARD_VERSION,
	checkGarmentDescription,
	contentPolicyTag,
} from './diy-guard.js';
import { DIY_CANVAS, compositeStack, createRgbaImage, extractDiyLayer, layerFromAlpha } from './diy-layers.js';
import {
	DIY_CONSENT_VERSION,
	DiyStoreError,
	deleteDiyRecord,
	diyStoreStats,
	listDiyRecords,
	makeDiyRecord,
	putDiyRecord,
	readConsent,
	readEnabled,
	revokeConsent,
	writeConsent,
	writeEnabled,
} from './diy-store.js';
import { buildSkinFile, parseSkinFile, sha256Hex, skinFileName } from './diy-skin.js';
import { DIY_MAX_ITEMS, diyRecordToItem, isDiyItemId } from './wardrobe-core.js';

const PROXY_STATUS = '/feiyu/diy/status';
const PROXY_GENERATE = '/feiyu/diy/generate';
const MAX_UPLOAD_EDGE = 1024;
// DIY 本地成层需要的素体掩膜（hair/arms/body）：随包发布的参考掩膜，不是 DOM 人物渲染资产。
// v2 起 DOM 分层渲染退役，这三个文件只被 extractDiyLayer 当作掩膜输入使用。
const ART_BASE = 'art/diy/masks/chibi/';
/** 本地成层算法是否已预热（在等待云端 API 时跑一次真实尺寸 warmup，降低首件 JIT 冷启动）。 */
let layersWarmed = false;

const CATEGORY_TO_MANIFEST = {
	top: 'tops',
	bottom: 'bottoms',
	dress: 'outfits',
	coat: 'outfits',
	outfit: 'outfits',
};

const ERROR_TEXT = {
	diy_disabled: '宿主未开启 DIY（默认关闭）。开启方式：在 DSH 插件配置中设置 diy.enabled=true 后重启。',
	missing_api_key: '宿主未配置 ARK_API_KEY，无法调用云端图像 API（请配置后重启宿主）。',
	consent_required: '需要先在面板中同意后再生成。',
	content_rejected: '内容不符合保守着装规范，已拒绝（不会发送到云端 API）。',
	cost_confirmation_required: '请先勾选费用确认。',
	daily_image_limit: '今日 DIY 图片额度已用完，明天再试。',
	daily_budget_exceeded: '今日 DIY 预算已用完，明天再试。',
	generation_failed: '云端生成失败（可重试；失败/重抽按张计费，请在成本日志中查看）。',
	invalid_image: '上传图片格式不支持，请换一张 png/jpeg/webp。',
	image_too_large: '上传图片过大，请先压缩。',
	body_too_large: '请求体过大，请换小图。',
	invalid_json: '请求格式错误，请重试。',
	forbidden: '请求被同源策略拦截，请刷新页面重试。',
	network: '连不上宿主代理（纯离线/在线试玩页不可用）。',
};

/* ---------------- 小工具 ---------------- */

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null) continue;
		if (key === 'class') node.className = value;
		else if (key === 'text') node.textContent = value;
		else if (key === 'html') node.innerHTML = value;
		else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
		else if (key === 'dataset') Object.assign(node.dataset, value);
		else node.setAttribute(key, value);
	}
	for (const child of Array.isArray(children) ? children : [children]) {
		if (child === null || child === undefined) continue;
		node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	return node;
}
const $ = (selector) => document.querySelector(selector);

/** 图片加载。 */
function loadImage(src) {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`图片加载失败：${String(src).slice(0, 60)}`));
		image.src = src;
	});
}

/** 文件 → 压缩后的 JPEG data URL（长边 ≤1024，供上传）。 */
function compressImageFile(file) {
	return new Promise((resolve, reject) => {
		if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
			reject(new Error('只支持 png / jpeg / webp 图片'));
			return;
		}
		const reader = new FileReader();
		reader.onerror = () => reject(new Error('读取上传图片失败'));
		reader.onload = () => {
			const raw = typeof reader.result === 'string' ? reader.result : '';
			const image = new Image();
			image.onerror = () => reject(new Error('上传图片损坏'));
			image.onload = () => {
				const scale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(image.width, image.height));
				const canvas = document.createElement('canvas');
				canvas.width = Math.max(1, Math.round(image.width * scale));
				canvas.height = Math.max(1, Math.round(image.height * scale));
				const ctx = canvas.getContext('2d');
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, canvas.width, canvas.height);
				ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
				resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height, raw });
			};
			image.src = raw;
		};
		reader.readAsDataURL(file);
	});
}

/** data URL → Uint8Array。 */
function dataUrlBytes(dataUrl) {
	const base64 = String(dataUrl).split(',')[1] || '';
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** canvas → Blob（webp 优先，失败回退 png）。 */
function canvasToBlob(canvas, type = 'image/webp', quality = 0.9) {
	return new Promise((resolve) => {
		if (typeof canvas.toBlob !== 'function') {
			resolve(null);
			return;
		}
		canvas.toBlob(
			(blob) => resolve(blob),
			type,
			quality,
		);
	});
}

/** RGBA 图像 → canvas。 */
function imageToCanvas(image) {
	const canvas = document.createElement('canvas');
	canvas.width = image.width;
	canvas.height = image.height;
	canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
	return canvas;
}

/** 图像画到 675×1200 canvas 并取 ImageData。 */
function imageDataOf(image, width = DIY_CANVAS.width, height = DIY_CANVAS.height) {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	ctx.clearRect(0, 0, width, height);
	ctx.drawImage(image, 0, 0, width, height);
	return ctx.getImageData(0, 0, width, height);
}

/** 加载身形图层（hair/arms）为 RGBA。 */
async function loadShapeLayer(name) {
	const image = await loadImage(`${ART_BASE}${name}.webp`);
	return imageDataOf(image);
}

/** 将 RGBA 图层（look RGB + alpha）画成 canvas。 */
function buildLayerCanvas(look, alpha) {
	const image = createRgbaImage(look.width, look.height);
	for (let i = 0; i < alpha.length; i += 1) {
		const p = i * 4;
		image.data[p] = look.data[p];
		image.data[p + 1] = look.data[p + 1];
		image.data[p + 2] = look.data[p + 2];
		image.data[p + 3] = alpha[i];
	}
	return imageToCanvas(image);
}

/** 棋盘格背景。 */
function checkerCanvas(width, height, size = 16) {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	for (let y = 0; y < height; y += size) {
		for (let x = 0; x < width; x += size) {
			ctx.fillStyle = ((x / size + y / size) | 0) % 2 === 0 ? '#c8c8d8' : '#e9e9f2';
			ctx.fillRect(x, y, size, size);
		}
	}
	return canvas;
}

/** 触发浏览器下载（本地文件，不经服务器）。 */
function downloadBytes(bytes, filename, mime = 'application/zip') {
	const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
	const url = URL.createObjectURL(blob);
	const link = el('a', { href: url, download: filename });
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------------- 主工厂 ---------------- */

/**
 * @param {{ manifest: any }} options
 */
export function createDiy(options) {
	const manifest = options.manifest;
	const manifestDiy = (manifest && manifest.diy) || {};
	let hooks = null;
	let root = null;
	/** @type {any} */ let status = null;
	/** @type {any[]} */ let records = [];
	/** @type {Map<string, { body: string, sleeve: string | null }>} */ const objectUrls = new Map();
	const state = {
		open: false,
		loadingStatus: false,
		statusError: '',
		enabled: readEnabled(),
		consent: readConsent(),
		category: 'top',
		name: '',
		description: '',
		upload: null,
		confirmCost: false,
		generating: false,
		generateError: '',
		result: null,
		reroll: 0,
		sessionCostYuan: 0,
		sessionImages: 0,
		storeError: '',
		importError: '',
		exportingId: '',
		statusFetchedAt: 0,
	};
	/** @type {Set<string>} */
	const preloaded = new Set();

	/* ---------- 状态与渲染 ---------- */

	function update(patch = {}) {
		Object.assign(state, patch);
		render();
	}

	function activeCategories() {
		const list = status && Array.isArray(status.guard && status.guard.categories) ? status.guard.categories : DIY_CATEGORIES;
		return list.filter((category) => DIY_CATEGORY_SLOTS[category]);
	}

	async function fetchStatus() {
		if (state.loadingStatus) return;
		update({ loadingStatus: true, statusError: '' });
		try {
			const response = await fetch(PROXY_STATUS, { cache: 'no-store', headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = await response.json();
			status = data;
			update({ loadingStatus: false, statusFetchedAt: Date.now() });
		} catch (error) {
			status = { offline: true, ok: false };
			update({ loadingStatus: false, statusError: ERROR_TEXT.network });
		}
	}

	function close() {
		if (root) root.hidden = true;
		state.open = false;
	}

	/* ---------- 记录注入 / 移除 ---------- */

	function manifestCategoryKey(category) {
		return CATEGORY_TO_MANIFEST[category] || 'tops';
	}

	function injectRecord(record) {
		const urls = objectUrls.get(record.id);
		if (!urls) return;
		const item = diyRecordToItem(record, urls);
		const key = manifestCategoryKey(record.category);
		if (!manifest.items[key]) manifest.items[key] = [];
		const list = manifest.items[key];
		const existing = list.findIndex((entry) => entry.id === record.id);
		if (existing >= 0) list[existing] = item;
		else list.push(item);
	}

	function removeInjectedItem(recordId) {
		for (const key of Object.values(CATEGORY_TO_MANIFEST)) {
			const list = manifest.items[key];
			if (!Array.isArray(list)) continue;
			manifest.items[key] = list.filter((item) => item.id !== recordId);
		}
		const urls = objectUrls.get(recordId);
		if (urls) {
			for (const url of [urls.body, urls.sleeve]) if (url) URL.revokeObjectURL(url);
			objectUrls.delete(recordId);
		}
	}

	function ensureObjectUrls(record) {
		if (objectUrls.has(record.id)) return objectUrls.get(record.id);
		const urls = {
			body: URL.createObjectURL(record.layers.body),
			sleeve: record.layers.sleeve ? URL.createObjectURL(record.layers.sleeve) : null,
		};
		objectUrls.set(record.id, urls);
		return urls;
	}

	async function refreshRecords() {
		try {
			records = await listDiyRecords();
			for (const record of records) ensureObjectUrls(record);
			state.storeError = '';
		} catch (error) {
			state.storeError = error instanceof DiyStoreError ? error.message : String(error && error.message ? error.message : error);
		}
	}

	function refreshShelf() {
		if (hooks && typeof hooks.refreshShelf === 'function') hooks.refreshShelf();
	}

	/* ---------- 生成 ---------- */

	function guardOf(description) {
		return checkGarmentDescription(description);
	}

	/**
	 * 预热本地成层（675×1200 同量级输入）：在云端生成等待期间执行，用户无感；
	 * 目的是让首件成层的 V8 类型反馈/循环 JIT 就绪（实测冷启动 ~0.6s → 预热后 ~0.15s 量级）。
	 */
	function warmupLayerPipeline() {
		if (layersWarmed) return;
		layersWarmed = true;
		setTimeout(() => {
			try {
				const width = DIY_CANVAS.width;
				const height = DIY_CANVAS.height;
				const look = createRgbaImage(width, height, [255, 255, 255, 255]);
				const flatout = createRgbaImage(width, height, [255, 255, 255, 255]);
				const hair = createRgbaImage(width, height, [255, 255, 255, 0]);
				const arms = createRgbaImage(width, height, [255, 255, 255, 0]);
				const paint = (target, x0, y0, x1, y1, rgb) => {
					for (let y = y0; y < y1; y += 1) {
						for (let x = x0; x < x1; x += 1) {
							const p = (y * width + x) * 4;
							target.data[p] = rgb[0];
							target.data[p + 1] = rgb[1];
							target.data[p + 2] = rgb[2];
						}
					}
				};
				paint(look, 180, 420, 500, 1080, [232, 188, 168]);
				paint(look, 170, 470, 510, 800, [200, 60, 60]);
				paint(look, 170, 260, 510, 470, [40, 50, 140]);
				paint(flatout, 170, 470, 510, 800, [128, 128, 128]);
				paint(hair, 170, 260, 510, 470, [40, 50, 140]);
				paint(arms, 130, 760, 220, 980, [255, 255, 255]);
				paint(arms, 460, 760, 550, 980, [255, 255, 255]);
				extractDiyLayer({ look, flatout, hair, arms, category: 'top' });
			} catch {
				/* 预热失败不影响主流程 */
			}
		}, 30);
	}

	async function generate() {
		if (state.generating) return;
		const guard = guardOf(state.description);
		if (guard.action === 'reject') {
			update({ generateError: `${ERROR_TEXT.content_rejected} ${guard.reasons.join('；')}` });
			return;
		}
		if (!state.upload) {
			update({ generateError: '请先上传一张衣服图片（挂拍/穿着/平铺均可，只要衣服清晰）' });
			return;
		}
		if (!state.confirmCost) {
			update({ generateError: '请先勾选费用确认（本次约 2 张图）' });
			return;
		}
		update({ generating: true, generateError: '', result: null });
		warmupLayerPipeline();
		try {
			const response = await fetch(PROXY_GENERATE, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-feiyu-diy': '1' },
				body: JSON.stringify({
					category: state.category,
					description: state.description,
					imageDataUrl: state.upload.dataUrl,
					consent: true,
					confirmCost: true,
					reroll: state.reroll,
				}),
			});
			const payload = await response.json().catch(() => ({ ok: false, code: 'invalid_json' }));
			if (!response.ok || !payload.ok) {
				const code = payload && payload.code ? payload.code : 'network';
				const base = ERROR_TEXT[code] || String(payload.message || '生成失败');
				const detail = code === 'content_rejected' && payload.guard && payload.guard.hits ? `命中：${payload.guard.hits.join('、')}` : '';
				update({ generating: false, generateError: `${base} ${detail}`.trim() });
				return;
			}
			await buildLocalLayers(payload);
			update({ generating: false });
		} catch (error) {
			update({ generating: false, generateError: `${ERROR_TEXT.network}（${String(error && error.message ? error.message : error).slice(0, 120)}）` });
		}
	}

	async function buildLocalLayers(payload) {
		const [lookImage, flatoutImage, hair, arms, body] = await Promise.all([
			loadImage(payload.look.dataUrl),
			loadImage(payload.flatout.dataUrl),
			loadShapeLayer('hair'),
			loadShapeLayer('arms'),
			loadShapeLayer('body'),
		]);
		const look = imageDataOf(lookImage);
		const flatout = imageDataOf(flatoutImage);
		const started = performance.now();
		const result = extractDiyLayer({ look, flatout, hair, arms, category: payload.meta.category });
		const elapsed = performance.now() - started;
		if (!result.ok) {
			update({
				generateError: `本地成层失败（${result.reason || '未知原因'}），可重抽或换一张图重试。`,
				result: null,
			});
			return;
		}
		const bodyCanvas = buildLayerCanvas(look, result.bodyAlpha);
		const sleeveCanvas = result.sleeveAlpha ? buildLayerCanvas(look, result.sleeveAlpha) : null;
		// 试穿合成：按 v6 drawOrder 用本地成层结果 + 现有身体部件叠出来（与游戏渲染同口径）
		const garmentLayer = layerFromAlpha(look, result.bodyAlpha);
		const sleeveLayer = result.sleeveAlpha ? layerFromAlpha(look, result.sleeveAlpha) : null;
		const stack = [
			{ width: look.width, height: look.height, data: body.data },
			garmentLayer,
			{ width: look.width, height: look.height, data: arms.data },
			...(sleeveLayer ? [sleeveLayer] : []),
			{ width: look.width, height: look.height, data: hair.data },
		];
		const composite = compositeStack(look.width, look.height, stack);
		state.sessionImages += Number(payload.meta.cost && payload.meta.cost.images ? payload.meta.cost.images : 0);
		state.sessionCostYuan += Number(payload.meta.cost && payload.meta.cost.costYuan ? payload.meta.cost.costYuan : 0);
		update({
			result: {
				payload,
				lookImage,
				look,
				flatoutImage,
				bodyCanvas,
				sleeveCanvas,
				compositeCanvas: imageToCanvas(composite),
				qa: result.qa,
				grade: result.grade,
				defects: result.defects,
				elapsed,
			},
		});
	}

	async function saveResult() {
		if (!state.result || !state.result.payload) return;
		const { payload, bodyCanvas, sleeveCanvas } = state.result;
		const recordName = (state.name || '').trim() || `${DIY_CATEGORY_LABELS[state.category]} DIY`;
		const bodyBlob = await canvasToBlob(bodyCanvas, 'image/webp', 0.9);
		const sleeveBlob = sleeveCanvas ? await canvasToBlob(sleeveCanvas, 'image/webp', 0.9) : null;
		if (!bodyBlob) {
			update({ generateError: '图层编码失败（浏览器不支持 canvas.toBlob）' });
			return;
		}
		try {
			const digest = await sha256Hex(dataUrlBytes(state.upload.dataUrl));
			const record = makeDiyRecord({
				digestSha256: digest,
				name: recordName,
				category: state.category,
				layers: { body: bodyBlob, sleeve: sleeveBlob },
				contentPolicyTag: payload.meta.contentPolicyTag || contentPolicyTag(guardOf(state.description).action === 'downgrade' ? 'downgrade' : 'pass'),
				guardVersion: payload.meta.guardVersion || DIY_GUARD_VERSION,
				promptVersion: payload.meta.promptVersion,
				originalSha256: digest,
			});
			const saved = await putDiyRecord(record);
			ensureObjectUrls(saved.record);
			injectRecord(saved.record);
			await refreshRecords();
			refreshShelf();
			update({ result: null, storeError: '', generateError: '' });
			if (hooks && typeof hooks.say === 'function') hooks.say(`「${record.name}」已放进本地衣柜，可以试穿啦～`);
			if (saved.evicted.length > 0 && hooks && typeof hooks.say === 'function') {
				hooks.say(`衣柜满了，按最近穿着淘汰了 ${saved.evicted.length} 件旧 DIY。`);
			}
		} catch (error) {
			update({ storeError: error instanceof DiyStoreError ? error.message : String(error && error.message ? error.message : error) });
		}
	}

	function reroll() {
		state.reroll += 1;
		state.result = null;
		generate();
	}

	/* ---------- 试穿 / 删除 / 分享 ---------- */

	function wearRecord(record) {
		injectRecord(record);
		refreshShelf();
		const categoryKey = manifestCategoryKey(record.category);
		if (hooks && typeof hooks.select === 'function') hooks.select(categoryKey, record.id);
	}

	async function removeRecord(record) {
		try {
			await deleteDiyRecord(record.id);
			removeInjectedItem(record.id);
			await refreshRecords();
			refreshShelf();
			if (hooks && typeof hooks.resetState === 'function') hooks.resetState();
			if (hooks && typeof hooks.say === 'function') hooks.say('这件 DIY 已删除。');
			update({ storeError: '' });
		} catch (error) {
			update({ storeError: error instanceof DiyStoreError ? error.message : String(error && error.message ? error.message : error) });
		}
	}

	async function exportRecord(record) {
		update({ exportingId: record.id });
		try {
			const bytes = await buildSkinFile(record, {
				getBody: () => (record.layers.body instanceof Blob ? record.layers.body.arrayBuffer() : record.layers.body),
				getSleeve: record.layers.sleeve
					? () => (record.layers.sleeve instanceof Blob ? record.layers.sleeve.arrayBuffer() : record.layers.sleeve)
					: undefined,
			});
			downloadBytes(bytes, skinFileName(record));
			update({ exportingId: '', storeError: '' });
		} catch (error) {
			update({ exportingId: '', storeError: `导出失败：${String(error && error.message ? error.message : error)}` });
		}
	}

	async function importSkinFile(file) {
		if (!file) return;
		try {
			const parsed = await parseSkinFile(new Uint8Array(await file.arrayBuffer()));
			if (!parsed.ok) {
				update({ importError: `导入被拒绝：${parsed.errors.slice(0, 4).join('；')}` });
				return;
			}
			const record = makeDiyRecord({
				digestSha256: await sha256Hex(parsed.files.body),
				name: parsed.record.name,
				category: parsed.record.category,
				layers: {
					body: new Blob([parsed.files.body], { type: 'image/webp' }),
					sleeve: parsed.files.sleeve ? new Blob([parsed.files.sleeve], { type: 'image/webp' }) : null,
				},
				contentPolicyTag: parsed.record.contentPolicyTag,
				sourceType: 'dshskin-import',
				guardVersion: parsed.record.guardVersion,
				promptVersion: parsed.record.promptVersion,
			});
			const saved = await putDiyRecord(record);
			ensureObjectUrls(saved.record);
			injectRecord(saved.record);
			await refreshRecords();
			refreshShelf();
			update({ importError: '', storeError: '' });
			if (hooks && typeof hooks.say === 'function') hooks.say(`导入了一件 DIY：「${record.name}」`);
		} catch (error) {
			update({ importError: `导入失败：${String(error && error.message ? error.message : error)}` });
		}
	}

	/* ---------- 渲染 ---------- */

	function render() {
		if (!root) return;
		const container = root.querySelector('#diyBody');
		if (!container) return;
		container.textContent = '';
		if (state.result) {
			container.appendChild(renderResult());
			return;
		}
		const sections = [];
		if (!status) {
			sections.push(
				el('div', { class: 'diy-section' }, [
					el('p', { class: 'diy-note', text: state.loadingStatus ? '正在读取宿主状态…' : '需要宿主本地代理才能使用 DIY 上传（在线试玩页不可用）。' }),
					el('button', {
						class: 'btn primary',
						type: 'button',
						text: state.loadingStatus ? '读取中…' : '重试',
						disabled: state.loadingStatus ? 'disabled' : undefined,
						onclick: () => fetchStatus(),
					}),
				]),
			);
		} else if (status.offline) {
			sections.push(
				el('div', { class: 'diy-section' }, [
					el('p', { class: 'diy-note', text: '当前页面没有连上 DSH 宿主代理：DIY 上传需要在本机 DSH 插件面板里使用（离线换装不受影响）。' }),
					el('button', { class: 'btn', type: 'button', text: '重试', onclick: () => fetchStatus() }),
				]),
			);
		} else {
			if (!status.enabled) {
				sections.push(
					el('div', { class: 'diy-section' }, [
						el('p', { class: 'diy-note', text: `宿主未开启 DIY（默认关闭）。在 DSH 插件配置中设置 diy.enabled=true 并重启宿主后可用。当前版本仍可安全浏览旧衣柜。` }),
					]),
				);
			} else if (!status.hasApiKey) {
				sections.push(el('div', { class: 'diy-section' }, [el('p', { class: 'diy-note', text: ERROR_TEXT.missing_api_key })]));
			} else if (!state.consent.accepted) {
				sections.push(renderConsent());
			} else {
				sections.push(renderToggle());
				if (state.enabled) {
					sections.push(renderForm());
					sections.push(renderList());
				}
			}
		}
		for (const section of sections) container.appendChild(section);
	}

	/**
	 * @param {HTMLElement} node
	 * @param {ReturnType<typeof checkGarmentDescription>} guard
	 */
	function renderGuardLine(node, guard) {
		node.className = 'diy-note';
		if (!state.description) {
			node.textContent = '描述只会用于生成 prompt；不要写暴露/超短/性感向内容（会被直接拒绝）。';
			return;
		}
		if (guard.action === 'reject') {
			node.classList.add('diy-bad');
			node.textContent = `内容守卫：拒绝（${guard.hits.join('、')}），不会发送到云端。`;
		} else if (guard.action === 'downgrade') {
			node.classList.add('diy-warn');
			node.textContent = `内容守卫：偏短/贴身描述已自动改写为保守版型：${guard.description}`;
		} else {
			node.classList.add('diy-ok');
			node.textContent = '内容守卫：通过（保守版型约束 + 负向词已加入 prompt）。';
		}
	}

	function renderConsent() {
		return el('div', { class: 'diy-section diy-consent' }, [
			el('h4', { text: '开启前请确认（默认关闭）' }),
			el('ul', { class: 'diy-list' }, [
				el('li', { text: '上传的衣服图片会发送到云端图像 API（火山方舟 Seedream）用于生成角色穿着效果，按张计费；本项目不会保存原图到服务器。' }),
				el('li', { text: '每件约 2 张图，预估 ¥0.42–0.60；生成失败/重抽也按实际调用张数计费。' }),
				el('li', { text: '生成结果只存在你浏览器的本地衣柜（IndexedDB），可随时删除/导出；不上传服务器、无遥测。' }),
				el('li', { text: '内容规范：保守日常着装（有领/长袖/及膝/宽松）；暴露、超短、涉未成年人的输入会被直接拒绝。' }),
				el('li', { text: `同意记录版本：${DIY_CONSENT_VERSION}；关闭开关或清除浏览器数据即可撤销。` }),
			]),
			el('div', { class: 'diy-row' }, [
				el('button', {
					class: 'btn primary',
					type: 'button',
					text: '同意并开启',
					onclick: () => {
						writeConsent();
						writeEnabled(true);
						update({ consent: readConsent(), enabled: true });
					},
				}),
				el('button', {
					class: 'btn',
					type: 'button',
					text: '暂不开启',
					onclick: () => close(),
				}),
			]),
		]);
	}

	function renderToggle() {
		return el('div', { class: 'diy-section diy-row diy-toggle' }, [
			el('label', {}, [
				el('input', {
					type: 'checkbox',
					checked: state.enabled ? 'checked' : undefined,
					onchange: (event) => {
						const enabled = Boolean(event.target.checked);
						writeEnabled(enabled);
						update({ enabled });
					},
				}),
				' ',
				el('b', { text: 'DIY 上传（opt-in）' }),
			]),
			el('span', {
				class: 'diy-note',
				text: state.enabled ? `今日剩余 ${status.daily.remainingImages} 张 / ¥${status.daily.remainingBudgetYuan}` : '已关闭：不会发起任何网络请求',
			}),
		]);
	}

	function renderForm() {
		const categories = activeCategories();
		const guardLine = el('p', { class: 'diy-note', id: 'diyGuardLine' });
		renderGuardLine(guardLine, guardOf(state.description));
		const estimate = (status && status.estimate) || { costRangeYuan: [0.42, 0.6], images: 2 };
		const uploadArea = el('div', { class: 'diy-upload' }, [
			el('input', {
				type: 'file',
				id: 'diyFile',
				accept: 'image/png,image/jpeg,image/webp',
				hidden: 'hidden',
				onchange: (event) => {
					const file = event.target.files && event.target.files[0];
					if (!file) return;
					compressImageFile(file).then(
						(upload) => update({ upload }),
						(error) => update({ generateError: String(error.message || error) }),
					);
				},
			}),
			el('label', { class: 'btn', for: 'diyFile', text: state.upload ? '重新选择图片' : '📷 上传衣服图片' }),
			state.upload ? el('img', { class: 'diy-thumb', src: state.upload.dataUrl, alt: '上传预览' }) : null,
		]);
		return el('div', { class: 'diy-section' }, [
			el('div', { class: 'diy-row' }, [
				el('label', { class: 'diy-label', text: '品类' }),
				el('div', { class: 'diy-chips' }, categories.map((category) =>
					el('button', {
						type: 'button',
						class: `diy-chip${state.category === category ? ' active' : ''}`,
						text: DIY_CATEGORY_LABELS[category],
						onclick: () => update({ category, result: null }),
					}),
				)),
			]),
			el('div', { class: 'diy-row' }, [
				el('label', { class: 'diy-label', text: '名称' }),
				el('input', {
					class: 'diy-input',
					type: 'text',
					maxlength: '24',
					placeholder: '例如：蓝色格纹及膝裙',
					value: state.name,
					oninput: (event) => {
						state.name = event.target.value;
					},
				}),
			]),
			el('div', { class: 'diy-row' }, [
				el('label', { class: 'diy-label', text: '描述' }),
				el('textarea', {
					class: 'diy-input',
					rows: '2',
					maxlength: '160',
					placeholder: '客观描述衣服（颜色/版型/材质/图案），例如：藏青色长袖针织开衫，及膝长度，宽松版型',
					oninput: (event) => {
						state.description = event.target.value;
						const line = document.getElementById('diyGuardLine');
						if (line) renderGuardLine(line, guardOf(state.description));
					},
				}, state.description),
			]),
			guardLine,
			uploadArea,
			el('p', { class: 'diy-note', text: `本次预计 ${estimate.images || 2} 张 ≈ ¥${(estimate.costRangeYuan || [0.42, 0.6]).join('–')}（今日剩余 ${status.daily.remainingImages} 张 / ¥${status.daily.remainingBudgetYuan}）` }),
			el('label', { class: 'diy-note' }, [
				el('input', {
					type: 'checkbox',
					checked: state.confirmCost ? 'checked' : undefined,
					onchange: (event) => {
						state.confirmCost = Boolean(event.target.checked);
					},
				}),
				' 我了解本次会调用云端图像 API 并产生费用（按实际调用张数计费）',
			]),
			state.sessionImages > 0 ? el('p', { class: 'diy-note', text: `本次会话已生成 ${state.sessionImages} 张 ≈ ¥${state.sessionCostYuan.toFixed(2)}` }) : null,
			state.generateError ? el('p', { class: 'diy-note diy-bad', text: state.generateError }) : null,
			el('div', { class: 'diy-row' }, [
				el('button', {
					class: 'btn primary',
					type: 'button',
					text: state.generating ? '生成中…（约 20–60 秒）' : '生成并预览',
					disabled: state.generating ? 'disabled' : undefined,
					onclick: () => generate(),
				}),
			]),
		]);
	}

	function renderList() {
		const statsLine = el('p', { class: 'diy-note', text: `本地衣柜：${records.length}/${DIY_MAX_ITEMS} 件` });
		const rows = records.map((record) =>
			el('div', { class: 'diy-item' }, [
				el('img', { class: 'diy-item-thumb', src: objectUrls.get(record.id) ? objectUrls.get(record.id).body : '', alt: record.name }),
				el('div', { class: 'diy-item-meta' }, [
					el('b', { text: record.name }),
					el('span', { text: `${DIY_CATEGORY_LABELS[record.category] || record.category} · ${(record.bytes / 1024).toFixed(0)}KB · ${record.contentPolicyTag}` }),
				]),
				el('div', { class: 'diy-item-actions' }, [
					el('button', { class: 'btn mini', type: 'button', text: '穿上', onclick: () => wearRecord(record) }),
					el('button', { class: 'btn mini', type: 'button', text: state.exportingId === record.id ? '导出中…' : '导出 .dshskin', onclick: () => exportRecord(record) }),
					el('button', { class: 'btn mini danger', type: 'button', text: '删除', onclick: () => removeRecord(record) }),
				]),
			]),
		);
		return el('div', { class: 'diy-section' }, [
			el('h4', { text: '我的 DIY 衣柜' }),
			statsLine,
			state.storeError ? el('p', { class: 'diy-note diy-bad', text: state.storeError }) : null,
			...rows,
			el('div', { class: 'diy-row' }, [
				el('input', {
					type: 'file',
					id: 'diyImport',
					accept: '.dshskin',
					hidden: 'hidden',
					onchange: (event) => {
						const file = event.target.files && event.target.files[0];
						if (file) importSkinFile(file);
					},
				}),
				el('label', { class: 'btn', for: 'diyImport', text: '📥 导入 .dshskin' }),
			]),
			state.importError ? el('p', { class: 'diy-note diy-bad', text: state.importError }) : null,
		]);
	}

	function renderResult() {
		const result = state.result;
		const gradeText = result.grade === 'pass' ? '可用' : result.grade === 'needs-fix' ? '需修（可保存）' : '失败（不可保存）';
		const preview = el('div', { class: 'diy-preview' }, [
			el('figure', {}, [el('figcaption', { text: 'look（云端生成）' }), el('img', { src: result.payload.look.dataUrl, alt: 'look' })]),
			el('figure', {}, [el('figcaption', { text: '图层（本地成层）' }), el('img', { src: result.bodyCanvas.toDataURL('image/png'), alt: '图层' })]),
			el('figure', {}, [el('figcaption', { text: '试穿合成' }), el('img', { src: result.compositeCanvas.toDataURL('image/png'), alt: '合成' })]),
		]);
		const qa = result.qa || {};
		const defectList = Array.isArray(result.defects) && result.defects.length > 0 ? result.defects.join('；') : '无';
		return el('div', { class: 'diy-section' }, [
			el('h4', { text: `预览结果 · 自动 QA：${gradeText}` }),
			preview,
			el('p', { class: 'diy-note' }, [
				`α洞 ${qa.alphaHolePx || 0}px · 缺衣 ${qa.missingGarmentPx || 0}px · 背景残留 ${qa.bgResiduePx || 0}px · 白边 ${((qa.whiteFringeFrac || 0) * 100).toFixed(1)}% · 同姿势配准 ${qa.poseShiftPx || 0}px`,
			]),
			el('p', { class: 'diy-note', text: `缺陷：${defectList} · 本地成层耗时 ${Math.round(result.elapsed)}ms · 云端 ${Math.round(result.payload.meta.latencyMs || 0)}ms` }),
			result.grade === 'fail' ? el('p', { class: 'diy-note diy-bad', text: '这张图成层质量不达标（硬性缺陷），建议重抽或换一张清晰的衣服图。' }) : null,
			el('div', { class: 'diy-row' }, [
				el('button', {
					class: 'btn primary',
					type: 'button',
					text: '保存到本地衣柜',
					disabled: result.grade === 'fail' ? 'disabled' : undefined,
					onclick: () => saveResult(),
				}),
				el('button', { class: 'btn', type: 'button', text: '重抽（约 ¥0.42–0.60）', onclick: () => reroll() }),
				el('button', { class: 'btn', type: 'button', text: '放弃', onclick: () => update({ result: null }) }),
			]),
			state.generateError ? el('p', { class: 'diy-note diy-bad', text: state.generateError }) : null,
			state.storeError ? el('p', { class: 'diy-note diy-bad', text: state.storeError }) : null,
		]);
	}

	/* ---------- 公开 API ---------- */

	async function prepare() {
		if (!readEnabled()) return { loaded: false };
		await refreshRecords();
		for (const record of records) {
			try {
				ensureObjectUrls(record);
				injectRecord(record);
			} catch {
				/* 单条损坏不影响启动 */
			}
		}
		return { loaded: true, records: records.length };
	}

	function attach(api) {
		hooks = api;
		root = document.getElementById('diySheet');
		if (!root) return;
		const button = document.getElementById('diyBtn');
		if (button) button.addEventListener('click', () => open());
		const closeButton = document.getElementById('diyClose');
		if (closeButton) closeButton.addEventListener('click', () => close());
		root.addEventListener('click', (event) => {
			if (event.target === root) close();
		});
		window.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && state.open) close();
		});
	}

	async function open() {
		if (!root) return;
		state.open = true;
		root.hidden = false;
		if (state.enabled && records.length === 0) await refreshRecords();
		render();
		if (!status) await fetchStatus();
	}

	/**
	 * QA 用：在浏览器内测 675×1200 单件成层的冷启动 + 预热中位数（不影响正常流程）。
	 * @param {{ runs?: number }} [options]
	 */
	function benchLayerPipeline(options = {}) {
		const runs = Math.max(2, Math.min(20, Number(options.runs) || 5));
		const width = DIY_CANVAS.width;
		const height = DIY_CANVAS.height;
		const look = createRgbaImage(width, height, [255, 255, 255, 255]);
		const flatout = createRgbaImage(width, height, [255, 255, 255, 255]);
		const hair = createRgbaImage(width, height, [255, 255, 255, 0]);
		const arms = createRgbaImage(width, height, [255, 255, 255, 0]);
		const paint = (target, x0, y0, x1, y1, rgb) => {
			for (let y = y0; y < y1; y += 1) {
				for (let x = x0; x < x1; x += 1) {
					const p = (y * width + x) * 4;
					target.data[p] = rgb[0];
					target.data[p + 1] = rgb[1];
					target.data[p + 2] = rgb[2];
				}
			}
		};
		paint(look, 180, 420, 500, 1080, [232, 188, 168]);
		paint(look, 170, 470, 510, 800, [200, 60, 60]);
		paint(look, 170, 260, 510, 470, [40, 50, 140]);
		paint(flatout, 170, 470, 510, 800, [128, 128, 128]);
		paint(hair, 170, 260, 510, 470, [40, 50, 140]);
		paint(arms, 130, 760, 220, 980, [255, 255, 255]);
		paint(arms, 460, 760, 550, 980, [255, 255, 255]);
		const input = { look, flatout, hair, arms, category: 'top' };
		const times = [];
		let coldMs = 0;
		for (let i = 0; i < runs; i += 1) {
			const started = performance.now();
			extractDiyLayer(input);
			const elapsed = performance.now() - started;
			if (i === 0) coldMs = elapsed;
			else times.push(elapsed);
		}
		times.sort((a, b) => a - b);
		return {
			coldMs: Math.round(coldMs),
			warmMedianMs: Math.round(times[Math.floor(times.length / 2)]),
			warmMinMs: Math.round(times[0]),
			runs,
		};
	}

	return {
		prepare,
		attach,
		open,
		close,
		_benchLayerPipeline: benchLayerPipeline,
		get state() {
			return state;
		},
		get records() {
			return records;
		},
		get status() {
			return status;
		},
		refreshRecords,
		_generate: generate,
		_importSkinFile: importSkinFile,
		_saveResult: saveResult,
	};
}

export { isDiyItemId };

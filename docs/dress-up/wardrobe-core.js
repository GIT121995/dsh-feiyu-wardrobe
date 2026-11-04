/**
 * 大肥鱼衣橱 · 换装间核心规则（纯函数，浏览器与单元测试共用）
 *
 * v2（2.5D-only）：渲染由 runtime-2d5.js 负责，本模块只保留「换装状态 + 衣柜数据 + DIY 注入」
 * 这类与渲染技术无关的规则：
 *   - 穿搭状态：默认值/校验/选中/切身形/描述/随机；
 *   - 衣柜数据：分类/单品查找/图鉴收集；
 *   - DIY 本地衣柜记录 → 运行时注入单品（贴片渲染由页面 canvas 2D 负责）。
 * DOM 分层纸娃娃（v6/v7 的 drawOrder/layers/face 补丁）在 2.0.0 移除。
 *
 * @module dsh-feiyu-wardrobe/wardrobe-core
 */

/**
 * 人物内容上下边界（0–1，相对整张画布高度）。
 * @typedef {object} Bounds
 * @property {number} top
 * @property {number} bottom
 */

/**
 * 按 id 找身形；找不到时回退第一个身形（容错口径统一）。
 * @param {any} manifest
 * @param {string} [shapeId]
 * @returns {any | null}
 */
function findShape(manifest, shapeId) {
	const shapes = Array.isArray(manifest.shapes) ? manifest.shapes : [];
	return shapes.find((entry) => entry.id === shapeId) || shapes[0] || null;
}

/**
 * 按分类 / 单品 id 找衣柜单品；找不到返回 null。
 * @param {any} manifest
 * @param {string} categoryId
 * @param {string} itemId
 * @returns {any | null}
 */
function findItem(manifest, categoryId, itemId) {
	const groups = (manifest.items && manifest.items[categoryId]) || [];
	return groups.find((entry) => entry.id === itemId) || null;
}

/**
 * 当前身形的人物内容上下边界。
 * 同一身形的素体/图层共用同一画布坐标，所以边界由身形固定、不随穿搭变化。
 * @param {any} manifest
 * @param {Record<string, string>} state
 * @returns {Bounds}
 */
export function currentBounds(manifest, state) {
	const snapshot = state || {};
	const shape = findShape(manifest, snapshot.shape);
	const bounds = (shape && shape.bounds) || {};
	return {
		top: typeof bounds.top === 'number' ? bounds.top : 0.06,
		bottom: typeof bounds.bottom === 'number' ? bounds.bottom : 0.94,
	};
}

/**
 * 建立默认穿搭。
 * @param {any} manifest
 * @returns {Record<string, string>}
 */
export function defaultState(manifest) {
	const state = { shape: manifest.defaults.shape };
	for (const category of manifest.categories) {
		const value = manifest.defaults[category.stateKey];
		const items = manifest.items[category.id] || [];
		state[category.stateKey] = value && items.some((item) => item.id === value) ? value : items[0].id;
	}
	return state;
}

/**
 * 校验/补全一份穿搭状态（localStorage、URL 参数、悬浮鲸鱼同步都走这里）。
 * @param {any} manifest
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {Record<string, string>}
 */
export function normalizeState(manifest, raw) {
	const state = defaultState(manifest);
	if (!raw || typeof raw !== 'object') return state;
	if (typeof raw.shape === 'string' && manifest.shapes.some((shape) => shape.id === raw.shape)) {
		state.shape = raw.shape;
	}
	for (const category of manifest.categories) {
		const wanted = raw[category.stateKey];
		if (typeof wanted !== 'string') continue;
		const items = manifest.items[category.id] || [];
		if (items.some((item) => item.id === wanted)) state[category.stateKey] = wanted;
	}
	return state;
}

/**
 * 选中某个部位的单品，返回新状态（不修改入参）。
 * - 选「套装」里的非空项 → 套装模式；
 * - 选上衣 / 下装 → 自动退出套装模式（连衣裙与上下装互斥）。
 * @param {any} manifest
 * @param {Record<string, string>} state
 * @param {string} categoryId
 * @param {string} itemId
 * @returns {Record<string, string>}
 */
export function applySelection(manifest, state, categoryId, itemId) {
	const category = manifest.categories.find((entry) => entry.id === categoryId);
	if (!category) return state;
	const items = manifest.items[categoryId] || [];
	if (!items.some((item) => item.id === itemId)) return state;
	/** @type {Record<string, string>} */
	const next = { ...state, [category.stateKey]: itemId };
	if (categoryId === 'outfits' && itemId !== 'none') {
		next.outfit = itemId;
	} else if (categoryId === 'tops' || categoryId === 'bottoms') {
		next.outfit = 'none';
	}
	return next;
}

/** 切换身形（chibi / girl）。 */
export function applyShape(manifest, state, shapeId) {
	if (!manifest.shapes.some((shape) => shape.id === shapeId)) return state;
	return { ...state, shape: shapeId };
}

/**
 * 一句话描述当前穿搭（衣柜底部信息条用）。
 * @param {any} manifest
 * @param {Record<string, string>} state
 * @returns {{ name: string, detail: string }}
 */
export function describeOutfit(manifest, state) {
	const find = (categoryId, itemId) =>
		(manifest.items[categoryId] || []).find((entry) => entry.id === itemId) || null;
	let name;
	if (state.outfit && state.outfit !== 'none') {
		const outfit = find('outfits', state.outfit);
		name = outfit ? outfit.name : '套装';
	} else {
		const top = find('tops', state.top);
		const bottom = find('bottoms', state.bottom);
		name = [top && top.name, bottom && bottom.name].filter(Boolean).join(' + ') || '上衣 + 下装';
	}
	const shape = manifest.shapes.find((entry) => entry.id === state.shape);
	const bg = find('backgrounds', state.bg);
	const effect = find('effects', state.effect);
	const detail = [shape && shape.name, bg && bg.name, effect && effect.id !== 'none' ? effect.name : null]
		.filter(Boolean)
		.join(' · ');
	return { name, detail };
}

/**
 * 随机一套穿搭（游戏里的「随机换装」）。
 * @param {any} manifest
 * @param {Record<string, string>} state
 * @param {() => number} [random]
 * @returns {Record<string, string>}
 */
export function randomOutfit(manifest, state, random = Math.random) {
	const pick = (categoryId) => {
		const list = (manifest.items[categoryId] || []).filter(
			(item) => item.id !== 'none' && item.id !== state[manifest.categories.find((c) => c.id === categoryId).stateKey],
		);
		const pool = list.length ? list : (manifest.items[categoryId] || []).filter((item) => item.id !== 'none');
		if (!pool.length) return 'none';
		return pool[Math.floor(random() * pool.length) % pool.length].id;
	};
	const next = { ...state };
	if (random() < 0.65) {
		next.outfit = pick('outfits');
	} else {
		next.outfit = 'none';
		next.top = pick('tops');
		next.bottom = pick('bottoms');
	}
	next.bg = pick('backgrounds');
	next.effect = pick('effects');
	return next;
}

/* ---------------- DIY 上传层（manifest v7 扩展，v6 数据语义不变） ---------------- */

/** 衣柜里所有可展示的单品（图鉴用）。 */
export function collectItems(manifest) {
	const groups = [];
	for (const category of manifest.categories) {
		const items = (manifest.items[category.id] || []).filter((item) => item.id !== 'none');
		if (items.length) groups.push({ category, items });
	}
	return groups;
}

import { DIY_CATEGORY_SLOTS } from './diy-guard.js';

/** DIY 扩展 schema 版本（写进 `.dshskin` / IndexedDB 记录）。 */
export const DIY_LAYER_MODEL_VERSION = 1;

/** DIY 单品 id 前缀（与静态衣柜单品区分；state 里持久化的是完整 id）。 */
export const DIY_ID_PREFIX = 'diy-';

/** 单个 DIY 品类的槽位映射（v7 契约：顶层/套装走 topBody + 可选 sleeve，下装只占 bottom）。 */
export const DIY_LAYER_SLOTS = DIY_CATEGORY_SLOTS;

/** 本地衣柜默认上限（与 manifest.diy 一致）。 */
export const DIY_MAX_ITEMS = 24;

/**
 * DIY 贴片按槽位顺序展开（2.5D 静态贴片用；全画布 675×1200 透明位图）。
 * 顺序参考原 DOM drawOrder：bottom 低于 topBody，sleeve 最上。
 * @param {any} item 注入后的 DIY 单品（含 `layers[shape][slot] = url|url[]`）
 * @param {string} [shape]
 * @returns {string[]}
 */
export function diyLayerUrls(item, shape = 'chibi') {
	const layers = (item && item.layers && item.layers[shape]) || {};
	const order = ['topUnder', 'bottom', 'topBody', 'body', 'sleeve'];
	/** @type {string[]} */
	const urls = [];
	for (const slot of order) {
		const value = layers[slot];
		if (!value) continue;
		for (const url of Array.isArray(value) ? value : [value]) if (url) urls.push(url);
	}
	return urls;
}


/**
 * DIY 衣柜记录（IndexedDB / `.dshskin` 共用 schema）。
 *
 * @typedef {object} DiyRecord
 * @property {string} id 形如 `diy-<hash>`
 * @property {string} name 展示名（≤24 字）
 * @property {'top'|'bottom'|'dress'|'coat'|'outfit'} category
 * @property {'chibi'} shape 目前仅 Q版
 * @property {{ body: Blob | Uint8Array | string, sleeve?: Blob | Uint8Array | string | null }} layers
 *   图层数据（浏览器为 Blob；`.dshskin` 校验时为字节；运行时注入时换为 blob URL）
 * @property {{ type: 'user-upload' | 'dshskin-import', license: string, originalSha256?: string }} source
 * @property {string} contentPolicyTag conservative-v1 / conservative-downgraded-v1
 * @property {number} createdAt 毫秒时间戳
 * @property {number} [lastUsedAt] 最近穿着时间（LRU 淘汰用）
 * @property {number} bytes 图层总字节数（配额/LRU）
 * @property {number} [version] 记录 schema 版本
 * @property {string} [guardVersion]
 * @property {string} [promptVersion]
 */

/**
 * 校验一条 DIY 衣柜记录（存储/导入共用；不检查 Blob 内容，只校验 schema）。
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[], record: DiyRecord | null }}
 */
export function validateDiyRecord(raw) {
	/** @type {string[]} */
	const errors = [];
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, errors: ['记录必须是对象'], record: null };
	}
	const record = /** @type {any} */ (raw);
	const category = record.category;
	if (typeof category !== 'string' || !DIY_LAYER_SLOTS[category]) {
		errors.push(`非法品类：${String(category)}`);
	}
	if (record.shape !== 'chibi') errors.push('目前只支持 chibi 身形');
	if (typeof record.id !== 'string' || !record.id.startsWith(DIY_ID_PREFIX) || record.id.length > 80) {
		errors.push('id 必须为 diy- 前缀的字符串（≤80）');
	}
	if (typeof record.name !== 'string' || record.name.trim().length === 0 || record.name.length > 24) {
		errors.push('name 必须为 1–24 字的字符串');
	}
	const layers = record.layers;
	const hasBody = layers && typeof layers === 'object' && layers.body !== undefined && layers.body !== null;
	if (!hasBody) errors.push('缺少 layers.body（衣身层）');
	if (record.layers && record.layers.sleeve !== undefined && record.layers.sleeve !== null) {
		const slot = DIY_LAYER_SLOTS[category];
		if (!slot || !slot.sleeve) errors.push('该品类不接受 sleeve 层');
	}
	if (!record.source || typeof record.source !== 'object') errors.push('缺少 source');
	else {
		if (!['user-upload', 'dshskin-import'].includes(record.source.type)) {
			errors.push('source.type 非法');
		}
		if (typeof record.source.license !== 'string' || record.source.license.length === 0) {
			errors.push('缺少 source.license');
		}
	}
	if (typeof record.contentPolicyTag !== 'string' || !/^conservative(-downgraded)?-v\d+$/.test(record.contentPolicyTag)) {
		errors.push('contentPolicyTag 非法');
	}
	if (!Number.isFinite(record.createdAt) || record.createdAt <= 0) errors.push('createdAt 非法');
	if (!Number.isFinite(record.bytes) || record.bytes < 0) errors.push('bytes 非法');
	return { ok: errors.length === 0, errors, record: errors.length === 0 ? /** @type {DiyRecord} */ (record) : null };
}

/**
 * 把 DIY 记录注入 manifest.items 之前转换成标准单品对象（运行时层）。
 * 图层文件为 blob URL / data URL / 相对路径字符串（由调用方先创建 object URL）。
 *
 * @param {DiyRecord} record
 * @param {{ body: string, sleeve?: string | null }} urls
 * @returns {any} manifest v7 item（同时兼容 v6 的 `layers[shapeId][slot]` 结构）
 */
export function diyRecordToItem(record, urls) {
	const slot = DIY_LAYER_SLOTS[record.category];
	if (!slot) throw new Error(`非法 DIY 品类：${record.category}`);
	/** @type {Record<string, string>} */
	const layers = { [slot.slot]: urls.body };
	if (slot.sleeve && urls.sleeve) layers.sleeve = urls.sleeve;
	return {
		id: record.id,
		name: record.name,
		desc: `DIY 上传 · ${record.category} · ${record.contentPolicyTag}`,
		emoji: '✨',
		diy: true,
		contentPolicyTag: record.contentPolicyTag,
		layers: { [record.shape]: layers },
	};
}

/**
 * 判断是否为 DIY 单品 id。
 * @param {unknown} itemId
 * @returns {boolean}
 */
export function isDiyItemId(itemId) {
	return typeof itemId === 'string' && itemId.startsWith(DIY_ID_PREFIX);
}

/**
 * 本地衣柜的 LRU/配额选择：返回应淘汰的记录 id（从最旧开始）。
 *
 * @param {DiyRecord[]} records
 * @param {{ maxItems?: number, maxBytes?: number, keepId?: string }} [options]
 * @returns {{ evictIds: string[], totalBytes: number, count: number }}
 */
export function selectDiyEvictions(records, options = {}) {
	const maxItems = Math.max(1, Number(options.maxItems ?? DIY_MAX_ITEMS));
	const maxBytes = Math.max(0, Number(options.maxBytes ?? 24 * 1024 * 1024));
	const list = Array.isArray(records) ? records.slice() : [];
	const totalBytes = list.reduce((sum, record) => sum + (Number(record.bytes) || 0), 0);
	if (list.length <= maxItems && totalBytes <= maxBytes) {
		return { evictIds: [], totalBytes, count: list.length };
	}
	const candidates = list
		.filter((record) => record.id !== options.keepId)
		.sort((a, b) => (Number(a.lastUsedAt) || Number(a.createdAt) || 0) - (Number(b.lastUsedAt) || Number(b.createdAt) || 0));
	/** @type {string[]} */
	const evictIds = [];
	let remainingCount = list.length;
	let remainingBytes = totalBytes;
	for (const record of candidates) {
		if (remainingCount <= maxItems && remainingBytes <= maxBytes) break;
		evictIds.push(record.id);
		remainingCount -= 1;
		remainingBytes -= Number(record.bytes) || 0;
	}
	return { evictIds, totalBytes, count: list.length };
}

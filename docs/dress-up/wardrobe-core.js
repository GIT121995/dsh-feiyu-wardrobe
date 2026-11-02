/**
 * 大肥鱼衣橱 · 换装间核心规则（纯函数，浏览器与单元测试共用）
 *
 * 换装模型（v5 · 真·分层换装 / 纸娃娃）：
 *   - 每个身形一张「素体（base）」+ 一张「头发/尾巴叠层（overlay）」；
 *   - 每件衣服是一张与素体同画布、同坐标的透明图层，运行时按 z 序叠放：
 *     base(0) → 下装(20) → 上装(30) → overlay(100)；
 *   - 套装（连衣裙）占 z=30 的一层，与「上衣 + 下装」互斥；
 *   - 背景、特效独立可叠。
 *
 * 图层都由「同一张素体上生成的单件穿着 look」经像素级 matte 得到，
 * 所有 look 都继承素体的构图（位置/比例/姿势），天然对齐，
 * 所以运行时不需要任何锚点/配准数据。
 *
 * @module dsh-feiyu-wardrobe/wardrobe-core
 */

/**
 * 一个可渲染的图层。
 * @typedef {object} Layer
 * @property {'base' | 'bottom' | 'top' | 'outfit' | 'overlay'} kind 图层种类（同时决定渲染槽位）
 * @property {string} file 相对 `docs/dress-up/` 的图片路径（空串表示该层没有素材）
 * @property {number} z 叠放层级，越大越靠上
 */

/**
 * 人物内容上下边界（0–1，相对整张画布高度）。
 * @typedef {object} Bounds
 * @property {number} top
 * @property {number} bottom
 */

/**
 * 按 id 找身形；找不到时回退第一个身形（与 resolveLayers 的容错规则一致）。
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
 * 单品在指定身形下的图层路径；缺失时返回空串。
 * @param {any} item
 * @param {string} shapeId
 * @returns {string}
 */
function layerFile(item, shapeId) {
	const file = item && item.layer && item.layer[shapeId];
	return typeof file === 'string' && file ? file : '';
}

/**
 * 单品的 z 值（缺省时用默认值）。
 * @param {any} item
 * @param {number} fallback
 * @returns {number}
 */
function zOf(item, fallback) {
	return item && typeof item.z === 'number' ? item.z : fallback;
}

/**
 * 当前穿搭需要渲染的图层，按 z 稳定升序（同 z 保持 base→下装→上装→overlay 的插入顺序）。
 *
 * 规则：
 *   - `state.shape` 非法时回退 `shapes[0].id`；
 *   - 恒含 `base` 与 `overlay` 两层；
 *   - `state.outfit` 非空且不为 `'none'` → 只加套装层，不加 top / bottom；
 *   - 否则加 bottom（默认 z=20）与 top（默认 z=30）；
 *   - 单品在 manifest 里找不到、或缺少当前身形的图层路径 → 跳过该层，不抛错。
 *
 * @param {any} manifest
 * @param {Record<string, string>} state
 * @returns {Layer[]}
 */
export function resolveLayers(manifest, state) {
	const snapshot = state || {};
	const shape = findShape(manifest, snapshot.shape);
	const shapeId = shape ? shape.id : '';
	/** @type {Layer[]} */
	const layers = [];

	// 素体与头发/尾巴叠层恒在（缺字段时 file 为空串，由调用方决定是否渲染）
	layers.push({ kind: 'base', file: (shape && shape.base) || '', z: 0 });

	if (snapshot.outfit && snapshot.outfit !== 'none') {
		// 套装模式：连衣裙独占衣服层，与上衣 / 下装互斥
		const outfit = findItem(manifest, 'outfits', snapshot.outfit);
		const file = layerFile(outfit, shapeId);
		if (file) layers.push({ kind: 'outfit', file, z: zOf(outfit, 30) });
	} else {
		// 上下装模式：下装在里、上装在外
		const bottom = findItem(manifest, 'bottoms', snapshot.bottom);
		const bottomFile = layerFile(bottom, shapeId);
		if (bottomFile) layers.push({ kind: 'bottom', file: bottomFile, z: zOf(bottom, 20) });
		const top = findItem(manifest, 'tops', snapshot.top);
		const topFile = layerFile(top, shapeId);
		if (topFile) layers.push({ kind: 'top', file: topFile, z: zOf(top, 30) });
	}

	layers.push({ kind: 'overlay', file: (shape && shape.overlay) || '', z: 100 });
	return layers.sort((a, b) => a.z - b.z);
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

/** 衣柜里所有可展示的单品（图鉴用）。 */
export function collectItems(manifest) {
	const groups = [];
	for (const category of manifest.categories) {
		const items = (manifest.items[category.id] || []).filter((item) => item.id !== 'none');
		if (items.length) groups.push({ category, items });
	}
	return groups;
}

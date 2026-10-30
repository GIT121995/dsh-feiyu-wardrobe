/**
 * 大肥鱼衣橱 · 换装间核心规则（纯函数，浏览器与单元测试共用）
 *
 * 换装模型（v4）：
 *   - 两种身形：Q版 / 少女版，各有一套「整套穿着立绘」；
 *   - 衣柜分「套装」（连衣裙整套）与「上衣 + 下装」（组合整套）两种模式；
 *   - 选套装 → 直接用套装立绘；选上衣/下装 → 自动切到组合模式，
 *     组合立绘文件按 `art/<shape>/combo-<top>-<bottom>.webp` 约定解析；
 *   - 背景、特效独立可叠。
 *
 * 立绘都是 Seedream 在素体上直接生成的「穿好衣服的完整图」，
 * 所以不存在衣服浮空/贴不上的问题；不同立绘之间的头部/脚位置一致。
 *
 * @module dsh-feiyu-wardrobe/wardrobe-core
 */

/** 立绘文件解析：当前穿搭 → art 目录下的相对路径。 */
export function resolveImage(manifest, state) {
	const shape = manifest.shapes.some((entry) => entry.id === state.shape) ? state.shape : manifest.shapes[0].id;
	if (state.outfit && state.outfit !== 'none') return `art/${shape}/dress-${state.outfit}.webp`;
	const top = state.top || manifest.defaults.top;
	const bottom = state.bottom || manifest.defaults.bottom;
	return `art/${shape}/combo-${top}-${bottom}.webp`;
}

/** 当前立绘的内容上下边界（用于把立绘缩放到舞台合适大小）。 */
export function currentBounds(manifest, state) {
	const file = resolveImage(manifest, state);
	const bounds = (manifest.bounds && manifest.bounds[file]) || {};
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
	if (manifest.shapes.some((shape) => shape.id === raw.shape)) state.shape = raw.shape;
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

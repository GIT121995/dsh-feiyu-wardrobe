/**
 * 大肥鱼衣橱 · 换装间核心规则（纯函数，浏览器与单元测试共用）
 *
 * 换装模型（v6 · 七槽位纸娃娃）：
 *   - `manifest.drawOrder` 定义从下到上的深度槽位：
 *     body → topUnder → bottom → topBody → arms → sleeve → hair；
 *   - 身形固定提供 body / arms / hair 三层（素体、手臂+手、完整前发）；
 *   - 衣服按槽位拆层：上衣主体 topUnder（塞进裙子）或 topBody（盖在裙子外）、
 *     袖子 sleeve（盖在手臂上）、下装 bottom（在手臂层之下）；
 *   - 套装（连衣裙）走 topBody + sleeve，与「上衣 + 下装」互斥；
 *   - `resolveLayers` 把「身形层 + 当前穿搭层」按 drawOrder 排成一次绘制序列，
 *     页面 DOM、立绘卡、悬浮鲸鱼小图都按这个序列叠图。
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
 * @property {string} slot 槽位名（`manifest.drawOrder` 中的一项）
 * @property {string} file 相对 `docs/dress-up/` 的图片路径
 * @property {number} z 叠放层级（= 该槽位在 drawOrder 里的下标），越大越靠上
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
 * drawOrder 里合法的槽位列表（去重、忽略非字符串项；manifest 没给时为 []）。
 * @param {any} manifest
 * @returns {string[]}
 */
function drawOrderOf(manifest) {
	const order = manifest && Array.isArray(manifest.drawOrder) ? manifest.drawOrder : [];
	/** @type {string[]} */
	const slots = [];
	for (const slot of order) {
		if (typeof slot !== 'string' || !slot || slots.includes(slot)) continue;
		slots.push(slot);
	}
	return slots;
}

/**
 * 把「slot → 文件路径」映射里合法且存在的图层收进槽位表。
 * - 文件为空 / 不是字符串 → 视为缺文件，跳过；
 * - 槽位不在 drawOrder 里 → 视为非法槽位，跳过；
 * - 同一槽位只保留先出现的文件（身形层优先于单品层）。
 * @param {any} layers slot → 相对图片路径
 * @param {string[]} drawOrder
 * @param {Map<string, string>} out
 */
function collectSlots(layers, drawOrder, out) {
	if (!layers || typeof layers !== 'object') return;
	for (const [slot, file] of Object.entries(layers)) {
		if (typeof file !== 'string' || !file) continue;
		if (!drawOrder.includes(slot)) continue;
		if (out.has(slot)) continue;
		out.set(slot, file);
	}
}

/**
 * 收进某件单品在指定身形下的图层（manifest v6：`items[].layers[shapeId]`）。
 * @param {any} item
 * @param {string} shapeId
 * @param {string[]} drawOrder
 * @param {Map<string, string>} out
 */
function collectItemSlots(item, shapeId, drawOrder, out) {
	if (!item || !shapeId) return;
	collectSlots(item.layers && item.layers[shapeId], drawOrder, out);
}

/**
 * 当前穿搭需要渲染的图层，按 `manifest.drawOrder` 从下到上排序。
 *
 * 规则（v6 契约 §4）：
 *   - `z` = 槽位在 `manifest.drawOrder` 里的下标，返回值按 z 升序；
 *   - 身形层恒在（body / arms / hair 等，无文件则跳过）；
 *   - 套装非空且不为 `'none'` → 只加套装的槽位层，与上衣 / 下装互斥；
 *   - 否则加下装层 + 上衣层（水手服的主体在 topUnder 槽位）；
 *   - `state.shape` 非法时回退 `shapes[0].id`；
 *   - 单品找不到、缺当前身形的图层、槽位非法、文件为空 → 跳过，不抛错。
 *
 * @param {any} manifest
 * @param {Record<string, string> | null | undefined} state
 * @returns {Layer[]}
 */
export function resolveLayers(manifest, state) {
	const snapshot = state || {};
	const mf = manifest && typeof manifest === 'object' ? manifest : {};
	const drawOrder = drawOrderOf(mf);
	const shape = findShape(mf, snapshot.shape);
	const shapeId = shape ? shape.id : '';

	/** @type {Map<string, string>} */
	const bySlot = new Map();
	// 身形层（body / arms / hair）恒在
	collectSlots(shape && shape.layers, drawOrder, bySlot);

	const outfitId = snapshot.outfit;
	if (typeof outfitId === 'string' && outfitId && outfitId !== 'none') {
		// 套装模式：只叠套装层（topBody + sleeve 等），不加上衣 / 下装
		collectItemSlots(findItem(mf, 'outfits', outfitId), shapeId, drawOrder, bySlot);
	} else {
		// 上下装模式：下装在下、上衣在上（各自可能占多个槽位）
		collectItemSlots(findItem(mf, 'bottoms', snapshot.bottom), shapeId, drawOrder, bySlot);
		collectItemSlots(findItem(mf, 'tops', snapshot.top), shapeId, drawOrder, bySlot);
	}

	/** @type {Layer[]} */
	const layers = [];
	for (let z = 0; z < drawOrder.length; z += 1) {
		const file = bySlot.get(drawOrder[z]);
		if (file) layers.push({ slot: drawOrder[z], file, z });
	}
	return layers;
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

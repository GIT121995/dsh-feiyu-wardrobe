import assert from 'node:assert/strict';
import test from 'node:test';

import * as core from '../docs/dress-up/wardrobe-core.js';
import {
	applySelection,
	applyShape,
	collectItems,
	currentBounds,
	defaultState,
	describeOutfit,
	normalizeState,
	randomOutfit,
	resolveLayers,
} from '../docs/dress-up/wardrobe-core.js';

/* ---------------- 内联 fixture：manifest v6（不依赖真实素材文件） ---------------- */

/** v6 契约的顺序（LAYER-MODEL.md §1）。 */
const DRAW_ORDER = ['body', 'topUnder', 'bottom', 'topBody', 'arms', 'sleeve', 'hair'];
const SHAPES = ['chibi', 'girl'];

/** 身形自带的 body / arms / hair 三层。 */
function shapeLayers(shapeId) {
	return {
		body: `art/${shapeId}/body.webp`,
		arms: `art/${shapeId}/arms.webp`,
		hair: `art/${shapeId}/hair.webp`,
	};
}

/**
 * 生成 item.layers：两种身形各自映射「槽位 → 图层文件」。
 * @param {(shapeId: string) => Record<string, string>} slotsOf
 */
function itemLayers(slotsOf) {
	const out = {};
	for (const shapeId of SHAPES) {
		out[shapeId] = {};
		for (const [slot, file] of Object.entries(slotsOf(shapeId))) {
			out[shapeId][slot] = `art/${shapeId}/layers/${file}`;
		}
	}
	return out;
}

const manifest = {
	version: 6,
	title: '大肥鱼衣橱 · 换装间',
	character: '大肥鱼 · 经典鲸鱼娘',
	credits: '测试用内联素材说明，长度足够。',
	drawOrder: [...DRAW_ORDER],
	shapes: [
		{
			id: 'chibi',
			name: 'Q版',
			desc: '大头小身子的可爱版本',
			bounds: { top: 0.05, bottom: 0.95 },
			layers: shapeLayers('chibi'),
		},
		{
			id: 'girl',
			name: '少女版',
			desc: '六头身的少女比例',
			bounds: { top: 0.03, bottom: 0.97 },
			layers: shapeLayers('girl'),
		},
	],
	categories: [
		{ id: 'outfits', name: '套装', emoji: '👗', stateKey: 'outfit' },
		{ id: 'tops', name: '上衣', emoji: '👚', stateKey: 'top' },
		{ id: 'bottoms', name: '下装', emoji: '👘', stateKey: 'bottom' },
		{ id: 'backgrounds', name: '背景', emoji: '🏙️', stateKey: 'bg' },
		{ id: 'effects', name: '特效', emoji: '❄️', stateKey: 'effect' },
	],
	items: {
		outfits: [
			{ id: 'none', name: '不穿套装', emoji: '🚫', desc: '换成上衣 + 下装搭配。' },
			{
				id: 'maid',
				name: '经典女仆装',
				icon: 'art/icons/maid.webp',
				layers: itemLayers(() => ({ topBody: 'dress-maid-body.webp', sleeve: 'dress-maid-sleeve.webp' })),
			},
			{
				// 故意只给 chibi 图层：少女版应跳过整套套装层
				id: 'ghost',
				name: '幽灵套装',
				layers: { chibi: { topBody: 'art/chibi/layers/dress-ghost-body.webp' } },
			},
		],
		tops: [
			{
				id: 'sweater',
				name: '白色高领毛衣',
				icon: 'art/icons/sweater.webp',
				layers: itemLayers(() => ({ topBody: 'top-sweater-body.webp', sleeve: 'top-sweater-sleeve.webp' })),
			},
			{
				// 水手服主体塞进裙子 → topUnder
				id: 'sailor',
				name: '水手服上衣',
				icon: 'art/icons/sailor.webp',
				layers: itemLayers(() => ({ topUnder: 'top-sailor-body.webp', sleeve: 'top-sailor-sleeve.webp' })),
			},
			{
				// 故意只给 chibi 图层、且没有袖子层
				id: 'sleeveless',
				name: '无袖背心',
				icon: 'art/icons/sweater.webp',
				layers: { chibi: { topBody: 'art/chibi/layers/top-sleeveless-body.webp' } },
			},
		],
		bottoms: [
			{
				id: 'plaid',
				name: '格纹百褶裙',
				icon: 'art/icons/plaid.webp',
				layers: itemLayers(() => ({ bottom: 'bottom-plaid.webp' })),
			},
			{
				id: 'pleated',
				name: '深蓝百褶裙',
				icon: 'art/icons/pleated.webp',
				layers: itemLayers(() => ({ bottom: 'bottom-pleated.webp' })),
			},
			{
				// 故意只给 chibi 图层
				id: 'ghostBottom',
				name: '幽灵裙',
				layers: { chibi: { bottom: 'art/chibi/layers/bottom-ghost.webp' } },
			},
		],
		backgrounds: [
			{ id: 'bg-snow', name: '冬夜街道', file: 'art/bg-snow.webp', thumb: 'art/thumbs/bg-snow.webp', floor: 0.86 },
		],
		effects: [
			{ id: 'none', name: '无', emoji: '🌙' },
			{ id: 'snow', name: '飘雪', emoji: '❄️' },
		],
	},
	defaults: { shape: 'chibi', outfit: 'maid', top: 'sweater', bottom: 'plaid', bg: 'bg-snow', effect: 'snow' },
	bubbles: ['嘿嘿。'],
};

/** 按 drawOrder 生成期望的图层序列（entries 是「槽位 → 文件」的无序映射）。 */
function expectLayers(entries, drawOrder = DRAW_ORDER) {
	const bySlot = new Map(entries);
	return drawOrder
		.map((slot, z) => (bySlot.has(slot) ? { slot, file: bySlot.get(slot), z } : null))
		.filter((layer) => layer !== null);
}

/** 断言图层数组按 z 严格升序。 */
function assertZOrder(layers) {
	for (let i = 1; i < layers.length; i += 1) {
		assert.ok(layers[i].z > layers[i - 1].z, '图层应按 z 严格升序');
	}
}

/** 断言每个图层的 z 等于该槽位在 drawOrder 里的下标。 */
function assertZMatchesDrawOrder(layers, drawOrder = DRAW_ORDER) {
	for (const layer of layers) assert.equal(layer.z, drawOrder.indexOf(layer.slot), `${layer.slot} 的 z 应为 drawOrder 下标`);
}

/** 每个槽位在结果里最多出现一次。 */
function assertUniqueSlots(layers) {
	const slots = layers.map((layer) => layer.slot);
	assert.equal(new Set(slots).size, slots.length, '同一槽位不应重复渲染');
}

/** 把 fixture 深拷贝一份再改（避免测试之间互相污染）。 */
function cloneManifest(patch) {
	const copy = JSON.parse(JSON.stringify(manifest));
	return patch ? patch(copy) : copy;
}

/* ---------------- 默认状态 / 状态校验 ---------------- */

test('默认穿搭：Q版 + 经典女仆装 + 默认上下装/背景/特效', () => {
	const state = defaultState(manifest);
	assert.equal(state.shape, 'chibi');
	assert.equal(state.outfit, 'maid');
	assert.equal(state.top, 'sweater');
	assert.equal(state.bottom, 'plaid');
	assert.equal(state.bg, 'bg-snow');
	assert.equal(state.effect, 'snow');
});

test('normalizeState 丢弃未知值并补全', () => {
	const state = normalizeState(manifest, { shape: 'girl', outfit: '不存在的', top: 'sailor', effect: 42 });
	assert.equal(state.shape, 'girl');
	assert.equal(state.outfit, 'maid', '未知套装回退默认');
	assert.equal(state.top, 'sailor', '合法值保留');
	assert.equal(state.effect, 'snow', '非字符串回退默认');
	assert.equal(state.bg, 'bg-snow', '缺失槽位回退默认');
});

test('无效 / 空状态也能拿到完整默认状态', () => {
	assert.deepEqual(normalizeState(manifest, null), defaultState(manifest));
	assert.deepEqual(normalizeState(manifest, 'not-an-object'), defaultState(manifest));
});

test('resolveImage 已删除（v4 单图 → v6 多槽位图层解析）', () => {
	assert.equal('resolveImage' in core, false);
});

/* ---------------- resolveLayers：槽位顺序 ---------------- */

test('套装模式：按 drawOrder 返回 body → topBody → arms → sleeve → hair', () => {
	const layers = resolveLayers(manifest, defaultState(manifest));
	assert.deepEqual(
		layers,
		expectLayers([
			['body', 'art/chibi/body.webp'],
			['topBody', 'art/chibi/layers/dress-maid-body.webp'],
			['arms', 'art/chibi/arms.webp'],
			['sleeve', 'art/chibi/layers/dress-maid-sleeve.webp'],
			['hair', 'art/chibi/hair.webp'],
		]),
	);
	assertZOrder(layers);
	assertZMatchesDrawOrder(layers);
	assertUniqueSlots(layers);
	assert.ok(!layers.some((layer) => layer.slot === 'topUnder' || layer.slot === 'bottom'), '套装模式不应叠上衣 / 下装');
});

test('上下装模式：按 drawOrder 返回 body → bottom → topBody → arms → sleeve → hair', () => {
	const state = { ...defaultState(manifest), outfit: 'none', top: 'sweater', bottom: 'plaid' };
	const layers = resolveLayers(manifest, state);
	assert.deepEqual(
		layers,
		expectLayers([
			['body', 'art/chibi/body.webp'],
			['bottom', 'art/chibi/layers/bottom-plaid.webp'],
			['topBody', 'art/chibi/layers/top-sweater-body.webp'],
			['arms', 'art/chibi/arms.webp'],
			['sleeve', 'art/chibi/layers/top-sweater-sleeve.webp'],
			['hair', 'art/chibi/hair.webp'],
		]),
	);
	assertZOrder(layers);
	assertZMatchesDrawOrder(layers);
	assert.ok(!layers.some((layer) => layer.slot === 'topUnder'), '毛衣主体应在 topBody 而不是 topUnder');
});

test('水手服主体（topUnder）在下装之下：裙子盖住下摆，手臂仍在下装之上', () => {
	const state = { ...defaultState(manifest), outfit: 'none', top: 'sailor', bottom: 'pleated' };
	const layers = resolveLayers(manifest, state);
	assert.deepEqual(
		layers.map((layer) => layer.slot),
		['body', 'topUnder', 'bottom', 'arms', 'sleeve', 'hair'],
	);
	const bySlot = new Map(layers.map((layer) => [layer.slot, layer]));
	assert.ok(bySlot.get('topUnder').z < bySlot.get('bottom').z, 'topUnder 应被 bottom 盖住');
	assert.ok(bySlot.get('bottom').z < bySlot.get('arms').z, '手臂（手）应盖在下装之上');
	assert.ok(bySlot.get('sleeve').z > bySlot.get('arms').z, '袖子应盖在手臂之上');
	assert.ok(bySlot.get('hair').z > bySlot.get('sleeve').z, '前发永远最上层');
	assert.ok(!layers.some((layer) => layer.slot === 'topBody'), '水手服不应用 topBody');
});

test('无袖上衣没有 sleeve 层：只渲染 topBody', () => {
	const state = { ...defaultState(manifest), outfit: 'none', top: 'sleeveless', bottom: 'plaid' };
	const layers = resolveLayers(manifest, state);
	assert.deepEqual(
		layers.map((layer) => layer.slot),
		['body', 'bottom', 'topBody', 'arms', 'hair'],
	);
	assertZOrder(layers);
});

test('所有组合的 z 都单调且等于 drawOrder 下标', () => {
	const states = [
		defaultState(manifest),
		{ ...defaultState(manifest), outfit: 'none', top: 'sweater', bottom: 'plaid' },
		{ ...defaultState(manifest), outfit: 'none', top: 'sailor', bottom: 'pleated' },
		{ ...defaultState(manifest), outfit: 'none', top: 'sleeveless', bottom: 'plaid' },
		{ ...defaultState(manifest), shape: 'girl' },
	];
	for (const state of states) {
		const layers = resolveLayers(manifest, state);
		assertZOrder(layers);
		assertZMatchesDrawOrder(layers);
		assertUniqueSlots(layers);
	}
});

/* ---------------- resolveLayers：槽位来源 / 跳过规则 ---------------- */

test('切换身形：身形层与单品层都跟着身形走', () => {
	const layers = resolveLayers(manifest, { ...defaultState(manifest), shape: 'girl' });
	assert.deepEqual(
		layers,
		expectLayers([
			['body', 'art/girl/body.webp'],
			['topBody', 'art/girl/layers/dress-maid-body.webp'],
			['arms', 'art/girl/arms.webp'],
			['sleeve', 'art/girl/layers/dress-maid-sleeve.webp'],
			['hair', 'art/girl/hair.webp'],
		]),
	);
	assert.ok(layers.find((layer) => layer.slot === 'body').file.startsWith('art/girl/'));
});

test('非法身形回退第一个身形的图层与 bounds', () => {
	const layers = resolveLayers(manifest, { ...defaultState(manifest), shape: 'alien' });
	assert.deepEqual(
		layers,
		expectLayers([
			['body', 'art/chibi/body.webp'],
			['topBody', 'art/chibi/layers/dress-maid-body.webp'],
			['arms', 'art/chibi/arms.webp'],
			['sleeve', 'art/chibi/layers/dress-maid-sleeve.webp'],
			['hair', 'art/chibi/hair.webp'],
		]),
	);
	assert.deepEqual(currentBounds(manifest, { ...defaultState(manifest), shape: 'alien' }), { top: 0.05, bottom: 0.95 });
});

test('缺失单品 / 缺当前身形图层时跳过该层，不抛错', () => {
	const unknownTop = resolveLayers(manifest, { ...defaultState(manifest), outfit: 'none', top: '不存在的上衣' });
	assert.ok(!unknownTop.some((layer) => layer.slot === 'topBody' || layer.slot === 'sleeve'));
	assert.ok(unknownTop.some((layer) => layer.slot === 'bottom'));

	const girlSleeveless = resolveLayers(manifest, {
		...defaultState(manifest),
		shape: 'girl',
		outfit: 'none',
		top: 'sleeveless',
		bottom: 'plaid',
	});
	assert.ok(!girlSleeveless.some((layer) => layer.slot === 'topBody'), '少女版没有无袖背心图层，应跳过');

	const girlGhost = resolveLayers(manifest, { ...defaultState(manifest), shape: 'girl', outfit: 'ghost' });
	assert.deepEqual(
		girlGhost.map((layer) => layer.slot),
		['body', 'arms', 'hair'],
		'缺当前身形图层路径的套装应整套跳过，其余身形层仍在',
	);
});

test('商品字段缺失 / 空字符串 / 非字符串文件都跳过，不抛错', () => {
	const broken = cloneManifest((copy) => {
		copy.items.tops[0].layers.chibi = { topBody: '', sleeve: 42 };
		return copy;
	});
	const layers = resolveLayers(broken, { ...defaultState(broken), outfit: 'none', top: 'sweater', bottom: 'plaid' });
	assert.ok(!layers.some((layer) => layer.slot === 'topBody' || layer.slot === 'sleeve'), '缺文件的上衣层应跳过');
	assert.deepEqual(layers.map((layer) => layer.slot), ['body', 'bottom', 'arms', 'hair']);

	const noShapeLayers = cloneManifest((copy) => {
		delete copy.shapes[0].layers;
		return copy;
	});
	assert.deepEqual(
		resolveLayers(noShapeLayers, { ...defaultState(noShapeLayers), outfit: 'none', top: 'sweater', bottom: 'plaid' })
			.map((layer) => layer.slot),
		['bottom', 'topBody', 'sleeve'],
		'身形层缺失时只渲染衣服层',
	);
});

test('未知槽位（不在 drawOrder 里）被忽略', () => {
	const extraSlots = cloneManifest((copy) => {
		copy.items.tops[0].layers.chibi.hat = 'art/chibi/layers/top-sweater-hat.webp';
		copy.items.tops[0].layers.chibi.cape = 'art/chibi/layers/top-sweater-cape.webp';
		copy.shapes[0].layers.tail = 'art/chibi/tail.webp';
		return copy;
	});
	const layers = resolveLayers(extraSlots, { ...defaultState(extraSlots), outfit: 'none', top: 'sweater' });
	assert.ok(!layers.some((layer) => layer.slot === 'hat' || layer.slot === 'cape' || layer.slot === 'tail'), '未知槽位应忽略');
	assert.deepEqual(
		layers.map((layer) => layer.slot),
		['body', 'bottom', 'topBody', 'arms', 'sleeve', 'hair'],
	);
});

test('state 为空时容错：只返回身形层', () => {
	const layers = resolveLayers(manifest, undefined);
	assert.deepEqual(
		layers.map((layer) => layer.slot),
		['body', 'arms', 'hair'],
	);
	assertZOrder(layers);
	assert.deepEqual(currentBounds(manifest, null), { top: 0.05, bottom: 0.95 });
});

test('manifest 为空 / 没有 drawOrder 时返回空数组，不抛错', () => {
	assert.deepEqual(resolveLayers(undefined, { shape: 'chibi' }), []);
	assert.deepEqual(resolveLayers({}, { shape: 'chibi' }), []);
	assert.deepEqual(resolveLayers({ ...manifest, drawOrder: undefined }, defaultState(manifest)), []);
	assert.deepEqual(resolveLayers({ ...manifest, drawOrder: 'body,hair' }, defaultState(manifest)), []);
});

/* ---------------- resolveLayers：drawOrder 是唯一顺序来源 ---------------- */

test('自定义 drawOrder：输出顺序与 z 完全跟随 manifest.drawOrder', () => {
	const customOrder = ['hair', 'arms', 'body'];
	const custom = cloneManifest((copy) => {
		copy.drawOrder = [...customOrder];
		return copy;
	});
	const layers = resolveLayers(custom, defaultState(custom));
	assert.deepEqual(
		layers,
		expectLayers(
			[
				['body', 'art/chibi/body.webp'],
				['arms', 'art/chibi/arms.webp'],
				['hair', 'art/chibi/hair.webp'],
			],
			customOrder,
		),
	);
	assert.deepEqual(
		layers.map((layer) => layer.slot),
		customOrder,
		'顺序应由 manifest.drawOrder 决定，而不是写死常量',
	);
	assert.ok(!layers.some((layer) => layer.slot === 'topBody' || layer.slot === 'sleeve'), 'drawOrder 之外的槽位不渲染');
});

test('drawOrder 里的非法项被忽略、重复项只算一次', () => {
	const custom = cloneManifest((copy) => {
		copy.drawOrder = ['body', '', 42, 'hair', 'body', null, 'arms'];
		return copy;
	});
	const layers = resolveLayers(custom, defaultState(custom));
	assert.deepEqual(
		layers.map((layer) => [layer.slot, layer.z]),
		[
			['body', 0],
			['hair', 1],
			['arms', 2],
		],
	);
});

/* ---------------- currentBounds ---------------- */

test('currentBounds 读身形固定边界，不随穿搭变化', () => {
	const chibi = currentBounds(manifest, defaultState(manifest));
	assert.deepEqual(chibi, { top: 0.05, bottom: 0.95 });
	const sameShapeCombo = currentBounds(manifest, {
		...defaultState(manifest),
		outfit: 'none',
		top: 'sweater',
		bottom: 'pleated',
	});
	assert.deepEqual(sameShapeCombo, chibi, '同一身形换穿搭边界不变');

	const girl = currentBounds(manifest, { ...defaultState(manifest), shape: 'girl' });
	assert.deepEqual(girl, { top: 0.03, bottom: 0.97 });
});

test('currentBounds 缺 bounds 时给默认值', () => {
	const noBoundsManifest = {
		...manifest,
		shapes: manifest.shapes.map(({ bounds, ...shape }) => shape),
	};
	assert.deepEqual(currentBounds(noBoundsManifest, defaultState(noBoundsManifest)), { top: 0.06, bottom: 0.94 });
});

/* ---------------- 选择 / 身形切换 ---------------- */

test('选上衣/下装会退出套装模式；选套装会回到套装模式', () => {
	let state = defaultState(manifest);
	state = applySelection(manifest, state, 'tops', 'sailor');
	assert.equal(state.outfit, 'none');
	assert.equal(state.top, 'sailor');
	state = applySelection(manifest, state, 'bottoms', 'pleated');
	assert.equal(state.outfit, 'none');
	assert.equal(state.bottom, 'pleated');
	state = applySelection(manifest, state, 'outfits', 'ghost');
	assert.equal(state.outfit, 'ghost');
	state = applySelection(manifest, state, 'outfits', 'none');
	assert.equal(state.outfit, 'none');
});

test('applySelection 不修改入参', () => {
	const state = defaultState(manifest);
	const snapshot = { ...state };
	applySelection(manifest, state, 'tops', 'sailor');
	assert.deepEqual(state, snapshot);
});

test('未知单品 / 未知分类是安全空操作', () => {
	const state = defaultState(manifest);
	assert.deepEqual(applySelection(manifest, state, 'outfits', 'nope'), state);
	assert.deepEqual(applySelection(manifest, state, 'nope', 'x'), state);
});

test('身形切换只接受 manifest 里有的身形', () => {
	const state = defaultState(manifest);
	assert.equal(applyShape(manifest, state, 'girl').shape, 'girl');
	assert.equal(applyShape(manifest, state, 'alien').shape, 'chibi');
});

/* ---------------- 描述 / 随机 / 图鉴 ---------------- */

test('describeOutfit 区分套装模式与组合模式', () => {
	const outfit = describeOutfit(manifest, defaultState(manifest));
	assert.ok(outfit.name.includes('经典女仆装'));
	assert.ok(outfit.detail.includes('Q版'));
	assert.ok(outfit.detail.includes('冬夜街道'));
	const combo = describeOutfit(manifest, { ...defaultState(manifest), outfit: 'none', top: 'sweater', bottom: 'pleated' });
	assert.ok(combo.name.includes('白色高领毛衣'));
	assert.ok(combo.name.includes('深蓝百褶裙'));
});

test('randomOutfit 遵守「套装与上衣/下装互斥」，且可复现', () => {
	const seq = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6];
	const run = () => {
		let i = 0;
		return randomOutfit(manifest, defaultState(manifest), () => seq[i++ % seq.length]);
	};
	const state = run();
	assert.ok(state.outfit === 'none' || (state.top !== undefined && state.bottom !== undefined));
	assert.ok(state.bg && state.effect);
	assert.deepEqual(run(), state, '同一随机序列应得到同一套穿搭');
});

test('collectItems 图鉴不包含“不穿”占位项', () => {
	const groups = collectItems(manifest);
	assert.deepEqual(
		groups.map((group) => group.category.id),
		['outfits', 'tops', 'bottoms', 'backgrounds', 'effects'],
	);
	for (const group of groups) {
		for (const item of group.items) assert.notEqual(item.id, 'none');
	}
});

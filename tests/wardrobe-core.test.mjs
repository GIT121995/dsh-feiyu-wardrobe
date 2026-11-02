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

/* ---------------- 内联 fixture：manifest v5（不依赖真实素材文件） ---------------- */

const manifest = {
	version: 5,
	title: '大肥鱼衣橱 · 换装间',
	character: '大肥鱼 · 经典鲸鱼娘',
	credits: '测试用内联素材说明，长度足够。',
	shapes: [
		{
			id: 'chibi',
			name: 'Q版',
			desc: '大头小身子的可爱版本',
			base: 'art/chibi/base.webp',
			overlay: 'art/chibi/overlay.webp',
			bounds: { top: 0.05, bottom: 0.95 },
		},
		{
			id: 'girl',
			name: '少女版',
			desc: '六头身的少女比例',
			base: 'art/girl/base.webp',
			overlay: 'art/girl/overlay.webp',
			bounds: { top: 0.03, bottom: 0.97 },
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
				z: 30,
				layer: { chibi: 'art/chibi/layers/dress-maid.webp', girl: 'art/girl/layers/dress-maid.webp' },
			},
			{
				// 故意不写 z：应回退默认 30
				id: 'starry',
				name: '星空礼服',
				icon: 'art/icons/starry.webp',
				layer: { chibi: 'art/chibi/layers/dress-starry.webp', girl: 'art/girl/layers/dress-starry.webp' },
			},
			{
				// 故意缺 girl 图层：少女版应跳过该层
				id: 'ghost',
				name: '幽灵套装',
				layer: { chibi: 'art/chibi/layers/dress-ghost.webp' },
			},
		],
		tops: [
			{
				id: 'sweater',
				name: '白色高领毛衣',
				icon: 'art/icons/sweater.webp',
				z: 30,
				layer: { chibi: 'art/chibi/layers/top-sweater.webp', girl: 'art/girl/layers/top-sweater.webp' },
			},
			{
				id: 'hoodie',
				name: '白色连帽卫衣',
				icon: 'art/icons/hoodie.webp',
				z: 25,
				layer: { chibi: 'art/chibi/layers/top-hoodie.webp', girl: 'art/girl/layers/top-hoodie.webp' },
			},
			{
				// 故意只给 chibi 图层：少女版应跳过该层
				id: 'sleeveless',
				name: '无袖背心',
				icon: 'art/icons/sweater.webp',
				z: 5,
				layer: { chibi: 'art/chibi/layers/top-sleeveless.webp' },
			},
		],
		bottoms: [
			{
				id: 'plaid',
				name: '格纹百褶裙',
				icon: 'art/icons/plaid.webp',
				z: 20,
				layer: { chibi: 'art/chibi/layers/bottom-plaid.webp', girl: 'art/girl/layers/bottom-plaid.webp' },
			},
			{
				// 故意不写 z：应回退默认 20
				id: 'pleated',
				name: '深蓝百褶裙',
				icon: 'art/icons/pleated.webp',
				layer: { chibi: 'art/chibi/layers/bottom-pleated.webp', girl: 'art/girl/layers/bottom-pleated.webp' },
			},
			{
				// 与上装同 z：用来验证「同 z 保持 base→下装→上装→overlay 的插入顺序」
				id: 'sash',
				name: '腰带长裙',
				icon: 'art/icons/pleated.webp',
				z: 30,
				layer: { chibi: 'art/chibi/layers/bottom-sash.webp', girl: 'art/girl/layers/bottom-sash.webp' },
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

/** 断言图层数组按 z 升序。 */
function assertZOrder(layers) {
	for (let i = 1; i < layers.length; i += 1) assert.ok(layers[i].z >= layers[i - 1].z, '图层应按 z 升序');
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
	const state = normalizeState(manifest, { shape: 'girl', outfit: '不存在的', top: 'hoodie', effect: 42 });
	assert.equal(state.shape, 'girl');
	assert.equal(state.outfit, 'maid', '未知套装回退默认');
	assert.equal(state.top, 'hoodie', '合法值保留');
	assert.equal(state.effect, 'snow', '非字符串回退默认');
	assert.equal(state.bg, 'bg-snow', '缺失槽位回退默认');
});

test('无效 / 空状态也能拿到完整默认状态', () => {
	assert.deepEqual(normalizeState(manifest, null), defaultState(manifest));
	assert.deepEqual(normalizeState(manifest, 'not-an-object'), defaultState(manifest));
});

test('resolveImage 已删除（v5 改为图层解析）', () => {
	assert.equal('resolveImage' in core, false);
});

/* ---------------- resolveLayers ---------------- */

test('套装模式：base → 套装层（z=30）→ overlay', () => {
	const layers = resolveLayers(manifest, defaultState(manifest));
	assert.deepEqual(layers, [
		{ kind: 'base', file: 'art/chibi/base.webp', z: 0 },
		{ kind: 'outfit', file: 'art/chibi/layers/dress-maid.webp', z: 30 },
		{ kind: 'overlay', file: 'art/chibi/overlay.webp', z: 100 },
	]);
	assertZOrder(layers);
	assert.ok(!layers.some((layer) => layer.kind === 'top' || layer.kind === 'bottom'), '套装模式不应叠上下装');
});

test('上下装模式：base → 下装（z=20）→ 上装（z=30）→ overlay', () => {
	const state = { ...defaultState(manifest), outfit: 'none', top: 'sweater', bottom: 'plaid' };
	const layers = resolveLayers(manifest, state);
	assert.deepEqual(layers, [
		{ kind: 'base', file: 'art/chibi/base.webp', z: 0 },
		{ kind: 'bottom', file: 'art/chibi/layers/bottom-plaid.webp', z: 20 },
		{ kind: 'top', file: 'art/chibi/layers/top-sweater.webp', z: 30 },
		{ kind: 'overlay', file: 'art/chibi/overlay.webp', z: 100 },
	]);
	assertZOrder(layers);
	assert.ok(!layers.some((layer) => layer.kind === 'outfit'), '上下装模式不应叠套装层');
});

test('图层按 z 排序：z 小于下装的上装也会排到下装前面', () => {
	const state = { ...defaultState(manifest), outfit: 'none', top: 'sleeveless', bottom: 'pleated' };
	const layers = resolveLayers(manifest, state);
	assert.deepEqual(
		layers.map((layer) => [layer.kind, layer.z]),
		[
			['base', 0],
			['top', 5],
			['bottom', 20],
			['overlay', 100],
		],
	);
	assertZOrder(layers);
});

test('同 z 保持插入顺序：下装在上装之前', () => {
	const state = { ...defaultState(manifest), outfit: 'none', top: 'sweater', bottom: 'sash' };
	const layers = resolveLayers(manifest, state);
	const sameZ = layers.filter((layer) => layer.z === 30);
	assert.deepEqual(
		sameZ.map((layer) => layer.kind),
		['bottom', 'top'],
	);
});

test('套装缺 z 时回退默认 30；套装层替换上下装', () => {
	const layers = resolveLayers(manifest, { ...defaultState(manifest), outfit: 'starry' });
	const outfit = layers.find((layer) => layer.kind === 'outfit');
	assert.ok(outfit);
	assert.equal(outfit.file, 'art/chibi/layers/dress-starry.webp');
	assert.equal(outfit.z, 30);
	assert.equal(layers.length, 3);
});

test('切换身形：图层路径与 bounds 都跟着身形走', () => {
	const layers = resolveLayers(manifest, { ...defaultState(manifest), shape: 'girl' });
	assert.deepEqual(layers, [
		{ kind: 'base', file: 'art/girl/base.webp', z: 0 },
		{ kind: 'outfit', file: 'art/girl/layers/dress-maid.webp', z: 30 },
		{ kind: 'overlay', file: 'art/girl/overlay.webp', z: 100 },
	]);
});

test('非法身形回退第一个身形', () => {
	const layers = resolveLayers(manifest, { ...defaultState(manifest), shape: 'alien' });
	assert.equal(layers[0].file, 'art/chibi/base.webp');
	assert.equal(layers.find((layer) => layer.kind === 'outfit').file, 'art/chibi/layers/dress-maid.webp');
});

test('缺失单品 / 缺当前身形图层路径时跳过该层，不抛错', () => {
	const unknownTop = resolveLayers(manifest, { ...defaultState(manifest), outfit: 'none', top: '不存在的上衣' });
	assert.ok(!unknownTop.some((layer) => layer.kind === 'top'));
	assert.ok(unknownTop.some((layer) => layer.kind === 'bottom'));

	const girlSleeveless = resolveLayers(manifest, {
		...defaultState(manifest),
		shape: 'girl',
		outfit: 'none',
		top: 'sleeveless',
		bottom: 'plaid',
	});
	assert.ok(!girlSleeveless.some((layer) => layer.kind === 'top'), '少女版没有无袖背心图层，应跳过');

	const girlGhost = resolveLayers(manifest, { ...defaultState(manifest), shape: 'girl', outfit: 'ghost' });
	assert.ok(!girlGhost.some((layer) => layer.kind === 'outfit'), '缺当前身形图层路径的套装应跳过');
	assert.ok(!girlGhost.some((layer) => layer.kind === 'top' || layer.kind === 'bottom'), '套装模式不加上下装');
	assert.deepEqual(girlGhost.map((layer) => layer.kind), ['base', 'overlay'], '其余两层仍在');
});

test('state 为空时容错：只返回 base 与 overlay', () => {
	assert.deepEqual(
		resolveLayers(manifest, undefined).map((layer) => layer.kind),
		['base', 'overlay'],
	);
	assert.deepEqual(currentBounds(manifest, null), { top: 0.05, bottom: 0.95 });
});

test('base 与 overlay 恒在（即使套装 / 上下装都没解析出来）', () => {
	const layers = resolveLayers(manifest, { shape: 'girl', outfit: 'ghost', top: 'x', bottom: 'y' });
	assert.deepEqual(
		layers.map((layer) => layer.kind),
		['base', 'overlay'],
	);
	assert.equal(layers[0].z, 0);
	assert.equal(layers[1].z, 100);
});

/* ---------------- currentBounds ---------------- */

test('currentBounds 读身形固定边界，不随穿搭变化', () => {
	const chibi = currentBounds(manifest, defaultState(manifest));
	assert.deepEqual(chibi, { top: 0.05, bottom: 0.95 });
	const sameShapeCombo = currentBounds(manifest, {
		...defaultState(manifest),
		outfit: 'none',
		top: 'hoodie',
		bottom: 'pleated',
	});
	assert.deepEqual(sameShapeCombo, chibi, '同一身形换穿搭边界不变');

	const girl = currentBounds(manifest, { ...defaultState(manifest), shape: 'girl' });
	assert.deepEqual(girl, { top: 0.03, bottom: 0.97 });
});

test('currentBounds 非法身形回退第一个身形，缺 bounds 时给默认值', () => {
	const fallbackShape = currentBounds(manifest, { ...defaultState(manifest), shape: 'alien' });
	assert.deepEqual(fallbackShape, { top: 0.05, bottom: 0.95 });

	const noBoundsManifest = {
		...manifest,
		shapes: manifest.shapes.map(({ bounds, ...shape }) => shape),
	};
	assert.deepEqual(currentBounds(noBoundsManifest, defaultState(noBoundsManifest)), { top: 0.06, bottom: 0.94 });
});

/* ---------------- 选择 / 身形切换 ---------------- */

test('选上衣/下装会退出套装模式；选套装会回到套装模式', () => {
	let state = defaultState(manifest);
	state = applySelection(manifest, state, 'tops', 'hoodie');
	assert.equal(state.outfit, 'none');
	assert.equal(state.top, 'hoodie');
	state = applySelection(manifest, state, 'bottoms', 'pleated');
	assert.equal(state.outfit, 'none');
	assert.equal(state.bottom, 'pleated');
	state = applySelection(manifest, state, 'outfits', 'starry');
	assert.equal(state.outfit, 'starry');
	state = applySelection(manifest, state, 'outfits', 'none');
	assert.equal(state.outfit, 'none');
});

test('applySelection 不修改入参', () => {
	const state = defaultState(manifest);
	const snapshot = { ...state };
	applySelection(manifest, state, 'tops', 'hoodie');
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
	const combo = describeOutfit(manifest, { ...defaultState(manifest), outfit: 'none', top: 'hoodie', bottom: 'pleated' });
	assert.ok(combo.name.includes('白色连帽卫衣'));
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

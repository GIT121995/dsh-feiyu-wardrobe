import assert from 'node:assert/strict';
import test from 'node:test';

import {
	applySelection,
	applyShape,
	collectItems,
	currentBounds,
	defaultState,
	describeOutfit,
	normalizeState,
	randomOutfit,
	resolveImage,
} from '../docs/dress-up/wardrobe-core.js';

const manifest = {
	version: 4,
	character: '大肥鱼',
	shapes: [
		{ id: 'chibi', name: 'Q版' },
		{ id: 'girl', name: '少女版' },
	],
	bounds: {
		'art/chibi/dress-maid.webp': { top: 0.05, bottom: 0.95 },
		'art/chibi/combo-sweater-plaid.webp': { top: 0.06, bottom: 0.9 },
	},
	categories: [
		{ id: 'outfits', name: '套装', stateKey: 'outfit' },
		{ id: 'tops', name: '上衣', stateKey: 'top' },
		{ id: 'bottoms', name: '下装', stateKey: 'bottom' },
		{ id: 'backgrounds', name: '背景', stateKey: 'bg' },
		{ id: 'effects', name: '特效', stateKey: 'effect' },
	],
	items: {
		outfits: [
			{ id: 'none', name: '不穿套装' },
			{ id: 'maid', name: '经典女仆装' },
			{ id: 'starry', name: '星空礼服' },
		],
		tops: [
			{ id: 'sweater', name: '白色高领毛衣' },
			{ id: 'hoodie', name: '白色连帽卫衣' },
		],
		bottoms: [
			{ id: 'plaid', name: '格纹百褶裙' },
			{ id: 'pleated', name: '深蓝百褶裙' },
		],
		backgrounds: [{ id: 'bg-snow', name: '冬夜街道', file: 'art/bg-snow.webp' }],
		effects: [
			{ id: 'none', name: '无' },
			{ id: 'snow', name: '飘雪' },
		],
	},
	defaults: { shape: 'chibi', outfit: 'maid', top: 'sweater', bottom: 'plaid', bg: 'bg-snow', effect: 'snow' },
};

test('默认穿搭：Q版 + 经典女仆装', () => {
	const state = defaultState(manifest);
	assert.equal(state.shape, 'chibi');
	assert.equal(state.outfit, 'maid');
	assert.equal(state.top, 'sweater');
	assert.equal(state.bottom, 'plaid');
});

test('整套立绘按「身形 + 套装」解析，组合立绘按「上衣-下装」解析', () => {
	assert.equal(resolveImage(manifest, { ...defaultState(manifest), shape: 'chibi' }), 'art/chibi/dress-maid.webp');
	assert.equal(resolveImage(manifest, { ...defaultState(manifest), shape: 'girl' }), 'art/girl/dress-maid.webp');
	const combo = { ...defaultState(manifest), outfit: 'none', top: 'hoodie', bottom: 'pleated' };
	assert.equal(resolveImage(manifest, combo), 'art/chibi/combo-hoodie-pleated.webp');
	assert.equal(resolveImage(manifest, { ...combo, shape: 'girl' }), 'art/girl/combo-hoodie-pleated.webp');
});

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

test('normalizeState 丢弃未知值并补全', () => {
	const state = normalizeState(manifest, { shape: 'girl', outfit: '不存在的', top: 'hoodie' });
	assert.equal(state.shape, 'girl');
	assert.equal(state.outfit, 'maid', '未知套装回退默认');
	assert.equal(state.top, 'hoodie');
	assert.equal(state.bg, 'bg-snow', '缺失槽位回退默认');
});

test('currentBounds 读 manifest 里的立绘边界，缺失时给默认值', () => {
	const maid = currentBounds(manifest, defaultState(manifest));
	assert.deepEqual(maid, { top: 0.05, bottom: 0.95 });
	const unknown = currentBounds(manifest, { ...defaultState(manifest), outfit: 'starry' });
	assert.ok(unknown.top >= 0 && unknown.bottom <= 1);
});

test('describeOutfit 区分套装模式与组合模式', () => {
	const outfit = describeOutfit(manifest, defaultState(manifest));
	assert.ok(outfit.name.includes('经典女仆装'));
	assert.ok(outfit.detail.includes('Q版'));
	const combo = describeOutfit(manifest, { ...defaultState(manifest), outfit: 'none', top: 'hoodie', bottom: 'pleated' });
	assert.ok(combo.name.includes('白色连帽卫衣'));
	assert.ok(combo.name.includes('深蓝百褶裙'));
});

test('randomOutfit 遵守「套装与上衣/下装互斥」，且可复现', () => {
	const seq = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6];
	let i = 0;
	const random = () => seq[i++ % seq.length];
	const state = randomOutfit(manifest, defaultState(manifest), random);
	assert.ok(state.outfit === 'none' || (state.top !== undefined && state.bottom !== undefined));
	const again = randomOutfit(manifest, defaultState(manifest), () => {
		i = 0;
		return seq[0];
	});
	assert.equal(again.outfit, state.outfit);
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

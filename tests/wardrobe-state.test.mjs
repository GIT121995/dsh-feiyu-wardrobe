import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
} from '../docs/dress-up/wardrobe-core.js';
import { dressUpRoot } from '../lib/webserver.js';

const ROOT = dressUpRoot();
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

function makeRandom(values) {
	let index = 0;
	return () => {
		const value = values[index % values.length];
		index += 1;
		return value;
	};
}

test('currentBounds：读身形内容边界（2.5D 布局用），非法身形回退第一个', () => {
	assert.deepEqual(currentBounds(MANIFEST, { shape: 'chibi' }), { top: 0.04, bottom: 0.9725 });
	assert.deepEqual(currentBounds(MANIFEST, { shape: 'girl' }), { top: 0.0292, bottom: 0.9725 });
	assert.deepEqual(currentBounds(MANIFEST, { shape: '不存在的身形' }), currentBounds(MANIFEST, { shape: 'chibi' }));
	// manifest 缺 bounds 时回退默认值
	assert.deepEqual(currentBounds({ shapes: [{ id: 'x' }] }, { shape: 'x' }), { top: 0.06, bottom: 0.94 });
});

test('defaultState：取 manifest.defaults，且单品必须在对应分类里', () => {
	const state = defaultState(MANIFEST);
	assert.equal(state.shape, MANIFEST.defaults.shape);
	assert.equal(state.outfit, 'maid');
	assert.equal(state.top, 'sweater');
	assert.equal(state.bottom, 'plaid');
	assert.equal(state.bg, 'bg-snow');
	assert.equal(state.effect, 'snow');
});

test('normalizeState：localStorage/URL 脏数据回退默认值，非法身形/单品忽略', () => {
	const state = normalizeState(MANIFEST, {
		shape: 'girl',
		outfit: 'ghost',
		top: 'navy',
		bottom: 'pleated',
		bg: 'bg-ghost',
		effect: 'stars',
		evil: 'x',
	});
	assert.equal(state.shape, 'girl');
	assert.equal(state.outfit, 'maid'); // ghost 非法 → 默认
	assert.equal(state.top, 'sweater'); // 非法 → 默认
	assert.equal(state.bottom, 'pleated'); // 合法保留
	assert.equal(state.bg, 'bg-snow');
	assert.equal(state.effect, 'stars');
	assert.equal('evil' in state, false);
	assert.deepEqual(normalizeState(MANIFEST, null), defaultState(MANIFEST));
});

test('applySelection：选套装进入套装模式；选上衣/下装退出套装（互斥）', () => {
	const base = defaultState(MANIFEST);
	const withTop = applySelection(MANIFEST, { ...base, outfit: 'none' }, 'tops', 'sailor');
	assert.equal(withTop.top, 'sailor');
	assert.equal(withTop.outfit, 'none');
	const outfit = applySelection(MANIFEST, withTop, 'outfits', 'maid');
	assert.equal(outfit.outfit, 'maid');
	assert.equal(outfit.top, 'sailor', '套装不清空上衣/下装状态，只是不再渲染');
	const backToTop = applySelection(MANIFEST, outfit, 'tops', 'hoodie');
	assert.equal(backToTop.outfit, 'none');
	// 非法分类 / 非法单品 → 原 state 不变
	assert.equal(applySelection(MANIFEST, base, 'nope', 'maid'), base);
	assert.equal(applySelection(MANIFEST, base, 'tops', 'nope'), base);
});

test('applyShape：合法切身形；非法忽略', () => {
	const base = defaultState(MANIFEST);
	assert.equal(applyShape(MANIFEST, base, 'girl').shape, 'girl');
	assert.equal(applyShape(MANIFEST, base, 'alien'), base);
});

test('describeOutfit：套装/上下装名称 + 身形/背景/特效详情', () => {
	const outfitText = describeOutfit(MANIFEST, { ...defaultState(MANIFEST), outfit: 'maid', bg: 'bg-sakura', effect: 'petals' });
	assert.equal(outfitText.name, '经典女仆装');
	assert.match(outfitText.detail, /Q版/);
	assert.match(outfitText.detail, /樱花庭院/);
	const mix = describeOutfit(MANIFEST, { ...defaultState(MANIFEST), outfit: 'none', top: 'sweater', bottom: 'plaid', effect: 'none' });
	assert.equal(mix.name, '白色高领毛衣 + 格纹百褶裙');
	assert.equal(mix.detail.includes('无'), false, 'effect=none 不出现在详情');
});

test('randomOutfit：套装 65% 概率；否则上衣+下装；背景/特效随机；形状字段保留', () => {
	const base = defaultState(MANIFEST);
	const outfitRoll = randomOutfit(MANIFEST, base, makeRandom([0.1, 0.9, 0.1, 0.9, 0.1]));
	assert.equal(outfitRoll.outfit, 'maid');
	assert.equal(outfitRoll.shape, base.shape);
	const mixRoll = randomOutfit(MANIFEST, base, makeRandom([0.99, 0.5, 0.5, 0.1, 0.1]));
	assert.equal(mixRoll.outfit, 'none');
	assert.ok(['sweater', 'hoodie', 'sailor'].includes(mixRoll.top));
	assert.ok(['plaid', 'pleated'].includes(mixRoll.bottom));
	assert.ok(mixRoll.bg.startsWith('bg-'));
});

test('collectItems：图鉴按分类收集非 none 单品', () => {
	const groups = collectItems(MANIFEST);
	const ids = groups.map((group) => group.category.id);
	assert.deepEqual(ids, ['outfits', 'tops', 'bottoms', 'backgrounds', 'effects']);
	for (const group of groups) {
		assert.ok(group.items.length > 0, `${group.category.id} 应有单品`);
		assert.equal(group.items.some((item) => item.id === 'none'), false, 'none 不进图鉴');
	}
});

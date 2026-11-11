import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	DIY_ID_PREFIX,
	DIY_LAYER_SLOTS,
	DIY_MAX_ITEMS,
	diyRecordToItem,
	diyLayerUrls,
	isDiyItemId,
	selectDiyEvictions,
	validateDiyRecord,
} from '../docs/dress-up/wardrobe-core.js';
import { DIY_CATEGORIES, DIY_CATEGORY_SLOTS } from '../docs/dress-up/diy-guard.js';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)), 'docs', 'dress-up');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const STATE_KEYS = MANIFEST.categories.map((category) => category.stateKey);

/* ---------------- manifest v8：DOM 分层退役，2.5D-only 数据契约 ---------------- */

test('manifest v8：DOM 图层字段全部移除，身形/分类/默认穿搭保持', () => {
	assert.equal(MANIFEST.version, 8);
	assert.equal('drawOrder' in MANIFEST, false, 'v8 不应再有 DOM drawOrder');
	assert.deepEqual(MANIFEST.shapes.map((shape) => shape.id), ['chibi', 'girl']);
	assert.deepEqual(MANIFEST.categories.map((category) => category.id), ['outfits', 'tops', 'bottoms', 'backgrounds', 'effects']);
	assert.ok(MANIFEST.defaults && typeof MANIFEST.defaults.shape === 'string');
	for (const shape of MANIFEST.shapes) {
		assert.equal('layers' in shape, false, `${shape.id} 不应再有 DOM 图层映射`);
		assert.ok(shape.bounds && typeof shape.bounds.top === 'number', `${shape.id} 仍需要内容边界（2.5D 布局用）`);
	}
	for (const items of Object.values(MANIFEST.items)) {
		for (const item of items) assert.equal('layers' in item, false, `${item.id} 不应再有 DOM 图层映射`);
	}
});

test('manifest.diy：声明默认关闭、chibi、IndexedDB、v1 分享格式与内容策略', () => {
	const diy = MANIFEST.diy;
	assert.ok(diy && typeof diy === 'object', 'manifest 必须有 diy 扩展声明');
	assert.equal(diy.version, 1);
	assert.equal(diy.enabled, false, 'DIY 必须默认关闭');
	assert.equal(diy.shape, 'chibi');
	assert.equal(diy.storage, 'indexeddb');
	assert.equal(diy.idPrefix, DIY_ID_PREFIX);
	assert.equal(diy.maxItems, DIY_MAX_ITEMS);
	assert.ok(diy.maxBytes >= 8 * 1024 * 1024);
	assert.deepEqual(Object.keys(diy.categories).sort(), DIY_CATEGORIES.slice().sort());
	for (const category of DIY_CATEGORIES) {
		assert.deepEqual(diy.categories[category], DIY_CATEGORY_SLOTS[category], `品类映射与守卫一致：${category}`);
	}
	assert.equal(diy.shareFormat.ext, '.dshskin');
	assert.equal(diy.shareFormat.version, 1);
	assert.equal(diy.contentPolicy.tag, 'conservative-v1');
	assert.equal(diy.contentPolicy.downgradedTag, 'conservative-downgraded-v1');
	assert.match(diy.contentPolicy.guardVersion, /^diy-guard-\d+$/);
	// 素体参考图随包发布（宿主生成 look 的参考图1），且文件真实存在
	assert.equal(diy.baseRef, 'art/diy/base-chibi.png');
	assert.ok(existsSync(join(ROOT, diy.baseRef)), 'diy.baseRef 文件应存在');
});

/* ---------------- DIY 记录 schema ---------------- */

function makeRecord(overrides = {}) {
	return {
		id: 'diy-0123456789ab',
		name: '白色衬衫',
		category: 'top',
		shape: 'chibi',
		layers: { body: 'blob:http://127.0.0.1:3080/abc', sleeve: 'blob:http://127.0.0.1:3080/def' },
		source: { type: 'user-upload', license: 'user-owned', originalSha256: 'abc' },
		contentPolicyTag: 'conservative-v1',
		createdAt: 1_760_000_000_000,
		bytes: 123_456,
		version: 1,
		guardVersion: 'diy-guard-1',
		promptVersion: 'diy-m1-v1',
		...overrides,
	};
}

test('validateDiyRecord：合法记录通过，非法 schema 明确报错', () => {
	const ok = validateDiyRecord(makeRecord());
	assert.equal(ok.ok, true);
	assert.equal(ok.errors.length, 0);
	assert.equal(ok.record.id, 'diy-0123456789ab');
	const cases = [
		[makeRecord({ id: 'not-diy-prefix' }), 'id'],
		[makeRecord({ id: undefined }), 'id'],
		[makeRecord({ name: '   ' }), 'name'],
		[makeRecord({ name: 'x'.repeat(25) }), 'name'],
		[makeRecord({ category: 'hat' }), '品类'],
		[makeRecord({ shape: 'girl' }), 'chibi'],
		[makeRecord({ layers: {} }), 'layers.body'],
		[makeRecord({ layers: { body: 'blob:x', sleeve: 'blob:y' }, category: 'bottom' }), 'sleeve'],
		[makeRecord({ source: null }), 'source'],
		[makeRecord({ source: { type: 'evil', license: 'x' } }), 'source.type'],
		[makeRecord({ contentPolicyTag: 'anything' }), 'contentPolicyTag'],
		[makeRecord({ createdAt: 0 }), 'createdAt'],
		[makeRecord({ bytes: -1 }), 'bytes'],
	];
	for (const [raw, keyword] of cases) {
		const result = validateDiyRecord(raw);
		assert.equal(result.ok, false, `应拒绝：${JSON.stringify(raw).slice(0, 120)}`);
		assert.ok(
			result.errors.some((error) => error.includes(keyword)),
			`错误信息应提到 ${keyword}：${result.errors.join('|')}`,
		);
	}
	assert.equal(validateDiyRecord(null).ok, false);
	assert.equal(validateDiyRecord([1, 2]).ok, false);
});

/* ---------------- 运行时注入：DIY item → 2.5D 静态贴片顺序 ---------------- */

test('diyRecordToItem：按品类映射槽位，blob URL 原样保留', () => {
	const top = diyRecordToItem(makeRecord(), { body: 'blob:body', sleeve: 'blob:sleeve' });
	assert.equal(top.id, 'diy-0123456789ab');
	assert.equal(top.diy, true);
	assert.deepEqual(top.layers.chibi, { topBody: 'blob:body', sleeve: 'blob:sleeve' });
	assert.match(top.desc, /DIY/);
	const bottomRecord = makeRecord({ category: 'bottom', layers: { body: 'blob:b' } });
	const bottom = diyRecordToItem(bottomRecord, { body: 'blob:b' });
	assert.deepEqual(bottom.layers.chibi, { bottom: 'blob:b' });
	assert.equal(bottom.layers.chibi.sleeve, undefined);
	assert.equal(isDiyItemId(top.id), true);
	assert.equal(isDiyItemId('hoodie'), false);
});

test('diyLayerUrls：贴片按 bottom → topBody → sleeve 顺序，缺层跳过，girl 无贴片', () => {
	const top = diyRecordToItem(makeRecord(), { body: 'blob:body', sleeve: 'blob:sleeve' });
	const bottomRecord = makeRecord({ category: 'bottom', layers: { body: 'blob:b' } });
	const bottom = diyRecordToItem(bottomRecord, { body: 'blob:b' });
	// 组合顺序：下装先、衣身其次、袖子最上
	const merged = { ...top, layers: { chibi: { ...bottom.layers.chibi, ...top.layers.chibi } } };
	assert.deepEqual(diyLayerUrls(merged, 'chibi'), ['blob:b', 'blob:body', 'blob:sleeve']);
	// 只有单件时按自身槽位
	assert.deepEqual(diyLayerUrls(bottom, 'chibi'), ['blob:b']);
	// 未注入／其它身形返回空数组（不抛错）
	assert.deepEqual(diyLayerUrls(null, 'chibi'), []);
	assert.deepEqual(diyLayerUrls(top, 'girl'), []);
});

test('v3 单层 outfit 兼容：DIY 静态贴片仍「只取用户自绘层，不叠加 base 服装」', () => {
	// v3.0 把每套 base outfit 收敛成 top/skirt 整层，但 DIY 上传贴片的槽位契约不变：
	// 顶层/套装 = topBody（+可选 sleeve），下装 = bottom；页面仍先 setLook({bare:true})
	// 隐藏全部 base 服装层，再叠用户自绘贴片（策略沿用，见 v2-page 回归断言）。
	assert.deepEqual(DIY_LAYER_SLOTS, {
		top: { slot: 'topBody', sleeve: true },
		bottom: { slot: 'bottom', sleeve: false },
		dress: { slot: 'topBody', sleeve: true },
		coat: { slot: 'topBody', sleeve: true },
		outfit: { slot: 'topBody', sleeve: true },
	});
	const top = diyRecordToItem(makeRecord(), { body: 'blob:body', sleeve: 'blob:sleeve' });
	const urls = diyLayerUrls(top, 'chibi');
	assert.deepEqual(urls, ['blob:body', 'blob:sleeve'], '静态贴片只包含用户自绘层');
	for (const url of urls) assert.match(url, /^blob:/, '不应混入 base 服装/图集路径');
});

/* ---------------- 本地衣柜 LRU / 配额 ---------------- */

test('selectDiyEvictions：未超限不淘汰；超条目/超字节按最久未穿淘汰；keepId 受保护', () => {
	const records = [
		{ id: 'diy-a', bytes: 100, createdAt: 3, lastUsedAt: 10 },
		{ id: 'diy-b', bytes: 100, createdAt: 2 },
		{ id: 'diy-c', bytes: 100, createdAt: 3, lastUsedAt: 20 },
	];
	assert.deepEqual(selectDiyEvictions(records, { maxItems: 3, maxBytes: 1000 }).evictIds, []);
	// 条目上限：淘汰最久未穿（b 无 lastUsedAt → createdAt=2 最旧）
	assert.deepEqual(selectDiyEvictions(records, { maxItems: 2, maxBytes: 1000 }).evictIds, ['diy-b']);
	// 字节上限：最旧的先走
	assert.deepEqual(selectDiyEvictions(records, { maxItems: 10, maxBytes: 150 }).evictIds, ['diy-b', 'diy-a']);
	// keepId 不被淘汰（本次刚保存的新记录）
	assert.deepEqual(selectDiyEvictions(records, { maxItems: 1, maxBytes: 1000, keepId: 'diy-b' }).evictIds, ['diy-a', 'diy-c']);
	assert.equal(selectDiyEvictions(records, {}).totalBytes, 300);
	assert.equal(selectDiyEvictions(records, {}).count, 3);
});

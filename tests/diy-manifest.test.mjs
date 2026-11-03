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
	isDiyItemId,
	resolveLayers,
	selectDiyEvictions,
	validateDiyRecord,
} from '../docs/dress-up/wardrobe-core.js';
import { DIY_CATEGORIES, DIY_CATEGORY_SLOTS } from '../docs/dress-up/diy-guard.js';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)), 'docs', 'dress-up');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const STATE_KEYS = MANIFEST.categories.map((category) => category.stateKey);

/* ---------------- manifest v7：扩展声明，v6 数据语义不变 ---------------- */

test('manifest v7：版本号+1，drawOrder/身形/分类/默认穿搭与 v6 完全一致', () => {
	assert.equal(MANIFEST.version, 7);
	assert.deepEqual(MANIFEST.drawOrder, ['body', 'topUnder', 'bottom', 'topBody', 'arms', 'sleeve', 'hair']);
	assert.deepEqual(MANIFEST.shapes.map((shape) => shape.id), ['chibi', 'girl']);
	assert.deepEqual(MANIFEST.categories.map((category) => category.id), ['outfits', 'tops', 'bottoms', 'backgrounds', 'effects']);
	assert.ok(MANIFEST.defaults && typeof MANIFEST.defaults.shape === 'string');
	// v6 的 7 个槽位文件映射仍在原位（旧数据/旧渲染路径不变）
	for (const shape of MANIFEST.shapes) {
		for (const slot of ['body', 'arms', 'hair']) assert.ok(shape.layers[slot], `${shape.id}.${slot}`);
	}
	// v7 只新增 diy 扩展，不引入新的 drawOrder 槽位
	assert.equal(MANIFEST.drawOrder.includes('diy'), false);
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

/* ---------------- 运行时注入：manifest v6 resolveLayers 直接消费 DIY item ---------------- */

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
	assert.equal(isDiyItemId('sweater'), false);
});

test('resolveLayers 消费注入的 DIY item（v6 渲染路径零改动），且不污染静态单品', () => {
	const manifest = JSON.parse(JSON.stringify(MANIFEST));
	manifest.items.tops.push(diyRecordToItem(makeRecord(), { body: 'blob:body', sleeve: 'blob:sleeve' }));
	const layers = resolveLayers(manifest, {
		shape: 'chibi',
		outfit: 'none',
		top: 'diy-0123456789ab',
		bottom: 'plaid',
		bg: 'bg-snow',
		effect: 'snow',
	});
	const bySlot = Object.fromEntries(layers.map((layer) => [layer.slot, layer.file]));
	assert.equal(bySlot.topBody, 'blob:body');
	assert.equal(bySlot.sleeve, 'blob:sleeve');
	assert.equal(bySlot.bottom, 'art/chibi/layers/bottom-plaid.webp');
	// 原有静态单品的行为不变
	const original = resolveLayers(MANIFEST, {
		shape: 'chibi',
		outfit: 'none',
		top: 'sweater',
		bottom: 'plaid',
		bg: 'bg-snow',
		effect: 'snow',
	});
	assert.deepEqual(
		original.map((layer) => layer.slot),
		['body', 'bottom', 'topBody', 'arms', 'sleeve', 'hair'],
	);
	// girl 身形找不到 DIY item 的图层 → 只回退身形层，不抛错
	const girl = resolveLayers(manifest, {
		shape: 'girl',
		outfit: 'none',
		top: 'diy-0123456789ab',
		bottom: 'plaid',
		bg: 'bg-snow',
		effect: 'snow',
	});
	assert.equal(girl.some((layer) => layer.file.startsWith('blob:')), false);
	for (const layer of girl) assert.ok(typeof layer.file === 'string' && layer.file.length > 0);
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

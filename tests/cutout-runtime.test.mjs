/**
 * B 方案 cutout（v2.2）runtime/core 支持测试：
 * - 新 drawOrder 槽位（legs/armUpper/armFore/hand/collar/sleeveUpper/sleeveFore）解析与排序；
 * - 多图集（rig.atlases 1–2 张）/旧 rig 单图集向后兼容；
 * - DIY 增量 pack 新槽位 + 旧槽位别名映射；
 * - getState().look.slots 旧 4 键语义不变（由 runtime cloneSlots 保证；此处覆盖 core 侧）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	BODY_DRAW_SLOTS,
	CUTOUT_SLOTS,
	LEGACY_OUTFIT_SLOTS,
	MAX_ATLASES,
	OUTFIT_SLOTS,
	emptyLookSlots,
	normalizeAtlases,
	normalizeDiyPack,
	resolveDrawableAtlas,
	resolveLook,
	visibleDrawables,
} from '../docs/dress-up/runtime-2d5-core.js';

/** 最小 cutout 身形（只关心 slot/z/id；权重/网格不在本测试范围）。 */
function makeCutoutRig() {
	/** @param {string} id @param {string} slot @param {number} z */
	const drawable = (id, slot, z) => ({ id, slot, z, mesh: { positions: [] } });
	return {
		atlases: [
			{ id: 'base', file: 'atlas.webp', width: 2048, height: 2048 },
			{ id: 'cutout', file: 'atlas-cutout.webp', width: 1024, height: 1024 },
		],
		slots: {
			hairBack: ['hair-back'],
			strands: ['strandL'],
			body: ['body-torso'],
			legs: ['legsL', 'legsR'],
			arms: [],
			armUpper: ['armUpperL', 'armUpperR'],
			armFore: ['armForeL', 'armForeR'],
			hand: ['handL', 'handR'],
			hair: ['hair'],
			hairFront: ['bangs'],
			collar: ['collar-base'],
		},
		drawables: [
			drawable('hair-back', 'hairBack', 4),
			drawable('hair', 'hair', 8),
			drawable('legsL', 'legs', 9),
			drawable('legsR', 'legs', 9),
			drawable('body-torso', 'body', 10),
			drawable('strandL', 'strands', 8),
			drawable('bangs', 'hairFront', 70),
			drawable('topBody', 'topBody', 40),
			drawable('bottom', 'bottom', 30),
			drawable('sleeveUpperL', 'sleeveUpper', 60),
			drawable('sleeveForeL', 'sleeveFore', 62),
			drawable('collar', 'collar', 56),
			drawable('collar-base', 'collar', 56),
			drawable('armUpperL', 'armUpper', 45),
			drawable('armForeL', 'armFore', 48),
			drawable('handL', 'hand', 65),
		],
		outfits: {
			cutout: {
				name: 'cutout 测试套装',
				topBody: ['topBody'], bottom: ['bottom'], collar: ['collar'],
				sleeveUpper: ['sleeveUpperL'], sleeveFore: ['sleeveForeL'],
			},
		},
	};
}

test('cutout 槽位常量：新槽位覆盖 SPEC，旧 4 槽位保留在 OUTFIT_SLOTS', () => {
	for (const slot of ['legs', 'armUpper', 'armFore', 'hand', 'collar', 'sleeveUpper', 'sleeveFore']) {
		assert.ok(CUTOUT_SLOTS.includes(slot), `CUTOUT_SLOTS 缺少 ${slot}`);
	}
	for (const slot of ['collar', 'sleeveUpper', 'sleeveFore']) {
		assert.ok(OUTFIT_SLOTS.includes(slot), `OUTFIT_SLOTS 缺少服装新槽位 ${slot}`);
	}
	for (const slot of LEGACY_OUTFIT_SLOTS) assert.ok(OUTFIT_SLOTS.includes(slot), `旧槽位 ${slot} 丢失`);
	// 身体部件常驻槽位包含新 cutout 部件
	for (const slot of ['legs', 'armUpper', 'armFore', 'hand']) assert.ok(BODY_DRAW_SLOTS.includes(slot));
	// 空 look slots：包含全部服装槽位，且旧 4 键为数组
	const empty = emptyLookSlots();
	for (const slot of OUTFIT_SLOTS) assert.deepEqual(empty[slot], []);
	assert.equal(Object.keys(empty).length, OUTFIT_SLOTS.length);
});

test('visibleDrawables：cutout 槽位按 z 排序（legs<body<topBody<armUpper<armFore<collar<sleeveUpper<sleeveFore<hand）', () => {
	const rig = makeCutoutRig();
	const look = resolveLook(rig, { outfit: 'cutout' });
	assert.deepEqual(look.slots.topBody, ['topBody']);
	assert.deepEqual(look.slots.collar, ['collar']);
	assert.deepEqual(look.slots.sleeveUpper, ['sleeveUpperL']);
	assert.deepEqual(look.slots.sleeveFore, ['sleeveForeL']);
	const entries = visibleDrawables(rig, look, { eye: 'open', mouth: 'closed' });
	const ids = entries.map((entry) => entry.id);
	const zOf = (/** @type {string} */ id) => {
		const found = rig.drawables.find((drawable) => drawable.id === id);
		return found ? found.z : NaN;
	};
	// 逐项相对顺序（含身体 cutout 部件）
	const order = ['legsL', 'body-torso', 'bottom', 'topBody', 'armUpperL', 'armForeL', 'collar', 'collar-base', 'sleeveUpperL', 'sleeveForeL', 'handL', 'bangs'];
	const positions = order.map((id) => ids.indexOf(id));
	for (let i = 1; i < positions.length; i += 1) {
		assert.ok(positions[i - 1] < positions[i], `${order[i - 1]}(z=${zOf(order[i - 1])}) 应排在 ${order[i]}(z=${zOf(order[i])}) 前：${ids.join(',')}`);
	}
	// z 升序
	const zs = entries.map((entry) => entry.z);
	for (let i = 1; i < zs.length; i += 1) assert.ok(zs[i - 1] <= zs[i], 'visibleDrawables 必须按 z 升序');
});

test('visibleDrawables：旧 rig（无 cutout 槽位）仍可渲染，不引入任何新槽位 drawable', () => {
	const legacy = {
		slots: { hairBack: ['hair-back'], body: ['body'], arms: ['arms'], hairFront: ['bangs'] },
		drawables: [
			{ id: 'hair-back', slot: 'hairBack', z: 4 },
			{ id: 'body', slot: 'body', z: 10 },
			{ id: 'arms', slot: 'arms', z: 50 },
			{ id: 'bangs', slot: 'hairFront', z: 70 },
			{ id: 'maid-body', slot: 'topBody', z: 40 },
		],
		outfits: { maid: { name: 'maid', topBody: ['maid-body'] } },
	};
	const look = resolveLook(legacy, { outfit: 'maid' });
	assert.deepEqual(look.slots.topBody, ['maid-body']);
	assert.deepEqual(look.slots.sleeveUpper, []);
	assert.deepEqual(look.slots.collar, []);
	const ids = visibleDrawables(legacy, look, {}).map((entry) => entry.id);
	assert.deepEqual(ids, ['hair-back', 'body', 'maid-body', 'arms', 'bangs']);
});

test('normalizeAtlases：旧单图集兼容 / 新多图集（≤MAX_ATLASES）/ 超限与重复 id 报错', () => {
	const legacy = normalizeAtlases({ atlas: { file: 'atlas.webp', width: 2048, height: 2048 } });
	assert.equal(legacy.ok, true);
	assert.equal(legacy.legacy, true);
	assert.equal(legacy.atlases.length, 1);
	assert.equal(legacy.atlases[0].file, 'atlas.webp');

	const multi = normalizeAtlases(makeCutoutRig());
	assert.equal(multi.ok, true);
	assert.equal(multi.legacy, false);
	assert.deepEqual(multi.atlases.map((atlas) => atlas.id), ['base', 'cutout']);
	assert.equal(MAX_ATLASES, 6);

	const tooMany = normalizeAtlases({
		atlases: Array.from({ length: MAX_ATLASES + 1 }, (_, index) => ({ id: `p${index}`, file: `atlas-${index}.webp` })),
	});
	assert.equal(tooMany.ok, false);
	assert.ok(tooMany.errors.includes('too_many_atlases'));

	const dup = normalizeAtlases({ atlases: [{ id: 'a', file: 'a.webp' }, { id: 'a', file: 'b.webp' }] });
	assert.equal(dup.ok, false);
	assert.ok(dup.errors.some((error) => error.startsWith('duplicate_atlas_id')));

	const missingFile = normalizeAtlases({ atlases: [{ id: 'a' }] });
	assert.equal(missingFile.ok, false);
	assert.ok(missingFile.errors.some((error) => error.startsWith('atlas_file_missing')));
});

test('resolveDrawableAtlas：id / 下标 / 文件名 / 缺省回退第一张', () => {
	const { atlases } = normalizeAtlases(makeCutoutRig());
	assert.equal(resolveDrawableAtlas({ atlas: 'cutout' }, atlases), 1);
	assert.equal(resolveDrawableAtlas({ atlas: 'base' }, atlases), 0);
	assert.equal(resolveDrawableAtlas({ atlas: 1 }, atlases), 1);
	assert.equal(resolveDrawableAtlas({ atlas: 'atlas-cutout.webp' }, atlases), 1);
	assert.equal(resolveDrawableAtlas({}, atlases), 0);
	assert.equal(resolveDrawableAtlas({ atlas: 'unknown' }, atlases), 0);
	assert.equal(resolveDrawableAtlas({ atlas: 5 }, atlases), 0);
});

test('normalizeDiyPack：新槽位（sleeveUpper/sleeveFore/collar）可加载，旧槽位别名映射（arms→sleeve）', () => {
	/** @param {string} slot */
	const drawable = (slot) => ({
		id: `diy-x-${slot}`, slot, z: 60, texture: `tex/diy-x-${slot}.webp`, texSize: [8, 8], rect: [0, 0, 8, 8],
		mesh: {
			positions: [[0, 0], [8, 0], [8, 8]],
			uvs: [[0, 0], [1, 0], [1, 1]],
			bones: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
			weights: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]],
			deform: [[0, 0], [0, 0], [0, 0]],
			indices: [0, 1, 2],
		},
	});
	const makePack = (/** @type {any[]} */ drawables) => ({
		format: 'feiyu-diy-pack', formatVersion: 1, item: 'diy-cutout-20260101000000', shape: 'chibi',
		base: { skeletonBones: 59 }, drawables,
		outfits: { 'diy-cutout-20260101000000': { name: 'x', topBody: [], sleeveUpper: [drawables[0].id], bottom: [] } },
	});
	const cutoutPack = makePack([drawable('sleeveUpper'), drawable('sleeveFore')]);
	cutoutPack.outfits['diy-cutout-20260101000000'].sleeveUpper = [drawable('sleeveUpper').id];
	const result = normalizeDiyPack(cutoutPack, { bones: 59, shape: 'chibi' });
	assert.equal(result.ok, true, result.errors.join(','));

	const aliasPack = makePack([drawable('arms')]);
	aliasPack.outfits['diy-cutout-20260101000000'] = { name: 'x', sleeve: [drawable('arms').id], topBody: [] };
	const alias = normalizeDiyPack(aliasPack, { bones: 59, shape: 'chibi' });
	assert.equal(alias.ok, true, alias.errors.join(','));
	assert.equal(alias.drawables[0].slot, 'sleeve', '旧 arms 槽位应映射为 sleeve（服装槽位）');

	const badSlot = makePack([drawable('shoes')]);
	badSlot.outfits['diy-cutout-20260101000000'] = { name: 'x', topBody: [drawable('shoes').id] };
	const bad = normalizeDiyPack(badSlot, { bones: 59, shape: 'chibi' });
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((error) => error.startsWith('slot_invalid')));
});

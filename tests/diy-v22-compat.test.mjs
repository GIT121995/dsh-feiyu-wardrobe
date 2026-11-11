/**
 * v3.0 DIY 兼容测试（Phase 2B）：
 * 1) runtime core：旧 v2.1 generic / v2.2–v2.7 cutout 分件 base 引用 → v3 整层 drawable
 *    （`{combo}-top` / `{combo}-skirt`）；用户自绘层不丢、同一整层不重复叠加 base 服装、
 *    缺目标安全置空 + 记 unmapped（不抛错）；
 * 2) auto-pair（下装 pack 配上衣 / 上衣 pack 配下装）从当前 rig.outfits 动态取：
 *    v3 整层 rig → 只配对 1 层；v2.2–v2.7 分件 rig → 保持旧观感（过渡期不回归）；
 * 3) tools/diy/bind_layers.py：pairing 从 base rig 动态取（v3 整层 rig 也成立，不写死分件 id）。
 *
 * 说明：v3 真实 dist 由 Phase 2A 重建；本测试用 mock drawableById/outfits 覆盖规则，
 * 并对真实 rig 只做结构派生断言（v2.7 过渡期与 v3 均成立，不锁死分件 id）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { dressUpRoot } from '../lib/webserver.js';
import {
	DIY_AUTO_PAIR_OUTFITS,
	LEGACY_V21_BASE_REFS,
	LEGACY_V22_BASE_REFS,
	V3_OUTFIT_LAYERS,
	legacyBaseRefTargets,
	migrateDiyPackOutfits,
	normalizeDiyPack,
} from '../docs/dress-up/runtime-2d5-core.js';

const ROOT = resolve(import.meta.dirname, '..');
const PYTHON = process.env.DSH_FEIYU_PYTHON || 'python3';
const BASE_RIG = JSON.parse(readFileSync(join(dressUpRoot(), 'art/2d5/chibi/rig.json'), 'utf8'));

/** 旧 v2.1 base 引用键（从运行时迁移表派生，测试不改写旧键名）。 */
const LEGACY_V21_KEYS = Object.keys(LEGACY_V21_BASE_REFS);
/** v3 全部整层 drawable id（各套 top/skirt）。 */
const V3_LAYER_IDS = new Set(Object.values(V3_OUTFIT_LAYERS).flatMap((layers) => [layers.top, layers.skirt]));
const V3_COMBOS = Object.keys(V3_OUTFIT_LAYERS);

/* ---------------------------------------------------------------- mock 场景 --- */

/** v3 场景 drawableById（每套只有 top/skirt 两个整层 drawable）。 */
function v3DrawableById() {
	/** @type {Record<string, { slot: string }>} */
	const map = { 'body-torso': { slot: 'body' }, 'body-head': { slot: 'body' } };
	for (const combo of V3_COMBOS) {
		map[V3_OUTFIT_LAYERS[combo].top] = { slot: 'topBody' };
		map[V3_OUTFIT_LAYERS[combo].skirt] = { slot: 'bottom' };
	}
	return map;
}

/** v3 场景 outfits（每套 topBody/bottom 各 1 项）。 */
function v3Outfits() {
	/** @type {Record<string, any>} */
	const outfits = {};
	for (const combo of V3_COMBOS) {
		outfits[combo] = {
			name: combo,
			topBody: [V3_OUTFIT_LAYERS[combo].top],
			bottom: [V3_OUTFIT_LAYERS[combo].skirt],
		};
	}
	return outfits;
}

/**
 * v2.2–v2.7 过渡期场景（分件仍在）：用于证明迁移/auto-pair 对旧 dist 不回归。
 * 只列迁移/配对会用到的 base 部件。
 */
function v27DrawableById() {
	/** @type {Record<string, { slot: string }>} */
	const map = { 'body-torso': { slot: 'body' } };
	const layer = (/** @type {string} */ slot, /** @type {string[]} */ ids) => {
		for (const id of ids) map[id] = { slot };
	};
	layer('topBody', ['hoodie-plaid-torso', 'hoodie-pleated-torso', 'maid-torso']);
	layer('topUnder', ['sailor-plaid-torso']);
	layer('collar', ['sailor-plaid-collar', 'maid-collar', 'maid-apron']);
	layer('sleeveUpper', [
		'hoodie-plaid-sleeve-upper-L', 'hoodie-plaid-sleeve-upper-R',
		'hoodie-pleated-sleeve-upper-L', 'hoodie-pleated-sleeve-upper-R',
		'maid-sleeve-upper-L', 'maid-sleeve-upper-R',
		'sailor-plaid-sleeve-upper-L', 'sailor-plaid-sleeve-upper-R',
	]);
	layer('sleeveFore', [
		'hoodie-plaid-sleeve-fore-L', 'hoodie-plaid-sleeve-fore-R',
		'hoodie-pleated-sleeve-fore-L', 'hoodie-pleated-sleeve-fore-R',
		'maid-sleeve-fore-L', 'maid-sleeve-fore-R',
	]);
	layer('bottom', [
		'hoodie-plaid-skirt', 'hoodie-plaid-skirt-under',
		'hoodie-pleated-skirt', 'hoodie-pleated-skirt-under',
		'maid-skirt', 'maid-skirt-under',
		'sailor-plaid-skirt', 'sailor-plaid-skirt-under',
	]);
	return map;
}

/** v2.2–v2.7 过渡期场景 outfits（分件槽位）。 */
function v27Outfits() {
	return {
		'hoodie-plaid': {
			name: 'hoodie-plaid',
			topBody: ['hoodie-plaid-torso'],
			bottom: ['hoodie-plaid-skirt', 'hoodie-plaid-skirt-under'],
			sleeveUpper: ['hoodie-plaid-sleeve-upper-L', 'hoodie-plaid-sleeve-upper-R'],
			sleeveFore: ['hoodie-plaid-sleeve-fore-L', 'hoodie-plaid-sleeve-fore-R'],
		},
		'hoodie-pleated': {
			name: 'hoodie-pleated',
			topBody: ['hoodie-pleated-torso'],
			bottom: ['hoodie-pleated-skirt', 'hoodie-pleated-skirt-under'],
			sleeveUpper: ['hoodie-pleated-sleeve-upper-L', 'hoodie-pleated-sleeve-upper-R'],
			sleeveFore: ['hoodie-pleated-sleeve-fore-L', 'hoodie-pleated-sleeve-fore-R'],
		},
		maid: {
			name: 'maid',
			topBody: ['maid-torso'],
			bottom: ['maid-skirt', 'maid-skirt-under'],
			collar: ['maid-collar', 'maid-apron'],
			sleeveUpper: ['maid-sleeve-upper-L', 'maid-sleeve-upper-R'],
			sleeveFore: ['maid-sleeve-fore-L', 'maid-sleeve-fore-R'],
		},
		'sailor-plaid': {
			name: 'sailor-plaid',
			topUnder: ['sailor-plaid-torso'],
			bottom: ['sailor-plaid-skirt', 'sailor-plaid-skirt-under'],
			collar: ['sailor-plaid-collar'],
			sleeveUpper: ['sailor-plaid-sleeve-upper-L', 'sailor-plaid-sleeve-upper-R'],
		},
	};
}

/** 收集一个 outfit 全部槽位引用（拍平，便于断言「整层只出现一次 / 无旧 id 残留」）。 */
function refsOf(outfit) {
	return Object.entries(outfit || {})
		.filter(([slot]) => slot !== 'name')
		.flatMap(([, ids]) => (Array.isArray(ids) ? ids : []));
}

/* ------------------------------------------------- 映射规则表（可读契约） --- */

test('LEGACY_V21_BASE_REFS：v2.1 旧上衣/袖按套收敛到 v3 整层 top、旧下装收敛到 v3 裙层', () => {
	// 关键规则（任务约定的可读映射表）
	assert.deepEqual(LEGACY_V21_BASE_REFS['hoodie-body'], ['hoodie-plaid-top'], 'hoodie 旧衣身 → 整层 top');
	assert.deepEqual(LEGACY_V21_BASE_REFS['hoodie-sleeve'], ['hoodie-plaid-top'], 'hoodie 旧袖 → 同套整层 top');
	assert.deepEqual(LEGACY_V21_BASE_REFS['sailor-body'], ['sailor-plaid-top']);
	assert.deepEqual(LEGACY_V21_BASE_REFS['sailor-sleeve'], ['sailor-plaid-top'], '水手袖并入整层 top');
	assert.deepEqual(LEGACY_V21_BASE_REFS['maid-body'], ['maid-top']);
	assert.deepEqual(LEGACY_V21_BASE_REFS['maid-sleeve'], ['maid-top'], '女仆袖并入整层 top（含领/围裙）');
	assert.deepEqual(LEGACY_V21_BASE_REFS['bottom-plaid'], ['hoodie-plaid-skirt']);
	assert.deepEqual(LEGACY_V21_BASE_REFS['bottom-pleated'], ['hoodie-pleated-skirt']);
	// v2.7.0 已下架的毛衣：保持 v2.7.0 决策 → hoodie-plaid 整层上衣
	assert.deepEqual(LEGACY_V21_BASE_REFS['sweater-body'], ['hoodie-plaid-top']);
	assert.deepEqual(LEGACY_V21_BASE_REFS['sweater-sleeve'], ['hoodie-plaid-top']);
	// 表内所有目标都必须是 v3 整层 id（不得残留 v2.2 分件 id）
	for (const [ref, targets] of Object.entries(LEGACY_V21_BASE_REFS)) {
		assert.ok(Array.isArray(targets) && targets.length > 0, `${ref} 迁移目标不能为空`);
		for (const target of targets) assert.ok(V3_LAYER_IDS.has(target), `${ref} → ${target} 不是 v3 整层 id`);
	}
});

test('LEGACY_V22_BASE_REFS：v2.2–v2.7 分件 → 同套整层 id（torso/collar/sleeve 收敛 top，skirt-under 收敛 skirt）', () => {
	// 抽样：同一套的旧分件全部收敛到同一个整层（v3 整层已含领口/袖）
	assert.deepEqual(LEGACY_V22_BASE_REFS['hoodie-plaid-torso'], ['hoodie-plaid-top']);
	assert.deepEqual(LEGACY_V22_BASE_REFS['hoodie-plaid-sleeve-upper-L'], ['hoodie-plaid-top']);
	assert.deepEqual(LEGACY_V22_BASE_REFS['hoodie-plaid-sleeve-fore-R'], ['hoodie-plaid-top']);
	assert.deepEqual(LEGACY_V22_BASE_REFS['hoodie-plaid-skirt-under'], ['hoodie-plaid-skirt']);
	assert.deepEqual(LEGACY_V22_BASE_REFS['sailor-plaid-collar'], ['sailor-plaid-top']);
	assert.deepEqual(LEGACY_V22_BASE_REFS['sailor-plaid-torso'], ['sailor-plaid-top']);
	assert.deepEqual(LEGACY_V22_BASE_REFS['maid-apron'], ['maid-top']);
	assert.deepEqual(LEGACY_V22_BASE_REFS['maid-sleeve-fore-L'], ['maid-top']);
	assert.deepEqual(LEGACY_V22_BASE_REFS['maid-skirt-under'], ['maid-skirt']);
	assert.deepEqual(LEGACY_V22_BASE_REFS['sweater-plaid-torso'], ['hoodie-plaid-top'], '已下架毛衣 v2.2 分件保持 v2.7.0 回退');
	assert.deepEqual(LEGACY_V22_BASE_REFS['sweater-pleated-skirt'], ['hoodie-pleated-skirt']);
	for (const [ref, targets] of Object.entries(LEGACY_V22_BASE_REFS)) {
		assert.equal(targets.length, 1, `${ref} 应只映射一个整层`);
		assert.ok(V3_LAYER_IDS.has(targets[0]), `${ref} → ${targets[0]} 不是 v3 整层 id`);
	}
	// 规则一致性：同一 combo 前缀的分件只能映射到该 combo 的 top 或 skirt
	for (const [ref, targets] of Object.entries(LEGACY_V22_BASE_REFS)) {
		const comma = V3_COMBOS.find((combo) => ref.startsWith(`${combo}-`));
		if (!comma) continue;
		const layer = V3_OUTFIT_LAYERS[comma];
		assert.ok(targets.includes(layer.top) || targets.includes(layer.skirt), `${ref} → ${targets[0]} 与 ${comma} 不一致`);
	}
	// legacyBaseRefTargets：两张表都覆盖，未知引用返回 null
	assert.deepEqual(legacyBaseRefTargets('hoodie-body'), ['hoodie-plaid-top']);
	assert.deepEqual(legacyBaseRefTargets('hoodie-plaid-torso'), ['hoodie-plaid-top']);
	assert.equal(legacyBaseRefTargets('made-up-ref'), null);
	assert.equal(legacyBaseRefTargets(''), null);
});

/* ---------------------------------------------- 旧 pack 迁移：自身层不丢 --- */

test('migrateDiyPackOutfits：v2.1 旧 top pack（自绘衣身/袖 + bottom-plaid）→ v3 整层，自绘层保留', () => {
	const drawableById = v3DrawableById();
	const legacyOutfits = {
		'diy-old-top': {
			name: '旧上衣',
			topBody: ['diy-old-top-body'],
			sleeve: ['diy-old-top-sleeve'],
			bottom: ['bottom-plaid'],
		},
	};
	const result = migrateDiyPackOutfits(legacyOutfits, drawableById, ['diy-old-top-body', 'diy-old-top-sleeve']);
	const outfit = result.outfits['diy-old-top'];
	assert.deepEqual(outfit.topBody, ['diy-old-top-body'], '用户自绘衣身必须保留');
	assert.deepEqual(outfit.sleeve, ['diy-old-top-sleeve'], '用户自绘袖必须保留');
	assert.deepEqual(outfit.bottom, ['hoodie-plaid-skirt'], 'bottom-plaid → v3 裙层');
	assert.ok(result.warnings.includes('migrated:bottom-plaid→hoodie-plaid-skirt'), `warnings=${result.warnings.join(',')}`);
	assert.deepEqual(result.unmapped, []);
	// 不修改输入对象
	assert.deepEqual(legacyOutfits['diy-old-top'].bottom, ['bottom-plaid']);
});

test('migrateDiyPackOutfits：v2.1 旧 bottom pack（上衣/袖分件引用）→ 1 个整层 top，不重复叠加', () => {
	const drawableById = v3DrawableById();
	const result = migrateDiyPackOutfits({
		'diy-old-bottom': {
			name: '旧下装',
			topBody: ['hoodie-body'],
			sleeve: ['hoodie-sleeve'],
			bottom: ['diy-old-bottom-body'],
		},
	}, drawableById, ['diy-old-bottom-body']);
	const outfit = result.outfits['diy-old-bottom'];
	// 旧上衣 + 袖两个 base 引用 → 同一个 v3 整层 top（不叠加两份）
	assert.deepEqual(outfit.topBody, ['hoodie-plaid-top']);
	assert.deepEqual(outfit.sleeve || [], [], 'v2.1 sleeve 收敛进整层 top，不再单列');
	assert.deepEqual(outfit.bottom, ['diy-old-bottom-body']);
	assert.equal(refsOf(outfit).filter((id) => id === 'hoodie-plaid-top').length, 1, '整层 top 只应出现一次');
	assert.deepEqual(result.unmapped, []);
});

test('migrateDiyPackOutfits：v2.1 全部旧上衣/袖键在 v3 场景均有映射且不产生旧 id 残留', () => {
	const drawableById = v3DrawableById();
	for (const ref of LEGACY_V21_KEYS) {
		if (ref.startsWith('bottom-')) continue; // 下装键在下面的 auto-pair/单独断言覆盖
		const result = migrateDiyPackOutfits({
			'diy-old-single': { name: 'x', topBody: [ref], sleeve: [], bottom: ['diy-old-single-body'] },
		}, drawableById, ['diy-old-single-body']);
		const outfit = result.outfits['diy-old-single'];
		const mapped = refsOf(outfit).filter((id) => V3_LAYER_IDS.has(id));
		assert.equal(mapped.length, 1, `${ref} 应映射到恰好 1 个整层，实际 ${JSON.stringify(mapped)}`);
		assert.deepEqual(result.unmapped.filter((entry) => entry.includes(ref)), [], `${ref} 不应 unmapped`);
	}
});

test('migrateDiyPackOutfits：v2.2 分件引用（过渡期 pack）→ 整层 + 自绘层保留 + 整层去重', () => {
	const drawableById = v3DrawableById();
	const result = migrateDiyPackOutfits({
		'diy-v22': {
			name: 'v2.2 期 pack',
			topBody: ['diy-v22-body', 'hoodie-plaid-torso'],
			sleeve: ['diy-v22-sleeve'],
			sleeveUpper: ['hoodie-plaid-sleeve-upper-L', 'hoodie-plaid-sleeve-upper-R'],
			sleeveFore: ['hoodie-plaid-sleeve-fore-L', 'hoodie-plaid-sleeve-fore-R'],
			bottom: ['hoodie-plaid-skirt-under'],
		},
	}, drawableById, ['diy-v22-body', 'diy-v22-sleeve']);
	const outfit = result.outfits['diy-v22'];
	assert.deepEqual(outfit.topBody, ['diy-v22-body', 'hoodie-plaid-top'], '自绘衣身 + 收敛后的整层 top');
	assert.deepEqual(outfit.sleeve, ['diy-v22-sleeve'], '自绘袖保留');
	assert.deepEqual(outfit.bottom, ['hoodie-plaid-skirt'], 'skirt-under → 整层 skirt');
	assert.deepEqual(outfit.sleeveUpper || [], []);
	assert.deepEqual(outfit.sleeveFore || [], []);
	assert.equal(refsOf(outfit).filter((id) => id === 'hoodie-plaid-top').length, 1, '4 个旧上衣分件应去重为 1 个整层');
	assert.equal(refsOf(outfit).filter((id) => id === 'hoodie-plaid-skirt').length, 1, 'skirt-under 不应与 skirt 叠加');
	const refs = refsOf(outfit);
	for (const id of refs) {
		if (id.startsWith('diy-')) continue;
		assert.ok(V3_LAYER_IDS.has(id), `迁移结果不应残留旧分件 id：${id}`);
	}
	assert.deepEqual(result.unmapped, []);
	assert.ok(result.warnings.some((warning) => warning.startsWith('migrated:hoodie-plaid-torso→hoodie-plaid-top')));
});

test('migrateDiyPackOutfits：目标缺失/未知引用安全置空并记 unmapped，不抛错、不丢自绘层', () => {
	const result = migrateDiyPackOutfits({
		'diy-broken': {
			name: 'broken',
			topBody: ['hoodie-body', 'diy-broken-body'],
			bottom: ['bottom-plaid'],
			sleeve: ['made-up-ref'],
		},
	}, {}, ['diy-broken-body']);
	const outfit = result.outfits['diy-broken'];
	assert.deepEqual(outfit.topBody, ['diy-broken-body'], '自绘层仍在');
	assert.deepEqual(outfit.bottom || [], []);
	assert.deepEqual(outfit.sleeve || [], []);
	assert.ok(result.unmapped.some((entry) => entry.includes('hoodie-body@missing-target')));
	assert.ok(result.unmapped.some((entry) => entry.includes('bottom-plaid@missing-target')));
	assert.ok(result.unmapped.some((entry) => entry.includes('made-up-ref')));
});

/* -------------------------------------- auto-pair：v3 单层 / v2.7 分件均成立 --- */

test('migrateDiyPackOutfits：auto-pair 在 v3 单层 rig 上只补 1 层（bottom→top、top→skirt）', () => {
	const drawableById = v3DrawableById();
	const outfits = v3Outfits();
	// 旧下装 pack 无上衣 → 自动补 1 个整层 top（防裸上身）
	const bottomResult = migrateDiyPackOutfits({
		'diy-old-skirt': { name: '旧裙', topBody: [], bottom: ['diy-old-skirt-body'] },
	}, drawableById, ['diy-old-skirt-body'], { category: 'bottom', outfits });
	const bottomOutfit = bottomResult.outfits['diy-old-skirt'];
	assert.deepEqual(bottomOutfit.topBody, ['hoodie-plaid-top']);
	assert.deepEqual(bottomOutfit.sleeveUpper || [], []);
	assert.deepEqual(bottomOutfit.sleeveFore || [], []);
	assert.ok(bottomResult.warnings.includes(`migrated:auto-pair-top:hoodie-plaid-top`), `warnings=${bottomResult.warnings.join(',')}`);
	// 旧上衣 pack 无下装 → 自动补 1 个整层 skirt（防光腿）
	const topResult = migrateDiyPackOutfits({
		'diy-old-shirt': { name: '旧上衣', topBody: ['diy-old-shirt-body'], bottom: [] },
	}, drawableById, ['diy-old-shirt-body'], { category: 'top', outfits });
	const topOutfit = topResult.outfits['diy-old-shirt'];
	assert.deepEqual(topOutfit.bottom, ['hoodie-plaid-skirt']);
	assert.deepEqual(topOutfit.topBody, ['diy-old-shirt-body']);
	assert.ok(topResult.warnings.includes('migrated:auto-pair-bottom:hoodie-plaid-skirt'));
});

test('migrateDiyPackOutfits：auto-pair 在 v2.2–v2.7 分件 rig 上保持旧观感（过渡期不回归）', () => {
	const drawableById = v27DrawableById();
	const outfits = v27Outfits();
	const bottomResult = migrateDiyPackOutfits({
		'diy-old-skirt': { name: '旧裙', topBody: [], bottom: ['diy-old-skirt-body'] },
	}, drawableById, ['diy-old-skirt-body'], { category: 'bottom', outfits });
	const bottomOutfit = bottomResult.outfits['diy-old-skirt'];
	assert.deepEqual(bottomOutfit.topBody, ['hoodie-plaid-torso']);
	assert.equal(bottomOutfit.sleeveUpper.length, 2, '分件 rig 仍配对分段袖');
	assert.equal(bottomOutfit.sleeveFore.length, 2);
	// 未传 options.outfits 的旧调用：静态候选兜底，分件 rig 同样配对分段袖
	const legacyCall = migrateDiyPackOutfits({
		'diy-old-skirt': { name: '旧裙', topBody: [], bottom: ['diy-old-skirt-body'] },
	}, drawableById, ['diy-old-skirt-body'], { category: 'bottom' });
	assert.deepEqual(legacyCall.outfits['diy-old-skirt'].topBody, ['hoodie-plaid-torso']);
	assert.equal(legacyCall.outfits['diy-old-skirt'].sleeveUpper.length, 2);
	// v2.7 分件 rig 的 top pack：裙对仍为裙 + 内衬（不应被 v3 规则误伤）
	const topResult = migrateDiyPackOutfits({
		'diy-old-shirt': { name: '旧上衣', topBody: ['diy-old-shirt-body'], bottom: [] },
	}, drawableById, ['diy-old-shirt-body'], { category: 'top', outfits });
	assert.deepEqual(topResult.outfits['diy-old-shirt'].bottom, ['hoodie-plaid-skirt', 'hoodie-plaid-skirt-under']);
});

test('migrateDiyPackOutfits：auto-pair 参考套装顺序以 hoodie-plaid 优先（可被 rig 缺件跳过）', () => {
	assert.equal(DIY_AUTO_PAIR_OUTFITS[0], 'hoodie-plaid');
	// 只有 maid 可用时，auto-pair 退到 maid 整层
	const drawableById = { 'maid-top': { slot: 'topBody' }, 'maid-skirt': { slot: 'bottom' } };
	const outfits = { maid: { topBody: ['maid-top'], bottom: ['maid-skirt'] } };
	const result = migrateDiyPackOutfits({
		'diy-old-skirt': { name: '旧裙', topBody: [], bottom: [] },
	}, drawableById, [], { category: 'bottom', outfits });
	assert.deepEqual(result.outfits['diy-old-skirt'].topBody, ['maid-top']);
});

/* ------------------------------------- normalizeDiyPack + 迁移端到端 --- */

/** 构造最小可用 feiyu-diy-pack（2 drawables；59 骨）。 */
function makeLegacyPack() {
	const drawable = (/** @type {string} */ id, /** @type {string} */ slot) => ({
		id, slot, z: 40, role: slot, texture: `tex/${id}.webp`,
		texSize: [8, 8], rect: [0, 0, 8, 8],
		mesh: {
			positions: [[0, 0], [8, 0], [8, 8]],
			uvs: [[0, 0], [1, 0], [1, 1]],
			bones: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
			weights: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]],
			deform: [[0, 0], [0, 0], [0, 0]],
			indices: [0, 1, 2],
		},
	});
	return {
		format: 'feiyu-diy-pack', formatVersion: 1, item: 'diy-v22-legacy-20260101000000',
		name: 'v2.2 期套装', shape: 'chibi', category: 'top',
		base: { skeletonBones: 59 },
		drawables: [
			drawable('diy-v22-legacy-20260101000000-body', 'topBody'),
			drawable('diy-v22-legacy-20260101000000-sleeve', 'sleeve'),
		],
		outfits: {
			'diy-v22-legacy-20260101000000': {
				name: 'v2.2 期套装',
				topBody: ['diy-v22-legacy-20260101000000-body', 'hoodie-plaid-torso'],
				sleeve: ['diy-v22-legacy-20260101000000-sleeve'],
				sleeveUpper: ['hoodie-plaid-sleeve-upper-L', 'hoodie-plaid-sleeve-upper-R'],
				bottom: ['hoodie-plaid-skirt-under'],
			},
		},
	};
}

test('normalizeDiyPack + migrate：v2.2 期 pack（引用 base 分件）校验通过，自绘层不因分件消失而丢', () => {
	const pack = makeLegacyPack();
	const normalized = normalizeDiyPack(pack, { bones: 59, shape: 'chibi' });
	assert.equal(normalized.ok, true, `pack 应校验通过：${normalized.errors.join(',')}`);
	const ownIds = normalized.drawables.map((drawable) => drawable.id);
	const migration = migrateDiyPackOutfits(normalized.outfits, v3DrawableById(), ownIds);
	const outfit = migration.outfits[pack.item];
	assert.deepEqual(outfit.topBody, ['diy-v22-legacy-20260101000000-body', 'hoodie-plaid-top']);
	assert.deepEqual(outfit.sleeve, ['diy-v22-legacy-20260101000000-sleeve']);
	assert.deepEqual(outfit.bottom, ['hoodie-plaid-skirt']);
	assert.deepEqual(migration.unmapped, []);
});

/* ---------------------------------- tools/diy/bind_layers.py（动态配对） --- */

/** 当前 base rig 上 hoodie-plaid 套的可用配对引用（按槽位；v2.7 分件 / v3 整层都成立）。 */
function basePairingRefs() {
	const outfit = (BASE_RIG.outfits && BASE_RIG.outfits['hoodie-plaid']) || {};
	const drawableIds = new Set(BASE_RIG.drawables.map((drawable) => drawable.id));
	const slots = ['topBody', 'topUnder', 'collar', 'sleeveUpper', 'sleeveFore', 'sleeve', 'bottom'];
	/** @type {Record<string, string[]>} */
	const out = {};
	for (const slot of slots) out[slot] = (outfit[slot] || []).filter((/** @type {string} */ id) => drawableIds.has(id));
	return out;
}

test('bind_layers.py：pairing 从当前 base rig 动态取（v3 整层 rig 也成立；top 配裙、bottom 配上衣）', () => {
	const probe = spawnSync(PYTHON, ['-c', 'import PIL, numpy, cv2; print("ok")'], { encoding: 'utf8' });
	if (probe.status !== 0) {
		console.log('skip: python3 + Pillow/numpy/cv2 不可用');
		return;
	}
	const pairing = basePairingRefs();
	assert.ok(pairing.bottom.length > 0, 'base rig 的 hoodie-plaid 套装应有下装（v3 整层 skirt / v2.7 裙+内衬）');
	assert.ok(pairing.topBody.length > 0, 'base rig 的 hoodie-plaid 套装应有上衣（v3 整层 top / v2.7 torso）');
	const tmp = mkdtempSync(join(tmpdir(), 'feiyu-diy-pair-'));
	try {
		const layers = join(tmp, 'layers-top');
		mkdirSync(layers, { recursive: true });
		const script = [
			'from PIL import Image, ImageDraw',
			'import sys, pathlib',
			'base = pathlib.Path(sys.argv[1])',
			'body = Image.new("RGBA", (675, 1200), (0, 0, 0, 0))',
			'd = ImageDraw.Draw(body)',
			'd.rectangle((240, 520, 430, 800), fill=(240, 240, 245, 255))',
			'body.save(base / "body.png")',
			'sleeve = Image.new("RGBA", (675, 1200), (0, 0, 0, 0))',
			'd = ImageDraw.Draw(sleeve)',
			'd.rectangle((180, 560, 250, 760), fill=(240, 240, 245, 255))',
			'd.rectangle((420, 560, 490, 760), fill=(240, 240, 245, 255))',
			'sleeve.save(base / "sleeve.png")',
		].join('\n');
		const created = spawnSync(PYTHON, ['-c', script, layers], { encoding: 'utf8' });
		assert.equal(created.status, 0, created.stderr);
		const out = join(tmp, 'pack-top');
		const build = spawnSync(PYTHON, [
			join(ROOT, 'tools', 'diy', 'bind_layers.py'),
			'--layers', layers,
			'--base-rig', join(dressUpRoot(), 'art/2d5/chibi/rig.json'),
			'--item-id', 'diy-pair-test-20260101000000',
			'--category', 'top',
			'--out', out,
		], { encoding: 'utf8' });
		assert.equal(build.status, 0, build.stderr);
		const pack = JSON.parse(readFileSync(join(out, 'diy-pack.json'), 'utf8'));
		const outfit = pack.outfits['diy-pair-test-20260101000000'];
		const baseIds = new Set(BASE_RIG.drawables.map((drawable) => drawable.id));
		const refs = Object.entries(outfit)
			.filter(([slot]) => slot !== 'name')
			.flatMap(([, ids]) => ids);
		for (const id of refs) {
			const isOwn = id.startsWith('diy-pair-test-20260101000000');
			assert.ok(isOwn || baseIds.has(id), `pack 引用了 base rig 不存在的 id：${id}`);
		}
		assert.ok(outfit.bottom.length > 0, 'top 分类应对齐 base 下装（避免光腿）');
		assert.deepEqual(outfit.bottom, pairing.bottom, 'top 分类应配对 base rig 的 hoodie-plaid 下装引用');
		assert.equal(outfit.topBody[0], 'diy-pair-test-20260101000000-body', 'DIY 自绘衣身应在最前');
		assert.equal(pack.pairingSource, 'base-rig:hoodie-plaid');
		// P3：base 骨架从 base rig 动态读取（含骨名/版本），不写死 59
		const baseBoneNames = BASE_RIG.skeleton.bones.map((bone) => bone.id);
		assert.equal(pack.base.skeletonBones, baseBoneNames.length);
		assert.deepEqual(pack.base.boneNames, baseBoneNames);
		assert.equal(pack.base.skeletonVersion, BASE_RIG.version);
		// 不应再出现 v2.1 写死 id（旧键集合以运行时迁移表为准）
		for (const legacyId of LEGACY_V21_KEYS) {
			assert.ok(!refs.includes(legacyId), `不应写死 v2.1 id：${legacyId}`);
		}

		// bottom 分类：配当前 base rig 的上衣层（v3 整层 top / v2.7 torso + 分件袖）
		const layersBottom = join(tmp, 'layers-bottom');
		mkdirSync(layersBottom, { recursive: true });
		const madeBottom = spawnSync(PYTHON, ['-c', script, layersBottom], { encoding: 'utf8' });
		assert.equal(madeBottom.status, 0, madeBottom.stderr);
		const outBottom = join(tmp, 'pack-bottom');
		const buildBottom = spawnSync(PYTHON, [
			join(ROOT, 'tools', 'diy', 'bind_layers.py'),
			'--layers', layersBottom,
			'--base-rig', join(dressUpRoot(), 'art/2d5/chibi/rig.json'),
			'--item-id', 'diy-pair-bottom-20260101000000',
			'--category', 'bottom',
			'--out', outBottom,
		], { encoding: 'utf8' });
		assert.equal(buildBottom.status, 0, buildBottom.stderr);
		const packBottom = JSON.parse(readFileSync(join(outBottom, 'diy-pack.json'), 'utf8'));
		const outfitBottom = packBottom.outfits['diy-pair-bottom-20260101000000'];
		assert.ok(outfitBottom.topBody.length > 0, 'bottom 分类应对齐 base 上衣（避免裸上身）');
		assert.deepEqual(outfitBottom.topBody, pairing.topBody, 'bottom 分类应配对 base rig 的 hoodie-plaid 上衣引用');
		for (const slot of ['collar', 'sleeveUpper', 'sleeveFore', 'sleeve', 'topUnder']) {
			const expected = pairing[slot] || [];
			assert.deepEqual(outfitBottom[slot] || [], expected, `bottom 分类的 ${slot} 配对应与 base rig 一致`);
		}
		assert.deepEqual(outfitBottom.bottom, ['diy-pair-bottom-20260101000000-body']);
		assert.equal(packBottom.pairingSource, 'base-rig:hoodie-plaid');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

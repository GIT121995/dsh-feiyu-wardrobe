/**
 * v2.2.1 DIY 兼容修复测试：
 * 1) runtime core：旧 v2.1 DIY pack 的 base 引用按槽位迁移到 v2.2 部件（缺目标安全置空+warning）；
 * 2) tools/diy/bind_layers.py：pairing 从 v2.2 base rig 动态取（不再写死 v2.1 id），
 *    top/coat/dress 配下装、bottom 配上衣/领/袖，且引用均存在于 base rig。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { dressUpRoot } from '../lib/webserver.js';
import { LEGACY_V21_BASE_REFS, migrateDiyPackOutfits } from '../docs/dress-up/runtime-2d5-core.js';

const ROOT = resolve(import.meta.dirname, '..');
const PYTHON = process.env.DSH_FEIYU_PYTHON || 'python3';
const BASE_RIG = JSON.parse(readFileSync(join(dressUpRoot(), 'art/2d5/chibi/rig.json'), 'utf8'));
/** 旧 v2.1 base 引用键（从运行时迁移表派生，测试不改写旧键名）。 */
const LEGACY_KEYS = Object.keys(LEGACY_V21_BASE_REFS);
/** 旧 v2.1 上衣 base 引用：v2.7.0 后其迁移目标为 hoodie-plaid 躯干部件。 */
const LEGACY_TOP_REFS = LEGACY_KEYS.filter((key) => LEGACY_V21_BASE_REFS[key].includes('hoodie-plaid-torso'));
/** 旧 v2.1 袖 base 引用：迁移目标为 hoodie-plaid 分段袖部件。 */
const LEGACY_SLEEVE_REFS = LEGACY_KEYS.filter((key) => LEGACY_V21_BASE_REFS[key].every((id) => id.startsWith('hoodie-plaid-sleeve')));

/** v2.2 chibi 场景 drawableById（只关心 slot）。 */
function sceneDrawables() {
	/** @type {Record<string, { slot: string }>} */
	const map = {};
	for (const drawable of BASE_RIG.drawables) map[drawable.id] = { slot: drawable.slot };
	return map;
}

test('migrateDiyPackOutfits：旧 top pack（bottom-plaid/…）按槽位映射到 v2.2 部件，自身 drawable 保留', () => {
	const drawableById = sceneDrawables();
	const legacyOutfits = {
		'diy-old-top': {
			name: '旧上衣',
			topBody: ['diy-old-top-body'],
			sleeve: ['diy-old-top-sleeve'],
			bottom: ['bottom-plaid'],
			topUnder: [],
		},
	};
	const result = migrateDiyPackOutfits(legacyOutfits, drawableById, ['diy-old-top-body', 'diy-old-top-sleeve']);
	const outfit = result.outfits['diy-old-top'];
	assert.deepEqual(outfit.topBody, ['diy-old-top-body'], '自身 drawable 必须保留');
	assert.deepEqual(outfit.sleeve, ['diy-old-top-sleeve'], 'legacy sleeve 槽位保留');
	assert.deepEqual(outfit.bottom, ['hoodie-plaid-skirt', 'hoodie-plaid-skirt-under'], 'bottom-plaid → hoodie-plaid 裙对');
	assert.ok(result.warnings.some((warning) => warning.startsWith('migrated:bottom-plaid')));
	assert.deepEqual(result.unmapped, []);
	// 不修改输入对象
	assert.deepEqual(legacyOutfits['diy-old-top'].bottom, ['bottom-plaid']);
});

test('migrateDiyPackOutfits：旧 bottom pack（v2.1 上衣/袖引用）映射到 hoodie-plaid 部件', () => {
	const drawableById = sceneDrawables();
	// 用运行时迁移表里的旧上衣/袖键驱动（v2.1 两件上衣都映射到 hoodie-plaid 部件）
	const [legacyTop, legacySleeve] = [LEGACY_TOP_REFS[0], LEGACY_SLEEVE_REFS[0]];
	assert.ok(legacyTop && legacySleeve, '迁移表应保留旧 v2.1 上衣/袖键');
	const result = migrateDiyPackOutfits({
		'diy-old-bottom': {
			name: '旧下装',
			topBody: [legacyTop],
			sleeve: [legacySleeve],
			bottom: ['diy-old-bottom-body'],
			topUnder: [],
		},
	}, drawableById, ['diy-old-bottom-body']);
	const outfit = result.outfits['diy-old-bottom'];
	assert.deepEqual(outfit.topBody, ['hoodie-plaid-torso']);
	assert.equal((outfit.sleeve || []).length, 0, "v2.1 sleeve 应迁移到 sleeveUpper/sleeveFore");
	assert.equal(outfit.sleeveUpper.length, 2);
	assert.equal(outfit.sleeveFore.length, 2);
	assert.deepEqual(outfit.bottom, ['diy-old-bottom-body']);
	assert.equal(result.unmapped.length, 0);
	// 全部旧上衣 base 键都应映射到同一 hoodie-plaid 躯干
	for (const legacyTopKey of LEGACY_TOP_REFS) {
		const single = migrateDiyPackOutfits({
			'diy-old-top-single': { name: '旧上衣', topBody: [legacyTopKey], bottom: ['diy-old-body'], topUnder: [] },
		}, drawableById, ['diy-old-body']);
		assert.deepEqual(single.outfits['diy-old-top-single'].topBody, ['hoodie-plaid-torso'], `${legacyTopKey} 应迁移到 hoodie-plaid-torso`);
	}
});

test('migrateDiyPackOutfits：旧 dress/outfit pack 无 bottom 时按品类自动补 v2.2 裙对（防光腿）', () => {
	const drawableById = sceneDrawables();
	const result = migrateDiyPackOutfits({
		'diy-old-dress': { name: '旧连衣裙', topBody: ['diy-old-dress-body'], sleeve: ['diy-old-dress-sleeve'], bottom: [], topUnder: [] },
	}, drawableById, ['diy-old-dress-body', 'diy-old-dress-sleeve'], { category: 'dress' });
	const outfit = result.outfits['diy-old-dress'];
	assert.deepEqual(outfit.bottom, ['hoodie-plaid-skirt', 'hoodie-plaid-skirt-under'], 'auto-pair 用 hoodie-plaid 裙对');
	assert.ok(result.warnings.includes('migrated:auto-pair-bottom'));
	// bottom 品类缺上衣 → 自动补 hoodie-plaid 上衣/袖（毛衣下架后 hoodie 为默认配对）
	const bottomResult = migrateDiyPackOutfits({
		'diy-old-skirt': { name: '旧裙', topBody: [], bottom: ['diy-old-skirt-body'], topUnder: [] },
	}, drawableById, ['diy-old-skirt-body'], { category: 'bottom' });
	const bottomOutfit = bottomResult.outfits['diy-old-skirt'];
	assert.deepEqual(bottomOutfit.topBody, ['hoodie-plaid-torso']);
	assert.equal(bottomOutfit.sleeveUpper.length, 2);
	assert.equal(bottomOutfit.sleeveFore.length, 2);
	assert.ok(bottomResult.warnings.includes('migrated:auto-pair-top'));
});

test('migrateDiyPackOutfits：目标缺失/未知引用安全置空并记 unmapped，不抛错', () => {
	// 目标部件不存在（例如旧 girl rig 或裁剪版）
	const drawableById = { 'hoodie-plaid-torso': { slot: 'topBody' } };
	const result = migrateDiyPackOutfits({
		'diy-broken': {
			name: 'broken',
			topBody: [LEGACY_TOP_REFS[0]], // 旧 v2.1 上衣引用：目标 torso 存在 → 迁移
			bottom: ['bottom-plaid'],       // 目标 skirt 不存在 → unmapped
			sleeve: ['made-up-ref'],        // 未知引用 → unmapped
			topUnder: [],
		},
	}, drawableById, []);
	assert.deepEqual(result.outfits['diy-broken'].topBody, ['hoodie-plaid-torso']);
	assert.deepEqual(result.outfits['diy-broken'].bottom || [], []);
	assert.deepEqual(result.outfits['diy-broken'].sleeve || [], []);
	assert.ok(result.unmapped.some((entry) => entry.includes('bottom-plaid')));
	assert.ok(result.unmapped.some((entry) => entry.includes('made-up-ref')));
});

test('bind_layers.py：pairing 从 v2.2 base rig 动态取（top 配裙、bottom 配上衣；不含 v2.1 id）', () => {
	const probe = spawnSync(PYTHON, ['-c', 'import PIL, numpy, cv2; print("ok")'], { encoding: 'utf8' });
	if (probe.status !== 0) {
		console.log('skip: python3 + Pillow/numpy/cv2 不可用');
		return;
	}
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
		assert.ok(outfit.bottom.length > 0, 'top 分类应对齐 v2.2 裙装（避免光腿）');
		for (const bottomId of outfit.bottom) assert.ok(bottomId.startsWith('hoodie-plaid-skirt'), `top 分类应配对 hoodie-plaid 裙：${bottomId}`);
		assert.equal(pack.pairingSource, 'base-rig:hoodie-plaid');
		// P3：base 骨架从 base rig 动态读取（含骨名/版本），不写死 59
		const baseBoneNames = BASE_RIG.skeleton.bones.map((bone) => bone.id);
		assert.equal(pack.base.skeletonBones, baseBoneNames.length);
		assert.deepEqual(pack.base.boneNames, baseBoneNames);
		assert.equal(pack.base.skeletonVersion, BASE_RIG.version);
		// 不应再出现 v2.1 写死 id（旧键集合以运行时迁移表为准）
		for (const legacyId of LEGACY_KEYS) {
			assert.ok(!refs.includes(legacyId), `不应写死 v2.1 id：${legacyId}`);
		}

		// bottom 分类：配 v2.2 上衣/领/袖
		const layersBottom = join(tmp, 'layers-bottom');
		mkdirSync(layersBottom, { recursive: true });
		const madeBottom = spawnSync(PYTHON, ['-c', script.replace('body.png', 'body.png').replace('sleeve.png', 'unused.png'), layersBottom], { encoding: 'utf8' });
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
		assert.ok(outfitBottom.topBody.length > 0, 'bottom 分类应对齐 v2.2 上衣（避免裸上身）');
		assert.equal(outfitBottom.topBody[0], 'hoodie-plaid-torso');
		assert.ok(outfitBottom.sleeveUpper.length > 0 && outfitBottom.sleeveFore.length > 0);
		assert.equal(packBottom.pairingSource, 'base-rig:hoodie-plaid');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

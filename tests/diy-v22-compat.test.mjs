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
import { migrateDiyPackOutfits } from '../docs/dress-up/runtime-2d5-core.js';

const ROOT = resolve(import.meta.dirname, '..');
const PYTHON = process.env.DSH_FEIYU_PYTHON || 'python3';
const BASE_RIG = JSON.parse(readFileSync(join(dressUpRoot(), 'art/2d5/chibi/rig.json'), 'utf8'));

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
	assert.deepEqual(outfit.bottom, ['sweater-plaid-skirt', 'sweater-plaid-skirt-under'], 'bottom-plaid → v2.2 裙对');
	assert.ok(result.warnings.some((warning) => warning.startsWith('migrated:bottom-plaid')));
	assert.deepEqual(result.unmapped, []);
	// 不修改输入对象
	assert.deepEqual(legacyOutfits['diy-old-top'].bottom, ['bottom-plaid']);
});

test('migrateDiyPackOutfits：旧 bottom pack（sweater-body/sleeve）映射到 v2.2 上衣/袖部件', () => {
	const drawableById = sceneDrawables();
	const result = migrateDiyPackOutfits({
		'diy-old-bottom': {
			name: '旧下装',
			topBody: ['sweater-body'],
			sleeve: ['sweater-sleeve'],
			bottom: ['diy-old-bottom-body'],
			topUnder: [],
		},
	}, drawableById, ['diy-old-bottom-body']);
	const outfit = result.outfits['diy-old-bottom'];
	assert.deepEqual(outfit.topBody, ['sweater-plaid-torso']);
	assert.equal((outfit.sleeve || []).length, 0, "v2.1 sleeve 应迁移到 sleeveUpper/sleeveFore");
	assert.equal(outfit.sleeveUpper.length, 2);
	assert.equal(outfit.sleeveFore.length, 2);
	assert.deepEqual(outfit.bottom, ['diy-old-bottom-body']);
	assert.equal(result.unmapped.length, 0);
});

test('migrateDiyPackOutfits：旧 dress/outfit pack 无 bottom 时按品类自动补 v2.2 裙对（防光腿）', () => {
	const drawableById = sceneDrawables();
	const result = migrateDiyPackOutfits({
		'diy-old-dress': { name: '旧连衣裙', topBody: ['diy-old-dress-body'], sleeve: ['diy-old-dress-sleeve'], bottom: [], topUnder: [] },
	}, drawableById, ['diy-old-dress-body', 'diy-old-dress-sleeve'], { category: 'dress' });
	const outfit = result.outfits['diy-old-dress'];
	assert.deepEqual(outfit.bottom, ['sweater-plaid-skirt', 'sweater-plaid-skirt-under']);
	assert.ok(result.warnings.includes('migrated:auto-pair-bottom'));
	// bottom 品类缺上衣 → 自动补 v2.2 上衣/领/袖
	const bottomResult = migrateDiyPackOutfits({
		'diy-old-skirt': { name: '旧裙', topBody: [], bottom: ['diy-old-skirt-body'], topUnder: [] },
	}, drawableById, ['diy-old-skirt-body'], { category: 'bottom' });
	const bottomOutfit = bottomResult.outfits['diy-old-skirt'];
	assert.deepEqual(bottomOutfit.topBody, ['sweater-plaid-torso']);
	assert.equal(bottomOutfit.sleeveUpper.length, 2);
	assert.equal(bottomOutfit.sleeveFore.length, 2);
	assert.ok(bottomResult.warnings.includes('migrated:auto-pair-top'));
});

test('migrateDiyPackOutfits：目标缺失/未知引用安全置空并记 unmapped，不抛错', () => {
	// 目标部件不存在（例如旧 girl rig 或裁剪版）
	const drawableById = { 'sweater-plaid-torso': { slot: 'topBody' } };
	const result = migrateDiyPackOutfits({
		'diy-broken': {
			name: 'broken',
			topBody: ['sweater-body'],      // 目标 torso 存在 → 迁移
			bottom: ['bottom-plaid'],       // 目标 skirt 不存在 → unmapped
			sleeve: ['made-up-ref'],        // 未知引用 → unmapped
			topUnder: [],
		},
	}, drawableById, []);
	assert.deepEqual(result.outfits['diy-broken'].topBody, ['sweater-plaid-torso']);
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
		for (const bottomId of outfit.bottom) assert.ok(bottomId.startsWith('sweater-plaid-skirt'));
		assert.equal(pack.pairingSource.startsWith('base-rig:'), true, `pairingSource=${pack.pairingSource}`);
		// P3：base 骨架从 base rig 动态读取（含骨名/版本），不写死 59
		const baseBoneNames = BASE_RIG.skeleton.bones.map((bone) => bone.id);
		assert.equal(pack.base.skeletonBones, baseBoneNames.length);
		assert.deepEqual(pack.base.boneNames, baseBoneNames);
		assert.equal(pack.base.skeletonVersion, BASE_RIG.version);
		// 不应再出现 v2.1 写死 id
		for (const legacyId of ['bottom-plaid', 'bottom-pleated', 'sweater-body', 'sweater-sleeve']) {
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
		assert.equal(outfitBottom.topBody[0], 'sweater-plaid-torso');
		assert.ok(outfitBottom.sleeveUpper.length > 0 && outfitBottom.sleeveFore.length > 0);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

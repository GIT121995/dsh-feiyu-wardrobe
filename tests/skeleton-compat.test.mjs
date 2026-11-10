/**
 * P3 Phase 1：骨架版本兼容（前缀骨架）+ collider 端点绑骨。
 * - 旧 59 骨 DIY pack 在 65 骨场景可用（normalize/register/resolveLook/unregister 全链路）；
 * - skeleton mismatch / name mismatch / 骨索引越界仍拒绝；
 * - capsule aBone/bBone 端点绑骨；无绑骨字段时行为不变；sphere 绑骨保留。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateConfig } from '../lib/config.js';
import { createDiyPipeline } from '../lib/diy-pipeline.js';

import {
	normalizeDiyPack,
	registerDiyPack,
	resolveLook,
	unregisterDiyPack,
} from '../docs/dress-up/runtime-2d5-core.js';
import { __colliderHelpers } from '../docs/dress-up/runtime-2d5.js';

const OLD_BONES = 59;
const NEW_BONES = 65;
const OLD_NAMES = Array.from({ length: OLD_BONES }, (_, i) => `bone-${i}`);
const NEW_NAMES = [...OLD_NAMES, 'legBendL', 'legBendR', 'hairBackExtra1', 'hairBackExtra2', 'girlTurnA', 'girlTurnB'];

/** 构造最小 DIY pack（2 drawable：body/sleeve；mesh 三角；权重合法）。 */
function makePack(overrides = {}) {
	const drawable = (id, slot, z) => ({
		id, slot, z, role: slot, texture: `tex/${id}.webp`, texSize: [8, 8], rect: [0, 0, 8, 8],
		mesh: {
			positions: [[0, 0], [10, 0], [0, 10]],
			uvs: [[0, 0], [1, 0], [0, 1]],
			bones: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
			weights: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]],
			deform: [[0, 0], [0, 0], [0, 0]],
			indices: [0, 1, 2],
		},
	});
	const pack = {
		format: 'feiyu-diy-pack', formatVersion: 1, item: 'diy-p3-test-20260101000000',
		name: 'P3 测试', shape: 'chibi', category: 'top',
		base: { rigFormat: 'feiyu-rig', shape: 'chibi', skeletonBones: OLD_BONES },
		drawables: [drawable('diy-p3-test-20260101000000-body', 'topBody', 40), drawable('diy-p3-test-20260101000000-sleeve', 'sleeve', 60)],
		outfits: {
			'diy-p3-test-20260101000000': {
				name: 'P3 测试', topBody: ['diy-p3-test-20260101000000-body'],
				sleeve: ['diy-p3-test-20260101000000-sleeve'], bottom: [], topUnder: [],
			},
		},
	};
	return { ...pack, ...overrides };
}

/** 65 骨场景（含 59 旧骨前缀 + 6 新骨；含 drawable/outfit；用于 register 测试）。 */
function makeScene65() {
	const drawable = (id, slot, z) => ({
		id, slot, z, role: slot, texture: 'atlas.webp', texSize: [8, 8], rect: [0, 0, 8, 8],
		mesh: { positions: [[0, 0]], uvs: [[0, 0]], bones: [[0, 0, 0, 0]], weights: [[1, 0, 0, 0]], deform: [[0, 0]], indices: [] },
		verts: 1, tris: 0,
	});
	return {
		shape: 'chibi',
		skeleton: { bones: NEW_NAMES.map((id) => ({ id })) },
		bones: NEW_NAMES.map((id, index) => ({ id, index })),
		boneIndex: Object.fromEntries(NEW_NAMES.map((id, index) => [id, index])),
		drawables: [drawable('body-torso', 'body', 10), drawable('hoodie-plaid-torso', 'topBody', 40)],
		outfits: { 'hoodie-plaid': { name: '白卫衣', topBody: ['hoodie-plaid-torso'] } },
		drawableById: {},
		diyPacks: new Map(),
		diyDrawables: [],
	};
}

test('骨架前缀兼容：旧 59 骨 pack 在 65 骨场景通过 normalize（legacy 标记）', () => {
	const pack = makePack();
	const normalized = normalizeDiyPack(pack, { bones: NEW_BONES, boneNames: NEW_NAMES, shape: 'chibi' });
	assert.equal(normalized.ok, true, normalized.errors.join(','));
	assert.equal(normalized.packBones, OLD_BONES);
	assert.equal(normalized.sceneBones, NEW_BONES);
	assert.equal(normalized.legacyBones, true);
	// 同 pack 在 59 骨场景不是 legacy
	const same = normalizeDiyPack(pack, { bones: OLD_BONES, boneNames: OLD_NAMES, shape: 'chibi' });
	assert.equal(same.ok, true);
	assert.equal(same.legacyBones, false);
});

test('骨架校验：超出场景骨数/缺失/骨名不匹配/索引越界仍拒绝', () => {
	const tooMany = normalizeDiyPack(makePack({ base: { skeletonBones: NEW_BONES + 1 } }), { bones: NEW_BONES, boneNames: NEW_NAMES });
	assert.equal(tooMany.ok, false);
	assert.ok(tooMany.errors.includes('skeleton_mismatch'));
	const missing = normalizeDiyPack(makePack({ base: { skeletonBones: 0 } }), { bones: NEW_BONES, boneNames: NEW_NAMES });
	assert.equal(missing.ok, false);
	assert.ok(missing.errors.includes('skeleton_mismatch'));
	const wrongNames = normalizeDiyPack(makePack({ base: { skeletonBones: OLD_BONES, boneNames: ['wrong', ...OLD_NAMES.slice(1)] } }), { bones: NEW_BONES, boneNames: NEW_NAMES });
	assert.equal(wrongNames.ok, false);
	assert.ok(wrongNames.errors.includes('skeleton_name_mismatch'));
	const namesLen = normalizeDiyPack(makePack({ base: { skeletonBones: OLD_BONES, boneNames: ['bone-0'] } }), { bones: NEW_BONES, boneNames: NEW_NAMES });
	assert.equal(namesLen.ok, false);
	assert.ok(namesLen.errors.includes('skeleton_names_invalid'));
	// pack 声明 59 骨却用索引 60 → 越界（即使场景有 65 骨）
	const badPack = makePack();
	badPack.drawables[0].mesh.bones[0] = [OLD_BONES, 0, 0, 0];
	const badIndex = normalizeDiyPack(badPack, { bones: NEW_BONES, boneNames: NEW_NAMES });
	assert.equal(badIndex.ok, false);
	assert.ok(badIndex.errors.includes('bone_out_of_range:diy-p3-test-20260101000000-body'));
});

test('旧 59 骨 pack 在 65 骨场景：register → resolveLook 选中 → unregister 清理', () => {
	const scene = makeScene65();
	scene.drawableById = Object.fromEntries(scene.drawables.map((drawable) => [drawable.id, drawable]));
	const normalized = normalizeDiyPack(makePack(), { bones: NEW_BONES, boneNames: NEW_NAMES, shape: 'chibi' });
	assert.equal(normalized.ok, true, normalized.errors.join(','));
	const registered = registerDiyPack(scene, 'diy-p3-test-20260101000000', normalized);
	assert.equal(registered.ok, true);
	assert.equal(scene.diyPacks.has('diy-p3-test-20260101000000'), true);
	// 选中 pack outfit（复用 resolveLook 的 outfit 分支；Diy 自带 drawable 不依赖 base 骨数）
	const look = resolveLook(scene, { outfit: 'diy-p3-test-20260101000000' });
	assert.deepEqual(look.slots.topBody, ['diy-p3-test-20260101000000-body']);
	assert.deepEqual(look.slots.sleeve, ['diy-p3-test-20260101000000-sleeve']);
	assert.equal(look.outfit, 'diy-p3-test-20260101000000');
	// 移除后无残留
	const removed = unregisterDiyPack(scene, 'diy-p3-test-20260101000000');
	assert.equal(removed.ok, true);
	assert.equal(scene.diyPacks.has('diy-p3-test-20260101000000'), false);
	assert.equal(scene.drawables.some((drawable) => drawable.id.startsWith('diy-p3-test')), false);
	assert.equal(scene.outfits['diy-p3-test-20260101000000'], undefined);
});

test('collider：capsule aBone/bBone 端点绑骨（含 offset），无绑骨行为不变，sphere 绑骨保留', () => {
	const helpers = __colliderHelpers;
	const scene = {
		bones: [{ id: 'root', base: [100, 200], index: 0 }, { id: 'legL', base: [120, 300], index: 1 }, { id: 'legR', base: [180, 300], index: 2 }],
		boneIndex: { root: 0, legL: 1, legR: 2 },
		colliders: [
			{ id: 'legs', type: 'capsule', aBone: 'legL', bBone: 'legR', aOffset: [0, 10], bOffset: [0, 20], radius: 30 },
			{ id: 'plain', type: 'capsule', a: [0, 0], b: [0, 100], radius: 20 },
			{ id: 'head', type: 'sphere', bone: 'root', offset: [0, -50], radius: 80 },
			{ id: 'abs', type: 'sphere', center: [50, 60], radius: 10 },
		],
	};
	// bind 期端点 = 骨 base + offset
	assert.deepEqual(helpers.colliderEndpointBind(scene, scene.colliders[0], 'a'), [120, 310]);
	assert.deepEqual(helpers.colliderEndpointBind(scene, scene.colliders[0], 'b'), [180, 320]);
	assert.equal(helpers.colliderBindDistance(scene, scene.colliders[0], 120, 310), 0);
	// 无绑骨的 capsule 使用绝对 a/b（与旧行为一致）
	assert.deepEqual(helpers.colliderEndpointBind(scene, scene.colliders[1], 'a'), [0, 0]);
	assert.equal(helpers.colliderBindDistance(scene, scene.colliders[1], 30, 50), 30);
	const point = helpers.colliderClosest(scene.colliders[1], 30, 50);
	assert.deepEqual(point, [0, 50]);
	// sphere 绑骨/绝对中心保留
	assert.deepEqual(helpers.bindColliderCenter(scene, scene.colliders[2]), [100, 150]);
	assert.deepEqual(helpers.bindColliderCenter(scene, scene.colliders[3]), [50, 60]);

	// 运行期：矩阵跟随骨运动（平移 matrix），capsule 端点世界坐标更新
	const rt = {
		scene,
		M: [
			{ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
			{ a: 1, b: 0, c: 0, d: 1, tx: 5, ty: 7 },
			{ a: 1, b: 0, c: 0, d: 1, tx: -5, ty: 7 },
		],
	};
	helpers.updateColliderWorld(rt);
	// 世界端点 = 骨矩阵 × 局部 offset（合成矩阵仅平移；若真机矩阵含旋转/缩放会一并生效）
	assert.deepEqual(scene.colliders[0].wa, [5, 17]);
	assert.deepEqual(scene.colliders[0].wb, [-5, 27]);
	assert.deepEqual(helpers.colliderClosest(scene.colliders[0], 5, 17), [5, 17]);
	// 无绑骨 capsule / sphere 不受影响
	assert.deepEqual(scene.colliders[1].wa, [0, 0]);
	assert.deepEqual(scene.colliders[1].wb, [0, 100]);
	assert.equal(scene.colliders[2].wx, 0);
	assert.equal(scene.colliders[2].wy, -50);
	assert.equal(scene.colliders[3].wx, 50);
});


/* ---------------- pipeline：骨架从 base rig 动态读取（不再写死 59） ---------------- */

function makePipelineFixture(baseBones) {
	const tmp = mkdtempSync(join(tmpdir(), 'feiyu-p3-skeleton-'));
	const repoRoot = join(tmp, 'repo');
	const rigDir = join(repoRoot, 'docs', 'dress-up', 'art', '2d5', 'chibi');
	mkdirSync(rigDir, { recursive: true });
	const names = Array.from({ length: baseBones }, (_, i) => `bone-${i}`);
	writeFileSync(join(rigDir, 'rig.json'), JSON.stringify({ format: 'feiyu-rig', version: 3, skeleton: { bones: names.map((id) => ({ id })) } }));
	const statePath = join(tmp, 'state.json');
	const config = validateConfig({ statePath });
	const pipeline = createDiyPipeline({ config, home: join(tmp, 'diy'), repoRoot, now: () => 1_760_000_000_000 });
	const jobId = 'diy-p3-qa-20260101000000';
	const jobDir = join(join(tmp, 'diy'), 'jobs', jobId);
	mkdirSync(join(jobDir, 'layers'), { recursive: true });
	mkdirSync(join(jobDir, 'pack', 'tex'), { recursive: true });
	writeFileSync(join(jobDir, 'layers', 'split.json'), JSON.stringify({ ok: true, grade: 'pass', qa: {} }));
	writeFileSync(join(jobDir, 'pack', 'bind-report.json'), JSON.stringify({ coverage: { alphaCovered: 0.99, coverageIoU: 0.9, alphaAreaFrac: 0.1 } }));
	const pack = makePack();
	for (const drawable of pack.drawables) {
		const file = join(jobDir, 'pack', drawable.texture);
		writeFileSync(file, Buffer.alloc(600, 1));
	}
	writeFileSync(join(jobDir, 'pack', 'diy-pack.json'), JSON.stringify(pack));
	const job = {
		id: jobId, itemId: jobId, createdAt: '2026-01-01T00:00:00.000Z',
		input: { name: 'P3 QA', category: 'top', shape: 'chibi' },
		stages: { generate: { data: { images: 2, costYuan: 0.6 } } },
	};
	return { tmp, pipeline, job };
}

test('pipeline qa：base rig 骨架动态读取（65 骨下旧 59 骨 pack 通过并标 legacy；58 骨 base 拒绝）', () => {
	const fixture = makePipelineFixture(NEW_BONES);
	try {
		const result = fixture.pipeline.stages.qa(fixture.job);
		assert.equal(result.pass, true, JSON.stringify(result.checks));
		assert.deepEqual(result.skeleton, { packBones: OLD_BONES, baseBones: NEW_BONES, legacy: true });
		const baseCheck = result.checks.find((check) => check.name === 'base_skeleton');
		assert.equal(baseCheck.ok, true);
		assert.equal(baseCheck.value.legacy, true);
		// 安装到 registry：skeleton 元数据落盘
		const install = fixture.pipeline.stages.install(fixture.job);
		assert.equal(install.ok, true);
		const registry = JSON.parse(readFileSync(join(join(fixture.tmp, 'diy'), 'registry.json'), 'utf8'));
		assert.deepEqual(registry.items[fixture.job.id].skeleton, { packBones: OLD_BONES, baseBones: NEW_BONES, legacy: true });
	} finally {
		rmSync(fixture.tmp, { recursive: true, force: true });
	}
	// 新 pipeline 指向 58 骨 base → 59 骨 pack 超出，QA fail（不写死 59，也不放宽非法骨架）
	const shortBase = makePipelineFixture(OLD_BONES - 1);
	try {
		const result = shortBase.pipeline.stages.qa(shortBase.job);
		assert.equal(result.pass, false);
		assert.deepEqual(result.skeleton, { packBones: OLD_BONES, baseBones: OLD_BONES - 1, legacy: false });
		const baseCheck = result.checks.find((check) => check.name === 'base_skeleton');
		assert.equal(baseCheck.ok, false);
	} finally {
		rmSync(shortBase.tmp, { recursive: true, force: true });
	}
});

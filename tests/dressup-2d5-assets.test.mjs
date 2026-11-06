import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { dressUpRoot } from '../lib/webserver.js';
import { estimateTextureMemory, normalizeAtlases, resolveDrawableAtlas } from '../docs/dress-up/runtime-2d5-core.js';

const ROOT = dressUpRoot();
const ASSET_ROOT = join(ROOT, 'art/2d5');
const SHAPES = ['chibi', 'girl'];
const MAX_BONES = 80;   // v2.4：65 骨 rig（59+6 legBones）；runtime shader 上限提到 80
/** cutout production 资产：chibi 85 / girl 86 drawables（单页图集；v2.5 girl 新增 hair-arm-girl）。 */
const EXPECTED_DRAWABLES = { chibi: 85, girl: 86 };
/** 旧四个 + cutout 新服装槽位（outfit 引用校验）。 */
const OUTFIT_SLOTS = ['topUnder', 'bottom', 'topBody', 'sleeve', 'sleeveUpper', 'sleeveFore', 'collar'];

/** 读 WebP 尺寸（VP8X / VP8L / VP8 三种头）。 */
function webpSize(file) {
	const bytes = readFileSync(file);
	assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF', `${file} 不是 RIFF`);
	assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP', `${file} 不是 WEBP`);
	const chunk = bytes.subarray(12, 16).toString('latin1');
	if (chunk === 'VP8X') {
		const width = 1 + bytes.readUIntLE(24, 3);
		const height = 1 + bytes.readUIntLE(27, 3);
		return { width, height };
	}
	if (chunk === 'VP8 ') {
		const width = bytes.readUInt16LE(26) & 0x3fff;
		const height = bytes.readUInt16LE(28) & 0x3fff;
		return { width, height };
	}
	assert.equal(chunk, 'VP8L', `未知 WebP 头 ${chunk}`);
	const bits = bytes.readUInt32LE(21);
	const width = 1 + (bits & 0x3fff);
	const height = 1 + ((bits >> 14) & 0x3fff);
	return { width, height };
}

/** @returns {any} */
function loadRig(shape) {
	const file = join(ASSET_ROOT, shape, 'rig.json');
	assert.ok(existsSync(file), `缺少 ${shape}/rig.json（先跑 npm run build:assets）`);
	return JSON.parse(readFileSync(file, 'utf8'));
}

/** 浮点小数位不超过 n 位（JSON 序列化后的十进制位数）。 */
function decimals(value) {
	const text = String(value);
	if (text.includes('e') || text.includes('E')) return 0;
	const dot = text.indexOf('.');
	return dot < 0 ? 0 : text.length - dot - 1;
}

/** 递归遍历目录下文件（相对 ASSET_ROOT）。 */
function walkAssets() {
	/** @type {string[]} */
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.push(full);
		}
	};
	walk(ASSET_ROOT);
	return files;
}

test('2.5D 资产全集：两身形 rig + 图集 + 构建报告（缺失时先跑 npm run build:assets）', () => {
	for (const shape of SHAPES) {
		for (const name of ['rig.json', 'atlas.webp', 'build-report.json']) {
			const file = join(ASSET_ROOT, shape, name);
			assert.ok(existsSync(file), `缺少 art/2d5/${shape}/${name}`);
			assert.ok(statSync(file).size > 1024, `art/2d5/${shape}/${name} 体积异常`);
		}
	}
	assert.ok(existsSync(join(ROOT, '..', '..', 'tools', 'art', 'build_2d5.py')), '仓库应带资产构建脚本 tools/art/build_2d5.py');
});

test('2.5D rig：图集元数据与实际 WebP 尺寸一致、UV 重映射到图集空间', () => {
	for (const shape of SHAPES) {
		const rig = loadRig(shape);
		assert.ok(rig.atlas, `${shape} 缺少 atlas 元数据`);
		assert.equal(rig.atlas.file, 'atlas.webp');
		assert.equal(rig.atlas.format, 'webp-lossless-rgba');
		assert.ok(rig.atlas.padding >= 1 && rig.atlas.padding <= 8, 'padding 应在 1–8px');
		const size = webpSize(join(ASSET_ROOT, shape, 'atlas.webp'));
		assert.equal(rig.atlas.width, size.width, `${shape} 图集宽与 rig 元数据不一致`);
		assert.equal(rig.atlas.height, size.height, `${shape} 图集高与 rig 元数据不一致`);
		assert.ok(rig.atlas.width <= 4096 && rig.atlas.height <= 4096, '单页图集尺寸不应超出 4096');
		const report = JSON.parse(readFileSync(join(ASSET_ROOT, shape, 'build-report.json'), 'utf8'));
		assert.equal(report.atlas.width, rig.atlas.width);
		assert.equal(report.atlas.height, rig.atlas.height);
		assert.equal(report.atlas.pixelEqual, true, '图集回读应逐像素一致（lossless）');
		assert.equal(report.drawables.length, rig.drawables.length);
	}
});

test('2.5D rig：drawable/mesh 数据完整（顶点/UV/权重/索引/图集矩形）', () => {
	for (const shape of SHAPES) {
		const rig = loadRig(shape);
		const boneCount = rig.skeleton.bones.length;
		assert.equal(boneCount, 65, `${shape} v2.4 应为 65 骨（59 前缀 + 6 legBones）`);
		assert.ok(boneCount <= MAX_BONES, `${shape} 骨数 ${boneCount} 超出 shader 上限 ${MAX_BONES}`);
		// v2.4 legBones：追加 6 骨、原 59 骨索引不变（DIY 前缀兼容前提）
		const boneIds = rig.skeleton.bones.map((bone) => bone.id);
		for (const id of ['thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR']) assert.ok(boneIds.includes(id), `${shape} 缺少腿骨 ${id}`);
		// collider 跟骨元数据：capsule aBone/bBone + aLocal/bLocal（与 m2-rig P3 对齐）
		const legColliders = (rig.colliders || []).filter((collider) => collider.type === 'capsule' && collider.aBone && collider.bBone);
		assert.ok(legColliders.length >= 2, `${shape} 应有腿部 capsule aBone/bBone 绑骨`);
		for (const collider of legColliders) {
			assert.ok(boneIds.includes(collider.aBone) && boneIds.includes(collider.bBone), `${shape}/${collider.id} 绑骨不存在`);
			assert.equal(collider.aLocal.length, 2);
			assert.equal(collider.bLocal.length, 2);
		}
		if (shape === 'girl') {
			const hairBack = rig.drawables.find((drawable) => drawable.id === 'hair-back-girl');
			assert.ok(hairBack, 'girl 缺少 hair-back-girl');
			assert.equal(hairBack.slot, 'hairBack');
			assert.ok(rig.slots.hairBack.includes('hair-back-girl'));
			// v2.5 全量拆发：手臂上的发丝独立成层（slot strands、z=66 在 hand z=65 之上、hairFront z=70 之下）
			const hairArm = rig.drawables.find((drawable) => drawable.id === 'hair-arm-girl');
			assert.ok(hairArm, 'girl 缺少 hair-arm-girl（v2.5 全量拆发）');
			assert.equal(hairArm.slot, 'strands');
			assert.equal(hairArm.z, 66);
			assert.equal(hairArm.role, 'strand');
			assert.ok(rig.slots.strands.includes('hair-arm-girl'), 'girl slots.strands 应包含 hair-arm-girl');
			assert.deepEqual(hairArm.texSize, [hairArm.atlasRect[2], hairArm.atlasRect[3]], 'hair-arm-girl texSize 应与裁剪尺寸一致');
		}
		assert.equal(rig.drawables.length, EXPECTED_DRAWABLES[shape], `${shape} drawable 数量应为 ${EXPECTED_DRAWABLES[shape]}`);
		assert.ok(rig.slots.body && rig.slots.legs && rig.slots.armUpper && rig.slots.armFore && rig.slots.hand,
			`${shape} 缺少 cutout 身体部件槽位`);
		const atlasW = rig.atlas.width;
		const atlasH = rig.atlas.height;
		let totalVerts = 0;
		for (const drawable of rig.drawables) {
			const label = `${shape}/${drawable.id}`;
			assert.equal(typeof drawable.id, 'string', `${label} 缺 id`);
			assert.equal(drawable.texture, 'atlas.webp', `${label} 应引用图集`);
			assert.ok(!('source' in drawable), `${label} 不应保留 POC source 字段`);
			const mesh = drawable.mesh;
			assert.ok(Array.isArray(mesh.positions) && mesh.positions.length > 0, `${label} 缺顶点`);
			assert.ok(!('cell' in mesh) && !('grid' in mesh), `${label} 不应保留 POC cell/grid 字段`);
			const n = mesh.positions.length;
			assert.equal(mesh.uvs.length, n, `${label} uvs 长度`);
			assert.equal(mesh.bones.length, n, `${label} bones 长度`);
			assert.equal(mesh.weights.length, n, `${label} weights 长度`);
			assert.equal(mesh.deform.length, n, `${label} deform 长度`);
			assert.equal(mesh.indices.length % 3, 0, `${label} 索引数应为 3 的倍数`);
			totalVerts += n;
			const [ax, ay, tw, th] = drawable.atlasRect;
			assert.ok(tw > 0 && th > 0, `${label} atlasRect 尺寸非法`);
			assert.ok(ax >= 0 && ay >= 0 && ax + tw <= atlasW && ay + th <= atlasH, `${label} atlasRect 越界`);
			assert.deepEqual(drawable.texSize, [tw, th], `${label} texSize 应与 atlasRect 尺寸一致`);
			// 抽验顶点（全量过重，每 drawable 抽样 64 个）：UV 落在图集矩形内、精度合规
			const step = Math.max(1, Math.floor(n / 64));
			for (let i = 0; i < n; i += step) {
				const [u, v] = mesh.uvs[i];
				assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1, `${label} uv 越界 (${u},${v})`);
				const px = u * atlasW;
				const py = v * atlasH;
				assert.ok(px >= ax - 0.51 && px <= ax + tw + 0.51, `${label} uv x 不在图集矩形内`);
				assert.ok(py >= ay - 0.51 && py <= ay + th + 0.51, `${label} uv y 不在图集矩形内`);
				assert.ok(decimals(mesh.uvs[i][0]) <= 5 && decimals(mesh.uvs[i][1]) <= 5, `${label} uv 精度应 ≤5 位`);
				assert.ok(decimals(mesh.positions[i][0]) <= 2 && decimals(mesh.positions[i][1]) <= 2, `${label} position 精度应 ≤2 位`);
				const weights = mesh.weights[i];
				assert.equal(weights.length, 4, `${label} 每顶点 4 权重`);
				const sum = weights.reduce((acc, weight) => acc + weight, 0);
				assert.ok(Math.abs(sum - 1) <= 0.01, `${label} 权重和应≈1（实际 ${sum}）`);
				for (let k = 0; k < 4; k += 1) {
					const bone = mesh.bones[i][k];
					assert.ok(Number.isInteger(bone) && bone >= 0 && bone < boneCount, `${label} 骨索引越界 ${bone}`);
					assert.ok(weights[k] >= 0 && weights[k] <= 1, `${label} 权重越界`);
				}
				const index = mesh.indices[i];
				assert.ok(index >= 0 && index < n, `${label} 索引越界 ${index}`);
			}
		}
		assert.ok(totalVerts > 5000, `${shape} 顶点总数异常：${totalVerts}`);
	}
});

test('2.5D rig：骨架/物理链/碰撞体/槽位引用闭合', () => {
	for (const shape of SHAPES) {
		const rig = loadRig(shape);
		const boneIds = new Set(rig.skeleton.bones.map((bone) => bone.id));
		assert.equal(boneIds.size, rig.skeleton.bones.length, `${shape} 骨 id 不应重复`);
		for (const bone of rig.skeleton.bones) {
			if (bone.parent) assert.ok(boneIds.has(bone.parent), `${shape} 骨 ${bone.id} 父骨缺失 ${bone.parent}`);
			assert.equal(bone.base.length, 2);
		}
		const drawableIds = new Set(rig.drawables.map((drawable) => drawable.id));
		for (const chain of rig.physics) {
			assert.ok(boneIds.has(chain.parent), `${shape} 链 ${chain.id} parent 缺失`);
			for (const boneId of chain.chain) assert.ok(boneIds.has(boneId), `${shape} 链 ${chain.id} 引用缺失骨 ${boneId}`);
			assert.ok(chain.nodes.length === chain.chain.length + 1, `${shape} 链 ${chain.id} 节点数应=骨数+1`);
		}
		for (const collider of rig.colliders || []) {
			if (collider.bone) assert.ok(boneIds.has(collider.bone), `${shape} 碰撞体 ${collider.id} 骨缺失`);
			for (const kind of collider.affects || []) assert.ok(['hair', 'skirt', 'tail'].includes(kind), `${shape} 碰撞体影响类型非法 ${kind}`);
		}
		for (const [outfitId, outfit] of Object.entries(rig.outfits)) {
			for (const slot of OUTFIT_SLOTS) {
				for (const id of outfit[slot] || []) {
					assert.ok(drawableIds.has(id), `${shape} 套装 ${outfitId}.${slot} 引用缺失 drawable ${id}`);
				}
			}
		}
		const face = rig.slots.face;
		assert.equal(face.mode, 'parts', `${shape} face 应为 parts 模式`);
		assert.ok(face.brow.every((id) => drawableIds.has(id)));
		for (const eye of ['open', 'half', 'closed', 'smile']) {
			assert.ok(Array.isArray(face.eye[eye]) && face.eye[eye].length > 0, `${shape} face.eye.${eye} 缺失`);
			for (const id of face.eye[eye]) assert.ok(drawableIds.has(id));
		}
		for (const mouth of ['closed', 'small', 'mid', 'open']) {
			assert.ok(Array.isArray(face.mouth[mouth]) && face.mouth[mouth].length > 0, `${shape} face.mouth.${mouth} 缺失`);
		}
		// 默认套装必须存在且四个 deformers 齐全
		assert.ok(rig.outfits[rig.defaults.outfit], `${shape} 默认套装缺失`);
		const deformers = new Set(rig.deformers.map((deformer) => deformer.id));
		for (const id of ['headYawWarp', 'headPitchWarp', 'breathChest']) assert.ok(deformers.has(id), `${shape} deformer ${id} 缺失`);
		assert.deepEqual([rig.canvas.width, rig.canvas.height], [675, 1200]);
	}
});

test('2.5D 资产体积预算：单身形 ≤3MB、双身形合计 ≤6MB、rig gzip ≤400KB、包体 ≤15MB', () => {
	let total = 0;
	for (const shape of SHAPES) {
		const rigBytes = readFileSync(join(ASSET_ROOT, shape, 'rig.json'));
		const atlasBytes = readFileSync(join(ASSET_ROOT, shape, 'atlas.webp'));
		const shapeTotal = rigBytes.byteLength + atlasBytes.byteLength + statSync(join(ASSET_ROOT, shape, 'build-report.json')).size;
		total += shapeTotal;
		assert.ok(shapeTotal <= 4.5 * 1024 * 1024, `${shape} 资产 ${(shapeTotal / 1048576).toFixed(2)}MB 超出单身形预算`);
		const gzip = gzipSync(rigBytes, { level: 9 });
		assert.ok(gzip.byteLength <= 400 * 1024, `${shape} rig gzip ${(gzip.byteLength / 1024).toFixed(0)}KB 超出预算`);
	}
	assert.ok(total <= 9 * 1024 * 1024, `2.5D 资产合计 ${(total / 1048576).toFixed(2)}MB 超出预算`);
	// 首屏 payload（单身形，gzip rig + 图集）：应 ≤2MB 传输
	const chibiRig = readFileSync(join(ASSET_ROOT, 'chibi/rig.json'));
	const firstScreen = gzipSync(chibiRig, { level: 9 }).byteLength + statSync(join(ASSET_ROOT, 'chibi/atlas.webp')).size;
	assert.ok(firstScreen <= 3 * 1024 * 1024, `2.5D 首屏 payload ${(firstScreen / 1048576).toFixed(2)}MB 超出 3MB`);
});

test('2.5D 资产无绝对路径/无构建机依赖（可移植到 npm 包）', () => {
	for (const shape of SHAPES) {
		const text = readFileSync(join(ASSET_ROOT, shape, 'rig.json'), 'utf8');
		assert.ok(!text.includes('/home/ubuntu'), 'rig 不应含构建机绝对路径');
		assert.ok(!text.includes('.scratch'), 'rig 不应引用 .scratch 源路径');
		for (const file of walkAssets()) {
			assert.ok(!file.includes('/.scratch/'), '资产目录不应含 .scratch 文件');
		}
	}
});


test('2.5D 资产：单页图集 legacy 契约（runtime normalizeAtlases 可消费）+ 多图集字段向前兼容', () => {
	for (const shape of SHAPES) {
		const rig = loadRig(shape);
		const normalized = normalizeAtlases(rig);
		assert.equal(normalized.ok, true, `${shape} 图集配置非法：${normalized.errors.join(',')}`);
		if (!rig.atlases) {
			assert.equal(normalized.legacy, true, `${shape} 单页图集应走 legacy 模式`);
			assert.equal(normalized.atlases.length, 1);
			assert.equal(normalized.atlases[0].file, 'atlas.webp');
			for (const drawable of rig.drawables) {
				assert.equal(drawable.texture, 'atlas.webp', `${shape}/${drawable.id} 应引用 atlas.webp`);
				assert.equal(resolveDrawableAtlas(drawable, normalized.atlases), 0);
			}
		} else {
			assert.equal(normalized.legacy, false);
			assert.ok(normalized.atlases.length >= 1 && normalized.atlases.length <= 2);
			const ids = new Set(normalized.atlases.map((atlas) => atlas.id));
			for (const drawable of rig.drawables) {
				assert.ok(ids.has(drawable.atlas), `${shape}/${drawable.id} atlas=${drawable.atlas} 未声明`);
				const index = resolveDrawableAtlas(drawable, normalized.atlases);
				assert.equal(normalized.atlases[index].file, drawable.texture);
			}
		}
	}
});

test('2.5D 资产：显存估算与构建报告一致（含 mipmap）且 ≤40MiB/身形', () => {
	for (const shape of SHAPES) {
		const rig = loadRig(shape);
		const report = JSON.parse(readFileSync(join(ASSET_ROOT, shape, 'build-report.json'), 'utf8'));
		const normalized = normalizeAtlases(rig);
		const memory = estimateTextureMemory(
			normalized.atlases.map((atlas) => ({ width: atlas.width, height: atlas.height })),
			true,
		);
		assert.equal(memory.texMiB, report.textureTotal.texMiB, `${shape} texMiB 与构建报告不一致`);
		assert.equal(memory.texMiBwithMipmap, report.textureTotal.texMiBwithMipmap, `${shape} mipmap texMiB 不一致`);
		assert.ok(memory.texMiBwithMipmap <= 40, `${shape} mipmap 显存 ${memory.texMiBwithMipmap}MiB 超出 40MiB`);
		assert.equal(report.atlas.pixelEqual, true, `${shape} pixelEqual 应为 true`);
	}
});

/* ---------------- v2.6.1 hi tier（2x 高 DPI，两页图集） ---------------- */

test('v2.6.1 hi tier：2 页图集可被 runtime 契约消费（normalize/resolve/尺寸/显存与报告一致）', (t) => {
	const hiShapes = SHAPES.filter((shape) => existsSync(join(ASSET_ROOT, `${shape}-hi`, 'rig.json')));
	if (hiShapes.length === 0) return t.skip('hi tier 产物未生成（先跑 npm run build:assets:hi）');
	for (const shape of hiShapes) {
		const dir = join(ASSET_ROOT, `${shape}-hi`);
		const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8'));
		const report = JSON.parse(readFileSync(join(dir, 'build-report.json'), 'utf8'));
		// 1) 多图集契约：2 页、非 legacy、每页 ≤4096 且 WebP 实际尺寸与 rig 元数据一致
		const normalized = normalizeAtlases(rig);
		assert.equal(normalized.ok, true, `${shape}-hi 图集配置非法：${normalized.errors.join(',')}`);
		assert.equal(normalized.legacy, false, `${shape}-hi 应走多图集（非 legacy）`);
		assert.equal(normalized.atlases.length, 2, `${shape}-hi 应为 2 页图集`);
		assert.deepEqual(normalized.atlases.map((atlas) => atlas.file), ['atlas.webp', 'atlas-2.webp']);
		assert.equal(report.pages, 2, `${shape}-hi 构建报告页数应为 2`);
		assert.equal(report.atlases.length, 2);
		for (const atlas of normalized.atlases) {
			const size = webpSize(join(dir, atlas.file));
			assert.equal(atlas.width, size.width, `${shape}-hi/${atlas.file} 宽与 rig 元数据不一致`);
			assert.equal(atlas.height, size.height, `${shape}-hi/${atlas.file} 高与 rig 元数据不一致`);
			assert.ok(atlas.width <= 4096 && atlas.height <= 4096, `${shape}-hi/${atlas.file} 超出 4096：${atlas.width}x${atlas.height}`);
		}
		// 2) 每 drawable 的 atlas 页可解析，且纹理文件名与页一致；几何/mesh/rect 与 lo 完全一致
		const loRig = loadRig(shape);
		const loById = Object.fromEntries(loRig.drawables.map((drawable) => [drawable.id, drawable]));
		const pageIds = new Set(normalized.atlases.map((atlas) => atlas.id));
		let twoXCount = 0;
		let pageUse = { hi: 0, lo: 0 };
		for (const drawable of rig.drawables) {
			const label = `${shape}-hi/${drawable.id}`;
			assert.ok(pageIds.has(drawable.atlas), `${label} atlas=${drawable.atlas} 未在 rig.atlases 声明`);
			const index = resolveDrawableAtlas(drawable, normalized.atlases);
			assert.equal(normalized.atlases[index].file, drawable.texture, `${label} texture 与 atlas 页不一致`);
			pageUse[drawable.atlas] = (pageUse[drawable.atlas] || 0) + 1;
			const lo = loById[drawable.id];
			assert.ok(lo, `${label} 为 lo 不存在的 drawable`);
			assert.deepEqual(drawable.rect, lo.rect, `${label} rect 应保持 1x 画布坐标`);
			// 几何/骨权重/索引与 lo 完全一致；uvs 是图集空间坐标（hi 页更大，必然不同，长度一致即可）
			for (const key of ['positions', 'bones', 'weights', 'deform', 'indices']) {
				assert.deepEqual(drawable.mesh[key], lo.mesh[key], `${label} mesh.${key} 应与 lo 完全一致`);
			}
			assert.equal(drawable.mesh.uvs.length, lo.mesh.uvs.length, `${label} mesh.uvs 顶点数应与 lo 一致`);
			assert.deepEqual(drawable.texSize, [drawable.atlasRect[2], drawable.atlasRect[3]], `${label} texSize 应与 atlasRect 一致`);
			if (drawable.texSize[0] > lo.texSize[0] * 1.5) twoXCount += 1;
		}
		assert.ok(twoXCount >= 20, `${shape}-hi 2x drawable 过少：${twoXCount}`);
		assert.ok((pageUse.hi || 0) > 0 && (pageUse.lo || 0) > 0, `${shape}-hi 两页都应被引用：${JSON.stringify(pageUse)}`);
		// 3) 显存估算与构建报告一致（2x 页占大头，仍在预算内）
		const memory = estimateTextureMemory(normalized.atlases.map((atlas) => ({ width: atlas.width, height: atlas.height })), false);
		assert.equal(memory.texMiB, report.textureTotal.texMiB, `${shape}-hi texMiB 与构建报告不一致`);
		assert.ok(memory.texMiB > 40 && memory.texMiB <= 96, `${shape}-hi texMiB 应明显高于 lo 且在预算内：${memory.texMiB}`);
	}
});

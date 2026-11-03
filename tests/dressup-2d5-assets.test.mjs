import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { dressUpRoot } from '../lib/webserver.js';

const ROOT = dressUpRoot();
const ASSET_ROOT = join(ROOT, 'art/2d5');
const SHAPES = ['chibi', 'girl'];
const MAX_BONES = 64;

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
	assert.ok(existsSync(file), `缺少 ${shape}/rig.json（先跑 tools/build_2d5.py）`);
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

test('2.5D 资产全集：两身形 rig + 图集 + 构建报告（缺失时先跑 tools/build_2d5.py）', () => {
	for (const shape of SHAPES) {
		for (const name of ['rig.json', 'atlas.webp', 'build-report.json']) {
			const file = join(ASSET_ROOT, shape, name);
			assert.ok(existsSync(file), `缺少 art/2d5/${shape}/${name}`);
			assert.ok(statSync(file).size > 1024, `art/2d5/${shape}/${name} 体积异常`);
		}
	}
	assert.ok(existsSync(join(ROOT, '..', '..', 'tools', 'build_2d5.py')), '仓库应带资产构建脚本 tools/build_2d5.py');
});

test('2.5D rig：图集元数据与实际 WebP 尺寸一致、UV 重映射到图集空间', () => {
	for (const shape of SHAPES) {
		const rig = loadRig(shape);
		assert.ok(rig.atlas, `${shape} 缺少 atlas 元数据`);
		assert.equal(rig.atlas.file, 'atlas.webp');
		assert.equal(rig.atlas.format, 'webp-lossless-rgba');
		assert.ok(rig.atlas.padding >= 2 && rig.atlas.padding <= 8, 'padding 应在 2–8px');
		const size = webpSize(join(ASSET_ROOT, shape, 'atlas.webp'));
		assert.equal(rig.atlas.width, size.width, `${shape} 图集宽与 rig 元数据不一致`);
		assert.equal(rig.atlas.height, size.height, `${shape} 图集高与 rig 元数据不一致`);
		assert.ok(rig.atlas.width <= 2048 && rig.atlas.height <= 4096, '图集尺寸不应超出 GL 最低上限');
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
		assert.ok(boneCount > 0 && boneCount <= MAX_BONES, `${shape} 骨数 ${boneCount} 超出 shader 上限 ${MAX_BONES}`);
		assert.ok(rig.drawables.length >= 30, `${shape} drawable 数量异常：${rig.drawables.length}`);
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
			for (const slot of ['topUnder', 'bottom', 'topBody', 'sleeve']) {
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
		assert.ok(shapeTotal <= 3.2 * 1024 * 1024, `${shape} 资产 ${(shapeTotal / 1048576).toFixed(2)}MB 超出单身形预算`);
		const gzip = gzipSync(rigBytes, { level: 9 });
		assert.ok(gzip.byteLength <= 400 * 1024, `${shape} rig gzip ${(gzip.byteLength / 1024).toFixed(0)}KB 超出预算`);
	}
	assert.ok(total <= 6.5 * 1024 * 1024, `2.5D 资产合计 ${(total / 1048576).toFixed(2)}MB 超出预算`);
	// 首屏 payload（单身形，gzip rig + 图集）：应 ≤2MB 传输
	const chibiRig = readFileSync(join(ASSET_ROOT, 'chibi/rig.json'));
	const firstScreen = gzipSync(chibiRig, { level: 9 }).byteLength + statSync(join(ASSET_ROOT, 'chibi/atlas.webp')).size;
	assert.ok(firstScreen <= 2 * 1024 * 1024, `2.5D 首屏 payload ${(firstScreen / 1048576).toFixed(2)}MB 超出 2MB`);
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

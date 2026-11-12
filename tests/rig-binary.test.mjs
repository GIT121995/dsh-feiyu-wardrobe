/**
 * rig 二进化：rig.bin 二进制编解码契约测试（feiyu-rig-binary v1）
 *
 * 规范：`.scratch/p1-320/RIG-BINARY.md`；编码器：`tools/art/rig_binary.py`；
 * 解码器：`docs/dress-up/rig-binary.js`。对 4 个 rig.json（存在才测）覆盖：
 *  1) Python 编码器 CLI：报告字段 / magic+版本 / headerLen 4 字节对齐 / header JSON
 *     （= rig.json 去 mesh、加 meshMeta）/ offsets 顺序对齐不重叠 gap 补 0 / 双跑 sha256 确定；
 *  2) encode → JS decode roundtrip：非 mesh 字段 deepStrictEqual；mesh 每个数值严格
 *     === Math.fround(JSON 值)；typed array 类型/长度/形状正确；视图指向输入 buffer（零拷贝）；
 *  3) 损坏输入（magic/版本/截断/headerLen/offsets 对齐/越界/重叠/indexCount/vertexCount/
 *     binaryRig 不一致/坏 JSON）→ RigBinaryError；
 *  4) toRuntimeRig(rig.json)（JSON 回退）与 decode(encode) 形状/数值一致，非 mesh 字段保引用、
 *     不修改输入；非法 mesh 抛错；
 *  5) diagnostics：每 rig raw/gzip9/brotli(q5,q11) 字节 + JSON.parse vs decode 中位耗时（≥5 次）。
 *
 * 依赖：python3（缺失时 skip）、Node ≥22（zlib.brotliCompressSync）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

import {
	RIG_BINARY_FORMAT,
	RIG_BINARY_MAGIC,
	RIG_BINARY_MESH_LAYOUT,
	RIG_BINARY_MINOR_VERSION,
	RIG_BINARY_VERSION,
	RigBinaryError,
	decodeRigBinary,
	toRuntimeRig,
} from '../docs/dress-up/rig-binary.js';

const ROOT = resolve(import.meta.dirname, '..');
const ENCODER = join(ROOT, 'tools', 'art', 'rig_binary.py');
const ART_ROOT = join(ROOT, 'docs', 'dress-up', 'art', '2d5');
const PYTHON = process.env.DSH_FEIYU_PYTHON || 'python3';
const SHAPES = ['chibi', 'girl', 'chibi-hi', 'girl-hi'];
const ARRAY_KEYS = ['positions', 'uvs', 'bones', 'weights', 'deform', 'indices'];
/** 每顶点字节数（indices 按索引数另算 2B/索引）。 */
const VERTEX_BYTES = { positions: 8, uvs: 8, bones: 8, weights: 16, deform: 8 };

const pythonStatus = spawnSync(PYTHON, ['--version'], { encoding: 'utf8' });
const PYTHON_OK = pythonStatus.status === 0;
const SCRATCH = mkdtempSync(join(tmpdir(), 'feiyu-rig-binary-'));
process.on('exit', () => {
	try {
		rmSync(SCRATCH, { recursive: true, force: true });
	} catch {
		/* 临时目录清理失败不影响测试结论 */
	}
});

/** @type {Map<string, object>} */
const fixtureCache = new Map();

function rigPathOf(shape) {
	return join(ART_ROOT, shape, 'rig.json');
}

function skipReason(shape) {
	if (!PYTHON_OK) return 'python3 不可用，跳过 rig.bin 编码器测试';
	if (!existsSync(ENCODER)) return `编码器不存在: ${ENCODER}`;
	if (!existsSync(rigPathOf(shape))) return `${shape}/rig.json 不存在`;
	return false;
}

function toArrayBuffer(buffer) {
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function sha256(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

/** 调 Python CLI 把 rig.json 编码两次（验证确定性），返回缓存的 fixture。 */
function prepareFixture(shape) {
	if (fixtureCache.has(shape)) return fixtureCache.get(shape);
	const rigPath = rigPathOf(shape);
	const outDir = join(SCRATCH, shape);
	const run = (outPath, withReport) => {
		const args = [ENCODER, '--rig', rigPath, '--out', outPath];
		if (withReport) args.push('--report');
		return spawnSync(PYTHON, args, { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
	};
	const outFirst = join(outDir, 'rig.bin');
	const outSecond = join(outDir, 'rig.bin.second');
	const first = run(outFirst, true);
	assert.equal(first.status, 0, `rig_binary.py 编码失败（${shape}）:\n${first.stderr}`);
	const second = run(outSecond, false);
	assert.equal(second.status, 0, `rig_binary.py 二次编码失败（${shape}）:\n${second.stderr}`);
	const text = readFileSync(rigPath, 'utf8');
	const bin = readFileSync(outFirst);
	const fixture = {
		shape,
		rigPath,
		text,
		rigJson: JSON.parse(text),
		bin,
		binSecond: readFileSync(outSecond),
		report: JSON.parse(first.stdout),
		hash: sha256(bin),
	};
	fixtureCache.set(shape, fixture);
	return fixture;
}

/** 解析并校验文件头，返回 { headerLen, bin0, header }。 */
function parseBinHeader(bin) {
	assert.ok(bin.length >= 12, 'rig.bin 至少 12 字节');
	assert.equal(bin.subarray(0, 6).toString('latin1'), RIG_BINARY_MAGIC, 'magic 必须是 FYRIGB');
	assert.equal(bin[6], RIG_BINARY_VERSION, 'major 版本必须是 1');
	assert.equal(bin[7], RIG_BINARY_MINOR_VERSION, 'minor 版本必须是 0');
	const headerLen = bin.readUInt32LE(8);
	const bin0 = 12 + headerLen;
	assert.equal(bin0 % 4, 0, `BIN0=12+headerLen=${bin0} 必须是 4 的倍数`);
	assert.ok(bin0 <= bin.length, 'headerLen 不得超出文件');
	const header = JSON.parse(bin.subarray(12, bin0).toString('utf8'));
	return { headerLen, bin0, header };
}

/** 去掉 drawable.mesh（decode 输出）与 drawable.meshMeta（header JSON），用于非 mesh 字段对拍。 */
function withoutMesh(rig, meshKey) {
	const clone = { ...rig };
	clone.drawables = rig.drawables.map((drawable) => {
		const rest = { ...drawable };
		delete rest[meshKey];
		return rest;
	});
	return clone;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function expectRigBinaryError(fn, pattern, label = '') {
	let caught;
	try {
		fn();
	} catch (error) {
		caught = error;
	}
	assert.ok(caught, `${label ? `${label}：` : ''}期望抛 RigBinaryError，实际未抛`);
	assert.ok(caught instanceof RigBinaryError,
		`期望 RigBinaryError，实际 ${caught?.name}: ${caught?.message}`);
	if (pattern) assert.match(caught.message, pattern);
	return caught;
}

/** mesh 浮点字段逐值对拍：必须严格等于 Math.fround(JSON 值)。 */
function assertFloat32Field(actual, sourceRows, width, where) {
	assert.equal(actual.length, sourceRows.length * width, `${where} 长度必须为 ${sourceRows.length * width}`);
	for (let i = 0; i < actual.length; i += 1) {
		const row = sourceRows[Math.floor(i / width)];
		const source = row[i % width];
		const expected = Math.fround(source);
		if (!Object.is(actual[i], expected)) {
			assert.fail(`${where}[${i}] = ${actual[i]} ≠ Math.fround(${source}) = ${expected}`);
		}
	}
}

/** uint16 字段逐值对拍（bones 嵌套 / indices 扁平，width=1 时 sourceRows 为扁平数组）。 */
function assertUint16Field(actual, sourceRows, width, where) {
	const expectedCount = width === 1 ? sourceRows.length : sourceRows.length * width;
	assert.equal(actual.length, expectedCount, `${where} 长度必须是 ${expectedCount}`);
	for (let i = 0; i < actual.length; i += 1) {
		const source = width === 1 ? sourceRows[i] : sourceRows[Math.floor(i / width)][i % width];
		if (actual[i] !== source) {
			assert.fail(`${where}[${i}] = ${actual[i]} ≠ JSON 值 ${source}`);
		}
	}
}

// ---------------------------------------------------------------------------
// 1) 编码器 CLI + 文件头 / header JSON 契约
// ---------------------------------------------------------------------------

for (const shape of SHAPES) {
	test(`编码器 CLI + 文件头契约：${shape}`, { skip: skipReason(shape) }, () => {
		const fixture = prepareFixture(shape);
		const { bin, binSecond, report, rigJson, hash } = fixture;

		// 确定性：同一输入双跑逐字节一致（sha256）
		assert.equal(hash, sha256(binSecond), '双跑 encode sha256 必须一致（无时间戳/键序稳定）');
		assert.equal(report.sha256, hash, '--report.sha256 必须等于输出文件 sha256');
		assert.equal(report.format, RIG_BINARY_FORMAT);
		assert.equal(report.version, RIG_BINARY_VERSION);
		assert.equal(report.bytes, bin.length, '--report.bytes 必须等于文件字节数');
		assert.equal(report.headerLen, bin.readUInt32LE(8), '--report.headerLen 必须等于 u32 headerLen');
		assert.equal(report.binaryBytes, bin.length - 12 - report.headerLen);
		assert.equal(report.drawables, rigJson.drawables.length);
		assert.equal(report.vertices, rigJson.drawables.reduce((sum, drawable) => sum + drawable.mesh.positions.length, 0));
		assert.equal(report.indices, rigJson.drawables.reduce((sum, drawable) => sum + drawable.mesh.indices.length, 0));

		const { header, bin0 } = parseBinHeader(bin);
		assert.deepStrictEqual(header.binaryRig, {
			format: RIG_BINARY_FORMAT,
			version: RIG_BINARY_VERSION,
			meshLayout: RIG_BINARY_MESH_LAYOUT,
			bytes: bin.length,
		}, 'header.binaryRig 必须是规范定义的固定字段');

		// header JSON = rig.json 去掉每个 drawable.mesh、改 meshMeta；其余字段完全一致。
		const headerRest = withoutMesh(header, 'meshMeta');
		delete headerRest.binaryRig;
		assert.deepStrictEqual(headerRest, withoutMesh(rigJson, 'mesh'),
			'header JSON 的非 mesh 字段必须与 rig.json 完全一致');
		assert.equal(header.drawables.length, rigJson.drawables.length);

		// 逐 drawable meshMeta：V/I = JSON 数组长度；offsets 按表格顺序 4 字节对齐递增、gap 补 0、无尾部垃圾。
		let cursor = 0;
		for (let i = 0; i < rigJson.drawables.length; i += 1) {
			const source = rigJson.drawables[i];
			const meta = header.drawables[i].meshMeta;
			const vertexCount = source.mesh.positions.length;
			const indexCount = source.mesh.indices.length;
			assert.ok(meta, `drawables[${i}](${source.id}) 缺少 meshMeta`);
			assert.equal(meta.vertexCount, vertexCount, `drawables[${i}](${source.id}) meshMeta.vertexCount`);
			assert.equal(meta.indexCount, indexCount, `drawables[${i}](${source.id}) meshMeta.indexCount`);
			assert.deepStrictEqual(Object.keys(meta.offsets), ARRAY_KEYS, 'offsets 键顺序必须按规范表格');
			for (const key of ARRAY_KEYS) {
				const gapStart = cursor;
				cursor += (4 - (cursor % 4)) % 4;
				assert.equal(meta.offsets[key], cursor,
					`drawables[${i}](${source.id}).offsets.${key} 必须顺序 4 字节对齐（期望 ${cursor}）`);
				const gap = bin.subarray(bin0 + gapStart, bin0 + cursor);
				assert.ok(gap.every((byte) => byte === 0),
					`drawables[${i}](${source.id}).offsets.${key} 之前 gap 必须补 0`);
				cursor += key === 'indices' ? indexCount * 2 : vertexCount * VERTEX_BYTES[key];
			}
		}
		assert.equal(cursor, bin.length - bin0, 'binary 段末尾不得有多余字节（bytes 精确）');
	});
}

// ---------------------------------------------------------------------------
// 2) encode → decode roundtrip：非 mesh 字段 / mesh f32 / typed array / 零拷贝
// ---------------------------------------------------------------------------

for (const shape of SHAPES) {
	test(`encode → decode roundtrip：${shape}`, { skip: skipReason(shape) }, () => {
		const fixture = prepareFixture(shape);
		const { rigJson, bin } = fixture;
		const arrayBuffer = toArrayBuffer(bin);
		const decoded = decodeRigBinary(arrayBuffer);

		assert.equal(decoded.drawables.length, rigJson.drawables.length);
		assert.ok(!('binaryRig' in decoded), 'decode 输出不应残留 header.binaryRig 元数据');
		assert.deepStrictEqual(withoutMesh(decoded, 'mesh'), withoutMesh(rigJson, 'mesh'),
			'除 mesh 外字段（drawable 级）必须与 rig.json 完全一致');
		const decodedTop = { ...decoded };
		const jsonTop = { ...rigJson };
		delete decodedTop.drawables;
		delete jsonTop.drawables;
		assert.deepStrictEqual(decodedTop, jsonTop, '除 drawables 外顶层字段必须与 rig.json 完全一致');

		for (let i = 0; i < rigJson.drawables.length; i += 1) {
			const source = rigJson.drawables[i];
			const drawable = decoded.drawables[i];
			const mesh = drawable.mesh;
			const where = `${shape} drawables[${i}](${source.id})`;
			const vertexCount = source.mesh.positions.length;
			const indexCount = source.mesh.indices.length;

			assert.deepStrictEqual(Object.keys(drawable), Object.keys(source),
				`${where} 除 mesh 外字段集合/顺序必须与 JSON 一致`);
			assert.ok(mesh, `${where} 缺少 mesh`);
			assert.ok(mesh.positions instanceof Float32Array, `${where} positions 必须是 Float32Array`);
			assert.ok(mesh.uvs instanceof Float32Array, `${where} uvs 必须是 Float32Array`);
			assert.ok(mesh.bones instanceof Uint16Array, `${where} bones 必须是 Uint16Array`);
			assert.ok(mesh.weights instanceof Float32Array, `${where} weights 必须是 Float32Array`);
			assert.ok(mesh.deform instanceof Float32Array, `${where} deform 必须是 Float32Array`);
			assert.ok(mesh.indices instanceof Uint16Array, `${where} indices 必须是 Uint16Array`);
			assert.equal(mesh.vertexCount, vertexCount);
			assert.equal(mesh.indexCount, indexCount);
			assert.equal(mesh.positions.length, vertexCount * 2);
			assert.equal(mesh.uvs.length, vertexCount * 2);
			assert.equal(mesh.bones.length, vertexCount * 4);
			assert.equal(mesh.weights.length, vertexCount * 4);
			assert.equal(mesh.deform.length, vertexCount * 2);
			assert.equal(mesh.indices.length, indexCount);

			// 每个数值严格等于 Math.fround(JSON 值)（f32 最近偶数舍入，GL 侧逐位等价）
			assertFloat32Field(mesh.positions, source.mesh.positions, 2, `${where}.positions`);
			assertFloat32Field(mesh.uvs, source.mesh.uvs, 2, `${where}.uvs`);
			assertUint16Field(mesh.bones, source.mesh.bones, 4, `${where}.bones`);
			assertFloat32Field(mesh.weights, source.mesh.weights, 4, `${where}.weights`);
			assertFloat32Field(mesh.deform, source.mesh.deform, 2, `${where}.deform`);
			assertUint16Field(mesh.indices, source.mesh.indices, 1, `${where}.indices`);

			// 零拷贝：mesh typed array 直接是输入 buffer 的视图
			assert.equal(mesh.positions.buffer, arrayBuffer, `${where}.positions 必须是输入 buffer 的视图`);
			assert.equal(mesh.uvs.buffer, arrayBuffer);
			assert.equal(mesh.bones.buffer, arrayBuffer);
			assert.equal(mesh.weights.buffer, arrayBuffer);
			assert.equal(mesh.deform.buffer, arrayBuffer);
			assert.equal(mesh.indices.buffer, arrayBuffer);
		}

		// JSON 回退路径必须归一成与 decode(encode) 完全一致的形状/数值
		assert.deepStrictEqual(toRuntimeRig(rigJson), decoded,
			'toRuntimeRig(rig.json) 必须与 decode(encode(rig.json)) 完全一致');
	});
}

// ---------------------------------------------------------------------------
// 3) 损坏 / 非法输入 → RigBinaryError
// ---------------------------------------------------------------------------

/** 构造一个最小合法 rig.bin；offsets/binaryRig 可覆盖，用于解码器边界校验。 */
function buildBin(headerFactory, binaryLength) {
	let total = 0;
	let headerBytes = Buffer.alloc(0);
	for (let i = 0; i < 8; i += 1) {
		const raw = Buffer.from(JSON.stringify(headerFactory(total)), 'utf8');
		const pad = (4 - ((12 + raw.length) % 4)) % 4;
		headerBytes = Buffer.concat([raw, Buffer.alloc(pad, 0x20)]);
		const next = 12 + headerBytes.length + binaryLength;
		if (next === total) break;
		total = next;
	}
	const bin = Buffer.alloc(total);
	bin.write(RIG_BINARY_MAGIC, 0, 'latin1');
	bin[6] = RIG_BINARY_VERSION;
	bin[7] = RIG_BINARY_MINOR_VERSION;
	bin.writeUInt32LE(headerBytes.length, 8);
	headerBytes.copy(bin, 12);
	return bin;
}

function makeTinyBin({
	vertexCount = 3,
	indexCount = 3,
	offsetOverrides = {},
	binaryRig = {},
	includeBinaryRig = true,
	binaryLength = undefined,
} = {}) {
	const sizes = {
		positions: vertexCount * 8,
		uvs: vertexCount * 8,
		bones: vertexCount * 8,
		weights: vertexCount * 16,
		deform: vertexCount * 8,
		indices: indexCount * 2,
	};
	const offsets = {};
	let cursor = 0;
	for (const key of ARRAY_KEYS) {
		cursor += (4 - (cursor % 4)) % 4;
		offsets[key] = key in offsetOverrides ? offsetOverrides[key] : cursor;
		cursor += sizes[key];
	}
	const headerFactory = (totalBytes) => {
		const header = {
			format: 'feiyu-2.5d',
			version: 2,
			drawables: [{
				id: 'tiny',
				slot: 'body',
				meshMeta: { vertexCount, indexCount, offsets },
			}],
		};
		if (includeBinaryRig) {
			header.binaryRig = {
				format: RIG_BINARY_FORMAT,
				version: RIG_BINARY_VERSION,
				meshLayout: RIG_BINARY_MESH_LAYOUT,
				bytes: totalBytes,
				...binaryRig,
			};
		}
		return header;
	};
	return buildBin(headerFactory, binaryLength === undefined ? cursor : binaryLength);
}

test('decodeRigBinary：损坏/非法输入必须抛 RigBinaryError', { skip: skipReason('chibi') }, () => {
	const fixture = prepareFixture('chibi');
	const { bin } = fixture;

	// 基础输入类型
	expectRigBinaryError(() => decodeRigBinary(null), /ArrayBuffer/);
	expectRigBinaryError(() => decodeRigBinary(42), /ArrayBuffer/);
	expectRigBinaryError(() => decodeRigBinary(new Uint8Array(0)), /至少需要 12B/);

	// 太短 / 截断（保留原 buffer 长度也按视图长度判定）
	const shortHeader = Buffer.alloc(12);
	shortHeader.write(RIG_BINARY_MAGIC, 0, 'latin1');
	shortHeader[6] = RIG_BINARY_VERSION;
	shortHeader.writeUInt32LE(12, 8);
	expectRigBinaryError(() => decodeRigBinary(toArrayBuffer(shortHeader)), /超出文件大小|截断/);
	for (const cut of [1, 2, 7, 12, 64, 4096]) {
		const truncated = new Uint8Array(bin.buffer, bin.byteOffset, bin.length - cut);
		expectRigBinaryError(() => decodeRigBinary(truncated), /不一致|截断|超出文件/);
	}

	// 坏 magic
	const badMagic = Buffer.from(bin);
	badMagic[2] = 0x00;
	expectRigBinaryError(() => decodeRigBinary(toArrayBuffer(badMagic)), /magic/);

	// 坏版本（major / minor）
	const badMajor = Buffer.from(bin);
	badMajor[6] = 2;
	expectRigBinaryError(() => decodeRigBinary(toArrayBuffer(badMajor)), /版本 2\.0/);
	const badMinor = Buffer.from(bin);
	badMinor[7] = 1;
	expectRigBinaryError(() => decodeRigBinary(toArrayBuffer(badMinor)), /版本 1\.1/);

	// 坏 headerLen：未对齐 / 越界 / 0
	const badHeaderLen = Buffer.from(bin);
	badHeaderLen.writeUInt32LE((badHeaderLen.readUInt32LE(8) + 1) >>> 0, 8);
	expectRigBinaryError(() => decodeRigBinary(toArrayBuffer(badHeaderLen)), /4 的倍数/);
	const bigHeaderLen = Buffer.from(bin);
	bigHeaderLen.writeUInt32LE(bin.length, 8);
	expectRigBinaryError(() => decodeRigBinary(toArrayBuffer(bigHeaderLen)), /超出文件大小/);
	const zeroHeaderLen = Buffer.from(bin);
	zeroHeaderLen.writeUInt32LE(0, 8);
	expectRigBinaryError(() => decodeRigBinary(toArrayBuffer(zeroHeaderLen)), /headerLen=0/);

	// header JSON 损坏
	const brokenJson = Buffer.from('{"format":"feiyu-2.5d",', 'utf8');
	const brokenJsonPad = (4 - ((12 + brokenJson.length) % 4)) % 4;
	const brokenHeaderBin = Buffer.concat([Buffer.alloc(12), brokenJson, Buffer.alloc(brokenJsonPad)]);
	brokenHeaderBin.write(RIG_BINARY_MAGIC, 0, 'latin1');
	brokenHeaderBin[6] = RIG_BINARY_VERSION;
	brokenHeaderBin.writeUInt32LE(brokenJson.length + brokenJsonPad, 8);
	expectRigBinaryError(() => decodeRigBinary(toArrayBuffer(brokenHeaderBin)), /header JSON 解析失败/);

	// 自定义最小 bin：合法基线必须能解码
	const tiny = decodeRigBinary(toArrayBuffer(makeTinyBin()));
	assert.equal(tiny.drawables.length, 1);
	const tinyMesh = tiny.drawables[0].mesh;
	assert.equal(tinyMesh.vertexCount, 3);
	assert.equal(tinyMesh.indexCount, 3);
	assert.equal(tinyMesh.positions.length, 6);
	assert.equal(tinyMesh.bones.length, 12);
	assert.equal(tinyMesh.indices.length, 3);

	const cases = [
		['offset 未 4 字节对齐', makeTinyBin({ offsetOverrides: { positions: 2 } }), /未 4 字节对齐/],
		['offset 越界', makeTinyBin({ offsetOverrides: { indices: 999996 } }), /超出文件/],
		['offset 区间重叠', makeTinyBin({ offsetOverrides: { uvs: 8 } }), /重叠/],
		['vertexCount=0', makeTinyBin({ vertexCount: 0, indexCount: 0 }), /vertexCount=0/],
		['indexCount 非 3 倍数', makeTinyBin({ indexCount: 4 }), /3 的倍数/],
		['缺 binaryRig', makeTinyBin({ includeBinaryRig: false }), /binaryRig/],
		['binaryRig.bytes 不一致', makeTinyBin({ binaryRig: { bytes: 1 } }), /不一致/],
		['binaryRig.format 错误', makeTinyBin({ binaryRig: { format: 'nope' } }), /format/],
		['binaryRig.version 错误', makeTinyBin({ binaryRig: { version: 2 } }), /version/],
		['binaryRig.meshLayout 错误', makeTinyBin({ binaryRig: { meshLayout: 'nested-f64' } }), /meshLayout/],
		['header 不是对象', buildBin(() => [], 0), /header 必须是 JSON 对象/],
	];
	for (const [name, bytes, pattern] of cases) {
		expectRigBinaryError(() => decodeRigBinary(toArrayBuffer(bytes)), pattern, name);
	}
});

// ---------------------------------------------------------------------------
// 4) toRuntimeRig（JSON 回退）形状 / 引用 / 输入不可变 / 非法 mesh
// ---------------------------------------------------------------------------

test('toRuntimeRig：JSON 回退归一形状与 decode 一致，非 mesh 字段原样', { skip: skipReason('chibi') }, () => {
	const fixture = prepareFixture('chibi');
	const { rigJson } = fixture;
	const decoded = decodeRigBinary(toArrayBuffer(fixture.bin));
	const runtime = toRuntimeRig(rigJson);

	assert.deepStrictEqual(runtime, decoded, 'JSON 回退输出必须与二进制解码输出完全一致');

	// 非 mesh 字段原样（同一引用，不做深拷贝/重排）
	assert.equal(runtime.format, rigJson.format);
	assert.equal(runtime.skeleton, rigJson.skeleton);
	assert.equal(runtime.outfits, rigJson.outfits);
	assert.equal(runtime.atlas, rigJson.atlas);
	for (let i = 0; i < rigJson.drawables.length; i += 1) {
		assert.equal(runtime.drawables[i].atlasRect, rigJson.drawables[i].atlasRect);
		assert.equal(runtime.drawables[i].texture, rigJson.drawables[i].texture);
	}

	// 输入不被修改：原 mesh 仍是嵌套数组
	assert.ok(Array.isArray(rigJson.drawables[0].mesh.positions));
	assert.ok(Array.isArray(rigJson.drawables[0].mesh.positions[0]));
	assert.equal(rigJson.drawables[0].mesh.indices[0] !== undefined, true);

	// 幂等：对已归一形状再调一次结果等价
	assert.deepStrictEqual(toRuntimeRig(decoded), decoded, 'toRuntimeRig 对扁平 typed array 形状必须幂等');

	// 非法输入 → RigBinaryError
	expectRigBinaryError(() => toRuntimeRig(null), /rig JSON 对象/);
	expectRigBinaryError(() => toRuntimeRig('nope'), /rig JSON 对象/);
	expectRigBinaryError(() => toRuntimeRig({}), /drawables 必须是数组/);
	expectRigBinaryError(() => toRuntimeRig({ drawables: [{}] }), /缺少 mesh/);
	expectRigBinaryError(() => toRuntimeRig({ drawables: [{ mesh: null }] }), /mesh 必须是对象/);

	const baseDrawable = (mesh) => ({ drawables: [{ id: 'x', mesh }] });
	const goodMesh = {
		positions: [[0, 0], [1, 0], [1, 1]],
		uvs: [[0, 0], [1, 0], [1, 1]],
		bones: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
		weights: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]],
		deform: [[1, 0], [1, 0], [1, 0]],
		indices: [0, 1, 2],
	};
	expectRigBinaryError(() => toRuntimeRig(baseDrawable({ ...goodMesh, positions: [] })), /vertexCount 必须 ≥ 1/);
	expectRigBinaryError(() => toRuntimeRig(baseDrawable({ ...goodMesh, uvs: goodMesh.uvs.slice(0, 2) })), /不一致/);
	expectRigBinaryError(() => toRuntimeRig(baseDrawable({ ...goodMesh, bones: [[0, 0, 0, 70000], [0, 0, 0, 0], [0, 0, 0, 0]] })), /uint16/);
	expectRigBinaryError(() => toRuntimeRig(baseDrawable({ ...goodMesh, indices: [0, 1] })), /3 的倍数/);
	expectRigBinaryError(() => toRuntimeRig(baseDrawable({ ...goodMesh, indices: [0, 1, 1.5] })), /uint16/);
	expectRigBinaryError(() => toRuntimeRig(baseDrawable({ ...goodMesh, positions: [[0, 0], [1, 'x'], [1, 1]] })), /有限数字/);
});

// ---------------------------------------------------------------------------
// 5) ArrayBufferView 输入（Buffer / 非 4 字节对齐视图）
// ---------------------------------------------------------------------------

test('decodeRigBinary：接受 Buffer 与非 4 对齐子视图（必要时复制）', { skip: skipReason('chibi') }, () => {
	const fixture = prepareFixture('chibi');
	const { bin } = fixture;
	const decodedFromArrayBuffer = decodeRigBinary(toArrayBuffer(bin));

	const decodedFromBuffer = decodeRigBinary(bin);
	assert.deepStrictEqual(decodedFromBuffer, decodedFromArrayBuffer, 'Buffer 视图解码结果必须一致');

	const padded = Buffer.concat([Buffer.alloc(1, 0xff), bin]);
	const misaligned = padded.subarray(1);
	assert.equal(misaligned.byteOffset % 4, 1, '测试前置：子视图 byteOffset 必须非 4 对齐');
	const decodedFromMisaligned = decodeRigBinary(misaligned);
	assert.deepStrictEqual(decodedFromMisaligned, decodedFromArrayBuffer,
		'非 4 对齐视图（复制路径）解码结果必须一致');
	assert.notEqual(decodedFromMisaligned.drawables[0].mesh.positions.buffer, misaligned.buffer,
		'非 4 对齐视图无法零拷贝，必须复制到独立 buffer');
});

// ---------------------------------------------------------------------------
// 6) diagnostics：体积 / 压缩 / 解码耗时（中位数，≥5 次）
// ---------------------------------------------------------------------------

test('diagnostics：raw/gzip9/brotli(q5,q11) 字节 + JSON.parse vs decode 中位耗时', { skip: skipReason('chibi') }, (t) => {
	const RUNS = 5;
	const rows = [];
	for (const shape of SHAPES) {
		if (!existsSync(rigPathOf(shape))) {
			t.diagnostic(`跳过 ${shape}：rig.json 不存在`);
			continue;
		}
		const fixture = prepareFixture(shape);
		const { bin, text } = fixture;

		const jsonBytes = Buffer.byteLength(text, 'utf8');
		const rawBytes = bin.length;
		assert.ok(rawBytes < jsonBytes,
			`${shape}: rig.bin 原始 ${rawBytes}B 必须小于 rig.json ${jsonBytes}B`);

		const jsonParseTimes = [];
		for (let i = 0; i < RUNS; i += 1) {
			const started = performance.now();
			JSON.parse(text);
			jsonParseTimes.push(performance.now() - started);
		}

		const arrayBuffer = toArrayBuffer(bin);
		const decodeTimes = [];
		for (let i = 0; i < RUNS; i += 1) {
			const started = performance.now();
			decodeRigBinary(arrayBuffer);
			decodeTimes.push(performance.now() - started);
		}

		const gzip9Bytes = gzipSync(bin, { level: 9 }).length;
		const brotli = (quality) =>
			brotliCompressSync(bin, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality } }).length;
		const brotli5Bytes = brotli(5);
		const brotli11Bytes = brotli(11);

		const row = {
			shape,
			jsonBytes,
			rawBytes,
			gzip9Bytes,
			brotli5Bytes,
			brotli11Bytes,
			jsonParseMedianMs: median(jsonParseTimes),
			decodeMedianMs: median(decodeTimes),
			ratio: rawBytes / jsonBytes,
		};
		rows.push(row);
		t.diagnostic(
			`${shape}: json=${jsonBytes}B bin=${rawBytes}B (${(row.ratio * 100).toFixed(1)}%) `
			+ `gzip9=${gzip9Bytes}B br-q5=${brotli5Bytes}B br-q11=${brotli11Bytes}B | `
			+ `JSON.parse median=${row.jsonParseMedianMs.toFixed(2)}ms decode median=${row.decodeMedianMs.toFixed(2)}ms`,
		);
	}

	assert.equal(rows.length, SHAPES.filter((shape) => existsSync(rigPathOf(shape))).length,
		'diagnostics 必须覆盖所有存在的 rig');
	const lines = rows.map((row) => `  ${row.shape.padEnd(8)} json=${String(row.jsonBytes).padStart(8)}B `
		+ `bin=${String(row.rawBytes).padStart(8)}B gzip9=${String(row.gzip9Bytes).padStart(7)}B `
		+ `br-q5=${String(row.brotli5Bytes).padStart(7)}B br-q11=${String(row.brotli11Bytes).padStart(7)}B `
		+ `JSON.parse=${row.jsonParseMedianMs.toFixed(2)}ms decode=${row.decodeMedianMs.toFixed(2)}ms`);
	console.log(`\n[rig-binary diagnostics] (median of ${RUNS} runs)\n${lines.join('\n')}`);
});

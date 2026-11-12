/**
 * 大肥鱼衣橱 · rig.bin 二进制格式（feiyu-rig-binary v1）解码 + JSON 回退归一
 * （浏览器 / Node ESM 通用；无 DOM / window / WebGL 依赖）
 *
 * 构建期编码器：tools/art/rig_binary.py → `docs/dress-up/art/2d5/<shape>/rig.bin`；
 * 运行时 fetch 到 arraybuffer 后二选一：
 *
 *   const rig = decodeRigBinary(arrayBuffer);   // rig.bin（mesh 为输入 buffer 上的零拷贝视图）
 *   const rig = toRuntimeRig(rigJson);          // rig.json 回退（嵌套数组归一成同一扁平形状）
 *
 * 两条路径输出同一形状（消费方只认一种）：drawables[i].mesh =
 *   { positions: Float32Array(2V), uvs: Float32Array(2V), bones: Uint16Array(4V),
 *     weights: Float32Array(4V), deform: Float32Array(2V), indices: Uint16Array(I),
 *     vertexCount, indexCount }
 * 其余字段（format/skeleton/drawables[].atlasRect/outfits/...）与 rig.json 完全一致。
 *
 * 文件布局（全部小端）：
 *   [0, 8)     ASCII "FYRIGB" + uint8 major=1 + uint8 minor=0
 *   [8, 12)    uint32 headerLen（header JSON 字节数，含 4 字节对齐的尾部空格）
 *   [12, 12+H) header JSON = 原 rig 去掉每个 drawables[i].mesh，改为
 *              meshMeta{vertexCount,indexCount,offsets:{positions,uvs,bones,weights,deform,indices}}
 *              （offsets 相对 BIN0），顶层加
 *              binaryRig{format:'feiyu-rig-binary',version:1,meshLayout:'flat-f32',bytes}
 *   [BIN0,...) binary 段：逐 drawable 4 字节对齐写
 *              positions f32×2V / uvs f32×2V / bones u16×4V / weights f32×4V /
 *              deform f32×2V / indices u16×I
 * BIN0 = 12 + headerLen 必为 4 的倍数；所有非法输入（magic/版本/长度/对齐/越界/
 * 区间重叠/不一致）抛 RigBinaryError，运行时可 catch 后回退 rig.json。
 *
 * 格式规范：.scratch/p1-320/RIG-BINARY.md；契约测试：tests/rig-binary.test.mjs。
 *
 * @module dsh-feiyu-wardrobe/rig-binary
 */

/** magic 明文（8 字节文件头前 6 字节）。 */
export const RIG_BINARY_MAGIC = 'FYRIGB';
/** 格式主版本（文件头第 7 字节；不兼容修改时自增）。 */
export const RIG_BINARY_VERSION = 1;
/** 格式次版本（文件头第 8 字节；向后兼容修改时自增）。 */
export const RIG_BINARY_MINOR_VERSION = 0;
/** header.binaryRig.format 固定值。 */
export const RIG_BINARY_FORMAT = 'feiyu-rig-binary';
/** header.binaryRig.meshLayout 固定值（扁平 f32/u16 typed array）。 */
export const RIG_BINARY_MESH_LAYOUT = 'flat-f32';

const HEADER_PREFIX_BYTES = 12;
const MAGIC_BYTES = Object.freeze([0x46, 0x59, 0x52, 0x49, 0x47, 0x42]); // "FYRIGB"
const ARRAY_KEYS = Object.freeze(['positions', 'uvs', 'bones', 'weights', 'deform', 'indices']);
/** 每顶点字节数（indices 按索引数另算 2B/索引）。 */
const VERTEX_BYTES = Object.freeze({
	positions: 8, // f32 × 2
	uvs: 8, // f32 × 2
	bones: 8, // u16 × 4
	weights: 16, // f32 × 4
	deform: 8, // f32 × 2
	indices: 0, // 特判：indexCount × 2
});
const INDICES_BYTES_PER_INDEX = 2;
/** uint16 上限（V/I/bones 均要求 < 65536）。 */
const UINT16_LIMIT = 65536;

/** 本模块统一的解码错误类型；所有非法输入都抛它（message 可读，details.code 为错误码）。 */
export class RigBinaryError extends Error {
	/**
	 * @param {string} message 可读错误信息
	 * @param {{code?: string, cause?: unknown}} [details] 错误码 / 原始异常
	 */
	constructor(message, details = undefined) {
		super(message);
		this.name = 'RigBinaryError';
		this.code = details?.code || 'RIG_BINARY_ERROR';
		if (details && 'cause' in details) this.cause = details.cause;
	}
}

function fail(code, message) {
	return new RigBinaryError(message, { code });
}

/** 宿主字节序（typed array 视图按宿主 endian 解释；rig.bin 固定小端 → 大端机无法零拷贝）。 */
const LITTLE_ENDIAN_HOST = (() => {
	const probe = new Uint8Array(2);
	new Uint16Array(probe.buffer)[0] = 1;
	return probe[0] === 1;
})();

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const ARRAY_BUFFER_TAG = '[object ArrayBuffer]';

function isArrayBuffer(value) {
	return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === ARRAY_BUFFER_TAG;
}

function describeInput(input) {
	if (input === null) return 'null';
	if (Array.isArray(input)) return 'Array';
	return typeof input;
}

function formatBytes(bytes, max = 8) {
	return Array.from(bytes.subarray(0, max), (value) => value.toString(16).padStart(2, '0')).join(' ');
}

/**
 * 把输入归一成「buffer + byteOffset + byteLength」；非 4 字节对齐的视图复制一份，
 * 保证后续 Float32Array/Uint16Array 视图能直接挂在输入 buffer 上（零拷贝）。
 */
function normalizeInput(input) {
	if (isArrayBuffer(input)) {
		return { buffer: input, byteOffset: 0, byteLength: input.byteLength };
	}
	if (ArrayBuffer.isView(input)) {
		const { buffer, byteOffset, byteLength } = input;
		if (byteLength < 0 || byteOffset < 0 || byteOffset + byteLength > buffer.byteLength) {
			throw fail('BAD_INPUT', `decodeRigBinary: 视图区间 [${byteOffset},${byteOffset + byteLength}) 超出 buffer ${buffer.byteLength}B`);
		}
		if (byteOffset % 4 === 0) return { buffer, byteOffset, byteLength };
		const copy = new Uint8Array(byteLength);
		copy.set(new Uint8Array(buffer, byteOffset, byteLength));
		return { buffer: copy.buffer, byteOffset: 0, byteLength };
	}
	throw fail('BAD_INPUT', `decodeRigBinary: 需要 ArrayBuffer 或 ArrayBufferView，实际 ${describeInput(input)}`);
}

function requireObject(value, message) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('BAD_HEADER', message);
	return value;
}

function requireUint(value, what) {
	if (!Number.isInteger(value) || value < 0) {
		throw fail('BAD_MESH_META', `decodeRigBinary: ${what}=${String(value)} 必须是非负整数`);
	}
	return value;
}

/**
 * 解码 rig.bin。
 *
 * @param {ArrayBuffer|ArrayBufferView} input rig.bin 字节（浏览器 fetch().arrayBuffer() 直接传入）
 * @returns {object} rig 对象；drawables[i].mesh 为扁平 typed array，其余字段与 rig.json 相同。
 *   mesh 视图直接指向输入 buffer（零拷贝），需要持久化时调用方自行 clone。
 * @throws {RigBinaryError} magic/版本/长度/对齐/越界/重叠/不一致等任何非法输入
 */
export function decodeRigBinary(input) {
	if (!LITTLE_ENDIAN_HOST) {
		throw fail('BIG_ENDIAN_HOST',
			'decodeRigBinary: 当前主机为大端，rig.bin 为 little-endian f32/u16，typed array 零拷贝视图不可用');
	}
	const { buffer, byteOffset, byteLength } = normalizeInput(input);
	if (byteLength < HEADER_PREFIX_BYTES) {
		throw fail('TRUNCATED',
			`decodeRigBinary: 文件仅 ${byteLength}B，至少需要 ${HEADER_PREFIX_BYTES}B（magic + headerLen）`);
	}
	const bytes = new Uint8Array(buffer, byteOffset, byteLength);
	const data = new DataView(buffer, byteOffset, byteLength);

	for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
		if (bytes[i] !== MAGIC_BYTES[i]) {
			throw fail('BAD_MAGIC',
				`decodeRigBinary: magic 不是 "${RIG_BINARY_MAGIC}"，实际 [${formatBytes(bytes)}]`);
		}
	}
	const major = bytes[6];
	const minor = bytes[7];
	if (major !== RIG_BINARY_VERSION || minor !== RIG_BINARY_MINOR_VERSION) {
		throw fail('BAD_VERSION',
			`decodeRigBinary: 不支持的版本 ${major}.${minor}（期望 ${RIG_BINARY_VERSION}.${RIG_BINARY_MINOR_VERSION}）`);
	}

	const headerLen = data.getUint32(8, true);
	const bin0 = HEADER_PREFIX_BYTES + headerLen;
	if (headerLen === 0) throw fail('BAD_HEADER', 'decodeRigBinary: headerLen=0');
	if (bin0 % 4 !== 0) {
		throw fail('BAD_ALIGNMENT', `decodeRigBinary: BIN0=12+headerLen=${bin0} 不是 4 的倍数（header 未对齐）`);
	}
	if (bin0 > byteLength) {
		throw fail('TRUNCATED',
			`decodeRigBinary: headerLen=${headerLen} 超出文件大小 ${byteLength}B（header 被截断）`);
	}

	let header;
	try {
		header = JSON.parse(UTF8_DECODER.decode(bytes.subarray(HEADER_PREFIX_BYTES, bin0)));
	} catch (cause) {
		throw fail('BAD_HEADER', `decodeRigBinary: header JSON 解析失败: ${cause.message}`);
	}
	requireObject(header, 'decodeRigBinary: header 必须是 JSON 对象');

	const binaryRig = requireObject(header.binaryRig, 'decodeRigBinary: header.binaryRig 必须是对象');
	if (binaryRig.format !== RIG_BINARY_FORMAT) {
		throw fail('BAD_HEADER',
			`decodeRigBinary: binaryRig.format=${JSON.stringify(binaryRig.format)}（期望 "${RIG_BINARY_FORMAT}"）`);
	}
	if (binaryRig.version !== RIG_BINARY_VERSION) {
		throw fail('BAD_HEADER',
			`decodeRigBinary: binaryRig.version=${JSON.stringify(binaryRig.version)}（期望 ${RIG_BINARY_VERSION}）`);
	}
	if (binaryRig.meshLayout !== RIG_BINARY_MESH_LAYOUT) {
		throw fail('BAD_HEADER',
			`decodeRigBinary: binaryRig.meshLayout=${JSON.stringify(binaryRig.meshLayout)}（期望 "${RIG_BINARY_MESH_LAYOUT}"）`);
	}
	if (binaryRig.bytes !== byteLength) {
		throw fail('BAD_LENGTH',
			`decodeRigBinary: binaryRig.bytes=${JSON.stringify(binaryRig.bytes)} 与实际 ${byteLength}B 不一致（截断或尾部多余字节）`);
	}

	const sourceDrawables = header.drawables;
	if (!Array.isArray(sourceDrawables)) {
		throw fail('BAD_HEADER', 'decodeRigBinary: header.drawables 必须是数组');
	}

	// 所有数组区间（文件绝对字节区间），最后统一检查不重叠。
	const ranges = [];
	const drawables = sourceDrawables.map((drawable, index) => {
		const here = `drawables[${index}]`;
		requireObject(drawable, `decodeRigBinary: ${here} 必须是对象`);
		const meta = requireObject(drawable.meshMeta, `decodeRigBinary: ${here}.meshMeta 必须是对象`);
		const vertexCount = requireUint(meta.vertexCount, `${here}.meshMeta.vertexCount`);
		const indexCount = requireUint(meta.indexCount, `${here}.meshMeta.indexCount`);
		if (vertexCount < 1 || vertexCount >= UINT16_LIMIT) {
			throw fail('BAD_MESH_META',
				`decodeRigBinary: ${here}.vertexCount=${vertexCount} 非法（需 1 ≤ V < 65536）`);
		}
		if (indexCount >= UINT16_LIMIT) {
			throw fail('BAD_MESH_META',
				`decodeRigBinary: ${here}.indexCount=${indexCount} 超出 uint16 索引上限（需 I < 65536）`);
		}
		if (indexCount % 3 !== 0) {
			throw fail('BAD_MESH_META',
				`decodeRigBinary: ${here}.indexCount=${indexCount} 不是 3 的倍数（三角形列表）`);
		}
		const offsets = requireObject(meta.offsets, `decodeRigBinary: ${here}.meshMeta.offsets 必须是对象`);

		const starts = {};
		for (const key of ARRAY_KEYS) {
			const offset = requireUint(offsets[key], `${here}.meshMeta.offsets.${key}`);
			if (offset % 4 !== 0) {
				throw fail('BAD_ALIGNMENT',
					`decodeRigBinary: ${here}.meshMeta.offsets.${key}=${offset} 未 4 字节对齐`);
			}
			const size = key === 'indices'
				? indexCount * INDICES_BYTES_PER_INDEX
				: vertexCount * VERTEX_BYTES[key];
			const start = bin0 + offset;
			const end = start + size;
			if (end > byteLength) {
				throw fail('OUT_OF_BOUNDS',
					`decodeRigBinary: ${here}.meshMeta.offsets.${key} 区间 [${start},${end}) 超出文件 ${byteLength}B`);
			}
			starts[key] = start;
			if (size > 0) ranges.push({ start, end, drawable: index, key });
		}

		const mesh = {
			positions: new Float32Array(buffer, byteOffset + starts.positions, vertexCount * 2),
			uvs: new Float32Array(buffer, byteOffset + starts.uvs, vertexCount * 2),
			bones: new Uint16Array(buffer, byteOffset + starts.bones, vertexCount * 4),
			weights: new Float32Array(buffer, byteOffset + starts.weights, vertexCount * 4),
			deform: new Float32Array(buffer, byteOffset + starts.deform, vertexCount * 2),
			indices: new Uint16Array(buffer, byteOffset + starts.indices, indexCount),
			vertexCount,
			indexCount,
		};

		const runtimeDrawable = {};
		for (const key of Object.keys(drawable)) {
			if (key === 'meshMeta') runtimeDrawable.mesh = mesh;
			else runtimeDrawable[key] = drawable[key];
		}
		return runtimeDrawable;
	});

	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	for (let i = 1; i < ranges.length; i += 1) {
		const previous = ranges[i - 1];
		const current = ranges[i];
		if (current.start < previous.end) {
			throw fail('OVERLAP',
				`decodeRigBinary: 数组区间重叠: drawables[${previous.drawable}].${previous.key} `
				+ `[${previous.start},${previous.end}) 与 drawables[${current.drawable}].${current.key} `
				+ `[${current.start},${current.end})`);
		}
	}

	const rig = {};
	for (const key of Object.keys(header)) {
		if (key === 'drawables') rig[key] = drawables;
		else if (key !== 'binaryRig') rig[key] = header[key];
	}
	return rig;
}

// ---------------------------------------------------------------------------
// JSON 回退：把 rig.json 的嵌套 mesh 归一成与 decodeRigBinary 相同的扁平 typed array。
// ---------------------------------------------------------------------------

function requireArrayLike(value, what) {
	if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
		throw fail('BAD_MESH', `toRuntimeRig: ${what} 必须是数组`);
	}
}

/**
 * 嵌套 [[a,b],...] 或扁平 [a,b,...] → { flat: number[], count }。
 * @param {unknown} value 输入数组
 * @param {number} width 每行元素数（1 = 扁平）
 * @param {string} what 报错定位
 * @param {number} [expectedCount] 期望元素数（顶点数）
 */
function flattenNumericField(value, width, what, expectedCount = undefined) {
	requireArrayLike(value, what);
	const rows = /** @type {any[]} */ (Array.from(/** @type {ArrayLike<any>} */ (value)));
	if (rows.length === 0) {
		if (expectedCount && expectedCount > 0) {
			throw fail('BAD_MESH', `toRuntimeRig: ${what} 为空，但 vertexCount=${expectedCount}`);
		}
		return { flat: [], count: 0 };
	}
	let flat = [];
	let count;
	if (typeof rows[0] === 'number') {
		if (rows.length % width !== 0) {
			throw fail('BAD_MESH', `toRuntimeRig: ${what} 长度 ${rows.length} 不是 ${width} 的倍数（扁平数组）`);
		}
		count = rows.length / width;
		flat = rows;
	} else {
		count = rows.length;
		flat = new Array(count * width);
		for (let i = 0; i < count; i += 1) {
			const row = rows[i];
			if (!Array.isArray(row) || row.length !== width) {
				throw fail('BAD_MESH', `toRuntimeRig: ${what}[${i}] 必须是长度 ${width} 的数组`);
			}
			for (let j = 0; j < width; j += 1) flat[i * width + j] = row[j];
		}
	}
	if (expectedCount !== undefined && count !== expectedCount) {
		throw fail('BAD_MESH', `toRuntimeRig: ${what} 元素数 ${count} 与 vertexCount ${expectedCount} 不一致`);
	}
	for (let i = 0; i < flat.length; i += 1) {
		const number = flat[i];
		if (typeof number !== 'number' || !Number.isFinite(number)) {
			throw fail('BAD_MESH', `toRuntimeRig: ${what}[${i}]=${String(number)} 不是有限数字`);
		}
	}
	return { flat, count };
}

function flattenFloatField(value, width, what, expectedCount = undefined) {
	const { flat, count } = flattenNumericField(value, width, what, expectedCount);
	return { array: Float32Array.from(flat), count };
}

function flattenUint16Field(value, width, what, expectedCount = undefined) {
	const { flat, count } = flattenNumericField(value, width, what, expectedCount);
	const array = new Uint16Array(flat.length);
	for (let i = 0; i < flat.length; i += 1) {
		const number = flat[i];
		if (!Number.isInteger(number) || number < 0 || number >= UINT16_LIMIT) {
			throw fail('BAD_MESH', `toRuntimeRig: ${what}[${i}]=${String(number)} 超出 uint16 范围 [0,65535]`);
		}
		array[i] = number;
	}
	return { array, count };
}

/** rig.json 的嵌套 mesh → 与 decodeRigBinary 一致的扁平 typed array mesh。 */
function normalizeJsonMesh(mesh, where) {
	requireObject(mesh, `toRuntimeRig: ${where}.mesh 必须是对象`);
	const positions = flattenFloatField(mesh.positions, 2, `${where}.mesh.positions`);
	if (positions.count < 1) {
		throw fail('BAD_MESH', `toRuntimeRig: ${where}.mesh.positions 为空（vertexCount 必须 ≥ 1）`);
	}
	if (positions.count >= UINT16_LIMIT) {
		throw fail('BAD_MESH', `toRuntimeRig: ${where}.mesh vertexCount=${positions.count} 超出上限（需 < 65536）`);
	}
	const vertexCount = positions.count;
	const uvs = flattenFloatField(mesh.uvs, 2, `${where}.mesh.uvs`, vertexCount);
	const bones = flattenUint16Field(mesh.bones, 4, `${where}.mesh.bones`, vertexCount);
	const weights = flattenFloatField(mesh.weights, 4, `${where}.mesh.weights`, vertexCount);
	const deform = flattenFloatField(mesh.deform, 2, `${where}.mesh.deform`, vertexCount);

	const rawIndices = mesh.indices;
	if (!Array.isArray(rawIndices) && !ArrayBuffer.isView(rawIndices)) {
		throw fail('BAD_MESH', `toRuntimeRig: ${where}.mesh.indices 必须是数组`);
	}
	const indexCount = Number(/** @type {any} */ (rawIndices).length);
	if (indexCount >= UINT16_LIMIT) {
		throw fail('BAD_MESH', `toRuntimeRig: ${where}.mesh indexCount=${indexCount} 超出上限（需 < 65536）`);
	}
	if (indexCount % 3 !== 0) {
		throw fail('BAD_MESH', `toRuntimeRig: ${where}.mesh indexCount=${indexCount} 不是 3 的倍数（三角形列表）`);
	}
	const indices = new Uint16Array(indexCount);
	for (let i = 0; i < indexCount; i += 1) {
		const number = rawIndices[i];
		if (!Number.isInteger(number) || number < 0 || number >= UINT16_LIMIT) {
			throw fail('BAD_MESH', `toRuntimeRig: ${where}.mesh.indices[${i}]=${String(number)} 超出 uint16 范围 [0,65535]`);
		}
		indices[i] = number;
	}

	return {
		positions: positions.array,
		uvs: uvs.array,
		bones: bones.array,
		weights: weights.array,
		deform: deform.array,
		indices,
		vertexCount,
		indexCount,
	};
}

/**
 * JSON 回退路径：rig.json（嵌套 mesh 数组）→ 与 decodeRigBinary 相同的运行时形状。
 *
 * - `drawables[i].mesh` 归一为扁平 typed array（positions/uvs/weights/deform Float32Array，
 *   bones/indices Uint16Array，带 vertexCount/indexCount）；
 * - 非 mesh 字段原样保留（同一引用，不深拷贝、不修改输入对象）。
 *
 * 数值口径：Float32Array 构造即 f32 最近偶数舍入，与 rig.bin 路径逐位一致。
 *
 * @param {object} rigJson JSON.parse 后的 rig.json
 * @returns {object} 归一后的 rig（形状同 decodeRigBinary 输出）
 * @throws {RigBinaryError} drawables/mesh 缺失或长度、范围不一致
 */
export function toRuntimeRig(rigJson) {
	if (!rigJson || typeof rigJson !== 'object' || Array.isArray(rigJson)) {
		throw fail('BAD_RIG', `toRuntimeRig: 需要 rig JSON 对象，实际 ${describeInput(rigJson)}`);
	}
	const sourceDrawables = rigJson.drawables;
	if (!Array.isArray(sourceDrawables)) {
		throw fail('BAD_RIG', 'toRuntimeRig: rig.drawables 必须是数组');
	}
	const drawables = sourceDrawables.map((drawable, index) => {
		const where = `drawables[${index}]`;
		if (!drawable || typeof drawable !== 'object' || Array.isArray(drawable)) {
			throw fail('BAD_RIG', `toRuntimeRig: ${where} 必须是对象`);
		}
		if (!('mesh' in drawable)) {
			throw fail('BAD_RIG', `toRuntimeRig: ${where} 缺少 mesh`);
		}
		const mesh = normalizeJsonMesh(drawable.mesh, where);
		const runtimeDrawable = {};
		for (const key of Object.keys(drawable)) {
			if (key === 'mesh') runtimeDrawable.mesh = mesh;
			else runtimeDrawable[key] = drawable[key];
		}
		return runtimeDrawable;
	});

	const rig = {};
	for (const key of Object.keys(rigJson)) {
		if (key === 'drawables') rig[key] = drawables;
		else rig[key] = rigJson[key];
	}
	return rig;
}

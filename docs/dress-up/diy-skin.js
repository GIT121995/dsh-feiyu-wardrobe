/**
 * 大肥鱼衣橱 · `.dshskin` 本地分享格式（导入/导出 + schema 校验）
 *
 * 格式（v1，纯本地文件、不经服务器）：
 *   ZIP（store 模式，无压缩，无外部依赖）
 *     ├─ manifest.json     schema：format/version/物品元数据/图层清单(sha256)/内容策略/许可
 *     ├─ layers/body.webp  衣身层（必需）
 *     ├─ layers/sleeve.webp 袖子层（可选；bottom 不允许）
 *     ├─ LICENSE.txt      衣服版权归上传者 / 本项目 MIT
 *     └─ ATTRIBUTION.txt  来源与内容策略说明
 *
 * 导入校验：ZIP 结构/条目名（拒目录穿越/重复）、manifest schema/版本/品类/内容策略、
 * 图层文件存在 + 大小上限 + sha256 一致。任何一项不过 → 整包拒绝，不落盘。
 *
 * @module dsh-feiyu-wardrobe/diy-skin
 */

import { DIY_LAYER_SLOTS, validateDiyRecord } from './wardrobe-core.js';

/** 分享格式标识（写进 manifest.json / 下载文件名）。 */
export const SKIN_FORMAT = 'dshskin';
export const SKIN_VERSION = 1;
export const SKIN_EXT = '.dshskin';

/** 包内容限制（防 zip bomb / 误导入超大文件）。 */
export const SKIN_LIMITS = {
	maxEntries: 12,
	maxLayerBytes: 2 * 1024 * 1024,
	maxTotalBytes: 12 * 1024 * 1024,
	maxManifestBytes: 64 * 1024,
};

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * @param {unknown} value
 * @returns {value is { ok: boolean, errors: string[] }}
 */
function isResult(value) {
	return Boolean(value && typeof value === 'object' && 'ok' in value);
}

/* ---------------- CRC32 / ZIP（store） ---------------- */

/** @type {Uint32Array | null} */
let crcTable = null;

/**
 * CRC32（ZIP 兼容）。
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function crc32(bytes) {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let i = 0; i < 256; i += 1) {
			let c = i;
			for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[i] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 规范化 ZIP 条目名：拒绝对路径 / 目录穿越 / 反斜杠 / 空名。
 * @param {string} name
 * @returns {string | null}
 */
export function normalizeEntryName(name) {
	if (typeof name !== 'string' || !name || name.length > 120) return null;
	if (name.includes('\\') || name.includes('\0')) return null;
	if (name.startsWith('/') || name.startsWith('.')) return null;
	const parts = name.split('/');
	if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
	return name;
}

/**
 * 写一个 store-only ZIP（无压缩；不写额外扩展字段）。
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @returns {Uint8Array}
 */
export function writeZip(entries) {
	/** @type {Array<{ nameBytes: Uint8Array, data: Uint8Array, crc: number, offset: number }>} */
	const prepared = [];
	let offset = 0;
	for (const entry of entries) {
		const name = normalizeEntryName(entry.name);
		if (!name) throw new Error(`非法 ZIP 条目名：${String(entry.name)}`);
		const nameBytes = TEXT_ENCODER.encode(name);
		const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
		const crc = crc32(data);
		prepared.push({ nameBytes, data, crc, offset });
		offset += 30 + nameBytes.length + data.length;
	}
	const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.nameBytes.length, 0);
	const total = offset + centralSize + 22;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	let cursor = 0;
	for (const entry of prepared) {
		view.setUint32(cursor, 0x04034b50, true);
		view.setUint16(cursor + 4, 20, true); // version needed
		view.setUint16(cursor + 6, 0x0800, true); // UTF-8 filename
		view.setUint16(cursor + 8, 0, true); // method: store
		view.setUint16(cursor + 10, 0, true); // time
		view.setUint16(cursor + 12, 0, true); // date
		view.setUint32(cursor + 14, entry.crc, true);
		view.setUint32(cursor + 18, entry.data.length, true);
		view.setUint32(cursor + 22, entry.data.length, true);
		view.setUint16(cursor + 26, entry.nameBytes.length, true);
		view.setUint16(cursor + 28, 0, true);
		out.set(entry.nameBytes, cursor + 30);
		out.set(entry.data, cursor + 30 + entry.nameBytes.length);
		cursor += 30 + entry.nameBytes.length + entry.data.length;
	}
	const centralOffset = cursor;
	for (const entry of prepared) {
		view.setUint32(cursor, 0x02014b50, true);
		view.setUint16(cursor + 4, 20, true); // version made by
		view.setUint16(cursor + 6, 20, true); // version needed
		view.setUint16(cursor + 8, 0x0800, true);
		view.setUint16(cursor + 10, 0, true);
		view.setUint16(cursor + 12, 0, true);
		view.setUint16(cursor + 14, 0, true);
		view.setUint32(cursor + 16, entry.crc, true);
		view.setUint32(cursor + 20, entry.data.length, true);
		view.setUint32(cursor + 24, entry.data.length, true);
		view.setUint16(cursor + 28, entry.nameBytes.length, true);
		view.setUint16(cursor + 30, 0, true);
		view.setUint16(cursor + 32, 0, true);
		view.setUint16(cursor + 34, 0, true);
		view.setUint16(cursor + 36, 0, true);
		view.setUint32(cursor + 38, 0, true);
		view.setUint32(cursor + 42, entry.offset, true);
		out.set(entry.nameBytes, cursor + 46);
		cursor += 46 + entry.nameBytes.length;
	}
	view.setUint32(cursor, 0x06054b50, true);
	view.setUint16(cursor + 4, 0, true);
	view.setUint16(cursor + 6, 0, true);
	view.setUint16(cursor + 8, prepared.length, true);
	view.setUint16(cursor + 10, prepared.length, true);
	view.setUint32(cursor + 12, centralSize, true);
	view.setUint32(cursor + 16, centralOffset, true);
	view.setUint16(cursor + 20, 0, true);
	return out;
}

/**
 * 读取 store-only ZIP（只接受 method=0；导入时整包校验）。
 * @param {Uint8Array} bytes
 * @returns {{ ok: boolean, errors: string[], entries: Map<string, Uint8Array> }}
 */
export function readZip(bytes) {
	const errors = [];
	const entries = new Map();
	if (!(bytes instanceof Uint8Array) || bytes.length < 22) {
		return { ok: false, errors: ['文件不是有效的 ZIP'], entries };
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// 从尾部找 EOCD
	let eocd = -1;
	for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65_557; i -= 1) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return { ok: false, errors: ['缺少 ZIP 目录（EOCD）'], entries };
	const count = view.getUint16(eocd + 10, true);
	const centralOffset = view.getUint32(eocd + 16, true);
	if (count > SKIN_LIMITS.maxEntries) errors.push(`条目数 ${count} 超过上限 ${SKIN_LIMITS.maxEntries}`);
	let cursor = centralOffset;
	let totalBytes = 0;
	for (let index = 0; index < count; index += 1) {
		if (cursor + 46 > bytes.length) {
			errors.push('ZIP 目录损坏');
			break;
		}
		if (view.getUint32(cursor, true) !== 0x02014b50) {
			errors.push('ZIP 目录项签名错误');
			break;
		}
		const method = view.getUint16(cursor + 10, true);
		const crc = view.getUint32(cursor + 16, true);
		const compressedSize = view.getUint32(cursor + 20, true);
		const uncompressedSize = view.getUint32(cursor + 24, true);
		const nameLength = view.getUint16(cursor + 28, true);
		const extraLength = view.getUint16(cursor + 30, true);
		const commentLength = view.getUint16(cursor + 32, true);
		const localOffset = view.getUint32(cursor + 42, true);
		const nameStart = cursor + 46;
		if (nameStart + nameLength > bytes.length) {
			errors.push('ZIP 目录项越界');
			break;
		}
		const rawName = TEXT_DECODER.decode(bytes.subarray(nameStart, nameStart + nameLength));
		const name = normalizeEntryName(rawName);
		if (!name) errors.push(`非法条目名：${rawName}`);
		else if (entries.has(name)) errors.push(`重复条目：${name}`);
		cursor = nameStart + nameLength + extraLength + commentLength;
		if (method !== 0) {
			errors.push(`条目 ${rawName} 使用了不支持的压缩方式（只接受 store）`);
			continue;
		}
		if (uncompressedSize !== compressedSize) errors.push(`条目 ${rawName} 大小字段不一致`);
		if (uncompressedSize > SKIN_LIMITS.maxLayerBytes) errors.push(`条目 ${rawName} 超过单文件上限`);
		if (errorCount(errors) > 0) continue;
		// local header 读取真实数据
		if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
			errors.push(`条目 ${rawName} 本地头损坏`);
			continue;
		}
		const localNameLength = view.getUint16(localOffset + 26, true);
		const localExtraLength = view.getUint16(localOffset + 28, true);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		if (dataStart + compressedSize > bytes.length) {
			errors.push(`条目 ${rawName} 数据越界`);
			continue;
		}
		const data = bytes.slice(dataStart, dataStart + compressedSize);
		if (crc32(data) !== crc) {
			errors.push(`条目 ${rawName} CRC 校验失败`);
			continue;
		}
		totalBytes += data.length;
		if (name) entries.set(name, data);
	}
	if (totalBytes > SKIN_LIMITS.maxTotalBytes) errors.push('解压后总大小超过上限');
	return { ok: errors.length === 0, errors, entries };
}

/**
 * @param {string[]} errors
 * @returns {number}
 */
function errorCount(errors) {
	return errors.length;
}

/* ---------------- sha256（浏览器/Node 通用） ---------------- */

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function sha256Hex(bytes) {
	if (typeof crypto === 'undefined' || !crypto.subtle) {
		throw new Error('当前环境不支持 crypto.subtle（无法校验 .dshskin）');
	}
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/* ---------------- `.dshskin` schema ---------------- */

const POLICY_TAGS = ['conservative-v1', 'conservative-downgraded-v1'];

/**
 * 构造 manifest.json（不写图层字节；sha256 由 `buildSkinFile` 补）。
 * @param {import('./wardrobe-core.js').DiyRecord} record
 * @returns {Record<string, unknown>}
 */
export function buildSkinManifest(record) {
	return {
		format: SKIN_FORMAT,
		version: SKIN_VERSION,
		createdAt: new Date().toISOString(),
		app: { name: 'dsh-feiyu-wardrobe', manifestVersion: 7, diyVersion: 1 },
		item: {
			id: record.id,
			name: record.name,
			category: record.category,
			shape: record.shape,
			bytes: record.bytes,
			createdAt: record.createdAt,
			contentPolicyTag: record.contentPolicyTag,
			guardVersion: record.guardVersion || '',
			promptVersion: record.promptVersion || '',
			source: { type: record.source && record.source.type, license: record.source && record.source.license },
		},
		layers: [],
		contentPolicy: {
			tag: record.contentPolicyTag,
			note: '内容策略：保守着装（长袖/及膝/宽松、不暴露）；文本词表硬拦截，图像分类器为后续项。',
		},
		license: {
			garment: '衣服图片版权归上传者/分享者所有；导入即表示仅本地个人使用。',
			code: 'MIT (dsh-feiyu-wardrobe)',
		},
	};
}

/**
 * 校验 manifest.json（schema/版本/品类/内容策略）；图层校验在 `parseSkinFile` 里做。
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: string[], record: Record<string, any> | null }}
 */
export function validateSkinManifest(raw) {
	/** @type {string[]} */
	const errors = [];
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, errors: ['manifest 必须是 JSON 对象'], record: null };
	}
	const manifest = /** @type {any} */ (raw);
	if (manifest.format !== SKIN_FORMAT) errors.push(`format 必须是 ${SKIN_FORMAT}`);
	if (manifest.version !== SKIN_VERSION) errors.push(`version 必须是 ${SKIN_VERSION}（不支持旧/新格式）`);
	const item = manifest.item && typeof manifest.item === 'object' ? manifest.item : null;
	if (!item) {
		errors.push('缺少 item');
		return { ok: false, errors, record: null };
	}
	if (!DIY_LAYER_SLOTS[item.category]) errors.push(`非法品类：${String(item.category)}`);
	if (item.shape !== 'chibi') errors.push('目前只支持 chibi 身形');
	if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 24) errors.push('name 非法（1–24 字）');
	if (typeof item.id !== 'string' || !item.id.startsWith('diy-')) errors.push('id 必须为 diy- 前缀');
	if (!POLICY_TAGS.includes(item.contentPolicyTag)) errors.push('内容策略标签不在允许列表');
	if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) errors.push('缺少 layers 清单');
	if (typeof manifest.contentPolicy !== 'object' || !manifest.contentPolicy || manifest.contentPolicy.tag !== item.contentPolicyTag) {
		errors.push('contentPolicy 与 item.contentPolicyTag 不一致');
	}
	return {
		ok: errors.length === 0,
		errors,
		record: errors.length === 0 ? /** @type {Record<string, any>} */ (manifest) : null,
	};
}

/**
 * 把记录 + 图层字节打成 `.dshskin`（ZIP）。
 *
 * @param {import('./wardrobe-core.js').DiyRecord} record
 * @param {{ getBody: () => Promise<Uint8Array> | Uint8Array, getSleeve?: () => Promise<Uint8Array> | Uint8Array, licenseText?: string, attributionText?: string }} provider
 * @returns {Promise<Uint8Array>}
 */
export async function buildSkinFile(record, provider) {
	const checked = validateDiyRecord(record);
	if (!checked.ok) throw new Error(`记录非法：${checked.errors.join('；')}`);
	const manifest = buildSkinManifest(record);
	/** @type {Array<{ name: string, data: Uint8Array }>} */
	const entries = [];
	const layerFiles = [];
	const body = toBytes(await provider.getBody());
	if (body.byteLength > SKIN_LIMITS.maxLayerBytes) throw new Error('衣身层超过分享上限（2MB）');
	const bodySha = await sha256Hex(body);
	layerFiles.push({ slot: 'body', file: 'layers/body.webp', bytes: body.byteLength, sha256: bodySha });
	entries.push({ name: 'layers/body.webp', data: body });
	if (record.layers.sleeve && provider.getSleeve) {
		const sleeve = toBytes(await provider.getSleeve());
		if (sleeve.byteLength > SKIN_LIMITS.maxLayerBytes) throw new Error('袖子层超过分享上限（2MB）');
		const sleeveSha = await sha256Hex(sleeve);
		layerFiles.push({ slot: 'sleeve', file: 'layers/sleeve.webp', bytes: sleeve.byteLength, sha256: sleeveSha });
		entries.push({ name: 'layers/sleeve.webp', data: sleeve });
	}
	manifest.layers = layerFiles;
	const manifestBytes = TEXT_ENCODER.encode(JSON.stringify(manifest, null, 2));
	if (manifestBytes.byteLength > SKIN_LIMITS.maxManifestBytes) throw new Error('manifest.json 过大');
	entries.unshift({ name: 'manifest.json', data: manifestBytes });
	const licenseInfo = /** @type {{ garment: string, code: string }} */ (manifest.license);
	const licenseText =
		provider.licenseText || `${licenseInfo.garment}\n${licenseInfo.code}\n`;
	const attributionText =
		provider.attributionText ||
		`由「大肥鱼衣橱」DIY 上传生成（dshskin v${SKIN_VERSION}）。\n` +
			`内容策略：${record.contentPolicyTag}（保守着装；文本词表硬拦截）。\n` +
			`请仅本地个人使用，不要二次传播未经授权的衣物图像。\n`;
	entries.push({ name: 'LICENSE.txt', data: TEXT_ENCODER.encode(licenseText) });
	entries.push({ name: 'ATTRIBUTION.txt', data: TEXT_ENCODER.encode(attributionText) });
	return writeZip(entries);
}

/**
 * @param {Uint8Array | ArrayBuffer} value
 * @returns {Uint8Array}
 */
function toBytes(value) {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/**
 * 解析并校验 `.dshskin`：任何一项不通过整包拒绝（不落盘）。
 *
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {Promise<{ ok: boolean, errors: string[], record: Record<string, any> | null, files: { body: Uint8Array, sleeve: Uint8Array | null } | null }>}
 */
export async function parseSkinFile(input) {
	const bytes = toBytes(input);
	if (bytes.byteLength > SKIN_LIMITS.maxTotalBytes + SKIN_LIMITS.maxManifestBytes) {
		return { ok: false, errors: ['文件超过 .dshskin 大小上限'], record: null, files: null };
	}
	const zip = readZip(bytes);
	if (!zip.ok) return { ok: false, errors: zip.errors, record: null, files: null };
	const manifestBytes = zip.entries.get('manifest.json');
	if (!manifestBytes) return { ok: false, errors: ['缺少 manifest.json'], record: null, files: null };
	if (manifestBytes.byteLength > SKIN_LIMITS.maxManifestBytes) {
		return { ok: false, errors: ['manifest.json 过大'], record: null, files: null };
	}
	let rawManifest;
	try {
		rawManifest = JSON.parse(TEXT_DECODER.decode(manifestBytes));
	} catch {
		return { ok: false, errors: ['manifest.json 不是合法 JSON'], record: null, files: null };
	}
	const checked = validateSkinManifest(rawManifest);
	if (!checked.ok) return { ok: false, errors: checked.errors, record: null, files: null };
	const manifest = /** @type {any} */ (checked.record);
	const errors = [];
	/** @type {Uint8Array | null} */
	let body = null;
	/** @type {Uint8Array | null} */
	let sleeve = null;
	for (const layer of manifest.layers) {
		if (!layer || typeof layer !== 'object') {
			errors.push('图层清单项非法');
			continue;
		}
		const file = normalizeEntryName(String(layer.file || ''));
		if (!file || !file.startsWith('layers/')) {
			errors.push(`图层路径非法：${String(layer.file)}`);
			continue;
		}
		const data = zip.entries.get(file);
		if (!data) {
			errors.push(`缺少图层文件：${file}`);
			continue;
		}
		if (Number.isFinite(layer.bytes) && data.byteLength !== Number(layer.bytes)) {
			errors.push(`图层大小不一致：${file}`);
			continue;
		}
		const digest = await sha256Hex(data);
		if (digest !== layer.sha256) {
			errors.push(`图层 sha256 校验失败：${file}`);
			continue;
		}
		if (layer.slot === 'body') body = data;
		else if (layer.slot === 'sleeve') sleeve = data;
		else errors.push(`未知图层槽位：${String(layer.slot)}`);
	}
	if (!body) errors.push('缺少 body 衣身层');
	const slot = DIY_LAYER_SLOTS[manifest.item.category];
	if (slot && !slot.sleeve && sleeve) errors.push('该品类不接受 sleeve 层');
	if (errors.length > 0) return { ok: false, errors, record: null, files: null };
	const record = {
		id: manifest.item.id,
		name: manifest.item.name,
		category: manifest.item.category,
		shape: manifest.item.shape,
		layers: { body: body, ...(sleeve ? { sleeve } : {}) },
		source: {
			type: 'dshskin-import',
			license: 'user-owned',
		},
		contentPolicyTag: manifest.item.contentPolicyTag,
		createdAt: Number(manifest.item.createdAt) || Date.now(),
		lastUsedAt: Date.now(),
		bytes: (body ? body.byteLength : 0) + (sleeve ? sleeve.byteLength : 0),
		version: 1,
		...(manifest.item.guardVersion ? { guardVersion: String(manifest.item.guardVersion) } : {}),
		...(manifest.item.promptVersion ? { promptVersion: String(manifest.item.promptVersion) } : {}),
	};
	return { ok: true, errors, record, files: { body: /** @type {Uint8Array} */ (body), sleeve } };
}

/**
 * 导出文件名（去危险字符，保留 .dshskin 后缀）。
 * @param {import('./wardrobe-core.js').DiyRecord} record
 * @returns {string}
 */
export function skinFileName(record) {
	const safeName = String(record.name || 'diy')
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
		.trim()
		.slice(0, 24) || 'diy';
	const suffix = String(record.id || 'skin').replace(/^diy-/, '').slice(0, 8);
	return `${safeName}-${suffix}${SKIN_EXT}`;
}

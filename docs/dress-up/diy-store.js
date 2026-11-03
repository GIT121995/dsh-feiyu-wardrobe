// @ts-nocheck — 浏览器 IndexedDB/Storage/Blob 全局在 Node 单测环境下没有类型；纯逻辑由 tests/diy-store-skin.test.mjs 覆盖
/**
 * 大肥鱼衣橱 · DIY 本地衣柜（IndexedDB 存储 + 配额/LRU + 同意/开关状态）
 *
 * 设计（task-7 D3）：
 *   - DIY 单品只存浏览器本地（IndexedDB），不上传服务器、无遥测；
 *   - 每件 = schema 固定的记录（见 wardrobe-core.DiyRecord）：图层 Blob、来源/许可、
 *     内容策略标签、createdAt/lastUsedAt/bytes；
 *   - 配额：条目上限 + 字节上限；超限按 LRU（最久未穿）淘汰，刚保存的 keepId 受保护；
 *   - 与 manifest 的桥：`diyRecordToItem(record, { body: objectURL, sleeve: objectURL })`
 *     注入 `manifest.items[category]`，v6 渲染路径（resolveLayers）零改动消费；
 *   - 默认关闭：`feiyu:diy:enabled`（默认 off）+ 首次开启显式同意 `feiyu:diy:consent`
 *     （记录时间/版本；清空 consent 即回到未同意状态）。
 *
 * 纯函数（记录构造/字节估算/同意状态）在 node 单测覆盖；IndexedDB 读写由浏览器
 * Playwright 端到端覆盖（node 无 IndexedDB）。
 *
 * @module dsh-feiyu-wardrobe/diy-store
 */

import {
	DIY_ID_PREFIX,
	DIY_LAYER_SLOTS,
	DIY_MAX_ITEMS,
	selectDiyEvictions,
	validateDiyRecord,
} from './wardrobe-core.js';

/** IndexedDB 数据库名 / 版本 / object store。 */
export const DIY_DB_NAME = 'feiyu-diy';
export const DIY_DB_VERSION = 1;
export const DIY_STORE_NAME = 'items';

/** 本地衣柜默认配额。 */
export const DIY_MAX_BYTES = 24 * 1024 * 1024;

/** localStorage key：UI 开关（默认关闭）与首次开启的同意记录。 */
export const DIY_ENABLED_KEY = 'feiyu:diy:enabled';
export const DIY_CONSENT_KEY = 'feiyu:diy:consent';
export const DIY_CONSENT_VERSION = 'diy-consent-1';

/** 允许的内容策略标签（与 manifest.diy.contentPolicy 对齐）。 */
export const ALLOWED_POLICY_TAGS = ['conservative-v1', 'conservative-downgraded-v1'];

/**
 * 本地衣柜错误（code 供 UI 提示/重试分类）。
 */
export class DiyStoreError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 */
	constructor(code, message) {
		super(message);
		this.name = 'DiyStoreError';
		this.code = code;
	}
}

/**
 * 由上传图 sha256 摘要派生记录 id（同图重复入库会被覆盖/去重）。
 * @param {string} digestSha256
 * @returns {string}
 */
export function createDiyId(digestSha256) {
	const digest = String(digestSha256 || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
	if (digest.length < 12) throw new DiyStoreError('bad_digest', '上传图摘要非法');
	return `${DIY_ID_PREFIX}${digest.slice(0, 12)}`;
}

/**
 * 估算图层字节数（Blob/ArrayBuffer/TypedArray/data URL 字符串）。
 * @param {unknown} layer
 * @returns {number}
 */
export function layerBytes(layer) {
	if (!layer) return 0;
	if (typeof Blob !== 'undefined' && layer instanceof Blob) return layer.size;
	if (layer instanceof Uint8Array || layer instanceof ArrayBuffer) return layer.byteLength;
	if (typeof layer === 'string') return layer.length;
	return 0;
}

/**
 * 构造一条 DIY 衣柜记录（做 schema 校验；失败抛 DiyStoreError）。
 *
 * @param {{
 *   digestSha256: string,
 *   name: string,
 *   category: 'top'|'bottom'|'dress'|'coat'|'outfit',
 *   shape?: 'chibi',
 *   layers: { body: Blob | Uint8Array | ArrayBuffer | string, sleeve?: Blob | Uint8Array | ArrayBuffer | string | null },
 *   contentPolicyTag: string,
 *   sourceType?: 'user-upload' | 'dshskin-import',
 *   license?: string,
 *   originalSha256?: string,
 *   guardVersion?: string,
 *   promptVersion?: string,
 *   now?: number,
 * }} input
 * @returns {import('./wardrobe-core.js').DiyRecord}
 */
export function makeDiyRecord(input) {
	const slot = DIY_LAYER_SLOTS[input.category];
	if (!slot) throw new DiyStoreError('bad_category', `不支持的 DIY 品类：${input.category}`);
	if (!ALLOWED_POLICY_TAGS.includes(input.contentPolicyTag)) {
		throw new DiyStoreError('bad_policy_tag', `内容策略标签非法：${input.contentPolicyTag}`);
	}
	const now = Number(input.now) || Date.now();
	const bytes = layerBytes(input.layers.body) + layerBytes(input.layers.sleeve);
	const record = {
		id: createDiyId(input.digestSha256),
		name: String(input.name || '').trim().slice(0, 24),
		category: input.category,
		shape: input.shape || 'chibi',
		layers: {
			body: input.layers.body,
			...(slot.sleeve && input.layers.sleeve ? { sleeve: input.layers.sleeve } : {}),
		},
		source: {
			type: input.sourceType || 'user-upload',
			license: input.license || 'user-owned',
			...(input.originalSha256 ? { originalSha256: input.originalSha256 } : {}),
		},
		contentPolicyTag: input.contentPolicyTag,
		createdAt: now,
		lastUsedAt: now,
		bytes,
		version: 1,
		...(input.guardVersion ? { guardVersion: input.guardVersion } : {}),
		...(input.promptVersion ? { promptVersion: input.promptVersion } : {}),
	};
	const checked = validateDiyRecord(record);
	if (!checked.ok) {
		throw new DiyStoreError('invalid_record', checked.errors.join('；'));
	}
	return /** @type {import('./wardrobe-core.js').DiyRecord} */ (record);
}

/* ---------------- 开关 / 同意（localStorage；可注入便于单测） ---------------- */

/**
 * @typedef {{ accepted: boolean, at: number, version: string, costNoticeAccepted?: boolean }} DiyConsent
 */

/**
 * 读取首次开启同意状态（默认：未同意、功能关闭）。
 * @param {Storage | null} [storage]
 * @returns {DiyConsent}
 */
export function readConsent(storage = defaultStorage()) {
	const raw = safeStorageGet(storage, DIY_CONSENT_KEY);
	if (!raw) return { accepted: false, at: 0, version: DIY_CONSENT_VERSION };
	try {
		const parsed = JSON.parse(raw);
		return {
			accepted: parsed && parsed.accepted === true && parsed.version === DIY_CONSENT_VERSION,
			at: Number(parsed && parsed.at) || 0,
			version: typeof parsed === 'object' && parsed ? String(parsed.version || '') : '',
			costNoticeAccepted: Boolean(parsed && parsed.costNoticeAccepted),
		};
	} catch {
		return { accepted: false, at: 0, version: DIY_CONSENT_VERSION };
	}
}

/**
 * 写入同意记录（只在用户显式点「同意并开启」时调用）。
 * @param {Storage | null} [storage]
 * @param {number} [now]
 * @returns {DiyConsent}
 */
export function writeConsent(storage = defaultStorage(), now = Date.now()) {
	const consent = {
		accepted: true,
		at: now,
		version: DIY_CONSENT_VERSION,
		costNoticeAccepted: true,
	};
	safeStorageSet(storage, DIY_CONSENT_KEY, JSON.stringify(consent));
	return consent;
}

/** 撤销同意（同时关闭开关）。 */
export function revokeConsent(storage = defaultStorage()) {
	safeStorageRemove(storage, DIY_CONSENT_KEY);
	safeStorageSet(storage, DIY_ENABLED_KEY, '0');
}

/**
 * UI 开关是否开启（默认关闭；未同意时永远返回 false）。
 * @param {Storage | null} [storage]
 * @returns {boolean}
 */
export function readEnabled(storage = defaultStorage()) {
	if (!readConsent(storage).accepted) return false;
	return safeStorageGet(storage, DIY_ENABLED_KEY) === '1';
}

/**
 * 写 UI 开关。
 * @param {boolean} enabled
 * @param {Storage | null} [storage]
 */
export function writeEnabled(enabled, storage = defaultStorage()) {
	safeStorageSet(storage, DIY_ENABLED_KEY, enabled ? '1' : '0');
}

/** @returns {Storage | null} */
function defaultStorage() {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/**
 * @param {Storage | null} storage
 * @param {string} key
 * @returns {string | null}
 */
function safeStorageGet(storage, key) {
	try {
		return storage ? storage.getItem(key) : null;
	} catch {
		return null;
	}
}

/**
 * @param {Storage | null} storage
 * @param {string} key
 * @param {string} value
 */
function safeStorageSet(storage, key, value) {
	try {
		if (storage) storage.setItem(key, value);
	} catch {
		/* 隐身模式/配额不足时忽略（开关退化为本次会话） */
	}
}

/**
 * @param {Storage | null} storage
 * @param {string} key
 */
function safeStorageRemove(storage, key) {
	try {
		if (storage) storage.removeItem(key);
	} catch {
		/* 忽略 */
	}
}

/* ---------------- IndexedDB 封装 ---------------- */

/**
 * @param {IDBRequest} request
 * @returns {Promise<any>}
 */
function requestToPromise(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
	});
}

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/**
 * 打开 DIY 衣柜数据库（单例；失败时清空缓存允许重试）。
 * @param {{ indexedDBImpl?: IDBFactory }} [options]
 * @returns {Promise<IDBDatabase>}
 */
export function openDiyDb(options = {}) {
	const factory = options.indexedDBImpl || (typeof indexedDB === 'undefined' ? null : indexedDB);
	if (!factory) return Promise.reject(new DiyStoreError('indexeddb_unavailable', '浏览器不支持 IndexedDB'));
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		/** @type {IDBOpenDBRequest} */
		let request;
		try {
			request = factory.open(DIY_DB_NAME, DIY_DB_VERSION);
		} catch (error) {
			reject(new DiyStoreError('indexeddb_open_failed', `IndexedDB 打开失败：${String(error)}`));
			return;
		}
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(DIY_STORE_NAME)) {
				db.createObjectStore(DIY_STORE_NAME, { keyPath: 'id' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			dbPromise = null;
			reject(new DiyStoreError('indexeddb_open_failed', 'IndexedDB 打开失败（可能处于隐私模式）'));
		};
	});
	return dbPromise;
}

/**
 * 列出所有 DIY 记录（按 createdAt 升序）。
 * @param {{ indexedDBImpl?: IDBFactory }} [options]
 * @returns {Promise<import('./wardrobe-core.js').DiyRecord[]>}
 */
export async function listDiyRecords(options = {}) {
	const db = await openDiyDb(options);
	const tx = db.transaction(DIY_STORE_NAME, 'readonly');
	const store = tx.objectStore(DIY_STORE_NAME);
	const records = await requestToPromise(store.getAll());
	return Array.isArray(records)
		? records.slice().sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
		: [];
}

/**
 * 读取单条记录。
 * @param {string} id
 * @param {{ indexedDBImpl?: IDBFactory }} [options]
 * @returns {Promise<import('./wardrobe-core.js').DiyRecord | null>}
 */
export async function getDiyRecord(id, options = {}) {
	const db = await openDiyDb(options);
	const tx = db.transaction(DIY_STORE_NAME, 'readonly');
	const record = await requestToPromise(tx.objectStore(DIY_STORE_NAME).get(id));
	return record || null;
}

/**
 * 保存一条记录（先按配额 LRU 淘汰；同一 id 覆盖）。
 * @param {import('./wardrobe-core.js').DiyRecord} record
 * @param {{ maxItems?: number, maxBytes?: number, indexedDBImpl?: IDBFactory }} [options]
 * @returns {Promise<{ record: import('./wardrobe-core.js').DiyRecord, evicted: string[] }>}
 */
export async function putDiyRecord(record, options = {}) {
	const checked = validateDiyRecord(record);
	if (!checked.ok) throw new DiyStoreError('invalid_record', checked.errors.join('；'));
	const db = await openDiyDb(options);
	const all = await listDiyRecords(options);
	const others = all.filter((entry) => entry.id !== record.id);
	const evictions = selectDiyEvictions([...others, record], {
		maxItems: options.maxItems ?? DIY_MAX_ITEMS,
		maxBytes: options.maxBytes ?? DIY_MAX_BYTES,
		keepId: record.id,
	});
	const tx = db.transaction(DIY_STORE_NAME, 'readwrite');
	const store = tx.objectStore(DIY_STORE_NAME);
	for (const id of evictions.evictIds) store.delete(id);
	store.put(record);
	await new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve(undefined);
		tx.onerror = () => reject(new DiyStoreError('indexeddb_write_failed', '保存到本地衣柜失败（配额不足或隐私模式）'));
		tx.onabort = () => reject(new DiyStoreError('indexeddb_write_failed', '保存到本地衣柜被中止'));
	});
	return { record, evicted: evictions.evictIds };
}

/**
 * 删除一条记录。
 * @param {string} id
 * @param {{ indexedDBImpl?: IDBFactory }} [options]
 * @returns {Promise<boolean>}
 */
export async function deleteDiyRecord(id, options = {}) {
	const db = await openDiyDb(options);
	const tx = db.transaction(DIY_STORE_NAME, 'readwrite');
	tx.objectStore(DIY_STORE_NAME).delete(id);
	await new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve(undefined);
		tx.onerror = () => reject(new DiyStoreError('indexeddb_delete_failed', '删除本地 DIY 单品失败'));
	});
	return true;
}

/**
 * 记录一次穿着（LRU 时间戳）。
 * @param {string} id
 * @param {number} [now]
 * @param {{ indexedDBImpl?: IDBFactory }} [options]
 * @returns {Promise<boolean>}
 */
export async function touchDiyRecord(id, now = Date.now(), options = {}) {
	const record = await getDiyRecord(id, options);
	if (!record) return false;
	await putDiyRecord({ ...record, lastUsedAt: now }, options);
	return true;
}

/**
 * 清空本地衣柜（隐私/重置用）。
 * @param {{ indexedDBImpl?: IDBFactory }} [options]
 * @returns {Promise<void>}
 */
export async function clearDiyRecords(options = {}) {
	const db = await openDiyDb(options);
	const tx = db.transaction(DIY_STORE_NAME, 'readwrite');
	tx.objectStore(DIY_STORE_NAME).clear();
	await new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve(undefined);
		tx.onerror = () => reject(new DiyStoreError('indexeddb_clear_failed', '清空本地衣柜失败'));
	});
}

/**
 * 本地衣柜统计（UI 配额展示）。
 * @param {{ indexedDBImpl?: IDBFactory }} [options]
 * @returns {Promise<{ count: number, bytes: number, maxItems: number, maxBytes: number }>}
 */
export async function diyStoreStats(options = {}) {
	const records = await listDiyRecords(options);
	return {
		count: records.length,
		bytes: records.reduce((sum, record) => sum + (Number(record.bytes) || 0), 0),
		maxItems: DIY_MAX_ITEMS,
		maxBytes: DIY_MAX_BYTES,
	};
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	DIY_CONSENT_VERSION,
	DiyStoreError,
	createDiyId,
	layerBytes,
	makeDiyRecord,
	readConsent,
	readEnabled,
	revokeConsent,
	writeConsent,
	writeEnabled,
} from '../docs/dress-up/diy-store.js';
import {
	SKIN_EXT,
	SKIN_FORMAT,
	SKIN_LIMITS,
	SKIN_VERSION,
	buildSkinFile,
	buildSkinManifest,
	normalizeEntryName,
	parseSkinFile,
	readZip,
	sha256Hex,
	skinFileName,
	validateSkinManifest,
	writeZip,
} from '../docs/dress-up/diy-skin.js';

/* ---------------- 记录构造 / 开关 / 同意 ---------------- */

function makeStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
		removeItem: (key) => map.delete(key),
		clear: () => map.clear(),
		key: (index) => Array.from(map.keys())[index] || null,
		get length() {
			return map.size;
		},
		_map: map,
	};
}

const bodyBytes = new Uint8Array(1500).fill(7);
const sleeveBytes = new Uint8Array(900).fill(9);

function makeRecordFrom(overrides = {}) {
	return makeDiyRecord({
		digestSha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
		name: '白色衬衫',
		category: 'top',
		layers: { body: bodyBytes, sleeve: sleeveBytes },
		contentPolicyTag: 'conservative-v1',
		guardVersion: 'diy-guard-1',
		promptVersion: 'diy-m1-v1',
		now: 1_760_000_000_000,
		...overrides,
	});
}

test('createDiyId / layerBytes / makeDiyRecord：id 派生、字节估算、schema 校验', () => {
	const id = createDiyId('a1b2c3d4e5f60718');
	assert.equal(id, 'diy-a1b2c3d4e5f6');
	assert.throws(() => createDiyId('short'), (error) => error.code === 'bad_digest');
	assert.equal(layerBytes(bodyBytes), 1500);
	assert.equal(layerBytes('x'.repeat(42)), 42);
	assert.equal(layerBytes(null), 0);
	if (typeof Blob !== 'undefined') assert.equal(layerBytes(new Blob([bodyBytes])), 1500);
	const record = makeRecordFrom();
	assert.equal(record.id, 'diy-a1b2c3d4e5f6');
	assert.equal(record.name, '白色衬衫');
	assert.equal(record.bytes, 2400);
	assert.equal(record.shape, 'chibi');
	assert.deepEqual(Object.keys(record.layers).sort(), ['body', 'sleeve']);
	assert.equal(record.source.type, 'user-upload');
	assert.equal(record.source.license, 'user-owned');
	// bottom 不接受 sleeve（自动丢弃）
	const bottom = makeRecordFrom({ category: 'bottom', layers: { body: bodyBytes, sleeve: sleeveBytes } });
	assert.deepEqual(Object.keys(bottom.layers), ['body']);
	assert.throws(() => makeRecordFrom({ category: 'hat' }), (error) => error.code === 'bad_category');
	assert.throws(() => makeRecordFrom({ contentPolicyTag: 'anything' }), (error) => error.code === 'bad_policy_tag');
	assert.throws(() => makeRecordFrom({ name: '   ' }), (error) => error.code === 'invalid_record');
});

test('开关默认关闭：未同意时 readEnabled=false；同意+开启后可读；撤销后回到关闭', () => {
	const storage = makeStorage();
	assert.deepEqual(readConsent(storage), { accepted: false, at: 0, version: DIY_CONSENT_VERSION });
	assert.equal(readEnabled(storage), false);
	writeEnabled(true, storage); // 未同意时的开启无效
	assert.equal(readEnabled(storage), false, '未同意时开关必须无效');
	const consent = writeConsent(storage, 123);
	assert.equal(consent.accepted, true);
	assert.equal(readConsent(storage).accepted, true);
	assert.equal(readConsent(storage).at, 123);
	writeEnabled(true, storage);
	assert.equal(readEnabled(storage), true);
	writeEnabled(false, storage);
	assert.equal(readEnabled(storage), false);
	revokeConsent(storage);
	assert.equal(readConsent(storage).accepted, false);
	assert.equal(readEnabled(storage), false);
	// 损坏的 consent JSON → 视为未同意
	storage.setItem('feiyu:diy:consent', '{oops');
	assert.equal(readConsent(storage).accepted, false);
});

test('DiyStoreError 是带 code 的 Error（UI 用来区分重试/提示）', () => {
	const error = new DiyStoreError('indexeddb_unavailable', 'no idb');
	assert.ok(error instanceof Error);
	assert.equal(error.code, 'indexeddb_unavailable');
});

/* ---------------- `.dshskin`（store-only ZIP） ---------------- */

test('writeZip/readZip：store 模式 roundtrip、CRC 校验、UTF-8 文件名', () => {
	const entries = [
		{ name: 'manifest.json', data: new TextEncoder().encode('{"a":1}') },
		{ name: 'layers/body.webp', data: bodyBytes },
		{ name: '说明.txt', data: new TextEncoder().encode('hi') },
	];
	const zip = writeZip(entries);
	assert.ok(zip.byteLength > 22);
	const parsed = readZip(zip);
	assert.equal(parsed.ok, true, parsed.errors.join('|'));
	assert.equal(parsed.entries.size, 3);
	assert.deepEqual(Array.from(parsed.entries.get('layers/body.webp')), Array.from(bodyBytes));
	assert.equal(new TextDecoder().decode(parsed.entries.get('manifest.json')), '{"a":1}');
	// 篡改数据 → CRC 失败（单条目 'a'：本地头 30B + 名 1B，数据从 offset 31 开始）
	const simple = writeZip([{ name: 'a', data: new Uint8Array([1, 2, 3]) }]);
	assert.equal(readZip(simple).ok, true);
	const tampered = simple.slice();
	tampered[31] ^= 0xff;
	assert.equal(readZip(tampered).ok, false);
});

test('normalizeEntryName：拒绝目录穿越/绝对路径/反斜杠/重复（导入安全）', () => {
	assert.equal(normalizeEntryName('layers/body.webp'), 'layers/body.webp');
	assert.equal(normalizeEntryName('../evil'), null);
	assert.equal(normalizeEntryName('a/../../b'), null);
	assert.equal(normalizeEntryName('/etc/passwd'), null);
	assert.equal(normalizeEntryName('a\\b'), null);
	assert.equal(normalizeEntryName('a//b'), null);
	assert.equal(normalizeEntryName(''), null);
	const duplicate = readZip(
		writeZip([
			{ name: 'manifest.json', data: new Uint8Array([1, 2, 3]) },
			{ name: 'manifest.json', data: new Uint8Array([4, 5, 6]) },
		]),
	);
	assert.equal(duplicate.ok, false);
	assert.ok(duplicate.errors.some((error) => error.includes('重复')));
});

test('buildSkinManifest/validateSkinManifest：schema/版本/内容策略校验', async () => {
	const record = makeRecordFrom();
	const manifest = buildSkinManifest(record);
	manifest.layers = [{ slot: 'body', file: 'layers/body.webp', bytes: bodyBytes.length, sha256: await sha256Hex(bodyBytes) }];
	assert.equal(manifest.format, SKIN_FORMAT);
	assert.equal(manifest.version, SKIN_VERSION);
	assert.equal(manifest.app.manifestVersion, 7);
	assert.equal(manifest.item.id, record.id);
	assert.equal(manifest.item.category, 'top');
	assert.equal(manifest.contentPolicy.tag, record.contentPolicyTag);
	assert.equal(manifest.layers.length, 1);
	const ok = validateSkinManifest(manifest);
	assert.equal(ok.ok, true, ok.errors.join('|'));
	for (const [patch, keyword] of [
		[{ format: 'zip' }, 'format'],
		[{ version: 2 }, 'version'],
		[{ item: { ...manifest.item, category: 'hat' } }, '品类'],
		[{ item: { ...manifest.item, id: 'x' } }, 'id'],
		[{ item: { ...manifest.item, contentPolicyTag: 'anything' } }, '内容策略'],
		[{ layers: [] }, 'layers'],
		[{ contentPolicy: { tag: 'other' } }, 'contentPolicy'],
	]) {
		const result = validateSkinManifest({ ...manifest, ...patch });
		assert.equal(result.ok, false, JSON.stringify(patch));
		assert.ok(result.errors.some((error) => error.includes(keyword)), `${keyword}: ${result.errors.join('|')}`);
	}
});

test('.dshskin 导出→导入 roundtrip：sha256/字节/记录还原，文件名安全', async () => {
	const record = makeRecordFrom();
	const zip = await buildSkinFile(record, {
		getBody: async () => bodyBytes,
		getSleeve: async () => sleeveBytes,
	});
	assert.ok(zip.byteLength > 0);
	const parsed = await parseSkinFile(zip);
	assert.equal(parsed.ok, true, parsed.errors.join('|'));
	assert.deepEqual(Array.from(parsed.files.body), Array.from(bodyBytes));
	assert.deepEqual(Array.from(parsed.files.sleeve), Array.from(sleeveBytes));
	assert.equal(parsed.record.id, record.id);
	assert.equal(parsed.record.category, 'top');
	assert.equal(parsed.record.source.type, 'dshskin-import');
	assert.equal(parsed.record.contentPolicyTag, 'conservative-v1');
	assert.equal(parsed.record.bytes, record.bytes);
	assert.equal((await sha256Hex(bodyBytes)).length, 64);
	const name = skinFileName(record);
	assert.ok(name.endsWith(SKIN_EXT));
	assert.ok(!/[\\/:*?"<>|]/.test(name));
	// bottom 不能带 sleeve：手工构造带 sleeve 的 bottom manifest → 拒绝
	const bottomRecord = makeRecordFrom({ category: 'bottom', layers: { body: bodyBytes } });
	const zipBottom = await buildSkinFile(bottomRecord, { getBody: async () => bodyBytes });
	const tamperedManifest = JSON.parse(new TextDecoder().decode(readZip(zipBottom).entries.get('manifest.json')));
	tamperedManifest.item.category = 'bottom';
	tamperedManifest.layers.push({ slot: 'sleeve', file: 'layers/sleeve.webp', bytes: sleeveBytes.length, sha256: await sha256Hex(sleeveBytes) });
	const tampered = writeZip([
		{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(tamperedManifest)) },
		{ name: 'layers/body.webp', data: bodyBytes },
		{ name: 'layers/sleeve.webp', data: sleeveBytes },
	]);
	const rejected = await parseSkinFile(tampered);
	assert.equal(rejected.ok, false);
	assert.ok(rejected.errors.some((error) => error.includes('sleeve')));
});

test('.dshskin 导入校验：缺图层/坏 sha/坏 manifest 整包拒绝', async () => {
	const record = makeRecordFrom();
	const zip = await buildSkinFile(record, { getBody: async () => bodyBytes, getSleeve: async () => sleeveBytes });
	// 缺 body.webp
	const parsed = readZip(zip);
	const withoutBody = writeZip([...parsed.entries.entries()].filter(([name]) => name !== 'layers/body.webp').map(([name, data]) => ({ name, data })));
	const missing = await parseSkinFile(withoutBody);
	assert.equal(missing.ok, false);
	assert.ok(missing.errors.some((error) => error.includes('缺少 body')));
	// manifest 不是 JSON
	const badManifest = writeZip([
		{ name: 'manifest.json', data: new TextEncoder().encode('{oops') },
		{ name: 'layers/body.webp', data: bodyBytes },
	]);
	const bad = await parseSkinFile(badManifest);
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((error) => error.includes('JSON')));
	// 图层 sha 不一致
	const manifest = JSON.parse(new TextDecoder().decode(parsed.entries.get('manifest.json')));
	manifest.layers[0].sha256 = '0'.repeat(64);
	const badSha = writeZip([
		{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) },
		{ name: 'layers/body.webp', data: bodyBytes },
	]);
	const shaFail = await parseSkinFile(badSha);
	assert.equal(shaFail.ok, false);
	assert.ok(shaFail.errors.some((error) => error.includes('sha256')));
	// v1 之外版本
	const wrongVersion = JSON.parse(new TextDecoder().decode(parsed.entries.get('manifest.json')));
	wrongVersion.version = 2;
	const wrong = writeZip([{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(wrongVersion)) }]);
	assert.equal((await parseSkinFile(wrong)).ok, false);
	assert.ok(SKIN_LIMITS.maxLayerBytes > 0);
});

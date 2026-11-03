import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { DEFAULT_DRESS_UP_RENDER, DRESS_UP_RENDER_MODES, validateConfig, validateDressUpConfig } from '../lib/config.js';
import {
	DRESS_UP_CONFIG_VERSION,
	DRESS_UP_ENTRY,
	DRESS_UP_RENDER_CONFIG,
	createDressUpHandler,
	dressUpRoot,
} from '../lib/webserver.js';

const ROOT = dressUpRoot();

/** @returns {any} 最小 ServerResponse 桩 */
function createRes() {
	return {
		statusCode: 0,
		headers: {},
		body: undefined,
		writeHead(status, headers) {
			this.statusCode = status;
			Object.assign(this.headers, headers || {});
			return this;
		},
		end(body) {
			this.body = body;
		},
	};
}

async function hit(handler, url, headers = {}) {
	const res = createRes();
	await handler({ method: 'GET', url, headers }, res);
	return res;
}

/* ---------------- 配置校验（config.dressUp.render） ---------------- */

test('dressUp.render 默认 dom（M3 口径：2.5D opt-in）', () => {
	assert.equal(DEFAULT_DRESS_UP_RENDER, 'dom');
	assert.deepEqual(DRESS_UP_RENDER_MODES, ['dom', '2d5', 'auto']);
	assert.equal(validateConfig({}).dressUp.render, 'dom');
	assert.equal(validateConfig({ dressUp: {} }).dressUp.render, 'dom');
	assert.equal(validateConfig({ dressUp: null }).dressUp.render, 'dom');
});

test('dressUp.render 接受 dom/2d5/auto（大小写不敏感），非法值回退 dom', () => {
	assert.equal(validateConfig({ dressUp: { render: 'dom' } }).dressUp.render, 'dom');
	assert.equal(validateConfig({ dressUp: { render: '2d5' } }).dressUp.render, '2d5');
	assert.equal(validateConfig({ dressUp: { render: 'AUTO' } }).dressUp.render, 'auto');
	assert.equal(validateConfig({ dressUp: { render: '2D5' } }).dressUp.render, '2d5');
	for (const invalid of ['webgl', 'canvas', '', null, 42, {}, []]) {
		assert.equal(validateConfig({ dressUp: { render: invalid } }).dressUp.render, 'dom', `非法值 ${String(invalid)} 应回退 dom`);
	}
	// 未知字段忽略（patch 前向兼容）
	assert.equal(validateDressUpConfig({ render: '2d5', quality: 'high' }).render, '2d5');
});

test('dressUp 配置与 DIY 配置互不影响', () => {
	const config = validateConfig({
		dressUp: { render: '2d5' },
		diy: { enabled: true, dailyImageLimit: 3 },
	});
	assert.equal(config.dressUp.render, '2d5');
	assert.equal(config.diy.enabled, true);
	assert.equal(config.diy.dailyImageLimit, 3);
	assert.equal(validateConfig({}).diy.enabled, false);
});

/* ---------------- 静态路由：render-config.json ---------------- */

test('render-config 端点返回宿主配置与 no-store', async () => {
	assert.equal(DRESS_UP_RENDER_CONFIG, `${DRESS_UP_ENTRY}render-config.json`);
	const handler = createDressUpHandler(ROOT, { render: '2d5' });
	const res = await hit(handler, DRESS_UP_RENDER_CONFIG);
	assert.equal(res.statusCode, 200);
	assert.match(res.headers['content-type'], /application\/json/);
	assert.equal(res.headers['cache-control'], 'no-store');
	const body = JSON.parse(String(res.body));
	assert.deepEqual(body, { version: DRESS_UP_CONFIG_VERSION, render: '2d5' });
});

test('render-config 未传/非法配置时默认 dom', async () => {
	for (const options of [undefined, {}, { render: 'nope' }, { render: null }]) {
		const handler = createDressUpHandler(ROOT, options);
		const res = await hit(handler, DRESS_UP_RENDER_CONFIG);
		assert.equal(res.statusCode, 200);
		assert.equal(JSON.parse(String(res.body)).render, 'dom');
	}
});

test('render-config 端点只做 GET/HEAD，且不会被静态文件解析', async () => {
	const handler = createDressUpHandler(ROOT, { render: 'dom' });
	const postRes = createRes();
	await handler({ method: 'POST', url: DRESS_UP_RENDER_CONFIG, headers: {} }, postRes);
	assert.equal(postRes.statusCode, 405);
	const headHandler = createDressUpHandler(ROOT, { render: 'auto' });
	const headRes = createRes();
	await headHandler({ method: 'HEAD', url: DRESS_UP_RENDER_CONFIG, headers: {} }, headRes);
	assert.equal(headRes.statusCode, 200);
	assert.equal(headRes.body, undefined);
});

/* ---------------- 静态路由：gzip 协商（2.5D rig 首屏 payload） ---------------- */

test('文本资产按 Accept-Encoding: gzip 压缩返回（rig.json 1.6MB → ~270KB）', async () => {
	const handler = createDressUpHandler(ROOT, { render: 'dom' });
	const rawPath = `${DRESS_UP_ENTRY}art/2d5/chibi/rig.json`;
	const plain = await hit(handler, rawPath);
	assert.equal(plain.statusCode, 200);
	assert.equal(plain.headers['content-encoding'], undefined);
	const plainBytes = readFileSync(join(ROOT, 'art/2d5/chibi/rig.json'));
	assert.equal(Number(plain.headers['content-length']), plainBytes.byteLength);

	const gz = await hit(handler, rawPath, { 'accept-encoding': 'gzip, deflate, br' });
	assert.equal(gz.statusCode, 200);
	assert.equal(gz.headers['content-encoding'], 'gzip');
	assert.equal(gz.headers['vary'], 'accept-encoding');
	const decoded = gunzipSync(gz.body);
	assert.equal(decoded.byteLength, plainBytes.byteLength);
	assert.ok(Buffer.compare(decoded, plainBytes) === 0, 'gzip 解压后应与原文件逐字节一致');
	assert.ok(Number(gz.headers['content-length']) < plainBytes.byteLength * 0.3, 'gzip 传输应低于原文件 30%');
});

test('不接受 gzip 时返回原文；WebP 等已压缩格式不 gzip', async () => {
	const handler = createDressUpHandler(ROOT, { render: 'dom' });
	const noGzip = await hit(handler, `${DRESS_UP_ENTRY}art/2d5/chibi/rig.json`, { 'accept-encoding': 'identity' });
	assert.equal(noGzip.statusCode, 200);
	assert.equal(noGzip.headers['content-encoding'], undefined);
	const atlas = await hit(handler, `${DRESS_UP_ENTRY}art/2d5/chibi/atlas.webp`, { 'accept-encoding': 'gzip' });
	assert.equal(atlas.statusCode, 200);
	assert.equal(atlas.headers['content-encoding'], undefined);
	assert.equal(atlas.headers['content-type'], 'image/webp');
});

test('gzip 缓存键含文件 mtime/size（内容变化后重新压缩）', async () => {
	const handler = createDressUpHandler(ROOT, { render: 'dom' });
	const first = await hit(handler, `${DRESS_UP_ENTRY}manifest.json`, { 'accept-encoding': 'gzip' });
	const second = await hit(handler, `${DRESS_UP_ENTRY}manifest.json`, { 'accept-encoding': 'gzip' });
	assert.equal(first.headers['content-encoding'], 'gzip');
	assert.deepEqual(gunzipSync(first.body), gunzipSync(second.body));
});
